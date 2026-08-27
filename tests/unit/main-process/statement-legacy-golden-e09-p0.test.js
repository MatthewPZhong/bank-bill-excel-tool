'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const XLSX = require('xlsx');

const {
  buildDetailExportRows,
  buildMappedRows,
  calculateEndingBalanceFromAmounts,
  extractHeaders,
  FileValidationError,
  inferEndingBalance,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../../src/backend/file-service');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord
} = require('../../../src/backend/balance-seed-store');
const {
  readBalanceAdjustments,
  resolveBalanceAdjustment
} = require('../../../src/backend/balance-adjustment-store');
const {
  createStatementGenerationHelpers
} = require('../../../src/main-process/statement-generation');
const {
  buildManualBalanceSeedPlan,
  writeManualBalanceSeedPlan
} = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  removeStatementSessionEntriesByFilePath,
  resolveSinglePreparedFieldValue
} = require('../../../src/main-process/statement-session');

const ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'statement', 'e09-p0-legacy-golden.json'),
  'utf8'
));
const ORDERED_FIELDS = Object.freeze([
  'BillDate',
  'MerchantId',
  'Currency',
  'Credit Amount',
  'Debit Amount'
]);

function mainFunctionSource(name) {
  const node = MAIN_AST.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到production函数：${name}`);
  return MAIN_SOURCE.slice(node.start, node.end);
}

function loadMainFunction(name, dependencyNames = [], dependencyValues = []) {
  return Function(
    ...dependencyNames,
    `return (${mainFunctionSource(name)});`
  )(...dependencyValues);
}

// generation seam 已由 production Main 直接委托；仍留在 Main 的余额/命名纯函数
// 从当前源码执行，避免在测试内复制另一套业务算法。

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-p0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createProductionGenerationSeam(storageRoot) {
  const ensureStorageRoot = () => {
    fs.mkdirSync(storageRoot, { recursive: true });
    return storageRoot;
  };
  const pad = loadMainFunction('pad');
  const formatDateLabel = loadMainFunction('formatDateLabel', ['pad'], [pad]);
  const getToday = loadMainFunction('getToday', ['pad'], [pad]);
  const sanitizeFileName = loadMainFunction('sanitizeFileName');
  const buildDateRangeLabel = loadMainFunction('buildDateRangeLabel');
  const buildFieldIndexMap = loadMainFunction(
    'buildFieldIndexMap',
    ['normalizeCell'],
    [normalizeCell]
  );
  const getMappedFieldValue = loadMainFunction('getMappedFieldValue');
  const parseRequiredBillDates = loadMainFunction(
    'parseRequiredBillDates',
    [
      'buildFieldIndexMap',
      'normalizeCell',
      'parseDateValue',
      'FileValidationError',
      'formatDateLabel'
    ],
    [buildFieldIndexMap, normalizeCell, parseDateValue, FileValidationError, formatDateLabel]
  );
  const ensureNumericValue = loadMainFunction(
    'ensureNumericValue',
    ['normalizeCell', 'parseNumericValue', 'FileValidationError'],
    [normalizeCell, parseNumericValue, FileValidationError]
  );
  const buildBalanceTemplateRow = loadMainFunction(
    'buildBalanceTemplateRow',
    ['normalizeCell'],
    [normalizeCell]
  );
  const hasMultipleEndingBalances = loadMainFunction('hasMultipleEndingBalances');
  const buildBalanceSeedPrompt = loadMainFunction(
    'buildBalanceSeedPrompt',
    ['normalizeCell'],
    [normalizeCell]
  );
  const resolveSeededPreviousEndBalance = loadMainFunction(
    'resolveSeededPreviousEndBalance',
    ['FileValidationError'],
    [FileValidationError]
  );
  const deriveBalanceRecords = loadMainFunction(
    'deriveBalanceRecords',
    [
      'buildFieldIndexMap',
      'FileValidationError',
      'splitTemplateName',
      'normalizeCell',
      'parseDateValue',
      'formatDateLabel',
      'ensureNumericValue',
      'getMappedFieldValue',
      'buildBalanceSeedPrompt',
      'resolveSeededPreviousEndBalance',
      'calculateEndingBalanceFromAmounts',
      'inferEndingBalance',
      'hasMultipleEndingBalances',
      'resolveBalanceAdjustment',
      'buildBalanceTemplateRow',
      'BALANCE_SEED_GENERATION_METHODS'
    ],
    [
      buildFieldIndexMap,
      FileValidationError,
      splitTemplateName,
      normalizeCell,
      parseDateValue,
      formatDateLabel,
      ensureNumericValue,
      getMappedFieldValue,
      buildBalanceSeedPrompt,
      resolveSeededPreviousEndBalance,
      calculateEndingBalanceFromAmounts,
      inferEndingBalance,
      hasMultipleEndingBalances,
      resolveBalanceAdjustment,
      buildBalanceTemplateRow,
      BALANCE_SEED_GENERATION_METHODS
    ]
  );
  const scanBalanceSeedStatus = loadMainFunction(
    'scanBalanceSeedStatus',
    [
      'buildFieldIndexMap',
      'splitTemplateName',
      'normalizeCell',
      'parseDateValue',
      'formatDateLabel',
      'findPreviousBalanceSeed',
      'ensureStorageRoot'
    ],
    [
      buildFieldIndexMap,
      splitTemplateName,
      normalizeCell,
      parseDateValue,
      formatDateLabel,
      findPreviousBalanceSeed,
      ensureStorageRoot
    ]
  );
  const storeGeneratedBalanceSeeds = loadMainFunction(
    'storeGeneratedBalanceSeeds',
    ['ensureStorageRoot', 'upsertBalanceSeedRecord'],
    [ensureStorageRoot, upsertBalanceSeedRecord]
  );
  const buildOutputFilePath = loadMainFunction(
    'buildOutputFilePath',
    ['getToday', 'path', 'ensureStorageRoot', 'sanitizeFileName'],
    [getToday, path, ensureStorageRoot, sanitizeFileName]
  );
  const buildStatementOutputFilePath = loadMainFunction(
    'buildStatementOutputFilePath',
    ['getToday', 'buildOutputFilePath'],
    [getToday, buildOutputFilePath]
  );

  return createStatementGenerationHelpers({
    appendLog: () => {
      throw new Error('generation characterization不应进入系统异常日志分支');
    },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath,
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    getBalanceTemplatePath: () => path.join(ROOT, 'assets', '余额账单模版.xlsx'),
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    parseRequiredBillDates,
    readBalanceAdjustments,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus,
    splitTemplateName,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows
  });
}

function writeSourceWorkbook(root, fileName, rows) {
  const filePath = path.join(root, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function amountModeSnapshot(rows) {
  const exportRows = buildDetailExportRows(rows);
  return {
    mappedData: rows.slice(1),
    exportData: exportRows.slice(1),
    skippedRows: exportRows.skippedRows,
    simultaneousRows: exportRows.simultaneousRows,
    amountSplitMatchStats: rows.amountSplitMatchStats || null,
    billSplitMatchStats: rows.billSplitMatchStats || null
  };
}

function directRows(root) {
  return buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'direct.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-01', 'M001', 'USD', '100', ''],
      ['2026-08-02', 'M001', 'USD', '', '40'],
      ['2026-08-03', 'M001', 'USD', '0', '0'],
      ['2026-08-04', 'M001', 'USD', '5', '6']
    ]),
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
}

test('legacy四金额模式执行production buildMappedRows并逐字段匹配golden', (t) => {
  const root = createTempRoot(t);
  const modes = {
    direct: directRows(root),
    signed: buildMappedRows({
      inputFilePath: writeSourceWorkbook(root, 'signed.xlsx', [
        ['Date', 'Account', 'Curr', 'Amount'],
        ['2026-08-01', 'M001', 'USD', '+123.45'],
        ['2026-08-02', 'M001', 'USD', '-54.3'],
        ['2026-08-03', 'M001', 'USD', '0']
      ]),
      orderedTargetFields: ORDERED_FIELDS,
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      amountMappingRules: { signedAmountSourceField: 'Amount' }
    }),
    fieldConditional: buildMappedRows({
      inputFilePath: writeSourceWorkbook(root, 'field-conditional.xlsx', [
        ['Date', 'Account', 'Curr', 'Type', 'Amount'],
        ['2026-08-01', 'M001', 'USD', 'IN', '70'],
        ['2026-08-02', 'M001', 'USD', 'OUT', '20'],
        ['2026-08-03', 'M001', 'USD', 'OTHER', '9']
      ]),
      orderedTargetFields: ORDERED_FIELDS,
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      amountSplitByField: {
        enabled: true,
        rules: [
          {
            conditionField: 'Type',
            conditionValue: 'IN',
            mappedField: 'Amount',
            targetField: 'Credit Amount'
          },
          {
            conditionField: 'Type',
            conditionValue: 'OUT',
            mappedField: 'Amount',
            targetField: 'Debit Amount'
          }
        ]
      }
    }),
    billSplitMerge: buildMappedRows({
      inputFilePath: writeSourceWorkbook(root, 'bill-split-merge.xlsx', [
        ['Date', 'Account', 'Curr', 'Credit1', 'Debit1', 'Credit2', 'Debit2'],
        ['2026-08-01', 'M001', 'USD', '150', '', '', '40'],
        ['2026-08-02', 'M001', 'USD', '60', '', '', '60']
      ]),
      orderedTargetFields: ORDERED_FIELDS,
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      billSplitMerge: {
        enabled: true,
        reuseModuleMapping: true,
        billSplitRows: [
          {
            seqNo: 1,
            rowStatus: 'completed',
            currencySourceField: 'Curr',
            creditSourceField: 'Credit1',
            debitSourceField: 'Debit1',
            mergedGroupSeq: 1
          },
          {
            seqNo: 2,
            rowStatus: 'completed',
            currencySourceField: 'Curr',
            creditSourceField: 'Credit2',
            debitSourceField: 'Debit2',
            mergedGroupSeq: 1
          }
        ],
        billSplitAmountRules: [],
        signedAmountSourceField: '',
        signedAmountTargetSeqNos: [],
        byFieldAmountTargetSeqNos: []
      }
    })
  };

  for (const [mode, rows] of Object.entries(modes)) {
    const { workbookData: _workbookData, ...expected } = GOLDEN.amountModes[mode];
    assert.deepEqual(amountModeSnapshot(rows), expected, mode);
  }
});

test('production generation seam对双非零真实抛错且零artifact；安全行writer保持行序与金额方向', (t) => {
  const root = createTempRoot(t);
  const exportRows = buildDetailExportRows(directRows(root));
  assert.deepEqual(exportRows.simultaneousRows, GOLDEN.amountModes.direct.simultaneousRows);

  const storageRoot = path.join(root, 'blocked-storage');
  const generation = createProductionGenerationSeam(storageRoot);
  const config = {
    template: { name: '中行-上海' },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: false
  };
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: [{ filePath: path.join(root, 'direct.xlsx'), detailRows: directRows(root) }]
  });
  assert.throws(
    () => generation.generateStatementFiles({ config, preparedBatch }),
    (error) => error instanceof FileValidationError &&
      error.message.includes('Credit Amount 与 Debit Amount 同时有值')
  );
  assert.equal(fs.existsSync(storageRoot), false, 'gate必须先于output路径与writer副作用');

  const outputPath = path.join(root, 'detail-output.xlsx');
  writeWorkbookRows({ rows: exportRows, outputFilePath: outputPath });

  const workbook = XLSX.readFile(outputPath, { raw: true });
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets.COMMON, {
    header: 1,
    defval: ''
  });
  assert.deepEqual(sheetRows.slice(1), GOLDEN.amountModes.direct.workbookData);
  assert.equal(sheetRows.length, 3, 'production core过滤后的安全行写入保持现状');
});

test('production generation seam真实执行两batch current/all workbook、命名、warning与cache', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'generation-storage');
  const generation = createProductionGenerationSeam(storageRoot);
  const config = {
    template: { name: '中行-上海' },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: false
  };
  const rows1 = buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'batch-one.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-01', 'M001', 'USD', '100', ''],
      ['2026-08-01', 'M001', 'USD', '0', '0']
    ]),
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
  const rows2 = buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'batch-two.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-02', 'M001', 'USD', '', '40']
    ]),
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
  let entryId = 0;
  let batchId = 0;
  const session = createStatementImportSession({ templateId: 1, templateName: '中行-上海' });
  const cache = { detail: null, balance: null, allDetail: null, allBalance: null };
  for (const [fileName, detailRows] of [['batch-one.xlsx', rows1], ['batch-two.xlsx', rows2]]) {
    appendStatementSessionImport({
      buildBatchId: () => `batch-${++batchId}`,
      lastGeneratedExports: cache,
      session,
      fileEntries: [buildStatementFileEntry({
        buildEntryId: () => `entry-${++entryId}`,
        filePath: path.join(root, fileName),
        detailRows
      })]
    });
  }

  const currentPrepared = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: getStatementSessionEntries(session, 'current')
  });
  const allPrepared = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: getStatementSessionEntries(session, 'all')
  });
  const current = generation.generateStatementFiles({
    config,
    preparedBatch: currentPrepared,
    scope: 'current'
  });
  const all = generation.generateStatementFiles({
    config,
    preparedBatch: allPrepared,
    scope: 'all'
  });

  assert.equal(current.detail.fileName, '中行-上海-M001-COMMON-2026-08-02.xlsx');
  assert.equal(all.detail.fileName, '中行-上海-COMMON-2026-08-01~2026-08-02.xlsx');
  assert.deepEqual(current.warnings, []);
  assert.deepEqual(all.warnings, [{
    type: 'detail-row-skipped',
    rowNumber: 3,
    creditAmount: '0',
    debitAmount: '0'
  }]);
  const workbookRows = (filePath) => {
    const workbook = XLSX.readFile(filePath, { raw: true });
    return XLSX.utils.sheet_to_json(workbook.Sheets.COMMON, { header: 1, defval: '' });
  };
  assert.equal(workbookRows(current.detail.filePath).length, 2);
  assert.equal(workbookRows(all.detail.filePath).length, 3);
  assert.match(path.basename(all.detail.filePath), /__all\.xlsx$/);

  generation.cacheCurrentStatementExports({
    session,
    generatedFiles: current,
    lastGeneratedExports: cache
  });
  generation.cacheAllStatementExport(cache, 'detail', all.detail);
  assert.deepEqual({
    current: cache.detail.fileName,
    all: cache.allDetail.fileName,
    statementSessionKey: cache.statementSessionKey,
    currentBatchId: cache.currentBatchId
  }, {
    current: current.detail.fileName,
    all: all.detail.fileName,
    statementSessionKey: session.key,
    currentBatchId: session.currentBatchId
  });
});

test('production generation seam覆盖混合币种alias、statement直取与calculated余额', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'balance-generation-storage');
  const generation = createProductionGenerationSeam(storageRoot);
  const balanceFields = ORDERED_FIELDS.concat('Balance');
  const mappingByField = {
    BillDate: 'Date',
    MerchantId: 'Account',
    Currency: 'Curr',
    'Credit Amount': 'Credit',
    'Debit Amount': 'Debit',
    Balance: 'EndBalance'
  };
  const currencyMappings = [
    { aliases: ['美元'], englishCode: 'USD' },
    { aliases: ['欧元'], englishCode: 'EUR' }
  ];
  const directRows = buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'direct-balance.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'EndBalance'],
      ['2026-08-01', 'M001', '美元', '100', '', '1000'],
      ['2026-08-02', 'M001', 'USD', '100', '', '1100'],
      ['2026-08-02', 'M001', '欧元', '', '20', '900']
    ]),
    orderedTargetFields: balanceFields,
    mappingByField,
    currencyMappings
  });
  assert.deepEqual(directRows.slice(1).map((row) => row[2]), ['USD', 'USD', 'EUR']);
  const directConfig = {
    template: { name: '中行-上海' },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  const directPrepared = generation.buildPreparedStatementBatchFromEntries({
    config: directConfig,
    fileEntries: [{ filePath: path.join(root, 'direct-balance.xlsx'), detailRows: directRows }]
  });
  const direct = generation.generateStatementFiles({
    config: directConfig,
    preparedBatch: directPrepared
  });
  assert.ok(direct.detail && direct.balance);
  assert.deepEqual(direct.warnings, []);
  const balanceRows = (filePath) => {
    const workbook = XLSX.readFile(filePath, { raw: true });
    return XLSX.utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]],
      { header: 1, defval: '' }
    ).slice(1);
  };
  assert.deepEqual(
    balanceRows(direct.balance.filePath).map((row) => [row[2], row[4], row[7]]),
    [
      ['EUR', 46236, 900],
      ['USD', 46235, 1000],
      ['USD', 46236, 1100]
    ]
  );

  const calculatedRows = buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'calculated-balance.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-03', 'M001', '美元', '25', ''],
      ['2026-08-03', 'M001', '欧元', '', '50']
    ]),
    orderedTargetFields: balanceFields,
    mappingByField: { ...mappingByField, Balance: '' },
    currencyMappings
  });
  const calculatedConfig = {
    ...directConfig,
    balanceMode: 'calculated'
  };
  const calculatedPrepared = generation.buildPreparedStatementBatchFromEntries({
    config: calculatedConfig,
    fileEntries: [{
      filePath: path.join(root, 'calculated-balance.xlsx'),
      detailRows: calculatedRows
    }]
  });
  const calculated = generation.generateStatementFiles({
    config: calculatedConfig,
    preparedBatch: calculatedPrepared
  });
  assert.ok(calculated.balance);
  assert.deepEqual(calculated.warnings, []);
  assert.deepEqual(
    balanceRows(calculated.balance.filePath).map((row) => [row[2], row[7]]),
    [['EUR', 850], ['USD', 1125]]
  );
});

test('production generation seam缺calculated seed时冻结真实queue prompt且不产balance', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'missing-seed-storage');
  const generation = createProductionGenerationSeam(storageRoot);
  const rows = buildMappedRows({
    inputFilePath: writeSourceWorkbook(root, 'missing-seed.xlsx', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-01', 'M001', 'USD', '10', ''],
      ['2026-08-01', 'M002', 'EUR', '20', '']
    ]),
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
  const config = {
    template: { name: '中行-上海' },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: true,
    balanceMode: 'calculated'
  };
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: [{ filePath: path.join(root, 'missing-seed.xlsx'), detailRows: rows }]
  });
  const result = generation.generateStatementFiles({ config, preparedBatch });
  assert.ok(result.detail && fs.existsSync(result.detail.filePath));
  assert.equal(result.balance, null);
  assert.deepEqual(result.warnings, [{
    type: 'balance-seed-required',
    message: '因首次导入余额，请导入上一个账单日余额用于余额校验',
    prompt: {
      templateName: '中行-上海',
      bankName: '中行',
      merchantId: 'M001',
      currency: 'USD',
      targetBillDate: '2026-08-01',
      queueIndex: 1,
      queueTotal: 2
    }
  }]);
});

test('legacy current/all按真实session batch identity稳定取数，remove后回退上一有效batch', (t) => {
  const root = createTempRoot(t);
  let nextEntry = 0;
  let nextBatch = 0;
  const session = createStatementImportSession({ templateId: 1, templateName: '中行-上海' });
  const generatedExports = {
    statementSessionKey: session.key,
    allDetail: { fileName: 'stale-detail.xlsx' },
    allBalance: { fileName: 'stale-balance.xlsx' }
  };
  const entry = (fileName, amount) => buildStatementFileEntry({
    buildEntryId: () => `entry-${++nextEntry}`,
    filePath: path.join(root, fileName),
    detailRows: [
      ORDERED_FIELDS.slice(),
      ['2026-08-01', 'M001', 'USD', amount, '']
    ]
  });
  const entries = [entry('a.xlsx', '10'), entry('b.xlsx', '20'), entry('c.xlsx', '30')];
  appendStatementSessionImport({
    buildBatchId: () => `batch-${++nextBatch}`,
    lastGeneratedExports: generatedExports,
    session,
    fileEntries: entries.slice(0, 2)
  });
  appendStatementSessionImport({
    buildBatchId: () => `batch-${++nextBatch}`,
    lastGeneratedExports: generatedExports,
    session,
    fileEntries: entries.slice(2)
  });

  const snapshot = {
    current: getStatementSessionEntries(session, 'current').map((item) => item.id),
    all: getStatementSessionEntries(session, 'all').map((item) => item.id)
  };
  assert.deepEqual(snapshot, {
    current: GOLDEN.sessionScope.current,
    all: GOLDEN.sessionScope.all
  });
  assert.equal(generatedExports.allDetail, null, '新batch使all detail qualification失效');
  assert.equal(generatedExports.allBalance, null, '新batch使all balance qualification失效');

  removeStatementSessionEntriesByFilePath(session, path.join(root, 'c.xlsx'));
  assert.deepEqual({
    current: getStatementSessionEntries(session, 'current').map((item) => item.id),
    all: getStatementSessionEntries(session, 'all').map((item) => item.id),
    currentBatchId: session.currentBatchId,
    batches: session.batches.map((batch) => ({ id: batch.id, entryIds: batch.entryIds }))
  }, GOLDEN.sessionScope.afterCurrentEntryRemoved);
});

test('legacy余额计算与真实balance writer保留多币种记录顺序和值', (t) => {
  const root = createTempRoot(t);
  const calculated = calculateEndingBalanceFromAmounts({
    previousEndBalance: 1000,
    entries: [
      { creditAmount: 100, debitAmount: 0 },
      { creditAmount: 0, debitAmount: 25 }
    ]
  });
  assert.equal(calculated, GOLDEN.balance.calculatedEndingBalance);

  const outputPath = path.join(root, 'balance-output.xlsx');
  writeBalanceWorkbook({
    templateFilePath: path.join(ROOT, 'assets', '余额账单模版.xlsx'),
    records: GOLDEN.balance.multiCurrencyRecords,
    outputFilePath: outputPath
  });
  const workbook = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: ''
  });
  assert.deepEqual(rows.slice(1, 3), GOLDEN.balance.multiCurrencyWorkbookRows);
  assert.deepEqual(rows.slice(1, 3).map((row) => row[2]), ['USD', 'EUR']);
});

test('legacy manual seed plan/write/read使用真实production store并冻结文件bytes与previous选择', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const planResult = buildManualBalanceSeedPlan({
    payload: { billDate: '2026-07-31', endBalance: '1,234.56' },
    pendingPrompt: {
      templateName: '中行-上海',
      merchantId: 'M001',
      currency: 'USD',
      targetBillDate: '2026-08-01'
    },
    importContext: { template: { name: '中行-上海' } },
    generatedExports: { detail: { fileName: 'detail.xlsx' } },
    storageRoot
  });
  assert.equal(planResult.stopResult, undefined);
  assert.equal(planResult.plan.existingIndex, -1);

  const written = writeManualBalanceSeedPlan(
    planResult.plan,
    new Date('2026-08-27T12:34:56.000Z')
  );
  assert.deepEqual(written.record, GOLDEN.manualSeed.record);
  assert.equal(path.relative(storageRoot, written.filePath), GOLDEN.manualSeed.relativePath);
  assert.equal(fs.readFileSync(written.filePath, 'utf8'), GOLDEN.manualSeed.fileText);
  assert.deepEqual(readBalanceSeedRecords(storageRoot, '中行'), [GOLDEN.manualSeed.record]);
  assert.deepEqual(findPreviousBalanceSeed(storageRoot, {
    bankName: '中行',
    merchantId: 'M001',
    currency: 'USD',
    beforeBillDate: '2026-08-01'
  }), GOLDEN.manualSeed.record);
});
