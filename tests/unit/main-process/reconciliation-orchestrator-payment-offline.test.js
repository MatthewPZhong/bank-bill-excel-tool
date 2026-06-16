// v3.0.4 块 F「Payment线下调拨订单回填处理」编排器 R5s2b 集成单测（node:test，合成数据）
// 目标文件：src/main-process/reconciliation-orchestrator.js（R5s2b 接线落点）
// changes/payment-offline-allocation-backfill/spec.md §F4 / §F7
//
// ⚠️ 范围边界：只测【编排器接线 / gating / 字段管道 / config 合并不掉桶 / excludeBankRowIds 互斥】，
//   不重测引擎匹配矩阵（那是 r5-payment-offline-allocation-backfill 引擎单测职责）。
//
// 覆盖：
//   1. config 注入 paymentOfflineBackfill 后 bucketScenarios 分桶不变（R5s2 仍落 r5s2，资金红线契约）
//   2. midAllocationContext 注入 → 引擎回填流出到返回对象（modifiedRows + stats.r5s2bBackfilledCount + rounds.r5s2b）
//   3. gating：paymentOfflineBackfill.enabled !== true → R5s2b no-op
//   4. gating：midAllocationContext 缺省 / midRows 空 → R5s2b no-op
//   5. 行数守恒：modifiedRows + unmatchedRows === bankRows.length 不变
//   6. 🔴 excludeBankRowIds 互斥：R5s2（网关）先命中的行不被 R5s2b 覆盖

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation,
  bucketScenarios
} = require('../../../src/main-process/reconciliation-orchestrator');

// ---- 合成数据 ----------------------------------------------------------

// 银行行（含 R5s2 / R5s2b 所需列）
//   修订 R2 方向：银行 +1 周 = 订单周。默认订单 FTA 06-02（订单周 2623）；银行 BillDate 05-26
//   → weekTagPlusOne(05-26)=2623=订单周，且 05-26 = 订单交易时间（同日晚于）→ R5s2b 主轮命中。
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

// 中台调拨订单行（修订 R2：付款方式=线下 / 收款渠道=CITI 参与筛选；付款渠道=出款行不参与）
function makeMidRow(o = {}) {
  return {
    调拨单号: o.调拨单号 ?? 'FTA202606021000477', // → 2026-06-02 → 订单周 2623
    付款方式: o.付款方式 ?? '线下',
    渠道流水号: o.渠道流水号 ?? 'CH-1',
    交易时间: o.交易时间 ?? '2026-05-26',
    '收款账户（卡号）': o['收款账户（卡号）'] ?? '202782001',
    收款金额: o.收款金额 ?? 100,
    收款币种: o.收款币种 ?? 'USD',
    付款渠道: o.付款渠道 ?? 'BGL',
    收款渠道: o.收款渠道 ?? 'CITI'
  };
}

// R5s2 场景（fund-transfer-backfill），可挂 paymentOfflineBackfill 子开关
//   v3.0.6 需求2：R5s2 数据来源二选一默认改「勾选=调拨对账单」（决策 D4）。本测试文件验证的是
//   **网关 R5s2 → R5s2b 互斥/排除集** mechanics（gwRows / 无 fundTransferReconContext），故显式
//   reconSourceMid:false 走取消路（旧网关引擎，行为逐字不变 / parity），与 R5s2b excludeBankRowIds 接线无关。
function makeR5s2Scenario({ paymentOfflineBackfill } = {}) {
  const config = {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    reconSourceMid: false,
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateToleranceDays: 1
  };
  if (paymentOfflineBackfill) config.paymentOfflineBackfill = paymentOfflineBackfill;
  return { id: 502, name: '中台调拨订单对账ID回填', category: 'builtin-fixed', priority: 0, enabled: true, config };
}

const POB_ON = { enabled: true, bigAccount: '202782001', bankChannel: 'CITI', region: 'LU' };

// ---- 1. config 合并不掉桶 ----------------------------------------------

test.describe('bucketScenarios：注入 paymentOfflineBackfill 后 R5s2 分桶不变', () => {
  test('🔴 资金红线：带 paymentOfflineBackfill 子开关的场景仍落 r5s2（不掉桶/不漂移）', async () => {
    const { r2, r4, r5s2, r5s3, r5s4 } = bucketScenarios([makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })]);
    assert.equal(r5s2.length, 1, '注入子开关后仍落 r5s2 桶');
    assert.equal(r5s2[0].config.subCategory, 'fund-transfer-backfill');
    assert.equal(r5s2[0].config.paymentOfflineBackfill.enabled, true, '子开关随 config 携带');
    assert.equal(r2.length, 0);
    assert.equal(r4.length, 0);
    assert.equal(r5s3.length, 0);
    assert.equal(r5s4.length, 0);
  });
});

// ---- 2 + 5. midAllocationContext 注入 + 行数守恒 ------------------------

test.describe('runReconciliation R5s2b 集成', () => {
  test('midAllocationContext 注入 → R5s2b 回填流出（modifiedRows + stats + rounds）', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })]; // BillDate 默认 05-26（+1 周=订单周 2623）
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })],
      midAllocationContext: { midAllocationRows: [makeMidRow({ 渠道流水号: 'CH-OK' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'CH-OK', '银行行被 R5s2b 回填');
    assert.equal(result.stats.r5s2bBackfilledCount, 1, 'stats.r5s2bBackfilledCount = 1');
    assert.ok(result.rounds.r5s2b && typeof result.rounds.r5s2b === 'object', 'rounds.r5s2b 存在');
    assert.equal(result.rounds.r5s2b.backfilled, 1);
    // 回填行进 modifiedRows（标黄 ReconciliationId）
    assert.ok(result.modifiedRows.some((r) => r._rowId === 'b1'), 'b1 进 modifiedRows');
    const mod = result.modifications.find((m) => m._round === 'R5s2b');
    assert.ok(mod, '应产 R5s2b modification');
    assert.equal(mod.column, 'ReconciliationId');
    // 修订 R2 Q14：paymentOfflineMatchedPairs 透传出编排器（仿 refundBackfillRows/platformCleanupRows 范式）
    assert.ok(Array.isArray(result.paymentOfflineMatchedPairs), 'paymentOfflineMatchedPairs 为数组');
    assert.equal(result.paymentOfflineMatchedPairs.length, 1, '1 个匹配对透传');
    assert.equal(result.paymentOfflineMatchedPairs[0].round, 'main');
    assert.equal(result.paymentOfflineMatchedPairs[0].bankRow._rowId, 'b1');
    assert.equal(result.paymentOfflineMatchedPairs[0].orderRow['渠道流水号'], 'CH-OK');
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('gating：paymentOfflineBackfill.enabled !== true → R5s2b no-op', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: { ...POB_ON, enabled: false } })],
      midAllocationContext: { midAllocationRows: [makeMidRow()] }
    });
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'enabled=false → no-op');
    assert.equal(bankRows[0].ReconciliationId, '');
  });

  test('gating：无 paymentOfflineBackfill 子开关 → R5s2b no-op（不影响 R5s2 既有行为）', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario()], // 不挂子开关
      midAllocationContext: { midAllocationRows: [makeMidRow()] }
    });
    assert.equal(result.stats.r5s2bBackfilledCount, 0);
  });

  test('gating：midAllocationContext 缺省 → R5s2b no-op、不抛', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })]
        // 不传 midAllocationContext
      });
    });
    assert.equal(result.stats.r5s2bBackfilledCount, 0);
    assert.equal(bankRows[0].ReconciliationId, '');
  });

  test('gating：midRows 空数组 → R5s2b no-op', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })],
      midAllocationContext: { midAllocationRows: [] }
    });
    assert.equal(result.stats.r5s2bBackfilledCount, 0);
  });
});

// ---- 6. excludeBankRowIds 互斥（Q3 网关回填优先）-----------------------

test.describe('runReconciliation R5s2b — excludeBankRowIds 互斥（Q3）', () => {
  test('🔴 R5s2（网关）先回填的银行行不被 R5s2b 覆盖（编排器从 R5s2 modifications 收集排除集）', async () => {
    // 构造一条银行行同时满足 R5s2（网关 in 方向）与 R5s2b 条件；网关 reconid 应胜出。
    // R5s2：网关 FundTransfer-in + merchantid/currency/金额 + 同日 → 回填 GW-RECON。
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'FundTransfer-in',
      MerchantId: '202782001',
      Currency: 'USD',
      'Credit Amount': 100, 'Debit Amount': 0,
      BillDate: '2026-05-26',
      ReconciliationId: ''
    })];
    // 网关行（小写表头）：同 merchantid/currency/金额/同日 → R5s2 命中
    const gwRows = [{
      TradeType: 'FundTransfer-in',
      merchantid: '202782001',
      currency: 'USD',
      amount: 100,
      Billdate: '2026-05-26',
      reconciliationid: 'GW-RECON'
    }];
    // 中台订单：也能匹配 b1（若未被排除会覆盖成 CH-OFFLINE）
    const midRows = [makeMidRow({ 渠道流水号: 'CH-OFFLINE' })];

    const result = await runReconciliation({
      bankRows,
      gwRows,
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })],
      midAllocationContext: { midAllocationRows: midRows }
    });

    // R5s2 网关回填胜出，R5s2b 不得覆盖
    assert.equal(bankRows[0].ReconciliationId, 'GW-RECON', '网关回填优先，R5s2b 不覆盖');
    assert.equal(result.stats.r5s2BackfilledCount, 1, 'R5s2 命中 1');
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'R5s2b 被 excludeBankRowIds 剔除 → 0 命中');
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('🔴 R5s2「同值消费但未写」行不被 R5s2b 触碰（窄缺口闭合·端到端）', async () => {
    // 构造：银行行 ReconciliationId 原值 === 网关回填值（GW-RECON）。
    //   R5s2 命中该行但 old===nv → 不 record（modifications 取不到该行），但 usedBankRowId 已消费它。
    //   若编排器只用 R5s2 modifications 收集排除集 → 该行不在排除集 → R5s2b 可二次匹配并覆盖为 CH-OFFLINE。
    //   修复后：R5s2 引擎返回 usedBankRowIds（含同值未写行），编排器 union 后 R5s2b 银行池剔除该行 → 不触碰。
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'FundTransfer-in',
      MerchantId: '202782001',
      Currency: 'USD',
      'Credit Amount': 100, 'Debit Amount': 0,
      BillDate: '2026-05-26',
      ReconciliationId: 'GW-RECON' // 原值已等于网关回填值 → R5s2 同值消费不写
    })];
    // 网关行：同字段同日同金额 + reconid === 银行原值 → R5s2 命中但 old===nv 不 record。
    const gwRows = [{
      TradeType: 'FundTransfer-in',
      merchantid: '202782001',
      currency: 'USD',
      amount: 100,
      Billdate: '2026-05-26',
      reconciliationid: 'GW-RECON'
    }];
    // 中台订单：也能匹配 b1（若该行未被排除会覆盖成 CH-OFFLINE）。
    const midRows = [makeMidRow({ 渠道流水号: 'CH-OFFLINE' })];

    const result = await runReconciliation({
      bankRows,
      gwRows,
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: POB_ON })],
      midAllocationContext: { midAllocationRows: midRows }
    });

    // R5s2 同值消费（modifications 取不到，stats=0），但该行已被排除 → R5s2b 不覆盖。
    assert.equal(result.stats.r5s2BackfilledCount, 0, 'R5s2 同值未写 → modifications 为空（计数 0）');
    assert.equal(
      bankRows[0].ReconciliationId,
      'GW-RECON',
      '🔴 同值消费行不被 R5s2b 覆盖（窄缺口闭合：usedBankRowIds 含同值未写行）'
    );
    assert.equal(result.stats.r5s2bBackfilledCount, 0, 'R5s2b 不触碰被 R5s2 消费的同值行 → 0 命中');
    // R5s2b 也不应对该行产生任何 modification
    const r5s2bMod = result.modifications.find((m) => m._round === 'R5s2b' && m.rowId === 'b1');
    assert.ok(!r5s2bMod, 'R5s2b 不应对被 R5s2 消费的行产 modification');
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});
