'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLogicalAccounts,
  identifyAccountPair
} = require('../../../src/main-process/position-reconciliation/logical-accounts');
const { REASON_CODES } = require('../../../src/main-process/position-reconciliation/contracts');

function account(overrides = {}) {
  return {
    '账户状态': overrides['账户状态'] ?? '正常',
    '账户性质': overrides['账户性质'] ?? '自有',
    '币种': overrides['币种'] ?? 'USD',
    '银行账号': overrides['银行账号'] ?? 'OWN-001',
    '系统账号': overrides['系统账号'] ?? ''
  };
}

test.describe('清结算银行账户逻辑账户归并', () => {
  test('仅保留账户状态正常的数据，银行账号与系统账号作为同一逻辑账户别名', () => {
    const logical = buildLogicalAccounts([
      account({ '银行账号': 'OWN-001', '系统账号': 'SYS-001' }),
      account({ '银行账号': 'OWN-001', '系统账号': 'SYS-ALT' }),
      account({ '账户状态': '注销', '银行账号': 'CLOSED' })
    ]);
    assert.equal(logical.length, 1);
    assert.deepEqual(logical[0].aliases.sort(), ['OWN-001', 'SYS-001', 'SYS-ALT']);
    assert.equal(logical[0].currency, 'USD');
    assert.equal(logical[0].nature, '自有');
    assert.equal(logical[0].valid, true);
  });

  test('共享别名会传递归并；同一逻辑账户多币种或多性质标为冲突', () => {
    const logical = buildLogicalAccounts([
      account({ '银行账号': 'A', '系统账号': 'B', '币种': 'USD', '账户性质': '自有' }),
      account({ '银行账号': 'B', '系统账号': 'C', '币种': 'EUR', '账户性质': '客户' })
    ]);
    assert.equal(logical.length, 1);
    assert.equal(logical[0].valid, false);
    assert.deepEqual(logical[0].currencies.sort(), ['EUR', 'USD']);
    assert.deepEqual(logical[0].natures.sort(), ['客户', '自有']);
  });

  test('先唯一识别自有账户，再从未被自有账户命中的字段识别非自有账户', () => {
    const logical = buildLogicalAccounts([
      account({ '银行账号': 'OWN-001', '系统账号': 'SYS-OWN' }),
      account({
        '账户性质': '客户',
        '币种': 'EUR',
        '银行账号': 'OTHER-001',
        '系统账号': 'SYS-OTHER'
      })
    ]);
    const result = identifyAccountPair({
      'Payee CardNo': 'prefix-OWN-001-suffix',
      'Drawee CardNo': 'OTHER-001',
      MerchantId: ''
    }, logical);
    assert.equal(result.ok, true);
    assert.equal(result.own.account.nature, '自有');
    assert.equal(result.other.account.nature, '客户');
    assert.deepEqual(result.excludedFields, ['Payee CardNo']);
  });

  test('自有与非自有账号只出现在同一字段时，该字段整体排除，不能重复解释', () => {
    const logical = buildLogicalAccounts([
      account({ '银行账号': 'OWN-001' }),
      account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER-001' })
    ]);
    const result = identifyAccountPair({
      'Payee CardNo': 'OWN-001/OTHER-001',
      'Drawee CardNo': '',
      MerchantId: ''
    }, logical);
    assert.equal(result.ok, false);
    assert.equal(result.code, REASON_CODES.OTHER_ACCOUNT_NOT_FOUND);
  });

  test('多个自有账户、多个非自有账户及冲突逻辑账户均拒绝取第一条', () => {
    const multipleOwn = buildLogicalAccounts([
      account({ '银行账号': 'OWN-A' }),
      account({ '银行账号': 'OWN-B' }),
      account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER' })
    ]);
    assert.equal(identifyAccountPair({
      'Payee CardNo': 'OWN-A',
      'Drawee CardNo': 'OTHER',
      MerchantId: 'OWN-B'
    }, multipleOwn).code, REASON_CODES.OWN_ACCOUNT_MULTIPLE);

    const multipleOther = buildLogicalAccounts([
      account({ '银行账号': 'OWN' }),
      account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER-A' }),
      account({ '账户性质': '供应商', '币种': 'GBP', '银行账号': 'OTHER-B' })
    ]);
    assert.equal(identifyAccountPair({
      'Payee CardNo': 'OWN',
      'Drawee CardNo': 'OTHER-A',
      MerchantId: 'OTHER-B'
    }, multipleOther).code, REASON_CODES.OTHER_ACCOUNT_MULTIPLE);

    const conflict = buildLogicalAccounts([
      account({ '银行账号': 'OWN', '系统账号': 'SHARED', '币种': 'USD' }),
      account({ '银行账号': 'SHARED', '币种': 'EUR' }),
      account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER' })
    ]);
    assert.equal(identifyAccountPair({
      'Payee CardNo': 'OWN',
      'Drawee CardNo': 'OTHER'
    }, conflict).code, REASON_CODES.ACCOUNT_CONFLICT);
  });

  test('账号包含匹配 trim 后大小写敏感，不做片段大小写归一', () => {
    const logical = buildLogicalAccounts([
      account({ '银行账号': 'OWN-ABC' }),
      account({ '账户性质': '客户', '币种': 'EUR', '银行账号': 'OTHER-ABC' })
    ]);
    assert.equal(identifyAccountPair({
      'Payee CardNo': ' own-abc ',
      'Drawee CardNo': 'OTHER-ABC'
    }, logical).code, REASON_CODES.OWN_ACCOUNT_NOT_FOUND);
  });
});
