// biz-op-recon per-month 侧库迁移 — parity golden 采集脚本 🔴🔴 资金红线
//
// 必须在「改造前的干净工作树」上运行一次，把改造前 4 步对账算法的差异行 + 导出 xlsx 数据
//   dump 冻结为 golden.json。改造完成后由 scripts/integration/biz-op-recon-side-db-parity.js
//   跑同 fixture 与本 golden byte-for-byte 断言。
//
// 用法：node scripts/integration/fixtures/biz-op-recon-side-db-parity/_collect-golden.js
//   产物：scripts/integration/fixtures/biz-op-recon-side-db-parity/golden.json
//
// 改造前路径：imports/flow 直插主库 + runReconciliation(主库 db) → 落主库 runs/diff_rows。
//   parity 锁的是「相同 imports/flow 行在主库 vs 侧库对账产出 byte-for-byte 一致」。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const sessionApi = require('../../../../src/main-process/biz-op-recon-session');
const session = { ...sessionApi, runReconciliation: sessionApi.runLegacyReconciliation };
const importsRepo = require('../../../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../../../src/backend/biz-op-recon-db/run-repository');
const writer = require('../../../../src/main-process/biz-op-recon-writer');
const shared = require('./_shared');

const GOLDEN_PATH = path.join(__dirname, 'golden.json');

// 中月 date（T-2 同月）作主 parity；跨月边界由集成脚本/单测覆盖（测编排，不测算法）。
const DATE = '2026-03-15';
const T2_DATE = '2026-03-14';
const BU = 'BU-A';

async function collect() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-parity-golden-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const db = appDb.db;

  const fx = shared.buildSingleDayFixture(DATE, T2_DATE, BU);
  const golden = {};

  try {
    // 改造前：imports/flow 直插主库（绕过 import 校验——parity 锁对账算法，不锁导入校验）。
    importsRepo.insertRows(db, fx.t2Date, fx.t2);
    importsRepo.insertRows(db, fx.date, fx.t1);
    flowRepo.insertRows(db, fx.date, fx.flow);

    const { runId } = session.runReconciliation(db, { date: fx.date, buName: fx.bu });
    golden.single = shared.dumpRunDiff(db, runRepo, importsRepo, runId);

    // 导出单日 diff.xlsx（改造前 writer，主库）
    const savePath = path.join(tmpdir, 'diff-single.xlsx');
    await writer.writeSingleDateDiffWorkbook({ db, date: fx.date, buName: fx.bu, runId, savePath });
    golden.single.diffSheetData = await shared.dumpDiffXlsx(savePath);

    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2));
    console.log(`biz-op golden 采集完成 → ${GOLDEN_PATH}`);
  } finally {
    try { db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

collect().catch((err) => { console.error('biz-op golden 采集失败:', err); process.exit(1); });
