'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const {
  openToolboxBiff8Pass
} = require('../../../src/backend/toolbox-format');
const {
  exportToolboxFilter,
  exportToolboxMultiFilters,
  scanToolboxSplitFields,
  ToolboxSplitDuplicateHeaderError,
  ToolboxSplitFieldNotFoundError
} = require('../../../src/main-process/toolbox-format-operations');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-operations-'));
  tempDirs.push(dir);
  return dir;
}

async function createStyledSource(filePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.getColumn(2).width = 28;
  const header = sheet.addRow(['Group', 'LongId', 'BillDate']);
  header.height = 24;
  header.getCell(1).font = { bold: true, color: { argb: 'FFFF0000' } };
  const first = sheet.addRow(['A', '001234567890123456789', new Date(Date.UTC(2026, 6, 1))]);
  first.getCell(2).numFmt = '@';
  first.getCell(2).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' }
  };
  first.getCell(3).numFmt = 'yyyy-mm-dd';
  sheet.addRow(['B', '999999999999999999999', new Date(Date.UTC(2026, 6, 2))])
    .getCell(3).numFmt = 'yyyy-mm-dd';
  await workbook.xlsx.writeFile(filePath);
}

test('字段扫描和单输出共用 matchValue，并保留长编号、日期、样式及布局', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.xlsx');
  const output = path.join(dir, 'output.xlsx');
  await createStyledSource(source);

  const scan = await scanToolboxSplitFields(source);
  assert.deepEqual(scan.headers, ['Group', 'LongId', 'BillDate']);
  assert.deepEqual(scan.valuesByField.Group, ['A', 'B']);

  const result = await exportToolboxFilter({
    filePath: source,
    field: 'Group',
    values: ['A'],
    savePath: output
  });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.inputDataRowCount, 2);
  assert.equal(result.warningSummary.warningCount, 0);
  assert.ok(result.styleStats.actualCounts.cellXfs > 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell('A1').font.bold, true);
  assert.equal(sheet.getCell('A1').font.color.argb, 'FFFF0000');
  assert.equal(sheet.getColumn(2).width, 28);
  assert.equal(sheet.getCell('B2').value, '001234567890123456789');
  assert.equal(sheet.getCell('B2').numFmt, '@');
  assert.equal(sheet.getCell('B2').fill.fgColor.argb, 'FFFFFF00');
  assert.ok(sheet.getCell('C2').value instanceof Date);
  assert.equal(sheet.getCell('C2').numFmt, 'yyyy-mm-dd');
});

test('多输出只扫描一次并为零命中分组生成表头文件', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.xlsx');
  await createStyledSource(source);
  const outputA = path.join(dir, 'a.xlsx');
  const outputEmpty = path.join(dir, 'empty.xlsx');

  const result = await exportToolboxMultiFilters({
    filePath: source,
    groups: [
      {
        outputId: 'group-a',
        fileName: 'a.xlsx',
        field: 'Group',
        values: ['A'],
        savePath: outputA
      },
      {
        outputId: 'group-empty',
        fileName: 'empty.xlsx',
        field: 'Group',
        values: ['C'],
        savePath: outputEmpty
      }
    ]
  });
  assert.deepEqual(
    result.files.map((file) => [file.outputId, file.matchedCount]),
    [['group-a', 1], ['group-empty', 0]]
  );
  assert.equal(result.inputDataRowCount, 2);
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.readFile(outputEmpty);
  assert.equal(emptyWorkbook.worksheets[0].rowCount, 1);
  assert.deepEqual(emptyWorkbook.worksheets[0].getRow(1).values.slice(1), [
    'Group',
    'LongId',
    'BillDate'
  ]);
});

test('多输出任一独立样式预算失败会清理整批 generation 文件', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'budget-source.xlsx');
  const outputA = path.join(dir, 'budget-a.xlsx');
  const outputB = path.join(dir, 'budget-b.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['Group', 'Value']);
  sheet.addRow(['A', 'plain']);
  const styled = sheet.addRow(['B', 'styled']);
  styled.getCell(2).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFF0000' }
  };
  await workbook.xlsx.writeFile(source);

  await assert.rejects(
    exportToolboxMultiFilters({
      filePath: source,
      groups: [
        { outputId: 'a', field: 'Group', values: ['A'], savePath: outputA },
        { outputId: 'b', field: 'Group', values: ['B'], savePath: outputB }
      ],
      budgets: { fills: 2 }
    }),
    /fills/
  );
  assert.equal(fs.existsSync(outputA), false);
  assert.equal(fs.existsSync(outputB), false);
});

test('字段不存在时不保留 generation 文件', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.xlsx');
  const output = path.join(dir, 'missing.xlsx');
  await createStyledSource(source);

  await assert.rejects(
    exportToolboxFilter({
      filePath: source,
      field: 'Missing',
      values: ['x'],
      savePath: output
    }),
    ToolboxSplitFieldNotFoundError
  );
  assert.equal(fs.existsSync(output), false);
});

test('重复表头 fail-closed，避免 split:read 与 export 定位到不同列', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'duplicate-header.xlsx');
  const output = path.join(dir, 'duplicate-output.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['A', 'A']);
  sheet.addRow(['left1', 'right1']);
  sheet.addRow(['left2', 'right2']);
  await workbook.xlsx.writeFile(source);

  await assert.rejects(
    scanToolboxSplitFields(source),
    (error) => {
      assert.ok(error instanceof ToolboxSplitDuplicateHeaderError);
      assert.match(error.message, /重复表头/);
      assert.ok(error.detailLines.some((line) => line.includes('「A」')));
      return true;
    }
  );
  await assert.rejects(
    exportToolboxFilter({
      filePath: source,
      field: 'A',
      values: ['right1'],
      savePath: output
    }),
    ToolboxSplitDuplicateHeaderError
  );
  assert.equal(fs.existsSync(output), false);
});

test('普通拆分扫描保留第 1001 个及之后的既有下拉值，不静默套 Worker 上限', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'ordinary-distinct-values.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['Key']);
  for (let index = 0; index < 1005; index += 1) {
    sheet.addRow([`value-${String(index).padStart(4, '0')}`]);
  }
  await workbook.xlsx.writeFile(source);

  const scan = await scanToolboxSplitFields(source);
  assert.equal(scan.valuesByField.Key.length, 1005);
  assert.equal(scan.valuesByField.Key[1000], 'value-1000');
  assert.equal(scan.valuesByField.Key[1004], 'value-1004');
});

test('__proto__ 表头的下拉值在统一扫描与 IPC 形状中不丢失', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'proto-header.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['__proto__']);
  sheet.addRow(['PAYPAL']);
  await workbook.xlsx.writeFile(source);

  const scan = await scanToolboxSplitFields(source);
  assert.equal(Object.prototype.hasOwnProperty.call(scan.valuesByField, '__proto__'), true);
  assert.deepEqual(scan.valuesByField.__proto__, ['PAYPAL']);
  assert.deepEqual(structuredClone(scan).valuesByField.__proto__, ['PAYPAL']);
});

test('CSV 拆分保持长数字和科学计数字符串为文本', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'source.csv');
  const output = path.join(dir, 'csv-output.xlsx');
  fs.writeFileSync(source, 'Group,LongId,Lexical\nA,001234567890123456789,1E+20\n', 'utf8');

  const result = await exportToolboxFilter({
    filePath: source,
    field: 'Group',
    values: ['A'],
    savePath: output
  });
  assert.equal(result.matchedCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  assert.equal(workbook.worksheets[0].getCell('B2').value, '001234567890123456789');
  assert.equal(workbook.worksheets[0].getCell('C2').value, '1E+20');
});

test('真实 BIFF8 单元格样式通过统一 writer 落到 XLSX', async () => {
  const dir = tempDir();
  const source = path.join(__dirname, '..', '..', '..', 'assets', '外汇交割表.xls');
  const output = path.join(dir, 'biff8-output.xlsx');
  const pass = await openToolboxBiff8Pass(source);
  let sourceStyle;
  try {
    pass.scanSheet(0, {
      onRow: (row) => {
        if (sourceStyle || row.rowIndex !== 2 || row.cells.length === 0) return;
        const styleRef = row.cells[0].effectiveStyleRef;
        sourceStyle = pass.sourceRegistry.get(styleRef.styleRef);
      }
    });
  } finally {
    pass.close();
  }
  assert.ok(sourceStyle);

  const result = await exportToolboxFilter({
    filePath: source,
    field: '即期结售汇交易明细',
    values: ['交易编号'],
    savePath: output
  });
  assert.equal(result.matchedCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const outputCell = workbook.worksheets[0].getCell('A2');
  assert.equal(outputCell.font.name, sourceStyle.font.name);
  assert.equal(!!outputCell.font.bold, !!sourceStyle.font.bold);
  assert.equal(outputCell.numFmt || 'General', sourceStyle.numFmt);
  assert.equal(outputCell.alignment.horizontal || null, sourceStyle.alignment.horizontal);
});

test('split:read 暴露的异构匹配值可由独立 split:export pass 全部重新命中', async () => {
  const dir = tempDir();
  const source = path.join(dir, 'match-roundtrip.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['Key', 'Label']);
  sheet.addRow(['001', 'leading-zero']);
  sheet.addRow([1, 'number']);
  sheet.addRow(['1E+20', 'scientific-text']);
  sheet.addRow([true, 'boolean']);
  sheet.addRow([{ error: '#N/A' }, 'error']);
  const dateRow = sheet.addRow([new Date(Date.UTC(2026, 6, 21)), 'date']);
  dateRow.getCell(1).numFmt = 'yyyy-mm-dd';
  await workbook.xlsx.writeFile(source);

  const scan = await scanToolboxSplitFields(source);
  assert.ok(scan.valuesByField.Key.length >= 6);
  for (let index = 0; index < scan.valuesByField.Key.length; index += 1) {
    const selectedValue = scan.valuesByField.Key[index];
    const output = path.join(dir, `roundtrip-${index}.xlsx`);
    // 每次导出重新打开源文件，验证 UI 值不是只在同一 pass 内偶然命中。
    const result = await exportToolboxFilter({
      filePath: source,
      field: 'Key',
      values: [selectedValue],
      savePath: output,
      outputId: `roundtrip-${index}`
    });
    assert.ok(result.matchedCount >= 1, `匹配值「${selectedValue}」应至少重新命中一行`);
  }
});
