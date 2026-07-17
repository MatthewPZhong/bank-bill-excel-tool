'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5RefundOrderBackfill,
  RESULT_ERROR,
  RESULT_NOTICE,
  HIT_TYPE_FUZZY,
  BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX
} = require('../../../../src/main-process/scenario-engines/r5-refund-order-backfill');

function bank(id, overrides = {}) {
  return {
    _rowId: id,
    FundType: 'Ach Return',
    MerchantId: 'M1',
    Currency: 'USD',
    'Credit Amount': '0',
    'Debit Amount': '109.99',
    Channel: 'CH',
    '地区': 'HK',
    BillDate: '2026-07-16',
    ReconciliationId: `RECON-${id}`,
    ChannelOrderNo: 'PAY-1',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    'Drawee Name': '',
    'Drawee CardNo': '',
    'Payee CardNo': '',
    ...overrides
  };
}

function refund(serial, overrides = {}) {
  return {
    '流水号': serial,
    '状态': 'SUBMITTED',
    '银行大账号': 'M1',
    '币种': 'USD',
    '退款金额': '100',
    '银行打款流水号': 'PAY-1',
    '附言': '',
    '付款人名称': '',
    '付款卡号': '',
    '虚拟卡号': '',
    valueDate: '2026-01-01',
    ...overrides
  };
}

function run(bankRows, refundRows, enabled = true) {
  return runRound5RefundOrderBackfill(bankRows, refundRows, [], {
    bankPaymentSerialFuzzyMatchEnabled: enabled
  });
}

describe('银行打款流水号模糊匹配', () => {
  test('缺省和显式关闭保持旧普通未命中结果一致', () => {
    const bankRows = [bank('b1')];
    const refundRows = [refund('R1')];
    const missing = runRound5RefundOrderBackfill(bankRows, refundRows, [], {});
    const disabled = run(bankRows, refundRows, false);
    assert.deepEqual(disabled, missing);
    assert.equal(disabled.backfillRows.length, 0);
    assert.equal(disabled.unmatchedRows[0]['结果类型'], RESULT_NOTICE);
  });

  test('ChannelOrderNo 命中且差额 9.99 时救回，详情和标黄字段完整', () => {
    const result = run([bank('b1')], [refund('R1')]);
    assert.equal(result.backfillRows.length, 1);
    assert.equal(result.unmatchedRows.length, 0);
    const row = result.backfillRows[0];
    assert.equal(row['命中类型'], HIT_TYPE_FUZZY);
    assert.equal(row['匹配命中详情'], `${BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX}9.99`);
    for (const field of [
      'ChannelOrderNo', 'Debit Amount', 'MerchantId', 'Currency',
      '银行打款流水号', '退款金额', '银行大账号', '币种'
    ]) {
      assert.ok(row._matchedColumns.includes(field), `${field} 应标黄`);
    }
    assert.equal(row._matchedColumns.includes('Credit Amount'), false, 'Credit Amount 不在现有退款模板中，不进入标黄投影');
  });

  test('CustomerRef 可命中；大小写敏感且账号、币种隔离', () => {
    const customerRefHit = run(
      [bank('b1', { ChannelOrderNo: '', CustomerRef: 'PAY-1' })],
      [refund('R1')]
    );
    assert.equal(customerRefHit.backfillRows.length, 1);
    assert.ok(customerRefHit.backfillRows[0]._matchedColumns.includes('CustomerRef'));

    const mismatches = [
      run([bank('b2', { ChannelOrderNo: 'pay-1' })], [refund('R2')]),
      run([bank('b3', { MerchantId: 'M2' })], [refund('R3')]),
      run([bank('b4', { Currency: 'EUR' })], [refund('R4')])
    ];
    for (const result of mismatches) {
      assert.equal(result.backfillRows.length, 0);
      assert.equal(result.unmatchedRows[0]['结果类型'], RESULT_NOTICE);
    }
  });

  test('金额差额等于 10 不命中', () => {
    const result = run([bank('b1', { 'Debit Amount': '110' })], [refund('R1')]);
    assert.equal(result.backfillRows.length, 0);
    assert.equal(result.unmatchedRows[0]['结果类型'], RESULT_NOTICE);
  });

  test('S4 旧命中优先，不改写为新规则详情', () => {
    const result = run(
      [bank('b1', { 'Debit Amount': '100', ChannelOrderNo: '' , BillDate: '2026-07-10' })],
      [refund('R1', { '银行打款流水号': 'OTHER', valueDate: '2026-07-01' })]
    );
    assert.equal(result.backfillRows.length, 1);
    assert.notEqual(result.backfillRows[0]['匹配命中详情'].startsWith(BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX), true);
  });

  test('一对多和多对一均转人工，不按顺序抢占', () => {
    const oneToMany = run(
      [bank('b1', { 'Debit Amount': '109' })],
      [refund('R1', { '退款金额': '100' }), refund('R2', { '退款金额': '101' })]
    );
    assert.equal(oneToMany.backfillRows.length, 0);
    assert.equal(oneToMany.unmatchedRows[0]['结果类型'], RESULT_ERROR);
    assert.match(oneToMany.unmatchedRows[0]['报错/提示信息'], /2 条退款订单/);

    const manyToOne = run(
      [bank('b2', { 'Debit Amount': '109' }), bank('b3', { 'Debit Amount': '108' })],
      [refund('R3')]
    );
    assert.equal(manyToOne.backfillRows.length, 0);
    assert.equal(manyToOne.unmatchedRows.length, 2);
    assert.ok(manyToOne.unmatchedRows.every((row) => row['结果类型'] === RESULT_ERROR));
    assert.ok(manyToOne.unmatchedRows.every((row) => /同时关联到同一退款订单/.test(row['报错/提示信息'])));
  });

  test('既有 S1 多候选人工结论不被新规则推翻', () => {
    const result = run(
      [bank('b1', { 'Debit Amount': '100' })],
      [refund('R1'), refund('R2')]
    );
    assert.equal(result.backfillRows.length, 0);
    assert.equal(result.unmatchedRows.length, 1);
    assert.equal(result.unmatchedRows[0]['结果类型'], RESULT_ERROR);
    assert.match(result.unmatchedRows[0]['报错/提示信息'], /关联到 2 条退款订单/);
  });

  test('相关银行或退款金额非法时转人工，不降级为零', () => {
    const badBank = run([bank('b1', { 'Debit Amount': 'bad' })], [refund('R1')]);
    assert.equal(badBank.backfillRows.length, 0);
    assert.equal(badBank.unmatchedRows[0]['结果类型'], RESULT_ERROR);
    assert.match(badBank.unmatchedRows[0]['报错/提示信息'], /金额非法/);

    const badRefund = run([bank('b2')], [refund('R2', { '退款金额': 'bad' })]);
    assert.equal(badRefund.backfillRows.length, 0);
    assert.equal(badRefund.unmatchedRows[0]['结果类型'], RESULT_ERROR);
    assert.match(badRefund.unmatchedRows[0]['报错/提示信息'], /金额非法/);
  });

  test('金额非法的未决关联会阻止另一银行行抢占同一退款单', () => {
    const result = run(
      [
        bank('bad', { 'Debit Amount': 'bad' }),
        bank('good', { 'Debit Amount': '109' })
      ],
      [refund('R1')]
    );
    assert.equal(result.backfillRows.length, 0);
    assert.equal(result.unmatchedRows.length, 2);
    assert.match(result.unmatchedRows.find((row) => row.ReconciliationId === 'RECON-bad')['报错/提示信息'], /金额非法/);
    assert.match(result.unmatchedRows.find((row) => row.ReconciliationId === 'RECON-good')['报错/提示信息'], /严格1:1/);
  });
});
