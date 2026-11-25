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
  readSourceFiles,
  rowValues
} = require('../../../src/main-process/position-reconciliation/readers');
const {
  AUDIT_HEADERS,
  POSITION_BANK_HEADERS,
  POSITION_BANK_INTERACTION_FIELDS,
  BANK_SHEET_NAME,
  SOURCE_TYPES,
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS
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
  test('银行 46 列、平盘结果导出列和 XLS 均可读取：只取交互字段，结果文件里的审计列不会进入工作数据', (t) => {
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
    assert.deepEqual(Object.keys(parsed.records[0].workingRow), [...POSITION_BANK_INTERACTION_FIELDS]);
    assert.deepEqual(Object.keys(parsed.records[1].workingRow), [...POSITION_BANK_INTERACTION_FIELDS]);
    assert.equal(parsed.records[1].workingRow.BizId, 'BANK-BIZ-2');
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

  test('同文件完全相同的行折叠；业务单号相同但内容不同的行各自保留', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-duplicate-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    const duplicatePath = path.join(dir, 'duplicate.xlsx');
    const differentPath = path.join(dir, 'different.xlsx');
    const noteOnlyPath = path.join(dir, 'note-only.xlsx');
    writeWorkbook(duplicatePath, 'Sheet1', headers, [transferRow(), transferRow()]);
    writeWorkbook(differentPath, 'Sheet1', headers, [
      transferRow(),
      transferRow({ 收款金额: '96' })
    ]);
    // 只有非必用列不同：保存下来的内容相同，视为同一条记录。
    writeWorkbook(noteOnlyPath, 'Sheet1', headers, [
      transferRow({ 附言: 'A' }),
      transferRow({ 附言: 'B' })
    ]);

    const parsed = readSourceFile(duplicatePath);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.collapsedDuplicateCount, 1);
    assert.deepEqual(Object.keys(parsed.records[0].row), [...SOURCE_REQUIRED_FIELDS[SOURCE_TYPES.FUND_TRANSFER]]);
    const different = readSourceFile(differentPath);
    assert.deepEqual(different.records.map((record) => record.row['收款金额']), ['95', '96']);
    assert.notEqual(different.records[0].rowHash, different.records[1].rowHash);
    const noteOnly = readSourceFile(noteOnlyPath);
    assert.equal(noteOnly.records.length, 1);
    assert.equal(noteOnly.collapsedDuplicateCount, 1);
  });

  test('同批跨文件完全相同的行折叠，多份账户快照拒绝后续文件', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-cross-file-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transferHeaders = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    const first = path.join(dir, 'first.xlsx');
    const second = path.join(dir, 'second.xlsx');
    writeWorkbook(first, 'Sheet1', transferHeaders, [transferRow()]);
    writeWorkbook(second, 'Sheet1', transferHeaders, [transferRow()]);
    const duplicateResults = readSourceFiles([first, second]);
    assert.deepEqual(duplicateResults.map((row) => row.status), ['ok', 'ok']);
    assert.deepEqual(duplicateResults.map((row) => row.rowCount), [1, 0]);
    assert.equal(duplicateResults[1].collapsedDuplicateCount, 1);

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

  test('数据区空白行不压缩后续银行和原始表的物理行号', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-blank-row-lineage-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const bankPath = path.join(dir, 'bank-with-blank.xlsx');
    const bankWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      bankWorkbook,
      XLSX.utils.aoa_to_sheet([
        BANK_STATEMENT_FIELDS,
        BANK_STATEMENT_FIELDS.map((header) => bankRow()[header] ?? ''),
        [],
        BANK_STATEMENT_FIELDS.map((header) => (
          bankRow({ BizId: 'BANK-BIZ-2', BillDate: '2026-07-21' })[header] ?? ''
        ))
      ]),
      BANK_SHEET_NAME
    );
    XLSX.writeFile(bankWorkbook, bankPath);

    const bankParsed = readBankFiles([bankPath]);
    assert.equal(bankParsed.records[1].sourceRowNumber, 4);

    const sourcePath = path.join(dir, 'source-with-blank.xlsx');
    const sourceHeaders = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers;
    const sourceWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      sourceWorkbook,
      XLSX.utils.aoa_to_sheet([
        sourceHeaders,
        sourceHeaders.map((header) => transferRow()[header] ?? ''),
        [],
        sourceHeaders.map((header) => (
          transferRow({ 调拨单号: 'FT-2', 付款币种: '' })[header] ?? ''
        ))
      ]),
      '资金数据'
    );
    XLSX.writeFile(sourceWorkbook, sourcePath);

    assert.throws(
      () => readSourceFile(sourcePath),
      (error) => (
        error.code === 'position-source-row-invalid'
        && /source-with-blank\.xlsx \/ 资金数据 第 4 行/.test(error.message)
        && error.detailLines.includes('付款币种为空')
      )
    );
  });

  test('前面若干列完全空白（使用范围不从 A 列开始）的原始表与银行对账单按缺列拒绝', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-sparse-header-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const writeFromColumnB = (filePath, sheetName, headers, row) => {
      const workbook = XLSX.utils.book_new();
      const tail = headers.slice(1);
      const sheet = XLSX.utils.aoa_to_sheet([tail, tail.map((header) => row[header] ?? '')], { origin: 'B1' });
      // 与 Excel 保存后的使用范围一致：A 列没有任何单元格
      sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 1 }, e: { r: 1, c: tail.length } });
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
      XLSX.writeFile(workbook, filePath);
    };
    const accountPath = path.join(dir, 'account-from-b.xls');
    const accountHeaders = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers;
    writeFromColumnB(accountPath, 'Sheet1', accountHeaders, { 账户状态: '正常', 账户性质: '自有', 币种: 'USD', 银行账号: 'OWN-1' });
    assert.throws(() => readSourceFile(accountPath), (error) => error.code === 'position-source-unrecognized');

    const bankPath = path.join(dir, 'bank-from-b.xls');
    writeFromColumnB(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, bankRow());
    assert.throws(
      () => readBankFiles([bankPath]),
      (error) => error.code === 'position-bank-headers-invalid'
        && error.detailLines.includes('第 1 列（A）：应为「账户主体」，实际为空')
    );

    const fromColumnC = XLSX.utils.aoa_to_sheet([['X', 'Y']], { origin: 'C1' });
    fromColumnC['!ref'] = 'C1:D1';
    assert.deepEqual([...rowValues(fromColumnC)[0]], ['', '', 'X', 'Y']);
  });

  test('稀疏工作表只返回非空行并保留物理行号', () => {
    const rows = rowValues({
      A1: { t: 's', v: '表头' },
      A100000: { t: 's', v: '数据' },
      '!ref': 'A1:A100000'
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].__rowNum__, 0);
    assert.equal(rows[1].__rowNum__, 99999);
  });
});
