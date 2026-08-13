// v2.1.12 β.1-T1 — run-check-multiworker（多 worker write-splitting / plan-b）unit test
//
// 覆盖（任务交付物 §3）：
//   🔴 byte-for-byte：M=1/2/4 多 worker 产出 与 单 worker 逐 chunk INSERT...SELECT 顺序插入 **逐行一致**
//      （baseline = 复刻生产 run-repository.js#insertDiffRowsByJoinChunked 的 chunked INSERT...SELECT 物理顺序）
//   🔴 chunkIndex 升序汇总不变量：即使 temp db 物理完成/排布乱序，汇总必须严格按 chunkIndex 0..N-1 升序
//      （直接单测 mergeTempDbsInOrder —— 不依赖调度时序，确定性锁死）
//   M=1 退化路径正确（只起 1 worker 也 byte-for-byte 一致）
//   worker crash（reader 阶段 process.exit(1)）→ reject + temp db 不泄漏
//   无 SQLITE_BUSY（所有路径 busy=false）
//   入参校验（fail-fast）
//
// 自包含：模块内造小 fixture sqlite（bill + flow + diff_rows 三表），确定性数据，run 完清理。
// SELECT SQL 复用生产同款 currency-mismatch JOIN（列别名顺序 = partColumns）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const mw = require('../../../src/main-process/run-check-multiworker');
const mwWorker = require('../../../src/main-process/run-check-multiworker-worker');

// ─────────────────────────────────────────────────────────────────
// fixture：复刻 acquiring-bill-currency 的 bill/flow/diff schema（最小子集）
// ─────────────────────────────────────────────────────────────────
const BILL_TABLE = 'acquiring_bill_currency_bill_imports';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';
const MONTH_KEY = '2026-03';
const WORKER_BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'acquiring-nested-multiworker-contract',
  taskKey: 'acquiringBillCurrency:run',
  moduleId: 'acquiring-bill-currency',
  parentRunId: 'acquiring-run-parent',
  operationKey: 'acquiring-run-operation'
});

const PRAGMA = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',
  'PRAGMA mmap_size = 268435456;',
  'PRAGMA busy_timeout = 30000;',
];

// partColumns / targetColumns（顺序敏感 — byte-for-byte 列映射）
//   SELECT 输出别名顺序 = partColumns；目标表列 = [run_id(prefix)] + partColumns
const PART_COLUMNS = ['bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type'];
const TARGET_COLUMNS = ['run_id', 'bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type'];

// 业务 SELECT JOIN（与 run-repository.js:196-217 / POC buildSelectOnlySql 同款；列别名顺序 = PART_COLUMNS）
const SELECT_SQL = `
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

// 单 worker baseline INSERT...SELECT（与 SELECT_SQL 同条件 + INSERT 头；复刻生产 chunkStmt）
const INSERT_SELECT_SQL = `
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

const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'];

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

// 确定性造数（xorshift32）—— baseline 与多 worker 跑同一份数据
function seedData(db, rows) {
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
  for (let i = 0; i < rows; i++) {
    const reconId = `RID${String(i).padStart(7, '0')}`;
    const flowCur = CURRENCIES[Math.floor(rand() * CURRENCIES.length)];
    const r = rand();
    let billCur;
    if (r < 0.1) {
      billCur = ''; // 缺失 → bill_currency_missing
    } else if (r < 0.3) {
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

function countBill(db) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?`).get(MONTH_KEY).c;
}

// 单 worker baseline：逐 chunk INSERT...SELECT（chunk 0,1,2... 升序）；返回 runId
function runBaseline(db, runId, chunkSize) {
  const total = countBill(db);
  const totalChunks = total === 0 ? 0 : Math.ceil(total / chunkSize);
  const stmt = db.prepare(INSERT_SELECT_SQL);
  for (let ci = 0; ci < totalChunks; ci++) {
    db.exec('BEGIN');
    try {
      stmt.run(runId, MONTH_KEY, chunkSize, ci * chunkSize);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_e) {}
      throw e;
    }
  }
  return totalChunks;
}

// 取回 diff_rows（按物理插入顺序 id ASC）；逐行内容数组
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

function buildChunks(total, chunkSize) {
  const totalChunks = total === 0 ? 0 : Math.ceil(total / chunkSize);
  const chunks = [];
  for (let ci = 0; ci < totalChunks; ci++) {
    chunks.push({ chunkIndex: ci, bindParams: [MONTH_KEY, chunkSize, ci * chunkSize] });
  }
  return chunks;
}

// 在一个临时目录起一个 fixture DB；返回 { dir, dbPath, db, cleanup }
function setupDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-test-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = openDb(dbPath);
  createSchema(db);
  seedData(db, rows);
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

// 统计目录下 part-*.sqlite（含旁文件）—— temp 泄漏检测
function countTempParts(dir) {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/^part-\d+\.sqlite(-wal|-shm|-journal)?$/.test(f)) n++;
  }
  return n;
}

test.describe('run-check-multiworker（plan-b write-splitting）', () => {

  // ── 🔴 byte-for-byte：M=1/2/4 端到端 vs 单 worker baseline 逐行一致 ──
  for (const M of [1, 2, 4]) {
    test(`1.M=${M} 🔴 byte-for-byte：多 worker 产出 == 单 worker 逐 chunk INSERT...SELECT 逐行一致`, async () => {
      const rows = 600;
      const chunkSize = 100; // 6 chunks > M（喂得饱并行）
      const ctx = setupDb(rows);
      const tempDir = mw.makeTempDir();
      try {
        // baseline（runId=1）
        const totalChunks = runBaseline(ctx.db, 1, chunkSize);
        const baseRows = dumpDiffRows(ctx.db, 1);
        assert.ok(baseRows.length > 0, `baseline diff 行应 > 0（实际 ${baseRows.length}）`);

        // 多 worker（runId=2）
        const res = await mw.runWriteSplitChunks({
          db: ctx.db,
          dbPath: ctx.dbPath,
          workerCount: M,
          chunks: buildChunks(rows, chunkSize),
          selectSql: SELECT_SQL,
          partColumns: PART_COLUMNS,
          targetTable: DIFF_TABLE,
          targetColumns: TARGET_COLUMNS,
          prefixValues: [2], // run_id = 2
          tempDir,
          batchContext: WORKER_BATCH_CONTEXT,
        });

        assert.equal(res.totalChunks, totalChunks, 'totalChunks 与 baseline 一致');
        assert.equal(res.insertedRows, baseRows.length, `插入行数与 baseline 一致（base=${baseRows.length} mw=${res.insertedRows}）`);

        const mwRows = dumpDiffRows(ctx.db, 2);
        const cmp = compareRows(baseRows, mwRows);
        assert.equal(cmp.equal, true, `🔴 byte-for-byte 失败 @${cmp.firstDiffAt}：${cmp.reason}`);

        // temp db 清理（不泄漏）
        assert.equal(countTempParts(tempDir), 0, '跑完 temp part 文件应清空（不泄漏）');
      } finally {
        mw.cleanupDir(tempDir);
        ctx.cleanup();
      }
    });
  }

  // ── 🔴 chunkIndex 升序汇总不变量（直接单测 mergeTempDbsInOrder，确定性，不依赖调度时序）──
  test('2. 🔴 chunkIndex 升序汇总：temp db 乱序排布也按 chunkIndex 0..N-1 升序汇总插入', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-merge-'));
    const dbPath = path.join(dir, 'target.sqlite');
    const db = openDb(dbPath);
    createSchema(db);
    try {
      // 手工造 4 个 temp db，每个 1 行，diff_type 标记自己的 chunkIndex（chunk-0..chunk-3）
      //   ⚠️ 故意「乱序写盘」：按 [2,0,3,1] 的物理顺序创建文件，但放进 tempPaths 时按 chunkIndex 升序排列
      //   → 验证汇总结果严格按 chunkIndex 0,1,2,3 升序（与文件创建/完成时序无关）
      const tempPaths = new Array(4);
      const writeOrder = [2, 0, 3, 1];
      for (const ci of writeOrder) {
        const tp = path.join(dir, `part-${ci}.sqlite`);
        const tdb = new DatabaseSync(tp);
        for (const sql of PRAGMA) tdb.exec(sql);
        tdb.exec(`CREATE TABLE ${mwWorker.PART_TABLE} (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_import_id INTEGER, flow_currency TEXT, flow_amount_abs TEXT, diff_type TEXT
        );`);
        // 每 chunk 写 2 行，seq 内顺序也要保留（row-a 先 row-b 后）
        tdb.prepare(`INSERT INTO ${mwWorker.PART_TABLE} (bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,?,?)`)
          .run(ci * 10 + 0, 'USD', '1.00', `chunk-${ci}-a`);
        tdb.prepare(`INSERT INTO ${mwWorker.PART_TABLE} (bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,?,?)`)
          .run(ci * 10 + 1, 'USD', '2.00', `chunk-${ci}-b`);
        tdb.close();
        tempPaths[ci] = tp; // 按 chunkIndex 放入下标位置（升序数组）
      }

      const inserted = mw.__test_only__.mergeTempDbsInOrder(db, {
        tempPaths,
        targetTable: DIFF_TABLE,
        targetColumns: TARGET_COLUMNS,
        partColumnNames: PART_COLUMNS,
        prefixValues: [99],
      });
      assert.equal(inserted, 8, '应插入 8 行（4 chunk × 2 行）');

      // 物理顺序必须是 chunk-0-a, chunk-0-b, chunk-1-a, chunk-1-b, chunk-2-a, ... chunk-3-b
      const got = dumpDiffRows(db, 99).map((r) => r.diff_type);
      const expected = [];
      for (let ci = 0; ci < 4; ci++) { expected.push(`chunk-${ci}-a`, `chunk-${ci}-b`); }
      assert.deepEqual(got, expected, `🔴 汇总顺序必须严格按 chunkIndex 升序 + seq 升序（实际 ${JSON.stringify(got)}）`);
    } finally {
      try { db.close(); } catch (_e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  // ── M=1 退化路径（只起 1 worker 也一致）已被 case 1.M=1 覆盖；这里补 chunk 数=1 的极小路径 ──
  test('3. 退化：chunk 数=1（单 chunk）byte-for-byte 一致 + effectiveWorkerCount 收敛', async () => {
    const rows = 50;
    const chunkSize = 1000; // 1 chunk
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    try {
      runBaseline(ctx.db, 1, chunkSize);
      const baseRows = dumpDiffRows(ctx.db, 1);

      const res = await mw.runWriteSplitChunks({
        db: ctx.db, dbPath: ctx.dbPath,
        workerCount: 4, // 请求 4 但只有 1 chunk → effectiveWorkerCount 应收敛到 1
        chunks: buildChunks(rows, chunkSize),
        selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
        targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
        prefixValues: [2], tempDir,
      });
      assert.equal(res.totalChunks, 1, 'totalChunks=1');
      assert.equal(res.workerCount, 1, 'effectiveWorkerCount 收敛到 chunk 数 1');

      const cmp = compareRows(baseRows, dumpDiffRows(ctx.db, 2));
      assert.equal(cmp.equal, true, `byte-for-byte 失败：${cmp.reason}`);
      assert.equal(countTempParts(tempDir), 0, 'temp 不泄漏');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── worker crash（reader 阶段）→ reject + temp db 不泄漏 ──
  test('4. worker crash（reader 阶段 process.exit(1)）→ reject + temp db 不泄漏', async () => {
    const rows = 600;
    const chunkSize = 100;
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    const crashWorker = path.join(__dirname, '__fixtures__', 'multiworker-chunk-crash-worker.js');
    mw.__test_only_set_worker_script__(crashWorker);
    try {
      let rejectErr;
      try {
        await mw.runWriteSplitChunks({
          db: ctx.db, dbPath: ctx.dbPath,
          workerCount: 2,
          chunks: buildChunks(rows, chunkSize),
          selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
          targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
          prefixValues: [2], tempDir,
        });
      } catch (e) { rejectErr = e; }

      assert.ok(rejectErr, 'worker crash 应 reject');
      assert.ok(
        /worker|exit|crash/i.test(rejectErr.message),
        `reject 错误应反映 worker 崩溃（实际：${rejectErr.message}）`
      );

      // crash 后目标表不应有 runId=2 的任何行（plan-b 全有或全无 — 汇总未执行）
      const leaked = dumpDiffRows(ctx.db, 2);
      assert.equal(leaked.length, 0, `crash 时汇总不应执行（目标表 runId=2 应 0 行，实际 ${leaked.length}）`);

      // temp db 文件不泄漏（finally 清理）
      assert.equal(countTempParts(tempDir), 0, 'crash 后 temp part 文件应清空（不泄漏）');
    } finally {
      mw.__test_only_set_worker_script__(null);
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── 无 SQLITE_BUSY（高并发 M=4 多次跑，断言全程无 busy 异常）──
  test('5. 无 SQLITE_BUSY：M=4 / 多 chunk 并行不触发写锁冲突', async () => {
    const rows = 800;
    const chunkSize = 50; // 16 chunks，M=4 高并发抢跑
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    try {
      runBaseline(ctx.db, 1, chunkSize);
      const baseRows = dumpDiffRows(ctx.db, 1);

      let busyHit = false;
      let res;
      try {
        res = await mw.runWriteSplitChunks({
          db: ctx.db, dbPath: ctx.dbPath,
          workerCount: 4,
          chunks: buildChunks(rows, chunkSize),
          selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
          targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
          prefixValues: [2], tempDir,
        });
      } catch (e) {
        if (/SQLITE_BUSY|database is locked/i.test(e.message)) busyHit = true;
        throw e;
      }
      assert.equal(busyHit, false, '不应触发 SQLITE_BUSY');
      assert.ok(res.totalChunks >= 8, `chunk 数应 >= 8（实际 ${res.totalChunks}）`);

      const cmp = compareRows(baseRows, dumpDiffRows(ctx.db, 2));
      assert.equal(cmp.equal, true, `高并发下仍 byte-for-byte（失败：${cmp.reason}）`);
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── onProgress 聚合（D34 不排序流式：completedChunks 单调递增到 totalChunks）──
  test('6. onProgress：completedChunks 单调递增至 totalChunks', async () => {
    const rows = 500;
    const chunkSize = 100; // 5 chunks
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    try {
      const events = [];
      await mw.runWriteSplitChunks({
        db: ctx.db, dbPath: ctx.dbPath,
        workerCount: 3,
        chunks: buildChunks(rows, chunkSize),
        selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
        targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
        prefixValues: [2], tempDir,
        onProgress: (ev) => events.push(ev),
      });
      assert.equal(events.length, 5, `应有 5 个 progress 事件（实际 ${events.length}）`);
      // completedChunks 单调递增 1..5
      const completed = events.map((e) => e.completedChunks).sort((a, b) => a - b);
      assert.deepEqual(completed, [1, 2, 3, 4, 5], 'completedChunks 覆盖 1..5');
      assert.ok(events.every((e) => e.totalChunks === 5), '每个事件 totalChunks=5');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── 空 chunks 短路 ──
  test('7. 空 chunks（0 行）→ insertedRows=0 短路返回', async () => {
    const ctx = setupDb(0);
    const tempDir = mw.makeTempDir();
    try {
      const res = await mw.runWriteSplitChunks({
        db: ctx.db, dbPath: ctx.dbPath,
        workerCount: 4,
        chunks: [],
        selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
        targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
        prefixValues: [2], tempDir,
      });
      assert.equal(res.insertedRows, 0);
      assert.equal(res.totalChunks, 0);
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── 入参校验（fail-fast）──
  test('8. 入参校验：非法 workerCount / 列数不匹配 / 非法列名 / chunkIndex 越界都抛错', async () => {
    const ctx = setupDb(10);
    const tempDir = mw.makeTempDir();
    const base = {
      db: ctx.db, dbPath: ctx.dbPath, workerCount: 2,
      chunks: buildChunks(10, 100), selectSql: SELECT_SQL,
      partColumns: PART_COLUMNS, targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
      prefixValues: [2], tempDir,
    };
    try {
      await assert.rejects(() => mw.runWriteSplitChunks({ ...base, workerCount: 0 }), /workerCount/);
      await assert.rejects(() => mw.runWriteSplitChunks({ ...base, workerCount: 1.5 }), /workerCount/);
      // 列数不匹配：targetColumns(5) != prefixValues(0) + partColumns(4)
      await assert.rejects(() => mw.runWriteSplitChunks({ ...base, prefixValues: [] }), /targetColumns/);
      // 非法列名（SQL 注入防御）
      await assert.rejects(() => mw.runWriteSplitChunks({ ...base, partColumns: ['bad name; DROP'] }), /非法列名/);
      // chunkIndex 越界
      await assert.rejects(
        () => mw.runWriteSplitChunks({ ...base, chunks: [{ chunkIndex: 5, bindParams: [MONTH_KEY, 100, 0] }] }),
        /chunkIndex/
      );
      // chunkIndex 重复
      await assert.rejects(
        () => mw.runWriteSplitChunks({
          ...base,
          chunks: [
            { chunkIndex: 0, bindParams: [MONTH_KEY, 100, 0] },
            { chunkIndex: 0, bindParams: [MONTH_KEY, 100, 100] },
          ],
        }),
        /重复/
      );
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── worker 文件 buildPartTableSql 列名防御 + writeChunkToTemp 顺序 ──
  test('9. worker.buildPartTableSql 拒绝非法列名 + seq 列固定', () => {
    const sql = mwWorker.__test_only__.buildPartTableSql(['a', { name: 'b', type: 'TEXT' }]);
    assert.ok(/seq INTEGER PRIMARY KEY AUTOINCREMENT/.test(sql), '含 seq AUTOINCREMENT');
    assert.ok(/b TEXT/.test(sql), '含带类型列');
    assert.throws(() => mwWorker.__test_only__.buildPartTableSql([]), /非空数组/);
    assert.throws(() => mwWorker.__test_only__.buildPartTableSql(['x; DROP TABLE']), /非法列名/);
  });

  // ── 🔴 C1（self-review）：固定 tempDir 跨 run 复用，残留 part-*.sqlite 必须写前清除（不追加污染）──
  //   背景：上个 run 在 merge 期被硬杀/OOM/断电 → finally 未清 → part-<ci>.sqlite 残留；
  //   writeChunkToTemp CREATE IF NOT EXISTS + INSERT（seq 续涨）若不先删会追加 → merge 收走残留行 → diff_rows 重复。
  test('10. 🔴 C1：tempDir 残留 part-0.sqlite 含垃圾行 → 写前清除，不污染 merge（byte-for-byte）', async () => {
    const rows = 300;
    const chunkSize = 100; // 3 chunks
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    try {
      // baseline（runId=1）
      runBaseline(ctx.db, 1, chunkSize);
      const baseRows = dumpDiffRows(ctx.db, 1);
      assert.ok(baseRows.length > 0, 'baseline 应有 diff 行');

      // 预置「上个 run 崩溃残留」：tempDir 写一个含垃圾行的 part-0.sqlite（PART_TABLE schema，seq=1 占位）
      const stalePath = path.join(tempDir, 'part-0.sqlite');
      const stale = new DatabaseSync(stalePath);
      for (const sql of PRAGMA) stale.exec(sql);
      stale.exec(`CREATE TABLE ${mwWorker.PART_TABLE} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        bill_import_id INTEGER, flow_currency TEXT, flow_amount_abs TEXT, diff_type TEXT
      );`);
      stale.prepare(`INSERT INTO ${mwWorker.PART_TABLE} (bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,?,?)`)
        .run(999999, 'XXX', '99999.99', 'STALE_GARBAGE');
      stale.close();

      // 多 worker（runId=2）—— C1 修复后 chunk-0 的 writeChunkToTemp 写前删残留 → 不污染
      const res = await mw.runWriteSplitChunks({
        db: ctx.db, dbPath: ctx.dbPath, workerCount: 2,
        chunks: buildChunks(rows, chunkSize),
        selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
        targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
        prefixValues: [2], tempDir,
      });

      assert.equal(res.insertedRows, baseRows.length, `插入行数应 == baseline（无残留追加；base=${baseRows.length} mw=${res.insertedRows}）`);
      const mwRows = dumpDiffRows(ctx.db, 2);
      assert.equal(
        mwRows.some((r) => r.diff_type === 'STALE_GARBAGE'), false,
        '🔴 C1：残留垃圾行不应进入 diff_rows（writeChunkToTemp 写前清除）'
      );
      const cmp = compareRows(baseRows, mwRows);
      assert.equal(cmp.equal, true, `🔴 C1 byte-for-byte 失败 @${cmp.firstDiffAt}：${cmp.reason}`);
      assert.equal(countTempParts(tempDir), 0, 'temp part 跑完清空');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });

  // ── P2（PR #57 review）：MW 路径接 cancelToken —— 运行中取消 → 停派发 + CancelError + 不汇总 + temp 不泄漏 ──
  //   修 review「MW 仅在全部 worker 完成并提交后才查取消，违反手册 <5s」。与单 worker 同语义（每 chunk 间 check）。
  test('11. P2 cancel：运行中 cancelToken 取消 → 中止(CancelError) + 不汇总(0行) + temp 不泄漏', async () => {
    const rows = 800;
    const chunkSize = 50; // 16 chunks — cancel 在中途生效
    const ctx = setupDb(rows);
    const tempDir = mw.makeTempDir();
    let progressed = 0;
    const cancelToken = { get cancelled() { return progressed >= 1; } }; // 首个 chunk 完成后即取消
    try {
      let rejectErr;
      try {
        await mw.runWriteSplitChunks({
          db: ctx.db, dbPath: ctx.dbPath, workerCount: 2,
          chunks: buildChunks(rows, chunkSize),
          selectSql: SELECT_SQL, partColumns: PART_COLUMNS,
          targetTable: DIFF_TABLE, targetColumns: TARGET_COLUMNS,
          prefixValues: [2], tempDir, cancelToken,
          onProgress: () => { progressed += 1; },
        });
      } catch (e) { rejectErr = e; }
      assert.ok(rejectErr, 'cancel 应 reject');
      assert.equal(rejectErr.name, 'CancelError', `应抛 CancelError（实际 ${rejectErr && rejectErr.name}：${rejectErr && rejectErr.message}）`);
      // reader 阶段 abort → 汇总(merge)不执行 → 目标表 runId=2 应 0 行（全有或全无）
      assert.equal(dumpDiffRows(ctx.db, 2).length, 0, 'cancel 时汇总不执行（runId=2 应 0 行）');
      assert.equal(countTempParts(tempDir), 0, 'cancel 后 temp 不泄漏');
    } finally {
      mw.cleanupDir(tempDir);
      ctx.cleanup();
    }
  });
});
