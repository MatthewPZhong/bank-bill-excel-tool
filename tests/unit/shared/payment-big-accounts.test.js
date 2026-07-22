const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePaymentBigAccounts
} = require('../../../src/shared/payment-big-accounts');

test.describe('parsePaymentBigAccounts', () => {
  test('单账号与多账号按原序规范化', () => {
    assert.deepEqual(parsePaymentBigAccounts(' 202782001 '), {
      ok: true,
      reason: '',
      message: '',
      accounts: ['202782001'],
      normalized: '202782001'
    });
    assert.deepEqual(parsePaymentBigAccounts(' A 、 B '), {
      ok: true,
      reason: '',
      message: '',
      accounts: ['A', 'B'],
      normalized: 'A、B'
    });
  });

  test('严格拒绝空值、空段、错误分隔符和重复账号', () => {
    assert.equal(parsePaymentBigAccounts('').reason, 'empty');
    assert.equal(parsePaymentBigAccounts('、A').reason, 'empty-segment');
    assert.equal(parsePaymentBigAccounts('A、').reason, 'empty-segment');
    assert.equal(parsePaymentBigAccounts('A、、B').reason, 'empty-segment');
    assert.equal(parsePaymentBigAccounts('A,B').reason, 'invalid-separator');
    assert.equal(parsePaymentBigAccounts('A，B').reason, 'invalid-separator');
    assert.equal(parsePaymentBigAccounts('A、 A ').reason, 'duplicate');
  });

  test('大小写敏感且不改变前导零', () => {
    const parsed = parsePaymentBigAccounts('00123、ABC、abc');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.accounts, ['00123', 'ABC', 'abc']);
    assert.equal(parsed.normalized, '00123、ABC、abc');
  });
});
