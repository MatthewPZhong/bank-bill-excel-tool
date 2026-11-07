'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const {
  buildExpectedHeaderCandidates,
  buildMappedRows,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = {
  ...require('../../../src/backend/file-service'),
  ...require('../../../src/main-process/archive-center/source-snapshot')
};
const {
  assertFilePlanFresh,
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');

const ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_PATH = path.join(ROOT, 'src', 'main.js');
const RENDERER_DIALOGS_PATH = path.join(ROOT, 'src', 'renderer', 'dialogs', 'configuration.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
const mainAst = acorn.parse(mainSource, {
  ecmaVersion: 'latest',
  sourceType: 'script'
});

function functionSource(name) {
  const node = mainAst.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到函数：${name}`);
  return mainSource.slice(node.start, node.end);
}

function loadFunction(name, names = [], values = []) {
  return Function(...names, `return (${functionSource(name)});`)(...values);
}

test('fixed 提取按服务端 rowsWithEmptyBlocks 选择，保留空 block 行', () => {
  const selectRows = loadFunction('selectPendingBigAccountRows');
  const context = {
    rows: [{ index: 0, fileName: 'A.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 0, fileName: 'A.xlsx' },
      { index: 1, fileName: 'A.xlsx', empty: true }
    ]
  };
  assert.deepEqual(
    selectRows(context, 'fixed', [0, 1]),
    context.rowsWithEmptyBlocks
  );
  assert.deepEqual(selectRows(context, 'unfixed', [0, 1]), context.rows);
});

test('fixed 前块空、后块有交易时按 per-file block ordinal 冻结 M001/M002', () => {
  const normalize = (value) => String(value == null ? '' : value).trim();
  const match = (cell, merchantId) => normalize(cell) === normalize(merchantId) ? 'exact' : 'none';
  const identifyBlocks = loadFunction(
    'identifyAccountBlocks',
    ['normalizeCell'],
    [normalize]
  );
  const buildSelectionRows = loadFunction(
    'buildBigAccountSelectionRows',
    ['identifyAccountBlocks', 'path'],
    [identifyBlocks, path]
  );
  const findMatch = loadFunction(
    'findBigAccountMatchInRows',
    ['normalizeCell', 'matchMerchantIds'],
    [normalize, match]
  );
  const identifyFromBasis = loadFunction(
    'identifyAccountsFromRecognitionBasis',
    ['findBigAccountMatchInRows'],
    [findMatch]
  );
  const detailRows = [
    ['Credit Amount', 'Debit Amount'],
    ['', '100']
  ];
  detailRows.rowMetas = [{ sourceRowNumber: 11 }];
  detailRows.headerBreaks = [10];
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', {
    enumerable: false,
    value: Object.freeze({
      version: 1,
      headerWindows: Object.freeze([
        Object.freeze({ headerRowNumber: 2, candidateRows: Object.freeze([Object.freeze(['M001'])]) }),
        Object.freeze({ headerRowNumber: 10, candidateRows: Object.freeze([Object.freeze(['M002'])]) })
      ]),
      bridgeClearingIdsByBlock: Object.freeze(['', ''])
    })
  });
  const filePath = path.resolve('/private/fixed-empty-first.xlsx');
  const fileEntries = [{ filePath, detailRows }];
  const fixedRows = buildSelectionRows(fileEntries, { includeEmptyBlocks: true });
  const unfixedRows = buildSelectionRows(fileEntries);
  assert.deepEqual(fixedRows.map((row) => row.fileBlockOrdinal), [0, 1]);
  assert.deepEqual(fixedRows.map((row) => row.sourceRowNumber), [11, 11]);
  assert.deepEqual(unfixedRows.map((row) => row.fileBlockOrdinal), [1]);

  const buildEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [
      path,
      normalize,
      (items) => items.flatMap((item) => item.currencies.map((currency) => ({
        merchantId: item.merchantId,
        currency
      }))),
      identifyFromBasis,
      () => null,
      match
    ]
  );
  const pendingContext = {
    statementSelectionSessionId: 'fixed-empty-session',
    bigAccounts: [
      { merchantId: 'M001', currencies: ['USD'] },
      { merchantId: 'M002', currencies: ['EUR'] }
    ],
    fileEntries,
    rows: unfixedRows,
    rowsWithEmptyBlocks: fixedRows
  };
  pendingContext.bigAccountOrderEvidence = buildEvidence(pendingContext);
  assert.equal(Object.isFrozen(pendingContext.bigAccountOrderEvidence), true);
  assert.deepEqual(
    pendingContext.bigAccountOrderEvidence.files[0].rows.map((row) => row.accountKey),
    ['M001\u0000USD', 'M002\u0000EUR']
  );

  const rememberAndRequire = Function(
    'randomUUID',
    'normalizeCell',
    'normalizeInputFilePaths',
    'cloneRowsWithMetadata',
    'path',
    `let lastPendingBigAccountSelection = null;
     const remember = (${functionSource('rememberPendingBigAccountSelection')});
     const requirePending = (${functionSource('requirePendingBigAccountSelection')});
     return (context) => requirePending(remember(context));`
  )(
    () => 'fixed-empty-context-id',
    normalize,
    (values) => Array.isArray(values) ? values.slice() : [],
    (rows) => rows,
    path
  );
  const storedPendingContext = rememberAndRequire(pendingContext);
  assert.deepEqual(
    storedPendingContext.rowsWithEmptyBlocks.map((row) => row.fileBlockOrdinal),
    [0, 1]
  );

  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [loadFunction('selectPendingBigAccountRows'), path, normalize]
  );
  assert.deepEqual(
    extract(storedPendingContext, 'fixed', [0, 1]).accounts.map((account) => account.merchantId),
    ['M001', 'M002']
  );
  const remembered = loadFunction('buildBigAccountOrderData')(storedPendingContext, [
    { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
    { rowIndex: 1, merchantId: 'M002', currency: 'EUR' }
  ]);
  assert.deepEqual(remembered.files[0], {
    fileIndex: 0,
    accountCount: 2,
    accounts: [
      { merchantId: 'M001', currency: 'USD' },
      { merchantId: 'M002', currency: 'EUR' }
    ]
  });
  const nextAutoMatch = identifyFromBasis({
    basis: detailRows.bigAccountRecognitionBasis,
    allMerchantIds: ['M001', 'M002']
  });
  assert.deepEqual(
    nextAutoMatch.accounts.map((account) => account.merchantId),
    remembered.files[0].accounts.map((account) => account.merchantId)
  );
});

test('self-input 单文件多 block 按 ordinal 独立桥接，未识别 block fail closed', () => {
  const normalize = (value) => String(value == null ? '' : value).trim();
  const match = (cell, merchantId) => normalize(cell) === normalize(merchantId) ? 'exact' : 'none';
  const findHeaders = loadFunction(
    'findHeaderRowNumbersInRawRows',
    ['normalizeCell', 'buildExpectedHeaderCandidates'],
    [normalize, buildExpectedHeaderCandidates]
  );
  const buildBasis = loadFunction(
    'buildBigAccountRecognitionBasis',
    ['findHeaderRowNumbersInRawRows', 'normalizeCell', 'matchMerchantIds'],
    [findHeaders, normalize, match]
  );
  const rawRows = [
    ['银行账号', 'BANK1'],
    ['Date', 'Amount'],
    ['2026-08-01', '1'],
    ['银行账号', 'BANK2'],
    ['Date', 'Amount'],
    ['2026-08-02', '2']
  ];
  const provisionalBasis = buildBasis({
    rawRows,
    expectedSourceHeaders: ['Date', 'Amount'],
    accountMappingByBankId: {
      BANK1: { clearingAccountId: 'M001' },
      BANK2: { clearingAccountId: 'M002' }
    }
  });
  assert.deepEqual(provisionalBasis.bridgeCandidatesByBlock, [
    [{ sourceRow: 1, clearingAccountId: 'M001' }],
    [{ sourceRow: 4, clearingAccountId: 'M002' }]
  ]);
  assert.equal(Object.hasOwn(provisionalBasis, 'rawRows'), false);

  const detailRows = [
    ['Credit Amount', 'Debit Amount'],
    ['1', ''],
    ['', '2']
  ];
  detailRows.rowMetas = [{ sourceRowNumber: 3 }, { sourceRowNumber: 6 }];
  detailRows.headerBreaks = [5];
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const basis = finalizeBasis(provisionalBasis, detailRows);
  assert.deepEqual(basis.bridgeClearingIdsByBlock, ['M001', 'M002']);
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', {
    enumerable: false,
    value: basis
  });
  const buildSelectionRows = loadFunction(
    'buildBigAccountSelectionRows',
    ['identifyAccountBlocks', 'path'],
    [identifyBlocks, path]
  );
  const filePath = path.resolve('/private/self-input-two-blocks.xlsx');
  const selectionRows = buildSelectionRows([{ filePath, detailRows }], { includeEmptyBlocks: true });
  assert.deepEqual(selectionRows.map((row) => row.fileBlockOrdinal), [0, 1]);

  const findBridge = loadFunction(
    'findSelfInputBigAccountBridge',
    ['normalizeCell', 'matchMerchantIds'],
    [normalize, match]
  );
  const identifyBridges = loadFunction(
    'identifySelfInputBigAccountBridges',
    ['findSelfInputBigAccountBridge'],
    [findBridge]
  );
  const expandedOptions = [
    { merchantId: 'M001', currency: 'USD' },
    { merchantId: 'M002', currency: 'EUR' }
  ];
  const buildEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [path, normalize, () => expandedOptions, () => ({ matches: [] }), findBridge, match]
  );
  const pendingContext = {
    statementSelectionSessionId: 'self-input-two-blocks',
    bigAccounts: [
      { merchantId: 'M001', currencies: ['USD'] },
      { merchantId: 'M002', currencies: ['EUR'] }
    ],
    fileEntries: [{
      filePath,
      detailRows,
      selfInputMerchant: true,
      skipDirectMerchantLookup: true
    }],
    rows: selectionRows,
    rowsWithEmptyBlocks: selectionRows
  };
  pendingContext.bigAccountOrderEvidence = buildEvidence(pendingContext);
  assert.deepEqual(
    pendingContext.bigAccountOrderEvidence.files[0].rows.map((row) => row.accountKey),
    ['M001\u0000USD', 'M002\u0000EUR']
  );
  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [loadFunction('selectPendingBigAccountRows'), path, normalize]
  );
  assert.deepEqual(
    extract(pendingContext, 'fixed', [0, 1]).accounts.map((account) => account.merchantId),
    ['M001', 'M002']
  );
  assert.deepEqual(
    extract(pendingContext, 'unfixed', [0, 1]).accounts.map((account) => account.merchantId),
    ['M001', 'M002']
  );
  const buildOrderData = loadFunction('buildBigAccountOrderData');
  const rememberedOrder = buildOrderData(pendingContext, [
    { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
    { rowIndex: 1, merchantId: 'M002', currency: 'EUR' }
  ]);
  let savedOrder = null;
  const persist = loadFunction(
    'persistBigAccountOrderAfterGeneration',
    ['buildBigAccountOrderData', 'writeBigAccountOrder', 'ensureStorageRoot'],
    [buildOrderData, (_root, _templateId, data) => { savedOrder = data; }, () => '/tmp']
  );
  assert.deepEqual(persist({
    pendingContext: { ...pendingContext, templateId: 1 },
    normalizedAssignments: rememberedOrder.assignments,
    rememberOrder: true,
    result: { status: 'success' }
  }), { status: 'success' });
  assert.deepEqual(savedOrder.files[0].accounts, [
    { merchantId: 'M001', currency: 'USD' },
    { merchantId: 'M002', currency: 'EUR' }
  ]);
  assert.deepEqual(
    identifyBridges(basis, expandedOptions).map((account) => account.merchantId),
    ['M001', 'M002']
  );

  const previousBlockEmptyRawRows = [
    ['银行账号', 'BANK1'],
    ['Date', 'Amount'],
    ['上一块无交易'],
    ['银行账号', 'BANK2'],
    ['Date', 'Amount'],
    ['2026-08-02', '2']
  ];
  const previousBlockEmptyMappedRows = [
    ['Credit Amount', 'Debit Amount'],
    ['', '2']
  ];
  previousBlockEmptyMappedRows.rowMetas = [{ sourceRowNumber: 6 }];
  previousBlockEmptyMappedRows.headerBreaks = [5];
  const previousBlockEmptyBasis = finalizeBasis(buildBasis({
    rawRows: previousBlockEmptyRawRows,
    expectedSourceHeaders: ['Date', 'Amount'],
    accountMappingByBankId: {
      BANK1: { clearingAccountId: 'M001' },
      BANK2: { clearingAccountId: 'M002' }
    }
  }), previousBlockEmptyMappedRows);
  assert.deepEqual(previousBlockEmptyBasis.bridgeClearingIdsByBlock, ['M001', 'M002']);

  const multiCurrencyRows = detailRows.map((row) => row.slice());
  multiCurrencyRows.rowMetas = detailRows.rowMetas.map((meta) => ({ ...meta }));
  multiCurrencyRows.headerBreaks = detailRows.headerBreaks.slice();
  Object.defineProperty(multiCurrencyRows, 'bigAccountRecognitionBasis', {
    enumerable: false,
    value: basis
  });
  const multiCurrencyContext = {
    ...pendingContext,
    bigAccounts: [
      { merchantId: 'M001', currencies: ['USD', 'CNY'] },
      { merchantId: 'M002', currencies: ['EUR'] }
    ],
    fileEntries: [{
      filePath,
      detailRows: multiCurrencyRows,
      selfInputMerchant: true,
      skipDirectMerchantLookup: true
    }]
  };
  const multiCurrencyOptions = [
    { merchantId: 'M001', currency: 'USD' },
    { merchantId: 'M001', currency: 'CNY' },
    { merchantId: 'M002', currency: 'EUR' }
  ];
  const buildMultiCurrencyEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [path, normalize, () => multiCurrencyOptions, () => ({ matches: [] }), findBridge, match]
  );
  multiCurrencyContext.bigAccountOrderEvidence = buildMultiCurrencyEvidence(multiCurrencyContext);
  assert.deepEqual(extract(multiCurrencyContext, 'fixed', [0]), {
    status: 'ok',
    accounts: [{
      merchantId: 'M001',
      currency: 'USD',
      matchType: 'exact',
      fileName: 'self-input-two-blocks.xlsx'
    }],
    ambiguousCurrencyFiles: ['self-input-two-blocks.xlsx']
  });

  const incompleteBasis = finalizeBasis(
    buildBasis({
      rawRows,
      expectedSourceHeaders: ['Date', 'Amount'],
      accountMappingByBankId: { BANK1: { clearingAccountId: 'M001' } }
    }),
    detailRows
  );
  assert.deepEqual(incompleteBasis.bridgeClearingIdsByBlock, ['M001', '']);
  assert.deepEqual(identifyBridges(incompleteBasis, expandedOptions), [
    { merchantId: 'M001', matchType: 'exact', viaBridge: true },
    null
  ]);
  const incompleteRows = detailRows.map((row) => row.slice());
  Object.defineProperty(incompleteRows, 'bigAccountRecognitionBasis', {
    enumerable: false,
    value: incompleteBasis
  });
  const incompleteContext = {
    ...pendingContext,
    fileEntries: [{
      filePath,
      detailRows: incompleteRows,
      selfInputMerchant: true,
      skipDirectMerchantLookup: true
    }]
  };
  incompleteContext.bigAccountOrderEvidence = buildEvidence(incompleteContext);
  assert.deepEqual(
    extract(incompleteContext, 'fixed', [0, 1]),
    { status: 'error', failedRows: [{ index: 1, fileName: 'self-input-two-blocks.xlsx' }] }
  );
});

test('self-input 后块不得把前块交易行中的 bankId 误归为 bridge', () => {
  const normalize = (value) => String(value == null ? '' : value).trim();
  const match = (cell, merchantId) => {
    const left = normalize(cell);
    const right = normalize(merchantId);
    if (left === right) return 'exact';
    return left.includes(right) ? 'fuzzy' : 'none';
  };
  const findHeaders = loadFunction(
    'findHeaderRowNumbersInRawRows',
    ['normalizeCell', 'buildExpectedHeaderCandidates'],
    [normalize, buildExpectedHeaderCandidates]
  );
  const buildBasis = loadFunction(
    'buildBigAccountRecognitionBasis',
    ['findHeaderRowNumbersInRawRows', 'normalizeCell', 'matchMerchantIds'],
    [findHeaders, normalize, match]
  );
  const rawRows = [
    ['银行账号', 'BANK1'],
    ['Date', 'Amount'],
    ['2026-08-01', '1', 'Memo=BANK1'],
    ['账户名称', '第二块无账号'],
    ['Date', 'Amount'],
    ['2026-08-02', '2']
  ];
  const provisionalBasis = buildBasis({
    rawRows,
    expectedSourceHeaders: ['Date', 'Amount'],
    accountMappingByBankId: {
      BANK1: { clearingAccountId: 'M001' }
    }
  });
  assert.deepEqual(provisionalBasis.bridgeCandidatesByBlock, [
    [{ sourceRow: 1, clearingAccountId: 'M001' }],
    [{ sourceRow: 3, clearingAccountId: 'M001' }]
  ]);
  const detailRows = [
    ['Credit Amount', 'Debit Amount'],
    ['1', ''],
    ['', '2']
  ];
  detailRows.rowMetas = [{ sourceRowNumber: 3 }, { sourceRowNumber: 6 }];
  detailRows.headerBreaks = [5];
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const basis = finalizeBasis(provisionalBasis, detailRows);
  assert.deepEqual(basis.bridgeClearingIdsByBlock, ['M001', '']);

  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', {
    enumerable: false,
    value: basis
  });
  const filePath = path.resolve('/private/self-input-missing-second-bridge.xlsx');
  const buildSelectionRows = loadFunction(
    'buildBigAccountSelectionRows',
    ['identifyAccountBlocks', 'path'],
    [identifyBlocks, path]
  );
  const selectionRows = buildSelectionRows([{ filePath, detailRows }], { includeEmptyBlocks: true });
  const findBridge = loadFunction(
    'findSelfInputBigAccountBridge',
    ['normalizeCell', 'matchMerchantIds'],
    [normalize, match]
  );
  const buildEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [
      path,
      normalize,
      () => [{ merchantId: 'M001', currency: 'USD' }],
      () => ({ matches: [] }),
      findBridge,
      match
    ]
  );
  const pendingContext = {
    statementSelectionSessionId: 'self-input-missing-second-bridge',
    bigAccounts: [{ merchantId: 'M001', currencies: ['USD'] }],
    fileEntries: [{
      filePath,
      detailRows,
      selfInputMerchant: true,
      skipDirectMerchantLookup: true
    }],
    rows: selectionRows,
    rowsWithEmptyBlocks: selectionRows
  };
  pendingContext.bigAccountOrderEvidence = buildEvidence(pendingContext);
  assert.deepEqual(
    pendingContext.bigAccountOrderEvidence.files[0].rows.map((row) => row.accountKey),
    ['M001\u0000USD', '']
  );
  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [loadFunction('selectPendingBigAccountRows'), path, normalize]
  );
  assert.deepEqual(extract(pendingContext, 'fixed', [0, 1]), {
    status: 'error',
    failedRows: [{ index: 1, fileName: 'self-input-missing-second-bridge.xlsx' }]
  });
});

test('冻结顺序 evidence 按 session + file block ordinal 提取，失败行和币种歧义可观测', () => {
  const selectRows = loadFunction('selectPendingBigAccountRows');
  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [selectRows, path, (value) => String(value == null ? '' : value).trim()]
  );
  const filePath = path.resolve('/private/A.xlsx');
  const context = {
    statementSelectionSessionId: 'session-1',
    rows: [
      { index: 0, filePath, fileName: 'A.xlsx', fileBlockOrdinal: 0, sourceRowNumber: 8 },
      { index: 1, filePath, fileName: 'A.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 20 }
    ],
    rowsWithEmptyBlocks: [
      { index: 0, filePath, fileName: 'A.xlsx', fileBlockOrdinal: 0, sourceRowNumber: 8 },
      { index: 1, filePath, fileName: 'A.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 20 }
    ],
    bigAccountOrderEvidence: {
      version: 1,
      sessionId: 'session-1',
      files: [{
        fileOrdinal: 0,
        resolvedPath: filePath,
        fileName: 'A.xlsx',
        rows: [
          {
            blockOrdinal: 0,
            sourceRow: 8,
            merchantId: 'M001',
            currency: 'USD',
            matchKind: 'exact',
            accountKey: 'M001\u0000USD',
            ambiguityCode: 'MULTI_CURRENCY'
          },
          {
            blockOrdinal: 1,
            sourceRow: 20,
            merchantId: '',
            currency: '',
            matchKind: '',
            accountKey: '',
            ambiguityCode: null
          }
        ],
        orderedAccountKeys: ['M001\u0000USD']
      }]
    }
  };
  assert.deepEqual(extract(context, 'unfixed', [0]), {
    status: 'ok',
    accounts: [{
      merchantId: 'M001',
      currency: 'USD',
      matchType: 'exact',
      fileName: 'A.xlsx'
    }],
    ambiguousCurrencyFiles: ['A.xlsx']
  });
  assert.deepEqual(extract(context, 'fixed', [1]), {
    status: 'error',
    failedRows: [{ index: 1, fileName: 'A.xlsx' }]
  });
  context.bigAccountOrderEvidence.sessionId = 'stale';
  assert.match(extract(context, 'fixed', [0]).message, /已失效/);
});

test('直接识别到多币种大账号也提醒币种待核对，并按账号精确取币种选项', () => {
  const {
    matchMerchantIds,
    normalizeMaintainedBigAccounts
  } = require('../../../src/main-process/big-account-recognition');
  const normalize = (value) => String(value == null ? '' : value).trim();
  const findBridge = loadFunction(
    'findSelfInputBigAccountBridge',
    ['normalizeCell', 'matchMerchantIds'],
    [normalize, matchMerchantIds]
  );
  const buildEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [
      path,
      normalize,
      normalizeMaintainedBigAccounts,
      ({ basis }) => ({ matches: (basis && basis.directMatches) || [] }),
      findBridge,
      matchMerchantIds
    ]
  );
  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [loadFunction('selectPendingBigAccountRows'), path, normalize]
  );
  // 对应 CZBANK 模板：MerchantId 为固定的多大账号标记，先直接从账单表头识别账号，账单里没有币种列。
  const files = [
    // 同一账号的人民币、美元账单；第一份同时带桥接值，直接识别优先时仍要提醒。
    { name: 'CNY-7013.xls', directMatch: 'FTN7013', clearingId: 'NRA2268' },
    { name: 'USD-7013.xls', directMatch: 'FTN7013' },
    { name: 'CNY-2268.xls', directMatch: 'NRA2268' },
    // 维护列表里 M0011 排在前面且包含 M001，不能被当成 M001 的币种选项。
    { name: 'USD-M001.xls', directMatch: 'M001' }
  ];
  const fileEntries = files.map((file) => ({
    filePath: path.resolve('/private/czbank', file.name),
    detailRows: {
      bigAccountRecognitionBasis: {
        headerWindows: [{ headerRowNumber: 5, candidateRows: [] }],
        bridgeClearingIdsByBlock: file.clearingId ? [file.clearingId] : [],
        directMatches: [{ merchantId: file.directMatch, matchType: 'fuzzy' }]
      }
    },
    selfInputMerchant: true,
    skipDirectMerchantLookup: false
  }));
  const rows = fileEntries.map((entry, index) => ({
    index,
    filePath: entry.filePath,
    fileName: path.basename(entry.filePath),
    fileBlockOrdinal: 0,
    sourceRowNumber: 6
  }));
  const context = {
    statementSelectionSessionId: 'czbank-session',
    bigAccounts: [
      { merchantId: 'FTN7013', currencies: ['CNY', 'USD', 'GBP'] },
      { merchantId: 'NRA2268', currencies: ['CNY'] },
      { merchantId: 'M0011', currencies: ['CNY'] },
      { merchantId: 'M001', currencies: ['USD'] }
    ],
    fileEntries,
    rows,
    rowsWithEmptyBlocks: rows
  };
  context.bigAccountOrderEvidence = buildEvidence(context);

  assert.deepEqual(
    context.bigAccountOrderEvidence.files.map((file) => file.rows[0].ambiguityCode),
    ['MULTI_CURRENCY', 'MULTI_CURRENCY', null, null]
  );
  for (const mode of ['unfixed', 'fixed']) {
    assert.deepEqual(extract(context, mode, [0, 1, 2, 3]), {
      status: 'ok',
      accounts: [
        { merchantId: 'FTN7013', currency: 'CNY', matchType: 'fuzzy', fileName: 'CNY-7013.xls' },
        { merchantId: 'FTN7013', currency: 'CNY', matchType: 'fuzzy', fileName: 'USD-7013.xls' },
        { merchantId: 'NRA2268', currency: 'CNY', matchType: 'fuzzy', fileName: 'CNY-2268.xls' },
        { merchantId: 'M001', currency: 'USD', matchType: 'fuzzy', fileName: 'USD-M001.xls' }
      ],
      ambiguousCurrencyFiles: ['CNY-7013.xls', 'USD-7013.xls']
    }, mode);
  }
  // 只提取单币种账号时不追加多余提醒。
  assert.deepEqual(extract(context, 'unfixed', [2, 3]), {
    status: 'ok',
    accounts: [
      { merchantId: 'NRA2268', currency: 'CNY', matchType: 'fuzzy', fileName: 'CNY-2268.xls' },
      { merchantId: 'M001', currency: 'USD', matchType: 'fuzzy', fileName: 'USD-M001.xls' }
    ]
  });
});

test('首次 workbook raw rows 派生最小 recognition basis，标准/bridge/多模板均不重读源', () => {
  const normalize = (value) => String(value == null ? '' : value).trim();
  const match = (cell, merchantId) => {
    const left = normalize(cell);
    const right = normalize(merchantId);
    if (left === right) return 'exact';
    return left.includes(right) ? 'fuzzy' : 'none';
  };
  const findMatch = loadFunction(
    'findBigAccountMatchInRows',
    ['normalizeCell', 'matchMerchantIds'],
    [normalize, match]
  );
  const buildBasis = loadFunction(
    'buildBigAccountRecognitionBasis',
    ['findHeaderRowNumbersInRawRows', 'normalizeCell', 'matchMerchantIds'],
    [
      loadFunction(
        'findHeaderRowNumbersInRawRows',
        ['normalizeCell', 'buildExpectedHeaderCandidates'],
        [normalize, buildExpectedHeaderCandidates]
      ),
      normalize,
      match
    ]
  );
  const identifyFromBasis = loadFunction(
    'identifyAccountsFromRecognitionBasis',
    ['findBigAccountMatchInRows'],
    [findMatch]
  );
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const rawA = [
    ['查询账号', 'M001'],
    ['Date', 'Amount'],
    ['2026-08-01', '1'],
    ['查询账号', 'M002', '银行账号', 'BANK-SELF'],
    ['Date', 'Amount'],
    ['2026-08-02', '2']
  ];
  let workbookReadCount = 0;
  const buildForFile = loadFunction(
    'buildMappedRowsForFile',
    [
      'buildMappedRows',
      'createStatementWorkbookReadGuard',
      'buildBigAccountRecognitionBasis',
      'finalizeBigAccountRecognitionBasis'
    ],
    [
      ({ readOptions }) => {
        workbookReadCount += 1;
        assert.equal(typeof readOptions.onWorkbookRows, 'function');
        readOptions.onWorkbookRows(rawA);
        const mappedRows = [
          ['Credit Amount', 'Debit Amount'],
          ['1', ''],
          ['', '2']
        ];
        mappedRows.rowMetas = [{ sourceRowNumber: 3 }, { sourceRowNumber: 6 }];
        mappedRows.headerBreaks = [5];
        return mappedRows;
      },
      () => Object.freeze({ beforeRead() {}, afterRead() {} }),
      buildBasis,
      finalizeBasis
    ]
  );
  const detailRowsA = buildForFile({
    inputFilePath: '/private/child.xlsx',
    config: {
      exportTargetFields: [],
      mappingByTargetField: {},
      accountMappingByBankId: {
        'BANK-SELF': { clearingAccountId: 'M003' }
      },
      currencyMappings: [],
      amountMappingRules: {},
      amountSplitByField: null,
      billSplitMerge: null,
      template: { headers: ['Date', 'Amount'] },
      selectedMerchantId: '',
      selectedCurrency: '',
      dateParseOrder: 'auto'
    }
  });
  const basisA = detailRowsA.bigAccountRecognitionBasis;
  assert.equal(workbookReadCount, 1);
  assert.equal(Object.hasOwn(basisA, 'rawRows'), false);
  assert.equal(basisA.headerWindows.length, 2);
  assert.deepEqual(basisA.bridgeClearingIdsByBlock, ['', 'M003']);
  assert.deepEqual(
    identifyFromBasis({ basis: basisA, allMerchantIds: ['M001', 'M002', 'M003'] }).accounts,
    [
      { merchantId: 'M001', matchType: 'exact' },
      { merchantId: 'M002', matchType: 'exact' }
    ]
  );

  const buildEvidence = loadFunction(
    'buildBigAccountOrderEvidence',
    [
      'path',
      'normalizeCell',
      'expandBigAccountConfigurations',
      'identifyAccountsFromRecognitionBasis',
      'findSelfInputBigAccountBridge',
      'matchMerchantIds'
    ],
    [
      path,
      normalize,
      (items) => items.flatMap((item) => item.currencies.map((currency) => ({
        merchantId: item.merchantId,
        currency
      }))),
      identifyFromBasis,
      loadFunction(
        'findSelfInputBigAccountBridge',
        ['normalizeCell', 'matchMerchantIds'],
        [normalize, match]
      ),
      match
    ]
  );
  const childPath = path.resolve('/private/child.xlsx');
  const parentPath = path.resolve('/private/parent.xlsx');
  const evidence = buildEvidence({
    statementSelectionSessionId: 'session-basis',
    bigAccounts: [
      { merchantId: 'M001', currencies: ['USD'] },
      { merchantId: 'M002', currencies: ['EUR'] },
      { merchantId: 'M003', currencies: ['CNY'] }
    ],
    fileEntries: [
      { filePath: childPath, detailRows: detailRowsA },
      {
        filePath: parentPath,
        selfInputMerchant: true,
        skipDirectMerchantLookup: true,
        detailRows: detailRowsA
      }
    ],
    rowsWithEmptyBlocks: [
      { index: 0, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 0, sourceRowNumber: 3 },
      { index: 1, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 6 },
      { index: 2, filePath: parentPath, fileName: 'parent.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 6 }
    ]
  });
  assert.deepEqual(
    evidence.files.flatMap((file) => file.rows.map((row) => row.accountKey)),
    ['M001\u0000USD', 'M002\u0000EUR', 'M003\u0000CNY']
  );
  assert.equal(Object.isFrozen(evidence), true);
  const extractionContext = {
    statementSelectionSessionId: 'session-basis',
    bigAccounts: [
      { merchantId: 'M001', currencies: ['USD'] },
      { merchantId: 'M002', currencies: ['EUR'] },
      { merchantId: 'M003', currencies: ['CNY'] }
    ],
    rows: [
      { index: 0, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 0, sourceRowNumber: 3 },
      { index: 1, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 6 }
    ],
    rowsWithEmptyBlocks: [
      { index: 0, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 0, sourceRowNumber: 3 },
      { index: 1, filePath: childPath, fileName: 'child.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 6 },
      { index: 2, filePath: parentPath, fileName: 'parent.xlsx', fileBlockOrdinal: 1, sourceRowNumber: 6 }
    ],
    bigAccountOrderEvidence: evidence
  };
  const extract = loadFunction(
    'extractBigAccountOrderFromEvidence',
    ['selectPendingBigAccountRows', 'path', 'normalizeCell'],
    [loadFunction('selectPendingBigAccountRows'), path, normalize]
  );
  assert.equal(extract(extractionContext, 'fixed', [0, 1, 2]).accounts.length, 3);
  const buildOrderData = loadFunction('buildBigAccountOrderData');
  assert.equal(buildOrderData(extractionContext).fileCount, 2);
  assert.equal(workbookReadCount, 1);
});

test('大账号 fuzzy fallback 保持旧 last-fuzzy-wins 顺序', () => {
  const findMatch = loadFunction(
    'findBigAccountMatchInRows',
    ['normalizeCell', 'matchMerchantIds'],
    [
      (value) => String(value == null ? '' : value).trim(),
      (cell, merchantId) => String(cell).includes(merchantId) ? 'fuzzy' : 'none'
    ]
  );
  assert.deepEqual(
    findMatch([['far-M002'], ['near-M001']], 0, 1, ['M001', 'M002']),
    { merchantId: 'M002', matchType: 'fuzzy' }
  );
});

test('statement workbook 读取期间变化时统一失败，输出与 session side effect 均为 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-stable-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'statement.csv');
  fs.writeFileSync(inputPath, 'Date\n2026-08-19\n');
  const actualStat = fs.lstatSync(inputPath, { bigint: true });
  let statCount = 0;
  const fsImpl = {
    lstatSync() {
      statCount += 1;
      if (statCount === 1) return actualStat;
      return new Proxy(actualStat, {
        get(target, property) {
          if (property === 'size') return target.size + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  const createGuard = loadFunction(
    'createStatementWorkbookReadGuard',
    [
      'path',
      'fs',
      'sourceSnapshotFromStat',
      'sourceSnapshotMatchesStat',
      'STATEMENT_SOURCE_FRESHNESS_FAILURE',
      'statementSourceFreshnessError',
      'statementSourceReadContext'
    ],
    [
      path,
      fsImpl,
      sourceSnapshotFromStat,
      sourceSnapshotMatchesStat,
      {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      },
      () => Object.assign(
        new Error('网银明细源文件在确认期间已变化，请重新选择'),
        { code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION' }
      ),
      { getStore: () => null }
    ]
  );
  let outputCount = 0;
  let sessionCommitCount = 0;
  assert.throws(() => {
    buildMappedRows({
      inputFilePath: inputPath,
      orderedTargetFields: ['BillDate'],
      mappingByField: { BillDate: 'Date' },
      expectedSourceHeaders: ['Date'],
      readOptions: { readGuard: createGuard(inputPath) }
    });
    outputCount += 1;
    sessionCommitCount += 1;
  }, (error) => error
    && error.code === 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION'
    && error.message === '网银明细源文件在确认期间已变化，请重新选择');
  assert.equal(outputCount, 0);
  assert.equal(sessionCommitCount, 0);
});

test('public freshness 通过后稳定替换 v2，reader 起点仍绑定 confirmed FilePlan snapshot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-confirmed-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'statement.csv');
  fs.writeFileSync(inputPath, 'Date\n2026-08-19\n');
  const pickerSnapshot = sourceSnapshotFromStat(fs.lstatSync(inputPath, { bigint: true }));
  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: pickerSnapshot,
      freshnessFailure: {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      }
    }],
    outputs: []
  });
  assert.equal(assertFilePlanFresh(plan), plan);

  const replacementPath = path.join(dir, 'replacement.csv');
  fs.writeFileSync(replacementPath, 'Date\n2026-08-20\n');
  fs.unlinkSync(inputPath);
  fs.renameSync(replacementPath, inputPath);
  const { AsyncLocalStorage } = require('node:async_hooks');
  const readContext = new AsyncLocalStorage();
  const runConfirmed = loadFunction(
    'runWithStatementConfirmedSourceSnapshots',
    ['statementSourceReadContext', 'path'],
    [readContext, path]
  );
  const createGuard = loadFunction(
    'createStatementWorkbookReadGuard',
    [
      'path',
      'fs',
      'sourceSnapshotFromStat',
      'sourceSnapshotMatchesStat',
      'STATEMENT_SOURCE_FRESHNESS_FAILURE',
      'statementSourceFreshnessError',
      'statementSourceReadContext'
    ],
    [
      path,
      fs,
      sourceSnapshotFromStat,
      sourceSnapshotMatchesStat,
      {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      },
      () => Object.assign(
        new Error('网银明细源文件在确认期间已变化，请重新选择'),
        { code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION' }
      ),
      readContext
    ]
  );
  let outputCount = 0;
  let sessionCommitCount = 0;
  assert.throws(() => runConfirmed(
    'file:import',
    { fileEvidence: { filePlan: plan } },
    () => {
      buildMappedRows({
        inputFilePath: inputPath,
        orderedTargetFields: ['BillDate'],
        mappingByField: { BillDate: 'Date' },
        expectedSourceHeaders: ['Date'],
        readOptions: { readGuard: createGuard(inputPath) }
      });
      outputCount += 1;
      sessionCommitCount += 1;
    }
  ), (error) => error
    && error.code === 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION'
    && error.message === '网银明细源文件在确认期间已变化，请重新选择');
  assert.equal(outputCount, 0);
  assert.equal(sessionCommitCount, 0);
  assert.equal(readContext.getStore(), undefined);
  assert.match(
    functionSource('runWithStatementConfirmedSourceSnapshots'),
    /taskContext\.fileEvidence\.filePlan\.inputs/
  );
  assert.match(
    functionSource('runWithStatementConfirmedSourceSnapshots'),
    /file:import[\s\S]*file:complete-big-account-selection/
  );
  assert.doesNotMatch(
    functionSource('runWithStatementConfirmedSourceSnapshots'),
    /renderer|picker|prepared/
  );
  assert.match(
    functionSource('runArchiveAwareOperation'),
    /executeBusiness:\s*\(\) => runWithStatementConfirmedSourceSnapshots\(\s*meta\.channel, taskContext,\s*\(\) => executeIpcTaskInvocation\(contract, event, prepared, effectiveArgs, taskContext\)/
  );
});

test('filename 多模板先完成全部稳定读取，再产生输出或 session 副作用', () => {
  let rebuildCount = 0;
  let outputCount = 0;
  let sessionMutationCount = 0;
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  // v3.2.15：生成分组改为按渠道 / 模板；这里的模板都不属于渠道，按模板各自成组。
  const groupStatementEntriesForGeneration = loadFunction(
    'groupStatementEntriesForGeneration',
    ['database', 'resolveGenerationGroupKey', 'getTemplateMappingConfig'],
    [{ getTemplate: (id) => ({ id, channelId: null }) }, resolveGenerationGroupKey, () => null]
  );
  const generateGroups = loadFunction(
    'generateMultiTemplateGroupFiles',
    [
      'groupStatementEntriesForGeneration',
      'getEntryTemplateConfig',
      'normalizeCell',
      'FIXED_FIELD_VALUE_PREFIX',
      'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
      'buildStatementGenerationConfig',
      'rebuildMatchedTemplateFileEntries',
      'buildPreparedStatementBatchFromEntries',
      'removeStatementSessionEntriesByFilePath',
      'generateStatementFiles'
    ],
    [
      groupStatementEntriesForGeneration,
      ({ entry }) => ({
        template: { id: entry.matchedTemplateId },
        exportMappings: [{ templateField: 'MerchantId', mappedField: '__FIXED__:__MULTI__' }],
        exportTargetFields: []
      }),
      (value) => String(value == null ? '' : value).trim(),
      '__FIXED__:',
      '__MULTI__',
      ({ template }) => ({ template }),
      ({ fileEntries }) => {
        rebuildCount += 1;
        if (rebuildCount === 2) {
          throw Object.assign(
            new Error('网银明细源文件在确认期间已变化，请重新选择'),
            { code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION' }
          );
        }
        return fileEntries;
      },
      ({ fileEntries }) => ({ detailRows: fileEntries }),
      () => { sessionMutationCount += 1; },
      () => { outputCount += 1; return {}; }
    ]
  );
  assert.throws(() => generateGroups({
    fileEntries: [
      { matchedTemplateId: 1, filePath: '/private/A.xlsx' },
      { matchedTemplateId: 2, filePath: '/private/B.xlsx' }
    ],
    fallbackTemplateConfig: {},
    selectedBigAccount: { merchantId: 'M001', currency: 'USD' },
    reuseMappedRows: true,
    session: {},
    replacePaths: ['/private/old.xlsx'],
    inputFilePaths: ['/private/A.xlsx', '/private/B.xlsx']
  }), (error) => error && error.code === 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION');
  assert.equal(rebuildCount, 2);
  assert.equal(outputCount, 0);
  assert.equal(sessionMutationCount, 0);
});

test('direct/filename/big-account execute 不泛化 statement 读取稳定性错误', () => {
  const filenameImportSource = mainSource.slice(
    mainSource.indexOf('async function handleFilenameMappingImport'),
    mainSource.indexOf('async function prepareStatementImportFiles')
  );
  const directImportSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  const bigAccountSource = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("businessIpcHandle(\n    'file:complete-big-account-selection'")
  );
  for (const source of [filenameImportSource, directImportSource]) {
    assert.match(source, /error\.code === STATEMENT_SOURCE_FRESHNESS_FAILURE\.code/);
    assert.match(source, /message:\s*STATEMENT_SOURCE_FRESHNESS_FAILURE\.message/);
    assert.match(source, /errorCode:\s*STATEMENT_SOURCE_FRESHNESS_FAILURE\.code/);
    assert.match(source, /throw error/);
  }
  assert.match(bigAccountSource, /error\.code === STATEMENT_SOURCE_FRESHNESS_FAILURE\.code/);
  assert.match(bigAccountSource, /throw error/);
  assert.doesNotMatch(
    bigAccountSource.slice(bigAccountSource.indexOf('if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code)')),
    /BIG_ACCOUNT_SELECTION_RUNTIME[\s\S]*?STATEMENT_SOURCE_FRESHNESS_FAILURE/
  );
});

test('完成选择接受完整乱序 assignments，并拒绝重复 rowIndex', () => {
  class FileValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const normalize = loadFunction(
    'normalizePendingBigAccountSelection',
    ['normalizeCell', 'FileValidationError'],
    [(value) => String(value == null ? '' : value).trim(), FileValidationError]
  );
  const context = {
    rows: [{ index: 0 }, { index: 1 }],
    bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false }]
  };
  assert.deepEqual(normalize(context, {
    assignments: [
      { rowIndex: 1, merchantId: 'M001', currency: 'USD' },
      { rowIndex: 0, merchantId: 'M001', currency: 'USD' }
    ]
  }).normalizedAssignments.map((item) => item.rowIndex), [0, 1]);
  assert.throws(
    () => normalize(context, {
      assignments: [
        { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
        { rowIndex: 0, merchantId: 'M001', currency: 'USD' }
      ]
    }),
    (error) => error.code === 'BIG_ACCOUNT_SELECTION_INVALID'
  );
});

test('大账号 preview DTO 只暴露 contextId 与展示行，不暴露主进程 filePath', () => {
  const normalizeCell = (value) => String(value == null ? '' : value).trim();
  const buildPreview = loadFunction(
    'buildBigAccountPreviewResult',
    ['normalizeCell'],
    [normalizeCell]
  );
  const result = buildPreview({
    status: 'select-big-account',
    rows: [{ index: 3, fileName: 'A.xlsx', filePath: '/private/source.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 3, fileName: 'A.xlsx', filePath: '/private/source.xlsx' },
      { index: 4, fileName: 'A.xlsx', filePath: '/private/source.xlsx' }
    ]
  }, 'opaque-context');
  assert.equal(result.contextId, 'opaque-context');
  assert.equal(Object.hasOwn(result.rows[0], 'filePath'), false);
  assert.equal(Object.hasOwn(result.rowsWithEmptyBlocks[1], 'filePath'), false);
});

test('非 bill-split 缓存行注入大账号且移除 selectedCurrency 已短路的伪告警', () => {
  const config = {
    template: { id: 1, headers: ['原字段'] },
    exportMappings: [{
      templateField: 'MerchantId',
      mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    }],
    exportTargetFields: ['MerchantId', 'Currency']
  };
  const rebuild = loadFunction(
    'rebuildMatchedTemplateFileEntries',
    [
      'getEntryTemplateConfig',
      'normalizeCell',
      'FIXED_FIELD_VALUE_PREFIX',
      'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
      'cloneRowsWithMetadata',
      'buildFieldIndexMap',
      'buildManagedMerchantLookupFlags',
      'buildStatementGenerationConfig',
      'buildMappedRowsForFile'
    ],
    [
      () => config,
      (value) => String(value == null ? '' : value).trim(),
      '__FIXED__:',
      '__MULTI_BIG_ACCOUNT__',
      (rows) => {
        const cloned = rows.map((row) => row.slice());
        if (Array.isArray(rows.issues)) {
          cloned.issues = rows.issues.map((issue) => ({ ...issue }));
        }
        return cloned;
      },
      (header) => new Map(header.map((field, index) => [field, index])),
      () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
      () => ({ billSplitMerge: { enabled: false } }),
      () => { throw new Error('reuseMappedRows 不得重新解析文件'); }
    ]
  );
  const sourceRows = [
    ['MerchantId', 'Currency', 'Amount'],
    ['', '', 10],
    ['', '', 20]
  ];
  sourceRows.issues = [
    { type: 'currency-unmapped', rawValue: '美元' },
    { type: 'date-invalid', rawValue: 'bad-date' }
  ];
  const [entry] = rebuild({
    fileEntries: [{ filePath: '/private/A.xlsx', detailRows: sourceRows }],
    fallbackTemplateConfig: config,
    selectedBigAccount: { merchantId: 'M001', currency: 'USD' },
    reuseMappedRows: true
  });
  assert.deepEqual(entry.detailRows.map((row) => row), [
    ['MerchantId', 'Currency', 'Amount'],
    ['M001', 'USD', 10],
    ['M001', 'USD', 20]
  ]);
  assert.deepEqual(sourceRows[1], ['', '', 10], '不得修改 prepare 缓存原对象');
  assert.deepEqual(entry.detailRows.issues, [
    { type: 'date-invalid', rawValue: 'bad-date' }
  ]);
  assert.equal(sourceRows.issues.length, 2, '不得修改 prepare 缓存告警');
});

test('多大账号 + bill-split 缓存路径回退 raw rebuild，保留原币种拆分算法', () => {
  const config = {
    template: { id: 1, headers: ['原字段'] },
    exportMappings: [{
      templateField: 'MerchantId',
      mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    }],
    exportTargetFields: ['MerchantId', 'Currency']
  };
  const rawRows = [['MerchantId', 'Currency'], ['M001', 'EUR']];
  let rawRebuildCount = 0;
  const rebuild = loadFunction(
    'rebuildMatchedTemplateFileEntries',
    [
      'getEntryTemplateConfig',
      'normalizeCell',
      'FIXED_FIELD_VALUE_PREFIX',
      'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
      'cloneRowsWithMetadata',
      'buildFieldIndexMap',
      'buildManagedMerchantLookupFlags',
      'buildStatementGenerationConfig',
      'buildMappedRowsForFile'
    ],
    [
      () => config,
      (value) => String(value == null ? '' : value).trim(),
      '__FIXED__:',
      '__MULTI_BIG_ACCOUNT__',
      () => { throw new Error('bill-split 不得复用 preview 映射行'); },
      () => { throw new Error('bill-split 不得走缓存字段覆盖'); },
      () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
      ({ selectedBigAccount }) => {
        assert.deepEqual(selectedBigAccount, { merchantId: 'M001', currency: 'USD' });
        return { billSplitMerge: { enabled: true } };
      },
      ({ config: generationConfig, inputFilePath }) => {
        rawRebuildCount += 1;
        assert.equal(generationConfig.billSplitMerge.enabled, true);
        assert.equal(inputFilePath, '/private/A.xlsx');
        return rawRows;
      }
    ]
  );
  const [entry] = rebuild({
    fileEntries: [{
      filePath: '/private/A.xlsx',
      detailRows: [['MerchantId', 'Currency'], ['', 'preview-currency']]
    }],
    fallbackTemplateConfig: config,
    selectedBigAccount: { merchantId: 'M001', currency: 'USD' },
    reuseMappedRows: true
  });
  assert.equal(rawRebuildCount, 1);
  assert.equal(entry.detailRows, rawRows);
});

test('普通模板 direct recognition 的 preview 决策在 execute 复用，只探测一次', () => {
  let recognitionCount = 0;
  const resolvePrepared = loadFunction(
    'resolvePreparedDirectBigAccountRecognition',
    ['resolveDirectBigAccountRecognition'],
    [() => {
      recognitionCount += 1;
      return {
        status: 'ok',
        selectedBigAccount: { merchantId: 'M001', currency: 'USD' }
      };
    }]
  );
  const prepared = { previewOnly: true };
  const previewDecision = resolvePrepared({ prepared, recognitionArgs: { fileEntries: [{}] } });
  prepared.previewOnly = false;
  const executeDecision = resolvePrepared({ prepared, recognitionArgs: { fileEntries: [{}] } });
  assert.equal(recognitionCount, 1);
  assert.equal(executeDecision, previewDecision);

  const importHandlerSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.match(importHandlerSource, /resolvePreparedDirectBigAccountRecognition\s*\(\{/);
});

test('fixed 顺序自定义输入的 preview auto-match 决策在 execute 复用，不重开源文件', () => {
  let decisionCount = 0;
  const resolvePrepared = loadFunction('resolvePreparedFixedBigAccountAutoMatchDecision');
  const prepared = { previewOnly: true };
  const resolveDecision = () => {
    decisionCount += 1;
    return {
      failedFileNames: [],
      reorderedAssignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }]
    };
  };
  const previewDecision = resolvePrepared(prepared, resolveDecision);
  prepared.previewOnly = false;
  const executeDecision = resolvePrepared(prepared, resolveDecision);
  assert.equal(decisionCount, 1);
  assert.equal(executeDecision, previewDecision);

  const importHandlerSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  const autoMatchSource = importHandlerSource.slice(
    importHandlerSource.indexOf('const autoMatchDecision = resolvePreparedFixedBigAccountAutoMatchDecision'),
    importHandlerSource.indexOf('const { failedFileNames, reorderedAssignments } = autoMatchDecision')
  );
  assert.match(autoMatchSource, /identifySelfInputBigAccountBridges\s*\(/);
  assert.match(autoMatchSource, /bridgeAccounts\.every\(Boolean\)/);
  assert.doesNotMatch(autoMatchSource, /readRows(?:WithMetadata)?\s*\(/);
});

test('网银 picker snapshot 注入 FilePlan，预检/重复弹窗不比较，beforeStart 只验 session', () => {
  const captureSelection = loadFunction(
    'captureStatementSourceSelections',
    ['normalizeInputFilePaths', 'path', 'fs', 'sourceSnapshotFromStat'],
    [
      (values) => values.map((value) => path.resolve(value)),
      path,
      {
        lstatSync(filePath, options) {
          assert.deepEqual(options, { bigint: true });
          return fs.lstatSync(filePath, options);
        }
      },
      sourceSnapshotFromStat
    ]
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-preview-fresh-'));
  try {
    const inputPath = path.join(dir, 'statement.xlsx');
    fs.writeFileSync(inputPath, 'before', 'utf8');
    const selections = captureSelection([inputPath]);
    assert.equal(selections[0].resolvedPath, inputPath);
    assert.equal(typeof selections[0].sourceSnapshot.ino, 'string');
    assert.equal(Object.isFrozen(selections), true);
    assert.equal(Object.isFrozen(selections[0]), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const duplicateResolver = mainSource.slice(
    mainSource.indexOf('async function resolveImportFileSelection'),
    mainSource.indexOf('function buildScopeSelectionResult')
  );
  assert.doesNotMatch(duplicateResolver, /assertFreshAfterConfirmation|sourceSnapshotMatchesStat/);
  const statementPrepare = mainSource.slice(
    mainSource.indexOf('async function prepareStatementImportFiles'),
    mainSource.indexOf('function registerFileHandlers')
  );
  assert.match(statementPrepare, /captureStatementSourceSelections\(inputFilePaths\)/);
  assert.match(statementPrepare, /buildStatementInputFilePlanItems\(sourceSelections, 'file:import'\)/);
  const filePlanItemSource = functionSource('buildStatementInputFilePlanItems');
  assert.match(filePlanItemSource, /sourceSnapshot:\s*selection\.sourceSnapshot/);
  assert.match(filePlanItemSource, /freshnessFailure:\s*STATEMENT_SOURCE_FRESHNESS_FAILURE/);
  assert.doesNotMatch(statementPrepare, /assertSelectionFresh|assertSourceFresh|createPreviewSourceFreshnessGuard/);

  const importPrepareSource = mainSource.slice(
    mainSource.indexOf('const previewResult = await fileImportHandler.execute'),
    mainSource.indexOf('async execute(_event, prepared, taskContext, templateId)')
  );
  assert.doesNotMatch(importPrepareSource, /previewPrepared\.assertFresh|sourceSnapshotMatchesStat/);

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'")
  );
  const beforeStartIndex = completeHandler.indexOf('beforeStart()');
  assert.ok(beforeStartIndex >= 0);
  assert.doesNotMatch(completeHandler.slice(0, beforeStartIndex), /assertSessionCurrent\(\)|assertFresh\(\)/);
  assert.match(completeHandler.slice(beforeStartIndex), /pendingContext\.assertSessionCurrent\(\)/);
  assert.doesNotMatch(completeHandler, /sourceSnapshotMatchesStat|assertFresh/);
});

test('大账号顺序提取/保存只消费预检冻结 evidence，不重读源文件', () => {
  assert.doesNotMatch(
    functionSource('buildBigAccountOrderEvidence'),
    /readRows\(|readRowsWithMetadata\(|identifyAccountsFromFile\(/
  );
  const extractHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'"),
    mainSource.indexOf("businessIpcHandle('file:save-balance-seed'")
  );
  assert.match(extractHandler, /extractBigAccountOrderFromEvidence\(/);
  assert.doesNotMatch(extractHandler, /readRows\(|identifyAccountsFromFile\(|assertFresh|sourceSnapshotMatchesStat/);

  const saveHandler = mainSource.slice(
    mainSource.indexOf("businessIpcHandle('big-account-order:save'"),
    mainSource.indexOf('const STATEMENT_IMPORT_PREVIEW_READY')
  );
  assert.match(saveHandler, /buildBigAccountOrderData\(pendingContext/);
  assert.doesNotMatch(saveHandler, /readRows\(|identifyAccountsFromFile\(|assertFresh|sourceSnapshotMatchesStat/);
  assert.doesNotMatch(functionSource('buildBigAccountOrderData'), /readRows\(|identifyAccountsFromFile\(/);
});

test('acquiring peek 探测期间源文件变更会在建立覆盖上下文前被拒绝', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-preview-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'acquiring.xlsx');
  fs.writeFileSync(inputPath, 'before', 'utf8');
  const guard = loadFunction(
    'createPreviewSourceFreshnessGuard',
    ['path', 'sourceSnapshotFromStat', 'fs', 'sourceSnapshotMatchesStat'],
    [path, sourceSnapshotFromStat, fs, sourceSnapshotMatchesStat]
  )([inputPath], '收单导入');
  fs.writeFileSync(inputPath, 'after-peek-is-longer', 'utf8');
  assert.throws(guard, /源文件在确认期间已变化/);

  const acquiringPrepareSource = mainSource.slice(
    mainSource.indexOf('async function prepareAcquiringImport'),
    mainSource.indexOf('async function executeAcquiringImport')
  );
  assert.match(
    acquiringPrepareSource,
    /peeked = await acquiringRunData\.peekImportTarget\([\s\S]*?assertSourceFresh\(\);[\s\S]*?if \(peeked\.monthKey/
  );
});

test('顺序持久化失败只追加生成后告警，不覆盖已形成的业务结果', () => {
  let writeCount = 0;
  const activityLogs = [];
  const persist = loadFunction(
    'persistBigAccountOrderAfterGeneration',
    [
      'buildBigAccountOrderData',
      'writeBigAccountOrder',
      'ensureStorageRoot',
      'appendActivityLogEntry'
    ],
    [
      (_pendingContext, assignments) => ({ assignments, fileCount: 1, files: [] }),
      () => {
        writeCount += 1;
        throw new Error('disk full');
      },
      () => '/tmp/storage',
      (entry) => activityLogs.push(entry)
    ]
  );
  const generatedResult = {
    status: 'success',
    message: '文件生成成功',
    detailReady: true,
    balanceReady: true,
    filePath: '/tmp/generated.xlsx'
  };
  const result = persist({
    pendingContext: { templateId: 7 },
    normalizedAssignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }],
    rememberOrder: true,
    result: generatedResult
  });
  assert.equal(writeCount, 1);
  assert.equal(result.status, 'warning');
  assert.equal(result.detailReady, true);
  assert.equal(result.balanceReady, true);
  assert.equal(result.filePath, '/tmp/generated.xlsx');
  assert.match(result.message, /账单已生成.*本次选择未记住/);
  assert.equal(activityLogs.length, 1);
});

test('选择结果构造不清 lastErrorReport，renderer 只回传 contextId + rowIndexes/assignments', () => {
  assert.doesNotMatch(
    functionSource('buildBigAccountSelectionRequiredResult'),
    /clearLastErrorReport\s*\(/
  );
  const rendererSource = fs.readFileSync(RENDERER_DIALOGS_PATH, 'utf8');
  const extractCall = rendererSource.match(
    /extractBigAccountOrder\s*\(\{([\s\S]*?)\}\)\s*;/
  );
  assert.ok(extractCall, '应存在 extractBigAccountOrder 调用');
  assert.match(extractCall[1], /contextId\s*:/);
  assert.match(extractCall[1], /rowIndexes\s*:/);
  assert.doesNotMatch(extractCall[1], /fileRows\s*:|filePath\s*:/);
  const extractHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'"),
    mainSource.indexOf("businessIpcHandle('file:save-balance-seed'")
  );
  assert.match(extractHandler, /extractBigAccountOrderFromEvidence\s*\(/);
  assert.match(functionSource('extractBigAccountOrderFromEvidence'), /selectPendingBigAccountRows\s*\(/);
  assert.doesNotMatch(extractHandler, /payload(?:\?|)\.fileRows/);
  const activeDialogTail = rendererSource.slice(
    rendererSource.indexOf('let finalAssignments;'),
    rendererSource.indexOf('initializeState();', rendererSource.indexOf('let finalAssignments;'))
  );
  const activeCompleteCall = activeDialogTail.match(
    /completeBigAccountSelection\s*\(\{([\s\S]*?assignments:\s*finalAssignments[\s\S]*?)\}\)\s*;/
  );
  assert.ok(activeCompleteCall, '当前 object 分支应提交 complete payload');
  assert.equal(
    [...activeDialogTail.matchAll(/completeBigAccountSelection\s*\(/g)].length,
    1,
    '当前 object 分支只调用一次 complete'
  );
  assert.match(activeCompleteCall[1], /contextId:\s*payload\.contextId/);
  assert.match(activeCompleteCall[1], /rememberOrder:\s*rememberCheckbox\.checked/);
  assert.doesNotMatch(activeCompleteCall[1], /fileRows\s*:|filePath\s*:/);

  assert.doesNotMatch(activeDialogTail, /bigAccount\.saveOrder/);

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'")
  );
  assert.match(completeHandler, /requirePendingBigAccountSelection\(contextId\)/);
  assert.match(
    completeHandler,
    /clearPendingBigAccountSelection\(prepared\.contextId\);[\s\S]*?const \{ isFixedMode/
  );
  assert.match(
    completeHandler,
    /const result = buildImportResultFromGeneratedFiles\([\s\S]*?persistBigAccountOrderAfterGeneration\(\{[\s\S]*?result/
  );
});

test('Statement 五条 eager action 只以冻结 FilePlan 作为业务文件路径权威', () => {
  const importPrepare = functionSource('prepareStatementImportFiles');
  const bindPrepared = functionSource('bindStatementImportPreparedToFileEvidence');
  assert.match(importPrepare, /filePlan:\s*\{[\s\S]*?allocation:\s*'eager'[\s\S]*?buildStatementInputFilePlanItems\(sourceSelections, 'file:import'\)/);
  assert.doesNotMatch(importPrepare, /inputPaths\s*:/);
  assert.match(bindPrepared, /filePlan\.inputs\.map\(\(item\) => item\.filePath\)/);

  const importHandler = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.match(
    importHandler,
    /bindStatementImportPreparedToFileEvidence\(\s*prepared,\s*taskContext\.fileEvidence\.filePlan\s*\)/
  );

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("businessIpcHandle(\n    'file:complete-big-account-selection'")
  );
  assert.match(
    completeHandler,
    /buildStatementInputFilePlanItems\([\s\S]*?'file:complete-big-account-selection'/
  );
  assert.match(completeHandler, /taskContext\.fileEvidence\.filePlan\.inputs/);

  const manualBalanceHandler = mainSource.slice(
    mainSource.indexOf("businessIpcHandle('file:save-balance-seed'"),
    mainSource.indexOf('function resolveStatementExportSession', mainSource.indexOf("businessIpcHandle('file:save-balance-seed'"))
  );
  assert.match(manualBalanceHandler, /sourceOperation:\s*'file:save-balance-seed'/);
  assert.match(manualBalanceHandler, /taskContext\.fileEvidence\.filePlan\.inputs\.map/);

  const exportPrepareStart = mainSource.indexOf('const prepareStatementExport =');
  const exportPrepare = mainSource.slice(
    exportPrepareStart,
    mainSource.indexOf("trackedIpcHandle('file:export-detail'", exportPrepareStart)
  );
  assert.match(exportPrepare, /sourceOperation:\s*kind === 'detail' \? 'file:export-detail' : 'file:export-balance'/);
  assert.doesNotMatch(exportPrepare, /outputPaths\s*:|savePath\s*:/);
  for (const channel of ['file:export-detail', 'file:export-balance']) {
    const start = mainSource.indexOf(`trackedIpcHandle('${channel}'`);
    const end = mainSource.indexOf('\n  });', start);
    const handler = mainSource.slice(start, end);
    assert.match(handler, /taskContext\.fileEvidence\.filePlan\.outputs\[0\]\.filePath/, channel);
    assert.match(handler, /taskContext\.settleArtifacts\(/, channel);
  }
});

test('两个 deferred action 仅在非空结果确定具体 output 后 promote，写盘与证据同一路径', () => {
  const deferredManifest = loadFunction(
    'buildStatementDeferredOutputManifest',
    ['fs', 'path', 'artifactManifestFromFilePlan', 'normalizeFilePlanV1'],
    [fs, path, artifactManifestFromFilePlan, normalizeFilePlanV1]
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-deferred-output-'));
  try {
    const outputPath = path.join(root, 'exports', '2026-08-18', 'balance', 'result.xlsx');
    assert.equal(fs.existsSync(path.dirname(outputPath)), false);
    const manifest = deferredManifest(outputPath, 'monthly-balance:assemble');
    assert.equal(fs.existsSync(path.dirname(outputPath)), true);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(manifest.outputs[0].filePath, outputPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const monthlyStart = mainSource.indexOf("trackedIpcHandle('monthly-balance:assemble'");
  const monthlyEnd = mainSource.indexOf("trackedIpcHandle('monthly-balance:export'", monthlyStart);
  const monthly = mainSource.slice(monthlyStart, monthlyEnd);
  assert.match(monthly, /allocation:\s*'deferred'/);
  assert.ok(monthly.indexOf('if (!assembled.records.length)') < monthly.indexOf('buildStatementDeferredOutputManifest('));
  assert.doesNotMatch(
    monthly.slice(0, monthly.indexOf('if (!assembled.records.length)')),
    /ensureStorageRoot\(|mkdirSync\(/
  );
  assert.ok(monthly.indexOf('await taskContext.ensureFileBatch(promotionManifest)') < monthly.indexOf('writeBalanceWorkbook({'));
  assert.match(monthly, /const promotedOutputPath = promotionManifest\.outputs\[0\]\.filePath/);
  assert.doesNotMatch(monthly, /filePath:\s*output\.outputFilePath|临时文件：\$\{output\.outputFilePath\}/);

  const accountStart = mainSource.indexOf("trackedIpcHandle('new-account:generate'");
  const accountEnd = mainSource.indexOf("trackedIpcHandle('new-account:export'", accountStart);
  const account = mainSource.slice(accountStart, accountEnd);
  assert.match(account, /allocation:\s*'deferred'/);
  assert.ok(account.indexOf('prepareNewAccountGeneration({') >= 0);
  assert.ok(account.indexOf('prepareNewAccountGeneration({') < account.indexOf('buildStatementDeferredOutputManifest('));
  assert.ok(account.indexOf('await taskContext.ensureFileBatch(promotionManifest)') < account.indexOf('writeBalanceWorkbook({'));
  assert.match(account, /filePath:\s*promotedOutputPath/);
  assert.doesNotMatch(account, /filePath:\s*output\.outputFilePath/);

  assert.doesNotMatch(mainSource, /atomicFileLifecycleChannels/);
  assert.match(mainSource, /policy\.allocation === 'deferred'[\s\S]*?runDeferredFileTask/);
  assert.match(mainSource, /archiveTaskLifecycle\.runFileTask/);
});

// 取真实 completeBigAccountSelectionHandler.execute，只替换生成与外部副作用；会话与待选择上下文用 production 实现。
function loadCompleteBigAccountSelectionExecute(deps) {
  let executeNode = null;
  const visit = (node) => {
    if (executeNode || !node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === 'completeBigAccountSelectionHandler') {
      executeNode = node.init.properties.find((prop) => prop.key && prop.key.name === 'execute');
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(mainAst);
  if (!executeNode) throw new Error('未找到 completeBigAccountSelectionHandler.execute');
  const names = Object.keys(deps);
  return Function(
    ...names,
    `return ({ ${mainSource.slice(executeNode.start, executeNode.end)} }).execute;`
  )(...names.map((name) => deps[name]));
}

function loadPendingBigAccountSelectionStore(deps) {
  const names = Object.keys(deps);
  return Function(
    ...names,
    `let lastPendingBigAccountSelection = null;
    ${functionSource('resolvePendingReplacePaths')}
    ${functionSource('createPendingBigAccountSelectionContext')}
    ${functionSource('rememberPendingBigAccountSelection')}
    ${functionSource('requirePendingBigAccountSelection')}
    return { createPendingBigAccountSelectionContext, rememberPendingBigAccountSelection, requirePendingBigAccountSelection, resolvePendingReplacePaths };`
  )(...names.map((name) => deps[name]));
}

test('大账号续跑沿用重复提示中确认覆盖的旧路径：跨目录同名、改名同内容只保留替换后的记录', async () => {
  const sessionHelpers = require('../../../src/main-process/statement-session');
  const normalizeCell = (value) => String(value == null ? '' : value).trim();
  const detailRows = () => Object.assign(
    [['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'], ['2026-11-01', '', 'USD', '100', '']],
    { rowMetas: [{ sourceRowNumber: 2 }] }
  );
  const cases = [
    { label: '同一路径', oldPath: '/private/stmt/a.xlsx', newPath: '/private/stmt/a.xlsx' },
    { label: '跨目录同名', oldPath: '/private/stmt/old/a.xlsx', newPath: '/private/stmt/new/a.xlsx' },
    { label: '改名同内容', oldPath: '/private/stmt/a.xlsx', newPath: '/private/stmt/a-copy.xlsx' }
  ];
  for (const { label, oldPath, newPath } of cases) {
    let entrySeq = 0;
    let batchSeq = 0;
    const buildEntryId = () => `entry-${++entrySeq}`;
    const buildBatchId = () => `batch-${++batchSeq}`;
    const statementImportSessions = new Map();
    const session = sessionHelpers.getOrCreateStatementImportSession({ statementImportSessions, templateId: 7, templateName: '中行-上海' });
    sessionHelpers.appendStatementSessionImport({
      buildBatchId,
      lastGeneratedExports: {},
      session,
      fileEntries: [sessionHelpers.buildStatementFileEntry({ buildEntryId, detailRows: detailRows(), filePath: oldPath })]
    });

    const store = loadPendingBigAccountSelectionStore({
      normalizeCell,
      normalizeInputFilePaths: sessionHelpers.normalizeInputFilePaths,
      cloneRowsWithMetadata: sessionHelpers.cloneRowsWithMetadata,
      buildBigAccountOrderEvidence: () => ({}),
      randomUUID: () => `context-${label}`
    });
    // 重复提示中点击“覆盖旧记录”后，selectionResult.replacePaths 记录会话里的旧路径。
    const prepared = { selectionResult: { filePaths: [newPath], replacePaths: [oldPath] } };
    const contextId = store.rememberPendingBigAccountSelection(store.createPendingBigAccountSelectionContext(prepared, {
      templateId: 7,
      template: { id: 7, name: '中行-上海' },
      mappings: [],
      orderedTargetFields: [],
      inputFilePaths: [newPath],
      fileEntries: [{ filePath: newPath, detailRows: detailRows() }]
    }));

    const execute = loadCompleteBigAccountSelectionExecute({
      requirePendingBigAccountSelection: store.requirePendingBigAccountSelection,
      resolvePendingReplacePaths: store.resolvePendingReplacePaths,
      clearPendingBigAccountSelection: () => {},
      getOrCreateStatementImportSession: sessionHelpers.getOrCreateStatementImportSession,
      statementImportSessions,
      applyBigAccountAssignmentsToFileEntries: (entries) => entries,
      isFilenameMappingMode: () => false,
      resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
      buildStatementGenerationConfig: ({ template }) => ({ template }),
      statementGenerationHelpers: { buildPreparedStatementBatchFromEntries: ({ fileEntries }) => ({ detailRows: fileEntries[0].detailRows }) },
      generateStatementFiles: () => ({ warnings: [] }),
      buildStatementFileEntry: sessionHelpers.buildStatementFileEntry,
      buildStatementFileEntryId: buildEntryId,
      removeStatementSessionEntriesByFilePath: sessionHelpers.removeStatementSessionEntriesByFilePath,
      appendStatementSessionImport: sessionHelpers.appendStatementSessionImport,
      buildStatementBatchId: buildBatchId,
      lastGeneratedExports: {},
      rememberLastFileImportContext: () => {},
      updateStatementSessionCache: () => {},
      buildImportResultFromGeneratedFiles: () => ({ status: 'success' }),
      persistBigAccountOrderAfterGeneration: ({ result }) => result,
      clearGeneratedExports: () => {},
      clearPendingManualBalancePrompt: () => {},
      STATEMENT_SOURCE_FRESHNESS_FAILURE: { code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE' },
      FileValidationError: class FileValidationError extends Error {},
      appendLog: (_root, error) => { throw error; },
      ensureStorageRoot: () => '',
      createErrorResult: (result) => ({ status: 'error', ...result })
    });
    const result = await execute(null, { contextId, isFixedMode: false, normalizedAssignments: [], rememberOrder: null }, {
      fileEvidence: { filePlan: { inputs: [{ filePath: newPath }] } }
    });

    assert.equal(result.status, 'success', label);
    assert.deepEqual(
      sessionHelpers.getStatementSessionEntries(session, 'all').map((entry) => entry.filePath),
      [path.resolve(newPath)],
      label
    );
  }
});

// v3.2.15（release 审查）：标准入口（按文件名映射）进入大账号选择时，记住的顺序与本次导入文件无法逐个唯一对上、
//   或对上后的顺序与记住的不同时，降级为不固定模式，界面不再按位置预填。
function loadSavedOrderGuard({ mode, order, logs = [] }) {
  const { matchImportFilesToSavedOrder } = require('../../../src/main-process/big-account-recognition');
  const normalize = (value) => String(value == null ? '' : value).trim();
  const resolveDecision = loadFunction(
    'resolveSavedBigAccountOrderDecision',
    ['readBigAccountMode', 'readBigAccountOrder', 'ensureStorageRoot', 'matchImportFilesToSavedOrder', 'normalizeCell'],
    [() => mode, () => order, () => '/storage', matchImportFilesToSavedOrder, normalize]
  );
  return loadFunction(
    'applySavedBigAccountOrderGuard',
    ['resolveSavedBigAccountOrderDecision', 'appendActivityLogEntry', 'normalizeCell'],
    [resolveDecision, (entry) => logs.push(entry), normalize]
  );
}

function evidenceFile(fileName, merchantIds) {
  return {
    fileName,
    rows: merchantIds.map((merchantId) => ({ merchantId, currency: 'CNY', accountKey: `${merchantId}\u0000CNY` }))
  };
}

function savedOrder(fileAccounts, assignments) {
  return {
    assignments,
    fileCount: fileAccounts.length,
    files: fileAccounts.map((merchantIds, fileIndex) => ({
      fileIndex,
      accountCount: merchantIds.length,
      accounts: merchantIds.map((merchantId) => ({ merchantId, currency: 'CNY' }))
    }))
  };
}

test('标准入口固定模式：同一多币种大账号的两份账单换了导入顺序时改为人工选择，不按位置预填币种', () => {
  const logs = [];
  const guard = loadSavedOrderGuard({
    mode: 'fixed',
    order: savedOrder([['7013'], ['7013']], [
      { rowIndex: 0, merchantId: '7013', currency: 'CNY' },
      { rowIndex: 1, merchantId: '7013', currency: 'USD' }
    ]),
    logs
  });
  const pendingContext = {
    templateId: '__FILENAME_MAPPING__',
    template: { name: '按文件名映射模板' },
    bigAccountOrderEvidence: { files: [evidenceFile('USD-7013.xls', ['7013']), evidenceFile('CNY-7013.xls', ['7013'])] }
  };
  const result = guard({ previewOnly: false }, pendingContext, { status: 'select-big-account' });
  assert.equal(result.forceMode, 'unfixed');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].details, ['模板名：按文件名映射模板', '涉及文件：USD-7013.xls、CNY-7013.xls']);
  // 预检阶段同样降级，但不重复写活动日志。
  const previewLogs = [];
  const previewGuard = loadSavedOrderGuard({ mode: 'fixed', order: savedOrder([['7013'], ['7013']], [
    { rowIndex: 0, merchantId: '7013', currency: 'CNY' },
    { rowIndex: 1, merchantId: '7013', currency: 'USD' }
  ]), logs: previewLogs });
  assert.equal(previewGuard({ previewOnly: true }, pendingContext, { status: 'select-big-account' }).forceMode, 'unfixed');
  assert.equal(previewLogs.length, 0);
});

test('标准入口固定模式：导入文件与记住的顺序逐个对上且顺序相同才保留预填，换序、个数不同、对不上都改为人工选择', () => {
  const order = savedOrder([['A001'], ['B001']], [
    { rowIndex: 0, merchantId: 'A001', currency: 'USD' },
    { rowIndex: 1, merchantId: 'B001', currency: 'EUR' }
  ]);
  const contextOf = (...files) => ({ templateId: '__FILENAME_MAPPING__', template: { name: 't' }, bigAccountOrderEvidence: { files } });
  const run = (mode, savedConfig, pendingContext) => loadSavedOrderGuard({ mode, order: savedConfig })(
    { previewOnly: true }, pendingContext, { status: 'select-big-account' }
  ).forceMode || null;
  const same = contextOf(evidenceFile('a.xls', ['A001']), evidenceFile('b.xls', ['B001']));
  assert.equal(run('fixed', order, same), null, '顺序相同');
  assert.equal(run('fixed', order, contextOf(evidenceFile('b.xls', ['B001']), evidenceFile('a.xls', ['A001']))), 'unfixed', '换序');
  assert.equal(run('fixed', order, contextOf(evidenceFile('a.xls', ['A001']))), 'unfixed', '文件个数不同');
  assert.equal(run('fixed', order, contextOf(evidenceFile('a.xls', ['A001']), evidenceFile('c.xls', ['C001']))), 'unfixed', '对不上');
  assert.equal(run('unfixed', order, contextOf(evidenceFile('b.xls', ['B001']), evidenceFile('a.xls', ['A001']))), null, '不固定模式不处理');
  assert.equal(run('fixed', { assignments: order.assignments }, contextOf(evidenceFile('b.xls', ['B001']))), null, '没有文件信息的旧顺序沿用原行为');
});

test('标准入口（按文件名映射）进入大账号选择的两处都经过记住顺序核对', () => {
  const source = functionSource('handleFilenameMappingImport');
  assert.equal(source.match(/applySavedBigAccountOrderGuard\(prepared, pendingContext, buildBigAccountSelectionRequiredResult\(/g).length, 2);
  assert.doesNotMatch(source, /return buildBigAccountSelectionRequiredResult\(/);
});
