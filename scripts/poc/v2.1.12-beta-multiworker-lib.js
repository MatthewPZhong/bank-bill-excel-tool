/*
 * v2.1.12 β「A3-multi-worker」Phase 0 POC — 共享 harness lib
 *
 * 职责（被 -worker.js / -poc.js require）：
 *   1. SCHEMA：复刻 acquiring-bill-currency 4 表真实 schema（migrations.js:1785-1888）
 *   2. 造数：mkdtemp 临时 sqlite，合成 bill_imports / flow_imports（含币种不一致 + 缺失场景）
 *   3. PRAGMA：复用 run-check-worker.js:48-55 的 6 条 PRAGMA（含 busy_timeout=30000）
 *   4. baseline：复刻 stage 4' 单 worker `INSERT...SELECT JOIN`（run-repository.js insertDiffRowsByJoinChunked）
 *   5. CHUNK_SELECT_SQL：write-splitting 的只读 SELECT（把 INSERT...SELECT 拆成纯 SELECT，行 message 回主）
 *   6. diff 工具：byte-for-byte 逐行比对（内容 + 顺序）
 *
 * ⚠️ 资金红线：byte-for-byte 一致性的真理源是 baseline（单 worker INSERT...SELECT）。
 *   POC 内任何"多 worker 产出"都要与 baseline 逐行 diff，0 差异才算 PASS。
 *
 * 真实 SQL 出处：
 *   - src/backend/acquiring-bill-currency-db/run-repository.js:196-217 (insertDiffRowsByJoinChunked chunkStmt)
 *   - src/backend/database/migrations.js:1785-1888 (4 表 schema)
 *   - src/main-process/run-check-worker.js:48-55 (PRAGMA 清单)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ─────────────────────────────────────────────────────────────────
// PRAGMA 清单（与 run-check-worker.js:48-55 完全一致 — POC 复用这套连接方式）
// ─────────────────────────────────────────────────────────────────
const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',     // 64MB
  'PRAGMA mmap_size = 268435456;',   // 256MB
  'PRAGMA busy_timeout = 30000;',    // 30s（防写冲突 SQLITE_BUSY）
];

const BILL_TABLE = 'acquiring_bill_currency_bill_imports';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const RUNS_TABLE = 'acquiring_bill_currency_runs';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';

function openDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  for (const sql of PRAGMA_STATEMENTS) db.exec(sql);
  return db;
}

// ─────────────────────────────────────────────────────────────────
// SCHEMA — 复刻 migrations.js:1785-1888（去掉与 POC 无关的 fix4/fix5 迁移）
// ─────────────────────────────────────────────────────────────────
function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FLOW_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_amount TEXT NOT NULL,
      settle_amount_abs TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_join ON ${FLOW_TABLE}(month_key, recon_main_id);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${BILL_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bill_join ON ${BILL_TABLE}(month_key, recon_main_id);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL,
      matched_rows INTEGER NOT NULL,
      mismatch_rows INTEGER NOT NULL,
      unmatched_rows INTEGER NOT NULL,
      status TEXT NOT NULL,
      diff_file_path TEXT,
      report_file_path TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DIFF_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES ${RUNS_TABLE}(id),
      FOREIGN KEY (bill_import_id) REFERENCES ${BILL_TABLE}(id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_diff_run ON ${DIFF_TABLE}(run_id);`);
}

// ─────────────────────────────────────────────────────────────────
// 造数 — 合成 bill + flow（每条 bill 都能 JOIN 到 flow，按 recon_main_id 一一对应）
//
// 币种分布（控制 diff 比例 ~ 真实场景）：
//   - matchRatio（默认 0.7）：bill/flow 币种一致 → 不进 diff_rows
//   - mismatchRatio（默认 0.2）：bill/flow 币种不一致 → diff_type='currency_mismatch'
//   - missingRatio（默认 0.1）：bill 币种为空 → diff_type='bill_currency_missing'
//   → diff_rows 行数 ≈ rows * (mismatchRatio + missingRatio)
//
// settle_amount_abs：TEXT，按真实 import-repository.js 形态（ABS(parseFloat) 字符串）
// settle_currency_norm：trim+lower
// ─────────────────────────────────────────────────────────────────
const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP', 'SGD', 'AUD'];

function seedData(db, { rows, monthKey = '2026-03', matchRatio = 0.7, mismatchRatio = 0.2, missingRatio = 0.1 }) {
  createSchema(db);
  // 用确定性伪随机（seed 固定）保证 baseline 与多 worker 跑同一份数据
  let s = 0x2545f491;
  const rand = () => {
    // xorshift32 — 确定性
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };

  db.exec('PRAGMA foreign_keys = OFF;'); // 造数期临时关，加速；造完恢复
  db.exec('BEGIN');
  const billStmt = db.prepare(`
    INSERT INTO ${BILL_TABLE}
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const flowStmt = db.prepare(`
    INSERT INTO ${FLOW_TABLE}
      (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const FILES = ['bill_a.xlsx', 'bill_b.xlsx', 'bill_c.xlsx'];
  const ts = '2026-03-31T00:00:00.000Z';
  for (let i = 0; i < rows; i++) {
    const reconId = `RID${String(i).padStart(9, '0')}`;
    const flowCur = CURRENCIES[Math.floor(rand() * CURRENCIES.length)];
    const r = rand();
    let billCur;
    if (r < missingRatio) {
      billCur = ''; // 单据币种缺失 → bill_currency_missing
    } else if (r < missingRatio + mismatchRatio) {
      // 币种不一致：选一个与 flow 不同的币种
      let c = CURRENCIES[Math.floor(rand() * CURRENCIES.length)];
      if (c === flowCur) c = CURRENCIES[(CURRENCIES.indexOf(flowCur) + 1) % CURRENCIES.length];
      billCur = c;
    } else {
      billCur = flowCur; // 一致 → 不进 diff
    }
    const amount = (rand() * 100000).toFixed(2);
    const file = FILES[i % FILES.length];
    billStmt.run(
      monthKey, file, i, reconId,
      billCur, billCur.trim().toLowerCase(),
      JSON.stringify({ 账单日期: `2026-03-${String((i % 28) + 1).padStart(2, '0')}` }),
      ts
    );
    flowStmt.run(
      monthKey, file, i, reconId,
      amount, amount, flowCur, flowCur.trim().toLowerCase(),
      JSON.stringify({}),
      ts
    );
  }
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON;');
}

// 写一条 runs 拿 runId
function insertRun(db, { monthKey, totalBillRows }) {
  const res = db.prepare(`
    INSERT INTO ${RUNS_TABLE} (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, ?, 0, 0, 0, 'success')
  `).run(monthKey, '2026-03-31T00:00:00.000Z', totalBillRows);
  return Number(res.lastInsertRowid);
}

// ─────────────────────────────────────────────────────────────────
// BASELINE — 单 worker 真理源：复刻 insertDiffRowsByJoinChunked 的 INSERT...SELECT
//   逐 chunk INSERT INTO diff_rows SELECT ... JOIN（与生产 run-repository.js:196-217 byte-for-byte 同 SQL）
//   返回 { runId, insertedDiffRows, chunks, ms }
// ─────────────────────────────────────────────────────────────────

// 生产 chunkStmt 原文（run-repository.js:197-217）— 用于 baseline
function buildInsertSelectSql() {
  return `
    INSERT INTO ${DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    SELECT
      ?,
      b.id,
      f.settle_currency,
      f.settle_amount_abs,
      CASE
        WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
        ELSE 'currency_mismatch'
      END
    FROM (
      SELECT id, month_key, recon_main_id, settle_currency_norm
      FROM ${BILL_TABLE}
      WHERE month_key = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    ) b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `;
}

// write-splitting 的只读 SELECT —— 把上面的 INSERT...SELECT 去掉 INSERT 头，
//   多选一个 run_id 占位列（worker 不知道 runId，让主进程 INSERT 时补；这里只读 SELECT JOIN）
//   ⚠️ 关键：列顺序 / ORDER BY / WHERE / JOIN 与 baseline 完全一致，才能保证行内容 + 顺序一致
function buildSelectOnlySql() {
  return `
    SELECT
      b.id AS bill_import_id,
      f.settle_currency AS flow_currency,
      f.settle_amount_abs AS flow_amount_abs,
      CASE
        WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
        ELSE 'currency_mismatch'
      END AS diff_type
    FROM (
      SELECT id, month_key, recon_main_id, settle_currency_norm
      FROM ${BILL_TABLE}
      WHERE month_key = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    ) b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `;
}

function countBillRows(db, monthKey) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?`).get(monthKey).c;
}

// 单 worker baseline — chunked INSERT...SELECT（与生产路径一致），返回 runId + 计时
function runBaselineSingleWorker(db, { monthKey, chunkSize = 100000 }) {
  const totalBillRows = countBillRows(db, monthKey);
  const runId = insertRun(db, { monthKey, totalBillRows });
  const totalChunks = totalBillRows === 0 ? 0 : Math.ceil(totalBillRows / chunkSize);
  const stmt = db.prepare(buildInsertSelectSql());
  const t0 = Date.now();
  let inserted = 0;
  for (let ci = 0; ci < totalChunks; ci++) {
    const offset = ci * chunkSize;
    db.exec('BEGIN');
    try {
      const r = stmt.run(runId, monthKey, chunkSize, offset);
      inserted += Number(r.changes);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_e) {}
      throw e;
    }
  }
  return { runId, insertedDiffRows: inserted, totalChunks, ms: Date.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────
// diff 工具 — byte-for-byte 逐行比对（内容 + 物理顺序）
//   按 diff_rows.id ASC 取回（id = 插入顺序），逐行比 (bill_import_id, flow_currency, flow_amount_abs, diff_type)
//   返回 { equal, count1, count2, firstDiffAt, firstDiffDetail }
// ─────────────────────────────────────────────────────────────────
function dumpDiffRowsOrdered(db, runId) {
  // ORDER BY id ASC = 物理插入顺序（id 自增）
  return db.prepare(`
    SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type
    FROM ${DIFF_TABLE}
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId);
}

function compareDiffRows(rowsA, rowsB) {
  const out = { equal: true, countA: rowsA.length, countB: rowsB.length, firstDiffAt: -1, firstDiffDetail: null };
  if (rowsA.length !== rowsB.length) {
    out.equal = false;
  }
  const n = Math.min(rowsA.length, rowsB.length);
  for (let i = 0; i < n; i++) {
    const a = rowsA[i], b = rowsB[i];
    if (
      String(a.bill_import_id) !== String(b.bill_import_id) ||
      String(a.flow_currency) !== String(b.flow_currency) ||
      String(a.flow_amount_abs) !== String(b.flow_amount_abs) ||
      String(a.diff_type) !== String(b.diff_type)
    ) {
      out.equal = false;
      out.firstDiffAt = i;
      out.firstDiffDetail = { a, b };
      return out;
    }
  }
  if (rowsA.length !== rowsB.length) {
    out.firstDiffAt = n;
    out.firstDiffDetail = { note: 'length mismatch', a: rowsA[n] || null, b: rowsB[n] || null };
  }
  return out;
}

// 内容指纹（不依赖物理 id；对 (bill_import_id, flow_currency, flow_amount_abs, diff_type) 序列求和式 hash）
//   用于 D30 方案(b) ATTACH 汇总时的有序内容比对
function fingerprint(rows) {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha256');
  for (const r of rows) {
    h.update(`${r.bill_import_id}|${r.flow_currency}|${r.flow_amount_abs}|${r.diff_type}\n`);
  }
  return h.digest('hex');
}

// ─────────────────────────────────────────────────────────────────
// 临时 DB 生命周期
// ─────────────────────────────────────────────────────────────────
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poc-v2112-mw-'));
}
function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

module.exports = {
  PRAGMA_STATEMENTS,
  BILL_TABLE, FLOW_TABLE, RUNS_TABLE, DIFF_TABLE,
  openDb,
  createSchema,
  seedData,
  insertRun,
  countBillRows,
  buildInsertSelectSql,
  buildSelectOnlySql,
  runBaselineSingleWorker,
  dumpDiffRowsOrdered,
  compareDiffRows,
  fingerprint,
  makeTempDir,
  cleanupDir,
};
