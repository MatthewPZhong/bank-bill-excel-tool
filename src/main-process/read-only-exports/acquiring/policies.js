'use strict';

const ACQUIRING_EXPORT_ACTIONS = Object.freeze({
  COPY: 'acquiring:copy-existing-diff',
  REGENERATE: 'acquiring:export-diff-workbook'
});

const ACQUIRING_EXPORT_ACTION_SET = Object.freeze(
  new Set(Object.values(ACQUIRING_EXPORT_ACTIONS))
);

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const COPY_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 16777216
});

const REGENERATE_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 201326592
});

function acquiringExportPolicy(actionKey) {
  if (!ACQUIRING_EXPORT_ACTION_SET.has(actionKey)) {
    throw new TypeError(`Acquiring export action 非法：${actionKey}`);
  }
  const copy = actionKey === ACQUIRING_EXPORT_ACTIONS.COPY;
  const suffix = actionKey.slice('acquiring:'.length);
  return Object.freeze({
    actionKey,
    moduleId: 'acquiring',
    description: `v3.2.5 E13-C Acquiring ${copy ? 'stable artifact copy' : 'stable run regenerate'} capability`,
    disposition: 'managed',
    mode: copy ? 'inline-async' : 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.acquiring:${suffix}`,
    lifetime: 'job',
    context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
    resources: Object.freeze({
      profile: `resource.acquiring:${suffix}`,
      base: ZERO_RESOURCES,
      phase: copy ? COPY_RESOURCES : REGENERATE_RESOURCES,
      compound: null,
      lowMemoryBehavior: 'queue',
      admissionPriority: 'normal'
    }),
    cancellation: Object.freeze({
      capability: 'shutdown-only',
      safePoints: Object.freeze(copy
        ? ['before-copy', 'after-copy-before-publish']
        : ['before-critical', 'between-units']),
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
      inspectorKey: `inspector.acquiring:${suffix}`,
      conflictScopeResolverKey: `scope.acquiring:${suffix}`,
      settlementKey: `settlement.acquiring:${suffix}`
    }),
    result: Object.freeze({
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.acquiring:${suffix}`
    }),
    artifacts: Object.freeze({
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: `technical-validator.acquiring:${suffix}`,
      businessValidatorKey: `business-validator.acquiring:${suffix}`,
      publisherKey: `publisher.acquiring:${suffix}`,
      maxArtifacts: 1
    }),
    service: null,
    metrics: Object.freeze({
      phases: Object.freeze(['queue', 'execute', 'settle']),
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    }),
    featureFlag: `feature.acquiring:${suffix}`,
    legacyStrategyKey: copy ? null : `legacy.acquiring:${suffix}`,
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

const ACQUIRING_EXPORT_POLICIES = Object.freeze(
  Object.values(ACQUIRING_EXPORT_ACTIONS).map(acquiringExportPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validateAcquiringExportResult(value) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) || value.contractVersion !== 1 || !ACQUIRING_EXPORT_ACTION_SET.has(value.actionKey) ||
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
        !Number.isSafeInteger(artifact.sheetCount) || artifact.sheetCount < 0 ||
        !Number.isSafeInteger(artifact.dataRowCount) || artifact.dataRowCount < 0) return false;
    if (!exactKeys(value.summary, ['kind', 'monthKey', 'runId']) ||
        !['copy-existing-diff', 'regenerate-diff-workbook'].includes(value.summary.kind) ||
        !/^\d{4}-\d{2}$/.test(value.summary.monthKey) ||
        !Number.isSafeInteger(value.summary.runId) || value.summary.runId < 1) return false;
    if (value.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY) {
      return value.summary.kind === 'copy-existing-diff' &&
        artifact.sheetCount === 0 && artifact.dataRowCount === 0 &&
        artifact.businessDigest === artifact.sha256;
    }
    return value.summary.kind === 'regenerate-diff-workbook' && artifact.sheetCount >= 2;
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validateAcquiringExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  ACQUIRING_EXPORT_ACTIONS,
  ACQUIRING_EXPORT_ACTION_SET,
  ACQUIRING_EXPORT_POLICIES,
  acquiringExportPolicy,
  validateAcquiringExportResult
};
