// v2.1.12 β.1-T2 — acquiring 多 worker write-splitting byte-for-byte contract test（🔴 资金红线）
//
// 本任务核心交付物：锁死「多 worker 路径产出的 diff_rows（内容 + 物理插入顺序）与单 worker 逐 chunk
// INSERT...SELECT 逐行完全一致」（合并门槛级指标）。
//
// 三方对比：
//   ① 单 worker  runRepo.insertDiffRowsByJoinChunked（生产 byte-for-byte 真理源）
//   ② 多 worker  runRepo.insertDiffRowsByJoinMultiWorker（M=2 / M=4，plan-b）
//   ③ 主进程直跑 session.runCheckCore（单 worker baseline vs 多 worker gate，端到端集成）
//
// 断言：diff_rows 按 `ORDER BY id ASC`（物理插入顺序）取回，逐行四列严格相等 + 行数相等。
//
// 覆盖：
//   - 多档数据集（~50 / 500 / 5000 bill 行，混币种制造 diff）
//   - 跨 chunk 边界（chunkSize < 总行数）/ 单 chunk（chunkSize >= 总行数）/ 0 diff / 空表
//   - Group A：repository 级（fixture schema + 真实表名，直接调两个 repo 函数；快、确定性）
//   - Group B：runCheckCore 级（真实 AppDatabase + 真实 import，验 gate 分流 + 自适应分片 + chunk_progress complete）
//
// 自包含：Group A 模块内造小 fixture sqlite（真实 acquiring 表名子集）；Group B 复用 session import 链路。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');

const runRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');
const mw = require('../../../src/main-process/run-check-multiworker');
const session = require('../../../src/main-process/acquiring-bill-currency-session');

// ─────────────────────────────────────────────────────────────────
// 真实 acquiring 表名（与生产 run-repository.js 顶部常量一致）
// ─────────────────────────────────────────────────────────────────
const BILL_TABLE = 'acquiring_bill_currency_bill_imports';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';
const RUNS_TABLE = 'acquiring_bill_currency_runs';
const MONTH_KEY = '2026-03';

const PRAGMA = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',
  'PRAGMA mmap_size = 268435456;',
  'PRAGMA busy_timeout = 30000;',
];

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'];

// 复刻 acquiring schema 最小子集（列名 / 比对所需字段与生产一致）
//   注：生产 schema 更宽（含 raw_json / source_file 等），但 insertDiffRowsByJoinChunked
//   / buildSelectOnlyChunkSql 只读 id / month_key / recon_main_id / settle_currency / settle_currency_norm
//   / settle_amount_abs，故此子集足以锁 byte-for-byte 行为。
function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FLOW_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_amount_abs TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_join ON ${FLOW_TABLE}(month_key, recon_main_id);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${BILL_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bill_join ON ${BILL_TABLE}(month_key, recon_main_id);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DIFF_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL
    );
  `);
}

// 确定性造数（xorshift32 固定种子）—— 单 / 多 worker 跑同一份数据
//   diffRatio 控制 diff 占比；diffRatio=0 → 全匹配（0 diff）
function seedData(db, rows, { diffRatio = 0.3 } = {}) {
  let s = 0x2545f491;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
  db.exec('BEGIN');
  const billStmt = db.prepare(
    `INSERT INTO ${BILL_TABLE} (month_key, recon_main_id, settle_currency, settle_currency_norm) VALUES (?, ?, ?, ?)`
  );
  const flowStmt = db.prepare(
    `INSERT INTO ${FLOW_TABLE} (month_key, recon_main_id, settle_amount_abs, settle_currency, settle_currency_norm) VALUES (?, ?, ?, ?, ?)`
  );
  const missingCut = diffRatio > 0 ? diffRatio / 3 : 0;       // 1/3 of diff = 缺失
  const mismatchCut = diffRatio;                              // 其余到 diffRatio = 不一致
  for (let i = 0; i < rows; i++) {
    const reconId = `RID${String(i).padStart(7, '0')}`;
    const flowCur = CURRENCIES[Math.floor(rand() * CURRENCIES.length)];
    const r = rand();
    let billCur;
    if (r < missingCut) {
      billCur = ''; // 缺失 → bill_currency_missing
    } else if (r < mismatchCut) {
      let c = CURRENCIES[Math.floor(rand() * CURRENCIES.length)];
      if (c === flowCur) c = CURRENCIES[(CURRENCIES.indexOf(flowCur) + 1) % CURRENCIES.length];
      billCur = c; // 不一致 → currency_mismatch
    } else {
      billCur = flowCur; // 一致 → 不进 diff
    }
    const amount = (rand() * 100000).toFixed(2);
    billStmt.run(MONTH_KEY, reconId, billCur, billCur.trim().toLowerCase());
    flowStmt.run(MONTH_KEY, reconId, amount, flowCur, flowCur.trim().toLowerCase());
  }
  db.exec('COMMIT');
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  for (const sql of PRAGMA) db.exec(sql);
  return db;
}

// 取回 diff_rows（按物理插入顺序 id ASC）；逐行四列
function dumpDiffRows(db, runId) {
  return db.prepare(
    `SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type FROM ${DIFF_TABLE} WHERE run_id = ? ORDER BY id ASC`
  ).all(runId);
}

// byte-for-byte 逐行比对（内容 + 物理顺序）
function compareRows(a, b) {
  if (a.length !== b.length) {
    return { equal: false, firstDiffAt: Math.min(a.length, b.length), reason: `length ${a.length} vs ${b.length}` };
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      String(x.bill_import_id) !== String(y.bill_import_id) ||
      String(x.flow_currency) !== String(y.flow_currency) ||
      String(x.flow_amount_abs) !== String(y.flow_amount_abs) ||
      String(x.diff_type) !== String(y.diff_type)
    ) {
      return { equal: false, firstDiffAt: i, reason: `row ${i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}` };
    }
  }
  return { equal: true, firstDiffAt: -1, reason: null };
}

// 起一个 fixture DB（真实表名）；返回 { dir, dbPath, db, cleanup }
function setupDb(rows, seedOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-contract-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = openDb(dbPath);
  createSchema(db);
  seedData(db, rows, seedOpts);
  return {
    dir,
    dbPath,
    db,
    cleanup() {
      try { db.close(); } catch (_e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

function countTempParts(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/^part-\d+\.sqlite(-wal|-shm|-journal)?$/.test(f)) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────
// Group A — repository 级三方 byte-for-byte
//   单 worker insertDiffRowsByJoinChunked（runId=1） vs 多 worker insertDiffRowsByJoinMultiWorker（runId=2/3）
//   覆盖多档 × M=2/4 × chunk 边界。
// ─────────────────────────────────────────────────────────────────
test.describe('β.1-T2 多 worker contract（Group A：repository 级 byte-for-byte）', () => {

  // 多档 × chunk 边界（跨 chunk）× M
  const MATRIX = [
    { label: '~50 行 / chunkSize 10（5 chunks 跨边界）', rows: 50, chunkSize: 10 },
    { label: '500 行 / chunkSize 100（5 chunks 跨边界）', rows: 500, chunkSize: 100 },
    { label: '500 行 / chunkSize 50（10 chunks 喂饱 M=4）', rows: 500, chunkSize: 50 },
    { label: '5000 行 / chunkSize 500（10 chunks）', rows: 5000, chunkSize: 500 },
    { label: '5000 行 / chunkSize 137（非整除边界）', rows: 5000, chunkSize: 137 },
  ];

  for (const cfg of MATRIX) {
    for (const M of [2, 4]) {
      test(`A1.[${cfg.label}] M=${M} 🔴 多 worker == 单 worker 逐行一致`, async () => {
        const ctx = setupDb(cfg.rows);
        const tempDir = mw.makeTempDir();
        try {
          // ① 单 worker baseline（runId=1）
          const base = runRepo.insertDiffRowsByJoinChunked(ctx.db, {
            runId: 1, monthKey: MONTH_KEY, chunkSize: cfg.chunkSize,
          });
          const baseRows = dumpDiffRows(ctx.db, 1);
          assert.ok(baseRows.length > 0, `baseline diff 应 > 0（实际 ${baseRows.length}）`);

          // ② 多 worker（runId=2）
          const mwRes = await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
            runId: 2, monthKey: MONTH_KEY, chunkSize: cfg.chunkSize,
            dbPath: ctx.dbPath, workerCount: M, tempDir,
          });

          // 形状一致（与单 worker 同字段）
          assert.equal(mwRes.totalChunks, base.totalChunks, `totalChunks 一致（base=${base.totalChunks} mw=${mwRes.totalChunks}）`);
          assert.equal(mwRes.totalInsertedDiffRows, base.totalInsertedDiffRows,
            `插入行数一致（base=${base.totalInsertedDiffRows} mw=${mwRes.totalInsertedDiffRows}）`);
          assert.equal(mwRes.totalProcessedBillRows, base.totalProcessedBillRows, 'totalProcessedBillRows 一致');
          assert.equal(mwRes.lastCompletedChunkIndex, base.lastCompletedChunkIndex, 'lastCompletedChunkIndex 一致');

          // 🔴 byte-for-byte（内容 + 物理插入顺序）
          const mwRows = dumpDiffRows(ctx.db, 2);
          const cmp = compareRows(baseRows, mwRows);
          assert.equal(cmp.equal, true, `🔴 byte-for-byte 失败 @${cmp.firstDiffAt}：${cmp.reason}`);

          // temp 不泄漏
          assert.equal(countTempParts(tempDir), 0, 'temp part 文件应清空（不泄漏）');
        } finally {
          mw.cleanupDir(tempDir);
          ctx.cleanup();
        }
      });
    }
  }

  // 单 chunk（chunkSize >= 总行数）
  test('A2. 单 chunk（chunkSize >= 总行数）🔴 byte-for-byte 一致', async () => {
    const ctx = setupDb(50);
    const tempDir = mw.makeTempDir();
    try {
      const base = runRepo.insertDiffRowsByJoinChunked(ctx.db, { runId: 1, monthKey: MONTH_KEY, chunkSize: 100000 });
      const baseRows = dumpDiffRows(ctx.db, 1);
      const mwRes = await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
        runId: 2, monthKey: MONTH_KEY, chunkSize: 100000, dbPath: ctx.dbPath, workerCount: 4, tempDir,
      });
      assert.equal(mwRes.totalChunks, 1, 'totalChunks=1（单 chunk）');
      assert.equal(mwRes.totalChunks, base.totalChunks, 'totalChunks 与 baseline 一致');
      const cmp = compareRows(baseRows, dumpDiffRows(ctx.db, 2));
      assert.equal(cmp.equal, true, `byte-for-byte 失败：${cmp.reason}`);
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // 0 diff（全匹配 → diff_rows 0 行）
  test('A3. 0 diff（全匹配）→ 两路均 0 行 + totalChunks/lastCompletedChunkIndex 一致', async () => {
    const ctx = setupDb(500, { diffRatio: 0 });
    const tempDir = mw.makeTempDir();
    try {
      const base = runRepo.insertDiffRowsByJoinChunked(ctx.db, { runId: 1, monthKey: MONTH_KEY, chunkSize: 100 });
      const baseRows = dumpDiffRows(ctx.db, 1);
      assert.equal(baseRows.length, 0, 'baseline 0 diff');
      const mwRes = await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
        runId: 2, monthKey: MONTH_KEY, chunkSize: 100, dbPath: ctx.dbPath, workerCount: 4, tempDir,
      });
      assert.equal(mwRes.totalInsertedDiffRows, 0, '多 worker 0 diff');
      assert.equal(mwRes.totalChunks, base.totalChunks, 'totalChunks 一致（仍按 bill 行数切 chunk）');
      assert.equal(mwRes.lastCompletedChunkIndex, base.lastCompletedChunkIndex, 'lastCompletedChunkIndex 一致');
      assert.equal(dumpDiffRows(ctx.db, 2).length, 0, '多 worker diff_rows 0 行');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // 空表（0 bill 行）→ 0 chunk 边界
  test('A4. 空表（0 bill 行）→ totalChunks=0 / lastCompletedChunkIndex=-1（与单 worker 一致，不起 worker）', async () => {
    const ctx = setupDb(0);
    const tempDir = mw.makeTempDir();
    try {
      const base = runRepo.insertDiffRowsByJoinChunked(ctx.db, { runId: 1, monthKey: MONTH_KEY, chunkSize: 100 });
      assert.equal(base.totalChunks, 0, 'baseline totalChunks=0');
      assert.equal(base.lastCompletedChunkIndex, -1, 'baseline lastCompletedChunkIndex=-1');
      const mwRes = await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
        runId: 2, monthKey: MONTH_KEY, chunkSize: 100, dbPath: ctx.dbPath, workerCount: 4, tempDir,
      });
      assert.equal(mwRes.totalChunks, 0, '多 worker totalChunks=0');
      assert.equal(mwRes.lastCompletedChunkIndex, -1, '多 worker lastCompletedChunkIndex=-1');
      assert.equal(mwRes.totalInsertedDiffRows, 0, '0 diff');
      // 0 chunk 不应建任何 temp part
      assert.equal(countTempParts(tempDir), 0, '0 chunk 不建 temp part');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // 🔴 失败保守处理（任务要点 5）：reader 阶段 worker crash → reject + 本 run diff_rows 0 行（不留半套数据）
  test('A6. 🔴 worker crash（reader 阶段）→ reject + 本 run diff_rows 清空（不留半套数据）', async () => {
    const ctx = setupDb(600);
    const tempDir = mw.makeTempDir();
    const crashWorker = path.join(__dirname, '__fixtures__', 'multiworker-chunk-crash-worker.js');
    mw.__test_only_set_worker_script__(crashWorker);
    try {
      // 先预置一些「脏」diff_rows（runId=2，模拟前序残留）→ 验证 catch 里的 DELETE WHERE run_id 清干净
      ctx.db.exec('BEGIN');
      ctx.db.prepare(
        `INSERT INTO ${DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (2, 999, 'USD', '1.00', 'currency_mismatch')`
      ).run();
      ctx.db.exec('COMMIT');
      assert.equal(dumpDiffRows(ctx.db, 2).length, 1, '预置 1 行脏数据');

      let rejectErr;
      try {
        await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
          runId: 2, monthKey: MONTH_KEY, chunkSize: 100, dbPath: ctx.dbPath, workerCount: 2, tempDir,
        });
      } catch (e) { rejectErr = e; }

      assert.ok(rejectErr, 'worker crash 应 reject');
      assert.ok(/worker|exit|crash/i.test(rejectErr.message), `reject 错误应反映 worker 崩溃（实际：${rejectErr.message}）`);
      // 🔴 失败后本 run diff_rows 必须 0 行（catch DELETE 清掉预置脏数据 + 任何半套数据）
      assert.equal(dumpDiffRows(ctx.db, 2).length, 0, `🔴 失败后本 run diff_rows 应 0 行（不留半套数据）`);
      // 其他 run（runId=1）不受影响（DELETE 仅 WHERE run_id=2）—— 此处无 runId=1 数据，验证 DELETE 范围即可
      assert.equal(countTempParts(tempDir), 0, 'temp 不泄漏');
    } finally {
      mw.__test_only_set_worker_script__(null);
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // 🔴 失败保守处理：DELETE WHERE run_id 范围正确性 —— 失败只清本 run，不误伤其他 run
  test('A7. 🔴 失败清理范围：DELETE 仅清本 run（runId=2），不误伤 runId=1 的有效 diff', async () => {
    const ctx = setupDb(600);
    const tempDir = mw.makeTempDir();
    const crashWorker = path.join(__dirname, '__fixtures__', 'multiworker-chunk-crash-worker.js');
    try {
      // runId=1：单 worker 正常跑出有效 diff（必须在失败清理后存活）
      const base = runRepo.insertDiffRowsByJoinChunked(ctx.db, { runId: 1, monthKey: MONTH_KEY, chunkSize: 100 });
      const base1Rows = dumpDiffRows(ctx.db, 1);
      assert.ok(base1Rows.length > 0, 'runId=1 有效 diff > 0');

      // runId=2：多 worker crash → catch DELETE WHERE run_id=2
      mw.__test_only_set_worker_script__(crashWorker);
      let rejectErr;
      try {
        await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
          runId: 2, monthKey: MONTH_KEY, chunkSize: 100, dbPath: ctx.dbPath, workerCount: 2, tempDir,
        });
      } catch (e) { rejectErr = e; }
      assert.ok(rejectErr, '应 reject');

      // runId=1 的有效 diff 必须原样存活（DELETE 仅清 runId=2）
      const after1 = dumpDiffRows(ctx.db, 1);
      assert.equal(after1.length, base1Rows.length, `runId=1 diff 不应被误删（before=${base1Rows.length} after=${after1.length}）`);
      assert.equal(dumpDiffRows(ctx.db, 2).length, 0, 'runId=2 清空');
    } finally {
      mw.__test_only_set_worker_script__(null);
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // 三方同跑：单 worker（runId=1） vs M=2（runId=2） vs M=4（runId=3）—— 三者两两一致
  test('A5. 三方一致：单 worker vs M=2 vs M=4 同一份数据 diff_rows 逐行相等', async () => {
    const ctx = setupDb(2000);
    const tempDir2 = mw.makeTempDir();
    const tempDir4 = mw.makeTempDir();
    try {
      const chunkSize = 73; // 非整除 → ceil(2000/73)=28 chunks，喂饱并行 + 末 chunk 非满
      runRepo.insertDiffRowsByJoinChunked(ctx.db, { runId: 1, monthKey: MONTH_KEY, chunkSize });
      await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
        runId: 2, monthKey: MONTH_KEY, chunkSize, dbPath: ctx.dbPath, workerCount: 2, tempDir: tempDir2,
      });
      await runRepo.insertDiffRowsByJoinMultiWorker(ctx.db, {
        runId: 3, monthKey: MONTH_KEY, chunkSize, dbPath: ctx.dbPath, workerCount: 4, tempDir: tempDir4,
      });
      const r1 = dumpDiffRows(ctx.db, 1);
      const r2 = dumpDiffRows(ctx.db, 2);
      const r3 = dumpDiffRows(ctx.db, 3);
      assert.ok(r1.length > 0, 'diff 应 > 0');
      const c12 = compareRows(r1, r2);
      assert.equal(c12.equal, true, `单 worker vs M=2 失败 @${c12.firstDiffAt}：${c12.reason}`);
      const c13 = compareRows(r1, r3);
      assert.equal(c13.equal, true, `单 worker vs M=4 失败 @${c13.firstDiffAt}：${c13.reason}`);
    } finally {
      mw.cleanupDir(tempDir2);
      mw.cleanupDir(tempDir4);
      ctx.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Group B — runCheckCore 级 gate（真实 AppDatabase + 真实 import）
//   验：stage 4' gate 分流（单 worker baseline vs 多 worker）+ 自适应分片 + chunk_progress complete
// ─────────────────────────────────────────────────────────────────
const { AppDatabase } = require('../../../src/backend/database');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../../src/backend/acquiring-bill-currency-db/columns');

function makeFlow(date, id, flowCcy, billCcy) {
  const r = new Array(48).fill('');
  r[0] = date;
  r[6] = id;
  r[12] = '100';
  r[13] = flowCcy;
  r[28] = '100';
  r[29] = billCcy;
  return r;
}
function makeBill(date, id, currency) {
  const r = new Array(26).fill('');
  r[0] = date;
  r[14] = id;
  r[18] = '100';
  r[19] = currency;
  return r;
}

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

const FIXTURE_DATE = '2026-04-15';
const FIXTURE_MONTH = '2026-04';

// 造 N bill 行（混币种），其中约 1/3 mismatch；返回 { tmpdir, dbPath, db, cleanup }
async function setupRealDb(billCount) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-contract-rc-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const flowRows = [];
  const billRows = [];
  for (let i = 0; i < billCount; i++) {
    const id = `RID${String(i).padStart(6, '0')}`;
    const mod = i % 3;
    if (mod === 0) {
      // mismatch：流水 USD，单据 EUR
      flowRows.push(makeFlow(FIXTURE_DATE, id, 'USD', 'USD'));
      billRows.push(makeBill(FIXTURE_DATE, id, 'EUR'));
    } else if (mod === 1) {
      // 全匹配 USD-USD
      flowRows.push(makeFlow(FIXTURE_DATE, id, 'USD', 'USD'));
      billRows.push(makeBill(FIXTURE_DATE, id, 'USD'));
    } else {
      // 全匹配 JPY-JPY
      flowRows.push(makeFlow(FIXTURE_DATE, id, 'JPY', 'JPY'));
      billRows.push(makeBill(FIXTURE_DATE, id, 'JPY'));
    }
  }

  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');
  await writeXlsx(flowFile, FLOW_HEADERS, flowRows);
  await writeXlsx(billFile, BILL_HEADERS, billRows);
  await session.importFlowFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [billFile] });

  return {
    tmpdir, dbPath, db,
    cleanup() {
      try { db.db.close(); } catch (_e) {}
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

// 取 run_id 最大那次 run 的 diff_rows（按 id ASC 物理顺序）+ chunk_progress
function snapshotRun(db) {
  const runRow = db.prepare(`SELECT id, chunk_progress FROM ${RUNS_TABLE} ORDER BY id DESC LIMIT 1`).get();
  const rows = db.prepare(
    `SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type FROM ${DIFF_TABLE} WHERE run_id = ? ORDER BY id ASC`
  ).all(runRow.id);
  return { runId: runRow.id, chunkProgress: runRow.chunk_progress, rows };
}

test.describe('β.1-T2 多 worker contract（Group B：runCheckCore 级 gate）', () => {

  // 单 worker baseline（不传 workerCount → default 1）vs 多 worker（workerCount=2 + dbPath + tempDir）
  //   两个独立 tmpdir / 独立 db，同一份 fixture → diff_rows byte-for-byte 一致
  for (const billCount of [60, 600]) {
    test(`B1.[${billCount} bill] 🔴 runCheckCore 多 worker(M=2) == 单 worker baseline 逐行一致`, async () => {
      const A = await setupRealDb(billCount); // 单 worker
      const B = await setupRealDb(billCount); // 多 worker
      const tempDir = mw.makeTempDir();
      try {
        // A：单 worker（default workerCount，按生产合同同步发布耐久输出）
        const ra = await session.runCheckCore({
          db: A.db.db, monthKey: FIXTURE_MONTH,
          storageRoot: A.tmpdir,
          chunkSize: 50, // 小 chunk 制造跨 chunk 边界（billCount/50 chunks）
        });
        const snapA = snapshotRun(A.db.db);

        // B：多 worker（workerCount=2 + dbPath + tempDir → 走 insertDiffRowsByJoinMultiWorker）
        //   v2.1.12 β.1-T3：__forceMultiWorkerForTest 跳过 D31 行数闸（小 fixture 不足 100w 否则会回退单 worker，
        //     GroupB 就失去多 worker 覆盖）；chunkSize:50 与 A 对齐 → billCount/50 个 chunk（≥2）真正跑 M=2 并行。
        const rb = await session.runCheckCore({
          db: B.db.db, monthKey: FIXTURE_MONTH,
          storageRoot: B.tmpdir,
          chunkSize: 50,
          workerCount: 2, dbPath: B.dbPath, tempDir,
          __forceMultiWorkerForTest: true,
        });
        const snapB = snapshotRun(B.db.db);

        // stats 一致
        assert.equal(ra.mismatchRows, rb.mismatchRows, `mismatchRows 一致（A=${ra.mismatchRows} B=${rb.mismatchRows}）`);
        assert.equal(ra.totalBillRows, rb.totalBillRows, 'totalBillRows 一致');
        assert.equal(ra.matchedRows, rb.matchedRows, 'matchedRows 一致');
        assert.ok(ra.mismatchRows > 0, `应有 mismatch（实际 ${ra.mismatchRows}）`);

        // 🔴 diff_rows byte-for-byte（物理插入顺序 id ASC；bill_import_id 在两 db 独立但同序同值 — 同一份 fixture 同序导入）
        const cmp = compareRows(snapA.rows, snapB.rows);
        assert.equal(cmp.equal, true, `🔴 runCheckCore byte-for-byte 失败 @${cmp.firstDiffAt}：${cmp.reason}`);

        // 多 worker run chunk_progress 应标 complete
        assert.ok(snapB.chunkProgress, 'B 应有 chunk_progress');
        const cp = JSON.parse(snapB.chunkProgress);
        assert.equal(cp.status, 'complete', `多 worker 成功后 chunk_progress.status=complete（实际 ${cp.status}）`);

        // 临时 tempDir 内 part 文件应清空（runWriteSplitChunks finally 清）
        assert.equal(countTempParts(tempDir), 0, 'temp part 不泄漏');
      } finally {
        mw.cleanupDir(tempDir);
        A.cleanup();
        B.cleanup();
      }
    });
  }

  // 🔴 B4 C2（self-review）：resume(lastCompletedChunkIndex=-1) 从 chunk 0 重跑前清本 run 残留 diff_rows
  //   背景：MW run 在 merge 期被硬杀/cancel-terminate/OOM（不经 insertDiffRowsByJoinMultiWorker 的 catch DELETE）
  //   → 部分 chunk 已 COMMIT 残留 + MW 不逐 chunk 标 chunk_progress（恒 -1）→ resume 单 worker 从 0 全跑，
  //   而 clearRunsByMonth 仅在 !isResume → 不清 → diff_rows 翻倍。C2 修复：resumeFromChunkIndex===0 时先清本 run。
  test('B4. 🔴 C2：resume(从 chunk 0)重跑前清本 run 残留 diff_rows（MW 崩/cancel mid-merge 不致翻倍）', async () => {
    const ctx = await setupRealDb(120);
    try {
      // 1) 完整单 worker run → 正确 diff 集（runId R / N 行）
      await session.runCheckCore({
        db: ctx.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
        chunkSize: 50
      });
      const snap1 = snapshotRun(ctx.db.db);
      const N = snap1.rows.length;
      const runId = snap1.runId;
      assert.ok(N > 0, `首次 run 应有 diff（实际 ${N}）`);

      // 2) 模拟「MW 崩/cancel mid-merge」残留态：本 run diff_rows 仍在（此处用全集 N = 最坏情况，不清则翻倍）
      //    + chunk_progress 标 partial 且 lastCompletedChunkIndex=-1（MW 不逐 chunk 标，恒 -1）
      runRepo.setRunChunkProgress(ctx.db.db, {
        runId, lastCompletedChunkIndex: -1, totalChunks: 0, status: 'partial', chunkSize: 50,
      });
      assert.equal(
        ctx.db.db.prepare(`SELECT COUNT(*) AS c FROM ${DIFF_TABLE} WHERE run_id = ?`).get(runId).c, N,
        '残留 N 行就绪'
      );

      // 3) resume 同 runId（单 worker，lastCompletedChunkIndex=-1 → resumeFromChunkIndex=0 全重跑）
      await session.runCheckCore({
        db: ctx.db.db, monthKey: FIXTURE_MONTH, chunkSize: 50,
        storageRoot: ctx.tmpdir,
        resumeFromRun: { runId, lastCompletedChunkIndex: -1 },
      });

      // 4) 🔴 断言：最终 diff_rows == N（C2 清残留再重插），无 C2 修复会翻倍成 2N
      const finalCount = ctx.db.db.prepare(`SELECT COUNT(*) AS c FROM ${DIFF_TABLE} WHERE run_id = ?`).get(runId).c;
      assert.equal(finalCount, N, `🔴 C2：resume 重跑后 diff_rows 应 == N=${N}（清残留再重插），未修复会翻倍成 ${2 * N}（实际 ${finalCount}）`);

      // 内容与首次一致（byte-for-byte）
      const snap2 = snapshotRun(ctx.db.db);
      assert.equal(snap2.runId, runId, 'resume 复用同 runId（未新建 run）');
      const cmp = compareRows(snap1.rows, snap2.rows);
      assert.equal(cmp.equal, true, `🔴 C2 resume 后 diff_rows 内容应与首次一致：${cmp.reason}`);
    } finally {
      ctx.cleanup();
    }
  });

  // gate 回退：workerCount>1 但无 dbPath → 安全回退单 worker（不抛错，结果正确）
  test('B2. gate 回退：workerCount=4 但无 dbPath → 走单 worker（结果正确 + chunk_progress complete）', async () => {
    const ctx = await setupRealDb(120);
    try {
      const r = await session.runCheckCore({
        db: ctx.db.db, monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
        workerCount: 4, // 给了 workerCount 但故意不给 dbPath → useMultiWorker=false
        chunkSize: 50,
      });
      assert.ok(r.mismatchRows > 0, '应有 mismatch');
      const snap = snapshotRun(ctx.db.db);
      const cp = JSON.parse(snap.chunkProgress);
      assert.equal(cp.status, 'complete', '单 worker 路径成功后也 complete');
      // diff_rows 行数 == mismatchRows
      assert.equal(snap.rows.length, r.mismatchRows, 'diff_rows 行数 == mismatchRows');
    } finally {
      ctx.cleanup();
    }
  });

  // default workerCount（不传）零行为变化：与显式 workerCount=1 完全等价（都走单 worker）
  test('B3. default workerCount（不传）== 显式 workerCount=1（都单 worker，diff_rows 一致）', async () => {
    const A = await setupRealDb(90); // 不传 workerCount
    const B = await setupRealDb(90); // 显式 workerCount=1
    try {
      await session.runCheckCore({
        db: A.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: A.tmpdir,
        chunkSize: 30
      });
      await session.runCheckCore({
        db: B.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: B.tmpdir,
        workerCount: 1,
        chunkSize: 30
      });
      const cmp = compareRows(snapshotRun(A.db.db).rows, snapshotRun(B.db.db).rows);
      assert.equal(cmp.equal, true, `default vs workerCount=1 应完全一致：${cmp.reason}`);
    } finally {
      A.cleanup();
      B.cleanup();
    }
  });
});
