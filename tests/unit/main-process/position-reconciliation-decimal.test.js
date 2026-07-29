'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalToCents,
  validateDirection,
  positionBankAmountWithExtraFee,
  sourceAmountToCents
} = require('../../../src/main-process/position-reconciliation/decimal');

test.describe('平盘资金性质金额口径', () => {
  test('十进制转分不经过浮点数，支持千分位、科学计数法和精确四舍五入', () => {
    assert.equal(canonicalToCents('1.005').cents, 101n);
    assert.equal(canonicalToCents('1,000.004').cents, 100000n);
    assert.equal(canonicalToCents('1e3').cents, 100000n);
    assert.equal(canonicalToCents('-0.005').cents, -1n);
    assert.equal(canonicalToCents('0.004999999999999999').cents, 0n);
  });

  test('方向校验要求主方向非0、相反方向为空或0', () => {
    assert.equal(validateDirection({
      'Credit Amount': '100',
      'Debit Amount': ''
    }, 'credit').ok, true);
    assert.equal(validateDirection({
      'Credit Amount': '100',
      'Debit Amount': '0e9'
    }, 'credit').ok, true);
    assert.equal(validateDirection({
      'Credit Amount': '',
      'Debit Amount': '0'
    }, 'credit').ok, false);
    assert.equal(validateDirection({
      'Credit Amount': '100',
      'Debit Amount': '0.01'
    }, 'credit').code, 'opposite-amount-not-zero');
    assert.equal(validateDirection({
      'Credit Amount': '0',
      'Debit Amount': '100'
    }, 'debit').ok, true, '出账使用 Debit 作为主金额且要求 Credit 为0');
  });

  test('Test 只校验 Debit，不检查 Credit', () => {
    const result = validateDirection({
      'Debit Amount': '100',
      'Credit Amount': '999'
    }, 'test-debit');
    assert.equal(result.ok, true);
    assert.equal(result.mainField, 'Debit Amount');
    assert.equal(result.oppositeField, null);
  });

  test('调拨金额按主方向绝对值加 signed Extra Fee，合计后不再取绝对值', () => {
    const negativeFee = positionBankAmountWithExtraFee({
      'Debit Amount': '-100',
      'Credit Amount': '0',
      'Extra Fee': '-5'
    }, 'debit');
    assert.equal(negativeFee.ok, true);
    assert.equal(negativeFee.total, '95');
    assert.equal(negativeFee.cents, 9500n);

    const positiveFee = positionBankAmountWithExtraFee({
      'Debit Amount': '1000',
      'Credit Amount': '',
      'Extra Fee': '27'
    }, 'debit');
    assert.equal(positiveFee.total, '1027');
    assert.equal(positiveFee.cents, 102700n);
  });

  test('空手续费按0；非法手续费和负合计 fail closed', () => {
    assert.equal(positionBankAmountWithExtraFee({
      'Credit Amount': '100',
      'Debit Amount': '0',
      'Extra Fee': ''
    }, 'credit').total, '100');
    assert.equal(positionBankAmountWithExtraFee({
      'Credit Amount': '100',
      'Debit Amount': '0',
      'Extra Fee': 'bad'
    }, 'credit').ok, false);
    assert.equal(positionBankAmountWithExtraFee({
      'Credit Amount': '5',
      'Debit Amount': '0',
      'Extra Fee': '-6'
    }, 'credit').code, 'negative-total');
  });

  test('调拨来源金额取绝对值并精确到分，空值和0不进入候选', () => {
    assert.equal(sourceAmountToCents('-95.004').cents, 9500n);
    assert.equal(sourceAmountToCents('-95.005').cents, 9501n);
    assert.equal(sourceAmountToCents('').ok, false);
    assert.equal(sourceAmountToCents('0').code, 'zero-source-amount');
  });
});
