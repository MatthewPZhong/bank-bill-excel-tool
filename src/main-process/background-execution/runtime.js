'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('./execution-policy-registry');
const { createPlatformResourceBudgets } = require('./resource-budget');
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
  PRE_FUND_MPT_IMPORT_ACTION,
  PRE_FUND_MPT_REPAIR_ACTION,
  validatePreFundMptImportResult,
  validatePreFundMptRepairResult
} = require('../pre-fund-reconciliation/mpt-import/policies');
const {
  createPreFundMptTopologyPlanner
} = require('../pre-fund-reconciliation/mpt-import/topology');
const {
  validateNewAccountGenerationResult
} = require('../new-account/generation-contract');
const {
  NEW_ACCOUNT_GENERATION_POLICY
} = require('../new-account/policies');
const {
  estimateNewAccountGenerationPhaseResources
} = require('../new-account/resource-estimator');
const {
  FUND_RECON_POLICIES,
  FUND_RECON_SERVICE_KEY,
  validateFundReconExportResult,
  validateFundReconImportResult,
  validateFundReconRunResult
} = require('../fund-recon-worker/policies');
const {
  DUPLICATE_ACTIONS,
  DUPLICATE_POLICIES,
  DUPLICATE_SERVICE_KEY,
  validateDuplicateExportResult,
  validateDuplicateImportResult,
  validateDuplicateRunResult
} = require('../duplicate-inbound-match/policies');
const {
  normalizeDuplicateStartupGateDescriptor
} = require('../duplicate-inbound-match/startup-gate');
const {
  createDuplicatePairedTopologyPlanner
} = require('../duplicate-inbound-match/topology');
const {
  beginExternalParserShutdown,
  waitForExternalParserShutdownPhase
} = require('./external-parser-finalization');

const BACKGROUND_EXECUTION_POLICIES = Object.freeze([
  ...TOOLBOX_GENERATION_POLICIES,
  ...PRE_FUND_MPT_POLICIES,
  NEW_ACCOUNT_GENERATION_POLICY,
  ...FUND_RECON_POLICIES,
  ...DUPLICATE_POLICIES
]);

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = BACKGROUND_EXECUTION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

function deadlineAfter(timeoutMs) {
  const timestamp = Date.now();
  return timeoutMs > Number.MAX_SAFE_INTEGER - timestamp
    ? Number.POSITIVE_INFINITY
    : timestamp + timeoutMs;
}

function remainingTimeout(deadline) {
  return deadline === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, deadline - Date.now());
}

function mergeShutdownReports(report, ...pairedReports) {
  return Object.freeze({
    ...report,
    leakedTransports: Object.freeze([...new Set([
      ...report.leakedTransports,
      ...pairedReports.flatMap((item) => item.leakedTransports)
    ])]),
    errors: Object.freeze([
      ...report.errors,
      ...pairedReports.flatMap((item) => item.errors)
    ])
  });
}

function entryBindingForPolicy(policy, workerRoot, duplicateStartupGate) {
  if (policy.moduleId === 'duplicate') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'duplicate-inbound-match', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['DUPLICATE_SHUTDOWN']),
      workerData: Object.freeze({ startupGate: duplicateStartupGate })
    });
  }
  if (policy.moduleId === 'fund-recon') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'fund-recon-worker', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['FUND_RECON_SHUTDOWN'])
    });
  }
  if (policy.moduleId === 'new-account') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'new-account', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['NEW_ACCOUNT_GENERATION_CANCELLED'])
    });
  }
  const preFund = policy.moduleId === 'pre-fund';
  return Object.freeze({
    path: path.join(
      preFund
        ? path.resolve(__dirname, '..', 'pre-fund-reconciliation', 'mpt-import')
        : workerRoot,
      preFund
        ? 'writer-worker-entry.js'
        : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE
            ? 'merge-worker-entry.js'
            : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
                ? 'route-scanner-worker-entry.js'
                : 'split-worker-entry.js'))
    ),
    cancellationTerminalErrorCodes: Object.freeze(preFund
      ? ['PREFUND_WRITER_CANCELLED']
      : ['TOOLBOX_GENERATION_CANCELLED'])
  });
}

function createBackgroundExecutionRuntimeInternal(options, resourceGovernorOverride = null) {
  const availableParallelism = options.availableParallelism === undefined
    ? (typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : Math.max(1, os.cpus().length))
    : options.availableParallelism;
  const platformBudgets = createPlatformResourceBudgets({
    availableParallelism,
    ...(options.freeMemoryBytes === undefined ? {} : { freeMemoryBytes: options.freeMemoryBytes }),
    ...(options.totalMemoryBytes === undefined ? {} : { totalMemoryBytes: options.totalMemoryBytes }),
    ...(options.memoryHardCeilingBytes === undefined
      ? {}
      : { memoryHardCeilingBytes: options.memoryHardCeilingBytes }),
    ...(options.systemReserveBytes === undefined
      ? {}
      : { systemReserveBytes: options.systemReserveBytes })
  });
  const workerRoot = path.resolve(__dirname, '..', 'toolbox-background');
  const duplicateStartupGate = normalizeDuplicateStartupGateDescriptor(
    options.duplicateStartupGate
  );
  const entryRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES.map((policy) => [
      policy.entryKey,
      entryBindingForPolicy(policy, workerRoot, duplicateStartupGate)
    ])
  ));
  const validatorEntries = {};
  for (const policy of BACKGROUND_EXECUTION_POLICIES) {
    const resultValidator = policy.moduleId === 'duplicate'
      ? (policy.actionKey === DUPLICATE_ACTIONS.IMPORT
          ? validateDuplicateImportResult
          : (policy.actionKey === DUPLICATE_ACTIONS.RUN
              ? validateDuplicateRunResult
              : validateDuplicateExportResult))
      : policy.moduleId === 'fund-recon'
      ? (policy.actionKey === 'fund-recon:import'
          ? validateFundReconImportResult
          : (policy.actionKey === 'fund-recon:run'
              ? validateFundReconRunResult
              : validateFundReconExportResult))
      : policy.moduleId === 'pre-fund'
      ? (policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
          ? validatePreFundMptRepairResult
          : validatePreFundMptImportResult)
      : (policy.moduleId === 'new-account'
          ? validateNewAccountGenerationResult
          : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
          ? validateToolboxMultiGenerationResult
          : (value) => validateToolboxGenerationResult(value, policy.actionKey)));
    validatorEntries[policy.result.validatorKey] = resultValidator;
    // Main explicitly executes the asynchronous technical/business validators before Publisher.
    // Registry bindings remain synchronous capability declarations for static contract coverage.
    validatorEntries[policy.artifacts.technicalValidatorKey] = resultValidator;
    validatorEntries[policy.artifacts.businessValidatorKey] = resultValidator;
  }
  const validatorRegistry = createStaticRegistry(validatorEntries);
  const resourceProfileRegistry = createStaticRegistry({
    [NEW_ACCOUNT_GENERATION_POLICY.resources.profile]: estimateNewAccountGenerationPhaseResources
  });
  const preFundTopologyPlanner = createPreFundMptTopologyPlanner({ availableParallelism });
  const duplicateTopologyPlanner = createDuplicatePairedTopologyPlanner({ availableParallelism });
  const topologyRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES
      .filter((policy) => policy.resources.compound)
      .map((policy) => [policy.resources.compound.topologyKey,
        policy.actionKey === PRE_FUND_MPT_IMPORT_ACTION || policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
          ? preFundTopologyPlanner
          : (policy.actionKey === DUPLICATE_ACTIONS.IMPORT
              ? duplicateTopologyPlanner
              : () => Object.freeze({ effectiveChildCount: 1 }))])
  ));
  entryRegistry.freeze();
  validatorRegistry.freeze();
  resourceProfileRegistry.freeze();
  topologyRegistry.freeze();

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
    serviceKeys: [FUND_RECON_SERVICE_KEY, DUPLICATE_SERVICE_KEY],
    plannerKeys: ['planner.pre-fund:mpt-import', 'planner.duplicate:import'],
    reducerKeys: ['reducer.pre-fund:mpt-import', 'reducer.duplicate:import']
  };
  const policyRegistry = createExecutionPolicyRegistry({
    policies: BACKGROUND_EXECUTION_POLICIES,
    entryRegistry,
    validatorRegistry,
    resourceProfileRegistry,
    topologyRegistry,
    staticKeys,
    generatedAt: '2026-08-25T00:00:00+08:00'
  });
  policyRegistry.freeze();
  // PreFund topology可以请求false-gated Pool，但不得扩大全局E00预算；
  // Governor是native admission的唯一资源权威。
  const resourceGovernor = resourceGovernorOverride || createResourceGovernor({
    budgets: platformBudgets,
    diagnostics: options.diagnostics
  });
  const supervisorShutdownTimeoutMs = options.shutdownTimeoutMs || 5000;
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    diagnostics: options.diagnostics,
    executionTimeoutMs: options.executionTimeoutMs,
    shutdownTimeoutMs: supervisorShutdownTimeoutMs,
    workerDurableCoordinator: options.workerDurableCoordinator,
    ...(options.workerThreadAdapter ? { workerThreadAdapter: options.workerThreadAdapter } : {})
  });
  let shutdownPromise = null;
  const runtime = Object.freeze({
    start(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return supervisor.start(request);
    },
    execute(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return supervisor.execute(request);
    },
    inspect(jobId) {
      return supervisor.inspect(jobId);
    },
    policyRegistry,
    resourceGovernor,
    shutdown(shutdownOptions = {}) {
      if (shutdownPromise) return shutdownPromise;
      const fallbackTimeoutMs = Number.isFinite(supervisorShutdownTimeoutMs) &&
        supervisorShutdownTimeoutMs >= 0
        ? supervisorShutdownTimeoutMs
        : 5000;
      let timeoutMs;
      try {
        timeoutMs = Number.isFinite(shutdownOptions.timeoutMs) && shutdownOptions.timeoutMs >= 0
          ? shutdownOptions.timeoutMs
          : fallbackTimeoutMs;
      } catch (error) {
        return Promise.reject(error);
      }
      supervisor.stopAcceptingNewJobs();
      const deadline = deadlineAfter(timeoutMs);
      const parserSession = beginExternalParserShutdown(runtime);
      shutdownPromise = Promise.resolve().then(async () => {
        const workerReport = await waitForExternalParserShutdownPhase(
          parserSession,
          'workersTerminal',
          remainingTimeout(deadline)
        );
        const supervisorReport = await supervisor.shutdown({
          ...shutdownOptions,
          timeoutMs: remainingTimeout(deadline)
        });
        const finalizationReport = await waitForExternalParserShutdownPhase(
          parserSession,
          'finalized',
          remainingTimeout(deadline)
        );
        return mergeShutdownReports(
          supervisorReport,
          Object.freeze({
            leakedTransports: Object.freeze([]),
            errors: parserSession.errors
          }),
          workerReport,
          finalizationReport
        );
      }).finally(() => {
        shutdownPromise = null;
      });
      return shutdownPromise;
    },
    stopAcceptingNewJobs() {
      supervisor.stopAcceptingNewJobs();
    }
  });
  return runtime;
}

function assertNonProductionGovernorRequest(request) {
  const descriptor = request && typeof request === 'object'
    ? Object.getOwnPropertyDescriptor(request, 'production')
    : null;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) return;
  const error = new Error('隔离ResourceGovernor不得执行production request');
  error.code = 'BACKGROUND_EXECUTION_RESOURCE_GOVERNOR_OVERRIDE_FORBIDDEN';
  throw error;
}

function createBackgroundExecutionRuntime(options = {}) {
  if (options && Object.hasOwn(options, 'resourceGovernor')) {
    throw new TypeError('resourceGovernor override只允许显式non-production runtime');
  }
  return createBackgroundExecutionRuntimeInternal(options);
}

// 仅供false-gated测试/benchmark注入隔离Governor；不从production barrel导出，
// 且production request在Supervisor/admission前拒绝。
function createNonProductionBackgroundExecutionRuntime(options = {}) {
  if (!options || !Object.hasOwn(options, 'resourceGovernor') || !options.resourceGovernor) {
    throw new TypeError('non-production runtime需要显式resourceGovernor');
  }
  const { resourceGovernor, ...runtimeOptions } = options;
  return createBackgroundExecutionRuntimeInternal(runtimeOptions, resourceGovernor);
}

function createBackgroundExecutionRuntimeManager(options = {}) {
  const runtimeFactory = options.runtimeFactory || (() => {
    const duplicateStartupGate = typeof options.duplicateStartupGateProvider === 'function'
      ? options.duplicateStartupGateProvider()
      : options.duplicateStartupGate;
    return createBackgroundExecutionRuntime({
      ...options,
      duplicateStartupGate,
      workerDurableCoordinator: typeof options.workerDurableCoordinatorProvider === 'function'
        ? options.workerDurableCoordinatorProvider()
        : options.workerDurableCoordinator
    });
  });
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
  createNonProductionBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
};
