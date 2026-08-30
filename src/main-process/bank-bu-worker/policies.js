'use strict';

const BANK_BU_ACTIONS = Object.freeze({
  IMPORT_MONTH: 'bank-bu:import-month',
  RUN: 'bank-bu:run',
  EXPORT_SINGLE: 'bank-bu:export-single',
  EXPORT_AGGREGATE: 'bank-bu:export-aggregate'
});

const ZERO = Object.freeze({
  cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 0
});
const IMPORT_BASE = Object.freeze({ ...ZERO, workerThreadSlots: 1, memoryBytes: 33554432 });
const IMPORT_PHASE = Object.freeze({
  ...ZERO, cpuSlots: 1, workerThreadSlots: 1, ioHeavySlots: 1, memoryBytes: 268435456
});
const SINGLE_PHASE = Object.freeze({
  ...ZERO, cpuSlots: 1, workerThreadSlots: 1, ioHeavySlots: 1, memoryBytes: 201326592
});

function policy(actionKey) {
  const values = Object.values(BANK_BU_ACTIONS);
  if (!values.includes(actionKey)) throw new TypeError(`未知BankBU action：${String(actionKey)}`);
  const mutation = actionKey === BANK_BU_ACTIONS.IMPORT_MONTH || actionKey === BANK_BU_ACTIONS.RUN;
  const importing = actionKey === BANK_BU_ACTIONS.IMPORT_MONTH;
  return Object.freeze({
    actionKey,
    moduleId: 'bank-bu',
    description: `v3.2.x canonical policy fixture for ${actionKey}`,
    disposition: 'managed',
    mode: importing ? 'thread-pool' : 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.${actionKey}`,
    lifetime: 'job',
    context: { kind: 'operation', validatorKey: 'exact-5' },
    resources: {
      profile: `resource.${actionKey}`,
      base: importing ? IMPORT_BASE : ZERO,
      phase: importing ? IMPORT_PHASE : SINGLE_PHASE,
      compound: importing ? {
        topologyKey: 'topology.bank-bu:import-month',
        childrenMax: 4,
        childResource: IMPORT_PHASE
      } : null,
      lowMemoryBehavior: importing ? 'downgrade-to-single' : 'queue',
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
      unitBusinessError: 'fail-job', unitTransportCrash: 'fail-job',
      workerExit: 'module-inspect', automaticRetry: false
    },
    commit: mutation ? {
      kind: 'worker-durable', criticalIntent: true, receiptKind: 'module-local',
      inspectorKey: `inspector.${actionKey}`,
      conflictScopeResolverKey: `scope.${actionKey}`,
      settlementKey: null
    } : {
      kind: 'main-settlement', criticalIntent: false, receiptKind: 'publisher-journal',
      inspectorKey: `inspector.${actionKey}`,
      conflictScopeResolverKey: `scope.${actionKey}`,
      settlementKey: `settlement.${actionKey}`
    },
    result: {
      kind: importing ? 'spool-manifest' : (mutation ? 'compact-json' : 'artifact-manifest'),
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.${actionKey}`
    },
    artifacts: mutation ? {
      kind: 'none', filePlanRequired: false, technicalValidatorKey: null,
      businessValidatorKey: null, publisherKey: null, maxArtifacts: 0
    } : {
      kind: 'single', filePlanRequired: true,
      technicalValidatorKey: `technical-validator.${actionKey}`,
      businessValidatorKey: `business-validator.${actionKey}`,
      publisherKey: `publisher.${actionKey}`,
      maxArtifacts: 1
    },
    service: null,
    metrics: {
      phases: ['queue', 'execute', 'settle'],
      privacyProfile: 'finance-safe-v1', progressRateLimitPerSecond: 10
    },
    featureFlag: `feature.${actionKey}`,
    legacyStrategyKey: `legacy.${actionKey}`,
    blocker: null,
    production: {
      enabled: false, effectiveMode: 'legacy', effectiveWorkerCount: 0,
      recoveryStatus: 'probe', evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    },
    ...(importing ? {
      workUnits: {
        kind: 'role', ordering: 'input-index-reducer', requestedMaxWorkers: 4,
        minUnitsPerWorker: 2, plannerKey: 'planner.bank-bu:import-month',
        reducerKey: 'reducer.bank-bu:import-month'
      }
    } : {}),
    protocolLimits: { commandMaxBytes: 262144, eventMaxBytes: 262144 }
  });
}

const BANK_BU_POLICIES = Object.freeze(Object.values(BANK_BU_ACTIONS).map(policy));

module.exports = { BANK_BU_ACTIONS, BANK_BU_POLICIES, bankBuPolicy: policy };
