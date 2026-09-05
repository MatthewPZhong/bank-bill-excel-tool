'use strict';

const PRE_FUND_READ_ONLY_ACTIONS = Object.freeze({
  CHANNEL: 'pre-fund:export-channel',
  AUDIT: 'pre-fund:export-audit'
});

const PRE_FUND_READ_ONLY_ACTION_SET = Object.freeze(
  new Set(Object.values(PRE_FUND_READ_ONLY_ACTIONS))
);

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
  memoryBytes: 201326592
});

function preFundReadOnlyExportPolicy(actionKey) {
  if (!PRE_FUND_READ_ONLY_ACTION_SET.has(actionKey)) {
    throw new TypeError(`PreFund read-only export action 非法：${actionKey}`);
  }
  const suffix = actionKey.slice('pre-fund:'.length);
  return Object.freeze({
    actionKey,
    moduleId: 'pre-fund-read-only-export',
    description: `v3.2.5 E13-B PreFund read-only worker capability for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.pre-fund:${suffix}`,
    lifetime: 'job',
    context: Object.freeze({ kind: 'operation', validatorKey: 'exact-5' }),
    resources: Object.freeze({
      profile: `resource.pre-fund:${suffix}`,
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
      inspectorKey: `inspector.pre-fund:${suffix}`,
      conflictScopeResolverKey: `scope.pre-fund:${suffix}`,
      settlementKey: `settlement.pre-fund:${suffix}`
    }),
    result: Object.freeze({
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.pre-fund:${suffix}`
    }),
    artifacts: Object.freeze({
      kind: 'single',
      filePlanRequired: true,
      technicalValidatorKey: `technical-validator.pre-fund:${suffix}`,
      businessValidatorKey: `business-validator.pre-fund:${suffix}`,
      publisherKey: `publisher.pre-fund:${suffix}`,
      maxArtifacts: 1
    }),
    service: null,
    metrics: Object.freeze({
      phases: Object.freeze(['queue', 'execute', 'settle']),
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    }),
    featureFlag: `feature.pre-fund:${suffix}`,
    legacyStrategyKey: `legacy.pre-fund:${suffix}`,
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

const PRE_FUND_READ_ONLY_POLICIES = Object.freeze(
  Object.values(PRE_FUND_READ_ONLY_ACTIONS).map(preFundReadOnlyExportPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validatePreFundReadOnlyExportResult(value) {
  try {
    if (!exactKeys(value, [
      'actionKey', 'artifacts', 'contractVersion', 'operationKey',
      'sourceDigest', 'summary', 'taskRunId'
    ]) || value.contractVersion !== 1 || !PRE_FUND_READ_ONLY_ACTION_SET.has(value.actionKey) ||
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
        !Number.isSafeInteger(artifact.sheetCount) || artifact.sheetCount < 5 ||
        !Number.isSafeInteger(artifact.dataRowCount) || artifact.dataRowCount < 0) return false;
    if (!exactKeys(value.summary, [
      'balancedCount', 'channelBillCount', 'channelDigest',
      'duplicateGatewayCount', 'hasDuplicateRecords', 'unbalancedCount'
    ]) || !/^[a-f0-9]{64}$/.test(value.summary.channelDigest) ||
        !['balancedCount', 'channelBillCount', 'duplicateGatewayCount', 'unbalancedCount']
          .every((key) => Number.isSafeInteger(value.summary[key]) && value.summary[key] >= 0) ||
        typeof value.summary.hasDuplicateRecords !== 'boolean' ||
        value.summary.channelBillCount !== value.summary.unbalancedCount ||
        value.summary.hasDuplicateRecords !==
          (value.actionKey === PRE_FUND_READ_ONLY_ACTIONS.AUDIT) ||
        (value.summary.hasDuplicateRecords
          ? value.summary.duplicateGatewayCount < 1
          : value.summary.duplicateGatewayCount !== 0)) return false;
    return artifact.sheetCount === (value.summary.hasDuplicateRecords ? 6 : 5);
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validatePreFundReadOnlyExportResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['businessDigest', 'channelDigest', 'sha256', 'sourceDigest'].includes(key) &&
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }
});

module.exports = {
  PRE_FUND_READ_ONLY_ACTIONS,
  PRE_FUND_READ_ONLY_ACTION_SET,
  PRE_FUND_READ_ONLY_POLICIES,
  preFundReadOnlyExportPolicy,
  validatePreFundReadOnlyExportResult
};
