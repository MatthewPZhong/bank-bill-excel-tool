const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { AppDatabase } = require('../src/backend/database');
const {
  buildMappedRows,
  extractHeaders,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  loadEnumValues,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../src/backend/file-service');

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
  const dbPath = path.join(root, 'app.sqlite');
  const templatePath = path.join(root, 'template.xlsx');
  const dataPath = path.join(root, 'input.xlsx');
  const unmappedDataPath = path.join(root, 'input-unmapped.xlsx');
  const detailOutputPath = path.join(root, '2026-03-09', 'detail', 'template-Balance-2026-03-09.xlsx');
  const balanceTemplatePath = path.join(root, 'balance-template.xlsx');
  const balanceOutputPath = path.join(root, '2026-03-09', 'balance', 'template-Balance-2026-03-09.xlsx');

  makeWorkbook(templatePath, [['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'], ['值1', '值2', '值3', '值4', '值5', '值6', '值7', '值8']]);
  makeWorkbook(dataPath, [['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'], ['$1,234.56CR', 'DB789.01元', '2026-03-09', '20260310', 'NET_001', 88, '美元', '456.78']]);
  makeWorkbook(unmappedDataPath, [['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F', '原字段G', '原字段H'], ['100', '200', '2026-03-09', '20260310', 'NET_001', 88, '测试币', '456.78']]);
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
  writeWorkbookRows({
    rows: detailRows,
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
  const rows = XLSX.utils.sheet_to_json(
    worksheet,
    { header: 1, defval: '' }
  );
  assert.deepStrictEqual(rows[0], ['Balance', 'BillDate', 'ValueDate', 'Channel', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Extra Information']);
  assert.strictEqual(rows[1][0], 456.78);
  assert.strictEqual(rows[1][3], 'CHB');
  assert.strictEqual(rows[1][4], 'SELF_INPUT_001');
  assert.strictEqual(rows[1][5], 'USD');
  assert.strictEqual(rows[1][8], '');
  assert.strictEqual(worksheet.A2.t, 'n');
  assert.strictEqual(worksheet.A2.z, '0.00');
  assert.strictEqual(worksheet.B2.t, 'n');
  assert.strictEqual(worksheet.B2.z, 'yyyy-mm-dd');
  assert.strictEqual(worksheet.C2.t, 'n');
  assert.strictEqual(worksheet.C2.z, 'yyyy-mm-dd');
  assert.strictEqual(worksheet.D2.t, 's');
  assert.strictEqual(worksheet.D2.z, '@');
  assert.strictEqual(worksheet.E2.t, 's');
  assert.strictEqual(worksheet.E2.z, '@');
  assert.strictEqual(worksheet.G2.v, 1234.56);
  assert.strictEqual(worksheet.G2.t, 'n');
  assert.strictEqual(worksheet.G2.z, '0.00');
  assert.strictEqual(worksheet.H2.v, 789.01);
  assert.strictEqual(worksheet.H2.t, 'n');
  assert.strictEqual(worksheet.H2.z, '0.00');

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

  console.log('smoke test passed');
}

run();
