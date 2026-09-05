'use strict';

const PENDING_BIZOP_ADAPTER_ACTIONS = Object.freeze({
  PENDING_IMPORT: 'pending:import',
  BIZ_OP_IMPORT_FLOW: 'biz-op:import-flow'
});

const PENDING_BIZOP_ADAPTER_ACTION_SET = Object.freeze(
  new Set(Object.values(PENDING_BIZOP_ADAPTER_ACTIONS))
);

const ZERO_BASE_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 33554432
});

const ROOT_PHASE_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

const PARSER_CHILD_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

function pendingBizOpAdapterPolicy(actionKey) {
  if (!PENDING_BIZOP_ADAPTER_ACTION_SET.has(actionKey)) {
    throw new TypeError(`Pending/BizOP mature adapter action 非法：${actionKey}`);
  }
  const pending = actionKey === PENDING_BIZOP_ADAPTER_ACTIONS.PENDING_IMPORT;
  return Object.freeze({
    actionKey,
    moduleId: pending ? 'pending' : 'biz-op',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-pool',
    adapterKind: 'existing-dispatch',
    adapterKey: `adapter.${actionKey}`,
    entryKey: null,
    lifetime: 'job',
    context: Object.freeze({ kind: 'file-batch', validatorKey: 'exact-7' }),
    resources: Object.freeze({
      profile: `resource.${actionKey}`,
      base: ZERO_BASE_RESOURCES,
      phase: ROOT_PHASE_RESOURCES,
      compound: Object.freeze({
        topologyKey: `topology.${actionKey}`,
        childrenMax: 4,
        childResource: PARSER_CHILD_RESOURCES
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
      kind: 'existing-critical-protocol',
      criticalIntent: false,
      receiptKind: 'existing-protocol',
      inspectorKey: `inspector.${actionKey}`,
      conflictScopeResolverKey: `scope.${actionKey}`,
      settlementKey: `settlement.${actionKey}`
    }),
    result: Object.freeze({
      kind: 'spool-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.${actionKey}`
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
    featureFlag: `feature.${actionKey}`,
    legacyStrategyKey: `legacy.${actionKey}`,
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
    workUnits: Object.freeze({
      kind: 'file',
      ordering: 'input-index-reducer',
      requestedMaxWorkers: 4,
      minUnitsPerWorker: 2,
      plannerKey: `planner.${actionKey}`,
      reducerKey: `reducer.${actionKey}`
    }),
    protocolLimits: Object.freeze({
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    })
  });
}

const PENDING_BIZOP_ADAPTER_POLICIES = Object.freeze(
  Object.values(PENDING_BIZOP_ADAPTER_ACTIONS).map(pendingBizOpAdapterPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validatePendingBizOpAdapterResult(value) {
  try {
    return exactKeys(value, [
      'deletedCount', 'fileCount', 'maxParallel', 'monthKey', 'totalImported'
    ]) &&
      (value.monthKey === null || /^\d{4}-\d{2}$/.test(value.monthKey)) &&
      Number.isSafeInteger(value.fileCount) && value.fileCount > 0 &&
      Number.isSafeInteger(value.totalImported) && value.totalImported >= 0 &&
      Number.isSafeInteger(value.deletedCount) && value.deletedCount >= 0 &&
      Number.isSafeInteger(value.maxParallel) && value.maxParallel > 0 &&
      value.maxParallel <= value.fileCount;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  PENDING_BIZOP_ADAPTER_ACTIONS,
  PENDING_BIZOP_ADAPTER_ACTION_SET,
  PENDING_BIZOP_ADAPTER_POLICIES,
  pendingBizOpAdapterPolicy,
  validatePendingBizOpAdapterResult
};
