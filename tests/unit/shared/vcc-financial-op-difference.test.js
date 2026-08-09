'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCanonicalDifference,
  isEffectiveDifferenceZero
} = require('../../../src/shared/vcc-financial-op-difference');

test.describe('VCC 财务OP生效差异共享判定', () => {
  test('0、0.00 与 -0.00 均为零', () => {
    for (const value of ['0', '0.00', '-0.00']) {
      assert.equal(isEffectiveDifferenceZero(value), true);
    }
  });

  test('任意正负非零规范值均不为零', () => {
    for (const value of ['1', '-1', '0.01', '-0.01', '135886024.59']) {
      assert.equal(isEffectiveDifferenceZero(value), false);
    }
  });

  test('非法或非字符串输入失败关闭', () => {
    for (const value of ['', ' 0', '0 ', '+0', '00', '1.', '1e3', 'NaN', null, 0]) {
      assert.throws(
        () => isEffectiveDifferenceZero(value),
        /生效差异必须是规范十进制字符串/
      );
    }
    assert.equal(assertCanonicalDifference('-123.40'), '-123.40');
  });
});
