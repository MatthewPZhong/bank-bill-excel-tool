'use strict';

// v3.2.19：工作表有效范围不从第 1 行开始（前几行完全为空）时，readRowsWithMetadata 的行号仍是 Excel 中的物理行号
//   （重复账单提醒、去除行号、各类逐行提示与分段识别都按同一行号）；includeFullRows 另给含模板范围以外列的整行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { readRowsWithMetadata, readRows } = require('../../../../src/backend/file-service/readers');

function writeSheetAt(t, origin, rows, ref = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readers-physical-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'offset.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet(rows, { origin });
  if (ref) sheet['!ref'] = ref;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('有效范围从 A5 开始：表头在第 5 行，数据行号为 6、7（物理行号）', (t) => {
  const filePath = writeSheetAt(t, 'A5', [['日期', '收入', '流水号'], ['2026-11-01', '100', 'TX1'], ['2026-11-01', '100', 'TX2']], 'A5:C7');
  let rawRows = null;
  const result = readRowsWithMetadata(filePath, ['日期', '收入'], { onWorkbookRows: (rows) => { rawRows = rows; } });
  assert.deepEqual(result.rowNumbers, [5, 6, 7]);
  // 只记起始行偏移，不为有效范围之前的空行创建数组
  assert.deepEqual([rawRows.length, rawRows.firstRowNumber], [3, 5]);
  assert.deepEqual(result.rows, [['日期', '收入'], ['2026-11-01', '100'], ['2026-11-01', '100']]);
  assert.equal(result.fullRows, undefined, '默认不返回整行');
  const withFull = readRowsWithMetadata(filePath, ['日期', '收入'], { includeFullRows: true });
  // 整行末尾另附该行在工作表 XML 中的原文（查重按原文比较）
  assert.deepEqual(withFull.fullRows.map((row) => row.filter((cell) => typeof cell === 'string')),
    [['日期', '收入', '流水号'], ['2026-11-01', '100', 'TX1'], ['2026-11-01', '100', 'TX2']]);
  assert.ok(withFull.fullRows.every((row) => typeof row[row.length - 1].sourceText === 'string'));
});

test('有效范围从 C3 开始：列偏移不影响取值，行号仍为物理行号；不保留空行的读取不变', (t) => {
  const filePath = writeSheetAt(t, 'C3', [['日期', '收入'], ['2026-11-02', '30']], 'C3:D4');
  assert.deepEqual(readRowsWithMetadata(filePath, ['日期', '收入']).rowNumbers, [3, 4]);
  assert.deepEqual(readRows(filePath), [['日期', '收入'], ['2026-11-02', '30']]);
});
