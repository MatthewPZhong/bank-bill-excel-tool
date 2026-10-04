'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { loadSharedStringsProvider } = require('../xlsx/shared-strings-provider');
const { closeZip } = require('../xlsx/zip-lifecycle');
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
    themeColors,
    maxRowBytes
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
    this.closePromise = null;
    this.maxRowBytes = maxRowBytes;
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
        maxRowBytes: this.maxRowBytes,
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
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closed = true;
    if (this.sharedStrings && typeof this.sharedStrings.close === 'function') {
      this.closePromise = (async () => {
        const errors = [];
        try { await this.sharedStrings.close(); } catch (error) { errors.push(error); }
        try { await closeZip(this.zip); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, '工具箱 XLSX 资源关闭未确认');
      })();
      return this.closePromise;
    }
    try { this.zip.close(); } catch (_error) {}
  }
}

async function openToolboxXlsxPass(filePath, options = {}) {
  const adaptive = options.sharedStringsMode === 'adaptive';
  if (options.sharedStringsMode !== undefined && !adaptive) throw new TypeError('共享字符串读取模式非法');
  if (adaptive && (typeof options.sstTempRoot !== 'string' || !path.isAbsolute(options.sstTempRoot) ||
      !Number.isSafeInteger(options.memoryBudgetBytes) || options.memoryBudgetBytes < 1 ||
      !Number.isSafeInteger(options.cacheMaxBytes) || options.cacheMaxBytes < 1)) {
    throw new TypeError('落盘读取必须提供私有 SST 目录、主体预算和字节缓存预算');
  }
  const metadataLimits = { ...TOOLBOX_XLSX_METADATA_LIMITS };
  if (options.metadataLimits !== undefined) {
    if (!options.metadataLimits || typeof options.metadataLimits !== 'object' || Array.isArray(options.metadataLimits)) {
      throw new TypeError('XML 元数据预算非法');
    }
    for (const [key, limit] of Object.entries(options.metadataLimits)) {
      if (!Object.hasOwn(metadataLimits, key) || !Number.isSafeInteger(limit) || limit < 1 || limit > metadataLimits[key]) {
        throw new TypeError('XML 元数据预算不得超过既有安全上限');
      }
      metadataLimits[key] = limit;
    }
  }
  const absolutePath = path.resolve(filePath);
  const sourceFile = path.basename(absolutePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, absolutePath, {
    rejectDuplicateEntries: true
  });
  let sharedStrings;
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY_NAME);
    if (!workbookEntry) {
      throw new ToolboxXlsxFormatError('xlsx 缺少 xl/workbook.xml', { sourceFile });
    }
    const relsEntry = entries.get(WORKBOOK_RELS_ENTRY_NAME);
    const workbookXml = await readToolboxMetadataEntryAsString(zip, workbookEntry, {
      sourceFile,
      partName: 'workbook.xml',
      limitBytes: metadataLimits.workbook
    });
    const relsXml = relsEntry
      ? await readToolboxMetadataEntryAsString(zip, relsEntry, {
        sourceFile,
        partName: 'workbook.xml.rels',
        limitBytes: metadataLimits.relationships
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
        limitBytes: metadataLimits.styles
      })
      : '';
    const themeXml = themeEntry
      ? await readToolboxMetadataEntryAsString(zip, themeEntry, {
        sourceFile,
        partName: 'theme',
        limitBytes: metadataLimits.theme
      })
      : '';
    // 显式新合同使用公共落盘 provider；旧调用保留数组及同步 close 的兼容形状。
    if (adaptive) {
      assertToolboxSharedStringsSize(sharedStringsEntry, sourceFile);
      sharedStrings = await loadSharedStringsProvider(zip, sharedStringsEntry, {
        sourceFile, tempRoot: options.sstTempRoot,
        memoryBudgetBytes: options.memoryBudgetBytes, cacheMaxBytes: options.cacheMaxBytes,
        lruMaxEntries: options.lruMaxEntries, strictClose: true, cancelToken: options.cancelToken
      });
    } else {
      sharedStrings = await loadToolboxSharedStrings(zip, sharedStringsEntry, sourceFile);
    }
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
      themeColors: styleResult.themeColors,
      maxRowBytes: options.maxRowBytes
    });
  } catch (error) {
    if (adaptive) {
      const errors = [error];
      try { if (sharedStrings) await sharedStrings.close(); } catch (closeError) { errors.push(closeError); }
      try { await closeZip(zip); } catch (closeError) { errors.push(closeError); }
      if (errors.length > 1) throw new AggregateError(errors, '工具箱读取失败且资源关闭未确认', { cause: error });
      throw error;
    }
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
