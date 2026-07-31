'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../src/main-process/position-reconciliation/constants');

const outputPath = path.resolve(process.argv[2] || 'outputs/position-import-fixture.xlsx');
const rowCount = Number.parseInt(process.argv[3] || '100', 10);
if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 3_000_000) {
  throw new Error('fixture 行数只允许 1-3000000');
}

const definition = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND];

async function main() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useSharedStrings: false,
    useStyles: false
  });
  const sheet = workbook.addWorksheet('出账');
  sheet.addRow(definition.headers).commit();
  for (let index = 0; index < rowCount; index += 1) {
    const row = Object.fromEntries(definition.headers.map((header) => [header, '']));
    row['账单日期'] = '2026-07-20';
    row['渠道名称'] = 'TEST';
    row['账户号'] = 'M001';
    row['交易类型'] = 'Outbound';
    row['主对账id'] = `RID-${index + 1}`;
    row['业务单号'] = `ORDER-${index + 1}`;
    row['币种'] = 'USD';
    row['金额'] = index + 1;
    sheet.addRow(definition.headers.map((header) => row[header])).commit();
  }
  sheet.commit();
  await workbook.commit();
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
