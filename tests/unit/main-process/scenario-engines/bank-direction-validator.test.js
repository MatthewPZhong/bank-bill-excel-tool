'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBankDirection
} = require('../../../../src/main-process/scenario-engines/bank-direction-validator');

function row(credit, debit) {
  return {
    'Credit Amount': credit,
    'Debit Amount': debit
  };
}

describe('validateBankDirection — 严格借贷方向矩阵', () => {
  test('DEBIT：Debit 非零且 Credit 为空或合法零才通过；负主侧按绝对值语义通过', () => {
    assert.deepEqual(validateBankDirection(row('', 100), 'DEBIT'), { ok: true, code: 'ok' });
    assert.deepEqual(validateBankDirection(row('0.000', '-100.25'), 'DEBIT'), { ok: true, code: 'ok' });
  });

  test('CREDIT：Credit 非零且 Debit 为空或合法零才通过；科学计数法和负主侧合法', () => {
    assert.deepEqual(validateBankDirection(row('1e2', null), 'CREDIT'), { ok: true, code: 'ok' });
    assert.deepEqual(validateBankDirection(row('-0.01', '0.00'), 'CREDIT'), { ok: true, code: 'ok' });
  });

  test('主侧为空、非法、零分别返回稳定 code', () => {
    assert.deepEqual(validateBankDirection(row('', '  '), 'DEBIT'), {
      ok: false,
      code: 'expected-empty'
    });
    assert.deepEqual(validateBankDirection(row('', 'not-money'), 'DEBIT'), {
      ok: false,
      code: 'expected-invalid'
    });
    assert.deepEqual(validateBankDirection(row('', '-0.000e+9'), 'DEBIT'), {
      ok: false,
      code: 'expected-zero'
    });
  });

  test('另一侧非法或非零分别失败；双侧非零不会通过', () => {
    assert.deepEqual(validateBankDirection(row('invalid', 100), 'DEBIT'), {
      ok: false,
      code: 'opposite-invalid'
    });
    assert.deepEqual(validateBankDirection(row(-2, 100), 'DEBIT'), {
      ok: false,
      code: 'opposite-nonzero'
    });
    assert.deepEqual(validateBankDirection(row(100, 100), 'CREDIT'), {
      ok: false,
      code: 'opposite-nonzero'
    });
  });

  test('未知方向失败关闭，不尝试猜测', () => {
    assert.deepEqual(validateBankDirection(row('', 100), 'OUT'), {
      ok: false,
      code: 'unsupported-direction'
    });
    assert.deepEqual(validateBankDirection(row('', 100), undefined), {
      ok: false,
      code: 'unsupported-direction'
    });
  });

  test('无银行对象也按主侧为空失败，不抛异常', () => {
    assert.deepEqual(validateBankDirection(null, 'CREDIT'), {
      ok: false,
      code: 'expected-empty'
    });
  });
});
