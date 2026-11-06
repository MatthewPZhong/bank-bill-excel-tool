// v3.2.15：自带写死场景「适用银行渠道」对独立分桶的 R4 资金性质校验与 R5 场景4 退款回填同样生效
//   （v2.1.13 D-3：空列表 = 全部；只处理 matchedChannel 在列表内的银行行，与 R2 dispatcher 同口径）。
//   🔴 资金红线：排除渠道的银行行不得被改写 FundType，也不得产出退款 SUCCESS 回填行。

const test = require('node:test');
const assert = require('node:assert/strict');

const { runReconciliation } = require('../../../src/main-process/reconciliation-orchestrator');

const CHANNELS = [
  { id: 1, name: '工商', location: '上海' },
  { id: 2, name: '花旗', location: '纽约' }
];

// 双维调度依赖：按 Channel + 地区查渠道（与生产 channels 仓储同签名）。
const DEPS = {
  db: {},
  channelsRepo: {
    findByNameAndLocation: (_db, name, location) =>
      CHANNELS.find((channel) => channel.name === name && channel.location === location) || null,
    getBuiltinGeneral: () => ({ id: 99, name: '通用', location: '' })
  }
};

function makeBankRow(overrides = {}) {
  return {
    _rowId: overrides._rowId,
    ReconciliationId: overrides.ReconciliationId ?? '',
    FundType: overrides.FundType ?? '',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'USD',
    'Credit Amount': overrides['Credit Amount'] ?? 0,
    'Debit Amount': overrides['Debit Amount'] ?? '',
    BillDate: overrides.BillDate ?? '2026-06-01',
    Channel: overrides.Channel ?? '工商',
    地区: overrides['地区'] ?? '上海',
    ChannelOrderNo: overrides.ChannelOrderNo ?? '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': ''
  };
}

function makeGwRow(overrides = {}) {
  return {
    reconciliationid: overrides.reconciliationid ?? '',
    TradeType: overrides.TradeType ?? '',
    merchantid: overrides.merchantid ?? 'M001',
    currency: overrides.currency ?? 'USD',
    amount: overrides.amount ?? '',
    Billdate: overrides.Billdate ?? '2026-06-01',
    orderid: overrides.orderid ?? ''
  };
}

function makeR4AchReturnScenario(applicableChannelIds) {
  return {
    id: 401,
    name: 'R4-Ach Return',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    _applicableChannelIds: applicableChannelIds,
    config: { funcCategory: 'fund-nature-check', subCategory: 'ach-return' }
  };
}

function makeR4WireReturnScenario(applicableChannelIds) {
  return {
    id: 402,
    name: 'R4-Wire Return',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    _applicableChannelIds: applicableChannelIds,
    config: { funcCategory: 'fund-nature-check', subCategory: 'wire-return' }
  };
}

function makeRefundScenario(applicableChannelIds) {
  return {
    id: 504,
    name: '中台退款订单回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    _applicableChannelIds: applicableChannelIds,
    config: { funcCategory: 'platform-order', subCategory: 'refund-order-backfill', roundPhase: 5 }
  };
}

// 三条同构的 AchReturn 银行行：工商-上海、花旗-纽约、未登记渠道（招商-深圳）。
function buildR4Data() {
  const bankRows = [
    makeBankRow({ _rowId: 'icbc', ReconciliationId: 'RC-1', FundType: 'outbound', 'Debit Amount': 100 }),
    makeBankRow({ _rowId: 'citi', ReconciliationId: 'RC-2', FundType: 'outbound', 'Debit Amount': 100, Channel: '花旗', 地区: '纽约' }),
    makeBankRow({ _rowId: 'unknown', ReconciliationId: 'RC-3', FundType: 'outbound', 'Debit Amount': 100, Channel: '招商', 地区: '深圳' })
  ];
  const gwRows = ['RC-1', 'RC-2', 'RC-3'].map((reconciliationid) => makeGwRow({
    reconciliationid, TradeType: 'AchReturn', amount: 100
  }));
  return { bankRows, gwRows };
}

function fundTypes(bankRows) {
  return Object.fromEntries(bankRows.map((row) => [row._rowId, row.FundType]));
}

test('R4：只改写适用渠道内银行行的 FundType；排除渠道与未登记渠道的行不改、不告警', async () => {
  const { bankRows, gwRows } = buildR4Data();
  const result = await runReconciliation({ bankRows, gwRows, scenarios: [makeR4AchReturnScenario([1])], deps: DEPS });

  assert.deepEqual(fundTypes(bankRows), { icbc: 'Ach Return', citi: 'outbound', unknown: 'outbound' });
  assert.deepEqual(result.modifiedRows.map((row) => row._rowId), ['icbc']);
  assert.deepEqual(result.unmatchedRows.map((row) => row._rowId), ['citi', 'unknown']);
  assert.equal(result.errorReport.filter((warning) => String(warning.code || '').startsWith('r4-')).length, 0);
});

test('R4：适用列表为空 = 全部渠道；只选花旗时只改花旗', async () => {
  const all = buildR4Data();
  await runReconciliation({ ...all, scenarios: [makeR4AchReturnScenario([])], deps: DEPS });
  assert.deepEqual(fundTypes(all.bankRows), { icbc: 'Ach Return', citi: 'Ach Return', unknown: 'Ach Return' });

  const citiOnly = buildR4Data();
  await runReconciliation({ ...citiOnly, scenarios: [makeR4AchReturnScenario([2])], deps: DEPS });
  assert.deepEqual(fundTypes(citiOnly.bankRows), { icbc: 'outbound', citi: 'Ach Return', unknown: 'outbound' });
});

test('R4：不同子场景各自按自己的适用渠道生效', async () => {
  const bankRows = [
    makeBankRow({ _rowId: 'ach-icbc', ReconciliationId: 'RC-A1', FundType: 'outbound', 'Debit Amount': 100 }),
    makeBankRow({ _rowId: 'ach-citi', ReconciliationId: 'RC-A2', FundType: 'outbound', 'Debit Amount': 100, Channel: '花旗', 地区: '纽约' }),
    // Wire Return 按贷方金额匹配。
    makeBankRow({ _rowId: 'wire-icbc', ReconciliationId: 'RC-W1', FundType: 'inbound', 'Credit Amount': 100, 'Debit Amount': 0 }),
    makeBankRow({ _rowId: 'wire-citi', ReconciliationId: 'RC-W2', FundType: 'inbound', 'Credit Amount': 100, 'Debit Amount': 0, Channel: '花旗', 地区: '纽约' })
  ];
  const gwRows = [
    makeGwRow({ reconciliationid: 'RC-A1', TradeType: 'AchReturn', amount: 100 }),
    makeGwRow({ reconciliationid: 'RC-A2', TradeType: 'AchReturn', amount: 100 }),
    makeGwRow({ reconciliationid: 'RC-W1', TradeType: 'WireReturn', amount: 100 }),
    makeGwRow({ reconciliationid: 'RC-W2', TradeType: 'WireReturn', amount: 100 })
  ];
  await runReconciliation({
    bankRows,
    gwRows,
    scenarios: [makeR4AchReturnScenario([1]), makeR4WireReturnScenario([2])],
    deps: DEPS
  });
  assert.deepEqual(fundTypes(bankRows), {
    'ach-icbc': 'Ach Return',
    'ach-citi': 'outbound',
    'wire-icbc': 'inbound',
    'wire-citi': 'Wire Return'
  });
});

test('R4：未提供渠道仓储（单维调度）时与 R2 一致不按渠道过滤', async () => {
  const { bankRows, gwRows } = buildR4Data();
  await runReconciliation({ bankRows, gwRows, scenarios: [makeR4AchReturnScenario([1])] });
  assert.deepEqual(fundTypes(bankRows), { icbc: 'Ach Return', citi: 'Ach Return', unknown: 'Ach Return' });
});

// 两条 Ach Return 银行行各对应一条 SUBMITTED 退款订单（S1：ChannelOrderNo ↔ 银行打款流水号）。
function buildRefundData() {
  const bankRows = [
    makeBankRow({ _rowId: 'icbc', FundType: 'Ach Return', 'Debit Amount': 100, ChannelOrderNo: 'PAY-1' }),
    makeBankRow({ _rowId: 'citi', FundType: 'Ach Return', 'Debit Amount': 100, ChannelOrderNo: 'PAY-2', Channel: '花旗', 地区: '纽约' })
  ];
  const refundOrderRows = [
    { 流水号: 'REF-1', 银行大账号: 'M001', 退款金额: 100, 币种: 'USD', 状态: 'SUBMITTED', 银行打款流水号: 'PAY-1', 附言: '', valueDate: '2026-06-01' },
    { 流水号: 'REF-2', 银行大账号: 'M001', 退款金额: 100, 币种: 'USD', 状态: 'SUBMITTED', 银行打款流水号: 'PAY-2', 附言: '', valueDate: '2026-06-01' }
  ];
  return { bankRows, refundContext: { refundOrderRows, depositRows: [] } };
}

test('退款回填：只为适用渠道内的银行行产出 SUCCESS 回填，排除渠道不产出', async () => {
  const data = buildRefundData();
  const result = await runReconciliation({ ...data, gwRows: [], scenarios: [makeRefundScenario([1])], deps: DEPS });
  assert.deepEqual(result.refundBackfillRows.map((row) => [row['退款单号'], row['状态']]), [['REF-1', 'SUCCESS']]);
  assert.equal(result.stats.r5s4BackfilledCount, 1);
});

test('退款回填：适用列表为空 = 全部渠道', async () => {
  const data = buildRefundData();
  const result = await runReconciliation({ ...data, gwRows: [], scenarios: [makeRefundScenario([])], deps: DEPS });
  assert.deepEqual(
    result.refundBackfillRows.map((row) => [row['退款单号'], row['状态']]).sort(),
    [['REF-1', 'SUCCESS'], ['REF-2', 'SUCCESS']]
  );
});
