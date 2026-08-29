'use strict';

const { NEW_ACCOUNT_GENERATION_ACTION } = require('./generation-contract');

const ZERO_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 0,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 0
});

const GENERATION_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 268435456
});

const NEW_ACCOUNT_GENERATION_POLICY = Object.freeze({
  actionKey: NEW_ACCOUNT_GENERATION_ACTION,
  moduleId: 'new-account',
  description: 'v3.2.3 E10-A NewAccount native one-shot workbook generation',
  disposition: 'managed',
  mode: 'thread-single',
  adapterKind: 'native',
  adapterKey: null,
  entryKey: 'executor.new-account:generate',
  lifetime: 'job',
  context: { kind: 'operation', validatorKey: 'exact-5' },
  resources: {
    profile: 'resource.new-account:generate',
    base: ZERO_RESOURCES,
    phase: GENERATION_RESOURCES,
    compound: null,
    lowMemoryBehavior: 'queue',
    admissionPriority: 'normal'
  },
  cancellation: {
    capability: 'shutdown-only',
    safePoints: ['before-write', 'after-write', 'after-readback', 'before-terminal'],
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
    inspectorKey: 'inspector.new-account:generate',
    conflictScopeResolverKey: 'scope.new-account:generate',
    settlementKey: 'settlement.new-account:generate'
  },
  result: {
    kind: 'artifact-manifest',
    maxBytes: 262144,
    maxErrorItems: 100,
    validatorKey: 'result-validator.new-account:generate'
  },
  artifacts: {
    kind: 'single',
    filePlanRequired: true,
    technicalValidatorKey: 'technical-validator.new-account:generate',
    businessValidatorKey: 'business-validator.new-account:generate',
    publisherKey: 'publisher.new-account:generate',
    maxArtifacts: 1
  },
  service: null,
  metrics: {
    phases: ['queue', 'execute', 'settle'],
    privacyProfile: 'finance-safe-v1',
    progressRateLimitPerSecond: 10
  },
  featureFlag: 'feature.new-account:generate',
  legacyStrategyKey: 'legacy.new-account:generate',
  blocker: null,
  production: {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'E10-B Publisher and R3.2.3 Windows/manual gates not yet passed',
    benchmarkEvidenceId: null
  },
  protocolLimits: {
    commandMaxBytes: 262144,
    eventMaxBytes: 262144
  }
});

module.exports = {
  GENERATION_RESOURCES,
  NEW_ACCOUNT_GENERATION_POLICY,
  ZERO_RESOURCES
};
