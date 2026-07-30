'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOLBOX_PROJECTION_PROFILES,
  createToolboxCell,
  createToolboxRow,
  createWarningCollector,
  findToolboxCell,
  projectOutputCell,
  projectToolboxRowValues,
  toMatchValue
} = require('../../src/backend/toolbox-format/model');

function makeCell(overrides = {}) {
  return createToolboxCell({
    rawLexicalValue: '1.00',
    cachedValue: 1,
    cellType: 'number',
    decodedSemanticValue: 1,
    matchProjectionValue: '1',
    sourceStyleId: 0,
    effectiveStyleRef: { sourceRegistryId: 'book-a', styleRef: 0 },
    sourceDateSystem: 1900,
    sourceFormat: 'General',
    sourceFile: '/tmp/source.xlsx',
    sourceSheet: 'Sheet1',
    rowIndex: 2,
    columnIndex: 0,
    ...overrides
  });
}

test.describe('toolbox-format model', () => {
  test('ToolboxRow 使用按列排序的稀疏显式单元格，重复坐标最后一个生效', () => {
    const first = makeCell({ columnIndex: 10, matchProjectionValue: 'ten' });
    const replacement = makeCell({ columnIndex: 10, matchProjectionValue: 'TEN' });
    const far = makeCell({ columnIndex: 16383, matchProjectionValue: 'far' });
    const row = createToolboxRow({
      rowIndex: 2,
      cells: [first, far, replacement],
      sourceFile: '/tmp/source.xlsx',
      sourceSheet: 'Sheet1'
    });
    assert.equal(row.cells.length, 2);
    assert.equal(row.cells[0], replacement);
    assert.equal(findToolboxCell(row, 10), replacement);
    assert.equal(findToolboxCell(row, 1), null);
  });

  test('XLSX matchValue 使用普通工具箱旧路径 projection 后 trim', () => {
    const cell = makeCell({ matchProjectionValue: '  TRUE  ' });
    assert.equal(toMatchValue(cell, TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY), 'TRUE');
    const row = createToolboxRow({ rowIndex: 2, cells: [cell] });
    assert.deepEqual(
      projectToolboxRowValues(row, TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY, 2),
      ['  TRUE  ', '']
    );
  });

  test('输出投影保护长数字，数值日期 1904→1900，公式只用缓存值', () => {
    const longId = makeCell({ rawLexicalValue: '1234567890123456' });
    assert.deepEqual(projectOutputCell(longId), {
      value: '1234567890123456',
      numFmtOverride: '@',
      canonicalValue: '1234567890123456',
      numericFallbackReason: 'precision'
    });

    const date = makeCell({
      rawLexicalValue: '0.5',
      sourceDateSystem: 1904,
      sourceFormat: 'yyyy-mm-dd hh:mm',
      hasFormula: true,
      formulaLexical: 'TODAY()'
    });
    const projected = projectOutputCell(date);
    assert.equal(projected.value, 1462.5);
    assert.equal(projected.canonicalValue, '1462.5');
    assert.equal(projected.numFmtOverride, null);

    const monthOnlyDate = makeCell({
      rawLexicalValue: '0',
      sourceDateSystem: 1904,
      sourceFormat: 'mmm'
    });
    assert.equal(
      projectOutputCell(monthOnlyDate).canonicalValue,
      '1462',
      '单独月份格式也必须触发 1904→1900 日期转换'
    );

    const collector = createWarningCollector();
    const extremeDate = makeCell({
      rawLexicalValue: '1e309',
      sourceFormat: 'yyyy-mm-dd'
    });
    const extremeProjected = projectOutputCell(extremeDate, collector);
    assert.equal(extremeProjected.value, `1${'0'.repeat(309)}`);
    assert.equal(extremeProjected.numFmtOverride, '@');
    assert.equal(extremeProjected.canonicalValue, `1${'0'.repeat(309)}`);
    assert.equal(collector.summary().warningCount, 1);
  });

  test('无效 t=d 降级文本并产生最多 20 条有界 warning', () => {
    const collector = createWarningCollector(20);
    for (let index = 0; index < 25; index += 1) {
      const cell = makeCell({
        cellType: 'date',
        rawLexicalValue: '1899-12-31',
        rowIndex: index + 1,
        columnIndex: 1
      });
      const projected = projectOutputCell(cell, collector);
      assert.equal(projected.value, '1899-12-31');
      assert.equal(projected.numFmtOverride, '@');
    }
    const summary = collector.summary();
    assert.equal(summary.warningCount, 25);
    assert.equal(summary.warningSamples.length, 20);
    assert.equal(summary.warningSamples[0].sourceFileName, 'source.xlsx');
    assert.equal(summary.warningSamples[0].cellRef, 'B1');
  });
});
