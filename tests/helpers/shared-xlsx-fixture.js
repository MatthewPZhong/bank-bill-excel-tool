'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheetXml = (rows) => `<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`;
const defaultRows = '<row r="1"><c r="A1" t="inlineStr"><is><t>标题&amp;</t></is></c><c r="C1"/><c r="E1" t="inlineStr"><is><t>尾列</t></is></c></row>'
  + '<row r="3"><c r="A3"><v>001.2300</v></c><c r="B3" t="inlineStr"><is><r><t>甲&lt;</t></r><r><t>乙&#x1F600;</t></r></is></c></row>'
  + '<row r="5"><c r="A5"><v>1e3</v></c><c r="B5" t="str"><v xml:space="preserve"> 尾&amp; </v></c></row>';

function workbookXml(sheets, date1904 = false) {
  return `<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets>`
    + sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.id || `rId${index + 1}`}"${sheet.state ? ` state="${sheet.state}"` : ''}/>`).join('')
    + '</sheets></workbook>';
}

function relationshipsXml(relationships) {
  return `<Relationships xmlns="${PACKAGE_REL}">`
    + relationships.map((rel) => `<Relationship Id="${rel.id}" Type="${REL}/${rel.type || 'worksheet'}" Target="${rel.target}"${rel.mode ? ` TargetMode="${rel.mode}"` : ''}/>`).join('')
    + '</Relationships>';
}

async function writeFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-xlsx-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.xlsx');
  const sheets = options.sheets || [{ name: '数据', target: 'worksheets/sheet1.xml', rows: defaultRows }];
  const relationships = options.relationships || sheets.map((sheet, index) => ({
    id: sheet.id || `rId${index + 1}`, target: sheet.target || `worksheets/sheet${index + 1}.xml`
  }));
  const zip = new JSZip();
  zip.file('xl/workbook.xml', options.workbook || workbookXml(sheets, options.date1904));
  if (options.includeRels !== false) zip.file('xl/_rels/workbook.xml.rels', relationshipsXml(relationships));
  for (const [index, sheet] of sheets.entries()) {
    zip.file(`xl/${sheet.target || `worksheets/sheet${index + 1}.xml`}`, sheetXml(sheet.rows ?? defaultRows));
  }
  if (options.styles !== undefined) zip.file('xl/styles.xml', options.styles);
  if (options.sst !== undefined) zip.file('xl/sharedStrings.xml', options.sst);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { dir, file, zip };
}

module.exports = { NS, REL, defaultRows, sheetXml, workbookXml, relationshipsXml, writeFixture };
