'use strict';

// 扫描器专用的 cell / row 构造函数省去了已由扫描器保证的校验与重复冻结，产出必须与通用构造函数
// 在同一输入下字段、键顺序、取值与冻结状态完全相同。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const {
  createScannedToolboxCell,
  createScannedToolboxRow,
  createToolboxCell,
  createToolboxRow,
  freezeToolboxStyleRef
} = require(path.join(ROOT, 'src/backend/xlsx/model'));

function assertSameModel(actual, expected) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  assert.deepEqual(actual, expected);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.effectiveStyleRef));
}

test('createScannedToolboxCell 与 createToolboxCell 产出一致', () => {
  const styleRef = freezeToolboxStyleRef({ sourceRegistryId: 'reg-1', styleRef: 3 });
  const samples = [
    ['46023', 46023, 'number', '46023', 1, 1900, '#,##0.00', null],
    ['甲', '甲', 'text', '甲', null, 1904, 'General', 'A1&"x"'],
    ['', null, 'blank', '', 2, 1900, '@', null],
    ['1', true, 'boolean', 'TRUE', null, 1900, 'General', ''],
    ['#N/A', '#N/A', 'error', '#N/A', null, 1900, 'General', null]
  ];
  for (const [raw, semantic, cellType, match, styleId, dateSystem, format, formula] of samples) {
    const expected = createToolboxCell({
      rawLexicalValue: raw,
      cachedValue: semantic,
      cellType,
      decodedSemanticValue: semantic,
      matchProjectionValue: match,
      sourceStyleId: styleId,
      effectiveStyleRef: { sourceRegistryId: 'reg-1', styleRef: 3 },
      isExplicitCell: true,
      sourceDateSystem: dateSystem,
      sourceFormat: format,
      sourceFile: 'a.xlsx',
      sourceSheet: 'S',
      rowIndex: 7,
      columnIndex: 2,
      hasFormula: formula !== null,
      formulaLexical: formula
    });
    const actual = createScannedToolboxCell(raw, semantic, cellType, match, styleId, styleRef, dateSystem, format,
      'a.xlsx', 'S', 7, 2, formula);
    assertSameModel(actual, expected);
  }
});

test('createScannedToolboxRow 与 createToolboxRow 对递增单元格产出一致', () => {
  const styleRef = freezeToolboxStyleRef({ sourceRegistryId: 'reg-1', styleRef: 0 });
  const cells = [0, 1, 4].map((columnIndex) => createScannedToolboxCell('1', 1, 'number', '1', null, styleRef, 1900,
    'General', 'a.xlsx', 'S', 3, columnIndex, null));
  const input = { cells: cells.slice(), rowIndex: 3, height: 20, hidden: false, outlineLevel: 1, sourceStyleId: null,
    effectiveStyleRef: styleRef, customFormat: false, sourceFile: 'a.xlsx', sourceSheet: 'S' };
  const expected = createToolboxRow(input);
  const actual = createScannedToolboxRow({ ...input, cells: cells.slice() }, styleRef);
  assertSameModel(actual, expected);
  assert.ok(Object.isFrozen(actual.cells));
});
