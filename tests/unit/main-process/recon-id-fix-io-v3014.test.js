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
  PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME,
  PRE_FUND_UNBALANCED_FIELDS,
  PRE_FUND_UNBALANCED_FIELDS_LEGACY,
  PRE_FUND_BALANCED_FIELDS,
  DUPLICATE_GATEWAY_HEADERS
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

function writeGatewayWorkbook(filePath, {
  modern = false,
  unbalancedHeaders = PRE_FUND_UNBALANCED_FIELDS,
  balancedHeaders = PRE_FUND_BALANCED_FIELDS,
  duplicateHeaders = null,
  duplicateRows = [],
  gatewayRows = [],
  channelRows = [],
  orderRepairRows = []
} = {}) {
  const workbook = XLSX.utils.book_new();
  if (modern) {
    appendSheet(
      workbook,
      PRE_FUND_UNBALANCED_SHEET_NAME,
      unbalancedHeaders,
      [unbalancedHeaders.map((field) => `value-${field}`)]
    );
    appendSheet(workbook, PRE_FUND_BALANCED_SHEET_NAME, balancedHeaders);
  } else {
    appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, RECON_RESULT_FIELDS_GATEWAY, [[
      ...RECON_RESULT_FIELDS_GATEWAY.map((field) => `legacy-${field}`)
    ]]);
  }
  appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS, gatewayRows);
  appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS, channelRows);
  appendSheet(
    workbook,
    ORDER_REPAIR_SHEET_NAME_GATEWAY,
    ORDER_REPAIR_FIELDS_GATEWAY,
    orderRepairRows
  );
  if (duplicateHeaders) {
    appendSheet(
      workbook,
      PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME,
      duplicateHeaders,
      duplicateRows
    );
  }
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

  test('accepts v3.0.26 five-sheet workbook and strips source/FundType fields from C4 result rows', () => {
    const filePath = path.join(dir, 'modern.xlsx');
    writeGatewayWorkbook(filePath, { modern: true });

    const result = readReconIdFixFile(filePath, 'gateway');

    assert.equal(result.sheets.reconResult.length, 1);
    assert.deepEqual(Object.keys(result.sheets.reconResult[0]), RECON_RESULT_FIELDS_GATEWAY);
    assert.equal(result.sheets.reconResult[0]['账单日期'], 'value-账单日期');
    assert.equal('对账数据来源' in result.sheets.reconResult[0], false);
    assert.equal('FundType' in result.sheets.reconResult[0], false);
  });

  test('accepts v3.0.14-v3.0.25 twenty-column unbalanced sheet unchanged', () => {
    const filePath = path.join(dir, 'modern-legacy-twenty-columns.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      unbalancedHeaders: PRE_FUND_UNBALANCED_FIELDS_LEGACY
    });

    const result = readReconIdFixFile(filePath, 'gateway');

    assert.equal(result.sheets.reconResult.length, 1);
    assert.deepEqual(Object.keys(result.sheets.reconResult[0]), RECON_RESULT_FIELDS_GATEWAY);
    assert.equal(result.sheets.reconResult[0]['账单日期'], 'value-账单日期');
    assert.equal('对账数据来源' in result.sheets.reconResult[0], false);
  });

  test('rejects nineteen-column data under modern unbalanced sheet name', () => {
    const filePath = path.join(dir, 'modern-name-with-legacy-fields.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      unbalancedHeaders: RECON_RESULT_FIELDS_GATEWAY
    });

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-count'
        && error.message.includes('期望 21 列')
    );
  });

  test('rejects twenty-one-column data under legacy result sheet name', () => {
    const filePath = path.join(dir, 'legacy-name-with-modern-fields.xlsx');
    const workbook = XLSX.utils.book_new();
    appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, PRE_FUND_UNBALANCED_FIELDS);
    appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS);
    appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS);
    appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
    XLSX.writeFile(workbook, filePath);

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-count'
        && error.message.includes('期望 19 列')
    );
  });

  test('rejects new unbalanced sheet when FundType is not the sixth column', () => {
    const filePath = path.join(dir, 'modern-wrong-fund-type-position.xlsx');
    const badHeaders = PRE_FUND_UNBALANCED_FIELDS.slice();
    const fundType = badHeaders.splice(5, 1)[0];
    badHeaders.push(fundType);
    writeGatewayWorkbook(filePath, {
      modern: true,
      unbalancedHeaders: badHeaders
    });

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-name'
        && error.message.includes(PRE_FUND_UNBALANCED_SHEET_NAME)
    );
  });

  test('rejects unknown twenty-second unbalanced column', () => {
    const filePath = path.join(dir, 'modern-extra-column.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      unbalancedHeaders: [...PRE_FUND_UNBALANCED_FIELDS, '未知额外列']
    });

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-count'
        && error.message.includes('期望 21 列')
    );
  });

  test('accepts six-sheet workbook, validates duplicate audit headers, and ignores its rows', () => {
    const filePath = path.join(dir, 'modern-with-duplicate-audit.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      duplicateHeaders: DUPLICATE_GATEWAY_HEADERS,
      duplicateRows: [[
        'PF-1', '被折叠记录', 1, 1, 'reconciliationId+10字段指纹完全重复', 'fp',
        '网关对账单', 'linked_gateway_bill#2', '2026-07-01', 'CIT', 'M1', 'O1',
        'B1', 'R1', 'USD', '10', 'PAY', 'Alice', '1234', 'CIT', 'SWIFT', '{"id":2}'
      ]]
    });

    const result = readReconIdFixFile(filePath, 'gateway');

    assert.equal(result.sheets.reconResult.length, 1);
    assert.deepEqual(Object.keys(result.sheets), [
      'reconResult', 'businessBills', 'opponentBills', 'fixTemplate'
    ]);
    assert.deepEqual(result.sheets.businessBills, []);
    assert.deepEqual(result.sheets.opponentBills, []);
  });

  test('six-sheet and five-sheet return identical non-empty C4 business data', () => {
    const fiveSheetPath = path.join(dir, 'modern-five-non-empty.xlsx');
    const sixSheetPath = path.join(dir, 'modern-six-non-empty.xlsx');
    const gatewayRows = [GATEWAY_BILL_FIELDS.map((field) => `gateway-${field}`)];
    const channelRows = [CHANNEL_BILL_FIELDS.map((field) => `channel-${field}`)];
    const orderRepairRows = [ORDER_REPAIR_FIELDS_GATEWAY.map((field) => `repair-${field}`)];
    const common = { modern: true, gatewayRows, channelRows, orderRepairRows };
    writeGatewayWorkbook(fiveSheetPath, common);
    writeGatewayWorkbook(sixSheetPath, {
      ...common,
      duplicateHeaders: DUPLICATE_GATEWAY_HEADERS,
      duplicateRows: [[
        'PF-1', '被折叠记录', 1, 1, 'reconciliationId+10字段指纹完全重复', 'fp',
        '网关对账单', 'linked_gateway_bill#2', '2026-07-01', 'CIT', 'M1', 'O1',
        'B1', 'R1', 'USD', '10', 'PAY', 'Alice', '1234', 'CIT', 'SWIFT', '{"id":2}'
      ]]
    });

    assert.deepEqual(
      readReconIdFixFile(sixSheetPath, 'gateway').sheets,
      readReconIdFixFile(fiveSheetPath, 'gateway').sheets
    );
  });

  test('loads only one header row first, then excludes duplicate audit data from the business read', () => {
    const filePath = path.join(dir, 'modern-selective-read.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      duplicateHeaders: DUPLICATE_GATEWAY_HEADERS,
      duplicateRows: [DUPLICATE_GATEWAY_HEADERS.map((_header, index) => `value-${index}`)]
    });
    const originalReadFile = XLSX.readFile;
    const optionsSeen = [];
    XLSX.readFile = function instrumentedReadFile(targetPath, options) {
      optionsSeen.push(options || {});
      return originalReadFile.call(this, targetPath, options);
    };
    try {
      readReconIdFixFile(filePath, 'gateway');
    } finally {
      XLSX.readFile = originalReadFile;
    }

    assert.equal(optionsSeen[0].sheetRows, 1);
    assert.ok(Array.isArray(optionsSeen[1].sheets));
    assert.equal(optionsSeen[1].sheets.includes(PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME), false);
  });

  test('rejects six-sheet workbook when duplicate audit headers are malformed', () => {
    const filePath = path.join(dir, 'modern-bad-duplicate-audit.xlsx');
    writeGatewayWorkbook(filePath, {
      modern: true,
      duplicateHeaders: DUPLICATE_GATEWAY_HEADERS.slice(0, -1)
    });

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'invalid-column-count'
        && error.message.includes(PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME)
    );
  });

  test('rejects modern workbook when required balanced sheet is absent', () => {
    const filePath = path.join(dir, 'modern-no-balanced.xlsx');
    const workbook = XLSX.utils.book_new();
    appendSheet(workbook, PRE_FUND_UNBALANCED_SHEET_NAME, PRE_FUND_UNBALANCED_FIELDS);
    appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS);
    appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS);
    appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
    XLSX.writeFile(workbook, filePath);

    assert.throws(
      () => readReconIdFixFile(filePath, 'gateway'),
      (error) => error instanceof FileValidationError
        && error.code === 'missing-sheet'
        && error.message.includes(PRE_FUND_BALANCED_SHEET_NAME)
    );
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
