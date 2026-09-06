'use strict';
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { BIZ_OP_HEADERS, FLOW_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function column(index) {
  let result = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result;
  return result;
}
function rowXml(values, index) {
  return `<row r="${index}">${values.map((input, col) => {
    const cell = input && typeof input === 'object' ? input : { t: 'inlineStr', v: input ?? '' };
    const content = cell.t === 'inlineStr' ? `<is><t>${escape(cell.v)}</t></is>` : `<v>${escape(cell.v)}</v>`;
    return `<c r="${column(col)}${index}" t="${cell.t || 'n'}"${cell.s ? ` s="${cell.s}"` : ''}>${cell.f !== undefined ? `<f>${escape(cell.f)}</f>` : ''}${content}</c>`;
  }).join('')}</row>`;
}
async function writeXlsx(filePath, { kind = 'FLOW', headers, rowCount, row, sharedStrings = [], date1904 = false,
  secondSheet = false, brokenTail = false, brokenSst = false } = {}) {
  const zip = new ZipFile();
  const add = (name, text) => zip.addBuffer(Buffer.from(text), name);
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  add('xl/workbook.xml', `<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="原始数据" sheetId="1" r:id="rId1"/>${secondSheet ? '<sheet name="隐藏页" sheetId="2" state="hidden" r:id="rId4"/>' : ''}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>${secondSheet ? `<Relationship Id="rId4" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` : ''}</Relationships>`);
  add('xl/styles.xml', `<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  if (brokenSst) add('xl/sharedStrings.xml', '<sst broken');
  else {
    async function* strings() {
      yield `<sst xmlns="${NS}">`;
      const count = Array.isArray(sharedStrings) ? sharedStrings.length : sharedStrings.count;
      for (let i = 0; i < count; i += 1) yield `<si><t>${escape(Array.isArray(sharedStrings) ? sharedStrings[i] : sharedStrings.at(i))}</t></si>`;
      yield '</sst>';
    }
    zip.addReadStream(Readable.from(strings()), 'xl/sharedStrings.xml');
  }
  if (secondSheet) add('xl/worksheets/sheet2.xml', `<worksheet xmlns="${NS}"><sheetData/></worksheet>`);
  async function* worksheet() {
    yield `<worksheet xmlns="${NS}"><sheetData>${rowXml(headers || (kind === 'OP' ? BIZ_OP_HEADERS : FLOW_HEADERS), 1)}`;
    for (let i = 0; i < rowCount; i += 1) yield rowXml(row(i), i + 2);
    yield brokenTail ? '</broken>' : '</sheetData></worksheet>';
  }
  zip.addReadStream(Readable.from(worksheet()), 'xl/worksheets/sheet1.xml');
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(filePath, { flags: 'wx' }));
}
function flowRow({ date = '2026-09-02', bu = 'Alpha', account = '000123', amount = '1.25', direction = '入', number = '0001' } = {}) {
  const row = Array(28).fill('');
  for (const [index, value] of [[1, date], [4, '主体'], [6, bu], [8, direction], [9, number], [11, account], [13, amount], [14, 'usd'], [15, '付款']]) row[index] = value;
  return row;
}
function opRow({ date = '2026-09-01', bu = 'Alpha', account = '000123', begin = '100', amount = '10', incoming = '10', outgoing = '0', end = '110' } = {}) {
  return [date, bu, '客户001', '主体', account, '付款', 'usd', begin, amount, incoming, outgoing, end, ...Array(11).fill('')];
}
module.exports = { writeXlsx, flowRow, opRow };
