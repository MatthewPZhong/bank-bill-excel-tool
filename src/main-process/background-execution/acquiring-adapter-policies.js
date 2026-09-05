'use strict';

const ACQUIRING_ADAPTER_ACTIONS = Object.freeze({
  IMPORT: 'acquiring:import',
  RUN_NEW_ELIGIBLE: 'acquiring:run-new-eligible',
  RUN_SINGLE_OR_RESUME: 'acquiring:run-single-or-resume'
});

const ACQUIRING_ADAPTER_ACTION_SET = Object.freeze(
  new Set(Object.values(ACQUIRING_ADAPTER_ACTIONS))
);

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const BASE_RESOURCES = Object.freeze({
  ...ZERO_RESOURCES,
  memoryBytes: 33554432
});

const ROOT_POOL_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

const SINGLE_ROOT_RESOURCES = Object.freeze({
  ...ROOT_POOL_RESOURCES,
  memoryBytes: 201326592
});

const CHILD_RESOURCES = Object.freeze({ ...ROOT_POOL_RESOURCES });

function productionGate() {
  return Object.freeze({
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  });
}

function acquiringAdapterPolicy(actionKey) {
  if (!ACQUIRING_ADAPTER_ACTION_SET.has(actionKey)) {
    throw new TypeError(`Acquiring mature adapter action 非法：${actionKey}`);
  }
  const importAction = actionKey === ACQUIRING_ADAPTER_ACTIONS.IMPORT;
  const multiWorkerAction = actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE;
  const singleAction = actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME;
  const childrenMax = importAction ? 4 : 8;
  const resultKind = importAction ? 'spool-manifest' : 'compact-json';
  const policy = {
    actionKey,
    moduleId: 'acquiring',
    description: `v3.2.5 E13-E Acquiring existing-dispatch capability for ${actionKey}`,
    disposition: 'managed',
    mode: singleAction ? 'thread-single' : 'thread-pool',
    adapterKind: 'existing-dispatch',
    adapterKey: `adapter.${actionKey}`,
    entryKey: null,
    lifetime: 'job',
    context: Object.freeze({
      kind: importAction ? 'file-batch' : 'operation',
      validatorKey: importAction ? 'exact-7' : 'exact-5'
    }),
    resources: Object.freeze({
      profile: `resource.${actionKey}`,
      base: singleAction ? ZERO_RESOURCES : BASE_RESOURCES,
      phase: singleAction ? SINGLE_ROOT_RESOURCES : ROOT_POOL_RESOURCES,
      compound: singleAction ? null : Object.freeze({
        topologyKey: `topology.${actionKey}`,
        childrenMax,
        childResource: CHILD_RESOURCES
      }),
      lowMemoryBehavior: singleAction ? 'queue' : 'downgrade-to-single',
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
      kind: resultKind,
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
    production: productionGate(),
    protocolLimits: Object.freeze({
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    })
  };
  if (!singleAction) {
    policy.workUnits = Object.freeze({
      kind: importAction ? 'file' : 'chunk',
      ordering: 'input-index-reducer',
      requestedMaxWorkers: childrenMax,
      minUnitsPerWorker: 2,
      plannerKey: `planner.${actionKey}`,
      reducerKey: `reducer.${actionKey}`
    });
  }
  return Object.freeze(policy);
}

const ACQUIRING_ADAPTER_POLICIES = Object.freeze(
  Object.values(ACQUIRING_ADAPTER_ACTIONS).map(acquiringAdapterPolicy)
);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateAcquiringImportAdapterResult(value) {
  try {
    const appendKeys = ['fileCount', 'monthKey', 'perFileStats', 'totalImported'];
    const overwriteKeys = [...appendKeys, 'deletedCount'];
    if (!exactKeys(value, appendKeys) && !exactKeys(value, overwriteKeys)) return false;
    if (!/^\d{4}-\d{2}$/.test(value.monthKey) ||
        !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 ||
        !safeCount(value.totalImported) ||
        !Array.isArray(value.perFileStats) || value.perFileStats.length !== value.fileCount) {
      return false;
    }
    if (Object.hasOwn(value, 'deletedCount') && !safeCount(value.deletedCount)) return false;
    return value.perFileStats.every((item) => exactKeys(item, ['sourceFile']) &&
      typeof item.sourceFile === 'string' && item.sourceFile.length > 0 &&
      !/[\\/]/.test(item.sourceFile));
  } catch (_error) {
    return false;
  }
}

function validateAcquiringRunAdapterResult(value) {
  try {
    const baseKeys = [
      'diffFilePath', 'matchedRows', 'mismatchRows', 'reportFilePath',
      'runId', 'totalBillRows', 'unmatchedRows'
    ];
    const freshKeys = [...baseKeys, 'cleanupNeeded'];
    if (!exactKeys(value, baseKeys) && !exactKeys(value, freshKeys)) return false;
    if (!Number.isSafeInteger(value.runId) || value.runId < 1 ||
        !safeCount(value.totalBillRows) || !safeCount(value.matchedRows) ||
        !safeCount(value.mismatchRows) || !safeCount(value.unmatchedRows) ||
        value.matchedRows + value.unmatchedRows !== value.totalBillRows ||
        value.mismatchRows > value.matchedRows ||
        typeof value.diffFilePath !== 'string' || value.diffFilePath.length === 0 ||
        typeof value.reportFilePath !== 'string' || value.reportFilePath.length === 0 ||
        value.diffFilePath !== value.reportFilePath) {
      return false;
    }
    return !Object.hasOwn(value, 'cleanupNeeded') || typeof value.cleanupNeeded === 'boolean';
  } catch (_error) {
    return false;
  }
}

function validReadingProgress(value) {
  return exactKeys(value, ['fileCount', 'fileIndex', 'filePath', 'stage']) &&
    value.stage === 'reading' &&
    Number.isSafeInteger(value.fileIndex) && value.fileIndex >= 0 &&
    Number.isSafeInteger(value.fileCount) && value.fileCount > value.fileIndex &&
    typeof value.filePath === 'string' && value.filePath.length > 0;
}

function validInsertingProgress(value) {
  return exactKeys(value, [
    'fileCount', 'fileIndex', 'importedCount', 'sourceFile', 'stage'
  ]) && value.stage === 'inserting' &&
    Number.isSafeInteger(value.fileIndex) && value.fileIndex >= 0 &&
    Number.isSafeInteger(value.fileCount) && value.fileCount > value.fileIndex &&
    safeCount(value.importedCount) &&
    typeof value.sourceFile === 'string' && value.sourceFile.length > 0;
}

function allowAcquiringImportFinanceSafeValue(input = {}) {
  if (!input || typeof input !== 'object') return false;
  const { value, path, parent, key } = input;
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) ||
      typeof value !== 'string' || parent[key] !== value) return false;
  if (path === '/payload/progress/filePath' && key === 'filePath') {
    return validReadingProgress(parent);
  }
  if (path === '/payload/progress/sourceFile' && key === 'sourceFile') {
    return validInsertingProgress(parent);
  }
  return /^\/payload\/result\/perFileStats\/(?:0|[1-9]\d*)\/sourceFile$/.test(path) &&
    key === 'sourceFile' && exactKeys(parent, ['sourceFile']);
}

function allowAcquiringRunFinanceSafeValue(input = {}) {
  if (!input || typeof input !== 'object') return false;
  const { value, path, parent, key } = input;
  const expectedKey = {
    '/payload/result/diffFilePath': 'diffFilePath',
    '/payload/result/reportFilePath': 'reportFilePath'
  }[path];
  return Boolean(expectedKey && key === expectedKey && typeof value === 'string' &&
    parent && typeof parent === 'object' && !Array.isArray(parent) &&
    parent[key] === value && validateAcquiringRunAdapterResult(parent));
}

Object.defineProperty(validateAcquiringImportAdapterResult, 'allowFinanceSafeValue', {
  value: allowAcquiringImportFinanceSafeValue
});
Object.defineProperty(validateAcquiringRunAdapterResult, 'allowFinanceSafeValue', {
  value: allowAcquiringRunFinanceSafeValue
});

module.exports = {
  ACQUIRING_ADAPTER_ACTIONS,
  ACQUIRING_ADAPTER_ACTION_SET,
  ACQUIRING_ADAPTER_POLICIES,
  acquiringAdapterPolicy,
  validateAcquiringImportAdapterResult,
  validateAcquiringRunAdapterResult
};
