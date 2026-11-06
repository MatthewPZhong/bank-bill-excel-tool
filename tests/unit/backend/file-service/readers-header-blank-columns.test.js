'use strict';

// 模板表头含中间空项（合并单元格占位）时的表头定位：
//   - 只裁首尾空项、保留中间空项，与原始账单逐列对齐，取值下标与物理列一致；
//   - 完整结构找不到时退回旧的去空口径，兼容「模板有空项、账单没有这些空列」的已有模板；
//   - 空表头仍按无表头约束读取全部有意义行。
// 结构仿 KBANK-VN 账单：表头前有账户信息区，表头从 C 列开始，借方/余额/描述各占多列合并单元格。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { buildExpectedHeaderCandidates, FileValidationError } = require('../../../../src/backend/file-service/common');
const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');

const MERGED_HEADER = [
  'No.', 'Date', 'Time', '', 'Debit', '', '', 'Credit', 'Balance', '', '', '', '', 'Description'
];
const COMPACT_HEADER = MERGED_HEADER.filter(Boolean);

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readers-header-blank-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, fileName, rows) {
  const filePath = path.join(dir, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

// 一行交易，按 14 列相对位置放值：前置 offset 个空列。
function dataRow(offset, { no, date, debit = '', credit = '', balance, description = '' }) {
  const cells = new Array(MERGED_HEADER.length).fill('');
  cells[0] = no;
  cells[1] = date;
  cells[2] = '10:00:00';
  cells[4] = debit;
  cells[7] = credit;
  cells[8] = balance;
  cells[13] = description;
  return [...new Array(offset).fill(''), ...cells];
}

test('buildExpectedHeaderCandidates：裁首尾空项、保留中间空项，并附旧去空口径', () => {
  assert.deepEqual(buildExpectedHeaderCandidates(['', ' A ', '', 'B', '', '']), [['A', '', 'B'], ['A', 'B']]);
  assert.deepEqual(buildExpectedHeaderCandidates(['', 'A', 'B', '']), [['A', 'B']]);
  assert.deepEqual(buildExpectedHeaderCandidates(MERGED_HEADER), [MERGED_HEADER, COMPACT_HEADER]);
  assert.deepEqual(buildExpectedHeaderCandidates([]), []);
  assert.deepEqual(buildExpectedHeaderCandidates(['', '  ', null]), []);
  assert.deepEqual(buildExpectedHeaderCandidates(null), []);
});

test('表头含中间空列且不在首行首列：按完整结构定位，取值列与物理列一致', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'merged-header.xlsx', [
    ['', '', '', '', '', '账号', '', '', '', '', '', '', '', '币种'],
    ['', '', '', '', '', 'ACC001', '', '', '', '', '', '', '', 'VND'],
    [],
    ['', '', ...MERGED_HEADER],
    dataRow(2, { no: 1, date: '01/10/2026', debit: '100', balance: '900', description: '付款' }),
    dataRow(2, { no: 2, date: '02/10/2026', credit: '50', balance: '950' })
  ]);

  const result = readRowsWithMetadata(filePath, MERGED_HEADER);

  assert.deepEqual(result.rows[0], MERGED_HEADER);
  assert.deepEqual(result.rowNumbers, [4, 5, 6]);
  assert.equal(result.rows[1].length, MERGED_HEADER.length);
  assert.deepEqual(
    [result.rows[1][1], result.rows[1][4], result.rows[1][7], result.rows[1][8], result.rows[1][13]],
    ['01/10/2026', '100', '', '900', '付款']
  );
  assert.deepEqual(
    [result.rows[2][1], result.rows[2][4], result.rows[2][7], result.rows[2][8], result.rows[2][13]],
    ['02/10/2026', '', '50', '950', '']
  );
});

test('模板表头带前导空项时，表头从 A 列开始的账单也能定位', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'header-at-a.xlsx', [
    MERGED_HEADER,
    dataRow(0, { no: 1, date: '01/10/2026', debit: '100', balance: '900' })
  ]);

  const result = readRowsWithMetadata(filePath, ['', '', ...MERGED_HEADER, '', '']);

  assert.deepEqual(result.rows[0], MERGED_HEADER);
  assert.equal(result.rows[1][4], '100');
});

test('兼容已有模板：模板有中间空项而账单没有这些空列时退回去空口径', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'compact-file.xlsx', [
    COMPACT_HEADER,
    ['1', '01/10/2026', '10:00:00', '100', '', '900', '付款']
  ]);

  const result = readRowsWithMetadata(filePath, MERGED_HEADER);

  assert.deepEqual(result.rows[0], COMPACT_HEADER);
  assert.deepEqual(result.rows[1], ['1', '01/10/2026', '10:00:00', '100', '', '900', '付款']);
});

test('字段改名或空列位置不同（且去空口径也对不上）时仍报表头不匹配', (t) => {
  const dir = createTempDir(t);
  const renamed = MERGED_HEADER.slice();
  renamed[4] = 'Debit Amount';
  const renamedPath = writeXlsx(dir, 'renamed.xlsx', [['', '', ...renamed]]);
  // Debit 前的空列挪到 Debit 后：完整结构逐列对不上，账单又有中间空列，去空口径也对不上。
  const shiftedBlank = ['No.', 'Date', 'Time', 'Debit', '', '', '', 'Credit', 'Balance', '', '', '', '', 'Description'];
  const shiftedPath = writeXlsx(dir, 'shifted-blank.xlsx', [shiftedBlank]);

  for (const filePath of [renamedPath, shiftedPath]) {
    assert.throws(() => readRowsWithMetadata(filePath, MERGED_HEADER), (error) => {
      assert.ok(error instanceof FileValidationError);
      assert.equal(error.code, 'FILE_READ');
      assert.match(error.message, /未匹配到所选模板的表头/);
      return true;
    });
  }
});

test('多段账单的重复表头按完整结构识别为分段，不当作数据行', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'multi-block.xlsx', [
    ['', '', ...MERGED_HEADER],
    dataRow(2, { no: 1, date: '01/10/2026', debit: '100', balance: '900' }),
    [],
    ['', '', ...MERGED_HEADER],
    dataRow(2, { no: 1, date: '03/10/2026', credit: '30', balance: '930' })
  ]);

  const result = readRowsWithMetadata(filePath, MERGED_HEADER);

  assert.deepEqual(result.headerBreaks, [4]);
  assert.deepEqual(result.rowNumbers, [1, 2, 5]);
  assert.equal(result.rows[2][7], '30');
});

test('空表头或全空表头：不施加表头约束，返回全部有意义行', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'no-header.xlsx', [['a', '', 'b'], [], ['c']]);

  for (const headers of [[], ['', '  ']]) {
    const result = readRowsWithMetadata(filePath, headers);
    assert.deepEqual(result.rows, [['a', '', 'b'], ['c']]);
    assert.deepEqual(result.rowNumbers, [1, 3]);
  }
});
