'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FinancialDecimalError,
  canonicalizeDecimal,
  absoluteDecimal,
  addCanonicalDecimals,
  subtractCanonicalDecimals,
  compareCanonicalDecimals
} = require('../../../src/main-process/financial-decimal');

describe('financial-decimal', () => {
  test('规范化普通数、千分位、科学计数和负零', () => {
    assert.equal(canonicalizeDecimal('001.2300'), '1.23');
    assert.equal(canonicalizeDecimal('1,234.500'), '1234.5');
    assert.equal(canonicalizeDecimal('1.2e3'), '1200');
    assert.equal(canonicalizeDecimal('-0.00'), '0');
  });

  test('加减和绝对值全程保持精确十进制', () => {
    assert.equal(addCanonicalDecimals('9999980', '20'), '10000000');
    assert.equal(subtractCanonicalDecimals('3300254.4', '254.4'), '3300000');
    assert.equal(subtractCanonicalDecimals('0.1', '0.03'), '0.07');
    assert.equal(absoluteDecimal('-9.9900'), '9.99');
  });

  test('比较不使用浮点并覆盖 9.99/10 边界', () => {
    assert.equal(compareCanonicalDecimals('9.99', '10'), -1);
    assert.equal(compareCanonicalDecimals('10.00', '10'), 0);
    assert.equal(compareCanonicalDecimals('10000000000000000000.01', '10000000000000000000'), 1);
  });

  test('非法金额抛结构化错误，不降级为零', () => {
    assert.throws(
      () => canonicalizeDecimal('1,2'),
      (error) => error instanceof FinancialDecimalError && error.code === 'invalid-financial-decimal'
    );
  });
});
