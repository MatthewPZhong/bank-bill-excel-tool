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

// v3.2.22 R20：有的导出工具追加行后不更新工作表声明的范围（dimension），读取结果只到声明范围为止；表头以下的非空行数
//   （rowsBelowHeader，网银账单据此区分「原表只有表头」）把声明范围以外仍有内容的行计入，不把这类文件判为只有表头
test('声明范围只到表头：范围以外仍有内容的行计入表头以下的非空行数；范围以外只有空白文本的行不计入', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readers-out-of-range-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, rows, dimension) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
    const text = Buffer.from(entry.content).toString('utf8');
    assert.match(text, /<dimension ref="[^"]+"\/>/);
    entry.content = Buffer.from(text.replace(/<dimension ref="[^"]+"\/>/, `<dimension ref="${dimension}"/>`), 'utf8');
    entry.size = entry.content.length;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
    return filePath;
  };
  const rows = [['日期', '收入'], ['2026-11-01', '100'], ['2026-11-02', '200']];
  const stale = readRowsWithMetadata(write('stale.xlsx', rows, 'A1:B1'), ['日期', '收入']);
  assert.deepEqual([stale.rows, stale.rowsBelowHeader], [[['日期', '收入']], 2]);
  // 数据只在声明范围以外的列（C 列）
  const sideways = readRowsWithMetadata(write('sideways.xlsx', [['日期', '收入'], ['', '', '备注']], 'A1:B2'), ['日期', '收入']);
  assert.equal(sideways.rowsBelowHeader, 1);
  // 声明范围以外只有空白文本：仍按只有表头
  const blank = readRowsWithMetadata(write('blank.xlsx', [['日期', '收入'], ['  ', '']], 'A1:B1'), ['日期', '收入']);
  assert.equal(blank.rowsBelowHeader, 0);
  // 范围正确时照常计数，不重复计入
  assert.equal(readRowsWithMetadata(write('normal.xlsx', rows, 'A1:B3'), ['日期', '收入']).rowsBelowHeader, 2);
});
