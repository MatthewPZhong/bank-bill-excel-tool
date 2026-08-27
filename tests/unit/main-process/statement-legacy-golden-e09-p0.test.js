'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  buildDetailExportRows,
  buildMappedRows,
  calculateEndingBalanceFromAmounts,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../../src/backend/file-service');
const {
  findPreviousBalanceSeed,
  readBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');
const {
  buildManualBalanceSeedPlan,
  writeManualBalanceSeedPlan
} = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  createStatementImportSession,
  getStatementSessionEntries,
  removeStatementSessionEntriesByFilePath
} = require('../../../src/main-process/statement-session');

const ROOT = path.join(__dirname, '..', '..', '..');
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

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-p0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
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

test('legacy detail gate识别双非零并在writer之前阻断；安全行真实落xlsx保持行序与金额方向', (t) => {
  const root = createTempRoot(t);
  const exportRows = buildDetailExportRows(directRows(root));
  assert.deepEqual(exportRows.simultaneousRows, GOLDEN.amountModes.direct.simultaneousRows);

  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const generateStart = mainSource.indexOf('function generateStatementFiles({');
  const generateEnd = mainSource.indexOf('\nfunction prepareGeneratedFiles(', generateStart);
  const generateSource = mainSource.slice(generateStart, generateEnd);
  const simultaneousGate = generateSource.indexOf('if (simultaneousAmountRows.length)');
  const writerCall = generateSource.indexOf('writeWorkbookRows({');
  assert.ok(generateStart >= 0 && generateEnd > generateStart, '必须找到legacy generation实现');
  assert.ok(simultaneousGate >= 0 && writerCall > simultaneousGate, '双非零gate必须先于writer');

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
