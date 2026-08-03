// v3.1.7 Payment 与 R5s2-recon 共享调拨对账单工作副本的编排器集成测试。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation,
  bucketScenarios
} = require('../../../src/main-process/reconciliation-orchestrator');

function makeBankRow(o = {}) {
  return {
    _rowId: o._rowId ?? 'b1',
    ReconciliationId: o.ReconciliationId ?? '',
    FundType: o.FundType ?? 'FundTransfer-in',
    MerchantId: o.MerchantId ?? '202782001',
    地区: o['地区'] ?? 'LU',
    Currency: o.Currency ?? 'USD',
    'Credit Amount': o['Credit Amount'] ?? 100,
    'Debit Amount': o['Debit Amount'] ?? 0,
    'Extra Fee': o['Extra Fee'] ?? '',
    BillDate: o.BillDate ?? '2026-05-26',
    'Drawee CardNo': o['Drawee CardNo'] ?? 'PAY-CARD-1'
  };
}

function makeReconRow(o = {}) {
  return {
    调拨单号: o.调拨单号 ?? 'FTA202606021000477',
    BillDate: o.BillDate ?? '2026-05-26',
    ReconID: o.ReconID ?? 'CH-PAYMENT',
    付款方式: o.付款方式 ?? '线下',
    付款账号: o.付款账号 ?? 'PAY-CARD-1',
    收款账号: o.收款账号 ?? '202782001',
    付款渠道: o.付款渠道 ?? '',
    收款渠道: o.收款渠道 ?? 'CITI',
    金额: o.金额 ?? 100,
    币种: o.币种 ?? 'USD',
    fund_type: o.fund_type ?? 'FundTransfer-in',
    big_account: o.big_account ?? '202782001',
    是否被使用: o.是否被使用 ?? ''
  };
}

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

function makeR5s2Scenario({ reconSourceMid = false, paymentOfflineBackfill } = {}) {
  const config = {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    reconSourceMid,
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateToleranceDays: 1
  };
  if (paymentOfflineBackfill) config.paymentOfflineBackfill = paymentOfflineBackfill;
  return {
    id: 502,
    name: '中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config
  };
}

const PAYMENT_ON = {
  enabled: true,
  bigAccount: '202782001',
  bankChannel: 'CITI',
  region: 'LU'
};

test('Payment 子配置不改变 R5s2 场景分桶', () => {
  const buckets = bucketScenarios([
    makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })
  ]);
  assert.equal(buckets.r5s2.length, 1);
  assert.equal(buckets.r5s2[0].config.paymentOfflineBackfill.enabled, true);
});

test.describe('Payment 先执行，R5s2-recon 后执行', () => {
  test('Payment 开启会强制派生表来源，并优先回填、消费银行行和派生行', async () => {
    const bankRows = [makeBankRow()];
    const reconRows = [makeReconRow({ ReconID: 'PAY-WINS' })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-MUST-NOT-WIN' })],
      scenarios: [makeR5s2Scenario({
        reconSourceMid: false,
        paymentOfflineBackfill: PAYMENT_ON
      })],
      fundTransferReconContext: { reconRows }
    });

    assert.equal(bankRows[0].ReconciliationId, 'PAY-WINS');
    assert.equal(reconRows[0].是否被使用, '1');
    assert.equal(result.stats.r5s2bMatchedCount, 1);
    assert.equal(result.stats.r5s2bBackfilledCount, 1);
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.deepEqual(result.rounds.r5s2b, { matched: 1, backfilled: 1 });
    assert.equal(result.paymentOfflineMatchedPairs[0].reconRow, reconRows[0]);
    assert.ok(result.modifications.some((item) => item._round === 'R5s2b'));
    assert.ok(result.errorReport.some((warning) => warning.code === 'payment-offline-forced-recon-source'));
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('Payment 未命中的 in 派生行可降级给 R5s2-recon', async () => {
    const bankRows = [makeBankRow({ 'Drawee CardNo': 'BANK-CARD' })];
    const reconRows = [makeReconRow({ 付款账号: 'OTHER-CARD', ReconID: 'R5-FALLBACK' })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })],
      fundTransferReconContext: { reconRows }
    });

    assert.equal(result.stats.r5s2bMatchedCount, 0);
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.equal(bankRows[0].ReconciliationId, 'R5-FALLBACK');
    assert.equal(reconRows[0].是否被使用, '1');
    assert.ok(result.modifications.some((item) => item._round === 'R5s2-recon'));
  });

  test('Payment 同值命中仍排除银行行，R5 不得用另一派生行覆盖', async () => {
    const bankRows = [makeBankRow({ ReconciliationId: 'PAY-SAME' })];
    const reconRows = [
      makeReconRow({ ReconID: 'PAY-SAME' }),
      makeReconRow({ ReconID: 'R5-MUST-NOT-OVERWRITE', 付款方式: '线上' })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })],
      fundTransferReconContext: { reconRows }
    });

    assert.equal(bankRows[0].ReconciliationId, 'PAY-SAME');
    assert.equal(result.stats.r5s2bMatchedCount, 1);
    assert.equal(result.stats.r5s2bBackfilledCount, 0);
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.equal(reconRows[0].是否被使用, '1');
    assert.equal(reconRows[1].是否被使用, '');
    assert.equal(result.modifications.length, 0);
  });

  test('同一调拨的 in 被 Payment 消费后，out 仍可由 R5s2-recon 独立回填', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'in', MerchantId: '202782001', 'Credit Amount': 100 }),
      makeBankRow({
        _rowId: 'out',
        FundType: 'FundTransfer-out',
        MerchantId: 'PAY-CARD-1',
        'Credit Amount': 0,
        'Debit Amount': 200
      })
    ];
    const reconRows = [
      makeReconRow({ ReconID: 'IN-PAYMENT' }),
      makeReconRow({
        ReconID: 'OUT-R5',
        fund_type: 'FundTransfer-out',
        big_account: 'PAY-CARD-1',
        金额: 200,
        收款渠道: '',
        付款渠道: 'CITI'
      })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })],
      fundTransferReconContext: { reconRows }
    });

    assert.equal(bankRows[0].ReconciliationId, 'IN-PAYMENT');
    assert.equal(bankRows[1].ReconciliationId, 'OUT-R5');
    assert.equal(result.stats.r5s2bBackfilledCount, 1);
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.deepEqual(reconRows.map((row) => row.是否被使用), ['1', '1']);
  });

  test('每次 run 先重置旧使用标记，再执行 Payment', async () => {
    const bankRows = [makeBankRow()];
    const reconRows = [makeReconRow({ ReconID: 'RESET-HIT', 是否被使用: '1' })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })],
      fundTransferReconContext: { reconRows }
    });

    assert.equal(bankRows[0].ReconciliationId, 'RESET-HIT');
    assert.equal(result.stats.r5s2bMatchedCount, 1);
    assert.equal(reconRows[0].是否被使用, '1');
  });
});

test.describe('Payment gating 与兼容', () => {
  test('Payment 关闭时保持 reconSourceMid=false 的网关路径', async () => {
    const bankRows = [makeBankRow()];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-ONLY' })],
      scenarios: [makeR5s2Scenario({
        reconSourceMid: false,
        paymentOfflineBackfill: { ...PAYMENT_ON, enabled: false }
      })],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'IGNORED' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'GW-ONLY');
    assert.equal(result.stats.r5s2bMatchedCount, 0);
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.ok(result.modifications.some((item) => item._round === 'R5s2'));
  });

  test('Payment 开启但共享派生表为空时安全 no-op', async () => {
    const bankRows = [makeBankRow()];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ paymentOfflineBackfill: PAYMENT_ON })]
    });
    assert.equal(result.stats.r5s2bMatchedCount, 0);
    assert.equal(result.stats.r5s2bBackfilledCount, 0);
    assert.equal(bankRows[0].ReconciliationId, '');
  });

  test('历史非法多账号配置产生可见告警，Payment 不消费任何行', async () => {
    const bankRows = [makeBankRow()];
    const reconRows = [makeReconRow({ big_account: 'OTHER' })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({
        paymentOfflineBackfill: { ...PAYMENT_ON, bigAccount: 'A、、B' }
      })],
      fundTransferReconContext: { reconRows }
    });
    assert.equal(result.stats.r5s2bMatchedCount, 0);
    assert.ok(result.errorReport.some((warning) => warning.code === 'payment-offline-invalid-big-account-config'));
  });
});
