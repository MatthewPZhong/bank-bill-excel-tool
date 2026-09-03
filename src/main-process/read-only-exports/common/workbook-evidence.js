'use strict';

const XLSX = require('xlsx-js-style');

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');

function normalizeCellStyle(style) {
  if (!style || typeof style !== 'object') return null;
  return {
    alignment: style.alignment || null,
    border: style.border || null,
    fill: style.fill || null,
    font: style.font || null,
    numFmt: style.numFmt || null,
    protection: style.protection || null
  };
}

function sheetSemanticEvidence(sheet) {
  const range = sheet && sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (!range) {
    return Object.freeze({ cells: Object.freeze([]), merges: Object.freeze([]), rowCount: 0 });
  }
  const cells = [];
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address];
      if (!cell) continue;
      cells.push(Object.freeze({
        address,
        formula: cell.f == null ? null : String(cell.f),
        numberFormat: cell.z == null ? null : String(cell.z),
        style: normalizeCellStyle(cell.s),
        type: cell.t == null ? null : String(cell.t),
        value: cell.v == null ? null : cell.v
      }));
    }
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    merges: Object.freeze((sheet['!merges'] || []).map((merge) => XLSX.utils.encode_range(merge))),
    rowCount: range.e.r - range.s.r + 1
  });
}

function readWorkbookBusinessEvidence(filePath) {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  const sheets = workbook.SheetNames.map((name) => Object.freeze({
    name,
    ...sheetSemanticEvidence(workbook.Sheets[name])
  }));
  const dataRowCount = sheets.reduce((sum, sheet) => sum + Math.max(0, sheet.rowCount - 1), 0);
  return Object.freeze({
    businessDigest: canonicalSha256(Object.freeze({ sheets: Object.freeze(sheets) })),
    sheetCount: sheets.length,
    dataRowCount
  });
}

module.exports = { readWorkbookBusinessEvidence, sheetSemanticEvidence };
