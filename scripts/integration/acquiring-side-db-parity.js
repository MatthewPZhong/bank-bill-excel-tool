// 收单 per-月侧库迁移 parity 集成验证（v3.0.5 PR-3）🔴🔴 资金红线（AC3-1 放行闸）
//
// 目标：在「改造后代码」上跑与 golden 采集脚本完全相同的 fixture（多币种/差异行/空流水边界三类），
//   走 per-月侧库写/读路径，把差异表业务数据 dump 与冻结的 golden.json byte-for-byte 断言。
//   golden 由 scripts/integration/fixtures/acquiring-side-db-parity/_collect-golden.js 在改造前干净
//   工作树采得（已冻结）。本脚本验证迁移后差异表数据完整性零漂移。
//
// 侧库路径还原产线 routing：
//   - import：acquiringRunData.importFiles（真实 open per-月侧库 → session import 落侧库）
//   - runCheck：打开该月侧库 → session.runCheckCore（= worker 在侧库上跑的同一函数；5 阶段/JOIN/epsilon 零改动）
//     + acquiringRunData.upsertMainRunMirror（主库镜像）— 验证镜像 summary 与侧库一致。
//   - dump：listAllDiffRowsByRun（侧库）+ 解析侧库 runCheckCore 写出的 diff.xlsx 数据 sheet。
//
// 额外断言（迁移结构正确性，超出 golden 字段对比）：
//   - 主库 acquiring_bill_currency_* 三表零增量（run 级行不写主库，AC3-2 小规模口径）
//   - 主库 runs 镜像行 side_db_rel_path 非空 + summary 与侧库一致
//   - 侧库文件存在 + 删整月后文件消失（删 run=删文件）
//
// 用法：node scripts/integration/acquiring-side-db-parity.js（integration-runner.js 自动发现）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');
const runDataStore = require('../../src/backend/run-data-store');
const acquiringRunData = require('../../src/main-process/acquiring-bill-currency-run-data');
const shared = require('./fixtures/acquiring-side-db-parity/_shared');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'acquiring-side-db-parity', 'golden.json');
const MODULE = runDataStore.MODULE_ACQUIRING;

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

// 主库三表行数（验证 run 级行不写主库）。
function mainTableCounts(mainDb) {
  const c = (t) => mainDb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  return {
    flow: c('acquiring_bill_currency_flow_imports'),
    bill: c('acquiring_bill_currency_bill_imports'),
    diff: c('acquiring_bill_currency_diff_rows'),
  };
}

// 在侧库上跑 runCheck（= worker 路径的同一函数）+ 落主库镜像；返回 runCheckCore result。
async function runCheckOnSideDb({ userDataDir, mainDb, monthKey, storageRoot }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  let result;
  try {
    result = await session.runCheckCore({ db: sideDb, monthKey, storageRoot });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
  // 镜像主库（产线 acquiringRunData.runCheckViaSideDb 成功后做的同一动作）
  acquiringRunData.upsertMainRunMirror(mainDb, {
    monthKey,
    relPath: runDataStore.sideDbRelPath(MODULE, monthKey),
    stats: {
      totalBillRows: result.totalBillRows,
      matchedRows: result.matchedRows,
      mismatchRows: result.mismatchRows,
      unmatchedRows: result.unmatchedRows,
    },
    status: 'success',
    diffFilePath: result.diffFilePath || null,
    reportFilePath: result.reportFilePath || null,
    ranAt: new Date().toISOString(),
  });
  return result;
}

// dump 一个 case 的差异表业务数据（侧库）+ diff.xlsx 数据 sheet（与 golden 同口径）。
async function dumpCase({ userDataDir, monthKey, runId, diffFilePath }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  let biz;
  try {
    biz = shared.dumpRunBusinessData(sideDb, runRepo, runId);
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
  const diffSheets = await shared.dumpDiffXlsxDataSheets(diffFilePath);
  return { ...biz, diffSheetData: diffSheets };
}

async function main() {
  if (!fs.existsSync(GOLDEN_PATH)) {
    console.error(`acquiring-side-db-parity: golden.json 不存在（${GOLDEN_PATH}）— 请先在改造前干净工作树跑 _collect-golden.js`);
    process.exitCode = 1;
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-side-parity-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const userDataDir = tmpdir; // userDataDir = path.dirname(dbPath) = tmpdir
  const storageRoot = path.join(tmpdir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });

  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const mainDb = appDb.db;

  try {
    const fx = await shared.buildFixtures(tmpdir);

    // 改造结构正确性基线：主库三表初始 0 行
    const mainBefore = mainTableCounts(mainDb);
    assertEq(mainBefore, { flow: 0, bill: 0, diff: 0 }, '主库三表初始 0 行');

    // ════════════ case1：多币种 + 差异行 ════════════
    {
      await acquiringRunData.importFiles({ userDataDir, kind: 'flow', monthKey: fx.case1.monthKey, filePaths: fx.case1.flow });
      await acquiringRunData.importFiles({ userDataDir, kind: 'bill', monthKey: fx.case1.monthKey, filePaths: fx.case1.bill });
      const rc = await runCheckOnSideDb({ userDataDir, mainDb, monthKey: fx.case1.monthKey, storageRoot });
      const got = await dumpCase({ userDataDir, monthKey: fx.case1.monthKey, runId: rc.runId, diffFilePath: rc.diffFilePath });

      assertEq(got.runsSummary, golden.case1.runsSummary, '🔴 case1 runsSummary（matched/mismatch/unmatched/total）byte-for-byte');
      assertEq(got.diffRowCount, golden.case1.diffRowCount, '🔴 case1 diffRowCount 相等');
      assertEq(got.diffRows, golden.case1.diffRows, '🔴 case1 diff_rows 逐行（含 bill raw_json / source / flow 字段）byte-for-byte');
      assertEq(got.diffSheetData, golden.case1.diffSheetData, '🔴 case1 差异表 xlsx 数据 sheet 逐行 cell byte-for-byte');

      // 主库镜像行：side_db_rel_path 非空 + summary 与侧库一致
      const mirror = runRepo.getLatestRun(mainDb, fx.case1.monthKey);
      assertTrue(mirror && mirror.side_db_rel_path, 'case1 主库镜像行 side_db_rel_path 非空', JSON.stringify(mirror));
      assertEq(
        { t: mirror.total_bill_rows, m: mirror.matched_rows, mm: mirror.mismatch_rows, u: mirror.unmatched_rows },
        { t: golden.case1.runsSummary.totalBillRows, m: golden.case1.runsSummary.matchedRows, mm: golden.case1.runsSummary.mismatchRows, u: golden.case1.runsSummary.unmatchedRows },
        'case1 主库镜像 summary 与侧库一致'
      );

      // 主库三表仍 0 行（run 级行不写主库 — AC3-2 小规模口径）
      assertEq(mainTableCounts(mainDb), { flow: 0, bill: 0, diff: 0 }, '🔴 case1 后主库三表仍 0 行（run 级数据未写主库）');
      // 侧库文件存在
      assertTrue(runDataStore.sideDbExists(userDataDir, MODULE, fx.case1.monthKey), 'case1 侧库文件存在');

      // 删整月 = 删文件（删 run）
      acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb, monthKey: fx.case1.monthKey });
      assertTrue(!runDataStore.sideDbExists(userDataDir, MODULE, fx.case1.monthKey), '🔴 case1 删整月后侧库文件消失（删 run=删文件）');
      assertTrue(!runRepo.getLatestRun(mainDb, fx.case1.monthKey), 'case1 删整月后主库镜像行清除');
    }

    // ════════════ case2：全一致（零差异行边界） ════════════
    {
      await acquiringRunData.importFiles({ userDataDir, kind: 'flow', monthKey: fx.case2.monthKey, filePaths: fx.case2.flow });
      await acquiringRunData.importFiles({ userDataDir, kind: 'bill', monthKey: fx.case2.monthKey, filePaths: fx.case2.bill });
      const rc = await runCheckOnSideDb({ userDataDir, mainDb, monthKey: fx.case2.monthKey, storageRoot });
      const got = await dumpCase({ userDataDir, monthKey: fx.case2.monthKey, runId: rc.runId, diffFilePath: rc.diffFilePath });

      assertEq(got.runsSummary, golden.case2.runsSummary, '🔴 case2 runsSummary byte-for-byte');
      assertEq(got.diffRowCount, golden.case2.diffRowCount, '🔴 case2 diffRowCount=0（零差异边界）');
      assertEq(got.diffRows, golden.case2.diffRows, '🔴 case2 diff_rows 空 byte-for-byte');
      assertEq(got.diffSheetData, golden.case2.diffSheetData, '🔴 case2 差异表 xlsx 数据 sheet byte-for-byte');
      assertEq(mainTableCounts(mainDb), { flow: 0, bill: 0, diff: 0 }, 'case2 后主库三表仍 0 行');
      acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb, monthKey: fx.case2.monthKey });
    }

    // ════════════ case3：空流水边界（仅 bill，runCheck 应抛「流水表尚未导入」） ════════════
    {
      await acquiringRunData.importFiles({ userDataDir, kind: 'bill', monthKey: fx.case3.monthKey, filePaths: fx.case3.bill });
      let errMsg = null;
      const sideDb = runDataStore.openSideDb(userDataDir, MODULE, fx.case3.monthKey);
      try {
        await session.runCheckCore({ db: sideDb, monthKey: fx.case3.monthKey, storageRoot });
      } catch (err) {
        errMsg = err && err.message ? err.message : String(err);
      } finally {
        try { sideDb.close(); } catch (_e) { /* swallow */ }
      }
      assertEq(errMsg, golden.case3.runError, '🔴 case3 空流水 runCheck 报错文案 byte-for-byte');
      // 无 run → 主库无镜像行（runCheck 抛错前不镜像）
      assertTrue(!runRepo.getLatestRun(mainDb, fx.case3.monthKey), 'case3 空流水无主库 run 镜像');
      assertEq(mainTableCounts(mainDb), { flow: 0, bill: 0, diff: 0 }, 'case3 后主库三表仍 0 行');
      acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb, monthKey: fx.case3.monthKey });
    }

    console.log(`acquiring-side-db-parity: ${passed}/${passed + failed} PASS`);
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
  console.error('acquiring-side-db-parity crashed:', err);
  process.exitCode = 1;
});
