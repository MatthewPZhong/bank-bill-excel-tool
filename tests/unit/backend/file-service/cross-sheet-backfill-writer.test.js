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

const { decodeExcelStXstring } = require('../../../../src/backend/xlsx/excel-text');
const {
  allocateCrossSheetBackfillOutputPaths,
  computeFileFingerprint,
  isoDateToSerial,
  publishWithoutReplace,
  readFingerprintedFile,
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
  // 返回写出内容的摘要（存档结算核对用），与磁盘上的输出文件一致
  const outputFingerprint = computeFileFingerprint(outputPath);
  assert.deepEqual(result, { converted: false, cellCount: 4, sha256: outputFingerprint.sha256, size: outputFingerprint.size });
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
  // 返回写出内容的摘要（存档结算核对用），与磁盘上的输出文件一致
  const outputFingerprint = computeFileFingerprint(outputPath);
  assert.deepEqual(result, { converted: true, cellCount: 2, sha256: outputFingerprint.sha256, size: outputFingerprint.size });
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

// ---- v3.2.21 审查回归（第一轮）----

test('输出名：区分大小写的文件系统上，目录已有的文件同样不区分大小写比较', () => {
  const paths = allocateCrossSheetBackfillOutputPaths({
    directory: '/out',
    sourceFilePaths: ['/b/statement.xls'],
    existsSync: () => false,
    readdirSync: () => ['Statement_回填.xlsx']
  });
  assert.deepEqual(paths.map((item) => path.basename(item)), ['statement_回填(1).xlsx']);
});

test('目标文件在分配名称后被占用：不覆盖已有文件，按本份失败处理且不留临时文件', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  fs.writeFileSync(outputPath, 'existing');
  await assert.rejects(
    writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE }),
    /目标文件已存在，未覆盖/
  );
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Statement.xlsx', 'Statement_回填.xlsx']);
});

test('写出用调用方已核对指纹的同一份字节，不按路径重读', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const verified = fs.readFileSync(sourcePath);
  // 核对之后原文件被替换成另一份（主表多了一行）：写出仍基于已核对的字节
  await buildStatementWorkbook(sourcePath, { mainRows: [['ValueDate', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Channel'], ['x']] });
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, sourceBuffer: verified, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const cells = readSheetCells(outputPath, 'NGN');
  assert.equal(cells.C3, 'Trade - $65.45');
  assert.equal(cells.F3, 'FX-01');
});

test('文本里的控制字符按 _xHHHH_ 写出，工作表仍是合法 XML；原文中的 _xHHHH_ 片段不被误解码', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'Statement.xlsx');
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, source: SOURCE,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 4, value: 'A\u0001B_x0041_', kind: 'value' }] }] });
  const sheetXml = (await readZipEntries(outputPath))['xl/worksheets/sheet1.xml'];
  assert.doesNotMatch(sheetXml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  assert.match(cellXml(sheetXml, 'F3'), /A_x0001_B_x005F_x0041_/);
  // 独立读取器按 SpreadsheetML 规则解码 _xHHHH_ 转义
  assert.equal(readSheetCells(outputPath, 'NGN').F3, 'A\u0001B_x0041_');
});

test('没有样式部件的 xlsx：写日期时新建最小样式表并登记关系与内容类型', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'NoStyles.xlsx');
  const base = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(base, XLSX.utils.aoa_to_sheet([['ValueDate', 'Debit Amount'], ['', 90000]]), 'NGN');
  const zip = await JSZip.loadAsync(XLSX.write(base, { type: 'buffer', bookType: 'xlsx' }));
  zip.remove('xl/styles.xml');
  const relsPath = 'xl/_rels/workbook.xml.rels';
  zip.file(relsPath, (await zip.file(relsPath).async('string')).replace(/<Relationship [^>]*\/styles"[^>]*\/>/, ''));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string'))
    .replace(/<Override PartName="\/xl\/styles\.xml"[^>]*\/>/, ''));
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  assert.doesNotMatch(await JSZip.loadAsync(fs.readFileSync(sourcePath)).then((item) => item.file(relsPath).async('string')), /styles/);

  const outputPath = path.join(dir, 'NoStyles_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 2, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }] }],
    source: { mainSheetName: 'NGN', columnOffset: 0, dateParseOrder: 'auto' } });
  const entries = await readZipEntries(outputPath);
  assert.match(entries[relsPath], /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/styles" Target="styles\.xml"/);
  assert.match(entries['[Content_Types].xml'], /PartName="\/xl\/styles\.xml"/);
  const styleIndex = Number(/<c r="A2" s="(\d+)"/.exec(entries['xl/worksheets/sheet1.xml'])[1]);
  assert.equal(styleOf(entries['xl/styles.xml'], styleIndex).formatCode, 'dd/mm/yyyy');
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.readFile(outputPath);
  const cell = reread.getWorksheet('NGN').getCell('A2');
  assert.equal(cell.numFmt, 'dd/mm/yyyy');
  assert.equal(readSheetCells(outputPath, 'NGN').A2, 46291);
});

test('非 xlsx（SpreadsheetML 2003 的 .xls）转 xlsx：所有工作表的公式冻结为读取到的结果值', async (t) => {
  const dir = makeTempDir(t);
  const sheet = XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Debit Amount', 'Calc'],
    ['', 90000, { t: 'n', v: 6, f: 'A2+1' }]
  ]);
  const usd = XLSX.utils.aoa_to_sheet([['ValueDate', 'Credit Amount', 'Calc'], [46291, 65.45, { t: 'n', v: 7, f: 'B2*2' }]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'NGN');
  XLSX.utils.book_append_sheet(workbook, usd, 'USD');
  // 读取库写 BIFF8 时不保留公式；SpreadsheetML 2003 保留，读回带 f
  const sourcePath = path.join(dir, 'Statement.xls');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'xlml' });
  assert.equal(XLSX.readFile(sourcePath).Sheets.NGN.C2.f, 'A2+1');
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 2, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }] }],
    source: { mainSheetName: 'NGN', columnOffset: 0, dateParseOrder: 'auto' } });
  const entries = await readZipEntries(outputPath);
  Object.keys(entries).filter((name) => name.startsWith('xl/worksheets/')).forEach((name) => {
    assert.doesNotMatch(entries[name], /<f[ >]/, `${name} 不含公式`);
  });
  assert.equal(readSheetCells(outputPath, 'NGN').C2, 6);
  assert.equal(readSheetCells(outputPath, 'USD').C2, 7);
});

test('目标单元格原本不存在（或没有自身样式）时，以继承的行样式 / 列样式为底套用日期格式', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'inherit.xlsx');
  await buildStatementWorkbook(sourcePath);
  // 改写原文：B 列（ValueDate）设列样式（取 B3 的加粗红字样式），删掉 B3 / B5 单元格；第 5 行设行样式（customFormat）
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetXml = await zip.file(sheetPath).async('string');
  const b3Style = /<c r="B3" s="(\d+)"/.exec(sheetXml)[1];
  const d2Style = /<c r="D2" s="(\d+)"/.exec(sheetXml)[1];
  sheetXml = sheetXml
    .replace(/<c r="B3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '')
    .replace(/<c r="B5"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '')
    .replace(/<row r="5"/, `<row r="5" s="${d2Style}" customFormat="1"`)
    .replace(/<sheetData>/, `<cols><col min="2" max="2" width="12" style="${b3Style}" customWidth="1"/></cols><sheetData>`);
  if (/<cols>[\s\S]*<cols>/.test(sheetXml)) throw new Error('fixture 已有 cols，需调整');
  zip.file(sheetPath, sheetXml);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const outputPath = path.join(dir, 'inherit_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const output = await readZipEntries(outputPath);
  const styleIndexOf = (reference) => Number(/\ss="(\d+)"/.exec(cellXml(output[sheetPath], reference))[1]);
  const base = styleOf(output['xl/styles.xml'], Number(b3Style));
  const b3 = styleOf(output['xl/styles.xml'], styleIndexOf('B3'));
  assert.deepEqual([b3.fontId, b3.borderId, b3.formatCode], [base.fontId, base.borderId, 'dd/mm/yyyy'], 'B3 继承列样式（加粗红字、边框），只换数字格式');
  const rowBase = styleOf(output['xl/styles.xml'], Number(d2Style));
  const b5 = styleOf(output['xl/styles.xml'], styleIndexOf('B5'));
  assert.deepEqual([b5.fontId, b5.borderId, b5.formatCode], [rowBase.fontId, rowBase.borderId, 'dd/mm/yyyy'], 'B5 继承行样式（优先于列样式）');
  assert.equal(styleIndexOf('F5'), Number(d2Style), '非日期值同样继承行样式');
});

test('非日期回填值：原单元格显式带 s="0" 时保留（覆盖行样式），不按继承样式写出', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'explicit-zero.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetXml = await zip.file(sheetPath).async('string');
  const d2Style = /<c r="D2" s="(\d+)"/.exec(sheetXml)[1];
  // 第 5 行设行样式；F5（Channel）是显式 s="0" 的空单元格
  sheetXml = sheetXml
    .replace(/<row r="5"/, `<row r="5" s="${d2Style}" customFormat="1"`)
    .replace(/<c r="F5"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '')
    .replace(/(<row r="5"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="F5" s="0"/>$2');
  zip.file(sheetPath, sheetXml);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'explicit-zero_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const output = await readZipEntries(outputPath);
  assert.match(cellXml(output[sheetPath], 'F5'), /^<c r="F5" s="0"><v>7<\/v><\/c>$/);
});

test('不支持硬链接时的回退发布：写入失败只通过本次的句柄清空并报告待删除路径，不按名称删除；打开失败时不清理', () => {
  const failingFs = (overrides) => {
    const calls = [];
    const impl = {
      linkSync() { const error = new Error('EPERM'); error.code = 'EPERM'; throw error; },
      openSync() { calls.push('open'); return 7; },
      writeSync() { const error = new Error('EIO'); error.code = 'EIO'; throw error; },
      fsyncSync() {},
      ftruncateSync(fd, length) { calls.push(`truncate:${fd}:${length}`); },
      fstatSync() { return { dev: 1, ino: 100 }; },
      lstatSync() { return { dev: 1, ino: 100, isFile: () => true }; },
      unlinkSync(target) { calls.push(`unlink:${path.basename(target)}`); },
      closeSync() { calls.push('close'); },
      rmSync(target) { calls.push(`rm:${path.basename(target)}`); },
      ...overrides
    };
    return { impl, calls };
  };
  const buffer = Buffer.from('xlsx');
  const target = path.join(os.tmpdir(), 'never-created_回填.xlsx');

  const owned = failingFs({});
  assert.throws(() => publishWithoutReplace('tmp', target, buffer, owned.impl),
    (error) => /EIO/.test(error.message) && /已清空，请手动删除/.test(error.message) && error.message.includes(target));
  assert.deepEqual(owned.calls, ['open', 'truncate:7:0', 'close'], '写入失败：只清空本次句柄对应的文件，不按路径删除');

  const openFailed = failingFs({ openSync: () => { const error = new Error('EMFILE'); error.code = 'EMFILE'; throw error; } });
  assert.throws(() => publishWithoutReplace('tmp', target, buffer, openFailed.impl), /EMFILE/);
  assert.deepEqual(openFailed.calls, [], '打开失败：没有取得句柄，不按路径删除');

  const exists = failingFs({ openSync: () => { const error = new Error('EEXIST'); error.code = 'EEXIST'; throw error; } });
  assert.throws(() => publishWithoutReplace('tmp', target, buffer, exists.impl), /目标文件已存在，未覆盖/);
  assert.deepEqual(exists.calls, []);

  let written = 0;
  const ok = failingFs({ writeSync: (_fd, data, offset, length) => { written += length; return Math.min(length, 2); } });
  publishWithoutReplace('tmp', target, buffer, ok.impl);
  assert.deepEqual([ok.calls, written], [['open', 'close'], 4 + 2], '分段写满整个 buffer，成功时不删除');
});

test('写出位置与读取时对不上：目标单元格原文已有值时整份拒绝、不覆盖；文本为空白的共享字符串仍视为空', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'occupied.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheetXml = await zip.file(sheetPath).async('string');
  const sharedPath = 'xl/sharedStrings.xml';
  const sharedXml = await zip.file(sharedPath).async('string');
  const count = (sharedXml.match(/<si>/g) || []).length;
  // 共享字符串末尾追加「  」（空白）与「NIP-OLD」两项
  zip.file(sharedPath, sharedXml.replace(/<\/sst>/, '<si><t xml:space="preserve">  </t></si><si><r><t>NIP-</t></r><r><t>OLD</t></r></si></sst>'));
  const withCell = (xml, reference, index) => xml
    .replace(new RegExp(`<c r="${reference}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), '')
    .replace(new RegExp(`(<row r="${reference.slice(1)}"[^>]*>[\\s\\S]*?)(</row>)`), `$1<c r="${reference}" t="s"><v>${index}</v></c>$2`);
  // F3 为空白共享字符串：可以回填；F5 已有「NIP-OLD」：拒绝
  zip.file(sheetPath, withCell(withCell(sheetXml, 'F3', count), 'F5', count + 1));
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'occupied_回填.xlsx');
  await assert.rejects(
    writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE }),
    /单元格 F5 已有值，与回填时读到的空单元格对不上，未改写/
  );
  assert.equal(fs.existsSync(outputPath), false);
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE });
  const output = await readZipEntries(outputPath);
  assert.match(cellXml(output[sheetPath], 'F3'), /<is><t>FX-01<\/t><\/is>/);
});

test('自闭合空行之后有省略行号的行：读取库与按顺序推算的行号不同，整份拒绝；没有自闭合空行时省略行号照常写出', async (t) => {
  const dir = makeTempDir(t);
  const build = async (name, selfClosing) => {
    const sourcePath = path.join(dir, `${name}.xlsx`);
    await buildStatementWorkbook(sourcePath);
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const xml = await zip.file(sheetPath).async('string');
    // 第 4 行改成自闭合空行（或保留），第 5 行省略行号
    const next = xml
      .replace(/<row r="4"[^>]*>[\s\S]*?<\/row>/, selfClosing ? '<row r="4"/>' : (whole) => whole)
      .replace(/<row r="5"([^>]*)>/, (_whole, attributes) => `<row${attributes}>`);
    assert.notEqual(next, xml);
    zip.file(sheetPath, next);
    fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return sourcePath;
  };
  const ambiguous = await build('ambiguous', true);
  await assert.rejects(
    writeCrossSheetBackfillWorkbook({ sourceFilePath: ambiguous, outputFilePath: path.join(dir, 'a_回填.xlsx'), patches: PATCHES, source: SOURCE }),
    /省略了行号且前面有空行标记，无法与读取结果核对行号/
  );
  const plain = await build('plain', false);
  const outputPath = path.join(dir, 'p_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: plain, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const workbook = XLSX.readFile(outputPath);
  assert.equal(workbook.Sheets.NGN.F5.v, 7);
});

test('日期格式只复用全局数字格式：同格式只定义在条件格式（dxf）里时新增全局项，编号不与 dxf 内的冲突', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'dxf-only.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const stylesPath = 'xl/styles.xml';
  const stylesXml = await zip.file(stylesPath).async('string');
  assert.doesNotMatch(stylesXml, /formatCode="dd\/mm\/yyyy"/);
  const dxfs = '<dxfs count="1"><dxf><numFmt numFmtId="190" formatCode="dd/mm/yyyy"/></dxf></dxfs>';
  const next = /<dxfs\b[^>]*\/>|<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/.test(stylesXml)
    ? stylesXml.replace(/<dxfs\b[^>]*\/>|<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/, dxfs)
    : stylesXml.replace(/<\/cellXfs>/, `</cellXfs>${dxfs}`);
  zip.file(stylesPath, next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'dxf-only_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const output = await readZipEntries(outputPath);
  const style = styleOf(output[stylesPath], Number(/ s="(\d+)"/.exec(cellXml(output['xl/worksheets/sheet1.xml'], 'B3'))[1]));
  assert.equal(style.formatCode, 'dd/mm/yyyy');
  assert.ok(Number(style.numFmtId) > 190, `新增编号 ${style.numFmtId} 不与 dxf 内的 190 冲突`);
  const globalNumFmts = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(output[stylesPath])[1];
  assert.match(globalNumFmts, new RegExp(`numFmtId="${style.numFmtId}" formatCode="dd/mm/yyyy"`));
  const readBack = XLSX.readFile(outputPath, { cellNF: true });
  assert.equal(readBack.Sheets.NGN.B3.w, '26/09/2026');
});

test('ZIP 容器但不是 SpreadsheetML（xlsb、ods）：走转换分支写出 xlsx，不按 xlsx 原位改写', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', '', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, '', '']
  ], { origin: 'B1' }), 'NGN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ValueDate', 'Credit Amount', 'Channel']]), 'USD');
  for (const bookType of ['xlsb', 'ods']) {
    const sourceBuffer = XLSX.write(workbook, { type: 'buffer', bookType });
    assert.equal(sourceBuffer.subarray(0, 2).toString('latin1'), 'PK', `${bookType} 是 ZIP 容器`);
    const outputPath = path.join(dir, `${bookType}_回填.xlsx`);
    const result = await writeCrossSheetBackfillWorkbook({
      sourceFilePath: path.join(dir, `in.${bookType}`), sourceBuffer, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE
    });
    assert.equal(result.converted, true, bookType);
    const readBack = XLSX.readFile(outputPath);
    assert.equal(readBack.Sheets.NGN.F3.v, 'FX-01', bookType);
    assert.equal(readBack.Sheets.NGN.B3.v, isoDateToSerial('2026-09-26'), bookType);
  }
});

test('文本编码：相邻、共用下划线的 _xHHHH_ 字面片段重新读取后与原文一致', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'overlap.xlsx');
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, 'overlap_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, source: SOURCE,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 4, value: '_x000A_x000B_', kind: 'value' }] }] });
  assert.equal(readSheetCells(outputPath, 'NGN').F3, '_x000A_x000B_');
  const output = await readZipEntries(outputPath);
  const inlineText = /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/.exec(cellXml(output['xl/worksheets/sheet1.xml'], 'F3'))[1];
  assert.equal(inlineText, '_x005F_x000A_x005F_x000B_');
  assert.equal(decodeExcelStXstring(inlineText), '_x000A_x000B_');
});

test('目标单元格的文本按 Excel 转义解码后为空白（_x000D_）时视为空，照常回填', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'escaped-blank.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(sheetPath).async('string');
  const next = xml
    .replace(/<c r="F3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '')
    .replace(/(<row r="3"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="F3" t="inlineStr"><is><t>_x000D_</t></is></c>$2');
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'escaped-blank_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE });
  assert.equal(readSheetCells(outputPath, 'NGN').F3, 'FX-01');
});

test('SpreadsheetML 2003 的 .xls 声明 1904：转换写出保留 1904，DateTime 与数值日期、回填日期写后读回都正确', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = Buffer.from(`<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><Date1904/></ExcelWorkbook>
 <Styles><Style ss:ID="d"><NumberFormat ss:Format="yyyy-mm-dd"/></Style></Styles>
 <Worksheet ss:Name="NGN"><Table>
  <Row><Cell ss:Index="2"><Data ss:Type="String">ValueDate</Data></Cell></Row>
  <Row><Cell ss:Index="2" ss:StyleID="d"><Data ss:Type="DateTime">2026-09-25T00:00:00.000</Data></Cell></Row>
  <Row><Cell ss:Index="3"><Data ss:Type="String">Trade - $65.45</Data></Cell></Row>
  <Row><Cell ss:Index="2" ss:StyleID="d"><Data ss:Type="Number">44828</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`);
  const outputPath = path.join(dir, 'xml2003_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'xml2003.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }] }], source: SOURCE
  });
  assert.equal(result.converted, true);
  const readBack = XLSX.readFile(outputPath);
  assert.equal(Boolean(readBack.Workbook && readBack.Workbook.WBProps && readBack.Workbook.WBProps.date1904), true);
  const sheet = readBack.Sheets.NGN;
  const format1904 = (value) => XLSX.SSF.format('yyyy-mm-dd', value, { date1904: true });
  assert.equal(format1904(sheet.B2.v), '2026-09-25', '原有 DateTime 日期不偏移');
  assert.equal(format1904(sheet.B3.v), '2026-09-26', '回填日期');
  assert.equal(format1904(sheet.B4.v), '2026-09-25', '原有数值日期（1904 序号）不偏移');
});

test('启用宏的工作簿内容（xlsm）不按 xlsx 原位改写，走转换分支，写出的是普通 xlsx', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  const next = contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  );
  assert.notEqual(next, contentTypes);
  zip.file('[Content_Types].xml', next);
  const sourceBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(dir, 'macro_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE
  });
  assert.equal(result.converted, true);
  const output = await readZipEntries(outputPath);
  assert.match(output['[Content_Types].xml'], /PartName="\/xl\/workbook\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml"/);
  assert.doesNotMatch(output['[Content_Types].xml'], /sheet\.macroEnabled\.main\+xml/);
  assert.equal(readSheetCells(outputPath, 'NGN').F3, 'FX-01');
});

test('1900 日期系统：1900-03-01 之前的日期按 Excel 序号写出（1900-01-01 为 1，1900-02-28 为 59）', () => {
  assert.equal(isoDateToSerial('1900-01-01'), 1);
  assert.equal(isoDateToSerial('1900-02-28'), 59);
  assert.equal(isoDateToSerial('1900-03-01'), 61);
  assert.equal(isoDateToSerial('2026-09-26'), 46291);
  assert.equal(isoDateToSerial('1904-01-01', true), 0);
});

test('启用宏、声明 1904 的工作簿含 ISO 日期格（t="d"）：转换写出后未回填的原有日期仍是原日期', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro1904.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  ));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const withDate1904 = /<workbookPr\b/.test(workbookXml)
    ? workbookXml.replace(/<workbookPr\b/, '<workbookPr date1904="1"')
    : workbookXml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>');
  assert.notEqual(withDate1904, workbookXml);
  zip.file('xl/workbook.xml', withDate1904);
  // 第二张表 A1 放一个 ISO 日期格：所有工作表都按原日期系统换算
  const sheet2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const nextSheet2 = sheet2.replace(/<c r="A1"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A1" t="d"><v>2026-09-25T00:00:00</v></c>');
  assert.notEqual(nextSheet2, sheet2);
  zip.file('xl/worksheets/sheet2.xml', nextSheet2);
  const sourceBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(dir, 'macro1904_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE
  });
  assert.equal(result.converted, true);
  const readBack = XLSX.readFile(outputPath);
  assert.equal(Boolean(readBack.Workbook.WBProps.date1904), true);
  const cell = readBack.Sheets[readBack.SheetNames[1]].A1;
  assert.equal(cell.v, 44828, '1904 序号');
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v, { date1904: true }), '2026-09-25');
});

test('启用宏、声明 1904 的工作簿中公式的 ISO 日期缓存值：冻结公式前按原日期系统换算', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro1904f.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  ));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  zip.file('xl/workbook.xml', /<workbookPr\b/.test(workbookXml)
    ? workbookXml.replace(/<workbookPr\b/, '<workbookPr date1904="1"')
    : workbookXml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>'));
  const sheet2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const nextSheet2 = sheet2.replace(/<c r="A1"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A1" t="d"><f>DATE(2026,9,25)</f><v>2026-09-25T00:00:00</v></c>');
  assert.notEqual(nextSheet2, sheet2);
  zip.file('xl/worksheets/sheet2.xml', nextSheet2);
  const outputPath = path.join(dir, 'macro1904f_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }),
    outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1),
    source: SOURCE
  });
  const cell = XLSX.readFile(outputPath).Sheets.USD.A1;
  assert.equal(cell.f, undefined, '公式已冻结');
  assert.equal(cell.v, 44828);
});

test('临时文件名已被占用时写出失败，且不删除该已有文件', async (t) => {
  const crypto = require('node:crypto');
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'occupied.xlsx');
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, 'occupied_回填.xlsx');
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('00000000', 'hex'));
  const occupied = path.join(dir, `.backfill-${process.pid}-00000000.tmp`);
  fs.writeFileSync(occupied, 'keep');
  await assert.rejects(() => writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE
  }), /EEXIST/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'keep');
  assert.equal(fs.existsSync(outputPath), false);
});

// ---- v3.2.21 审查回归（第十轮）----

function buildBiffStatement(dir, { usdRows, mainRows } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(mainRows || [
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, '']
  ]), 'NGN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(usdRows || [['ValueDate', 'Credit Amount'], [46291, 65.45]]), 'USD');
  const sourcePath = path.join(dir, 'Statement.xls');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'biff8' });
  return sourcePath;
}
const BIFF_SOURCE = { mainSheetName: 'NGN', columnOffset: 0, dateParseOrder: 'auto' };

test('转换写出保留形似 Excel 转义码的文本：未改动的其他 sheet 与补丁中的 `_x0041_` 读回仍是原文', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = buildBiffStatement(dir, { usdRows: [['ValueDate', 'Credit Amount', 'Ref'], [46291, 65.45, '_x0041_']] });
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 3, value: '_x0042_', kind: 'value' }] }], source: BIFF_SOURCE });
  const readBack = XLSX.readFile(outputPath);
  assert.equal(readBack.Sheets.USD.C2.v, '_x0041_');
  assert.equal(readBack.Sheets.NGN.D3.v, '_x0042_');
  assert.equal(readBack.Sheets.NGN.B3.v, 'Trade - $65.45');
});

test('转换写出同样拒绝覆盖已有值、写入不存在的行，不发布留档文件', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = buildBiffStatement(dir);
  for (const [patches, pattern] of [
    [[{ rowNumber: 2, cells: [{ columnIndex: 3, value: 'FX-01', kind: 'value' }] }], /单元格 D2 已有值/],
    [[{ rowNumber: 9, cells: [{ columnIndex: 3, value: 'FX-01', kind: 'value' }] }], /第 9 行不存在或为空/]
  ]) {
    const outputPath = path.join(dir, 'Statement_回填.xlsx');
    await assert.rejects(() => writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
      patches, source: BIFF_SOURCE }), pattern);
    assert.equal(fs.existsSync(outputPath), false);
  }
});

test('没有要写出的回填文件时不读取导出目录', () => {
  let read = 0;
  const paths = allocateCrossSheetBackfillOutputPaths({
    directory: '/no/such/dir', sourceFilePaths: [], readdirSync: () => { read += 1; return []; }, existsSync: () => false
  });
  assert.deepEqual(paths, []);
  assert.equal(read, 0);
});

// ---- v3.2.21 审查回归（第十一轮）----

async function buildMacroWorkbook(sourcePath, mutateSheet2) {
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  ));
  if (mutateSheet2) {
    const sheet2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
    const next = mutateSheet2(sheet2);
    assert.notEqual(next, sheet2);
    zip.file('xl/worksheets/sheet2.xml', next);
  }
  return zip;
}

test('转换写出：没有缓存结果的布尔公式按空值写出，不冻结成 FALSE；确实缓存的值照常冻结', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro-uncached.xlsx');
  const zip = await buildMacroWorkbook(sourcePath, (xml) => xml
    .replace(/<c r="A1"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A1" t="b"><f>1=1</f></c>')
    .replace(/<c r="B1"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B1" t="b"><f>1=2</f><v>0</v></c>'));
  const outputPath = path.join(dir, 'macro-uncached_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }),
    outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE });
  const usd = XLSX.readFile(outputPath).Sheets.USD;
  assert.equal(usd.A1, undefined);
  assert.equal(usd.B1.v, false);
});

test('转换写出只保留值、类型与数字格式：不带出单元格超链接', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  const main = XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, '']
  ]);
  main.B2.l = { Target: 'file:///C:/Users/someone/secret.xlsx', Tooltip: '原文件' };
  XLSX.utils.book_append_sheet(workbook, main, 'NGN');
  const sourcePath = path.join(dir, 'Linked.xlsm');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsm' });
  const outputPath = path.join(dir, 'Linked_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, sourceBuffer: buffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 3, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE });
  assert.equal(result.converted, true);
  const entries = await readZipEntries(outputPath);
  const texts = Object.values(entries).map((text) => text || '');
  assert.equal(texts.some((text) => /<(?:\w+:)?hyperlink\b|relationships\/hyperlink|secret/.test(text)), false);
  assert.equal(XLSX.readFile(outputPath).Sheets.NGN.B2.v, 'Transfer in');
});

test('样式表没有 cellXfs（所有单元格用默认样式）：补建默认单元格格式后写出日期，保留原有数字格式定义', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'no-cellxfs.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="170" formatCode="0.000"/></numFmts></styleSheet>');
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/\s(?:s|style)="\d+"/g, '').replace(/\scustomFormat="1"/g, ''));
  }
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'no-cellxfs_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const styles = (await readZipEntries(outputPath))['xl/styles.xml'];
  assert.match(styles, /<numFmt numFmtId="170" formatCode="0\.000"\/>/);
  assert.match(styles, /<fonts count="1">[\s\S]*<fills count="2">[\s\S]*<borders count="1">[\s\S]*<cellStyleXfs count="1">[\s\S]*<cellXfs count="2">/);
  const cell = XLSX.readFile(outputPath).Sheets.NGN.B3;
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

test('输出名按 Unicode 规范化比较：组合与分解写法的 Café 指向同一目标，第二份追加 (1)', () => {
  const paths = allocateCrossSheetBackfillOutputPaths({
    directory: '/out',
    sourceFilePaths: ['/a/Caf\u00e9.xlsx', '/b/Cafe\u0301.xlsx'],
    readdirSync: () => [],
    existsSync: () => false
  });
  assert.equal(path.basename(paths[0]).normalize('NFC'), 'Caf\u00e9_回填.xlsx');
  assert.equal(path.basename(paths[1]).normalize('NFC'), 'Caf\u00e9_回填(1).xlsx');
});

test('长文件名账单：临时名长度与原文件名无关，写出成功', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, `${'L'.repeat(235)}.xlsx`);
  await buildStatementWorkbook(sourcePath);
  const outputPath = path.join(dir, `${'L'.repeat(235)}_回填.xlsx`);
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE });
  assert.equal(fs.existsSync(outputPath), true);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

// ---- v3.2.21 审查回归（第十二轮）----

// 按严格 XML 解析器读回：只有一个根元素、标签成对，解析出错时抛出
function assertWellFormedXml(xml) {
  const sax = require('sax');
  const parser = sax.parser(true);
  let depth = 0;
  let roots = 0;
  parser.onopentag = () => { if (depth === 0) roots += 1; depth += 1; };
  parser.onclosetag = () => { depth -= 1; };
  parser.onerror = (error) => { throw error; };
  parser.write(xml).close();
  assert.equal(roots, 1, '只有一个根元素');
}

test('空样式表是自闭合根元素（<styleSheet …/>）时先展开：补建的数字格式与单元格格式都在根元素之内，读回是合法 XML', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'empty-stylesheet.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/\s(?:s|style)="\d+"/g, '').replace(/\scustomFormat="1"/g, ''));
  }
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'empty-stylesheet_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const styles = (await readZipEntries(outputPath))['xl/styles.xml'];
  assertWellFormedXml(styles);
  assert.match(styles, /^[\s\S]*<styleSheet\b[^>]*>[\s\S]*<numFmts\b[\s\S]*<cellXfs\b[\s\S]*<\/styleSheet>\s*$/);
  const cell = XLSX.readFile(outputPath).Sheets.NGN.B3;
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

test('目标单元格是公式文本结果（t="str"）且按 Excel 转义解码后为空白（_x000D_）时：与导入同口径视为空，不按已有值拒绝', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'str-escaped-blank.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(sheetPath).async('string');
  const next = xml
    .replace(/<c r="F3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '')
    .replace(/(<row r="3"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="F3" t="str"><v>_x000D_</v></c>$2');
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'str-escaped-blank_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES.slice(0, 1), source: SOURCE });
  assert.equal(readSheetCells(outputPath, 'NGN').F3, 'FX-01');
});

test('转换写出新建输出工作簿：不带出定义名称中的外部引用与原文件路径', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, '']
  ]), 'NGN');
  workbook.Workbook = { Names: [{ Name: 'ExtRate', Ref: "'C:\\Users\\someone\\[secret.xlsx]Rates'!$A$1" }] };
  const sourcePath = path.join(dir, 'Named.xlsm');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsm' });
  assert.ok((XLSX.read(buffer).Workbook.Names || []).some((name) => name.Name === 'ExtRate'), '原工作簿带该定义名称');
  const outputPath = path.join(dir, 'Named_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, sourceBuffer: buffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 3, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE });
  assert.equal(result.converted, true);
  const texts = Object.values(await readZipEntries(outputPath)).map((text) => text || '');
  assert.equal(texts.some((text) => /secret|ExtRate|definedName/.test(text)), false);
  const output = XLSX.readFile(outputPath);
  assert.equal(output.Sheets.NGN.D3.v, 'FX-01');
  assert.equal(output.Sheets.NGN.B2.v, 'Transfer in');
});

// ---- v3.2.21 审查回归（第十三轮）----

test('输出名超过单个文件名上限（255 字节）时截短原文件名部分：后缀、序号与扩展名保留，能在真实目录中创建', (t) => {
  const dir = makeTempDir(t);
  const byteLength = (name) => Buffer.byteLength(name.normalize('NFD'), 'utf8');
  for (const stem of ['L'.repeat(249), '账'.repeat(83), `${'é'.repeat(80)}`]) {
    const paths = allocateCrossSheetBackfillOutputPaths({
      directory: dir,
      sourceFilePaths: [path.join('/in', `${stem}.xlsx`), path.join('/other', `${stem}.xlsx`)]
    });
    const names = paths.map((item) => path.basename(item));
    assert.ok(names.every((name) => byteLength(name) <= 255), names.map(byteLength).join(','));
    assert.match(names[0], /_回填\.xlsx$/);
    assert.match(names[1], /_回填\(1\)\.xlsx$/);
    paths.forEach((item) => fs.writeFileSync(item, ''));
    paths.forEach((item) => fs.rmSync(item));
  }
  const short = allocateCrossSheetBackfillOutputPaths({ directory: dir, sourceFilePaths: ['/in/Statement.xlsx'] });
  assert.equal(path.basename(short[0]), 'Statement_回填.xlsx', '未超长时名称不变');
});

// ---- v3.2.21 审查回归（第十四轮）----

test('SpreadsheetML 2003 转换写出：原文是不存在的日期（2026-02-30）时保留原文文本，不写成读取库滚入下月的日期', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = Buffer.from(`<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles><Style ss:ID="d"><NumberFormat ss:Format="yyyy-mm-dd"/></Style></Styles>
 <Worksheet ss:Name="NGN"><Table>
  <Row><Cell><Data ss:Type="String">ValueDate</Data></Cell><Cell><Data ss:Type="String">Desc</Data></Cell><Cell><Data ss:Type="String">Channel</Data></Cell></Row>
  <Row><Cell ss:StyleID="d"><Data ss:Type="DateTime">2026-02-30T00:00:00.000</Data></Cell><Cell><Data ss:Type="String">x</Data></Cell><Cell><Data ss:Type="String">NIP</Data></Cell></Row>
  <Row><Cell ss:StyleID="d"><Data ss:Type="DateTime">2026-09-25T00:00:00.000</Data></Cell><Cell><Data ss:Type="String">Trade - $65.45</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`);
  const outputPath = path.join(dir, 'invalid-date_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'invalid-date.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.v, '2026-02-30T00:00:00.000');
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', sheet.A3.v), '2026-09-25');
  assert.equal(sheet.C3.v, 'FX-01');
});

test('内容为 ODS 的账单转换写出（西半球时区）：日期单元格按原文换算，留档文件中的原有日期不早一天', async (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Desc', 'Channel'], ['ODS_DATE', 'x', 'NIP'], ['', 'Trade - $65.45', '']
  ]), 'NGN');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const xml = Buffer.from(content.content).toString('utf8');
  const next = xml.replace('<table:table-cell office:value-type="string"><text:p>ODS_DATE</text:p></table:table-cell>',
    '<table:table-cell office:value-type="date" office:date-value="2026-09-25"><text:p>2026-09-25</text:p></table:table-cell>');
  assert.notEqual(next, xml);
  content.content = Buffer.from(next, 'utf8');
  const sourceBuffer = XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' });
  const outputPath = path.join(dir, 'ods_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  assert.equal(result.converted, true);
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.A2.v, 46290);
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第十五轮）----

function buildOdsSource({ rows, replacements, nullDate }) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'NGN');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  let xml = Buffer.from(content.content).toString('utf8');
  Object.entries(replacements).forEach(([placeholder, cellXml]) => {
    const original = `<table:table-cell office:value-type="string"><text:p>${placeholder}</text:p></table:table-cell>`;
    assert.ok(xml.includes(original), placeholder);
    xml = xml.replace(original, cellXml);
  });
  xml = xml.replace('<office:spreadsheet>',
    `<office:spreadsheet><table:calculation-settings><table:null-date table:date-value="${nullDate}"/></table:calculation-settings>`);
  content.content = Buffer.from(xml, 'utf8');
  return XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' });
}

test('内容为 ODS 的账单声明日期基准 1904-01-01 时转换写出按 1904：留档文件保留 1904，原有日期、数值日期与回填日期都是原日期；不支持的基准不写出', async (t) => {
  const dir = makeTempDir(t);
  const build = (nullDate) => buildOdsSource({
    rows: [['ValueDate', 'Desc', 'Channel'], ['ODS_DATE', 'x', 'NIP'], ['', 'Trade - $65.45', ''], [44831, 'y', 'NIP']],
    replacements: { ODS_DATE: '<table:table-cell office:value-type="date" office:date-value="2026-09-25"><text:p>2026-09-25</text:p></table:table-cell>' },
    nullDate
  });
  const outputPath = path.join(dir, 'ods-1904_回填.xlsx');
  const patches = [{ rowNumber: 3, cells: [
    { columnIndex: 0, value: '2026-09-26', kind: 'date' },
    { columnIndex: 2, value: 'FX-01', kind: 'value' }
  ] }];
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-1904.xls'), sourceBuffer: build('1904-01-01'), outputFilePath: outputPath, patches, source: BIFF_SOURCE
  });
  const output = XLSX.readFile(outputPath);
  assert.equal(Boolean(output.Workbook && output.Workbook.WBProps && output.Workbook.WBProps.date1904), true);
  const sheet = output.Sheets.NGN;
  assert.deepEqual(['A2', 'A3', 'A4'].map((address) => XLSX.SSF.format('yyyy-mm-dd', sheet[address].v, { date1904: true })),
    ['2026-09-25', '2026-09-26', '2026-09-28']);
  await assert.rejects(writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-starcalc.xls'), sourceBuffer: build('1900-01-01'),
    outputFilePath: path.join(dir, 'ods-starcalc_回填.xlsx'), patches, source: BIFF_SOURCE
  }), /日期基准/);
  assert.equal(fs.existsSync(path.join(dir, 'ods-starcalc_回填.xlsx')), false);
});

test('日期格式新增编号：原有数字格式的 formatCode 含字面 >（[>0]0.00）时按完整元素读出编号，新增编号不与之冲突', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'gt-format.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const stylesPath = 'xl/styles.xml';
  const stylesXml = await zip.file(stylesPath).async('string');
  // 编号取已用最大自定义编号 + 1：截断读不到它时，新增的日期格式会拿到同一个编号
  const usedIds = Array.from(stylesXml.matchAll(/numFmtId="(\d+)"/g), (found) => Number(found[1]));
  const gtId = Math.max(163, ...usedIds) + 1;
  const numFmt = `<numFmt formatCode="[>0]0.00;General" numFmtId="${gtId}"/>`;
  const next = /<numFmts\b[^>]*>/.test(stylesXml)
    ? stylesXml.replace(/<numFmts\b[^>]*>/, (open) => `${open}${numFmt}`)
    : stylesXml.replace(/<styleSheet\b[^>]*>/, (open) => `${open}<numFmts count="1">${numFmt}</numFmts>`);
  assert.notEqual(next, stylesXml);
  zip.file(stylesPath, next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'gt-format_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const output = await readZipEntries(outputPath);
  assertWellFormedXml(output[stylesPath]);
  const style = styleOf(output[stylesPath], Number(/ s="(\d+)"/.exec(cellXml(output['xl/worksheets/sheet1.xml'], 'B3'))[1]));
  assert.equal(style.formatCode, 'dd/mm/yyyy');
  assert.ok(Number(style.numFmtId) > gtId, `新增编号 ${style.numFmtId} 排在 ${gtId} 之后`);
  assert.equal((output[stylesPath].match(new RegExp(`<numFmt\\b(?:[^>"']|"[^"]*")*?numFmtId="${gtId}"`, 'g')) || []).length, 1, '该编号只有原金额格式');
  assert.ok(output[stylesPath].includes(numFmt), '原金额格式保留');
});

// ---- v3.2.21 审查回归（第十七轮）----

test('主表表名按 ST_Xstring 转义存储（NGN_x005F_x0041_）：按解码后的名字核对第一个 Sheet，照常原位写出', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'escaped-name.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const renamed = workbookXml.replace(/(<sheet\b[^>]*?name=")NGN(")/, '$1NGN_x005F_x0041_$2');
  assert.notEqual(renamed, workbookXml);
  zip.file('xl/workbook.xml', renamed);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const decodedName = XLSX.readFile(sourcePath).SheetNames[0];
  assert.equal(decodedName, 'NGN_x0041_');
  const outputPath = path.join(dir, 'escaped-name_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: { ...SOURCE, mainSheetName: decodedName }
  });
  assert.equal(result.converted, false);
  assert.equal(XLSX.readFile(outputPath).Sheets[decodedName].F3.v, 'FX-01');
});

test('源文件指纹分块计算、先比大小：大小与导入时不同则不读内容；执行阶段只读导入时的字节数，摘要一致才返回同一份字节', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'big.bin');
  const content = Buffer.alloc(2.5 * 1024 * 1024);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 31) % 251;
  fs.writeFileSync(filePath, content);
  const expected = { size: content.length, sha256: require('node:crypto').createHash('sha256').update(content).digest('hex') };
  assert.deepEqual(computeFileFingerprint(filePath), expected, '跨多个块的摘要与整份计算一致');
  assert.deepEqual(computeFileFingerprint(filePath, { expectedSize: content.length }), expected);
  assert.ok(readFingerprintedFile(filePath, expected).equals(content));

  const readSync = t.mock.method(fs, 'readSync');
  assert.deepEqual(computeFileFingerprint(filePath, { expectedSize: 10 }), { size: content.length, sha256: null });
  assert.equal(readFingerprintedFile(filePath, { size: 10, sha256: expected.sha256 }), null);
  assert.equal(readSync.mock.callCount(), 0, '大小不一致时不读内容');
  readSync.mock.restore();

  const changed = Buffer.from(content);
  changed[changed.length - 1] ^= 0xff;
  fs.writeFileSync(filePath, changed);
  assert.equal(readFingerprintedFile(filePath, expected), null, '同样大小、内容不同');
});

test('源文件被换成命名管道：核对指纹时不打开、不阻塞，按不是普通文件拒绝', { skip: process.platform === 'win32' }, (t) => {
  const dir = makeTempDir(t);
  const fifoPath = path.join(dir, 'pipe.xlsx');
  require('node:child_process').execFileSync('mkfifo', [fifoPath]);
  assert.throws(() => computeFileFingerprint(fifoPath, { expectedSize: 10 }), /不是普通文件/);
  assert.throws(() => readFingerprintedFile(fifoPath, { size: 10, sha256: 'x' }), /不是普通文件/);
});

// ---- v3.2.21 审查回归（第十八轮）----

test('主表表名含字面 `>`（NGN > X）：按属性引号边界读取表名，照常原位写出', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'gt-name.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const renamed = workbookXml.replace(/(<sheet\b[^>]*?name=")NGN(")/, '$1NGN > X$2');
  assert.notEqual(renamed, workbookXml);
  zip.file('xl/workbook.xml', renamed);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'gt-name_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: { ...SOURCE, mainSheetName: 'NGN > X' }
  });
  assert.equal(result.converted, false);
  assert.equal(XLSX.readFile(outputPath).Sheets['NGN > X'].F3.v, 'FX-01');
});

test('行用默认命名空间、单元格用绑定同一命名空间的前缀（<m:c>）：按任意前缀识别并替换原单元格，写出后该坐标只有一个单元格', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'prefixed-cells.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Note', 'Amount'], ['', 5]]), 'MAIN');
  XLSX.writeFile(workbook, sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${main}" xmlns:m="${main}"><sheetData>`
    + '<row r="1"><m:c r="A1" t="inlineStr"><m:is><m:t>Note</m:t></m:is></m:c><m:c r="B1" t="inlineStr"><m:is><m:t>Amount</m:t></m:is></m:c></row>'
    + '<row r="2"><m:c r="A2" t="inlineStr"><m:is><m:t xml:space="preserve"> </m:t></m:is></m:c><m:c r="B2"><m:v>5</m:v></m:c></row>'
    + '</sheetData></worksheet>');
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'prefixed-cells_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    patches: [{ rowNumber: 2, sourceRowNumber: 2, cells: [{ field: 'Note', columnIndex: 0, value: 'FX-01', kind: 'value' }] }],
    source: { mainSheetName: 'MAIN', columnOffset: 0, dateParseOrder: 'auto' }
  });
  const sheetXml = (await readZipEntries(outputPath))['xl/worksheets/sheet1.xml'];
  assert.equal((sheetXml.match(/<(?:[\w.-]+:)?c\b[^>]*\br="A2"/g) || []).length, 1, 'A2 只有一个单元格');
  assert.equal(XLSX.readFile(outputPath).Sheets.MAIN.A2.v, 'FX-01');
});

test('转换为 xlsx：表名中字面的 `_xHHHH_` 按 ST_Xstring 编码写出，Ref_x0041_ 与 RefA 读回仍是两张表、各自的数据', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'escaped-names.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Note', 'Amount'], ['', 5]]), 'Ref_x0041_');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Other'], ['B-1']]), 'RefA');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'biff8' });
  assert.deepEqual(XLSX.readFile(sourcePath).SheetNames, ['Ref_x0041_', 'RefA']);
  const outputPath = path.join(dir, 'escaped-names_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    patches: [{ rowNumber: 2, sourceRowNumber: 2, cells: [{ field: 'Note', columnIndex: 0, value: 'FX-01', kind: 'value' }] }],
    source: { mainSheetName: 'Ref_x0041_', columnOffset: 0, dateParseOrder: 'auto' }
  });
  assert.equal(result.converted, true);
  const written = XLSX.readFile(outputPath);
  assert.deepEqual(written.SheetNames, ['Ref_x0041_', 'RefA']);
  assert.equal(written.Sheets.Ref_x0041_.A2.v, 'FX-01');
  assert.equal(written.Sheets.RefA.A2.v, 'B-1');
});

test('样式表的 numFmts 省略 count（可选属性）且有两个格式：追加日期格式后仍省略 count；声明了 count 时按实际子元素个数更新', async (t) => {
  const dir = makeTempDir(t);
  const stylesPath = 'xl/styles.xml';
  const build = async (fileName, countAttribute) => {
    const sourcePath = path.join(dir, fileName);
    await buildStatementWorkbook(sourcePath);
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const stylesXml = await zip.file(stylesPath).async('string');
    const withoutNumFmts = stylesXml.replace(/<numFmts\b[^>]*?(?:\/>|>[\s\S]*?<\/numFmts>)/, '');
    const next = withoutNumFmts.replace(/<styleSheet\b[^>]*>/, (open) => `${open}<numFmts${countAttribute}>`
      + '<numFmt numFmtId="200" formatCode="0.000"/><numFmt numFmtId="201" formatCode="0.0000"/></numFmts>');
    zip.file(stylesPath, next);
    fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const outputPath = path.join(dir, fileName.replace('.xlsx', '_回填.xlsx'));
    await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
    const output = (await readZipEntries(outputPath))[stylesPath];
    assertWellFormedXml(output);
    const open = /<numFmts\b[^>]*>/.exec(output)[0];
    const children = (/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(output)[1].match(/<numFmt\b/g) || []).length;
    return { open, children };
  };
  const omitted = await build('no-count.xlsx', '');
  assert.equal(omitted.children, 3);
  assert.doesNotMatch(omitted.open, /count=/);
  const wrong = await build('wrong-count.xlsx', ' count="1"');
  assert.equal(wrong.children, 3);
  assert.match(wrong.open, /count="3"/);
});

// ---- v3.2.21 审查回归（第十九轮）----

test('转换为 xlsx：重写表名时按字面量写入，USD$1、A$&B 中的 $1、$& 不当作替换标记', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'dollar-names.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Note', 'Amount'], ['', 5]]), 'USD$1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Other'], ['B-1']]), 'Ref_x0041_');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Other'], ['C-1']]), 'A$&B');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'biff8' });
  const outputPath = path.join(dir, 'dollar-names_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    patches: [{ rowNumber: 2, sourceRowNumber: 2, cells: [{ field: 'Note', columnIndex: 0, value: 'FX-01', kind: 'value' }] }],
    source: { mainSheetName: 'USD$1', columnOffset: 0, dateParseOrder: 'auto' }
  });
  const written = XLSX.readFile(outputPath);
  assert.deepEqual(written.SheetNames, ['USD$1', 'Ref_x0041_', 'A$&B']);
  assert.equal(written.Sheets['USD$1'].A2.v, 'FX-01');
});

test('平面 OpenDocument（FODS，以 .xls 命名）转换写出：按声明的日期基准 1904-01-01 写出，回填日期与原有日期单元格都是原日期', async (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'flat.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Amount'], ['MAIN_DATE', 1], ['', 2]]), 'MAIN');
  let xml = XLSX.write(workbook, { type: 'string', bookType: 'fods' });
  const placeholder = '<table:table-cell office:value-type="string"><text:p>MAIN_DATE</text:p></table:table-cell>';
  assert.ok(xml.includes(placeholder));
  xml = xml.replace(placeholder, '<table:table-cell office:value-type="date" office:date-value="2026-09-24"><text:p>2026-09-24</text:p></table:table-cell>')
    .replace('<office:spreadsheet>', '<office:spreadsheet><table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>');
  fs.writeFileSync(sourcePath, xml, 'utf8');
  const outputPath = path.join(dir, 'flat_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    patches: [{ rowNumber: 3, sourceRowNumber: 2, cells: [{ field: 'Date', columnIndex: 0, value: '2026-09-25', kind: 'date' }] }],
    source: { mainSheetName: 'MAIN', columnOffset: 0, dateParseOrder: 'auto' }
  });
  assert.equal(result.converted, true);
  const written = XLSX.readFile(outputPath);
  assert.ok(written.Workbook.WBProps.date1904, '保留 1904 日期系统');
  const isoOf = (cell) => {
    const parsed = XLSX.SSF.parse_date_code(cell.v, { date1904: true });
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  };
  assert.deepEqual([isoOf(written.Sheets.MAIN.A2), isoOf(written.Sheets.MAIN.A3)], ['2026-09-24', '2026-09-25']);
});

// ---- v3.2.21 审查回归（第二十轮）----

test('ODS 转换写出：公式错误（office:value-type="string" 加 calcext:value-type="error"）按错误值写出，不变成普通文本；未修改的来源表同样保留', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'ods-error.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Note', 'Amount'], ['', 5]]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Credit', 'Other'], ['SRC_ERROR', 'LO_ERROR']]), 'SRC');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const errorCell = (text) => `<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>${text}</text:p></table:table-cell>`;
  let xml = Buffer.from(content.content).toString('utf8');
  xml = xml.replace('<table:table-cell office:value-type="string"><text:p>SRC_ERROR</text:p></table:table-cell>', errorCell('#DIV/0!'))
    .replace('<table:table-cell office:value-type="string"><text:p>LO_ERROR</text:p></table:table-cell>', errorCell('Err:502'));
  content.content = Buffer.from(xml, 'utf8');
  fs.writeFileSync(sourcePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
  const outputPath = path.join(dir, 'ods-error_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath,
    outputFilePath: outputPath,
    patches: [{ rowNumber: 2, sourceRowNumber: 2, cells: [{ field: 'Note', columnIndex: 0, value: 'FX-01', kind: 'value' }] }],
    source: { mainSheetName: 'MAIN', columnOffset: 0, dateParseOrder: 'auto' }
  });
  const written = XLSX.readFile(outputPath);
  assert.equal(written.Sheets.MAIN.A2.v, 'FX-01');
  assert.deepEqual([written.Sheets.SRC.A2.t, written.Sheets.SRC.A2.w], ['e', '#DIV/0!']);
  assert.deepEqual([written.Sheets.SRC.B2.t, written.Sheets.SRC.B2.w], ['e', '#N/A'], 'LibreOffice 的 Err:502 按不可用值写出');
});

// ---- v3.2.21 审查回归（第二十一轮）----

test('样式表没有 cellXfs、根元素结束标签后还有 XML 注释：补建的元素插在根元素之内，读回是合法 XML', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'trailing-comment.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="170" formatCode="0.000"/></numFmts></styleSheet>\n<!-- generated by bank -->\n');
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/\s(?:s|style)="\d+"/g, '').replace(/\scustomFormat="1"/g, ''));
  }
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'trailing-comment_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const styles = (await readZipEntries(outputPath))['xl/styles.xml'];
  assertWellFormedXml(styles);
  assert.match(styles, /<cellXfs count="2">[\s\S]*<\/styleSheet>\n<!-- generated by bank -->\n$/);
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', XLSX.readFile(outputPath).Sheets.NGN.B3.v), '2026-09-26');
});

test('转换写出：文本回填沿用目标格原有的数字格式（0;0;0;"Order: "@ 回填 123 后仍显示 Order: 123）', async (t) => {
  const dir = makeTempDir(t);
  const main = XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Transaction Description', 'Debit Amount', 'Channel'],
    ['21/09/2026', 'Transfer in', 1000, 'NIP'],
    ['', 'Trade - $65.45', 90000, ' ']
  ]);
  main.D3.z = '0;0;0;"Order: "@';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, main, 'NGN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ValueDate', 'Credit Amount'], [46291, 65.45]]), 'USD');
  const sourcePath = path.join(dir, 'Statement.xls');
  XLSX.writeFile(workbook, sourcePath, { bookType: 'biff8' });
  const outputPath = path.join(dir, 'Statement_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 3, value: '123', kind: 'value' }] }], source: BIFF_SOURCE });
  const cell = XLSX.readFile(outputPath, { cellNF: true }).Sheets.NGN.D3;
  assert.deepEqual([cell.t, cell.v, cell.z, cell.w], ['s', '123', '0;0;0;"Order: "@', 'Order: 123']);
});

// ---- v3.2.21 审查回归（第二十二轮）----

test('样式表混用绑定到同一命名空间的前缀（默认命名空间的 cellXfs 下写 <m:xf>）、cellXfs 中有注释掉的 xf：保留全部原样式下标，只追加日期格式', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'mixed-prefix.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const styles = await zip.file('xl/styles.xml').async('string');
  const mixed = styles
    .replace(/<styleSheet\b/, '<styleSheet xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
    .replace(/(<cellXfs\b[^>]*>)([\s\S]*?)(<\/cellXfs>)/, (_whole, open, body, close) => `${open}<!-- <xf numFmtId="0"/> -->`
      + `${body.replace(/<xf\b/g, '<m:xf').replace(/<\/xf>/g, '</m:xf>')}${close}`);
  assert.match(mixed, /<cellXfs\b[^>]*><!-- <xf numFmtId="0"\/> --><m:xf\b/);
  zip.file('xl/styles.xml', mixed);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  // D2 只有样式（#,##0.00）没有值：按占位单元格读出其数字格式
  const before = XLSX.readFile(sourcePath, { cellNF: true, sheetStubs: true }).Sheets.NGN;
  assert.equal(before.D2.z, '#,##0.00');
  const outputPath = path.join(dir, 'mixed-prefix_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: PATCHES, source: SOURCE });
  const outputStyles = (await readZipEntries(outputPath))['xl/styles.xml'];
  assertWellFormedXml(outputStyles);
  const originalXfs = mixed.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1].replace(/<!--[\s\S]*?-->/g, '');
  const outputBody = outputStyles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1];
  assert.ok(outputBody.startsWith(`<!-- <xf numFmtId="0"/> -->${originalXfs}`), '原有 xf 原样保留在原位置');
  const originalCount = (originalXfs.match(/<m:xf\b/g) || []).length;
  // 两种底样式（B3 有字体与边框、B5 默认）各追加一个日期格式，原有下标不变
  assert.equal((outputBody.match(/<m:xf\b/g) || []).length, originalCount + 2);
  assert.match(outputStyles, new RegExp(`<cellXfs\\b[^>]*count="${originalCount + 2}"`));
  const after = XLSX.readFile(outputPath, { cellNF: true, sheetStubs: true }).Sheets.NGN;
  assert.equal(after.D2.z, '#,##0.00', '未改动单元格的数字格式不变');
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', after.B3.v), '2026-09-26');
  assert.equal(after.B3.z, 'dd/mm/yyyy');
});

test('样式表中同一前缀另被绑定到其他命名空间：无法按前缀判断元素归属，拒绝写出这份留档文件', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'rebound-prefix.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const styles = await zip.file('xl/styles.xml').async('string');
  zip.file('xl/styles.xml', styles.replace(/<cellXfs\b/, '<cellXfs xmlns="urn:example:other"'));
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, outputFilePath: path.join(dir, 'rebound-prefix_回填.xlsx'), patches: PATCHES, source: SOURCE
  }), /样式表命名空间无法识别/);
});

test('转换写出：只有样式、没有值的目标格（<c r="F3" s="…"/>）的数字格式同样沿用（000000 回填 123 显示 000123）', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro-stub.xlsx');
  await buildStatementWorkbook(sourcePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  workbook.getWorksheet('NGN').getCell('F3').numFmt = '000000';
  await workbook.xlsx.writeFile(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<c r="F3" s="\d+"\s*\/>/);
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  ));
  const sourceBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(dir, 'macro-stub_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ field: 'Channel', columnIndex: 4, value: 123, kind: 'value' }] }], source: SOURCE
  });
  assert.equal(result.converted, true);
  const cell = XLSX.readFile(outputPath, { cellNF: true }).Sheets.NGN.F3;
  assert.deepEqual([cell.t, cell.v, cell.z, cell.w], ['n', 123, '000000', '000123']);
});

// ---- v3.2.21 审查回归（第二十三轮）----

test('ODS 自闭合单元格（日期、数值只写在属性上）转换写出时保留原值，不在留档文件中丢失', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = buildOdsSource({
    rows: [['ValueDate', 'Desc', 'Channel'], ['ODS_DATE', 'x', 'ODS_NUM'], ['', 'Trade - $65.45', '']],
    replacements: {
      ODS_DATE: '<table:table-cell office:value-type="date" office:date-value="2026-09-25"/>',
      ODS_NUM: '<table:table-cell office:value-type="float" office:value="7"/>'
    },
    nullDate: '1899-12-30'
  });
  const outputPath = path.join(dir, 'ods-self-closing_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-self-closing.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  assert.equal(result.converted, true);
  const sheet = XLSX.readFile(outputPath, { cellNF: true }).Sheets.NGN;
  assert.equal(sheet.A2.v, 46290);
  assert.equal(XLSX.SSF.format(sheet.A2.z, sheet.A2.v), '9/25/26');
  assert.equal(sheet.C2.v, 7);
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第二十四轮）----

test('xlsx 主表 XML 中注释里的旧 sheetData、旧行不算：回填写进实际生效的单元格，注释原样保留，重新打开留档文件能读到回填值', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'commented-sheet-data.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const staleBefore = '<!-- <sheetData><row r="3"><c r="B3"/><c r="F3"/></row></sheetData> -->';
  const staleInside = '<!-- <row r="3"><c r="B3"/></row> -->';
  const next = sheetXml.replace(/<sheetData>/, `${staleBefore}<sheetData>${staleInside}`);
  assert.notEqual(next, sheetXml);
  zip.file('xl/worksheets/sheet1.xml', next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'commented-sheet-data_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: [PATCHES[0]], source: SOURCE });
  assert.equal(result.cellCount, 2);
  const output = (await readZipEntries(outputPath))['xl/worksheets/sheet1.xml'];
  assert.ok(output.includes(staleBefore) && output.includes(staleInside), '注释原样保留');
  const live = output.replace(/<!--[\s\S]*?-->/g, '');
  assert.match(cellXml(live, 'B3'), /<v>46291<\/v>/);
  assert.match(cellXml(live, 'F3'), /FX-01/);
});

test('ODS 重复列的文本单元格（值只在属性上）转换写出时每个位置都保留原值，不当成空格', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = buildOdsSource({
    rows: [['ValueDate', 'Desc', 'Channel', 'Ref'], ['2026-09-25', 'x', 'REPEATED', 'Z'], ['', 'Trade - $65.45', '', '']],
    replacements: { REPEATED: '<table:table-cell office:value-type="string" office:string-value="00123" table:number-columns-repeated="2"/>' },
    nullDate: '1899-12-30'
  });
  const container = XLSX.CFB.read(sourceBuffer, { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const xml = Buffer.from(content.content).toString('utf8');
  const next = xml.replace('<table:table-cell office:value-type="string"><text:p>Z</text:p></table:table-cell>', '');
  assert.notEqual(next, xml);
  content.content = Buffer.from(next, 'utf8');
  const outputPath = path.join(dir, 'ods-repeated_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-repeated.xls'),
    sourceBuffer: XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }),
    outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }],
    source: BIFF_SOURCE
  });
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.C2.v, '00123');
  assert.equal(sheet.D2.v, '00123');
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第二十五轮）----

test('xlsx 写出回填日期按工作簿实际生效的 workbookPr：注释中的旧 date1904="1" 不算，重新打开留档文件读到的仍是回填日期', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'commented-workbook-pr.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const next = workbookXml.replace(/<workbookPr\b[^>]*\/>/, '<!-- <workbookPr date1904="1"/> --><workbookPr date1904="0"/>');
  assert.notEqual(next, workbookXml);
  zip.file('xl/workbook.xml', next);
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'commented-workbook-pr_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: [PATCHES[0]], source: SOURCE });
  const output = XLSX.readFile(outputPath, { cellNF: true });
  assert.equal(Boolean(output.Workbook && output.Workbook.WBProps && output.Workbook.WBProps.date1904), false);
  const cell = output.Sheets.NGN.B3;
  assert.equal(cell.v, 46291);
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

test('ODS 非主表的表尾整行都是只写在属性上的文本格时，转换写出的留档文件保留这些行', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Desc', 'Channel'], ['2026-09-25', 'x', 'NIP'], ['', 'Trade - $65.45', '']
  ]), 'NGN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Ref'], ['P1', 'P2'], ['P3', 'P4']]), 'SRC');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  let xml = Buffer.from(content.content).toString('utf8');
  [['P1', '2026-09-26'], ['P2', 'ORD-1'], ['P3', '2026-09-27'], ['P4', 'ORD-2']].forEach(([placeholder, text]) => {
    const original = `<table:table-cell office:value-type="string"><text:p>${placeholder}</text:p></table:table-cell>`;
    assert.ok(xml.includes(original), placeholder);
    xml = xml.replace(original, `<table:table-cell office:value-type="string" office:string-value="${text}"/>`);
  });
  content.content = Buffer.from(xml, 'utf8');
  const outputPath = path.join(dir, 'ods-tail_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-tail.xls'),
    sourceBuffer: XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }),
    outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }],
    source: BIFF_SOURCE
  });
  const output = XLSX.readFile(outputPath);
  assert.deepEqual(XLSX.utils.sheet_to_json(output.Sheets.SRC, { header: 1, raw: true, defval: '' }),
    [['Date', 'Ref'], ['2026-09-26', 'ORD-1'], ['2026-09-27', 'ORD-2']]);
  assert.equal(output.Sheets.NGN.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第二十六轮）----

async function rewriteZipBuffer(buffer, entryName, mutate) {
  const zip = await JSZip.loadAsync(buffer);
  const original = await zip.file(entryName).async('string');
  const next = mutate(original);
  assert.notEqual(next, original, entryName);
  zip.file(entryName, next);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('xlsx 工作簿关系中有被注释的旧关系（写在生效关系之前或之后）时拒绝写出，不把补丁写进另一张表', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'stale-relationship.xlsx');
  await buildStatementWorkbook(sourcePath);
  const relsXml = (await readZipEntries(sourcePath))['xl/_rels/workbook.xml.rels'];
  const mainId = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="worksheets\/sheet1\.xml"/.exec(relsXml)
    || /<Relationship\b[^>]*Target="worksheets\/sheet1\.xml"[^>]*Id="([^"]+)"/.exec(relsXml);
  assert.ok(mainId, relsXml);
  const stale = `<!-- <Relationship Id="${mainId[1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/> -->`;
  for (const position of ['before', 'after']) {
    const buffer = await rewriteZipBuffer(fs.readFileSync(sourcePath), 'xl/_rels/workbook.xml.rels', (xml) => (position === 'before'
      ? xml.replace('<Relationship ', `${stale}<Relationship `)
      : xml.replace('</Relationships>', `${stale}</Relationships>`)));
    const patchedPath = path.join(dir, `stale-relationship-${position}.xlsx`);
    fs.writeFileSync(patchedPath, buffer);
    await assert.rejects(writeCrossSheetBackfillWorkbook({
      sourceFilePath: patchedPath, outputFilePath: path.join(dir, `stale-relationship-${position}_回填.xlsx`), patches: [PATCHES[0]], source: SOURCE
    }), /关系声明/, position);
  }
});

test('普通 xlsx 的内容类型中注释掉的宏工作簿声明不算：按原位改写写出，未回填工作表的公式保留', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'commented-content-type.xlsx');
  await buildStatementWorkbook(sourcePath);
  let buffer = await rewriteZipBuffer(fs.readFileSync(sourcePath), 'xl/worksheets/sheet2.xml',
    (xml) => xml.replace(/<c r="C2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="C2"><f>100+100</f><v>200</v></c>'));
  buffer = await rewriteZipBuffer(buffer, '[Content_Types].xml', (xml) => xml.replace('<Override ',
    '<!-- <Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/> --><Override '));
  fs.writeFileSync(sourcePath, buffer);
  const outputPath = path.join(dir, 'commented-content-type_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: [PATCHES[0]], source: SOURCE });
  assert.equal(result.converted, false);
  assert.match(cellXml((await readZipEntries(outputPath))['xl/worksheets/sheet2.xml'], 'C2'), /<f>100\+100<\/f>/);
});

test('内容为 xlsm 的账单转换写出按工作簿实际生效的 workbookPr：注释中的旧 date1904="1" 不算，未回填的日期序号仍是原日期', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Desc', 'Channel'], [46290, 'x', 'NIP'], ['', 'Trade - $65.45', '']
  ]), 'NGN');
  const sourceBuffer = await rewriteZipBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsm' }), 'xl/workbook.xml',
    (xml) => xml.replace(/<workbookPr\b[^>]*\/>/, '<!-- <workbookPr date1904="1"/> --><workbookPr/>'));
  const outputPath = path.join(dir, 'xlsm-commented-1904_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'xlsm-commented-1904.xlsx'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }] }], source: BIFF_SOURCE
  });
  assert.equal(result.converted, true);
  const output = XLSX.readFile(outputPath);
  assert.equal(Boolean(output.Workbook && output.Workbook.WBProps && output.Workbook.WBProps.date1904), false);
  assert.equal(output.Sheets.NGN.A2.v, 46290);
  assert.equal(output.Sheets.NGN.A3.v, 46291);
});

test('ODS 转换写出：日期单元格被扩展属性误读成文本时按标准日期写出；只写在属性上的文本保留连续空格；mimetype 被压缩时同样按 ODS 处理', async (t) => {
  const dir = makeTempDir(t);
  let sourceBuffer = buildOdsSource({
    rows: [['ValueDate', 'Desc', 'Channel'], ['ODS_DATE', 'REF_TEXT', 'NIP'], ['', 'Trade - $65.45', '']],
    replacements: {
      ODS_DATE: '<table:table-cell xmlns:other="urn:example:other" office:value-type="date" office:date-value="2026-09-10" other:value-type="string"><text:p>09/10/2026</text:p></table:table-cell>',
      REF_TEXT: '<table:table-cell office:value-type="string" office:string-value="REF  123"/>'
    },
    nullDate: '1899-12-30'
  });
  sourceBuffer = await (await JSZip.loadAsync(sourceBuffer)).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outputPath = path.join(dir, 'ods-foreign-date_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'ods-foreign-date.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  assert.equal(result.converted, true);
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.A2.t, 'n');
  assert.equal(sheet.A2.v, 46275);
  assert.equal(sheet.B2.v, 'REF  123');
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第二十七轮）----

test('普通 xlsx 的根关系中注释掉的旧关系按 Excel 忽略：仍按原位改写写出，未回填工作表的公式保留', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'commented-root-relationship.xlsx');
  await buildStatementWorkbook(sourcePath);
  let buffer = await rewriteZipBuffer(fs.readFileSync(sourcePath), 'xl/worksheets/sheet2.xml',
    (xml) => xml.replace(/<c r="C2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="C2"><f>100+100</f><v>200</v></c>'));
  buffer = await rewriteZipBuffer(buffer, '_rels/.rels', (xml) => xml.replace('</Relationships>',
    '<!-- <Relationship Id="rIdOld" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/old.xml"/> --></Relationships>'));
  fs.writeFileSync(sourcePath, buffer);
  const outputPath = path.join(dir, 'commented-root-relationship_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: [PATCHES[0]], source: SOURCE });
  assert.equal(result.converted, false);
  assert.match(cellXml((await readZipEntries(outputPath))['xl/worksheets/sheet2.xml'], 'C2'), /<f>100\+100<\/f>/);
});

test('Strict OOXML 工作簿没有样式部件时，补建的样式表与样式关系按 Strict 的命名空间与关系类型', async (t) => {
  const dir = makeTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['ValueDate', 'Desc', 'Channel'], [46290, 'x', 'NIP'], [null, 'Trade - $65.45', null]
  ]), 'NGN');
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  zip.remove('xl/styles.xml');
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(?:xml|rels)$/.test(name)) continue;
    let xml = await zip.file(name).async('string');
    xml = xml
      .replace(/<Relationship\b[^>]*relationships\/styles"[^>]*\/>/g, '')
      .replace(/<Override\b[^>]*PartName="\/xl\/styles\.xml"[^>]*\/>/g, '')
      .split('http://schemas.openxmlformats.org/spreadsheetml/2006/main').join('http://purl.oclc.org/ooxml/spreadsheetml/main')
      .split('http://schemas.openxmlformats.org/officeDocument/2006/relationships').join('http://purl.oclc.org/ooxml/officeDocument/relationships');
    zip.file(name, xml);
  }
  const sourcePath = path.join(dir, 'strict.xlsx');
  fs.writeFileSync(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const outputPath = path.join(dir, 'strict_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 0, value: '2026-09-26', kind: 'date' }] }], source: BIFF_SOURCE
  });
  assert.equal(result.converted, false);
  const entries = await readZipEntries(outputPath);
  const stylesName = Object.keys(entries).find((name) => /^xl\/styles\d*\.xml$/.test(name));
  assert.ok(stylesName, Object.keys(entries).join(','));
  assert.match(entries[stylesName], /xmlns="http:\/\/purl\.oclc\.org\/ooxml\/spreadsheetml\/main"/);
  assert.match(entries['xl/_rels/workbook.xml.rels'], /Type="http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships\/styles"/);
  assert.doesNotMatch(entries['xl/_rels/workbook.xml.rels'], /schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/styles/);
  assert.match(cellXml(entries['xl/worksheets/sheet1.xml'], 'A3'), /<v>46291<\/v>/);
});

// ---- v3.2.21 审查回归（第二十八轮）----

function buildOdsWithSecondSheet(sourcePath, { secondName, secondRows, replacements = {} }) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Note', 'Amount'], ['', 5]]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(secondRows), secondName);
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  let xml = Buffer.from(content.content).toString('utf8');
  Object.entries(replacements).forEach(([placeholder, cellXml]) => {
    const original = `<table:table-cell office:value-type="string"><text:p>${placeholder}</text:p></table:table-cell>`;
    assert.ok(xml.includes(original), placeholder);
    xml = xml.replace(original, cellXml);
  });
  content.content = Buffer.from(xml, 'utf8');
  fs.writeFileSync(sourcePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
}

const ODS_NOTE_PATCH = [{ rowNumber: 2, sourceRowNumber: 2, cells: [{ field: 'Note', columnIndex: 0, value: 'FX-01', kind: 'value' }] }];
const ODS_MAIN_SOURCE = { mainSheetName: 'MAIN', columnOffset: 0, dateParseOrder: 'auto' };

test('ODS 转换写出：未回填工作表的表名按实际名称写出（Cash & Bank 不变成 Cash &amp; Bank），读回仍是原表名', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'ods-escaped-sheet-name.xls');
  buildOdsWithSecondSheet(sourcePath, { secondName: 'Cash & Bank', secondRows: [['Credit'], [7]] });
  const outputPath = path.join(dir, 'ods-escaped-sheet-name_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: ODS_NOTE_PATCH, source: ODS_MAIN_SOURCE });
  assert.equal(result.converted, true);
  const written = XLSX.readFile(outputPath);
  assert.deepEqual(written.SheetNames, ['MAIN', 'Cash & Bank']);
  assert.equal(written.Sheets['Cash & Bank'].A2.v, 7);
  assert.match((await readZipEntries(outputPath))['xl/workbook.xml'], /name="Cash &amp; Bank"/);
});

test('ODS 转换写出：公式错误的错误码只写在 office:string-value 上（没有显示文本）时按原错误码写出，不变成 #N/A', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'ods-error-attribute.xls');
  buildOdsWithSecondSheet(sourcePath, {
    secondName: 'SRC',
    secondRows: [['Credit', 'Other'], ['ATTR_ERROR', 'TEXT_ERROR']],
    replacements: {
      ATTR_ERROR: '<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="#DIV/0!" calcext:value-type="error"/>',
      TEXT_ERROR: '<table:table-cell table:formula="of:=NA()" office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>#VALUE!</text:p></table:table-cell>'
    }
  });
  const outputPath = path.join(dir, 'ods-error-attribute_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: ODS_NOTE_PATCH, source: ODS_MAIN_SOURCE });
  const written = XLSX.readFile(outputPath);
  assert.deepEqual([written.Sheets.SRC.A2.t, written.Sheets.SRC.A2.w], ['e', '#DIV/0!']);
  assert.deepEqual([written.Sheets.SRC.B2.t, written.Sheets.SRC.B2.w], ['e', '#VALUE!'], '标准属性为空时取显示文本');
});

// ---- v3.2.21 审查回归（第二十九轮）----

test('ODS 转换写出：表尾只有自闭合公式错误单元格的行（读取库不计入范围）在留档中保留为原错误值，不丢成空白', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'ods-tail-error.xls');
  buildOdsWithSecondSheet(sourcePath, {
    secondName: 'SRC',
    secondRows: [['Credit'], ['TAIL_ERROR']],
    replacements: {
      TAIL_ERROR: '<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="#DIV/0!" calcext:value-type="error"/>'
    }
  });
  const outputPath = path.join(dir, 'ods-tail-error_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: ODS_NOTE_PATCH, source: ODS_MAIN_SOURCE });
  const written = XLSX.readFile(outputPath);
  assert.equal(written.Sheets.SRC['!ref'], 'A1:A2');
  assert.deepEqual([written.Sheets.SRC.A2.t, written.Sheets.SRC.A2.w], ['e', '#DIV/0!']);
});

// ---- v3.2.21 审查回归（第三十轮）----

test('SpreadsheetML 2003 转换写出：自闭合的合并单元格后面的单元格按跨度定位（与导入时同一坐标），留档中不左移', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = Buffer.from(`<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="NGN"><Table>
  <Row><Cell><Data ss:Type="String">ValueDate</Data></Cell><Cell><Data ss:Type="String">Desc</Data></Cell><Cell><Data ss:Type="String">Channel</Data></Cell><Cell><Data ss:Type="String">Ref</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">x</Data></Cell><Cell ss:MergeAcross="1"/><Cell><Data ss:Type="String">R-1</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">y</Data></Cell><Cell><Data ss:Type="String">Trade - $65.45</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`);
  const outputPath = path.join(dir, 'merged_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'merged.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.D2.v, 'R-1');
  assert.equal(sheet.C2, undefined);
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第三十一轮）----

test('SpreadsheetML 2003 转换写出：带时区偏移的 DateTime（读取库读成文本）按原文换算成日期序号写出，与导入时一致', async (t) => {
  const dir = makeTempDir(t);
  const sourceBuffer = Buffer.from(`<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="NGN"><Table>
  <Row><Cell><Data ss:Type="String">ValueDate</Data></Cell><Cell><Data ss:Type="String">Desc</Data></Cell><Cell><Data ss:Type="String">Channel</Data></Cell></Row>
  <Row><Cell><Data ss:Type="DateTime">2026-09-25T12:00:00+02:00</Data></Cell><Cell><Data ss:Type="String">x</Data></Cell><Cell><Data ss:Type="String">C</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">y</Data></Cell><Cell><Data ss:Type="String">Trade - $65.45</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`);
  const outputPath = path.join(dir, 'offset_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: path.join(dir, 'offset.xls'), sourceBuffer, outputFilePath: outputPath,
    patches: [{ rowNumber: 3, cells: [{ columnIndex: 2, value: 'FX-01', kind: 'value' }] }], source: BIFF_SOURCE
  });
  const sheet = XLSX.readFile(outputPath).Sheets.NGN;
  assert.equal(sheet.A2.t, 'n');
  assert.equal(sheet.A2.v, 46290.5);
  assert.equal(sheet.C3.v, 'FX-01');
});

// ---- v3.2.21 审查回归（第三十二轮）----

test('回填写出：date1904 首尾带空白时与 1 同样按 1904 写出日期；无法识别的取值拒绝写出（原位改写与启用宏的转换写出）', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'date1904-space.xlsx');
  await buildStatementWorkbook(sourcePath);
  const variant = async (value, { macro = false } = {}) => {
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    if (macro) {
      const contentTypes = await zip.file('[Content_Types].xml').async('string');
      zip.file('[Content_Types].xml', contentTypes.replace(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
      ));
    }
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    zip.file('xl/workbook.xml', /<workbookPr\b/.test(workbookXml)
      ? workbookXml.replace(/<workbookPr\b/, `<workbookPr date1904="${value}"`)
      : workbookXml.replace(/(<workbook\b[^>]*>)/, `$1<workbookPr date1904="${value}"/>`));
    const outputPath = path.join(dir, `out-${macro ? 'macro' : 'plain'}-${encodeURIComponent(value)}.xlsx`);
    await writeCrossSheetBackfillWorkbook({
      sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }), outputFilePath: outputPath,
      patches: PATCHES.slice(0, 1), source: SOURCE
    });
    return XLSX.readFile(outputPath).Sheets.NGN;
  };
  for (const macro of [false, true]) {
    const reference = await variant('1', { macro });
    const spaced = await variant(' true ', { macro });
    assert.equal(spaced.B3.v, reference.B3.v, `macro=${macro}`);
    assert.equal(XLSX.SSF.format('yyyy-mm-dd', spaced.B3.v, { date1904: true }), '2026-09-26');
    await assert.rejects(() => variant('yes', { macro }), /日期系统/, `macro=${macro}`);
  }
});

// ---- v3.2.21 审查回归（第三十三轮）----

test('回填写出：目标格是内联字符串 <t><![CDATA[ ]]></t>（导入读作一个空格、按空格回填）时同样按空格写入，不当成已有值拒绝', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'inline-cdata-space.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const nextSheetXml = sheetXml.replace(/<c r="B3"([^>]*?)\/>/, '<c r="B3"$1 t="inlineStr"><is><t><![CDATA[ ]]></t></is></c>');
  assert.notEqual(nextSheetXml, sheetXml);
  zip.file('xl/worksheets/sheet1.xml', nextSheetXml);
  const outputPath = path.join(dir, 'inline-cdata-space_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }), outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1), source: SOURCE
  });
  const cell = XLSX.readFile(outputPath).Sheets.NGN.B3;
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

test('ODS 转换写出：被合并覆盖的单元格带重复计数时，留档中后面的单元格按实际坐标写出（与导入时一致，不左移）', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'ods-covered-convert.xls');
  buildOdsWithSecondSheet(sourcePath, {
    secondName: 'SRC',
    secondRows: [['P1', 'X1', 'Y1', 65.45, 'e']],
    replacements: {
      P1: '<table:table-cell office:value-type="string" table:number-columns-spanned="3"><text:p>P1</text:p></table:table-cell>',
      X1: '<table:covered-table-cell table:number-columns-repeated="2"/>',
      Y1: ''
    }
  });
  const outputPath = path.join(dir, 'ods-covered-convert_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({ sourceFilePath: sourcePath, outputFilePath: outputPath, patches: ODS_NOTE_PATCH, source: ODS_MAIN_SOURCE });
  const sheet = XLSX.readFile(outputPath).Sheets.SRC;
  assert.equal(sheet.D1.v, 65.45);
  assert.equal(sheet.E1.v, 'e');
});

// ---- v3.2.21 审查回归（第三十四轮）----

test('回填写出：目标格是公式文本结果 <c t="str"><v><![CDATA[ ]]></v></c>（导入读作一个空格、按空格回填）时按空格写入，不当成已有值拒绝', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'str-cdata-space.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const nextSheetXml = sheetXml.replace(/<c r="B3"([^>]*?)\/>/, '<c r="B3"$1 t="str"><v><![CDATA[ ]]></v></c>');
  assert.notEqual(nextSheetXml, sheetXml);
  zip.file('xl/worksheets/sheet1.xml', nextSheetXml);
  const outputPath = path.join(dir, 'str-cdata-space_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }), outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1), source: SOURCE
  });
  const cell = XLSX.readFile(outputPath).Sheets.NGN.B3;
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

test('回填写出：主表表名含字符引用（A&#38;amp;B，即表名 A&amp;B）时与导入同样只解码一次，按导入时的表名找到主表', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'sheet-name-char-ref.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const nextWorkbookXml = workbookXml.replace('name="NGN"', 'name="A&#38;amp;B"');
  assert.notEqual(nextWorkbookXml, workbookXml);
  zip.file('xl/workbook.xml', nextWorkbookXml);
  const sourceBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  assert.deepEqual(XLSX.read(sourceBuffer, { type: 'buffer' }).SheetNames, ['A&amp;B', 'USD']);
  const outputPath = path.join(dir, 'sheet-name-char-ref_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer, outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1), source: { ...SOURCE, mainSheetName: 'A&amp;B' }
  });
  const cell = XLSX.readFile(outputPath).Sheets['A&amp;B'].B3;
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', cell.v), '2026-09-26');
});

// ---- v3.2.21 审查回归（第三十五轮）----

async function rewriteStatementParts(sourcePath, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const parts = {};
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']) parts[name] = await zip.file(name).async('string');
  const next = mutate(parts);
  Object.entries(next).forEach(([name, text]) => {
    assert.notEqual(text, parts[name], name);
    zip.file(name, text);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('回填写出：共享字符串表的注释中有旧条目时按实际生效的条目核对目标格（引用 ORIGINAL 的格已有值，拒绝覆盖，不按注释中的空白当成空格）', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'sst-comment-target.xlsx');
  await buildStatementWorkbook(sourcePath);
  const sourceBuffer = await rewriteStatementParts(sourcePath, (parts) => {
    const sst = parts['xl/sharedStrings.xml'];
    const index = (sst.match(/<si>/g) || []).length;
    return {
      'xl/sharedStrings.xml': sst.replace('</sst>', '<!--<si><t> </t></si>--><si><t>ORIGINAL</t></si></sst>'),
      'xl/worksheets/sheet1.xml': parts['xl/worksheets/sheet1.xml'].replace(/<c r="B3"([^>]*?)\/>/, `<c r="B3"$1 t="s"><v>${index}</v></c>`)
    };
  });
  await assert.rejects(writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer, outputFilePath: path.join(dir, 'sst-comment-target_回填.xlsx'),
    patches: PATCHES.slice(0, 1), source: SOURCE
  }), /B3 已有值/);
});

test('回填写出：目标格中只有注释里写着 <f>（不是实际的公式元素）时按空格回填，不当成含公式拒绝', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'formula-in-comment.xlsx');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const nextSheetXml = sheetXml.replace(/<c r="B3"([^>]*?)\/>/, '<c r="B3"$1><!-- <f>TODAY()</f> --></c>');
  assert.notEqual(nextSheetXml, sheetXml);
  zip.file('xl/worksheets/sheet1.xml', nextSheetXml);
  const outputPath = path.join(dir, 'formula-in-comment_回填.xlsx');
  await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }), outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1), source: SOURCE
  });
  assert.equal(XLSX.SSF.format('yyyy-mm-dd', XLSX.readFile(outputPath).Sheets.NGN.B3.v), '2026-09-26');
});

// ---- v3.2.21 审查回归（第三十六轮）----

test('启用宏的工作簿转换写出：共享字符串表含自闭合空条目与注释中的旧条目时与导入同一改写，未回填的原有文本不变成空白或错位', async (t) => {
  const dir = makeTempDir(t);
  const sourcePath = path.join(dir, 'macro-sst.xls');
  await buildStatementWorkbook(sourcePath);
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  ));
  const sst = await zip.file('xl/sharedStrings.xml').async('string');
  const nextSst = sst.replace(/(<sst\b[^>]*>)/, '$1<si/><!--<si><t> </t></si>-->');
  assert.notEqual(nextSst, sst);
  zip.file('xl/sharedStrings.xml', nextSst);
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    const xml = await zip.file(name).async('string');
    const next = xml.replace(/(<c\b[^>]*\bt="s"[^>]*>\s*<v>)(\d+)(<\/v>)/g, (_whole, open, index, close) => `${open}${Number(index) + 1}${close}`);
    assert.notEqual(next, xml, name);
    zip.file(name, next);
  }
  const outputPath = path.join(dir, 'macro-sst_回填.xlsx');
  const result = await writeCrossSheetBackfillWorkbook({
    sourceFilePath: sourcePath, sourceBuffer: await zip.generateAsync({ type: 'nodebuffer' }), outputFilePath: outputPath,
    patches: PATCHES.slice(0, 1), source: SOURCE
  });
  assert.equal(result.converted, true);
  const cells = readSheetCells(outputPath, 'NGN');
  assert.deepEqual([cells.B1, cells.C2, cells.F2, cells.C3, cells.F3], ['ValueDate', 'Transfer in', 'NIP', 'Trade - $65.45', 'FX-01']);
});
