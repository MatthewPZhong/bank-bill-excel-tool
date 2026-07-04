const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchMerchantIds,
  normalizeMaintainedBigAccounts,
  resolveRecognizedBigAccount
} = require('../../../src/main-process/big-account-recognition');

test.describe('resolveRecognizedBigAccount', () => {
  test('维护表有 B002/USD，文件识别为空：返回失败，不允许 fallback 到 B002', () => {
    const result = resolveRecognizedBigAccount({
      extractedMerchantId: '',
      maintainedBigAccounts: [{ merchantId: 'B002', currencies: ['USD'] }],
      sourceFileName: 'bank.xlsx',
      templateName: 'DBS-HK'
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'BIG_ACCOUNT_NOT_RECOGNIZED');
    assert.match(result.message, /未识别到大账号/);
    assert.ok(result.detailLines.includes('识别值：(空)'));
  });

  test('维护表有 B002/USD，文件识别为 A001：返回未维护失败，不选择 B002', () => {
    const result = resolveRecognizedBigAccount({
      extractedMerchantId: 'A001',
      maintainedBigAccounts: [{ merchantId: 'B002', currencies: ['USD'] }],
      sourceFileName: 'bank.xlsx',
      templateName: 'DBS-HK'
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.match(result.message, /A001/);
    assert.ok(result.detailLines.includes('识别值：A001'));
  });

  test('维护表有 A001/USD，识别为 A001：成功选择 A001/USD', () => {
    const result = resolveRecognizedBigAccount({
      extractedMerchantId: ' A001 ',
      maintainedBigAccounts: [{ merchantId: 'A001', currencies: ['USD'] }]
    });

    assert.deepEqual(result, {
      status: 'ok',
      selectedBigAccount: { merchantId: 'A001', currency: 'USD', accountNature: 'client' }
    });
  });

  test('维护表有 A001/USD、A001/EUR，识别账号为 A001 但币种未知：返回 needs-selection', () => {
    const result = resolveRecognizedBigAccount({
      extractedMerchantId: 'A001',
      maintainedBigAccounts: [{ merchantId: 'A001', currencies: ['USD', 'EUR'] }]
    });

    assert.equal(result.status, 'needs-selection');
    assert.match(result.message, /币种无法唯一确定/);
    assert.deepEqual(result.candidates, [
      { merchantId: 'A001', currency: 'USD', accountNature: 'client' },
      { merchantId: 'A001', currency: 'EUR', accountNature: 'client' }
    ]);
  });

  test('维护表有 A001/USD、A001/EUR，识别账号 A001 且币种 USD：成功选择 USD', () => {
    const result = resolveRecognizedBigAccount({
      extractedMerchantId: 'A001',
      extractedCurrency: 'USD',
      maintainedBigAccounts: [{ merchantId: 'A001', currencies: ['USD', 'EUR'] }]
    });

    assert.deepEqual(result, {
      status: 'ok',
      selectedBigAccount: { merchantId: 'A001', currency: 'USD', accountNature: 'client' }
    });
  });

  test('用户显式选择 A001/EUR 后重新生成：纯函数不会拦截已传入的选择值', () => {
    const selectedBigAccount = { merchantId: 'A001', currency: 'EUR' };

    assert.deepEqual(selectedBigAccount, { merchantId: 'A001', currency: 'EUR' });
  });
});

test.describe('normalizeMaintainedBigAccounts', () => {
  test('兼容 grouped 和 expanded 两种维护表形态', () => {
    assert.deepEqual(normalizeMaintainedBigAccounts([
      { merchantId: ' A001 ', currencies: [' USD ', '', 'EUR'] },
      { merchantId: 'B002', currency: 'HKD', accountNature: 'own' },
      { merchantId: 'C003', currencies: [] }
    ]), [
      { merchantId: 'A001', currency: 'USD', accountNature: 'client' },
      { merchantId: 'A001', currency: 'EUR', accountNature: 'client' },
      { merchantId: 'B002', currency: 'HKD', accountNature: 'own' },
      { merchantId: 'C003', currency: '', accountNature: 'client' }
    ]);
  });
});

test.describe('matchMerchantIds', () => {
  test('直接识别放行路径禁用子串 fuzzy，避免 NET001 误吃 NET0011', () => {
    assert.equal(matchMerchantIds('NET001', 'NET001', { allowSubstring: false }), 'exact');
    assert.equal(matchMerchantIds('NET-001', 'NET001', { allowSubstring: false }), 'fuzzy');
    assert.equal(matchMerchantIds('NET0011', 'NET001', { allowSubstring: false }), 'none');
  });

  test('默认 fuzzy 仍保留子串匹配，供既有顺序提示路径使用', () => {
    assert.equal(matchMerchantIds('NET0011', 'NET001'), 'fuzzy');
  });
});
