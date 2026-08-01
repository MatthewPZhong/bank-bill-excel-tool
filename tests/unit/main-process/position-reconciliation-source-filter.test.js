'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifySourceRow
} = require('../../../src/main-process/position-reconciliation/readers');
const {
  SOURCE_FILTER_CODES,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');

function transferRow(overrides = {}) {
  return {
    调拨单号: 'FTA-1',
    调拨状态: '付款成功',
    渠道流水号: 'RID-FT-1',
    交易时间: '2026-05-07',
    付款金额: '100',
    付款币种: 'USD',
    收款金额: '95',
    收款币种: 'EUR',
    ...overrides
  };
}

function testPaymentRow(overrides = {}) {
  return {
    付款单号: 'TP-1',
    付款状态: '付款成功',
    渠道流水号: 'RID-TP-1',
    创建时间: '2026-05-07',
    源金额: '100',
    源币种: 'USD',
    目标金额: '95',
    目标币种: 'EUR',
    ...overrides
  };
}

test.describe('平盘来源过滤白名单', () => {
  test('非付款成功调拨缺金额或币种时进入稳定过滤去向', () => {
    const result = classifySourceRow(
      SOURCE_TYPES.FUND_TRANSFER,
      transferRow({ 调拨状态: '付款失败', 付款金额: '', 收款币种: '' })
    );
    assert.equal(result.disposition, 'filtered');
    assert.equal(
      result.filter.code,
      SOURCE_FILTER_CODES.FUND_TRANSFER_NON_SUCCESS_EVIDENCE_INCOMPLETE
    );
    assert.deepEqual(result.filter.fields, ['付款金额', '收款币种']);
    assert.equal(result.filter.reconId, 'RID-FT-1');
  });

  test('付款成功调拨缺同样证据仍是硬错误', () => {
    const result = classifySourceRow(
      SOURCE_TYPES.FUND_TRANSFER,
      transferRow({ 付款金额: '' })
    );
    assert.equal(result.disposition, 'invalid');
    assert.deepEqual(result.validation.errors, ['付款金额 不是合法金额：(空)']);
  });

  test('调拨业务键或日期无效不进入过滤白名单', () => {
    for (const row of [
      transferRow({ 调拨状态: '付款失败', 调拨单号: '', 付款金额: '' }),
      transferRow({ 调拨状态: '付款失败', 交易时间: 'bad-date', 付款金额: '' })
    ]) {
      assert.equal(
        classifySourceRow(SOURCE_TYPES.FUND_TRANSFER, row).disposition,
        'invalid'
      );
    }
  });

  test('测试付款仅在目标证据有效时过滤源证据缺失', () => {
    const filtered = classifySourceRow(
      SOURCE_TYPES.TEST_PAYMENT,
      testPaymentRow({ 源金额: '', 源币种: '' })
    );
    assert.equal(filtered.disposition, 'filtered');
    assert.equal(
      filtered.filter.code,
      SOURCE_FILTER_CODES.TEST_PAYMENT_SOURCE_EVIDENCE_INCOMPLETE
    );
    assert.deepEqual(filtered.filter.fields, ['源金额', '源币种']);

    const invalid = classifySourceRow(
      SOURCE_TYPES.TEST_PAYMENT,
      testPaymentRow({ 源金额: '', 目标金额: '' })
    );
    assert.equal(invalid.disposition, 'invalid');
    assert.ok(invalid.validation.errors.some((line) => line.includes('目标金额')));
  });

  test('正常行和非目标来源保持 accepted/invalid 既有语义', () => {
    assert.equal(
      classifySourceRow(SOURCE_TYPES.FUND_TRANSFER, transferRow()).disposition,
      'accepted'
    );
    assert.equal(
      classifySourceRow(SOURCE_TYPES.TEST_PAYMENT, testPaymentRow()).disposition,
      'accepted'
    );
    assert.equal(
      classifySourceRow(SOURCE_TYPES.GATEWAY_INBOUND, {
        bizId: 'IN-1',
        billDate: '2026-05-07',
        currency: ''
      }).disposition,
      'invalid'
    );
  });
});
