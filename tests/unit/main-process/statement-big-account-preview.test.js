'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const {
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
const RENDERER_DIALOGS_PATH = path.join(ROOT, 'src', 'renderer-dialogs.js');
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
    ['normalizeCell'],
    [normalize]
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
    ['normalizeCell'],
    [normalize]
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
      loadFunction('findHeaderRowNumbersInRawRows', ['normalizeCell'], [normalize]),
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
    /const executeBusiness = \(taskContext\) => runWithStatementConfirmedSourceSnapshots\(/
  );
});

test('filename 多模板先完成全部稳定读取，再产生输出或 session 副作用', () => {
  let rebuildCount = 0;
  let outputCount = 0;
  let sessionMutationCount = 0;
  const generateGroups = loadFunction(
    'generateMultiTemplateGroupFiles',
    [
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
