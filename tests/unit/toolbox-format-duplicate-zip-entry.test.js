'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yazl = require('yazl');

const {
  openZipWithEntries
} = require('../../src/backend/big-table-import/zip-reader');
const {
  openToolboxXlsxPass
} = require('../../src/backend/toolbox-format');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDuplicateEntryWorkbook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-duplicate-entry-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'duplicate-entry.xlsx');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'
  ), 'xl/workbook.xml');
  zip.addBuffer(Buffer.from(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + '</Relationships>'
  ), 'xl/_rels/workbook.xml.rels');
  zip.addBuffer(Buffer.from(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
  ), 'xl/worksheets/sheet1.xml');
  zip.addBuffer(Buffer.from('<sst><si><t>FIRST</t></si></sst>'), 'xl/sharedStrings.xml');
  zip.addBuffer(Buffer.from('<sst><si><t>SECOND</t></si></sst>'), 'xl/sharedStrings.xml');
  return new Promise((resolve, reject) => {
    zip.outputStream.pipe(fs.createWriteStream(filePath))
      .on('close', () => resolve(filePath))
      .on('error', reject);
    zip.end();
  });
}

test('工具箱 strict opener 拒绝重复 ZIP entry，避免同一路径出现两套业务值', async () => {
  const filePath = await writeDuplicateEntryWorkbook();
  await assert.rejects(
    openToolboxXlsxPass(filePath),
    (error) => {
      assert.match(error.message, /重复的 ZIP entry/);
      assert.ok(error.detailLines.some((line) => line.includes('xl/sharedStrings.xml')));
      return true;
    }
  );
});

test('共享 ZIP reader 默认契约保持首项优先，只有 strict 调用方启用拒绝', async () => {
  const filePath = await writeDuplicateEntryWorkbook();
  const opened = await openZipWithEntries(path.basename(filePath), filePath);
  try {
    assert.equal(opened.entries.has('xl/sharedStrings.xml'), true);
  } finally {
    opened.zip.close();
  }
});
