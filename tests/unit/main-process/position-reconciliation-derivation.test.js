'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveLinkedRows,
  deriveLinkedRowsForRecord
} = require('../../../src/main-process/position-reconciliation/derivation');
const {
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');

function record(row, businessKey = 'KEY-1') {
  return {
    row,
    businessKey,
    sourceRowNumber: 2
  };
}

test('调拨同币种双腿保留为内部证据但不出现在可见链接表', () => {
  const rows = deriveLinkedRows(SOURCE_TYPES.FUND_TRANSFER, [record({
    调拨单号: 'FT-1',
    调拨状态: '付款成功',
    渠道流水号: 'RID-1',
    交易时间: '2026-07-20',
    '付款账户（卡号）': 'PAY-1',
    '收款账户（卡号）': 'REC-1',
    付款金额: '100',
    付款币种: 'USD',
    收款金额: '100',
    收款币种: 'USD'
  })], []);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.visible === false));
  assert.deepEqual(rows.map((row) => row.row.FundType), ['FundTransfer-out', 'FundTransfer-in']);
});

test('测试付款和网关入账只把FX行标为可见，基础类型证据仍可供引擎使用', () => {
  const testRows = deriveLinkedRows(SOURCE_TYPES.TEST_PAYMENT, [
    record({
      付款单号: 'TEST-1',
      付款状态: '付款成功',
      渠道流水号: 'TEST-RID',
      源金额: '100',
      源币种: 'USD',
      目标金额: '100',
      目标币种: 'USD',
      创建时间: '2026-07-20'
    })
  ]);
  const inboundRows = deriveLinkedRows(SOURCE_TYPES.GATEWAY_INBOUND, [
    record({
      bizId: 'IN-1',
      billDate: '2026-07-20',
      tradeType: 'Inbound-VA',
      reconId: 'IN-RID',
      currency: 'USD',
      originOutboundCurrency: ''
    })
  ]);
  assert.equal(testRows.length, 1);
  assert.equal(testRows[0].visible, false);
  assert.equal(inboundRows.length, 1);
  assert.equal(inboundRows[0].visible, false);
});

test('测试付款源金额为0时不生成链接候选', () => {
  const rows = deriveLinkedRows(SOURCE_TYPES.TEST_PAYMENT, [
    record({
      付款单号: 'TEST-ZERO',
      付款状态: '付款成功',
      渠道流水号: 'TEST-ZERO-RID',
      源金额: '0',
      源币种: 'USD',
      目标金额: '0',
      目标币种: 'EUR',
      创建时间: '2026-07-20'
    })
  ]);
  assert.deepEqual(rows, []);
});

test('单记录派生 API 与批量 API 对五类来源保持完全等价', () => {
  const cases = [
    {
      sourceType: SOURCE_TYPES.FUND_TRANSFER,
      row: {
        调拨单号: 'FT-PARITY',
        调拨状态: '付款成功',
        渠道流水号: 'FT-PARITY-RID',
        交易时间: '2026-07-20',
        '付款账户（卡号）': 'PAY-MID',
        '收款账户（卡号）': 'REC-MID',
        付款金额: '100',
        付款币种: 'USD',
        收款金额: '95',
        收款币种: 'EUR'
      },
      mappings: [
        { midAccountId: 'PAY-MID', clearingAccountId: 'PAY-CLEARING' },
        { midAccountId: 'REC-MID', clearingAccountId: 'REC-CLEARING' }
      ],
      expectedCount: 2
    },
    {
      sourceType: SOURCE_TYPES.TEST_PAYMENT,
      row: {
        付款单号: 'TEST-PARITY',
        付款状态: '付款成功',
        渠道流水号: 'TEST-PARITY-RID',
        源金额: '100',
        源币种: 'USD',
        目标金额: '95',
        目标币种: 'EUR',
        创建时间: '2026-07-20'
      },
      expectedCount: 1
    },
    {
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      row: {
        bizId: 'IN-PARITY',
        billDate: '2026-07-20',
        tradeType: 'Inbound-VA',
        reconId: 'IN-PARITY-RID',
        merchantId: 'M001',
        currency: 'USD',
        originOutboundCurrency: 'EUR'
      },
      expectedCount: 1
    },
    {
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      row: {
        业务单号: 'OUT-PARITY',
        账单日期: '2026-07-20',
        主对账id: 'OUT-PARITY-RID',
        账户号: 'M001',
        币种: 'USD'
      },
      expectedCount: 1
    },
    {
      sourceType: SOURCE_TYPES.BANK_ACCOUNT,
      row: {
        账户状态: '正常',
        账户性质: '自有',
        币种: 'USD',
        银行账号: 'OWN-PARITY'
      },
      expectedCount: 1
    },
    {
      sourceType: SOURCE_TYPES.TEST_PAYMENT,
      row: {
        付款单号: 'TEST-ZERO-PARITY',
        付款状态: '付款成功',
        渠道流水号: 'TEST-ZERO-PARITY-RID',
        源金额: '0',
        源币种: 'USD',
        目标金额: '0',
        目标币种: 'EUR',
        创建时间: '2026-07-20'
      },
      expectedCount: 0
    }
  ];

  for (const [index, item] of cases.entries()) {
    const sourceRecord = {
      ...record(item.row, `KEY-${index}`),
      sourceRecordKey: `ROW-HASH-${index}`,
      sourceRowId: index + 10
    };
    const single = deriveLinkedRowsForRecord(
      item.sourceType,
      sourceRecord,
      item.mappings || []
    );
    const batch = deriveLinkedRows(
      item.sourceType,
      [sourceRecord],
      item.mappings || []
    );
    assert.equal(single.length, item.expectedCount);
    assert.deepEqual(
      batch.map(({ ordinal, ...row }) => row),
      single
    );
    assert.deepEqual(
      batch.map((row) => row.ordinal),
      Array.from({ length: item.expectedCount }, (_, ordinal) => ordinal)
    );
  }
});
