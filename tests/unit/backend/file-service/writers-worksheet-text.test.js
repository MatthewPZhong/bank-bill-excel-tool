// v3.2.22 B113：XLSX 写出边界的文本处理。
//   - 字面 _xHHHH_（不分大小写，含与回车等控制字符相连的写法）写出、读回原样保留：写出前把下划线转义为 _x005F_；
//   - 调用方的行数据不被改写；数值、日期单元格不受影响；
//   - 含 U+FFFE、U+FFFF 或未配对代理项的文本整份拒绝写出，列出行号与列名，不留下文件。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { prepareWorkbookTextForWrite } = require('../../../../src/backend/file-service/writers');
const { writeBalanceWorkbook, writeWorkbookRows } = require('../../../../src/backend/file-service');

const ESCAPE_LIKE = [
  'FEE_x0041_',
  'a_X00e9_b',
  'REF_x0041\r\nB',
  'REF_x0041\u0001',
  '_x0041__x0042_',
  '_x005F_',
  'FEE_x004_',
  'FEE_x00G1_',
  'plain'
];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writers-worksheet-text-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
}

test('writeWorkbookRows：字面 _xHHHH_ 写出读回原样保留（含表头），行数据不被改写', (t) => {
  const dir = createTempDir(t);
  const rows = [['摘要', 'Ref_x0041_'], ...ESCAPE_LIKE.map((value) => [value, 1])];
  const snapshot = JSON.parse(JSON.stringify(rows));
  const outputFilePath = path.join(dir, 'detail.xlsx');
  writeWorkbookRows({ rows, outputFilePath });
  assert.deepEqual(rows, snapshot, '调用方的行数据不变');
  const back = readRows(outputFilePath);
  assert.deepEqual(back[0], ['摘要', 'Ref_x0041_']);
  assert.deepEqual(back.slice(1).map((row) => row[0]), ESCAPE_LIKE);
});

test('writeWorkbookRows：同一单元格对象出现在多格时各格只转义一次，调用方的对象不被改写', (t) => {
  const dir = createTempDir(t);
  const shared = { t: 's', v: 'FEE_x0041_' };
  const outputFilePath = path.join(dir, 'shared.xlsx');
  writeWorkbookRows({ rows: [['Ref'], [shared], [shared]], outputFilePath });
  assert.deepEqual(readRows(outputFilePath).slice(1), [['FEE_x0041_'], ['FEE_x0041_']]);
  assert.deepEqual(shared, { t: 's', v: 'FEE_x0041_' });
});

test('writeBalanceWorkbook：模板表头与记录中的字面 _xHHHH_ 写出读回原样保留', (t) => {
  const dir = createTempDir(t);
  const templateFilePath = path.join(dir, 'template.xlsx');
  const template = XLSX.utils.book_new();
  // 模板文件里按 OOXML 转义存表头 Note_x0041_（读取即为原文）
  XLSX.utils.book_append_sheet(template, XLSX.utils.aoa_to_sheet([['MerchantId', 'Note_x005F_x0041_']]), 'Sheet1');
  XLSX.writeFile(template, templateFilePath);
  const outputFilePath = path.join(dir, 'balance.xlsx');
  writeBalanceWorkbook({
    templateFilePath,
    records: [['ACC_x0041_', 'REF_x0041\r\nB']],
    templateFields: ['MerchantId', 'Note_x0041_'],
    outputFilePath
  });
  assert.deepEqual(readRows(outputFilePath), [['MerchantId', 'Note_x0041_'], ['ACC_x0041_', 'REF_x0041\r\nB']]);
});

test('含 U+FFFE、U+FFFF 或未配对代理项时拒绝写出并列出行号与列名，不留下文件', (t) => {
  const dir = createTempDir(t);
  const outputFilePath = path.join(dir, 'bad.xlsx');
  const rows = [['摘要', '参考号'], ['ok', 'REF\uFFFE'], ['x\uFFFF', 'ref\ud83d'], ['emoji\ud83d\ude00', 'ok']];
  assert.throws(() => writeWorkbookRows({ rows, outputFilePath }), (error) => {
    assert.equal(error.code, 'FILE_READ');
    assert.match(error.message, /^第 2 行「参考号」列的值含无法写入 Excel 的字符.*等 3 处/);
    assert.deepEqual(error.detailLines, ['第 2 行「参考号」列', '第 3 行「摘要」列', '第 3 行「参考号」列']);
    return true;
  });
  assert.equal(fs.existsSync(outputFilePath), false);
});

test('prepareWorkbookTextForWrite：只改字符串单元格，数值、日期单元格不变', () => {
  const sheet = {
    '!ref': 'A1:C1',
    A1: { t: 's', v: 'A_x0041_' },
    B1: { t: 'n', v: 46000, z: 'yyyy-mm-dd' },
    C1: { t: 'b', v: true }
  };
  prepareWorkbookTextForWrite({ SheetNames: ['S'], Sheets: { S: sheet } });
  assert.deepEqual(sheet.A1, { t: 's', v: 'A_x005F_x0041_' });
  assert.deepEqual(sheet.B1, { t: 'n', v: 46000, z: 'yyyy-mm-dd' });
  assert.deepEqual(sheet.C1, { t: 'b', v: true });
});

test('报错的列名取表头原文（转义前）；超过 20 处时按行列顺序列前 20 处并给出总数', (t) => {
  const dir = createTempDir(t);
  const outputFilePath = path.join(dir, 'many.xlsx');
  const rows = [['Ref_x0041_', '摘要']];
  for (let index = 0; index < 25; index += 1) rows.push([`bad\uFFFF${index}`, index === 0 ? 'x\uFFFE' : 'ok']);
  assert.throws(() => writeWorkbookRows({ rows, outputFilePath }), (error) => {
    assert.match(error.message, /^第 2 行「Ref_x0041_」列的值含无法写入 Excel 的字符.*等 26 处/);
    assert.equal(error.detailLines.length, 21);
    assert.deepEqual(error.detailLines.slice(0, 3), ['第 2 行「Ref_x0041_」列', '第 2 行「摘要」列', '第 3 行「Ref_x0041_」列']);
    assert.equal(error.detailLines[19], '第 20 行「Ref_x0041_」列');
    assert.equal(error.detailLines[20], '另有 6 处，共 26 处');
    return true;
  });
  assert.equal(fs.existsSync(outputFilePath), false);
});

test('多张工作表时位置带表名', () => {
  const workbook = { SheetNames: ['Sheet1', '附表'], Sheets: {
    Sheet1: { '!ref': 'A1:B1', A1: { t: 's', v: 'MerchantId' }, B1: { t: 's', v: 'Balance' } },
    附表: { '!ref': 'A1:A2', A1: { t: 's', v: '说明' }, A2: { t: 's', v: '附注\uFFFF' } }
  } };
  assert.throws(() => prepareWorkbookTextForWrite(workbook), (error) => {
    assert.deepEqual(error.detailLines, ['工作表「附表」第 2 行「说明」列']);
    return true;
  });
});

// 余额账单模板随程序发布（assets），原有文字随余额账单写出，生成时不在运行时读取核对（spec D3）：这里确认它能原样写出、读回。
//   读取库只能正确还原 U+0080 以下的 _xHHHH_ 转义（_x00E9_ 读成「�」），且不区分 x 的大小写，模板 XML 里不能有更高的转义
const lossyEscapesIn = (xml) => [...String(xml).matchAll(/_[xX]([0-9A-Fa-f]{4})_/g)]
  .filter((match) => parseInt(match[1], 16) >= 0x80)
  .map((match) => match[0]);

test('模板转义检查覆盖读取库会改写的两种大小写写法', () => {
  const sheetXml = (value) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + `<row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`;
  for (const escape of ['_x00E9_', '_X00E9_']) {
    assert.deepEqual(lossyEscapesIn(sheetXml(escape)), [escape], `${escape} 被检查发现`);
  }
  assert.deepEqual(lossyEscapesIn(sheetXml('_x0041_ _X0042_')), [], 'U+0080 以下的转义读取库能正确还原，不算');
});

test('随程序发布的余额账单模板：文字可原样写出读回，没有读取时会被改写的转义', (t) => {
  const templatePath = path.join(__dirname, '../../../../assets/余额账单模版.xlsx');
  const container = XLSX.CFB.read(fs.readFileSync(templatePath), { type: 'buffer' });
  container.FullPaths.forEach((fullPath, index) => {
    if (!/xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(fullPath)) return;
    const xml = Buffer.from(container.FileIndex[index].content || []).toString('utf8');
    assert.deepEqual(lossyEscapesIn(xml), [], fullPath);
  });
  const dir = createTempDir(t);
  const template = XLSX.readFile(templatePath);
  const fields = readRows(templatePath)[0];
  const outputFilePath = path.join(dir, 'balance.xlsx');
  writeBalanceWorkbook({ templateFilePath: templatePath, records: [fields.map(() => 'v')], templateFields: fields, outputFilePath });
  const written = XLSX.readFile(outputFilePath);
  assert.deepEqual(written.SheetNames, template.SheetNames);
  template.SheetNames.forEach((name) => {
    const rows = XLSX.utils.sheet_to_json(written.Sheets[name], { header: 1, defval: '' });
    assert.deepEqual(rows[0], XLSX.utils.sheet_to_json(template.Sheets[name], { header: 1, defval: '' })[0], name);
  });
});

test('余额账单预检 assertBalanceRecordsWritable：不构造工作表，报错与写出边界一致；记录不是数组时预检与写出都拒绝', (t) => {
  const { assertBalanceRecordsWritable } = require('../../../../src/backend/file-service');
  const dir = createTempDir(t);
  const templateFilePath = path.join(dir, 'template.xlsx');
  const templateFields = ['银行账号', '币种', '备注'];
  const template = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(template, XLSX.utils.aoa_to_sheet([templateFields]), 'Sheet1');
  XLSX.writeFile(template, templateFilePath);
  const outputFilePath = path.join(dir, 'balance.xlsx');
  const captured = (fn) => {
    try {
      fn();
    } catch (error) {
      return { code: error.code, message: error.message, detailLines: error.detailLines, positionsOnly: error.positionsOnly };
    }
    return null;
  };
  const cases = [
    // 超出表头列数的值不写出、不报
    [['ok', 'USD', 'n', 'extra￿'], ['a￿', 'USD'], 'short-row', ['b', 'U￾', 'c\ud83d']],
    Array.from({ length: 30 }, (_value, index) => [`acc${index}￿`, 'USD', index % 2 ? 'x￾' : 'ok'])
  ];
  for (const records of cases) {
    const preflight = captured(() => assertBalanceRecordsWritable({ records, templateFields }));
    const written = captured(() => writeBalanceWorkbook({ templateFilePath, records, templateFields, outputFilePath }));
    assert.ok(preflight && preflight.positionsOnly, '预检拒绝并只带位置');
    assert.deepEqual(preflight, written, '预检与写出边界的报错一致');
    assert.equal(fs.existsSync(outputFilePath), false);
  }
  assert.equal(captured(() => assertBalanceRecordsWritable({ records: [['ok', 'USD', 'n']], templateFields })), null);
  assert.equal(captured(() => assertBalanceRecordsWritable({ records: [], templateFields })), null, '显式空数组可写出');
  for (const records of [null, undefined, { length: 0 }, new Uint8Array([1])]) {
    assert.throws(() => assertBalanceRecordsWritable({ records, templateFields }), TypeError);
    assert.throws(() => writeBalanceWorkbook({ templateFilePath, records, templateFields, outputFilePath }), TypeError);
    assert.equal(fs.existsSync(outputFilePath), false, '无效记录不当作空账单写出');
  }
});

// v3.2.22 B113（Codex 第六轮）：本应用写出的明细交给链接表流式导入（BizId 幂等键）时，读回原文，与非流式读取一致
test('writeWorkbookRows 写出后经链接表流式导入：字面 _xHHHH_ 与回车读回原文，与非流式读取一致；默认不还原（工具箱通道不变）', async (t) => {
  const { streamLinkedRowsToInsert } = require('../../../../src/main-process/linked-table-stream-source');
  const { readXlsxStreamed } = require('../../../../src/backend/xlsx/legacy/streaming-xlsx-reader');
  const dir = createTempDir(t);
  const outputFilePath = path.join(dir, 'linked.xlsx');
  const rows = [['BizId', '备注'], ['TX_x0041_', 'REF_x0041\r\nB'], ['_x005F_', 'plain']];
  writeWorkbookRows({ rows, outputFilePath });
  const streamed = [];
  assert.deepEqual(await streamLinkedRowsToInsert(outputFilePath, { expectedHeaders: ['BizId', '备注'] }, (row) => streamed.push(row)),
    { matched: true });
  const values = streamed.map((row) => (Array.isArray(row) ? row : [row.BizId, row['备注']]));
  assert.deepEqual(values, rows.slice(1), '流式导入读回原文');
  assert.deepEqual(readRows(outputFilePath).slice(1), rows.slice(1), '非流式读取同样读回原文');
  const raw = [];
  await readXlsxStreamed(outputFilePath, (cells) => raw.push(cells), { colCount: 2 });
  assert.equal(raw[1][0], 'TX_x005F_x0041_', '默认不还原（既有调用方行为不变）');
});

// v3.2.22 B113（Codex 第七轮）：链接表的表头识别与流式导入按同一口径还原（写出端转义后的表头仍能识别）；还原后无法确认原值的格
//   （转义跨富文本片段拼成、表示非 ASCII 字符、还原为未配对的代理项）拒绝导入，不让不同的原值落成同一个键或与非流式读取不同
test('链接表：表头识别与流式导入同样还原转义；无法确认原值的转义拒绝导入并给出行号与列名', async (t) => {
  const JSZip = require('jszip');
  const { streamLinkedRowsToInsert } = require('../../../../src/main-process/linked-table-stream-source');
  const { detectTableType } = require('../../../../src/main-process/table-type-detector');
  const dir = createTempDir(t);
  const headerFile = path.join(dir, 'header.xlsx');
  writeWorkbookRows({ rows: [['BizId', 'Note_x0041'], ['TX1', 'n']], outputFilePath: headerFile });
  const signature = { tableKey: 'bank-statement', structureExact: true, expectedHeaders: ['BizId', 'Note_x0041'] };
  const detected = await detectTableType(headerFile, [signature]);
  assert.deepEqual([detected.status, detected.tableKey, detected.streamingEligible], ['matched', 'bank-statement', true], '写出端转义后的表头仍能识别');
  assert.deepEqual(await streamLinkedRowsToInsert(headerFile, signature, () => {}), { matched: true });

  const build = async (name, rowXml, sharedStrings) => {
    const filePath = path.join(dir, `${name}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['BizId', '备注']]), 'S');
    XLSX.writeFile(workbook, filePath, { bookSST: true });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml').async('string'))
      .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:B5"/>')
      .replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${rowXml}</sheetData>`));
    zip.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<si><t>BizId</t></si><si><t>备注</t></si>${sharedStrings}</sst>`);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const linked = { expectedHeaders: ['BizId', '备注'] };
  const rejected = [
    ['共享字符串富文本拼成转义', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><r><t>ID_x00</t></r><r><t>41_</t></r></si>'],
    ['内联富文本拼成转义', '<row r="5"><c r="A5" t="inlineStr"><is><r><t>ID_x00</t></r><r><t>41_</t></r></is></c></row>', ''],
    ['公式字符串的非 ASCII 转义', '<row r="5"><c r="A5" t="str"><v>ID_x00E9_</v></c></row>', ''],
    ['未配对的代理项', '<row r="5"><c r="A5" t="str"><v>ID_xD800_</v></c></row>', ''],
    ['字符引用的未配对代理项', '<row r="5"><c r="A5" t="str"><v>ID&#xD800;</v></c></row>', '']
  ];
  for (const [label, rowXml, sharedStrings] of rejected) {
    const filePath = await build(label, rowXml, sharedStrings);
    const inserted = [];
    await assert.rejects(streamLinkedRowsToInsert(filePath, linked, (row) => inserted.push(row)), (error) => (
      error.code === 'FILE_READ' && /^源文件第 5 行「BizId」列的文本含无法确认原值的 Excel 文本转义（_xHHHH_）、不完整的 Unicode 字符或非常规的文本结构/.test(error.message)
        && !error.message.includes('ID_')
    ), label);
    assert.deepEqual(inserted, [], `${label}：不入库`);
  }
  // Excel 写出的转义（字面下划线、控制字符，各在一个文本段内）照常还原，与非流式读取一致
  const accepted = await build('accepted', '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="str"><v>A_x000D_B</v></c></row>',
    '<si><r><t>TX_x005F_x0041_</t></r><r><t>-1</t></r></si>');
  const inserted = [];
  assert.deepEqual(await streamLinkedRowsToInsert(accepted, linked, (row) => inserted.push(row)), { matched: true });
  assert.deepEqual(inserted.map((row) => [row.BizId, row['备注']]), [['TX_x0041_-1', 'A\rB']]);
  assert.deepEqual(readRows(accepted)[1], ['TX_x0041_-1', 'A\rB'], '与非流式读取一致');
});

// v3.2.22 B113（Codex 第八轮）：注音不计入正文；CDATA、多段纯文本、带前缀的元素等非规范结构拒绝；表头格无法确认时不认作表头
//   （流式导入、表头识别一致）；只有该格有内容的行同样拒绝；<row> 省略 r 时按上一行顺推行号
test('链接表：注音不计入正文，非规范文本结构拒绝导入；无法确认的表头格不认作表头；全空判断前先拒绝；省略 r 的行顺推行号', async (t) => {
  const JSZip = require('jszip');
  const { streamLinkedRowsToInsert } = require('../../../../src/main-process/linked-table-stream-source');
  const { detectTableType } = require('../../../../src/main-process/table-type-detector');
  const { readMeaningfulRowsHead, UNVERIFIABLE_CELL_TEXT } = require('../../../../src/backend/file-service/readers');
  const dir = createTempDir(t);
  const build = async (name, sheetData, sharedStrings) => {
    const filePath = path.join(dir, `${name}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['BizId', '备注']]), 'S');
    XLSX.writeFile(workbook, filePath, { bookSST: true });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml').async('string'))
      .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:B20"/>')
      .replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData>${sheetData}</sheetData>`));
    zip.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<si><t>BizId</t></si><si><t>备注</t></si>${sharedStrings}</sst>`);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const header = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>';
  const linked = { expectedHeaders: ['BizId', '备注'] };
  const importRows = async (filePath) => {
    const inserted = [];
    const result = await streamLinkedRowsToInsert(filePath, linked, (row) => inserted.push(row.BizId));
    return { result, inserted };
  };

  // 注音：正文 ABC、注音 _x0041_ 与正文 ABCA 是两个键（与非流式读取一致）
  const phonetic = await build('phonetic', `${header}<row r="2"><c r="A2" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c></row>`
    + '<row r="4"><c r="A4" t="inlineStr"><is><t>XY</t><rPh sb="0" eb="2"><t>_x0041_</t></rPh></is></c></row>',
  '<si><t>ABC</t><rPh sb="0" eb="3"><t>_x0041_</t></rPh><phoneticPr fontId="1"/></si><si><t>ABCA</t></si>');
  assert.deepEqual(await importRows(phonetic), { result: { matched: true }, inserted: ['ABC', 'ABCA', 'XY'] });
  assert.deepEqual(readRows(phonetic).slice(1, 4).map((row) => row[0]), ['ABC', 'ABCA', 'XY'], '与非流式读取一致');

  // 字面文本 <![CDATA[IDA]]>（以实体写出）照常导入；真正的 CDATA 与其他非规范结构拒绝
  const literal = await build('literal', `${header}<row r="2"><c r="A2" t="s"><v>2</v></c></row>`, '<si><t>&lt;![CDATA[IDA]]&gt;</t></si>');
  assert.deepEqual((await importRows(literal)).inserted, ['<![CDATA[IDA]]>']);
  const rejected = [
    ['CDATA', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><t><![CDATA[ID_x0041_]]></t></si>'],
    ['公式字符串中的 CDATA', '<row r="5"><c r="A5" t="str"><v><![CDATA[IDA]]></v></c></row>', ''],
    ['多段纯文本', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><t>ID</t><t>A</t></si>'],
    ['带前缀的元素', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><x:t>IDA</x:t></si>'],
    ['内联字符串缺 is', '<row r="5"><c r="A5" t="inlineStr"><t>IDA</t></c></row>', ''],
    ['还原为空白、该行别无内容', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><r><t>_x00</t></r><r><t>20_</t></r></si>'],
    ['省略 r 的行', '<row r="4"><c r="B4" t="str"><v></v></c></row><row spans="1:2"><c r="A5" t="str"><v>ID_xD800_</v></c></row>', '']
  ];
  for (const [label, rows, sharedStrings] of rejected) {
    const filePath = await build(label, header + rows, sharedStrings);
    const inserted = [];
    await assert.rejects(streamLinkedRowsToInsert(filePath, linked, (row) => inserted.push(row)), (error) => (
      error.code === 'FILE_READ' && /^源文件第 5 行「BizId」列的文本含无法确认原值的/.test(error.message) && !error.message.includes('IDA')
    ), label);
    assert.deepEqual(inserted, [], `${label}：不入库`);
  }

  // 表头格由富文本片段拼成 BizId：流式导入、表头识别都不认作表头
  const splitHeader = await build('split-header', '<row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="str"><v>TX1</v></c></row>', '<si><r><t>Biz_x00</t></r><r><t>49_d</t></r></si>');
  assert.deepEqual(await importRows(splitHeader), { result: { matched: false }, inserted: [] });
  assert.deepEqual((await readMeaningfulRowsHead(splitHeader, 5, { decodeTextEscapes: true })).rows[0], [UNVERIFIABLE_CELL_TEXT, '备注']);
  const signature = { tableKey: 'bank-statement', structureExact: true, expectedHeaders: ['BizId', '备注'] };
  assert.notEqual((await detectTableType(splitHeader, [signature])).status, 'matched');
});

// v3.2.22 B113（Codex 第九轮）：带前缀的共享字符串项（后续索引错位）、带前缀的内联字符串、注释中的文本段、原始回车、公式字符串中表示
//   非 ASCII 字符的字符引用、行内注释或缺坐标的单元格均拒绝；行号以单元格坐标为准；无法确认的格不与任何可配置列名相等
test('链接表：带前缀、注释、原始回车、非 ASCII 字符引用等非规范结构拒绝导入；行号取单元格坐标；标记不与列名相等', async (t) => {
  const JSZip = require('jszip');
  const { streamLinkedRowsToInsert } = require('../../../../src/main-process/linked-table-stream-source');
  const { detectTableType } = require('../../../../src/main-process/table-type-detector');
  const { UNVERIFIABLE_CELL_TEXT } = require('../../../../src/backend/file-service/readers');
  const dir = createTempDir(t);
  const build = async (name, sheetData, sharedStrings) => {
    const filePath = path.join(dir, `${name}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['BizId', '备注']]), 'S');
    XLSX.writeFile(workbook, filePath, { bookSST: true });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml').async('string'))
      .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:B20"/>')
      .replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData>${sheetData}</sheetData>`));
    zip.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<si><t>BizId</t></si><si><t>备注</t></si>${sharedStrings}</sst>`);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const header = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>';
  const linked = { expectedHeaders: ['BizId', '备注'] };
  const rejected = [
    // 第 2 行是正常交易：遇到异常行时整批拒绝（调用方回滚已喂入的行）
    ['带前缀的共享字符串项', '<row r="2"><c r="A2" t="str"><v>OK1</v></c></row><row r="5"><c r="A5" t="s"><v>3</v></c></row>',
      '<x:si xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:t>TX1</x:t></x:si><si><t>TX2</t></si>'],
    ['带前缀的内联字符串', '<row r="5"><c r="A5" t="inlineStr"><x:is xmlns:x="urn:x"><x:t>TX</x:t></x:is></c></row>', ''],
    ['富文本中的注释', '<row r="5"><c r="A5" t="s"><v>2</v></c></row>', '<si><r><t>TX</t></r><!--<r><t>_x0041_</t></r>--></si>'],
    ['原始回车', '<row r="5"><c r="A5" t="str"><v>TX\rA</v></c></row>', ''],
    ['公式字符串的非 ASCII 字符引用', '<row r="5"><c r="A5" t="str"><v>TX&#xE9;_x0041_</v></c></row>', ''],
    ['行内注释中的单元格', '<row r="5"><c r="B5" t="str"><v>n</v></c><!--<c r="A5" t="str"><v>TX</v></c>--></row>', ''],
    ['缺坐标的单元格', '<row r="5"><c t="str"><v>TX</v></c></row>', ''],
    ['单引号行号', "<row r='5'><c r=\"A5\" t=\"str\"><v>ID_xD800_</v></c></row>", ''],
    ['单引号行号、缺坐标的单元格', "<row r='5'><c t=\"str\"><v>TX</v></c></row>", ''],
    ['自闭合空行后的数据行', '<row r="3"/><row r="5"><c r="A5" t="str"><v>ID_xD800_</v></c></row>', '']
  ];
  for (const [label, rows, sharedStrings] of rejected) {
    const filePath = await build(label, header + rows, sharedStrings);
    const inserted = [];
    let rejection = null;
    const result = await streamLinkedRowsToInsert(filePath, linked, (row) => inserted.push(row.BizId)).catch((error) => { rejection = error; });
    if (label === '带前缀的共享字符串项') {
      // 所有共享字符串（含表头）都无法确认：不认作表头，调用方按未匹配表头拒绝
      assert.deepEqual([result, inserted], [{ matched: false }, []], label);
      continue;
    }
    assert.ok(rejection && rejection.code === 'FILE_READ', `${label}：拒绝导入`);
    assert.match(rejection.message, /^源文件第 5 行「BizId」列的文本含无法确认原值的/, label);
    assert.ok(!inserted.includes('TX2') && !inserted.includes('TXA') && !inserted.includes('TX\nA'), `${label}：不按错误的键入库`);
  }
  // 原始换行（Excel 写出的形式）照常导入
  const newline = await build('newline', `${header}<row r="2"><c r="A2" t="str"><v>TX\nA</v></c></row>`, '');
  const inserted = [];
  assert.deepEqual(await streamLinkedRowsToInsert(newline, linked, (row) => inserted.push(row.BizId)), { matched: true });
  assert.deepEqual(inserted, ['TX\nA']);
  // 标记不与可配置的列名相等：签名第二列恰为提示文字时，无法确认的格不命中
  const marker = await build('marker', '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><v>X_x00E9_</v></c></row>', '');
  const signature = { tableKey: 'bank-statement', structureExact: true, expectedHeaders: ['BizId', '（无法确认原值的文本）'] };
  assert.notEqual((await detectTableType(marker, [signature])).status, 'matched');
  assert.ok(UNVERIFIABLE_CELL_TEXT.endsWith('（无法确认原值的文本）'), '前置：标记含提示文字');
});
