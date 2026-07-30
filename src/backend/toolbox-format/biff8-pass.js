'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  createToolboxCell,
  createToolboxRow,
  createToolboxSheetMeta
} = require('./model');
const { SourceStyleRegistry } = require('./style-registry');
const {
  readBiff8Overlay,
  createBiff8GridResolver,
  assertBiff8OverlayMatchesProjection
} = require('./biff8-overlay');

class ToolboxBiff8PassError extends Error {
  constructor(code, message, detailLines = []) {
    super(message);
    this.name = 'ToolboxBiff8PassError';
    this.code = code;
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

function sheetStateFromHidden(hidden) {
  if (Number(hidden) === 2) return 'veryHidden';
  if (Number(hidden) === 1) return 'hidden';
  return 'visible';
}

function buildBiff8ColumnLayout(overlaySheet, sourceRegistry) {
  const columns = [];
  // BIFF8 合法允许默认列宽为 0。ExcelJS 不会序列化 defaultColWidth=0，
  // 因此先把 BIFF8 全列范围投影为隐藏，再由显式 ColInfo 按顺序覆盖。
  if (overlaySheet && overlaySheet.defaultColumnWidth === 0) {
    columns.push({
      minColumnIndex: 0,
      maxColumnIndex: 255,
      width: null,
      hidden: true,
      outlineLevel: 0,
      sourceStyleId: null,
      effectiveStyleRef: null,
      customWidth: true
    });
  }
  for (const column of (overlaySheet && overlaySheet.columns) || []) {
    columns.push({
      minColumnIndex: column.firstColumn,
      maxColumnIndex: column.lastColumn,
      width: column.widthCharacters,
      // coldx=0 与隐藏列具有相同可见语义；不得让 writer 因 falsy width 回退为可见默认宽。
      hidden: column.hidden || column.widthCharacters === 0,
      outlineLevel: column.outlineLevel,
      sourceStyleId: column.xfIndex,
      effectiveStyleRef: sourceRegistry.compoundRef(
        sourceRegistry.styleRefForXf(column.xfIndex)
      ),
      customWidth: column.userSet || column.widthCharacters === 0
    });
  }
  return columns;
}

function resolveBiff8RowForOutput(explicitRow, defaultRow, rowIndex) {
  if (explicitRow) return explicitRow;
  return {
    row: rowIndex,
    formatted: false,
    customHeight: false,
    heightPoints: null,
    hidden: !!(defaultRow && defaultRow.hidden),
    outlineLevel: 0,
    xfIndex: null
  };
}

function buildSheetJsProjection(workbook) {
  return {
    sheets: workbook.SheetNames.map((name) => ({
      name,
      cells: Object.keys(workbook.Sheets[name] || {})
        .filter((address) => !address.startsWith('!'))
        .map((address) => {
          const coordinate = XLSX.utils.decode_cell(address);
          return { row: coordinate.r, column: coordinate.c };
        })
    }))
  };
}

function assertSheetStatesMatch(workbook, overlay) {
  const sheetMetadata = workbook && workbook.Workbook && Array.isArray(workbook.Workbook.Sheets)
    ? workbook.Workbook.Sheets
    : [];
  overlay.sheets.forEach((sheet, index) => {
    const sheetJsState = sheetStateFromHidden(sheetMetadata[index] && sheetMetadata[index].Hidden);
    if (sheetJsState !== sheet.state) {
      throw new ToolboxBiff8PassError(
        'BIFF8_OVERLAY_SHEET_STATE_MISMATCH',
        `BIFF8 overlay 与值层的 Sheet 可见状态不一致：${sheet.name}`,
        [`overlay：${sheet.state}`, `值层：${sheetJsState}`]
      );
    }
  });
}

function assertBiff8ValueFormatsMatch(workbook, overlay) {
  const resolver = createBiff8GridResolver(overlay);
  const recordDefinedNumberFormatIds = new Set(
    overlay.recordDefinedNumberFormatIds || []
  );
  overlay.sheets.forEach((overlaySheet, sheetIndex) => {
    const sheetName = workbook.SheetNames[sheetIndex];
    const sheetJs = workbook.Sheets[sheetName];
    for (const overlayCell of overlaySheet.cells) {
      // Blank/MulBlank、行样式和列样式以物理 BIFF8 record 为唯一权威；
      // 值层只参与有值 cell 的独立 numFmt 交叉校验。
      if (!overlayCell.hasValue) continue;
      const resolved = resolver.resolve(sheetIndex, overlayCell.row, overlayCell.column);
      // 无物理 Format 的 canonical built-in 会随 SheetJS locale 呈现不同字符串；
      // 这类格式已由 XF numFmtId + canonical 表校验，不做跨解析器逐字比较。
      if (!recordDefinedNumberFormatIds.has(resolved.style.numFmtId)) continue;
      const address = XLSX.utils.encode_cell({
        r: overlayCell.row,
        c: overlayCell.column
      });
      const sheetJsCell = sheetJs && sheetJs[address];
      const sheetJsFormat = String(
        sheetJsCell && sheetJsCell.z != null ? sheetJsCell.z : 'General'
      );
      const overlayFormat = String(
        resolved.style.staticStyle.numFmt
      );
      if (sheetJsFormat !== overlayFormat) {
        throw new ToolboxBiff8PassError(
          'BIFF8_VALUE_NUMFMT_MISMATCH',
          `BIFF8 物理格式与值层格式不一致：${overlaySheet.name}!${address}`,
          [`物理格式：${overlayFormat}`, `值层格式：${sheetJsFormat}`]
        );
      }
    }
  });
}

function createBiff8SourceRegistry(overlay, sourceRegistryId) {
  const defaultStyle = overlay.styles[overlay.workbookDefaultXfIndex];
  if (!defaultStyle || defaultStyle.kind !== 'cell') {
    throw new ToolboxBiff8PassError(
      'BIFF8_DEFAULT_XF_INVALID',
      `BIFF8 默认 Cell XF 无效：${overlay.workbookDefaultXfIndex}`
    );
  }
  const registry = new SourceStyleRegistry(sourceRegistryId, {
    defaultStyle: defaultStyle.staticStyle
  });
  for (const style of overlay.styles) {
    registry.bindXf(style.index, style.staticStyle);
  }
  registry.defaultStyleRef = registry.styleRefForXf(overlay.workbookDefaultXfIndex);
  return registry;
}

function getSheetRange(sheet) {
  if (!sheet || !sheet['!ref']) return null;
  try {
    return XLSX.utils.decode_range(sheet['!ref']);
  } catch (_error) {
    return null;
  }
}

function buildLegacyMatchMatrix(sheet) {
  const range = getSheetRange(sheet);
  if (!range) return [];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: true,
    defval: '',
    range: {
      s: { r: 0, c: 0 },
      e: range.e
    }
  });
}

function decodeSheetJsCell(cell, legacyValue) {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) {
    return {
      cellType: 'blank',
      rawLexicalValue: '',
      decodedSemanticValue: null,
      matchProjectionValue: legacyValue == null ? '' : legacyValue
    };
  }
  if (cell.t === 'n') {
    return {
      cellType: 'number',
      rawLexicalValue: String(cell.v),
      decodedSemanticValue: cell.v,
      matchProjectionValue: legacyValue
    };
  }
  if (cell.t === 'b') {
    return {
      cellType: 'boolean',
      rawLexicalValue: cell.v ? '1' : '0',
      decodedSemanticValue: !!cell.v,
      matchProjectionValue: legacyValue
    };
  }
  if (cell.t === 'e') {
    const errorValue = cell.w || cell.v || '#VALUE!';
    return {
      cellType: 'error',
      rawLexicalValue: String(errorValue),
      decodedSemanticValue: String(errorValue),
      matchProjectionValue: legacyValue
    };
  }
  return {
    cellType: 'text',
    rawLexicalValue: String(cell.v == null ? '' : cell.v),
    decodedSemanticValue: String(cell.v == null ? '' : cell.v),
    matchProjectionValue: legacyValue
  };
}

class ToolboxBiff8Pass {
  constructor({ filePath, workbook, overlay, sourceRegistry }) {
    this.filePath = filePath;
    this.sourceFile = path.basename(filePath);
    this.format = 'biff8';
    this.workbook = workbook;
    this.overlay = overlay;
    this.sourceRegistry = sourceRegistry;
    this.sourceRegistryId = sourceRegistry.sourceRegistryId;
    this.gridResolver = createBiff8GridResolver(overlay);
    this.closed = false;
    this.scanActive = false;
    this.sheets = Object.freeze(overlay.sheets.map((sheet, sheetIndex) => Object.freeze({
      name: sheet.name,
      state: sheet.state,
      sheetIndex,
      type: sheet.type
    })));
  }

  getSourceRegistry(sourceRegistryId = this.sourceRegistryId) {
    return sourceRegistryId === this.sourceRegistryId ? this.sourceRegistry : null;
  }

  _sheetAt(sheetOrIndex) {
    const index = Number.isInteger(sheetOrIndex)
      ? sheetOrIndex
      : (sheetOrIndex && Number.isInteger(sheetOrIndex.sheetIndex) ? sheetOrIndex.sheetIndex : -1);
    if (index < 0 || index >= this.sheets.length) return null;
    return {
      publicSheet: this.sheets[index],
      overlaySheet: this.overlay.sheets[index],
      sheetJs: this.workbook.Sheets[this.workbook.SheetNames[index]]
    };
  }

  scanSheet(sheetOrIndex, options = {}) {
    if (this.closed) throw new Error('ToolboxBiff8Pass 已关闭');
    if (this.scanActive) throw new Error('同一 ToolboxBiff8Pass 不允许并发扫描多个 Sheet');
    const selected = this._sheetAt(sheetOrIndex);
    if (!selected) throw new RangeError('未找到指定 BIFF8 Sheet');
    if (options.cancelToken && options.cancelToken.cancelled) {
      const error = new Error('工具箱 BIFF8 处理已取消');
      error.name = 'ToolboxBiff8CancelledError';
      error.code = 'TOOLBOX_BIFF8_CANCELLED';
      throw error;
    }

    this.scanActive = true;
    try {
      const { publicSheet, overlaySheet, sheetJs } = selected;
      const onSheetMeta = typeof options.onSheetMeta === 'function' ? options.onSheetMeta : null;
      const onRow = typeof options.onRow === 'function' ? options.onRow : null;
      const sheetMeta = createToolboxSheetMeta({
        name: overlaySheet.name,
        sheetIndex: publicSheet.sheetIndex,
        state: overlaySheet.state,
        date1904: this.overlay.date1904,
        defaultColWidth: overlaySheet.defaultColumnWidth,
        defaultRowHeight: overlaySheet.defaultRow
          ? overlaySheet.defaultRow.heightPoints
          : null,
        defaultRowHidden: !!(overlaySheet.defaultRow && overlaySheet.defaultRow.hidden),
        customHeight: !!(overlaySheet.defaultRow && overlaySheet.defaultRow.customHeight),
        columns: buildBiff8ColumnLayout(overlaySheet, this.sourceRegistry),
        sourceRegistryId: this.sourceRegistryId,
        sourceFile: this.filePath,
        themeColors: this.overlay.themeColorsArgb || {}
      });
      if (onSheetMeta) onSheetMeta(sheetMeta);

      const legacyMatrix = buildLegacyMatchMatrix(sheetJs);
      const cellsByRow = new Map();
      for (const overlayCell of overlaySheet.cells) {
        const rowCells = cellsByRow.get(overlayCell.row) || [];
        rowCells.push(overlayCell);
        cellsByRow.set(overlayCell.row, rowCells);
      }
      const explicitRowsByIndex = new Map(
        overlaySheet.rows.map((row) => [row.row, row])
      );
      const logicalRowIndexes = Array.from(new Set([
        ...explicitRowsByIndex.keys(),
        ...cellsByRow.keys()
      ])).sort((left, right) => left - right);
      let explicitCellCount = 0;
      let maxColumnIndex = -1;
      for (const rowIndex of logicalRowIndexes) {
        const overlayRow = resolveBiff8RowForOutput(
          explicitRowsByIndex.get(rowIndex),
          overlaySheet.defaultRow,
          rowIndex
        );
        if (options.cancelToken && options.cancelToken.cancelled) {
          const error = new Error('工具箱 BIFF8 处理已取消');
          error.name = 'ToolboxBiff8CancelledError';
          error.code = 'TOOLBOX_BIFF8_CANCELLED';
          throw error;
        }
        const cells = (cellsByRow.get(overlayRow.row) || []).map((overlayCell) => {
          const address = XLSX.utils.encode_cell({ r: overlayCell.row, c: overlayCell.column });
          const sheetJsCell = sheetJs && sheetJs[address];
          const legacyValue = legacyMatrix[overlayCell.row]
            ? legacyMatrix[overlayCell.row][overlayCell.column]
            : '';
          const decoded = decodeSheetJsCell(sheetJsCell, legacyValue);
          const resolved = this.gridResolver.resolve(
            publicSheet.sheetIndex,
            overlayCell.row,
            overlayCell.column
          );
          explicitCellCount += 1;
          maxColumnIndex = Math.max(maxColumnIndex, overlayCell.column);
          return createToolboxCell({
            ...decoded,
            cachedValue: sheetJsCell && sheetJsCell.f ? sheetJsCell.v : null,
            sourceStyleId: resolved.xfIndex,
            effectiveStyleRef: this.sourceRegistry.compoundRef(
              this.sourceRegistry.styleRefForXf(resolved.xfIndex)
            ),
            isExplicitCell: true,
            sourceDateSystem: this.overlay.date1904 ? 1904 : 1900,
            sourceFormat: resolved.style.staticStyle.numFmt,
            sourceFile: this.filePath,
            sourceSheet: overlaySheet.name,
            rowIndex: overlayCell.row + 1,
            columnIndex: overlayCell.column,
            hasFormula: !!(sheetJsCell && sheetJsCell.f),
            formulaLexical: sheetJsCell && sheetJsCell.f ? String(sheetJsCell.f) : null
          });
        });
        const rowStyleRef = overlayRow.formatted
          ? this.sourceRegistry.styleRefForXf(overlayRow.xfIndex)
          : this.sourceRegistry.defaultStyleRef;
        const row = createToolboxRow({
          cells,
          rowIndex: overlayRow.row + 1,
          height: overlayRow.customHeight ? overlayRow.heightPoints : null,
          hidden: overlayRow.hidden,
          outlineLevel: overlayRow.outlineLevel,
          sourceStyleId: overlayRow.formatted ? overlayRow.xfIndex : null,
          effectiveStyleRef: this.sourceRegistry.compoundRef(rowStyleRef),
          customFormat: overlayRow.formatted,
          sourceFile: this.filePath,
          sourceSheet: overlaySheet.name
        });
        if (onRow) onRow(row, sheetMeta);
      }
      return {
        sheetMeta,
        rowCount: logicalRowIndexes.length,
        explicitCellCount,
        maxColumnIndex,
        cancelled: false
      };
    } finally {
      this.scanActive = false;
    }
  }

  async scanSheets(options = {}) {
    const includeSheet = typeof options.includeSheet === 'function'
      ? options.includeSheet
      : () => true;
    const summaries = [];
    for (const sheet of this.sheets) {
      if (!includeSheet(sheet)) continue;
      // eslint-disable-next-line no-await-in-loop
      const summary = await this.scanSheet(sheet, {
        cancelToken: options.cancelToken,
        onSheetMeta: options.onSheetMeta
          ? (meta) => options.onSheetMeta(meta, sheet)
          : null,
        onRow: options.onRow
          ? (row, meta) => options.onRow(row, meta, sheet)
          : null
      });
      summaries.push(summary);
    }
    return summaries;
  }

  close() {
    this.closed = true;
    this.workbook = null;
  }
}

async function openToolboxBiff8Pass(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const overlay = await readBiff8Overlay(absolutePath);
  let workbook;
  try {
    workbook = XLSX.readFile(absolutePath, {
      raw: true,
      cellDates: false,
      cellNF: true,
      cellText: true,
      cellStyles: true,
      sheetStubs: true
    });
  } catch (error) {
    throw new ToolboxBiff8PassError(
      'BIFF8_VALUE_LAYER_READ_FAILED',
      'BIFF8 值层无法读取，未生成部分保真结果',
      [error && error.message ? error.message : String(error)]
    );
  }
  assertBiff8OverlayMatchesProjection(overlay, buildSheetJsProjection(workbook));
  assertSheetStatesMatch(workbook, overlay);
  assertBiff8ValueFormatsMatch(workbook, overlay);
  const sourceRegistryId = options.sourceRegistryId ||
    `biff8-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
  const sourceRegistry = createBiff8SourceRegistry(overlay, sourceRegistryId);
  return new ToolboxBiff8Pass({
    filePath: absolutePath,
    workbook,
    overlay,
    sourceRegistry
  });
}

module.exports = {
  ToolboxBiff8Pass,
  ToolboxBiff8PassError,
  assertBiff8ValueFormatsMatch,
  assertSheetStatesMatch,
  buildLegacyMatchMatrix,
  buildBiff8ColumnLayout,
  buildSheetJsProjection,
  createBiff8SourceRegistry,
  decodeSheetJsCell,
  openToolboxBiff8Pass,
  resolveBiff8RowForOutput,
  sheetStateFromHidden
};
