// bank-bu-recon per-month 侧库迁移 — parity golden 采集脚本 🔴🔴 资金红线
//
// 必须在「改造前的干净工作树」上运行一次，把改造前的对账业务数据 + 导出 diff.xlsx 数据
//   dump 冻结为 golden.json。改造完成后由 scripts/integration/bank-bu-recon-side-db-parity.js
//   跑同 fixture 与本 golden byte-for-byte 断言。
//
// 用法：node scripts/integration/fixtures/bank-bu-recon-side-db-parity/_collect-golden.js
//   产物：scripts/integration/fixtures/bank-bu-recon-side-db-parity/golden.json
//
// 改造前路径完整镜像产线：importMonthAtomic 落主库 → session.run（insertRun 落 runs 表）
//   → loadRunResultByRunId 重跑取 matched（lastRunCache 命中）→ writeDiffWorkbook；
//   跨月 aggregateLatestSuccessRuns（依赖 runs 表有 success run）→ writeAggregateDiffWorkbook。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const session = require('../../../../src/main-process/bank-bu-recon-session');
const monthRepo = require('../../../../src/backend/bank-bu-recon-db/month-repository');
const writer = require('../../../../src/main-process/bank-bu-recon-writer');
const shared = require('./_shared');

const GOLDEN_PATH = path.join(__dirname, 'golden.json');

async function collect() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbr-parity-golden-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const db = appDb.db;

  const fx = shared.buildFixtureRows();
  const golden = {};
  const sessionObj = session.createBankBuReconSession({ getDb: () => db, getStorageRoot: () => tmpdir });

  try {
    // 改造前路径：importMonthAtomic 落主库 → session.run（落 runs） → loadRunResultByRunId 取 matched。
    for (const key of ['m1', 'm2']) {
      const m = fx[key];
      monthRepo.importMonthAtomic(db, m.yearMonth, m.pending, m.bank);
      const runRes = sessionObj.run(m.yearMonth);
      // recon dump：直接复跑 runReconciliation 拿全量结构（与 run 内部同一算法）。
      const result = session.runReconciliation(db, m.yearMonth);
      golden[key] = { yearMonth: m.yearMonth, recon: shared.dumpReconResult(result) };

      // 导出 diff.xlsx（改造前 writer，loadRunResultByRunId 取 matched）。
      const exportData = sessionObj.loadRunResultByRunId(runRes.runId);
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
      golden[key].diffSheetData = await shared.dumpDiffXlsx(savePath);
    }

    // 跨月汇总导出（aggregateLatestSuccessRuns 依赖 runs 表 success run）。
    const agg = sessionObj.aggregateLatestSuccessRuns();
    const aggSavePath = path.join(tmpdir, 'diff-aggregate.xlsx');
    await writer.writeAggregateDiffWorkbook({ matchedMonths: agg.months, savePath: aggSavePath });
    golden.aggregate = {
      includedMonths: agg.months.map((m) => m.yearMonth).sort(),
      skippedMonths: agg.skippedMonths.slice().sort(),
      diffSheetData: await shared.dumpDiffXlsx(aggSavePath)
    };

    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2));
    console.log(`bank-bu golden 采集完成 → ${GOLDEN_PATH}`);
  } finally {
    try { db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

collect().catch((err) => { console.error('bank-bu golden 采集失败:', err); process.exit(1); });
