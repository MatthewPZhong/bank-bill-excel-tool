'use strict';

const FUND_RECON_ACTIONS = Object.freeze({
  IMPORT: 'fund-recon:import',
  RUN: 'fund-recon:run',
  EXPORT: 'fund-recon:export'
});

const FUND_RECON_SERVICE_KEY = 'service.fund-recon';
const FUND_RECON_STATE_OWNER_KEY = 'fund-recon-state';
const FUND_RECON_STATE_BUDGET_BYTES = 268435456;

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
  memoryBytes: FUND_RECON_STATE_BUDGET_BYTES
});

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const SERVICE_CONTRACT = Object.freeze({
  generationRequired: true,
  busyPolicy: 'reject',
  closePolicy: 'cooperative',
  statusMaxBytes: 1048576,
  stateFootprintEstimatorKey: 'footprint.fund-recon',
  tokenPolicy: Object.freeze({
    enabled: false,
    maxOutstanding: 0,
    ttlMs: 0,
    singleUse: true
  }),
  startupRecoveryKey: 'startup-recovery.fund-recon',
  serviceKey: FUND_RECON_SERVICE_KEY,
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

function fundReconPolicy(actionKey) {
  if (!Object.values(FUND_RECON_ACTIONS).includes(actionKey)) {
    throw new TypeError(`Unknown FundRecon action: ${String(actionKey)}`);
  }
  const exporting = actionKey === FUND_RECON_ACTIONS.EXPORT;
  return Object.freeze({
    actionKey,
    moduleId: 'fund-recon',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.${actionKey}`,
    lifetime: 'service',
    context: { kind: 'operation', validatorKey: 'exact-5' },
    resources: {
      profile: `resource.${actionKey}`,
      base: BASE_RESOURCES,
      phase: PHASE_RESOURCES,
      compound: null,
      lowMemoryBehavior: 'queue',
      admissionPriority: 'normal',
      persistentState: PERSISTENT_STATE_RESOURCES,
      pendingInteraction: ZERO_RESOURCES
    },
    cancellation: {
      capability: 'shutdown-only',
      safePoints: ['before-critical', 'between-units'],
      cooperativeTimeoutMs: 5000,
      terminateTimeoutMs: 5000,
      protectedResult: 'protected/not-cancellable'
    },
    failure: {
      unitBusinessError: 'fail-job',
      unitTransportCrash: 'fail-job',
      workerExit: exporting ? 'module-inspect' : 'fail-job',
      automaticRetry: false
    },
    commit: exporting ? {
      kind: 'main-settlement',
      criticalIntent: false,
      receiptKind: 'publisher-journal',
      inspectorKey: 'inspector.fund-recon:export',
      conflictScopeResolverKey: 'scope.fund-recon:export',
      settlementKey: 'settlement.fund-recon:export'
    } : {
      kind: 'none',
      criticalIntent: false,
      receiptKind: null,
      inspectorKey: null,
      conflictScopeResolverKey: null,
      settlementKey: null
    },
    result: {
      kind: exporting ? 'artifact-manifest' : 'compact-json',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.${actionKey}`
    },
    artifacts: exporting ? {
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: 'technical-validator.fund-recon:export',
      businessValidatorKey: 'business-validator.fund-recon:export',
      publisherKey: 'publisher.fund-recon:export',
      maxArtifacts: 1
    } : {
      kind: 'none',
      filePlanRequired: false,
      technicalValidatorKey: null,
      businessValidatorKey: null,
      publisherKey: null,
      maxArtifacts: 0
    },
    service: SERVICE_CONTRACT,
    metrics: {
      phases: ['queue', 'execute', 'settle'],
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    },
    featureFlag: `feature.${actionKey}`,
    legacyStrategyKey: `legacy.${actionKey}`,
    blocker: null,
    production: {
      enabled: false,
      effectiveMode: 'legacy',
      effectiveWorkerCount: 0,
      recoveryStatus: exporting ? 'probe' : 'not-applicable',
      evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    },
    protocolLimits: {
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    }
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateStableSummary(summary) {
  if (!isPlainObject(summary)) return false;
  const keys = Object.keys(summary).sort().join(',');
  if (keys !== 'bankRowCount,hasGateway,hasProcessingResult,hasRefund,sourceFileCount') return false;
  return isNonNegativeInteger(summary.bankRowCount) && isNonNegativeInteger(summary.sourceFileCount) &&
    typeof summary.hasGateway === 'boolean' && typeof summary.hasRefund === 'boolean' &&
    typeof summary.hasProcessingResult === 'boolean';
}

function validateFundReconCompactResult(value, operation) {
  if (!isPlainObject(value) || value.status !== 'ok' || value.operation !== operation ||
      !isNonNegativeInteger(value.stateRevision) || !validateStableSummary(value.summary)) return false;
  const expected = operation === 'run'
    ? 'evidenceSignature,operation,stateRevision,stats,status,summary'
    : 'operation,stateRevision,status,summary';
  if (Object.keys(value).sort().join(',') !== expected) return false;
  if (operation === 'run') {
    return typeof value.evidenceSignature === 'string' && /^[a-f0-9]{64}$/.test(value.evidenceSignature) &&
      isPlainObject(value.stats);
  }
  return true;
}

function validateFundReconImportResult(value) {
  return validateFundReconCompactResult(value, 'import');
}

function validateFundReconRunResult(value) {
  return validateFundReconCompactResult(value, 'run');
}

function validateArtifactEntry(value) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') === 'artifactKey,byteSize,sha256,stagingPath' &&
    typeof value.artifactKey === 'string' && value.artifactKey.length > 0 && value.artifactKey.length <= 160 &&
    typeof value.stagingPath === 'string' && value.stagingPath.length > 0 &&
    isNonNegativeInteger(value.byteSize) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}

function validateFundReconExportResult(value) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') ===
      'artifacts,evidenceSignature,operation,stateRevision,status,summary' &&
    value.status === 'ok' && value.operation === 'export' &&
    isNonNegativeInteger(value.stateRevision) && validateStableSummary(value.summary) &&
    typeof value.evidenceSignature === 'string' && /^[a-f0-9]{64}$/.test(value.evidenceSignature) &&
    Array.isArray(value.artifacts) && value.artifacts.length === 1 &&
    value.artifacts.every(validateArtifactEntry);
}

const FUND_RECON_POLICIES = Object.freeze([
  fundReconPolicy(FUND_RECON_ACTIONS.IMPORT),
  fundReconPolicy(FUND_RECON_ACTIONS.RUN),
  fundReconPolicy(FUND_RECON_ACTIONS.EXPORT)
]);

module.exports = {
  FUND_RECON_ACTIONS,
  FUND_RECON_POLICIES,
  FUND_RECON_SERVICE_KEY,
  FUND_RECON_STATE_BUDGET_BYTES,
  FUND_RECON_STATE_OWNER_KEY,
  fundReconPolicy,
  validateFundReconExportResult,
  validateFundReconImportResult,
  validateFundReconRunResult,
  validateStableSummary
};
