// 链接表「按日期范围删除」三表化 + 派生联动集成测试（v3.0.5 OPEN-4 / T6b-2，🔴🔴 资金红线）。
//   覆盖 main.js `linked-table:delete-by-date-range` / `linked-table:count-by-date-range` handler 的端到端契约：
//     1. 🔴 tableKey 正向白名单路由决策：缺省 gateway-bill / 三主表分发 / 非白名单（含隐藏派生表）拒绝。
//     2. 🔴 fx 删除联动：删 fx 主表（T6a 单事务联动删 BOC 行）→ rebuildFxBocDerivation 全量重匹配重编号（无进组步，空 ctx）
//        → 删后全库 BOC 行分组连续 1..N + 2.4/2.5 重算（real AppDatabase + real builder，非 mock）。
//     3. 🔴 bank-deposit 删除联动：删 bank 主表 → rebuildAdmDerivation + rebuildBankDepositBocDerivation 派生重建
//        → ADM/BOC bank 派生表反映删后全库候选 + clearBankDepositHitMarkersByBizIds 防悬挂（被删行标记随 DELETE 消失=no-op，
//        存活行标记不被误清）。
//
//   为什么 e2e：handler 是 ipcMain+dialog 绑定无法直接调（既有 v3.0.1-linked-gateway-upsert.js 同结论）；
//     本测试【镜像 handler 的 dispatch 决策 + 缓存清理语义】（同一白名单 Set / 同一分发分支 / 同一 rebuild 调用），
//     用真实 AppDatabase facade + 真实 rebuildFxBocDerivation/rebuildAdmDerivation/rebuildBankDepositBocDerivation
//     （单测 mock 了 database，本测试不 mock，验证真实 DB 读写链路），覆盖单测覆盖不到的「删除 handler 编排 + 真实派生联动」。
//   ⚠️ 未覆盖（靠人工回归）：processingResult/reconIdFixResult 是 main.js 模块级运行时状态，不拉起 Electron 无法断言
//     （与 v3.0.1 同口径，记 manual-test-checklist）；前端弹框（T6c）与 IPC 序列化（GUI 手测）。
//
// 用法：node scripts/integration/linked-table-delete-by-range-tablekey.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const linkedRepo = require('../../src/backend/database/linked-table-repository');
const {
  scanFxGroups,
  rematchAllBocGroups,
  buildBocBankRows,
  backfillBocReconLinkIds
} = require('../../src/main-process/boc-fx-link-builder');
const {
  rebuildAdmDerivation,
  rebuildBankDepositBocDerivation,
  rebuildFxBocDerivation
} = require('../../src/main-process/linked-derive-rebuild');

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1; failures.push({ label, actual: cond, expected: true });
}

// 静默 activity log（rebuild* 内部统一调用）。
const noopLog = () => {};

// ============================================================================
// 镜像 handler 的 dispatch（与 src/main.js linked-table:delete-by-date-range / count-by-date-range 字节同源）
// ============================================================================
//   🔴 白名单与分发逻辑必须与 handler 保持一致——本测试是该决策的回归锁。
const LINKED_DELETE_ALLOWED_TABLES = new Set(['gateway-bill', 'fx-settlement', 'bank-deposit']);

// 镜像 count handler 的白名单 + ISO 守卫 + 缺省 gateway 分发。
function mirrorCountHandler(db, payload) {
  const start = payload && payload.start != null ? String(payload.start).trim() : '';
  const end = payload && payload.end != null ? String(payload.end).trim() : '';
  if (!start || !end || start > end) return { status: 'failed', message: '日期范围非法' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { status: 'failed', message: '日期格式非法（需 YYYY-MM-DD）' };
  }
  const tableKey = payload && payload.tableKey != null ? String(payload.tableKey).trim() : 'gateway-bill';
  if (!LINKED_DELETE_ALLOWED_TABLES.has(tableKey)) return { status: 'failed', message: '不支持的删除目标表' };
  let count;
  if (tableKey === 'fx-settlement') count = db.countFxByDateRange(start, end);
  else if (tableKey === 'bank-deposit') count = db.countBankDepositByDateRange(start, end);
  else count = db.countGatewayBillByDateRange(start, end);
  return { status: 'ok', count };
}

// 镜像 delete handler 的白名单 + 三表分发 + 派生联动（缓存清空是 main.js 模块级状态，本镜像用 sideEffects 记录代替）。
function mirrorDeleteHandler(db, payload, sideEffects) {
  const start = payload && payload.start != null ? String(payload.start).trim() : '';
  const end = payload && payload.end != null ? String(payload.end).trim() : '';
  if (!start || !end || start > end) return { status: 'failed', message: '日期范围非法（起止必填且起≤止）' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { status: 'failed', message: '日期格式非法（需 YYYY-MM-DD）' };
  }
  const tableKey = payload && payload.tableKey != null ? String(payload.tableKey).trim() : 'gateway-bill';
  if (!LINKED_DELETE_ALLOWED_TABLES.has(tableKey)) return { status: 'failed', message: '不支持的删除目标表' };

  if (tableKey === 'fx-settlement') {
    const ret = db.deleteFxByDateRange(start, end);
    const { bocDerive } = rebuildFxBocDerivation(
      { database: db, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: noopLog },
      { scanLogs: [], groupCount: 0, overwriteCount: 0 }
    );
    sideEffects.reconIdFixResultCleared = true;
    return { status: 'ok', deleted: ret.deleted, rowCount: ret.rowCount, bocDeleted: ret.bocDeleted, bocDerive };
  }
  if (tableKey === 'bank-deposit') {
    const ret = db.deleteBankDepositByDateRange(start, end);
    const { admDerive } = rebuildAdmDerivation({ database: db, buildAdmRows: realBuildAdmRows });
    const { bocBankDerive } = rebuildBankDepositBocDerivation(
      { database: db, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: noopLog }
    );
    sideEffects.processingResultCleared = true;
    sideEffects.reconIdFixResultCleared = true;
    const clearRet = db.clearBankDepositHitMarkersByBizIds(ret.deletedBizIds);
    return { status: 'ok', deleted: ret.deleted, rowCount: ret.rowCount, admDerive, bocBankDerive, clearRet };
  }
  const ret = db.deleteGatewayBillByDateRange(start, end);
  sideEffects.processingResultCleared = true;
  return { status: 'ok', deleted: ret.deleted, rowCount: ret.rowCount };
}

// 真实 buildAdmRows（rebuildAdmDerivation 依赖；与 main.js 同 require）。
const { buildAdmRows: realBuildAdmRows } = require('../../src/main-process/adm-bank-deposit-builder');

// ---- 行构造工具（真实表头键名）----
function fxRow(txnNo, txnDate) {
  const row = {};
  if (txnNo !== undefined) row['交易编号'] = txnNo;
  if (txnDate !== undefined) row['交易日期'] = txnDate;
  return row;
}
function bocRow(txnNo, maturityIso, group) {
  return {
    '交易编号': txnNo, '到期日': maturityIso, '分组': String(group), '调拨单号': '', '资金对账不平表链接ID': '',
    __txnNo: txnNo, __maturityIso: maturityIso, __origGroup: String(group), __sourceRow: 3
  };
}
function bdRow(bizId, reconId, billDate, extra) {
  return Object.assign({ ReconciliationId: reconId, BizId: bizId, BillDate: billDate }, extra || {});
}

async function run() {
  console.log('==== v3.0.5 OPEN-4（T6b-2）链接表删除三表化 + 派生联动集成验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-del-tablekey-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  try {
    appDb = new AppDatabase(dbPath);
    appDb.init();

    // ========================================================================
    // 块 A：🔴 tableKey 正向白名单路由决策（缺省 gateway / 三主表分发 / 非白名单拒绝）
    // ========================================================================
    // A1：缺省（无 tableKey）→ gateway-bill（向后兼容 parity）；count 走 gateway 函数不抛。
    const cDefault = mirrorCountHandler(appDb, { start: '2026-01-01', end: '2026-12-31' });
    assertEq(cDefault.status, 'ok', 'A1.缺省 tableKey count status=ok（路由 gateway-bill）');
    assertEq(cDefault.count, 0, 'A1.空库 gateway count=0');

    // A2：三主表均在白名单 → 放行。
    for (const tk of ['gateway-bill', 'fx-settlement', 'bank-deposit']) {
      const c = mirrorCountHandler(appDb, { start: '2026-01-01', end: '2026-12-31', tableKey: tk });
      assertEq(c.status, 'ok', `A2.白名单 ${tk} count 放行`);
    }

    // A3：🔴 非白名单（含隐藏派生表）→ failed「不支持的删除目标表」（绝不放行删隐藏表）。
    for (const tk of ['adm-bank-deposit', 'boc-fx-settlement', 'boc-bank-deposit', 'mid-allocation', 'fx-option', 'unknown', '']) {
      const c = mirrorCountHandler(appDb, { start: '2026-01-01', end: '2026-12-31', tableKey: tk });
      assertEq(c.status, 'failed', `A3.非白名单 '${tk}' count 拒绝`);
      assertEq(c.message, '不支持的删除目标表', `A3.非白名单 '${tk}' 文案对齐`);
      // delete 同口径拒绝（资金红线：删除侧白名单与 count 一致）。
      const d = mirrorDeleteHandler(appDb, { start: '2026-01-01', end: '2026-12-31', tableKey: tk }, {});
      assertEq(d.status, 'failed', `A3.非白名单 '${tk}' delete 拒绝`);
      assertEq(d.message, '不支持的删除目标表', `A3.非白名单 '${tk}' delete 文案对齐`);
    }

    // A4：ISO 守卫三表共用（非 ISO 日期 → failed，删隐藏表风险前先被日期守卫拦）。
    assertEq(
      mirrorDeleteHandler(appDb, { start: '2026/01/01', end: '2026-12-31', tableKey: 'fx-settlement' }, {}).status,
      'failed', 'A4.非 ISO 起始日期 delete 拒绝'
    );

    // ========================================================================
    // 块 B：🔴 fx 删除联动（删 fx 主表 → 联动删 BOC 行 → rebuildFxBocDerivation 全量重匹配重编号）
    // ========================================================================
    // 进组步（导入侧）：scan 3 个文件分组，写 fx 主表 + BOC 表，模拟「已导入 3 段交割数据」。
    //   组 1（txn 100/101，2026-02 段）、组 2（txn 200，2026-03 段）、组 3（txn 300，2026-09 段）。
    appDb.upsertLinkedFx([
      fxRow('100', '2026-02-10'),
      fxRow('101', '2026-02-11'),
      fxRow('200', '2026-03-20'),
      fxRow('300', '2026-09-15')
    ], { sourceFileName: 'fx-seed.xls' });
    appDb.upsertBocFxLink([
      bocRow('100', '2026-05-04', 1),
      bocRow('101', '2026-05-04', 1),
      bocRow('200', '2026-05-04', 2),
      bocRow('300', '2026-05-04', 3)
    ]);
    assertEq(appDb.readBocFxLinkRows().length, 4, 'B0.前置 BOC 4 行');

    // count 预览删除区间 [2026-02-01, 2026-03-31] → 命中 100/101/200（3 行）。
    assertEq(
      mirrorCountHandler(appDb, { start: '2026-02-01', end: '2026-03-31', tableKey: 'fx-settlement' }).count,
      3, 'B1.fx count 闭区间 [02-01,03-31] = 3 行'
    );

    // delete 该区间 → fx 主表删 3 行 + 🔴 BOC 联动删 3 行（同 txn 100/101/200）；剩 txn 300。
    const fxSe = {};
    const fxDel = mirrorDeleteHandler(appDb, { start: '2026-02-01', end: '2026-03-31', tableKey: 'fx-settlement' }, fxSe);
    assertEq(fxDel.status, 'ok', 'B2.fx delete status=ok');
    assertEq(fxDel.deleted, 3, 'B2.fx 主表删 3 行（txn 100/101/200）');
    assertEq(fxDel.bocDeleted, 3, 'B2.🔴 BOC 联动删 3 行（按 transaction_no，非按到期日）');
    assertEq(fxDel.rowCount, 1, 'B2.fx 主表删后 meta.rowCount=1（剩 txn 300）');
    assertEq(fxSe.reconIdFixResultCleared, true, 'B2.🔴 fx 删后清 reconIdFixResult');

    // 🔴 rebuildFxBocDerivation 对删后全库 BOC 行重算：剩 1 行（txn 300），重编号后分组连续 1..N（=「1」）。
    const bocAfterFxDel = appDb.readBocFxLinkRows();
    assertEq(bocAfterFxDel.length, 1, 'B3.🔴 BOC 删后剩 1 行（txn 300，联动删生效）');
    assertEq(bocAfterFxDel[0]['交易编号'], '300', 'B3.剩余 BOC 行 = txn 300');
    assertEq(bocAfterFxDel[0]['分组'], '1', 'B3.🔴 全量重编号后分组连续 1..N（单组 → 「1」，消除空洞）');
    assertEq(fxDel.bocDerive.created, true, 'B3.bocDerive.created=true');
    assertEq(fxDel.bocDerive.total, 1, 'B3.bocDerive.total=1（删后全库行）');

    // B4：fx 删到空（删 txn 300）→ BOC 联动删空 → bocDerive.total=0 不抛。
    const fxDel2 = mirrorDeleteHandler(appDb, { start: '2026-09-01', end: '2026-09-30', tableKey: 'fx-settlement' }, {});
    assertEq(fxDel2.deleted, 1, 'B4.fx 删末行 deleted=1');
    assertEq(fxDel2.bocDeleted, 1, 'B4.BOC 联动删 1 行');
    assertEq(appDb.readBocFxLinkRows().length, 0, 'B4.🔴 BOC 全删空');
    assertEq(fxDel2.bocDerive.total, 0, 'B4.bocDerive.total=0（删空不抛）');

    // ========================================================================
    // 块 C：🔴 bank-deposit 删除联动（删 bank 主表 → ADM/BOC bank 派生重建 + 清命中标记）
    // ========================================================================
    // 前置：4 个有日期入金表行——2 行 Channel=ADM（派生 ADM 表）、1 行 Channel=BOC（派生 BOC bank 表）、1 行普通。
    appDb.upsertLinkedBankDeposit([
      bdRow('BIZ-ADM-1', 'R-ADM-1', '2026-02-10', { Channel: 'ADM', FundType: 'Fundtransfer-in', '批次号': 'BN1', CustomerRef: 'C1' }),
      bdRow('BIZ-ADM-2', 'R-ADM-2', '2026-03-20', { Channel: 'ADM', FundType: 'Fundtransfer-in', '批次号': 'BN2', CustomerRef: 'C2' }),
      bdRow('BIZ-BOC-1', 'R-BOC-1', '2026-02-15', { Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0', 'Payment Detail': '无折存款借记交易 100' }),
      bdRow('BIZ-PLAIN', 'R-PLAIN', '2026-09-01', { Channel: 'PAY' })
    ], { sourceFileName: 'bank-seed.xlsx' });
    assertEq(appDb.countBankDepositByDateRange('2026-01-01', '2026-12-31'), 4, 'C0.前置 bank-deposit 4 行');

    // 先建 ADM/BOC bank 派生表（模拟导入后已派生态）。
    rebuildAdmDerivation({ database: appDb, buildAdmRows: realBuildAdmRows });
    rebuildBankDepositBocDerivation({ database: appDb, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: noopLog });
    const admBefore = appDb.readAdmBankDepositRows ? appDb.readAdmBankDepositRows().length : null;

    // 🔴 在删除区间外的存活行（BIZ-PLAIN）打命中标记——验证删除联动【不误清存活行标记】。
    linkedRepo.markBankDepositHits(appDb.db, ['BIZ-PLAIN'], 'RUN-keep', '2026-09-02T00:00:00Z');
    // 在删除区间内的行（BIZ-ADM-1）也打标记——验证 DELETE 后该标记随行消失（clear 对其 no-op）。
    linkedRepo.markBankDepositHits(appDb.db, ['BIZ-ADM-1'], 'RUN-gone', '2026-02-11T00:00:00Z');
    const markBefore = linkedRepo.readBankDepositHitMarkers(appDb.db, ['BIZ-PLAIN', 'BIZ-ADM-1']);
    assertTrue(markBefore.get('BIZ-PLAIN') && markBefore.get('BIZ-PLAIN').last_hit_run === 'RUN-keep', 'C1.存活行 BIZ-PLAIN 标记已写');
    assertTrue(markBefore.get('BIZ-ADM-1') && markBefore.get('BIZ-ADM-1').last_hit_run === 'RUN-gone', 'C1.待删行 BIZ-ADM-1 标记已写');

    // count 预览删除区间 [2026-02-01, 2026-03-31] → 命中 BIZ-ADM-1/BIZ-ADM-2/BIZ-BOC-1（3 行）。
    assertEq(
      mirrorCountHandler(appDb, { start: '2026-02-01', end: '2026-03-31', tableKey: 'bank-deposit' }).count,
      3, 'C2.bank-deposit count 闭区间 = 3 行'
    );

    // delete 该区间 → bank 主表删 3 行；剩 BIZ-PLAIN（区间外）。
    const bdSe = {};
    const bdDel = mirrorDeleteHandler(appDb, { start: '2026-02-01', end: '2026-03-31', tableKey: 'bank-deposit' }, bdSe);
    assertEq(bdDel.status, 'ok', 'C3.bank-deposit delete status=ok');
    assertEq(bdDel.deleted, 3, 'C3.bank 主表删 3 行');
    assertEq(bdDel.rowCount, 1, 'C3.删后 meta.rowCount=1（剩 BIZ-PLAIN）');
    assertEq(bdSe.processingResultCleared, true, 'C3.🔴 bank 删后清 processingResult');
    assertEq(bdSe.reconIdFixResultCleared, true, 'C3.🔴 bank 删后清 reconIdFixResult');

    // 🔴 派生重建：删后 ADM 表反映全库 Channel=ADM 候选（2 行 ADM 已删 → ADM 表重建为空）。
    assertEq(bdDel.admDerive.created, true, 'C4.admDerive.created=true');
    assertEq(bdDel.admDerive.total, 0, 'C4.🔴 ADM 候选全删 → ADM 派生表重建为 0 行');
    assertEq(bdDel.bocBankDerive.created, true, 'C4.bocBankDerive.created=true');
    assertEq(bdDel.bocBankDerive.bankRowCount, 0, 'C4.🔴 BOC bank 候选（BIZ-BOC-1）已删 → BOC bank 派生表重建为 0 行');

    // 🔴 命中标记：被删行 BIZ-ADM-1 标记随 DELETE 消失（clear 对其 .changes=0 no-op）；存活行 BIZ-PLAIN 标记不被误清。
    assertEq(bdDel.clearRet.cleared, 0, 'C5.🔴 clearBankDepositHitMarkersByBizIds 对已删行 no-op（行已随 DELETE 消失，防御性双保险）');
    const markAfter = linkedRepo.readBankDepositHitMarkers(appDb.db, ['BIZ-PLAIN', 'BIZ-ADM-1']);
    assertTrue(markAfter.get('BIZ-PLAIN') && markAfter.get('BIZ-PLAIN').last_hit_run === 'RUN-keep', 'C5.🔴 存活行 BIZ-PLAIN 标记保留（未被误清）');
    assertTrue(!markAfter.has('BIZ-ADM-1'), 'C5.🔴 被删行 BIZ-ADM-1 标记已随行消失');

    // C6：bank-deposit 删除区间外（BIZ-PLAIN 区间）→ 删 1 行 + 派生重建 + 清标记（deletedBizIds=[BIZ-PLAIN]，行已删 → clear no-op）。
    const bdDel2 = mirrorDeleteHandler(appDb, { start: '2026-09-01', end: '2026-09-30', tableKey: 'bank-deposit' }, {});
    assertEq(bdDel2.deleted, 1, 'C6.删末行 BIZ-PLAIN deleted=1');
    assertEq(appDb.countBankDepositByDateRange('2026-01-01', '2026-12-31'), 0, 'C6.🔴 bank-deposit 全删空');
    assertEq(bdDel2.clearRet.cleared, 0, 'C6.clear 对已删 BIZ-PLAIN no-op');

    // ========================================================================
    // 块 D：gateway-bill parity（缺省 tableKey 删除走 gateway 函数，行为不变）
    // ========================================================================
    // gateway 用既有 upsert 喂行（gateway repoKey 直接走仓储 facade）。
    appDb.upsertLinkedGatewayBill([
      { reconciliationid: 'GR-1', ReconBillBizId: 'GB-1', Billdate: '2026-02-10' },
      { reconciliationid: 'GR-2', ReconBillBizId: 'GB-2', Billdate: '2026-03-20' },
      { reconciliationid: 'GR-3', ReconBillBizId: 'GB-3', Billdate: '2026-09-01' }
    ], { sourceFileName: 'gw.xlsx' });
    // 缺省 tableKey（不传）→ gateway 删除。
    const gwSe = {};
    const gwDel = mirrorDeleteHandler(appDb, { start: '2026-02-01', end: '2026-03-31' }, gwSe);
    assertEq(gwDel.deleted, 2, 'D1.缺省 tableKey 删 gateway 2 行（GB-1/GB-2）');
    assertEq(gwDel.rowCount, 1, 'D1.gateway 删后剩 1 行（GB-3）');
    assertEq(gwSe.processingResultCleared, true, 'D1.gateway 删后清 processingResult（v3.0.1 行为不变）');
    assertEq(linkedRepo.readLinkedTableRows(appDb.db, 'gateway-bill').length, 1, 'D1.DB 实查 gateway 剩 1 行');
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
