// v3.1.7 Payment线下调拨回填引擎单测（资金红线）。
// Payment 读取调拨对账单派生行，按付款账号、动态周区间和单次运行消费状态严格 1:1 匹配。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5PaymentOfflineAllocationBackfill,
  PaymentOfflinePreflightError,
  resetFundTransferReconUsage,
  buildOrderWeekGroups,
  findGroupForBankDate,
  amountEqual,
  billDateNotEarlier,
  billDateWithinLag,
  billDateWithinWindow
} = require('../../../../src/main-process/scenario-engines/r5-payment-offline-allocation-backfill');
const { parseFtaDate } = require('../../../../src/main-process/scenario-engines/engine-week-utils');

function reconRow({
  allocationNo = 'FTA202606021000477',
  billDate = '2026-05-26',
  reconId = 'CH-1',
  payMethod = '线下',
  payAccount = 'PAY-CARD-1',
  payeeAccount = '202782001',
  payChannel = '',
  receiveChannel = 'CITI',
  amount = 100,
  currency = 'USD',
  fundType = 'FundTransfer-in',
  bigAccount = '202782001',
  used = ''
} = {}) {
  return {
    调拨单号: allocationNo,
    BillDate: billDate,
    ReconID: reconId,
    付款方式: payMethod,
    付款账号: payAccount,
    收款账号: payeeAccount,
    付款渠道: payChannel,
    收款渠道: receiveChannel,
    金额: amount,
    币种: currency,
    fund_type: fundType,
    big_account: bigAccount,
    是否被使用: used
  };
}

function bankRow({
  rowId = 'b1',
  merchantId = '202782001',
  fundType = 'FundTransfer-in',
  region = 'LU',
  billDate = '2026-05-26',
  creditAmount = 100,
  currency = 'USD',
  draweeCardNo = 'PAY-CARD-1',
  reconId = ''
} = {}) {
  return {
    _rowId: rowId,
    MerchantId: merchantId,
    FundType: fundType,
    地区: region,
    BillDate: billDate,
    'Credit Amount': creditAmount,
    Currency: currency,
    'Drawee CardNo': draweeCardNo,
    ReconciliationId: reconId
  };
}

const OPT = { bigAccount: '202782001', bankChannel: 'CITI', region: 'LU' };

test.describe('Payment v3.1.7 基础口径', () => {
  test('金额精确到分，日期规则分别覆盖 R1/R2/R3', () => {
    assert.equal(amountEqual(reconRow({ amount: 100.5 }), bankRow({ creditAmount: 100.5 })), true);
    assert.equal(amountEqual(reconRow({ amount: 100.5 }), bankRow({ creditAmount: 100.51 })), false);

    assert.equal(billDateNotEarlier(bankRow({ billDate: '2026-05-26' }), reconRow({ billDate: '2026-05-26' })), true);
    assert.equal(billDateNotEarlier(bankRow({ billDate: '2026-05-25' }), reconRow({ billDate: '2026-05-26' })), false);
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-05-24' }), reconRow({ billDate: '2026-05-26' }), 2), true);
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-05-23' }), reconRow({ billDate: '2026-05-26' }), 2), false);
    assert.equal(billDateWithinWindow(bankRow({ billDate: '2026-06-02' }), reconRow({ billDate: '2026-05-26' }), 7), true);
    assert.equal(billDateWithinWindow(bankRow({ billDate: '2026-06-03' }), reconRow({ billDate: '2026-05-26' }), 7), false);
  });

  test('主轮命中后写 ReconID，并保留回填前银行快照', () => {
    const recon = reconRow({ reconId: 'CH-OK' });
    const bank = bankRow({ reconId: 'OLD' });
    const result = runRound5PaymentOfflineAllocationBackfill([bank], [recon], OPT);

    assert.equal(bank.ReconciliationId, 'CH-OK');
    assert.equal(recon.是否被使用, '1');
    assert.deepEqual(result.modifications, [{
      rowId: 'b1', column: 'ReconciliationId', oldValue: 'OLD', newValue: 'CH-OK'
    }]);
    assert.equal(result.matchedPairs.length, 1);
    assert.equal(result.matchedPairs[0].round, 'main');
    assert.equal(result.matchedPairs[0].bankRowOriginal.ReconciliationId, 'OLD');
    assert.equal(result.matchedPairs[0].reconRow, recon);
    assert.deepEqual([...result.usedBankRowIds], ['b1']);
  });

  test('付款账号必须等于 Drawee CardNo，旧版可串配组合被拒绝', () => {
    const bank = bankRow({ draweeCardNo: 'LU340030440265302800' });
    const recon = reconRow({ payAccount: 'LU780030440265160000' });
    const result = runRound5PaymentOfflineAllocationBackfill([bank], [recon], OPT);

    assert.equal(bank.ReconciliationId, '');
    assert.equal(recon.是否被使用, '');
    assert.equal(result.matchedPairs.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-no-order-match'));
  });

  test('同值命中不产生改写，但仍消费派生行和银行行', () => {
    const recon = reconRow({ reconId: 'SAME' });
    const bank = bankRow({ reconId: 'SAME' });
    const result = runRound5PaymentOfflineAllocationBackfill([bank], [recon], OPT);

    assert.equal(result.modifications.length, 0);
    assert.equal(result.matchedPairs.length, 1);
    assert.equal(recon.是否被使用, '1');
    assert.deepEqual([...result.usedBankRowIds], ['b1']);
  });

  test('一条派生行最多消费一条银行行', () => {
    const recon = reconRow({ reconId: 'ONLY-ONCE' });
    const banks = [bankRow({ rowId: 'b1' }), bankRow({ rowId: 'b2' })];
    const result = runRound5PaymentOfflineAllocationBackfill(banks, [recon], OPT);

    assert.equal(result.matchedPairs.length, 1);
    assert.equal(banks.filter((row) => row.ReconciliationId === 'ONLY-ONCE').length, 1);
    assert.ok(result.warnings.some((warning) => (
      warning.code === 'payment-offline-no-order-match' && warning.rowId === 'b2'
    )));
  });
});

test.describe('Payment v3.1.7 候选池与稳定选择', () => {
  test('只消费线下 FundTransfer-in、配置收款渠道和配置大账号', () => {
    const invalidRows = [
      reconRow({ reconId: 'ONLINE', payMethod: '线上' }),
      reconRow({ reconId: 'OUT', fundType: 'FundTransfer-out' }),
      reconRow({ reconId: 'CHANNEL', receiveChannel: 'DBS' }),
      reconRow({ reconId: 'ACCOUNT', bigAccount: 'OTHER' })
    ];
    const result = runRound5PaymentOfflineAllocationBackfill([bankRow()], invalidRows, OPT);

    assert.equal(result.matchedPairs.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-no-eligible-recon-row'));
  });

  test('银行池同时限制 MerchantId、FundType 和地区', () => {
    const banks = [
      bankRow({ rowId: 'merchant', merchantId: 'OTHER' }),
      bankRow({ rowId: 'fund', fundType: 'FundTransfer-out' }),
      bankRow({ rowId: 'region', region: 'US' })
    ];
    const result = runRound5PaymentOfflineAllocationBackfill(banks, [reconRow()], OPT);

    assert.equal(result.matchedPairs.length, 0);
    assert.equal(result.warnings.length, 0, '非Payment银行池行不应产生未命中告警');
  });

  test('多大账号仍按 MerchantId 与派生 big_account 隔离', () => {
    const rows = [
      reconRow({ reconId: 'CH-B', bigAccount: 'B', payAccount: 'CARD-B' }),
      reconRow({ reconId: 'CH-A', bigAccount: 'A', payAccount: 'CARD-A' })
    ];
    const banks = [
      bankRow({ rowId: 'a', merchantId: 'A', draweeCardNo: 'CARD-A' }),
      bankRow({ rowId: 'b', merchantId: 'B', draweeCardNo: 'CARD-B' })
    ];
    const result = runRound5PaymentOfflineAllocationBackfill(banks, rows, {
      ...OPT,
      bigAccount: 'B、A'
    });

    assert.equal(result.matchedPairs.length, 2);
    assert.equal(banks[0].ReconciliationId, 'CH-A');
    assert.equal(banks[1].ReconciliationId, 'CH-B');
  });

  test('多候选按日期差、派生原序稳定选择并告警', () => {
    const rows = [
      reconRow({ reconId: 'FAR', billDate: '2026-05-25' }),
      reconRow({ reconId: 'NEAR', billDate: '2026-05-26' })
    ];
    const bank = bankRow({ billDate: '2026-05-26' });
    const result = runRound5PaymentOfflineAllocationBackfill([bank], rows, OPT);

    assert.equal(bank.ReconciliationId, 'NEAR');
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-multi-candidate'));
  });

  test('无效大账号配置安全 no-op 并输出告警', () => {
    const result = runRound5PaymentOfflineAllocationBackfill([bankRow()], [reconRow()], {
      ...OPT,
      bigAccount: 'A、、B'
    });
    assert.equal(result.matchedPairs.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-invalid-big-account-config'));
  });

  test('派生表为空或配置不完整时不静默成功', () => {
    const empty = runRound5PaymentOfflineAllocationBackfill([bankRow()], [], OPT);
    assert.ok(empty.warnings.some((warning) => warning.code === 'payment-offline-no-eligible-recon-row'));

    const incomplete = runRound5PaymentOfflineAllocationBackfill([bankRow()], [reconRow()], {
      ...OPT,
      region: ''
    });
    assert.ok(incomplete.warnings.some((warning) => warning.code === 'payment-offline-config-incomplete'));
  });
});

test.describe('Payment v3.1.7 动态周区间', () => {
  test('首周取前一完整 ISO 周；后续周左含右不含', () => {
    const groups = buildOrderWeekGroups([
      { ftaDate: parseFtaDate('FTA202606021000001'), sourceIndex: 0 },
      { ftaDate: parseFtaDate('FTA202606091000001'), sourceIndex: 1 }
    ]);

    assert.equal(groups.length, 2);
    assert.equal(findGroupForBankDate(groups, '2026-05-25').weekTag, groups[0].weekTag);
    assert.equal(findGroupForBankDate(groups, '2026-05-31').weekTag, groups[0].weekTag);
    assert.equal(findGroupForBankDate(groups, '2026-06-01'), null);
    assert.equal(findGroupForBankDate(groups, '2026-06-02').weekTag, groups[1].weekTag);
    assert.equal(findGroupForBankDate(groups, '2026-06-08').weekTag, groups[1].weekTag);
    assert.equal(findGroupForBankDate(groups, '2026-06-09'), null);
  });

  test('同一订单周多个 FTA 日期取最早日期作为周边界', () => {
    const groups = buildOrderWeekGroups([
      { ftaDate: parseFtaDate('FTA202606041000001'), sourceIndex: 0 },
      { ftaDate: parseFtaDate('FTA202606021000001'), sourceIndex: 1 },
      { ftaDate: parseFtaDate('FTA202606111000001'), sourceIndex: 2 }
    ]);

    assert.equal(groups[0].boundaryDate.getDate(), 2);
    assert.equal(groups[1].rangeStart.getDate(), 2);
    assert.equal(groups[1].rangeEndExclusive.getDate(), 11);
  });

  test('跨年 ISO 周连续时不误报断周', () => {
    const groups = buildOrderWeekGroups([
      { ftaDate: parseFtaDate('FTA202512301000001'), sourceIndex: 0 },
      { ftaDate: parseFtaDate('FTA202601061000001'), sourceIndex: 1 }
    ]);
    assert.equal(groups.length, 2);
  });

  test('订单周断档在任何 Payment/R5 写值前阻断', () => {
    const bank = bankRow();
    const rows = [
      reconRow({ allocationNo: 'FTA202606021000001', reconId: 'W23' }),
      reconRow({ allocationNo: 'FTA202606161000001', reconId: 'W25' })
    ];

    assert.throws(
      () => runRound5PaymentOfflineAllocationBackfill([bank], rows, OPT),
      (error) => error instanceof PaymentOfflinePreflightError
        && error.code === 'payment-offline-order-week-gap'
    );
    assert.equal(bank.ReconciliationId, '');
    assert.equal(rows[0].是否被使用, '');
  });

  test('R2 使用同一动态周区间，R3 不限周按 ±7 天兜底', () => {
    const r2Bank = bankRow({ rowId: 'r2', billDate: '2026-05-26' });
    const r2Recon = reconRow({ reconId: 'R2-HIT', billDate: '2026-05-28' });
    const r2 = runRound5PaymentOfflineAllocationBackfill([r2Bank], [r2Recon], OPT);
    assert.equal(r2.matchedPairs[0].round, 'date-tolerance');

    const r3Bank = bankRow({ rowId: 'r3', billDate: '2026-06-03' });
    const r3Recon = reconRow({ reconId: 'R3-HIT', billDate: '2026-06-02' });
    const r3 = runRound5PaymentOfflineAllocationBackfill([r3Bank], [r3Recon], OPT);
    assert.equal(r3.matchedPairs[0].round, 'relaxed-week');
  });
});

test.describe('Payment v3.1.7 失败与运行状态', () => {
  test('非法 FTA 日期阻断且不写值', () => {
    const bank = bankRow();
    assert.throws(
      () => runRound5PaymentOfflineAllocationBackfill([bank], [reconRow({ allocationNo: 'BAD' })], OPT),
      (error) => error.code === 'payment-offline-invalid-fta'
    );
    assert.equal(bank.ReconciliationId, '');
  });

  test('派生字段缺失阻断，禁止以旧订单结构降级运行', () => {
    assert.throws(
      () => runRound5PaymentOfflineAllocationBackfill([bankRow()], [{ 调拨单号: 'FTA202606021000001' }], OPT),
      (error) => error.code === 'payment-offline-recon-schema-invalid'
    );
  });

  test('ReconID 或付款账号为空时可见告警且不占用银行行', () => {
    const rows = [
      reconRow({ reconId: '' }),
      reconRow({ reconId: 'HAS-ID', payAccount: '' })
    ];
    const result = runRound5PaymentOfflineAllocationBackfill([bankRow()], rows, OPT);
    assert.equal(result.matchedPairs.length, 0);
    assert.equal(result.usedBankRowIds.size, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-empty-recon-id'));
    assert.ok(result.warnings.some((warning) => warning.code === 'payment-offline-empty-pay-account'));
  });

  test('每次运行可统一重置是否被使用，且不改其它派生字段', () => {
    const rows = [reconRow({ reconId: 'KEEP', used: '1' }), reconRow({ reconId: 'KEEP-2', used: 'x' })];
    assert.equal(resetFundTransferReconUsage(rows), rows);
    assert.deepEqual(rows.map((row) => row.是否被使用), ['', '']);
    assert.deepEqual(rows.map((row) => row.ReconID), ['KEEP', 'KEEP-2']);
  });
});
