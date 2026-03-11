const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { AppDatabase } = require('../src/backend/database');
const {
  calculateEndingBalanceFromAmounts,
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  FIXED_FIELD_VALUE_PREFIX,
  inferEndingBalance,
  loadCurrencyMappings,
  loadEnumValues,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../src/backend/file-service');
const {
  appendActivityRecord,
  ensureActivityLogFile,
  writeErrorReport
} = require('../src/backend/logger');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  upsertBalanceSeedRecord
} = require('../src/backend/balance-seed-store');

function makeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bill-tool-'));
  const projectRoot = path.resolve(__dirname, '..');
  const bundledEnumPath = path.join(projectRoot, 'COMMON枚举.xlsx');
  const currencyMappingPath = path.join(projectRoot, 'assets', '币种映射表.xlsx');
  const iconSourcePath = path.join(projectRoot, 'assets', 'app-icon-source.png');
  const runtimeIconPath = path.join(projectRoot, 'assets', 'app-icon.ico');
  const buildIconPath = path.join(projectRoot, 'build', 'icon.ico');
  const dbPath = path.join(root, 'app.sqlite');
  const templatePath = path.join(root, 'template.xlsx');
  const dataPath = path.join(root, 'input.xlsx');
  const unmappedDataPath = path.join(root, 'input-unmapped.xlsx');
  const amountMappingDataPath = path.join(root, 'amount-mapping-input.xlsx');
  const simultaneousAmountDataPath = path.join(root, 'input-simultaneous.xlsx');
  const detailOutputPath = path.join(root, '2026-03-09', 'detail', 'template-COMMON-2026-03-09~2026-03-10.xlsx');
  const balanceTemplatePath = path.join(root, 'balance-template.xlsx');
  const balanceOutputPath = path.join(root, '2026-03-09', 'balance', 'template-Balance-2026-03-09.xlsx');
  const errorReportRoot = path.join(root, 'reports');
  const activityLogPath = path.join(root, 'app_activity_log.txt');
  const storageRoot = path.join(root, 'storage');

  makeWorkbook(templatePath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['值1', '值2', '值3', '值4', '值5', '值6', '值7', '值8']
  ]);
  makeWorkbook(dataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['$1,234.56CR', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', 'BAL 456.78元'],
    ['', 'DB789.01元', '2026-03-10', '20260311', 'NET_002', 99, '港元', '99.99']
  ]);
  makeWorkbook(unmappedDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '测试币', '456.78']
  ]);
  makeWorkbook(amountMappingDataPath, [
    ['户名源', '账号源', '收入', '支出', '账单日期'],
    ['收款户名', '收款账号', '100', '', '2026-03-09'],
    ['付款户名', '付款账号', '', '200', '2026-03-10']
  ]);
  makeWorkbook(simultaneousAmountDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78']
  ]);
  makeWorkbook(balanceTemplatePath, [
    ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额', '扩展字段'],
    ['旧银行', '旧地点', '旧币种', '旧账号', '旧日期', '旧期初', '旧可用', '旧期末', '旧期末可用', '旧扩展']
  ]);

  const db = new AppDatabase(dbPath);
  db.init();

  const headers = extractHeaders(templatePath);
  assert.deepStrictEqual(headers, ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H']);

  const template = db.upsertTemplate({
    name: 'template',
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
    { templateField: '原字段A', mappedField: 'Credit Amount' },
    { templateField: '原字段B', mappedField: 'Debit Amount' },
    { templateField: '原字段C', mappedField: 'BillDate' },
    { templateField: '原字段D', mappedField: 'ValueDate' },
    { templateField: '原字段E', mappedField: 'MerchantId' },
    { templateField: '原字段F', mappedField: 'Channel' }
  ]);
  db.saveAccountMappings([
    {
      bankAccountId: 'NET_001',
      clearingAccountId: 'CLEAR_9001'
    }
  ]);

  assert(fs.existsSync(bundledEnumPath));
  assert(fs.existsSync(currencyMappingPath));
  assert(fs.existsSync(iconSourcePath));
  assert(fs.existsSync(runtimeIconPath));
  assert(fs.existsSync(buildIconPath));
  const enumValues = loadEnumValues(bundledEnumPath);
  const currencyMappings = loadCurrencyMappings(currencyMappingPath);
  assert.strictEqual(enumValues[0], 'BillDate');
  assert(enumValues.includes('Credit Amount'));
  assert(enumValues.includes('MerchantId'));
  assert.strictEqual(enumValues.includes('COMMON字段'), false);
  assert(currencyMappings.length > 0);

  const detailRows = buildMappedRows({
    inputFilePath: dataPath,
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
  writeWorkbookRows({
    rows: detailExportRows,
    outputFilePath: detailOutputPath
  });

  const unmappedRows = buildMappedRows({
    inputFilePath: unmappedDataPath,
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
    inputFilePath: dataPath,
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

  const amountMappingRows = buildMappedRows({
    inputFilePath: amountMappingDataPath,
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

  const simultaneousAmountRows = buildMappedRows({
    inputFilePath: simultaneousAmountDataPath,
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

  writeBalanceWorkbook({
    templateFilePath: balanceTemplatePath,
    records: [['CHB', 'HK', 'USD', 'SELF_INPUT_001', '2026-03-09', '', '', 456.78, '']],
    outputFilePath: balanceOutputPath
  });

  assert(fs.existsSync(detailOutputPath));
  const workbook = XLSX.readFile(detailOutputPath, {
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
  assert.strictEqual(worksheet.B2.z, 'yyyy-mm-dd');
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

  assert(fs.existsSync(balanceOutputPath));
  const balanceWorkbook = XLSX.readFile(balanceOutputPath, {
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

  const report = writeErrorReport(errorReportRoot, {
    step: '导入网银明细文件',
    templateName: 'template',
    message: '测试错误摘要',
    errorCode: 'TEST_ERROR'
  });
  assert(/^\d{8}-\d{6}-template-导入网银明细文件\.txt$/.test(report.fileName));

  const firstSeedWrite = upsertBalanceSeedRecord(storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 456.78
  });
  assert.strictEqual(firstSeedWrite.status, 'success');
  assert.strictEqual(readBalanceSeedRecords(storageRoot, 'LusoBank').length, 1);
  assert.strictEqual(readBalanceSeedRecords(storageRoot, 'LusoBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.manual);
  const seedLookup = findPreviousBalanceSeed(storageRoot, {
    bankName: 'LusoBank',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    beforeBillDate: '2026-02-12'
  });
  assert.strictEqual(seedLookup.endBalance, 456.78);
  const duplicateSeedWrite = upsertBalanceSeedRecord(storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 500.12
  });
  assert.strictEqual(duplicateSeedWrite.status, 'confirm-overwrite');
  const overwriteSeedWrite = upsertBalanceSeedRecord(storageRoot, {
    templateName: 'LusoBank-MO',
    merchantId: 'SELF_INPUT_001',
    currency: 'USD',
    billDate: '2026-01-31',
    endBalance: 500.12,
    generationMethod: BALANCE_SEED_GENERATION_METHODS.calculated,
    overwrite: true
  });
  assert.strictEqual(overwriteSeedWrite.status, 'success');
  assert.strictEqual(readBalanceSeedRecords(storageRoot, 'LusoBank')[0].endBalance, 500.12);
  assert.strictEqual(readBalanceSeedRecords(storageRoot, 'LusoBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.calculated);
  fs.mkdirSync(path.join(storageRoot, 'balance-seeds'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'balance-seeds', 'LegacyBank.json'),
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
  assert.strictEqual(readBalanceSeedRecords(storageRoot, 'LegacyBank')[0].generationMethod, BALANCE_SEED_GENERATION_METHODS.manual);

  ensureActivityLogFile(activityLogPath);
  appendActivityRecord(activityLogPath, {
    level: 'info',
    message: '执行导出',
    details: ['模板名：template']
  });
  const activityLogContent = fs.readFileSync(activityLogPath, 'utf8');
  assert(activityLogContent.includes('[INFO] 执行导出 | 模板名：template'));

  console.log('smoke test passed');
}

run();
