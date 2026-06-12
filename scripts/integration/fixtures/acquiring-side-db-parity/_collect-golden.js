// 收单 per-month 侧库迁移 — parity golden 采集脚本 🔴🔴 资金红线
//
// 必须在「改造前的干净工作树」上运行一次，把改造前的差异表业务数据 dump 冻结为 golden.json。
// 改造完成后由 scripts/integration/acquiring-side-db-parity.js 跑同 fixture 与本 golden byte-for-byte 断言。
//
// 用法：node scripts/integration/fixtures/acquiring-side-db-parity/_collect-golden.js
//   产物：scripts/integration/fixtures/acquiring-side-db-parity/golden.json
//
// 不进 integration-runner 自动发现（_ 前缀 + 非 scripts/integration/ 顶层）；纯一次性采集工具。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const session = require('../../../../src/main-process/acquiring-bill-currency-session');
const runRepo = require('../../../../src/backend/acquiring-bill-currency-db/run-repository');
const shared = require('./_shared');

const GOLDEN_PATH = path.join(__dirname, 'golden.json');

async function collect() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-parity-golden-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const storageRoot = path.join(tmpdir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });

  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const db = appDb.db;

  const fx = await shared.buildFixtures(tmpdir);
  const golden = {};

  try {
    // ── case1：多币种 + 差异行 ──
    {
      await session.importFlowFiles({ db, monthKey: fx.case1.monthKey, filePaths: fx.case1.flow });
      await session.importBillFiles({ db, monthKey: fx.case1.monthKey, filePaths: fx.case1.bill });
      const rc = await session.runCheck({ db, monthKey: fx.case1.monthKey, storageRoot });
      const biz = shared.dumpRunBusinessData(db, runRepo, rc.runId);
      const diffSheets = await shared.dumpDiffXlsxDataSheets(rc.diffFilePath);
      golden.case1 = { ...biz, diffSheetData: diffSheets };
      // 跑完清月，隔离 case2（同 monthKey）
      session.clearMonth({ db, monthKey: fx.case1.monthKey });
    }

    // ── case2：全一致（零差异行边界） ──
    {
      await session.importFlowFiles({ db, monthKey: fx.case2.monthKey, filePaths: fx.case2.flow });
      await session.importBillFiles({ db, monthKey: fx.case2.monthKey, filePaths: fx.case2.bill });
      const rc = await session.runCheck({ db, monthKey: fx.case2.monthKey, storageRoot });
      const biz = shared.dumpRunBusinessData(db, runRepo, rc.runId);
      const diffSheets = await shared.dumpDiffXlsxDataSheets(rc.diffFilePath);
      golden.case2 = { ...biz, diffSheetData: diffSheets };
      session.clearMonth({ db, monthKey: fx.case2.monthKey });
    }

    // ── case3：空流水边界（仅 bill，runCheck 应抛「流水表尚未导入」） ──
    {
      await session.importBillFiles({ db, monthKey: fx.case3.monthKey, filePaths: fx.case3.bill });
      let errMsg = null;
      try {
        await session.runCheck({ db, monthKey: fx.case3.monthKey, storageRoot });
      } catch (err) {
        errMsg = err && err.message ? err.message : String(err);
      }
      golden.case3 = { runError: errMsg, ...shared.dumpRunBusinessData(db, runRepo, null) };
      session.clearMonth({ db, monthKey: fx.case3.monthKey });
    }

    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2), 'utf8');
    console.log(`golden 采集完成 → ${GOLDEN_PATH}`);
    console.log(`  case1: diffRowCount=${golden.case1.diffRowCount} summary=${JSON.stringify(golden.case1.runsSummary)}`);
    console.log(`  case2: diffRowCount=${golden.case2.diffRowCount} summary=${JSON.stringify(golden.case2.runsSummary)}`);
    console.log(`  case3: runError=${JSON.stringify(golden.case3.runError)}`);
  } finally {
    try { db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

collect().catch((err) => {
  console.error('golden 采集失败:', err);
  process.exitCode = 1;
});
