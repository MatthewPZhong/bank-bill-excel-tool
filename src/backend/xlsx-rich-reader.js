'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openZipWithEntries, WORKBOOK_ENTRY_NAME, WORKBOOK_RELS_ENTRY_NAME } = require('./big-table-import/zip-reader');
const { TOOLBOX_XLSX_METADATA_LIMITS, findRelationshipEntry, parseWorkbookRelationships,
  parseWorkbookXml, relationshipTypeAllowed, readToolboxMetadataEntryAsString } = require('./toolbox-format/xlsx-pass');
const { createSourceStyleRegistryFromOoxml } = require('./toolbox-format/style-registry');
const { scanXlsxSheet } = require('./toolbox-format/xlsx-sheet-scanner');
const { loadSharedStringsProvider } = require('./position-reconciliation-import/shared-strings-provider');

function invalid(message) { const error = new Error(message); error.code = 'RICH_XLSX_WORKBOOK_INVALID'; return error; }
function closeZip(zip) {
  if (zip.reader.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { zip.removeListener('close', done); zip.removeListener('error', failed); };
    const done = () => { clean(); resolve(); };
    const failed = (error) => { clean(); reject(error); };
    zip.once('close', done); zip.once('error', failed);
    try { zip.close(); } catch (error) { failed(error); }
  });
}

// 组合既有中性解析器；单声明页检查先于 styles/SST，包含隐藏页。
async function openRichWorkbook(filePath, options = {}, singleSheet = false) {
  const maxSheets = options.maxSheets ?? 4096;
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1 || maxSheets > 4096) throw invalid('工作表读取预算非法');
  const sourceFile = path.basename(filePath);
  const { zip, entries } = await openZipWithEntries(sourceFile, filePath, { rejectDuplicateEntries: true });
  let sharedStrings;
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      const errors = [];
      try { if (sharedStrings) await sharedStrings.close(); } catch (error) { errors.push(error); }
      try { await closeZip(zip); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'XLSX 读取资源关闭未确认');
    })();
    return closePromise;
  };
  try {
    const metadata = (entry, label, limit) => readToolboxMetadataEntryAsString(zip, entry,
      { sourceFile, partName: label, limitBytes: limit });
    if (!entries.has(WORKBOOK_ENTRY_NAME) || !entries.has(WORKBOOK_RELS_ENTRY_NAME)) throw invalid('工作簿缺少 workbook 或 relationships');
    const workbook = parseWorkbookXml(await metadata(entries.get(WORKBOOK_ENTRY_NAME), 'workbook.xml', TOOLBOX_XLSX_METADATA_LIMITS.workbook));
    const relationships = parseWorkbookRelationships(await metadata(entries.get(WORKBOOK_RELS_ENTRY_NAME), 'workbook.xml.rels', TOOLBOX_XLSX_METADATA_LIMITS.relationships));
    if (singleSheet && workbook.sheets.length !== 1) throw invalid('每个输入文件必须恰好声明一个工作表（包含隐藏页）');
    if (!workbook.sheets.length || workbook.sheets.length > maxSheets) throw invalid('工作表数量超出读取预算');
    const paths = new Set();
    const sheets = workbook.sheets.map((declared, sheetIndex) => {
      const relationship = relationships.get(declared.relationshipId);
      if (!relationship || relationship.targetMode === 'External' || !relationshipTypeAllowed(relationship.type, 'worksheet')
          || !entries.has(relationship.target) || paths.has(relationship.target)) throw invalid('工作表关系无效、重复或目标不存在');
      paths.add(relationship.target);
      return Object.freeze({ ...declared, sheetIndex, entryPath: relationship.target });
    });
    const sheet = sheets[0];
    const related = (kind, fallback) => findRelationshipEntry(entries, relationships, kind, fallback,
      { sourceFile, relationshipLabel: kind });
    const styles = related('styles', 'xl/styles.xml');
    const theme = related('theme', 'xl/theme/theme1.xml');
    const registry = createSourceStyleRegistryFromOoxml({ sourceRegistryId: `rich-${randomUUID()}`,
      stylesXml: styles ? await metadata(styles, 'styles.xml', TOOLBOX_XLSX_METADATA_LIMITS.styles) : '',
      themeXml: theme ? await metadata(theme, 'theme', TOOLBOX_XLSX_METADATA_LIMITS.theme) : '',
      requireStylesXml: !!styles, requireThemeXml: !!theme });
    sharedStrings = await loadSharedStringsProvider(zip, related('sharedStrings', 'xl/sharedStrings.xml'), {
      sourceFile, tempRoot: options.sstTempRoot, memoryBudgetBytes: options.memoryBudgetBytes,
      lruMaxEntries: options.lruMaxEntries, cacheMaxBytes: options.cacheMaxBytes,
      strictClose: true, cancelToken: options.cancelToken
    });
    let scanning = false;
    async function scanSheet(index, onRow, onSheetMeta) {
      if (scanning || closePromise || !sheets[index]) throw invalid('读取已关闭、并发扫描或页索引无效');
      scanning = true;
      const selected = sheets[index];
      try { return await scanXlsxSheet({ zip, sheetEntry: entries.get(selected.entryPath), sheet: selected, sourceFile,
        sourceRegistry: registry.registry, date1904: workbook.date1904, sharedStrings,
        themeColors: registry.themeColors, cancelToken: options.cancelToken, onRow, onSheetMeta }); }
      finally { scanning = false; }
    }
    return Object.freeze({ sheet, sheets: Object.freeze(sheets), date1904: workbook.date1904, sharedStrings, close,
      scanSheet, scan(onRow) { return scanSheet(0, onRow); } });
  } catch (error) {
    try { await close(); } catch (closeError) { throw new AggregateError([error, closeError], '工作簿读取失败且资源关闭未确认', { cause: error }); }
    throw error;
  }
}

function openSingleSheetRichWorkbook(filePath, options = {}) { return openRichWorkbook(filePath, options, true); }

module.exports = { openSingleSheetRichWorkbook, openRichWorkbook };
