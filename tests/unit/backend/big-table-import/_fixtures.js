'use strict';
// 大表导入引擎四方 harness 共享 fixture builder（v3.0.3 块 D · PR-G1）
//
// 与 acquiring-bill-currency-import/reader-handrolled-contract.test.js 的 fixture 构造方式一致
//   （ExcelJS sharedStrings 路径 / yazl 手工拼 sheet1.xml 精确控制 cell 形态 / SST）；
//   独立成文件供四方 harness 复用，不改动既有 contract test（其 25 用例断言与通过状态保持原样）。
//
// 提供：mkTmpDir / row / writeFixtureExcelJS / colLetter / escXml / rowToInlineStrCells /
//       writeRawSheetXlsx / buildSst / writeMultiSheetXlsx（多 sheet 报错测试用，新增）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const yazl = require('yazl');

const tmpDirs = [];
function cleanupTmpDirs() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  tmpDirs.length = 0;
}

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// 行数组工具：长度 len，o 是 {colIndex: value}
function row(len, o) {
  const r = new Array(len).fill('');
  for (const k of Object.keys(o)) r[Number(k)] = o[k];
  return r;
}

// ExcelJS fixture（默认 sharedStrings t="s"）。rows 为二维数组；sparse 为 [{rowNum, cells}]。
async function writeFixtureExcelJS({ name = 'Sheet1', rows, sparse }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  if (sparse) {
    for (const { rowNum, cells } of sparse) ws.getRow(rowNum).values = cells;
  } else {
    for (const r of rows) ws.addRow(r);
  }
  const fp = path.join(mkTmpDir('btie-xlsx-'), 'fixture.xlsx');
  await wb.xlsx.writeFile(fp);
  return fp;
}

function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 把一行 cells（string[]）渲染为 inlineStr <c> 序列（空串跳过 → 与 ExcelJS 稀疏写一致）
function rowToInlineStrCells(cells, rowNum) {
  let xml = '';
  cells.forEach((v, i) => {
    if (v === '' || v == null) return;
    xml += `<c r="${colLetter(i)}${rowNum}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  });
  return xml;
}

// yazl 手工 xlsx：sheetRows 为 [{ r:行号, raw?:string(原始<c>序列), cells?:string[](inlineStr), selfClose?:bool }]
//   raw 优先（精确控制 cell 形态）；否则 cells 渲染为 inlineStr。sst 可选（sharedStrings.xml 内容）。
function writeRawSheetXlsx({ sheetRows, sst = null }) {
  let body = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  for (const sr of sheetRows) {
    if (sr.selfClose) { body += `<row r="${sr.r}"/>`; continue; }
    body += `<row r="${sr.r}">`;
    body += sr.raw !== undefined ? sr.raw : rowToInlineStrCells(sr.cells, sr.r);
    body += '</row>';
  }
  body += '</sheetData></worksheet>';

  const fp = path.join(mkTmpDir('btie-raw-'), 'fixture.xlsx');
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(body, 'utf8'), 'xl/worksheets/sheet1.xml');
    if (sst) zf.addBuffer(Buffer.from(sst, 'utf8'), 'xl/sharedStrings.xml');
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

// 构造 sharedStrings.xml（strings: string[]）
function buildSst(strings) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`;
  for (const s of strings) xml += `<si><t>${escXml(s)}</t></si>`;
  xml += '</sst>';
  return xml;
}

// 多 sheet xlsx（用于 zip-reader 多 sheet 显式报错测试）。
//   sheets：[{ name, body?:string(sheetData 内 <row> 序列) }]，按顺序生成 worksheets/sheetN.xml + workbook.xml(.rels)。
function writeMultiSheetXlsx({ sheets }) {
  const dir = mkTmpDir('btie-multi-');
  const fp = path.join(dir, 'fixture.xlsx');
  const sheetEntries = sheets.map((s, i) => ({
    name: s.name,
    rid: `rId${i + 1}`,
    target: `worksheets/sheet${i + 1}.xml`,
    body: s.body || ''
  }));
  const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheetEntries.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join('')
    + '</sheets></workbook>';
  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheetEntries.map((s) => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target}"/>`).join('')
    + '</Relationships>';
  const sheetXml = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + body + '</sheetData></worksheet>';

  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(wbXml, 'utf8'), 'xl/workbook.xml');
    zf.addBuffer(Buffer.from(relsXml, 'utf8'), 'xl/_rels/workbook.xml.rels');
    for (const s of sheetEntries) zf.addBuffer(Buffer.from(sheetXml(s.body), 'utf8'), `xl/${s.target}`);
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

module.exports = {
  mkTmpDir,
  cleanupTmpDirs,
  row,
  writeFixtureExcelJS,
  colLetter,
  escXml,
  rowToInlineStrCells,
  writeRawSheetXlsx,
  buildSst,
  writeMultiSheetXlsx
};
