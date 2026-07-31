'use strict';

const path = require('node:path');
const XLSX = require('xlsx');

const {
  BANK_SHEET_NAME,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  isBlankRow
} = require('../../main-process/position-reconciliation/common');
const {
  headersEqual,
  normalizeHeaderRow,
  rowValues
} = require('../../main-process/position-reconciliation/readers');
const {
  BANK_STATEMENT_FIELDS
} = require('../../constants/bank-statement-fields');

function ensureUtilityContext(options) {
  if (options.allowMainThread === true) return;
  if (process.env.POSITION_IMPORT_UTILITY_PROCESS !== '1') {
    throw new PositionReconciliationError(
      'position-import-parser-parity-unproven',
      '.xls 只能在平盘导入 utilityProcess 中读取'
    );
  }
}

function openWorkbook(filePath) {
  try {
    return XLSX.readFile(filePath, { cellDates: true, raw: true });
  } catch (error) {
    throw new PositionReconciliationError(
      'position-workbook-invalid',
      `无法读取 Excel：${path.basename(filePath)}`,
      [error && error.message ? error.message : String(error)]
    );
  }
}

function sourceMatch(workbook, fileName) {
  const matches = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = rowValues(workbook.Sheets[sheetName]);
    const headers = normalizeHeaderRow(rows[0]);
    for (const [sourceType, definition] of Object.entries(SOURCE_DEFINITIONS)) {
      if (headersEqual(headers, definition.headers)) {
        matches.push({ sourceType, definition, sheetName, rows, headers });
      }
    }
  }
  if (matches.length === 0) {
    throw new PositionReconciliationError(
      'position-source-unrecognized',
      `无法通过表头识别链接原始表：${fileName}`
    );
  }
  if (matches.length > 1) {
    throw new PositionReconciliationError(
      'position-source-ambiguous',
      `文件中存在多个可识别原始表，无法确定唯一来源：${fileName}`,
      matches.map((match) => `${match.sheetName} → ${match.definition.sourceName}`)
    );
  }
  return matches[0];
}

function bankMatch(workbook, fileName) {
  const sheet = workbook.Sheets[BANK_SHEET_NAME];
  if (!sheet) {
    throw new PositionReconciliationError(
      'position-bank-sheet-missing',
      `银行对账单缺少 sheet「${BANK_SHEET_NAME}」：${fileName}`,
      [`实际 sheets：${workbook.SheetNames.join(' / ')}`]
    );
  }
  const rows = rowValues(sheet);
  const headers = normalizeHeaderRow(rows[0]);
  if (!headersEqual(headers, BANK_STATEMENT_FIELDS) &&
      !headersEqual(headers, POSITION_BANK_HEADERS)) {
    throw new PositionReconciliationError(
      'position-bank-headers-invalid',
      `银行对账单表头不符合 46/49 列契约：${fileName}`,
      [`实际列数：${headers.length}`, `实际表头：${headers.join(' / ')}`]
    );
  }
  return { sourceType: null, definition: null, sheetName: BANK_SHEET_NAME, rows, headers };
}

async function streamPositionXlsRows(filePath, options = {}) {
  ensureUtilityContext(options);
  const absolutePath = path.resolve(String(filePath || ''));
  const fileName = path.basename(absolutePath);
  const workbook = openWorkbook(absolutePath);
  const detected = options.kind === 'bank'
    ? bankMatch(workbook, fileName)
    : sourceMatch(workbook, fileName);
  let nonBlankRowCount = 0;

  for (let index = 1; index < detected.rows.length; index += 1) {
    if (options.cancelToken && options.cancelToken.cancelled) {
      throw new PositionReconciliationError('position-import-cancelled', '平盘导入已取消');
    }
    const values = detected.rows[index] || [];
    const row = Object.fromEntries(
      detected.headers.map((header, columnIndex) => [header, values[columnIndex] ?? ''])
    );
    if (isBlankRow(row, detected.headers)) continue;
    nonBlankRowCount += 1;
    const physicalRowIndex = Number.isSafeInteger(values.__rowNum__)
      ? values.__rowNum__
      : index;
    if (typeof options.onRow === 'function') {
      options.onRow({
        row,
        excelRowNumber: physicalRowIndex + 1,
        sourceType: detected.sourceType,
        sourceHeaders: detected.headers,
        sheetName: detected.sheetName
      });
    }
  }

  return {
    sourceFile: fileName,
    sheetName: detected.sheetName,
    sourceType: detected.sourceType,
    sourceName: detected.definition ? detected.definition.sourceName : null,
    linkedName: detected.definition ? detected.definition.linkedName : null,
    sourceHeaders: detected.headers.slice(),
    nonBlankRowCount,
    sharedStringsMode: 'sheetjs-xls',
    sharedStringsCount: null
  };
}

module.exports = {
  streamPositionXlsRows
};
