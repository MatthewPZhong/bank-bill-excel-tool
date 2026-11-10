'use strict';

// scanXlsxSheet 的行 / 单元格快路径只是逐事件路径的提速：同一工作表、任意切块方式下，
// 开启与关闭快路径（内部选项 fastPath: false）得到的行模型、汇总与首个错误必须完全一致。
// rowCallbackLimit 只限定 onRow 次数，不改变解析、校验与计数。

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { scanXlsxSheet } = require('../../../../src/backend/xlsx/xlsx-sheet-scanner');
const { SourceStyleRegistry } = require('../../../../src/backend/xlsx/style-registry');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function registry() {
  const r = new SourceStyleRegistry('fast-path-test');
  r.bindXf(0, {});
  r.bindXf(1, { numFmt: '#,##0.00' });
  r.bindXf(2, { numFmt: 'yyyy-mm-dd', font: { bold: true } });
  return r;
}

async function scan(xml, { chunkSize, fastPath = true, rowCallbackLimit, onCellLexical } = {}) {
  const bytes = Buffer.from(xml, 'utf8');
  const chunks = [];
  for (let index = 0; index < bytes.length; index += chunkSize) chunks.push(bytes.subarray(index, index + chunkSize));
  const rows = [];
  try {
    const summary = await scanXlsxSheet({
      zip: { openReadStream(_entry, callback) { callback(null, Readable.from(chunks)); } },
      sheetEntry: { fileName: 'xl/worksheets/sheet1.xml' },
      sheet: { name: 'S', sheetIndex: 0, state: 'visible' },
      sourceFile: 'fixture.xlsx',
      sourceRegistry: registry(),
      sharedStrings: ['甲', ' 乙 ', ''],
      onRow: (row) => rows.push(row),
      ...(fastPath ? {} : { fastPath: false }),
      ...(rowCallbackLimit ? { rowCallbackLimit } : {}),
      ...(onCellLexical ? { onCellLexical } : {})
    });
    return { summary, rows };
  } catch (error) {
    return { rows: rows.length, error: { name: error.name, code: error.code, message: error.message, context: error.context } };
  }
}

function sheet(rowsXml, { root = `<worksheet xmlns="${NS}" xmlns:x14ac="urn:x14ac">`, close = '</worksheet>' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>${root}<cols><col min="1" max="2" width="9" style="1"/></cols>` +
    `<sheetData>${rowsXml}</sheetData>${close}`;
}

async function assertSameWithAndWithoutFastPath(xml, label) {
  for (const chunkSize of [1, 3, 7, 64, Number.MAX_SAFE_INTEGER]) {
    const fast = await scan(xml, { chunkSize });
    const slow = await scan(xml, { chunkSize, fastPath: false });
    assert.deepEqual(fast, slow, `${label} / chunk ${chunkSize}`);
  }
}

const CASES = [
  // 常见形态：共享字符串、数值、样式、自闭合、乱序、缺省坐标、单引号、多空白
  '<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>3134.16</v></c><c r="C1" s="2"/></row>' +
    '<row r="2"><c r="C2" t="str"><v>文本_x000D_</v></c><c r="A2"><v>-0.5</v></c><c t="b"><v>1</v></c></row>' +
    "<row r='4' ht=\"15.75\" customHeight=\"1\">\n  <c\tr='a4'  s=\"1\" ><v>00012</v></c>\n</row>",
  '<row><c><v>1</v></c><c><v>2</v></c></row><row s="2" customFormat="1"><c r="B2"><v>1e3</v></c><c r="D2" t="e"><v>#N/A</v></c></row>',
  '<row r="1"><c r="A1" t="d"><v>2026-01-02T03:04:05</v></c><c r="B1" t="n"/><c r="C1" t="str"><v></v></c></row>',
  // 需要回退或报错的近邻形态
  '<row r="1"><c r="A1" t="s"><v>9</v></c></row>',
  '<row r="1"><c r="A1"><v>a&amp;b</v></c></row>',
  '<row r="1"><c r="A1" t="inlineStr"><v>x</v></c></row>',
  '<row r="1"><c r="A2"><v>1</v></c></row>',
  '<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
  '<row r="1"><c R="A1"><v>1</v></c></row>',
  '<row r="1"><c r="A1" r="B1"><v>1</v></c></row>',
  '<row r="1"><c r="A1" s="9"><v>1</v></c></row>',
  '<row r="1"><c r="ß1"><v>1</v></c></row>',
  '<row r="1"><c r="A1"><v><![CDATA[1]]></v></c></row>',
  '<row r="1"><c r="A1"><f>B1</f><v>1</v></c></row>',
  '<row r="1"><c r="A1"><v>1</v></c ></row>',
  '<row r="1"><c r="A1"r="B1"><v>1</v></c></row>',
  `<row r="1"><c r="A1"><v>${'x'.repeat(5000)}</v></c></row>`,
  '<row r="1" R="1"><c r="A1"><v>1</v></c></row>',
  '<row r="1" customformat="1"><c r="A1"><v>1</v></c></row>',
  '<row r="1" z:foo="1"><c r="A1"><v>1</v></c></row>',
  '<row r="1" r="2"><c r="A2"><v>1</v></c></row>',
  `<row r="1" xmlns="${NS}"><c r="A1"><v>1</v></c></row>`,
  '<row r="1" xmlns="urn:other"><c r="A1"><v>1</v></c></row>',
  '<row r="2"><c r="A2"><v>1</v></c></row><row r="1"><c r="A1"><v>1</v></c></row>',
  '<row r="1"><c r="A1"><v>1</v></c><row r="2"></row></row>',
  '<row r="1"/><row r="2"><c r="XFD2"><v>1</v></c><c><v>2</v></c></row>'
];

test('快路径开启 / 关闭对常见与近邻形态的结果一致（含任意切块）', async () => {
  for (let index = 0; index < CASES.length; index += 1) {
    await assertSameWithAndWithoutFastPath(sheet(CASES[index]), `case ${index}`);
  }
  await assertSameWithAndWithoutFastPath(
    `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row>` +
      '</x:sheetData></x:worksheet>',
    'prefixed'
  );
});

test('快路径开启 / 关闭对固定种子随机工作表的结果一致', async () => {
  let seed = 20261110;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  for (let iteration = 0; iteration < 150; iteration += 1) {
    let rowsXml = '';
    let rowIndex = 0;
    for (let r = 0, rows = 1 + Math.floor(random() * 4); r < rows; r += 1) {
      rowIndex += 1 + (random() < 0.2 ? 1 : 0);
      rowsXml += `<row r="${rowIndex}"${pick(['', ' spans="1:4"', ' s="2" customFormat="1"', ' ht="20" customHeight="1"', ' hidden="1"'])}>`;
      for (let c = 0, cells = Math.floor(random() * 5); c < cells; c += 1) {
        const ref = `${String.fromCharCode(65 + c)}${rowIndex}`;
        rowsXml += pick([
          `<c r="${ref}" t="s"><v>${pick(['0', '1', '2', '3'])}</v></c>`,
          `<c r="${ref}" s="${pick(['0', '1', '2', '5'])}"><v>${pick(['46023', '3134.16', '-0.5', '1E-7', '123456789012345678', 'x'])}</v></c>`,
          `<c r="${ref}" t="str"><v>${pick(['abc', '中文', '_x0041_', ''])}</v></c>`,
          `<c r="${ref}" s="1"/>`,
          `<c r="${ref}" t="${pick(['b', 'e', 'd'])}"><v>${pick(['1', '#N/A', '2026-01-02'])}</v></c>`
        ]);
      }
      rowsXml += '</row>';
    }
    const xml = sheet(rowsXml);
    const chunkSize = pick([1, 2, 5, 16, 1000]);
    const fast = await scan(xml, { chunkSize });
    const slow = await scan(xml, { chunkSize, fastPath: false });
    assert.deepEqual(fast, slow, `iteration ${iteration}: ${xml}`);
  }
});

test('rowCallbackLimit 只限定 onRow 次数，后续行照常校验、计数并报错', async () => {
  const xml = sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>' +
    '<row r="3"><c r="A3"><v>2</v></c><c r="B3"><v>3</v></c></row>');
  const full = await scan(xml, { chunkSize: 7 });
  const limited = await scan(xml, { chunkSize: 7, rowCallbackLimit: 1 });
  assert.deepEqual(limited.summary, full.summary);
  assert.equal(full.rows.length, 3);
  assert.deepEqual(limited.rows, full.rows.slice(0, 1));

  const broken = sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>7</v></c></row>');
  const brokenFull = await scan(broken, { chunkSize: 5 });
  const brokenLimited = await scan(broken, { chunkSize: 5, rowCallbackLimit: 1 });
  assert.deepEqual(brokenLimited.error, brokenFull.error);
  assert.equal(brokenLimited.error.message, '共享字符串索引越界或无效，无法安全读取单元格');

  await assert.rejects(scanXlsxSheet({ rowCallbackLimit: 0 }), TypeError);
});

test('生效样式缓存按实际样式引用去重，不随行 / 单元格 XF 组合增长', async () => {
  const sourceRegistry = new SourceStyleRegistry('style-cache-test');
  // 21 个 XF 内容相同，注册表去重后只有一个实际样式引用
  for (let xf = 0; xf <= 20; xf += 1) sourceRegistry.bindXf(xf, { numFmt: '0.00' });
  let compoundRefCalls = 0;
  const compoundRef = sourceRegistry.compoundRef.bind(sourceRegistry);
  sourceRegistry.compoundRef = (styleRef) => {
    compoundRefCalls += 1;
    return compoundRef(styleRef);
  };
  let rowsXml = '';
  for (let r = 1; r <= 40; r += 1) {
    rowsXml += `<row r="${r}" s="${1 + (r % 20)}" customFormat="1">`;
    for (let c = 0; c < 20; c += 1) rowsXml += `<c r="${String.fromCharCode(65 + c)}${r}" s="${1 + ((r + c) % 20)}"><v>${c}</v></c>`;
    rowsXml += '</row>';
  }
  const rows = [];
  await scanXlsxSheet({
    zip: { openReadStream(_entry, callback) { callback(null, Readable.from([Buffer.from(sheet(rowsXml))])); } },
    sheetEntry: { fileName: 'xl/worksheets/sheet1.xml' },
    sheet: { name: 'S', sheetIndex: 0, state: 'visible' },
    sourceFile: 'fixture.xlsx',
    sourceRegistry,
    onRow: (row) => rows.push(row)
  });
  assert.equal(rows.length, 40);
  assert.ok(rows.every((row) => row.cells.every((cell) => cell.sourceFormat === '0.00')));
  // 400 种行 × 单元格 XF 组合只对应 1 个实际样式；单元格与行各解析一次（列样式 XF 1 另计一次以内）
  assert.ok(compoundRefCalls <= 3, `compoundRef 调用 ${compoundRefCalls} 次`);
});
