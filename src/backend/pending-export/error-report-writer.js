'use strict';

const XLSX = require('xlsx-js-style');

const PENDING_COLUMNS = require('../pending-db/columns');
const { errorCodeToCause } = require('../file-service/error-causes');
const { applyWatermark } = require('../../main-process/workbook-watermark');

function applyHeaderRowFont(worksheet, headerRowIndex = 0) {
  if (!worksheet || !worksheet['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  if (headerRowIndex < range.s.r || headerRowIndex > range.e.r) return;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const cell = worksheet[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, sz: 10 }
    };
  }
}

function normalizeErrorReportSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      !Array.isArray(snapshot.errors)) {
    throw new TypeError('Pending 错误报告快照非法');
  }
  return snapshot;
}

function writePendingErrorReport(snapshot, savePath) {
  const source = normalizeErrorReportSnapshot(snapshot);
  const headers = ['source_file', 'sheet_row', 'severity', 'message', '可能原因', ...PENDING_COLUMNS];
  const rows = [headers];
  for (const err of source.errors) {
    const cells = Array.isArray(err && err.cells)
      ? err.cells
      : PENDING_COLUMNS.map(() => '');
    rows.push([
      err && err.file ? err.file : '',
      err && err.sheetRow != null ? err.sheetRow : '',
      err && err.severity ? err.severity : '',
      err && err.message ? err.message : '',
      errorCodeToCause(err && (err.code || err.severity)),
      ...cells
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  applyHeaderRowFont(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '错误报告');
  applyWatermark(wb);
  XLSX.writeFile(wb, savePath);
  return {
    status: 'success',
    path: savePath,
    filePath: savePath,
    errorCount: source.errors.length
  };
}

module.exports = {
  applyHeaderRowFont,
  writePendingErrorReport,
  __internal: { applyHeaderRowFont, normalizeErrorReportSnapshot }
};
