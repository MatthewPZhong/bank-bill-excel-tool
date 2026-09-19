'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { inspectWorkbook } = require(path.join(process.argv[2] || process.cwd(), 'src/backend/vcc-financial-op/workbook-import-plan'));

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-review3-sst-safe-'));
  const workbookPath = path.join(sandbox, 'source.xlsx');
  const cwd = path.join(sandbox, 'sacrificial-cwd');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'sentinel-user-file.txt'), 'only probe-owned sacrificial data');
  const b = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet([['probe']]), 'Data');
  XLSX.writeFile(b, workbookPath, { bookSST: true });
  const zip = await JSZip.loadAsync(fs.readFileSync(workbookPath));
  const count = 2200, textLength = 32000;
  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + count + '" uniqueCount="' + count + '">' + Array.from({ length: count }, (_, i) => '<si><t>' + 'x'.repeat(textLength - String(i).length) + i + '</t></si>').join('') + '</sst>';
  zip.file('xl/sharedStrings.xml', sst);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData>' + Array.from({length: count}, (_, i) => '<row r="' + (i + 1) + '"><c r="A' + (i + 1) + '" t="s"><v>' + i + '</v></c></row>').join('') + '</sheetData>').replace(/<dimension[^>]+\/>/, '<dimension ref="A1:A' + count + '"/>'));
  fs.writeFileSync(workbookPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const sentinel = path.join(cwd, 'sentinel-user-file.txt');
    assert.equal(fs.existsSync(sentinel), true);
    const roots = []; const mkdir = fs.mkdirSync;
    fs.mkdirSync = (name, ...args) => { const result = mkdir(name, ...args); if (String(name).includes('rich-xlsx-sst-')) roots.push(name); return result; };
    let result; try { result = await inspectWorkbook(workbookPath); } finally { fs.mkdirSync = mkdir; }
    assert.equal(roots.length, 1);
    assert.equal(fs.existsSync(roots[0]), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'only probe-owned sacrificial data');
    console.log(JSON.stringify({ entryPoint: 'inspectWorkbook', memoryBudgetBytes: 64 * 1024 * 1024,
      sourceBytes: fs.statSync(workbookPath).size, sstBytes: Buffer.byteLength(sst),
      privateSpillDirectories: roots.length, privateSpillCleaned: roots.every(root => !fs.existsSync(root)),
      sources: result.sources.map(s => ({ status: s.status, meaningfulRows: s.meaningfulRows })),
      sacrificialCwd: cwd, cwdExistsAfterPreflight: fs.existsSync(cwd),
      sentinelExistsAfterPreflight: fs.existsSync(sentinel), originalSourceStillExists: fs.existsSync(workbookPath) }));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(sandbox, {recursive: true, force: true});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
