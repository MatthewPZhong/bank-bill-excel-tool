'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const {
  buildExpectedHeaderCandidates,
  hasDetailExportRow,
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

// v3.2.16：rebuildMatchedTemplateFileEntries 用它把各文件的「币种未维护大账号」问题汇总后一次报错
const { mapEachCollectingCurrencyBigAccountIssues } = require('../../../src/backend/file-service/currency-big-account');

function functionSource(name) {
  const node = mainAst.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到函数：${name}`);
  return mainSource.slice(node.start, node.end);
}

function loadFunction(name, names = [], values = []) {
  // v3.2.22：identifyAccountBlocks 用纯函数 isHeaderOnlyDetailRows 判断原表只有表头，统一注入
  if (name === 'identifyAccountBlocks' && !names.includes('isHeaderOnlyDetailRows')) {
    return loadFunction(name, [...names, 'isHeaderOnlyDetailRows'], [...values, loadFunction('isHeaderOnlyDetailRows')]);
  }
  return Function(...names, `return (${functionSource(name)});`)(...values);
}

function loadEvidenceBuilder(names = [], values = []) {
  return loadFunction('buildBigAccountOrderEvidence', names, values);
}

test('v3.2.22 提取只按服务端不含无交易空段的 rows 选择，忽略空段行号', () => {
  const selectRows = loadFunction('selectPendingBigAccountRows');
  const context = {
    rows: [{ index: 0, fileName: 'A.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 0, fileName: 'A.xlsx' },
      { index: 1, fileName: 'A.xlsx' }
    ]
  };
  assert.deepEqual(selectRows(context, [0, 1]), context.rows);
  assert.deepEqual(selectRows(context, [1]), []);
  assert.equal(selectRows.length, 1, '不再接受 mode 参数');
});

test('前块空、后块有交易时证据按 per-file block ordinal 冻结 M001/M002，选择只列有交易的块', () => {
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
  const rowsWithEmptyBlocks = buildSelectionRows(fileEntries, { includeEmptyBlocks: true });
  const selectionRows = buildSelectionRows(fileEntries);
  assert.deepEqual(rowsWithEmptyBlocks.map((row) => row.fileBlockOrdinal), [0, 1]);
  assert.deepEqual(rowsWithEmptyBlocks.map((row) => row.sourceRowNumber), [11, 11]);
  assert.deepEqual(selectionRows.map((row) => row.fileBlockOrdinal), [1]);

  const buildEvidence = loadEvidenceBuilder(
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
    rows: selectionRows,
    rowsWithEmptyBlocks
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
    extract(storedPendingContext, selectionRows.map((row) => row.index)).accounts.map((account) => account.merchantId),
    ['M002']
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
  // 逐块桥接（大账号顺序证据逐块取）。
  const identifyBridges = (basis, options) => (Array.isArray(basis && basis.bridgeClearingIdsByBlock)
    ? basis.bridgeClearingIdsByBlock.map((_clearingId, blockOrdinal) => findBridge(basis, options, blockOrdinal))
    : []);
  const expandedOptions = [
    { merchantId: 'M001', currency: 'USD' },
    { merchantId: 'M002', currency: 'EUR' }
  ];
  const buildEvidence = loadEvidenceBuilder(
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
    extract(pendingContext, [0, 1]).accounts.map((account) => account.merchantId),
    ['M001', 'M002']
  );
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
  const buildMultiCurrencyEvidence = loadEvidenceBuilder(
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
  assert.deepEqual(extract(multiCurrencyContext, [0]), {
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
    extract(incompleteContext, [0, 1]),
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
  const buildEvidence = loadEvidenceBuilder(
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
  assert.deepEqual(extract(pendingContext, [0, 1]), {
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
  assert.deepEqual(extract(context, [0]), {
    status: 'ok',
    accounts: [{
      merchantId: 'M001',
      currency: 'USD',
      matchType: 'exact',
      fileName: 'A.xlsx'
    }],
    ambiguousCurrencyFiles: ['A.xlsx']
  });
  assert.deepEqual(extract(context, [1]), {
    status: 'error',
    failedRows: [{ index: 1, fileName: 'A.xlsx' }]
  });
  context.bigAccountOrderEvidence.sessionId = 'stale';
  assert.match(extract(context, [0]).message, /已失效/);
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
  const buildEvidence = loadEvidenceBuilder(
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
  assert.deepEqual(extract(context, [0, 1, 2, 3]), {
    status: 'ok',
    accounts: [
      { merchantId: 'FTN7013', currency: 'CNY', matchType: 'fuzzy', fileName: 'CNY-7013.xls' },
      { merchantId: 'FTN7013', currency: 'CNY', matchType: 'fuzzy', fileName: 'USD-7013.xls' },
      { merchantId: 'NRA2268', currency: 'CNY', matchType: 'fuzzy', fileName: 'CNY-2268.xls' },
      { merchantId: 'M001', currency: 'USD', matchType: 'fuzzy', fileName: 'USD-M001.xls' }
    ],
    ambiguousCurrencyFiles: ['CNY-7013.xls', 'USD-7013.xls']
  });
  // 只提取单币种账号时不追加多余提醒。
  assert.deepEqual(extract(context, [2, 3]), {
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

  const buildEvidence = loadEvidenceBuilder(
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
  assert.equal(extract(extractionContext, [0, 1, 2]).accounts.length, 3);
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
  // v3.2.15：生成分组改为按渠道 / 模板；这里的模板都不属于渠道，按模板各自成组（模板都存在）。
  const groupStatementEntriesForGeneration = loadFunction(
    'groupStatementEntriesForGeneration',
    ['database', 'resolveGenerationGroupKey', 'getTemplateMappingConfig'],
    [{ getTemplate: (id) => ({ id, channelId: null }) }, resolveGenerationGroupKey, (id) => ({ template: { id }, exportMappings: [], exportTargetFields: [] })]
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
      'generateStatementFiles',
      'assertStatementBatchWritable',
      'FileValidationError',
      'isAllTransactionsSkippedByBackfill'
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
      () => { outputCount += 1; return {}; },
      () => {},
      require('../../../src/backend/file-service').FileValidationError,
      loadFunction('isAllTransactionsSkippedByBackfill', ['hasDetailExportRow'], [hasDetailExportRow])
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
  const buildRequired = loadFunction(
    'buildBigAccountSelectionRequiredResult',
    ['normalizeCell', 'expandBigAccountConfigurations'],
    [normalizeCell, () => []]
  );
  const result = buildPreview(buildRequired({
    rows: [{ index: 3, fileName: 'A.xlsx', filePath: '/private/source.xlsx' }],
    bigAccounts: [],
    templateId: 1
  }), 'opaque-context');
  assert.equal(result.contextId, 'opaque-context');
  assert.equal(Object.hasOwn(result.rows[0], 'filePath'), false);
  // v3.2.22：账号顺序固定已去掉，选择结果不再下发含空段的行
  assert.equal(Object.hasOwn(result, 'rowsWithEmptyBlocks'), false);
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
      'buildMappedRowsForFile',
      'mapEachCollectingCurrencyBigAccountIssues',
      'dropIssuesOverriddenBySelectedBigAccount'
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
      () => { throw new Error('reuseMappedRows 不得重新解析文件'); },
      mapEachCollectingCurrencyBigAccountIssues,
      loadFunction('dropIssuesOverriddenBySelectedBigAccount')
    ]
  );
  const sourceRows = [
    ['MerchantId', 'Currency', 'Amount'],
    ['', '', 10],
    ['', '', 20]
  ];
  // v3.2.21 B112：只写进币种列的长数字来源随币种被覆盖去掉，其余来源保留
  sourceRows.issues = [
    { type: 'currency-unmapped', rawValue: '美元' },
    { type: 'date-invalid', rawValue: 'bad-date' },
    { type: 'long-number-unverified', rowNumber: 2, cells: [{ sourceField: '原字段', digitCount: 19, targetFields: ['Currency'] }] },
    { type: 'long-number-unverified', rowNumber: 3, cells: [
      { sourceField: '原字段', digitCount: 19, targetFields: ['Currency'] },
      { sourceField: '金额', digitCount: 16 }
    ] }
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
    { type: 'date-invalid', rawValue: 'bad-date' },
    { type: 'long-number-unverified', rowNumber: 3, cells: [{ sourceField: '金额', digitCount: 16 }] }
  ]);
  assert.equal(sourceRows.issues.length, 4, '不得修改 prepare 缓存告警');
  assert.equal(sourceRows.issues[3].cells.length, 2, '不得修改 prepare 缓存告警的来源');
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
      'buildMappedRowsForFile',
      'mapEachCollectingCurrencyBigAccountIssues'
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
      },
      mapEachCollectingCurrencyBigAccountIssues
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

test('大账号顺序提取只消费预检冻结 evidence，不重读源文件', () => {
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
});

// v3.2.20：原收单导入 peek 用例随收单单据币种校验下线删除，保留通用预览源文件新鲜度守卫断言。
test('预览源文件新鲜度守卫：探测期间源文件变更会在建立覆盖上下文前被拒绝', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-source-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'source.xlsx');
  fs.writeFileSync(inputPath, 'before', 'utf8');
  const guard = loadFunction(
    'createPreviewSourceFreshnessGuard',
    ['path', 'sourceSnapshotFromStat', 'fs', 'sourceSnapshotMatchesStat'],
    [path, sourceSnapshotFromStat, fs, sourceSnapshotMatchesStat]
  )([inputPath], '账单导入');
  guard();
  fs.writeFileSync(inputPath, 'after-peek-is-longer', 'utf8');
  assert.throws(guard, /源文件在确认期间已变化/);
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
  // v3.2.22：账号顺序固定已去掉，不再提交 mode / rememberOrder
  assert.doesNotMatch(activeCompleteCall[1], /\bmode\s*:|rememberOrder/);
  assert.doesNotMatch(activeCompleteCall[1], /fileRows\s*:|filePath\s*:/);
  assert.doesNotMatch(extractCall[1], /\bmode\s*:/);

  assert.doesNotMatch(rendererSource, /bigAccount\.(?:loadMode|saveMode|loadOrder|saveOrder)/);

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'")
  );
  assert.match(completeHandler, /requirePendingBigAccountSelection\(contextId\)/);
  assert.match(
    completeHandler,
    /clearPendingBigAccountSelection\(prepared\.contextId\);[\s\S]*?const \{ normalizedAssignments \} = prepared/
  );
  assert.doesNotMatch(completeHandler, /isFixedMode|rememberOrder|persistBigAccountOrderAfterGeneration|includeEmptyBlocks/);
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
      // v3.2.19：重复账单过滤（本用例没有重复账单，原样放行）；业务入口的配置核对（prepared 没有核对函数时放行）
      statementDuplicateReview: { clear: () => {} },
      checkImportConfigGuard: () => null,
      IMPORT_CONFIG_CHANGED_MESSAGE: '导入期间模板、渠道或账户映射已修改，请重新导入文件',
      DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE: '等待确认期间模板、渠道或账户映射已修改，请重新导入文件',
      applyConfirmedDuplicateRowFilter: (entries) => ({ entries }),
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
    const result = await execute(null, { contextId, normalizedAssignments: [] }, {
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

function constValue(name) {
  const node = mainAst.body.find((item) => (
    item.type === 'VariableDeclaration' && item.declarations.some((declaration) => declaration.id.name === name)
  ));
  if (!node) throw new Error(`未找到常量：${name}`);
  const declaration = node.declarations.find((item) => item.id.name === name);
  return Function(`return (${mainSource.slice(declaration.init.start, declaration.init.end)});`)();
}

test('v3.2.22 进入大账号选择的各处直接返回选择结果，不再读取或套用记住的模式 / 顺序', () => {
  const importHandlerSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.equal(importHandlerSource.match(/return buildBigAccountSelectionRequiredResult\(/g).length, 3);
  assert.equal(functionSource('handleFilenameMappingImport').match(/return buildBigAccountSelectionRequiredResult\(/g).length, 2);
  assert.doesNotMatch(
    mainSource,
    /applySavedBigAccountOrderGuard|readBigAccountMode|readBigAccountOrder|writeBigAccountOrder|big-account-(?:mode|order)-store|remember-order-mismatch|forceMode/
  );
});

// 运行真实的指定模板导入 execute（预检）：模板配置、活动日志为替身，
// 大账号分块、证据、识别与选择结果取 main.js 及识别模块的真实实现。
function loadDesignatedImportExecute({ templateConfig, logs, overrides = {} }) {
  const scope = new Map();
  const proxy = new Proxy({}, {
    has: (_target, key) => scope.has(key),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : scope.get(key)),
    set: (_target, key, value) => { scope.set(key, value); return true; }
  });
  const evaluate = (source) => Function('scope', `with (scope) { return (${source}); }`)(proxy);
  const recognition = require('../../../src/main-process/big-account-recognition');
  const { normalizeCell } = require('../../../src/backend/file-service');
  Object.entries({
    ...recognition,
    normalizeCell,
    hasDetailExportRow,
    path,
    isFilenameMappingMode: () => false,
    fileImportInProgress: false,
    getTemplateMappingConfig: () => templateConfig,
    statementImportSessionForInvocation: () => ({ key: 'session' }),
    ensureStorageRoot: () => '/storage',
    appendActivityLogEntry: (entry) => logs.push(entry),
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    createPreflightErrorResult: (payload) => ({ status: 'error', ...payload }),
    FileValidationError: require('../../../src/backend/file-service').FileValidationError,
    STATEMENT_SOURCE_FRESHNESS_FAILURE: Object.freeze({ code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE', message: '源文件已变化' }),
    // 合入渠道后，指定模板导入在大账号流程前还核对库里的输出名称；本测试的模板无同名所有者，直接放行。
    findGenerationGroupOutputNameConflicts: () => null,
    resolveGenerationGroupKey: (template) => `template:${template.id}`,
    // v3.2.19：重复账单过滤——本测试的模板未勾选（条目没有源行指纹）
    hasDuplicateRowKeys: require('../../../src/main-process/statement-duplicate-review').hasSourceRowKeys,
    isDuplicateRowFilterEnabled: () => false,
    // v3.2.21：跨 Sheet 回填全部跳过时按没有交易数据返回（逐行原因按「行号:原因」简写）
    archiveOperationContext: { getStore: () => null },
    buildImportWarningDetailLines: (warnings) => warnings.map((warning) => `${warning.rowNumber}:${warning.reason}`),
    MERCHANT_ID_SELF_INPUT_OPTION: constValue('MERCHANT_ID_SELF_INPUT_OPTION'),
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: constValue('MERCHANT_ID_MULTI_ACCOUNT_MARKER'),
    FIXED_FIELD_VALUE_PREFIX: require('../../../src/backend/file-service').FIXED_FIELD_VALUE_PREFIX,
    STATEMENT_IMPORT_PREVIEW_READY: constValue('STATEMENT_IMPORT_PREVIEW_READY'),
    // 只探测原表是否有数据行时（probeSourceFilesHeaderOnly）用真实读取；文件变更检查由各用例按需替换
    readRowsWithMetadata: require('../../../src/backend/file-service').readRowsWithMetadata,
    normalizeInputFilePaths: require('../../../src/main-process/statement-session').normalizeInputFilePaths,
    createStatementWorkbookReadGuard: () => undefined
  }).forEach(([name, value]) => scope.set(name, value));
  [
    'expandBigAccountConfigurations', 'isHeaderOnlyDetailRows', 'identifyAccountBlocks', 'buildBigAccountSelectionRows',
    'findBigAccountMatchInRows', 'identifyAccountsFromRecognitionBasis', 'findSelfInputBigAccountBridge',
    'buildBigAccountOrderEvidence', 'createPendingBigAccountSelectionContext',
    'stagePendingBigAccountSelection', 'buildBigAccountSelectionRequiredResult', 'statementImportPreviewReady',
    'createNoTransactionDataResult', 'allEntriesHeaderOnly', 'isMultiBigAccountMapping', 'usesBigAccountMerchantMapping',
    'probeSourceFilesHeaderOnly', 'isAllTransactionsSkippedByBackfill', 'collectCrossSheetBackfillWarnings', 'createNoTransactionDataErrorResult'
  ].forEach((name) => scope.set(name, evaluate(functionSource(name))));
  Object.entries(overrides).forEach(([name, value]) => scope.set(name, value));
  let handlerNode = null;
  (function visit(node) {
    if (!node || typeof node !== 'object' || handlerNode) return;
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === 'fileImportHandler') {
      handlerNode = node.init;
      return;
    }
    Object.values(node).forEach((value) => (Array.isArray(value) ? value.forEach(visit) : visit(value)));
  })(mainAst);
  const handler = evaluate(mainSource.slice(handlerNode.start, handlerNode.end));
  return (prepared, taskContext = null) => handler.execute(null, prepared, taskContext, 7);
}

// 两个块的明细：headerBreaks 把第 10 行前后分为两块，rows 给出每块是否有交易。
function twoBlockEntry(fileName, { firstHasTransaction, basis, selfInput = false }) {
  const detailRows = firstHasTransaction
    ? [['Credit Amount', 'Debit Amount'], ['', '100'], ['', '200']]
    : [['Credit Amount', 'Debit Amount'], ['', '200']];
  detailRows.rowMetas = firstHasTransaction ? [{ sourceRowNumber: 3 }, { sourceRowNumber: 11 }] : [{ sourceRowNumber: 11 }];
  detailRows.headerBreaks = [10];
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', { enumerable: false, value: basis });
  return {
    filePath: path.resolve(`/private/${fileName}`),
    detailRows,
    ...(selfInput ? { selfInputMerchant: true, skipDirectMerchantLookup: true } : {})
  };
}

function designatedTemplateConfig(bigAccounts, merchantMappedField = 'Account') {
  return {
    template: { id: 7, name: '指定模板', headers: ['Credit Amount', 'Debit Amount'], channelId: null },
    exportMappings: [{ templateField: 'MerchantId', mappedField: merchantMappedField }],
    exportTargetFields: [],
    bigAccounts,
    fixedAssignments: []
  };
}

function designatedPrepared(entries) {
  return {
    previewOnly: true,
    inputFilePaths: entries.map((entry) => entry.filePath),
    selectionResult: { filePaths: entries.map((entry) => entry.filePath), parentProvisionalEntries: entries }
  };
}

const UNIDENTIFIED_BASIS = Object.freeze({
  version: 1,
  headerWindows: [{ headerRowNumber: 2, candidateRows: [['无账号']] }, { headerRowNumber: 10, candidateRows: [['无账号']] }],
  bridgeClearingIdsByBlock: ['', '']
});

test('v3.2.22 指定模板入口：有交易但未识别账号的块直接进入手动选择，只列有交易的块，不带 forceMode / 空段行', async () => {
  const bigAccounts = [{ merchantId: 'M001', currencies: ['USD', 'EUR'], isMultiCurrency: true }];
  const logs = [];
  const execute = loadDesignatedImportExecute({ templateConfig: designatedTemplateConfig(bigAccounts), logs });
  const result = await execute(designatedPrepared([twoBlockEntry('m.xls', { firstHasTransaction: true, basis: UNIDENTIFIED_BASIS })]));
  assert.equal(result.status, 'select-big-account');
  assert.equal(result.rows.length, 2);
  assert.equal(Object.hasOwn(result, 'forceMode'), false);
  assert.equal(Object.hasOwn(result, 'rowsWithEmptyBlocks'), false);
  assert.deepEqual(logs, []);

  // 前块无交易：选择窗口只列有交易的后块
  const emptyFirstResult = await loadDesignatedImportExecute({ templateConfig: designatedTemplateConfig(bigAccounts), logs: [] })(
    designatedPrepared([twoBlockEntry('m.xls', { firstHasTransaction: false, basis: UNIDENTIFIED_BASIS })])
  );
  assert.equal(emptyFirstResult.status, 'select-big-account');
  assert.equal(emptyFirstResult.rows.length, 1);
});

test('v3.2.22 指定模板入口：多个大账号时即使自定义输入 MerchantId 全部桥接到，也按不固定口径进入手动选择', async () => {
  const logs = [];
  const bigAccounts = [
    { merchantId: 'A001', currencies: ['USD'], isMultiCurrency: false },
    { merchantId: 'B001', currencies: ['USD'], isMultiCurrency: false }
  ];
  const execute = loadDesignatedImportExecute({ templateConfig: designatedTemplateConfig(bigAccounts, '自己输入'), logs });
  const basis = Object.freeze({
    version: 1,
    headerWindows: [{ headerRowNumber: 2, candidateRows: [] }, { headerRowNumber: 10, candidateRows: [] }],
    bridgeClearingIdsByBlock: ['', 'B001']
  });
  const result = await execute(designatedPrepared([
    twoBlockEntry('b.xls', { firstHasTransaction: false, basis, selfInput: true })
  ]));
  assert.equal(result.status, 'select-big-account');
  assert.equal(result.rows.length, 1);
  assert.deepEqual(logs, []);
});

// 只有表头（没有任何数据行）的明细
function headerOnlyEntry(fileName, { selfInput = false } = {}) {
  const detailRows = [['Credit Amount', 'Debit Amount']];
  detailRows.rowMetas = [];
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', { enumerable: false, value: UNIDENTIFIED_BASIS });
  // 同 buildMappedRows：原表表头以下没有数据行
  Object.defineProperty(detailRows, 'sourceDataRowCount', { enumerable: false, value: 0 });
  return {
    filePath: path.resolve(`/private/${fileName}`),
    detailRows,
    ...(selfInput ? { selfInputMerchant: true, skipDirectMerchantLookup: true } : {})
  };
}

test('v3.2.22 指定模板入口：整批只有表头时各分流都报「没有交易数据」并保留上一批界面；混有交易文件时只为有交易的文件留位置', async () => {
  const single = [{ merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false }];
  const multiple = [
    { merchantId: 'A001', currencies: ['USD'], isMultiCurrency: false },
    { merchantId: 'B001', currencies: ['USD'], isMultiCurrency: false }
  ];
  const reachedDirectRecognition = [];
  const run = (bigAccounts, merchantMappedField, entries) => loadDesignatedImportExecute({
    templateConfig: designatedTemplateConfig(bigAccounts, merchantMappedField),
    logs: [],
    overrides: {
      resolvePreparedDirectBigAccountRecognition: () => {
        reachedDirectRecognition.push(merchantMappedField);
        return { status: 'failed', code: 'REACHED_DIRECT_RECOGNITION' };
      },
      createBigAccountRecognitionErrorResult: (resolution) => ({ status: 'error', errorCode: resolution.code })
    }
  })(designatedPrepared(entries));
  const MULTI = '__FIXED__:__MULTI_BIG_ACCOUNT__';
  const cases = [
    ['多大账号映射、一个候选账号（直接识别前拦截，不误报未识别到大账号）', single, MULTI, [headerOnlyEntry('a.xls')]],
    ['多大账号映射、没有候选账号（只维护了自有账号）', [], MULTI, [headerOnlyEntry('a.xls')]],
    ['自己输入 MerchantId、一个候选账号', single, '自己输入', [headerOnlyEntry('a.xls', { selfInput: true })]],
    ['自己输入 MerchantId、两个文件都只有表头', single, '自己输入',
      [headerOnlyEntry('a.xls', { selfInput: true }), headerOnlyEntry('b.xls', { selfInput: true })]],
    ['多个候选账号', multiple, 'Account', [headerOnlyEntry('a.xls'), headerOnlyEntry('b.xls')]]
  ];
  for (const [label, bigAccounts, field, entries] of cases) {
    const result = await run(bigAccounts, field, entries);
    assert.deepEqual([result.status, result.errorCode, result.message, result.preservesSession],
      ['error', 'NO_TRANSACTION_DATA', '导入文件中没有账号存在交易数据', true], label);
  }

  assert.deepEqual(reachedDirectRecognition, [], '整批只有表头时不进入直接识别');
  // MerchantId 取自源列的普通映射、一个候选账号：不按只有表头拦截，沿用原流程（进入直接识别）
  const sourceColumn = await run(single, 'Account', [headerOnlyEntry('a.xls')]);
  assert.equal(sourceColumn.errorCode, 'REACHED_DIRECT_RECOGNITION');
  assert.deepEqual(reachedDirectRecognition, ['Account']);

  const mixed = await run(multiple, 'Account', [
    headerOnlyEntry('empty.xls'),
    twoBlockEntry('m.xls', { firstHasTransaction: true, basis: UNIDENTIFIED_BASIS })
  ]);
  assert.equal(mixed.status, 'select-big-account');
  assert.deepEqual(mixed.rows.map((row) => row.fileName), ['m.xls', 'm.xls']);
});

test('v3.2.22 指定模板、多大账号映射但没有候选大账号（只维护了自有账号）：只逐文件探测原表是否有数据、不映射不缓存，生成仍走原路径校验大账号', async (t) => {
  const { FileValidationError, readRowsWithMetadata } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
  const MULTI = '__FIXED__:__MULTI_BIG_ACCOUNT__';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designated-header-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const HEADERS = ['Credit Amount', 'Debit Amount'];
  const writeBook = (name, rows) => {
    const filePath = path.join(dir, name);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    XLSX.writeFile(workbook, filePath);
    return filePath;
  };
  const dataFile = writeBook('t.xlsx', [HEADERS, ['', 100]]);
  const headerOnlyFile = writeBook('h.xlsx', [HEADERS]);
  const otherHeaderFile = writeBook('x.xlsx', [['别的表头'], ['1']]);
  const calls = [];
  const readOptions = [];
  const execute = (overrides = {}) => loadDesignatedImportExecute({
    templateConfig: designatedTemplateConfig([], MULTI),
    logs: [],
    overrides: {
      // 只探测：记下读了哪些文件，不应映射
      readRowsWithMetadata: (filePath, headers, options) => {
        calls.push(`read:${path.basename(filePath)}`);
        readOptions.push(options);
        return readRowsWithMetadata(filePath, headers, options);
      },
      createStatementWorkbookReadGuard: (filePath) => { calls.push(`guard:${path.basename(filePath)}`); return undefined; },
      buildPendingBigAccountFileEntries: () => { calls.push('pre-map'); throw new Error('不应映射整批明细'); },
      checkImportConfigGuard: () => null,
      IMPORT_CONFIG_CHANGED_MESSAGE: '',
      DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE: '',
      bindStatementImportPreparedToFileEvidence: (value) => value,
      appendLog: (_root, error) => { throw error; },
      statementDuplicateReview: { clear: () => {} },
      clearGeneratedExports: () => {},
      clearPendingManualBalancePrompt: () => {},
      clearPendingBigAccountSelection: () => {},
      // 原路径：未选定大账号时按原口径拒绝
      prepareGeneratedFiles: () => {
        calls.push('prepareGeneratedFiles');
        throw new FileValidationError('BIG_ACCOUNT_REQUIRED_STUB', '请先选择大账号');
      },
      // 复用分支（放宽了受管大账号校验）不应到达
      buildPreparedStatementBatchFromEntries: () => { calls.push('reuse'); return {}; },
      ...overrides
    }
  });
  const prepared = (previewOnly, filePaths) => ({
    previewOnly,
    inputFilePaths: filePaths,
    selectionResult: { filePaths, replacePaths: [] }
  });
  const taskContext = { fileEvidence: { filePlan: { inputs: [] } } };

  // 第一份文件有数据：只读这一份即停止，后面的文件不读；预检不缓存预映射条目
  const preview = prepared(true, [dataFile, headerOnlyFile, headerOnlyFile]);
  const previewResult = await execute()(preview);
  assert.equal(previewResult.status, constValue('STATEMENT_IMPORT_PREVIEW_READY'));
  assert.deepEqual(calls, ['guard:t.xlsx', 'read:t.xlsx'], '见到第一份有数据的文件即停止，不映射');
  assert.equal(preview.selectionResult.parentProvisionalEntries, undefined, '预检不缓存预映射条目');
  assert.equal(preview.selectionResult.sourceRowsChecked, true);
  assert.ok(readOptions.every((options) => !options.exactSourceText && !options.includeFullRows), '只数行，不还原长数字原文');

  calls.length = 0;
  const generated = await execute()(prepared(false, [headerOnlyFile, dataFile]), taskContext);
  assert.deepEqual([generated.status, generated.errorCode], ['error', 'BIG_ACCOUNT_REQUIRED_STUB']);
  assert.deepEqual(calls, ['guard:h.xlsx', 'read:h.xlsx', 'guard:t.xlsx', 'read:t.xlsx', 'prepareGeneratedFiles'],
    '执行走原路径，不复用预映射条目');

  // 预检后执行（同一份 prepared）：预检已确认有数据行，只记结论，执行阶段不再读取
  const handedOff = prepared(true, [dataFile]);
  const run = execute();
  await run(handedOff);
  handedOff.previewOnly = false;
  calls.length = 0;
  const afterPreview = await run(handedOff, taskContext);
  assert.equal(afterPreview.errorCode, 'BIG_ACCOUNT_REQUIRED_STUB');
  assert.deepEqual(calls, ['prepareGeneratedFiles'], '不为同一结论再读取一遍');

  // 整批只有表头时照常拦截
  calls.length = 0;
  const headerOnly = await execute()(prepared(true, [headerOnlyFile, headerOnlyFile]));
  assert.deepEqual([headerOnly.errorCode, headerOnly.preservesSession], ['NO_TRANSACTION_DATA', true]);
  assert.deepEqual(calls.filter((call) => call.startsWith('read:')), ['read:h.xlsx', 'read:h.xlsx']);

  // 表头定位失败（FileValidationError）时无法判断，不在拦截处报错，交给原路径
  calls.length = 0;
  const unmatched = await execute()(prepared(false, [headerOnlyFile, otherHeaderFile, dataFile]), taskContext);
  assert.deepEqual([unmatched.errorCode, calls.filter((call) => !call.startsWith('guard:'))],
    ['BIG_ACCOUNT_REQUIRED_STUB', ['read:h.xlsx', 'read:x.xlsx', 'prepareGeneratedFiles']]);

  // 源文件在确认期间变化：照常抛出，不进入原路径
  calls.length = 0;
  const freshnessError = Object.assign(new Error('源文件已变化'), { code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE' });
  await assert.rejects(
    execute({ readRowsWithMetadata: () => { throw freshnessError; } })(prepared(false, [dataFile]), taskContext),
    (error) => error === freshnessError
  );
  assert.deepEqual(calls.filter((call) => call === 'prepareGeneratedFiles'), []);
});

test('v3.2.22 按文件名映射入口：混合模式检查、直接识别与手动选择之前先拦截整批只有表头的导入', () => {
  const source = functionSource('handleFilenameMappingImport');
  const guard = source.indexOf('if (needsBigAccountMerchant && allEntriesHeaderOnly(trimmedProvisionalEntries))');
  assert.match(source, /const needsBigAccountMerchant = bigAccountOptions\.length > 1 \|\| trimmedProvisionalEntries\.some\(/);
  assert.match(source, /usesBigAccountMerchantMapping\(entryConfig && entryConfig\.exportMappings\)/, '按命中模板的 MerchantId 映射模式判断，普通源列映射不拦截');
  assert.ok(guard > 0);
  assert.ok(guard < source.indexOf('return createCurrencyOnlyMixedSelectionErrorResult('), '早于混合模式拒绝（混合拒绝不保留上一批界面）');
  assert.ok(guard < source.indexOf('resolveDirectBigAccountRecognition('));
  assert.ok(guard < source.indexOf('buildBigAccountSelectionRows('));
  assert.doesNotMatch(source, /errorCode: 'NO_TRANSACTION_DATA'/, '没有交易数据统一经 createNoTransactionDataResult（预检时保留上一批界面）');
  // v3.2.21 跨 Sheet 回填带逐行原因的结果另行构造（不保留上一批界面，状态框可查看逐行原因），由 createNoTransactionDataResult 按条目转交
  const ownBuilders = ['createNoTransactionDataResult', 'createNoTransactionDataErrorResult', 'createBackfillEmptiedGroupsErrorResult'];
  assert.doesNotMatch(ownBuilders.reduce((text, name) => text.replace(functionSource(name), ''), mainSource), /errorCode: 'NO_TRANSACTION_DATA'/);
});

test('v3.2.22 MerchantId 由大账号决定的映射：保存的多大账号标记与「自己输入」都算，源列与仅有币种不算', () => {
  const normalize = (value) => String(value == null ? '' : value).trim();
  const isMulti = loadFunction('isMultiBigAccountMapping', ['normalizeCell', 'FIXED_FIELD_VALUE_PREFIX', 'MERCHANT_ID_MULTI_ACCOUNT_MARKER'],
    [normalize, '__FIXED__:', constValue('MERCHANT_ID_MULTI_ACCOUNT_MARKER')]);
  const uses = loadFunction('usesBigAccountMerchantMapping', ['isMultiBigAccountMapping', 'normalizeCell', 'MERCHANT_ID_SELF_INPUT_OPTION'],
    [isMulti, normalize, constValue('MERCHANT_ID_SELF_INPUT_OPTION')]);
  const merchant = (mappedField) => [{ templateField: 'Currency', mappedField: 'Curr' }, { templateField: 'MerchantId', mappedField }];
  assert.equal(uses(merchant('__FIXED__:__MULTI_BIG_ACCOUNT__')), true);
  assert.equal(uses(merchant('自己输入')), true);
  assert.equal(uses(merchant('Account')), false);
  assert.equal(uses(merchant(require('../../../src/backend/file-service').MERCHANT_ID_CURRENCY_ONLY_MARKER)), false);
  assert.equal(uses(merchant('__FIXED__:M001')), false);
  assert.equal(uses(undefined), false);
});

test('v3.2.22 直接识别大账号：混合批次中原表只有表头的文件不参与识别，不让整批报未识别到大账号', () => {
  const identified = [];
  const recognize = loadFunction('resolveDirectBigAccountRecognition', [
    'expandBigAccountConfigurations', 'uniqueNormalizedValues', 'getEntryTemplateConfig', 'isMultiBigAccountMapping',
    'path', 'identifyAccountsFromFile', 'resolveRecognizedBigAccount', 'normalizeCell', 'isHeaderOnlyDetailRows'
  ], [
    (accounts) => accounts.flatMap((account) => account.currencies.map((currency) => ({ merchantId: account.merchantId, currency }))),
    (values) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))],
    ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
    () => true,
    path,
    ({ filePath }) => {
      identified.push(path.basename(filePath));
      return { accounts: path.basename(filePath) === 'with-account.xls' ? [{ merchantId: 'M001' }] : [] };
    },
    ({ extractedMerchantId }) => (extractedMerchantId
      ? { status: 'ok', selectedBigAccount: { merchantId: extractedMerchantId, currency: 'USD' } }
      : { status: 'failed', code: 'BIG_ACCOUNT_NOT_RECOGNIZED' }),
    (value) => String(value == null ? '' : value).trim(),
    loadFunction('isHeaderOnlyDetailRows')
  ]);
  const withAccount = twoBlockEntry('with-account.xls', { firstHasTransaction: true, basis: UNIDENTIFIED_BASIS });
  const args = (fileEntries) => ({
    fileEntries,
    maintainedBigAccounts: [{ merchantId: 'M001', currencies: ['USD'] }],
    fallbackTemplateConfig: { exportMappings: [], template: { headers: [] } },
    templateName: '指定模板'
  });
  assert.deepEqual(recognize(args([headerOnlyEntry('empty.xls'), withAccount])),
    { status: 'ok', selectedBigAccount: { merchantId: 'M001', currency: 'USD' } });
  assert.deepEqual(identified, ['with-account.xls'], '只有表头的文件不读取识别');
  // 有数据但识别不到账号的文件照旧报未识别
  identified.length = 0;
  assert.equal(recognize(args([twoBlockEntry('no-account.xls', { firstHasTransaction: true, basis: UNIDENTIFIED_BASIS }), withAccount])).code,
    'BIG_ACCOUNT_NOT_RECOGNIZED');
});

test('v3.2.19 原始账单预处理：上一段被过滤掉的交易行不作为下一段的账号桥接候选', () => {
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
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  // 第二段表头前没有「银行账号」说明行；第一段最后一笔（第 4 行，本方账号 BANK1）被预处理过滤掉
  const provisionalBasis = buildBasis({
    rawRows: [
      ['银行账号', 'BANK1'],
      ['Date', 'Amount', 'Account'],
      ['2026-08-01', '1', 'BANK1'],
      ['2026-08-01', '9', 'BANK1'],
      ['Date', 'Amount', 'Account'],
      ['2026-08-02', '2', 'BANK2']
    ],
    expectedSourceHeaders: ['Date', 'Amount', 'Account'],
    accountMappingByBankId: { BANK1: { clearingAccountId: 'M001' }, BANK2: { clearingAccountId: 'M002' } }
  });
  const mappedRows = (preprocessRowFilterStats) => {
    const rows = [['Credit Amount', 'Debit Amount'], ['1', ''], ['2', '']];
    rows.rowMetas = [{ sourceRowNumber: 3 }, { sourceRowNumber: 6 }];
    rows.headerBreaks = [5];
    if (preprocessRowFilterStats) rows.preprocessRowFilterStats = preprocessRowFilterStats;
    return rows;
  };
  // 不带被过滤交易行信息时，第 4 行会被当成第二段的账号说明（M001）
  assert.deepEqual(finalizeBasis(provisionalBasis, mappedRows(null)).bridgeClearingIdsByBlock, ['M001', 'M001']);
  // 被过滤的交易行仍算作第一段：第二段没有可用的账号说明，不桥接
  assert.deepEqual(finalizeBasis(provisionalBasis, mappedRows({
    enabled: true, totalRows: 3, keptRows: 2, droppedTransactionRowNumbers: [4]
  })).bridgeClearingIdsByBlock, ['M001', '']);
});

test('v3.2.19 原始账单预处理 + 特征值日期：真实生成后，被过滤的说明行仍可作下一段的账号桥接', (t) => {
  const { buildFeatureFilterToken, buildMappedRows } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
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
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const headers = ['Date', 'Type', 'Amount'];
  // 第 4 行（冻结）是被过滤的交易行；第 5 行是第二段的账号说明（也被过滤，但不是交易行）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocess-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'two-blocks.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['银行账号', 'BANK1'],
    headers,
    ['2026-08-01', '交易', '1'],
    ['2026-08-01', '冻结', '9'],
    ['银行账号', 'BANK2'],
    headers,
    ['2026-08-02', '交易', '2']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  let provisionalBasis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: buildFeatureFilterToken('1'), 'Credit Amount': 'Amount' },
    featureFilters: { 1: { id: '1', name: '日期', sourceField: 'Date', separator: '', length: 10 } },
    expectedSourceHeaders: headers,
    preprocessRowFilterRules: [{ conditions: [{ field: 'Type', op: '等于', value: '交易' }] }],
    readOptions: {
      onWorkbookRows(rawRows) {
        provisionalBasis = buildBasis({
          rawRows,
          expectedSourceHeaders: headers,
          accountMappingByBankId: { BANK1: { clearingAccountId: 'M001' }, BANK2: { clearingAccountId: 'M002' } }
        });
      }
    }
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [3, 7]);
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedTransactionRowNumbers, [4]);
  assert.deepEqual(finalizeBasis(provisionalBasis, mapped).bridgeClearingIdsByBlock, ['M001', 'M002']);
});

test('v3.2.21 跨 Sheet 回填：因未能回填而跳过的交易行仍算作上一段，其中的账号不被当成下一段的账号', (t) => {
  const { buildMappedRows } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
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
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const headers = ['Date', 'Type', 'Desc', 'Amount', 'Account'];
  // 第 4 行（第一段最后一笔，本方账号 BANK1）是待回填行、来源 Sheet 没有 9 → 跳过；第 5 行是第二段的账号说明（被预处理过滤）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sheet-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'two-blocks.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['银行账号', 'BANK1'],
    headers,
    ['2026-08-01', '交易', 'x', '1', 'BANK1'],
    ['', '交易', 'Trade - $9', '9', 'BANK1'],
    ['银行账号', 'BANK2'],
    headers,
    ['2026-08-02', '交易', 'y', '2', 'BANK2']
  ]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit'], ['2026-08-01', 5]]), 'USD');
  XLSX.writeFile(workbook, filePath);
  let provisionalBasis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'Amount' },
    expectedSourceHeaders: headers,
    preprocessRowFilterRules: [{ conditions: [{ field: 'Type', op: '等于', value: '交易' }] }],
    crossSheetBackfillRule: {
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
      matchMode: 'amount',
      matchField: 'Desc',
      sourceMatchField: 'Credit',
      sourceDateOrder: 'auto',
      backfillFields: [{ targetField: 'Date', sourceField: 'Date' }]
    },
    readOptions: {
      onWorkbookRows(rawRows) {
        provisionalBasis = buildBasis({
          rawRows,
          expectedSourceHeaders: headers,
          accountMappingByBankId: { BANK1: { clearingAccountId: 'M001' }, BANK2: { clearingAccountId: 'M002' } }
        });
      }
    }
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [3, 7]);
  assert.deepEqual(mapped.crossSheetBackfillStats.skippedTransactionRowNumbers, [4]);
  const finalized = finalizeBasis(provisionalBasis, mapped);
  assert.deepEqual(finalized.bridgeClearingIdsByBlock, ['M001', 'M002']);
  // 直接匹配同一界线：第二段窗口不含第 4 行（跳过的交易行，含上一段账号 BANK1）及其之前的行
  assert.deepEqual(finalized.headerWindows.map((window) => window.candidateRows), [
    [['银行账号', 'BANK1']],
    [['银行账号', 'BANK2']]
  ]);
  assert.deepEqual(provisionalBasis.headerWindows[1].candidateRows.length, 3, '定稿前第二段窗口含上一段的行');
});

test('v3.2.21 跨 Sheet 回填：第二段表头前没有账号时，直接匹配不把上一段跳过的交易行中的账号当成第二段账号', (t) => {
  const { buildMappedRows } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
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
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const findMatch = loadFunction('findBigAccountMatchInRows', ['normalizeCell', 'matchMerchantIds'], [normalize, match]);
  const identify = loadFunction('identifyAccountsFromRecognitionBasis', ['findBigAccountMatchInRows'], [findMatch]);
  const headers = ['Date', 'Desc', 'Amount', 'Account'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sheet-direct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'two-blocks.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['账号', 'M001'],
    headers,
    ['2026-08-01', 'x', '1', 'M001'],
    ['', 'Trade - $9', '9', 'M001'],
    headers,
    ['2026-08-02', 'y', '2', '']
  ]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit'], ['2026-08-01', 5]]), 'USD');
  XLSX.writeFile(workbook, filePath);
  let provisionalBasis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'Amount' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: {
      sourceSheetName: 'USD',
      rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
      matchMode: 'amount',
      matchField: 'Desc',
      sourceMatchField: 'Credit',
      sourceDateOrder: 'auto',
      backfillFields: [{ targetField: 'Date', sourceField: 'Date' }]
    },
    readOptions: {
      onWorkbookRows(rawRows) {
        provisionalBasis = buildBasis({ rawRows, expectedSourceHeaders: headers });
      }
    }
  });
  assert.deepEqual(mapped.crossSheetBackfillStats.skippedTransactionRowNumbers, [4]);
  const allMerchantIds = ['M001', 'M002'];
  assert.deepEqual(identify({ basis: provisionalBasis, allMerchantIds }).matches.map((item) => (item ? item.merchantId : null)),
    ['M001', 'M001'], '定稿前：第二段窗口扫到上一段跳过行中的 M001');
  assert.deepEqual(identify({ basis: finalizeBasis(provisionalBasis, mapped), allMerchantIds }).matches.map((item) => (item ? item.merchantId : null)),
    ['M001', null], '定稿后：第二段没有可识别的账号，不误认上一段账号');
});

test('v3.2.21 跨 Sheet 回填：直接匹配窗口只以带发生额的交易行为界，被「过滤账单」过滤的说明行（有账期日期和下一段账号、收支为空）仍是下一段账号的候选', (t) => {
  const { buildMappedRows } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
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
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction(
    'finalizeBigAccountRecognitionBasis',
    ['identifyAccountBlocks', 'normalizeCell'],
    [identifyBlocks, normalize]
  );
  const findMatch = loadFunction('findBigAccountMatchInRows', ['normalizeCell', 'matchMerchantIds'], [normalize, match]);
  const identify = loadFunction('identifyAccountsFromRecognitionBasis', ['findBigAccountMatchInRows'], [findMatch]);
  const headers = ['Date', 'Type', 'Desc', 'Amount', 'Account'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocess-direct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'two-blocks.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['账号', 'M001'],
    headers,
    ['2026-08-01', '交易', 'x', '1', ''],
    ['2026-08-31', '说明', '账期', '', 'M002'],
    headers,
    ['2026-09-01', '交易', 'y', '2', '']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  let provisionalBasis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'Amount' },
    expectedSourceHeaders: headers,
    preprocessRowFilterRules: [{ conditions: [{ field: 'Type', op: '等于', value: '交易' }] }],
    readOptions: {
      onWorkbookRows(rawRows) {
        provisionalBasis = buildBasis({ rawRows, expectedSourceHeaders: headers });
      }
    }
  });
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedTransactionRowNumbers, [4]);
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedAmountRowNumbers, []);
  assert.deepEqual(identify({ basis: finalizeBasis(provisionalBasis, mapped), allMerchantIds: ['M001', 'M002'] }).matches
    .map((item) => (item ? item.merchantId : null)), ['M001', 'M002']);
});

test('v3.2.21 跨 Sheet 回填：被「过滤账单」排除、账单日期为空但带发生额的行同样是直接匹配窗口的界线，其中的上一段账号不当成下一段账号', (t) => {
  const { buildMappedRows } = require('../../../src/backend/file-service');
  const XLSX = require('xlsx');
  const normalize = (value) => String(value == null ? '' : value).trim();
  const match = (cell, merchantId) => normalize(cell) === normalize(merchantId) ? 'exact' : 'none';
  const findHeaders = loadFunction('findHeaderRowNumbersInRawRows', ['normalizeCell', 'buildExpectedHeaderCandidates'], [normalize, buildExpectedHeaderCandidates]);
  const buildBasis = loadFunction('buildBigAccountRecognitionBasis', ['findHeaderRowNumbersInRawRows', 'normalizeCell', 'matchMerchantIds'], [findHeaders, normalize, match]);
  const identifyBlocks = loadFunction('identifyAccountBlocks', ['normalizeCell'], [normalize]);
  const finalizeBasis = loadFunction('finalizeBigAccountRecognitionBasis', ['identifyAccountBlocks', 'normalizeCell'], [identifyBlocks, normalize]);
  const findMatch = loadFunction('findBigAccountMatchInRows', ['normalizeCell', 'matchMerchantIds'], [normalize, match]);
  const identify = loadFunction('identifyAccountsFromRecognitionBasis', ['findBigAccountMatchInRows'], [findMatch]);
  const headers = ['Date', 'Type', 'Desc', 'Amount', 'Account'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocess-amount-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'two-blocks.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['账号', 'M001'],
    headers,
    ['2026-08-01', '交易', 'x', '1', ''],
    ['', '冲正', 'y', '5', 'M001'],
    headers,
    ['2026-09-01', '交易', 'z', '2', '']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  let provisionalBasis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'Amount' },
    expectedSourceHeaders: headers,
    preprocessRowFilterRules: [{ conditions: [{ field: 'Type', op: '等于', value: '交易' }] }],
    readOptions: {
      onWorkbookRows(rawRows) {
        provisionalBasis = buildBasis({ rawRows, expectedSourceHeaders: headers });
      }
    }
  });
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedTransactionRowNumbers, [], '没有账单日期，不算桥接界线');
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedAmountRowNumbers, [4]);
  assert.deepEqual(identify({ basis: finalizeBasis(provisionalBasis, mapped), allMerchantIds: ['M001', 'M002'] }).matches
    .map((item) => (item ? item.merchantId : null)), ['M001', null]);
});

test('v3.2.21 跨 Sheet 回填：单个表头的账单全部交易都被回填跳过时，多大账号的完整预检入口按没有交易数据返回逐行原因，不要求为空分段选择账户', async () => {
  const execute = loadDesignatedImportExecute({
    templateConfig: designatedTemplateConfig([
      { merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false },
      { merchantId: 'M002', currencies: ['USD'], isMultiCurrency: false }
    ]),
    mode: 'unfixed',
    order: null,
    logs: []
  });
  const detailRows = [['Credit Amount', 'Debit Amount']];
  detailRows.rowMetas = [];
  detailRows.headerBreaks = [];
  detailRows.issues = [{ type: 'cross-sheet-backfill-skipped', rowNumber: 3, reason: 'no-source-row' }];
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', { enumerable: false, value: {
    version: 1, headerWindows: [{ headerRowNumber: 2, candidateRows: [] }], bridgeClearingIdsByBlock: ['']
  } });
  const result = await execute(designatedPrepared([{ filePath: path.resolve('/private/all-skipped.xlsx'), detailRows }]));
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'NO_TRANSACTION_DATA');
  assert.match(result.message, /「跨 Sheet 回填」跳过了1行/);
  assert.deepEqual(result.detailLines, ['3:no-source-row']);
});

test('v3.2.21 跨 Sheet 回填：大账号预检因没有交易数据提前返回时，失败报告带回填逐行跳过原因，活动日志用脱敏明细', () => {
  const buildLines = loadFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine', 'formatBalanceMismatchLine', 'formatBalanceSeedReplaceLine'],
    [String, String, String]
  );
  const calls = [];
  const collect = loadFunction('collectCrossSheetBackfillWarnings');
  const create = loadFunction(
    'createNoTransactionDataErrorResult',
    ['createErrorResult', 'buildImportWarningDetailLines', 'archiveOperationContext', 'collectCrossSheetBackfillWarnings'],
    [(options) => { calls.push(options); return { status: 'error' }; }, buildLines, { getStore: () => phase }, collect]
  );
  let phase = null;
  const entries = [{
    detailRows: Object.assign([['BillDate']], {
      issues: [
        { type: 'currency-unmapped', rowNumber: 2 },
        { type: 'cross-sheet-backfill-skipped', rowNumber: 4, reason: 'no-source-row', matchField: 'Desc', matchValue: 'ACC-SECRET', sourceFileName: 'a.xlsx' }
      ]
    })
  }];
  create(entries, '模板A');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].errorCode, 'NO_TRANSACTION_DATA');
  assert.match(calls[0].message, /「跨 Sheet 回填」跳过了1行/);
  assert.ok(calls[0].detailLines.some((line) => line.includes('ACC-SECRET')), '报错文件保留配对值');
  assert.ok(calls[0].logDetailLines.length > 0 && calls[0].logDetailLines.every((line) => !line.includes('ACC-SECRET')), '活动日志不含配对值');

  assert.match(calls[0].message, /请点击状态框导出报错文件核对/);
  // 导入预检阶段不生成报错文件：提示改为看弹窗（界面按 detailLines 逐行列出）
  phase = { phase: 'prepare' };
  create(entries, '模板A');
  assert.match(calls[1].message, /请点击状态框查看逐行原因/);
  phase = null;

  create([{ detailRows: [['BillDate']] }], '模板A');
  assert.deepEqual([calls[2].message, calls[2].detailLines, calls[2].logDetailLines], ['导入文件中没有账号存在交易数据', [], null]);
});

test('v3.2.21 统一错误出口：未显式传 logDetailLines 时，活动日志取 originalError 的脱敏明细，报错文件仍用完整明细', () => {
  const reports = [];
  const logs = [];
  const createErrorResult = loadFunction(
    'createErrorResult',
    ['archiveOperationContext', 'createPreflightErrorResult', 'createErrorReport', 'lastErrorReport', 'appendActivityLogEntry'],
    [{ getStore: () => null }, () => null, (options) => { reports.push(options); return { fileName: 'r.txt' }; }, null, (entry) => logs.push(entry)]
  );
  const originalError = { detailLines: ['第 4 行，Desc="ACC-SECRET"'], logDetailLines: ['第 4 行'] };
  createErrorResult({ step: '导入网银明细文件', message: 'x', detailLines: originalError.detailLines, originalError });
  assert.deepEqual(reports[0].detailLines, ['第 4 行，Desc="ACC-SECRET"']);
  assert.deepEqual(logs[0].details.slice(3), ['第 4 行']);

  createErrorResult({ step: '导入网银明细文件', message: 'x', detailLines: ['a'], originalError: new Error('plain') });
  assert.deepEqual(logs[1].details.slice(3), ['a'], '没有脱敏明细时同 detailLines');
  createErrorResult({ step: '导入网银明细文件', message: 'x', detailLines: ['a'], logDetailLines: ['b'], originalError });
  assert.deepEqual(logs[2].details.slice(3), ['b'], '显式传入时优先');
});

test('v3.2.21 跨 Sheet 回填：按文件名映射导出全部时，模板已删除、未纳入明细的组不导出回填文件；有缓存或其他范围时含全部条目', () => {
  const entries = [
    { filePath: '/in/a.xlsx', matchedTemplateId: 1, detailRows: Object.assign([['BillDate'], ['2026-09-25']], { crossSheetBackfillPatches: [{}], crossSheetBackfillSource: { sha256: 'a' } }) },
    { filePath: '/in/b.xlsx', matchedTemplateId: 2, detailRows: Object.assign([['BillDate'], ['2026-09-25']], { crossSheetBackfillPatches: [{}], crossSheetBackfillSource: { sha256: 'b' } }) }
  ];
  let cachedAllDetail = null;
  const collect = loadFunction(
    'collectCrossSheetBackfillExportItems',
    ['getStatementSessionEntries', 'isFilenameMappingMode', 'getGeneratedStatementExport', 'groupStatementEntriesForGeneration', 'hasDetailExportRow'],
    [
      () => entries,
      (templateId) => templateId === -1,
      () => cachedAllDetail,
      (list) => list.map((entry) => ({ entries: [entry], templateConfig: entry.matchedTemplateId === 1 ? {} : null })),
      hasDetailExportRow
    ]
  );
  const paths = (session, scope) => collect(session, scope).map((item) => item.sourceFilePath);
  assert.deepEqual(paths({ templateId: -1 }, 'all'), ['/in/a.xlsx'], '模板 2 已删除：明细跳过该组，回填文件同样不导出');
  assert.deepEqual(paths({ templateId: -1 }, 'current'), ['/in/a.xlsx', '/in/b.xlsx']);
  assert.deepEqual(paths({ templateId: 5 }, 'all'), ['/in/a.xlsx', '/in/b.xlsx']);
  cachedAllDetail = { filePath: '/out/all.xlsx' };
  assert.deepEqual(paths({ templateId: -1 }, 'all'), ['/in/a.xlsx', '/in/b.xlsx'], '命中缓存的明细含全部条目');
});

test('v3.2.21 跨 Sheet 回填：没有一行写入明细的源文件（回填行被过滤账单排除、只剩零金额行）不导出回填文件；分段条目任一有明细行即导出', () => {
  const detail = (amounts, file) => Object.assign(
    [['BillDate', 'Credit Amount', 'Debit Amount']].concat(amounts.map(([credit, debit]) => ['2026-09-25', credit, debit])),
    { crossSheetBackfillPatches: [{ rowNumber: 3 }], crossSheetBackfillSource: { sha256: file } }
  );
  const entries = [
    { filePath: '/in/a.xlsx', matchedTemplateId: 1, detailRows: detail([], 'a') },
    { filePath: '/in/b.xlsx', matchedTemplateId: 1, detailRows: detail([['10', ''], ['', '5']], 'b') },
    { filePath: '/in/c.xlsx', matchedTemplateId: 1, detailRows: detail([], 'c') },
    { filePath: '/in/c.xlsx', matchedTemplateId: 1, detailRows: detail([['1', '0']], 'c') },
    { filePath: '/in/d.xlsx', matchedTemplateId: 1, detailRows: detail([['0', ''], ['', '0.00']], 'd') }
  ];
  const collect = loadFunction(
    'collectCrossSheetBackfillExportItems',
    ['getStatementSessionEntries', 'isFilenameMappingMode', 'getGeneratedStatementExport', 'groupStatementEntriesForGeneration', 'hasDetailExportRow'],
    [() => entries, () => false, () => null, () => [], hasDetailExportRow]
  );
  assert.deepEqual(collect({ templateId: 5 }, 'all').map((item) => item.sourceFilePath), ['/in/b.xlsx', '/in/c.xlsx']);
});

test('v3.2.21 跨 Sheet 回填：按文件名映射多模板组中任一组的交易全部被回填跳过时整批失败（用户决定），在替换会话旧条目与写出之前失败，失败报告带这些组的逐行回填跳过；两种组顺序都如此', () => {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  const groupStatementEntriesForGeneration = loadFunction(
    'groupStatementEntriesForGeneration',
    ['database', 'resolveGenerationGroupKey', 'getTemplateMappingConfig'],
    [{ getTemplate: (id) => ({ id, channelId: null }) }, resolveGenerationGroupKey, (id) => ({ template: { id }, exportMappings: [], exportTargetFields: [] })]
  );
  const isAllSkipped = loadFunction('isAllTransactionsSkippedByBackfill', ['hasDetailExportRow'], [hasDetailExportRow]);
  const skippedIssue = { type: 'cross-sheet-backfill-skipped', rowNumber: 3, reason: 'no-source-row' };
  // 回填跳过了全部交易：只剩表头，或只剩带日期、收支为空的期初余额行（不写入明细，第十五轮审查）
  const emptiedEntry = (templateId = 1, issue = skippedIssue, { openingRow = false } = {}) => {
    const detailRows = [['BillDate', 'Credit Amount', 'Debit Amount'], ...(openingRow ? [['2026-09-01', '', '']] : [])];
    detailRows.issues = [issue];
    return { matchedTemplateId: templateId, filePath: `/private/T${templateId}.xlsx`, detailRows };
  };
  const validEntry = () => {
    const detailRows = [['BillDate', 'Credit Amount', 'Debit Amount'], ['2026-09-01', '10', '']];
    detailRows.issues = [];
    return { matchedTemplateId: 2, filePath: '/private/B.xlsx', detailRows };
  };
  const buildLines = loadFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine', 'formatBalanceMismatchLine', 'formatBalanceSeedReplaceLine'],
    [String, String, String]
  );
  const archiveOperationContext = { getStore: () => null };
  const buildMessage = loadFunction('buildBackfillEmptiedGroupsMessage', ['path', 'archiveOperationContext'], [path, archiveOperationContext]);
  const run = (fileEntries, { removed = [] } = {}) => {
    const generated = [];
    const sessionEntries = [];
    const imported = [];
    const deps = {
      groupStatementEntriesForGeneration,
      FileValidationError: require('../../../src/backend/file-service').FileValidationError,
      path,
      FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
      MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI__',
      normalizeCell: (value) => String(value == null ? '' : value).trim(),
      getEntryTemplateConfig: ({ entry }) => ({ template: { id: entry.matchedTemplateId }, exportMappings: [], exportTargetFields: [] }),
      buildStatementGenerationConfig: ({ template }) => ({ template }),
      rebuildMatchedTemplateFileEntries: ({ fileEntries: entries }) => entries,
      buildPreparedStatementBatchFromEntries: ({ fileEntries: entries }) => {
        const detailRows = [entries[0].detailRows[0], ...entries.flatMap((entry) => entry.detailRows.slice(1))];
        return { detailRows, warnings: entries.flatMap((entry) => entry.detailRows.issues) };
      },
      isAllTransactionsSkippedByBackfill: isAllSkipped,
      // v3.2.21：写出前的整批检查（本用例的组都可写出）
      assertStatementBatchWritable: () => {},
      assertGenerationOutputNameUnique: () => {},
      findGenerationGroupOutputPathConflicts: () => null,
      buildStatementOutputPathConflictError: () => new Error('conflict'),
      removeStatementSessionEntriesByFilePath: (_session, filePath) => { removed.push(filePath); },
      buildImportWarningDetailLines: buildLines,
      buildBackfillEmptiedGroupsMessage: buildMessage,
      generateStatementFiles: ({ config, preparedBatch }) => {
        generated.push(config.template.id);
        return { detail: { filePath: `/tmp/group-${config.template.id}.xlsx` }, balance: null, warnings: preparedBatch.warnings };
      },
      parseRequiredBillDates: (rows) => rows.slice(1).map((row) => row[0]),
      buildDateRangeLabel: () => '20260901',
      getToday: () => '20260901',
      buildOutputFilePath: ({ outputFileName }) => ({ outputFilePath: `/tmp/${outputFileName}` }),
      mergeGeneratedXlsxFiles: () => {},
      buildStatementFileEntry: (entry) => entry,
      buildStatementFileEntryId: () => 'entry',
      appendStatementSessionImport: ({ fileEntries: entries }) => { sessionEntries.push(...entries); return 'batch-1'; },
      buildStatementBatchId: () => 'batch-1',
      lastGeneratedExports: {},
      updateStatementSessionCache: () => {},
      buildImportResultFromGeneratedFiles: ({ generatedFiles }) => { imported.push(generatedFiles); return { status: 'captured' }; },
      FILENAME_MAPPING_TEMPLATE_ID: -1
    };
    const generate = loadFunction('generateMultiTemplateGroupFiles', Object.keys(deps), Object.values(deps));
    generate({
      fileEntries,
      fallbackTemplateConfig: {},
      selectedBigAccount: null,
      session: {},
      replacePaths: ['/private/old.xlsx'],
      inputFilePaths: fileEntries.map((entry) => entry.filePath)
    });
    return { generated, sessionEntries, imported };
  };
  for (const order of [[emptiedEntry(), validEntry()], [validEntry(), emptiedEntry()]]) {
    const label = order.map((entry) => path.basename(entry.filePath)).join(',');
    const removedPaths = [];
    assert.throws(() => run(order, { removed: removedPaths }), (error) => {
      assert.equal(error.name, 'FileValidationError', label);
      assert.match(error.message, /交易全部被「跨 Sheet 回填」跳过（共1行），已取消本次导入.*T1\.xlsx$/, label);
      assert.equal(error.detailLines.length, 2, `${label}：标题行 + 空组的一行`);
      assert.match(error.detailLines[1], /第3行/, label);
      return true;
    }, label);
    assert.deepEqual(removedPaths, [], `${label}：会话未被改动`);
  }
  // 空组留有带日期、收支为空的期初余额行：同样按交易全部被跳过整批失败，不靠生成时取不到日期
  const generatedIds = [];
  assert.throws(() => {
    const { generated } = run([validEntry(), emptiedEntry(1, skippedIssue, { openingRow: true })]);
    generatedIds.push(...generated);
  }, /已取消本次导入/);
  assert.deepEqual(generatedIds, []);
  // 整批都是这种组：同样在替换会话旧条目之前失败，失败报告带全部组的逐行回填跳过
  const removed = [];
  const otherIssue = { ...skippedIssue, rowNumber: 9 };
  assert.throws(() => run([emptiedEntry(1), emptiedEntry(3, otherIssue)], { removed }), (error) => {
    assert.match(error.message, /共2行.*T1\.xlsx、T3\.xlsx$/);
    assert.equal(error.detailLines.length, 3, '标题行 + 两组各一行');
    assert.ok(Array.isArray(error.logDetailLines));
    return true;
  });
  assert.deepEqual(removed, [], '会话未被改动');
});

// ---- v3.2.21 审查回归（第十四轮）----

test('v3.2.21 跨 Sheet 回填：按文件名映射多组时任一组的交易全部被回填跳过，在大账号聚合、选择与写入会话之前整批取消（用户决定），失败报告逐行列出这些组的跳过原因', () => {
  const buildLines = loadFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine', 'formatBalanceMismatchLine', 'formatBalanceSeedReplaceLine'],
    [String, String, String]
  );
  const calls = [];
  const archiveOperationContext = { getStore: () => ({ phase: 'prepare' }) };
  const create = loadFunction(
    'createBackfillEmptiedGroupsErrorResult',
    ['createErrorResult', 'buildImportWarningDetailLines', 'collectCrossSheetBackfillWarnings', 'buildBackfillEmptiedGroupsMessage'],
    [(options) => { calls.push(options); return { status: 'error' }; }, buildLines, loadFunction('collectCrossSheetBackfillWarnings'),
      loadFunction('buildBackfillEmptiedGroupsMessage', ['path', 'archiveOperationContext'], [path, archiveOperationContext])]
  );
  const skipped = (rowNumber) => ({ type: 'cross-sheet-backfill-skipped', rowNumber, reason: 'no-source-row', matchField: 'Desc', matchValue: 'ACC-SECRET', sourceFileName: 'a.xlsx' });
  const entry = (filePath, issues) => ({ filePath, detailRows: Object.assign([['BillDate']], { issues }) });
  create([
    { entries: [entry('/private/A.xlsx', [skipped(3), { type: 'currency-unmapped', rowNumber: 2 }])] },
    { entries: [entry('/private/C.xlsx', [skipped(5), skipped(6)])] }
  ], '按文件名映射模板');
  assert.equal(calls[0].errorCode, 'NO_TRANSACTION_DATA', '界面按该码在弹窗中逐行列出（预检阶段没有报错文件）');
  assert.match(calls[0].message, /共3行.*已取消本次导入.*请点击状态框查看逐行原因.*A\.xlsx、C\.xlsx$/);
  assert.equal(calls[0].detailLines.filter((line) => line.includes('ACC-SECRET')).length, 3, '两组共 3 行逐行列出');
  assert.ok(calls[0].logDetailLines.every((line) => !line.includes('ACC-SECRET')), '活动日志不含配对值');

  // 导入入口：只在多组时拦下，且位于大账号聚合（及选择）之前
  const source = functionSource('handleFilenameMappingImport');
  const precheck = source.indexOf('createBackfillEmptiedGroupsErrorResult(');
  assert.ok(precheck > source.indexOf('const importGenerationGroups = groupStatementEntriesForGeneration('));
  assert.ok(precheck < source.indexOf('const aggregatedBigAccounts = [];'));
  assert.match(source, /importGenerationGroups\.length > 1\s*\?\s*importGenerationGroups\.filter\(\(group\) => isAllTransactionsSkippedByBackfill\(group\.entries\)\)/);
});

// ---- v3.2.21 审查回归（第十五轮）----

test('v3.2.21 跨 Sheet 回填：指定模板已记住固定大账号顺序时，交易全部被回填跳过同样在套用记住的顺序之前按没有交易数据返回逐行原因', async () => {
  const execute = loadDesignatedImportExecute({
    templateConfig: designatedTemplateConfig([
      { merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false },
      { merchantId: 'M002', currencies: ['USD'], isMultiCurrency: false }
    ]),
    mode: 'fixed',
    order: {
      assignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }],
      fileCount: 1,
      files: [{ fileIndex: 0, accountCount: 1, accounts: ['M001'], rowAccounts: ['M001'], rowEmpty: [false] }]
    },
    logs: []
  });
  const detailRows = [['BillDate', 'Credit Amount', 'Debit Amount'], ['2026-09-01', '', '']];
  detailRows.rowMetas = [{ sourceRowNumber: 2 }];
  detailRows.headerBreaks = [];
  detailRows.issues = [{ type: 'cross-sheet-backfill-skipped', rowNumber: 3, reason: 'no-source-row' }];
  Object.defineProperty(detailRows, 'bigAccountRecognitionBasis', { enumerable: false, value: {
    version: 1, headerWindows: [{ headerRowNumber: 1, candidateRows: [] }], bridgeClearingIdsByBlock: ['']
  } });
  const result = await execute(designatedPrepared([{ filePath: path.resolve('/private/all-skipped.xlsx'), detailRows }]));
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'NO_TRANSACTION_DATA');
  assert.deepEqual(result.detailLines, ['3:no-source-row']);
});
