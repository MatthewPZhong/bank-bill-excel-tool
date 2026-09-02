'use strict';

const {
  financeSafeTextViolation
} = require('../background-execution/error-codec');

const RECON_FIX_IMPORT_ACTION = 'recon-fix:import';
const RECON_FIX_EXPORT_ACTION = 'recon-fix:export';
const RECON_FIX_RUN_JPM_ACTION = 'recon-fix:run-jpm';
const RECON_FIX_RUN_READONLY_ACTION = 'recon-fix:run-readonly';
const RECON_FIX_SERVICE_KEY = 'service.recon-fix';
const RECON_FIX_JPM_UNIT_ID = 'operation:000001';
const RECON_FIX_ENTRY_KEYS = Object.freeze({
  [RECON_FIX_EXPORT_ACTION]: 'executor.recon-fix:export',
  [RECON_FIX_IMPORT_ACTION]: 'executor.recon-fix:import',
  [RECON_FIX_RUN_JPM_ACTION]: 'executor.recon-fix:run-jpm',
  [RECON_FIX_RUN_READONLY_ACTION]: 'executor.recon-fix:run-readonly'
});
const RECON_FIX_RESULT_VALIDATOR_KEYS = Object.freeze({
  [RECON_FIX_EXPORT_ACTION]: 'result-validator.recon-fix:export',
  [RECON_FIX_IMPORT_ACTION]: 'result-validator.recon-fix:import',
  [RECON_FIX_RUN_JPM_ACTION]: 'result-validator.recon-fix:run-jpm',
  [RECON_FIX_RUN_READONLY_ACTION]: 'result-validator.recon-fix:run-readonly'
});

const BASE_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 67108864
});
const PHASE_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 201326592
});
const PERSISTENT_STATE_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 268435456
});
const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const SERVICE_POLICY = Object.freeze({
  generationRequired: true,
  busyPolicy: 'reject',
  closePolicy: 'cooperative',
  statusMaxBytes: 1048576,
  stateFootprintEstimatorKey: 'footprint.recon-fix',
  tokenPolicy: Object.freeze({
    enabled: false,
    maxOutstanding: 0,
    ttlMs: 0,
    singleUse: true
  }),
  startupRecoveryKey: 'startup-recovery.recon-fix',
  serviceKey: RECON_FIX_SERVICE_KEY,
  controlProtocol: 'service-control-v1',
  resourceControl: Object.freeze({
    protocol: 'service-control-v1',
    allowedRequestKinds: Object.freeze(['persistent-state-replace', 'phase-extension']),
    maxPendingRequests: 8,
    grantTimeoutMs: 30000,
    adoptionTimeoutMs: 30000,
    grantIdentityRequired: true,
    releaseAckRequired: true
  }),
  stateAdoption: Object.freeze({
    grantIdentityRequired: true,
    atomicReplaceRequired: true,
    adoptAckRequired: true
  })
});

function reconFixReadonlyPolicy(actionKey) {
  if (![RECON_FIX_IMPORT_ACTION, RECON_FIX_RUN_READONLY_ACTION].includes(actionKey)) {
    throw new TypeError(`E11-A 不支持 action：${String(actionKey)}`);
  }
  return Object.freeze({
    actionKey,
    moduleId: 'recon-fix',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: RECON_FIX_ENTRY_KEYS[actionKey],
    lifetime: 'service',
    context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
    resources: Object.freeze({
      profile: `resource.${actionKey}`,
      base: BASE_RESOURCES,
      phase: PHASE_RESOURCES,
      compound: null,
      lowMemoryBehavior: 'queue',
      admissionPriority: 'normal',
      persistentState: PERSISTENT_STATE_RESOURCES,
      pendingInteraction: ZERO_RESOURCES
    }),
    cancellation: Object.freeze({
      capability: 'shutdown-only',
      safePoints: Object.freeze(['before-critical', 'between-units']),
      cooperativeTimeoutMs: 5000,
      terminateTimeoutMs: 5000,
      protectedResult: 'protected/not-cancellable'
    }),
    failure: Object.freeze({
      unitBusinessError: 'fail-job',
      unitTransportCrash: 'fail-job',
      workerExit: 'fail-job',
      automaticRetry: false
    }),
    commit: Object.freeze({
      kind: 'none',
      criticalIntent: false,
      receiptKind: null,
      inspectorKey: null,
      conflictScopeResolverKey: null,
      settlementKey: null
    }),
    result: Object.freeze({
      kind: 'compact-json',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: RECON_FIX_RESULT_VALIDATOR_KEYS[actionKey]
    }),
    artifacts: Object.freeze({
      kind: 'none',
      filePlanRequired: false,
      technicalValidatorKey: null,
      businessValidatorKey: null,
      publisherKey: null,
      maxArtifacts: 0
    }),
    service: SERVICE_POLICY,
    metrics: Object.freeze({
      phases: Object.freeze(['queue', 'execute', 'settle']),
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    }),
    featureFlag: `feature.${actionKey}`,
    legacyStrategyKey: `legacy.${actionKey}`,
    blocker: null,
    production: Object.freeze({
      enabled: false,
      effectiveMode: 'legacy',
      effectiveWorkerCount: 0,
      recoveryStatus: 'not-applicable',
      evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    }),
    protocolLimits: Object.freeze({
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    })
  });
}

function reconFixJpmPolicy() {
  const readonly = reconFixReadonlyPolicy(RECON_FIX_RUN_READONLY_ACTION);
  return Object.freeze({
    ...readonly,
    actionKey: RECON_FIX_RUN_JPM_ACTION,
    description: `v3.2.x canonical policy fixture for ${RECON_FIX_RUN_JPM_ACTION}`,
    entryKey: RECON_FIX_ENTRY_KEYS[RECON_FIX_RUN_JPM_ACTION],
    resources: Object.freeze({
      ...readonly.resources,
      profile: `resource.${RECON_FIX_RUN_JPM_ACTION}`
    }),
    failure: Object.freeze({
      ...readonly.failure,
      workerExit: 'module-inspect'
    }),
    commit: Object.freeze({
      kind: 'worker-durable',
      criticalIntent: true,
      receiptKind: 'module-local',
      inspectorKey: 'inspector.recon-fix:run-jpm',
      conflictScopeResolverKey: 'scope.recon-fix:run-jpm',
      settlementKey: null
    }),
    result: Object.freeze({
      ...readonly.result,
      validatorKey: RECON_FIX_RESULT_VALIDATOR_KEYS[RECON_FIX_RUN_JPM_ACTION]
    }),
    featureFlag: `feature.${RECON_FIX_RUN_JPM_ACTION}`,
    legacyStrategyKey: `legacy.${RECON_FIX_RUN_JPM_ACTION}`,
    production: Object.freeze({
      ...readonly.production,
      recoveryStatus: 'probe'
    })
  });
}

function reconFixExportPolicy() {
  const readonly = reconFixReadonlyPolicy(RECON_FIX_RUN_READONLY_ACTION);
  return Object.freeze({
    ...readonly,
    actionKey: RECON_FIX_EXPORT_ACTION,
    description: `v3.2.x canonical policy fixture for ${RECON_FIX_EXPORT_ACTION}`,
    entryKey: RECON_FIX_ENTRY_KEYS[RECON_FIX_EXPORT_ACTION],
    resources: Object.freeze({
      ...readonly.resources,
      profile: `resource.${RECON_FIX_EXPORT_ACTION}`
    }),
    failure: Object.freeze({
      ...readonly.failure,
      workerExit: 'module-inspect'
    }),
    commit: Object.freeze({
      kind: 'main-settlement',
      criticalIntent: false,
      receiptKind: 'publisher-journal',
      inspectorKey: 'inspector.recon-fix:export',
      conflictScopeResolverKey: 'scope.recon-fix:export',
      settlementKey: 'settlement.recon-fix:export'
    }),
    result: Object.freeze({
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: RECON_FIX_RESULT_VALIDATOR_KEYS[RECON_FIX_EXPORT_ACTION]
    }),
    artifacts: Object.freeze({
      kind: 'all-or-none',
      filePlanRequired: true,
      technicalValidatorKey: 'technical-validator.recon-fix:export',
      businessValidatorKey: 'business-validator.recon-fix:export',
      publisherKey: 'publisher.recon-fix:export',
      maxArtifacts: 64
    }),
    featureFlag: `feature.${RECON_FIX_EXPORT_ACTION}`,
    legacyStrategyKey: `legacy.${RECON_FIX_EXPORT_ACTION}`,
    production: Object.freeze({
      ...readonly.production,
      recoveryStatus: 'probe'
    })
  });
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function allowReconFixFinanceSafeValue({ value, key }) {
  return [
    'stateDigest',
    'resultHandle',
    'scenarioSnapshotHash',
    'linkedEvidenceHash',
    'inputEvidenceHash',
    'headersDigest',
    'recordsDigest',
    'resultDigest',
    'authorityDigest',
    'exportAuthorityDigest',
    'preImageHash',
    'postImageHash',
    'idSequenceDigest',
    'databaseIdentity',
    'workerInstanceIdentity',
    'receiptDigest'
  ].includes(key) && safeHash(value);
}

function validateReconFixExportAuthority(value) {
  if (!exactKeys(value, [
    'artifacts', 'authorityDigest', 'contractVersion', 'fixedRowCount',
    'inputEvidenceHash', 'linkedEvidenceHash', 'resultDigest', 'resultHandle',
    'runKind', 'scenarioSnapshotHash', 'subMode', 'unmatchedRowCount', 'warningCount'
  ]) || value.contractVersion !== 1 || !safeHash(value.authorityDigest) ||
      !safeHash(value.resultHandle) || !safeHash(value.inputEvidenceHash) ||
      !safeHash(value.scenarioSnapshotHash) || !safeHash(value.resultDigest) ||
      !(value.linkedEvidenceHash === null || safeHash(value.linkedEvidenceHash)) ||
      !['standard', 'boc', 'jpm'].includes(value.runKind) ||
      !['business', 'gateway'].includes(value.subMode) ||
      (value.runKind === 'jpm' && value.subMode !== 'gateway') ||
      (['boc', 'jpm'].includes(value.runKind) && !safeHash(value.linkedEvidenceHash)) ||
      !safeCount(value.fixedRowCount) || !safeCount(value.unmatchedRowCount) ||
      !safeCount(value.warningCount) ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length > 2) return false;
  const expectedKinds = [];
  if (value.fixedRowCount > 0) expectedKinds.push('main');
  if (value.unmatchedRowCount > 0) expectedKinds.push('unmatched');
  if (value.artifacts.length !== expectedKinds.length) return false;
  return value.artifacts.every((artifact, index) => (
    exactKeys(artifact, [
      'artifactKind', 'headersDigest', 'recordsDigest', 'rowCount', 'sheetName'
    ]) && artifact.artifactKind === expectedKinds[index] &&
    safeCount(artifact.rowCount) &&
    artifact.rowCount === (artifact.artifactKind === 'main'
      ? value.fixedRowCount
      : value.unmatchedRowCount) &&
    safeHash(artifact.headersDigest) && safeHash(artifact.recordsDigest) &&
    typeof artifact.sheetName === 'string' && artifact.sheetName.length > 0 &&
    Buffer.byteLength(artifact.sheetName, 'utf8') <= 256
  ));
}

function validateReconFixServiceResult(value) {
  if (!exactKeys(value, value && value.kind === 'imported'
    ? ['kind', 'revision', 'serviceGeneration', 'stateDigest', 'summary']
    : ['exportAuthority', 'kind', 'linkedEvidenceHash', 'resultHandle', 'revision',
        'scenarioSnapshotHash', 'serviceGeneration', 'stateDigest', 'summary'])) return false;
  if (!safeCount(value.revision) || value.revision < 1 ||
      !safeCount(value.serviceGeneration) || value.serviceGeneration < 1 ||
      !safeHash(value.stateDigest)) return false;
  if (value.kind === 'imported') {
    const summary = value.summary;
    return exactKeys(summary, ['fileName', 'hasResult', 'sheetCounts', 'subMode']) &&
      typeof summary.fileName === 'string' && summary.fileName.length <= 1024 &&
      financeSafeTextViolation(summary.fileName) === null &&
      summary.hasResult === false && ['business', 'gateway'].includes(summary.subMode) &&
      exactKeys(summary.sheetCounts, ['business', 'opponent', 'recon']) &&
      Object.values(summary.sheetCounts).every(safeCount);
  }
  if (value.kind !== 'readonly-result' || !safeHash(value.resultHandle) ||
      !safeHash(value.scenarioSnapshotHash) ||
      !(value.linkedEvidenceHash === null || safeHash(value.linkedEvidenceHash)) ||
      !validateReconFixExportAuthority(value.exportAuthority) ||
      value.exportAuthority.resultHandle !== value.resultHandle ||
      value.exportAuthority.scenarioSnapshotHash !== value.scenarioSnapshotHash ||
      value.exportAuthority.linkedEvidenceHash !== value.linkedEvidenceHash) return false;
  const summary = value.summary;
  return exactKeys(summary, ['fixedRowCount', 'resultDigest', 'runKind', 'unmatchedRowCount', 'warningCount']) &&
    ['standard', 'boc'].includes(summary.runKind) && safeHash(summary.resultDigest) &&
    safeCount(summary.fixedRowCount) && safeCount(summary.unmatchedRowCount) &&
    safeCount(summary.warningCount) && value.exportAuthority.runKind === summary.runKind &&
    value.exportAuthority.fixedRowCount === summary.fixedRowCount &&
    value.exportAuthority.unmatchedRowCount === summary.unmatchedRowCount &&
    value.exportAuthority.warningCount === summary.warningCount &&
    value.exportAuthority.resultDigest === summary.resultDigest;
}

function validateReconFixJpmResult(value) {
  if (!exactKeys(value, [
    'boundedSummary', 'exportAuthority', 'resultHandle', 'resultKind', 'revision',
    'serviceGeneration'
  ]) || !['noop', 'committed'].includes(value.resultKind) || !safeHash(value.resultHandle) ||
      !safeCount(value.revision) || value.revision < 1 ||
      !safeCount(value.serviceGeneration) || value.serviceGeneration < 1 ||
      !validateReconFixExportAuthority(value.exportAuthority) ||
      value.exportAuthority.runKind !== 'jpm' ||
      value.exportAuthority.resultHandle !== value.resultHandle) {
    return false;
  }
  const summary = value.boundedSummary;
  return exactKeys(summary, [
    'fixedRowCount', 'resultDigest', 'runKind', 'unmatchedRowCount', 'warningCount'
  ]) && summary.runKind === 'jpm' && safeHash(summary.resultDigest) &&
    safeCount(summary.fixedRowCount) && safeCount(summary.unmatchedRowCount) &&
    safeCount(summary.warningCount) &&
    value.exportAuthority.fixedRowCount === summary.fixedRowCount &&
    value.exportAuthority.unmatchedRowCount === summary.unmatchedRowCount &&
    value.exportAuthority.warningCount === summary.warningCount &&
    value.exportAuthority.resultDigest === summary.resultDigest;
}

function validateReconFixExportResult(value) {
  try {
    if (!exactKeys(value, [
      'artifacts', 'contractVersion', 'exportAuthorityDigest', 'inputEvidenceHash', 'linkedEvidenceHash',
      'resultHandle', 'revision', 'runKind', 'scenarioSnapshotHash',
      'serviceGeneration', 'subMode', 'summary'
    ]) || value.contractVersion !== 1 || !safeCount(value.revision) || value.revision < 1 ||
        !safeCount(value.serviceGeneration) || value.serviceGeneration < 1 ||
        !safeHash(value.resultHandle) || !safeHash(value.exportAuthorityDigest) ||
        !safeHash(value.inputEvidenceHash) ||
        !safeHash(value.scenarioSnapshotHash) ||
        !(value.linkedEvidenceHash === null || safeHash(value.linkedEvidenceHash)) ||
        !['standard', 'boc', 'jpm'].includes(value.runKind) ||
        !['business', 'gateway'].includes(value.subMode) ||
        !Array.isArray(value.artifacts) || value.artifacts.length < 1 ||
        value.artifacts.length > 2) return false;
    const seenKeys = new Set();
    for (let index = 0; index < value.artifacts.length; index += 1) {
      const artifact = value.artifacts[index];
      if (!exactKeys(artifact, [
        'artifactKind', 'byteSize', 'headersDigest', 'lineage', 'outputArtifactKey',
        'outputIndex', 'recordsDigest', 'rowCount', 'sha256', 'sheetName', 'style'
      ]) || artifact.outputIndex !== index ||
          !['main', 'unmatched'].includes(artifact.artifactKind) ||
          typeof artifact.outputArtifactKey !== 'string' ||
          !/^output-[a-f0-9]{64}$/.test(artifact.outputArtifactKey) ||
          seenKeys.has(artifact.outputArtifactKey) ||
          !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0 ||
          !safeHash(artifact.sha256) || !safeCount(artifact.rowCount) ||
          !safeHash(artifact.headersDigest) || !safeHash(artifact.recordsDigest) ||
          typeof artifact.sheetName !== 'string' || !artifact.sheetName ||
          Buffer.byteLength(artifact.sheetName, 'utf8') > 256 ||
          !exactKeys(artifact.style, ['headerFontSize', 'lastAuthor']) ||
          artifact.style.headerFontSize !== 10 || artifact.style.lastAuthor !== 'pzhong' ||
          !exactKeys(artifact.lineage, [
            'exportAuthorityDigest', 'inputEvidenceHash', 'linkedEvidenceHash',
            'resultDigest', 'scenarioSnapshotHash'
          ]) || !safeHash(artifact.lineage.inputEvidenceHash) ||
          !safeHash(artifact.lineage.exportAuthorityDigest) ||
          !safeHash(artifact.lineage.resultDigest) ||
          !safeHash(artifact.lineage.scenarioSnapshotHash) ||
          !(artifact.lineage.linkedEvidenceHash === null ||
            safeHash(artifact.lineage.linkedEvidenceHash))) return false;
      seenKeys.add(artifact.outputArtifactKey);
    }
    if (value.artifacts.length === 2 &&
        (value.artifacts[0].artifactKind !== 'main' ||
          value.artifacts[1].artifactKind !== 'unmatched')) return false;
    if (['boc', 'jpm'].includes(value.runKind) && !safeHash(value.linkedEvidenceHash)) return false;
    const summary = value.summary;
    return exactKeys(summary, [
      'artifactCount', 'fixedRowCount', 'resultDigest', 'unmatchedRowCount', 'warningCount'
    ]) && summary.artifactCount === value.artifacts.length &&
      safeCount(summary.fixedRowCount) && safeCount(summary.unmatchedRowCount) &&
      safeCount(summary.warningCount) && safeHash(summary.resultDigest) &&
      summary.fixedRowCount + summary.unmatchedRowCount > 0;
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validateReconFixServiceResult, 'allowFinanceSafeValue', {
  value: allowReconFixFinanceSafeValue
});
Object.defineProperty(validateReconFixJpmResult, 'allowFinanceSafeValue', {
  value: allowReconFixFinanceSafeValue
});
Object.defineProperty(validateReconFixExportResult, 'allowFinanceSafeValue', {
  value: allowReconFixFinanceSafeValue
});

const RECON_FIX_READONLY_POLICIES = Object.freeze([
  reconFixReadonlyPolicy(RECON_FIX_IMPORT_ACTION),
  reconFixReadonlyPolicy(RECON_FIX_RUN_READONLY_ACTION)
]);
const RECON_FIX_JPM_POLICY = reconFixJpmPolicy();
const RECON_FIX_EXPORT_POLICY = reconFixExportPolicy();
const RECON_FIX_POLICIES = Object.freeze([
  ...RECON_FIX_READONLY_POLICIES,
  RECON_FIX_JPM_POLICY,
  RECON_FIX_EXPORT_POLICY
]);

module.exports = {
  RECON_FIX_ENTRY_KEYS,
  RECON_FIX_EXPORT_ACTION,
  RECON_FIX_EXPORT_POLICY,
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_JPM_POLICY,
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_POLICIES,
  RECON_FIX_READONLY_POLICIES,
  RECON_FIX_RESULT_VALIDATOR_KEYS,
  RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_SERVICE_KEY,
  reconFixJpmPolicy,
  reconFixExportPolicy,
  reconFixReadonlyPolicy,
  validateReconFixExportAuthority,
  validateReconFixJpmResult,
  validateReconFixExportResult,
  validateReconFixServiceResult
};
