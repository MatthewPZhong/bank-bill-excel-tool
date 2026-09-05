'use strict';

const BIZ_OP_READ_ONLY_ACTIONS = Object.freeze({
  DAY: 'biz-op:export-day',
  RANGE: 'biz-op:export-range'
});

const BIZ_OP_READ_ONLY_ACTION_SET = Object.freeze(new Set(Object.values(BIZ_OP_READ_ONLY_ACTIONS)));

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const WORKER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

function bizOpReadOnlyExportPolicy(actionKey) {
  if (!BIZ_OP_READ_ONLY_ACTION_SET.has(actionKey)) {
    throw new TypeError(`BizOP read-only export action 非法：${actionKey}`);
  }
  const suffix = actionKey.slice('biz-op:'.length);
  return Object.freeze({
    actionKey,
    moduleId: 'biz-op-read-only-export',
    description: `v3.2.5 E13-A BizOP read-only worker capability for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: 'executor.biz-op:read-only-export',
    lifetime: 'job',
    context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
    resources: Object.freeze({
      profile: `resource.biz-op:${suffix}`,
      base: ZERO_RESOURCES,
      phase: WORKER_RESOURCES,
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
      inspectorKey: `inspector.biz-op:${suffix}`,
      conflictScopeResolverKey: `scope.biz-op:${suffix}`,
      settlementKey: `settlement.biz-op:${suffix}`
    }),
    result: Object.freeze({
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.biz-op:${suffix}`
    }),
    artifacts: Object.freeze({
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: `technical-validator.biz-op:${suffix}`,
      businessValidatorKey: `business-validator.biz-op:${suffix}`,
      publisherKey: `publisher.biz-op:${suffix}`,
      maxArtifacts: 1
    }),
    service: null,
    metrics: Object.freeze({
      phases: Object.freeze(['queue', 'execute', 'settle']),
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    }),
    featureFlag: `feature.biz-op:${suffix}`,
    legacyStrategyKey: `legacy.biz-op:${suffix}`,
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
}

const BIZ_OP_READ_ONLY_POLICIES = Object.freeze(
  Object.values(BIZ_OP_READ_ONLY_ACTIONS).map(bizOpReadOnlyExportPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validateBizOpReadOnlyExportResult(value) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) || value.contractVersion !== 1 || !BIZ_OP_READ_ONLY_ACTION_SET.has(value.actionKey) ||
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
    if (value.actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY) {
      return exactKeys(value.summary, ['rowCount']) &&
        Number.isSafeInteger(value.summary.rowCount) && value.summary.rowCount >= 0;
    }
    return exactKeys(value.summary, ['rowCount', 'sheetCount', 'skippedDates']) &&
      Number.isSafeInteger(value.summary.rowCount) && value.summary.rowCount >= 0 &&
      Number.isSafeInteger(value.summary.sheetCount) && value.summary.sheetCount >= 0 &&
      Array.isArray(value.summary.skippedDates) &&
      value.summary.skippedDates.every((date) => (
        typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ));
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validateBizOpReadOnlyExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  BIZ_OP_READ_ONLY_ACTIONS,
  BIZ_OP_READ_ONLY_ACTION_SET,
  BIZ_OP_READ_ONLY_POLICIES,
  bizOpReadOnlyExportPolicy,
  validateBizOpReadOnlyExportResult
};
