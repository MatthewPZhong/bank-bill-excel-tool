'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveLinkedRows
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
