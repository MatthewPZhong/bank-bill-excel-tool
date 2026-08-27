'use strict';

const fs = require('node:fs');

const { buildMappedRows } = require('../../backend/file-service');
const {
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession,
  removeStatementSessionEntriesByFilePath
} = require('../statement-session');

class StatementSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementSessionError';
    this.code = code;
  }
}

function sourceChanged() {
  return new StatementSessionError(
    'BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT',
    'Statement source evidence changed during import'
  );
}

function assertImportDoesNotRequireInteraction(template) {
  const merchantMapping = template && template.mappingByField
    ? template.mappingByField.MerchantId
    : null;
  const mappingValues = Array.isArray(merchantMapping) ? merchantMapping : [merchantMapping];
  const requiresBigAccount = mappingValues.some((value) =>
    value === '__FIXED__:__MULTI_BIG_ACCOUNT__' || value === '自己输入');
  if (requiresBigAccount) {
    throw new StatementSessionError(
      'STATEMENT_BIG_ACCOUNT_INTERACTION_BLOCKED',
      'Big-account selection remains blocked until E09-B'
    );
  }
}

function createStatementServiceState(serviceGeneration) {
  return {
    serviceGeneration,
    sessionRevision: 0,
    sessions: new Map(),
    stableSummary: null,
    activePhase: 'idle',
    persistentReservationId: null,
    nextEntryOrdinal: 1,
    nextBatchOrdinal: 1,
    artifactQualifications: new Map(),
    futureTokenContext: null
  };
}

function cloneSession(session) {
  return {
    key: session.key,
    templateId: session.templateId,
    templateName: session.templateName,
    importCount: session.importCount,
    currentBatchId: session.currentBatchId,
    fileEntries: session.fileEntries.map((entry) => ({
      ...entry,
      detailRows: cloneRowsWithMetadata(entry.detailRows)
    })),
    batches: session.batches.map((batch) => ({
      ...batch,
      entryIds: batch.entryIds.slice()
    }))
  };
}

function cloneStatementServiceState(state) {
  return {
    serviceGeneration: state.serviceGeneration,
    sessionRevision: state.sessionRevision,
    sessions: new Map([...state.sessions].map(([key, session]) => [key, cloneSession(session)])),
    stableSummary: state.stableSummary ? { ...state.stableSummary } : null,
    activePhase: state.activePhase,
    persistentReservationId: state.persistentReservationId,
    nextEntryOrdinal: state.nextEntryOrdinal,
    nextBatchOrdinal: state.nextBatchOrdinal,
    artifactQualifications: new Map(),
    futureTokenContext: null
  };
}

function countRows(detailRows) {
  return Array.isArray(detailRows) ? Math.max(0, detailRows.length - 1) : 0;
}

function buildStableSummary(state) {
  let batchCount = 0;
  let fileCount = 0;
  let rowCount = 0;
  for (const session of state.sessions.values()) {
    batchCount += session.batches.length;
    fileCount += session.fileEntries.length;
    rowCount += session.fileEntries.reduce((sum, entry) => sum + countRows(entry.detailRows), 0);
  }
  return {
    serviceGeneration: state.serviceGeneration,
    sessionRevision: state.sessionRevision,
    sessionCount: state.sessions.size,
    batchCount,
    fileCount,
    rowCount,
    pendingInteractionCount: 0,
    pendingInteractions: [],
    activePhase: state.activePhase
  };
}

function readGuardForSource(source, fsImpl) {
  return Object.freeze({
    beforeRead() {
      try {
        const stat = fsImpl.lstatSync(source.path, { bigint: true });
        if (stat.isSymbolicLink() || !sourceSnapshotMatchesStat(source.snapshot, stat)) {
          throw sourceChanged();
        }
        return source.snapshot;
      } catch (error) {
        if (error instanceof StatementSessionError) throw error;
        throw sourceChanged();
      }
    },
    afterRead(startedSnapshot) {
      try {
        const stat = fsImpl.lstatSync(source.path, { bigint: true });
        if (stat.isSymbolicLink() || !sourceSnapshotMatchesStat(startedSnapshot, stat)) {
          throw sourceChanged();
        }
      } catch (error) {
        if (error instanceof StatementSessionError) throw error;
        throw sourceChanged();
      }
    }
  });
}

async function buildStatementImportCandidate(state, request, options = {}) {
  const fsImpl = options.fs || fs;
  const mapRows = options.buildMappedRows || buildMappedRows;
  const candidate = cloneStatementServiceState(state);
  candidate.sessionRevision += 1;
  candidate.activePhase = 'import';
  candidate.persistentReservationId = 'pending-reservation'.padEnd(256, 'x');
  const template = request.templateEvidence.snapshot;
  assertImportDoesNotRequireInteraction(template);
  const existing = candidate.sessions.get(request.sessionKey);
  const session = existing || createStatementImportSession({
    templateId: template.templateId,
    templateName: template.templateName
  });
  candidate.sessions.set(request.sessionKey, session);

  const importedEntries = [];
  for (const source of request.sources) {
    if (typeof options.assertNotCancelled === 'function') options.assertNotCancelled();
    const detailRows = mapRows({
      inputFilePath: source.path,
      orderedTargetFields: template.orderedTargetFields,
      mappingByField: template.mappingByField,
      accountMappingByBankId: template.accountMappingByBankId,
      currencyMappings: template.currencyMappings,
      amountMappingRules: template.amountMappingRules,
      amountSplitByField: template.amountSplitByField,
      billSplitMerge: template.billSplitMerge,
      expectedSourceHeaders: template.expectedSourceHeaders,
      selectedBigAccount: null,
      dateParseOrder: template.dateParseOrder,
      readOptions: { readGuard: readGuardForSource(source, fsImpl) }
    });
    removeStatementSessionEntriesByFilePath(session, source.path);
    importedEntries.push(buildStatementFileEntry({
      buildEntryId: () => `statement-entry-${state.serviceGeneration}-${candidate.nextEntryOrdinal++}`,
      detailRows,
      filePath: source.path,
      matchedTemplateId: template.templateId
    }));
    await new Promise((resolve) => setImmediate(resolve));
  }

  const currentBatchId = appendStatementSessionImport({
    buildBatchId: () => `statement-batch-${state.serviceGeneration}-${candidate.nextBatchOrdinal++}`,
    lastGeneratedExports: {},
    session,
    fileEntries: importedEntries
  });
  candidate.activePhase = 'idle';
  candidate.stableSummary = buildStableSummary(candidate);
  return Object.freeze({
    state: candidate,
    result: Object.freeze({
      sessionKey: session.key,
      currentBatchId,
      entryCount: session.fileEntries.length,
      importedEntryIds: Object.freeze(importedEntries.map((entry) => entry.id))
    })
  });
}

module.exports = {
  StatementSessionError,
  buildStableSummary,
  buildStatementImportCandidate,
  cloneStatementServiceState,
  createStatementServiceState
};
