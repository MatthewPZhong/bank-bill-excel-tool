'use strict';

const path = require('node:path');
const {
  classifyExcelNumberFormat,
  classifyNumericOutput,
  gregorianTupleToExcelSerial,
  parseDecimalLexical,
  serial1904To1900
} = require('./number-date');

const TOOLBOX_PROJECTION_PROFILES = Object.freeze({
  XLSX_LEGACY: 'xlsx-legacy',
  CSV_LEGACY: 'csv-legacy',
  XLS_LEGACY: 'xls-legacy'
});

function normalizeCell(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function freezeStyleRef(ref) {
  if (!ref) return null;
  return Object.freeze({
    sourceRegistryId: String(ref.sourceRegistryId),
    styleRef: ref.styleRef
  });
}

function createToolboxCell(input = {}) {
  const rowIndex = Number.parseInt(input.rowIndex, 10);
  const columnIndex = Number.parseInt(input.columnIndex, 10);
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    throw new TypeError('ToolboxCell.rowIndex 必须是从 1 开始的整数');
  }
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex > 16383) {
    throw new TypeError('ToolboxCell.columnIndex 必须位于 0..16383');
  }

  return Object.freeze({
    rawLexicalValue: input.rawLexicalValue == null ? null : String(input.rawLexicalValue),
    cachedValue: input.cachedValue === undefined ? null : input.cachedValue,
    cellType: input.cellType || 'blank',
    decodedSemanticValue: input.decodedSemanticValue === undefined ? null : input.decodedSemanticValue,
    matchProjectionValue: input.matchProjectionValue === undefined
      ? input.decodedSemanticValue
      : input.matchProjectionValue,
    sourceStyleId: input.sourceStyleId === undefined ? null : input.sourceStyleId,
    effectiveStyleRef: freezeStyleRef(input.effectiveStyleRef),
    isExplicitCell: input.isExplicitCell !== false,
    sourceDateSystem: input.sourceDateSystem === 1904 ? 1904 : 1900,
    sourceFormat: String(input.sourceFormat == null ? 'General' : input.sourceFormat),
    sourceFile: String(input.sourceFile || ''),
    sourceSheet: String(input.sourceSheet || ''),
    rowIndex,
    columnIndex,
    hasFormula: !!input.hasFormula,
    formulaLexical: input.formulaLexical == null ? null : String(input.formulaLexical)
  });
}

function createToolboxRow(input = {}) {
  const rowIndex = Number.parseInt(input.rowIndex, 10);
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    throw new TypeError('ToolboxRow.rowIndex 必须是从 1 开始的整数');
  }

  const byColumn = new Map();
  for (const cell of Array.isArray(input.cells) ? input.cells : []) {
    if (!cell || !Number.isInteger(cell.columnIndex)) continue;
    byColumn.set(cell.columnIndex, cell);
  }
  const cells = Array.from(byColumn.values()).sort((a, b) => a.columnIndex - b.columnIndex);

  return Object.freeze({
    cells: Object.freeze(cells),
    rowIndex,
    height: Number.isFinite(input.height) ? input.height : null,
    hidden: !!input.hidden,
    outlineLevel: Number.isInteger(input.outlineLevel) ? input.outlineLevel : 0,
    sourceStyleId: input.sourceStyleId === undefined ? null : input.sourceStyleId,
    effectiveStyleRef: freezeStyleRef(input.effectiveStyleRef),
    customFormat: !!input.customFormat,
    sourceFile: String(input.sourceFile || ''),
    sourceSheet: String(input.sourceSheet || '')
  });
}

function createToolboxSheetMeta(input = {}) {
  const columns = (Array.isArray(input.columns) ? input.columns : [])
    .map((column) => Object.freeze({
      minColumnIndex: Number.parseInt(column.minColumnIndex, 10),
      maxColumnIndex: Number.parseInt(column.maxColumnIndex, 10),
      width: Number.isFinite(column.width) ? column.width : null,
      hidden: !!column.hidden,
      outlineLevel: Number.isInteger(column.outlineLevel) ? column.outlineLevel : 0,
      sourceStyleId: column.sourceStyleId === undefined ? null : column.sourceStyleId,
      effectiveStyleRef: freezeStyleRef(column.effectiveStyleRef),
      customWidth: !!column.customWidth
    }))
    .filter((column) => Number.isInteger(column.minColumnIndex) &&
      Number.isInteger(column.maxColumnIndex) &&
      column.minColumnIndex >= 0 &&
      column.maxColumnIndex >= column.minColumnIndex &&
      column.maxColumnIndex <= 16383);

  return Object.freeze({
    name: String(input.name || ''),
    sheetIndex: Number.isInteger(input.sheetIndex) ? input.sheetIndex : 0,
    state: String(input.state || 'visible'),
    date1904: !!input.date1904,
    defaultColWidth: Number.isFinite(input.defaultColWidth) ? input.defaultColWidth : null,
    defaultRowHeight: Number.isFinite(input.defaultRowHeight) ? input.defaultRowHeight : null,
    defaultRowHidden: !!input.defaultRowHidden,
    customHeight: !!input.customHeight,
    columns: Object.freeze(columns),
    logicalHeaderRowIndex: Number.isInteger(input.logicalHeaderRowIndex)
      ? input.logicalHeaderRowIndex
      : null,
    sourceRegistryId: String(input.sourceRegistryId || ''),
    sourceFile: String(input.sourceFile || ''),
    themeColors: Object.freeze({ ...(input.themeColors || {}) })
  });
}

function findToolboxCell(row, columnIndex) {
  if (!row || !Array.isArray(row.cells)) return null;
  let low = 0;
  let high = row.cells.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cell = row.cells[middle];
    if (cell.columnIndex === columnIndex) return cell;
    if (cell.columnIndex < columnIndex) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

function projectToolboxValue(cell, projectionProfile = TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY) {
  if (!cell) return '';
  if (projectionProfile === TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY) {
    return cell.matchProjectionValue == null ? '' : cell.matchProjectionValue;
  }
  if (projectionProfile === TOOLBOX_PROJECTION_PROFILES.CSV_LEGACY ||
      projectionProfile === TOOLBOX_PROJECTION_PROFILES.XLS_LEGACY) {
    return cell.matchProjectionValue == null ? '' : cell.matchProjectionValue;
  }
  throw new TypeError(`未知工具箱投影 profile：${projectionProfile}`);
}

function toMatchValue(cell, projectionProfile = TOOLBOX_PROJECTION_PROFILES.XLSX_LEGACY) {
  return normalizeCell(projectToolboxValue(cell, projectionProfile));
}

function projectToolboxRowValues(row, projectionProfile, width = null) {
  const cells = row && Array.isArray(row.cells) ? row.cells : [];
  const inferredWidth = cells.length === 0 ? 0 : cells[cells.length - 1].columnIndex + 1;
  const outputWidth = Number.isInteger(width) && width >= 0 ? width : inferredWidth;
  const values = new Array(outputWidth).fill('');
  for (const cell of cells) {
    if (cell.columnIndex < outputWidth) {
      values[cell.columnIndex] = projectToolboxValue(cell, projectionProfile);
    }
  }
  return values;
}

function cellReference(columnIndex, rowIndex) {
  let n = columnIndex + 1;
  let letters = '';
  while (n > 0) {
    const digit = (n - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${rowIndex}`;
}

function createWarningCollector(maxSamples = 20) {
  let warningCount = 0;
  const warningSamples = [];
  return Object.freeze({
    add(warning) {
      warningCount += 1;
      if (warningSamples.length < maxSamples) {
        warningSamples.push(Object.freeze({ ...warning }));
      }
    },
    summary() {
      return {
        warningCount,
        warningSamples: warningSamples.slice()
      };
    }
  });
}

function emitDateFallbackWarning(cell, warningCollector, message) {
  if (!warningCollector || typeof warningCollector.add !== 'function') return;
  warningCollector.add({
    code: 'toolbox-date-text-fallback',
    sourceFileName: path.basename(cell.sourceFile || ''),
    sourceSheet: cell.sourceSheet || '',
    cellRef: cellReference(cell.columnIndex, cell.rowIndex),
    message
  });
}

function projectOutputCell(cell, warningCollector = null) {
  if (!cell || cell.cellType === 'blank') {
    return Object.freeze({ value: null, numFmtOverride: null });
  }

  if (cell.cellType === 'date') {
    const serial = gregorianTupleToExcelSerial(cell.rawLexicalValue);
    if (serial === null) {
      emitDateFallbackWarning(cell, warningCollector, '日期超出 Excel 可表示范围或日期词法无效，已按文本保留');
      return Object.freeze({
        value: String(cell.rawLexicalValue == null ? '' : cell.rawLexicalValue),
        numFmtOverride: '@'
      });
    }
    const sourceFormatIsDate = classifyExcelNumberFormat(cell.sourceFormat || 'General').isDateLike;
    const lexical = String(cell.rawLexicalValue || '');
    const timeMatch = lexical.match(/[T ]\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?/);
    let generatedDateFormat = 'yyyy-mm-dd';
    if (timeMatch) {
      generatedDateFormat += timeMatch[0].split(/[T ]/)[1].split(':').length >= 3
        ? ` hh:mm:ss${timeMatch[1] ? `.${'0'.repeat(timeMatch[1].length)}` : ''}`
        : ' hh:mm';
    }
    return Object.freeze({
      value: Number(serial),
      numFmtOverride: sourceFormatIsDate ? null : generatedDateFormat,
      canonicalValue: serial
    });
  }

  if (cell.cellType === 'number') {
    const numberFormat = cell.sourceFormat || 'General';
    if (classifyExcelNumberFormat(numberFormat).isDateLike) {
      const parsed = parseDecimalLexical(cell.rawLexicalValue);
      if (!parsed) {
        emitDateFallbackWarning(cell, warningCollector, '数值日期词法无效，已按文本保留');
        return Object.freeze({
          value: String(cell.rawLexicalValue == null ? '' : cell.rawLexicalValue),
          numFmtOverride: '@'
        });
      }
      const serial = cell.sourceDateSystem === 1904
        ? serial1904To1900(parsed.canonical)
        : parsed.canonical;
      const numericSerial = Number(serial);
      if (!Number.isFinite(numericSerial)) {
        emitDateFallbackWarning(
          cell,
          warningCollector,
          '数值日期超出 Excel 可安全写入范围，已按 canonical 文本保留'
        );
        return Object.freeze({
          value: serial,
          numFmtOverride: '@',
          canonicalValue: serial
        });
      }
      return Object.freeze({ value: numericSerial, numFmtOverride: null, canonicalValue: serial });
    }

    const numeric = classifyNumericOutput(cell.rawLexicalValue, numberFormat);
    return Object.freeze({
      value: numeric.outputValue,
      numFmtOverride: numeric.numFmt,
      canonicalValue: numeric.canonical,
      numericFallbackReason: numeric.reason
    });
  }

  if (cell.cellType === 'boolean') {
    return Object.freeze({ value: !!cell.decodedSemanticValue, numFmtOverride: null });
  }
  if (cell.cellType === 'error') {
    return Object.freeze({
      value: { error: String(cell.decodedSemanticValue || cell.rawLexicalValue || '#VALUE!') },
      numFmtOverride: null
    });
  }
  return Object.freeze({
    value: cell.decodedSemanticValue == null ? '' : String(cell.decodedSemanticValue),
    numFmtOverride: null
  });
}

module.exports = {
  TOOLBOX_PROJECTION_PROFILES,
  cellReference,
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta,
  createWarningCollector,
  findToolboxCell,
  normalizeCell,
  projectOutputCell,
  projectToolboxRowValues,
  projectToolboxValue,
  toMatchValue
};
