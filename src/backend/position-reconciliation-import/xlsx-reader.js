'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  openZipWithEntries,
  WORKBOOK_ENTRY_NAME,
  WORKBOOK_RELS_ENTRY_NAME
} = require('../big-table-import/zip-reader');
const { scanSheetRows } = require('../big-table-import/row-scanner');
const {
  TOOLBOX_XLSX_METADATA_LIMITS,
  findRelationshipEntry,
  parseWorkbookRelationships,
  parseWorkbookXml,
  readToolboxMetadataEntryAsString
} = require('../toolbox-format/xlsx-pass');
const {
  ToolboxXlsxFormatError,
  scanXlsxSheet
} = require('../toolbox-format/xlsx-sheet-scanner');
const {
  createSourceStyleRegistryFromOoxml
} = require('../toolbox-format/style-registry');
const {
  classifyExcelNumberFormat
} = require('../toolbox-format/number-date');
const {
  BANK_SHEET_NAME,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError,
  isBlankRow,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  BANK_STATEMENT_FIELDS
} = require('../../constants/bank-statement-fields');
const {
  loadSharedStringsProvider
} = require('./shared-strings-provider');

const HEADER_SCAN_MAX_COLUMNS = 1024;
const WORKSHEET_RELATIONSHIP_SUFFIX = '/worksheet';

function headersEqual(actual, expected) {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function normalizeHeaderRow(values) {
  const normalized = Array.isArray(values) ? values.map((value) => text(value)) : [];
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
  return normalized;
}

function parserParityError(message, detailLines = []) {
  return new PositionReconciliationError(
    'position-import-parser-parity-unproven',
    message,
    detailLines
  );
}

function workbookInvalid(sourceFile, error) {
  if (error instanceof PositionReconciliationError) return error;
  if (error && error.code === 'TOOLBOX_XLSX_CANCELLED') {
    return new PositionReconciliationError(
      'position-import-cancelled',
      '平盘导入已取消'
    );
  }
  if (error && String(error.code || '').startsWith('position-import-')) {
    return new PositionReconciliationError(
      error.code,
      error.message || `无法读取 Excel：${sourceFile}`,
      Array.isArray(error.detailLines) ? error.detailLines : []
    );
  }
  const detailLines = [];
  if (error && error.message) detailLines.push(error.message);
  if (error && error.context) detailLines.push(JSON.stringify(error.context));
  return new PositionReconciliationError(
    'position-workbook-invalid',
    `无法读取 Excel：${sourceFile}`,
    detailLines
  );
}

function relationshipIsWorksheet(relationship) {
  return relationship &&
    relationship.targetMode !== 'External' &&
    String(relationship.type || '').endsWith(WORKSHEET_RELATIONSHIP_SUFFIX);
}

function mapWorkbookSheets(workbook, relationships, entries, sourceFile) {
  const used = new Set();
  return workbook.sheets.map((sheet, sheetIndex) => {
    const relationship = relationships.get(String(sheet.relationshipId || ''));
    if (!relationshipIsWorksheet(relationship) ||
        !relationship.target ||
        !entries.has(relationship.target)) {
      throw new ToolboxXlsxFormatError(
        `工作表“${sheet.name}”的 relationship 无效或目标不存在`,
        {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId
        }
      );
    }
    if (used.has(relationship.target)) {
      throw new ToolboxXlsxFormatError(
        `多个工作表指向同一 worksheet entry：${relationship.target}`,
        { sourceFile, sheetName: sheet.name, sheetIndex }
      );
    }
    used.add(relationship.target);
    return Object.freeze({
      name: sheet.name,
      state: sheet.state,
      sheetIndex,
      relationshipId: sheet.relationshipId,
      entryPath: relationship.target
    });
  });
}

async function openPositionWorkbook(filePath, options = {}) {
  const absolutePath = path.resolve(String(filePath || ''));
  const sourceFile = path.basename(absolutePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, absolutePath, {
    rejectDuplicateEntries: true
  });
  let sharedStrings = null;
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY_NAME);
    const relsEntry = entries.get(WORKBOOK_RELS_ENTRY_NAME);
    if (!workbookEntry || !relsEntry) {
      throw new ToolboxXlsxFormatError('xlsx 缺少 workbook.xml 或 workbook.xml.rels', {
        sourceFile
      });
    }
    const workbookXml = await readToolboxMetadataEntryAsString(zip, workbookEntry, {
      sourceFile,
      partName: 'workbook.xml',
      limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.workbook
    });
    const relsXml = await readToolboxMetadataEntryAsString(zip, relsEntry, {
      sourceFile,
      partName: 'workbook.xml.rels',
      limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.relationships
    });
    const workbook = parseWorkbookXml(workbookXml);
    const relationships = parseWorkbookRelationships(relsXml);
    const sheets = mapWorkbookSheets(workbook, relationships, entries, sourceFile);
    if (sheets.length === 0) {
      throw new ToolboxXlsxFormatError('xlsx 未声明任何工作表', { sourceFile });
    }

    const stylesEntry = findRelationshipEntry(
      entries,
      relationships,
      'styles',
      'xl/styles.xml',
      { sourceFile, relationshipLabel: 'styles' }
    );
    const themeEntry = findRelationshipEntry(
      entries,
      relationships,
      'theme',
      'xl/theme/theme1.xml',
      { sourceFile, relationshipLabel: 'theme' }
    );
    const sharedStringsEntry = findRelationshipEntry(
      entries,
      relationships,
      'sharedStrings',
      'xl/sharedStrings.xml',
      { sourceFile, relationshipLabel: 'sharedStrings' }
    );
    const stylesXml = stylesEntry
      ? await readToolboxMetadataEntryAsString(zip, stylesEntry, {
        sourceFile,
        partName: 'styles.xml',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.styles
      })
      : '';
    const themeXml = themeEntry
      ? await readToolboxMetadataEntryAsString(zip, themeEntry, {
        sourceFile,
        partName: 'theme',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.theme
      })
      : '';
    const registryId = `position-${crypto.randomUUID()}`;
    const styleResult = createSourceStyleRegistryFromOoxml({
      sourceRegistryId: registryId,
      stylesXml,
      themeXml,
      requireStylesXml: !!stylesEntry,
      requireThemeXml: !!themeEntry
    });
    sharedStrings = await loadSharedStringsProvider(zip, sharedStringsEntry, {
      sourceFile,
      tempRoot: options.sstTempRoot,
      memoryBudgetBytes: options.sstMemoryBudgetBytes,
      lruMaxEntries: options.sstLruMaxEntries,
      preserveOnClose: options.preserveSstOnClose,
      cancelToken: options.cancelToken
    });

    let closed = false;
    return {
      filePath: absolutePath,
      sourceFile,
      zip,
      entries,
      sheets,
      relationships,
      date1904: workbook.date1904,
      sharedStrings,
      sourceRegistry: styleResult.registry,
      themeColors: styleResult.themeColors,
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (sharedStrings) await sharedStrings.close();
        } finally {
          try { zip.close(); } catch (_error) {}
        }
      }
    };
  } catch (error) {
    if (sharedStrings) {
      try { await sharedStrings.close(); } catch (_closeError) {}
    }
    try { zip.close(); } catch (_closeError) {}
    throw workbookInvalid(sourceFile, error);
  }
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function readPhysicalHeader(workbook, sheet, cancelToken = null) {
  const entry = workbook.entries.get(sheet.entryPath);
  const stream = await openEntryStream(workbook.zip, entry);
  let header = [];
  await scanSheetRows({
    stream,
    expectedHeaders: new Array(HEADER_SCAN_MAX_COLUMNS).fill(''),
    sharedStrings: workbook.sharedStrings,
    valueColumnWhitelist: null,
    onRow: ({ rowR, values }) => {
      if (cancelToken && cancelToken.cancelled) {
        const error = new Error('平盘导入已取消');
        error.code = 'position-import-cancelled';
        throw error;
      }
      if (rowR !== 1) return;
      header = normalizeHeaderRow(values);
      const stop = new Error('header-read');
      stop.__stopParsing = true;
      throw stop;
    }
  });
  return header;
}

async function locatePositionBusinessSheet(workbook, kind, cancelToken = null) {
  if (kind === 'bank') {
    const sheet = workbook.sheets.find((candidate) => candidate.name === BANK_SHEET_NAME);
    if (!sheet) {
      throw new PositionReconciliationError(
        'position-bank-sheet-missing',
        `银行对账单缺少 sheet「${BANK_SHEET_NAME}」：${workbook.sourceFile}`,
        [`实际 sheets：${workbook.sheets.map((item) => item.name).join(' / ')}`]
      );
    }
    const headers = await readPhysicalHeader(workbook, sheet, cancelToken);
    if (!headersEqual(headers, BANK_STATEMENT_FIELDS) &&
        !headersEqual(headers, POSITION_BANK_HEADERS)) {
      throw new PositionReconciliationError(
        'position-bank-headers-invalid',
        `银行对账单表头不符合 46/49 列契约：${workbook.sourceFile}`,
        [
          `实际列数：${headers.length}`,
          `实际表头：${headers.join(' / ')}`
        ]
      );
    }
    return {
      sheet,
      sourceType: null,
      definition: null,
      headers
    };
  }

  const matches = [];
  for (const sheet of workbook.sheets) {
    const headers = await readPhysicalHeader(workbook, sheet, cancelToken);
    for (const [sourceType, definition] of Object.entries(SOURCE_DEFINITIONS)) {
      if (headersEqual(headers, definition.headers)) {
        matches.push({ sheet, sourceType, definition, headers });
      }
    }
  }
  if (matches.length === 0) {
    throw new PositionReconciliationError(
      'position-source-unrecognized',
      `无法通过表头识别链接原始表：${workbook.sourceFile}`
    );
  }
  if (matches.length > 1) {
    throw new PositionReconciliationError(
      'position-source-ambiguous',
      `文件中存在多个可识别原始表，无法确定唯一来源：${workbook.sourceFile}`,
      matches.map((match) => `${match.sheet.name} → ${match.definition.sourceName}`)
    );
  }
  return matches[0];
}

const BASE_DATE = new Date(1899, 11, 30, 0, 0, 0);
const REFERENCE_DATE = new Date();
const DATE_THRESHOLD = BASE_DATE.getTime() +
  (REFERENCE_DATE.getTimezoneOffset() - BASE_DATE.getTimezoneOffset()) * 60000;
const REFERENCE_OFFSET = REFERENCE_DATE.getTimezoneOffset();

function sheetJsSerialDate(value) {
  const output = new Date();
  output.setTime(value * 24 * 60 * 60 * 1000 + DATE_THRESHOLD);
  if (output.getTimezoneOffset() !== REFERENCE_OFFSET) {
    output.setTime(
      output.getTime() +
      (output.getTimezoneOffset() - REFERENCE_OFFSET) * 60000
    );
  }
  return output;
}

function sheetJsCompatibleCellValue(cell) {
  if (!cell || cell.cellType === 'blank' || cell.cellType === 'error') return '';
  if (cell.cellType === 'text') {
    return cell.decodedSemanticValue == null ? '' : String(cell.decodedSemanticValue);
  }
  if (cell.cellType === 'boolean') return !!cell.decodedSemanticValue;
  if (cell.cellType === 'date') {
    if (cell.decodedSemanticValue instanceof Date) {
      return new Date(cell.decodedSemanticValue.getTime());
    }
    const parsed = new Date(String(cell.decodedSemanticValue || cell.rawLexicalValue || ''));
    if (!Number.isNaN(parsed.getTime())) return parsed;
    throw parserParityError(
      `日期单元格尚未证明可与 SheetJS 等价：${path.basename(cell.sourceFile)} / ${cell.sourceSheet}`,
      [`单元格：${cell.rowIndex}:${cell.columnIndex + 1}`]
    );
  }
  if (cell.cellType === 'number') {
    if (cell.hasFormula && (cell.rawLexicalValue === null || cell.rawLexicalValue === '')) {
      throw parserParityError(
        `无缓存公式尚未证明可与 SheetJS 等价：${path.basename(cell.sourceFile)} / ${cell.sourceSheet}`,
        [`单元格：${cell.rowIndex}:${cell.columnIndex + 1}`]
      );
    }
    const numeric = Number.parseFloat(String(cell.rawLexicalValue || ''));
    if (classifyExcelNumberFormat(cell.sourceFormat || 'General').isDateLike) {
      if (!Number.isFinite(numeric)) {
        throw parserParityError(
          `数值日期尚未证明可与 SheetJS 等价：${path.basename(cell.sourceFile)} / ${cell.sourceSheet}`,
          [`单元格：${cell.rowIndex}:${cell.columnIndex + 1}`]
        );
      }
      return sheetJsSerialDate(numeric);
    }
    if (Number.isNaN(numeric)) return '';
    return Object.is(numeric, -0) ? 0 : numeric;
  }
  throw parserParityError(
    `单元格类型尚未证明可与 SheetJS 等价：${cell.cellType}`,
    [`文件：${path.basename(cell.sourceFile)}`, `sheet：${cell.sourceSheet}`]
  );
}

function valuesFromToolboxRow(row, width) {
  const values = new Array(width).fill('');
  for (const cell of row.cells) {
    if (cell.columnIndex < width) {
      values[cell.columnIndex] = sheetJsCompatibleCellValue(cell);
    }
  }
  return values;
}

async function streamPositionXlsxRows(filePath, options = {}) {
  const kind = options.kind === 'bank' ? 'bank' : 'source';
  const workbook = await openPositionWorkbook(filePath, options);
  try {
    const detected = await locatePositionBusinessSheet(
      workbook,
      kind,
      options.cancelToken
    );
    const sourceHeaders = detected.headers;
    let nonBlankRowCount = 0;
    await scanXlsxSheet({
      zip: workbook.zip,
      sheetEntry: workbook.entries.get(detected.sheet.entryPath),
      sheet: detected.sheet,
      sourceFile: workbook.filePath,
      sourceRegistry: workbook.sourceRegistry,
      date1904: workbook.date1904,
      sharedStrings: workbook.sharedStrings,
      themeColors: workbook.themeColors,
      cancelToken: options.cancelToken,
      onRow: (toolboxRow) => {
        if (toolboxRow.rowIndex === 1) return;
        const values = valuesFromToolboxRow(toolboxRow, sourceHeaders.length);
        const row = Object.fromEntries(
          sourceHeaders.map((header, index) => [header, values[index] ?? ''])
        );
        if (isBlankRow(row, sourceHeaders)) return;
        nonBlankRowCount += 1;
        if (typeof options.onRow === 'function') {
          options.onRow({
            row,
            excelRowNumber: toolboxRow.rowIndex,
            sourceType: detected.sourceType,
            sourceHeaders,
            sheetName: detected.sheet.name
          });
        }
      }
    });
    return {
      sourceFile: workbook.sourceFile,
      sheetName: detected.sheet.name,
      sourceType: detected.sourceType,
      sourceName: detected.definition ? detected.definition.sourceName : null,
      linkedName: detected.definition ? detected.definition.linkedName : null,
      sourceHeaders: sourceHeaders.slice(),
      nonBlankRowCount,
      date1904: workbook.date1904,
      sharedStringsMode: workbook.sharedStrings.mode,
      sharedStringsCount: workbook.sharedStrings.count
    };
  } catch (error) {
    if (error instanceof PositionReconciliationError) throw error;
    throw workbookInvalid(workbook.sourceFile, error);
  } finally {
    await workbook.close();
  }
}

module.exports = {
  HEADER_SCAN_MAX_COLUMNS,
  openPositionWorkbook,
  locatePositionBusinessSheet,
  readPhysicalHeader,
  sheetJsCompatibleCellValue,
  sheetJsSerialDate,
  streamPositionXlsxRows,
  valuesFromToolboxRow
};
