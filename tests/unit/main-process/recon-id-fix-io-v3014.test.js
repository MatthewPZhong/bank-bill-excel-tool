'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  readReconIdFixFile,
  PRE_FUND_UNBALANCED_SHEET_NAME,
  PRE_FUND_BALANCED_SHEET_NAME,
  PRE_FUND_UNBALANCED_FIELDS,
  PRE_FUND_BALANCED_FIELDS
} = require('../../../src/main-process/recon-id-fix-io');
const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../../src/constants/gateway-bill-recon-fields');
const { FileValidationError } = require('../../../src/backend/file-service/common');

function appendSheet(workbook, name, headers, rows = []) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function writeGatewayWorkbook(filePath, { modern = false, balancedHeaders = PRE_FUND_BALANCED_FIELDS } = {}) {
  const workbook = XLSX.utils.book_new();
  if (modern) {
    appendSheet(workbook, PRE_FUND_UNBALANCED_SHEET_NAME, PRE_FUND_UNBALANCED_FIELDS, [[
      '导入银行对账单',
      ...RECON_RESULT_FIELDS_GATEWAY.map((field) => `value-${field}`)
    ]]);
    appendSheet(workbook, PRE_FUND_BALANCED_SHEET_NAME, balancedHeaders);
  } else {
    appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, RECON_RESULT_FIELDS_GATEWAY, [[
      ...RECON_RESULT_FIELDS_GATEWAY.map((field) => `legacy-${field}`)
    ]]);
  }
  appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS);
  appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
  XLSX.writeFile(workbook, filePath);
}

test.describe('readReconIdFixFile gateway 3.0.14 compatibility', () => {
  let dir;

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-fix-v3014-'));
  });

  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('accepts legacy four-sheet workbook unchanged', () => {
    const filePath = path.join(dir, 'legacy.xlsx');
    writeGatewayWorkbook(filePath);

    const result = readReconIdFixFile(filePath, 'gateway');

    assert.equal(result.sheets.reconResult.length, 1);
    assert.deepEqual(Object.keys(result.sheets.reconResult[0]), RECON_RESULT_FIELDS_GATEWAY);
    assert.equal(result.sheets.reconResult[0]['账单日期'], 'legacy-账单日期');
  });

  test('accepts new five-sheet workbook and strips source field from C4 result rows', () => {
    const filePath = path.join(dir, 'modern.xlsx');
    writeGatewayWorkbook(filePath, { modern: true });

    const result = readReconIdFixFile(filePath, 'gateway');

    assert.equal(result.sheets.reconResult.length, 1);
    assert.deepEqual(Object.keys(result.sheets.reconResult[0]), RECON_RESULT_FIELDS_GATEWAY);
    assert.equal(result.sheets.reconResult[0]['账单日期'], 'value-账单日期');
    assert.equal('对账数据来源' in result.sheets.reconResult[0], false);
  });

  test('accepts new workbook when optional balanced sheet is absent', () => {
    const filePath = path.join(dir, 'modern-no-balanced.xlsx');
    const workbook = XLSX.utils.book_new();
    appendSheet(workbook, PRE_FUND_UNBALANCED_SHEET_NAME, PRE_FUND_UNBALANCED_FIELDS);
    appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS);
    appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS);
    appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
    XLSX.writeFile(workbook, filePath);

    const result = readReconIdFixFile(filePath, 'gateway');
    assert.deepEqual(result.sheets.reconResult, []);
  });

  test('rejects malformed balanced sheet when it is present', () => {
    const filePath = path.join(dir, 'modern-bad-balanced.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      balancedHeaders: PRE_FUND_BALANCED_FIELDS.slice(0, -1)
    });

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-count'
        && error.message.includes(PRE_FUND_BALANCED_SHEET_NAME)
    );
  });
});
