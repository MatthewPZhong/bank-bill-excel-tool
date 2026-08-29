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
  RECON_FIX_EXPORT_ACTION,
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_POLICIES,
  RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_SERVICE_KEY,
  validateReconFixExportResult,
  validateReconFixJpmResult,
  validateReconFixServiceResult
} = require('../recon-id-fix-service/policies');
const {
  createReconFixJpmDatabaseAuthority
} = require('../recon-id-fix-service/jpm-database-authority');
const {
  createReconFixEvidenceSettlementAdmission
} = require('../recon-id-fix-service/evidence-settlement-admission');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_POLICY,
  validateVccExportSingleResult,
  validateVccExportSubjectsResult
} = require('../vcc-financial-op-output/policies');
const {
  createVccExportTopologyPlanner
} = require('../vcc-financial-op-output/topology');

const BACKGROUND_EXECUTION_POLICIES = Object.freeze([
  ...TOOLBOX_GENERATION_POLICIES,
  ...PRE_FUND_MPT_POLICIES,
  ...RECON_FIX_POLICIES,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_POLICY
]);

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = BACKGROUND_EXECUTION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

function createBackgroundExecutionRuntimeInternal(options, resourceGovernorOverride = null) {
  const reconFixJpmDatabaseAuthority = options.reconFixJpmDatabasePath === undefined ||
    options.reconFixJpmDatabasePath === null
    ? null
    : createReconFixJpmDatabaseAuthority(options.reconFixJpmDatabasePath);
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
  const reconFixEntry = Object.freeze({
    path: path.resolve(__dirname, '..', 'recon-id-fix-service', 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['RECON_FIX_CANCELLED'])
  });
  const vccExportSubjectsEntry = Object.freeze({
    path: path.resolve(__dirname, '..', 'vcc-financial-op-output', 'writer-worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['VCC_EXPORT_CANCELLED']),
    admittedTopologyWorkerData: true
  });
  const vccExportSingleEntry = Object.freeze({
    path: path.resolve(__dirname, '..', 'vcc-financial-op-output', 'single-writer-worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['VCC_EXPORT_CANCELLED'])
  });
  const entryRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES.map((policy) => {
      if (policy.moduleId === 'recon-fix') return [policy.entryKey, reconFixEntry];
      if (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
        return [policy.entryKey, vccExportSubjectsEntry];
      }
      if (policy.actionKey === VCC_EXPORT_SINGLE_ACTION) {
        return [policy.entryKey, vccExportSingleEntry];
      }
      return [policy.entryKey, {
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
      }];
    })
  ));
  const validatorEntries = {};
  for (const policy of BACKGROUND_EXECUTION_POLICIES) {
    let resultValidator;
    if (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
      resultValidator = validateVccExportSubjectsResult;
    } else if (policy.actionKey === VCC_EXPORT_SINGLE_ACTION) {
      resultValidator = validateVccExportSingleResult;
    } else if (policy.moduleId === 'recon-fix') {
      resultValidator = policy.actionKey === RECON_FIX_EXPORT_ACTION
        ? validateReconFixExportResult
        : (policy.actionKey === RECON_FIX_RUN_JPM_ACTION
            ? validateReconFixJpmResult
            : validateReconFixServiceResult);
    } else if (policy.moduleId === 'pre-fund') {
      resultValidator = policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
        ? validatePreFundMptRepairResult
        : validatePreFundMptImportResult;
    } else {
      resultValidator = policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
        ? validateToolboxMultiGenerationResult
        : (value) => validateToolboxGenerationResult(value, policy.actionKey);
    }
    validatorEntries[policy.result.validatorKey] = resultValidator;
    // Main explicitly executes the asynchronous technical/business validators before Publisher.
    // Registry bindings remain synchronous capability declarations for static contract coverage.
    validatorEntries[policy.artifacts.technicalValidatorKey] = resultValidator;
    validatorEntries[policy.artifacts.businessValidatorKey] = resultValidator;
  }
  const validatorRegistry = createStaticRegistry(validatorEntries);
  const preFundTopologyPlanner = createPreFundMptTopologyPlanner({ availableParallelism });
  const vccExportTopologyPlanner = createVccExportTopologyPlanner();
  const topologyRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES
      .filter((policy) => policy.resources.compound)
      .map((policy) => [policy.resources.compound.topologyKey,
        policy.actionKey === PRE_FUND_MPT_IMPORT_ACTION || policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
          ? preFundTopologyPlanner
          : (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION
              ? vccExportTopologyPlanner
              : () => Object.freeze({ effectiveChildCount: 1 }))])
  ));
  entryRegistry.freeze();
  validatorRegistry.freeze();
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
    serviceKeys: [RECON_FIX_SERVICE_KEY],
    plannerKeys: [
      'planner.pre-fund:mpt-import',
      'planner.vcc-financial-op:export-subjects'
    ],
    reducerKeys: [
      'reducer.pre-fund:mpt-import',
      'reducer.vcc-financial-op:export-subjects'
    ]
  };
  const policyRegistry = createExecutionPolicyRegistry({
    policies: BACKGROUND_EXECUTION_POLICIES,
    entryRegistry,
    validatorRegistry,
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
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    diagnostics: options.diagnostics,
    executionTimeoutMs: options.executionTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs || 5000,
    workerDurableCoordinator: options.workerDurableCoordinator,
    bindInputForAction({ actionKey, input }) {
      if ([VCC_EXPORT_SINGLE_ACTION, VCC_EXPORT_SUBJECTS_ACTION].includes(actionKey)) {
        if (!options.vccFinancialOpDatabasePath || !options.vccFinancialOpAssetsDir) {
          const error = new Error('VCC export runtime generation 缺少 Main database/assets authority');
          error.code = 'VCC_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE';
          throw error;
        }
        if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'assetsDir')) {
          const error = new Error('VCC export database/assets authority 不接受 caller override');
          error.code = 'VCC_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN';
          throw error;
        }
        return Object.freeze({
          ...input,
          databasePath: path.resolve(options.vccFinancialOpDatabasePath),
          assetsDir: path.resolve(options.vccFinancialOpAssetsDir)
        });
      }
      if (actionKey !== RECON_FIX_RUN_JPM_ACTION) return input;
      if (!reconFixJpmDatabaseAuthority) {
        const error = new Error('ReconFix JPM runtime generation 缺少 Main database authority');
        error.code = 'RECON_FIX_JPM_DATABASE_AUTHORITY_UNAVAILABLE';
        throw error;
      }
      if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'databaseIdentity')) {
        const error = new Error('ReconFix JPM database authority 不接受 caller override');
        error.code = 'RECON_FIX_JPM_DATABASE_AUTHORITY_OVERRIDE_FORBIDDEN';
        throw error;
      }
      return Object.freeze({
        ...input,
        databasePath: reconFixJpmDatabaseAuthority.databasePath
      });
    },
    defaultUnitsForAction(actionKey) {
      return actionKey === RECON_FIX_RUN_JPM_ACTION
        ? Object.freeze([Object.freeze({ unitId: RECON_FIX_JPM_UNIT_ID, input: Object.freeze({}) })])
        : Object.freeze([]);
    },
    ...(options.workerThreadAdapter ? { workerThreadAdapter: options.workerThreadAdapter } : {})
  });
  const activeServiceOperations = new Map();
  const serviceOperationReservations = new Map();
  const reconFixEvidenceSettlementAdmission = createReconFixEvidenceSettlementAdmission();

  function serviceOperationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function serviceKeyForAction(actionKey) {
    const policy = policyRegistry.get(actionKey);
    return policy && policy.lifetime === 'service' && policy.service
      ? policy.service.serviceKey
      : null;
  }

  function enterUnreservedServiceOperation(request) {
    const serviceKey = serviceKeyForAction(request && request.actionKey);
    if (!serviceKey) return () => {};
    if (serviceOperationReservations.has(serviceKey)) {
      throw serviceOperationError(
        'SERVICE_BUSY',
        `Service operation 已被 Main settlement reservation 占用：${serviceKey}`
      );
    }
    activeServiceOperations.set(serviceKey, (activeServiceOperations.get(serviceKey) || 0) + 1);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const next = (activeServiceOperations.get(serviceKey) || 1) - 1;
      if (next > 0) activeServiceOperations.set(serviceKey, next);
      else activeServiceOperations.delete(serviceKey);
      return true;
    };
  }

  function executeUnreserved(request) {
    const leave = enterUnreservedServiceOperation(request);
    try {
      return Promise.resolve(supervisor.execute(request)).finally(leave);
    } catch (error) {
      leave();
      throw error;
    }
  }

  function startUnreserved(request) {
    const leave = enterUnreservedServiceOperation(request);
    try {
      const control = supervisor.start(request);
      Promise.resolve(control.promise).finally(leave).catch(() => undefined);
      return control;
    } catch (error) {
      leave();
      throw error;
    }
  }

  function reserveServiceOperation(authority) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority) ||
        Object.keys(authority).sort().join(',') !== 'actionKey,operationKey' ||
        typeof authority.actionKey !== 'string' || !authority.actionKey ||
        typeof authority.operationKey !== 'string' || !authority.operationKey) {
      throw serviceOperationError(
        'SERVICE_OPERATION_RESERVATION_INVALID',
        'Service operation reservation authority 必须是 exact actionKey/operationKey'
      );
    }
    const policy = policyRegistry.get(authority.actionKey);
    const serviceKey = serviceKeyForAction(authority.actionKey);
    if (!policy || !serviceKey) {
      throw serviceOperationError(
        'SERVICE_OPERATION_RESERVATION_INVALID',
        'Service operation reservation 只接受已注册 service action'
      );
    }
    if (serviceOperationReservations.has(serviceKey) ||
        (activeServiceOperations.get(serviceKey) || 0) > 0) {
      throw serviceOperationError('SERVICE_BUSY', `Service 已有 active operation/reservation：${serviceKey}`);
    }
    const identity = Object.freeze({
      actionKey: authority.actionKey,
      operationKey: authority.operationKey,
      serviceKey
    });
    const token = Object.freeze({});
    serviceOperationReservations.set(serviceKey, token);
    let executionStarted = false;
    let executionSettled = true;
    let released = false;
    return Object.freeze({
      identity,
      execute(request) {
        if (released || serviceOperationReservations.get(serviceKey) !== token) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_STALE',
            'Service operation reservation 已释放或失效'
          );
        }
        if (executionStarted) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_REUSED',
            'Service operation reservation 只能执行一次'
          );
        }
        if (!request || request.actionKey !== identity.actionKey ||
            request.operationKey !== identity.operationKey) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_IDENTITY_MISMATCH',
            'Service operation request 与 reservation identity 不一致'
          );
        }
        if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
        executionStarted = true;
        executionSettled = false;
        try {
          return Promise.resolve(supervisor.execute(request)).finally(() => {
            executionSettled = true;
          });
        } catch (error) {
          executionSettled = true;
          throw error;
        }
      },
      release() {
        if (released) return false;
        if (!executionSettled) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_ACTIVE',
            'Service operation execution 未结算，不能提前释放 reservation'
          );
        }
        if (serviceOperationReservations.get(serviceKey) !== token) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_STALE',
            'Service operation reservation owner 已变化'
          );
        }
        released = true;
        serviceOperationReservations.delete(serviceKey);
        return true;
      }
    });
  }
  return Object.freeze({
    start(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return startUnreserved(request);
    },
    execute(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return executeUnreserved(request);
    },
    inspect(jobId) {
      return supervisor.inspect(jobId);
    },
    closeService(serviceKey) {
      if (serviceOperationReservations.has(serviceKey)) {
        throw serviceOperationError(
          'SERVICE_BUSY',
          `Service settlement reservation 尚未释放：${serviceKey}`
        );
      }
      return supervisor.closeService(serviceKey);
    },
    policyRegistry,
    reconFixEvidenceSettlementAdmission,
    resourceGovernor,
    reserveServiceOperation,
    shutdown(shutdownOptions) {
      return supervisor.shutdown(shutdownOptions);
    },
    stopAcceptingNewJobs() {
      supervisor.stopAcceptingNewJobs();
    }
  });
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
  const runtimeFactory = options.runtimeFactory || (() => createBackgroundExecutionRuntime({
    ...options,
    workerDurableCoordinator: typeof options.workerDurableCoordinatorProvider === 'function'
      ? options.workerDurableCoordinatorProvider()
      : options.workerDurableCoordinator,
    reconFixJpmDatabasePath: typeof options.reconFixJpmDatabasePathProvider === 'function'
      ? options.reconFixJpmDatabasePathProvider()
      : options.reconFixJpmDatabasePath
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
  createNonProductionBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
};
