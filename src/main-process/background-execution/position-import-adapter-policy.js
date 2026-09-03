'use strict';

const {
  POSITION_IMPORT_COMMANDS
} = require('../../backend/position-reconciliation-import/constants');

const POSITION_IMPORT_ADAPTER_ACTION = 'position:import';

const POSITION_IMPORT_ADAPTER_COMMANDS = Object.freeze([
  POSITION_IMPORT_COMMANDS.BANK_PREPARE,
  POSITION_IMPORT_COMMANDS.BANK_APPLY,
  POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
  POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY
]);

const POSITION_IMPORT_ADAPTER_COMMAND_SET = Object.freeze(
  new Set(POSITION_IMPORT_ADAPTER_COMMANDS)
);

const POSITION_IMPORT_ADAPTER_OUTCOMES = Object.freeze([
  'preflight-complete',
  'preflight-recovered',
  'committed',
  'recovered'
]);

const POSITION_IMPORT_ADAPTER_OUTCOME_SET = Object.freeze(
  new Set(POSITION_IMPORT_ADAPTER_OUTCOMES)
);

const POSITION_IMPORT_ADAPTER_POLICY = Object.freeze({
  actionKey: POSITION_IMPORT_ADAPTER_ACTION,
  moduleId: 'position',
  description: 'v3.2.5 E13-F Position existing utility-process dispatcher capability',
  disposition: 'managed',
  mode: 'utility-process',
  adapterKind: 'existing-dispatch',
  adapterKey: `adapter.${POSITION_IMPORT_ADAPTER_ACTION}`,
  entryKey: null,
  lifetime: 'job',
  context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
  resources: Object.freeze({
    profile: `resource.${POSITION_IMPORT_ADAPTER_ACTION}`,
    base: Object.freeze({
      cpuSlots: 0,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 0
    }),
    phase: Object.freeze({
      cpuSlots: 1,
      workerThreadSlots: 0,
      utilityProcessSlots: 1,
      ioHeavySlots: 1,
      memoryBytes: 536870912
    }),
    // SOURCE_PREPARE_AND_APPLY 的 root utility process 等待 durable grant 时，
    // 既有 Main authorizer 最多并发一个 schema-migration utility process。
    // 其余路径不创建 child；旧 fixture 的 childrenMax=4 不符合 current dispatcher。
    compound: Object.freeze({
      topologyKey: `topology.${POSITION_IMPORT_ADAPTER_ACTION}`,
      childrenMax: 1,
      childResource: Object.freeze({
        cpuSlots: 1,
        workerThreadSlots: 0,
        utilityProcessSlots: 1,
        ioHeavySlots: 1,
        memoryBytes: 268435456
      })
    }),
    lowMemoryBehavior: 'reject',
    admissionPriority: 'normal'
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
    workerExit: 'module-inspect',
    automaticRetry: false
  }),
  commit: Object.freeze({
    kind: 'existing-critical-protocol',
    criticalIntent: false,
    receiptKind: 'existing-protocol',
    inspectorKey: `inspector.${POSITION_IMPORT_ADAPTER_ACTION}`,
    conflictScopeResolverKey: `scope.${POSITION_IMPORT_ADAPTER_ACTION}`,
    settlementKey: `settlement.${POSITION_IMPORT_ADAPTER_ACTION}`
  }),
  result: Object.freeze({
    kind: 'compact-json',
    maxBytes: 8388608,
    maxErrorItems: 100,
    validatorKey: `result-validator.${POSITION_IMPORT_ADAPTER_ACTION}`
  }),
  artifacts: Object.freeze({
    kind: 'none',
    filePlanRequired: false,
    technicalValidatorKey: null,
    businessValidatorKey: null,
    publisherKey: null,
    maxArtifacts: 0
  }),
  service: null,
  metrics: Object.freeze({
    phases: Object.freeze(['queue', 'execute', 'settle']),
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  }),
  featureFlag: `feature.${POSITION_IMPORT_ADAPTER_ACTION}`,
  legacyStrategyKey: `legacy.${POSITION_IMPORT_ADAPTER_ACTION}`,
  blocker: null,
  production: Object.freeze({
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  }),
  protocolLimits: Object.freeze({
    commandMaxBytes: 262144,
    eventMaxBytes: 262144
  })
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const RESULT_KEYS = Object.freeze([
  'acceptedFileCount',
  'cancelAcknowledged',
  'checkpointGeneration',
  'command',
  'committedMutations',
  'confirmationCount',
  'failedFileCount',
  'jobId',
  'outcome',
  'recoveredFromWorkerExit',
  'rowCount'
]);

function validatePositionImportAdapterResult(value) {
  try {
    if (!exactKeys(value, RESULT_KEYS) ||
        !POSITION_IMPORT_ADAPTER_COMMAND_SET.has(value.command) ||
        !POSITION_IMPORT_ADAPTER_OUTCOME_SET.has(value.outcome) ||
        typeof value.jobId !== 'string' || value.jobId.length < 1 || value.jobId.length > 256 ||
        !safeCount(value.acceptedFileCount) || !safeCount(value.failedFileCount) ||
        !safeCount(value.confirmationCount) || !safeCount(value.rowCount) ||
        !safeCount(value.committedMutations) ||
        (value.checkpointGeneration !== null && !safeCount(value.checkpointGeneration)) ||
        typeof value.recoveredFromWorkerExit !== 'boolean' ||
        typeof value.cancelAcknowledged !== 'boolean') {
      return false;
    }
    if (['recovered', 'preflight-recovered'].includes(value.outcome) !==
        value.recoveredFromWorkerExit) return false;
    if (value.outcome === 'preflight-complete') {
      return value.committedMutations === 0 && value.checkpointGeneration === null;
    }
    if (value.outcome === 'preflight-recovered') {
      return value.committedMutations === 0 && value.checkpointGeneration !== null;
    }
    return value.checkpointGeneration !== null && value.committedMutations > 0;
  } catch (_error) {
    return false;
  }
}

const PROGRESS_KEYS = Object.freeze([
  'acceptedRows',
  'committedRows',
  'copiedBytes',
  'elapsedMs',
  'heartbeat',
  'scannedRows',
  'stage',
  'totalBytes',
  'totalFiles'
]);

function validatePositionImportAdapterProgress(value) {
  return exactKeys(value, PROGRESS_KEYS) &&
    typeof value.stage === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.stage) &&
    safeCount(value.totalFiles) && safeCount(value.scannedRows) &&
    safeCount(value.acceptedRows) && safeCount(value.committedRows) &&
    safeCount(value.copiedBytes) && safeCount(value.totalBytes) &&
    safeCount(value.elapsedMs) && typeof value.heartbeat === 'boolean';
}

function allowPositionFinanceSafeValue(input = {}) {
  const { value, path, parent, key } = input;
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) || parent[key] !== value) {
    return false;
  }
  if (path === '/payload/progress/stage' && key === 'stage') {
    return validatePositionImportAdapterProgress(parent);
  }
  if (path === '/payload/result/command' && key === 'command') {
    return validatePositionImportAdapterResult(parent);
  }
  if (path === '/payload/result/outcome' && key === 'outcome') {
    return validatePositionImportAdapterResult(parent);
  }
  if (path === '/payload/result/jobId' && key === 'jobId') {
    return validatePositionImportAdapterResult(parent);
  }
  return false;
}

Object.defineProperty(validatePositionImportAdapterResult, 'allowFinanceSafeValue', {
  value: allowPositionFinanceSafeValue
});

module.exports = {
  POSITION_IMPORT_ADAPTER_ACTION,
  POSITION_IMPORT_ADAPTER_COMMANDS,
  POSITION_IMPORT_ADAPTER_COMMAND_SET,
  POSITION_IMPORT_ADAPTER_OUTCOMES,
  POSITION_IMPORT_ADAPTER_POLICY,
  validatePositionImportAdapterProgress,
  validatePositionImportAdapterResult
};
