'use strict';

const { TOOLBOX_GENERATION_ACTIONS } = require('./generation-contract');

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const GENERATION_PHASE_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 201326592
});

const ROUTE_WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 201326592
});

function toolboxGenerationPolicy(actionKey) {
  const isMerge = actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE;
  const suffix = isMerge ? 'merge' : 'split-single';
  return Object.freeze({
    actionKey,
    moduleId: 'toolbox',
    description: `v3.2.1 E04-A native one-shot generation for ${actionKey}`,
    disposition: 'managed',
    mode: 'thread-single',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: `executor.toolbox:${suffix}`,
    lifetime: 'job',
    context: { kind: 'operation', validatorKey: 'exact-5' },
    resources: {
      profile: `resource.toolbox:${suffix}`,
      base: ZERO_RESOURCES,
      phase: GENERATION_PHASE_RESOURCES,
      compound: null,
      lowMemoryBehavior: 'queue',
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
      unitBusinessError: 'fail-job',
      unitTransportCrash: 'fail-job',
      workerExit: 'module-inspect',
      automaticRetry: false
    },
    commit: {
      kind: 'main-settlement',
      criticalIntent: false,
      receiptKind: 'publisher-journal',
      inspectorKey: `inspector.toolbox:${suffix}`,
      conflictScopeResolverKey: `scope.toolbox:${suffix}`,
      settlementKey: `settlement.toolbox:${suffix}`
    },
    result: {
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: `result-validator.toolbox:${suffix}`
    },
    artifacts: {
      kind: isMerge ? 'single' : 'all-or-none',
      filePlanRequired: true,
      technicalValidatorKey: `technical-validator.toolbox:${suffix}`,
      businessValidatorKey: `business-validator.toolbox:${suffix}`,
      publisherKey: `publisher.toolbox:${suffix}`,
      maxArtifacts: 1
    },
    service: null,
    metrics: {
      phases: ['queue', 'execute', 'settle'],
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    },
    featureFlag: `feature.toolbox:${suffix}`,
    legacyStrategyKey: `legacy.toolbox:${suffix}`,
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

function toolboxMultiOutputPolicy() {
  const actionKey = TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT;
  return Object.freeze({
    actionKey,
    moduleId: 'toolbox',
    description: 'v3.2.1 E04-B single Scanner and single read-only Writer capability',
    disposition: 'managed',
    mode: 'thread-pool',
    adapterKind: 'native',
    adapterKey: null,
    entryKey: 'executor.toolbox:split-multi-output',
    lifetime: 'job',
    context: { kind: 'operation', validatorKey: 'exact-5' },
    workUnits: {
      kind: 'output',
      ordering: 'module-defined',
      requestedMaxWorkers: 1,
      minUnitsPerWorker: 1,
      plannerKey: null,
      reducerKey: null
    },
    resources: {
      profile: 'resource.toolbox:split-multi-output',
      base: ZERO_RESOURCES,
      phase: ROUTE_WRITER_RESOURCES,
      compound: {
        topologyKey: 'topology.toolbox:split-multi-output',
        childrenMax: 1,
        childResource: ROUTE_WRITER_RESOURCES
      },
      lowMemoryBehavior: 'queue',
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
      unitBusinessError: 'fail-job',
      unitTransportCrash: 'fail-job',
      workerExit: 'module-inspect',
      automaticRetry: false
    },
    commit: {
      kind: 'main-settlement',
      criticalIntent: false,
      receiptKind: 'publisher-journal',
      inspectorKey: 'inspector.toolbox:split-multi-output',
      conflictScopeResolverKey: 'scope.toolbox:split-multi-output',
      settlementKey: 'settlement.toolbox:split-multi-output'
    },
    result: {
      kind: 'artifact-manifest',
      maxBytes: 8388608,
      maxErrorItems: 100,
      validatorKey: 'result-validator.toolbox:split-multi-output'
    },
    artifacts: {
      kind: 'all-or-none',
      filePlanRequired: true,
      technicalValidatorKey: 'technical-validator.toolbox:split-multi-output',
      businessValidatorKey: 'business-validator.toolbox:split-multi-output',
      publisherKey: 'publisher.toolbox:split-multi-output',
      maxArtifacts: 8
    },
    service: null,
    metrics: {
      phases: ['queue', 'scan', 'write', 'settle'],
      privacyProfile: 'finance-safe-v1',
      progressRateLimitPerSecond: 10
    },
    featureFlag: 'feature.toolbox:split-multi-output',
    legacyStrategyKey: 'legacy.toolbox:split-multi-output',
    blocker: null,
    production: {
      enabled: false,
      effectiveMode: 'legacy',
      effectiveWorkerCount: 0,
      recoveryStatus: 'probe',
      evidenceStatus: 'baseline',
      downgradeReason: 'Windows durability and production performance gates not yet passed',
      benchmarkEvidenceId: null
    },
    protocolLimits: {
      commandMaxBytes: 262144,
      eventMaxBytes: 262144
    }
  });
}

const TOOLBOX_GENERATION_POLICIES = Object.freeze([
  toolboxGenerationPolicy(TOOLBOX_GENERATION_ACTIONS.MERGE),
  toolboxGenerationPolicy(TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE),
  toolboxMultiOutputPolicy()
]);

module.exports = {
  TOOLBOX_GENERATION_POLICIES,
  toolboxMultiOutputPolicy,
  toolboxGenerationPolicy
};
