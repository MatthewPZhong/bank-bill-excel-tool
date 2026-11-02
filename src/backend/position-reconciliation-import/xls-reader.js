'use strict';

const path = require('node:path');
const XLSX = require('xlsx');

const {
  BANK_SHEET_NAME,
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
  bankHeaderMismatchLines,
  sourceHeaderMismatchLines
} = require('../../main-process/position-reconciliation/header-mismatch');
const { bankSourceStructure } = require('../../main-process/position-reconciliation/source-structures');

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

function sourceMatch(workbook, fileName, definitions = SOURCE_DEFINITIONS) {
  const matches = [];
  const sheetHeaders = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = rowValues(workbook.Sheets[sheetName]);
    const headers = normalizeHeaderRow(rows[0]);
    sheetHeaders.push({ name: sheetName, headers });
    for (const [sourceType, definition] of Object.entries(definitions)) {
      if (headersEqual(headers, definition.headers)) {
        matches.push({ sourceType, definition, sheetName, rows, headers });
      }
    }
  }
  if (matches.length === 0) {
    throw new PositionReconciliationError(
      'position-source-unrecognized',
      `无法通过表头识别链接原始表：${fileName}`,
      sourceHeaderMismatchLines(sheetHeaders, definitions)
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

// bankSourceHeaders：银行对账单导入识别结构的当前用户版本（D17，与内置 46 / 49 列同时接受）。
function bankMatch(workbook, fileName, bankSourceHeaders = null) {
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
  const structure = bankSourceStructure(headers, bankSourceHeaders);
  if (!structure) {
    throw new PositionReconciliationError(
      'position-bank-headers-invalid',
      `银行对账单表头不符合 46/49 列契约${bankSourceHeaders ? '或当前版本' : ''}：${fileName}`,
      bankHeaderMismatchLines(headers, bankSourceHeaders)
    );
  }
  return { sourceType: null, definition: null, sheetName: BANK_SHEET_NAME, rows, headers, project: structure.project };
}

async function streamPositionXlsRows(filePath, options = {}) {
  ensureUtilityContext(options);
  const absolutePath = path.resolve(String(filePath || ''));
  const fileName = path.basename(absolutePath);
  const workbook = openWorkbook(absolutePath);
  const detected = options.kind === 'bank'
    ? bankMatch(workbook, fileName, options.bankSourceHeaders || null)
    : sourceMatch(workbook, fileName, options.sourceDefinitions || SOURCE_DEFINITIONS);
  // 银行对账单按当前版本读取时，行对应回内置 46 列名再交给预检 / 写入（按列名取值）。
  const project = detected.project || ((value) => value);
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
        row: project(row),
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
