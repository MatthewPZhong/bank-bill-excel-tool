'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { openRichWorkbook } = require('../../backend/xlsx-rich-reader');
const { canonicalizeDecimal } = require('../financial-decimal');
const { createEvidence } = require('./export-spool');
const { NULL_CELL, evidenceIdentity } = require('./export-cells');
const { fail, hash } = require('./contracts');

function actualCell(cell) {
  if (!cell) return NULL_CELL;
  if (cell.hasFormula || !['text', 'blank', 'number', 'boolean'].includes(cell.cellType)) fail('BIZOP_OUTPUT_CELL_INVALID');
  const f = cell.sourceFormat || 'General';
  if (cell.cellType === 'blank') return { t: 'null', v: null, f };
  if (cell.cellType === 'number') return { t: 'number', v: canonicalizeDecimal(cell.rawLexicalValue), f };
  return { t: cell.cellType, v: cell.decodedSemanticValue, f };
}
async function hashClosedFile(filePath, safePoint = () => {}) {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1) fail('BIZOP_OUTPUT_FILE_INVALID');
    const digest = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) { safePoint(); digest.update(bytes); }
    const after = await handle.stat(); const current = await fs.promises.lstat(filePath);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key] || before[key] !== current[key])) fail('BIZOP_OUTPUT_FILE_CHANGED');
    return { sha256: digest.digest('hex'), byteSize: before.size,
      fileIdentity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map((key) => [key, before[key]])) };
  } finally { await handle.close(); }
}
async function validateExportWorkbook({ filePath, source, expected, tempDirectory, cancelToken, safePoint = () => {} }) {
  if (hash(expected.identity) !== hash(evidenceIdentity({ ...source, maxRowsPerSheet: expected.identity.maxRowsPerSheet }))) fail('BIZOP_OUTPUT_IDENTITY_INVALID');
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) fail('BIZOP_OUTPUT_FILE_INVALID');
  const workbook = await openRichWorkbook(filePath, { sstTempRoot: tempDirectory,
    memoryBudgetBytes: 32 * 1024 * 1024, cacheMaxBytes: 32 * 1024 * 1024, cancelToken, maxSheets: expected.pages.length });
  const evidence = createEvidence(expected.identity);
  let dataRowCount = 0; let noteRowCount = 0;
  try {
    if (workbook.date1904 || workbook.sheets.length !== expected.pages.length) fail('BIZOP_OUTPUT_SHEETS_INVALID');
    for (let index = 0; index < expected.pages.length; index += 1) {
      safePoint(); const page = expected.pages[index]; const sheet = workbook.sheets[index];
      if (sheet.name !== page.name || sheet.state !== 'visible') fail('BIZOP_OUTPUT_SHEETS_INVALID');
      evidence.add({ name: sheet.name, section: page.section, page: page.page, headers: page.headers });
      let rows = 0;
      await workbook.scanSheet(index, (row) => {
        safePoint();
        if (row.rowIndex !== ++rows || row.hidden || row.height !== null || row.customFormat
            || row.cells.some((cell) => cell.columnIndex >= page.headers.length)) fail('BIZOP_OUTPUT_ROW_INVALID');
        const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
        const values = page.headers.map((_, column) => actualCell(cells.get(column)));
        evidence.add({ row: row.rowIndex, values });
      }, (meta) => {
        if (meta.defaultRowHidden || meta.columns.length || meta.defaultRowHeight !== 15) fail('BIZOP_OUTPUT_LAYOUT_INVALID');
      });
      if (rows !== page.rowCount + 1) fail('BIZOP_OUTPUT_ROW_COUNT');
      evidence.add({ rows: rows - 1 });
      if (page.section === 'DATA') dataRowCount += rows - 1; else noteRowCount += rows - 1;
    }
  } finally { await workbook.close(); }
  const actualDigest = evidence.finish();
  if (actualDigest !== expected.expectedDigest || dataRowCount !== expected.dataRowCount || noteRowCount !== expected.noteRowCount) fail('BIZOP_OUTPUT_EVIDENCE_MISMATCH');
  const measured = await hashClosedFile(filePath, safePoint);
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== measured.fileIdentity[key])) fail('BIZOP_OUTPUT_FILE_CHANGED');
  return { actualDigest, ...measured, sheetCount: expected.pages.length, dataRowCount, noteRowCount };
}
module.exports = { actualCell, hashClosedFile, validateExportWorkbook };
