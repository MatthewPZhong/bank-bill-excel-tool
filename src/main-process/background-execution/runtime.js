'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('./execution-policy-registry');
const { createResourceGovernor } = require('./resource-governor');
const { createExecutionSupervisor } = require('./supervisor');
const {
  TOOLBOX_GENERATION_ACTIONS,
  validateToolboxGenerationResult
} = require('../toolbox-background/generation-contract');
const {
  TOOLBOX_GENERATION_POLICIES
} = require('../toolbox-background/policies');

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = TOOLBOX_GENERATION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

function createBackgroundExecutionRuntime(options = {}) {
  const workerRoot = path.resolve(__dirname, '..', 'toolbox-background');
  const entryRegistry = createStaticRegistry(Object.fromEntries(
    TOOLBOX_GENERATION_POLICIES.map((policy) => [policy.entryKey, {
      path: path.join(
        workerRoot,
        policy.actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE
          ? 'merge-worker-entry.js'
          : 'split-worker-entry.js'
      ),
      cancellationTerminalErrorCodes: ['TOOLBOX_GENERATION_CANCELLED']
    }])
  ));
  const validatorEntries = {};
  for (const policy of TOOLBOX_GENERATION_POLICIES) {
    const resultValidator = (value) => validateToolboxGenerationResult(value, policy.actionKey);
    validatorEntries[policy.result.validatorKey] = resultValidator;
    // Main explicitly executes the asynchronous technical/business validators before Publisher.
    // Registry bindings remain synchronous capability declarations for static contract coverage.
    validatorEntries[policy.artifacts.technicalValidatorKey] = resultValidator;
    validatorEntries[policy.artifacts.businessValidatorKey] = resultValidator;
  }
  const validatorRegistry = createStaticRegistry(validatorEntries);
  entryRegistry.freeze();
  validatorRegistry.freeze();

  const staticKeys = {
    resourceProfileKeys: TOOLBOX_GENERATION_POLICIES.map((policy) => policy.resources.profile),
    inspectorKeys: TOOLBOX_GENERATION_POLICIES.map((policy) => policy.commit.inspectorKey),
    conflictScopeResolverKeys: TOOLBOX_GENERATION_POLICIES.map(
      (policy) => policy.commit.conflictScopeResolverKey
    ),
    settlementKeys: TOOLBOX_GENERATION_POLICIES.map((policy) => policy.commit.settlementKey),
    publisherKeys: TOOLBOX_GENERATION_POLICIES.map((policy) => policy.artifacts.publisherKey)
  };
  const policyRegistry = createExecutionPolicyRegistry({
    policies: TOOLBOX_GENERATION_POLICIES,
    entryRegistry,
    validatorRegistry,
    staticKeys,
    generatedAt: '2026-08-25T00:00:00+08:00'
  });
  policyRegistry.freeze();
  const memoryBudget = Math.max(512 * 1024 * 1024, Math.floor(os.totalmem() / 4));
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 1,
      workerThreadSlots: 1,
      utilityProcessSlots: 0,
      ioHeavySlots: 1,
      memoryBytes: memoryBudget
    },
    diagnostics: options.diagnostics
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    diagnostics: options.diagnostics,
    executionTimeoutMs: options.executionTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 5000
  });
  return Object.freeze({
    execute(request) {
      return supervisor.execute(request);
    },
    inspect(jobId) {
      return supervisor.inspect(jobId);
    },
    policyRegistry,
    resourceGovernor,
    shutdown(shutdownOptions) {
      return supervisor.shutdown(shutdownOptions);
    },
    stopAcceptingNewJobs() {
      supervisor.stopAcceptingNewJobs();
    }
  });
}

function createBackgroundExecutionRuntimeManager(options = {}) {
  const runtimeFactory = options.runtimeFactory || (() => createBackgroundExecutionRuntime(options));
  let runtime = null;
  let closing = false;
  let shutdownPromise = null;
  let shutdownReport = null;

  return Object.freeze({
    get() {
      if (closing) {
        const error = new Error('后台执行 runtime 正在关闭');
        error.code = 'BACKGROUND_EXECUTION_RUNTIME_CLOSING';
        throw error;
      }
      if (!runtime) runtime = runtimeFactory();
      return runtime;
    },
    isProductionEnabled(actionKey) {
      return isBackgroundExecutionProductionEnabled(actionKey);
    },
    peek() {
      return runtime;
    },
    resume() {
      if (shutdownPromise) throw new Error('后台执行 runtime 尚未完成关闭');
      closing = false;
      shutdownReport = null;
    },
    shutdown(shutdownOptions = {}) {
      if (shutdownPromise) return shutdownPromise;
      if (!runtime) {
        closing = true;
        return Promise.resolve(shutdownReport || Object.freeze({
          closedServices: Object.freeze([]),
          cancelledJobs: Object.freeze([]),
          protectedJobs: Object.freeze([]),
          interruptedTasks: Object.freeze([]),
          activeHolds: Object.freeze([]),
          leakedTransports: Object.freeze([]),
          errors: Object.freeze([])
        }));
      }
      closing = true;
      const ownedRuntime = runtime;
      runtime = null;
      ownedRuntime.stopAcceptingNewJobs();
      shutdownPromise = Promise.resolve(ownedRuntime.shutdown(shutdownOptions))
        .then((report) => {
          shutdownReport = report;
          return report;
        })
        .finally(() => {
          shutdownPromise = null;
        });
      return shutdownPromise;
    },
    snapshot() {
      return Object.freeze({
        active: Boolean(runtime),
        closing,
        shutdownPending: Boolean(shutdownPromise)
      });
    }
  });
}

module.exports = {
  createBackgroundExecutionRuntime,
  createBackgroundExecutionRuntimeManager,
  isBackgroundExecutionProductionEnabled
};
