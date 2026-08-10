// v3.0.5 PR-4（Part B Phase 2）— bank-bu-recon per-月侧库编排层单测
//   覆盖：import 落侧库 + run inline + 主库镜像 runId / 双源 listMonths/status / 导出重跑路径 /
//   孤儿双向兜底（空壳删 / 有 imports 保留 / 有镜像无文件标失效）/ 删整月

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const bankBuReconRunData = require('../../../src/main-process/bank-bu-recon-run-data');
const shared = require('../../../scripts/integration/fixtures/bank-bu-recon-side-db-parity/_shared');

const MODULE = runDataStore.MODULE_BANK_BU;

let tmpdir;
let appDb;
let mainDb;
let userDataDir;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbr-rundata-test-'));
  userDataDir = tmpdir;
  appDb = new AppDatabase(path.join(tmpdir, 'tool-data.sqlite'));
  appDb.init();
  mainDb = appDb.db;
});
test.afterEach(() => {
  try { mainDb.close(); } catch (_) { /* swallow */ }
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

function seedMonth(yearMonth) {
  const fx = shared.buildFixtureRows();
  const base = yearMonth === '2026-03' ? fx.m1 : fx.m2;
  bankBuReconRunData.importMonth({ userDataDir, yearMonth, pendingRows: base.pending, bankRows: base.bank });
}

test('import 落侧库；主库 imports 表恒 0 行', () => {
  seedMonth('2026-03');
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true, '侧库文件建');
  assert.equal(mainDb.prepare('SELECT COUNT(*) c FROM bank_bu_recon_pending_imports').get().c, 0, '主库 pending 0 行');
  assert.equal(mainDb.prepare('SELECT COUNT(*) c FROM bank_bu_recon_bank_imports').get().c, 0, '主库 bank 0 行');
});

test('导入流程证据来自持久行主键，首次 run 与显式重跑可区分且可跨实例读取', () => {
  seedMonth('2026-03');
  const first = bankBuReconRunData.getImportFlowEvidence({
    userDataDir,
    mainDb,
    yearMonth: '2026-03'
  });
  assert.equal(first.identity.type, 'bank-bu-import-bundle');
  assert.match(first.identity.value, /^scope=2026-03\|pending=\d+-\d+-7\|bank=\d+-\d+-7$/);
  assert.equal(first.hasRun, false);

  bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  const afterRun = bankBuReconRunData.getImportFlowEvidence({
    userDataDir,
    mainDb,
    yearMonth: '2026-03'
  });
  assert.deepEqual(afterRun.identity, first.identity);
  assert.equal(afterRun.hasRun, true);

  seedMonth('2026-03');
  const reimported = bankBuReconRunData.getImportFlowEvidence({
    userDataDir,
    mainDb,
    yearMonth: '2026-03'
  });
  assert.notEqual(reimported.identity.value, first.identity.value);
  assert.equal(reimported.hasRun, false);
});

test('run inline + 主库镜像 runId = 主库镜像 id（非侧库 id）', () => {
  seedMonth('2026-03');
  seedMonth('2026-04');
  const r3 = bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  const r4 = bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-04' });
  // 两月侧库各自 insertRun id=1，但主库镜像 id 递增（1, 2）→ runId 必须用主库镜像 id。
  assert.notEqual(r3.runId, r4.runId, '两月 runId 不同（主库镜像 id 命名空间）');
  // loadExportDataByRun 用主库镜像 id 能正确取到对应月数据。
  const exp3 = bankBuReconRunData.loadExportDataByRun({ userDataDir, mainDb, runId: r3.runId });
  const exp4 = bankBuReconRunData.loadExportDataByRun({ userDataDir, mainDb, runId: r4.runId });
  assert.equal(exp3.yearMonth, '2026-03', 'r3 → 3 月');
  assert.equal(exp4.yearMonth, '2026-04', 'r4 → 4 月');
  // 主库 runs 镜像 side_db_rel_path 非空。
  const m = mainDb.prepare(`SELECT side_db_rel_path FROM bank_bu_recon_runs WHERE id = ?`).get(r3.runId);
  assert.ok(m.side_db_rel_path, '镜像 side_db_rel_path 非空');
});

test('双源 listMonths：侧库 month + 主库旧表 month 合并', () => {
  seedMonth('2026-03');
  // 主库旧表残留历史月（双源过渡）。
  mainDb.prepare(`INSERT INTO bank_bu_recon_pending_imports (year_month, row_index, recon_id) VALUES ('2025-12', 1, 'OLD')`).run();
  const months = bankBuReconRunData.listMonthsDualSource({ userDataDir, mainDb }).map((m) => m.yearMonth);
  assert.ok(months.includes('2026-03'), '侧库 month');
  assert.ok(months.includes('2025-12'), '主库旧表 month');
  // 降序。
  assert.deepEqual(months, [...months].sort().reverse(), '降序');
});

test('双源 status：侧库存在读侧库 meta', () => {
  seedMonth('2026-03');
  const s = bankBuReconRunData.getStatusDualSource({ userDataDir, mainDb, yearMonth: '2026-03' });
  assert.equal(s.meta.pendingCount, 7, '侧库 pending 行数');
  assert.equal(s.meta.bankCount, 7, '侧库 bank 行数');
});

test('删整月 = 删文件 + 主库镜像清', () => {
  seedMonth('2026-03');
  const r = bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  assert.ok(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'));
  bankBuReconRunData.deleteMonthSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), false, '文件删');
  assert.equal(mainDb.prepare(`SELECT COUNT(*) c FROM bank_bu_recon_runs WHERE id = ?`).get(r.runId).c, 0, '镜像清');
});

test('孤儿兜底①：有文件无 imports（空壳）→ 删；有 imports → 保留', () => {
  // 空壳：open 后立即 close（无 imports）。
  runDataStore.openSideDb(userDataDir, MODULE, '2026-01').close();
  // 有 imports：正常导入。
  seedMonth('2026-03');
  const stats = bankBuReconRunData.reconcileOrphans({ userDataDir, mainDb });
  assert.deepEqual(stats.deletedOrphanFiles, ['2026-01'], '空壳被删');
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-01'), false, '空壳文件消失');
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true, '有 imports 的保留');
});

test('孤儿兜底②：有镜像无文件 → 标 side-db-missing', () => {
  seedMonth('2026-03');
  const r = bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  // 手删侧库文件（模拟用户删）。
  runDataStore.deleteSideDb(userDataDir, MODULE, '2026-03');
  const stats = bankBuReconRunData.reconcileOrphans({ userDataDir, mainDb });
  assert.deepEqual(stats.invalidatedRuns, ['2026-03'], '镜像标失效');
  assert.equal(mainDb.prepare(`SELECT status FROM bank_bu_recon_runs WHERE id = ?`).get(r.runId).status, 'side-db-missing');
});

test('listSuccessMonths 主库镜像 GROUP BY', () => {
  seedMonth('2026-03');
  seedMonth('2026-04');
  bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
  bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: '2026-04' });
  const months = bankBuReconRunData.listSuccessMonthsDualSource({ mainDb }).map((m) => m.yearMonth);
  assert.deepEqual(months, ['2026-04', '2026-03'], '降序两月');
});
