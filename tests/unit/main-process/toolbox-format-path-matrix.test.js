'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const {
  exportToolboxFilter,
  exportToolboxMultiFilters,
  scanToolboxSplitFields
} = require('../../../src/main-process/toolbox-format-operations');
const {
  mergeToolboxFilesToXlsx
} = require('../../../src/main-process/toolbox-merge-io');

async function createSources(dir) {
  const rows = [
    ['Group', 'LongId'],
    ['A', '001234567890123456789'],
    ['B', '999999999999999999999']
  ];
  const xlsxPath = path.join(dir, 'source.xlsx');
  const xlsxBook = new ExcelJS.Workbook();
  const xlsxSheet = xlsxBook.addWorksheet('Data');
  rows.forEach((row) => xlsxSheet.addRow(row));
  xlsxSheet.getCell('B2').numFmt = '@';
  await xlsxBook.xlsx.writeFile(xlsxPath);

  const xlsPath = path.join(dir, 'source.xls');
  const xlsBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xlsBook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  XLSX.writeFile(xlsBook, xlsPath, { bookType: 'biff8' });

  const csvPath = path.join(dir, 'source.csv');
  fs.writeFileSync(
    csvPath,
    'Group,LongId\nA,001234567890123456789\nB,999999999999999999999\n',
    'utf8'
  );
  return [
    ['xlsx', xlsxPath],
    ['xls', xlsPath],
    ['csv', csvPath]
  ];
}

async function readWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

test('XLSX/BIFF8/CSV × merge/单输出/多输出/分页路径矩阵行数与长编号守恒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-matrix-'));
  try {
    const sources = await createSources(dir);
    for (const [kind, source] of sources) {
      const scan = await scanToolboxSplitFields(source);
      assert.deepEqual(scan.headers, ['Group', 'LongId'], `${kind} scan 表头`);
      assert.deepEqual(scan.valuesByField.Group, ['A', 'B'], `${kind} scan 匹配值`);

      const mergePath = path.join(dir, `${kind}-merge.xlsx`);
      const merge = await mergeToolboxFilesToXlsx({
        filePaths: [source],
        savePath: mergePath
      });
      assert.equal(merge.dataRowCount, 2, `${kind} merge 行数`);
      const mergedBook = await readWorkbook(mergePath);
      assert.equal(
        mergedBook.worksheets[0].getCell('B2').value,
        '001234567890123456789',
        `${kind} merge 长编号`
      );

      const singlePath = path.join(dir, `${kind}-single.xlsx`);
      const single = await exportToolboxFilter({
        filePath: source,
        field: 'Group',
        values: ['A'],
        savePath: singlePath
      });
      assert.equal(single.matchedCount, 1, `${kind} single 命中`);
      const singleBook = await readWorkbook(singlePath);
      assert.equal(singleBook.worksheets[0].getCell('B2').value, '001234567890123456789');

      const multiA = path.join(dir, `${kind}-multi-a.xlsx`);
      const multiB = path.join(dir, `${kind}-multi-b.xlsx`);
      const multi = await exportToolboxMultiFilters({
        filePath: source,
        groups: [
          { outputId: `${kind}-a`, field: 'Group', values: ['A'], savePath: multiA },
          { outputId: `${kind}-b`, field: 'Group', values: ['B'], savePath: multiB }
        ]
      });
      assert.deepEqual(multi.files.map((file) => file.matchedCount), [1, 1], `${kind} multi`);

      const pagedPath = path.join(dir, `${kind}-paged.xlsx`);
      const paged = await exportToolboxFilter({
        filePath: source,
        field: 'Group',
        values: ['A', 'B'],
        savePath: pagedPath,
        maxRowsPerSheet: 1
      });
      assert.equal(paged.matchedCount, 2, `${kind} paged 行数`);
      assert.equal(paged.sheetCount, 2, `${kind} 自动分页`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
