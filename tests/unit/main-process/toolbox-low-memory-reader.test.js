'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { openToolboxXlsxPass } = require('../../../src/backend/toolbox-format/xlsx-pass');
const { scanSplitMetadata, scanSplitFieldValues } = require('../../../src/main-process/toolbox-split-scan');
const { scanToolboxSplitFields } = require('../../../src/main-process/toolbox-format-operations');

function fixture(t, rows = [['字段', '备注'], ['甲', '唯一一'], ['', ''], ['乙', '唯一二'], ['甲', '唯一三']]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-low-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'source.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '数据');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([rows[0], ['丙', '隐藏页'].slice(0, rows[0].length)]), '隐藏续页');
  book.Workbook = { Sheets: [{ name: '数据', Hidden: 0 }, { name: '隐藏续页', Hidden: 1 }] };
  XLSX.writeFile(book, filename, { bookSST: true });
  const sstTempRoot = path.join(root, 'owned-sst');
  return { root, filename, sstTempRoot, readerOptions: {
    sharedStringsMode: 'adaptive', sstTempRoot, memoryBudgetBytes: 1, cacheMaxBytes: 128, lruMaxEntries: 2,
    sourceRegistryId: 'test-registry'
  } };
}

test('adaptive Toolbox SST spills and preserves the legacy row content', async (t) => {
  const f = fixture(t);
  const legacy = await openToolboxXlsxPass(f.filename, { sourceRegistryId: 'test-registry' });
  const bounded = await openToolboxXlsxPass(f.filename, f.readerOptions);
  let zipClosed = false;
  bounded.zip.once('close', () => { zipClosed = true; });
  assert.equal(bounded.sharedStrings.mode, 'disk');
  const oldRows = [], newRows = [];
  try {
    await legacy.scanSheets({ onRow: (row) => oldRows.push(row) });
    await bounded.scanSheets({ onRow: (row) => newRows.push(row) });
    assert.deepEqual(newRows, oldRows);
    assert.ok(bounded.sharedStrings.cacheBytes <= 128);
    assert.ok(fs.existsSync(f.sstTempRoot));
  } finally { await legacy.close(); await bounded.close(); }
  assert.equal(fs.existsSync(f.sstTempRoot), false);
  assert.equal(zipClosed, true);
  assert.equal(bounded.close(), bounded.close(), '重复 close 共享同一关闭承诺');
});

test('metadata uses the same exact row count but never returns value sets', async (t) => {
  const f = fixture(t);
  const original = await scanToolboxSplitFields(f.filename);
  const metadata = await scanSplitMetadata(f.filename, { readerOptions: f.readerOptions });
  assert.deepEqual(metadata, { headers: ['字段', '备注'], dataRowCount: 4 });
  assert.equal(metadata.dataRowCount, original.dataRowCount);
  assert.equal(Object.hasOwn(metadata, 'valuesByField'), false);
  assert.equal(fs.existsSync(f.sstTempRoot), false, '返回前已清理 SST');
});

test('single-column/default field can be requested directly and preserves first-seen ordering', async (t) => {
  const f = fixture(t, [['字段'], ['甲'], ['乙'], ['甲']]);
  const result = await scanSplitFieldValues(f.filename, '字段', {
    readerOptions: f.readerOptions, maxValues: 3, maxValueBytes: 1024
  });
  assert.deepEqual(result, { field: '字段', values: ['甲', '乙', '丙'], valuesState: 'complete' });
  assert.equal(fs.existsSync(f.sstTempRoot), false);
});

test('a truly empty field returns a completed empty list', async (t) => {
  const f = fixture(t);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['序号', '空列'], [1, ''], [2, '  ']]), '数据');
  XLSX.writeFile(book, f.filename, { bookSST: true });
  assert.deepEqual(await scanSplitFieldValues(f.filename, '空列', {
    readerOptions: f.readerOptions, maxValues: 1, maxValueBytes: 64
  }), { field: '空列', values: [], valuesState: 'complete' });
});

test('value limits fail explicitly without returning a truncated success or retaining SST', async (t) => {
  const f = fixture(t);
  for (const limits of [{ maxValues: 2, maxValueBytes: 1024 }, { maxValues: 100, maxValueBytes: 1 }]) {
    await assert.rejects(scanSplitFieldValues(f.filename, '字段', { readerOptions: f.readerOptions, ...limits }),
      { code: 'TOOLBOX_SPLIT_VALUES_BUDGET_EXCEEDED' });
    assert.equal(fs.existsSync(f.sstTempRoot), false);
  }
});

test('failed field lookup and cancelled scans close owned resources', async (t) => {
  const f = fixture(t);
  await assert.rejects(scanSplitFieldValues(f.filename, '不存在', {
    readerOptions: f.readerOptions, maxValues: 100, maxValueBytes: 1024
  }), { name: 'ToolboxSplitFieldNotFoundError' });
  assert.equal(fs.existsSync(f.sstTempRoot), false);
  await assert.rejects(scanSplitMetadata(f.filename, {
    readerOptions: f.readerOptions, cancelToken: { cancelled: true }
  }));
  assert.equal(fs.existsSync(f.sstTempRoot), false);
});

test('new reader requires explicit budgets and cannot widen metadata safety limits', async (t) => {
  const f = fixture(t);
  await assert.rejects(openToolboxXlsxPass(f.filename, { sharedStringsMode: 'adaptive' }), TypeError);
  await assert.rejects(openToolboxXlsxPass(f.filename, { ...f.readerOptions, metadataLimits: { styles: Infinity } }), TypeError);
  await assert.rejects(openToolboxXlsxPass(f.filename, { ...f.readerOptions, metadataLimits: { workbook: 1 } }),
    { code: 'TOOLBOX_XLSX_METADATA_TOO_LARGE' });
  assert.equal(fs.existsSync(f.sstTempRoot), false);
});

test('foreign files prevent cleanup success and remain available for owner recovery', async (t) => {
  const f = fixture(t);
  const pass = await openToolboxXlsxPass(f.filename, f.readerOptions);
  let zipClosed = false;
  pass.zip.once('close', () => { zipClosed = true; });
  const foreign = path.join(f.sstTempRoot, 'unowned.txt');
  fs.writeFileSync(foreign, '保留');
  await assert.rejects(pass.close(), { name: 'AggregateError' });
  assert.equal(zipClosed, true, 'SST 清理失败也必须关闭 ZIP');
  assert.equal(fs.readFileSync(foreign, 'utf8'), '保留');
  await assert.rejects(pass.close(), { name: 'AggregateError' });
});

test('an existing SST directory is never adopted or recursively deleted', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.sstTempRoot);
  fs.writeFileSync(path.join(f.sstTempRoot, 'keep'), 'existing');
  await assert.rejects(openToolboxXlsxPass(f.filename, f.readerOptions));
  assert.equal(fs.readFileSync(path.join(f.sstTempRoot, 'keep'), 'utf8'), 'existing');
});
