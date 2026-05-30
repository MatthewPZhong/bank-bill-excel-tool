const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');  // v2.1.12 SR-log-1：smoke 活动日志/启动失败日志改查新结构 JSON Lines 路径
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { AppDatabase } = require('../../src/backend/database');
const {
  calculateEndingBalanceFromAmounts,
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  FIXED_FIELD_VALUE_PREFIX,
  inferEndingBalance,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeDateExportValue,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  appendActivityRecord,
  ensureActivityLogFile,
  writeErrorReport
} = require('../../src/backend/logger');
const {
  collectMatchedRows
} = require('../../src/backend/file-service/readers');
const {
  buildStartupFailureDialogMessage,
  reportStartupFailure
} = require('../../src/backend/startup-failure');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  listBalanceSeedBankNames,
  readBalanceSeedRecords,
  upsertBalanceSeedRecord,
  writeBalanceSeedRecords
} = require('../../src/backend/balance-seed-store');
const {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  buildTargetLastDay,
  lastDayOfMonth,
  pickLatestSeedForAccount,
  toBalanceRows
} = require('../../src/main-process/monthly-balance');

function runDatabaseScenario(context) {
  const db = new AppDatabase(context.dbPath);
  db.init();
  const migratedDb = new AppDatabase(context.legacyDbPath);
  migratedDb.init();
  migratedDb.db.close();

  const migratedRawDb = new DatabaseSync(context.legacyDbPath);
  const templateColumns = migratedRawDb.prepare('PRAGMA table_info(templates)').all();
  assert(templateColumns.some((column) => column.name === 'template_key'));
  const migratedTemplate = migratedRawDb
    .prepare('SELECT template_key AS templateKey FROM templates WHERE name = ?')
    .get('legacy-template');
  assert(migratedTemplate.templateKey);
  const templateIndexes = migratedRawDb.prepare("PRAGMA index_list('templates')").all();
  assert(templateIndexes.some((index) => index.name === 'templates_template_key_unique'));
  migratedRawDb.close();

  const headers = extractHeaders(context.templatePath);
  assert.deepStrictEqual(headers, ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H']);

  const template = db.upsertTemplate({
    name: 'template',
    sourceFileName: 'template.xlsx',
    headers
  });
  assert(template.templateKey);

  const multiTemplate = db.upsertTemplate({
    name: 'multi-template',
    sourceFileName: 'template.xlsx',
    headers
  });
  const fixedTemplate = db.upsertTemplate({
    name: 'fixed-template',
    sourceFileName: 'template.xlsx',
    headers
  });

  db.setBackgroundConfig({
    colorHex: '#123456',
    filePath: '',
    sourceFileName: ''
  });
  assert.strictEqual(db.getBackgroundConfig().colorHex, '#123456');

  db.saveMappings(template.id, [
    { templateField: 'Credit Amount', mappedField: '原字段A' },
    { templateField: 'Debit Amount', mappedField: '原字段B' },
    { templateField: 'BillDate', mappedField: '原字段C' },
    { templateField: 'ValueDate', mappedField: '原字段D' },
    { templateField: 'MerchantId', mappedField: '原字段E' },
    { templateField: 'Channel', mappedField: '原字段F' }
  ]);
  db.saveMappings(multiTemplate.id, [
    { templateField: 'MerchantId', mappedField: `${FIXED_FIELD_VALUE_PREFIX}__MULTI_BIG_ACCOUNT__` },
    { templateField: 'Currency', mappedField: `${FIXED_FIELD_VALUE_PREFIX}USD` }
  ], [
    { merchantId: 'BIG_001', currency: 'USD' },
    { merchantId: 'BIG_001', currency: 'HKD' },
    { merchantId: 'BIG_002', currency: 'USD' }
  ]);
  db.saveMappings(fixedTemplate.id, [
    { templateField: 'MerchantId', mappedField: `${FIXED_FIELD_VALUE_PREFIX}62220000000000012345` },
    { templateField: 'Currency', mappedField: `${FIXED_FIELD_VALUE_PREFIX}USD` }
  ]);
  db.saveAccountMappings(fixedTemplate.id, [
    {
      bankAccountId: 'NET_001',
      clearingAccountId: 'CLEAR_9001'
    }
  ]);

  assert.strictEqual(db.listTemplates().find((item) => item.name === 'template').bigAccountSummary, '来自账单');
  assert.strictEqual(db.listTemplates().find((item) => item.name === 'multi-template').bigAccountSummary, '2个');
  assert.strictEqual(db.listTemplates().find((item) => item.name === 'fixed-template').bigAccountSummary, '62220000000000012345');
  assert.strictEqual(db.getTemplateMappings(multiTemplate.id).bigAccounts.length, 2);
  assert.deepStrictEqual(db.getTemplateMappings(multiTemplate.id).bigAccounts[0].currencies, ['USD', 'HKD']);

  return {
    db,
    fixedTemplate,
    headers,
    multiTemplate,
    template
  };
}

function runAssetAndDateScenario(context) {
  assert(fs.existsSync(context.bundledEnumPath));
  assert(fs.existsSync(context.currencyMappingPath));
  assert(fs.existsSync(context.iconSourcePath));
  assert(fs.existsSync(context.runtimeIconPath));
  assert(fs.existsSync(context.buildIconPath));

  const enumValues = loadEnumValues(context.bundledEnumPath);
  const currencyMappings = loadCurrencyMappings(context.currencyMappingPath);

  assert.deepStrictEqual(normalizeDateExportValue('2026-01-01'), {
    value: '2026-01-01',
    date: new Date(2026, 0, 1),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.deepStrictEqual(normalizeDateExportValue('2026/01/01'), {
    value: '2026/01/01',
    date: new Date(2026, 0, 1),
    displayFormat: 'yyyy/mm/dd'
  });
  assert.deepStrictEqual(normalizeDateExportValue('20260101'), {
    value: '20260101',
    date: new Date(2026, 0, 1),
    displayFormat: 'yyyymmdd'
  });
  assert.strictEqual(normalizeDateExportValue('260101').value, '2026-01-01');
  assert.deepStrictEqual(normalizeDateExportValue('31-1-26'), {
    value: '2026-01-31',
    date: new Date(2026, 0, 31),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.strictEqual(normalizeDateExportValue('31-01-2026').value, '2026-01-31');
  assert.strictEqual(normalizeDateExportValue('1/2/26').value, '2026-02-01');
  assert.deepStrictEqual(normalizeDateExportValue('2026-03-17-14:30'), {
    value: '2026-03-17',
    date: new Date(2026, 2, 17),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.deepStrictEqual(normalizeDateExportValue('2026 02-Feb'), {
    value: '2026-02-02',
    date: new Date(2026, 1, 2),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.deepStrictEqual(normalizeDateExportValue('02-Feb 2026'), {
    value: '2026-02-02',
    date: new Date(2026, 1, 2),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.deepStrictEqual(normalizeDateExportValue('11/02/26 02:08:07'), {
    value: '2026-02-11',
    date: new Date(2026, 1, 11),
    displayFormat: 'yyyy-mm-dd'
  });
  assert.strictEqual(normalizeDateExportValue('01022026').value, '2026-02-01');
  assert.strictEqual(normalizeDateExportValue('31122026').value, '2026-12-31');
  assert.strictEqual(normalizeDateExportValue('31-02-2026').value, '');
  assert.strictEqual(normalizeDateExportValue('32012026').value, '');
  assert.strictEqual(normalizeDateExportValue('000000').value, '');
  assert.strictEqual(normalizeDateExportValue('0').value, '');
  assert.strictEqual(normalizeDateExportValue('1').value, '');
  assert.strictEqual(normalizeDateExportValue('0.00').value, '');
  assert.strictEqual(enumValues[0], 'BillDate');
  assert(enumValues.includes('Credit Amount'));
  assert(enumValues.includes('MerchantId'));
  assert.strictEqual(enumValues.includes('COMMON字段'), false);
  assert(currencyMappings.length > 0);

  return {
    currencyMappings,
    enumValues
  };
}

function runMappingScenario(context, state) {
  const { currencyMappings } = state;

  const detailRows = buildMappedRows({
    inputFilePath: context.dataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: '原字段G',
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Extra Information'],
    currencyMappings,
    accountMappingByBankId: {
      NET_001: 'CLEAR_9001'
    }
  });
  assert.deepStrictEqual(detailRows.issues, []);
  assert.strictEqual(detailRows[1][0], '456.78');
  assert.strictEqual(detailRows[2][0], '99.99');

  const detailExportRows = buildDetailExportRows(detailRows);
  assert.strictEqual(detailExportRows.length, 3);
  assert.strictEqual(detailExportRows.skippedRows.length, 0);
  assert.strictEqual(detailExportRows.simultaneousRows.length, 0);
  assert.deepStrictEqual(detailExportRows[0], ['BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Extra Information']);
  assert.strictEqual(detailExportRows[1][0], '2026-03-09');
  assert.strictEqual(detailExportRows[2][0], '2026-03-10');

  const unmappedRows = buildMappedRows({
    inputFilePath: context.unmappedDataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: '原字段G',
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Extra Information'],
    currencyMappings
  });
  assert.strictEqual(unmappedRows[1][5], '测试币');
  assert.strictEqual(unmappedRows.issues.length, 1);
  assert.strictEqual(unmappedRows.issues[0].type, 'currency-unmapped');
  assert.strictEqual(unmappedRows.issues[0].sourceField, '原字段G');
  assert.strictEqual(unmappedRows.issues[0].rawValue, '测试币');

  const customCurrencyRows = buildMappedRows({
    inputFilePath: context.dataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: `${FIXED_FIELD_VALUE_PREFIX}USD_FIXED`,
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount']
  });
  assert.strictEqual(customCurrencyRows[1][5], 'USD_FIXED');
  assert.deepStrictEqual(customCurrencyRows.issues, []);

  const selectedBigAccountRows = buildMappedRows({
    inputFilePath: context.dataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}__MULTI_BIG_ACCOUNT__`,
      Currency: `${FIXED_FIELD_VALUE_PREFIX}USD`,
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    currencyMappings,
    selectedBigAccount: {
      merchantId: 'BIG_ACCOUNT_001',
      currency: 'JPY'
    }
  });
  assert.strictEqual(selectedBigAccountRows[1][4], 'BIG_ACCOUNT_001');
  assert.strictEqual(selectedBigAccountRows[1][5], 'JPY');
  assert.strictEqual(selectedBigAccountRows[2][4], 'BIG_ACCOUNT_001');
  assert.strictEqual(selectedBigAccountRows[2][5], 'JPY');

  const amountMappingRows = buildMappedRows({
    inputFilePath: context.amountMappingDataPath,
    mappingByField: {
      BillDate: '账单日期',
      'Credit Amount': '收入',
      'Debit Amount': '支出',
      'Drawee Name': '户名源',
      'Drawee CardNo': '账号源',
      'Payee Name': '户名源',
      'Payee Cardno': '账号源'
    },
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Debit Amount', 'Drawee Name', 'Drawee CardNo', 'Payee Name', 'Payee Cardno'],
    amountMappingRules: {
      nameSourceField: '户名源',
      accountSourceField: '账号源'
    }
  });
  assert.strictEqual(amountMappingRows[1][3], '收款户名');
  assert.strictEqual(amountMappingRows[1][4], '收款账号');
  assert.strictEqual(amountMappingRows[1][5], '');
  assert.strictEqual(amountMappingRows[1][6], '');
  assert.strictEqual(amountMappingRows[2][3], '');
  assert.strictEqual(amountMappingRows[2][4], '');
  assert.strictEqual(amountMappingRows[2][5], '付款户名');
  assert.strictEqual(amountMappingRows[2][6], '付款账号');

  const signedAmountRows = buildMappedRows({
    inputFilePath: context.signedAmountDataPath,
    mappingByField: {
      BillDate: '账单日期',
      MerchantId: '银行账号',
      Currency: `${FIXED_FIELD_VALUE_PREFIX}USD`
    },
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    amountMappingRules: {
      signedAmountSourceField: '发生额'
    }
  });
  assert.strictEqual(signedAmountRows[1][0], '2026-02-11');
  assert.strictEqual(signedAmountRows[1][3], '123.45');
  assert.strictEqual(signedAmountRows[1][4], '');
  assert.strictEqual(signedAmountRows[2][0], '2026-01-02');
  assert.strictEqual(signedAmountRows[2][3], '');
  assert.strictEqual(signedAmountRows[2][4], '54.3');

  const splitDateRows = buildMappedRows({
    inputFilePath: context.datePartsDataPath,
    mappingByField: {
      BillDate: ['Year', 'Date'],
      Currency: 'Currency',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    },
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount']
  });
  assert.strictEqual(splitDateRows[1][0], '2026-02-02');
  assert.strictEqual(splitDateRows[2][0], '2026-03-03');

  const rawStatementRows = buildMappedRows({
    inputFilePath: context.rawStatementPath,
    expectedSourceHeaders: state.headers,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: '原字段G',
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    currencyMappings
  });
  assert.strictEqual(rawStatementRows.rowMetas[0].sourceRowNumber, 3);
  assert.strictEqual(rawStatementRows[1][0], '456.78');
  assert.strictEqual(rawStatementRows[2][0], '99.99');

  const rawStatementWithSummaryRows = buildMappedRows({
    inputFilePath: context.rawStatementWithSummaryPath,
    expectedSourceHeaders: ['交易时间', '收入金额', '支出金额', '账户余额', '对方账号', '对方户名', '对方开户行', '交易用途', '摘要'],
    mappingByField: {
      Balance: '账户余额',
      BillDate: '交易时间',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}ABC`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}BIG_001`,
      Currency: `${FIXED_FIELD_VALUE_PREFIX}USD`,
      'Credit Amount': '收入金额',
      'Debit Amount': '支出金额'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount']
  });
  assert.strictEqual(rawStatementWithSummaryRows.length, 2);
  assert.strictEqual(rawStatementWithSummaryRows.rowMetas[0].sourceRowNumber, 4);
  assert.strictEqual(rawStatementWithSummaryRows[1][1], '2026-03-02');
  assert.strictEqual(rawStatementWithSummaryRows[1][3], 'BIG_001');
  assert.strictEqual(rawStatementWithSummaryRows[1][4], 'USD');

  const simultaneousAmountRows = buildMappedRows({
    inputFilePath: context.simultaneousAmountDataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: '原字段G',
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount']
  });
  const simultaneousExportRows = buildDetailExportRows(simultaneousAmountRows);
  assert.strictEqual(simultaneousExportRows.length, 1);
  assert.strictEqual(simultaneousExportRows.skippedRows.length, 0);
  assert.strictEqual(simultaneousExportRows.simultaneousRows.length, 1);
  assert.strictEqual(simultaneousExportRows.simultaneousRows[0].sourceRowNumber, 2);

  const skippedAmountRows = buildMappedRows({
    inputFilePath: context.skippedAmountDataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: `${FIXED_FIELD_VALUE_PREFIX}SELF_INPUT_001`,
      Currency: '原字段G',
      'Credit Amount': '原字段A',
      'Debit Amount': '原字段B'
    },
    orderedTargetFields: ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount']
  });
  const filteredExportRows = buildDetailExportRows(skippedAmountRows);
  assert.strictEqual(filteredExportRows.length, 2);
  assert.strictEqual(filteredExportRows.skippedRows.length, 2);
  assert.deepStrictEqual(filteredExportRows[1], ['2026-03-09', '20260310', 'CHB', 'SELF_INPUT_001', '美元', '100', '']);
  assert.strictEqual(filteredExportRows.sourceRows.length, 2);
  assert.strictEqual(filteredExportRows.sourceRows.rowMetas.length, 1);
  assert.strictEqual(filteredExportRows.sourceRows[1][0], '456.78');
  assert.strictEqual(filteredExportRows.sourceRows[1][6], '100');
  assert.strictEqual(filteredExportRows.sourceRows[1][7], '');

  assert.strictEqual(
    inferEndingBalance({
      previousEndBalance: 606784530.83,
      dateLabel: '2026-02-12',
      entries: [
        {
          balanceValue: 466784381.89,
          creditAmount: 0,
          debitAmount: 40000074.47
        },
        {
          balanceValue: 506784456.36,
          creditAmount: 0,
          debitAmount: 100000074.47
        }
      ]
    }),
    466784381.89
  );
  assert.strictEqual(
    calculateEndingBalanceFromAmounts({
      previousEndBalance: 456.78,
      entries: [
        {
          creditAmount: 100,
          debitAmount: 0
        },
        {
          creditAmount: 0,
          debitAmount: 25.5
        }
      ]
    }),
    531.28
  );

  return {
    detailExportRows,
    detailRows
  };
}

function runWorkbookScenario(context, state) {
  writeWorkbookRows({
    rows: state.detailExportRows,
    outputFilePath: context.detailOutputPath
  });
  writeBalanceWorkbook({
    templateFilePath: context.balanceTemplatePath,
    records: [['CHB', 'HK', 'USD', 'SELF_INPUT_001', '2026-03-09', '', '', 456.78, '']],
    outputFilePath: context.balanceOutputPath
  });

  assert(fs.existsSync(context.detailOutputPath));
  const workbook = XLSX.readFile(context.detailOutputPath, {
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  const worksheet = workbook.Sheets.COMMON;
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: ''
  });
  assert.deepStrictEqual(rows[0], ['BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Extra Information']);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[1][2], 'CHB');
  assert.strictEqual(rows[1][3], 'SELF_INPUT_001');
  assert.strictEqual(rows[1][4], 'USD');
  assert.strictEqual(rows[1][7], '');
  assert.strictEqual(rows[2][4], 'HKD');
  assert.strictEqual(worksheet.A2.v, 46090);
  assert.strictEqual(worksheet.A2.t, 'n');
  assert.strictEqual(worksheet.A2.z, 'yyyy-mm-dd');
  assert.strictEqual(worksheet.B2.t, 'n');
  assert.strictEqual(worksheet.B2.z, 'yyyymmdd');
  assert.strictEqual(worksheet.C2.t, 's');
  assert.strictEqual(worksheet.C2.z, '@');
  assert.strictEqual(worksheet.D2.t, 's');
  assert.strictEqual(worksheet.D2.z, '@');
  assert.strictEqual(worksheet.F2.v, 1234.56);
  assert.strictEqual(worksheet.F2.t, 'n');
  assert.strictEqual(worksheet.F2.z, '0.00');
  assert.strictEqual(worksheet.G2.v, '');
  assert.strictEqual(worksheet.F3.v, '');
  assert.strictEqual(worksheet.G3.v, 789.01);
  assert.strictEqual(worksheet.G3.t, 'n');
  assert.strictEqual(worksheet.G3.z, '0.00');

  assert(fs.existsSync(context.balanceOutputPath));
  const balanceWorkbook = XLSX.readFile(context.balanceOutputPath, {
    raw: true,
    cellNF: true,
    cellStyles: true
  });
  const balanceSheet = balanceWorkbook.Sheets[balanceWorkbook.SheetNames[0]];
  const balanceRows = XLSX.utils.sheet_to_json(balanceSheet, {
    header: 1,
    defval: ''
  });
  assert.strictEqual(balanceRows[1][0], 'CHB');
  assert.strictEqual(balanceRows[1][7], 456.78);
  assert.strictEqual(balanceRows[1][9], '');
  assert.strictEqual(balanceSheet.D2.t, 's');
  assert.strictEqual(balanceSheet.D2.z, '@');
  assert.strictEqual(balanceSheet.E2.t, 'n');
  assert.strictEqual(balanceSheet.E2.z, 'yyyy-mm-dd');
  assert.strictEqual(balanceSheet.H2.t, 'n');
  assert.strictEqual(balanceSheet.H2.z, '0.00');
}

function runLoggingScenario(context) {
  const report = writeErrorReport(context.errorReportRoot, {
    step: '导入网银明细文件',
    templateName: 'template',
    message: '测试错误摘要',
    errorCode: 'TEST_ERROR'
  });
  assert(/^\d{8}-\d{6}-template-导入网银明细文件\.txt$/.test(report.fileName));

  const firstSeedWrite = upsertBalanceSeedRecord(context.storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 456.78
  });
  assert.strictEqual(firstSeedWrite.status, 'success');
  assert.strictEqual(readBalanceSeedRecords(context.storageRoot, 'LusoBank').length, 1);
  assert.strictEqual(readBalanceSeedRecords(context.storageRoot, 'LusoBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.manual);
  const seedLookup = findPreviousBalanceSeed(context.storageRoot, {
    bankName: 'LusoBank',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    beforeBillDate: '2026-02-12'
  });
  assert.strictEqual(seedLookup.endBalance, 456.78);
  const duplicateSeedWrite = upsertBalanceSeedRecord(context.storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 500.12
  });
  assert.strictEqual(duplicateSeedWrite.status, 'confirm-overwrite');
  const overwriteSeedWrite = upsertBalanceSeedRecord(context.storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 500.12,
    generationMethod: BALANCE_SEED_GENERATION_METHODS.calculated,
    overwrite: true
  });
  assert.strictEqual(overwriteSeedWrite.status, 'success');
  assert.strictEqual(readBalanceSeedRecords(context.storageRoot, 'LusoBank')[0].endBalance, 500.12);
  assert.strictEqual(readBalanceSeedRecords(context.storageRoot, 'LusoBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.calculated);
  fs.mkdirSync(`${context.storageRoot}/balance-seeds`, { recursive: true });
  fs.writeFileSync(
    `${context.storageRoot}/balance-seeds/LegacyBank.json`,
    JSON.stringify([
      {
        merchantId: 'LEGACY_001',
        currency: 'HKD',
        billDate: '2026-01-31',
        endBalance: 88.66,
        templateName: 'LegacyBank-HK',
        updatedAt: '2026-03-11T00:00:00.000Z'
      }
    ], null, 2),
    'utf8'
  );
  assert.strictEqual(readBalanceSeedRecords(context.storageRoot, 'LegacyBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.manual);

  appendActivityRecord(context.activityLogPath, {
    level: 'info',
    message: '执行导出',
    details: ['模板名：template']
  });
  // v2.1.12 SR-log-1：appendActivityRecord 不再写旧 txt，改查新结构 JSON Lines（<root>/logs/YYYY-MM/MM-DD/info.log）
  const _alNow = new Date();
  const _alInfoLog = path.join(path.dirname(context.activityLogPath), 'logs',
    `${_alNow.getFullYear()}-${String(_alNow.getMonth() + 1).padStart(2, '0')}`,
    `${String(_alNow.getMonth() + 1).padStart(2, '0')}-${String(_alNow.getDate()).padStart(2, '0')}`,
    'info.log');
  const activityLogContent = fs.readFileSync(_alInfoLog, 'utf8');
  assert(activityLogContent.includes('执行导出'));
  assert(!fs.existsSync(context.activityLogPath), '旧 app_activity_log.txt 不再创建');

  const startupError = new Error('旧数据库迁移失败');
  const dialogCalls = [];
  const exitCalls = [];
  const startupDialogMessage = buildStartupFailureDialogMessage(startupError, context.startupFailureLogPath);
  assert(startupDialogMessage.includes('错误摘要：旧数据库迁移失败'));
  assert(startupDialogMessage.includes(`日志文件：${context.startupFailureLogPath}`));
  reportStartupFailure({
    error: startupError,
    logFilePath: context.startupFailureLogPath,
    appendRecord: (filePath, payload) => appendActivityRecord(filePath, payload),
    showErrorBox: (title, message) => dialogCalls.push({ title, message }),
    exit: (exitCode) => exitCalls.push(exitCode)
  });
  assert.strictEqual(dialogCalls.length, 1);
  assert.strictEqual(dialogCalls[0].title, '网银账单小助手启动失败');
  assert(dialogCalls[0].message.includes('错误摘要：旧数据库迁移失败'));
  assert.strictEqual(exitCalls.length, 1);
  assert.strictEqual(exitCalls[0], 1);
  // v2.1.12 SR-log-1：启动失败日志改写新结构 JSON Lines（不再写 startup-failure.log 旧 txt）
  const _sfNow = new Date();
  const _sfErrorLog = path.join(path.dirname(context.startupFailureLogPath), 'logs',
    `${_sfNow.getFullYear()}-${String(_sfNow.getMonth() + 1).padStart(2, '0')}`,
    `${String(_sfNow.getMonth() + 1).padStart(2, '0')}-${String(_sfNow.getDate()).padStart(2, '0')}`,
    'error.log');
  const startupFailureLogContent = fs.readFileSync(_sfErrorLog, 'utf8');
  assert(startupFailureLogContent.includes('应用启动失败'));

  const mainSource = fs.readFileSync(`${context.projectRoot}/src/main.js`, 'utf8');
  assert(
    /let balanceSeedStatus = \{\s*missing: 0,\s*missingIndexByKey: new Map\(\)\s*\};/.test(mainSource),
    '余额补录链路应在 try 外预置 balanceSeedStatus，避免 BALANCE_SEED_REQUIRED 时触发 ReferenceError'
  );
}

// v1.5.3 R1 (T1.9)：月度余额装配场景 — 7 个 P0 用例全链路覆盖
// 用独立 tmpdir + 独立 DB，避免污染其它 smoke 场景的共享 DB
function runMonthlyBalanceScenario() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { AppDatabase } = require('../../src/backend/database');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-smoke-'));

  try {
    // utility sanity
    assert.strictEqual(lastDayOfMonth(2024, 2), 29, 'leap year feb');
    assert.strictEqual(lastDayOfMonth(2026, 2), 28, 'non-leap feb');
    assert.strictEqual(lastDayOfMonth(2026, 3), 31);
    assert.strictEqual(lastDayOfMonth(2026, 12), 31);
    assert.strictEqual(lastDayOfMonth(2026, 13), null);
    assert.strictEqual(buildTargetLastDay(2026, 3), '2026-03-31');
    assert.strictEqual(buildTargetLastDay(2026, 10), '2026-10-31');

    // listBalanceSeedBankNames helper sanity
    assert.deepStrictEqual(listBalanceSeedBankNames(root), [], 'empty dir -> []');

    // pickLatestSeedForAccount helper sanity
    const seeds = [
      { merchantId: 'A', currency: 'CNY', billDate: '2026-03-31', endBalance: 100 },
      { merchantId: 'A', currency: 'CNY', billDate: '2026-02-28', endBalance: 50 },
      { merchantId: 'A', currency: 'USD', billDate: '2026-04-30', endBalance: 999 }
    ];
    assert.strictEqual(pickLatestSeedForAccount(seeds, 'A', 'CNY', '2026-03-31').reason, 'exact');
    assert.strictEqual(pickLatestSeedForAccount(seeds, 'A', 'CNY', '2026-04-30').reason, 'fallback');
    assert.strictEqual(pickLatestSeedForAccount(seeds, 'A', 'USD', '2026-03-31').chosen, null);
    assert.strictEqual(pickLatestSeedForAccount(seeds, 'B', 'CNY', '2026-03-31').chosen, null);

    // 构建 DB + 模板
    const db = new AppDatabase(path.join(root, 'app.sqlite'));
    db.init();
    const t1 = db.upsertTemplate({ name: '中行-北京', sourceFileName: 'a.xlsx', headers: ['h'] });
    const t2 = db.upsertTemplate({ name: '建行-上海', sourceFileName: 'b.xlsx', headers: ['h'] });
    const t3 = db.upsertTemplate({ name: '工行-深圳', sourceFileName: 'c.xlsx', headers: ['h'] });

    // 构造主模板 + 子模板 — 验证 Q5 "普通模板" 不包含它们
    const tParent = db.upsertTemplate({ name: '招商', sourceFileName: 'p.xlsx', headers: ['h'] });
    db.setParentStatus(tParent.id, true);
    const tChild = db.upsertTemplate({ name: '招商-北京', sourceFileName: 'ch.xlsx', headers: ['h'] });
    db.setChildParent(tChild.id, tParent.id);

    // 3 模板 × 2 大账号 × 2 币种 = 12 组合；另加 1 个自有账号（验证 Q6）
    db.saveMappings(t1.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
      { merchantId: 'BOC_CLIENT_1', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'BOC_CLIENT_1', currency: 'USD', accountNature: 'client' },
      { merchantId: 'BOC_CLIENT_2', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'BOC_CLIENT_2', currency: 'USD', accountNature: 'client' },
      { merchantId: 'BOC_OWN_1', currency: 'CNY', accountNature: 'own' }
    ]);
    db.saveMappings(t2.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
      { merchantId: 'CCB_CLIENT_1', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'CCB_CLIENT_1', currency: 'USD', accountNature: 'client' },
      { merchantId: 'CCB_CLIENT_2', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'CCB_CLIENT_2', currency: 'USD', accountNature: 'client' }
    ]);
    db.saveMappings(t3.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
      { merchantId: 'ICBC_CLIENT_1', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'ICBC_CLIENT_1', currency: 'USD', accountNature: 'client' },
      { merchantId: 'ICBC_CLIENT_2', currency: 'CNY', accountNature: 'client' },
      { merchantId: 'ICBC_CLIENT_2', currency: 'USD', accountNature: 'client' }
    ]);

    // 构造 seeds：每账号每币种在 2026-03-31 都有精确记录；1 个 USD 账号仅有未来 seed；1 个账号完全无 seed
    writeBalanceSeedRecords(root, '中行', [
      { merchantId: 'BOC_CLIENT_1', currency: 'CNY', billDate: '2026-03-31', endBalance: 1000.01, templateName: '中行-北京', updatedAt: '' },
      { merchantId: 'BOC_CLIENT_1', currency: 'USD', billDate: '2026-03-31', endBalance: 100.01, templateName: '中行-北京', updatedAt: '' },
      { merchantId: 'BOC_CLIENT_2', currency: 'CNY', billDate: '2026-02-28', endBalance: 900.00, templateName: '中行-北京', updatedAt: '' }, // 兜底
      { merchantId: 'BOC_CLIENT_2', currency: 'USD', billDate: '2026-04-30', endBalance: 500.00, templateName: '中行-北京', updatedAt: '' }, // 未来 → 排除
      { merchantId: 'BOC_OWN_1', currency: 'CNY', billDate: '2026-03-15', endBalance: 77.77, templateName: '中行-北京', updatedAt: '' } // 自有兜底
    ]);
    writeBalanceSeedRecords(root, '建行', [
      { merchantId: 'CCB_CLIENT_1', currency: 'CNY', billDate: '2026-03-31', endBalance: 2000.00, templateName: '建行-上海', updatedAt: '' },
      { merchantId: 'CCB_CLIENT_1', currency: 'USD', billDate: '2026-03-31', endBalance: 200.00, templateName: '建行-上海', updatedAt: '' },
      { merchantId: 'CCB_CLIENT_2', currency: 'CNY', billDate: '2026-03-31', endBalance: 2500.00, templateName: '建行-上海', updatedAt: '' },
      { merchantId: 'CCB_CLIENT_2', currency: 'USD', billDate: '2026-03-31', endBalance: 250.00, templateName: '建行-上海', updatedAt: '' }
    ]);
    writeBalanceSeedRecords(root, '工行', [
      { merchantId: 'ICBC_CLIENT_1', currency: 'CNY', billDate: '2026-03-31', endBalance: 3000.00, templateName: '工行-深圳', updatedAt: '' },
      { merchantId: 'ICBC_CLIENT_1', currency: 'USD', billDate: '2026-03-31', endBalance: 300.00, templateName: '工行-深圳', updatedAt: '' },
      { merchantId: 'ICBC_CLIENT_2', currency: 'CNY', billDate: '2026-03-31', endBalance: 3500.00, templateName: '工行-深圳', updatedAt: '' }
      // ICBC_CLIENT_2/USD 完全无 seed → 跳过
    ]);

    // -----------------------------------------------------------------------
    // 场景 1（P0-10 对应）：全部银行渠道 × 2026-03 → 中行 4 + 建行 4 + 工行 3 = 11 条；自有账号未计入 client 场景外应被包含
    // 中行：BOC_CLIENT_1/CNY+USD（exact）= 2；BOC_CLIENT_2/CNY（兜底 2026-02-28）= 1；BOC_CLIENT_2/USD 未来排除 = 0；BOC_OWN_1/CNY（兜底）= 1 → 4
    // 建行：4 条 exact
    // 工行：3 条 exact（ICBC_CLIENT_2/USD 无 seed → 排除）
    // 合计 11 条；templates 只有 3 个普通模板（主模板 + 子模板不参与）
    const r1 = assembleMonthlyBalance({
      templateScope: ALL_BANKS_TEMPLATE_SCOPE,
      year: 2026, month: 3,
      db, storageRoot: root
    });
    assert.strictEqual(r1.records.length, 11, `场景1 全部银行渠道 → 期望 11 条，实际 ${r1.records.length}`);
    assert.strictEqual(r1.templates.length, 3, `场景1 普通模板 → 期望 3，实际 ${r1.templates.length}`);
    assert(
      !r1.templates.some((t) => t.name === '招商' || t.name === '招商-北京'),
      '场景1 主模板/子模板 不应出现'
    );
    // Q6 自有账号出现在 R1 records
    assert(
      r1.records.some((r) => r.merchantId === 'BOC_OWN_1'),
      '场景1 自有账号 BOC_OWN_1 应出现（§3.1 R1 唯一放行）'
    );

    // -----------------------------------------------------------------------
    // 场景 2（P0-4 对应）：单模板 × 2026-03 某账号在月末恰好有记录 → exact
    const r2 = assembleMonthlyBalance({
      templateScope: '建行-上海',
      year: 2026, month: 3,
      db, storageRoot: root
    });
    assert.strictEqual(r2.records.length, 4, `场景2 建行-上海 2026-03 → 期望 4 条，实际 ${r2.records.length}`);
    const ccbC1CNY = r2.records.find((r) => r.merchantId === 'CCB_CLIENT_1' && r.currency === 'CNY');
    assert(ccbC1CNY, '场景2 CCB_CLIENT_1/CNY 应存在');
    assert.strictEqual(ccbC1CNY.billDate, '2026-03-31', '场景2 exact → billDate 应为 2026-03-31');
    assert.strictEqual(ccbC1CNY.endBalance, 2000.00, '场景2 endBalance 应为 2000.00');
    assert.strictEqual(ccbC1CNY.pickReason, 'exact');

    // -----------------------------------------------------------------------
    // 场景 3（P0-5 对应）：单模板 × 2026-03 某账号仅有 2026-02-28 → 兜底
    // 中行-北京 BOC_CLIENT_2/CNY 仅有 2026-02-28
    // v2.0.0 反转：billDate 统一为月末日（targetLastDay）；endBalance 仍是 chosen.endBalance；pickReason 仍区分 exact/fallback
    const r3 = assembleMonthlyBalance({
      templateScope: '中行-北京',
      year: 2026, month: 3,
      db, storageRoot: root
    });
    const bocC2CNY = r3.records.find((r) => r.merchantId === 'BOC_CLIENT_2' && r.currency === 'CNY');
    assert(bocC2CNY, '场景3 BOC_CLIENT_2/CNY 应存在');
    assert.strictEqual(bocC2CNY.billDate, '2026-03-31', '场景3 兜底 → billDate 仍为月末日 2026-03-31（v2.0.0 反转：不再用 seed 实际日期 2026-02-28）');
    assert.strictEqual(bocC2CNY.endBalance, 900.00, '场景3 endBalance 应为 900.00（仍是 2026-02-28 那条 seed 的余额）');
    assert.strictEqual(bocC2CNY.pickReason, 'fallback');

    // -----------------------------------------------------------------------
    // 场景 4（P0-6 对应）：某账号所有 seeds 都 > 月末 → 不出现
    // 中行-北京 BOC_CLIENT_2/USD 只有 2026-04-30
    const bocC2USD = r3.records.find((r) => r.merchantId === 'BOC_CLIENT_2' && r.currency === 'USD');
    assert.strictEqual(bocC2USD, undefined, '场景4 BOC_CLIENT_2/USD 全部 billDate > 月末 → 不应出现在 records');
    const missingC2USD = r3.stats.missingAccounts.find(
      (m) => m.merchantId === 'BOC_CLIENT_2' && m.currency === 'USD'
    );
    assert(missingC2USD, '场景4 应记入 missingAccounts');
    assert.strictEqual(missingC2USD.reason, 'no-candidates');

    // -----------------------------------------------------------------------
    // 场景 5：某账号完全无 seeds → 不出现
    // 工行-深圳 ICBC_CLIENT_2/USD 完全无 seed
    const r4 = assembleMonthlyBalance({
      templateScope: '工行-深圳',
      year: 2026, month: 3,
      db, storageRoot: root
    });
    const icbcC2USD = r4.records.find((r) => r.merchantId === 'ICBC_CLIENT_2' && r.currency === 'USD');
    assert.strictEqual(icbcC2USD, undefined, '场景5 ICBC_CLIENT_2/USD 无 seed → 不应出现');
    assert.strictEqual(r4.records.length, 3, `场景5 工行-深圳 → 期望 3 条（排除无 seed 的 USD），实际 ${r4.records.length}`);

    // -----------------------------------------------------------------------
    // 场景 6（P0-7 对应）：空输入 — 所有大账号无 seed / 未来 seed
    // 构造独立 tmpdir + DB 来隔离
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-smoke-empty-'));
    try {
      const db2 = new AppDatabase(path.join(root2, 'app.sqlite'));
      db2.init();
      const tX = db2.upsertTemplate({ name: '某行-某地', sourceFileName: 'x.xlsx', headers: ['h'] });
      db2.saveMappings(tX.id, [{ templateField: 'MerchantId', mappedField: 'h' }], [
        { merchantId: 'X_CLIENT_1', currency: 'CNY', accountNature: 'client' }
      ]);
      // 完全无 seeds 目录
      const r5 = assembleMonthlyBalance({
        templateScope: ALL_BANKS_TEMPLATE_SCOPE,
        year: 2026, month: 3,
        db: db2, storageRoot: root2
      });
      assert.strictEqual(r5.records.length, 0, '场景6 空输入 → records.length === 0');
      assert.strictEqual(r5.stats.missingAccounts.length, 1, '场景6 missingAccounts 仍应记录 X_CLIENT_1');
      db2.db.close();
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }

    // -----------------------------------------------------------------------
    // 场景 7（P0-11 对应）：自有账号有 seeds → 出现在 R1 导出（Q6 唯一放行）
    const r6 = assembleMonthlyBalance({
      templateScope: '中行-北京',
      year: 2026, month: 3,
      db, storageRoot: root
    });
    const ownInResult = r6.records.find((r) => r.merchantId === 'BOC_OWN_1');
    assert(ownInResult, '场景7 自有账号 BOC_OWN_1 应出现在 R1 records');
    // v2.0.0 反转：billDate 统一为月末日 2026-03-31（不再用 seed 实际日期 2026-03-15）；endBalance 仍是 77.77
    assert.strictEqual(ownInResult.billDate, '2026-03-31');
    assert.strictEqual(ownInResult.endBalance, 77.77);

    // toBalanceRows 字段对齐（模拟 balanceTemplateFields）
    const rows = toBalanceRows(r6.records, ['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额']);
    assert.strictEqual(rows.length, r6.records.length);
    assert.strictEqual(rows[0].length, 6);
    // 随机抽查一行字段位置
    const bocOwnRow = rows.find((row) => row[2] === 'BOC_OWN_1');
    assert(bocOwnRow);
    assert.strictEqual(bocOwnRow[0], '中行'); // 银行名称
    assert.strictEqual(bocOwnRow[1], '北京'); // 所在地
    assert.strictEqual(bocOwnRow[3], 'CNY'); // 币种
    assert.strictEqual(bocOwnRow[5], 77.77); // 期末余额

    db.db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runSmokeScenarios(context) {
  const databaseState = runDatabaseScenario(context);
  const assetState = runAssetAndDateScenario(context);
  const mappingState = runMappingScenario(context, {
    ...databaseState,
    ...assetState
  });
  runWorkbookScenario(context, mappingState);
  runLoggingScenario(context);
  // v1.5.3 R1 (T1.9)：月度余额装配场景
  runMonthlyBalanceScenario();
}

module.exports = {
  runSmokeScenarios
};
