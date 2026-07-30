'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXCEL_CELL_TEXT_MAX_UTF16_UNITS,
  ToolboxExcelTextError,
  assertExcelCellTextLength,
  decodeExcelStXstring,
  encodeExcelStXstring
} = require('../../src/backend/toolbox-format/excel-text');

test('ST_Xstring 单次解码并保护大小写 escape 字面量', () => {
  assert.equal(decodeExcelStXstring('_x0041_'), 'A');
  assert.equal(decodeExcelStXstring('_X0041_'), 'A');
  assert.equal(decodeExcelStXstring('_x005F_x0041_'), '_x0041_');
  assert.equal(decodeExcelStXstring('_x005F_X0041_'), '_X0041_');

  assert.equal(encodeExcelStXstring('_x0041_'), '_x005F_x0041_');
  assert.equal(encodeExcelStXstring('_X0041_'), '_x005F_X0041_');
});

test('ST_Xstring 往返保留控制字符、CRLF、DEL 与 emoji', () => {
  const semantic = 'A\u0000B\u0001C\u000BD\r\nE\u007FF😀_x0041__X0042_';
  const encoded = encodeExcelStXstring(semantic);
  assert.ok(encoded.includes('_x0000_'));
  assert.ok(encoded.includes('_x000D_'));
  assert.ok(encoded.includes('_x007F_'));
  assert.equal(decodeExcelStXstring(encoded), semantic);
});

test('Excel 文本上限按 UTF-16 code unit 保守计数，拒绝未配对代理项', () => {
  assert.equal(EXCEL_CELL_TEXT_MAX_UTF16_UNITS, 32767);
  assert.equal(assertExcelCellTextLength('A'.repeat(32767)).length, 32767);
  assert.equal(assertExcelCellTextLength(`${'😀'.repeat(16383)}A`).length, 32767);

  for (const invalid of [
    'A'.repeat(32768),
    '😀'.repeat(16384)
  ]) {
    assert.throws(
      () => assertExcelCellTextLength(invalid),
      (error) => error instanceof ToolboxExcelTextError &&
        error.code === 'TOOLBOX_EXCEL_TEXT_INVALID'
    );
  }
  assert.throws(() => encodeExcelStXstring('\uD800'), ToolboxExcelTextError);
  assert.throws(() => decodeExcelStXstring('_xD800_'), ToolboxExcelTextError);
  assert.throws(() => encodeExcelStXstring('\uFFFE'), ToolboxExcelTextError);
  assert.throws(() => decodeExcelStXstring('_xFFFF_'), ToolboxExcelTextError);
});
