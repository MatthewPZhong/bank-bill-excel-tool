'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../../../../src/backend');
const commonRoot = path.join(backendRoot, 'xlsx');
const leafModules = [
  'excel-text',
  'ooxml-namespaces',
  'number-date',
  'model',
  'style-registry',
  'xlsx-sheet-scanner'
];

for (const name of leafModules) {
  test(`${name} 旧入口与公共入口共享同一导出对象`, () => {
    assert.strictEqual(
      require(path.join(backendRoot, 'toolbox-format', name)),
      require(path.join(commonRoot, name))
    );
  });
}

test('ZIP 旧入口保留全部导出和 BigTableImportError constructor 身份', () => {
  const legacy = require(path.join(backendRoot, 'big-table-import/zip-reader'));
  const common = require(path.join(commonRoot, 'zip-reader'));
  assert.strictEqual(legacy, common);
  const details = ['保留原 detailLines'];
  const error = new common.BigTableImportError('输入无效', details);
  assert.ok(error instanceof legacy.BigTableImportError);
  assert.strictEqual(error.detailLines, details);
  assert.equal(error.name, 'BigTableImportError');
});

test('Toolbox 装配转发既有 metadata/SST helper，公共模块不暴露业务装配', () => {
  const toolbox = require(path.join(backendRoot, 'toolbox-format/xlsx-pass'));
  const common = require(path.join(commonRoot, 'workbook-parts'));
  const helpers = [
    'TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES',
    'TOOLBOX_XLSX_METADATA_LIMITS',
    'assertToolboxSharedStringsSize',
    'findRelationshipEntry',
    'loadToolboxSharedStrings',
    'normalizeRelationshipTarget',
    'parseWorkbookRelationships',
    'parseWorkbookXml',
    'relationshipTypeAllowed',
    'readToolboxMetadataEntryAsString'
  ];
  assert.deepEqual(Object.keys(common).sort(), helpers.slice().sort());
  for (const name of helpers) assert.strictEqual(toolbox[name], common[name], name);
  assert.equal(typeof toolbox.ToolboxXlsxPass, 'function');
  assert.equal(typeof toolbox.openToolboxXlsxPass, 'function');
  assert.equal(common.ToolboxXlsxPass, undefined);
  assert.equal(common.openToolboxXlsxPass, undefined);
});

test('公共 metadata 解析错误仍可通过旧业务 constructor 判断', () => {
  const { parseWorkbookXml } = require(path.join(commonRoot, 'workbook-parts'));
  const legacy = require(path.join(backendRoot, 'toolbox-format/xlsx-sheet-scanner'));
  const common = require(path.join(commonRoot, 'xlsx-sheet-scanner'));
  assert.throws(() => parseWorkbookXml(''), (error) => {
    assert.ok(error instanceof legacy.ToolboxXlsxFormatError);
    assert.ok(error instanceof common.ToolboxXlsxFormatError);
    assert.equal(error.name, 'ToolboxXlsxFormatError');
    assert.equal(error.code, 'TOOLBOX_XLSX_FORMAT_INVALID');
    return true;
  });
});

test('公共叶子、ZIP 与 workbook-parts 的运行时依赖闭包不载入业务源码', () => {
  const sourceRoot = path.resolve(backendRoot, '..') + path.sep;
  const commonPrefix = commonRoot + path.sep;
  const pending = [...leafModules, 'zip-reader', 'workbook-parts'].map((name) => {
    const resolved = require.resolve(path.join(commonRoot, name));
    require(resolved);
    return require.cache[resolved];
  });
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.filename.startsWith(sourceRoot)) {
      assert.ok(current.filename.startsWith(commonPrefix), current.filename);
    }
    pending.push(...current.children);
  }
});
