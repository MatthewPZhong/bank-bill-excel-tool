'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runPositionFundNatureCheck,
  compareLocalCalendarDays
} = require('../../../src/main-process/position-reconciliation/matching-engine');
const {
  AUDIT_FIELDS,
  HIT_TYPES,
  REASON_CODES,
  PAIR_DEFINITIONS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/contracts');

function bank(fundType, overrides = {}) {
  return {
    BizId: overrides.BizId ?? `BIZ-${overrides._rowId || '1'}`,
    _rowId: overrides._rowId ?? 'bank-1',
    FundType: fundType,
    BillDate: overrides.BillDate ?? '2026-07-20',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'USD',
    ReconciliationId: overrides.ReconciliationId ?? 'RID-1',
    ChannelOrderNo: overrides.ChannelOrderNo ?? '',
    CustomerRef: overrides.CustomerRef ?? '',
    'Credit Amount': overrides['Credit Amount'] ?? '100',
    'Debit Amount': overrides['Debit Amount'] ?? '0',
    'Extra Fee': overrides['Extra Fee'] ?? '',
    'Payee CardNo': overrides['Payee CardNo'] ?? '',
    'Drawee CardNo': overrides['Drawee CardNo'] ?? '',
    [AUDIT_FIELDS.DETAIL]: overrides[AUDIT_FIELDS.DETAIL] ?? 'OLD',
    [AUDIT_FIELDS.TYPE]: overrides[AUDIT_FIELDS.TYPE] ?? 'OLD',
    [AUDIT_FIELDS.MATCH_DETAIL]: overrides[AUDIT_FIELDS.MATCH_DETAIL] ?? 'OLD'
  };
}

function inbound(overrides = {}) {
  return {
    ReconID: overrides.ReconID ?? 'RID-1',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'USD',
    tradeType: overrides.tradeType ?? 'Inbound-VA',
    originOutboundCurrency: overrides.originOutboundCurrency ?? 'USD'
  };
}

function outbound(overrides = {}) {
  return {
    ReconID: overrides.ReconID ?? 'RID-1',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'EUR',
    '交易类型': overrides['交易类型'] ?? 'PUBLIC_PAY',
    '原始币种': overrides['原始币种'] ?? 'EUR',
    '原始金额': overrides['原始金额'] ?? '100',
    '银行扣款币种': overrides['银行扣款币种'] ?? 'USD'
  };
}

function transfer(overrides = {}) {
  const direction = overrides.FundType ?? 'FundTransfer-out';
  return {
    ReconID: overrides.ReconID ?? 'RID-1',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? (direction === 'FundTransfer-in' ? 'EUR' : 'USD'),
    Amount: overrides.Amount ?? '100',
    FundType: direction,
    '调拨单号': overrides['调拨单号'] ?? 'FT-1',
    '调拨状态': overrides['调拨状态'] ?? '付款成功',
    '交易时间': overrides['交易时间'] ?? '2026-07-19 12:00:00',
    '付款币种': overrides['付款币种'] ?? 'USD',
    '收款币种': overrides['收款币种'] ?? 'EUR'
  };
}

function testPayment(overrides = {}) {
  return {
    ReconID: overrides.ReconID ?? 'RID-1',
    '付款单号': overrides['付款单号'] ?? 'TEST-1',
    '付款状态': overrides['付款状态'] ?? '付款成功',
    '目标币种': overrides['目标币种'] ?? 'USD'
  };
}

function account(overrides = {}) {
  return {
    '账户状态': overrides['账户状态'] ?? '正常',
    '账户性质': overrides['账户性质'] ?? '自有',
    '币种': overrides['币种'] ?? 'USD',
    '银行账号': overrides['银行账号'] ?? 'OWN-001',
    '系统账号': overrides['系统账号'] ?? ''
  };
}

function run(bankRows, sources = {}) {
  return runPositionFundNatureCheck({
    bankRows,
    gatewayInboundRows: sources.gatewayInboundRows || [],
    gatewayOutboundRows: sources.gatewayOutboundRows || [],
    fundTransferRows: sources.fundTransferRows || [],
    testPaymentRows: sources.testPaymentRows || [],
    bankAccountRows: sources.bankAccountRows || [],
    allUnarchivedBankRows: sources.allUnarchivedBankRows || []
  });
}

test.describe('平盘资金性质十组配对与审计', () => {
  test('契约固定十组基础/FX配对', () => {
    assert.equal(PAIR_DEFINITIONS.length, 10);
    assert.deepEqual(PAIR_DEFINITIONS.map((item) => [item.baseFundType, item.fxFundType]), [
      ['Inbound', 'Inbound&FX'],
      ['outbound', 'Outbound&FX'],
      ['FundTransfer-in', 'FundTransfer-in&FX'],
      ['FundTransfer-out', 'FundTransfer-out&FX'],
      ['Ach Return', 'Ach Return&FX'],
      ['Wire Return', 'Wire Return&FX'],
      ['Others', 'Others&FX'],
      ['Revenue Clear', 'Revenue Clear&FX'],
      ['From TREASURY FUND', 'From TREASURY FUND&FX'],
      ['Test', 'Test&FX']
    ]);
  });

  test('Inbound 可增加FX，只有三种币种明确相同时才移除FX', () => {
    const result = run([
      bank('Inbound', { _rowId: 'fx', ReconciliationId: 'IN-FX', Currency: 'USD' }),
      bank('Inbound&FX', { _rowId: 'base', ReconciliationId: 'IN-BASE', Currency: 'USD' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'IN-FX', Currency: 'USD', originOutboundCurrency: 'EUR' }),
        inbound({ ReconID: 'IN-BASE', Currency: 'USD', originOutboundCurrency: 'USD' })
      ]
    });
    assert.deepEqual(result.resultRows.map((row) => row.FundType), ['Inbound&FX', 'Inbound']);
    assert.equal(result.modifications.length, 2);
    assert.ok(result.resultRows.every((row) => row[AUDIT_FIELDS.TYPE] === HIT_TYPES.PRECISE));
  });

  test('Inbound 原始出金币种为空时证据不足，保持原值并转人工', () => {
    const result = run([
      bank('Inbound&FX', { ReconciliationId: 'IN-UNKNOWN', Currency: 'USD' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'IN-UNKNOWN', Currency: 'USD', originOutboundCurrency: '' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Inbound&FX');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.MANUAL);
    assert.equal(result.differences.length, 1);
  });

  test('Inbound 出现订单、原始和银行三种不同币种时不得自动判为FX', () => {
    const result = run([
      bank('Inbound', { ReconciliationId: 'IN-THREE', Currency: 'GBP' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'IN-THREE', Currency: 'USD', originOutboundCurrency: 'EUR' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Inbound');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.MANUAL);
    assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /无法唯一判定/);
    assert.equal(result.differences.length, 1);
  });

  test('Inbound 的原始出金币种、订单币种和银行币种相同时判定不涉及换汇', () => {
    const result = run([
      bank('Inbound&FX', { ReconciliationId: 'IN-SAME', Currency: 'USD' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'IN-SAME', Currency: 'USD', originOutboundCurrency: 'USD' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Inbound');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.PRECISE);
  });

  test('Wire Return 只读取 WireReturn，普通 Inbound-VA 不得串场景', () => {
    const result = run([
      bank('Wire Return', { ReconciliationId: 'WIRE' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'WIRE', tradeType: 'Inbound-VA' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Wire Return');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.UNMATCHED);
    assert.equal(result.differences.length, 1);
  });

  test('outbound 精准/模糊规则只允许增加FX，不满足时不得自动移除FX', () => {
    const result = run([
      bank('outbound', {
        _rowId: 'precise',
        ReconciliationId: 'OUT-1',
        'Credit Amount': '0',
        'Debit Amount': '100'
      }),
      bank('outbound', {
        _rowId: 'fuzzy',
        ReconciliationId: 'OUT-2',
        'Credit Amount': '0',
        'Debit Amount': '100'
      }),
      bank('Outbound&FX', {
        _rowId: 'manual',
        ReconciliationId: 'OUT-3',
        'Credit Amount': '0',
        'Debit Amount': '100'
      })
    ], {
      gatewayOutboundRows: [
        outbound({ ReconID: 'OUT-1', Currency: 'EUR' }),
        outbound({
          ReconID: 'OUT-2',
          Currency: 'USD',
          '原始币种': 'EUR',
          '原始金额': '10'
        }),
        outbound({
          ReconID: 'OUT-3',
          Currency: 'USD',
          '原始币种': 'USD',
          '原始金额': '10'
        })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Outbound&FX');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.PRECISE);
    assert.equal(result.resultRows[1].FundType, 'Outbound&FX');
    assert.equal(result.resultRows[1][AUDIT_FIELDS.TYPE], HIT_TYPES.FUZZY);
    assert.equal(result.resultRows[2].FundType, 'Outbound&FX');
    assert.equal(result.resultRows[2][AUDIT_FIELDS.TYPE], HIT_TYPES.MANUAL);
  });

  test('Ach Return 只读取 AchReturn；普通 outbound 明确排除 AchReturn', () => {
    const result = run([
      bank('Ach Return', {
        _rowId: 'ach',
        ReconciliationId: 'ACH',
        'Credit Amount': '0',
        'Debit Amount': '100'
      }),
      bank('outbound', {
        _rowId: 'out',
        ReconciliationId: 'ACH-OUT',
        'Credit Amount': '0',
        'Debit Amount': '100'
      })
    ], {
      gatewayOutboundRows: [
        outbound({ ReconID: 'ACH', '交易类型': 'AchReturn', Currency: 'EUR' }),
        outbound({ ReconID: 'ACH-OUT', '交易类型': 'AchReturn', Currency: 'EUR' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Ach Return&FX');
    assert.equal(result.resultRows[1].FundType, 'outbound');
    assert.equal(result.resultRows[1][AUDIT_FIELDS.TYPE], HIT_TYPES.UNMATCHED);
  });

  test('Test 不比较账户和金额，Credit 非0也不阻断；异常付款状态为模糊命中', () => {
    const result = run([
      bank('Test', {
        _rowId: 'test',
        MerchantId: 'NO-ACCOUNT',
        Currency: 'EUR',
        'Credit Amount': '999',
        'Debit Amount': '1'
      })
    ], {
      testPaymentRows: [
        testPayment({ '付款状态': '付款失败', '目标币种': 'USD' })
      ]
    });
    assert.equal(result.resultRows[0].FundType, 'Test&FX');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.FUZZY);
    assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /付款失败/);
  });

  for (const [fundType, fxFundType] of [
    ['Others', 'Others&FX'],
    ['Revenue Clear', 'Revenue Clear&FX'],
    ['From TREASURY FUND', 'From TREASURY FUND&FX']
  ]) {
    test(`${fundType}：唯一自有/非自有账户币种不同改为 ${fxFundType}`, () => {
      const result = run([
        bank(fundType, {
          'Payee CardNo': 'prefix-OWN-001',
          'Drawee CardNo': 'OTHER-001',
          MerchantId: ''
        })
      ], {
        bankAccountRows: [
          account(),
          account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER-001' })
        ]
      });
      assert.equal(result.resultRows[0].FundType, fxFundType);
      assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.PRECISE);
      assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /自有账户别名=OWN-001/);
      assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /非自有账户别名=OTHER-001/);
    });
  }

  test('不支持的 FundType 原样保留且标记不适用，不进入差异', () => {
    const input = bank('Charge');
    const result = run([input]);
    assert.equal(result.resultRows[0].FundType, 'Charge');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.NOT_APPLICABLE);
    assert.equal(result.differences.length, 0);
    assert.equal(result.summary.notApplicable, 1);
  });
});

test.describe('标识符与严格1:1', () => {
  test('对账标识 trim 后大小写敏感，前导零保留', () => {
    const success = run([
      bank('Inbound', { ReconciliationId: ' 00123 ' })
    ], {
      gatewayInboundRows: [inbound({ ReconID: '00123' })]
    });
    assert.equal(success.matches.length, 1);

    const wrongCase = run([
      bank('Inbound', { ReconciliationId: 'rid-1' })
    ], {
      gatewayInboundRows: [inbound({ ReconID: 'RID-1' })]
    });
    assert.equal(wrongCase.matches.length, 0);
    assert.equal(wrongCase.differences[0].reasonCode, REASON_CODES.IDENTIFIER_NOT_FOUND);
  });

  test('不同银行标识命中不同链接记录时直接转人工，不选其中一条', () => {
    const result = run([
      bank('Inbound', {
        ReconciliationId: 'RID-A',
        ChannelOrderNo: 'RID-B'
      })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'RID-A' }),
        inbound({ ReconID: 'RID-B' })
      ]
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.differences[0].reasonCode, REASON_CODES.IDENTIFIER_CONFLICT);
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.MANUAL);
  });

  test('同一 ReconID 多条完整链接候选全部转人工', () => {
    const result = run([
      bank('Inbound')
    ], {
      gatewayInboundRows: [inbound(), inbound()]
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.differences[0].reasonCode, REASON_CODES.CANDIDATE_MULTIPLE);
  });

  test('两条银行行共享同一链接候选时双方都转人工，不按银行顺序抢占', () => {
    const result = run([
      bank('Inbound', { _rowId: 'first', BizId: 'B1' }),
      bank('Inbound', { _rowId: 'second', BizId: 'B2' })
    ], {
      gatewayInboundRows: [inbound()]
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.differences.length, 2);
    assert.ok(result.differences.every((item) => item.reasonCode === REASON_CODES.COUNTERPARTY_REUSED));
  });

  test('同值命中仍消费并记录配对，但不生成 modification 和命中明细', () => {
    const result = run([
      bank('Inbound')
    ], {
      gatewayInboundRows: [inbound()]
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.modifications.length, 0);
    assert.equal(result.resultRows[0][AUDIT_FIELDS.DETAIL], '');
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.PRECISE);
  });
});

test.describe('调拨金额、方向与日期', () => {
  test('FundTransfer-out 支持负手续费95和正手续费1027两个资金边界', () => {
    const result = run([
      bank('FundTransfer-out', {
        _rowId: 'negative-fee',
        BizId: 'NEG',
        ReconciliationId: 'FT-95',
        'Credit Amount': '0',
        'Debit Amount': '100',
        'Extra Fee': '-5'
      }),
      bank('FundTransfer-out', {
        _rowId: 'positive-fee',
        BizId: 'POS',
        ReconciliationId: 'FT-1027',
        'Credit Amount': '',
        'Debit Amount': '1000',
        'Extra Fee': '27'
      })
    ], {
      fundTransferRows: [
        transfer({ ReconID: 'FT-95', Amount: '95', '调拨单号': 'T95' }),
        transfer({ ReconID: 'FT-1027', Amount: '1027', '调拨单号': 'T1027' })
      ]
    });
    assert.deepEqual(result.resultRows.map((row) => row.FundType), [
      'FundTransfer-out&FX',
      'FundTransfer-out&FX'
    ]);
    assert.equal(result.matches.length, 2);
    assert.equal(result.differences.length, 0);
  });

  test('金额精确到分比较，非法手续费、负合计和相反方向非0转人工', () => {
    const result = run([
      bank('FundTransfer-out', {
        _rowId: 'round',
        BizId: 'ROUND',
        ReconciliationId: 'ROUND',
        'Credit Amount': '0',
        'Debit Amount': '1.005'
      }),
      bank('FundTransfer-out', {
        _rowId: 'bad-fee',
        BizId: 'BAD',
        ReconciliationId: 'BAD',
        'Credit Amount': '0',
        'Debit Amount': '100',
        'Extra Fee': 'bad'
      }),
      bank('FundTransfer-out', {
        _rowId: 'opposite',
        BizId: 'OPP',
        ReconciliationId: 'OPP',
        'Credit Amount': '1',
        'Debit Amount': '100'
      })
    ], {
      fundTransferRows: [
        transfer({ ReconID: 'ROUND', Amount: '1.01', '调拨单号': 'ROUND' }),
        transfer({ ReconID: 'BAD', Amount: '100', '调拨单号': 'BAD' }),
        transfer({ ReconID: 'OPP', Amount: '100', '调拨单号': 'OPP' })
      ]
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.differences.length, 2);
    assert.ok(result.differences.every((item) => item.reasonCode === REASON_CODES.DIRECTION_INVALID));
  });

  test('FundTransfer-out BillDate 不得早于交易时间', () => {
    const result = run([
      bank('FundTransfer-out', {
        BillDate: '2026-07-18',
        'Credit Amount': '0',
        'Debit Amount': '100'
      })
    ], {
      fundTransferRows: [transfer({ '交易时间': '2026-07-19 23:59:59' })]
    });
    assert.equal(result.matches.length, 0);
    assert.equal(result.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.UNMATCHED);
    assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /早于调拨交易时间/);
  });

  test('FundTransfer-in 同时要求不早于交易时间和唯一 FundTransfer-out 银行日期', () => {
    const outBank = bank('FundTransfer-out', {
      _rowId: 'out',
      BizId: 'OUT',
      ReconciliationId: 'RID-OUT',
      MerchantId: 'M-OUT',
      Currency: 'USD',
      BillDate: '2026-07-20',
      'Credit Amount': '0',
      'Debit Amount': '100'
    });
    const inBank = bank('FundTransfer-in', {
      _rowId: 'in',
      BizId: 'IN',
      ReconciliationId: 'RID-IN',
      MerchantId: 'M-IN',
      Currency: 'EUR',
      BillDate: '2026-07-21',
      'Credit Amount': '90',
      'Debit Amount': '0'
    });
    const result = run([inBank, outBank], {
      fundTransferRows: [
        transfer({
          ReconID: 'RID-OUT',
          MerchantId: 'M-OUT',
          Currency: 'USD',
          Amount: '100',
          FundType: 'FundTransfer-out'
        }),
        transfer({
          ReconID: 'RID-IN',
          MerchantId: 'M-IN',
          Currency: 'EUR',
          Amount: '90',
          FundType: 'FundTransfer-in'
        })
      ]
    });
    assert.equal(result.matches.length, 2);
    assert.equal(result.resultRows[0].FundType, 'FundTransfer-in&FX');
    assert.match(result.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /对应FundTransfer-out BillDate=2026-07-20/);
  });

  test('FundTransfer-in 可读取当前选择外的未归档 out；缺失或多条均转人工', () => {
    const inRow = bank('FundTransfer-in', {
      ReconciliationId: 'RID-IN',
      MerchantId: 'M-IN',
      Currency: 'EUR',
      BillDate: '2026-07-21',
      'Credit Amount': '90',
      'Debit Amount': '0'
    });
    const rows = [
      transfer({
        ReconID: 'RID-OUT',
        MerchantId: 'M-OUT',
        Currency: 'USD',
        Amount: '100',
        FundType: 'FundTransfer-out'
      }),
      transfer({
        ReconID: 'RID-IN',
        MerchantId: 'M-IN',
        Currency: 'EUR',
        Amount: '90',
        FundType: 'FundTransfer-in'
      })
    ];
    const historicalOut = bank('FundTransfer-out', {
      _rowId: 'history-out',
      BizId: 'HISTORY',
      ReconciliationId: 'RID-OUT',
      MerchantId: 'M-OUT',
      Currency: 'USD',
      BillDate: '2026-07-20',
      'Credit Amount': '0',
      'Debit Amount': '100'
    });
    const success = run([inRow], {
      fundTransferRows: rows,
      allUnarchivedBankRows: [historicalOut]
    });
    assert.equal(success.matches.length, 1);

    const multiple = run([inRow], {
      fundTransferRows: rows,
      allUnarchivedBankRows: [
        historicalOut,
        { ...historicalOut, _rowId: 'history-2', BizId: 'HISTORY-2' }
      ]
    });
    assert.equal(multiple.matches.length, 0);
    assert.equal(multiple.resultRows[0][AUDIT_FIELDS.TYPE], HIT_TYPES.MANUAL);
    assert.match(multiple.resultRows[0][AUDIT_FIELDS.MATCH_DETAIL], /找到2条/);
  });

  test('本地日比较忽略时分秒，非法日期返回 null', () => {
    assert.equal(compareLocalCalendarDays('2026-07-20 00:01', '2026-07-20 23:59'), 0);
    assert.equal(compareLocalCalendarDays('2026-07-21', '2026-07-20'), 1);
    assert.equal(compareLocalCalendarDays('2026-07-19', '2026-07-20'), -1);
    assert.equal(compareLocalCalendarDays('bad', '2026-07-20'), null);
  });
});

test.describe('账户场景冲突、结果守恒与输入只读', () => {
  test('两个账户币种相同会移除FX；多个自有账户转人工', () => {
    const sameCurrency = run([
      bank('Others&FX', {
        'Payee CardNo': 'OWN',
        'Drawee CardNo': 'OTHER',
        MerchantId: ''
      })
    ], {
      bankAccountRows: [
        account({ '银行账号': 'OWN', '币种': 'USD' }),
        account({ '银行账号': 'OTHER', '币种': 'USD', '账户性质': '客户' })
      ]
    });
    assert.equal(sameCurrency.resultRows[0].FundType, 'Others');
    assert.equal(sameCurrency.modifications.length, 1);

    const multipleOwn = run([
      bank('Others', {
        'Payee CardNo': 'OWN-A',
        'Drawee CardNo': 'OTHER',
        MerchantId: 'OWN-B'
      })
    ], {
      bankAccountRows: [
        account({ '银行账号': 'OWN-A' }),
        account({ '银行账号': 'OWN-B' }),
        account({ '银行账号': 'OTHER', '币种': 'EUR', '账户性质': '客户' })
      ]
    });
    assert.equal(multipleOwn.differences[0].reasonCode, REASON_CODES.OWN_ACCOUNT_MULTIPLE);
  });

  test('每条输入行恰有一个去向，结果按原序输出且不修改输入对象', () => {
    const matched = bank('Inbound', { _rowId: 'matched', BizId: 'M' });
    const unmatched = bank('Inbound', {
      _rowId: 'unmatched',
      BizId: 'U',
      ReconciliationId: 'NOPE'
    });
    const unsupported = bank('Charge', { _rowId: 'unsupported', BizId: 'N' });
    const before = structuredClone([matched, unmatched, unsupported]);
    const result = run([matched, unmatched, unsupported], {
      gatewayInboundRows: [inbound()]
    });

    assert.equal(result.resultRows.length, 3);
    assert.equal(result.outcomes.length, 3);
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.matched, 1);
    assert.equal(result.summary.differences, 1);
    assert.equal(result.summary.notApplicable, 1);
    assert.deepEqual([matched, unmatched, unsupported], before, '核心引擎不得修改输入银行行');
    assert.notEqual(result.resultRows[0], matched);
  });

  test('仅实际 FundType 修改生成命中明细和 modification，差异行不伪造标黄依据', () => {
    const result = run([
      bank('Inbound', { _rowId: 'change', ReconciliationId: 'FX' }),
      bank('Inbound', { _rowId: 'noop', ReconciliationId: 'BASE' }),
      bank('Inbound', { _rowId: 'diff', ReconciliationId: 'MISS' })
    ], {
      gatewayInboundRows: [
        inbound({ ReconID: 'FX', originOutboundCurrency: 'EUR' }),
        inbound({ ReconID: 'BASE', originOutboundCurrency: '' })
      ]
    });
    assert.deepEqual(result.modifications, [{
      rowId: 'change',
      column: 'FundType',
      oldValue: 'Inbound',
      newValue: 'Inbound&FX'
    }]);
    assert.match(result.resultRows[0][AUDIT_FIELDS.DETAIL], /Inbound→Inbound&FX/);
    assert.equal(result.resultRows[1][AUDIT_FIELDS.DETAIL], '');
    assert.equal(result.resultRows[2][AUDIT_FIELDS.DETAIL], '');
  });
});

test.describe('并行接线服务兼容契约', () => {
  test('接受 linkedRows/allBankRows 结构并返回 service 所需 rows 契约', () => {
    const bankRow = bank('Inbound', {
      _rowId: '',
      BizId: '',
      ReconciliationId: 'SERVICE-RID'
    });
    bankRow._positionBankId = 42;
    bankRow._positionBizId = 'SERVICE-BIZ';
    const result = runPositionFundNatureCheck({
      bankRows: [bankRow],
      linkedRows: {
        [SOURCE_TYPES.GATEWAY_INBOUND]: [{
          ...inbound({ ReconID: 'SERVICE-RID', originOutboundCurrency: 'EUR' }),
          _linkRowId: 7,
          _sourceBusinessKey: 'GW-BIZ',
          _sourceRowNumber: 12
        }]
      },
      rawSourceRows: {},
      allBankRows: []
    });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].bizId, 'SERVICE-BIZ');
    assert.equal(result.rows[0].bankRow.FundType, 'Inbound&FX');
    assert.equal(result.rows[0].resultFundType, 'Inbound&FX');
    assert.equal(result.rows[0].hitType, HIT_TYPES.PRECISE);
    assert.equal(result.rows[0].outcome, 'matched');
    assert.equal(result.rows[0].isDifference, false);
    assert.deepEqual(result.rows[0].lineage, {
      pairKey: 'inbound',
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      sourceIndex: 0,
      sourceLinkRowId: 7,
      sourceBusinessKey: 'GW-BIZ',
      sourceRowNumber: 12,
      sourceLegIndex: null,
      identifiers: [{ field: 'ReconciliationId', value: 'SERVICE-RID' }]
    });
  });

  test('链接行也兼容 store listLinkRows 的 {row, metadata} 包装结构', () => {
    const result = runPositionFundNatureCheck({
      bankRows: [bank('Inbound')],
      linkedRows: {
        [SOURCE_TYPES.GATEWAY_INBOUND]: [{
          id: 9,
          business_key: 'WRAPPED',
          row: inbound()
        }]
      }
    });
    assert.equal(result.rows[0].outcome, 'matched');
    assert.equal(result.rows[0].resultFundType, 'Inbound');
  });
});
