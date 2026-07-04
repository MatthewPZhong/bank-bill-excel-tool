const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
      selectedBigAccount: { merchantId: 'A001', currency: 'USD' }
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
      { merchantId: 'A001', currency: 'USD' },
      { merchantId: 'A001', currency: 'EUR' }
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
      selectedBigAccount: { merchantId: 'A001', currency: 'USD' }
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
      { merchantId: 'B002', currency: 'HKD' }
    ]), [
      { merchantId: 'A001', currency: 'USD' },
      { merchantId: 'A001', currency: 'EUR' },
      { merchantId: 'B002', currency: 'HKD' }
    ]);
  });
});
