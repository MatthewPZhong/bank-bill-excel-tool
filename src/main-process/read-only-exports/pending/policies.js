'use strict';

const PENDING_READ_ONLY_ACTIONS = Object.freeze({
  DIFF: 'pending:export-diff',
  SUMMARY: 'pending:export-summary',
  ERRORS: 'pending:export-errors'
});

const PENDING_READ_ONLY_ACTION_SET = Object.freeze(new Set(Object.values(PENDING_READ_ONLY_ACTIONS)));

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

function pendingReadOnlyExportPolicy(actionKey) {
  if (!PENDING_READ_ONLY_ACTION_SET.has(actionKey)) {
    throw new TypeError(`Pending read-only export action 非法：${actionKey}`);
  }
  const suffix = actionKey.slice('pending:'.length);
  return Object.freeze({
    actionKey,
    moduleId: 'pending-read-only-export',
    description: `v3.2.5 E13-A Pending read-only worker capability for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: 'executor.pending:read-only-export',
    lifetime: 'job',
    context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
    resources: Object.freeze({
      profile: `resource.pending:${suffix}`,
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
      inspectorKey: `inspector.pending:${suffix}`,
      conflictScopeResolverKey: `scope.pending:${suffix}`,
      settlementKey: `settlement.pending:${suffix}`
    }),
    result: Object.freeze({
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.pending:${suffix}`
    }),
    artifacts: Object.freeze({
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: `technical-validator.pending:${suffix}`,
      businessValidatorKey: `business-validator.pending:${suffix}`,
      publisherKey: `publisher.pending:${suffix}`,
      maxArtifacts: 1
    }),
    service: null,
    metrics: Object.freeze({
      phases: Object.freeze(['queue', 'execute', 'settle']),
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    }),
    featureFlag: `feature.pending:${suffix}`,
    legacyStrategyKey: `legacy.pending:${suffix}`,
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

const PENDING_READ_ONLY_POLICIES = Object.freeze(
  Object.values(PENDING_READ_ONLY_ACTIONS).map(pendingReadOnlyExportPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validatePendingReadOnlyExportResult(value) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) || value.contractVersion !== 1 || !PENDING_READ_ONLY_ACTION_SET.has(value.actionKey) ||
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
    if (value.actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS) {
      return exactKeys(value.summary, ['errorCount']) &&
        Number.isSafeInteger(value.summary.errorCount) && value.summary.errorCount >= 0;
    }
    if (value.actionKey === PENDING_READ_ONLY_ACTIONS.DIFF) {
      return exactKeys(value.summary, [
        'fundTypeDiffRowCount', 'missingReconRowCount', 'removalOnlyRowCount',
        'removalReconcileAppended', 'rowCount', 'sheetCount'
      ]) &&
        ['fundTypeDiffRowCount', 'missingReconRowCount', 'removalOnlyRowCount', 'rowCount', 'sheetCount']
          .every((key) => Number.isSafeInteger(value.summary[key]) && value.summary[key] >= 0) &&
        typeof value.summary.removalReconcileAppended === 'boolean';
    }
    return exactKeys(value.summary, [
      'fundTypeDiffRowCount', 'removalDataOmitted', 'rowCount', 'runsCount'
    ]) &&
      ['fundTypeDiffRowCount', 'rowCount', 'runsCount']
        .every((key) => Number.isSafeInteger(value.summary[key]) && value.summary[key] >= 0) &&
      typeof value.summary.removalDataOmitted === 'boolean';
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validatePendingReadOnlyExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  PENDING_READ_ONLY_ACTIONS,
  PENDING_READ_ONLY_ACTION_SET,
  PENDING_READ_ONLY_POLICIES,
  pendingReadOnlyExportPolicy,
  validatePendingReadOnlyExportResult
};
