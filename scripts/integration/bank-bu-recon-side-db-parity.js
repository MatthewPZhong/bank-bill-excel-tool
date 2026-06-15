// 月度银行对账单BU回填校验 per-月侧库迁移 parity 集成验证（v3.0.5 PR-4）🔴🔴 资金红线（AC4-2 放行闸）
//
// 目标：在「改造后代码」上跑与 golden 采集脚本完全相同的 fixture，走 per-月侧库写/读路径，
//   把对账业务数据 + 导出 diff.xlsx 与冻结的 golden.json byte-for-byte 断言。
//   golden 由 scripts/integration/fixtures/bank-bu-recon-side-db-parity/_collect-golden.js 在改造前
//   干净工作树采得（已冻结）。本脚本验证迁移后输出零漂移。
//
// 侧库路径还原产线 routing：
//   - import：bankBuReconRunData.importMonth（open per-月侧库 → importMonthAtomic 落侧库）
//   - run：bankBuReconRunData.runViaSideDb（runReconciliation 侧库直跑 + 主库镜像）
//   - export：bankBuReconRunData.loadExportDataByRun / aggregateExportData（重跑路径，lastRunCache 失效）
//
// 额外断言（迁移结构正确性）：
//   - 主库 bank_bu_recon_* 三表零增量（run 级行不写主库）
//   - 主库 runs 镜像行 side_db_rel_path 非空 + summary 与侧库一致
//   - 侧库文件存在 + 删整月后文件消失
//
// 用法：node scripts/integration/bank-bu-recon-side-db-parity.js（integration-runner.js 自动发现）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const runDataStore = require('../../src/backend/run-data-store');
const bankBuReconRunData = require('../../src/main-process/bank-bu-recon-run-data');
const writer = require('../../src/main-process/bank-bu-recon-writer');
const shared = require('./fixtures/bank-bu-recon-side-db-parity/_shared');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'bank-bu-recon-side-db-parity', 'golden.json');
const MODULE = runDataStore.MODULE_BANK_BU;

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, detail: `actual=${a} expected=${e}` });
}
function assertTrue(cond, label, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, detail: detail === undefined ? String(cond) : detail });
}

function mainTableCounts(mainDb) {
  const c = (t) => mainDb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  return {
    pending: c('bank_bu_recon_pending_imports'),
    bank: c('bank_bu_recon_bank_imports')
  };
}

// 从 runReconciliation 结果（侧库）dump 出与 golden 同口径的 recon 数据。需复跑侧库对账拿 result。
const session = require('../../src/main-process/bank-bu-recon-session');
function reconDumpFromSide(userDataDir, yearMonth) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, yearMonth);
  try {
    const result = session.runReconciliation(sideDb, yearMonth);
    return shared.dumpReconResult(result);
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

async function main() {
  if (!fs.existsSync(GOLDEN_PATH)) {
    console.error(`bank-bu-recon-side-db-parity: golden.json 不存在（${GOLDEN_PATH}）— 请先在改造前跑 _collect-golden.js`);
    process.exitCode = 1;
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbr-side-parity-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const userDataDir = tmpdir;
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const mainDb = appDb.db;

  try {
    const fx = shared.buildFixtureRows();

    // 主库三表初始 0 行
    assertEq(mainTableCounts(mainDb), { pending: 0, bank: 0 }, '主库两表初始 0 行');

    // ── 逐月导入 + 运行 + 单月导出 ──
    for (const key of ['m1', 'm2']) {
      const m = fx[key];
      bankBuReconRunData.importMonth({ userDataDir, yearMonth: m.yearMonth, pendingRows: m.pending, bankRows: m.bank });
      const runRes = bankBuReconRunData.runViaSideDb({ userDataDir, mainDb, yearMonth: m.yearMonth });

      // recon 业务数据 byte-for-byte
      const reconDump = reconDumpFromSide(userDataDir, m.yearMonth);
      assertEq(reconDump, golden[key].recon, `🔴 ${key} recon 业务数据 byte-for-byte（matched/buDiff/N:M）`);

      // 主库镜像 summary 与侧库一致
      assertTrue(runRes.stats.matchedCount === golden[key].recon.runSummary.matchedCount, `${key} run summary matchedCount`);

      // 单月导出 diff.xlsx byte-for-byte
      const exportData = bankBuReconRunData.loadExportDataByRun({ userDataDir, mainDb, runId: runRes.runId });
      const savePath = path.join(tmpdir, `diff-${m.yearMonth}.xlsx`);
      await writer.writeDiffWorkbook({
        storageRoot: tmpdir,
        yearMonth: m.yearMonth,
        matchedPending: exportData.matchedPending,
        matchedBank: exportData.matchedBank,
        buDiffPendingIds: exportData.buDiffPendingIds,
        buDiffBankIds: exportData.buDiffBankIds,
        nmAnomalies: exportData.nmAnomalies,
        overrideSavePath: savePath
      });
      assertEq(await shared.dumpDiffXlsx(savePath), golden[key].diffSheetData, `🔴 ${key} 单月导出 diff.xlsx 数据 sheet byte-for-byte`);

      // 主库镜像 side_db_rel_path 非空
      const mirror = mainDb.prepare(`SELECT side_db_rel_path FROM bank_bu_recon_runs WHERE year_month = ? ORDER BY id DESC LIMIT 1`).get(m.yearMonth);
      assertTrue(mirror && mirror.side_db_rel_path, `${key} 主库镜像 side_db_rel_path 非空`, JSON.stringify(mirror));
      // 侧库文件存在
      assertTrue(runDataStore.sideDbExists(userDataDir, MODULE, m.yearMonth), `${key} 侧库文件存在`);
    }

    // 主库三表仍 0 行（run 级数据未写主库）
    assertEq(mainTableCounts(mainDb), { pending: 0, bank: 0 }, '🔴 导入+运行+导出后主库两表仍 0 行（run 级数据未写主库）');

    // ── 跨月汇总导出 byte-for-byte ──
    const agg = bankBuReconRunData.aggregateExportData({ userDataDir, mainDb });
    const aggSavePath = path.join(tmpdir, 'diff-aggregate.xlsx');
    await writer.writeAggregateDiffWorkbook({ matchedMonths: agg.months, savePath: aggSavePath });
    assertEq(agg.months.map((m) => m.yearMonth).sort(), golden.aggregate.includedMonths, 'aggregate includedMonths');
    assertEq(agg.skippedMonths.slice().sort(), golden.aggregate.skippedMonths, 'aggregate skippedMonths');
    assertEq(await shared.dumpDiffXlsx(aggSavePath), golden.aggregate.diffSheetData, '🔴 跨月汇总导出 diff.xlsx 数据 sheet byte-for-byte');

    // ── 删整月 = 删文件 + 主库镜像清 ──
    bankBuReconRunData.deleteMonthSideDb({ userDataDir, mainDb, yearMonth: '2026-03' });
    assertTrue(!runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), '🔴 删整月后侧库文件消失');
    const m1Mirror = mainDb.prepare(`SELECT COUNT(*) c FROM bank_bu_recon_runs WHERE year_month = '2026-03' AND side_db_rel_path IS NOT NULL`).get().c;
    assertEq(m1Mirror, 0, '删整月后主库镜像行清除');

    console.log(`bank-bu-recon-side-db-parity: ${passed}/${passed + failed} PASS`);
    if (failed > 0) {
      for (const f of failures) console.error(`  FAIL ${f.label}: ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    try { mainDb.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

main().catch((err) => {
  console.error('bank-bu-recon-side-db-parity crashed:', err);
  process.exitCode = 1;
});
