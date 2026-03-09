const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { AppDatabase } = require('../src/backend/database');
const {
  extractHeaders,
  loadEnumValues,
  transformFileToWorkbook
} = require('../src/backend/file-service');

function makeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bill-tool-'));
  const dbPath = path.join(root, 'app.sqlite');
  const templatePath = path.join(root, 'template.xlsx');
  const enumPath = path.join(root, 'COMMON枚举.xlsx');
  const dataPath = path.join(root, 'input.xlsx');
  const outputPath = path.join(root, '2026-03-09', 'template-COMMON-2026-03-09.xlsx');

  makeWorkbook(templatePath, [['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F'], ['值1', '值2', '值3', '值4', '值5', '值6']]);
  makeWorkbook(enumPath, [['COMMON字段'], ['Credit Amount'], ['Debit Amount'], ['BillDate'], ['ValueDate'], ['MerchantId'], ['Channel']]);
  makeWorkbook(dataPath, [['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F'], ['1234.56', '789.01', '2026-03-09', '20260310', 'NET_001', 88]]);

  const db = new AppDatabase(dbPath);
  db.init();

  const headers = extractHeaders(templatePath);
  assert.deepStrictEqual(headers, ['原字段A', '原字段B', '原字段C', '原字段D', '原字段E', '原字段F']);

  const template = db.upsertTemplate({
    name: 'template',
    sourceFileName: 'template.xlsx',
    headers
  });

  db.setEnumConfig({
    filePath: enumPath,
    sourceFileName: '测试枚举.xlsx'
  });
  assert.strictEqual(db.getEnumConfig().sourceFileName, '测试枚举.xlsx');

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

  const enumValues = loadEnumValues(enumPath);
  assert(enumValues.includes('Credit Amount'));
  assert(enumValues.includes('MerchantId'));

  transformFileToWorkbook({
    inputFilePath: dataPath,
    mappingByField: {
      原字段A: 'Credit Amount',
      原字段B: 'Debit Amount',
      原字段C: 'BillDate',
      原字段D: 'ValueDate',
      原字段E: 'MerchantId',
      原字段F: 'Channel'
    },
    merchantSourceFields: ['原字段E'],
    accountMappingByBankId: {
      NET_001: 'CLEAR_9001'
    },
    outputFilePath: outputPath
  });

  assert(fs.existsSync(outputPath));
  const workbook = XLSX.readFile(outputPath, {
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  const worksheet = workbook.Sheets.COMMON;
  const rows = XLSX.utils.sheet_to_json(
    worksheet,
    { header: 1, defval: '' }
  );
  assert.deepStrictEqual(rows[0], ['Credit Amount', 'Debit Amount', 'BillDate', 'ValueDate', 'MerchantId', 'Channel']);
  assert.strictEqual(rows[1][4], 'CLEAR_9001');
  assert.strictEqual(rows[1][5], '88');
  assert.strictEqual(worksheet.A2.t, 'n');
  assert.strictEqual(worksheet.A2.z, '0.00');
  assert.strictEqual(worksheet.B2.t, 'n');
  assert.strictEqual(worksheet.B2.z, '0.00');
  assert.strictEqual(worksheet.C2.t, 'n');
  assert.strictEqual(worksheet.C2.z, 'yyyy-mm-dd');
  assert.strictEqual(worksheet.D2.t, 'n');
  assert.strictEqual(worksheet.D2.z, 'yyyy-mm-dd');
  assert.strictEqual(worksheet.E2.t, 's');
  assert.strictEqual(worksheet.E2.z, '@');
  assert.strictEqual(worksheet.F2.t, 's');
  assert.strictEqual(worksheet.F2.z, '@');

  console.log('smoke test passed');
}

run();
