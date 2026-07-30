'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  detectToolboxInputKind
} = require('../../src/main-process/toolbox-input-kind');

function withFixture(name, bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-kind-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  try {
    return fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('magic 优先：ZIP OOXML 即使扩展名是 .xls 仍判为 xlsx', () => {
  withFixture('伪装.xls', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), (filePath) => {
    assert.equal(detectToolboxInputKind(filePath), 'xlsx');
  });
});

test('magic 优先：OLE/CFB 即使扩展名是 .xlsx 仍判为 xls', () => {
  withFixture(
    '伪装.xlsx',
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    (filePath) => assert.equal(detectToolboxInputKind(filePath), 'xls')
  );
});

test('CSV 仅按扩展名进入无样式词法路径', () => {
  withFixture('data.csv', Buffer.from('a,b\n1,2\n'), (filePath) => {
    assert.equal(detectToolboxInputKind(filePath), 'csv');
  });
});

test('XML Spreadsheet 伪装 .xls 明确拒绝并提示转换', () => {
  withFixture('legacy.xls', Buffer.from('<?xml version="1.0"?><Workbook/>'), (filePath) => {
    assert.throws(
      () => detectToolboxInputKind(filePath),
      /另存为 \.xlsx 或 Excel 97–2003 \.xls/
    );
  });
});
