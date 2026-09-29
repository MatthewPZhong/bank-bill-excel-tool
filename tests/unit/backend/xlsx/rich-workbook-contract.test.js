'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const richPath = require.resolve('../../../../src/backend/xlsx/rich-workbook');
const { openRichWorkbook, openSingleSheetRichWorkbook } = require(richPath);
const { NS, writeFixture } = require('../../../helpers/shared-xlsx-fixture');

test('rich 兼容旧入口转发同一导出对象与函数', () => {
  const previous = require('../../../../src/backend/xlsx-rich-reader');
  assert.equal(previous, require(richPath));
  assert.equal(previous.openRichWorkbook, openRichWorkbook);
  assert.equal(previous.openSingleSheetRichWorkbook, openSingleSheetRichWorkbook);
});

test('rich 单页入口将隐藏页计入声明页数，先于损坏 styles/SST 拒绝', async (t) => {
  const { file } = await writeFixture(t, {
    sheets: [{ name: '可见页' }, { name: '隐藏页', state: 'hidden' }], styles: '<broken', sst: '<broken'
  });
  await assert.rejects(openSingleSheetRichWorkbook(file), {
    code: 'RICH_XLSX_WORKBOOK_INVALID', message: '每个输入文件必须恰好声明一个工作表（包含隐藏页）'
  });
});

test('rich 保留声明 sheet 顺序、隐藏状态、1904 日期系统及原始数字 lexical', async (t) => {
  const { file } = await writeFixture(t, {
    date1904: true,
    sheets: [
      { name: '先声明', target: 'worksheets/sheet2.xml', rows: '<row r="2"><c r="A2"><v>001.2300</v></c></row>' },
      { name: '隐藏页', target: 'worksheets/sheet1.xml', state: 'veryHidden', rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>隐藏内容</t></is></c></row>' }
    ]
  });
  const workbook = await openRichWorkbook(file);
  try {
    assert.equal(Object.isFrozen(workbook), true);
    assert.equal(Object.isFrozen(workbook.sheets), true);
    assert.equal(workbook.date1904, true);
    assert.deepEqual(workbook.sheets.map((sheet) => [sheet.name, sheet.state, sheet.entryPath]), [
      ['先声明', 'visible', 'xl/worksheets/sheet2.xml'], ['隐藏页', 'veryHidden', 'xl/worksheets/sheet1.xml']
    ]);
    const rows = [], metas = [], lexical = [];
    await workbook.scanSheet(0, (row) => { rows.push(row); }, (meta) => { metas.push(meta); },
      (cell, raw) => { lexical.push([cell.rawLexicalValue, raw.body]); });
    await workbook.scanSheet(1, (row) => { rows.push(row); });
    assert.deepEqual(rows.map((row) => [row.sourceSheet, row.rowIndex, row.cells[0].rawLexicalValue]), [
      ['先声明', 2, '001.2300'], ['隐藏页', 1, '隐藏内容']
    ]);
    assert.equal(rows[0].cells[0].sourceDateSystem, 1904);
    assert.equal(metas[0].date1904, true);
    assert.deepEqual(lexical, [['001.2300', '<v>001.2300</v>']]);
  } finally { await workbook.close(); }
});

test('rich 拒绝重复目标、外部目标、缺失关系和缺失 worksheet', async (t) => {
  const cases = [
    { label: '重复目标', sheets: [{ name: '一' }, { name: '二' }], relationships: [{ id: 'rId1', target: 'worksheets/sheet1.xml' }, { id: 'rId2', target: 'worksheets/sheet1.xml' }] },
    { label: '外部目标', relationships: [{ id: 'rId1', target: 'https://example.invalid/sheet.xml', mode: 'External' }] },
    { label: '缺失关系', relationships: [] },
    { label: '缺失 worksheet', relationships: [{ id: 'rId1', target: 'worksheets/missing.xml' }] }
  ];
  for (const sample of cases) await t.test(sample.label, async (t) => {
    const { file } = await writeFixture(t, sample);
    await assert.rejects(openRichWorkbook(file), { code: 'RICH_XLSX_WORKBOOK_INVALID', message: '工作表关系无效、重复或目标不存在' });
  });
});

test('rich 重复 relationship Id 保留原解析错误类型和 code', async (t) => {
  const { file } = await writeFixture(t, { relationships: [
    { id: 'rId1', target: 'worksheets/sheet1.xml' }, { id: 'rId1', target: 'worksheets/sheet1.xml' }
  ] });
  const { ToolboxXlsxFormatError } = require('../../../../src/backend/xlsx/xlsx-sheet-scanner');
  const previous = require('../../../../src/backend/toolbox-format/xlsx-sheet-scanner');
  assert.equal(previous.ToolboxXlsxFormatError, ToolboxXlsxFormatError);
  await assert.rejects(openRichWorkbook(file), (error) => error instanceof ToolboxXlsxFormatError
    && error.name === 'ToolboxXlsxFormatError' && error.code === 'TOOLBOX_XLSX_FORMAT_INVALID'
    && error.message === 'workbook.xml.rels 包含重复的关系 Id：rId1');
});

test('rich maxSheets 保留 1..4096 安全整数预算校验', async (t) => {
  for (const maxSheets of [0, -1, 1.5, '1', NaN, Infinity, 4097, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(openRichWorkbook('无需打开的路径.xlsx', { maxSheets }), {
      code: 'RICH_XLSX_WORKBOOK_INVALID', message: '工作表读取预算非法'
    });
  }
  const { file } = await writeFixture(t, { sheets: [{ name: '一' }, { name: '二' }] });
  await assert.rejects(openRichWorkbook(file, { maxSheets: 1 }), {
    code: 'RICH_XLSX_WORKBOOK_INVALID', message: '工作表数量超出读取预算'
  });
  for (const maxSheets of [undefined, null, 2, 4096]) {
    const workbook = await openRichWorkbook(file, { maxSheets });
    await workbook.close();
  }
});

test('rich 不接受其他 workbook 的样式引用', async (t) => {
  const { file } = await writeFixture(t);
  const first = await openRichWorkbook(file), second = await openRichWorkbook(file);
  try {
    let cell;
    await first.scan((row) => { cell ||= row.cells[0]; });
    assert.ok(first.getCellStyle(cell));
    assert.throws(() => second.getCellStyle(cell), { code: 'RICH_XLSX_WORKBOOK_INVALID', message: '单元格样式不属于当前工作簿' });
    assert.throws(() => first.getCellStyle({}), { code: 'RICH_XLSX_WORKBOOK_INVALID' });
  } finally { await first.close(); await second.close(); }
});

test('rich 拒绝并发 scan、非法页和 close 后 scan，close 缓存同一 Promise', async (t) => {
  const { file } = await writeFixture(t);
  const workbook = await openRichWorkbook(file);
  try {
    const first = workbook.scan(() => {});
    await assert.rejects(workbook.scan(() => {}), { code: 'RICH_XLSX_WORKBOOK_INVALID' });
    await first;
    for (const index of [-1, 1, 1.5]) await assert.rejects(workbook.scanSheet(index, () => {}), { code: 'RICH_XLSX_WORKBOOK_INVALID' });
    await workbook.scan(() => {});
    const closed = workbook.close();
    assert.equal(workbook.close(), closed);
    await closed;
    assert.equal(workbook.close(), closed);
    await assert.rejects(workbook.scan(() => {}), { code: 'RICH_XLSX_WORKBOOK_INVALID' });
  } finally { await workbook.close(); }
});

test('rich 各原有同步 callback 返回 thenable 按原 TypeError 拒绝且不等待', async (t) => {
  for (const callback of ['onRow', 'onCellLexical', 'onSheetMeta']) await t.test(callback, async (t) => {
    const { file } = await writeFixture(t);
    const workbook = await openRichWorkbook(file);
    let thenCalls = 0;
    const thenable = { then() { thenCalls += 1; } };
    try {
      const scan = callback === 'onRow' ? workbook.scan(() => thenable)
        : callback === 'onSheetMeta' ? workbook.scanSheet(0, () => {}, () => thenable)
          : workbook.scanSheet(0, () => {}, undefined, () => thenable);
      await assert.rejects(scan, (error) => error instanceof TypeError && error.message === (callback === 'onCellLexical'
        ? 'onCellLexical 必须是同步回调' : `scanXlsxSheet 的 ${callback} 必须是同步回调`));
      assert.equal(thenCalls, 0);
      const rows = [];
      await workbook.scan((row) => { rows.push(row); });
      assert.equal(rows.length, 3, '失败扫描结束后应恢复顺序扫描能力');
    } finally { await workbook.close(); }
  });
});

test('rich SST 构建失败清理已溢出的私有目录', async (t) => {
  const { file, dir } = await writeFixture(t, {
    sst: `<sst xmlns="${NS}"><si><t>溢出内容</t></si><si><t>未闭合`
  });
  const sstTempRoot = path.join(dir, 'sst');
  await assert.rejects(openRichWorkbook(file, { sstTempRoot, memoryBudgetBytes: 1 }));
  assert.equal(fs.existsSync(sstTempRoot), false);
  assert.equal(fs.existsSync(file), true);
});

test('rich 扫描中取消保留原取消错误，并在 caller await close 后清理 spill', async (t) => {
  const { file, dir } = await writeFixture(t, { sst: `<sst xmlns="${NS}"><si><t>溢出内容</t></si></sst>` });
  const sstTempRoot = path.join(dir, 'sst'), cancelToken = { cancelled: false };
  const workbook = await openRichWorkbook(file, { sstTempRoot, memoryBudgetBytes: 1, cancelToken });
  assert.equal(workbook.sharedStrings.mode, 'disk');
  try {
    await assert.rejects(workbook.scan(() => { cancelToken.cancelled = true; }), {
      name: 'ToolboxXlsxCancelledError', code: 'TOOLBOX_XLSX_CANCELLED'
    });
    assert.equal(fs.existsSync(sstTempRoot), true, '扫描取消不冒充 caller 的关闭职责');
  } finally { await workbook.close(); }
  assert.equal(fs.existsSync(sstTempRoot), false);
});

// 只替换资源获取边界，执行实际 rich close/catch 代码；故障不污染全局 require.cache。
function richWithFaults({ constructionError, sstCloseError, zipCloseError } = {}) {
  const events = [];
  const zip = new EventEmitter();
  zip.reader = { closed: false };
  zip.close = () => {
    events.push('zip');
    if (zipCloseError) throw zipCloseError;
    zip.reader.closed = true;
    zip.emit('close');
  };
  const sharedStrings = { async close() { events.push('sst'); if (sstCloseError) throw sstCloseError; } };
  const module = new Module(richPath, require.cache[__filename]);
  module.filename = richPath;
  module.paths = Module._nodeModulePaths(path.dirname(richPath));
  const nativeRequire = module.require.bind(module);
  module.require = (id) => {
    if (id.endsWith('/zip-reader')) return {
      WORKBOOK_ENTRY_NAME: 'book', WORKBOOK_RELS_ENTRY_NAME: 'rels',
      async openZipWithEntries() { return { zip, entries: new Map([['book', 'book'], ['rels', 'rels'], ['sheet', 'sheet']]) }; }
    };
    if (id.endsWith('/xlsx-pass') || id.endsWith('/workbook-parts')) return {
      TOOLBOX_XLSX_METADATA_LIMITS: {},
      async readToolboxMetadataEntryAsString() { return ''; },
      parseWorkbookXml() { if (constructionError) throw constructionError; return { sheets: [{ relationshipId: 'r1', name: '数据' }], date1904: false }; },
      parseWorkbookRelationships() { return new Map([['r1', { target: 'sheet', type: 'worksheet' }]]); },
      relationshipTypeAllowed() { return true; }, findRelationshipEntry() { return null; }
    };
    if (id.endsWith('/shared-strings-provider')) return { async loadSharedStringsProvider() { return sharedStrings; } };
    return nativeRequire(id);
  };
  module._compile(fs.readFileSync(richPath, 'utf8'), richPath);
  return { api: module.exports, events };
}

test('rich 关闭先 SST 后 ZIP，双失败汇总真实错误并缓存 rejected Promise', async () => {
  const sstError = new Error('sst close fault'), zipError = new Error('zip close fault');
  const { api, events } = richWithFaults({ sstCloseError: sstError, zipCloseError: zipError });
  const workbook = await api.openRichWorkbook('fixture.xlsx');
  const promise = workbook.close();
  assert.equal(workbook.close(), promise);
  const check = (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [sstError, zipError]);
    assert.equal(error.message, 'XLSX 读取资源关闭未确认');
    return true;
  };
  await assert.rejects(promise, check);
  assert.equal(workbook.close(), promise);
  await assert.rejects(workbook.close(), check);
  assert.deepEqual(events, ['sst', 'zip']);
});

test('rich 构建失败仍关闭 ZIP，关闭再次失败保留原 cause 和 AggregateError', async () => {
  const original = new Error('metadata fault'), closeError = new Error('zip close fault');
  const { api, events } = richWithFaults({ constructionError: original, zipCloseError: closeError });
  await assert.rejects(api.openRichWorkbook('fixture.xlsx'), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, '工作簿读取失败且资源关闭未确认');
    assert.equal(error.cause, original);
    assert.equal(error.errors[0], original);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors, [closeError]);
    return true;
  });
  assert.deepEqual(events, ['zip']);
});
