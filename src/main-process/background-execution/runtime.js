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
  validateToolboxGenerationResult,
  validateToolboxMultiGenerationResult
} = require('../toolbox-background/generation-contract');
const {
  TOOLBOX_GENERATION_POLICIES
} = require('../toolbox-background/policies');
const {
  PRE_FUND_MPT_POLICIES,
  validatePreFundMptParentResult
} = require('../pre-fund-reconciliation/mpt-import/policies');

const BACKGROUND_EXECUTION_POLICIES = Object.freeze([
  ...TOOLBOX_GENERATION_POLICIES,
  ...PRE_FUND_MPT_POLICIES
]);

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = BACKGROUND_EXECUTION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

function createBackgroundExecutionRuntime(options = {}) {
  const workerRoot = path.resolve(__dirname, '..', 'toolbox-background');
  const entryRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES.map((policy) => [policy.entryKey, {
      path: path.join(
        policy.moduleId === 'pre-fund'
          ? path.resolve(__dirname, '..', 'pre-fund-reconciliation', 'mpt-import')
          : workerRoot,
        policy.moduleId === 'pre-fund'
          ? 'writer-worker-entry.js'
          : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE
              ? 'merge-worker-entry.js'
              : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
                  ? 'route-scanner-worker-entry.js'
                  : 'split-worker-entry.js'))
      ),
      cancellationTerminalErrorCodes: policy.moduleId === 'pre-fund'
        ? ['PREFUND_WRITER_CANCELLED']
        : ['TOOLBOX_GENERATION_CANCELLED']
    }])
  ));
  const validatorEntries = {};
  for (const policy of BACKGROUND_EXECUTION_POLICIES) {
    const resultValidator = policy.moduleId === 'pre-fund'
      ? validatePreFundMptParentResult
      : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
          ? validateToolboxMultiGenerationResult
          : (value) => validateToolboxGenerationResult(value, policy.actionKey));
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
    resourceProfileKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.resources.profile),
    topologyKeys: BACKGROUND_EXECUTION_POLICIES
      .map((policy) => policy.resources.compound && policy.resources.compound.topologyKey)
      .filter(Boolean),
    inspectorKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.commit.inspectorKey),
    conflictScopeResolverKeys: BACKGROUND_EXECUTION_POLICIES.map(
      (policy) => policy.commit.conflictScopeResolverKey
    ),
    settlementKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.commit.settlementKey),
    publisherKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.artifacts.publisherKey),
    plannerKeys: ['planner.pre-fund:mpt-import'],
    reducerKeys: ['reducer.pre-fund:mpt-import']
  };
  const policyRegistry = createExecutionPolicyRegistry({
    policies: BACKGROUND_EXECUTION_POLICIES,
    entryRegistry,
    validatorRegistry,
    staticKeys,
    generatedAt: '2026-08-25T00:00:00+08:00'
  });
  policyRegistry.freeze();
  // E05-B capability最大单job拓扑为import base32MiB + Writer256MiB + Parser256MiB；
  // repair同样以Writer phase + exactly-one Parser child申报CompoundLease。
  const memoryBudget = Math.max(768 * 1024 * 1024, Math.floor(os.totalmem() / 4));
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 2,
      // E05-B false-gated capability以 effective parser=1 验证冻结 compound：
      // parent base + Writer phase + 1 parser child，恰需3个worker slot。
      workerThreadSlots: 3,
      utilityProcessSlots: 0,
      ioHeavySlots: 2,
      memoryBytes: memoryBudget
    },
    diagnostics: options.diagnostics
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    diagnostics: options.diagnostics,
    executionTimeoutMs: options.executionTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 5000,
    workerDurableCoordinator: options.workerDurableCoordinator
  });
  return Object.freeze({
    start(request) {
      return supervisor.start(request);
    },
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
  const runtimeFactory = options.runtimeFactory || (() => createBackgroundExecutionRuntime({
    ...options,
    workerDurableCoordinator: typeof options.workerDurableCoordinatorProvider === 'function'
      ? options.workerDurableCoordinatorProvider()
      : options.workerDurableCoordinator
  }));
  let runtime = null;
  let shutdownOwner = null;
  let closing = false;
  let shutdownPromise = null;
  let shutdownReport = null;
  let shutdownOutcome = 'none';

  function isCleanShutdownReport(report) {
    return Array.isArray(report && report.leakedTransports)
      && report.leakedTransports.length === 0
      && Array.isArray(report && report.errors)
      && report.errors.length === 0;
  }

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
      if (!closing) return;
      if (shutdownOwner || shutdownOutcome !== 'clean') {
        const error = new Error('后台执行 runtime 存在未解决的关闭失败');
        error.code = 'BACKGROUND_EXECUTION_RUNTIME_SHUTDOWN_UNRESOLVED';
        throw error;
      }
      closing = false;
      shutdownReport = null;
      shutdownOutcome = 'none';
    },
    shutdown(shutdownOptions = {}) {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      if (!shutdownOwner && runtime) {
        shutdownOwner = runtime;
        runtime = null;
        shutdownOutcome = 'unresolved';
        try {
          shutdownOwner.stopAcceptingNewJobs();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (!shutdownOwner) {
        shutdownOutcome = 'clean';
        shutdownReport = shutdownReport || Object.freeze({
          closedServices: Object.freeze([]),
          cancelledJobs: Object.freeze([]),
          protectedJobs: Object.freeze([]),
          interruptedTasks: Object.freeze([]),
          activeHolds: Object.freeze([]),
          leakedTransports: Object.freeze([]),
          errors: Object.freeze([])
        });
        return Promise.resolve(shutdownReport);
      }
      const ownedRuntime = shutdownOwner;
      let ownedShutdown;
      try {
        ownedShutdown = ownedRuntime.shutdown(shutdownOptions);
      } catch (error) {
        shutdownOutcome = 'unresolved';
        return Promise.reject(error);
      }
      shutdownPromise = Promise.resolve(ownedShutdown)
        .then((report) => {
          shutdownReport = report;
          if (isCleanShutdownReport(report)) {
            shutdownOwner = null;
            shutdownOutcome = 'clean';
          } else {
            shutdownOutcome = 'unresolved';
          }
          return report;
        }, (error) => {
          shutdownOutcome = 'unresolved';
          throw error;
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
  BACKGROUND_EXECUTION_POLICIES,
  createBackgroundExecutionRuntime,
  createBackgroundExecutionRuntimeManager,
  isBackgroundExecutionProductionEnabled
};
