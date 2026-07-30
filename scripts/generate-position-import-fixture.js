'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../src/main-process/position-reconciliation/constants');

const outputPath = path.resolve(process.argv[2] || 'outputs/position-import-fixture.xlsx');
const rowCount = Number.parseInt(process.argv[3] || '100', 10);
if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 10000) {
  throw new Error('PR-A fixture 行数只允许 1-10000；百万级流式生成器在 PR-B/PR-E 实现');
}

const definition = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND];
const rows = [definition.headers];
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
  rows.push(definition.headers.map((header) => row[header]));
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '出账');
XLSX.writeFile(workbook, outputPath);
process.stdout.write(`${outputPath}\n`);

