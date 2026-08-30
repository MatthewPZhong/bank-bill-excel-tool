'use strict';

const DUPLICATE_ACTIONS = Object.freeze({
  IMPORT: 'duplicate:import',
  RUN: 'duplicate:run',
  EXPORT: 'duplicate:export'
});

const DUPLICATE_SERVICE_KEY = 'service.duplicate';
const DUPLICATE_STATE_OWNER_KEY = 'duplicate-state';
const DUPLICATE_STATE_BUDGET_BYTES = 268435456;

const ZERO = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});
const BASE_SINGLE = Object.freeze({ ...ZERO, workerThreadSlots: 1, memoryBytes: 67108864 });
const BASE_IMPORT = Object.freeze({ ...ZERO, workerThreadSlots: 1, memoryBytes: 33554432 });
const PHASE_SINGLE = Object.freeze({ ...ZERO, cpuSlots: 1, ioHeavySlots: 1, memoryBytes: 201326592 });
const PHASE_IMPORT = Object.freeze({
  ...ZERO,
  cpuSlots: 1,
  workerThreadSlots: 1,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});
const PERSISTENT = Object.freeze({ ...ZERO, memoryBytes: DUPLICATE_STATE_BUDGET_BYTES });

const SERVICE = Object.freeze({
  generationRequired: true,
  busyPolicy: 'reject',
  closePolicy: 'cooperative',
  statusMaxBytes: 1048576,
  stateFootprintEstimatorKey: 'footprint.duplicate',
  tokenPolicy: Object.freeze({ enabled: false, maxOutstanding: 0, ttlMs: 0, singleUse: true }),
  startupRecoveryKey: 'startup-recovery.duplicate',
  serviceKey: DUPLICATE_SERVICE_KEY,
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

function duplicatePolicy(actionKey) {
  if (!Object.values(DUPLICATE_ACTIONS).includes(actionKey)) {
    throw new TypeError(`Unknown Duplicate action: ${String(actionKey)}`);
  }
  const importing = actionKey === DUPLICATE_ACTIONS.IMPORT;
  const exporting = actionKey === DUPLICATE_ACTIONS.EXPORT;
  return Object.freeze({
    actionKey,
    moduleId: 'duplicate',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: importing ? 'thread-pool' : 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.${actionKey}`,
    lifetime: 'service',
    context: { kind: 'operation', validatorKey: 'exact-5' },
    resources: {
      profile: `resource.${actionKey}`,
      base: importing ? BASE_IMPORT : BASE_SINGLE,
      phase: importing ? PHASE_IMPORT : PHASE_SINGLE,
      compound: importing ? {
        topologyKey: 'topology.duplicate:import',
        childrenMax: 4,
        childResource: PHASE_IMPORT
      } : null,
      lowMemoryBehavior: importing ? 'downgrade-to-single' : 'queue',
      admissionPriority: 'normal',
      persistentState: PERSISTENT,
      pendingInteraction: ZERO
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
      workerExit: 'module-inspect',
      automaticRetry: false
    },
    commit: exporting ? {
      kind: 'main-settlement',
      criticalIntent: false,
      receiptKind: 'publisher-journal',
      inspectorKey: 'inspector.duplicate:export',
      conflictScopeResolverKey: 'scope.duplicate:export',
      settlementKey: 'settlement.duplicate:export'
    } : {
      kind: 'worker-durable',
      criticalIntent: true,
      receiptKind: 'module-local',
      inspectorKey: `inspector.${actionKey}`,
      conflictScopeResolverKey: `scope.${actionKey}`,
      settlementKey: null
    },
    result: {
      kind: importing ? 'spool-manifest' : (exporting ? 'artifact-manifest' : 'compact-json'),
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.${actionKey}`
    },
    artifacts: exporting ? {
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: 'technical-validator.duplicate:export',
      businessValidatorKey: 'business-validator.duplicate:export',
      publisherKey: 'publisher.duplicate:export',
      maxArtifacts: 1
    } : {
      kind: 'none',
      filePlanRequired: false,
      technicalValidatorKey: null,
      businessValidatorKey: null,
      publisherKey: null,
      maxArtifacts: 0
    },
    service: SERVICE,
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
      recoveryStatus: 'probe',
      evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    },
    ...(importing ? {
      workUnits: {
        kind: 'role',
        ordering: 'input-index-reducer',
        requestedMaxWorkers: 4,
        minUnitsPerWorker: 2,
        plannerKey: 'planner.duplicate:import',
        reducerKey: 'reducer.duplicate:import'
      }
    } : {}),
    protocolLimits: { commandMaxBytes: 262144, eventMaxBytes: 262144 }
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function validSummary(value) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') === 'bankRowCount,canExport,canRun,documentRowCount' &&
    Number.isSafeInteger(value.bankRowCount) && value.bankRowCount >= 0 &&
    Number.isSafeInteger(value.documentRowCount) && value.documentRowCount >= 0 &&
    typeof value.canRun === 'boolean' && typeof value.canExport === 'boolean';
}

function validCompact(value, operation, extraKeys = []) {
  return isPlainObject(value) && value.status === 'ok' && value.operation === operation &&
    Object.keys(value).sort().join(',') === [
      'operation', 'stateRevision', 'status', 'summary', ...extraKeys
    ].sort().join(',') &&
    Number.isSafeInteger(value.stateRevision) && value.stateRevision >= 0 && validSummary(value.summary);
}

function validateDuplicateImportResult(value) {
  return validCompact(value, 'import');
}

function validateDuplicateRunResult(value) {
  return validCompact(value, 'run', ['runId']) && Number.isSafeInteger(value.runId) && value.runId > 0;
}

function validateDuplicateExportResult(value) {
  return validCompact(value, 'export', ['artifacts']) &&
    Array.isArray(value.artifacts) && value.artifacts.length === 1 &&
    value.artifacts.every((artifact) => isPlainObject(artifact) &&
      Object.keys(artifact).sort().join(',') === 'artifactKey,byteSize,sha256,stagingPath' &&
      typeof artifact.artifactKey === 'string' && artifact.artifactKey.length > 0 &&
      typeof artifact.stagingPath === 'string' && artifact.stagingPath.length > 0 &&
      Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0 &&
      typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256));
}

const DUPLICATE_POLICIES = Object.freeze(Object.values(DUPLICATE_ACTIONS).map(duplicatePolicy));

module.exports = {
  DUPLICATE_ACTIONS,
  DUPLICATE_POLICIES,
  DUPLICATE_SERVICE_KEY,
  DUPLICATE_STATE_BUDGET_BYTES,
  DUPLICATE_STATE_OWNER_KEY,
  duplicatePolicy,
  validateDuplicateExportResult,
  validateDuplicateImportResult,
  validateDuplicateRunResult
};
