// v3.0.5 PR-4（Part B Phase 2）— biz-op-recon per-月侧库编排层单测
//   覆盖：runViaSideDb inline + 主库镜像 runId / 月末跨月补清+冗余副本 / 月初 T-2 跨月单库自洽 /
//   双源 status 去重冗余副本 / check-single-day 去重 / list-ready-dates 逐月合并 /
//   导出 openExportContextByRun 侧库 runId 映射 / 区间导出跨月内存合并 db / 孤儿兜底

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const bizOpReconRunData = require('../../../src/main-process/biz-op-recon-run-data');
const importsRepo = require('../../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../../src/backend/biz-op-recon-db/run-repository');
const shared = require('../../../scripts/integration/fixtures/biz-op-recon-side-db-parity/_shared');

const MODULE = runDataStore.MODULE_BIZ_OP;

let tmpdir;
let appDb;
let mainDb;
let userDataDir;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-rundata-test-'));
  userDataDir = tmpdir;
  appDb = new AppDatabase(path.join(tmpdir, 'tool-data.sqlite'));
  appDb.init();
  mainDb = appDb.db;
});
test.afterEach(() => {
  try { mainDb.close(); } catch (_) { /* swallow */ }
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

// 直插侧库 imports/flow（建一个可对账的 (date,BU) 三件齐）。
function seedSide(monthKey, { date, t2Date, t1, t2, flow }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    if (t2 && t2.length) importsRepo.insertRows(sideDb, t2Date, t2);
    if (t1 && t1.length) importsRepo.insertRows(sideDb, date, t1);
    if (flow && flow.length) flowRepo.insertRows(sideDb, date, flow);
  } finally {
    sideDb.close();
  }
}

test('monthOf：date → YYYY-MM', () => {
  assert.equal(bizOpReconRunData.monthOf('2026-03-15'), '2026-03');
  assert.equal(bizOpReconRunData.monthOf('2026-12-31'), '2026-12');
});

test('runViaSideDb inline + 主库镜像 runId 唯一（跨月）+ 主库 4 表 0 行', () => {
  const fx3 = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx3);
  seedSide('2026-05', fx5);
  const r3 = bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-03-15', buName: 'BU-A' });
  const r5 = bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-05-15', buName: 'BU-A' });
  // 两月侧库各自 run id=1，主库镜像 id 递增 → runId 不同。
  assert.notEqual(r3.runId, r5.runId, '跨月 runId 不同（主库镜像 id）');
  // 主库 4 表 0 行。
  for (const t of ['biz_op_recon_imports', 'biz_op_recon_flow_imports', 'biz_op_recon_diff_rows']) {
    assert.equal(mainDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, `主库 ${t} 0 行`);
  }
  // 主库镜像 side_db_rel_path 指向各月。
  const m3 = runRepo.getRunById(mainDb, r3.runId);
  assert.ok(m3.side_db_rel_path.includes('month-2026-03'), 'r3 镜像指向 3 月侧库');
});

test('导出 openExportContextByRun：主库镜像 runId → 侧库内 run id 映射', () => {
  const fx = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx);
  seedSide('2026-05', fx5);
  bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-03-15', buName: 'BU-A' });
  const r5 = bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-05-15', buName: 'BU-A' });
  // r5 主库镜像 id=2，但 5 月侧库内 run id=1 → exportRunId 必须是侧库 id（能查到 diff）。
  const ctx = bizOpReconRunData.openExportContextByRun({ userDataDir, mainDb, runId: r5.runId });
  try {
    assert.equal(ctx.run.data_date, '2026-05-15', '主库镜像 date');
    const diff = runRepo.getDiffRowsByRun(ctx.db, ctx.exportRunId);
    assert.ok(diff.length > 0, 'exportRunId 能查到侧库 diff_rows（runId 映射正确）');
  } finally {
    if (ctx.sideDb) ctx.sideDb.close();
  }
});

test('🔴 codex P2：buildRangeExportDb date-range 跨月导出不抛（SIDE_DB_DDL_BIZ_OP 已导出）+ 4 表建表 + 跨月合并', () => {
  const fx3 = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx3);
  seedSide('2026-05', fx5);
  bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-03-15', buName: 'BU-A' });
  bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-05-15', buName: 'BU-A' });
  // 修复前：memDb.exec(runDataStore.SIDE_DB_DDL_BIZ_OP) 中常量未导出 = undefined → exec 抛错。
  let memDb;
  assert.doesNotThrow(() => {
    memDb = bizOpReconRunData.buildRangeExportDb({
      userDataDir, mainDb, buName: 'BU-A', startDate: '2026-03-01', endDate: '2026-05-31'
    });
  }, 'date-range 导出不应抛（SIDE_DB_DDL_BIZ_OP undefined 回归）');
  try {
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_runs').all(), 'runs 表建表成功');
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_diff_rows').all(), 'diff_rows 表建表成功');
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_imports').all(), 'imports 表建表成功');
    const runCount = memDb.prepare('SELECT COUNT(*) c FROM biz_op_recon_runs').get().c;
    assert.equal(runCount, 2, '跨月 2 个 run（3月+5月）合并进内存导出库');
  } finally {
    if (memDb) memDb.close();
  }
});

test('月末跨月：runBizOpImport（mock worker success）→ 下月侧库写 T-2 冗余副本', async () => {
  const D = '2026-06-30';
  const monthKey = '2026-06';
  const nextMonth = '2026-07';
  // 6 月侧库放 D 的 imports（模拟 worker 已导入到 month(D)）。
  const dRow = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'ACCX', begin: 0, amtIn: 100, amtOut: 0, end: 100, billDate: D });
  const curSide = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try { importsRepo.insertRows(curSide, D, [dRow]); } finally { curSide.close(); }
  // mock worker：返回 success + buName，触发编排层月末跨月补清/冗余。
  const mockWorker = async () => ({ status: 'success', buName: 'BU-C', validCount: 1 });
  const res = await bizOpReconRunData.runBizOpImport({
    userDataDir, runBizOpImportViaWorker: mockWorker, params: { date: D, filePath: 'x.xlsx' }
  });
  assert.equal(res.status, 'success');
  // 下月侧库含 D 的 T-2 冗余副本。
  const nextSide = runDataStore.openSideDb(userDataDir, MODULE, nextMonth);
  try {
    const copy = importsRepo.getRowsByDateBu(nextSide, D, 'BU-C');
    assert.equal(copy.length, 1, '下月侧库含 D 冗余副本');
    assert.equal(copy[0].account_no, 'ACCX', '副本账户号');
  } finally {
    nextSide.close();
  }
});

test('月末导入 rejected → 不补清不冗余（未改数据）', async () => {
  const D = '2026-06-30';
  const nextMonth = '2026-07';
  const mockWorker = async () => ({ status: 'rejected', errorReportPath: null, errorRows: [] });
  await bizOpReconRunData.runBizOpImport({
    userDataDir, runBizOpImportViaWorker: mockWorker, params: { date: D, filePath: 'x.xlsx' }
  });
  // 下月侧库不应被建（无冗余写入）。注意 runBizOpImport 会 ensureSideDbExists(month(D))，但不碰下月。
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, nextMonth), false, 'rejected 不建下月侧库');
});

test('月初对账单库自洽：T-2 冗余副本在当月侧库 → 对账读到 T-2', () => {
  const monthEnd = '2026-08-31';
  const monthStart = '2026-09-01';
  const sepMonth = '2026-09';
  const t2Row = shared.makeBizOp({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', begin: 0, amtIn: 1000, amtOut: 0, end: 1000, billDate: monthEnd });
  const t1Row = shared.makeBizOp({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', begin: 1000, amtIn: 50, amtOut: 0, end: 1050, billDate: monthStart });
  const flowRow = shared.makeFlow({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', direction: '入', amount: 50 });
  const sep = runDataStore.openSideDb(userDataDir, MODULE, sepMonth);
  try {
    importsRepo.insertRows(sep, monthEnd, [t2Row]);   // 冗余 T-2
    importsRepo.insertRows(sep, monthStart, [t1Row]);
    flowRepo.insertRows(sep, monthStart, [flowRow]);
  } finally { sep.close(); }
  const r = bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: monthStart, buName: 'BU-D' });
  assert.equal(r.stats.t2OpTotal, 1, '读到 T-2 冗余副本');
  assert.equal(r.stats.amountDiffCount, 0, 'T-2 副本正确参与计算 → 无差异');
});

test('双源 status：去重月末冗余副本（同 date|bu 不翻倍）', () => {
  // 模拟月末 D 在两个月侧库各一份（month(D) 原件 + month(D+1) 冗余副本）。
  const D = '2026-06-30';
  const r1 = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'A', begin: 0, amtIn: 1, amtOut: 0, end: 1, billDate: D });
  const s6 = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try { importsRepo.insertRows(s6, D, [r1]); } finally { s6.close(); }
  const s7 = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try { importsRepo.insertRows(s7, D, [r1]); } finally { s7.close(); }
  const status = bizOpReconRunData.getStatusDualSource({ userDataDir, mainDb });
  const dPairs = status.importedDateBuPairs.filter((p) => p.date === D);
  assert.equal(dPairs.length, 1, '(D,BU) 去重为单条（冗余副本不翻倍）');
});

test('check-single-day 双源去重：副本不算多日', () => {
  const D = '2026-06-30';
  const r1 = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'A', begin: 0, amtIn: 1, amtOut: 0, end: 1, billDate: D });
  const s6 = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try { importsRepo.insertRows(s6, D, [r1]); } finally { s6.close(); }
  const s7 = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try { importsRepo.insertRows(s7, D, [r1]); } finally { s7.close(); }  // 冗余副本同 date
  const r = bizOpReconRunData.checkSingleDayDualSource({ userDataDir, mainDb, buName: 'BU-C' });
  assert.equal(r.onlyOneDay, true, '副本同 date → 仍只 1 日');
  assert.equal(r.count, 1, 'date 去重后 1');
});

test('孤儿兜底①：空壳删 / 有 imports 保留；②有镜像无文件标失效', () => {
  // 空壳。
  runDataStore.openSideDb(userDataDir, MODULE, '2026-01').close();
  // 有 imports + run 镜像。
  const fx = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  seedSide('2026-03', fx);
  const r = bizOpReconRunData.runViaSideDb({ userDataDir, mainDb, date: '2026-03-15', buName: 'BU-A' });
  // 删 3 月侧库文件（模拟用户删）→ 有镜像无文件。
  runDataStore.deleteSideDb(userDataDir, MODULE, '2026-03');
  const stats = bizOpReconRunData.reconcileOrphans({ userDataDir, mainDb });
  assert.deepEqual(stats.deletedOrphanFiles, ['2026-01'], '空壳删');
  assert.deepEqual(stats.invalidatedRuns, ['2026-03-15'], '有镜像无文件标失效');
  assert.equal(runRepo.getRunById(mainDb, r.runId).status, 'side-db-missing', '镜像 status 失效');
});
