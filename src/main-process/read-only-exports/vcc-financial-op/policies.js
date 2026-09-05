'use strict';

const VCC_FINANCIAL_OP_READ_ONLY_ACTION = 'vcc-financial-op:export-audit';
const VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET = Object.freeze(new Set([
  VCC_FINANCIAL_OP_READ_ONLY_ACTION
]));

const VCC_FINANCIAL_OP_READ_ONLY_POLICY = Object.freeze({
  actionKey: VCC_FINANCIAL_OP_READ_ONLY_ACTION,
  moduleId: 'vcc-financial-op-read-only-export',
  description: 'v3.2.5 E13-B VCC Financial OP read-only dataset/audit capability',
  disposition: 'managed',
  mode: 'thread-single',
  adapterKind: 'native',
  adapterKey: null,
  entryKey: 'executor.vcc-financial-op:export-audit',
  lifetime: 'job',
  context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
  resources: Object.freeze({
    profile: 'resource.vcc-financial-op:export-audit',
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
    inspectorKey: 'inspector.vcc-financial-op:export-audit',
    conflictScopeResolverKey: 'scope.vcc-financial-op:export-audit',
    settlementKey: 'settlement.vcc-financial-op:export-audit'
  }),
  result: Object.freeze({
    kind: 'artifact-manifest',
    maxBytes: 8388608,
    maxErrorItems: 100,
    validatorKey: 'result-validator.vcc-financial-op:export-audit'
  }),
  artifacts: Object.freeze({
    kind: 'single',
    filePlanRequired: true,
    technicalValidatorKey: 'technical-validator.vcc-financial-op:export-audit',
    businessValidatorKey: 'business-validator.vcc-financial-op:export-audit',
    publisherKey: 'publisher.vcc-financial-op:export-audit',
    maxArtifacts: 1
  }),
  service: null,
  metrics: Object.freeze({
    phases: Object.freeze(['queue', 'execute', 'settle']),
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  }),
  featureFlag: 'feature.vcc-financial-op:export-audit',
  legacyStrategyKey: 'legacy.vcc-financial-op:export-audit',
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

function validateArtifact(artifact) {
  return exactKeys(artifact, [
    'businessDigest', 'byteSize', 'dataRowCount', 'outputArtifactKey',
    'sha256', 'sheetCount'
  ]) && typeof artifact.outputArtifactKey === 'string' && artifact.outputArtifactKey &&
    Number.isSafeInteger(artifact.byteSize) && artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/.test(artifact.sha256) &&
    /^[a-f0-9]{64}$/.test(artifact.businessDigest) &&
    Number.isSafeInteger(artifact.sheetCount) && artifact.sheetCount > 0 &&
    Number.isSafeInteger(artifact.dataRowCount) && artifact.dataRowCount >= 0;
}

function validateSummary(summary) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.variant === 'import-audit') {
    return exactKeys(summary, ['recordId', 'rowCount', 'sheetCount', 'variant']) &&
      Number.isSafeInteger(summary.recordId) && summary.recordId > 0 &&
      Number.isSafeInteger(summary.rowCount) && summary.rowCount > 0 &&
      Number.isSafeInteger(summary.sheetCount) && summary.sheetCount > 0;
  }
  if (summary.variant === 'dataset') {
    const valid = exactKeys(summary, [
      'dataCount', 'incomplete', 'missingRows', 'sheetCount', 'sourceType',
      'targetKind', 'targetMonth', 'totalRows', 'variant'
    ]) && typeof summary.targetMonth === 'string' && summary.targetMonth &&
      typeof summary.sourceType === 'string' && summary.sourceType &&
      ['raw', 'check'].includes(summary.targetKind) &&
      Number.isSafeInteger(summary.dataCount) && summary.dataCount >= 0 &&
      Number.isSafeInteger(summary.totalRows) && summary.totalRows > 0 &&
      Number.isSafeInteger(summary.missingRows) && summary.missingRows >= 0 &&
      Number.isSafeInteger(summary.sheetCount) && summary.sheetCount > 0 &&
      typeof summary.incomplete === 'boolean';
    return valid && summary.dataCount <= summary.totalRows &&
      summary.dataCount + summary.missingRows === summary.totalRows &&
      summary.incomplete === (summary.missingRows > 0);
  }
  return false;
}

function validateVccFinancialOpReadOnlyExportResult(value) {
  try {
    return exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) && value.contractVersion === 1 &&
      value.actionKey === VCC_FINANCIAL_OP_READ_ONLY_ACTION &&
      typeof value.operationKey === 'string' && value.operationKey &&
      typeof value.taskRunId === 'string' && value.taskRunId &&
      /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
      Array.isArray(value.artifacts) && value.artifacts.length === 1 &&
      validateArtifact(value.artifacts[0]) && validateSummary(value.summary) &&
      value.artifacts[0].sheetCount === value.summary.sheetCount &&
      (value.summary.variant !== 'import-audit' ||
        value.artifacts[0].dataRowCount === value.summary.rowCount);
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validateVccFinancialOpReadOnlyExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  VCC_FINANCIAL_OP_READ_ONLY_ACTION,
  VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET,
  VCC_FINANCIAL_OP_READ_ONLY_POLICY,
  validateVccFinancialOpReadOnlyExportResult
};
