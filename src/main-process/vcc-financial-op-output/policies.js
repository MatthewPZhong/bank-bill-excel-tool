'use strict';

const VCC_EXPORT_SUBJECTS_ACTION = 'vcc-financial-op:export-subjects';
const VCC_EXPORT_SINGLE_ACTION = 'vcc-financial-op:export-single';
const VCC_EXPORT_SUBJECTS_ENTRY_KEY = 'executor.vcc-financial-op:export-subjects';
const VCC_EXPORT_SINGLE_ENTRY_KEY = 'executor.vcc-financial-op:export-single';
const VCC_EXPORT_SUBJECTS_RESULT_VALIDATOR_KEY =
  'result-validator.vcc-financial-op:export-subjects';
const VCC_EXPORT_SINGLE_RESULT_VALIDATOR_KEY =
  'result-validator.vcc-financial-op:export-single';
const VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS = 64;

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

const VCC_EXPORT_SUBJECTS_POLICY = Object.freeze({
  actionKey: VCC_EXPORT_SUBJECTS_ACTION,
  moduleId: 'vcc-financial-op',
  description: `v3.2.x canonical policy fixture for ${VCC_EXPORT_SUBJECTS_ACTION}`,
  disposition: 'managed',
  mode: 'thread-pool',
  adapterKind: 'native',
  adapterKey: null,
  entryKey: VCC_EXPORT_SUBJECTS_ENTRY_KEY,
  lifetime: 'job',
  context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
  resources: Object.freeze({
    profile: 'resource.vcc-financial-op:export-subjects',
    base: Object.freeze({ ...ZERO_RESOURCES, workerThreadSlots: 1, memoryBytes: 33554432 }),
    phase: WRITER_RESOURCES,
    compound: Object.freeze({
      topologyKey: 'topology.vcc-financial-op:export-subjects',
      childrenMax: 4,
      childResource: WRITER_RESOURCES
    }),
    lowMemoryBehavior: 'downgrade-to-single',
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
    inspectorKey: 'inspector.vcc-financial-op:export-subjects',
    conflictScopeResolverKey: 'scope.vcc-financial-op:export-subjects',
    settlementKey: 'settlement.vcc-financial-op:export-subjects'
  }),
  result: Object.freeze({
    kind: 'artifact-manifest',
    maxBytes: 8388608,
    maxErrorItems: 100,
    validatorKey: VCC_EXPORT_SUBJECTS_RESULT_VALIDATOR_KEY
  }),
  artifacts: Object.freeze({
    kind: 'all-or-none',
    filePlanRequired: true,
    technicalValidatorKey: 'technical-validator.vcc-financial-op:export-subjects',
    businessValidatorKey: 'business-validator.vcc-financial-op:export-subjects',
    publisherKey: 'publisher.vcc-financial-op:export-subjects',
    maxArtifacts: VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS
  }),
  service: null,
  metrics: Object.freeze({
    phases: Object.freeze(['queue', 'execute', 'settle']),
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  }),
  featureFlag: 'feature.vcc-financial-op:export-subjects',
  legacyStrategyKey: 'legacy.vcc-financial-op:export-subjects',
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
  workUnits: Object.freeze({
    kind: 'subject',
    ordering: 'unit-index-reducer',
    requestedMaxWorkers: 4,
    minUnitsPerWorker: 2,
    plannerKey: 'planner.vcc-financial-op:export-subjects',
    reducerKey: 'reducer.vcc-financial-op:export-subjects'
  }),
  protocolLimits: Object.freeze({
    commandMaxBytes: 262144,
    eventMaxBytes: 262144
  })
});

const VCC_EXPORT_SINGLE_POLICY = Object.freeze({
  actionKey: VCC_EXPORT_SINGLE_ACTION,
  moduleId: 'vcc-financial-op',
  description: `v3.2.x canonical policy fixture for ${VCC_EXPORT_SINGLE_ACTION}`,
  disposition: 'managed',
  mode: 'thread-single',
  adapterKind: 'native',
  adapterKey: null,
  entryKey: VCC_EXPORT_SINGLE_ENTRY_KEY,
  lifetime: 'job',
  context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
  resources: Object.freeze({
    profile: 'resource.vcc-financial-op:export-single',
    base: ZERO_RESOURCES,
    phase: Object.freeze({ ...WRITER_RESOURCES, memoryBytes: 201326592 }),
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
    inspectorKey: 'inspector.vcc-financial-op:export-single',
    conflictScopeResolverKey: 'scope.vcc-financial-op:export-single',
    settlementKey: 'settlement.vcc-financial-op:export-single'
  }),
  result: Object.freeze({
    kind: 'artifact-manifest',
    maxBytes: 8388608,
    maxErrorItems: 100,
    validatorKey: VCC_EXPORT_SINGLE_RESULT_VALIDATOR_KEY
  }),
  artifacts: Object.freeze({
    kind: 'single',
    filePlanRequired: true,
    technicalValidatorKey: 'technical-validator.vcc-financial-op:export-single',
    businessValidatorKey: 'business-validator.vcc-financial-op:export-single',
    publisherKey: 'publisher.vcc-financial-op:export-single',
    maxArtifacts: 1
  }),
  service: null,
  metrics: Object.freeze({
    phases: Object.freeze(['queue', 'execute', 'settle']),
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  }),
  featureFlag: 'feature.vcc-financial-op:export-single',
  legacyStrategyKey: 'legacy.vcc-financial-op:export-single',
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

function safeHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateVccExportResult(value, expectedAction) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'archiveStateDigest', 'artifacts', 'authorityDigest', 'contractVersion',
      'inputFingerprint', 'resultRevision', 'runId', 'summary', 'targetMonth', 'task'
    ]) || value.contractVersion !== 1 || value.actionKey !== expectedAction ||
        !Number.isSafeInteger(value.runId) || value.runId < 1 ||
        typeof value.targetMonth !== 'string' || !/^\d{4}-\d{2}$/.test(value.targetMonth) ||
        !safeCount(value.resultRevision) ||
        !(value.inputFingerprint === null || safeHash(value.inputFingerprint)) ||
        !safeHash(value.archiveStateDigest) || !safeHash(value.authorityDigest) ||
        !exactKeys(value.task, ['action', 'taskGeneration', 'taskRunId']) ||
        value.task.action !== 'export-result' || !safeCount(value.task.taskGeneration) ||
        typeof value.task.taskRunId !== 'string' || !value.task.taskRunId ||
        !Array.isArray(value.artifacts) || value.artifacts.length < 1 ||
        value.artifacts.length > (expectedAction === VCC_EXPORT_SINGLE_ACTION
          ? 1 : VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS)) return false;
    const artifactKeys = new Set();
    const subjectIndexes = new Set();
    for (let index = 0; index < value.artifacts.length; index += 1) {
      const artifact = value.artifacts[index];
      if (!exactKeys(artifact, [
        'businessDigest', 'byteSize', 'outputArtifactKey', 'pendingRowCount',
        'resultRowCount', 'sha256', 'subjectDigest', 'subjectIndex'
      ]) || !safeCount(artifact.subjectIndex) ||
          (expectedAction === VCC_EXPORT_SUBJECTS_ACTION && artifact.subjectIndex !== index) ||
          subjectIndexes.has(artifact.subjectIndex) || !safeHash(artifact.subjectDigest) ||
          !safeHash(artifact.businessDigest) || !safeHash(artifact.sha256) ||
          typeof artifact.outputArtifactKey !== 'string' ||
          !/^output-[a-f0-9]{64}$/.test(artifact.outputArtifactKey) ||
          artifactKeys.has(artifact.outputArtifactKey) ||
          !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0 ||
          !Number.isSafeInteger(artifact.resultRowCount) || artifact.resultRowCount < 2 ||
          !Number.isSafeInteger(artifact.pendingRowCount) || artifact.pendingRowCount < 2) return false;
      artifactKeys.add(artifact.outputArtifactKey);
      subjectIndexes.add(artifact.subjectIndex);
    }
    return exactKeys(value.summary, ['artifactCount', 'subjectCount']) &&
      value.summary.artifactCount === value.artifacts.length &&
      value.summary.subjectCount === value.artifacts.length;
  } catch (_error) {
    return false;
  }
}

function validateVccExportSubjectsResult(value) {
  return validateVccExportResult(value, VCC_EXPORT_SUBJECTS_ACTION);
}

function validateVccExportSingleResult(value) {
  return validateVccExportResult(value, VCC_EXPORT_SINGLE_ACTION);
}

function allowVccExportFinanceSafeValue({ value, key }) {
  return [
    'archiveStateDigest', 'authorityDigest', 'businessDigest', 'inputFingerprint',
    'sha256', 'subjectDigest'
  ].includes(key) && safeHash(value);
}

Object.defineProperty(validateVccExportSubjectsResult, 'allowFinanceSafeValue', {
  value: allowVccExportFinanceSafeValue
});
Object.defineProperty(validateVccExportSingleResult, 'allowFinanceSafeValue', {
  value: allowVccExportFinanceSafeValue
});

module.exports = {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SINGLE_ENTRY_KEY,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SINGLE_RESULT_VALIDATOR_KEY,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_ENTRY_KEY,
  VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS,
  VCC_EXPORT_SUBJECTS_POLICY,
  VCC_EXPORT_SUBJECTS_RESULT_VALIDATOR_KEY,
  validateVccExportSingleResult,
  validateVccExportSubjectsResult
};
