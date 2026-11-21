'use strict';

// v3.2.21 跨 Sheet 回填：【导出明细】时写出回填后的原始账单（spec §3.3）。
//   - xlsx 复制原工作簿，只改主表被回填的单元格（及所需日期样式），其他 Sheet、样式与未回填的单元格不变；
//   - 日期写为 Excel 日期序号，格式随模板日期顺序（自动 / 日在前 → dd/mm/yyyy，月在前 → mm/dd/yyyy），以单元格原样式为底；
//   - 物理列 = 补丁列下标 + 列偏移；含公式的目标单元格、找不到的行拒绝且不留半成品；缺少 r 属性的单元格按隐含列号处理；
//   - 非 xlsx（xls）转成 xlsx；输出名「原文件名_回填.xlsx」，重名追加 (1)、(2)。
// 样式断言直接读 styles.xml，不经读取库的全局数字格式表（见 sheetjs 全局格式表的用例顺序问题）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const {
  allocateCrossSheetBackfillOutputPaths,
  computeFileFingerprint,
  isoDateToSerial,
  resolveCrossSheetBackfillDateFormat,
  writeCrossSheetBackfillWorkbook
} = require('../../../../src/backend/file-service/cross-sheet-backfill-writer');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sheet-backfill-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 合成的主表 NGN（第 3、5 行为换汇行，ValueDate 与 Channel 为空）与来源表 USD；主表从 B 列开始。
async function buildStatementWorkbook(filePath, { mainRows } = {}) {
  const workbook = new ExcelJS.Workbook();
  const main = workbook.addWorksheet('NGN');
  const rows = mainRows || [
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', null, 1000, 'NIP'],
    [null, 'Trade - $65.45', 90000, null, null],
    ['27/09/2026', 'Fee', 50, null, 'POS'],
    [null, 'Trade - $10', 15000, null, null]
  ];
  rows.forEach((row, index) => {
    row.forEach((value, column) => {
      const cell = main.getCell(index + 1, column + 2);
      if (value !== null) cell.value = value;
    });
  });
  main.getRow(1).font = { bold: true };
  // 换汇行的 ValueDate 单元格有样式（加粗、边框）但没有值：写出日期时保留原样式，只换数字格式
  main.getCell('B3').font = { bold: true, color: { argb: 'FFFF0000' } };
  main.getCell('B3').border = { top: { style: 'thin' } };
  main.getCell('D2').numFmt = '#,##0.00';
  const usd = workbook.addWorksheet('USD');
  usd.addRow(['ValueDate', 'Credit Amount', 'Channel']);
  usd.addRow([new Date(Date.UTC(2026, 8, 26)), 65.45, 'FX-01']);
  usd.getCell('A2').numFmt = 'm/d/yyyy';
  await workbook.xlsx.writeFile(filePath);
}

const PATCHES = [
  { rowNumber: 3, sourceRowNumber: 2, cells: [
    { field: 'ValueDate', columnIndex: 0, value: '2026-09-26', kind: 'date' },
    { field: 'Channel', columnIndex: 4, value: 'FX-01', kind: 'value' }
  ] },
  { rowNumber: 5, sourceRowNumber: 3, cells: [
    { field: 'ValueDate', columnIndex: 0, value: '2026-09-28', kind: 'date' },
    { field: 'Channel', columnIndex: 4, value: 7, kind: 'value' }
  ] }
];
const SOURCE = { mainSheetName: 'NGN', columnOffset: 1, dateParseOrder: 'auto' };

async function readZipEntries(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entries = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (!zip.files[name].dir) entries[name] = await zip.file(name).async('string');
  }
  return entries;
}

function cellXml(sheetXml, reference) {
  const match = new RegExp(`<c r="${reference}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(sheetXml);
  return match ? match[0] : null;
}

function styleOf(stylesXml, styleIndex) {
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)[1];
  const xfs = cellXfs.match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const xf = xfs[styleIndex];
  const attribute = (name) => (new RegExp(`\\s${name}="([^"]*)"`).exec(xf) || [])[1];
  const numFmtId = attribute('numFmtId');
  const numFmt = new RegExp(`<numFmt numFmtId="${numFmtId}" formatCode="([^"]*)"`).exec(stylesXml);
  return { numFmtId, formatCode: numFmt ? numFmt[1] : null, fontId: attribute('fontId'), borderId: attribute('borderId'), count: xfs.length };
}

function readSheetCells(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[sheetName];
  const cells = {};
  Object.keys(sheet).filter((key) => !key.startsWith('!')).forEach((key) => { cells[key] = sheet[key].v; });
  return cells;
}

test('xlsx：只改主表被回填的单元格，其他 Sheet 与部件不变；日期写为日期序号并以原样式为底套用 dd/mm/yyyy', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await buildStatementWorkbook(sourcePath);
  const sourceBytes = fs.readFileSync(sourcePath);

  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  assert.deepEqual(result, { converted: false, cellCount: 4 });
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes, '原文件不变');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Statement.xlsx', 'Statement_回填.xlsx'], '不留临时文件');

  const before = await readZipEntries(sourcePath);
  const after = await readZipEntries(outputPath);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  Object.keys(before)
    .filter((name) => name !== 'xl/worksheets/sheet1.xml' && name !== 'xl/styles.xml')
    .forEach((name) => assert.equal(after[name], before[name], `${name} 不变`));

  // 值：只有 4 个目标单元格变化，其余单元格（含 USD 表）与原文件相同
  const sourceCells = readSheetCells(sourcePath, 'NGN');
  const outputCells = readSheetCells(outputPath, 'NGN');
  assert.deepEqual(outputCells, { ...sourceCells, B3: 46291, F3: 'FX-01', B5: 46293, F5: 7 });
  assert.equal(isoDateToSerial('2026-09-26'), 46291);
  assert.deepEqual(readSheetCells(outputPath, 'USD'), readSheetCells(sourcePath, 'USD'));

  // 样式：B3 原有加粗红字与边框保留、数字格式换成 dd/mm/yyyy；B5 原本没有单元格，以默认样式为底；F3 文本为内联字符串
  const sheetXml = after['xl/worksheets/sheet1.xml'];
  const originalB3Style = Number(/ s="(\d+)"/.exec(cellXml(before['xl/worksheets/sheet1.xml'], 'B3'))[1]);
  const b3 = cellXml(sheetXml, 'B3');
  const b3Style = styleOf(after['xl/styles.xml'], Number(/ s="(\d+)"/.exec(b3)[1]));
  const baseStyle = styleOf(before['xl/styles.xml'], originalB3Style);
  assert.equal(b3Style.formatCode, 'dd/mm/yyyy');
  assert.deepEqual([b3Style.fontId, b3Style.borderId], [baseStyle.fontId, baseStyle.borderId]);
  assert.equal(styleOf(after['xl/styles.xml'], Number(/ s="(\d+)"/.exec(cellXml(sheetXml, 'B5'))[1])).formatCode, 'dd/mm/yyyy');
  assert.match(cellXml(sheetXml, 'F3'), /t="inlineStr"><is><t>FX-01<\/t><\/is>/);
  assert.equal(b3Style.count, baseStyle.count + 2, '每种底样式只新增一个日期样式');
  // 行内单元格按列排列（新单元格插入在正确位置）
  const row5 = /<row r="5"[^>]*>([\s\S]*?)<\/row>/.exec(sheetXml)[1];
  assert.deepEqual(Array.from(row5.matchAll(/<c r="([A-Z]+)5"/g)).map((match) => match[1]), ['B', 'C', 'D', 'F']);

  // 另一实现（ExcelJS）能打开写出的文件：日期单元格识别为日期、格式与字体保留
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(outputPath);
  const reopenedB3 = reopened.getWorksheet('NGN').getCell('B3');
  assert.equal(reopenedB3.value instanceof Date && reopenedB3.value.toISOString().slice(0, 10), '2026-09-26');
  assert.equal(reopenedB3.numFmt, 'dd/mm/yyyy');
  assert.equal(reopenedB3.font && reopenedB3.font.bold, true);
  assert.equal(reopened.getWorksheet('NGN').getCell('F5').value, 7);
  assert.deepEqual(reopened.worksheets.map((sheet) => sheet.name), ['NGN', 'USD']);
});

test('日期格式随模板日期顺序：月在前写 mm/dd/yyyy；已有同格式时复用其编号；1904 日期系统按 1904-01-01 起算', async (t) => {
  assert.equal(resolveCrossSheetBackfillDateFormat('MDY'), 'mm/dd/yyyy');
  assert.equal(resolveCrossSheetBackfillDateFormat('auto'), 'dd/mm/yyyy');
  assert.equal(resolveCrossSheetBackfillDateFormat('DMY'), 'dd/mm/yyyy');
  assert.equal(isoDateToSerial('2026-09-26', true), 46291 - 1462);
  assert.throws(() => isoDateToSerial('26/09/2026'), /回填日期无法写出/);

  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const firstPath = path.join(dir, 'first.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: firstPath, patches: [PATCHES[0]], source: { ...SOURCE, dateParseOrder: 'MDY' } });
  const first = await readZipEntries(firstPath);
  const style = styleOf(first['xl/styles.xml'], Number(/ s="(\d+)"/.exec(cellXml(first['xl/worksheets/sheet1.xml'], 'B3'))[1]));
  assert.equal(style.formatCode, 'mm/dd/yyyy');
  // 对已写过 mm/dd/yyyy 的文件再回填：复用同一数字格式编号，不重复登记
  const secondPath = path.join(dir, 'second.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: firstPath, outputFilePath: secondPath, patches: [PATCHES[1]], source: { ...SOURCE, dateParseOrder: 'MDY' } });
  const second = await readZipEntries(secondPath);
  assert.equal((second['xl/styles.xml'].match(/formatCode="mm\/dd\/yyyy"/g) || []).length, 1);
  assert.equal(styleOf(second['xl/styles.xml'], Number(/ s="(\d+)"/.exec(cellXml(second['xl/worksheets/sheet1.xml'], 'B5'))[1])).numFmtId, style.numFmtId);
});

test('拒绝：目标单元格含公式、找不到补丁行、主表名已变化；拒绝时不留输出文件', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, 'out.xlsx');
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace(/<row r="3"([^>]*)>/, '<row r="3"$1><c r="F3"><f>""</f><v></v></c>')
    .replace(/(<row r="3"[^>]*>)([\s\S]*?)<\/row>/, (_m, open, inner) => {
      const cells = inner.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g);
      const formula = cells.shift();
      return `${open}${cells.join('')}${formula}</row>`;
    }));
  const formulaPath = path.join(dir, 'formula.xlsx');
  fs.writeFileSync(formulaPath, await zip.generateAsync({ type: 'nodebuffer' }));

  await assert.rejects(writeCrossSheetBackfillWorkbook({ sourceFilePath: formulaPath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE }),
    /单元格 F3 含公式，未改写/);
  await assert.rejects(writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 40, cells: [{ columnIndex: 0, value: 'x', kind: 'value' }] }], source: SOURCE }), /找不到第 40 行/);
  await assert.rejects(writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES,
    source: { ...SOURCE, mainSheetName: 'EUR' } }), /第一个 Sheet 已不是「EUR」/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Statement.xlsx', 'formula.xlsx']);
});

test('单元格缺少 r 属性时按隐含列号定位：插入新单元格后补上 r，原有单元格位置不变', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  // 第 5 行改成 A 列起连续、不带 r 的单元格：A5 空、B5 空、C5 描述、D5 金额
  const row5 = /<row r="5"[^>]*>([\s\S]*?)<\/row>/.exec(sheetXml);
  const cells = row5[1].match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g).map((cell) => cell.replace(/ r="[A-Z]+5"/, ''));
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace(row5[0], `<row r="5"><c/><c/>${cells.join('')}</row>`));
  const noRefPath = path.join(dir, 'noref.xlsx');
  fs.writeFileSync(noRefPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const outputPath = path.join(dir, 'out.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: noRefPath, outputFilePath: outputPath,
    patches: [{ rowNumber: 5, cells: [{ columnIndex: 0, value: 'B-filled', kind: 'value' }, { columnIndex: 4, value: 'F-filled', kind: 'value' }] }],
    source: SOURCE });
  const output = readSheetCells(outputPath, 'NGN');
  const source = readSheetCells(noRefPath, 'NGN');
  assert.equal(source.C5, 'Trade - $10');
  assert.deepEqual(output, { ...source, B5: 'B-filled', F5: 'F-filled' });
});

test('xls：转成 xlsx 写出（只保留值与数字格式），日期带格式', async (t) => {
  const dir = makeTempDir(t);
  const sheet = XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, '']
  ]);
  const usd = XLSX.utils.aoa_to_sheet([['ValueDate', 'Credit Amount'], [46291, 65.45]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'NGN');
  XLSX.utils.book_append_sheet(workbook, usd, 'USD');
  const sourcePath = path.join(dir, 'Statement.xls');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'biff8' });
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }, { columnIndex: 3, value: 'FX-01', kind: 'value' }] }],
    source: { mainSheetName: 'NGN', columnOffset: 0, dateParseOrder: 'auto' } });
  assert.deepEqual(result, { converted: true, cellCount: 2 });
  assert.equal(fs.readFileSync(outputPath).subarray(0, 2).toString('latin1'), 'PK');
  const cells = readSheetCells(outputPath, 'NGN');
  assert.deepEqual([cells.A3, cells.B3, cells.C3, cells.D3], [46291, 'Trade - $65.45', 90000, 'FX-01']);
  assert.deepEqual(readSheetCells(outputPath, 'USD'), { A1: 'ValueDate', B1: 'Credit Amount', A2: 46291, B2: 65.45 });
  const entries = await readZipEntries(outputPath);
  assert.match(entries['xl/styles.xml'], /formatCode="dd\/mm\/yyyy"/);
});

test('输出名「原文件名_回填.xlsx」：已存在、与明细保存路径或其他输出重名（不区分大小写）时追加 (1)、(2)；指纹为大小与 SHA-256', (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'Statement_回填.xlsx'), '');
  const paths = allocateCrossSheetBackfillOutputPaths({
    directory: dir,
    sourceFilePaths: ['/a/Statement.xlsx', '/b/statement.xls', '/c/Other.xlsx'],
    reservedPaths: [path.join(dir, 'Other_回填.xlsx')]
  });
  assert.deepEqual(paths.map((item) => path.basename(item)), ['Statement_回填(1).xlsx', 'statement_回填(2).xlsx', 'Other_回填(1).xlsx']);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'abc');
  assert.deepEqual(computeFileFingerprint(file), {
    size: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  });
});
