// v3.0.6 需求2「R5s2 数据来源二选一（中台调拨单表 / 网关）」编排器接线单测（node:test，合成数据）
// 目标文件：src/main-process/reconciliation-orchestrator.js（R5s2 二选一 gating 落点）
// plan「需求2」/ 资金红线 review 点 7。
//
// ⚠️ 范围边界：只测【编排器二选一 gating / context 注入管道 / _round 标记 / usedBankRowIds 并入两路 /
//   下游 R5s2b excludeBankRowIds 互斥 / 行数守恒 / 取消路 parity】，
//   不重测引擎匹配矩阵（那是 r5-fund-transfer-recon-backfill / r5-fund-transfer-backfill 引擎单测职责）。
//
// 覆盖：
//   1. 勾选（reconSourceMid 缺省/true）→ 走新引擎，fundTransferReconContext.reconRows 命中 →
//      ReconciliationId 回填进 modifiedRows、_round='R5s2-recon'、stats.r5s2BackfilledCount=1
//   2. 取消（reconSourceMid:false）→ 走旧网关 runRound5FundTransferBackfill，与现状一致（_round='R5s2'，parity）
//   3. 🔴 两路 usedBankRowIds 都并入 r5s2ConsumedBankRowIds → 传 R5s2b excludeBankRowIds
//      （断言被消费行不被 R5s2b 二次匹配/覆盖）
//   4. 行数守恒：modifiedRows + unmatchedRows === bankRows.length

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation
} = require('../../../src/main-process/reconciliation-orchestrator');

// ---- 合成数据 ----------------------------------------------------------

// 银行行（含 R5s2 / R5s2b 所需列；默认 FundTransfer-in、MerchantId/Currency/金额/日期对齐下方 recon/gw/mid）
function makeBankRow(o = {}) {
  return {
    _rowId: o._rowId,
    ReconciliationId: o.ReconciliationId ?? '',
    FundType: o.FundType ?? 'FundTransfer-in',
    MerchantId: o.MerchantId ?? '202782001',
    地区: o['地区'] ?? 'LU',
    Currency: o.Currency ?? 'USD',
    'Credit Amount': o['Credit Amount'] ?? '',
    'Debit Amount': o['Debit Amount'] ?? '',
    BillDate: o.BillDate ?? '2026-05-26'
  };
}

// 调拨对账单派生行（linked_fund_transfer_recon；字段名 = FT_RECON_FIELD_MAP.recon 真实列）
//   big_account ↔ MerchantId、币种 ↔ Currency、金额（绝对值精确到分）、BillDate、ReconID（回填来源）、fund_type 方向
function makeReconRow(o = {}) {
  return {
    调拨单号: o['调拨单号'] ?? 'FTA-1',
    BillDate: o.BillDate ?? '2026-05-26',
    ReconID: o.ReconID ?? 'RECON-MID',
    big_account: o.big_account ?? '202782001',
    币种: o['币种'] ?? 'USD',
    金额: o['金额'] ?? 100,
    fund_type: o.fund_type ?? 'FundTransfer-in'
  };
}

// 网关行（gateway-bill 真实表头，小写）：取消路 / R5s2b 互斥测试用
function makeGwRow(o = {}) {
  return {
    TradeType: o.TradeType ?? 'FundTransfer-in',
    merchantid: o.merchantid ?? '202782001',
    currency: o.currency ?? 'USD',
    amount: o.amount ?? 100,
    Billdate: o.Billdate ?? '2026-05-26',
    reconciliationid: o.reconciliationid ?? 'GW-RECON'
  };
}

// 中台调拨订单行（R5s2b 引擎需要；与 payment-offline 测试同范式）
function makeMidRow(o = {}) {
  return {
    调拨单号: o['调拨单号'] ?? 'FTA202606021000477', // → 2026-06-02 → 订单周 2623
    付款方式: o['付款方式'] ?? '线下',
    渠道流水号: o['渠道流水号'] ?? 'CH-OFFLINE',
    交易时间: o['交易时间'] ?? '2026-05-26',
    '收款账户（卡号）': o['收款账户（卡号）'] ?? '202782001',
    收款金额: o['收款金额'] ?? 100,
    收款币种: o['收款币种'] ?? 'USD',
    付款渠道: o['付款渠道'] ?? 'BGL',
    收款渠道: o['收款渠道'] ?? 'CITI'
  };
}

// R5s2 场景（fund-transfer-backfill）；reconSourceMid 控制二选一，paymentOfflineBackfill 挂 R5s2b
function makeR5s2Scenario({ reconSourceMid, paymentOfflineBackfill } = {}) {
  const config = {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateToleranceDays: 1
  };
  if (reconSourceMid !== undefined) config.reconSourceMid = reconSourceMid;
  if (paymentOfflineBackfill) config.paymentOfflineBackfill = paymentOfflineBackfill;
  return { id: 502, name: '中台调拨订单对账ID回填', category: 'builtin-fixed', priority: 0, enabled: true, config };
}

const POB_ON = { enabled: true, bigAccount: '202782001', bankChannel: 'CITI', region: 'LU' };

// ---- 1. 勾选路（默认 / true）→ 走新引擎，命中回填 ----------------------

test.describe('runReconciliation R5s2 二选一 —— 勾选路（reconSourceMid 缺省/true → 调拨对账单回填）', () => {
  test('reconSourceMid 缺省（默认勾选）→ 新引擎命中 → ReconciliationId 回填、_round=R5s2-recon', () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-SHOULD-NOT-WIN' })], // 取消路才会用；勾选路不读 gw
      scenarios: [makeR5s2Scenario()], // 不设 reconSourceMid → 缺省默认勾选
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID', '勾选路回填来源=调拨对账单 ReconID（非网关）');
    assert.equal(result.stats.r5s2BackfilledCount, 1, 'stats.r5s2BackfilledCount=1');
    assert.ok(result.modifiedRows.some((r) => r._rowId === 'b1'), 'b1 进 modifiedRows');
    const mod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    assert.ok(mod, '应产 ReconciliationId modification');
    assert.equal(mod._round, 'R5s2-recon', '勾选路 modification 标 _round=R5s2-recon');
    assert.equal(mod.newValue, 'RECON-MID');
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('reconSourceMid:true（显式勾选）→ 同上走新引擎', () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] }
    });
    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.ok(result.modifications.some((m) => m._round === 'R5s2-recon'));
    assert.ok(!result.modifications.some((m) => m._round === 'R5s2'), '勾选路不产 _round=R5s2（旧网关路）');
  });

  test('勾选路 fundTransferReconContext 缺省 → 新引擎空入参 no-op、不抛、行数守恒', () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    let result;
    assert.doesNotThrow(() => {
      result = runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5s2Scenario({ reconSourceMid: true })]
        // 不传 fundTransferReconContext
      });
    });
    assert.equal(result.stats.r5s2BackfilledCount, 0, '空 reconRows → 0 回填');
    assert.equal(bankRows[0].ReconciliationId, '');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---- 2. 取消路（reconSourceMid:false）→ 旧网关引擎 parity ----------------

test.describe('runReconciliation R5s2 二选一 —— 取消路（reconSourceMid:false → 网关回填，现状 parity）', () => {
  test('reconSourceMid:false → 走旧网关 runRound5FundTransferBackfill、_round=R5s2、来源=网关', () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-RECON' })],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      // 即便注入了调拨对账单，取消路也不读它（断言来源仍是网关）
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID-IGNORED' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'GW-RECON', '取消路回填来源=网关 reconciliationid（非调拨对账单）');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    const mod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    assert.ok(mod, '应产 ReconciliationId modification');
    assert.equal(mod._round, 'R5s2', '取消路 modification 标 _round=R5s2（现状不变）');
    assert.equal(mod.newValue, 'GW-RECON');
    assert.ok(!result.modifications.some((m) => m._round === 'R5s2-recon'), '取消路不产 _round=R5s2-recon');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('reconSourceMid:false + 空网关 → no-op（现状一致）', () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferReconContext: { reconRows: [makeReconRow()] }
    });
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.equal(bankRows[0].ReconciliationId, '');
  });
});

// ---- 3. 🔴 两路 usedBankRowIds 并入 r5s2ConsumedBankRowIds → 传 R5s2b excludeBankRowIds ----

test.describe('runReconciliation R5s2 二选一 —— usedBankRowIds 并入两路（资金红线点7：R5s2b 互斥）', () => {
  test('🔴 勾选路：新引擎消费的银行行不被 R5s2b 二次匹配/覆盖', () => {
    // b1 同时满足：调拨对账单（勾选路命中→RECON-MID）与 R5s2b 中台订单（CH-OFFLINE）。
    //   勾选路先消费 b1 → usedBankRowIds 并入 r5s2ConsumedBankRowIds → R5s2b excludeBankRowIds 剔除 → 不覆盖。
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'FundTransfer-in',
      MerchantId: '202782001',
      Currency: 'USD',
      'Credit Amount': 100, 'Debit Amount': 0,
      BillDate: '2026-05-26',
      ReconciliationId: ''
    })];
    const result = runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true, paymentOfflineBackfill: POB_ON })],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] },
      midAllocationContext: { midAllocationRows: [makeMidRow({ 渠道流水号: 'CH-OFFLINE' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID', '勾选路回填胜出，R5s2b 不覆盖');
    assert.equal(result.stats.r5s2BackfilledCount, 1, '勾选路命中 1');
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'R5s2b 被 excludeBankRowIds 剔除 → 0');
    assert.ok(!result.modifications.some((m) => m._round === 'R5s2b' && m.rowId === 'b1'),
      'R5s2b 不应对被勾选路消费的行产 modification');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('🔴 勾选路「同值消费但未写」行也并入排除集 → R5s2b 不触碰（窄缺口闭合·端到端）', () => {
    // 银行行 ReconciliationId 原值 === 调拨对账单 ReconID（RECON-MID）。
    //   勾选路命中但 old===nv → 不 record（modifications 取不到），但 usedBankRowIds 已消费它。
    //   断言：该行已并入排除集 → R5s2b 不二次匹配覆盖为 CH-OFFLINE。
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'FundTransfer-in',
      MerchantId: '202782001',
      Currency: 'USD',
      'Credit Amount': 100, 'Debit Amount': 0,
      BillDate: '2026-05-26',
      ReconciliationId: 'RECON-MID' // 原值已等于调拨对账单 ReconID → 勾选路同值消费不写
    })];
    const result = runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true, paymentOfflineBackfill: POB_ON })],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] },
      midAllocationContext: { midAllocationRows: [makeMidRow({ 渠道流水号: 'CH-OFFLINE' })] }
    });

    assert.equal(result.stats.r5s2BackfilledCount, 0, '勾选路同值未写 → 计数 0');
    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID',
      '🔴 同值消费行不被 R5s2b 覆盖（usedBankRowIds 含同值未写行）');
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'R5s2b 不触碰被消费的同值行 → 0');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('🔴 取消路：网关消费的银行行不被 R5s2b 二次匹配/覆盖（现状 parity，排除集接线仍生效）', () => {
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'FundTransfer-in',
      MerchantId: '202782001',
      Currency: 'USD',
      'Credit Amount': 100, 'Debit Amount': 0,
      BillDate: '2026-05-26',
      ReconciliationId: ''
    })];
    const result = runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-RECON' })],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false, paymentOfflineBackfill: POB_ON })],
      midAllocationContext: { midAllocationRows: [makeMidRow({ 渠道流水号: 'CH-OFFLINE' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'GW-RECON', '取消路网关回填胜出，R5s2b 不覆盖');
    assert.equal(result.stats.r5s2BackfilledCount, 1, '取消路命中 1');
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'R5s2b 被 excludeBankRowIds 剔除 → 0');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});
