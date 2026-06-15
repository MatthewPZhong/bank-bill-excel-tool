// linked-fx OPEN-7 跨期重复命中提醒「引擎 → 真实 DB 标记 → export 注入/回写」端到端集成测试
//   （v3.0.5 OPEN-7 / T5b-2 / T5c，🔴🔴 资金红线 · 观测增强但回写路径触碰 65.7 万行入金表）。
// spec: changes/linked-fx-bank-deposit-merge-import/spec.md §3.6 + §七「OPEN-7：跨期残留入金表行作 JPM-US 桥接 → 退款回填文件命中详情含提醒」
//
//   覆盖 main.js `bank-statement:export` handler 的 OPEN-7 三步时序编排（:3893-3967）跨真实 AppDatabase 的端到端契约：
//     ① 真实引擎 runRound5RefundOrderBackfill 产 hitDepositBizIds（JPM-US 桥接命中入金表行 BizId）——非 mock，与 main 同 require。
//     ② 真实 DB markBankDepositHits / readBankDepositHitMarkers round-trip（仿 v3.0.1-linked-gateway-upsert：真实 AppDatabase facade）。
//     ③ 🔴🔴 严格三步时序：读「旧」marker → 用旧 marker 判跨期 + 注入回填行「匹配命中详情」（append 不覆盖）→ 写盘后回写「新」marker。
//     ④ 🔴 同批（同 runId）export 两次：第二次读到的 marker.last_hit_run==runId → pickStaleHits 空 → 不误报（spec §3.6-3）。
//     ⑤ 🔴 跨期（runId 变）：第二期 export 读到第一期 marker（last_hit_run≠runId）→ stale → 提醒注入到 _bridgeDepositBizId 命中的那一行。
//     ⑥ 🔴 markable 门控（T5c Critical）：仅「判定+注入成功」且「退款回填产物成功落盘」才推进 runId（写失败 → 保留旧 marker，下次仍能判跨期）。
//     ⑦ 🔴 删 bank-deposit 行 → clearBankDepositHitMarkersByBizIds 防悬挂（被删 BizId 标记清空、存活行标记不被误清）。
//
//   为什么 e2e：export handler 是 ipcMain+dialog+模块级 processingResult/bankStatementSession 绑定无法直接调
//     （与 v3.0.1-linked-gateway-upsert.js / linked-table-delete-by-range-tablekey.js 同结论）；本测试【镜像 handler 的
//     OPEN-7 三步时序 + markable 门控】（同一 pickStaleHits/buildStaleHitReminder 纯函数 + 同一 markBankDepositHits 时机），
//     用真实引擎 + 真实 AppDatabase（单测 mock 了 DB，本测试不 mock，验证「引擎产 BizId → 真实库标记 round-trip → 跨期判定」整链）。
//   ⚠️ 未覆盖（靠人工回归）：refund-backfill-writer 落盘文件名/双 sheet（writer 单测覆盖）；processingResult 模块级状态
//     （不拉起 Electron 无法断言，记 manual-test-checklist）；R3/R5/R6 二跳命中点（随 refund-backfill 轨道接入，见 spec §3.6-7b）。
//
// 用法：node scripts/integration/linked-fx-open7-stale-hit-e2e.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const {
  runRound5RefundOrderBackfill,
  pickStaleHits,
  buildStaleHitReminder
} = require('../../src/main-process/scenario-engines/r5-refund-order-backfill');

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

// ---- 引擎输入夹具（与 r5-refund-order-backfill-open7-hits.test.js 同款，构造 JPM-US 桥接命中）----
let bankSeq = 0;
function bank(overrides = {}) {
  return {
    _rowId: overrides._rowId || `b${bankSeq++}`,
    FundType: 'Ach Return',
    MerchantId: 'M1',
    Currency: 'USD',
    'Credit Amount': 0,
    'Debit Amount': 100,
    Channel: 'CH',
    '地区': 'HK',
    BillDate: '2026-06-01',
    ReconciliationId: 'RECON-1',
    ChannelOrderNo: '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    'Drawee Name': '',
    'Drawee CardNo': '',
    'Payee CardNo': '',
    ...overrides
  };
}
function refund(overrides = {}) {
  return {
    '流水号': 'SN-1',
    '状态': 'SUBMITTED',
    '银行大账号': 'M1',
    '币种': 'USD',
    '退款金额': 100,
    '银行打款流水号': '',
    '附言': '',
    '付款人名称': '',
    '付款卡号': '',
    '虚拟卡号': '',
    'valueDate': '2026-06-01',
    ...overrides
  };
}
function deposit(overrides = {}) {
  return { BizId: '', ReconciliationId: '', ChannelOrderNo: '', CustomerRef: '', ...overrides };
}

// 入金表落库行（真实 BANK_DEPOSIT_FIELDS 键名；upsert 走 biz_id 幂等键）。
function bdRow(bizId, reconId, billDate, extra) {
  return Object.assign({ BizId: bizId, ReconciliationId: reconId, BillDate: billDate }, extra || {});
}

// ============================================================================
// 镜像 main.js bank-statement:export 的 OPEN-7 三步时序 + markable 门控（与 :3893-3967 字节同源）。
//   db：真实 AppDatabase；backfillRows：引擎产回填行（含 _bridgeDepositBizId）；hitBizIds：引擎产 hitDepositBizIds；
//   runId：当期 run 标识；writeSucceeded：模拟 writeRefundBackfillOutput 是否落盘成功（门控第二条件）。
//   返回：注入后回填行（浅拷贝，不 mutate 入参）+ 本轮是否回写了 marker（markedThisRun）。
function mirrorExportOpen7(db, backfillRows, hitBizIds, runId, writeSucceeded) {
  // T5c Minor：先浅拷贝再注入，绝不 mutate 缓存行（与 :3888 一致）。
  const rowsForExport = backfillRows.map((r) => ({ ...r }));
  let open7Markable = false;
  if (Array.isArray(hitBizIds) && hitBizIds.length > 0) {
    try {
      // 🔴 写盘前读「旧」marker → 用旧 marker 判跨期（回写在写盘后）。
      const markerMap = db.readBankDepositHitMarkers(hitBizIds);
      const staleHits = pickStaleHits(hitBizIds, markerMap, runId);
      if (staleHits.length > 0) {
        const staleByBizId = new Map(staleHits.map((s) => [s.bizId, s.lastHitAt]));
        for (const row of rowsForExport) {
          const bizId = row && row._bridgeDepositBizId;
          if (bizId && staleByBizId.has(bizId)) {
            const reminder = buildStaleHitReminder(bizId, staleByBizId.get(bizId));
            row['匹配命中详情'] = (row['匹配命中详情'] ? row['匹配命中详情'] + '\n' : '') + reminder;
          }
        }
      }
      open7Markable = true;
    } catch (_e) {
      open7Markable = false; // marker 失败仅降级，不抛
    }
  }
  // 🔴🔴 T5c Critical：仅「判定+注入成功」且「产物落盘成功」才推进 runId（写失败 → 保留旧 marker）。
  let markedThisRun = false;
  try {
    if (open7Markable && writeSucceeded && Array.isArray(hitBizIds) && hitBizIds.length > 0) {
      db.markBankDepositHits(hitBizIds, String(runId), new Date().toISOString());
      markedThisRun = true;
    }
  } catch (_e) { /* 回写失败仅降级 */ }
  return { rowsForExport, markedThisRun };
}

// 取某回填行的「匹配命中详情」是否含跨期提醒文案。
function hasStaleReminder(row, bizId) {
  const detail = row && row['匹配命中详情'] ? String(row['匹配命中详情']) : '';
  return detail.includes(`桥接入金表行 BizId=${bizId}`) && detail.includes('疑似历史残留');
}

async function run() {
  console.log('==== v3.0.5 OPEN-7 跨期重复命中提醒 引擎→真实DB标记→export注入 端到端验证 ====');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-fx-open7-e2e-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  let appDb = null;
  try {
    appDb = new AppDatabase(dbPath);
    appDb.init();

    // ========================================================================
    // 块 A：真实引擎产 hitDepositBizIds（JPM-US 桥接命中入金表行 BizId）
    // ========================================================================
    // 银行行 Channel=JPM/地区=US，CustomerRef=CR-1；退款行银行打款流水号=PAYNO-1；
    //   入金表桥接行 ReconciliationId=PAYNO-1（usDepositKeys 命中）+ CustomerRef=CR-1（usDepositTake 与 bank CustomerRef 等值）→ 桥接命中 BizId=BIZ-A。
    const bankRows = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' })];
    const refundRows = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1' })];
    const depositRowsForEngine = [deposit({ BizId: 'BIZ-A', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })];

    const engineRet = runRound5RefundOrderBackfill(bankRows, refundRows, depositRowsForEngine, {});
    assertEq(engineRet.hitDepositBizIds, ['BIZ-A'], 'A1.真实引擎产 hitDepositBizIds=[BIZ-A]（JPM-US 桥接）');
    assertEq(engineRet.backfillRows.length, 1, 'A2.回填 1 行');
    assertEq(engineRet.backfillRows[0]._bridgeDepositBizId, 'BIZ-A', 'A2.回填行带 _bridgeDepositBizId=BIZ-A');
    const engineHitBizIds = engineRet.hitDepositBizIds;
    const engineBackfillRows = engineRet.backfillRows;

    // ========================================================================
    // 块 B：真实入金表落库（桥接命中的 BIZ-A 行 + 1 个不相干行），供 marker round-trip
    // ========================================================================
    appDb.upsertLinkedBankDeposit([
      bdRow('BIZ-A', 'PAYNO-1', '2026-06-01', { CustomerRef: 'CR-1', Channel: 'JPM', '地区': 'US' }),
      bdRow('BIZ-OTHER', 'R-OTHER', '2026-06-02', { Channel: 'PAY' })
    ], { sourceFileName: 'bank-seed.xlsx' });
    // 落库后初始 marker 全 NULL（首次未命中）。
    const m0 = appDb.readBankDepositHitMarkers(['BIZ-A', 'BIZ-OTHER']);
    assertEq(m0.get('BIZ-A').last_hit_run, null, 'B1.BIZ-A 初始 last_hit_run=NULL');
    assertEq(m0.get('BIZ-A').last_hit_at, null, 'B1.BIZ-A 初始 last_hit_at=NULL');

    // ========================================================================
    // 块 C：🔴 首次 export（runId=run-1）——首次命中不报，写盘后回写 marker
    // ========================================================================
    const exp1 = mirrorExportOpen7(appDb, engineBackfillRows, engineHitBizIds, 'run-1', true);
    assertEq(hasStaleReminder(exp1.rowsForExport[0], 'BIZ-A'), false, 'C1.首次命中不注入跨期提醒（旧 marker 为 NULL）');
    assertEq(exp1.markedThisRun, true, 'C1.首次 export 写盘成功 → 回写 marker');
    const m1 = appDb.readBankDepositHitMarkers(['BIZ-A']);
    assertEq(m1.get('BIZ-A').last_hit_run, 'run-1', 'C2.🔴 回写后 BIZ-A.last_hit_run=run-1');
    assertTrue(typeof m1.get('BIZ-A').last_hit_at === 'string' && m1.get('BIZ-A').last_hit_at.length > 0, 'C2.last_hit_at 已写时间戳');
    // 🔴 T5c Minor：注入走浅拷贝，绝不 mutate 引擎原回填行。
    assertEq(Object.prototype.hasOwnProperty.call(engineBackfillRows[0], '匹配命中详情')
      ? String(engineBackfillRows[0]['匹配命中详情']).includes('疑似历史残留') : false,
    false, 'C3.🔴 注入不 mutate 引擎缓存原回填行');

    // ========================================================================
    // 块 D：🔴 同批再 export（同 runId=run-1）——同批不误报（spec §3.6-3）
    // ========================================================================
    const exp1b = mirrorExportOpen7(appDb, engineBackfillRows, engineHitBizIds, 'run-1', true);
    assertEq(hasStaleReminder(exp1b.rowsForExport[0], 'BIZ-A'), false, 'D1.🔴 同批（last_hit_run==runId）不误报跨期');
    // pickStaleHits 直接断言同批口径（再保险一层）。
    const markerNow = appDb.readBankDepositHitMarkers(engineHitBizIds);
    assertEq(pickStaleHits(engineHitBizIds, markerNow, 'run-1').length, 0, 'D2.pickStaleHits 同批 runId → 空');

    // ========================================================================
    // 块 E：🔴🔴 跨期 export（runId=run-2）——读到 run-1 marker → 注入提醒到桥接命中行
    // ========================================================================
    const exp2 = mirrorExportOpen7(appDb, engineBackfillRows, engineHitBizIds, 'run-2', true);
    assertEq(hasStaleReminder(exp2.rowsForExport[0], 'BIZ-A'), true, 'E1.🔴🔴 跨期（last_hit_run=run-1≠run-2）→ 注入提醒到 BIZ-A 桥接命中行');
    assertEq(exp2.markedThisRun, true, 'E1.跨期 export 写盘成功 → 回写 marker 推进 runId');
    const m2 = appDb.readBankDepositHitMarkers(['BIZ-A']);
    assertEq(m2.get('BIZ-A').last_hit_run, 'run-2', 'E2.🔴 回写后 BIZ-A.last_hit_run 推进=run-2');

    // ========================================================================
    // 块 F：🔴🔴 markable 门控（T5c Critical）——写盘失败 → 不推进 runId（保留旧 marker，下次仍能判跨期）
    // ========================================================================
    // 先把 marker 复位到 run-1（模拟「上一期是 run-1」）。
    appDb.markBankDepositHits(['BIZ-A'], 'run-1', '2026-06-01T00:00:00.000Z');
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-A']).get('BIZ-A').last_hit_run, 'run-1', 'F0.marker 复位 run-1');
    // 跨期 run-3 但写盘失败（writeSucceeded=false）→ 注入仍发生（判定用旧 marker），但 marker 不推进。
    const exp3 = mirrorExportOpen7(appDb, engineBackfillRows, engineHitBizIds, 'run-3', false);
    assertEq(hasStaleReminder(exp3.rowsForExport[0], 'BIZ-A'), true, 'F1.跨期判定+注入照常（用旧 marker run-1）');
    assertEq(exp3.markedThisRun, false, 'F1.🔴 写盘失败 → 本轮不回写 marker');
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-A']).get('BIZ-A').last_hit_run, 'run-1',
      'F2.🔴🔴 写盘失败 marker 保留 run-1（不被 run-3 覆盖）→ 下次 export 重试仍能判跨期，提醒不丢');
    // 重试（run-3 写盘成功）→ 现在才推进。
    const exp3b = mirrorExportOpen7(appDb, engineBackfillRows, engineHitBizIds, 'run-3', true);
    assertEq(exp3b.rowsForExport.length >= 1, true, 'F3.重试 export 有回填行');
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-A']).get('BIZ-A').last_hit_run, 'run-3', 'F3.重试写盘成功 → marker 推进 run-3');

    // ========================================================================
    // 块 G：🔴 删 bank-deposit 行 → clearBankDepositHitMarkersByBizIds 防悬挂
    // ========================================================================
    // 先给 BIZ-OTHER 也打一个标记（验证清理只针对被删 BizId，不误清存活行）。
    appDb.markBankDepositHits(['BIZ-OTHER'], 'run-x', '2026-06-02T00:00:00.000Z');
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-OTHER']).get('BIZ-OTHER').last_hit_run, 'run-x', 'G0.BIZ-OTHER 打标记 run-x');
    // 删 BIZ-A 所在日期段（2026-06-01）→ deleteBankDepositByDateRange 返回 deletedBizIds（含 BIZ-A）。
    const delRet = appDb.deleteBankDepositByDateRange('2026-06-01', '2026-06-01');
    assertEq(delRet.deleted, 1, 'G1.删 2026-06-01 段 1 行（BIZ-A）');
    assertTrue(Array.isArray(delRet.deletedBizIds) && delRet.deletedBizIds.includes('BIZ-A'), 'G1.deletedBizIds 含 BIZ-A');
    // 防悬挂清理（镜像 handler :11506）：被删 BizId 标记清空（DELETE 已隐式清，clear 为防御性双保险 no-op 安全）。
    const clearRet = appDb.clearBankDepositHitMarkersByBizIds(delRet.deletedBizIds);
    assertEq(clearRet.cleared, 0, 'G2.🔴 被删行已随 DELETE 消失 → clear .changes=0（防御性双保险 no-op，不报错）');
    // BIZ-A 行已删除 → readBankDepositHitMarkers 不再返回它（Map 无此键）。
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-A']).has('BIZ-A'), false, 'G3.🔴 BIZ-A 已删 → marker Map 无此键（无悬挂）');
    // 🔴 存活行 BIZ-OTHER 标记不被误清。
    assertEq(appDb.readBankDepositHitMarkers(['BIZ-OTHER']).get('BIZ-OTHER').last_hit_run, 'run-x',
      'G4.🔴 存活行 BIZ-OTHER 标记不被删除联动误清');
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
