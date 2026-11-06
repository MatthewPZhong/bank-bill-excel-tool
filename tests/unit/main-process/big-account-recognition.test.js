const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchImportFilesToSavedOrder,
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

test.describe('matchImportFilesToSavedOrder', () => {
  // 已记住文件的 accounts 来自提取证据，币种为维护列表首币种；真实币种只在 assignments 里。
  const savedFile = (merchantId, currency = 'CNY') => ({
    accountCount: 1,
    accounts: [{ merchantId, currency }]
  });

  test('同一多币种大账号的两份账单记住了不同币种：导入顺序变化时不自动套用，标出两份文件', () => {
    const savedOrderConfig = {
      files: [savedFile('FTN7013'), savedFile('NRA2268'), savedFile('FTN7013')],
      assignments: [
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 0 },
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 1 },
        { merchantId: 'FTN7013', currency: 'USD', rowIndex: 2 }
      ]
    };
    const importAccountLists = [
      [{ merchantId: 'FTN7013' }],
      [{ merchantId: 'FTN7013' }],
      [{ merchantId: 'NRA2268' }]
    ];

    assert.deepEqual(matchImportFilesToSavedOrder(importAccountLists, savedOrderConfig), {
      failedImportIndexes: [],
      ambiguousImportIndexes: [0, 1],
      reorderedAssignments: []
    });
  });

  test('同账号多份账单记住的币种相同：不算歧义，按导入顺序重排', () => {
    const savedOrderConfig = {
      files: [savedFile('FTN7013'), savedFile('NRA2268'), savedFile('FTN7013')],
      assignments: [
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 0 },
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 1 },
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 2 }
      ]
    };

    assert.deepEqual(matchImportFilesToSavedOrder([
      [{ merchantId: 'FTN7013' }],
      [{ merchantId: 'FTN7013' }],
      [{ merchantId: 'NRA2268' }]
    ], savedOrderConfig), {
      failedImportIndexes: [],
      ambiguousImportIndexes: [],
      reorderedAssignments: [
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 0 },
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 1 },
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 2 }
      ]
    });
  });

  test('账号各不相同时仍按账号对位重排，保留各自记住的币种', () => {
    const savedOrderConfig = {
      files: [
        savedFile('FTN7013'),
        {
          accountCount: 2,
          accounts: [{ merchantId: 'NRA2268', currency: 'CNY' }, { merchantId: 'NRA6122', currency: 'USD' }]
        }
      ],
      assignments: [
        { merchantId: 'FTN7013', currency: 'USD', rowIndex: 0 },
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 1 },
        { merchantId: 'NRA6122', currency: 'USD', rowIndex: 2 }
      ]
    };

    assert.deepEqual(matchImportFilesToSavedOrder([
      [{ merchantId: 'NRA2268' }, { merchantId: 'NRA6122' }],
      [{ merchantId: 'FTN7013' }]
    ], savedOrderConfig), {
      failedImportIndexes: [],
      ambiguousImportIndexes: [],
      reorderedAssignments: [
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 0 },
        { merchantId: 'NRA6122', currency: 'USD', rowIndex: 1 },
        { merchantId: 'FTN7013', currency: 'USD', rowIndex: 2 }
      ]
    });
  });

  test('账户个数或账号对不上的文件记为失败，不产出自动分配', () => {
    const savedOrderConfig = {
      files: [savedFile('FTN7013'), savedFile('NRA2268')],
      assignments: [
        { merchantId: 'FTN7013', currency: 'CNY', rowIndex: 0 },
        { merchantId: 'NRA2268', currency: 'CNY', rowIndex: 1 }
      ]
    };

    assert.deepEqual(matchImportFilesToSavedOrder([
      [{ merchantId: 'NRA9999' }],
      [{ merchantId: 'NRA2268' }]
    ], savedOrderConfig), {
      failedImportIndexes: [0],
      ambiguousImportIndexes: [],
      reorderedAssignments: []
    });
  });

  test('只记住了文件、没有记住分配时不产出自动分配', () => {
    assert.deepEqual(matchImportFilesToSavedOrder(
      [[{ merchantId: 'FTN7013' }]],
      { files: [savedFile('FTN7013')], assignments: [] }
    ), {
      failedImportIndexes: [],
      ambiguousImportIndexes: [],
      reorderedAssignments: []
    });
  });
});
