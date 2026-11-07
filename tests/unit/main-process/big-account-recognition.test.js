const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findSavedOrderFileRowMismatches,
  matchImportFilesToSavedOrder,
  matchMerchantIds,
  normalizeMaintainedBigAccounts,
  resolveRecognizedBigAccount,
  resolveSavedOrderFileRows
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
      reorderedAssignments: [],
      savedIndexByImport: [0, 2, 1]
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
      ],
      savedIndexByImport: [0, 2, 1]
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
      ],
      savedIndexByImport: [1, 0]
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
      reorderedAssignments: [],
      savedIndexByImport: [-1, 1]
    });
  });

  test('只记住了文件、没有记住分配时不产出自动分配', () => {
    assert.deepEqual(matchImportFilesToSavedOrder(
      [[{ merchantId: 'FTN7013' }]],
      { files: [savedFile('FTN7013')], assignments: [] }
    ), {
      failedImportIndexes: [],
      ambiguousImportIndexes: [],
      reorderedAssignments: [],
      savedIndexByImport: [0]
    });
  });
});

// v3.2.15（release 复审）：记住的顺序按位置逐块套用，块顺序、空段 / 未识别段位置都会改变每条分配落到哪一块。
test.describe('记住顺序逐块核对', () => {
  const assignment = (rowIndex, merchantId, currency) => ({ rowIndex, merchantId, currency });
  const savedFileWithRows = (rowAccounts) => {
    const accounts = rowAccounts.filter(Boolean).map((merchantId) => ({ merchantId, currency: 'CNY' }));
    return { accountCount: accounts.length, accounts, rowAccounts };
  };

  test('同一文件里账号块换了顺序不算对上：记为失败，不按记住的块顺序挂反账号 / 币种（B65）', () => {
    const savedOrderConfig = {
      files: [savedFileWithRows(['A001', 'B001'])],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD')]
    };
    assert.deepEqual(matchImportFilesToSavedOrder([[{ merchantId: 'B001' }, { merchantId: 'A001' }]], savedOrderConfig), {
      failedImportIndexes: [0],
      ambiguousImportIndexes: [],
      reorderedAssignments: [],
      savedIndexByImport: [-1]
    });
    assert.deepEqual(
      matchImportFilesToSavedOrder([[{ merchantId: 'A001' }, { merchantId: 'B001' }]], savedOrderConfig).reorderedAssignments,
      [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD')]
    );
  });

  test('含空段的记住顺序按逐块信息切分：同一文件原样再导入时取回该文件的全部分配', () => {
    const savedOrderConfig = {
      files: [savedFileWithRows(['', 'B001']), savedFileWithRows(['C001'])],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD'), assignment(2, 'C001', 'EUR')]
    };
    const result = matchImportFilesToSavedOrder([[{ merchantId: 'C001' }], [{ merchantId: 'B001' }]], savedOrderConfig);
    assert.deepEqual(result.savedIndexByImport, [1, 0]);
    assert.deepEqual(result.reorderedAssignments, [
      assignment(0, 'C001', 'EUR'),
      assignment(1, 'A001', 'CNY'),
      assignment(2, 'B001', 'USD')
    ]);
  });

  test('空段占用的分配按识别个数切分会错位并掩盖同账号多币种歧义，按逐块切分能识别', () => {
    const savedOrderConfig = {
      files: [savedFileWithRows(['', '7013']), savedFileWithRows(['7013'])],
      assignments: [assignment(0, '7013', 'CNY'), assignment(1, '7013', 'CNY'), assignment(2, '7013', 'USD')]
    };
    assert.deepEqual(
      matchImportFilesToSavedOrder([[{ merchantId: '7013' }], [{ merchantId: '7013' }]], savedOrderConfig).ambiguousImportIndexes,
      [0, 1]
    );
  });

  test('同一文件里同一账号多个块记住了不同币种：块顺序决定币种，记为歧义；币种相同不算', () => {
    const conflicting = {
      files: [savedFileWithRows(['7013', '7013'])],
      assignments: [assignment(0, '7013', 'CNY'), assignment(1, '7013', 'USD')]
    };
    const imported = [[{ merchantId: '7013' }, { merchantId: '7013' }]];
    assert.deepEqual(matchImportFilesToSavedOrder(imported, conflicting).ambiguousImportIndexes, [0]);
    assert.deepEqual(matchImportFilesToSavedOrder(imported, conflicting).reorderedAssignments, []);
    const sameCurrency = {
      files: [savedFileWithRows(['7013', '7013'])],
      assignments: [assignment(0, '7013', 'CNY'), assignment(1, '7013', 'CNY')]
    };
    assert.deepEqual(matchImportFilesToSavedOrder(imported, sameCurrency).ambiguousImportIndexes, []);
    // 旧数据无逐块信息时无法得知各块记住的币种，同一文件里账号重复即按歧义处理。
    const legacy = {
      files: [{ accountCount: 2, accounts: [{ merchantId: '7013' }, { merchantId: '7013' }] }],
      assignments: [assignment(0, 'X001', 'CNY'), assignment(1, '7013', 'CNY'), assignment(2, '7013', 'CNY')]
    };
    assert.deepEqual(matchImportFilesToSavedOrder(imported, legacy).ambiguousImportIndexes, [0]);
  });

  test('逐块信息：新数据直接取 rowAccounts；旧数据仅在当时每块都识别到账号时可还原', () => {
    assert.deepEqual(resolveSavedOrderFileRows({
      files: [savedFileWithRows(['', 'B001'])],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD')]
    }), [['', 'B001']]);
    const legacyFile = { accountCount: 1, accounts: [{ merchantId: 'B001', currency: 'CNY' }] };
    assert.deepEqual(resolveSavedOrderFileRows({ files: [legacyFile], assignments: [assignment(0, 'B001', 'USD')] }), [['B001']]);
    assert.equal(resolveSavedOrderFileRows({
      files: [legacyFile],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD')]
    }), null, '旧数据含未识别段：无法还原各文件占用的分配');
  });

  test('按位置套用前逐块比对：空段位置变化、旧数据无法还原都视为对不上', () => {
    const savedOrderConfig = {
      files: [savedFileWithRows(['', 'B001']), savedFileWithRows(['C001'])],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD'), assignment(2, 'C001', 'EUR')]
    };
    assert.deepEqual(findSavedOrderFileRowMismatches([['', 'B001'], ['C001']], savedOrderConfig, [0, 1]), []);
    assert.deepEqual(findSavedOrderFileRowMismatches([['C001'], ['', 'B001']], savedOrderConfig, [1, 0]), []);
    assert.deepEqual(findSavedOrderFileRowMismatches([['B001', ''], ['C001']], savedOrderConfig, [0, 1]), [0]);
    assert.deepEqual(findSavedOrderFileRowMismatches([['', 'B001'], ['', 'C001']], savedOrderConfig, [0, 1]), [1]);
    assert.deepEqual(findSavedOrderFileRowMismatches([['B001']], {
      files: [{ accountCount: 1, accounts: [{ merchantId: 'B001' }] }],
      assignments: [assignment(0, 'A001', 'CNY'), assignment(1, 'B001', 'USD')]
    }, [0]), [0]);
  });
});
