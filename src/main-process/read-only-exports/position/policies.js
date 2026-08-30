'use strict';

const POSITION_READ_ONLY_ACTION = 'position:export-run';
const POSITION_READ_ONLY_ACTION_SET = Object.freeze(new Set([POSITION_READ_ONLY_ACTION]));

const POSITION_READ_ONLY_POLICY = Object.freeze({
  actionKey: POSITION_READ_ONLY_ACTION,
  moduleId: 'position-read-only-export',
  description: 'v3.2.5 E13-B Position read-only worker capability',
  disposition: 'managed',
  mode: 'thread-single',
  adapterKind: 'native',
  adapterKey: null,
  entryKey: 'executor.position:export-run',
  lifetime: 'job',
  context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
  resources: Object.freeze({
    profile: 'resource.position:export-run',
    base: Object.freeze({
      cpuSlots: 0,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 0
    }),
    phase: Object.freeze({
      cpuSlots: 1,
      workerThreadSlots: 1,
      utilityProcessSlots: 0,
      ioHeavySlots: 1,
      memoryBytes: 268435456
    }),
    compound: null,
    lowMemoryBehavior: 'queue',
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
    kind: 'main-settlement',
    criticalIntent: false,
    receiptKind: 'publisher-journal',
    inspectorKey: 'inspector.position:export-run',
    conflictScopeResolverKey: 'scope.position:export-run',
    settlementKey: 'settlement.position:export-run'
  }),
  result: Object.freeze({
    kind: 'artifact-manifest',
    maxBytes: 8388608,
    maxErrorItems: 100,
    validatorKey: 'result-validator.position:export-run'
  }),
  artifacts: Object.freeze({
    kind: 'single',
    filePlanRequired: true,
    technicalValidatorKey: 'technical-validator.position:export-run',
    businessValidatorKey: 'business-validator.position:export-run',
    publisherKey: 'publisher.position:export-run',
    maxArtifacts: 1
  }),
  service: null,
  metrics: Object.freeze({
    phases: Object.freeze(['queue', 'execute', 'settle']),
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  }),
  featureFlag: 'feature.position:export-run',
  legacyStrategyKey: 'legacy.position:export-run',
  blocker: null,
  production: Object.freeze({
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'production gate not yet passed',
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

function validatePositionReadOnlyExportResult(value) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) || value.contractVersion !== 1 || value.actionKey !== POSITION_READ_ONLY_ACTION ||
        typeof value.operationKey !== 'string' || !value.operationKey ||
        typeof value.taskRunId !== 'string' || !value.taskRunId ||
        !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
        !Array.isArray(value.artifacts) || value.artifacts.length !== 1) return false;
    const artifact = value.artifacts[0];
    if (!exactKeys(artifact, [
      'businessDigest', 'byteSize', 'dataRowCount', 'outputArtifactKey',
      'sha256', 'sheetCount'
    ]) || typeof artifact.outputArtifactKey !== 'string' || !artifact.outputArtifactKey ||
        !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 1 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.businessDigest) ||
        !Number.isSafeInteger(artifact.sheetCount) || artifact.sheetCount < 1 ||
        !Number.isSafeInteger(artifact.dataRowCount) || artifact.dataRowCount < 0) return false;
    if (!exactKeys(value.summary, ['rowCount', 'runId', 'variant']) ||
        !Number.isSafeInteger(value.summary.runId) || value.summary.runId < 1 ||
        !Number.isSafeInteger(value.summary.rowCount) || value.summary.rowCount < 0 ||
        !['run', 'differences', 'filtered'].includes(value.summary.variant)) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validatePositionReadOnlyExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  POSITION_READ_ONLY_ACTION,
  POSITION_READ_ONLY_ACTION_SET,
  POSITION_READ_ONLY_POLICY,
  validatePositionReadOnlyExportResult
};
