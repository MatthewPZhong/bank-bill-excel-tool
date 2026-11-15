// v3.2.18 设置 → 数据管理：链接表过期清理 + 存档 VCC 默认 15 天集成测试（🔴🔴 资金红线）。
//   真实 AppDatabase（临时库，含启动迁移）+ 真实共享删除实现（src/main-process/linked-table-delete.js，
//   与「链接表管理 → 删除」handler 同一函数）+ 真实空闲控制器与业务操作登记表。
//   覆盖：
//     A. 启动迁移：VCC 存档期限默认 15 天写入一次；改回跟随默认后重启不写回。
//     B. 默认网关 15 天、外汇交割永久、银行对账单 60 天；外汇交割设 60 天后参与清理：
//        边界行（today−N 保留、today−N−1 删除、数据日期为空保留）、派生表与 meta 重算、缓存清理。
//     C. 24 小时内不重复；无过期行时不删除也不清对账缓存；修改期限后下一次空闲生效；永久不清理；设置重启回读。
//   未覆盖（靠人工 / 打包版回归）：Electron 主进程 30 分钟空闲触发、用户操作中止的真实时序、大表删除耗时。
//
// 用法：node scripts/integration/linked-table-retention-idle-cleanup.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const { buildAdmRows } = require('../../src/main-process/adm-bank-deposit-builder');
const { buildBocBankRows, backfillBocReconLinkIds } = require('../../src/main-process/boc-fx-link-builder');
const { rebuildAdmDerivation, rebuildBankDepositBocDerivation } = require('../../src/main-process/linked-derive-rebuild');
const {
  countLinkedTableRowsByDateRange,
  deleteLinkedTableRowsByDateRange
} = require('../../src/main-process/linked-table-delete');
const {
  LINKED_RETENTION_LAST_SUCCESS_KEY,
  readRetentionDaysByTable,
  setTableRetentionDays
} = require('../../src/main-process/linked-table-retention/policy');
const { createIdleLinkedTableRetentionController } = require('../../src/main-process/linked-table-retention/idle-retention');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');
const {
  readRetentionDaysByModule,
  resolveRetentionDays,
  setModuleRetentionDays
} = require('../../src/main-process/archive-center/retention-policy');

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const noopLog = () => {};
const identityBoundary = (work) => work();

function bdRow(bizId, reconId, billDate, extra) {
  const row = Object.assign({ ReconciliationId: reconId, BizId: bizId }, extra || {});
  if (billDate !== undefined) row.BillDate = billDate;
  return row;
}
function bocRow(txnNo, maturityIso, group) {
  return {
    '交易编号': txnNo, '到期日': maturityIso, '分组': String(group), '调拨单号': '', '资金对账不平表链接ID': '',
    __txnNo: txnNo, __maturityIso: maturityIso, __origGroup: String(group), __sourceRow: 3
  };
}
const keysOf = (appDb, tableKey, field) => linkedRepo.readLinkedTableRows(appDb.db, tableKey)
  .map((row) => row[field]).sort();

function createHarness(appDb, clock) {
  const registry = createBusinessOperationRegistry();
  const sideEffects = { processingResultCleared: 0, reconIdFixResultCleared: 0, deletes: [], logs: [] };
  const lock = { held: false };
  const deps = {
    database: appDb,
    appendActivityLogEntry: noopLog,
    assertAdmMutationAllowed: () => {},
    admMutationBoundary: identityBoundary,
    clearProcessingResult: () => { sideEffects.processingResultCleared += 1; },
    clearReconIdFixResult: () => { sideEffects.reconIdFixResultCleared += 1; }
  };
  const controller = createIdleLinkedTableRetentionController({
    getDatabase: () => appDb,
    registry,
    getLastUserActivityTs: () => clock.lastActivity,
    acquireLock: () => {
      if (lock.held) return { acquired: false };
      lock.held = true;
      return { acquired: true };
    },
    releaseLock: () => { lock.held = false; },
    countExpired: (range) => countLinkedTableRowsByDateRange(appDb, range),
    deleteExpired: (range) => {
      sideEffects.deletes.push(`${range.tableKey}:${range.start}..${range.end}`);
      return deleteLinkedTableRowsByDateRange(deps, range);
    },
    log: (entry) => sideEffects.logs.push(entry),
    now: () => clock.now
  });
  return { controller, registry, sideEffects, lock };
}

async function run() {
  console.log('==== v3.2.18 链接表过期清理 + 存档 VCC 默认期限集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-retention-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  const reopen = () => {
    if (appDb) appDb.close();
    appDb = new AppDatabase(dbPath);
    appDb.init();
    return appDb;
  };
  try {
    reopen();

    // ======================================================================
    // 块 A：存档 VCC 默认 15 天（启动迁移一次，用户改回跟随默认后不写回）
    // ======================================================================
    assertEq(readRetentionDaysByModule(appDb), { 'vcc-financial-op': 15 }, 'A1.新库启动后 VCC 存档期限 = 15 天');
    assertEq(resolveRetentionDays(appDb, 'vcc-financial-op'), 15, 'A1.VCC 新批次按 15 天');
    assertEq(resolveRetentionDays(appDb, 'toolbox'), null, 'A1.其他模块仍按全局默认（永久）');
    setModuleRetentionDays(appDb, { moduleId: 'vcc-financial-op', retentionDays: 'inherit' });
    reopen();
    assertEq(readRetentionDaysByModule(appDb), {}, 'A2.改回跟随默认后重启不被改回 15 天');
    setModuleRetentionDays(appDb, { moduleId: 'vcc-financial-op', retentionDays: 15 });
    reopen();
    assertEq(readRetentionDaysByModule(appDb), { 'vcc-financial-op': 15 }, 'A3.15 天可显式保存并重启回读');

    // ======================================================================
    // 块 B：默认值与边界行、派生联动
    // ======================================================================
    const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime(); // 本地 2026-11-13
    const clock = { now: NOW, lastActivity: NOW - 31 * MINUTE };
    assertEq(readRetentionDaysByTable(appDb), { 'gateway-bill': 15, 'fx-settlement': null, 'bank-deposit': 60 },
      'B0.未保存时默认网关 15 天、外汇交割永久、银行对账单 60 天');
    // 外汇交割表默认永久（远期交易到期前不能删 BOC 链接行）；本场景显式设 60 天以覆盖其删除联动。
    setTableRetentionDays(appDb, { tableKey: 'fx-settlement', retentionDays: 60 });

    // 网关：保留 15 天 → 截止 2026-10-28（含）；10-29 为到期当天保留；无日期保留。
    appDb.upsertLinkedGatewayBill([
      { reconciliationid: 'GR-OLD', ReconBillBizId: 'GB-OLD', Billdate: '2026-10-28' },
      { reconciliationid: 'GR-EDGE', ReconBillBizId: 'GB-EDGE', Billdate: '2026-10-29' },
      { reconciliationid: 'GR-NEW', ReconBillBizId: 'GB-NEW', Billdate: '2026-11-13' },
      { reconciliationid: 'GR-NODATE', ReconBillBizId: 'GB-NODATE' }
    ], { sourceFileName: 'gw.xlsx', legacySource: true });
    // 外汇交割：保留 60 天 → 截止 2026-09-13（含）；联动删同 transaction_no 的 BOC 行并重编号。
    appDb.upsertLinkedFx([
      { '交易编号': '100', '交易日期': '2026-09-13' },
      { '交易编号': '101', '交易日期': '2026-09-14' }
    ], { sourceFileName: 'fx.xls' });
    appDb.upsertBocFxLink([bocRow('100', '2026-12-04', 1), bocRow('101', '2026-12-04', 2)]);
    // 银行对账单表：保留 60 天 → 截止 2026-09-13（含）。
    appDb.upsertLinkedBankDeposit([
      bdRow('BIZ-ADM-OLD', 'R-ADM-OLD', '2026-09-13', { Channel: 'ADM', FundType: 'Fundtransfer-out', ChannelOrderNo: 'CO1' }),
      bdRow('BIZ-ADM-KEEP', 'R-ADM-KEEP', '2026-09-14', { Channel: 'ADM', FundType: 'Fundtransfer-out', ChannelOrderNo: 'CO2' }),
      bdRow('BIZ-MID', 'R-MID', '2026-10-20', { Channel: 'PAY' }),
      bdRow('BIZ-BOC-OLD', 'R-BOC-OLD', '2026-08-01', { Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0', 'Payment Detail': '无折存款借记交易 100' }),
      bdRow('BIZ-NODATE', 'R-NODATE', undefined, { Channel: 'PAY' })
    ], { sourceFileName: 'bank.xlsx' });
    rebuildAdmDerivation({ database: appDb, buildAdmRows, admMutationBoundary: identityBoundary });
    rebuildBankDepositBocDerivation({ database: appDb, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: noopLog });
    assertEq([appDb.readAdmBankDepositRows().length, appDb.readBocBankDepositRows().length], [2, 1],
      'B0.前置 ADM（2 行）与 BOC 调拨银行对账单（1 行）派生表');

    const h = createHarness(appDb, clock);
    const first = await h.controller.maybeRun();
    assertEq(first.status, 'cleaned', 'B1.空闲 31 分钟且未清理过：执行并完成');
    assertEq(h.sideEffects.deletes, [
      'gateway-bill:0000-01-01..2026-10-28',
      'fx-settlement:0000-01-01..2026-09-13',
      'bank-deposit:0000-01-01..2026-09-13'
    ], 'B1.按表顺序与截止日期删除');
    assertEq(keysOf(appDb, 'gateway-bill', 'ReconBillBizId'), ['GB-EDGE', 'GB-NEW', 'GB-NODATE'],
      'B2.网关：≤截止日删除，到期当天与无日期保留');
    assertEq(keysOf(appDb, 'fx-settlement', '交易编号'), ['101'], 'B3.外汇交割：截止日当天的行删除，次日保留');
    const bocAfter = appDb.readBocFxLinkRows();
    assertEq(bocAfter.map((row) => [row['交易编号'], row['分组']]), [['101', '1']],
      'B3.🔴 BOC 链接表按 transaction_no 联动删除并重编号为连续分组');
    assertEq(keysOf(appDb, 'bank-deposit', 'BizId'), ['BIZ-ADM-KEEP', 'BIZ-MID', 'BIZ-NODATE'],
      'B4.银行对账单表：过期 ADM/BOC 行删除，次日与无日期保留');
    assertEq(appDb.readAdmBankDepositRows().map((row) => row.BizId), ['BIZ-ADM-KEEP'],
      'B4.🔴 ADM 派生表按删后全库候选重建（只剩 ADM-KEEP）');
    assertEq(appDb.readBocBankDepositRows().length, 0, 'B4.🔴 BOC 调拨银行对账单表随 BOC 候选删除重建为空');
    const meta = Object.fromEntries(appDb.listLinkedTableMeta().map((item) => [item.tableKey, item.rowCount]));
    assertEq([meta['gateway-bill'], meta['fx-settlement'], meta['bank-deposit']], [3, 1, 3], 'B5.meta 行数重算');
    assertEq([h.sideEffects.processingResultCleared, h.sideEffects.reconIdFixResultCleared], [2, 2],
      'B5.🔴 网关与银行对账单表删除清 run 结果，外汇交割与银行对账单表删除清修复结果');
    assertEq(appDb.getSetting(LINKED_RETENTION_LAST_SUCCESS_KEY), String(NOW), 'B6.写上次成功清理时间');
    assertEq([h.lock.held, h.registry.isInstallTransitionActive()], [false, false], 'B6.锁与过渡租约已释放');
    assertEq(h.sideEffects.logs.map((log) => log.level), ['info'], 'B6.写一条完成日志');

    // ======================================================================
    // 块 C：间隔、无过期行、修改期限、永久与重启回读
    // ======================================================================
    clock.now = NOW + 23 * HOUR;
    clock.lastActivity = clock.now - 31 * MINUTE;
    const recent = await h.controller.maybeRun();
    assertEq([recent.status, recent.reason], ['skipped', 'recently-cleaned'], 'C1.24 小时内不重复执行');

    const resetEffects = () => {
      h.sideEffects.deletes = [];
      h.sideEffects.processingResultCleared = 0;
      h.sideEffects.reconIdFixResultCleared = 0;
    };
    const advance = (hours) => {
      clock.now += hours * HOUR;
      clock.lastActivity = clock.now - 31 * MINUTE;
    };

    // 本地 2026-11-14：三表截止日各前进一天，前一日的“到期当天”行到期。
    advance(2);
    resetEffects();
    const nextDay = await h.controller.maybeRun();
    assertEq(nextDay.status, 'cleaned', 'C2.超过 24 小时再次执行');
    assertEq(h.sideEffects.deletes, [
      'gateway-bill:0000-01-01..2026-10-29',
      'fx-settlement:0000-01-01..2026-09-14',
      'bank-deposit:0000-01-01..2026-09-14'
    ], 'C2.截止日随本地日期前进');
    assertEq(keysOf(appDb, 'gateway-bill', 'ReconBillBizId'), ['GB-NEW', 'GB-NODATE'], 'C2.网关到期当天的行次日删除');
    assertEq(keysOf(appDb, 'fx-settlement', '交易编号'), [], 'C2.外汇交割到期当天的行次日删除');
    assertEq(keysOf(appDb, 'bank-deposit', 'BizId'), ['BIZ-MID', 'BIZ-NODATE'], 'C2.银行对账单表到期当天的行次日删除');
    assertEq(appDb.readAdmBankDepositRows().length, 0, 'C2.🔴 ADM 派生表随最后一条候选删除重建为空');

    // 本地 2026-11-15：无过期行 → 只统计不删除，不清对账缓存。
    advance(25);
    resetEffects();
    const quiet = await h.controller.maybeRun();
    assertEq(quiet.status, 'cleaned', 'C3.无过期行仍记为完成');
    assertEq(h.sideEffects.deletes, [], 'C3.无过期行不调用删除');
    assertEq([h.sideEffects.processingResultCleared, h.sideEffects.reconIdFixResultCleared], [0, 0],
      'C3.🔴 无过期行不清对账缓存');

    // 修改期限：网关改永久、银行对账单表改 15 天；清空成功时间，下一次空闲即按新期限执行。
    setTableRetentionDays(appDb, { tableKey: 'gateway-bill', retentionDays: null });
    setTableRetentionDays(appDb, { tableKey: 'bank-deposit', retentionDays: 15 });
    assertEq(appDb.getSetting(LINKED_RETENTION_LAST_SUCCESS_KEY), '', 'C4.修改期限清空上次成功时间');
    advance(1);
    resetEffects();
    const afterChange = await h.controller.maybeRun();
    assertEq(afterChange.status, 'cleaned', 'C4.修改期限后下一次空闲即执行');
    assertEq(afterChange.results.map((item) => item.tableKey), ['fx-settlement', 'bank-deposit'], 'C4.永久的网关表不在处理范围');
    assertEq(h.sideEffects.deletes, ['bank-deposit:0000-01-01..2026-10-30'], 'C4.银行对账单表按新期限删除');
    assertEq(keysOf(appDb, 'bank-deposit', 'BizId'), ['BIZ-NODATE'], 'C4.15 天期限删除 10-20 的行，无日期行保留');
    assertEq(keysOf(appDb, 'gateway-bill', 'ReconBillBizId'), ['GB-NEW', 'GB-NODATE'], 'C4.永久的网关表不清理');

    reopen();
    assertEq(readRetentionDaysByTable(appDb), { 'gateway-bill': null, 'fx-settlement': 60, 'bank-deposit': 15 },
      'C5.链接表期限重启回读');
  } finally {
    try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
