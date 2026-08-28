'use strict';

const path = require('node:path');

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession
} = require('../statement-session');
const {
  createStatementBalanceSeedOverwriteContinuationDto,
  createStatementBalanceSeedOverwritePrivateContextDto,
  createStatementTokenHandleDto
} = require('./contracts');

const LEGACY_GLOBAL_KEYS = Object.freeze([
  'statementImportSessions',
  'lastFileImportContext',
  'lastPendingBigAccountSelection',
  'lastManualBalancePrompt',
  'lastPendingBalanceSeedConfirmation',
  'lastGeneratedExports'
]);
const STATEMENT_EXPORT_KEYS = Object.freeze([
  'detail',
  'balance',
  'allDetail',
  'allBalance'
]);

function exactLegacyGlobals(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('Statement legacy globals must be a plain object');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key === 'symbol') || keys.length !== LEGACY_GLOBAL_KEYS.length ||
      LEGACY_GLOBAL_KEYS.some((key) => !keys.includes(key))) {
    throw new TypeError('Statement legacy globals must contain exact six fields');
  }
  const result = {};
  for (const key of LEGACY_GLOBAL_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`Statement legacy global ${key} must be an enumerable own data property`);
    }
    result[key] = descriptor.value;
  }
  if (!(result.statementImportSessions instanceof Map) ||
      Object.getPrototypeOf(result.statementImportSessions) !== Map.prototype ||
      Reflect.ownKeys(result.statementImportSessions).length !== 0) {
    throw new TypeError('statementImportSessions must be an exact Map');
  }
  return result;
}

function jsonSnapshot(value, fallback = null) {
  if (value === undefined) return fallback;
  return canonicalJsonSnapshot(value);
}

function rowCount(rows) {
  return Array.isArray(rows) ? Math.max(0, rows.length - 1) : 0;
}

function stableSourceEvidence(filePath, sourceId, snapshot = null) {
  return {
    sourceId,
    fileName: path.basename(String(filePath || '')),
    snapshot: snapshot ? jsonSnapshot(snapshot) : null
  };
}

function projectFileEntry(entry, sourceId) {
  return {
    id: String(entry && entry.id || ''),
    source: stableSourceEvidence(entry && entry.filePath, sourceId),
    detailRows: cloneRowsWithMetadata(entry && entry.detailRows),
    matchedHeaders: Array.isArray(entry && entry.matchedHeaders)
      ? entry.matchedHeaders.slice()
      : null,
    selfInputMerchant: Boolean(entry && entry.selfInputMerchant),
    skipDirectMerchantLookup: Boolean(entry && entry.skipDirectMerchantLookup),
    matchedTemplateId: entry && entry.matchedTemplateId || null
  };
}

function projectSession(session, sessionIndex) {
  const fileEntries = (Array.isArray(session && session.fileEntries) ? session.fileEntries : [])
    .map((entry, entryIndex) => projectFileEntry(
      entry,
      `session-${sessionIndex + 1}-file-${entryIndex + 1}`
    ));
  return {
    key: String(session && session.key || ''),
    templateId: session && session.templateId,
    templateName: String(session && session.templateName || ''),
    importCount: Number(session && session.importCount || 0),
    currentBatchId: String(session && session.currentBatchId || ''),
    fileEntries,
    batches: (Array.isArray(session && session.batches) ? session.batches : []).map((batch) => ({
      id: String(batch && batch.id || ''),
      entryIds: (Array.isArray(batch && batch.entryIds) ? batch.entryIds : []).map(String),
      importedAt: String(batch && batch.importedAt || '')
    }))
  };
}

function projectGeneratedArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    fileName: String(value.fileName || path.basename(String(value.filePath || ''))),
    templateName: String(value.templateName || '')
  };
}

function projectGeneratedExports(lastGeneratedExports) {
  const result = {};
  for (const key of STATEMENT_EXPORT_KEYS) {
    result[key] = projectGeneratedArtifact(lastGeneratedExports && lastGeneratedExports[key]);
  }
  result.statementSessionKey = String(
    lastGeneratedExports && lastGeneratedExports.statementSessionKey || ''
  );
  result.currentBatchId = String(lastGeneratedExports && lastGeneratedExports.currentBatchId || '');
  return result;
}

function projectRememberedGeneration(context, projectedSessions) {
  if (!context) return null;
  const sessionKey = String(context.statementSessionKey || '');
  const sessionOwnsRows = Boolean(sessionKey && projectedSessions.has(sessionKey));
  const remembered = {
    templateId: context.templateId,
    template: jsonSnapshot(context.template, {}),
    mappings: jsonSnapshot(Array.isArray(context.mappings) ? context.mappings : [], []),
    orderedTargetFields: (Array.isArray(context.orderedTargetFields)
      ? context.orderedTargetFields
      : []).map(String),
    sources: (Array.isArray(context.inputFilePaths) ? context.inputFilePaths : [])
      .map((filePath, index) => stableSourceEvidence(
        filePath,
        `remembered-source-${index + 1}`
      )),
    selectedBigAccount: context.selectedBigAccount
      ? jsonSnapshot(context.selectedBigAccount)
      : null,
    scope: String(context.scope || 'current'),
    statementSessionKey: sessionKey,
    currentBatchId: String(context.currentBatchId || ''),
    preparedRowsEvidence: context.preparedDetailRows
      ? {
          owner: sessionOwnsRows ? 'session' : 'remembered-generation',
          rowCount: rowCount(context.preparedDetailRows),
          sessionKey,
          currentBatchId: String(context.currentBatchId || '')
        }
      : null,
    preparedDetailRows: context.preparedDetailRows && !sessionOwnsRows
      ? cloneRowsWithMetadata(context.preparedDetailRows)
      : null
  };
  return remembered;
}

function projectDisplayRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    index: Number.isSafeInteger(Number(row && row.index)) ? Number(row.index) : index,
    fileBlockOrdinal: Number.isSafeInteger(Number(row && row.fileBlockOrdinal))
      ? Number(row.fileBlockOrdinal)
      : index,
    sourceRowNumber: Number(row && row.sourceRowNumber || 0),
    fileName: String(row && row.fileName || '')
  }));
}

function projectPendingSourceSelections(selections) {
  return (Array.isArray(selections) ? selections : []).map((selection, index) => stableSourceEvidence(
    selection && selection.resolvedPath,
    `pending-source-${index + 1}`,
    selection && selection.sourceSnapshot
  ));
}

function buildBigAccountPrivateContext(pending, serviceGeneration, sessionRevision) {
  if (!pending) return null;
  const sourceEvidence = projectPendingSourceSelections(pending.sourceSelections);
  const context = {
    purpose: 'big-account',
    serviceGeneration,
    sessionRevision,
    templateId: pending.templateId,
    template: jsonSnapshot(pending.template, {}),
    mappings: jsonSnapshot(Array.isArray(pending.mappings) ? pending.mappings : [], []),
    orderedTargetFields: (Array.isArray(pending.orderedTargetFields)
      ? pending.orderedTargetFields
      : []).map(String),
    rememberedSources: (Array.isArray(pending.inputFilePaths) ? pending.inputFilePaths : [])
      .map((filePath, index) => stableSourceEvidence(
        filePath,
        `pending-remembered-source-${index + 1}`
      )),
    bigAccounts: jsonSnapshot(Array.isArray(pending.bigAccounts) ? pending.bigAccounts : [], []),
    fixedAssignments: jsonSnapshot(
      Array.isArray(pending.fixedAssignments) ? pending.fixedAssignments : [],
      []
    ),
    fileEntries: (Array.isArray(pending.fileEntries) ? pending.fileEntries : [])
      .map((entry, index) => projectFileEntry(entry, `pending-file-${index + 1}`)),
    rows: projectDisplayRows(pending.rows),
    rowsWithEmptyBlocks: projectDisplayRows(pending.rowsWithEmptyBlocks || pending.rows),
    sourceEvidence,
    sessionFreshnessEvidence: {
      statementSelectionSessionId: String(pending.statementSelectionSessionId || ''),
      sourceIds: sourceEvidence.map((source) => source.sourceId)
    },
    bigAccountOrderEvidence: pending.bigAccountOrderEvidence
      ? jsonSnapshot(pending.bigAccountOrderEvidence)
      : null
  };
  context.allowedChoiceDigest = canonicalSha256({
    rows: context.rows,
    bigAccounts: context.bigAccounts,
    fixedAssignments: context.fixedAssignments
  });
  return context;
}

function buildManualBalancePrivateContext(prompt, rememberedGeneration, serviceGeneration, sessionRevision) {
  if (!prompt) return null;
  const context = {
    purpose: 'manual-balance',
    serviceGeneration,
    sessionRevision,
    prompt: jsonSnapshot(prompt),
    generationRef: rememberedGeneration
      ? {
          statementSessionKey: rememberedGeneration.statementSessionKey,
          currentBatchId: rememberedGeneration.currentBatchId,
          scope: rememberedGeneration.scope
        }
      : null
  };
  context.allowedChoiceDigest = canonicalSha256(context.prompt);
  return context;
}

function buildBalanceSeedOverwritePrivateContext(
  confirmation,
  rememberedGeneration,
  serviceGeneration,
  sessionRevision
) {
  if (!confirmation) return null;
  const plan = confirmation.plan || {};
  const seedRecord = plan.record || {};
  const confirmationSession = confirmation.session || {};
  const generationContext = confirmation.importContext || rememberedGeneration || {};
  const record = {
    bankName: String(plan.bankName || ''),
    merchantId: String(seedRecord.merchantId || ''),
    currency: String(seedRecord.currency || ''),
    billDate: String(seedRecord.billDate || ''),
    endBalance: seedRecord.endBalance,
    templateName: String(seedRecord.templateName || ''),
    generationMethod: String(seedRecord.generationMethod || ''),
    existingIndex: Number(plan.existingIndex)
  };
  const freshnessEvidence = {
    recordsDigest: canonicalSha256(String(plan.recordsEvidence || '')),
    inputSourcesDigest: canonicalSha256(
      (Array.isArray(confirmation.inputFilePaths) ? confirmation.inputFilePaths : []).map(String)
    ),
    statementSessionKey: String(
      confirmationSession.key || generationContext.statementSessionKey || ''
    ),
    currentBatchId: String(
      confirmationSession.currentBatchId || generationContext.currentBatchId || ''
    ),
    scope: generationContext.scope === 'all' ? 'all' : 'current'
  };
  const inputSourceCount = Array.isArray(confirmation.inputFilePaths)
    ? confirmation.inputFilePaths.length
    : 0;
  const allowedChoiceDigest = canonicalSha256({
    kind: 'balance-seed-overwrite',
    record,
    freshnessEvidence,
    inputSourceCount
  });
  return createStatementBalanceSeedOverwritePrivateContextDto({
    kind: 'balance-seed-overwrite',
    purpose: 'manual-balance',
    serviceGeneration,
    sessionRevision,
    record,
    freshnessEvidence,
    inputSourceCount,
    allowedChoiceDigest
  });
}

function buildScopePrivateContext(scopeKind, rememberedGeneration, serviceGeneration, sessionRevision) {
  const context = {
    purpose: 'scope-generation',
    serviceGeneration,
    sessionRevision,
    kind: scopeKind === 'balance' ? 'balance' : 'detail',
    generationRef: rememberedGeneration
      ? {
          statementSessionKey: rememberedGeneration.statementSessionKey,
          currentBatchId: rememberedGeneration.currentBatchId
        }
      : null,
    allowedScopes: ['current', 'all']
  };
  context.allowedChoiceDigest = canonicalSha256({
    kind: context.kind,
    allowedScopes: context.allowedScopes
  });
  return context;
}

function buildStatementProbeProjection(legacyInput, options = {}) {
  const legacy = exactLegacyGlobals(legacyInput);
  const serviceGeneration = Number.isSafeInteger(options.serviceGeneration) &&
    options.serviceGeneration > 0
    ? options.serviceGeneration
    : 1;
  const sessionRevision = Number.isSafeInteger(options.sessionRevision) &&
    options.sessionRevision >= 0
    ? options.sessionRevision
    : Array.from(legacy.statementImportSessions.values())
      .reduce((sum, session) => sum + Number(session && session.importCount || 0), 0);
  const projectedSessions = new Map();
  let sessionIndex = 0;
  for (const [key, session] of legacy.statementImportSessions) {
    projectedSessions.set(String(key), projectSession(session, sessionIndex));
    sessionIndex += 1;
  }
  const rememberedGeneration = projectRememberedGeneration(
    legacy.lastFileImportContext,
    projectedSessions
  );
  const purpose = options.purpose || (legacy.lastPendingBigAccountSelection
    ? 'big-account'
    : legacy.lastManualBalancePrompt
      ? 'manual-balance'
      : 'scope-generation');
  let privateContext;
  if (purpose === 'big-account') {
    privateContext = buildBigAccountPrivateContext(
      legacy.lastPendingBigAccountSelection,
      serviceGeneration,
      sessionRevision
    );
  } else if (purpose === 'manual-balance') {
    privateContext = legacy.lastPendingBalanceSeedConfirmation
      ? buildBalanceSeedOverwritePrivateContext(
        legacy.lastPendingBalanceSeedConfirmation,
        rememberedGeneration,
        serviceGeneration,
        sessionRevision
      )
      : buildManualBalancePrivateContext(
        legacy.lastManualBalancePrompt,
        rememberedGeneration,
        serviceGeneration,
        sessionRevision
      );
  } else if (purpose === 'scope-generation') {
    privateContext = buildScopePrivateContext(
      options.scopeKind,
      rememberedGeneration,
      serviceGeneration,
      sessionRevision
    );
  } else {
    throw new TypeError('Statement probe purpose is invalid');
  }
  if (!privateContext) {
    throw new TypeError(`Statement legacy globals do not contain ${purpose} pending context`);
  }

  const sessionKey = rememberedGeneration && rememberedGeneration.statementSessionKey ||
    projectedSessions.keys().next().value || 'statement-probe';
  const tokenId = String(options.tokenId || 'probe-token-1');
  const reservationId = String(options.reservationId || 'probe-reservation-1');
  const handle = createStatementTokenHandleDto({
    tokenId,
    purpose,
    serviceGeneration,
    sessionKey,
    sessionRevision,
    expiresAt: Number.isSafeInteger(options.expiresAt) && options.expiresAt > 0
      ? options.expiresAt
      : Date.UTC(2026, 7, 27, 15, 0, 0),
    allowedChoiceDigest: privateContext.allowedChoiceDigest,
    reservationId
  });
  const tokens = new Map([[
    tokenId,
    {
      purpose,
      expiresAt: handle.expiresAt,
      privateContextRef: 'pending-interaction-1'
    }
  ]]);
  const pendingInteractionReservations = new Map([[tokenId, reservationId]]);
  const sessions = Array.from(projectedSessions.values());
  const summary = {
    sessionCount: sessions.length,
    batchCount: sessions.reduce((sum, session) => sum + session.batches.length, 0),
    fileCount: sessions.reduce((sum, session) => sum + session.fileEntries.length, 0),
    rowCount: sessions.reduce((sum, session) => (
      sum + session.fileEntries.reduce((entrySum, entry) => entrySum + rowCount(entry.detailRows), 0)
    ), 0),
    rememberedGeneration,
    generatedExports: projectGeneratedExports(legacy.lastGeneratedExports)
  };
  const serviceState = {
    serviceGeneration,
    sessionRevision,
    sessions: projectedSessions,
    tokens,
    stableSummary: summary,
    activeJobId: null,
    persistentReservation: null,
    pendingInteractionReservations
  };
  const pendingFileEntries = Array.isArray(
    legacy.lastPendingBigAccountSelection && legacy.lastPendingBigAccountSelection.fileEntries
  ) ? legacy.lastPendingBigAccountSelection.fileEntries : [];
  const legacyInventory = Object.freeze({
    globalNames: LEGACY_GLOBAL_KEYS.slice(),
    sessionCount: legacy.statementImportSessions.size,
    sessionFileEntryCount: Array.from(legacy.statementImportSessions.values())
      .reduce((sum, session) => sum + (Array.isArray(session.fileEntries) ? session.fileEntries.length : 0), 0),
    sessionRowCount: summary.rowCount,
    rememberedPreparedRowCount: rowCount(
      legacy.lastFileImportContext && legacy.lastFileImportContext.preparedDetailRows
    ),
    rememberedSelectedBigAccount: Boolean(
      legacy.lastFileImportContext && legacy.lastFileImportContext.selectedBigAccount
    ),
    pendingFileEntryCount: pendingFileEntries.length,
    pendingRowCount: pendingFileEntries.reduce(
      (sum, entry) => sum + rowCount(entry && entry.detailRows),
      0
    ),
    pendingSourceSelectionCount: Array.isArray(
      legacy.lastPendingBigAccountSelection && legacy.lastPendingBigAccountSelection.sourceSelections
    ) ? legacy.lastPendingBigAccountSelection.sourceSelections.length : 0,
    assertSessionCurrentPresent: typeof (
      legacy.lastPendingBigAccountSelection &&
      legacy.lastPendingBigAccountSelection.assertSessionCurrent
    ) === 'function',
    legacyBigAccountContextIdPresent: Boolean(
      legacy.lastPendingBigAccountSelection &&
      legacy.lastPendingBigAccountSelection.contextId
    ),
    manualBalancePromptPresent: Boolean(legacy.lastManualBalancePrompt),
    balanceSeedConfirmationPresent: Boolean(legacy.lastPendingBalanceSeedConfirmation),
    balanceSeedConfirmationCallbackPresent: typeof (
      legacy.lastPendingBalanceSeedConfirmation &&
      legacy.lastPendingBalanceSeedConfirmation.assertFresh
    ) === 'function',
    balanceSeedConfirmationRecordCount: Array.isArray(
      legacy.lastPendingBalanceSeedConfirmation &&
      legacy.lastPendingBalanceSeedConfirmation.plan &&
      legacy.lastPendingBalanceSeedConfirmation.plan.records
    ) ? legacy.lastPendingBalanceSeedConfirmation.plan.records.length : 0,
    generatedExportKeys: STATEMENT_EXPORT_KEYS.filter((key) => Boolean(
      legacy.lastGeneratedExports && legacy.lastGeneratedExports[key]
    )),
    excludedNonStatementExportKeys: ['newAccount', 'monthlyBalance']
  });
  const balanceSeedOverwriteContinuation = privateContext.kind === 'balance-seed-overwrite'
    ? createStatementBalanceSeedOverwriteContinuationDto({ token: handle })
    : null;
  return Object.freeze({
    legacyInventory,
    serviceState,
    mainTokenHandles: Object.freeze([handle]),
    privateContexts: Object.freeze([privateContext]),
    balanceSeedOverwriteContinuation,
    ownership: Object.freeze({
      persistent: 'sessions/all fileEntries + remembered generation + bounded artifact summary',
      mainTokenHandle: 'exact-eight identity only; tokenId replaces legacy Main contextId',
      pendingInteraction: 'provisional fileEntries or overwrite record + serializable freshness evidence',
      legacyCallback: 'characterized by presence only; assertSessionCurrent/assertFresh are not projected'
    })
  });
}

function expandStatementProbeRows(seed, count, offset = 0) {
  if (!Array.isArray(seed) || !Array.isArray(seed[0]) || !Array.isArray(seed[1])) {
    throw new TypeError('Statement probe seed must contain a header and one production-mapped row');
  }
  const rows = [seed[0].slice()];
  rows.rowMetas = [];
  rows.issues = [];
  rows.headerBreaks = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = offset + index;
    const row = seed[1].slice();
    row[0] = `2026-08-${String(ordinal % 28 + 1).padStart(2, '0')}`;
    row[1] = `M${String(ordinal % 5000).padStart(6, '0')}`;
    row[2] = ordinal % 3 === 0 ? 'USD' : ordinal % 3 === 1 ? 'EUR' : 'HKD';
    row[3] = ordinal % 2 === 0 ? `${ordinal + 100}.01` : '';
    row[4] = ordinal % 2 === 0 ? '' : `${ordinal + 50}.02`;
    rows.push(row);
    rows.rowMetas.push({ sourceRowNumber: index + 2 });
  }
  return rows;
}

function createStatementProbeLegacyGlobals({
  seed,
  rows: totalRows,
  batches,
  root,
  purpose = 'big-account',
  includeBalanceSeedConfirmation = false
}) {
  if (includeBalanceSeedConfirmation && purpose !== 'manual-balance') {
    throw new TypeError('Balance-seed overwrite confirmation requires manual-balance purpose');
  }
  const statementImportSessions = new Map();
  const session = createStatementImportSession({
    templateId: 17,
    templateName: 'E09ProbeBank-上海'
  });
  statementImportSessions.set(session.key, session);
  const lastGeneratedExports = {
    detail: null,
    balance: null,
    allDetail: { filePath: path.join(root, 'all-detail.xlsx'), fileName: 'all-detail.xlsx' },
    allBalance: { filePath: path.join(root, 'all-balance.xlsx'), fileName: 'all-balance.xlsx' },
    statementSessionKey: session.key,
    currentBatchId: '',
    newAccount: { filePath: path.join(root, 'new-account.xlsx') },
    monthlyBalance: { filePath: path.join(root, 'monthly-balance.xlsx') }
  };
  let nextEntry = 0;
  let nextBatch = 0;
  let assigned = 0;
  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    const remaining = totalRows - assigned;
    const count = batchIndex === batches - 1 ? remaining : Math.floor(totalRows / batches);
    const detailRows = expandStatementProbeRows(seed, count, assigned);
    const fileEntry = buildStatementFileEntry({
      buildEntryId: () => `entry-${++nextEntry}`,
      filePath: path.join(root, `source-${batchIndex + 1}.xlsx`),
      detailRows
    });
    appendStatementSessionImport({
      buildBatchId: () => `batch-${++nextBatch}`,
      lastGeneratedExports,
      session,
      fileEntries: [fileEntry]
    });
    assigned += count;
  }
  lastGeneratedExports.detail = {
    filePath: path.join(root, 'current-detail.xlsx'),
    fileName: 'current-detail.xlsx',
    templateName: session.templateName
  };
  lastGeneratedExports.balance = {
    filePath: path.join(root, 'current-balance.xlsx'),
    fileName: 'current-balance.xlsx',
    templateName: session.templateName
  };
  lastGeneratedExports.allDetail = {
    filePath: path.join(root, 'all-detail.xlsx'),
    fileName: 'all-detail.xlsx',
    templateName: session.templateName
  };
  lastGeneratedExports.allBalance = {
    filePath: path.join(root, 'all-balance.xlsx'),
    fileName: 'all-balance.xlsx',
    templateName: session.templateName
  };
  lastGeneratedExports.currentBatchId = session.currentBatchId;

  const currentEntry = session.fileEntries.at(-1);
  const lastFileImportContext = {
    templateId: 17,
    template: { id: 17, name: session.templateName },
    mappings: [
      { templateField: 'MerchantId', mappedField: 'Account' },
      { templateField: 'Currency', mappedField: 'Curr' }
    ],
    orderedTargetFields: seed[0].slice(),
    inputFilePaths: session.fileEntries.map((entry) => entry.filePath),
    selectedBigAccount: { merchantId: 'M000001', currency: 'USD' },
    preparedDetailRows: cloneRowsWithMetadata(currentEntry.detailRows),
    scope: 'current',
    statementSessionKey: session.key,
    currentBatchId: session.currentBatchId
  };

  const pendingRows = expandStatementProbeRows(
    seed,
    Math.max(1, Math.floor(totalRows / batches)),
    totalRows
  );
  const pendingPath = path.join(root, 'pending-source.xlsx');
  const lastPendingBigAccountSelection = purpose === 'big-account'
    ? {
        contextId: 'probe-context-1',
        templateId: 17,
        template: { id: 17, name: session.templateName },
        mappings: lastFileImportContext.mappings.map((mapping) => ({ ...mapping })),
        orderedTargetFields: seed[0].slice(),
        inputFilePaths: [pendingPath],
        bigAccounts: [{ merchantId: 'M000001', currencies: ['USD', 'EUR', 'HKD'], isMultiCurrency: true }],
        fixedAssignments: [{ merchantId: 'M000001', currency: 'USD', rowIndex: 0 }],
        fileEntries: [{
          id: 'pending-entry-1',
          filePath: pendingPath,
          detailRows: pendingRows,
          matchedHeaders: seed[0].slice(),
          selfInputMerchant: false,
          skipDirectMerchantLookup: false,
          matchedTemplateId: 17
        }],
        rows: [{
          index: 0,
          fileBlockOrdinal: 0,
          sourceRowNumber: 2,
          fileName: path.basename(pendingPath),
          filePath: pendingPath
        }],
        rowsWithEmptyBlocks: [{
          index: 0,
          fileBlockOrdinal: 0,
          sourceRowNumber: 2,
          fileName: path.basename(pendingPath),
          filePath: pendingPath
        }],
        statementSelectionSessionId: 'selection-session-1',
        sourceSelections: [{
          resolvedPath: pendingPath,
          sourceSnapshot: { sizeBytes: 4096, mtimeMs: 1787846400000, ctimeMs: 1787846400000, ino: '17' }
        }],
        assertSessionCurrent() {
          throw new Error('characterization callback must never enter the projected graph');
        },
        bigAccountOrderEvidence: {
          sessionId: 'selection-session-1',
          fileCount: 1,
          rows: [{ sourceOrdinal: 1, blockCount: 1 }]
        }
      }
    : null;
  const lastManualBalancePrompt = purpose === 'manual-balance'
    ? {
        templateName: session.templateName,
        bankName: 'E09ProbeBank',
        merchantId: 'M000001',
        currency: 'USD',
        targetBillDate: '2026-08-01',
        queueIndex: 1,
        queueTotal: 1
      }
    : null;
  const existingRecord = {
    merchantId: 'M000001',
    currency: 'USD',
    billDate: '2026-07-31',
    endBalance: 1000,
    templateName: session.templateName,
    generationMethod: '人工录入',
    updatedAt: '2026-08-26T00:00:00.000Z'
  };
  const overwriteRecord = {
    merchantId: 'M000001',
    currency: 'USD',
    billDate: '2026-07-31',
    endBalance: 1200,
    templateName: session.templateName,
    generationMethod: '人工录入'
  };
  const lastPendingBalanceSeedConfirmation = includeBalanceSeedConfirmation
    ? {
        contextId: 'legacy-balance-confirmation-1',
        plan: {
          storageRoot: root,
          bankName: 'E09ProbeBank',
          records: [existingRecord],
          recordsEvidence: JSON.stringify([existingRecord]),
          existingIndex: 0,
          record: overwriteRecord
        },
        pendingPrompt: lastManualBalancePrompt,
        importContext: lastFileImportContext,
        session,
        inputFilePaths: session.fileEntries.map((entry) => entry.filePath),
        assertFresh() {
          throw new Error('legacy freshness callback must never enter the projected graph');
        }
      }
    : null;
  return {
    statementImportSessions,
    lastFileImportContext,
    lastPendingBigAccountSelection,
    lastManualBalancePrompt,
    lastPendingBalanceSeedConfirmation,
    lastGeneratedExports
  };
}

module.exports = {
  LEGACY_GLOBAL_KEYS,
  buildStatementProbeProjection,
  createStatementProbeLegacyGlobals,
  expandStatementProbeRows
};
