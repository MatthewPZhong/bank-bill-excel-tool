'use strict';

// v3.2.17：补录余额「导入余额文件」解析与匹配（src/backend/balance-seed-import.js）
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchBalanceSeedImport,
  parseBalanceSeedImportRows
} = require('../../../src/backend/balance-seed-import');

const HEADER = ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'];

function balanceRow({ account, currency = 'USD', date, balance }) {
  return ['DBS', 'SG', currency, account, date, '', '', balance, ''];
}

test.describe('parseBalanceSeedImportRows', () => {
  test('首行表头（本工具余额账单格式）：按列名取四列，其他列忽略', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: ' 6001 ', currency: 'usd', date: '2026/09/30', balance: '1,234.50' })
    ]);
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records, [{
      merchantId: '6001',
      currency: 'USD',
      billDate: '2026-09-30',
      endBalance: 1234.5,
      rowNumber: 2
    }]);
  });

  test('表头前有标题行、列顺序不同也能识别；空行不计入跳过数', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      ['余额汇总'],
      [],
      ['期末余额', '账单日期', '银行账号', '币种'],
      ['0', '20260930', 'A1', 'EUR'],
      ['', '', '', '']
    ]);
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records.map((record) => [record.merchantId, record.currency, record.billDate, record.endBalance, record.rowNumber]), [
      ['A1', 'EUR', '2026-09-30', 0, 4]
    ]);
  });

  test('缺列报错并写明缺哪些列', () => {
    assert.throws(
      () => parseBalanceSeedImportRows([['银行账号', '币种', '账单日期'], ['A1', 'USD', '2026-09-30']]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING' && /期末余额/.test(error.message)
    );
    assert.throws(
      () => parseBalanceSeedImportRows([['x'], ['y']]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING'
    );
  });

  test('账号为空、日期或金额无效的行跳过并计数', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: '', date: '2026-09-30', balance: '1' }),
      balanceRow({ account: 'A1', date: '不是日期', balance: '1' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: 'abc' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '-8.8' })
    ]);
    assert.equal(skippedRowCount, 4);
    assert.deepEqual(records.map((record) => record.endBalance), [-8.8]);
  });
});

test.describe('parseBalanceSeedImportRows — 数字型银行账号', () => {
  const rows = [
    ['银行账号', '币种', '账单日期', '期末余额'],
    [123456789012345, 'USD', '2026-09-30', 1],
    [6222000000000001000, 'USD', '2026-09-30', 2],
    [1234567890123456, 'USD', '2026-09-30', 3],
    [12.5, 'USD', '2026-09-30', 4],
    [123, 'USD', '2026-09-30', 6],
    ['6222000000000001234', 'USD', '2026-09-30', 5]
  ];
  const displayRows = [
    rows[0],
    ['123456789012345', 'USD', '2026-09-30', '1'],
    ['6222000000000001000', 'USD', '2026-09-30', '2'],
    ['1234567890123456', 'USD', '2026-09-30', '3'],
    ['12.5', 'USD', '2026-09-30', '4'],
    ['000123', 'USD', '2026-09-30', '6'],
    ['6222000000000001234', 'USD', '2026-09-30', '5']
  ];

  test('显示文本与原值一致的 15 位以内整数账号按文本使用；被截断（16 位及以上）、带小数、显示补了前导 0 的跳过', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows(rows, { displayRows });
    assert.equal(skippedRowCount, 4);
    assert.deepEqual(records.map((record) => [record.merchantId, record.endBalance]), [
      ['123456789012345', 1],
      ['6222000000000001234', 5]
    ]);
    const result = matchBalanceSeedImport(records, [
      { merchantId: '6222000000000001000', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: '123', currency: 'USD', targetBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(result.accounts.map((account) => account.source), ['manual', 'manual'],
      '截断或补零显示的数字账号不会错配到另一个账号');
  });

  test('拿不到显示文本时数字型账号一律跳过；文本账号不受影响', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows(rows);
    assert.equal(skippedRowCount, 5);
    assert.deepEqual(records.map((record) => record.merchantId), ['6222000000000001234']);
    assert.equal(parseBalanceSeedImportRows(rows, { displayRows: displayRows.slice(1) }).skippedRowCount, 5,
      '显示文本行数对不上时不采用');
  });

  test('真实 xlsx：零填充格式的数字账号不当作原值，General 数字账号与文本账号照常识别', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const XLSX = require('xlsx');
    const { readBalanceSeedImportFile } = require('../../../src/backend/balance-seed-import');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, '余额.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['银行账号', '币种', '账单日期', '期末余额'],
      [123, 'USD', '2026-09-30', 10],
      [456, 'USD', '2026-09-30', 20],
      ['000789', 'USD', '2026-09-30', 30]
    ]);
    sheet.A2.z = '000000';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'balance');
    XLSX.writeFile(workbook, filePath);

    const { rows: fileRows, displayRows: fileDisplayRows } = readBalanceSeedImportFile(filePath);
    assert.equal(fileDisplayRows[1][0], '000123');
    const { records, skippedRowCount } = parseBalanceSeedImportRows(fileRows, { displayRows: fileDisplayRows });
    assert.equal(skippedRowCount, 1);
    assert.deepEqual(records.map((record) => [record.merchantId, record.endBalance]), [['456', 20], ['000789', 30]]);
    const result = matchBalanceSeedImport(records, [
      { merchantId: '123', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: '000123', currency: 'USD', targetBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(result.accounts.map((account) => account.source), ['manual', 'manual']);
  });
});

test.describe('parseBalanceSeedImportRows — 数字型账单日期与工作簿日期系统', () => {
  const XLSX = require('xlsx');
  const { readBalanceSeedImportFile } = require('../../../src/backend/balance-seed-import');
  // 2026-10-02 的 1900 系统序列号为 46297，1904 系统为 44835。
  function writeDateWorkbook(t, date1904) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-date-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, '余额.xlsx');
    const offset = date1904 ? 1462 : 0;
    const sheet = XLSX.utils.aoa_to_sheet([
      ['银行账号', '币种', '账单日期', '期末余额'],
      ['A1', 'USD', 46295 - offset, 10],
      ['A1', 'USD', 46296 - offset, 20],
      ['A1', 'USD', 46297 - offset, 30]
    ]);
    ['C2', 'C3', 'C4'].forEach((ref) => { sheet[ref].z = 'yyyy-mm-dd'; });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'balance');
    if (date1904) workbook.Workbook = { ...(workbook.Workbook || {}), WBProps: { date1904: true } };
    XLSX.writeFile(workbook, filePath);
    return filePath;
  }

  for (const date1904 of [false, true]) {
    test(`真实 xlsx（${date1904 ? '1904' : '1900'} 日期系统）：数字日期按工作簿日期系统解析，当日及之后的余额排除`, (t) => {
      const file = readBalanceSeedImportFile(writeDateWorkbook(t, date1904));
      assert.equal(file.date1904, date1904);
      assert.deepEqual(file.displayRows.slice(1).map((row) => row[2]), ['2026-09-30', '2026-10-01', '2026-10-02']);
      const { records } = parseBalanceSeedImportRows(file.rows, { displayRows: file.displayRows, date1904: file.date1904 });
      assert.deepEqual(records.map((record) => [record.billDate, record.endBalance]), [
        ['2026-09-30', 10], ['2026-10-01', 20], ['2026-10-02', 30]
      ]);
      const result = matchBalanceSeedImport(records, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }]);
      assert.deepEqual([result.accounts[0].source, result.accounts[0].billDate, result.accounts[0].endBalance], ['file', '2026-09-30', 10]);
    });
  }

  test('日期系统未知（date1904 为 null）时序列号形式的账单日期（数字或纯数字文本）跳过，日历写法不受影响', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      ['银行账号', '币种', '账单日期', '期末余额'],
      ['A1', 'USD', 46295, 10],
      ['A1', 'USD', '46295', 11],
      ['A1', 'USD', '2026-09-29', 5],
      ['A1', 'USD', '20260928', 4],
      ['A1', 'USD', '260927', 3]
    ], { date1904: null });
    assert.equal(skippedRowCount, 2);
    assert.deepEqual(records.map((record) => record.billDate), ['2026-09-29', '2026-09-28', '2026-09-27']);
  });

  test('已知日期系统时纯数字文本序列号与数字单元格同样换算；8 位、6 位日历写法不按序列号处理', () => {
    const rows = [
      ['银行账号', '币种', '账单日期', '期末余额'],
      ['A1', 'USD', '44835', 30],
      ['A1', 'USD', '44833', 10],
      ['A1', 'USD', '20260929', 9]
    ];
    const in1904 = parseBalanceSeedImportRows(rows, { date1904: true }).records.map((record) => record.billDate);
    assert.deepEqual(in1904, ['2026-10-02', '2026-09-30', '2026-09-29']);
    const in1900 = parseBalanceSeedImportRows(rows, { date1904: false }).records.map((record) => record.billDate);
    assert.deepEqual(in1900, ['2022-10-01', '2022-09-29', '2026-09-29']);
    const records = parseBalanceSeedImportRows(rows, { date1904: true }).records;
    const result = matchBalanceSeedImport(records, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }]);
    assert.deepEqual([result.accounts[0].billDate, result.accounts[0].endBalance], ['2026-09-30', 10], '1904 文本序列号的未来余额不会被当作历史余额');
  });

  test('带时间后缀的文本序列号同样按日期系统换算，未知日期系统时跳过；文本序列号范围外（如 365）的行按无效跳过', () => {
    const rows = [
      ['银行账号', '币种', '账单日期', '期末余额'],
      ['A1', 'USD', '44835 12:30:00', 30],
      ['A1', 'USD', '44835T12:30:00', 31],
      ['A1', 'USD', '44835,12.30 PM', 32],
      ['A1', 'USD', '365', 33],
      ['A1', 'USD', '44833 08:00', 10]
    ];
    const in1904 = parseBalanceSeedImportRows(rows, { date1904: true });
    assert.equal(in1904.skippedRowCount, 1);
    assert.deepEqual(in1904.records.map((record) => record.billDate), ['2026-10-02', '2026-10-02', '2026-10-02', '2026-09-30']);
    const result = matchBalanceSeedImport(in1904.records, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }]);
    assert.deepEqual([result.accounts[0].billDate, result.accounts[0].endBalance], ['2026-09-30', 10]);
    const unknown = parseBalanceSeedImportRows(rows, { date1904: null });
    assert.equal(unknown.skippedRowCount, 5);
    assert.deepEqual(unknown.records, []);
  });

  test('扩展名为 .csv、内容实为 xlsx 时按工作簿日期系统处理', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-disguised-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['银行账号', '币种', '账单日期', '期末余额'], ['A1', 'USD', '44835 12:30:00', 30], ['A1', 'USD', 44833, 10]
    ]), 'balance');
    workbook.Workbook = { WBProps: { date1904: true } };
    const filePath = path.join(dir, '余额.csv');
    fs.writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }));
    const file = readBalanceSeedImportFile(filePath);
    assert.equal(file.date1904, true);
    const records = parseBalanceSeedImportRows(file.rows, { displayRows: file.displayRows, date1904: file.date1904 }).records;
    assert.deepEqual(records.map((record) => record.billDate), ['2026-10-02', '2026-09-30']);
  });

  test('真实文件：xls（1904）文本序列号按工作簿日期系统；CSV 没有日期系统，序列号日期跳过、日历日期照常', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-serial-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const aoa = [['银行账号', '币种', '账单日期', '期末余额'], ['A1', 'USD', '44835', 30], ['A1', 'USD', '44833', 10]];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'balance');
    workbook.Workbook = { WBProps: { date1904: true } };
    const xlsPath = path.join(dir, '余额.xls');
    XLSX.writeFile(workbook, xlsPath, { bookType: 'biff8' });
    const xls = readBalanceSeedImportFile(xlsPath);
    assert.equal(xls.date1904, true);
    const xlsMatch = matchBalanceSeedImport(
      parseBalanceSeedImportRows(xls.rows, { displayRows: xls.displayRows, date1904: xls.date1904 }).records,
      [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }]
    );
    assert.deepEqual([xlsMatch.accounts[0].billDate, xlsMatch.accounts[0].endBalance], ['2026-09-30', 10]);

    const csvPath = path.join(dir, '余额.csv');
    fs.writeFileSync(csvPath, '银行账号,币种,账单日期,期末余额\nA1,USD,44835,30\nA1,USD,2026-09-29,9\n');
    const csv = readBalanceSeedImportFile(csvPath);
    assert.equal(csv.date1904, null);
    const parsed = parseBalanceSeedImportRows(csv.rows, { displayRows: csv.displayRows, date1904: csv.date1904 });
    assert.equal(parsed.skippedRowCount, 1);
    assert.deepEqual(parsed.records.map((record) => [record.billDate, record.endBalance]), [['2026-09-29', 9]]);
  });
});

test.describe('matchBalanceSeedImport', () => {
  const records = parseBalanceSeedImportRows([
    HEADER,
    balanceRow({ account: 'A1', date: '2026-09-28', balance: '10' }),
    balanceRow({ account: 'A1', date: '2026-09-30', balance: '30' }),
    balanceRow({ account: 'A1', date: '2026-10-01', balance: '40' }),
    balanceRow({ account: 'A1', date: '2026-10-02', balance: '50' }),
    balanceRow({ account: 'A1', currency: 'EUR', date: '2026-09-30', balance: '99' }),
    balanceRow({ account: 'B2', date: '2026-09-30', balance: '1.001' }),
    balanceRow({ account: 'B2', date: '2026-09-30', balance: '1.004' }),
    balanceRow({ account: 'C3', date: '2026-09-30', balance: '5' }),
    balanceRow({ account: 'C3', date: '2026-09-30', balance: '6' }),
    balanceRow({ account: 'D4', date: '2026-10-01', balance: '7' })
  ]).records;

  test('取早于当前账单日期的最近一天；等于或晚于当前账单日期的行排除；币种不区分大小写', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'A1', currency: 'usd', targetBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(result.accounts, [{
      merchantId: 'A1',
      currency: 'usd',
      targetBillDate: '2026-10-01',
      billDate: '2026-09-30',
      endBalance: 30,
      source: 'file',
      reason: ''
    }]);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.manualCount, 0);
  });

  test('币种不同不算同一账号', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'A1', currency: 'EUR', targetBillDate: '2026-10-01' }
    ]);
    assert.equal(result.accounts[0].endBalance, 99);
  });

  test('同日余额按分相同算一个余额，取首行原值', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'B2', currency: 'USD', targetBillDate: '2026-10-01' }
    ]);
    assert.equal(result.accounts[0].source, 'file');
    assert.equal(result.accounts[0].endBalance, 1.001);
  });

  test('同日多个不同余额、无更早余额、文件中无该账号 → 需手工录入并写明原因', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'C3', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'D4', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'Z9', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'A1', currency: 'JPY', targetBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.reason, account.billDate, account.endBalance]), [
      ['C3', 'manual', '文件中 2026-09-30 有多个不同余额', '', null],
      ['D4', 'manual', '文件中没有该账号早于 2026-10-01 的余额', '', null],
      ['Z9', 'manual', '文件中没有该账号', '', null],
      ['A1', 'manual', '文件中没有该账号', '', null]
    ]);
    assert.equal(result.matchedCount, 0);
    assert.equal(result.manualCount, 4);
  });

  test('余额为 0 视为有效余额', () => {
    const zero = parseBalanceSeedImportRows([HEADER, balanceRow({ account: 'Z0', date: '2026-09-30', balance: '0.00' })]).records;
    const result = matchBalanceSeedImport(zero, [{ merchantId: 'Z0', currency: 'USD', targetBillDate: '2026-10-01' }]);
    assert.equal(result.accounts[0].source, 'file');
    assert.equal(result.accounts[0].endBalance, 0);
  });

  test('保持待补录账号的顺序；没有待补录账号返回空', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'Z9', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(result.accounts.map((account) => account.merchantId), ['Z9', 'A1']);
    assert.deepEqual(matchBalanceSeedImport(records, []), { accounts: [], matchedCount: 0, manualCount: 0 });
  });
});
