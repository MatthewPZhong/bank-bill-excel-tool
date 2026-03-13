const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
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
  normalizeDateExportValue,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../src/backend/file-service');
const {
  appendActivityRecord,
  ensureActivityLogFile,
  writeErrorReport
} = require('../src/backend/logger');
const {
  buildStartupFailureDialogMessage,
  reportStartupFailure
} = require('../src/backend/startup-failure');
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

function makeLegacyDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_file_name TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      template_field TEXT NOT NULL,
      mapped_field TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
      UNIQUE(template_id, row_index)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id TEXT NOT NULL UNIQUE,
      clearing_account_id TEXT NOT NULL,
      row_index INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db
    .prepare(`
      INSERT INTO templates (name, source_file_name, headers_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-template',
      'legacy.xlsx',
      JSON.stringify(['字段A', '字段B']),
      '2026-03-12T00:00:00.000Z',
      '2026-03-12T00:00:00.000Z'
    );
  db.close();
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
  const signedAmountDataPath = path.join(root, 'input-signed-amount.xlsx');
  const simultaneousAmountDataPath = path.join(root, 'input-simultaneous.xlsx');
  const skippedAmountDataPath = path.join(root, 'input-skipped-amounts.xlsx');
  const rawStatementPath = path.join(root, 'input-raw-statement.xlsx');
  const detailOutputPath = path.join(root, '2026-03-09', 'detail', 'template-COMMON-2026-03-09~2026-03-10.xlsx');
  const balanceTemplatePath = path.join(root, 'balance-template.xlsx');
  const balanceOutputPath = path.join(root, '2026-03-09', 'balance', 'template-Balance-2026-03-09.xlsx');
  const errorReportRoot = path.join(root, 'reports');
  const activityLogPath = path.join(root, 'app_activity_log.txt');
  const startupFailureLogPath = path.join(root, 'startup-failure.log');
  const storageRoot = path.join(root, 'storage');
  const legacyDbPath = path.join(root, 'legacy.sqlite');

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
  makeWorkbook(signedAmountDataPath, [
    ['账单日期', '发生额', '银行账号'],
    ['11/02/26 09:01:19', '+123.45', 'NET_001'],
    ['2026/1/2 09:01:19', '-54.3', 'NET_001']
  ]);
  makeWorkbook(simultaneousAmountDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78']
  ]);
  makeWorkbook(skippedAmountDataPath, [
    ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'],
    ['100', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78'],
    ['', '', '2026-03-10', '20260311', 'NET_001', 88, '美元', '460.00'],
    ['0', '0', '2026-03-11', '20260312', 'NET_001', 88, '美元', '470.00']
  ]);
  makeWorkbook(rawStatementPath, [
    ['账户信息', '', '', '', '', '', '', '', '', ''],
    ['', '原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H', '脏列'],
    ['', '$1,234.56CR', '', '2026-03-09', '20260310', 'NET_001', 88, '美元', 'BAL 456.78元', '忽略'],
    ['', '', 'DB789.01元', '2026-03-10', '20260311', 'NET_002', 99, '港元', '99.99', '忽略']
  ]);
  makeWorkbook(balanceTemplatePath, [
    ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额', '扩展字段'],
    ['旧银行', '旧地点', '旧币种', '旧账号', '旧日期', '旧期初', '旧可用', '旧期末', '旧期末可用', '旧扩展']
  ]);
  makeLegacyDatabase(legacyDbPath);

  const db = new AppDatabase(dbPath);
  db.init();
  const migratedDb = new AppDatabase(legacyDbPath);
  migratedDb.init();
  migratedDb.db.close();

  const migratedRawDb = new DatabaseSync(legacyDbPath);
  const templateColumns = migratedRawDb.prepare('PRAGMA table_info(templates)').all();
  assert(templateColumns.some((column) => column.name === 'template_key'));
  const migratedTemplate = migratedRawDb
    .prepare('SELECT template_key AS templateKey FROM templates WHERE name = ?')
    .get('legacy-template');
  assert(migratedTemplate.templateKey);
  const templateIndexes = migratedRawDb.prepare("PRAGMA index_list('templates')").all();
  assert(templateIndexes.some((index) => index.name === 'templates_template_key_unique'));
  migratedRawDb.close();

  const headers = extractHeaders(templatePath);
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
  assert.strictEqual(enumValues[0], 'BillDate');
  assert(enumValues.includes('Credit Amount'));
  assert(enumValues.includes('MerchantId'));
  assert.strictEqual(enumValues.includes('COMMON字段'), false);
  assert(currencyMappings.length > 0);
  assert.strictEqual(db.listTemplates().find((item) => item.name === 'template').bigAccountSummary, '来自账单');
  assert.strictEqual(db.listTemplates().find((item) => item.name === 'multi-template').bigAccountSummary, '2个');
  assert.strictEqual(db.listTemplates().find((item) => item.name === 'fixed-template').bigAccountSummary, '62220000000000012345');
  assert.strictEqual(db.getTemplateMappings(multiTemplate.id).bigAccounts.length, 2);
  assert.deepStrictEqual(db.getTemplateMappings(multiTemplate.id).bigAccounts[0].currencies, ['USD', 'HKD']);

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

  const selectedBigAccountRows = buildMappedRows({
    inputFilePath: dataPath,
    mappingByField: {
      Balance: '原字段H',
      BillDate: '原字段C',
      ValueDate: '原字段D',
      Channel: `${FIXED_FIELD_VALUE_PREFIX}CHB`,
      MerchantId: '原字段E',
      Currency: '原字段G',
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

  const signedAmountRows = buildMappedRows({
    inputFilePath: signedAmountDataPath,
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

  const rawStatementRows = buildMappedRows({
    inputFilePath: rawStatementPath,
    expectedSourceHeaders: headers,
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

  const skippedAmountRows = buildMappedRows({
    inputFilePath: skippedAmountDataPath,
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

  const startupError = new Error('旧数据库迁移失败');
  const dialogCalls = [];
  const exitCalls = [];
  const startupDialogMessage = buildStartupFailureDialogMessage(startupError, startupFailureLogPath);
  assert(startupDialogMessage.includes('错误摘要：旧数据库迁移失败'));
  assert(startupDialogMessage.includes(`日志文件：${startupFailureLogPath}`));
  reportStartupFailure({
    error: startupError,
    logFilePath: startupFailureLogPath,
    appendRecord: (filePath, payload) => appendActivityRecord(filePath, payload),
    showErrorBox: (title, message) => dialogCalls.push({ title, message }),
    exit: (exitCode) => exitCalls.push(exitCode)
  });
  assert.strictEqual(dialogCalls.length, 1);
  assert.strictEqual(dialogCalls[0].title, '网银账单小助手启动失败');
  assert(dialogCalls[0].message.includes('错误摘要：旧数据库迁移失败'));
  assert.strictEqual(exitCalls.length, 1);
  assert.strictEqual(exitCalls[0], 1);
  const startupFailureLogContent = fs.readFileSync(startupFailureLogPath, 'utf8');
  assert(startupFailureLogContent.includes('[ERROR] 应用启动失败 | 错误摘要：旧数据库迁移失败'));

  console.log('smoke test passed');
}

run();
