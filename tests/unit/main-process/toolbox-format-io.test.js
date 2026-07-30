'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const {
  TOOLBOX_SHEET_STRATEGIES,
  streamToolboxBiff8Tables,
  streamToolboxTables,
  streamToolboxXlsxTables
} = require('../../../src/main-process/toolbox-format-io');

async function createWorkbookFixture(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-io-'));
  const filePath = path.join(dir, 'fixture.xlsx');
  const workbook = new ExcelJS.Workbook();
  await build(workbook);
  await workbook.xlsx.writeFile(filePath);
  return {
    filePath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createBiff8Fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-io-biff8-'));
  const filePath = path.join(dir, 'fixture.xls');
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ['ID', 'Amount'],
    ['001', 1]
  ]);
  const second = XLSX.utils.aoa_to_sheet([
    ['ID', 'Amount'],
    ['002', 2]
  ]);
  XLSX.utils.book_append_sheet(workbook, first, 'First');
  XLSX.utils.book_append_sheet(workbook, second, 'Second');
  XLSX.writeFile(workbook, filePath, { bookType: 'biff8' });
  return {
    filePath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('merge 跳过隐藏/空 Sheet，并让每个可见非空 Sheet 独立提供表头', async () => {
  const fixture = await createWorkbookFixture(async (workbook) => {
    const empty = workbook.addWorksheet('StyleOnly');
    empty.getCell('A1').font = { bold: true };
    const hidden = workbook.addWorksheet('Hidden');
    hidden.state = 'hidden';
    hidden.addRow(['ID']);
    hidden.addRow(['H']);
    const first = workbook.addWorksheet('First');
    first.addRow([' ID ', 'Amount']);
    first.addRow(['A', 1]);
    const second = workbook.addWorksheet('Second');
    second.addRow(['ID', 'Amount']);
    second.addRow(['B', 2]);
  });
  try {
    const headers = [];
    const values = [];
    const result = await streamToolboxXlsxTables(fixture.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.MERGE,
      onHeader: (info) => headers.push([info.sourceSheet, info.normalizedHeaders]),
      onDataRow: (_row, info) => values.push(info.matchValues)
    });
    assert.deepEqual(headers, [
      ['First', ['ID', 'Amount']],
      ['Second', ['ID', 'Amount']]
    ]);
    assert.deepEqual(values, [['A', '1'], ['B', '2']]);
    assert.equal(result.hiddenSheetCount, 1);
    assert.equal(result.emptySheetCount, 1);
    assert.equal(result.participatingSheetCount, 2);
  } finally {
    fixture.cleanup();
  }
});

test('split 保留隐藏 Sheet 续页语义并跳过重复表头', async () => {
  const fixture = await createWorkbookFixture(async (workbook) => {
    const first = workbook.addWorksheet('First');
    first.addRow(['ID']);
    first.addRow(['A']);
    const hidden = workbook.addWorksheet('Hidden');
    hidden.state = 'veryHidden';
    hidden.addRow(['ID']);
    hidden.addRow(['B']);
    const continuation = workbook.addWorksheet('NoHeader');
    continuation.addRow(['C']);
  });
  try {
    const rows = [];
    let headerCount = 0;
    const result = await streamToolboxXlsxTables(fixture.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      onHeader: () => { headerCount += 1; },
      onDataRow: (_row, info) => rows.push(info.matchValues[0])
    });
    assert.equal(headerCount, 1);
    assert.deepEqual(rows, ['A', 'B', 'C']);
    assert.equal(result.participatingSheetCount, 3);
    assert.equal(result.hiddenSheetCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test('split 的来源 registry 复合引用可在 pass 关闭后由 writer 解码', async () => {
  const fixture = await createWorkbookFixture(async (workbook) => {
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['ID']);
    const row = sheet.addRow(['001']);
    row.getCell(1).font = { bold: true, color: { argb: 'FFFF0000' } };
  });
  try {
    let capturedCell = null;
    const resolver = new Map();
    await streamToolboxXlsxTables(fixture.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      sourceRegistryResolver: resolver,
      onDataRow: (row) => {
        [capturedCell] = row.cells;
      }
    });
    assert.ok(capturedCell);
    const registry = resolver.get(capturedCell.effectiveStyleRef.sourceRegistryId);
    const style = registry.get(capturedCell.effectiveStyleRef.styleRef);
    assert.equal(style.font.bold, true);
    assert.equal(style.font.color.argb, 'FFFF0000');
  } finally {
    fixture.cleanup();
  }
});

test('BIFF8 与 XLSX 共用同一套 split 表头和续页策略', async () => {
  const fixture = createBiff8Fixture();
  try {
    const rows = [];
    let headerCount = 0;
    const result = await streamToolboxBiff8Tables(fixture.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      onHeader: () => { headerCount += 1; },
      onDataRow: (_row, info) => rows.push(info.matchValues)
    });
    assert.equal(headerCount, 1);
    assert.deepEqual(result.normalizedHeaders, ['ID', 'Amount']);
    assert.deepEqual(rows, [['001', '1'], ['002', '2']]);
    assert.equal(result.participatingSheetCount, 2);
  } finally {
    fixture.cleanup();
  }
});

test('统一格式路由让 CSV 使用旧文本匹配值和默认样式', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-io-csv-'));
  const filePath = path.join(dir, 'fixture.csv');
  fs.writeFileSync(filePath, '\uFEFFID,Amount\n001,1E+20\n', 'utf8');
  try {
    const rows = [];
    const resolver = new Map();
    const result = await streamToolboxTables(filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      sourceRegistryResolver: resolver,
      onDataRow: (row, info) => rows.push({
        matchValues: info.matchValues,
        cellTypes: row.cells.map((cell) => cell.cellType)
      })
    });
    assert.deepEqual(result.normalizedHeaders, ['ID', 'Amount']);
    assert.deepEqual(rows, [{
      matchValues: ['001', '1E+20'],
      cellTypes: ['text', 'text']
    }]);
    assert.equal(resolver.size, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
