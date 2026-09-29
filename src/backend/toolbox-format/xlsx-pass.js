'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  openZipWithEntries,
  WORKBOOK_ENTRY_NAME,
  WORKBOOK_RELS_ENTRY_NAME
} = require('../xlsx/zip-reader');
const {
  createSourceStyleRegistryFromOoxml
} = require('../xlsx/style-registry');
const {
  ToolboxXlsxCancelledError,
  ToolboxXlsxFormatError,
  scanXlsxSheet
} = require('../xlsx/xlsx-sheet-scanner');
const {
  TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES,
  TOOLBOX_XLSX_METADATA_LIMITS,
  assertToolboxSharedStringsSize,
  findRelationshipEntry,
  loadToolboxSharedStrings,
  normalizeRelationshipTarget,
  parseWorkbookRelationships,
  parseWorkbookXml,
  relationshipTypeAllowed,
  readToolboxMetadataEntryAsString
} = require('../xlsx/workbook-parts');

class ToolboxXlsxPass {
  constructor({
    filePath,
    sourceFile,
    zip,
    entries,
    sheets,
    relationships,
    date1904,
    sharedStrings,
    sourceRegistry,
    themeColors
  }) {
    this.filePath = filePath;
    this.sourceFile = sourceFile;
    this.format = 'xlsx';
    this.zip = zip;
    this.entries = entries;
    this.sheets = Object.freeze(sheets.map((sheet) => Object.freeze({ ...sheet })));
    this.workbookRelationships = Object.freeze(
      [...relationships.values()].map((relationship) => Object.freeze({ ...relationship }))
    );
    this.date1904 = !!date1904;
    this.sharedStrings = sharedStrings;
    this.sourceRegistry = sourceRegistry;
    this.sourceRegistryId = sourceRegistry.sourceRegistryId;
    this.themeColors = themeColors;
    this.closed = false;
    this.scanActive = false;
  }

  getSourceRegistry(sourceRegistryId = this.sourceRegistryId) {
    return sourceRegistryId === this.sourceRegistryId ? this.sourceRegistry : null;
  }

  _resolveSheet(sheetOrIndex) {
    if (Number.isInteger(sheetOrIndex)) return this.sheets[sheetOrIndex] || null;
    if (sheetOrIndex && this.sheets.includes(sheetOrIndex)) return sheetOrIndex;
    if (sheetOrIndex && Number.isInteger(sheetOrIndex.sheetIndex)) {
      return this.sheets[sheetOrIndex.sheetIndex] || null;
    }
    return null;
  }

  async scanSheet(sheetOrIndex, options = {}) {
    if (this.closed) throw new Error('ToolboxXlsxPass 已关闭');
    if (this.scanActive) throw new Error('同一 ToolboxXlsxPass 不允许并发扫描多个工作表');
    const sheet = this._resolveSheet(sheetOrIndex);
    if (!sheet) throw new RangeError('未找到指定 XLSX 工作表');
    if (!sheet.entryPath || !this.entries.has(sheet.entryPath)) {
      throw new ToolboxXlsxFormatError('工作簿中的工作表关系缺失或已损坏', {
        sourceFile: this.sourceFile,
        sheetName: sheet.name,
        sheetIndex: sheet.sheetIndex
      });
    }

    this.scanActive = true;
    try {
      return await scanXlsxSheet({
        ...options,
        zip: this.zip,
        sheetEntry: this.entries.get(sheet.entryPath),
        sheet,
        sourceFile: this.filePath,
        sourceRegistry: this.sourceRegistry,
        date1904: this.date1904,
        sharedStrings: this.sharedStrings,
        themeColors: this.themeColors
      });
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
      if (options.cancelToken && options.cancelToken.cancelled) {
        throw new ToolboxXlsxCancelledError();
      }
      if (!includeSheet(sheet)) continue;
      const summary = await this.scanSheet(sheet, {
        cancelToken: options.cancelToken,
        onSheetMeta: options.onSheetMeta
          ? (meta) => options.onSheetMeta(meta, sheet)
          : null,
        onRow: options.onRow
          ? (row, meta) => options.onRow(row, meta, sheet)
          : null
      });
      if (options.cancelToken && options.cancelToken.cancelled) {
        throw new ToolboxXlsxCancelledError();
      }
      summaries.push(summary);
    }
    return summaries;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.zip.close(); } catch (_error) {}
  }
}

async function openToolboxXlsxPass(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const sourceFile = path.basename(absolutePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, absolutePath, {
    rejectDuplicateEntries: true
  });
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY_NAME);
    if (!workbookEntry) {
      throw new ToolboxXlsxFormatError('xlsx 缺少 xl/workbook.xml', { sourceFile });
    }
    const relsEntry = entries.get(WORKBOOK_RELS_ENTRY_NAME);
    const workbookXml = await readToolboxMetadataEntryAsString(zip, workbookEntry, {
      sourceFile,
      partName: 'workbook.xml',
      limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.workbook
    });
    const relsXml = relsEntry
      ? await readToolboxMetadataEntryAsString(zip, relsEntry, {
        sourceFile,
        partName: 'workbook.xml.rels',
        limitBytes: TOOLBOX_XLSX_METADATA_LIMITS.relationships
      })
      : '';
    const workbook = parseWorkbookXml(workbookXml);
    const relationships = relsEntry ? parseWorkbookRelationships(relsXml) : new Map();

    const sheetEntryPaths = new Set();
    const sheets = workbook.sheets.map((sheet, sheetIndex) => {
      const relationship = sheet.relationshipId
        ? relationships.get(String(sheet.relationshipId))
        : null;
      if (!relationship) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”缺少对应的 workbook relationship`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId
        });
      }
      if (relationship.targetMode === 'External' ||
          !relationshipTypeAllowed(relationship.type, 'worksheet')) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”的关系类型不是有效 worksheet`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          relationshipType: relationship.type,
          targetMode: relationship.targetMode
        });
      }
      if (!relationship.target || !entries.has(relationship.target)) {
        throw new ToolboxXlsxFormatError(`工作表“${sheet.name}”指向的 worksheet entry 不存在`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          entryPath: relationship.target
        });
      }
      if (sheetEntryPaths.has(relationship.target)) {
        throw new ToolboxXlsxFormatError(`多个工作表声明指向同一 worksheet entry：${relationship.target}`, {
          sourceFile,
          sheetName: sheet.name,
          sheetIndex,
          relationshipId: sheet.relationshipId,
          entryPath: relationship.target
        });
      }
      sheetEntryPaths.add(relationship.target);
      return {
        name: sheet.name,
        state: sheet.state,
        sheetIndex,
        relationshipId: sheet.relationshipId,
        entryPath: relationship && relationship.target ? relationship.target : null
      };
    });
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
    const sharedStrings = await loadToolboxSharedStrings(zip, sharedStringsEntry, sourceFile);
    const sourceRegistryId = options.sourceRegistryId ||
      `xlsx-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
    const styleResult = createSourceStyleRegistryFromOoxml({
      sourceRegistryId,
      stylesXml,
      themeXml,
      requireStylesXml: !!stylesEntry,
      requireThemeXml: !!themeEntry
    });

    return new ToolboxXlsxPass({
      filePath: absolutePath,
      sourceFile,
      zip,
      entries,
      sheets,
      relationships,
      date1904: workbook.date1904,
      sharedStrings,
      sourceRegistry: styleResult.registry,
      themeColors: styleResult.themeColors
    });
  } catch (error) {
    try { zip.close(); } catch (_closeError) {}
    throw error;
  }
}

module.exports = {
  TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES,
  TOOLBOX_XLSX_METADATA_LIMITS,
  ToolboxXlsxPass,
  assertToolboxSharedStringsSize,
  findRelationshipEntry,
  loadToolboxSharedStrings,
  normalizeRelationshipTarget,
  openToolboxXlsxPass,
  parseWorkbookRelationships,
  parseWorkbookXml,
  relationshipTypeAllowed,
  readToolboxMetadataEntryAsString
};
