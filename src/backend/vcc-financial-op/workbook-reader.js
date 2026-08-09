'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BigTableImportError,
  openZipWithEntries,
  locateSheets,
  readEntryAsString,
  WORKBOOK_ENTRY_NAME
} = require('../big-table-import/zip-reader');
const { scanSheetRows } = require('../big-table-import/row-scanner');
const {
  loadSharedStringsProvider
} = require('../position-reconciliation-import/shared-strings-provider');
const { parseWorkbookXml } = require('../toolbox-format/xlsx-pass');
const {
  SOURCE_TYPES,
  SYSTEM_OP_HEADERS,
  detectDetailSourceType,
  getSourceDefinition,
  headersEqual,
  isLegacyPendingHeaders,
  isSystemOpHeaders,
  normalizeHeaderRow
} = require('./definitions');
const {
  legacyPendingUpgradeDetails,
  pendingHeaderCandidate,
  pendingHeaderMismatchDetails
} = require('./pending-template-contract');

const PREVIEW_COLUMN_COUNT = 64;
const PREVIEW_MEANINGFUL_ROWS = 220;

function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function openWorkbookSheets(filePath, options = {}) {
  const sourceFile = path.basename(filePath);
  const opened = await openZipWithEntries(sourceFile, filePath, { rejectDuplicateEntries: true });
  let sharedStrings = null;
  const sstTempRoot = options.sstTempRoot || path.join(
    os.tmpdir(),
    `vcc-fin-op-sst-${crypto.randomUUID()}`
  );
  try {
    const workbookEntry = opened.entries.get(WORKBOOK_ENTRY_NAME);
    if (!workbookEntry) {
      throw new BigTableImportError(`${sourceFile}：xlsx 缺少 workbook.xml`, []);
    }
    const workbookMetadata = parseWorkbookXml(
      await readEntryAsString(opened.zip, workbookEntry)
    );
    if (workbookMetadata.date1904) {
      throw new BigTableImportError(
        `${sourceFile}：暂不支持 1904 日期系统`,
        ['请将工作簿日期系统改为 1900 后重新导入，避免账期偏移']
      );
    }
    const sheets = await locateSheets(opened.zip, opened.entries);
    const resolved = sheets
      .filter((sheet) => sheet.entryPath && opened.entries.has(sheet.entryPath))
      .map((sheet) => ({ ...sheet, entry: opened.entries.get(sheet.entryPath) }));
    if (resolved.length === 0) {
      throw new BigTableImportError(`${sourceFile}：未找到可读取的数据 sheet`, []);
    }
    const sharedStringsEntry = opened.entries.get('xl/sharedStrings.xml') || null;
    sharedStrings = await loadSharedStringsProvider(opened.zip, sharedStringsEntry, {
      sourceFile,
      tempRoot: sstTempRoot,
      memoryBudgetBytes: options.sstMemoryBudgetBytes,
      lruMaxEntries: options.sstLruMaxEntries
    });
    let closed = false;
    return {
      ...opened,
      sourceFile,
      sheets: resolved,
      sharedStrings,
      date1904: false,
      sstTempRoot,
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (sharedStrings) await sharedStrings.close();
        } finally {
          await fs.promises.rm(sstTempRoot, { recursive: true, force: true });
          try { opened.zip.close(); } catch (_error) { /* ignore */ }
        }
      }
    };
  } catch (error) {
    if (sharedStrings) {
      try { await sharedStrings.close(); } catch (_closeError) { /* ignore */ }
    }
    try { await fs.promises.rm(sstTempRoot, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
    try { opened.zip.close(); } catch (_closeError) { /* ignore */ }
    throw error;
  }
}

async function previewSheet(workbook, sheet, maxRows = PREVIEW_MEANINGFUL_ROWS) {
  const rows = [];
  const stream = await openReadStream(workbook.zip, sheet.entry);
  await scanSheetRows({
    stream,
    expectedHeaders: new Array(PREVIEW_COLUMN_COUNT).fill(''),
    sharedStrings: workbook.sharedStrings,
    valueColumnWhitelist: null,
    collectAllColumns: true,
    onRow: ({ rowR, values, hasAnyCellText }) => {
      if (!hasAnyCellText) return;
      rows.push({ rowR, values: normalizeHeaderRow(values) });
      if (rows.length >= maxRows) {
        const stop = new Error('preview complete');
        stop.__stopParsing = true;
        stop.__stopValue = null;
        throw stop;
      }
    }
  });
  return rows;
}

function findSystemOpHeaders(rows) {
  return (rows || []).filter((row) => isSystemOpHeaders(row.values));
}

function systemHeaderCandidate(rows) {
  const expectedSet = new Set(SYSTEM_OP_HEADERS);
  let best = null;
  for (const row of rows || []) {
    const actual = normalizeHeaderRow(row.values);
    const uniqueOverlap = new Set(actual.filter((header) => expectedSet.has(header))).size;
    const positionMatches = SYSTEM_OP_HEADERS.reduce((count, header, index) => (
      count + (actual[index] === header ? 1 : 0)
    ), 0);
    if (uniqueOverlap < Math.ceil(SYSTEM_OP_HEADERS.length / 2)) continue;
    const candidate = { ...row, actual, uniqueOverlap, positionMatches };
    if (!best
      || candidate.uniqueOverlap > best.uniqueOverlap
      || (candidate.uniqueOverlap === best.uniqueOverlap
        && candidate.positionMatches > best.positionMatches)) {
      best = candidate;
    }
  }
  return best;
}

function systemHeaderMismatchDetails(candidate) {
  const actual = candidate ? candidate.actual : [];
  const details = [
    `正式模板要求 ${SYSTEM_OP_HEADERS.length} 列，实际识别到 ${actual.length} 列`,
    '请使用 assets/VCC财务OP校验/系统财务OP.xlsx，并保留完整表头及原顺序'
  ];
  const mismatchCount = Math.max(actual.length, SYSTEM_OP_HEADERS.length);
  for (let index = 0; index < mismatchCount && details.length < 8; index++) {
    const expectedHeader = SYSTEM_OP_HEADERS[index] || '（无此列）';
    const actualHeader = actual[index] || '（缺失）';
    if (expectedHeader !== actualHeader) {
      details.push(`第 ${index + 1} 列应为“${expectedHeader}”，实际为“${actualHeader}”`);
    }
  }
  return details;
}

function pendingContractError(sourceFile, message, detailLines) {
  const error = new BigTableImportError(`${sourceFile}：${message}`, detailLines || []);
  error.code = 'pending-template-contract-mismatch';
  return error;
}

function legacyPendingTemplateError(sourceFile, matches = []) {
  return pendingContractError(
    sourceFile,
    '模板已更新，请使用 46 列 VCC_移除归档Pending账单.xlsx',
    [
      ...matches.map((match) => `${match.sheetName}：第 ${match.headerRow} 行`),
      ...legacyPendingUpgradeDetails()
    ]
  );
}

async function inspectSourceFile(filePath) {
  const workbook = await openWorkbookSheets(filePath);
  try {
    const previews = [];
    const detailMatches = [];
    const legacyPendingMatches = [];
    for (const sheet of workbook.sheets) {
      const rows = await previewSheet(workbook, sheet);
      previews.push({ sheetName: sheet.name, rows });
      for (const row of rows) {
        if (isLegacyPendingHeaders(row.values)) {
          legacyPendingMatches.push({ sheetName: sheet.name, headerRow: row.rowR });
          break;
        }
        const sourceType = detectDetailSourceType(row.values);
        if (sourceType) {
          detailMatches.push({ sourceType, sheetName: sheet.name, headerRow: row.rowR });
          break;
        }
      }
    }

    const systemMatches = previews.flatMap((preview) => (
      findSystemOpHeaders(preview.rows).map((header) => ({
        sheetName: preview.sheetName,
        headerRow: header.rowR
      }))
    ));
    if (detailMatches.length > 1 && systemMatches.length === 0 && legacyPendingMatches.length === 0) {
      throw new BigTableImportError(
        `${workbook.sourceFile}：检测到多张校验原表 sheet，拒绝只读取其中一张`,
        detailMatches.map((match) => `${match.sheetName}：${match.sourceType}`)
      );
    }
    if (systemMatches.length > 1 && detailMatches.length === 0 && legacyPendingMatches.length === 0) {
      throw new BigTableImportError(
        `${workbook.sourceFile}：检测到多处系统财务OP完整表头，拒绝只读取其中一处`,
        systemMatches.map((match) => `${match.sheetName}：第 ${match.headerRow} 行`)
      );
    }
    const recognizedCount = detailMatches.length + systemMatches.length + legacyPendingMatches.length;
    if (recognizedCount > 1) {
      throw new BigTableImportError(
        `${workbook.sourceFile}：检测到多个可识别业务表，拒绝静默选择其中一个`,
        [
          ...detailMatches.map((match) => `${match.sheetName}：${match.sourceType}`),
          ...systemMatches.map((match) => `${match.sheetName}：${SOURCE_TYPES.SYSTEM_OP}`),
          ...legacyPendingMatches.map((match) => `${match.sheetName}：旧 48 列 Pending 模板`)
        ]
      );
    }
    if (legacyPendingMatches.length === 1) {
      throw legacyPendingTemplateError(workbook.sourceFile, legacyPendingMatches);
    }
    if (detailMatches.length === 1) {
      const match = detailMatches[0];
      const definition = getSourceDefinition(match.sourceType);
      return {
        filePath,
        fileName: workbook.sourceFile,
        sourceType: match.sourceType,
        sheetName: match.sheetName,
        headerRow: match.headerRow,
        requiresSubject: definition.requiresFileSubject === true
      };
    }

    if (systemMatches.length > 1) {
      throw new BigTableImportError(
        `${workbook.sourceFile}：检测到多处系统财务OP完整表头，拒绝只读取其中一处`,
        systemMatches.map((match) => `${match.sheetName}：第 ${match.headerRow} 行`)
      );
    }
    if (systemMatches.length === 1) {
      return {
        filePath,
        fileName: workbook.sourceFile,
        sourceType: SOURCE_TYPES.SYSTEM_OP,
        sheetName: systemMatches[0].sheetName,
        headerRow: systemMatches[0].headerRow,
        requiresSubject: false
      };
    }

    const malformedPendingHeaders = previews
      .map((preview) => ({
        sheetName: preview.sheetName,
        candidate: pendingHeaderCandidate(preview.rows)
      }))
      .filter((entry) => entry.candidate)
      .sort((left, right) => (
        right.candidate.uniqueOverlap - left.candidate.uniqueOverlap
        || right.candidate.positionMatches - left.candidate.positionMatches
      ));
    if (malformedPendingHeaders.length > 0) {
      const malformed = malformedPendingHeaders[0];
      throw pendingContractError(
        workbook.sourceFile,
        'Pending 原表表头与最新正式模板不一致',
        [
          `${malformed.sheetName}：第 ${malformed.candidate.rowR} 行`,
          ...pendingHeaderMismatchDetails(malformed.candidate)
        ]
      );
    }

    const malformedSystemHeaders = previews
      .map((preview) => ({
        sheetName: preview.sheetName,
        candidate: systemHeaderCandidate(preview.rows)
      }))
      .filter((entry) => entry.candidate)
      .sort((left, right) => (
        right.candidate.uniqueOverlap - left.candidate.uniqueOverlap
        || right.candidate.positionMatches - left.candidate.positionMatches
      ));
    if (malformedSystemHeaders.length > 0) {
      const malformed = malformedSystemHeaders[0];
      throw new BigTableImportError(
        `${workbook.sourceFile}：系统财务OP表头与正式模板不一致`,
        [
          `${malformed.sheetName}：第 ${malformed.candidate.rowR} 行`,
          ...systemHeaderMismatchDetails(malformed.candidate)
        ]
      );
    }

    throw new BigTableImportError(
      `${workbook.sourceFile}：无法识别为 VCC 财务OP校验原表`,
      [
        '请确认文件表头与 assets/VCC财务OP校验 中对应的正式模板完全一致',
        '系统财务OP请使用 assets/VCC财务OP校验/系统财务OP.xlsx；旧 YYMMOP 横表不再支持'
      ]
    );
  } finally {
    await workbook.close();
  }
}

async function inspectSourceFiles(filePaths) {
  const results = [];
  for (const filePath of filePaths || []) results.push(await inspectSourceFile(filePath));
  return results;
}

async function findDetailSheet(workbook, definition) {
  const detailMatches = [];
  const systemMatches = [];
  const legacyPendingMatches = [];
  const pendingCandidates = [];
  for (const sheet of workbook.sheets) {
    const rows = await previewSheet(workbook, sheet, PREVIEW_MEANINGFUL_ROWS);
    for (const row of rows.filter((entry) => isLegacyPendingHeaders(entry.values))) {
      legacyPendingMatches.push({ sheet, headerRow: row.rowR });
    }
    const pendingCandidate = pendingHeaderCandidate(rows);
    if (pendingCandidate) pendingCandidates.push({ sheet, candidate: pendingCandidate });
    const header = rows.find((row) => detectDetailSourceType(row.values));
    if (header) {
      detailMatches.push({
        sheet,
        headerRow: header.rowR,
        sourceType: detectDetailSourceType(header.values)
      });
    }
    for (const header of findSystemOpHeaders(rows)) {
      systemMatches.push({ sheet, headerRow: header.rowR });
    }
  }
  const recognizedCount = detailMatches.length + systemMatches.length + legacyPendingMatches.length;
  if (recognizedCount > 1) {
    throw new BigTableImportError(
      `${workbook.sourceFile}：正式导入时检测到多个可识别业务表，拒绝静默选择其中一个`,
      [
        ...detailMatches.map((match) => `${match.sheet.name}：${match.sourceType}`),
        ...systemMatches.map((match) => `${match.sheet.name}：${SOURCE_TYPES.SYSTEM_OP}`),
        ...legacyPendingMatches.map((match) => `${match.sheet.name}：旧 48 列 Pending 模板`)
      ]
    );
  }
  if (definition.sourceType === SOURCE_TYPES.PENDING && legacyPendingMatches.length === 1) {
    throw legacyPendingTemplateError(workbook.sourceFile, legacyPendingMatches.map((match) => ({
      sheetName: match.sheet.name,
      headerRow: match.headerRow
    })));
  }
  const match = detailMatches[0];
  if (match && match.sourceType === definition.sourceType) return match;
  if (definition.sourceType === SOURCE_TYPES.PENDING && pendingCandidates.length > 0) {
    const malformed = pendingCandidates.sort((left, right) => (
      right.candidate.uniqueOverlap - left.candidate.uniqueOverlap
      || right.candidate.positionMatches - left.candidate.positionMatches
    ))[0];
    throw pendingContractError(
      workbook.sourceFile,
      'Pending 原表表头与最新正式模板不一致',
      [
        `${malformed.sheet.name}：第 ${malformed.candidate.rowR} 行`,
        ...pendingHeaderMismatchDetails(malformed.candidate)
      ]
    );
  }
  return null;
}

async function streamDetailRows(filePath, sourceType, { onDataRow, onProgress } = {}) {
  const definition = getSourceDefinition(sourceType);
  if (!definition) throw new Error(`不支持的明细原表类型：${sourceType}`);
  const workbook = await openWorkbookSheets(filePath);
  try {
    const found = await findDetailSheet(workbook, definition);
    if (!found) {
      throw new BigTableImportError(`${workbook.sourceFile}：未找到 ${sourceType} 对应的原表 sheet`, []);
    }
    const stream = await openReadStream(workbook.zip, found.sheet.entry);
    let rowCount = 0;
    await scanSheetRows({
      stream,
      expectedHeaders: definition.headers,
      sharedStrings: workbook.sharedStrings,
      valueColumnWhitelist: null,
      cellTypeColumnWhitelist: new Set([definition.indexes[definition.keyHeader]]),
      collectAllColumns: (rowR) => rowR === found.headerRow,
      onRow: ({ rowR, values, hasAnyCellText, cellTypes }) => {
        if (rowR === found.headerRow) {
          if (!headersEqual(values, definition.headers)) {
            if (sourceType === SOURCE_TYPES.PENDING) {
              if (isLegacyPendingHeaders(values)) {
                throw legacyPendingTemplateError(workbook.sourceFile, [{
                  sheetName: found.sheet.name,
                  headerRow: rowR
                }]);
              }
              throw pendingContractError(
                workbook.sourceFile,
                'Pending 原表表头在读取期间与最新模板不一致',
                pendingHeaderMismatchDetails({ actual: normalizeHeaderRow(values) })
              );
            }
            throw new BigTableImportError(`${workbook.sourceFile}：原表表头在读取期间发生变化`, []);
          }
          return;
        }
        if (rowR < found.headerRow || !hasAnyCellText) return;
        rowCount += 1;
        onDataRow({
          rowR,
          values,
          sourceFile: workbook.sourceFile,
          sheetName: found.sheet.name,
          keyCellType: cellTypes && cellTypes[definition.indexes[definition.keyHeader]]
        });
        if (rowCount % 10000 === 0 && typeof onProgress === 'function') {
          onProgress({ sourceFile: workbook.sourceFile, rowCount });
        }
      }
    });
    if (typeof onProgress === 'function') onProgress({ sourceFile: workbook.sourceFile, rowCount });
    return { sourceFile: workbook.sourceFile, sheetName: found.sheet.name, rowCount };
  } finally {
    await workbook.close();
  }
}

module.exports = {
  PREVIEW_COLUMN_COUNT,
  PREVIEW_MEANINGFUL_ROWS,
  openWorkbookSheets,
  findSystemOpHeaders,
  systemHeaderCandidate,
  systemHeaderMismatchDetails,
  pendingContractError,
  legacyPendingTemplateError,
  inspectSourceFile,
  inspectSourceFiles,
  streamDetailRows
};
