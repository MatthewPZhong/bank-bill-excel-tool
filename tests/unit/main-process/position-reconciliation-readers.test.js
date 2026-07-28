'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  readBankFiles,
  readSourceFile,
  readSourceFiles
} = require('../../../src/main-process/position-reconciliation/readers');
const {
  AUDIT_HEADERS,
  POSITION_BANK_HEADERS,
  BANK_SHEET_NAME,
  SOURCE_TYPES,
  SOURCE_DEFINITIONS
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../../../src/constants/bank-statement-fields');

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      headers,
      ...rows.map((row) => headers.map((header) => row[header] ?? ''))
    ]),
    sheetName
  );
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'BANK-BIZ-1',
    BillDate: '2026-07-20',
    Channel: 'DBS',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    FundType: 'Inbound',
    ...overrides
  };
}

function transferRow(overrides = {}) {
  return {
    调拨单号: 'FT-1',
    调拨状态: '付款成功',
    渠道流水号: 'RID-1',
    交易时间: '2026-07-20',
    '付款账户（卡号）': 'PAY-1',
    '收款账户（卡号）': 'REC-1',
    付款金额: '100',
    付款币种: 'USD',
    收款金额: '95',
    收款币种: 'EUR',
    ...overrides
  };
}

test.describe('平盘导入读取器', () => {
  test('银行46/49列和XLS均可读取，49列旧审计不会进入工作数据', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-read-bank-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const legacyPath = path.join(dir, 'legacy.xls');
    const positionPath = path.join(dir, 'position.xlsx');
    writeWorkbook(legacyPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
    writeWorkbook(positionPath, BANK_SHEET_NAME, POSITION_BANK_HEADERS, [{
      ...bankRow({ BizId: 'BANK-BIZ-2' }),
      命中明细: '旧值',
      命中类型: '旧值',
      匹配命中详情: '旧值'
    }]);

    const parsed = readBankFiles([legacyPath, positionPath]);
    assert.equal(parsed.records.length, 2);
    assert.deepEqual(Object.keys(parsed.records[1].workingRow), BANK_STATEMENT_FIELDS);
    assert.deepEqual(parsed.records[1].audit, Object.fromEntries(
      AUDIT_HEADERS.map((header) => [header, ''])
    ));
  });

  test('银行空表、重复BizId和非法日期整批拒绝', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-read-bank-invalid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const emptyPath = path.join(dir, 'empty.xlsx');
    const firstPath = path.join(dir, 'first.xlsx');
    const secondPath = path.join(dir, 'second.xlsx');
    writeWorkbook(emptyPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, []);
    writeWorkbook(firstPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
    writeWorkbook(secondPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
      bankRow({ BillDate: 'not-a-date' })
    ]);

    assert.throws(() => readBankFiles([emptyPath]), /没有可导入的数据行/);
    assert.throws(
      () => readBankFiles([firstPath, secondPath]),
      (error) => (
        error.code === 'position-bank-row-invalid'
        && error.detailLines.some((line) => (
          line.includes('BillDate 无法解析') || line.includes('BizId 与')
        ))
      )
    );
  });

  test('同文件完全重复主键折叠，内容冲突拒绝', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-duplicate-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    const duplicatePath = path.join(dir, 'duplicate.xlsx');
    const conflictPath = path.join(dir, 'conflict.xlsx');
    const dateConflictPath = path.join(dir, 'date-conflict.xlsx');
    writeWorkbook(duplicatePath, 'Sheet1', headers, [transferRow(), transferRow()]);
    writeWorkbook(conflictPath, 'Sheet1', headers, [
      transferRow(),
      transferRow({ 收款金额: '96' })
    ]);
    writeWorkbook(dateConflictPath, 'Sheet1', headers, [
      transferRow({ 交易时间: new Date(2026, 6, 20) }),
      transferRow({ 交易时间: new Date(2026, 6, 21) })
    ]);

    const parsed = readSourceFile(duplicatePath);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.collapsedDuplicateCount, 1);
    assert.throws(() => readSourceFile(conflictPath), /同一文件存在业务主键冲突/);
    assert.throws(
      () => readSourceFile(dateConflictPath),
      /同一文件存在业务主键冲突/
    );
  });

  test('同批跨文件重复主键和多份账户快照均拒绝后续文件', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-cross-file-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transferHeaders = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    const first = path.join(dir, 'first.xlsx');
    const second = path.join(dir, 'second.xlsx');
    writeWorkbook(first, 'Sheet1', transferHeaders, [transferRow()]);
    writeWorkbook(second, 'Sheet1', transferHeaders, [transferRow()]);
    const duplicateResults = readSourceFiles([first, second]);
    assert.deepEqual(duplicateResults.map((row) => row.status), ['ok', 'failed']);
    assert.equal(duplicateResults[1].code, 'position-source-cross-file-conflict');

    const accountHeaders = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers;
    const accountA = path.join(dir, 'account-a.xlsx');
    const accountB = path.join(dir, 'account-b.xlsx');
    const accountRow = {
      账户状态: '正常',
      账户性质: '自有',
      币种: 'USD',
      银行账号: 'OWN-1'
    };
    writeWorkbook(accountA, 'Sheet1', accountHeaders, [accountRow]);
    writeWorkbook(accountB, 'Sheet1', accountHeaders, [{ ...accountRow, 银行账号: 'OWN-2' }]);
    const accountResults = readSourceFiles([accountA, accountB]);
    assert.deepEqual(accountResults.map((row) => row.status), ['ok', 'failed']);
    assert.equal(accountResults[1].code, 'position-source-cross-file-snapshot-conflict');
  });

  test('坏行错误包含文件、sheet、Excel行号和字段', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-lineage-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'bad-transfer.xlsx');
    const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    writeWorkbook(filePath, '资金数据', headers, [transferRow({ 付款币种: '' })]);

    assert.throws(
      () => readSourceFile(filePath),
      (error) => (
        error.code === 'position-source-row-invalid'
        && /bad-transfer\.xlsx \/ 资金数据 第 2 行/.test(error.message)
        && error.detailLines.includes('付款币种为空')
      )
    );
  });
});
