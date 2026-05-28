// v2.1.10 A3 Phase 1 T09 — runCheckCore byte-for-byte contract test
//
// ⚠️ 资金红线：worker 内执行 runCheckCore 必须与主进程直调 runCheckCore 行为 byte-for-byte 一致。
//
// 验证策略：
//   - 两个独立 tmpdir（A 主进程 / B worker 进程）
//   - 同一份 fixture（30 行单据 / 流水 — 含币种差异 / 全匹配 / 缺流水 三类）
//   - A：用 AppDatabase + session.runCheckCore 直接跑
//   - B：用 AppDatabase import 后关 main connection，用 workerPool.dispatchRunCheck 跑
//   - 对比：diff_rows 表内容（按 reconId 排序后 row-by-row 比对所有列）
//   - stats（totalBillRows / matchedRows / mismatchRows / unmatchedRows）也对比
//   - 通过则证明：worker 路径不破坏 SQL JOIN 算法 / 不引入隐式 race / DB 连接独立性 OK
//
// fixture：
//   - 5 行 USD-USD 全匹配
//   - 3 行 USD-EUR 币种差异（mismatch）
//   - 2 行 仅 bill 无 flow（unmatched）
//   合计 10 行 bill / 8 行 flow / 期望 diff_rows = 3（仅 mismatch）

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../../src/backend/database');
const session = require('../../../src/main-process/acquiring-bill-currency-session');
const pool = require('../../../src/main-process/run-check-worker-pool');
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

const FIXTURE_DATE = '2026-04-15';
const FIXTURE_MONTH = '2026-04';

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

async function setupTmpDbWithFixture() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-test-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  // fixture rows
  const flowRows = [];
  const billRows = [];

  // 5 行全匹配（USD-USD）
  for (let i = 1; i <= 5; i++) {
    flowRows.push(makeFlow(FIXTURE_DATE, `MATCH-${i}`, 'USD', 'USD'));
    billRows.push(makeBill(FIXTURE_DATE, `MATCH-${i}`, 'USD'));
  }
  // 3 行币种差异（流水 USD，单据 EUR）
  for (let i = 1; i <= 3; i++) {
    flowRows.push(makeFlow(FIXTURE_DATE, `MISMATCH-${i}`, 'USD', 'USD'));
    billRows.push(makeBill(FIXTURE_DATE, `MISMATCH-${i}`, 'EUR'));
  }
  // 2 行仅 bill 无 flow
  for (let i = 1; i <= 2; i++) {
    billRows.push(makeBill(FIXTURE_DATE, `UNMATCHED-${i}`, 'JPY'));
  }

  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');
  await writeXlsx(flowFile, FLOW_HEADERS, flowRows);
  await writeXlsx(billFile, BILL_HEADERS, billRows);

  await session.importFlowFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [billFile] });

  return {
    tmpdir,
    dbPath,
    db,
    cleanup() {
      try { db.db.close(); } catch (_e) {}
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

// 读 diff_rows 表所有列 + stats，按 recon_main_id 排序便于比对
function snapshotDiffRowsAndStats(db) {
  const stats = db.prepare(`
    SELECT total_bill_rows, matched_rows, mismatch_rows, unmatched_rows
    FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1
  `).get();
  // diff_rows 表所有列（取 run_id 最大的 — 即本次 run）
  const rows = db.prepare(`
    SELECT * FROM acquiring_bill_currency_diff_rows
    WHERE run_id = (SELECT MAX(id) FROM acquiring_bill_currency_runs)
    ORDER BY bill_import_id
  `).all();
  // 去掉时间相关 / id 相关字段（不同 tmpdir 间不可比），仅保留业务字段
  const normalized = rows.map((row) => {
    const cleaned = { ...row };
    delete cleaned.id;           // diff_rows.id 自增
    delete cleaned.run_id;       // run_id 自增
    delete cleaned.bill_import_id; // bill_imports.id 自增（两 tmpdir 独立）
    return cleaned;
  });
  return { stats, rows: normalized, rowCount: rows.length };
}

test.describe('runCheckCore byte-for-byte contract', () => {

  test.afterEach(async () => {
    await pool.__reset_for_test__();
  });

  test('主进程直调 vs worker pool dispatch — diff_rows + stats byte-for-byte 一致', async () => {
    // tmpdir A：主进程直调 runCheckCore
    const A = await setupTmpDbWithFixture();
    const B = await setupTmpDbWithFixture();
    try {
      // ── A: 主进程直调 ──
      const resultA = await session.runCheckCore({
        db: A.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: A.tmpdir,
      });
      const snapA = snapshotDiffRowsAndStats(A.db.db);

      // ── B: worker pool dispatch ──
      // 关掉 main connection，让 worker 独占（避免 WAL 模式下并发干扰）
      B.db.db.close();
      const resultB = await pool.dispatchRunCheck(
        { __dbPath: B.dbPath, monthKey: FIXTURE_MONTH, storageRoot: B.tmpdir },
        {}
      );
      // 重新打开 B 的 main connection 读结果
      const Bdb2 = new (require('../../../src/backend/database').AppDatabase)(B.dbPath);
      Bdb2.init();
      const snapB = snapshotDiffRowsAndStats(Bdb2.db);
      Bdb2.db.close();
      // 修正 B 的 cleanup（已 close 不能再 close）
      B.db.db = { close: () => {} };

      // ── 断言 stats 完全一致 ──
      assert.equal(resultA.totalBillRows, resultB.totalBillRows, 'totalBillRows 一致');
      assert.equal(resultA.matchedRows, resultB.matchedRows, 'matchedRows 一致');
      assert.equal(resultA.mismatchRows, resultB.mismatchRows, 'mismatchRows 一致');
      assert.equal(resultA.unmatchedRows, resultB.unmatchedRows, 'unmatchedRows 一致');

      // ── 断言 fixture 预期值 ──
      assert.equal(resultA.totalBillRows, 10, 'fixture totalBillRows=10');
      assert.equal(resultA.matchedRows, 8, 'fixture matchedRows=8 (5 matched + 3 mismatch 都按 reconId 配对到 flow)');
      assert.equal(resultA.mismatchRows, 3, 'fixture mismatchRows=3');
      assert.equal(resultA.unmatchedRows, 2, 'fixture unmatchedRows=2');

      // ── 断言 diff_rows 表内容 byte-for-byte 一致 ──
      assert.equal(snapA.rowCount, snapB.rowCount, 'diff_rows 行数一致');
      assert.equal(snapA.rowCount, 3, 'diff_rows = 3 行（mismatch）');
      assert.equal(snapA.stats.total_bill_rows, snapB.stats.total_bill_rows, 'stats.total_bill_rows 一致');
      assert.equal(snapA.stats.matched_rows, snapB.stats.matched_rows, 'stats.matched_rows 一致');
      assert.equal(snapA.stats.mismatch_rows, snapB.stats.mismatch_rows, 'stats.mismatch_rows 一致');
      assert.equal(snapA.stats.unmatched_rows, snapB.stats.unmatched_rows, 'stats.unmatched_rows 一致');

      // 每行（去掉自增 id）业务字段完全一致
      for (let i = 0; i < snapA.rows.length; i++) {
        assert.deepEqual(
          snapA.rows[i],
          snapB.rows[i],
          `diff_rows[${i}] byte-for-byte 一致`
        );
      }
    } finally {
      A.cleanup();
      B.cleanup();
    }
  });

  test('runCheck 和 runCheckCore 是同一函数引用（alias）', () => {
    assert.strictEqual(session.runCheck, session.runCheckCore, 'runCheck === runCheckCore（alias 引用同一函数）');
  });

  test('runCheckCore 直接 throw（monthKey 缺失）', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      await assert.rejects(
        () => session.runCheckCore({ db: ctx.db.db, monthKey: null, storageRoot: ctx.tmpdir }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('monthKey'));
          return true;
        }
      );
    } finally {
      ctx.cleanup();
    }
  });
});
