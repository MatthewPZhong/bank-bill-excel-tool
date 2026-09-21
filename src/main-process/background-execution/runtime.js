'use strict';

const os = require('node:os');
const { createPlatformResourceBudgets } = require('./resource-budget');
const { createResourceGovernor } = require('./resource-governor');
const { createExecutionSupervisor } = require('./supervisor');
const { beginExternalParserShutdown, waitForExternalParserShutdownPhase } = require('./external-parser-finalization');

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

function createBackgroundExecutionRuntimeInternal(options, resourceGovernorOverride = null) {
  const executionDescriptors = options.executionDescriptors;
  if (!executionDescriptors || !executionDescriptors.policyRegistry ||
      !executionDescriptors.policyRegistry.isFrozen() ||
      typeof executionDescriptors.bindInputForAction !== 'function' ||
      typeof executionDescriptors.beforeCarrierDispatch !== 'function' ||
      typeof executionDescriptors.getBeforeCarrierDispatchForAction !== 'function' ||
      typeof executionDescriptors.defaultUnitsForAction !== 'function') {
    throw Object.assign(new Error('后台执行 runtime 需要 Main 提供已冻结的 execution descriptors'), {
      code: 'EXECUTION_DESCRIPTOR_REQUIRED'
    });
  }
  const policyRegistry = executionDescriptors.policyRegistry;
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
    carrierClosureActionKeys: options.carrierClosureActionKeys || [],
    getBeforeCarrierDispatchForAction: executionDescriptors.getBeforeCarrierDispatchForAction,
    bindInputForAction: executionDescriptors.bindInputForAction,
    defaultUnitsForAction: executionDescriptors.defaultUnitsForAction,
    ...(options.workerThreadAdapter ? { workerThreadAdapter: options.workerThreadAdapter } : {})
  });
  const activeServiceOperations = new Map();
  const serviceOperationReservations = new Map();
  const reconFixEvidenceSettlementAdmission = typeof options.createEvidenceSettlementAdmission === 'function'
    ? options.createEvidenceSettlementAdmission({ resourceGovernor }) : null;

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
  let shutdownPromise = null;
  const runtime = Object.freeze({
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
    if (typeof options.createExecutionDescriptors !== 'function') {
      throw Object.assign(new Error('runtime manager 需要每代装配 execution descriptors 的 Main 工厂'), {
        code: 'EXECUTION_DESCRIPTOR_FACTORY_REQUIRED'
      });
    }
    const runtimeOptions = {
      ...options,
      workerDurableCoordinator: typeof options.workerDurableCoordinatorProvider === 'function'
        ? options.workerDurableCoordinatorProvider() : options.workerDurableCoordinator
    };
    return createBackgroundExecutionRuntime({
      ...runtimeOptions,
      executionDescriptors: options.createExecutionDescriptors(runtimeOptions)
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
      if (typeof options.isProductionEnabled === 'function') return options.isProductionEnabled(actionKey);
      const policy = runtime && runtime.policyRegistry && runtime.policyRegistry.get(actionKey);
      return Boolean(policy && policy.production.enabled === true);
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
  createBackgroundExecutionRuntime,
  createBackgroundExecutionRuntimeManager,
  createNonProductionBackgroundExecutionRuntime
};
