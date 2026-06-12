// v3.0.5 PR-3（Part B Phase 1）— 收单 per-月侧库编排层单测
//   覆盖：孤儿双向兜底（有文件无元数据删文件 / 有元数据无文件标失效）+ retention 文件级二态分流
//   （整文件删 / 仅保留 diff）+ 双源 listMonths/sessionStatus

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const acquiringRunData = require('../../../src/main-process/acquiring-bill-currency-run-data');

const MODULE = runDataStore.MODULE_ACQUIRING;
const RUNS_TABLE = 'acquiring_bill_currency_runs';

let tmpdir;
let appDb;
let mainDb;
let userDataDir;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-rundata-test-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  userDataDir = tmpdir; // = path.dirname(dbPath)
  appDb = new AppDatabase(dbPath);
  appDb.init();
  mainDb = appDb.db;
});
test.afterEach(() => {
  try { mainDb.close(); } catch (_) { /* swallow */ }
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

// 建一个该月侧库（含 imports + 一个 run + diff 行）+ 主库镜像行。
function seedSideMonth(monthKey, { withMirror = true, withFlow = true } = {}) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  sideDb.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES (?,1,1,1,0,'success')`).run(monthKey);
  const runId = sideDb.prepare('SELECT last_insert_rowid() AS id').get().id;
  sideDb.prepare(`INSERT INTO acquiring_bill_currency_bill_imports (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json) VALUES (?, 'b.xlsx', 2, 'M1', 'EUR', 'eur', '{}')`).run(monthKey);
  const billId = sideDb.prepare('SELECT last_insert_rowid() AS id').get().id;
  if (withFlow) {
    sideDb.prepare(`INSERT INTO acquiring_bill_currency_flow_imports (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json) VALUES (?, 'f.xlsx', 2, 'M1', '10', '10', 'usd', 'usd', '')`).run(monthKey);
  }
  sideDb.prepare(`INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,'usd','10','currency_mismatch')`).run(runId, billId);
  sideDb.close();
  if (withMirror) {
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey,
      relPath: runDataStore.sideDbRelPath(MODULE, monthKey),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 1, unmatchedRows: 0 },
      status: 'success',
      diffFilePath: null,
      reportFilePath: null,
      ranAt: new Date().toISOString(),
    });
  }
}

test.describe('孤儿双向兜底（reconcileOrphans，spec §B.6）', () => {
  test('正常配对（文件+镜像）→ 不删不标失效', () => {
    seedSideMonth('2026-03');
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, [], '无孤儿文件');
    assert.deepEqual(stats.invalidatedRuns, [], '无失效 run');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true, '文件保留');
  });

  test('有文件无元数据 → 删文件', () => {
    seedSideMonth('2026-03', { withMirror: false }); // 只有侧库文件，无主库镜像
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true);
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, ['2026-03'], '孤儿文件被删');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), false, '文件已删');
  });

  test('有元数据无文件 → 标记 run 失效（status=side-db-missing，不崩溃）', () => {
    // 主库镜像行存在但侧库文件不存在（模拟用户手删侧库文件）
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey: '2026-05',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-05'),
      stats: { totalBillRows: 2, matchedRows: 2, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success',
      diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-05'), false, '前置：无侧库文件');
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.invalidatedRuns, ['2026-05'], 'run 标记失效');
    const row = mainDb.prepare(`SELECT status FROM ${RUNS_TABLE} WHERE month_key='2026-05'`).get();
    assert.equal(row.status, 'side-db-missing', 'status=side-db-missing（UI 降级「数据已清理」不崩溃）');
  });

  test('再次 reconcile 已失效 run 不重复标记（幂等）', () => {
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey: '2026-05',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-05'),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success', diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    const stats2 = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats2.invalidatedRuns, [], '二次不重复标记（已 side-db-missing）');
  });

  test('双向并存：A 文件无元数据 + B 元数据无文件 → 同时处理', () => {
    seedSideMonth('2026-03', { withMirror: false }); // 文件无元数据
    acquiringRunData.upsertMainRunMirror(mainDb, {  // 元数据无文件
      monthKey: '2026-06',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-06'),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success', diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, ['2026-03']);
    assert.deepEqual(stats.invalidatedRuns, ['2026-06']);
  });
});

test.describe('retention 文件级二态分流（B-D4）', () => {
  test('整文件删（deleteMonthSideDb）：删侧库文件 + 主库镜像行', () => {
    seedSideMonth('2026-03');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true);
    assert.ok(mainDb.prepare(`SELECT 1 FROM ${RUNS_TABLE} WHERE month_key='2026-03'`).get(), '前置：镜像行存在');
    const r = acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb, monthKey: '2026-03' });
    assert.equal(r.deleted, true);
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), false, '侧库文件删除');
    assert.equal(mainDb.prepare(`SELECT COUNT(*) AS c FROM ${RUNS_TABLE} WHERE month_key='2026-03' AND side_db_rel_path IS NOT NULL`).get().c, 0, '主库镜像行删除');
  });

  test('仅保留 diff（trimMonthSideDbKeepDiff）：删 flow_imports，保留 bill + diff', () => {
    seedSideMonth('2026-03');
    const r = acquiringRunData.trimMonthSideDbKeepDiff({ userDataDir, monthKey: '2026-03' });
    assert.equal(r.flowDeleted, 1, '删 1 行 flow');
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-03');
    try {
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c, 0, 'flow 清空');
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c, 1, 'bill 保留（diff 源数据）');
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c, 1, 'diff 保留（重导出不丢）');
    } finally {
      sideDb.close();
    }
  });

  test('仅保留 diff：侧库文件不存在 → skip 不报错', () => {
    const r = acquiringRunData.trimMonthSideDbKeepDiff({ userDataDir, monthKey: '2099-12' });
    assert.equal(r.skipped, 'no-side-db');
  });
});

test.describe('双源读路径（B-D2）', () => {
  test('listMonthsDualSource 合并侧库 month + 主库旧表 month', () => {
    // 侧库新 run（2026-03）
    seedSideMonth('2026-03');
    // 主库旧表 imports（历史 run，2026-01）— 直接写主库 bill_imports 模拟历史
    mainDb.prepare(`INSERT INTO acquiring_bill_currency_bill_imports (month_key, source_file, source_row_index, recon_main_id, raw_json) VALUES ('2026-01','old.xlsx',2,'OLD','{}')`).run();
    const months = acquiringRunData.listMonthsDualSource({ userDataDir, mainDb });
    assert.deepEqual(months.slice().sort(), ['2026-01', '2026-03'], '两源 month 合并去重');
  });

  test('getSessionStatusDualSource 侧库存在 → 读侧库 readiness + 主库镜像 run', () => {
    seedSideMonth('2026-03');
    const status = acquiringRunData.getSessionStatusDualSource({ userDataDir, mainDb, monthKey: '2026-03' });
    assert.equal(status.flowReady, true, '侧库 flow 就绪');
    assert.equal(status.billReady, true, '侧库 bill 就绪');
    assert.ok(status.latestRun, '主库镜像 run 透出');
    assert.equal(status.latestRun.mismatch_rows, 1);
  });

  test('getSessionStatusDualSource 侧库不存在 → 读主库旧表（历史 run 零变化）', () => {
    // 主库旧表 imports（历史）
    mainDb.prepare(`INSERT INTO acquiring_bill_currency_flow_imports (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, raw_json) VALUES ('2026-01','old.xlsx',2,'OLD','10','10','')`).run();
    const status = acquiringRunData.getSessionStatusDualSource({ userDataDir, mainDb, monthKey: '2026-01' });
    assert.equal(status.flowReady, true, '主库旧表 flow 就绪');
    assert.equal(status.billReady, false, '主库旧表无 bill');
  });
});
