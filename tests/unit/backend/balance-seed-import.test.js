'use strict';

// v3.2.17：补录余额「导入余额文件」解析与匹配（src/backend/balance-seed-import.js）
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchBalanceSeedImport,
  parseBalanceSeedImportRows
} = require('../../../src/backend/balance-seed-import');

// 银行原始日终余额信息（清结算系统导出）的列，含不参与解析的列与可选参考列（v3.2.22）。
const HEADER = ['bizId', '账单日期', '主体', '银行类型', '银行名', '开户地', '币种', '账户名称', '银行账户号',
  '期初余额', '期末余额', '对账期末余额', '余额来源', '余额获取方式', '操作人'];
// 只含必需列（数字账号、日期系统用例）：银行名、开户地缺省为空，匹配时本组也传空。
const SHORT_HEADER = ['银行账户号', '币种', '账单日期', '期末余额', '银行名', '开户地'];
const GROUP = Object.freeze({ bankName: 'DBS', location: 'SG' });

function balanceRow({
  account, currency = 'USD', date, balance, bankName = 'DBS', location = 'SG', source = '网银账单', method = '手工导入'
}) {
  return ['1', date, 'ABCD', '渠道', bankName, location, currency, `ABCD-${location}-${bankName}-${account}-${currency}`,
    account, '', balance, balance, source, method, 'op'];
}

test.describe('parseBalanceSeedImportRows', () => {
  test('首行表头（银行原始日终余额信息）：按列名取 6 个取值字段与参考列，其他列忽略', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: ' 6001 ', currency: 'usd', date: '2026/09/30', balance: '1,234.50', bankName: ' Fincra ', location: 'NG' })
    ]);
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records, [{
      merchantId: '6001',
      currency: 'USD',
      bankName: 'Fincra',
      location: 'NG',
      billDate: '2026-09-30',
      endBalance: 1234.5,
      balanceSource: '网银账单',
      balanceMethod: '手工导入',
      rowNumber: 2
    }]);
  });

  test('表头前有标题行、列顺序不同也能识别；参考列缺失时为空；空行不计入跳过数', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      ['日终余额'],
      [],
      ['期末余额', '开户地', '账单日期', '银行账户号', '币种', '银行名'],
      ['0', 'SG', '20260930', 'A1', 'EUR', 'DBS'],
      ['', '', '', '', '', '']
    ]);
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records.map((record) => [
      record.merchantId, record.currency, record.bankName, record.location, record.billDate, record.endBalance,
      record.balanceSource, record.balanceMethod, record.rowNumber
    ]), [
      ['A1', 'EUR', 'DBS', 'SG', '2026-09-30', 0, '', '', 4]
    ]);
  });

  test('缺列报错并写明缺哪些列；旧版余额账单 4 列格式不再接受', () => {
    assert.throws(
      () => parseBalanceSeedImportRows([['银行账户号', '币种', '账单日期', '银行名', '开户地'], ['A1', 'USD', '2026-09-30', 'DBS', 'SG']]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING' && error.message === '余额文件缺少列：期末余额'
    );
    assert.throws(
      () => parseBalanceSeedImportRows([
        ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'],
        ['DBS', 'SG', 'USD', 'A1', '2026-09-30', '', '', '1', '']
      ]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING'
        && error.message === '余额文件缺少列：银行名、开户地、银行账户号'
        && /银行原始日终余额信息/.test(error.detailLines.join('\n'))
    );
    assert.throws(
      () => parseBalanceSeedImportRows([['x'], ['y']]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING'
    );
  });

  test('账号为空、日期或金额无效的行跳过并计数；账号可识别的无效行另按读不出记下；银行名、开户地为空不算无效，币种为空按读不出', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: '', date: '2026-09-30', balance: '1' }),
      balanceRow({ account: 'A1', date: '不是日期', balance: '1' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: 'abc' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '-8.8', bankName: '', location: '' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '7', currency: '' })
    ]);
    assert.equal(skippedRowCount, 4);
    assert.deepEqual(records.filter((record) => !record.unreadableFields).map((record) => [record.endBalance, record.bankName, record.location]),
      [[-8.8, '', '']]);
    assert.deepEqual(records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]), [
      [3, { billDate: '无法识别为日期' }], [4, { endBalance: '无法识别为金额' }], [5, { endBalance: '为空' }], [7, { currency: '为空' }]
    ]);
  });

  test('账号可识别、最近一天的期末余额为空或无法识别：不退回更早一天的余额，改为手工录入并写明原因', () => {
    const { records } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: 'A1', date: '2026-09-29', balance: '10' }),
      balanceRow({ account: 'A1', date: '2026-09-30', balance: '' }),
      balanceRow({ account: 'B2', date: '2026-09-29', balance: '20' }),
      balanceRow({ account: 'B2', date: '2026-09-30', balance: 'N/A' }),
      balanceRow({ account: 'C3', date: '2026-09-28', balance: '' }),
      balanceRow({ account: 'C3', date: '2026-09-29', balance: '30' })
    ]);
    const pending = ['A1', 'B2', 'C3'].map((merchantId) => ({ merchantId, currency: 'USD', targetBillDate: '2026-10-01' }));
    const result = matchBalanceSeedImport(records, pending, GROUP);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.endBalance]),
      [['A1', 'manual', null], ['B2', 'manual', null], ['C3', 'file', 30]], 'C3 的无效行早于可用的最近余额，不影响');
    assert.match(result.accounts[0].reason, /2026-09-30 的余额行（第 3 行）期末余额读不出（为空）/);
    assert.match(result.accounts[1].reason, /期末余额读不出（无法识别为金额）/);
  });

  test('随包模板 assets/银行原始日终余额信息.xlsx 的表头包含全部取值列与参考列，且能按本模块解析', () => {
    const path = require('node:path');
    const {
      BALANCE_IMPORT_COLUMNS,
      BALANCE_IMPORT_OPTIONAL_COLUMNS,
      readBalanceSeedImportFile
    } = require('../../../src/backend/balance-seed-import');
    const file = readBalanceSeedImportFile(path.join(__dirname, '../../../assets/银行原始日终余额信息.xlsx'));
    const header = file.rows[0].map((cell) => String(cell).trim());
    [...Object.values(BALANCE_IMPORT_COLUMNS), ...Object.values(BALANCE_IMPORT_OPTIONAL_COLUMNS)].forEach((column) => {
      assert.ok(header.includes(column), `模板缺少列：${column}`);
    });
    assert.doesNotThrow(() => parseBalanceSeedImportRows(file.rows, { displayRows: file.displayRows, date1904: file.date1904 }));
  });
});

test.describe('parseBalanceSeedImportRows — 数字型银行账号', () => {
  const ACCOUNT_DISPLAY_REJECTED = (error) => error.code === 'FILE_READ' && error.message === '余额文件中银行账户号显示的内容可能与原值不同'
    + '（单元格的数字格式或条件格式），无法确认属于哪个账号，请把银行账户号改为常规或文本格式后重新导入';
  const unidentified = (rowNumber) => (error) => error.code === 'FILE_READ'
    && error.message === `余额文件第 ${rowNumber} 行的银行账户号是无法确认原值的数字（超过 15 位、带小数，或无法核对显示的内容），`
      + '无法确认属于哪个账号，请把银行账户号改为文本或修正后重新导入';
  const rowOf = (account) => [account, 'USD', '2026-09-30', 1];
  const displayOf = (account) => [String(account), 'USD', '2026-09-30', '1'];

  test('显示文本与原值一致的 15 位以内整数账号按文本使用，文本账号不受影响', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows(
      [SHORT_HEADER, rowOf(123456789012345), rowOf('6222000000000001234')],
      { displayRows: [SHORT_HEADER, displayOf('123456789012345'), displayOf('6222000000000001234')] }
    );
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records.map((record) => record.merchantId), ['123456789012345', '6222000000000001234']);
  });

  test('超过 15 位、带小数的数字账号整个文件不导入（Excel 只保留 15 位有效数字），不跳过后让该账号退回更早一天的余额', () => {
    for (const account of [6222000000000001000, 1234567890123456, 12.5]) {
      assert.throws(() => parseBalanceSeedImportRows(
        [SHORT_HEADER, rowOf('6222000000000001234'), rowOf(account)],
        { displayRows: [SHORT_HEADER, displayOf('6222000000000001234'), displayOf(account)] }
      ), unidentified(3), String(account));
    }
  });

  test('银行账户号显示的内容与原值不同（数字补了前导 0、文本格式的文本段）时整个文件不导入，不跳过后让该账号退回更早一天的余额', () => {
    assert.throws(() => parseBalanceSeedImportRows([SHORT_HEADER, rowOf(123)], { displayRows: [SHORT_HEADER, displayOf('000123')] }),
      ACCOUNT_DISPLAY_REJECTED);
    const textRows = [SHORT_HEADER, ['001', 'USD', '2026-09-29', 10], ['1', 'USD', '2026-09-30', 20]];
    assert.throws(() => parseBalanceSeedImportRows(textRows, {
      displayRows: [SHORT_HEADER, ['001', 'USD', '2026-09-29', '10'], ['001', 'USD', '2026-09-30', '20']]
    }), ACCOUNT_DISPLAY_REJECTED);
    // 显示与原值只差首尾空白时照常导入
    assert.deepEqual(parseBalanceSeedImportRows(textRows, {
      displayRows: [SHORT_HEADER, ['001 ', 'USD', '2026-09-29', '10'], [' 1', 'USD', '2026-09-30', '20']]
    }).records.map((record) => record.merchantId), ['001', '1']);
  });

  test('币种、银行名、开户地显示的内容与原值不同（如 xls 自定义格式的文本段）时该格读不出', () => {
    const textRows = [SHORT_HEADER, ['A1', 'USD', '2026-09-29', 10, 'DBS', 'HK1'], ['A1', 'USD', '2026-09-30', 20, 'DBS', '1']];
    const { records } = parseBalanceSeedImportRows(textRows, {
      displayRows: [SHORT_HEADER, ['A1', 'USD', '2026-09-29', '10', 'DBS', 'HK1'], ['A1', 'USD', '2026-09-30', '20', 'DBS', 'HK1']]
    });
    assert.deepEqual(records.map((record) => record.unreadableFields || null), [null, { location: '单元格显示的内容与原值不同' }]);
    const result = matchBalanceSeedImport(records, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }], { bankName: 'DBS', location: 'HK1' });
    assert.deepEqual([result.accounts[0].source, result.accounts[0].endBalance], ['manual', null]);
  });

  test('拿不到显示文本（或显示文本行数对不上）时数字型账号整个文件不导入；文本账号不受影响', () => {
    const rows = [SHORT_HEADER, rowOf('6222000000000001234'), rowOf(123)];
    assert.throws(() => parseBalanceSeedImportRows(rows), unidentified(3));
    assert.throws(() => parseBalanceSeedImportRows(rows, { displayRows: [SHORT_HEADER, displayOf('123')] }), unidentified(3));
    assert.deepEqual(parseBalanceSeedImportRows(rows.slice(0, 2)).records.map((record) => record.merchantId), ['6222000000000001234']);
  });

  test('银行账户号是没有计算结果的公式时整个文件不导入（Excel 中看得到账号）；Excel 错误值、被跨列合并遮住的格照常按无效行跳过', () => {
    const rows = [SHORT_HEADER, rowOf('A1'), rowOf('')];
    const marks = (reason) => [null, null, new Map([[0, reason]])];
    assert.throws(() => parseBalanceSeedImportRows(rows, { unreadableCells: marks('公式没有计算结果') }),
      (error) => error.code === 'FILE_READ' && error.message.startsWith('余额文件第 3 行的银行账户号读不出（公式没有计算结果）'));
    for (const reason of ['Excel 错误值 #N/A', '跨列合并单元格']) {
      const { records, skippedRowCount } = parseBalanceSeedImportRows(rows, { unreadableCells: marks(reason) });
      assert.deepEqual([records.map((record) => record.merchantId), skippedRowCount], [['A1'], 1], reason);
    }
  });

  test('真实 xlsx：零填充格式的数字账号整个文件不导入；去掉格式后 General 数字账号与文本账号照常识别', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const XLSX = require('xlsx');
    const { readBalanceSeedImportFile } = require('../../../src/backend/balance-seed-import');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, '余额.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      SHORT_HEADER,
      [123, 'USD', '2026-09-30', 10],
      [456, 'USD', '2026-09-30', 20],
      ['000789', 'USD', '2026-09-30', 30]
    ]);
    sheet.A2.z = '000000';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'balance');
    XLSX.writeFile(workbook, filePath);
    // 显示为 000123：不当作 123，也不跳过后让 000123 退回别的行的余额
    assert.throws(() => readBalanceSeedImportFile(filePath), (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message));

    delete sheet.A2.z;
    XLSX.writeFile(workbook, filePath);
    const { rows: fileRows, displayRows: fileDisplayRows } = readBalanceSeedImportFile(filePath);
    const { records, skippedRowCount } = parseBalanceSeedImportRows(fileRows, { displayRows: fileDisplayRows });
    assert.equal(skippedRowCount, 0);
    assert.deepEqual(records.map((record) => [record.merchantId, record.endBalance]), [['123', 10], ['456', 20], ['000789', 30]]);
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
      SHORT_HEADER,
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

  test('数字单元格按日期系统换算序列号，日期系统未知（date1904 为 null）时读不出；纯数字文本、6 位写法与带时间的序列号文本一律读不出（W4）', () => {
    const rows = [
      SHORT_HEADER,
      ['A1', 'USD', 44833, 10],
      ['A1', 'USD', '44835', 30],
      ['A1', 'USD', '44835 12:30:00', 31],
      ['A1', 'USD', '260927', 3],
      ['A1', 'USD', '20260929', 9]
    ];
    const in1904 = parseBalanceSeedImportRows(rows, { date1904: true });
    assert.equal(in1904.skippedRowCount, 3);
    assert.deepEqual(in1904.records.filter((record) => !record.unreadableFields).map((record) => record.billDate), ['2026-09-30', '2026-09-29']);
    // Excel 把纯数字文本按文本显示，不是日期：按读不出处理，该账号不退回较早的余额
    assert.deepEqual(in1904.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]),
      [[3, { billDate: '无法识别为日期' }], [4, { billDate: '无法识别为日期' }], [5, { billDate: '无法识别为日期' }]]);
    const pending = [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }];
    assert.match(matchBalanceSeedImport(in1904.records, pending).accounts[0].reason, /第 3 行 等 3 行.*账单日期读不出（无法识别为日期）/);
    const unknown = parseBalanceSeedImportRows(rows, { date1904: null });
    assert.deepEqual(unknown.records.filter((record) => !record.unreadableFields).map((record) => record.billDate), ['2026-09-29']);
    assert.deepEqual(unknown.records.find((record) => record.rowNumber === 2).unreadableFields, { billDate: '无法识别为日期' });
  });

  test('文本日期只接受四位年份在前的写法（W4）；日在前、两位年份（含 26年9月30日）与无效的 8 位数字无法确认顺序，其余文本无法识别，都不退回较早的余额', () => {
    const { records, skippedRowCount } = parseBalanceSeedImportRows([
      SHORT_HEADER,
      ['A1', 'USD', '2026-09-29', 9],
      // 共享解析口径按日在前读成 1 月 10 日，Excel 按区域设置可能读成 10 月 1 日
      ['A1', 'USD', '10/01/2026', 101],
      ['B2', 'USD', '2026-09-29', 9],
      ['B2', 'USD', '13/09/2026', 13],
      ['C3', 'USD', '2026-09-29', 9],
      // 两位年份：共享解析口径把 26年9月30日 读成 2030-09-26
      ['C3', 'USD', '26年9月30日', 26],
      ['D4', 'USD', '2026-09-29', 9],
      ['D4', 'USD', '01102026', 8],
      ['E5', 'USD', '2026-09-29', 9],
      ['E5', 'USD', '20260930', 30],
      ['F6', 'USD', '2026-09-29', 9],
      ['F6', 'USD', '2026年9月30日 08:00', 30],
      ['G7', 'USD', '2026-09-29', 9],
      ['G7', 'USD', '2026.9.30', 30],
      ['H8', 'USD', '2026-09-29', 9],
      ['H8', 'USD', '2026/9/30 10:00:00', 30],
      ['I9', 'USD', '2026-09-29', 9],
      // 分隔符不一致、带星期等其他写法
      ['I9', 'USD', '2026-9/30', 30],
      ['J10', 'USD', '2026-09-29', 9],
      ['J10', 'USD', 'Sep 30, 2026', 30]
    ], { date1904: false });
    assert.equal(skippedRowCount, 6);
    assert.deepEqual(records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields.billDate]), [
      [3, '无法确认年、月、日的顺序'], [5, '无法确认年、月、日的顺序'], [7, '无法确认年、月、日的顺序'], [9, '无法确认年、月、日的顺序'],
      [19, '无法识别为日期'], [21, '无法识别为日期']
    ]);
    const pending = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9', 'J10']
      .map((merchantId) => ({ merchantId, currency: 'USD', targetBillDate: '2026-10-02' }));
    const result = matchBalanceSeedImport(records, pending);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]), [
      ['A1', 'manual', '', null], ['B2', 'manual', '', null], ['C3', 'manual', '', null], ['D4', 'manual', '', null],
      ['E5', 'file', '2026-09-30', 30], ['F6', 'file', '2026-09-30', 30], ['G7', 'file', '2026-09-30', 30], ['H8', 'file', '2026-09-30', 30],
      ['I9', 'manual', '', null], ['J10', 'manual', '', null]
    ]);
    assert.match(result.accounts[0].reason, /第 3 行.*账单日期读不出（无法确认年、月、日的顺序）/);
    assert.match(result.accounts[2].reason, /第 7 行.*账单日期读不出（无法确认年、月、日的顺序）/);
  });

  test('只接受 xlsx（W1）：扩展名不是 .xlsx（.xls、.csv、.xlsm 等），或内容不是 xlsx（ZIP 容器）时不导入，提示另存为 xlsx', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-xlsx-only-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SHORT_HEADER, ['A1', 'USD', '2026-09-30', 10]]), 'balance');
    const XLSX_ONLY = /余额文件须为 xlsx 格式.*请在 Excel 中打开并另存为 xlsx 后重新导入/;
    const write = (name, content) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    };
    const xlsxBytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    assert.equal(readBalanceSeedImportFile(write('余额.XLSX', xlsxBytes)).rows.length, 2);
    // 扩展名不对：内容是 xlsx 也不导入（FILE_TYPE）
    ['余额.csv', '余额.xls', '余额.xlsm', '余额.xlsb', '余额'].forEach((name) => {
      assert.throws(() => readBalanceSeedImportFile(write(name, xlsxBytes)), (error) => error.code === 'FILE_TYPE' && XLSX_ONLY.test(error.message));
    });
    // 扩展名是 .xlsx、内容是 xls / CSV / HTML / XML 电子表格：不导入（FILE_READ）
    [
      XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }),
      XLSX.write(workbook, { bookType: 'biff5', type: 'buffer' }),
      Buffer.from('银行账户号,币种,账单日期,期末余额,银行名,开户地\nA1,USD,2026-09-30,10,,\n'),
      Buffer.from(XLSX.write(workbook, { bookType: 'html', type: 'string' })),
      Buffer.from(XLSX.write(workbook, { bookType: 'xlml', type: 'string' }))
    ].forEach((content, index) => {
      assert.throws(() => readBalanceSeedImportFile(write(`余额-${index}.xlsx`, content)),
        (error) => error.code === 'FILE_READ' && XLSX_ONLY.test(error.message), `第 ${index} 种`);
    });
    // xlsb（ZIP 容器、二进制部件）：无法按原文核对，不导入
    assert.throws(() => readBalanceSeedImportFile(write('余额-xlsb.xlsx', XLSX.write(workbook, { bookType: 'xlsb', type: 'buffer' }))),
      (error) => error.code === 'FILE_READ' && /无法核对余额文件的工作表内容/.test(error.message));
  });
});

test.describe('readBalanceSeedImportFile 行号、单次读取与工作表核对（v3.2.22）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const XLSX = require('xlsx');
  const { readBalanceSeedImportFile } = require('../../../src/backend/balance-seed-import');
  const header = ['账单日期', '银行名', '开户地', '币种', '银行账户号', '期末余额', '余额来源', '余额获取方式'];
  const parseFile = (filePath) => {
    const file = readBalanceSeedImportFile(filePath);
    return { file, parsed: parseBalanceSeedImportRows(file.rows, file) };
  };
  const tempDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-import-rows-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  test('xlsx 表头在第 2 行、候选在第 4、6 行（中间有空行）：行号为工作表物理行号', (t) => {
    const dir = tempDir(t);
    const sheet = XLSX.utils.aoa_to_sheet([
      [],
      header,
      [],
      ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 10, '网银账单', '手工导入'],
      [],
      ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 20, '银行直连', 'API']
    ]);
    sheet['!ref'] = 'A2:H6';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
    const filePath = path.join(dir, '日终余额.xlsx');
    XLSX.writeFile(workbook, filePath);
    const { file, parsed } = parseFile(filePath);
    assert.deepEqual(file.rowNumbers, [2, 4, 6]);
    assert.equal(parsed.skippedRowCount, 0);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.endBalance, record.balanceSource]),
      [[4, 10, '网银账单'], [6, 20, '银行直连']]);
    const [account] = matchBalanceSeedImport(parsed.records, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }], GROUP).accounts;
    assert.deepEqual(account.choices.map((choice) => choice.rowNumber), [4, 6]);
  });

  const writeSheet = (t, aoa, decorate = () => {}) => {
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    decorate(sheet);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
    const filePath = path.join(tempDir(t), '日终余额.xlsx');
    XLSX.writeFile(workbook, filePath);
    return filePath;
  };
  const pendingOf = (merchantIds) => merchantIds.map((merchantId) => ({ merchantId, currency: 'USD', targetBillDate: '2026-11-21' }));
  // 本组输出名称不带所在地（开户地为空）：读不出的开户地读成空串后原本会与之匹配
  const NO_LOCATION_GROUP = Object.freeze({ bankName: 'DBS', location: '' });

  test('真实 xlsx：Excel 错误值读不出，不当作空值匹配、也不按无效行跳过；日期不早于可核对的最近余额时整个账号改为手工录入', (t) => {
    const NA = { t: 'e', v: 0x2A };
    const filePath = writeSheet(t, [
      header,
      ['2026-11-20', 'DBS', NA, 'USD', 'A1', 300, '网银', '接口'],
      ['2026-11-19', 'DBS', '', 'USD', 'A1', 200, '网银', '接口'],
      // 读不出的行早于可核对的最近余额：不影响
      ['2026-11-18', 'DBS', NA, 'USD', 'B2', 100, '网银', '接口'],
      ['2026-11-19', 'DBS', '', 'USD', 'B2', 150, '网银', '接口'],
      // 可读的银行名与本组不同：不是本组的行，不影响
      ['2026-11-20', 'CITI', NA, 'USD', 'C3', 1, '网银', '接口'],
      ['2026-11-19', 'DBS', '', 'USD', 'C3', 2, '网银', '接口'],
      // 币种为错误值
      ['2026-11-20', 'DBS', '', { t: 'e', v: 0x0F }, 'D4', 5, '网银', '接口'],
      // 读不出的行不早于当前账单日期：本来就不取，不影响
      ['2026-11-21', 'DBS', NA, 'USD', 'E5', 7, '网银', '接口'],
      ['2026-11-19', 'DBS', '', 'USD', 'E5', 6, '网银', '接口'],
      // 期末余额为错误值：不按无效行跳过后退回更早一天
      ['2026-11-19', 'DBS', '', 'USD', 'F6', { t: 'e', v: 0x07 }, '网银', '接口'],
      ['2026-11-18', 'DBS', '', 'USD', 'F6', 40, '网银', '接口'],
      // 银行账户号读不出：无法归属，按无效行跳过
      ['2026-11-19', 'DBS', '', 'USD', NA, 9, '网银', '接口']
    ]);
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 1);
    assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]), [
      [2, { location: 'Excel 错误值 #N/A' }], [4, { location: 'Excel 错误值 #N/A' }], [6, { location: 'Excel 错误值 #N/A' }],
      [8, { currency: 'Excel 错误值 #VALUE!' }], [9, { location: 'Excel 错误值 #N/A' }], [11, { endBalance: 'Excel 错误值 #DIV/0!' }]
    ]);
    assert.equal(Object.hasOwn(parsed.records.find((record) => record.rowNumber === 3), 'unreadableFields'), false, '可核对的行结构不变');

    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2', 'C3', 'D4', 'E5', 'F6']), NO_LOCATION_GROUP);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]), [
      ['A1', 'manual', '', null],
      ['B2', 'file', '2026-11-19', 150],
      ['C3', 'file', '2026-11-19', 2],
      ['D4', 'manual', '', null],
      ['E5', 'file', '2026-11-19', 6],
      ['F6', 'manual', '', null]
    ]);
    assert.equal(result.accounts[0].reason, '文件中该账号 2026-11-20 的余额行（第 2 行）开户地读不出（Excel 错误值 #N/A），无法确认该账号的余额，请手工填写');
    assert.match(result.accounts[3].reason, /2026-11-20 的余额行（第 8 行）币种读不出（Excel 错误值 #VALUE!）/);
    assert.match(result.accounts[5].reason, /2026-11-19 的余额行（第 11 行）期末余额读不出（Excel 错误值 #DIV\/0!）/);
  });

  test('真实 xlsx：没有计算结果的公式读不出（开户地、账单日期），不当作空值；有计算结果的公式照常取值', (t) => {
    const filePath = writeSheet(t, [
      header,
      ['2026-09-30', 'DBS', '', 'USD', 'A1', 30, '网银', '接口'],
      ['2026-09-29', 'DBS', 'HK', 'USD', 'A1', 29, '网银', '接口'],
      ['', 'DBS', 'HK', 'USD', 'B2', 50, '网银', '接口'],
      ['2026-09-28', 'DBS', 'HK', 'USD', 'B2', 28, '网银', '接口'],
      ['2026-09-30', 'DBS', '', 'USD', 'C3', 70, '网银', '接口'],
      ['2026-09-30', 'DBS', '', 'USD', 'D4', 80, '网银', '接口'],
      ['2026-09-29', 'DBS', 'HK', 'USD', 'D4', 79, '网银', '接口'],
      ['2026-09-30', 'DBS', 'HK', 'USD', 'E5', 90, '网银', '接口'],
      ['2026-09-29', 'DBS', 'HK', 'USD', 'E5', 89, '网银', '接口']
    ], (sheet) => {
      // C2：没有缓存的 ="HK"（读取库留占位）；A4：没有缓存的日期公式；C6：有缓存的 ="HK"；
      // C7：文本公式读出空串（没有缓存的 t="str" 公式与缓存为空串读出来相同）；B9：布尔公式（没有缓存时读成 FALSE）
      sheet.C2 = { t: 's', f: '"HK"' };
      sheet.A4 = { t: 'n', f: 'DATE(2026,9,30)' };
      sheet.C6 = { t: 's', v: 'HK', f: '"HK"' };
      sheet.C7 = { t: 's', v: '', f: '"HK"' };
      sheet.B9 = { t: 'b', v: false, f: 'TRUE' };
    });
    const { parsed } = parseFile(filePath);
    assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]), [
      [2, { location: '公式没有计算结果' }], [4, { billDate: '公式没有计算结果' }], [7, { location: '公式没有计算结果' }],
      [9, { bankName: '公式没有计算结果' }]
    ]);
    const hk = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2', 'C3', 'D4', 'E5']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(hk.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]), [
      ['A1', 'manual', '', null],
      ['B2', 'manual', '', null],
      ['C3', 'file', '2026-09-30', 70],
      ['D4', 'manual', '', null],
      ['E5', 'manual', '', null]
    ], 'HK 分组不退回 9 月 29 日的较旧余额（开户地、银行名读不出）；日期读不出的行一律要求手工核对；有计算结果的公式照常匹配');
    assert.match(hk.accounts[1].reason, /^文件中该账号的余额行（第 4 行）账单日期读不出（公式没有计算结果）/);
    const empty = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), NO_LOCATION_GROUP);
    assert.deepEqual([empty.accounts[0].source, empty.accounts[0].endBalance], ['manual', null], '开户地为空的分组不取走读不出开户地的余额');
  });

  test('真实 xlsx：纵向合并单元格按首格的值取（同列后续行），跨列合并的单元格读不出', (t) => {
    const filePath = writeSheet(t, [
      header,
      ['2026-11-01', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-02', 'DBS', '', 'USD', 'A1', 20, '网银', '接口'],
      // 账号纵向合并：两天共用一个账号
      ['2026-11-01', 'DBS', 'HK', 'USD', 'B2', 30, '网银', '接口'],
      ['2026-11-02', 'DBS', 'HK', 'USD', '', 40, '网银', '接口'],
      // 银行名、开户地横向合并
      ['2026-11-02', 'DBS', '', 'USD', 'C3', 50, '网银', '接口'],
      // 账号纵向合并，被遮住的格里还留着旧账号 Z9（Excel 显示首格 D4）
      ['2026-11-01', 'DBS', 'HK', 'USD', 'D4', 60, '网银', '接口'],
      ['2026-11-02', 'DBS', 'HK', 'USD', 'Z9', 70, '网银', '接口']
    ], (sheet) => {
      sheet['!merges'] = [
        { s: { r: 1, c: 2 }, e: { r: 2, c: 2 } },
        { s: { r: 3, c: 4 }, e: { r: 4, c: 4 } },
        { s: { r: 5, c: 1 }, e: { r: 5, c: 2 } },
        { s: { r: 6, c: 4 }, e: { r: 7, c: 4 } }
      ];
    });
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 0);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.merchantId, record.location, record.unreadableFields || null]), [
      [2, 'A1', 'HK', null], [3, 'A1', 'HK', null], [4, 'B2', 'HK', null], [5, 'B2', 'HK', null],
      [6, 'C3', '', { location: '跨列合并单元格' }], [7, 'D4', 'HK', null], [8, 'D4', 'HK', null]
    ], '被遮住的旧值不参与匹配');
    const hidden = matchBalanceSeedImport(parsed.records, pendingOf(['D4', 'Z9']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(hidden.accounts.map((account) => [account.source, account.billDate, account.endBalance]), [
      ['file', '2026-11-02', 70], ['manual', '', null]
    ]);
    const hk = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(hk.accounts.map((account) => [account.source, account.billDate, account.endBalance]), [
      ['file', '2026-11-02', 20], ['file', '2026-11-02', 40]
    ]);
    const empty = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'C3']), NO_LOCATION_GROUP);
    assert.deepEqual(empty.accounts.map((account) => account.source), ['manual', 'manual'], '合并区域的后续行不归入开户地为空的分组');
    assert.match(empty.accounts[1].reason, /开户地读不出（跨列合并单元格）/);
  });

  test('真实 xlsx：数组公式结果区域里没有缓存、读取库未建单元格的格同样读不出，不退回该账号较早的余额；有缓存的数组结果照常取', (t) => {
    const filePath = writeSheet(t, [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', null, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', null, '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'B2', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'C3', null, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'D4', null, '网银', '接口']
    ], (sheet) => {
      // F3:F4 没有缓存的数组公式：写出的文件只有首格 F3 带公式，F4 没有单元格
      sheet.F3 = { t: 'n', f: 'E3:E4*1', F: 'F3:F4' };
      delete sheet.F4;
      // F6:F9 有缓存的数组公式，区域延伸到下方空行（空行不算读不出的行）
      sheet.F6 = { t: 'n', v: 5, f: 'E6:E9*1', F: 'F6:F9' };
      sheet.F7 = { t: 'n', v: 6, F: 'F6:F9' };
    });
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 0);
    assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]), [
      [3, { endBalance: '公式没有计算结果' }], [4, { endBalance: '公式没有计算结果' }]
    ]);
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2', 'C3', 'D4']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]), [
      ['A1', 'manual', '', null], ['B2', 'manual', '', null], ['C3', 'file', '2026-11-20', 5], ['D4', 'file', '2026-11-20', 6]
    ]);
    assert.match(result.accounts[0].reason, /2026-11-20 的余额行（第 4 行）期末余额读不出（公式没有计算结果）/);
  });

  test('真实 xlsx：跨列合并区域遮住的旧值不用于识别表头、也不作为余额来源等参考列显示', (t) => {
    const wideHeader = ['账单日期', '银行名', '开户地', '币种', '银行账户号', '说明', '期末余额', '期末余额', '余额来源', '余额获取方式'];
    const filePath = writeSheet(t, [
      wideHeader,
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', '', 9, 55, '网银', '旧方式'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', '', 8, 66, '网银', '接口']
    ], (sheet) => {
      sheet['!merges'] = [
        // F1:G1 合并，G1 被遮住但残留旧标题「期末余额」；H1 才是可见的「期末余额」
        { s: { r: 0, c: 5 }, e: { r: 0, c: 6 } },
        // I2:J2 合并，J2 被遮住的旧「余额获取方式」
        { s: { r: 1, c: 8 }, e: { r: 1, c: 9 } }
      ];
    });
    const { parsed } = parseFile(filePath);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.balanceSource, record.balanceMethod]), [
      ['A1', 55, '网银', '读不出（跨列合并单元格）'], ['B2', 66, '网银', '接口']
    ], '期末余额取可见的 H 列；被遮住的旧余额获取方式不显示，显示读不出的原因');
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual([result.accounts[0].source, result.accounts[0].endBalance], ['file', 55]);
  });

  // 写出真实 xlsx 后按原文改写压缩包里的条目（读取库写不出的写法，如共享公式从属格的空 <f t="shared"></f>）
  //   （定义在下方的用例之前即可：用例按顺序执行时才调用）
  // 整份样式表（不在读取库写出的样式表上打补丁：读取库的数字格式表是全局的，前面用例加载过的自定义格式会写进后面用例的样式表，
  //   插入式补丁随用例顺序失效）。numFmts 为 [[编号, 已转义的格式代码]]，cellXfs / cellStyleXfs 为样式 0 之后追加的 <xf>
  const stylesXml = ({ numFmts = [], cellXfs = [], cellStyleXfs = [], dxfs = '<dxfs count="0"/>' } = {}) => [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join('')}</numFmts>` : '',
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    `<cellStyleXfs count="${1 + cellStyleXfs.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>${cellStyleXfs.join('')}</cellStyleXfs>`,
    `<cellXfs count="${1 + cellXfs.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${cellXfs.join('')}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    dxfs,
    '</styleSheet>'
  ].join('');
  const formattedXf = (numFmtId) => `<xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
  const TEXT_SECTION_STYLES = { numFmts: [[170, '0;0;0;&quot;HK&quot;@']], cellXfs: [formattedXf(170)] };
  const writePatchedWorkbook = (t, sheets, patches, writeOptions = {}) => {
    // 前面用例读过格式编号写成字符引用的样式表后，读取库的全局格式表会多出非数字编号（"NaN" → General），
    //   写出时每个单元格都会带上新的样式编号（s="N"），后面的补丁随用例顺序失效。写出前去掉这些项
    const formatTable = XLSX.SSF.get_table();
    Object.keys(formatTable).filter((key) => !/^\d+$/.test(key)).forEach((key) => delete formatTable[key]);
    const workbook = XLSX.utils.book_new();
    sheets.forEach(([name, aoa]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), name));
    const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', ...writeOptions }), { type: 'buffer' });
    Object.entries(patches).forEach(([entryPath, patch]) => {
      const index = cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(entryPath));
      // null：删去这个部件
      if (patch === null) {
        cfb.FileIndex.splice(index, 1);
        cfb.FullPaths.splice(index, 1);
        return;
      }
      const entry = cfb.FileIndex[index];
      entry.content = Buffer.from(patch(Buffer.from(entry.content).toString('utf8')), 'utf8');
      entry.size = entry.content.length;
    });
    const filePath = path.join(tempDir(t), '日终余额.xlsx');
    fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
    return filePath;
  };
  // 只按结构白名单（W2）核对：同一份反例往往也会被后面更深一层的核对拒绝，单独断言白名单这一层本身生效
  const passesWhitelist = (filePath) => {
    const { checkXlsxStructureWhitelist } = require('../../../src/backend/file-service/readers');
    const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false, dense: true, sheetStubs: true, sheets: 0, bookFiles: true });
    return checkXlsxStructureWhitelist(workbook, workbook.SheetNames[0]);
  };
  const replaceCell = (address, xml) => (text) => {
    const pattern = new RegExp(`<c r="${address}"[^>]*/>|<c r="${address}"[^>]*>.*?</c>`);
    assert.match(text, pattern, address);
    return text.replace(pattern, xml);
  };

  test('真实 xlsx：合并范围按工作表原文（含读取库漏掉的单引号写法）处理：纵向合并的账号取首格，不把较早的余额当作最近一天的', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 100, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', '', 200, '网银', '接口']
    ];
    for (const quote of ['"', "'"]) {
      const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
        'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', `</sheetData><mergeCells count="1"><mergeCell ref=${quote}E2:E3${quote}/></mergeCells>`)
      });
      const { parsed } = parseFile(filePath);
      assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.merchantId, record.endBalance]), [[2, 'A1', 100], [3, 'A1', 200]], quote);
      const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), { bankName: 'DBS', location: 'HK' });
      assert.deepEqual([result.accounts[0].billDate, result.accounts[0].endBalance], ['2026-11-20', 200], quote);
    }
  });

  test('真实 xlsx：共享公式的从属格写成空的 <f t="shared"></f> 且没有缓存值时按工作表原文识别为读不出，不退回较早的余额', (t) => {
    const rows = [
      header,
      ['2026-11-18', 'DBS', 'HK', 'USD', 'A1', 40, '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'B2', 0, '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 0, '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'C3', 0, '网银', '接口']
    ];
    const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => [
        // F3 共享公式首格（有缓存）、F4 从属格没有缓存、F5 从属格有缓存
        replaceCell('F3', '<c r="F3"><f t="shared" ref="F3:F5" si="0">E3*1</f><v>70</v></c>'),
        replaceCell('F4', '<c r="F4"><f t="shared" si="0"></f></c>'),
        replaceCell('F5', '<c r="F5"><f t="shared" si="0"></f><v>80</v></c>')
      ].reduce((xml, patch) => patch(xml), text)
    });
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 0);
    assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]),
      [[4, { endBalance: '公式没有计算结果' }]]);
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2', 'C3']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]), [
      ['A1', 'manual', '', null], ['B2', 'file', '2026-11-19', 70], ['C3', 'file', '2026-11-19', 80]
    ], 'A1 不退回 11 月 18 日的余额');
    assert.match(result.accounts[0].reason, /2026-11-19 的余额行（第 4 行）期末余额读不出（公式没有计算结果）/);
  });

  test('按工作表原文核对公式缓存：数组公式区域按原文（含单引号属性）；行或单元格省略 r 属性（读取库按自己的口径推算坐标）时无法核对', (t) => {
    const { scanXlsxFormulaCache } = require('../../../src/backend/file-service/readers');
    const scan = (row2, row3) => {
      const filePath = writePatchedWorkbook(t, [['Balance', [['a', 'b', 'c'], [1, 2, 3], [4, 5, 6]]]], {
        'xl/worksheets/sheet1.xml': (text) => text
          .replace(/<row r="2"[^>]*>.*?<\/row>/, row2)
          .replace(/<row r="3"[^>]*>.*?<\/row>/, row3)
      });
      return scanXlsxFormulaCache(XLSX.read(fs.readFileSync(filePath), { type: 'buffer', bookFiles: true, sheets: 0 }), 'Balance');
    };
    const row2 = '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">1</f></c><c r="C2"><v>3</v></c></row>';
    const row3 = '<row r="3"><c r="B3"><f t="shared" si="0"></f><v></v></c><c r="C3"><f t=\'array\' ref=\'c3:$C$4\'>1</f><v>6</v></c></row>';
    const cache = scan(row2, row3);
    assert.deepEqual([...cache.uncachedCells].sort(), ['1:1', '2:1'], 'B2 与 B3（空 <v>）没有缓存值；C3 有缓存');
    assert.deepEqual(cache.arrayRanges, ['C3:C4']);
    assert.equal(scan(row2.replace(' r="B2"', ''), row3), null, '单元格省略 r');
    assert.equal(scan(row2, row3.replace('<row r="3">', '<row>')), null, '行省略 r');
  });

  test('真实 xlsx：只解析第一张工作表（其他表的空白格式单元格不产生占位）；无法按原文确认工作表时不导入', (t) => {
    const rows = [header, ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 40, '网银', '接口']];
    // 第二张表有大量只带格式的空白单元格
    const blankCells = Array.from({ length: 200 }, (_value, index) => `<c r="A${index + 2}" s="0"/>`).join('');
    const withSecond = writePatchedWorkbook(t, [['Balance', rows], ['Other', [['x']]]], {
      'xl/worksheets/sheet2.xml': (text) => text.replace(/<c r="A1"[^>]*>.*?<\/c>/, (cell) => `${cell}${blankCells}`)
    });
    const originalRead = XLSX.read;
    const parsedSheets = [];
    XLSX.read = (...args) => {
      const workbook = originalRead(...args);
      parsedSheets.push(Object.keys(workbook.Sheets));
      return workbook;
    };
    try {
      assert.deepEqual(parseFile(withSecond).parsed.records.map((record) => record.endBalance), [40]);
    } finally {
      XLSX.read = originalRead;
    }
    assert.deepEqual(parsedSheets, [['Balance']], '第二张表不解析');
    // workbook.xml 注释里有旧的 <sheet>：无法确认读取库读的是哪个条目，不按读不全的结果导入
    const unconfirmed = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/workbook.xml': (text) => text.replace('<sheets>', '<sheets><!-- <sheet name="Old" sheetId="9" r:id="rId9"/> -->')
    });
    assert.throws(() => readBalanceSeedImportFile(unconfirmed), (error) => error.code === 'FILE_READ'
      && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
    // 工作表 XML 有注释：读取库会解析注释里的行，同样不导入
    const commented = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('<sheetData>', '<sheetData><!-- old -->')
    });
    assert.throws(() => readBalanceSeedImportFile(commented), (error) => error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
  });

  test('真实 xlsx：工作簿关系的属性用制表符分隔（读取库认不出关系、改按物理序号读表）时不导入，不按关系取另一张表核对公式', (t) => {
    const history = [header, ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口']];
    const current = [header, ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 40, '网银', '接口']];
    // 物理顺序 History（sheet1.xml）、Current（sheet2.xml）；标签顺序改为 Current 在前
    const reorder = (text) => {
      const pattern = /(<sheet [^>]*name="History"[^>]*\/>)(<sheet [^>]*name="Current"[^>]*\/>)/;
      assert.match(text, pattern);
      return text.replace(pattern, '$2$1');
    };
    const reordered = writePatchedWorkbook(t, [['History', history], ['Current', current]], { 'xl/workbook.xml': reorder });
    assert.deepEqual(parseFile(reordered).parsed.records.map((record) => record.endBalance), [40], '关系可读时按关系读 Current');
    const tabbed = writePatchedWorkbook(t, [['History', history], ['Current', current]], {
      'xl/workbook.xml': reorder,
      'xl/_rels/workbook.xml.rels': (text) => {
        assert.match(text, /<Relationship Id=/);
        return text.replace(/<Relationship Id=/g, '<Relationship\tId=');
      }
    });
    const { scanXlsxFormulaCache } = require('../../../src/backend/file-service/readers');
    const workbook = XLSX.read(fs.readFileSync(tabbed), { type: 'buffer', bookFiles: true, sheets: 0 });
    assert.equal(workbook.SheetNames[0], 'Current');
    assert.equal(scanXlsxFormulaCache(workbook, 'Current'), null);
    const rejected = (error) => error.code === 'FILE_READ'
      && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    assert.throws(() => readBalanceSeedImportFile(tabbed), rejected, '制表符');
    // 属性的引号前有换行：本模块的属性读法能读出 Id，读取库把换行与引号算进值里、找不到关系，同样改按物理序号读表
    const newline = writePatchedWorkbook(t, [['History', history], ['Current', current]], {
      'xl/workbook.xml': reorder,
      'xl/_rels/workbook.xml.rels': (text) => text.replace(/<Relationship Id="/g, '<Relationship Id=\n"')
    });
    assert.throws(() => readBalanceSeedImportFile(newline), rejected, '换行');
    // 物理序号恰好就是关系指向的条目时读的是同一张表，但标签内用制表符分隔不在结构白名单内（W2），同样不导入
    const samePhysical = writePatchedWorkbook(t, [['Current', current], ['History', history]], {
      'xl/_rels/workbook.xml.rels': (text) => text.replace(/<Relationship Id=/g, '<Relationship\tId=')
    });
    assert.throws(() => readBalanceSeedImportFile(samePhysical), rejected, '同一张表');
    const plain = writePatchedWorkbook(t, [['Current', current], ['History', history]], {});
    assert.deepEqual(parseFile(plain).parsed.records.map((record) => record.endBalance), [40]);
  });

  test('真实 xlsx：自闭合的空行之后省略行号（读取库不推进行号，与 Excel 的坐标不同）时不导入；带行号时照常按坐标核对公式缓存', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', 30, '网银', '接口']
    ];
    // 第 2 行写成自闭合空行，第 3 行（A1 的 20）改为没有缓存值的公式
    const write = (keepRowNumbers) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => {
        const row = (number) => new RegExp(`<row r="${number}"[^>]*>(.*?)</row>`);
        const third = text.match(row(3));
        const fourth = text.match(row(4));
        assert.ok(third && fourth);
        const strip = (number, cells) => (keepRowNumbers ? `<row r="${number}">${cells}</row>` : `<row>${cells.replace(/ r="[A-Z]+\d+"/g, '')}</row>`);
        return text
          .replace(row(2), '<row r="2"/>')
          .replace(row(3), strip(3, third[1].replace(/<c r="F3"><v>20<\/v><\/c>/, '<c r="F3"><f>1/0</f></c>')))
          .replace(row(4), strip(4, fourth[1]));
      }
    });
    const { scanXlsxFormulaCache } = require('../../../src/backend/file-service/readers');
    // 省略行号：读取库把其后两行放在第 2、3 行（Excel 放在第 3、4 行），无法核对
    const omitted = write(false);
    assert.equal(scanXlsxFormulaCache(XLSX.read(fs.readFileSync(omitted), { type: 'buffer', bookFiles: true, sheets: 0, dense: true }), 'Balance'), null);
    assert.throws(() => parseFile(omitted), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
    const numbered = write(true);
    assert.deepEqual([...scanXlsxFormulaCache(XLSX.read(fs.readFileSync(numbered), { type: 'buffer', bookFiles: true, sheets: 0, dense: true }), 'Balance')
      .uncachedCells], ['2:5']);
    const { parsed } = parseFile(numbered);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.merchantId, record.endBalance, record.unreadableFields || null]), [
      [3, 'A1', null, { endBalance: '公式没有计算结果' }], [4, 'B2', 30, null]
    ]);
  });

  test('真实 xlsx：数组公式结果区域里的内联文本（inlineStr）算有缓存值，空白内联文本读不出；同列重叠 / 相邻的数组区域按合并后的区间核对', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', 30, '网银', '接口']
    ];
    const write = (dependent) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => [
        replaceCell('C3', '<c r="C3" t="str"><f t="array" ref="C3:C4">C2:C3</f><v>HK</v></c>'),
        replaceCell('C4', dependent)
      ].reduce((xml, patch) => patch(xml), text)
    });
    const cached = parseFile(write('<c r="C4" t="inlineStr"><is><r><t>H</t></r><r><t>K</t></r></is></c>')).parsed;
    assert.deepEqual(cached.records.map((record) => [record.rowNumber, record.location, record.unreadableFields || null]),
      [[2, 'HK', null], [3, 'HK', null], [4, 'HK', null]]);
    const blank = parseFile(write('<c r="C4" t="inlineStr"><is><t> </t><rPh><t>x</t></rPh></is></c>')).parsed;
    assert.deepEqual(blank.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]),
      [[4, { location: '公式没有计算结果' }]]);
    // 区间合并与二分查找：A2:A3 与 A3:A5 重叠、A6:A6 与之相邻、A9 单独；A7、A8 不在区域内
    const { scanXlsxFormulaCache } = require('../../../src/backend/file-service/readers');
    const column = Array.from({ length: 10 }, (_value, index) => [index + 1]);
    const ranges = { A2: 'A2:A3', A3: 'A3:A5', A6: 'A6', A9: 'A9:A9' };
    const filePath = writePatchedWorkbook(t, [['Balance', column]], {
      'xl/worksheets/sheet1.xml': (text) => Object.entries(ranges).reduce((xml, [address, ref]) => replaceCell(address,
        `<c r="${address}"><f t="array" ref="${ref}">1</f><v>1</v></c>`)(xml), text)
    });
    const cache = scanXlsxFormulaCache(XLSX.read(fs.readFileSync(filePath), { type: 'buffer', bookFiles: true, sheets: 0 }), 'Balance');
    assert.deepEqual([...cache.arrayCachedCells].sort(), ['1:0', '2:0', '3:0', '4:0', '5:0', '8:0']);
  });

  test('参考列读不出（没有缓存的布尔公式等）显示原因，不显示读取库读出的 FALSE；只有参考列有内容的残缺行计入跳过数', (t) => {
    const filePath = writeSheet(t, [
      header,
      ['', '', '', '', '', '', '网银', ''],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 11, '网银', '接口']
    ], (sheet) => {
      sheet.G3 = { t: 'b', v: false, f: 'TRUE()' };
    });
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 1, '第 2 行只有余额来源，不能归属账号');
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.balanceSource, record.unreadableFields || null]), [
      [3, '读不出（公式没有计算结果）', null], [4, '网银', null]
    ], '参考列读不出不阻止该行参与选择');
    const [account] = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), { bankName: 'DBS', location: 'HK' }).accounts;
    assert.deepEqual([account.source, account.choices.map((choice) => choice.balanceSource)], ['choice', ['读不出（公式没有计算结果）', '网银']]);
  });

  test('真实 xlsx：数组公式属性用单引号（读取库不认数组公式）时按原文的结果区域逐格核对缓存：缺失、空文本、只有空白的结果格都读不出', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', 0, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', 0, '网银', '接口']
    ];
    const dependents = {
      缺失: ['', '公式没有计算结果'],
      空文本: ["<c r='F4' t='str'/>", '公式没有计算结果'],
      // 没有公式的数值格 <v> 只有空白：读取库读成 NaN，不是规范写法，整个文件无法核对
      只有空白: ['<c r="F4"><v>  </v></c>', null]
    };
    for (const [label, [dependent, reason]] of Object.entries(dependents)) {
      const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
        'xl/worksheets/sheet1.xml': (text) => [
          replaceCell('F3', "<c r='F3'><f t='array' ref='F3:F4'>E3:E4*1</f><v>7</v></c>"),
          replaceCell('F4', dependent)
        ].reduce((xml, patch) => patch(xml), text)
      });
      if (!reason) {
        assert.throws(() => parseFile(filePath), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入', label);
        continue;
      }
      const { parsed } = parseFile(filePath);
      assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]),
        [[4, { endBalance: reason }]], label);
      const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2']), { bankName: 'DBS', location: 'HK' });
      assert.deepEqual(result.accounts.map((account) => [account.source, account.billDate, account.endBalance]),
        [['manual', '', null], ['file', '2026-11-20', 7]], `${label}：A1 不退回 11 月 19 日的余额`);
    }
  });

  test('真实 xlsx：公式缓存只有空白时读不出，不按无效行跳过后退回较早的余额；普通数值格的值不是完整的数字时整个文件无法核对', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', 0, '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'B2', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', 0, '网银', '接口']
    ];
    const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => replaceCell('F3', '<c r="F3"><f>E3*1</f><v>  </v></c>')(text)
    });
    const { parsed } = parseFile(filePath);
    assert.equal(parsed.skippedRowCount, 0);
    assert.deepEqual(parsed.records.filter((record) => record.unreadableFields).map((record) => [record.rowNumber, record.unreadableFields]),
      [[3, { endBalance: '公式没有计算结果' }]]);
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(result.accounts.map((account) => account.source), ['manual', 'file']);
    // 数值格的 <v> 只有空白（读取库读成 NaN）、或不是完整的数字（20,50 读取库按 parseFloat 读成 20）
    for (const value of [' ', '20,50', '20abc', '1.2.3']) {
      const patched = writePatchedWorkbook(t, [['Balance', rows]], {
        'xl/worksheets/sheet1.xml': (text) => replaceCell('F5', `<c r="F5"><v>${value}</v></c>`)(text)
      });
      assert.throws(() => parseFile(patched), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入', value);
    }
  });

  test('真实 xlsx：工作表数据不是规范写法（读取库与 Excel 读出的值可能不同）时整个文件无法核对，不把较早的余额当作最近一天的', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口']
    ];
    const plain = writePatchedWorkbook(t, [['Balance', rows]], {});
    assert.deepEqual(parseFile(plain).parsed.records.map((record) => [record.location, record.endBalance]), [['SG', 10], ['SG', 20]]);
    // <v xml:space="preserve">（首尾有空白的文本）照常导入
    const preserved = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace(/(<c r="G3"[^>]*>)<v>/, '$1<v xml:space="preserve">')
    });
    assert.deepEqual(parseFile(preserved).parsed.records.map((record) => [record.balanceSource, record.endBalance]), [['网银', 10], ['网银', 20]]);
    const patches = {
      // <c 后接换行：读取库整格漏读，开户地读成空
      '<c 后接换行': (text) => text.replace('<c r="C3"', '<c\nr="C3"'),
      '<c 后接制表符': (text) => text.replace('<c r="C3"', '<c\tr="C3"'),
      '<v> 带空格': (text) => text.replace(/(<c r="F3"[^>]*>)<v>/, '$1<v >'),
      '结束标签带空格': (text) => text.replace(/(<c r="F3"[^>]*><v>20<\/v>)<\/c>/, '$1</c >'),
      'CDATA': (text) => text.replace(/(<c r="F3"[^>]*>)<v>20<\/v>/, '$1<v><![CDATA[20]]></v>'),
      '非预定义实体': (text) => text.replace(/(<c r="C3"[^>]*><v>)SG/, '$1S&eacute;G'),
      '带前缀的 r 属性': (text) => text.replace('<c r="C3"', '<c x:r="C3" r="C3"'),
      '单元格引用与所在行不一致': (text) => text.replace('<c r="C3"', '<c r="C5"'),
      '列不递增': (text) => text.replace('<c r="C3"', '<c r="B3"'),
      '<v> 带其他属性': (text) => text.replace(/(<c r="F3"[^>]*>)<v>/, '$1<v x="1">'),
      '布尔不是 0 / 1': (text) => text.replace(/<c r="F3"[^>]*><v>20<\/v><\/c>/, '<c r="F3" t="b"><v>2</v></c>'),
      '两个 <v>': (text) => text.replace(/(<c r="F3"[^>]*>)<v>20<\/v>/, '$1<v>20</v><v>30</v>'),
      '<row> 里的文本': (text) => text.replace(/(<row r="3"[^>]*>)/, '$1x'),
      // 日期类型（t="d"）：读取库按本机时区换算 ISO 日期，与 Excel 的日期可能差一天
      't="d" 的日期格': replaceCell('A3', '<c r="A3" t="d"><v>2026-11-20</v></c>'),
      // 属性的 = 前后有空白：读取库按自己的口径取属性，可能漏读样式或类型
      '属性 = 前有空格': (text) => text.replace('<c r="C3"', '<c r ="C3"'),
      '属性 = 后有换行': (text) => text.replace('<c r="C3"', '<c r=\n"C3"')
    };
    for (const [label, patch] of Object.entries(patches)) {
      const filePath = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': (text) => {
        const patched = patch(text);
        assert.notEqual(patched, text, label);
        return patched;
      } });
      assert.throws(() => parseFile(filePath), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入', label);
    }
  });

  test('真实 xlsx：公式格的空缓存（<v/>）只让该账号改为手工录入，其他账号照常；文本里写 sheetData 不影响核对', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, 'sheetData', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '<sheetData>', '接口'],
      ['2026-11-19', 'DBS', 'SG', 'USD', 'B2', 30, '</sheetData>', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'B2', 40, '网银', '接口']
    ];
    const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': replaceCell('F3', '<c r="F3"><f>1+1</f><v/></c>')
    });
    const { parsed } = parseFile(filePath);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.balanceSource, record.unreadableFields || null]), [
      ['A1', 10, 'sheetData', null], ['A1', null, '<sheetData>', { endBalance: '公式没有计算结果' }],
      ['B2', 30, '</sheetData>', null], ['B2', 40, '网银', null]
    ]);
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2']), { bankName: 'DBS', location: 'SG' });
    assert.deepEqual(result.accounts.map((account) => [account.source, account.endBalance]), [['manual', null], ['file', 40]]);
  });

  test('真实 xlsx：共享字符串表的下标与读取库不一致（自闭合的 <si/> 使后面各项错位）时整个文件无法核对，不把余额归给另一个账号', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'ACC-A', 10, '网银', '接口'],
      ['2026-11-19', 'DBS', 'SG', 'USD', 'ACC-B', 20, '网银', '接口']
    ];
    // 共享字符串表写法正常时照常导入
    const plain = writePatchedWorkbook(t, [['Balance', rows]], {}, { bookSST: true });
    assert.deepEqual(parseFile(plain).parsed.records.map((record) => [record.merchantId, record.endBalance]), [['ACC-A', 10], ['ACC-B', 20]]);
    // 表头前插入 <si/>（末尾另加一项未用的，下标不越界），单元格下标整体加 1：Excel 读出的仍是原文，读取库读成后一项（ACC-A 的格读成 ACC-B）
    const shifted = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/sharedStrings.xml': (text) => text.replace(/(<sst\b[^>]*>)/, '$1<si/>').replace('</sst>', '<si><t>未用</t></si></sst>'),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/(<c r="[A-Z]+\d+" t="s"><v>)(\d+)(<\/v>)/g, (_match, open, index, close) => `${open}${Number(index) + 1}${close}`)
    }, { bookSST: true });
    assert.throws(() => parseFile(shifted), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
    // 共享字符串、内联文本中的字符引用读取库按 Excel 的口径解码，照常导入
    const referenced = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/sharedStrings.xml': (text) => text.replace('<t>SG</t>', '<t>&#83;&#x47;</t>').replace('<t>网银</t>', '<t>&#32593;&#38134;</t>')
    }, { bookSST: true });
    assert.deepEqual(parseFile(referenced).parsed.records.map((record) => [record.location, record.balanceSource]), [['SG', '网银'], ['SG', '网银']]);
  });

  test('真实 xlsx：文本格（str）中非 ASCII 的字符引用读取库解码成乱码时整个文件无法核对，不把较早的余额当作最近一天的', (t) => {
    const rows = [
      header,
      ['2026-11-19', '香港', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', '香港', 'HK', 'USD', 'A1', 20, '网银', '接口']
    ];
    const REJECTED = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const nonAscii = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': replaceCell('B3', '<c r="B3" t="str"><v>&#39321;&#28207;</v></c>') });
    assert.throws(() => parseFile(nonAscii), REJECTED);
    const escaped = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': replaceCell('B3', '<c r="B3" t="str"><v>_x9999__x6E2F_</v></c>') });
    assert.throws(() => parseFile(escaped), REJECTED);
    // ASCII 的字符引用、内联文本中的字符引用读取库解码正确，照常导入
    const asciiRows = rows.map((row, index) => (index ? ['2026-11-' + (18 + index), 'DBS', ...row.slice(2)] : row));
    const ascii = writePatchedWorkbook(t, [['Balance', asciiRows]], { 'xl/worksheets/sheet1.xml': replaceCell('B3', '<c r="B3" t="str"><v>&#68;B&#x53;</v></c>') });
    assert.deepEqual(parseFile(ascii).parsed.records.map((record) => [record.bankName, record.endBalance]), [['DBS', 10], ['DBS', 20]]);
    const inline = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': replaceCell('B3', '<c r="B3" t="inlineStr"><is><t>&#39321;&#28207;</t><rPh sb="0" eb="1"><t>ほん</t></rPh></is></c>')
    });
    assert.deepEqual(parseFile(inline).parsed.records.map((record) => [record.bankName, record.endBalance]), [['香港', 10], ['香港', 20]]);
    // 内联文本同时有直接的 <t> 与 <r>：Excel 的取值不明确，无法核对
    const mixed = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': replaceCell('B3', '<c r="B3" t="inlineStr"><is><t>香</t><r><t>港</t></r></is></c>') });
    assert.throws(() => parseFile(mixed), REJECTED);
  });

  test('真实 xlsx：远端带样式的空白格（XFD1）不把转换的行撑到 16384 列；数值格带正号、布尔格写作 true 照常取值', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口']
    ];
    const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => {
        const patched = text.replace(/(<row r="1"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="XFD1"/>$2').replace(/(<c r="F2"[^>]*>)<v>10<\/v>/, '$1<v>+10</v>')
          .replace(/<c r="G2"[^>]*>.*?<\/c>/, '<c r="G2" t="b"><v>true</v></c>');
        assert.notEqual(patched, text);
        return patched;
      }
    });
    const { file, parsed } = parseFile(filePath);
    assert.equal(Math.max(...file.rows.map((row) => row.length)), header.length);
    assert.equal(Math.max(...file.displayRows.map((row) => row.length)), header.length);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.balanceSource]), [['A1', 10, 'TRUE']]);
    // 声明范围从 A 列开始、内容从 C 列开始：读不出原值的单元格按收窄后的列对应（期末余额的错误值不记到其他列）
    const shiftedRows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口']
    ].map((row) => ['', '', ...row]);
    const offset = writePatchedWorkbook(t, [['Balance', shiftedRows]], {
      'xl/worksheets/sheet1.xml': (text) => {
        const patched = text.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:J3"/>').replace(/<c r="H3"[^>]*>.*?<\/c>/, '<c r="H3" t="e"><v>#N/A</v></c>');
        assert.notEqual(patched, text);
        return patched;
      }
    });
    assert.deepEqual(parseFile(offset).parsed.records.map((record) => [record.billDate, record.endBalance, record.unreadableFields || null]),
      [['2026-11-19', 10, null], ['2026-11-20', null, { endBalance: 'Excel 错误值 #N/A' }]]);
  });

  test('真实 xlsx：开户地、银行名、币种存成常规格式的数字时按读不出，不排除该行后退回较早的余额；带数字格式（000 把 1 显示为 001）时整个文件不导入（W3）', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', '001', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 1, 'USD', 'A1', 20, '网银', '接口']
    ];
    const write = (format) => {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      if (format) sheet.C3.z = format;
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
      const filePath = path.join(tempDir(t), '日终余额.xlsx');
      XLSX.writeFile(workbook, filePath);
      return filePath;
    };
    assert.throws(() => parseFile(write('000')), (error) => error.code === 'FILE_READ'
      && error.message === '余额文件中开户地显示的内容可能与原值不同（单元格的数字格式或条件格式），无法确认余额属于哪个账号，请把开户地改为常规或文本格式后重新导入');
    const NOT_TEXT = '单元格不是文本，无法确认显示的内容';
    const { parsed } = parseFile(write(null));
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.location, record.unreadableFields || null]), [
      ['A1', '001', null], ['A1', '1', { location: NOT_TEXT }]
    ]);
    const [account] = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), { bankName: 'DBS', location: '001' }).accounts;
    assert.deepEqual([account.source, account.endBalance], ['manual', null]);
    assert.ok(account.reason.includes(`开户地读不出（${NOT_TEXT}）`), account.reason);
    // 银行名、币种存成数字同样按读不出
    const numericIdentity = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'C3', 10, '网银', '接口'],
      ['2026-11-20', 7, 'SG', 'USD', 'C3', 20, '网银', '接口'],
      ['2026-11-19', 'DBS', 'SG', 'USD', 'D4', 30, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 840, 'D4', 40, '网银', '接口']
    ]]], {});
    const identityParsed = parseFile(numericIdentity).parsed;
    assert.deepEqual(identityParsed.records.map((record) => record.unreadableFields || null), [
      null, { bankName: NOT_TEXT }, null, { currency: NOT_TEXT }
    ]);
    assert.deepEqual(matchBalanceSeedImport(identityParsed.records, pendingOf(['C3', 'D4']), { bankName: 'DBS', location: 'SG' }).accounts
      .map((account) => [account.source, account.endBalance]), [['manual', null], ['manual', null]]);
  });

  test('真实 xlsx：只转换有内容的列（中间的空列不展开）；共享字符串类型公式的空缓存只让该格读不出；带空白的布尔值无法核对', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'B2', 40, '网银', '接口']
    ];
    // 范围外 XFD1 的备注：只多转换这一列
    const sparse = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace(/(<row r="1"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="XFD1" t="str"><v>备注</v></c>$2')
    });
    const { file, parsed } = parseFile(sparse);
    assert.equal(Math.max(...file.rows.map((row) => row.length)), header.length + 1);
    assert.equal(Math.max(...file.displayRows.map((row) => row.length)), header.length + 1);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance]), [['A1', 10], ['A1', 20], ['B2', 40]]);
    // 共享字符串类型的公式没有缓存值（<v/>）：只有该格读不出，其他账号照常
    const uncached = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': replaceCell('F3', '<c r="F3" t="s"><f>"x"</f><v/></c>') });
    const uncachedParsed = parseFile(uncached).parsed;
    assert.deepEqual(uncachedParsed.records.map((record) => [record.merchantId, record.endBalance, record.unreadableFields || null]), [
      ['A1', 10, null], ['A1', null, { endBalance: '公式没有计算结果' }], ['B2', 40, null]
    ]);
    assert.deepEqual(matchBalanceSeedImport(uncachedParsed.records, pendingOf(['A1', 'B2']), { bankName: 'DBS', location: 'SG' }).accounts
      .map((account) => [account.source, account.endBalance]), [['manual', null], ['file', 40]]);
    // 布尔值带空白：读取库读成 FALSE，与原值相反，无法核对
    const spaced = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': replaceCell('G2', '<c r="G2" t="b"><v> 1 </v></c>') });
    assert.throws(() => parseFile(spaced), (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入');
  });

  test('真实 xlsx：共享公式从属格的缓存写成字符引用的空格（&#32;）时只让该格读不出，不当作空开户地采用余额', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', '', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', '', 'USD', 'A1', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', '', 'USD', 'B2', 40, '网银', '接口']
    ];
    const sharedBlank = (space) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => {
        const master = replaceCell('C2', '<c r="C2" t="str"><f t="shared" ref="C2:C3" si="0">TRIM(" ")</f><v></v></c>')(text);
        // 从属格写成空的 <f></f> 时读取库不给公式，只读到缓存的空格
        return replaceCell('C3', `<c r="C3" t="str"><f t="shared" si="0"></f><v>${space}</v></c>`)(master);
      }
    });
    for (const space of [' ', '&#32;', '_x0020_']) {
      const { parsed } = parseFile(sharedBlank(space));
      assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.unreadableFields || null]), [
        ['A1', 10, { location: '公式没有计算结果' }], ['A1', 20, { location: '公式没有计算结果' }], ['B2', 40, null]
      ], space);
      assert.deepEqual(matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2']), NO_LOCATION_GROUP).accounts
        .map((account) => [account.source, account.endBalance]), [['manual', null], ['file', 40]], space);
    }
  });

  test('真实 xlsx：横跨整行的合并标题（A1:XFD1，XFD1 有空白占位）不把转换的行撑到 16384 列', (t) => {
    const filePath = writePatchedWorkbook(t, [['Balance', [
      ['银行原始日终余额信息'],
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口']
    ]]], {
      'xl/worksheets/sheet1.xml': (text) => text
        .replace(/(<row r="1"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="XFD1" s="0"/>$2')
        .replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1"/></mergeCells>')
    });
    const { file, parsed } = parseFile(filePath);
    assert.equal(Math.max(...file.rows.map((row) => row.length)), header.length);
    assert.equal(Math.max(...file.displayRows.map((row) => row.length)), header.length);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.unreadableFields || null]), [['A1', 10, null]]);
  });

  test('带数字格式的条件格式覆盖银行账户号、开户地时整个文件不导入（W3）；样式表有注释、不是 UTF-8 时无法核对；只改颜色或只覆盖其他列时照常导入', (t) => {
    const REJECTED = (error) => error.code === 'FILE_READ' && error.message === '余额文件中银行账户号显示的内容可能与原值不同'
      + '（单元格的数字格式或条件格式），无法确认属于哪个账号，请把银行账户号改为常规或文本格式后重新导入';
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', '001', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 1, 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'B2', 40, '网银', '接口']
    ];
    const zeroPadded = '<numFmt numFmtId="164" formatCode="000"/>';
    const withConditional = (sqref, dxfs = `<dxfs count="1"><dxf>${zeroPadded}</dxf></dxfs>`) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        `</sheetData><conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>`),
      'xl/styles.xml': () => stylesXml({ dxfs })
    });
    // 恒真条件把数字账号 1 显示为 001：Excel 中看到的是 001，读取库给 1；文本账号同样可能被条件格式的文本段改变显示
    assert.throws(() => parseFile(withConditional('E3')), REJECTED);
    assert.throws(() => parseFile(withConditional('E2')), REJECTED);
    assert.throws(() => parseFile(withConditional('A1:H10')), REJECTED);
    // 覆盖开户地：同样无法确认余额属于哪个开户地，整个文件不导入
    assert.throws(() => parseFile(withConditional('C3')), (error) => error.code === 'FILE_READ' && /开户地显示的内容可能与原值不同/.test(error.message));
    // 只覆盖期末余额列、或只改颜色：照常导入
    assert.deepEqual(parseFile(withConditional('F2:F4')).parsed.records.map((record) => [record.merchantId, record.endBalance]),
      [['001', 10], ['1', 20], ['B2', 40]]);
    const colorOnly = parseFile(withConditional('E3', '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFF0000"/></patternFill></fill></dxf></dxfs>')).parsed;
    assert.deepEqual(colorOnly.records.map((record) => record.merchantId), ['001', '1', 'B2']);
    // 样式表有注释（注释里的 <dxf/> 会让序号错位）、样式表是 UTF-16：不在结构白名单内（W2），无法核对
    assert.throws(() => parseFile(withConditional('E3', `<dxfs count="1"><!-- <dxf/> --><dxf>${zeroPadded}</dxf></dxfs>`)), REJECTED_SHEET);
    const utf16 = withConditional('E3');
    const cfb = XLSX.CFB.read(fs.readFileSync(utf16), { type: 'buffer' });
    const styles = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/styles.xml'))];
    const stylesText = Buffer.from(styles.content).toString('utf8').replace('encoding="UTF-8"', 'encoding="UTF-16"');
    styles.content = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(stylesText, 'utf16le')]);
    styles.size = styles.content.length;
    fs.writeFileSync(utf16, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
    assert.throws(() => parseFile(utf16), REJECTED_SHEET);
  });

  test('真实 xlsx：文本格的数字格式带文本段（0;0;0;"HK"@ 把 1 显示为 HK1）、或继承行 / 列样式、命名样式、纵向合并的首格时整个文件不导入（W3）', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'HK1', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', '1', 'USD', 'A1', 20, '网银', '接口']
    ];
    const REJECTED_LOCATION = (error) => error.code === 'FILE_READ' && /开户地显示的内容可能与原值不同/.test(error.message);
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const withFormat = (sheetPatch, styles = TEXT_SECTION_STYLES) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml(styles),
      'xl/worksheets/sheet1.xml': sheetPatch
    });
    const cases = [
      // 单元格自身的样式：读取库给出显示文本 HK1，与原值 1 不同
      ['own', (text) => text.replace(/<c r="C3"/, '<c r="C3" s="1"')],
      // 行样式（customFormat）：读取库不按行样式给显示文本（其他身份列带自身的常规样式，不继承）
      ['row', (text) => ['B3', 'D3', 'E3'].reduce((patched, ref) => patched.replace(`<c r="${ref}"`, `<c r="${ref}" s="0"`),
        text.replace(/<row r="3"/, '<row r="3" s="1" customFormat="1"'))],
      // 列样式
      ['column', (text) => text.replace('<sheetData>', '<cols><col min="3" max="3" width="9" style="1"/></cols><sheetData>')]
    ];
    for (const [name, patch] of cases) assert.throws(() => parseFile(withFormat(patch)), REJECTED_LOCATION, name);
    // 账号格继承行样式
    assert.throws(() => parseFile(withFormat((text) => text.replace(/<row r="3"/, '<row r="3" s="1" customFormat="1"'))), REJECTED_ACCOUNT);
    // 命名样式（cellStyleXfs）带文本段：单元格样式自身是常规格式，读取库按常规给显示文本 1
    assert.throws(() => parseFile(withFormat((text) => text.replace(/<c r="C3"/, '<c r="C3" s="1"'), {
      numFmts: TEXT_SECTION_STYLES.numFmts,
      cellStyleXfs: ['<xf numFmtId="170" fontId="0" fillId="0" borderId="0"/>'],
      cellXfs: ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="1"/>']
    })), REJECTED_LOCATION);
    // 纵向合并的开户地：Excel 显示首格（继承行样式，显示为 HK1），被遮住的行按首格一并核对
    const merged = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-20', 'DBS', '1', 'USD', 'A1', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', '', 'USD', 'B2', 40, '网银', '接口']
    ]]], {
      'xl/styles.xml': () => stylesXml(TEXT_SECTION_STYLES),
      'xl/worksheets/sheet1.xml': (text) => ['B2', 'D2', 'E2'].reduce((patched, ref) => patched.replace(`<c r="${ref}"`, `<c r="${ref}" s="0"`),
        text.replace(/<row r="2"/, '<row r="2" s="1" customFormat="1"'))
        .replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="C2:C3"/></mergeCells>')
    });
    assert.throws(() => parseFile(merged), REJECTED_LOCATION);
  });

  test('真实 xlsx：工作表、共享字符串里绑定到别的命名空间的同名元素（mc:Ignorable 的 <aux:v> / <aux:t>）不当作单元格的值，整个文件无法核对', (t) => {
    const REJECTED = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口']
    ];
    const ignorable = (text) => text.replace(/<worksheet /, '<worksheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aux="urn:aux" mc:Ignorable="aux" ');
    // 期末余额格只有扩展元素 <aux:v>：Excel 忽略它（没有余额），读取库读成 456
    const auxValue = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => replaceCell('F3', '<c r="F3"><aux:v>456</aux:v></c>')(ignorable(text))
    });
    assert.throws(() => parseFile(auxValue), REJECTED);
    // 共享字符串项里的 <aux:t>
    const auxText = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/sharedStrings.xml': (text) => text
        .replace(/<sst /, '<sst xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aux="urn:aux" mc:Ignorable="aux" ')
        .replace('<si><t>SG</t></si>', '<si><aux:t>SG</aux:t></si>')
    }, { bookSST: true });
    assert.throws(() => parseFile(auxText), REJECTED);
    // 共享字符串的 <t> 上改绑默认命名空间：Excel 不读这段文本，读取库照读
    const reboundText = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/sharedStrings.xml': (text) => text.replace('<si><t>SG</t></si>', '<si><t xmlns="urn:other">SG</t></si>')
    }, { bookSST: true });
    assert.throws(() => parseFile(reboundText), REJECTED);
    // 根元素没有把默认命名空间绑定到 SpreadsheetML：不带前缀的行、单元格不在主命名空间
    const unbound = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', '<worksheet xmlns="urn:other"')
    });
    assert.throws(() => parseFile(unbound), REJECTED);
    // 行上改绑默认命名空间：这一行的单元格不在主命名空间（Excel 不读），读取库照读
    const reboundRow = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<row r="3"/, '<row r="3" xmlns="urn:other"')
    });
    assert.throws(() => parseFile(reboundRow), REJECTED);
    // 只有声明、没有使用扩展元素时照常导入
    const declaredOnly = writePatchedWorkbook(t, [['Balance', rows]], { 'xl/worksheets/sheet1.xml': ignorable });
    assert.deepEqual(parseFile(declaredOnly).parsed.records.map((record) => [record.merchantId, record.endBalance]), [['A1', 10], ['A1', 20]]);
  });

  test('真实 xlsx：属性值写成字符引用（customFormat="&#49;"、dxfId="&#48;"、numFmtId="&#49;&#55;&#48;"）、两份 <numFmts> 时整个文件无法核对；dxf 里同号的 numFmt 不覆盖单元格格式', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'HK1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', '1', 20, '网银', '接口']
    ];
    // 行样式的 customFormat 写成 &#49;（即 1）：工作表的属性不按原文比较，无法核对
    const rowStyle = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml(TEXT_SECTION_STYLES),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<row r="3"/, '<row r="3" s="1" customFormat="&#49;"')
    });
    assert.throws(() => parseFile(rowStyle), REJECTED_SHEET);
    // 条件格式的 dxfId 写成 &#48;（即 0）：按带数字格式处理
    const conditional = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ dxfs: '<dxfs count="1"><dxf><numFmt numFmtId="171" formatCode="0;0;0;&quot;HK&quot;@"/></dxf></dxfs>' }),
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        '</sheetData><conditionalFormatting sqref="E3"><cfRule type="expression" dxfId="&#48;" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>')
    });
    assert.throws(() => parseFile(conditional), REJECTED_SHEET);
    // 样式表的格式编号写成字符引用：属性里的字符引用不在结构白名单内（W2）
    const encodedId = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ numFmts: TEXT_SECTION_STYLES.numFmts, cellXfs: [formattedXf('&#49;&#55;&#48;')] }),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"')
    });
    assert.throws(() => parseFile(encodedId), REJECTED_SHEET);
    // 差异格式（dxf）里同号的 numFmt 不覆盖单元格的格式（170 仍是带文本段的格式）
    const dxfOverride = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ ...TEXT_SECTION_STYLES, dxfs: '<dxfs count="1"><dxf><numFmt numFmtId="170" formatCode="General"/></dxf></dxfs>' }),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<row r="3"/, '<row r="3" s="1" customFormat="1"').replace(/<c r="A3"/, '<c r="A3" s="0"')
    });
    assert.throws(() => parseFile(dxfOverride), REJECTED_ACCOUNT);
    // 样式表里有两份 <numFmts>（同号格式定义不同）：取哪一份无法确认，不在结构白名单内
    const twoNumFmts = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ numFmts: [[170, '0']], cellXfs: [formattedXf(170)] })
        .replace('</numFmts>', '</numFmts><numFmts count="1"><numFmt numFmtId="170" formatCode="0;0;0;&quot;HK&quot;@"/></numFmts>'),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"')
    });
    assert.throws(() => parseFile(twoNumFmts), REJECTED_SHEET);
  });

  test('真实 xlsx：扩展命名空间里的同名合并元素（<extra:mergeCell>）、读取库读出的合并范围不在工作表实际的合并范围中时整个文件无法核对', (t) => {
    const REJECTED = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'B2', 20, '网银', '接口']
    ];
    const extensionMerge = '<extLst><ext uri="{00000000-0000-0000-0000-000000000001}" xmlns:extra="urn:extra">'
      + '<extra:mergeCells count="1"><extra:mergeCell ref="E2:E3"/></extra:mergeCells></ext></extLst>';
    // 只有扩展元数据里的同名元素：Excel 的两个账号格并未合并；扩展里只允许条件格式等几种元素（W2），不导入
    const extensionOnly = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('</worksheet>', `${extensionMerge}</worksheet>`)
    });
    assert.throws(() => parseFile(extensionOnly), REJECTED);
    // 没有扩展元素时照常导入
    assert.deepEqual(parseFile(writePatchedWorkbook(t, [['Balance', rows]], {})).parsed.records.map((record) => [record.merchantId, record.endBalance]),
      [['A1', 10], ['B2', 20]]);
    // 读取库把单字符前缀（或扩展列表里不带前缀）的同名元素读成合并范围（第 3 行的账号会改取 A1）：无法核对
    for (const extension of ['<e:mergeCell ref="E2:E3"/>', '<mergeCell ref="E2:E3"/>']) {
      const readerMerge = writePatchedWorkbook(t, [['Balance', rows]], {
        'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="H2:H3"/></mergeCells>')
          .replace('</worksheet>', `<extLst><ext uri="{00000000-0000-0000-0000-000000000001}" xmlns:e="urn:extra">${extension}</ext></extLst></worksheet>`)
      });
      assert.throws(() => parseFile(readerMerge), REJECTED, extension);
    }
    // 主命名空间的合并范围不在 <worksheet> 的直接子元素 <mergeCells> 下（如 mc:AlternateContent 内）：Excel 是否采用无法确认
    const alternate = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
        + '<mc:Choice Requires="x14"><mergeCells count="1"><mergeCell ref="E2:E3"/></mergeCells></mc:Choice></mc:AlternateContent>')
    });
    assert.throws(() => parseFile(alternate), REJECTED);
    // 主命名空间的 <mergeCell> 放在声明为 mc:Ignorable 的扩展元素里（父元素不是 <mergeCells>）：Excel 忽略整个扩展元素，读取库照读
    const ignorableParent = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text
        .replace(/<worksheet /, '<worksheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:extra="urn:extra" mc:Ignorable="extra" ')
        .replace('</sheetData>', '</sheetData><extra:foo><mergeCell ref="E2:E3"/></extra:foo>')
    });
    assert.throws(() => parseFile(ignorableParent), REJECTED);
  });

  test('真实 xlsx：条件格式、列样式按 XML 元素识别（结束标签带空白、自闭合的块不漏读），差异格式表里没有的 dxfId 按带数字格式处理', (t) => {
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 1, 20, '网银', '接口']
    ];
    const zeroPadded = '<dxfs count="1"><dxf><numFmt numFmtId="171" formatCode="000"/></dxf></dxfs>';
    const rule = '<cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule>';
    const withSheetTail = (tailXml, dxfs = zeroPadded) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ dxfs }),
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', `</sheetData>${tailXml}`)
    });
    // 结束标签带空白（合法 XML）：E3 的 1 显示为 001
    assert.throws(() => parseFile(withSheetTail(`<conditionalFormatting sqref="E3">${rule}</conditionalFormatting >`)), REJECTED_ACCOUNT);
    // 前面有一个自闭合的块：不吞掉后面的块
    assert.throws(() => parseFile(withSheetTail(`<conditionalFormatting sqref="A1"/><conditionalFormatting sqref="E3">${rule}</conditionalFormatting>`)), REJECTED_ACCOUNT);
    // 条件格式块不在 sheetData 之后（位置不合规，Excel 是否采用无法确认）：按整张表处理
    const misplaced = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml({ dxfs: zeroPadded }),
      'xl/worksheets/sheet1.xml': (text) => text.replace('<sheetData>', `<conditionalFormatting sqref="E3">${rule}</conditionalFormatting><sheetData>`)
    });
    assert.throws(() => parseFile(misplaced), REJECTED_ACCOUNT);
    // dxfId 指向差异格式表里没有的项
    assert.throws(() => parseFile(withSheetTail(`<conditionalFormatting sqref="E3">${rule}</conditionalFormatting>`, '<dxfs count="0"/>')), REJECTED_ACCOUNT);
    // 列样式块的结束标签带空白：E 列的样式 1 是带文本段的格式（文本 1 显示为 HK1）
    const textRows = [header, ['2026-11-19', 'DBS', 'SG', 'USD', 'HK1', 10, '网银', '接口'], ['2026-11-20', 'DBS', 'SG', 'USD', '1', 20, '网银', '接口']];
    const columnStyle = writePatchedWorkbook(t, [['Balance', textRows]], {
      'xl/styles.xml': () => stylesXml(TEXT_SECTION_STYLES),
      'xl/worksheets/sheet1.xml': (text) => text.replace('<sheetData>', '<cols><col min="5" max="5" width="12" style="1" customWidth="1"/></cols ><sheetData>')
    });
    assert.throws(() => parseFile(columnStyle), REJECTED_ACCOUNT);
  });

  test('真实 xlsx：工作簿没有样式表部件（可选部件）时按常规格式照常导入；单元格引用不存在的样式时按可能改变显示处理', (t) => {
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口']
    ];
    const withoutStyles = (sheetPatch) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': null,
      'xl/_rels/workbook.xml.rels': (text) => text.replace(/<Relationship [^>]*Type="[^"]*\/styles"[^>]*\/>/, ''),
      '[Content_Types].xml': (text) => text.replace(/<Override PartName="\/xl\/styles\.xml"[^>]*\/>/, ''),
      'xl/worksheets/sheet1.xml': (text) => sheetPatch(text.replace(/ s="\d+"/g, ''))
    });
    assert.deepEqual(parseFile(withoutStyles((text) => text)).parsed.records.map((record) => [record.merchantId, record.endBalance]), [['A1', 10], ['A1', 20]]);
    assert.throws(() => parseFile(withoutStyles((text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"'))), REJECTED_ACCOUNT);
  });

  test('真实 xlsx：样式表里扩展命名空间的 <extra:dxf/>、<extra:xf/>（会让序号错位）整个文件无法核对；扩展列表里的扩展元素照常导入', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const withExtension = (styles) => styles.replace('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:extra="urn:extra" mc:Ignorable="extra">');
    // 条件格式 dxfId="0" 指向第一个真正的 <dxf>（把数字 1 显示为 001），前面插入的 <extra:dxf/> 曾使它被登记为序号 1
    const dxfShift = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 1, 20, '网银', '接口']
    ]]], {
      'xl/styles.xml': () => withExtension(stylesXml({ dxfs: '<dxfs count="1"><extra:dxf/><dxf><numFmt numFmtId="171" formatCode="000"/></dxf></dxfs>' })),
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        '</sheetData><conditionalFormatting sqref="E3"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>')
    });
    assert.throws(() => parseFile(dxfShift), REJECTED_SHEET);
    // 样式 1 是带文本段的格式（文本 1 显示为 HK1），前面插入的 <extra:xf/> 曾使它取成常规格式
    const xfShift = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'HK1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', '1', 20, '网银', '接口']
    ]]], {
      'xl/styles.xml': () => withExtension(stylesXml({ numFmts: TEXT_SECTION_STYLES.numFmts, cellXfs: ['<extra:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', formattedXf(170)] })),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"')
    });
    assert.throws(() => parseFile(xfShift), REJECTED_SHEET);
    // 样式里扩展列表（<extLst>）中的扩展元素与命名空间声明（新版 Excel 会写）不影响编号，照常导入
    const xfExtension = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口']
    ]]], {
      'xl/styles.xml': () => stylesXml({ cellXfs: ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><extLst><ext uri="{C7286773-470A-42A8-94C5-96B5CB345126}" '
        + 'xmlns:xfpb="http://schemas.microsoft.com/office/spreadsheetml/2022/featurepropertybag"><xfpb:xfComplement i="0"/></ext></extLst></xf>'] }),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"')
    });
    assert.deepEqual(parseFile(xfExtension).parsed.records.map((record) => [record.merchantId, record.endBalance]), [['A1', 10], ['A1', 20]]);
  });

  test('真实 xlsx：参考列（余额来源、余额获取方式）被带数字格式的条件格式覆盖时显示读不出，不显示读取库的原值，两笔余额照常供选择', (t) => {
    const filePath = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, 1, '接口'],
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 20, 2, '接口']
    ]]], {
      'xl/styles.xml': () => stylesXml({ dxfs: '<dxfs count="1"><dxf><numFmt numFmtId="171" formatCode="[=1]&quot;网银&quot;;&quot;人工&quot;"/></dxf></dxfs>' }),
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        '</sheetData><conditionalFormatting sqref="G2:G3"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>')
    });
    const unreadable = '读不出（单元格的数字格式或条件格式可能改变显示的内容，无法确认）';
    assert.deepEqual(parseFile(filePath).parsed.records.map((record) => [record.merchantId, record.endBalance, record.balanceSource, record.balanceMethod]),
      [['A1', 10, unreadable, '接口'], ['A1', 20, unreadable, '接口']]);
  });

  test('真实 xlsx：纵向合并的账号只按首格核对显示格式（被遮住的格残留的格式不影响显示），两行照常取首格的账号', (t) => {
    const filePath = writePatchedWorkbook(t, [['Balance', [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', '', 20, '网银', '接口']
    ]]], {
      'xl/styles.xml': () => stylesXml({ numFmts: [[170, '000000']], cellXfs: [formattedXf(170)] }),
      'xl/worksheets/sheet1.xml': (text) => replaceCell('E3', '<c r="E3" s="1"/>')(text)
        .replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="E2:E3"/></mergeCells>')
    });
    assert.deepEqual(parseFile(filePath).parsed.records.map((record) => [record.merchantId, record.billDate, record.endBalance]),
      [['A1', '2026-11-19', 10], ['A1', '2026-11-20', 20]]);
  });

  test('真实 xlsx：工作表声明的范围（dimension）没有包含后面的行时，按实际有单元格的范围读取，不漏掉最近一天的余额', (t) => {
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 20, '网银', '接口'],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'A1', 21, '网银', '接口']
    ];
    const filePath = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => {
        assert.match(text, /<dimension ref="A1:H4"\/>/);
        return text.replace('<dimension ref="A1:H4"/>', '<dimension ref="A1:F2"/>');
      }
    });
    const { file, parsed } = parseFile(filePath);
    assert.deepEqual(file.rowNumbers, [1, 2, 3, 4]);
    assert.deepEqual(parsed.records.map((record) => [record.billDate, record.endBalance, record.balanceSource]),
      [['2026-11-19', 10, '网银'], ['2026-11-20', 20, '网银'], ['2026-11-20', 21, '网银']]);
    const [account] = matchBalanceSeedImport(parsed.records, pendingOf(['A1']), { bankName: 'DBS', location: 'SG' }).accounts;
    assert.deepEqual([account.source, account.billDate, account.choices.map((choice) => choice.endBalance)], ['choice', '2026-11-20', [20, 21]]);
  });

  test('期末余额文本带逗号时只接受千分位分组正确的写法；12,34 等（可能是十进制逗号）读不出，不放大、不退回较早的余额', (t) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      header,
      ['2026-11-19', 'DBS', 'HK', 'USD', 'A1', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'A1', '12;34', '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'B2', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'B2', '12,34', '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'C3', '1,234.50', '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'D4', '-1,234,567', '网银', '接口'],
      ['2026-11-19', 'DBS', 'HK', 'USD', 'E5', 10, '网银', '接口'],
      ['2026-11-20', 'DBS', 'HK', 'USD', 'E5', '1,23,456', '网银', '接口']
    ]), 'S');
    const xlsxPath = path.join(tempDir(t), '余额.xlsx');
    XLSX.writeFile(workbook, xlsxPath);
    const { parsed } = parseFile(xlsxPath);
    assert.deepEqual(parsed.records.map((record) => [record.merchantId, record.endBalance, record.unreadableFields || null]), [
      ['A1', 10, null], ['A1', null, { endBalance: '无法识别为金额' }], ['B2', 10, null], ['B2', null, { endBalance: '无法识别为金额' }],
      ['C3', 1234.5, null], ['D4', -1234567, null], ['E5', 10, null], ['E5', null, { endBalance: '无法识别为金额' }]
    ]);
    const result = matchBalanceSeedImport(parsed.records, pendingOf(['A1', 'B2', 'C3', 'D4', 'E5']), { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(result.accounts.map((account) => [account.source, account.endBalance]),
      [['manual', null], ['manual', null], ['file', 1234.5], ['file', -1234567], ['manual', null]]);
  });

  test('表头扫描：只有读不出的单元格（如错误值）的行也占前 10 个非空行的名额', (t) => {
    const NA = { t: 'e', v: 0x2A };
    const aoa = Array.from({ length: 10 }, () => [NA]).concat([header, ['2026-11-02', 'DBS', 'HK', 'USD', 'A1', 1, '', '']]);
    assert.throws(() => parseFile(writeSheet(t, aoa)), (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING');
    assert.equal(parseFile(writeSheet(t, aoa.slice(1))).parsed.records.length, 1, '第 10 个非空行是表头时照常识别');
    // 只有没有计算结果的公式的行同样占名额（读取时删除占位单元格，按标记计入）
    const formulaRows = writeSheet(t, Array.from({ length: 10 }, () => ['']).concat([header, ['2026-11-02', 'DBS', 'HK', 'USD', 'A1', 1, '', '']]),
      (sheet) => {
        for (let r = 1; r <= 10; r += 1) sheet[`A${r}`] = { t: 'n', f: '1+1' };
      });
    assert.throws(() => parseFile(formulaRows), (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING');
  });

  test('只读取一次文件字节：原值、显示文本与日期系统都来自这一份字节', (t) => {
    const dir = tempDir(t);
    const sheet = XLSX.utils.aoa_to_sheet([header, ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 11, '来源 A', ''],
      ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 22, '来源 B', '']]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
    const xlsxPath = path.join(dir, '日终余额.xlsx');
    XLSX.writeFile(workbook, xlsxPath);
    const access = [];
    const originals = { readFile: XLSX.readFile, readFileSync: fs.readFileSync, openSync: fs.openSync };
    t.after(() => { XLSX.readFile = originals.readFile; fs.readFileSync = originals.readFileSync; fs.openSync = originals.openSync; });
    XLSX.readFile = (...args) => { access.push('XLSX.readFile'); return originals.readFile.apply(XLSX, args); };
    // fs.readFileSync 内部自己会打开一次文件，只记它之外的打开
    let insideReadFileSync = false;
    fs.readFileSync = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith(dir)) access.push('fs.readFileSync');
      insideReadFileSync = true;
      try { return originals.readFileSync.apply(fs, args); } finally { insideReadFileSync = false; }
    };
    fs.openSync = (...args) => {
      if (!insideReadFileSync && typeof args[0] === 'string' && args[0].startsWith(dir)) access.push('fs.openSync');
      return originals.openSync.apply(fs, args);
    };
    const { file, parsed } = parseFile(xlsxPath);
    assert.deepEqual(access, ['fs.readFileSync'], '只读一次文件');
    assert.deepEqual([file.date1904, Array.isArray(file.displayRows)], [false, true]);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.endBalance, record.balanceSource]), [[2, 11, '来源 A'], [3, 22, '来源 B']]);
  });

  test('有效范围延伸到大量空行时只转换有内容的行；只有表头以外全空的文件按空文件报错', (t) => {
    const dir = tempDir(t);
    const sheet = XLSX.utils.aoa_to_sheet([header, ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 11, '', '']]);
    sheet['!ref'] = 'A1:H200000';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
    const filePath = path.join(dir, '日终余额.xlsx');
    XLSX.writeFile(workbook, filePath);
    const { file, parsed } = parseFile(filePath);
    assert.deepEqual([file.rows.length, file.displayRows.length, file.rowNumbers], [2, 2, [1, 2]]);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.endBalance]), [[2, 11]]);

    const emptyPath = path.join(dir, '空.xlsx');
    const emptyBook = XLSX.utils.book_new();
    const emptySheet = XLSX.utils.aoa_to_sheet([[]]);
    emptySheet['!ref'] = 'A1:H100';
    XLSX.utils.book_append_sheet(emptyBook, emptySheet, 'Balance');
    XLSX.writeFile(emptyBook, emptyPath);
    assert.throws(() => readBalanceSeedImportFile(emptyPath), (error) => error.code === 'FILE_READ' && /文件为空或不可读/.test(error.message));
    assert.throws(() => readBalanceSeedImportFile(path.join(dir, '余额.txt')), (error) => error.code === 'FILE_TYPE');
  });

  test('内容之间隔着大量空行（第 1、2 行与第 200000 行）：只转换有内容的行，行号仍为物理行号', (t) => {
    const dir = tempDir(t);
    const sheet = XLSX.utils.aoa_to_sheet([header, ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 11, '', '']]);
    XLSX.utils.sheet_add_aoa(sheet, [['备注：以上为日终余额']], { origin: 'A200000' });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
    const filePath = path.join(dir, '日终余额.xlsx');
    XLSX.writeFile(workbook, filePath);
    const originalSheetToJson = XLSX.utils.sheet_to_json;
    t.after(() => { XLSX.utils.sheet_to_json = originalSheetToJson; });
    let convertedRows = 0;
    XLSX.utils.sheet_to_json = (...args) => {
      const result = originalSheetToJson.apply(XLSX.utils, args);
      convertedRows += result.length;
      return result;
    };
    const { file, parsed } = parseFile(filePath);
    assert.equal(convertedRows, 6, '原值、显示文本各转换 3 行，不为中间的空行分配数组');
    assert.deepEqual(file.rowNumbers, [1, 2, 200000]);
    assert.deepEqual(file.displayRows.map((row) => row[0]), ['账单日期', '2026-09-30', '备注：以上为日终余额']);
    assert.deepEqual(parsed.records.map((record) => [record.rowNumber, record.endBalance]), [[2, 11]]);
  });

  test('余额文件在读取前被移走或不可读：报文件不可读（FileValidationError），不带出含路径的系统错误', (t) => {
    const dir = tempDir(t);
    const missingPath = path.join(dir, '6222000000000001234 日终余额.xlsx');
    assert.throws(() => readBalanceSeedImportFile(missingPath), (error) => error.code === 'FILE_READ'
      && /文件为空或不可读/.test(error.message) && !error.message.includes(dir) && !String(error.stack).includes('ENOENT'));
  });

  test('身份列有值的空白格（只有空白的文本、空文本）带可能改变显示的格式时整个文件不导入（W3），不按空账号跳过后退回较早的余额', (t) => {
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rowsWith = (account) => [
      header,
      ['2026-09-27', 'DBS', 'SG', 'USD', 'A001', 10, '网银', '接口'],
      ['2026-09-28', 'DBS', 'SG', 'USD', account, 90, '网银', '接口']
    ];
    // 0;0;0;"A001"@ 把只有空格的文本显示为「A001 」：Excel 中第 3 行是 A001 在 9 月 28 日的余额
    const withTextSection = (account) => writePatchedWorkbook(t, [['Balance', rowsWith(account)]], {
      'xl/styles.xml': () => stylesXml({ numFmts: [[171, '0;0;0;&quot;A001&quot;@']], cellXfs: [formattedXf(171)] }),
      'xl/worksheets/sheet1.xml': (text) => text.replace(/<c r="E3"/, '<c r="E3" s="1"')
    });
    assert.throws(() => parseFile(withTextSection(' ')), REJECTED_ACCOUNT, '只有空格');
    assert.throws(() => parseFile(withTextSection('')), REJECTED_ACCOUNT, '空文本');
    // 对照：没有格式时空白账号的行按无效行跳过
    const { parsed } = parseFile(writePatchedWorkbook(t, [['Balance', rowsWith(' ')]], {}));
    assert.deepEqual([parsed.skippedRowCount, parsed.records.map((record) => record.merchantId)], [1, ['A001']]);
  });

  test('结构白名单（W2）：第一个标签只按主命名空间的 <sheet> 认，扩展命名空间的 <aux:sheet> 冒充第一张表时不导入；第一张表隐藏时不导入', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const first = [header, ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 100, '', '']];
    const second = [header, ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 888, '', '']];
    // 声明为 mc:Ignorable 的 <aux:sheet> 引用第二张表：Excel 忽略它，第一个标签是 First（100）；读取库把它当作第一张表（888）
    const impostor = writePatchedWorkbook(t, [['First', first], ['Second', second]], {
      'xl/workbook.xml': (text) => {
        const secondId = /<sheet name="Second" sheetId="2" r:id="(rId\d+)"\/>/.exec(text)[1];
        return text
          .replace(/<workbook /, '<workbook xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aux="urn:aux" mc:Ignorable="aux" ')
          .replace('<sheets>', `<sheets><aux:sheet name="Aux" sheetId="9" r:id="${secondId}"/>`);
      }
    });
    assert.equal(XLSX.read(fs.readFileSync(impostor), { type: 'buffer' }).SheetNames[0], 'Aux');
    assert.throws(() => parseFile(impostor), REJECTED_SHEET);
    assert.deepEqual(parseFile(writePatchedWorkbook(t, [['First', first], ['Second', second]], {})).parsed.records.map((record) => record.endBalance), [100]);
    // 第一张表隐藏：Excel 的第一个可见标签是另一张表
    const hidden = writePatchedWorkbook(t, [['First', first], ['Second', second]], {
      'xl/workbook.xml': (text) => text.replace('<sheet name="First"', '<sheet name="First" state="hidden"')
    });
    assert.throws(() => parseFile(hidden), (error) => error.code === 'FILE_READ' && /第一个工作表是隐藏的/.test(error.message));
  });

  test('结构白名单（W2）：读取用到的元素局部声明命名空间前缀（<x:mergeCells xmlns:x=…>、<y:cols xmlns:y=…>）时不导入，不漏掉合并范围与列样式', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A', 10, '', ''],
      ['2026-11-20', 'DBS', 'SG', 'USD', 'B', 20, '', '']
    ];
    // E2:E3 合并：Excel 第 3 行显示 A；局部前缀加单引号的 ref 曾被两套核对都漏掉，第 3 行的余额归给 B
    const localMerge = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        `</sheetData><x:mergeCells xmlns:x="${MAIN}" count="1"><x:mergeCell ref='E2:E3'/></x:mergeCells>`)
    });
    assert.throws(() => parseFile(localMerge), REJECTED_SHEET);
    const localCols = writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/styles.xml': () => stylesXml(TEXT_SECTION_STYLES),
      'xl/worksheets/sheet1.xml': (text) => text.replace('<sheetData>', `<y:cols xmlns:y="${MAIN}"><y:col min="5" max="5" width="9" style="1"/></y:cols><sheetData>`)
    });
    assert.throws(() => parseFile(localCols), REJECTED_SHEET);
  });

  test('结构白名单（W2）：x14 条件格式（扩展列表里）按原文的 <xm:sqref> 核对；sqref 写成字符引用、小写等非规范写法时不导入', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '', ''],
      ['2026-11-20', 'DBS', 'SG', 'USD', 1, 20, '', '']
    ];
    // Excel 2010 起的写法：把 E3 的数字 1 显示为 001
    const x14 = (sqref) => writePatchedWorkbook(t, [['Balance', rows]], {
      'xl/worksheets/sheet1.xml': (text) => text.replace('</worksheet>',
        '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
        + '<x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
        + '<x14:cfRule type="expression" priority="1" id="{00000000-0000-0000-0000-000000000001}"><xm:f>TRUE</xm:f>'
        + '<x14:dxf><numFmt numFmtId="171" formatCode="000"/></x14:dxf></x14:cfRule>'
        + `<xm:sqref>${sqref}</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>`)
    });
    assert.throws(() => parseFile(x14('E3')), REJECTED_ACCOUNT);
    // E&#51; 与 E3 等价，读取库按原文解析成另一个位置
    assert.throws(() => parseFile(x14('E&#51;')), REJECTED_SHEET);
    assert.throws(() => parseFile(x14('e3')), REJECTED_SHEET);
    assert.throws(() => parseFile(x14('E3  F3')), REJECTED_SHEET);
    // 只覆盖期末余额列：照常导入
    assert.deepEqual(parseFile(x14('F2:F3 H2')).parsed.records.map((record) => [record.merchantId, record.endBalance]), [['A1', 10], ['1', 20]]);
  });

  test('结构白名单（W2）：其他读取库与 Excel 读法可能不同的写法不导入（扩展里的日期系统、根关系与内容类型指向不同的工作簿、DTD、未声明的前缀、带前缀的同名属性、控制字符、嵌套的根元素）', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const rows = [header, ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '网银', '接口']];
    const ignorable = (text) => text.replace(/<worksheet /, '<worksheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aux="urn:aux" mc:Ignorable="aux" ');
    const cases = {
      // 扩展里的 <x15:workbookPr date1904="1">：读取库按它改用 1904 日期系统，Excel 不认
      'x15 日期系统': { 'xl/workbook.xml': (text) => text.replace('</workbook>',
        '<extLst><ext uri="{00000000-0000-0000-0000-000000000002}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">'
        + '<x15:workbookPr date1904="1"/></ext></extLst></workbook>') },
      // Excel 按根关系找工作簿，读取库按 [Content_Types].xml
      '根关系': { '_rels/.rels': (text) => text.replace('Target="xl/workbook.xml"', 'Target="xl/workbook2.xml"') },
      DTD: { 'xl/worksheets/sheet1.xml': (text) => text.replace('<worksheet ', '<!DOCTYPE worksheet><worksheet ') },
      未声明的前缀: { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><foo:bar/>') },
      带前缀的同名属性: { 'xl/worksheets/sheet1.xml': (text) => ignorable(text).replace('<sheetData>', '<cols><col min="5" max="5" width="9" aux:style="1"/></cols><sheetData>') },
      控制字符: { 'xl/worksheets/sheet1.xml': (text) => text.replace('网银', '网\u0001银') },
      嵌套的根元素: { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><worksheet/>') },
      扩展以外的命名空间声明: { 'xl/worksheets/sheet1.xml': (text) => text.replace('<sheetData>', '<sheetData xmlns:z="urn:z">') },
      'mc:AlternateContent 里的工作表元素': { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>',
        '</sheetData><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x14">'
        + '<conditionalFormatting sqref="E2"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>'
        + '</mc:Choice></mc:AlternateContent>') },
      两个工作表数据: { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><sheetData/>') }
    };
    for (const [name, patches] of Object.entries(cases)) {
      const filePath = writePatchedWorkbook(t, [['Balance', rows]], patches);
      assert.equal(passesWhitelist(filePath), false, name);
      assert.throws(() => parseFile(filePath), REJECTED_SHEET, name);
    }
    assert.deepEqual(parseFile(writePatchedWorkbook(t, [['Balance', rows]], {})).parsed.records.map((record) => record.endBalance), [10]);
  });

  test('结构白名单（W2）：读取库给属性起的别名（大小写、下划线截断、带前缀的局部名称）、不在规定父元素下的元素、扩展里的 mc:AlternateContent、公式文本里的字符引用不导入', (t) => {
    const REJECTED_SHEET = (error) => error.code === 'FILE_READ' && error.message === '无法核对余额文件的工作表内容，请在 Excel 中打开并另存为 xlsx 后重新导入';
    const REJECTED_ACCOUNT = (error) => error.code === 'FILE_READ' && /银行账户号显示的内容可能与原值不同/.test(error.message);
    const rows = [
      header,
      ['2026-11-19', 'DBS', 'SG', 'USD', 'A1', 10, '', ''],
      ['2026-11-20', 'DBS', 'SG', 'USD', 1, 20, '', '']
    ];
    // 样式 1 把数字 1 显示为 001。读取库按属性名的小写与下划线前的部分、带前缀属性的局部名称取值（后出现的覆盖先出现的），
    //   本模块按原名取值：两边会取到不同的样式、类型
    const styles = () => stylesXml({ numFmts: [[171, '000']], cellXfs: [formattedXf(171)] });
    const ignorable = (text) => text.replace(/<worksheet /, '<worksheet xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aux="urn:aux" mc:Ignorable="aux" ');
    const cell = (xml, decorate = (text) => text) => ({ 'xl/styles.xml': styles, 'xl/worksheets/sheet1.xml': (text) => replaceCell('E3', xml)(decorate(text)) });
    const x14 = '<x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
      + '<x14:cfRule type="expression" priority="1" id="{00000000-0000-0000-0000-000000000001}"><xm:f>TRUE</xm:f>'
      + '<x14:dxf><numFmt numFmtId="171" formatCode="000"/></x14:dxf></x14:cfRule><xm:sqref>H2</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings>';
    const ext = (inner) => ({ 'xl/worksheets/sheet1.xml': (text) => text.replace('</worksheet>',
      `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">${inner}</ext></extLst></worksheet>`) });
    const formula = (text) => ({ 'xl/worksheets/sheet1.xml': (sheet) => sheet.replace('</sheetData>',
      `</sheetData><conditionalFormatting sqref="H2"><cfRule type="expression" priority="1"><formula>${text}</formula></cfRule></conditionalFormatting>`) });
    const cases = {
      '大写的 S': cell('<c r="E3" S="1"><v>1</v></c>'),
      's 与大写的 S': cell('<c r="E3" s="0" S="1"><v>1</v></c>'),
      '下划线截断（s_x）': cell('<c r="E3" s="0" s_x="1"><v>1</v></c>'),
      '带前缀的类型（aux:t）': cell('<c r="E3" aux:t="str"><v>1</v></c>', ignorable),
      '大小写不同的同名属性（numFmtId 与 numfmtid）': {
        'xl/styles.xml': () => stylesXml({ cellXfs: ['<xf numFmtId="0" numfmtid="49" fontId="0" fillId="0" borderId="0" xfId="0"/>'] }),
        'xl/worksheets/sheet1.xml': replaceCell('E3', '<c r="E3" s="1"><v>1</v></c>')
      },
      '关系上的其他属性': { 'xl/_rels/workbook.xml.rels': (text) => text.replace('<Relationship ', '<Relationship Foo="1" ') },
      '小写的合并范围': { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="e2:e3"/></mergeCells>') },
      '不在 <mergeCells> 下的 <mergeCell>': { 'xl/worksheets/sheet1.xml': (text) => text.replace('</sheetData>', '</sheetData><mergeCell ref="E2:E3"/>') },
      '扩展里的 mc:AlternateContent': ext(`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x14">${x14}</mc:Choice></mc:AlternateContent>`),
      '条件格式公式里的字符引用': formula('&#84;RUE')
    };
    for (const [name, patches] of Object.entries(cases)) {
      const filePath = writePatchedWorkbook(t, [['Balance', rows]], patches);
      assert.equal(passesWhitelist(filePath), false, name);
      assert.throws(() => parseFile(filePath), REJECTED_SHEET, name);
    }
    // 对照：规范写法的 s="1" 通过白名单、按显示风险拒绝；扩展里直接写的 x14 条件格式、不带字符引用的公式只覆盖余额获取方式列，照常导入
    const styled = writePatchedWorkbook(t, [['Balance', rows]], cell('<c r="E3" s="1"><v>1</v></c>'));
    assert.equal(passesWhitelist(styled), true);
    assert.throws(() => parseFile(styled), REJECTED_ACCOUNT);
    for (const patches of [ext(x14), formula('TRUE')]) {
      assert.deepEqual(parseFile(writePatchedWorkbook(t, [['Balance', rows]], patches)).parsed.records.map((record) => [record.merchantId, record.endBalance]),
        [['A1', 10], ['1', 20]]);
    }
  });

  test('结构白名单（W2）不误拒：assets 下由 Excel、WPS、Apache POI 等保存的 xlsx 都能通过核对', () => {
    const { scanXlsxFormulaCache } = require('../../../src/backend/file-service/readers');
    const dir = path.join(__dirname, '../../../assets');
    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.xlsx'));
    assert.ok(names.length >= 20, `assets 下的 xlsx：${names.length} 个`);
    names.forEach((name) => {
      const workbook = XLSX.read(fs.readFileSync(path.join(dir, name)), { type: 'buffer', cellDates: false, dense: true, sheetStubs: true, sheets: 0, bookFiles: true });
      assert.ok(scanXlsxFormulaCache(workbook, workbook.SheetNames[0]), name);
    });
  });

  test('表头在前 10 个非空行内查找：前面的空行不占名额', () => {
    const rows = [...Array.from({ length: 12 }, () => []), ...Array.from({ length: 9 }, (_, index) => [`标题 ${index}`]), header,
      ['2026-09-30', 'DBS', 'SG', 'USD', 'A1', 10, '', '']];
    const parsed = parseBalanceSeedImportRows(rows, { rowNumbers: rows.map((_row, index) => index + 3) });
    assert.deepEqual(parsed.records.map((record) => record.rowNumber), [3 + 22]);
    assert.throws(() => parseBalanceSeedImportRows([...Array.from({ length: 10 }, (_, index) => [`标题 ${index}`]), header]),
      (error) => error.code === 'BALANCE_IMPORT_HEADER_MISSING');
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
    balanceRow({ account: 'B2', date: '2026-09-30', balance: '1.001', source: '网银账单' }),
    balanceRow({ account: 'B2', date: '2026-09-30', balance: '1.004', source: 'API' }),
    balanceRow({ account: 'C3', date: '2026-09-29', balance: '4' }),
    balanceRow({ account: 'C3', date: '2026-09-30', balance: '5', source: '网银账单', method: '手工导入' }),
    balanceRow({ account: 'C3', date: '2026-09-30', balance: '6', source: '银行API', method: '自动获取' }),
    balanceRow({ account: 'C3', date: '2026-09-30', balance: '5.00', source: '人工', method: '手工录入' }),
    balanceRow({ account: 'D4', date: '2026-10-01', balance: '7' }),
    balanceRow({ account: 'E5', date: '2026-09-30', balance: '8', bankName: 'CITI', location: 'HK' }),
    balanceRow({ account: 'E5', date: '2026-09-29', balance: '9', bankName: 'DBS', location: 'HK' }),
    balanceRow({ account: 'F6', date: '2026-09-30', balance: '11', bankName: 'CITI', location: 'SG' }),
    balanceRow({ account: 'F6', date: '2026-09-29', balance: '12', bankName: 'dbs', location: ' sg ' })
  ]).records;

  test('取早于当前账单日期的最近一天；等于或晚于当前账单日期的行排除；币种不区分大小写', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'A1', currency: 'usd', targetBillDate: '2026-10-01' }
    ], GROUP);
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
    assert.equal(result.choiceCount, 0);
    assert.equal(result.manualCount, 0);
  });

  test('币种不同不算同一账号', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'A1', currency: 'EUR', targetBillDate: '2026-10-01' }
    ], GROUP);
    assert.equal(result.accounts[0].endBalance, 99);
  });

  test('同日余额按分相同算一个余额，取首行原值，不需要选择', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'B2', currency: 'USD', targetBillDate: '2026-10-01' }
    ], GROUP);
    assert.equal(result.accounts[0].source, 'file');
    assert.equal(result.accounts[0].endBalance, 1.001);
  });

  test('同日多个不同余额 → 待选择，列出该日全部行（含余额来源、余额获取方式与行号）', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'C3', currency: 'USD', targetBillDate: '2026-10-01' }
    ], GROUP);
    const [account] = result.accounts;
    assert.equal(account.source, 'choice');
    assert.equal(account.billDate, '2026-09-30');
    assert.equal(account.endBalance, null);
    assert.equal(account.reason, '文件中 2026-09-30 有 2 个不同余额，请选择');
    assert.deepEqual(account.choices.map((choice) => [
      choice.rowNumber, choice.billDate, choice.bankName, choice.location, choice.currency, choice.merchantId,
      choice.endBalance, choice.balanceSource, choice.balanceMethod
    ]), [
      [10, '2026-09-30', 'DBS', 'SG', 'USD', 'C3', 5, '网银账单', '手工导入'],
      [11, '2026-09-30', 'DBS', 'SG', 'USD', 'C3', 6, '银行API', '自动获取'],
      [12, '2026-09-30', 'DBS', 'SG', 'USD', 'C3', 5, '人工', '手工录入']
    ]);
    assert.deepEqual([result.matchedCount, result.choiceCount, result.manualCount], [0, 1, 0]);
  });

  test('银行名 / 开户地为空、本组的不为空：按读不出（为空）处理，不当作另一开户地而退回更早一天；本组的也为空时照常匹配', () => {
    const { records } = parseBalanceSeedImportRows([
      HEADER,
      balanceRow({ account: 'A1', date: '2026-11-19', balance: '10' }),
      balanceRow({ account: 'A1', date: '2026-11-20', balance: '20', location: '' }),
      balanceRow({ account: 'B2', date: '2026-11-19', balance: '10' }),
      balanceRow({ account: 'B2', date: '2026-11-20', balance: '20', bankName: ' ' }),
      // 只有为空的行：不是「文件中的开户地对不上」，同样手工录入
      balanceRow({ account: 'C3', date: '2026-11-20', balance: '30', location: '' })
    ]);
    const pending = ['A1', 'B2', 'C3'].map((merchantId) => ({ merchantId, currency: 'USD', targetBillDate: '2026-11-21' }));
    const result = matchBalanceSeedImport(records, pending, GROUP);
    assert.deepEqual(result.accounts.map((account) => [account.source, account.endBalance]), [['manual', null], ['manual', null], ['manual', null]]);
    assert.match(result.accounts[0].reason, /2026-11-20 的余额行（第 3 行）开户地读不出（为空）/);
    assert.match(result.accounts[1].reason, /第 5 行）银行名读不出（为空）/);
    // 本组的开户地为空：空的开户地照常匹配
    const noLocation = matchBalanceSeedImport(records, pending, { bankName: GROUP.bankName, location: '' });
    assert.deepEqual(noLocation.accounts.map((account) => [account.source, account.billDate, account.endBalance]),
      [['file', '2026-11-20', 20], ['manual', '', null], ['file', '2026-11-20', 30]]);
  });

  test('银行名、开户地参与匹配：去首尾空格、不区分大小写；对不上的行不参与，全对不上写明文件中的银行名 / 开户地', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'E5', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'F6', currency: 'USD', targetBillDate: '2026-10-01' }
    ], { bankName: ' DBS ', location: 'sg' });
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance, account.reason]), [
      ['E5', 'manual', '', null, '文件中该账号的银行名 / 开户地为 CITI / HK、DBS / HK，与本组 DBS / sg 不一致'],
      ['F6', 'file', '2026-09-29', 12, '']
    ]);
  });

  test('银行名 / 开户地对不上的组超过 3 组时只列前 3 组并写明总数', () => {
    const many = parseBalanceSeedImportRows([
      HEADER,
      ...['B1', 'B2', 'B3', 'B4'].map((bankName) => balanceRow({ account: 'G7', date: '2026-09-30', balance: '1', bankName }))
    ]).records;
    const [account] = matchBalanceSeedImport(many, [{ merchantId: 'G7', currency: 'USD', targetBillDate: '2026-10-01' }], GROUP).accounts;
    assert.equal(account.reason, '文件中该账号的银行名 / 开户地为 B1 / SG、B2 / SG、B3 / SG 等 4 组，与本组 DBS / SG 不一致');
  });

  test('无更早余额、文件中无该账号 → 需手工录入并写明原因', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'D4', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'Z9', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'A1', currency: 'JPY', targetBillDate: '2026-10-01' }
    ], GROUP);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.reason, account.billDate, account.endBalance]), [
      ['D4', 'manual', '文件中没有该账号早于 2026-10-01 的余额', '', null],
      ['Z9', 'manual', '文件中没有该账号', '', null],
      ['A1', 'manual', '文件中没有该账号', '', null]
    ]);
    assert.deepEqual([result.matchedCount, result.choiceCount, result.manualCount], [0, 0, 3]);
  });

  test('账号是否在文件中、银行名 / 开户地是否一致按可读的身份字段判断：期末余额读不出的行也算，原因不误报「文件中没有该账号」', () => {
    const unreadableRow = (merchantId, billDate, extra = {}) => ({
      merchantId, currency: 'USD', bankName: 'DBS', location: 'SG', billDate, endBalance: null, balanceSource: '', balanceMethod: '',
      rowNumber: 2, unreadableFields: { endBalance: 'Excel 错误值 #N/A' }, ...extra
    });
    const result = matchBalanceSeedImport([
      // 唯一一行就是当前账单日，只有期末余额读不出
      unreadableRow('P1', '2026-10-01'),
      // 唯一一行的银行名与本组不同，期末余额读不出
      unreadableRow('P2', '2026-09-30', { bankName: 'CITI' }),
      // 币种读不出：不能确认是本账号 + 币种
      unreadableRow('P3', '2026-10-01', { currency: '', unreadableFields: { currency: 'Excel 错误值 #N/A' } })
    ], ['P1', 'P2', 'P3'].map((merchantId) => ({ merchantId, currency: 'USD', targetBillDate: '2026-10-01' })), GROUP);
    assert.deepEqual(result.accounts.map((account) => [account.merchantId, account.source, account.reason]), [
      ['P1', 'manual', '文件中没有该账号早于 2026-10-01 的余额'],
      ['P2', 'manual', '文件中该账号的银行名 / 开户地为 CITI / SG，与本组 DBS / SG 不一致'],
      ['P3', 'manual', '文件中没有该账号']
    ]);
  });

  test('核对账号带已有种子日期：文件最近一天早于它 → 需手工录入并写明原因；等于或晚于它照常取（v3.2.22）', () => {
    const pending = (minBillDate) => [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01', minBillDate }];
    // 9 月 30 日账单核对 9 月 29 日的种子，文件早于 9 月 30 日的最近一天是 9 月 28 日
    const earlier = matchBalanceSeedImport(records,
      [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-09-30', minBillDate: '2026-09-29' }], GROUP).accounts[0];
    assert.deepEqual([earlier.source, earlier.billDate, earlier.endBalance, earlier.reason],
      ['manual', '', null, '文件中该账号最近的余额在 2026-09-28，早于已有的 2026-09-29 余额，导入后仍按已有余额核对，请手工填写']);
    const stale = matchBalanceSeedImport(records, [{ merchantId: 'C3', currency: 'USD', targetBillDate: '2026-10-01', minBillDate: '2026-09-30' },
      { merchantId: 'E5', currency: 'USD', targetBillDate: '2026-10-01', minBillDate: '2026-09-30' }], { bankName: 'DBS', location: 'HK' });
    assert.deepEqual(stale.accounts.map((account) => [account.merchantId, account.source, account.reason]), [
      ['C3', 'manual', '文件中该账号的银行名 / 开户地为 DBS / SG，与本组 DBS / HK 不一致'],
      ['E5', 'manual', '文件中该账号最近的余额在 2026-09-29，早于已有的 2026-09-30 余额，导入后仍按已有余额核对，请手工填写']
    ]);
    assert.equal(earlier.minBillDate, '2026-09-29');
    for (const minBillDate of ['2026-09-30', '2026-09-29', '']) {
      const account = matchBalanceSeedImport(records, pending(minBillDate), GROUP).accounts[0];
      assert.deepEqual([account.source, account.billDate, account.endBalance], ['file', '2026-09-30', 30], minBillDate);
      // 结果带上已有种子日期，确认页据此限制可填写的日期
      assert.equal(account.minBillDate, minBillDate || undefined, minBillDate);
    }
  });

  test('余额为 0 视为有效余额', () => {
    const zero = parseBalanceSeedImportRows([HEADER, balanceRow({ account: 'Z0', date: '2026-09-30', balance: '0.00' })]).records;
    const result = matchBalanceSeedImport(zero, [{ merchantId: 'Z0', currency: 'USD', targetBillDate: '2026-10-01' }], GROUP);
    assert.equal(result.accounts[0].source, 'file');
    assert.equal(result.accounts[0].endBalance, 0);
  });

  test('保持待补录账号的顺序；没有待补录账号返回空', () => {
    const result = matchBalanceSeedImport(records, [
      { merchantId: 'Z9', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-01' }
    ], GROUP);
    assert.deepEqual(result.accounts.map((account) => account.merchantId), ['Z9', 'A1']);
    assert.deepEqual(matchBalanceSeedImport(records, [], GROUP), { accounts: [], matchedCount: 0, choiceCount: 0, manualCount: 0 });
  });
});

test.describe('balanceImportAccountsForPrompt', () => {
  const { balanceImportAccountsForPrompt } = require('../../../src/backend/balance-seed-import');
  const pendingAccounts = [
    { merchantId: 'B2', currency: 'USD', targetBillDate: '2026-10-01' },
    { merchantId: 'C3', currency: 'EUR', targetBillDate: '2026-10-03' }
  ];

  test('普通缺种子补录：取 pendingAccounts', () => {
    assert.deepEqual(balanceImportAccountsForPrompt({ merchantId: 'B2', currency: 'USD', pendingAccounts }), pendingAccounts);
  });

  test('核对上一账单日余额：当前核对账号在前，再加缺种子账号，按银行账号 + 币种去重', () => {
    const prompt = {
      merchantId: ' A1 ', currency: 'USD', targetBillDate: '2026-10-02', seedMismatch: { seedDate: '2026-09-30' },
      pendingAccounts: [...pendingAccounts, { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02' }]
    };
    // 当前核对账号带已有种子日期（minBillDate），更早的文件余额修正不了本次核对
    assert.deepEqual(balanceImportAccountsForPrompt(prompt), [
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02', minBillDate: '2026-09-30' },
      ...pendingAccounts
    ]);
    assert.deepEqual(balanceImportAccountsForPrompt({ ...prompt, pendingAccounts: undefined }), [
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02', minBillDate: '2026-09-30' }
    ]);
    assert.deepEqual(balanceImportAccountsForPrompt({ ...prompt, seedMismatch: {}, pendingAccounts: undefined }), [
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02' }
    ]);
    // 给了当前种子记录的取值时，下限按当前记录（种子已被改动 / 恢复时不沿用提示里的日期）
    const asked = [];
    const previousSeedDate = (account) => { asked.push(account); return asked.length === 1 ? '2026-10-01' : ''; };
    assert.deepEqual(balanceImportAccountsForPrompt({ ...prompt, pendingAccounts: undefined }, { previousSeedDate }), [
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02', minBillDate: '2026-10-01' }
    ]);
    assert.deepEqual(asked, [{ merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02' }]);
    assert.deepEqual(balanceImportAccountsForPrompt({ ...prompt, pendingAccounts: undefined }, { previousSeedDate }), [
      { merchantId: 'A1', currency: 'USD', targetBillDate: '2026-10-02' }
    ]);
  });

  test('断档、余额不一致、人工补录替换确认与空提示不可导入', () => {
    ['gap', 'mismatch', 'seed-replace'].forEach((reason) => {
      assert.deepEqual(balanceImportAccountsForPrompt({ reason, merchantId: 'A1', pendingAccounts }), []);
    });
    assert.deepEqual(balanceImportAccountsForPrompt(null), []);
  });
});
