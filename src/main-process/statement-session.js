const path = require('node:path');

function cloneRowsWithMetadata(rows = []) {
  const clonedRows = Array.isArray(rows)
    ? rows.map((row) => (Array.isArray(row) ? row.slice() : row))
    : [];

  if (Array.isArray(rows.rowMetas)) {
    clonedRows.rowMetas = rows.rowMetas.map((meta) => (meta ? { ...meta } : meta));
  }

  if (Array.isArray(rows.issues)) {
    clonedRows.issues = rows.issues.map((issue) => ({ ...issue }));
  }

  if (Array.isArray(rows.skippedRows)) {
    clonedRows.skippedRows = rows.skippedRows.map((row) => ({ ...row }));
  }

  if (Array.isArray(rows.simultaneousRows)) {
    clonedRows.simultaneousRows = rows.simultaneousRows.map((row) => ({ ...row }));
  }

  if (Array.isArray(rows.headerBreaks)) {
    clonedRows.headerBreaks = rows.headerBreaks.slice();
  }

  if (rows.amountSplitMatchStats && typeof rows.amountSplitMatchStats === 'object') {
    clonedRows.amountSplitMatchStats = { ...rows.amountSplitMatchStats };
  }

  // v1.4.9 PR #16 review P1 Fix C: 平行克隆 billSplitMatchStats
  if (rows.billSplitMatchStats && typeof rows.billSplitMatchStats === 'object') {
    clonedRows.billSplitMatchStats = { ...rows.billSplitMatchStats };
  }

  if (Array.isArray(rows.sourceRows)) {
    clonedRows.sourceRows = cloneRowsWithMetadata(rows.sourceRows);
  }

  return clonedRows;
}

function normalizeInputFilePaths(inputFilePathOrPaths, { dedupe = true } = {}) {
  const normalizedPaths = (Array.isArray(inputFilePathOrPaths) ? inputFilePathOrPaths : [inputFilePathOrPaths])
    .map((filePath) => String(filePath || '').trim())
    .filter((filePath) => filePath !== '')
    .map((filePath) => path.resolve(filePath));

  return dedupe ? Array.from(new Set(normalizedPaths)) : normalizedPaths;
}

function getStatementSessionKey({ templateId }) {
  return String(templateId || '');
}

function createStatementImportSession({ templateId, templateName }) {
  return {
    key: getStatementSessionKey({ templateId }),
    templateId,
    templateName,
    importCount: 0,
    currentBatchId: '',
    fileEntries: [],
    batches: []
  };
}

function getOrCreateStatementImportSession({ statementImportSessions, templateId, templateName }) {
  const sessionKey = getStatementSessionKey({ templateId });

  if (!statementImportSessions.has(sessionKey)) {
    statementImportSessions.set(
      sessionKey,
      createStatementImportSession({ templateId, templateName })
    );
  }

  return statementImportSessions.get(sessionKey);
}

function clearStatementExportCache(lastGeneratedExports, sessionKey = '') {
  if (!sessionKey || lastGeneratedExports.statementSessionKey !== sessionKey) {
    return;
  }

  lastGeneratedExports.allDetail = null;
  lastGeneratedExports.allBalance = null;
}

function pruneStatementImportSession(session) {
  session.batches = session.batches
    .map((batch) => ({
      ...batch,
      entryIds: batch.entryIds.filter((entryId) => session.fileEntries.some((entry) => entry.id === entryId))
    }))
    .filter((batch) => batch.entryIds.length > 0);

  if (!session.batches.some((batch) => batch.id === session.currentBatchId)) {
    session.currentBatchId = session.batches[session.batches.length - 1]?.id || '';
  }
}

function removeStatementSessionEntriesByFilePath(session, targetFilePath) {
  const normalizedPath = path.resolve(targetFilePath);
  const removedEntryIds = session.fileEntries
    .filter((entry) => entry.filePath === normalizedPath)
    .map((entry) => entry.id);

  if (!removedEntryIds.length) {
    return;
  }

  session.fileEntries = session.fileEntries.filter((entry) => entry.filePath !== normalizedPath);
  session.batches = session.batches.map((batch) => ({
    ...batch,
    entryIds: batch.entryIds.filter((entryId) => !removedEntryIds.includes(entryId))
  }));
  pruneStatementImportSession(session);
}

function buildStatementFileEntry({ buildEntryId, detailRows, filePath, matchedTemplateId = null }) {
  return {
    id: buildEntryId(),
    filePath: path.resolve(filePath),
    detailRows: cloneRowsWithMetadata(detailRows),
    matchedTemplateId: matchedTemplateId || null
  };
}

function getStatementSessionEntries(session, scope = 'all') {
  if (!session) {
    return [];
  }

  if (scope === 'current') {
    const currentBatch = session.batches.find((batch) => batch.id === session.currentBatchId);

    if (!currentBatch) {
      return [];
    }

    return currentBatch.entryIds
      .map((entryId) => session.fileEntries.find((entry) => entry.id === entryId))
      .filter(Boolean);
  }

  return session.fileEntries.slice();
}

function mergeMappedDetailRows(mappedRowsList = []) {
  const nonEmptyRows = mappedRowsList.filter((rows) => Array.isArray(rows) && rows.length > 0);

  if (!nonEmptyRows.length) {
    return [];
  }

  const mergedRows = [Array.isArray(nonEmptyRows[0][0]) ? nonEmptyRows[0][0].slice() : []];
  const mergedRowMetas = [];
  const mergedIssues = [];

  nonEmptyRows.forEach((rows) => {
    rows.slice(1).forEach((row) => {
      mergedRows.push(Array.isArray(row) ? row.slice() : row);
    });

    if (Array.isArray(rows.rowMetas)) {
      rows.rowMetas.forEach((meta) => {
        mergedRowMetas.push(meta ? { ...meta } : meta);
      });
    }

    if (Array.isArray(rows.issues)) {
      rows.issues.forEach((issue) => {
        mergedIssues.push({ ...issue });
      });
    }
  });

  mergedRows.rowMetas = mergedRowMetas;
  mergedRows.issues = mergedIssues;
  return mergedRows;
}

function resolveSinglePreparedFieldValue(detailRows, fieldName, { buildFieldIndexMap, normalizeCell }) {
  if (!Array.isArray(detailRows) || detailRows.length <= 1) {
    return '';
  }

  const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
  const fieldIndex = fieldIndexMap.get(normalizeCell(fieldName));

  if (fieldIndex === undefined) {
    return '';
  }

  const uniqueValues = Array.from(
    new Set(
      detailRows
        .slice(1)
        .map((row) => normalizeCell(Array.isArray(row) ? row[fieldIndex] : ''))
        .filter((value) => value !== '')
    )
  );

  return uniqueValues.length === 1 ? uniqueValues[0] : '';
}

function appendStatementSessionImport({
  buildBatchId,
  lastGeneratedExports,
  session,
  fileEntries = []
}) {
  const batchId = buildBatchId();
  const normalizedEntries = fileEntries.map((entry) => ({
    ...entry,
    detailRows: cloneRowsWithMetadata(entry.detailRows)
  }));

  session.importCount += 1;
  session.currentBatchId = batchId;
  session.fileEntries.push(...normalizedEntries);
  session.batches.push({
    id: batchId,
    entryIds: normalizedEntries.map((entry) => entry.id),
    importedAt: new Date().toISOString()
  });
  clearStatementExportCache(lastGeneratedExports, session.key);
  return batchId;
}

module.exports = {
  appendStatementSessionImport,
  buildStatementFileEntry,
  clearStatementExportCache,
  cloneRowsWithMetadata,
  createStatementImportSession,
  getOrCreateStatementImportSession,
  getStatementSessionEntries,
  getStatementSessionKey,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  pruneStatementImportSession,
  removeStatementSessionEntriesByFilePath,
  resolveSinglePreparedFieldValue
};
