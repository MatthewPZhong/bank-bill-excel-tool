/*
 * v2.1.12 β「A3-multi-worker」Phase 0 POC — worker 入口脚本
 *
 * 跑在 worker_threads 子线程内。复用 run-check-worker.js 的连接方式（独立 DatabaseSync + 6 PRAGMA）。
 *
 * write-splitting 的 reader 角色（spec §2.3）：
 *   - worker 持有自己的只读 connection（WAL 下并发 SELECT 不冲突）
 *   - 收到 'select-chunk' → 执行 buildSelectOnlySql(LIMIT/OFFSET) → 结果行 message 回主进程
 *   - worker 不 INSERT diff_rows（写串行留主进程单 writer，避免 SQLITE_BUSY）
 *
 * D30 方案(b) 的 temp-table 角色（'select-chunk-to-temp'）：
 *   - worker 在自己的 connection 里建 temp table + INSERT 本 chunk 结果（写自己的库文件，无跨 worker 写竞争）
 *   - 完成后回 { type:'temp-done', tempDbPath, rowCount }，主进程 ATTACH 汇总
 *
 * Message 协议：
 *   主 → worker:
 *     { type:'init', dbPath }                                  — 打开只读 connection
 *     { type:'select-chunk', jobId, monthKey, limit, offset }  — 方案(a)：SELECT 行回传
 *     { type:'select-chunk-to-temp', jobId, monthKey, limit, offset, tempDbPath } — 方案(b)：写 temp table
 *     { type:'close' }
 *   worker → 主:
 *     { type:'init-done' }
 *     { type:'init-error', error }
 *     { type:'chunk-done', jobId, rows, selectMs, rowCount }   — 方案(a)
 *     { type:'temp-done', jobId, tempDbPath, rowCount, ms }    — 方案(b)
 *     { type:'error', jobId, error }
 */

'use strict';

const { parentPort, isMainThread, workerData } = require('node:worker_threads');

if (isMainThread) {
  // 主线程 require 时不执行 worker 逻辑（仅用于潜在的单测）
  module.exports = {};
  return;
}

// 静默 SQLite ExperimentalWarning（POC surprise #1）
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning' && /SQLite|node:sqlite/.test(w.message || '')) return;
  process.stderr.write(`(poc-worker) ${w && w.name}: ${w && w.message}\n`);
});

const { DatabaseSync } = require('node:sqlite');

const BILL_TABLE = 'acquiring_bill_currency_bill_imports';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';

const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',
  'PRAGMA mmap_size = 268435456;',
  'PRAGMA busy_timeout = 30000;',
];

function serializeError(err) {
  if (!err) return null;
  return { name: err.name || 'Error', message: err.message || String(err), stack: err.stack || null, code: err.code || null };
}

// write-splitting 只读 SELECT（与 lib.buildSelectOnlySql 完全一致 — 列顺序 / ORDER BY / WHERE / JOIN）
const SELECT_ONLY_SQL = `
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

let db = null;          // 主数据源只读 connection
let selectStmt = null;

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  try {
    if (type === 'init') {
      db = new DatabaseSync(msg.dbPath);
      for (const sql of PRAGMA_STATEMENTS) db.exec(sql);
      selectStmt = db.prepare(SELECT_ONLY_SQL);
      parentPort.postMessage({ type: 'init-done' });
      return;
    }

    // ── 方案(a)：SELECT 行回传主进程，主进程单 writer INSERT ──
    if (type === 'select-chunk') {
      const { jobId, monthKey, limit, offset } = msg;
      const t0 = Date.now();
      const rows = selectStmt.all(monthKey, limit, offset);
      const selectMs = Date.now() - t0;
      // 行回传 — structuredClone 自动序列化（rows 是 plain object 数组）
      parentPort.postMessage({ type: 'chunk-done', jobId, rows, rowCount: rows.length, selectMs });
      return;
    }

    // ── 方案(b)：worker 写自己的 temp table（独立库文件，无跨 worker 写竞争）──
    if (type === 'select-chunk-to-temp') {
      const { jobId, monthKey, limit, offset, tempDbPath } = msg;
      const t0 = Date.now();
      // worker 在自己的库里 ATTACH 一个独立 temp 库，INSERT...SELECT 写进去（读主源 + 写 temp 同一 connection）
      const tdb = new DatabaseSync(tempDbPath);
      for (const sql of PRAGMA_STATEMENTS) tdb.exec(sql);
      tdb.exec(`
        CREATE TABLE IF NOT EXISTS diff_part (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_import_id INTEGER,
          flow_currency TEXT,
          flow_amount_abs TEXT,
          diff_type TEXT
        );
      `);
      // 从主源 db SELECT（已 open），逐行写入 tdb
      const rows = selectStmt.all(monthKey, limit, offset);
      const ins = tdb.prepare(`INSERT INTO diff_part (bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?, ?, ?, ?)`);
      tdb.exec('BEGIN');
      for (const r of rows) {
        ins.run(r.bill_import_id, r.flow_currency, r.flow_amount_abs, r.diff_type);
      }
      tdb.exec('COMMIT');
      tdb.close();
      parentPort.postMessage({ type: 'temp-done', jobId, tempDbPath, rowCount: rows.length, ms: Date.now() - t0 });
      return;
    }

    if (type === 'close') {
      try { if (db) db.close(); } catch (_e) {}
      process.exit(0);
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', jobId: msg && msg.jobId ? msg.jobId : null, error: serializeError(err) });
  }
});
