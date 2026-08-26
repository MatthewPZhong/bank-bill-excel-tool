'use strict';

const {
  allowMptFinanceSafeValue,
  isSafeMptDetailLines,
  isSafeMptErrorCode,
  isSafeMptErrorText,
  safeMptFileName
} = require('./file-result-safety');

const PRE_FUND_MPT_IMPORT_ACTION = 'pre-fund:mpt-import';
const PRE_FUND_MPT_REPAIR_ACTION = 'pre-fund:mpt-repair-import';
const PRE_FUND_MPT_STATIC_KEYS = Object.freeze({
  [PRE_FUND_MPT_IMPORT_ACTION]: Object.freeze({
    entry: 'executor.pre-fund:mpt-import',
    inspector: 'inspector.pre-fund:mpt-import',
    scope: 'scope.pre-fund:mpt-import',
    resultValidator: 'result-validator.pre-fund:mpt-import'
  }),
  [PRE_FUND_MPT_REPAIR_ACTION]: Object.freeze({
    entry: 'executor.pre-fund:mpt-repair-import',
    inspector: 'inspector.pre-fund:mpt-repair-import',
    scope: 'scope.pre-fund:mpt-repair-import',
    resultValidator: 'result-validator.pre-fund:mpt-repair-import'
  })
});

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});
const IMPORT_WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});
const PARSER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});
const REPAIR_WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 201326592
});

function preFundMptPolicy(actionKey) {
  const repair = actionKey === PRE_FUND_MPT_REPAIR_ACTION;
  const keys = PRE_FUND_MPT_STATIC_KEYS[actionKey];
  return Object.freeze({
    actionKey,
    moduleId: 'pre-fund',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: repair ? 'thread-single' : 'thread-pool',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: keys.entry,
    lifetime: 'job',
    context: { kind: 'file-batch', validatorKey: 'exact-7' },
    ...(repair ? {} : {
      workUnits: {
        kind: 'file',
        ordering: 'input-index-reducer',
        requestedMaxWorkers: 4,
        minUnitsPerWorker: 2,
        plannerKey: 'planner.pre-fund:mpt-import',
        reducerKey: 'reducer.pre-fund:mpt-import'
      }
    }),
    resources: {
      profile: `resource.${actionKey}`,
      base: repair ? ZERO_RESOURCES : {
        cpuSlots: 0,
        workerThreadSlots: 1,
        utilityProcessSlots: 0,
        ioHeavySlots: 0,
        memoryBytes: 33554432
      },
      phase: repair ? REPAIR_WRITER_RESOURCES : IMPORT_WRITER_RESOURCES,
      compound: repair ? {
        topologyKey: 'topology.pre-fund:mpt-repair-import',
        childrenMax: 1,
        childResource: PARSER_RESOURCES
      } : {
        topologyKey: 'topology.pre-fund:mpt-import',
        childrenMax: 4,
        childResource: PARSER_RESOURCES
      },
      lowMemoryBehavior: repair ? 'queue' : 'downgrade-to-single',
      admissionPriority: 'normal'
    },
    cancellation: {
      capability: 'shutdown-only',
      safePoints: ['before-critical', 'between-units'],
      cooperativeTimeoutMs: 5000,
      terminateTimeoutMs: 5000,
      protectedResult: 'protected/not-cancellable'
    },
    failure: {
      unitBusinessError: 'collect-and-continue',
      unitTransportCrash: 'fail-unit-and-continue',
      workerExit: 'module-inspect',
      automaticRetry: false
    },
    commit: {
      kind: 'worker-durable',
      criticalIntent: true,
      receiptKind: 'module-local',
      inspectorKey: keys.inspector,
      conflictScopeResolverKey: keys.scope,
      settlementKey: null
    },
    result: {
      kind: repair ? 'compact-json' : 'spool-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: keys.resultValidator
    },
    artifacts: {
      kind: 'none',
      filePlanRequired: false,
      technicalValidatorKey: null,
      businessValidatorKey: null,
      publisherKey: null,
      maxArtifacts: 0
    },
    service: null,
    metrics: {
      phases: ['queue', 'execute', 'settle'],
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    },
    featureFlag: `feature.${actionKey}`,
    legacyStrategyKey: `legacy.${actionKey}`,
    blocker: null,
    production: {
      enabled: false,
      effectiveMode: 'legacy',
      effectiveWorkerCount: 0,
      recoveryStatus: 'probe',
      evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    },
    protocolLimits: {
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    }
  });
}

function validateFileResult(item, { allowManagedRepairEvidence = false } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      !['ok', 'failed'].includes(item.status) || typeof item.fileName !== 'string') return false;
  if (item.status === 'ok') {
    return Object.keys(item).sort().join(',') ===
      'excludedRowCount,fileName,importStatus,rowCount,sourceType,status' &&
      safeMptFileName(item.fileName) === item.fileName &&
      ['imported', 'replaced', 'noop'].includes(item.importStatus) &&
      ['MPT_INBOUND_GATEWAY', 'MPT_OUTBOUND_GATEWAY'].includes(item.sourceType) &&
      Number.isSafeInteger(item.rowCount) && item.rowCount >= 0 &&
      Number.isSafeInteger(item.excludedRowCount) && item.excludedRowCount >= 0;
  }
  const keys = Object.keys(item).sort().join(',');
  if (!['code,detailLines,fileName,message,status',
    'code,detailLines,fileName,managedRepairEvidence,message,status'].includes(keys) ||
      safeMptFileName(item.fileName) !== item.fileName ||
      !isSafeMptErrorCode(item.code) || !isSafeMptErrorText(item.message) ||
      !isSafeMptDetailLines(item.detailLines)) return false;
  if (!item.managedRepairEvidence) return true;
  if (!allowManagedRepairEvidence) return false;
  const evidence = item.managedRepairEvidence;
  return evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === 'contentHash,rowErrorCount,sourceBatch,sourceType' &&
    ['MPT_INBOUND_GATEWAY', 'MPT_OUTBOUND_GATEWAY'].includes(evidence.sourceType) &&
    typeof evidence.sourceBatch === 'string' && evidence.sourceBatch.length > 0 &&
    /^[a-f0-9]{64}$/.test(evidence.contentHash) &&
    Number.isSafeInteger(evidence.rowErrorCount) && evidence.rowErrorCount > 0;
}

function validatePreFundMptParentResult(value, actionKey) {
  // Native unit:done与job:done共用冻结的action validator key；unit结果是单文件
  // golden，parent结果是等长聚合，故validator必须精确接受这两个既有shape。
  const repair = actionKey === PRE_FUND_MPT_REPAIR_ACTION;
  if (!repair && actionKey !== PRE_FUND_MPT_IMPORT_ACTION) return false;
  const validateActionFileResult = (item) => validateFileResult(item, {
    allowManagedRepairEvidence: !repair
  });
  if (validateActionFileResult(value)) return true;
  const expectedParentKeys = repair
    ? 'excludedRowCount,failedCount,importedRowCount,results,status,successCount'
    : 'failedCount,results,status,successCount';
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'ok' ||
      Object.keys(value).sort().join(',') !== expectedParentKeys ||
      !Array.isArray(value.results) || !value.results.every(validateActionFileResult) ||
      !Number.isSafeInteger(value.successCount) || !Number.isSafeInteger(value.failedCount) ||
      value.successCount + value.failedCount !== value.results.length ||
      value.successCount !== value.results.filter((item) => item.status === 'ok').length) return false;
  if (repair) {
    for (const key of ['importedRowCount', 'excludedRowCount']) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) return false;
    }
  }
  return true;
}

function validatePreFundMptImportResult(value) {
  return validatePreFundMptParentResult(value, PRE_FUND_MPT_IMPORT_ACTION);
}

function validatePreFundMptRepairResult(value) {
  return validatePreFundMptParentResult(value, PRE_FUND_MPT_REPAIR_ACTION);
}

Object.defineProperty(validatePreFundMptImportResult, 'allowFinanceSafeValue', {
  value: allowMptFinanceSafeValue
});
Object.defineProperty(validatePreFundMptRepairResult, 'allowFinanceSafeValue', {
  value: allowMptFinanceSafeValue
});

const PRE_FUND_MPT_POLICIES = Object.freeze([
  preFundMptPolicy(PRE_FUND_MPT_IMPORT_ACTION),
  preFundMptPolicy(PRE_FUND_MPT_REPAIR_ACTION)
]);

module.exports = {
  PRE_FUND_MPT_IMPORT_ACTION,
  PRE_FUND_MPT_POLICIES,
  PRE_FUND_MPT_REPAIR_ACTION,
  PRE_FUND_MPT_STATIC_KEYS,
  preFundMptPolicy,
  validatePreFundMptImportResult,
  validatePreFundMptParentResult,
  validatePreFundMptRepairResult
};
