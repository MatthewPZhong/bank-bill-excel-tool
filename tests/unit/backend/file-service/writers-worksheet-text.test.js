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
