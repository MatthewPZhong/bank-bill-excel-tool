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

  makeWorkbook(templatePath, [['原字段A', '原字段B'], ['值1', '值2']]);
  makeWorkbook(enumPath, [['COMMON字段'], ['字段A'], ['字段B']]);
  makeWorkbook(dataPath, [['原字段A', '原字段B'], ['1', '2']]);

  const db = new AppDatabase(dbPath);
  db.init();

  const headers = extractHeaders(templatePath);
  assert.deepStrictEqual(headers, ['原字段A', '原字段B']);

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
    { templateField: '原字段A', mappedField: '字段A' },
    { templateField: '原字段B', mappedField: '字段B' }
  ]);

  const enumValues = loadEnumValues(enumPath);
  assert(enumValues.includes('字段A'));
  assert(enumValues.includes('字段B'));

  transformFileToWorkbook({
    inputFilePath: dataPath,
    mappingByField: {
      原字段A: '字段A',
      原字段B: '字段B'
    },
    outputFilePath: outputPath
  });

  assert(fs.existsSync(outputPath));
  const rows = XLSX.utils.sheet_to_json(
    XLSX.readFile(outputPath).Sheets.COMMON,
    { header: 1, defval: '' }
  );
  assert.deepStrictEqual(rows[0], ['字段A', '字段B']);

  console.log('smoke test passed');
}

run();
