'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const legacy = require('../../../../src/backend/xlsx/legacy/streaming-xlsx-reader');
const rich = require('../../../../src/backend/xlsx/rich-workbook');
const { NS, writeFixture } = require('../../../helpers/shared-xlsx-fixture');

test('legacy 兼容旧入口转发同一导出对象与函数', () => {
  const previous = require('../../../../src/backend/pending-import/streaming-xlsx-reader');
  assert.equal(previous, legacy);
  for (const key of Object.keys(previous)) assert.equal(previous[key], legacy[key], key);
  assert.equal(require('../../../../src/backend/pending-import/xlsx-size-preflight'),
    require('../../../../src/backend/xlsx/legacy/entry-size-preflight'));
});

test('legacy 冻结行顺序、连续一基回调行号、列宽和 inline/escape 行值', async (t) => {
  const { file } = await writeFixture(t);
  const rows = [];
  const result = await legacy.readXlsxStreamed(file, (cells, index) => rows.push([index, cells]), { colCount: 3 });
  assert.deepEqual(result, { rowCount: 3, truncated: false });
  assert.deepEqual(rows, [
    [1, ['标题&', '', '']], [2, ['1.23', '甲<乙😀', '']], [3, ['1000', ' 尾& ', '']]
  ]);
  const widths = [];
  await legacy.readXlsxStreamed(file, (cells) => widths.push(cells.length));
  assert.deepEqual(widths, [31, 31, 31]);
});

test('legacy 空 SST 返回 null，存在的富文本 SST 保留字符串数组合同', async () => {
  assert.equal(await legacy.readSharedStrings(new JSZip()), null);
  const zip = new JSZip();
  zip.file('xl/sharedStrings.xml', `<sst xmlns="${NS}"><si><t>标题&amp;</t></si><si><r><t>甲</t></r><r><t>乙&#x1F600;</t></r></si></sst>`);
  const strings = await legacy.readSharedStrings(zip);
  assert.deepEqual(strings, ['标题&', '甲乙😀']);
  assert.deepEqual(legacy.parseRowXml('<row><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>9</v></c></row>', 3, strings), ['甲乙😀', '', '']);
  assert.deepEqual(legacy.parseRowXml('<row><c r="A1" t="s"><v>0</v></c></row>', 1, null), ['']);
});

test('legacy 仅正整数 maxRows 启用截断，等于实际行数仍报告 truncated', async (t) => {
  const { file } = await writeFixture(t);
  for (const maxRows of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity]) {
    const indexes = [];
    assert.deepEqual(await legacy.readXlsxStreamed(file, (_cells, index) => indexes.push(index), { maxRows }),
      { rowCount: 3, truncated: false }, `maxRows=${String(maxRows)}`);
    assert.deepEqual(indexes, [1, 2, 3]);
  }
  for (const maxRows of [1, 3]) {
    const indexes = [];
    assert.deepEqual(await legacy.readXlsxStreamed(file, (_cells, index) => indexes.push(index), { maxRows }),
      { rowCount: maxRows, truncated: true });
    assert.deepEqual(indexes, Array.from({ length: maxRows }, (_, index) => index + 1));
  }
});

test('legacy 同步逐行调用且忽略回调返回的 Promise/thenable', async (t) => {
  const { file } = await writeFixture(t);
  const seen = [];
  let thenCalls = 0;
  const pending = new Promise(() => {});
  const result = await legacy.readXlsxStreamed(file, (_cells, index) => {
    seen.push(index);
    return index === 1 ? pending : { then() { thenCalls += 1; } };
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(thenCalls, 0);
  assert.deepEqual(result, { rowCount: 3, truncated: false });
});

test('同一 XLSX 的 legacy 数字投影与 rich lexical/稀疏行号有意不同', async (t) => {
  const { file } = await writeFixture(t);
  const projected = [];
  await legacy.readXlsxStreamed(file, (cells, index) => projected.push([index, cells[0]]));
  const workbook = await rich.openRichWorkbook(file);
  try {
    const lexical = [];
    await workbook.scan((row) => { lexical.push([row.rowIndex, row.cells[0].rawLexicalValue]); });
    assert.deepEqual(projected, [[1, '标题&'], [2, '1.23'], [3, '1000']]);
    assert.deepEqual(lexical, [[1, '标题&'], [3, '001.2300'], [5, '1e3']]);
  } finally { await workbook.close(); }
});
