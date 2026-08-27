'use strict';

const fs = require('node:fs');

const { buildMappedRows } = require('../../backend/file-service');
const { normalizeCell } = require('../../backend/file-service/common');
const { hasEffectiveAmount } = require('../../backend/file-service/normalizers');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession,
  getStatementSessionEntries
} = require('../statement-session');
const {
  assertMetadataCurrent,
  assertStatementSourceIdentityCurrent
} = require('./source-identity');

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

function importRequiresBigAccountInteraction(template) {
  const merchantMapping = template && template.mappingByField
    ? template.mappingByField.MerchantId
    : null;
  const mappingValues = Array.isArray(merchantMapping) ? merchantMapping : [merchantMapping];
  const requiresBigAccount = mappingValues.some((value) =>
    value === '__FIXED__:__MULTI_BIG_ACCOUNT__' || value === '自己输入');
  return requiresBigAccount;
}

function assertImportDoesNotRequireInteraction(template) {
  if (!importRequiresBigAccountInteraction(template)) return;
  throw new StatementSessionError(
    'STATEMENT_BIG_ACCOUNT_INTERACTION_BLOCKED',
    'Big-account selection remains blocked until an E09-B continuation supplies exact assignments'
  );
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
    generationConfig: session.generationConfig ? structuredClone(session.generationConfig) : null,
    templateEvidenceDigest: session.templateEvidenceDigest || '',
    generationConfigByDigest: new Map(
      [...(session.generationConfigByDigest || new Map())]
        .map(([digest, config]) => [digest, structuredClone(config)])
    ),
    fileEntries: session.fileEntries.map((entry) => ({
      ...entry,
      sourceIdentity: entry.sourceIdentity ? { ...entry.sourceIdentity } : null,
      detailRows: cloneRowsWithMetadata(entry.detailRows)
    })),
    batches: session.batches.map((batch) => ({
      ...batch,
      entryIds: batch.entryIds.slice()
    })),
    templateEvidenceByDigest: new Map(
      [...(session.templateEvidenceByDigest || new Map())]
        .map(([digest, snapshot]) => [digest, structuredClone(snapshot)])
    )
  };
}

function generationConfigFromTemplate(template) {
  const mappingByTargetField = structuredClone(template.mappingByField);
  return {
    template: {
      id: template.templateId,
      name: template.templateName,
      headers: template.expectedSourceHeaders.slice()
    },
    mappingByTargetField,
    selectedMerchantId: '',
    selectedCurrency: '',
    balanceRequested: Boolean(mappingByTargetField.Balance && mappingByTargetField.Balance !== '无'),
    balanceMode: mappingByTargetField.Balance === '通过发生额计算' ? 'calculated' : 'statement',
    exportTargetFields: template.orderedTargetFields.slice(),
    accountMappingByBankId: structuredClone(template.accountMappingByBankId),
    currencyMappings: structuredClone(template.currencyMappings),
    amountMappingRules: structuredClone(template.amountMappingRules),
    amountSplitByField: structuredClone(template.amountSplitByField),
    billSplitMerge: structuredClone(template.billSplitMerge),
    dateParseOrder: template.dateParseOrder
  };
}

function statementGenerationInputEvidence(session, scope) {
  const entries = getStatementSessionEntries(session, scope);
  return Object.freeze({
    hash: canonicalSha256({
      sessionKey: session.key,
      scope,
      currentBatchId: scope === 'current' ? session.currentBatchId : '',
      templateEvidenceDigest: session.templateEvidenceDigest,
      entries: entries.map((entry) => ({
        id: entry.id,
        resourceId: entry.sourceIdentity.resourceId,
        templateRef: entry.templateRef,
        templateDigest: entry.templateDigest,
        sourceIdentity: entry.sourceIdentity
      }))
    }),
    entries: Object.freeze(entries)
  });
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
        assertMetadataCurrent(source, fsImpl);
        return source.snapshot;
      } catch (_error) {
        throw sourceChanged();
      }
    },
    afterRead(_startedSnapshot) {
      try {
        assertMetadataCurrent(source, fsImpl);
      } catch (_error) {
        throw sourceChanged();
      }
    }
  });
}

function templateCatalogByRef(request) {
  return new Map(request.templateCatalog.map((entry) => [entry.templateRef, entry]));
}

function assertSessionOwner(session, owner) {
  if (session.key !== owner.sessionKey ||
      String(session.templateId) !== owner.templateId ||
      session.templateName !== owner.templateName) {
    throw new StatementSessionError(
      'STATEMENT_SESSION_OWNER_MISMATCH',
      'Statement session owner identity does not match existing state'
    );
  }
}

function buildMappedRowsForSource(source, template, options = {}) {
  const mapRows = options.buildMappedRows || buildMappedRows;
  const fsImpl = options.fs || fs;
  return mapRows({
    inputFilePath: source.path,
    orderedTargetFields: template.orderedTargetFields,
    mappingByField: template.mappingByField,
    accountMappingByBankId: template.accountMappingByBankId,
    currencyMappings: template.currencyMappings,
    amountMappingRules: template.amountMappingRules,
    amountSplitByField: template.amountSplitByField,
    billSplitMerge: template.billSplitMerge,
    expectedSourceHeaders: template.expectedSourceHeaders,
    selectedBigAccount: options.selectedBigAccount || null,
    dateParseOrder: template.dateParseOrder,
    readOptions: { readGuard: readGuardForSource(source, fsImpl) }
  });
}

function identifyAccountBlocks(detailRows, options = {}) {
  const { includeEmptyBlocks = false } = options;
  const headerRow = detailRows[0] || [];
  const dataRows = detailRows.slice(1);
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  const headerBreaks = Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks : [];
  const creditIndex = headerRow.indexOf('Credit Amount');
  const debitIndex = headerRow.indexOf('Debit Amount');
  const isTransactionRow = (row) => {
    const credit = creditIndex >= 0 && Array.isArray(row) ? row[creditIndex] : '';
    const debit = debitIndex >= 0 && Array.isArray(row) ? row[debitIndex] : '';
    return hasEffectiveAmount(credit) || hasEffectiveAmount(debit);
  };
  const trimBlock = (startIndex, initialEndIndex) => {
    let endIndex = initialEndIndex;
    while (endIndex >= startIndex && !isTransactionRow(dataRows[endIndex])) endIndex -= 1;
    while (startIndex <= endIndex && !isTransactionRow(dataRows[startIndex])) startIndex += 1;
    return { startIndex, endIndex };
  };
  if (!headerBreaks.length) {
    const trimmed = trimBlock(0, dataRows.length - 1);
    if (!includeEmptyBlocks && trimmed.startIndex > trimmed.endIndex) return [];
    return [{
      blockOrdinal: 0,
      startIndex: trimmed.startIndex,
      endIndex: trimmed.endIndex,
      startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || 2
    }];
  }
  const blocks = [];
  let blockStart = 0;
  let previousBreak = null;
  headerBreaks.forEach((breakRowNumber, blockOrdinal) => {
    const splitIndex = rowMetas.findIndex((meta, index) =>
      index >= blockStart && meta.sourceRowNumber >= breakRowNumber);
    const effectiveSplit = splitIndex >= 0 ? splitIndex : dataRows.length;
    const trimmed = trimBlock(blockStart, effectiveSplit > blockStart ? effectiveSplit - 1 : blockStart - 1);
    if (includeEmptyBlocks || trimmed.startIndex <= trimmed.endIndex) {
      blocks.push({
        blockOrdinal,
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || previousBreak || blockStart + 2
      });
    }
    blockStart = effectiveSplit;
    previousBreak = breakRowNumber;
  });
  const lastTrimmed = trimBlock(blockStart, dataRows.length - 1);
  if (includeEmptyBlocks || lastTrimmed.startIndex <= lastTrimmed.endIndex) {
    blocks.push({
      blockOrdinal: headerBreaks.length,
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber ||
        headerBreaks[headerBreaks.length - 1] || blockStart + 2
    });
  }
  return blocks;
}

function mappedRowsEvidence(detailRows) {
  const evidence = {
    rows: detailRows.map((row) => (Array.isArray(row) ? row.slice() : row)),
    rowMetas: Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas.map((meta) => ({ ...meta })) : [],
    headerBreaks: Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks.slice() : [],
    issues: Array.isArray(detailRows.issues) ? detailRows.issues.map((issue) => ({ ...issue })) : [],
    skippedRows: Array.isArray(detailRows.skippedRows)
      ? detailRows.skippedRows.map((row) => ({ ...row }))
      : [],
    simultaneousRows: Array.isArray(detailRows.simultaneousRows)
      ? detailRows.simultaneousRows.map((row) => ({ ...row }))
      : []
  };
  if (detailRows.amountSplitMatchStats && typeof detailRows.amountSplitMatchStats === 'object') {
    evidence.amountSplitMatchStats = { ...detailRows.amountSplitMatchStats };
  }
  if (detailRows.billSplitMatchStats && typeof detailRows.billSplitMatchStats === 'object') {
    evidence.billSplitMatchStats = { ...detailRows.billSplitMatchStats };
  }
  if (Array.isArray(detailRows.sourceRows)) {
    evidence.sourceRows = mappedRowsEvidence(detailRows.sourceRows);
  }
  return evidence;
}

function provisionalDigest(entries) {
  return canonicalSha256(entries.map((entry) => ({
    resourceId: entry.source.resourceId,
    templateRef: entry.source.templateRef,
    templateDigest: entry.evidence.digest,
    sourceIdentity: entry.source.sourceIdentity,
    detailRows: mappedRowsEvidence(entry.detailRows)
  })));
}

function selectionRows(entries, options = {}) {
  const rows = [];
  for (const entry of entries) {
    if (!entry.requiresInteraction) continue;
    for (const block of identifyAccountBlocks(entry.detailRows, options)) {
      rows.push({
        index: rows.length,
        label: `${rows.length + 1}.`,
        sourceRowNumber: block.startRowNumber,
        fileName: entry.source.resourceId
      });
    }
  }
  return rows;
}

function applyBigAccountAssignments(entries, assignments, options = {}) {
  const assignmentByIndex = new Map(assignments.map((assignment) => [assignment.rowIndex, assignment]));
  let globalBlockIndex = 0;
  return entries.map((entry) => {
    const nextRows = cloneRowsWithMetadata(entry.detailRows);
    if (!entry.requiresInteraction) return nextRows;
    const header = nextRows[0] || [];
    const merchantIdIndex = header.indexOf('MerchantId');
    const currencyIndex = header.indexOf('Currency');
    const dataRows = nextRows.slice(1);
    const keepIndices = new Set();
    for (const block of identifyAccountBlocks(entry.detailRows, options)) {
      const assignment = assignmentByIndex.get(globalBlockIndex);
      for (let index = block.startIndex; index <= block.endIndex && index < dataRows.length; index += 1) {
        keepIndices.add(index);
        if (assignment) {
          if (merchantIdIndex >= 0) dataRows[index][merchantIdIndex] = assignment.merchantId;
          if (currencyIndex >= 0) dataRows[index][currencyIndex] = assignment.currency;
        }
      }
      globalBlockIndex += 1;
    }
    const result = [nextRows[0]];
    const rowMetas = [];
    dataRows.forEach((row, index) => {
      if (!keepIndices.has(index)) return;
      result.push(row);
      if (Array.isArray(nextRows.rowMetas) && nextRows.rowMetas[index]) {
        rowMetas.push(nextRows.rowMetas[index]);
      }
    });
    result.rowMetas = rowMetas;
    if (Array.isArray(nextRows.issues)) result.issues = nextRows.issues;
    if (Array.isArray(nextRows.headerBreaks)) result.headerBreaks = [];
    if (Array.isArray(nextRows.skippedRows)) result.skippedRows = nextRows.skippedRows;
    if (Array.isArray(nextRows.simultaneousRows)) result.simultaneousRows = nextRows.simultaneousRows;
    if (nextRows.amountSplitMatchStats && typeof nextRows.amountSplitMatchStats === 'object') {
      result.amountSplitMatchStats = { ...nextRows.amountSplitMatchStats };
    }
    if (nextRows.billSplitMatchStats && typeof nextRows.billSplitMatchStats === 'object') {
      result.billSplitMatchStats = { ...nextRows.billSplitMatchStats };
    }
    if (Array.isArray(nextRows.sourceRows)) {
      result.sourceRows = cloneRowsWithMetadata(nextRows.sourceRows);
    }
    return result;
  });
}

async function buildStatementImportCandidate(state, request, options = {}) {
  const fsImpl = options.fs || fs;
  const templates = templateCatalogByRef(request);
  const hasAssignments = Array.isArray(options.bigAccountAssignments) ||
    options.selectedBigAccount || Array.isArray(options.selectedBigAccounts);
  if (!hasAssignments) {
    for (const evidence of templates.values()) {
      assertImportDoesNotRequireInteraction(evidence.snapshot);
    }
  }
  const candidate = cloneStatementServiceState(state);
  candidate.sessionRevision += 1;
  candidate.activePhase = 'import';
  candidate.persistentReservationId = 'pending-reservation'.padEnd(256, 'x');
  const owner = request.sessionOwner;
  const existing = candidate.sessions.get(owner.sessionKey);
  const session = existing || createStatementImportSession({
    templateId: owner.templateId,
    templateName: owner.templateName
  });
  if (!existing) {
    session.key = owner.sessionKey;
    session.templateEvidenceByDigest = new Map();
  } else {
    assertSessionOwner(session, owner);
    if (!(session.templateEvidenceByDigest instanceof Map)) {
      throw new StatementSessionError(
        'STATEMENT_TEMPLATE_EVIDENCE_MISSING',
        'Existing Statement session lacks template evidence'
      );
    }
  }
  for (const evidence of templates.values()) {
    session.templateEvidenceByDigest.set(
      evidence.digest,
      structuredClone(evidence.snapshot)
    );
  }
  candidate.sessions.set(owner.sessionKey, session);
  session.generationConfigByDigest = new Map(
    [...templates.values()].map((evidence) => [
      evidence.digest,
      generationConfigFromTemplate(evidence.snapshot)
    ])
  );
  const ownerEvidence = [...templates.values()].find(
    (evidence) => String(evidence.snapshot.templateId) === owner.templateId
  ) || [...templates.values()][0];
  session.generationConfig = ownerEvidence
    ? generationConfigFromTemplate(ownerEvidence.snapshot)
    : null;
  session.templateEvidenceDigest = canonicalSha256(request.templateCatalog.map((evidence) => ({
    templateRef: evidence.templateRef,
    digest: evidence.digest
  })));

  const mappedEntries = [];
  for (const [sourceIndex, source] of request.sources.entries()) {
    if (typeof options.assertNotCancelled === 'function') options.assertNotCancelled();
    const evidence = templates.get(source.templateRef);
    if (!evidence) {
      throw new StatementSessionError(
        'STATEMENT_IMPORT_TEMPLATE_REF_UNKNOWN',
        'Statement source templateRef is not in the template catalog'
      );
    }
    const template = evidence.snapshot;
    const detailRows = buildMappedRowsForSource(source, template, {
      ...options,
      selectedBigAccount: Array.isArray(options.selectedBigAccounts)
        ? options.selectedBigAccounts[sourceIndex]
        : (options.selectedBigAccount || null)
    });
    await assertStatementSourceIdentityCurrent(source, {
      fs: fsImpl,
      assertNotCancelled: options.assertNotCancelled
    });
    mappedEntries.push({
      source,
      evidence,
      template,
      detailRows,
      requiresInteraction: importRequiresBigAccountInteraction(template)
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (options.expectedProvisionalDigest && provisionalDigest(mappedEntries) !== options.expectedProvisionalDigest) {
    throw new StatementSessionError(
      'STATEMENT_TOKEN_CANDIDATE_STALE',
      'Statement provisional candidate changed before continuation'
    );
  }
  const resolvedRows = Array.isArray(options.bigAccountAssignments)
    ? applyBigAccountAssignments(mappedEntries, options.bigAccountAssignments, {
        includeEmptyBlocks: options.bigAccountChoiceMode === 'fixed'
      })
    : mappedEntries.map((entry) => entry.detailRows);
  const importedEntries = [];
  for (const [sourceIndex, source] of request.sources.entries()) {
    const mapped = mappedEntries[sourceIndex];
    const entry = buildStatementFileEntry({
      buildEntryId: () => `statement-entry-${state.serviceGeneration}-${candidate.nextEntryOrdinal++}`,
      detailRows: resolvedRows[sourceIndex],
      filePath: source.path,
      matchedTemplateId: mapped.template.templateId
    });
    importedEntries.push({
      ...entry,
      templateRef: source.templateRef,
      templateDigest: mapped.evidence.digest,
      sourceIdentity: { ...source.sourceIdentity },
      sourceEvidence: {
        resourceId: source.resourceId,
        snapshot: { ...source.snapshot }
      }
    });
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
      sessionKey: owner.sessionKey,
      currentBatchId,
      entryCount: session.fileEntries.length,
      importedEntryIds: Object.freeze(importedEntries.map((entry) => entry.id))
    })
  });
}

function normalizeBigAccountChoices(template) {
  const choices = [];
  for (const item of Array.isArray(template.bigAccounts) ? template.bigAccounts : []) {
    const merchantId = normalizeCell(item && item.merchantId);
    const currencies = Array.isArray(item && item.currencies)
      ? [...new Set(item.currencies.map(normalizeCell).filter(Boolean))]
      : [];
    if (!merchantId || currencies.length === 0) continue;
    for (const currency of currencies) {
      choices.push({
        merchantId,
        currency,
        accountNature: item.accountNature === 'own' ? 'own' : 'client'
      });
    }
  }
  return choices;
}

async function buildBigAccountInteractionDraft(state, request, options = {}) {
  const templates = templateCatalogByRef(request);
  const interactionTemplates = request.templateCatalog
    .filter((entry) => importRequiresBigAccountInteraction(entry.snapshot));
  if (interactionTemplates.length === 0) return null;
  const choices = [];
  const seenChoices = new Set();
  for (const evidence of interactionTemplates) {
    for (const choice of normalizeBigAccountChoices(evidence.snapshot)) {
      const key = `${choice.merchantId}\u0000${choice.currency}\u0000${choice.accountNature}`;
      if (seenChoices.has(key)) continue;
      seenChoices.add(key);
      choices.push(choice);
    }
  }
  if (choices.length === 0) {
    throw new StatementSessionError(
      'STATEMENT_BIG_ACCOUNT_INTERACTION_BLOCKED',
      'Big-account selection remains blocked without maintained choices'
    );
  }
  const provisionalEntries = [];
  for (const source of request.sources) {
    if (typeof options.assertNotCancelled === 'function') options.assertNotCancelled();
    const evidence = templates.get(source.templateRef);
    if (!evidence) {
      throw new StatementSessionError(
        'STATEMENT_IMPORT_TEMPLATE_REF_UNKNOWN',
        'Statement source templateRef is not in the template catalog'
      );
    }
    const template = evidence.snapshot;
    const detailRows = buildMappedRowsForSource(source, template, options);
    await assertStatementSourceIdentityCurrent(source, {
      fs: options.fs || fs,
      assertNotCancelled: options.assertNotCancelled
    });
    provisionalEntries.push({
      source,
      evidence,
      template,
      detailRows,
      requiresInteraction: importRequiresBigAccountInteraction(template)
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const rows = selectionRows(provisionalEntries);
  if (rows.length === 0) {
    throw new StatementSessionError(
      'NO_TRANSACTION_DATA',
      '导入文件中没有账号存在交易数据'
    );
  }
  const rowsWithEmptyBlocks = selectionRows(provisionalEntries, { includeEmptyBlocks: true });
  const bigAccounts = [];
  for (const choice of choices) {
    let grouped = bigAccounts.find((item) => item.merchantId === choice.merchantId);
    if (!grouped) {
      grouped = { merchantId: choice.merchantId, currencies: [], isMultiCurrency: false };
      bigAccounts.push(grouped);
    }
    if (!grouped.currencies.includes(choice.currency)) grouped.currencies.push(choice.currency);
    grouped.isMultiCurrency = grouped.currencies.length > 1;
  }
  const choiceDomain = {
    rows: rows.map((row) => row.index),
    rowsWithEmptyBlocks: rowsWithEmptyBlocks.map((row) => row.index),
    options: choices
  };
  const candidateDigest = provisionalDigest(provisionalEntries);
  return Object.freeze({
    purpose: 'big-account',
    sessionKey: request.sessionOwner.sessionKey,
    sessionRevision: state.sessionRevision,
    prompt: {
      status: 'select-big-account',
      message: '请选择本次使用的大账号 / 币种',
      selectionMode: 'multi-row',
      templateId: request.sessionOwner.templateId,
      rows,
      rowsWithEmptyBlocks,
      bigAccounts,
      expandedBigAccountOptions: choices,
      fixedAssignments: interactionTemplates.flatMap((entry) =>
        Array.isArray(entry.snapshot.fixedAssignments) ? entry.snapshot.fixedAssignments : [])
    },
    allowedChoices: choiceDomain,
    privateContext: {
      evidence: {
        sessionOwner: request.sessionOwner,
        templateCatalog: request.templateCatalog,
        sources: request.sources.map((source) => ({
          resourceId: source.resourceId,
          snapshot: source.snapshot,
          templateRef: source.templateRef
        }))
      },
      request,
      choiceDomain,
      candidateDigest,
      provisionalFiles: provisionalEntries.map((entry) => ({
        resourceId: entry.source.resourceId,
        detailRows: mappedRowsEvidence(entry.detailRows)
      })),
      evidenceDigest: canonicalSha256({
        sessionOwner: request.sessionOwner,
        templateCatalog: request.templateCatalog,
        sources: request.sources
      })
    }
  });
}

module.exports = {
  StatementSessionError,
  buildStableSummary,
  buildBigAccountInteractionDraft,
  buildStatementImportCandidate,
  cloneStatementServiceState,
  createStatementServiceState,
  importRequiresBigAccountInteraction,
  statementGenerationInputEvidence
};
