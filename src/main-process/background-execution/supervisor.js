'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');

const {
  createExistingDispatchAdapter,
  createExistingDispatchTransportAdapter
} = require('./adapters/existing-dispatch-adapter');
const { createInlineAsyncAdapter } = require('./adapters/inline-async-adapter');
const { createUtilityProcessAdapter } = require('./adapters/utility-process-adapter');
const { createWorkerThreadAdapter } = require('./adapters/worker-thread-adapter');
const { sanitizeFinanceSafeValue, toProtocolError } = require('./error-codec');
const { createExecutionResult } = require('./execution-result');
const { createJobEnvelope } = require('./protocol');
const {
  ProtocolValidationError,
  assertJsonSafe,
  canonicalJsonSnapshot,
  utf8Size,
  validateJobEnvelope
} = require('./protocol-validator');
const { createDirectionSequenceTracker } = require('./sequence-tracker');
const { checkedAdd } = require('./resource-lease');
const { MAX_TIMER_DELAY_MS } = require('./admission-queue');
const { closeResourceGovernor } = require('./resource-governor');
const {
  ServiceHostProtocolError,
  createServiceHost,
  serviceTransportCreatedGeneration
} = require('./service-host');

class SupervisorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupervisorError';
    this.code = code;
  }
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function promiseWithTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        reject(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function validatorFor(validatorOrRegistry) {
  if (typeof validatorOrRegistry === 'function') return validatorOrRegistry;
  if (validatorOrRegistry && (typeof validatorOrRegistry.assertValid === 'function' ||
      typeof validatorOrRegistry.validate === 'function')) return validatorOrRegistry;
  return undefined;
}

function validateResultBody(policy, result, validatorOrRegistry) {
  const ownedResult = canonicalJsonSnapshot(result);
  if (utf8Size(ownedResult) > policy.result.maxBytes) {
    throw new SupervisorError('RESULT_TOO_LARGE', `Execution result exceeds ${policy.result.maxBytes} bytes`);
  }
  const validatorKey = policy.result.validatorKey;
  const validator = validatorFor(validatorOrRegistry);
  if (!validator) {
    throw new SupervisorError('RESULT_VALIDATOR_MISSING', `Result validator is not registered: ${validatorKey}`);
  }
  let validationResult;
  let assertionStyle = false;
  if (typeof validator === 'function') validationResult = validator(ownedResult);
  else if (typeof validator.assertValid === 'function') {
    assertionStyle = true;
    validationResult = validator.assertValid(ownedResult);
  } else if (typeof validator.validate === 'function') validationResult = validator.validate(ownedResult);
  else throw new SupervisorError('RESULT_VALIDATOR_INVALID', `Result validator has no callable API: ${validatorKey}`);

  if (validationResult && (typeof validationResult === 'object' || typeof validationResult === 'function') &&
      typeof validationResult.then === 'function') {
    Promise.resolve(validationResult).catch(() => {});
    throw new SupervisorError(
      'RESULT_VALIDATOR_ASYNC_UNSUPPORTED',
      `Result validator must be synchronous: ${validatorKey}`
    );
  }
  if (!assertionStyle && validationResult !== true && !(validationResult && typeof validationResult === 'object' &&
      validationResult.valid === true)) {
    throw new SupervisorError(
      'RESULT_VALIDATION_FAILED',
      `Execution result validator must return true or { valid: true }: ${validatorKey}`
    );
  }
  return ownedResult;
}

function validateStringField(value, field, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length === 0) {
    throw new SupervisorError(
      field === 'operationKey' ? 'OPERATION_KEY_REQUIRED' : 'EXECUTE_REQUEST_FIELD_INVALID',
      `Execute request ${field} must be a non-empty string`
    );
  }
}

function snapshotExecuteRequest(request) {
  if (utilTypes.isProxy(request)) {
    throw new SupervisorError('EXECUTE_REQUEST_NOT_JSON_SAFE', 'Execute request must not be a Proxy');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
    throw new SupervisorError('EXECUTE_REQUEST_INVALID', 'Execute request must be a plain object');
  }
  const jsonFields = {};
  let onProgress;
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== 'string') {
      throw new SupervisorError('EXECUTE_REQUEST_NOT_JSON_SAFE', 'Execute request must not contain symbol keys');
    }
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new SupervisorError(
        'EXECUTE_REQUEST_NOT_JSON_SAFE',
        `Execute request ${key} must be an enumerable own data property`
      );
    }
    if (key === 'onProgress') {
      if (typeof descriptor.value !== 'function') {
        throw new SupervisorError('EXECUTE_REQUEST_CALLBACK_INVALID', 'Execute request onProgress must be callable');
      }
      onProgress = descriptor.value;
      continue;
    }
    try {
      assertJsonSafe(descriptor.value, `/request/${key}`);
    } catch (error) {
      throw new SupervisorError('EXECUTE_REQUEST_NOT_JSON_SAFE', error.message);
    }
    jsonFields[key] = descriptor.value;
  }
  const data = canonicalJsonSnapshot(jsonFields);
  validateStringField(data.actionKey, 'actionKey', { required: true });
  validateStringField(data.operationKey, 'operationKey', { required: true });
  validateStringField(data.jobId, 'jobId');
  validateStringField(data.workerInstanceId, 'workerInstanceId');
  if (data.production !== undefined && typeof data.production !== 'boolean') {
    throw new SupervisorError('EXECUTE_REQUEST_FIELD_INVALID', 'Execute request production must be boolean');
  }
  if (data.deferUnitStart !== undefined && typeof data.deferUnitStart !== 'boolean') {
    throw new SupervisorError('EXECUTE_REQUEST_FIELD_INVALID', 'Execute request deferUnitStart must be boolean');
  }
  for (const field of ['initTimeoutMs', 'executionTimeoutMs']) {
    if (data[field] !== undefined && (typeof data[field] !== 'number' || !Number.isFinite(data[field]) || data[field] < 0)) {
      throw new SupervisorError('EXECUTE_REQUEST_FIELD_INVALID', `Execute request ${field} must be a non-negative number`);
    }
  }
  if (data.input !== undefined && (!data.input || typeof data.input !== 'object' || Array.isArray(data.input))) {
    throw new SupervisorError('EXECUTE_REQUEST_FIELD_INVALID', 'Execute request input must be a plain JSON object');
  }
  if (data.units !== undefined && !Array.isArray(data.units)) {
    throw new SupervisorError('EXECUTE_REQUEST_FIELD_INVALID', 'Execute request units must be an array');
  }
  return Object.freeze({ data, onProgress });
}

function normalizeCancelReason(reason) {
  if (utilTypes.isProxy(reason) || !reason || typeof reason !== 'object' || Array.isArray(reason) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(reason))) {
    throw new SupervisorError('CANCEL_REASON_INVALID', 'CancelReasonV1 must be a plain object');
  }
  try {
    return canonicalJsonSnapshot(reason);
  } catch (error) {
    throw new SupervisorError('CANCEL_REASON_INVALID', error.message);
  }
}

function createExecutionSupervisor(options = {}) {
  if (!options.policyRegistry) throw new TypeError('ExecutionSupervisor requires policyRegistry');
  if (typeof options.policyRegistry.getBinding !== 'function') {
    throw new TypeError('ExecutionSupervisor requires a frozen policy registry binding snapshot');
  }
  const resourceGovernor = options.resourceGovernor || null;
  const now = options.now || Date.now;
  const diagnostics = options.diagnostics || (() => {});
  const workerThreadAdapter = options.workerThreadAdapter || createWorkerThreadAdapter();
  const utilityProcessAdapter = options.utilityProcessAdapter || createUtilityProcessAdapter();
  const defaultAdapters = Object.freeze({
    'inline-async': options.inlineAsyncAdapter || createInlineAsyncAdapter(),
    'thread-single': workerThreadAdapter,
    'thread-pool': workerThreadAdapter,
    'utility-process': utilityProcessAdapter
  });
  const serviceHost = options.serviceHost || (resourceGovernor
    ? createServiceHost({
        policyRegistry: options.policyRegistry,
        resourceGovernor,
        workerThreadAdapter,
        utilityProcessAdapter,
        idFactory: options.idFactory,
        now,
        diagnostics
      })
    : null);
  const workerDurableCoordinator = options.workerDurableCoordinator || null;
  const jobs = new Map();
  const pendingTransportCleanups = new Map();
  const failedTransportCleanups = new Map();
  const usedJobIds = new Set();
  const usedWorkerRoutes = new Set();
  let acceptingNewJobs = true;

  function reportDiagnostic(entry) {
    try { diagnostics(sanitizeFinanceSafeValue(entry)); } catch (_error) {}
  }

  function startExecution(rawRequest) {
    if (!acceptingNewJobs) {
      throw new SupervisorError('SUPERVISOR_NOT_ACCEPTING', 'ExecutionSupervisor is not accepting new jobs');
    }
    const requestSnapshot = snapshotExecuteRequest(rawRequest);
    const request = requestSnapshot.data;
    const onProgress = requestSnapshot.onProgress;
    const { actionKey, operationKey } = request;
    const policy = options.policyRegistry.assertRunnable(actionKey, { production: request.production === true });
    if (!resourceGovernor && (policy.lifetime === 'service' || policy.resources.compound)) {
      throw new SupervisorError(
        'RESOURCE_GOVERNOR_REQUIRED',
        `${policy.lifetime === 'service' ? 'Service' : 'Compound'} execution requires ResourceGovernor`
      );
    }
    const nativeWorkerDurable = policy.adapterKind === 'native' &&
      policy.commit.kind === 'worker-durable';
    const externalCommitLifecycleOnly = policy.commit.kind === 'main-settlement' ||
      (policy.adapterKind === 'existing-dispatch' && policy.commit.kind === 'existing-critical-protocol');
    if (nativeWorkerDurable && (!workerDurableCoordinator ||
        typeof workerDurableCoordinator.prepareAndAck !== 'function' ||
        typeof workerDurableCoordinator.observeReceipt !== 'function' ||
        typeof workerDurableCoordinator.settleCommitted !== 'function' ||
        typeof workerDurableCoordinator.resolveUncertain !== 'function')) {
      throw new SupervisorError(
        'WORKER_DURABLE_COORDINATOR_REQUIRED',
        'Native worker-durable execution requires the Main-owned critical coordinator'
      );
    }
    if (policy.commit.kind !== 'none' && !externalCommitLifecycleOnly && !nativeWorkerDurable) {
      throw new SupervisorError(
        'E02A_DURABLE_COMMIT_UNSUPPORTED',
        'Supervisor only observes native main-settlement or existing-dispatch durable commit lifecycle'
      );
    }

    const context = request.context === undefined
      ? (policy.context.kind === 'none' ? canonicalJsonSnapshot({ kind: 'none', value: {} }) : null)
      : request.context;
    if (!context) throw new SupervisorError('CONTEXT_REQUIRED', 'Execute request requires policy context');
    const jobId = request.jobId || (options.idFactory ? options.idFactory('job') : makeId('job'));
    let workerInstanceId = request.workerInstanceId ||
      (options.idFactory ? options.idFactory('worker') : makeId('worker'));
    let serviceGeneration = policy.lifetime === 'service' ? 1 : null;
    validateStringField(jobId, 'jobId', { required: true });
    validateStringField(workerInstanceId, 'workerInstanceId', { required: true });

    const units = new Map();
    for (const unitValue of request.units || []) {
      let unitId;
      let input;
      if (typeof unitValue === 'string') {
        unitId = unitValue;
        input = canonicalJsonSnapshot({});
      } else if (unitValue && typeof unitValue === 'object' && !Array.isArray(unitValue)) {
        unitId = unitValue.unitId;
        input = unitValue.input === undefined ? canonicalJsonSnapshot({}) : unitValue.input;
      }
      if (typeof unitId !== 'string' || unitId.length === 0 || units.has(unitId) ||
          !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new SupervisorError('UNIT_REGISTRATION_INVALID', `Duplicate or invalid unitId: ${String(unitId)}`);
      }
      let resolveTerminal;
      const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
      units.set(unitId, {
        state: 'registered',
        input,
        result: null,
        error: null,
        criticalState: 'none',
        fileOperationKey: null,
        intentId: null,
        receiptHint: null,
        inspection: null,
        terminalPromise,
        resolveTerminal,
        terminalSettled: false
      });
    }

    // adapter 分配 Worker/process 前预检全部 request-derived command；真实 direction
    // seq 仍只由 send() 分配，预检不会推进 tracker。
    createJobEnvelope({
      direction: 'command',
      operation: 'job:start',
      actionKey,
      operationKey,
      jobId,
      workerInstanceId,
      serviceGeneration,
      unitId: null,
      seq: 1,
      context,
      payload: { input: request.input || {} }
    }, { policyRegistry: options.policyRegistry });
    for (const [unitId, unit] of units) {
      createJobEnvelope({
        direction: 'command',
        operation: 'unit:start',
        actionKey,
        operationKey,
        jobId,
        workerInstanceId,
        serviceGeneration,
        unitId,
        seq: 1,
        context,
        payload: { input: unit.input }
      }, { policyRegistry: options.policyRegistry });
    }

    const workerRoute = `${jobId}\u0000${workerInstanceId}`;
    if (usedJobIds.has(jobId) || usedWorkerRoutes.has(workerRoute)) {
      throw new SupervisorError('JOB_ID_DUPLICATE', `Reused jobId or worker route: ${jobId}`);
    }
    usedJobIds.add(jobId);
    usedWorkerRoutes.add(workerRoute);

    const queuedAt = now();
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    let resolveTransportAssignment;
    const transportAssignment = new Promise((resolve) => { resolveTransportAssignment = resolve; });
    let resolveDispatchReady;
    const dispatchReady = new Promise((resolve) => { resolveDispatchReady = resolve; });
    const record = {
      actionKey,
      operationKey,
      jobId,
      workerInstanceId,
      context,
      policy,
      resultValidator: options.policyRegistry.getBinding(actionKey, 'result.validatorKey'),
      entry: options.policyRegistry.getBinding(actionKey, 'entryKey'),
      adapterBinding: options.policyRegistry.getBinding(actionKey, 'adapterKey'),
      onProgress,
      state: 'queued',
      transport: null,
      transportAssignment,
      dispatchReady,
      dispatchReadySettled: false,
      transportAssignmentSettled: false,
      incomingSeq: createDirectionSequenceTracker(),
      outgoingSeq: createDirectionSequenceTracker(),
      units,
      unknownUnits: new Set(),
      terminal: false,
      startDispatchState: 'not-started',
      cancelRequested: false,
      cancelReason: null,
      cancelSource: null,
      cancelCommandState: 'not-requested',
      cancelAckState: 'none',
      cancelTerminalEvidence: false,
      cancelTimer: null,
      progressTimestamps: new Map(),
      transportCleanup: null,
      transportCleanupSettled: false,
      transportCleanupErrors: [],
      terminateCalled: false,
      closeCalled: false,
      admissionAbortController: new AbortController(),
      resourceLeases: [],
      resourceCleanupSettled: false,
      serviceGenerationCreated: null,
      topology: null,
      timers: new Set(),
      metrics: { queuedAt, startedAt: 0, endedAt: 0, workerCount: 1 },
      promise,
      resolvePromise,
      settlePromise: null
    };
    jobs.set(jobId, record);

    function finishTransportAssignment() {
      if (record.transportAssignmentSettled) return;
      record.transportAssignmentSettled = true;
      resolveTransportAssignment();
    }

    function finishDispatchReady() {
      if (record.dispatchReadySettled) return;
      record.dispatchReadySettled = true;
      resolveDispatchReady();
    }

    function settleUnit(unit, value) {
      if (!unit || unit.terminalSettled) return false;
      unit.terminalSettled = true;
      unit.resolveTerminal(Object.freeze(value));
      return true;
    }

    function safeErrorOptions(stage) {
      return {
        maxBytes: policy.protocolLimits.eventMaxBytes,
        maxErrorItems: policy.result.maxErrorItems,
        privacyProfile: policy.metrics.privacyProfile,
        stage
      };
    }

    function clearTimers() {
      for (const timer of record.timers) clearTimeout(timer);
      record.timers.clear();
      record.cancelTimer = null;
    }

    function retainCleanupError(phase, error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!normalized.code) normalized.code = `TRANSPORT_${phase.toUpperCase()}_FAILED`;
      record.transportCleanupErrors.push(Object.freeze({ phase, error: normalized }));
      failedTransportCleanups.set(jobId, record);
      reportDiagnostic({
        type: 'transport-cleanup-error',
        phase,
        actionKey,
        operationKey,
        jobId,
        error: toProtocolError(normalized, normalized.code, safeErrorOptions('cleanup'))
      });
    }

    async function boundedCleanupPhase(phase, callback) {
      const timeoutMs = policy.cancellation.terminateTimeoutMs;
      try {
        let cleanup;
        try {
          cleanup = callback();
        } catch (error) {
          cleanup = Promise.reject(error);
        }
        await promiseWithTimeout(
          cleanup,
          timeoutMs,
          () => new SupervisorError(
            `TRANSPORT_${phase.toUpperCase()}_TIMEOUT`,
            `Transport ${phase} timed out after ${timeoutMs}ms`
          )
        );
      } catch (error) {
        retainCleanupError(phase, error);
      }
    }

    function cleanupTransport({ force = false } = {}) {
      if (record.transportCleanup) return record.transportCleanup;
      record.transportCleanup = Promise.resolve().then(async () => {
        await record.transportAssignment;
        if (!record.transport) {
          record.transportCleanupSettled = true;
          return;
        }
        const terminateRequired = force ||
          (policy.lifetime !== 'service' && policy.adapterKind !== 'existing-dispatch');
        if (terminateRequired && !record.terminateCalled) {
          record.terminateCalled = true;
          await boundedCleanupPhase('terminate', () => {
            if (typeof record.transport.terminate !== 'function') {
              throw new SupervisorError('TRANSPORT_TERMINATE_MISSING', 'Transport has no terminate() API');
            }
            return record.transport.terminate();
          });
        }
        if (!record.closeCalled) {
          record.closeCalled = true;
          await boundedCleanupPhase('close', () => {
            if (typeof record.transport.close !== 'function') {
              throw new SupervisorError('TRANSPORT_CLOSE_MISSING', 'Transport has no close() API');
            }
            return record.transport.close();
          });
        }
        record.transportCleanupSettled = true;
      }).finally(() => {
        pendingTransportCleanups.delete(jobId);
        if (record.transportCleanupErrors.length === 0) failedTransportCleanups.delete(jobId);
      });
      pendingTransportCleanups.set(jobId, record);
      return record.transportCleanup;
    }

    function cleanupResources(reason = 'job-terminal') {
      if (record.resourceCleanupSettled) return;
      record.resourceCleanupSettled = true;
      for (const lease of record.resourceLeases.splice(0).reverse()) {
        try { lease.release(reason); } catch (releaseError) {
          reportDiagnostic({
            type: 'resource-cleanup-error',
            actionKey,
            operationKey,
            jobId,
            code: releaseError && releaseError.code || 'RESOURCE_RELEASE_FAILED'
          });
        }
      }
    }

    function retainGrantedLease(lease, reason = 'late-admission-grant') {
      if (!record.terminal && !record.admissionAbortController.signal.aborted &&
          !record.resourceCleanupSettled) {
        record.resourceLeases.push(lease);
        return true;
      }
      try { lease.release(reason); } catch (releaseError) {
        reportDiagnostic({
          type: 'resource-cleanup-error',
          actionKey,
          operationKey,
          jobId,
          code: releaseError && releaseError.code || 'RESOURCE_RELEASE_FAILED'
        });
      }
      return false;
    }

    function stageForTerminal(terminalSource) {
      if (terminalSource === 'spawn-error' || terminalSource === 'init-timeout') return 'spawn';
      if (terminalSource === 'cancel-timeout') return 'cancel';
      if (terminalSource === 'protocol-error') return 'protocol';
      return 'execute';
    }

    function isRecoveryInterruptedUnit(unit) {
      return nativeWorkerDurable && ['committed-lost', 'unknown'].includes(unit.criticalState);
    }

    function settleUnfinishedUnit(unit, outcome, safeError) {
      if (unit.terminalSettled) return;
      if (isRecoveryInterruptedUnit(unit)) {
        unit.state = 'interrupted';
      } else if (!['done', 'error', 'cancelled'].includes(unit.state)) {
        // transport终止前已真正派发的unit是当前普通file失败；尚未派发的unit
        // 没有业务执行，只能按父级取消收口。两者都不得冒充资金结果不确定。
        unit.state = outcome === 'cancelled' || unit.state !== 'running'
          ? 'cancelled'
          : 'error';
      }
      settleUnit(unit, {
        status: unit.state,
        error: safeError,
        inspection: unit.inspection
      });
    }

    function finish(terminalSource, outcome, error, result = null, finishOptions = {}) {
      if (record.terminal) {
        reportDiagnostic({ type: 'late-terminal', actionKey, operationKey, jobId, terminalSource });
        return false;
      }
      record.terminal = true;
      record.admissionAbortController.abort();
      record.state = 'settled';
      record.metrics.endedAt = now();
      clearTimers();
      const forceTransport = finishOptions.forceTransport === undefined
        ? !['job:done', 'job:error'].includes(terminalSource)
        : finishOptions.forceTransport;
      const ownsFailedPreDispatchService = policy.lifetime === 'service' &&
        record.startDispatchState === 'not-started' && record.serviceGenerationCreated === true;
      const preserveExistingPreDispatchService = policy.lifetime === 'service' &&
        record.startDispatchState === 'not-started' && record.serviceGenerationCreated === false;
      const effectiveForceTransport = preserveExistingPreDispatchService
        ? false
        : (ownsFailedPreDispatchService ? true : forceTransport);
      const safeError = error
        ? toProtocolError(error, 'BACKGROUND_EXECUTION_ERROR', safeErrorOptions(stageForTerminal(terminalSource)))
        : null;
      const terminalResult = result === null ? null : canonicalJsonSnapshot(result);
      record.settlePromise = Promise.resolve().then(async () => {
        if (nativeWorkerDurable && record.eventChain) {
          await record.eventChain.catch(() => {});
        }
        await cleanupTransport({ force: effectiveForceTransport });
        if (nativeWorkerDurable) await resolveOutstandingCritical(terminalSource);
        const interrupted = nativeWorkerDurable && [...record.units.values()].some((unit) =>
          ['committed-lost', 'unknown'].includes(unit.criticalState));
        for (const unit of record.units.values()) {
          settleUnfinishedUnit(unit, outcome, safeError);
        }
        cleanupResources(terminalSource === 'job:done' ? 'job-terminal' : 'job-failed');
        const executionResult = createExecutionResult({
          actionKey,
          operationKey,
          jobId,
          outcome: interrupted ? 'interrupted' : outcome,
          terminalSource,
          result: interrupted ? null : terminalResult,
          error: safeError,
          // existing-dispatch 的 job terminal 只证明既有 dispatcher 已结束；平台没有
          // 接管或重新判定其 settlement，也没有权威 receipt identity。保持 null，
          // 不得把 execution completed 冒充资金/发布或 TaskRun success。
          receiptHint: null,
          metrics: record.metrics
        });
        jobs.delete(jobId);
        resolvePromise(executionResult);
        return executionResult;
      }).catch((settlementError) => {
        // Inspector/RecoveryControl失败必须保留open Intent供启动恢复，同时当前调用方
        // 仍得到确定的interrupted终态，不能因settle链reject永久悬挂。
        reportDiagnostic({
          type: 'worker-durable-settlement-error',
          actionKey,
          operationKey,
          jobId,
          code: settlementError && settlementError.code || 'WORKER_DURABLE_SETTLEMENT_FAILED'
        });
        for (const unit of record.units.values()) {
          if (['acked', 'committed'].includes(unit.criticalState)) unit.criticalState = 'unknown';
          settleUnfinishedUnit(unit, outcome, safeError);
        }
        cleanupResources('job-interrupted');
        const executionResult = createExecutionResult({
          actionKey,
          operationKey,
          jobId,
          outcome: 'interrupted',
          terminalSource,
          result: null,
          error: safeError || toProtocolError(
            settlementError,
            'WORKER_DURABLE_SETTLEMENT_FAILED',
            safeErrorOptions('settle')
          ),
          receiptHint: null,
          metrics: record.metrics
        });
        jobs.delete(jobId);
        resolvePromise(executionResult);
        return executionResult;
      });
      finishDispatchReady();
      return true;
    }
    record.finish = finish;
    record.cleanupTransport = cleanupTransport;

    function failProtocol(error) {
      const protocolError = error instanceof Error ? error : new Error('Protocol validation failed');
      if (!protocolError.code) protocolError.code = 'PROTOCOL_ERROR';
      finish('protocol-error', 'transport-lost', protocolError, null);
    }

    function refreshProtectedState() {
      if (record.terminal) return;
      const protectedUnit = [...record.units.values()].some((unit) =>
        ['acked', 'committed'].includes(unit.criticalState));
      record.state = protectedUnit ? 'protected' : 'running';
    }

    async function resolveCriticalUnit(unit, terminalSource) {
      if (!nativeWorkerDurable || !unit || !['acked', 'committed'].includes(unit.criticalState)) {
        return null;
      }
      const inspection = await workerDurableCoordinator.resolveUncertain(Object.freeze({
        policy,
        actionKey,
        parentOperationKey: operationKey,
        fileOperationKey: unit.fileOperationKey,
        taskRunId: context.kind === 'file-batch' ? context.value.taskRunId : null,
        batchId: context.kind === 'file-batch' ? context.value.batchId : null,
        jobId,
        workerInstanceId,
        unitId: [...record.units].find(([, candidate]) => candidate === unit)?.[0] || null,
        intentId: unit.intentId,
        receiptHint: unit.receiptHint,
        terminalSource
      }));
      unit.inspection = inspection || null;
      if (inspection && inspection.outcome === 'not-committed') {
        unit.criticalState = 'recovered';
      } else if (inspection && inspection.outcome === 'committed') {
        unit.criticalState = 'committed-lost';
      } else {
        unit.criticalState = 'unknown';
      }
      refreshProtectedState();
      return inspection;
    }

    async function resolveOutstandingCritical(terminalSource) {
      for (const unit of record.units.values()) {
        if (['acked', 'committed'].includes(unit.criticalState)) {
          await resolveCriticalUnit(unit, terminalSource);
        }
      }
    }

    function expectedEventRoute() {
      return {
        actionKey,
        operationKey,
        jobId,
        workerInstanceId,
        serviceGeneration,
        direction: 'event'
      };
    }

    function unitForMessage(message, allowedStates = ['running']) {
      const unit = record.units.get(message.unitId);
      if (!unit) {
        record.unknownUnits.add(String(message.unitId));
        throw new ProtocolValidationError('PROTOCOL_UNKNOWN_UNIT', `Unknown unitId: ${message.unitId}`, '/unitId');
      }
      if (!allowedStates.includes(unit.state)) {
        const terminalStates = ['done', 'error', 'cancelled', 'interrupted'];
        throw new ProtocolValidationError(
          terminalStates.includes(unit.state)
            ? 'PROTOCOL_UNIT_TERMINAL_IMMUTABLE'
            : 'PROTOCOL_UNIT_STATE_INVALID',
          `Unit ${message.unitId} cannot accept ${message.operation} while ${unit.state}`,
          '/unitId'
        );
      }
      return unit;
    }

    function clearCancelTimer() {
      if (!record.cancelTimer) return;
      clearTimeout(record.cancelTimer);
      record.timers.delete(record.cancelTimer);
      record.cancelTimer = null;
    }

    function observeProgressRate(message) {
      const limit = policy.metrics.progressRateLimitPerSecond;
      const timestamp = now();
      const direction = message.direction;
      const timestamps = record.progressTimestamps.get(direction) || [];
      const cutoff = timestamp - 1000;
      while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length >= limit) {
        throw new ProtocolValidationError(
          'PROTOCOL_PROGRESS_RATE_LIMIT_EXCEEDED',
          `Progress rate exceeds ${limit} messages per second for ${direction} direction`,
          '/operation',
          { direction, limit, windowMs: 1000 }
        );
      }
      timestamps.push(timestamp);
      record.progressTimestamps.set(direction, timestamps);
    }

    function reportProgressObserverError(error) {
      reportDiagnostic({
        type: 'progress-observer-error',
        actionKey,
        operationKey,
        jobId,
        error: toProtocolError(error, 'PROGRESS_OBSERVER_ERROR', safeErrorOptions('diagnostic'))
      });
    }

    async function processMessage(message) {
      switch (message.operation) {
        case 'job:progress':
          observeProgressRate(message);
          if (onProgress) {
            try { onProgress(message.payload.progress); } catch (error) { reportProgressObserverError(error); }
          }
          return;
        case 'unit:progress': {
          unitForMessage(message);
          observeProgressRate(message);
          if (onProgress) {
            try { onProgress(message.payload.progress, Object.freeze({ unitId: message.unitId })); } catch (error) {
              reportProgressObserverError(error);
            }
          }
          return;
        }
        case 'critical:ready': {
          if (!nativeWorkerDurable) {
            throw new ProtocolValidationError(
              'PROTOCOL_COMMIT_OPERATION_FORBIDDEN',
              'critical:ready is not owned by this execution transport',
              '/operation'
            );
          }
          const unit = unitForMessage(message);
          if (unit.criticalState !== 'none') {
            throw new ProtocolValidationError(
              'PROTOCOL_DUPLICATE_CRITICAL_READY',
              'A unit may enter critical readiness only once',
              '/unitId'
            );
          }
          unit.criticalState = 'preparing';
          const prepared = await workerDurableCoordinator.prepareAndAck(Object.freeze({
            policy,
            actionKey,
            parentOperationKey: operationKey,
            taskRunId: context.kind === 'file-batch' ? context.value.taskRunId : null,
            batchId: context.kind === 'file-batch' ? context.value.batchId : null,
            jobId,
            workerInstanceId,
            unitId: message.unitId,
            critical: message.payload.critical
          }));
          if (!prepared || typeof prepared.intentId !== 'string' || prepared.intentId.length === 0 ||
              typeof prepared.fileOperationKey !== 'string' || prepared.fileOperationKey.length === 0) {
            throw new SupervisorError(
              'WORKER_DURABLE_PREPARE_INVALID',
              'Critical coordinator must return intentId and fileOperationKey'
            );
          }
          unit.intentId = prepared.intentId;
          unit.fileOperationKey = prepared.fileOperationKey;
          unit.criticalState = 'acked';
          refreshProtectedState();
          send('critical:ack', {
            critical: { intentId: unit.intentId, fileOperationKey: unit.fileOperationKey }
          }, message.unitId);
          return;
        }
        case 'commit:receipt': {
          if (!nativeWorkerDurable) {
            throw new ProtocolValidationError(
              'PROTOCOL_COMMIT_OPERATION_FORBIDDEN',
              'commit:receipt is not owned by this execution transport',
              '/operation'
            );
          }
          const unit = unitForMessage(message);
          if (unit.criticalState !== 'acked') {
            throw new ProtocolValidationError(
              'PROTOCOL_RECEIPT_BEFORE_ACK',
              'commit:receipt requires matching persisted critical ACK',
              '/unitId'
            );
          }
          const observed = await workerDurableCoordinator.observeReceipt(Object.freeze({
            policy,
            actionKey,
            parentOperationKey: operationKey,
            fileOperationKey: unit.fileOperationKey,
            taskRunId: context.kind === 'file-batch' ? context.value.taskRunId : null,
            batchId: context.kind === 'file-batch' ? context.value.batchId : null,
            jobId,
            workerInstanceId,
            unitId: message.unitId,
            intentId: unit.intentId,
            receipt: message.payload.receipt
          }));
          unit.receiptHint = observed && observed.receiptHint ? observed.receiptHint : null;
          unit.criticalState = 'committed';
          return;
        }
        case 'unit:done': {
          const unit = unitForMessage(message);
          if (nativeWorkerDurable && unit.criticalState !== 'committed') {
            throw new ProtocolValidationError(
              'PROTOCOL_UNIT_DONE_WITHOUT_RECEIPT',
              'worker-durable unit:done requires a persisted matching commit:receipt',
              '/unitId'
            );
          }
          unit.result = validateResultBody(policy, message.payload.result, record.resultValidator);
          if (nativeWorkerDurable) {
            await workerDurableCoordinator.settleCommitted(Object.freeze({
              policy,
              actionKey,
              parentOperationKey: operationKey,
              fileOperationKey: unit.fileOperationKey,
              taskRunId: context.kind === 'file-batch' ? context.value.taskRunId : null,
              batchId: context.kind === 'file-batch' ? context.value.batchId : null,
              jobId,
              workerInstanceId,
              unitId: message.unitId,
              intentId: unit.intentId,
              receiptHint: unit.receiptHint,
              result: unit.result
            }));
          }
          unit.state = 'done';
          if (nativeWorkerDurable) unit.criticalState = 'settled';
          refreshProtectedState();
          settleUnit(unit, { status: 'done', result: unit.result });
          return;
        }
        case 'unit:error': {
          const unit = unitForMessage(message);
          if (nativeWorkerDurable && ['acked', 'committed'].includes(unit.criticalState)) {
            await resolveCriticalUnit(unit, 'unit:error');
          }
          unit.error = message.payload.error;
          const recoveryInterrupted = nativeWorkerDurable &&
            ['committed-lost', 'unknown'].includes(unit.criticalState);
          unit.state = recoveryInterrupted ? 'interrupted' : 'error';
          settleUnit(unit, {
            status: recoveryInterrupted ? 'interrupted' : 'error',
            error: unit.error,
            inspection: unit.inspection
          });
          return;
        }
        case 'cancel:ack':
          if (record.cancelCommandState !== 'dispatching' && record.cancelCommandState !== 'sent') {
            throw new ProtocolValidationError(
              'PROTOCOL_UNSOLICITED_CANCEL_ACK',
              'cancel:ack arrived without a dispatched cancel command',
              '/operation'
            );
          }
          if (record.cancelAckState !== 'none') {
            throw new ProtocolValidationError(
              'PROTOCOL_DUPLICATE_CANCEL_ACK',
              'cancel:ack may be observed at most once',
              '/operation'
            );
          }
          record.cancelAckState = 'acknowledged';
          return;
        case 'job:done': {
          const allowUnitError = policy.failure.unitBusinessError === 'collect-and-continue' ||
            policy.failure.unitTransportCrash === 'fail-unit-and-continue';
          const invalidUnits = [...record.units.values()].filter((unit) =>
            unit.state !== 'done' && !(allowUnitError && unit.state === 'error'));
          const openCritical = nativeWorkerDurable && [...record.units.values()].some((unit) =>
            ['preparing', 'acked', 'committed'].includes(unit.criticalState));
          const recoveryInterrupted = nativeWorkerDurable && [...record.units.values()].some((unit) =>
            ['committed-lost', 'unknown'].includes(unit.criticalState));
          if (record.unknownUnits.size || invalidUnits.length || openCritical || recoveryInterrupted) {
            throw new ProtocolValidationError(
              'PROTOCOL_JOB_DONE_GATE_FAILED',
              'job:done requires every unit terminal and no unresolved critical unit',
              '/operation'
            );
          }
          const result = validateResultBody(policy, message.payload.result, record.resultValidator);
          finish('job:done', 'completed', null, result);
          return;
        }
        case 'job:error':
          if (nativeWorkerDurable) await resolveOutstandingCritical('job:error');
          for (const unit of record.units.values()) {
            if (unit.state === 'registered' || unit.state === 'queued' || unit.state === 'running') {
              const recoveryInterrupted = nativeWorkerDurable &&
                ['committed-lost', 'unknown'].includes(unit.criticalState);
              unit.state = recoveryInterrupted ? 'interrupted' : 'cancelled';
              settleUnit(unit, {
                status: recoveryInterrupted ? 'interrupted' : 'cancelled',
                error: message.payload.error,
                inspection: unit.inspection
              });
            }
          }
          finish(
            'job:error',
            record.cancelTerminalEvidence ? 'cancelled' : 'failed',
            message.payload.error,
            null
          );
          return;
        default:
          throw new ProtocolValidationError(
            'PROTOCOL_EVENT_OPERATION_UNEXPECTED',
            `Unexpected worker event operation: ${message.operation}`,
            '/operation'
          );
      }
    }

    function onMessage(rawMessage) {
      if (record.terminal) {
        reportDiagnostic({ type: 'late-message', actionKey, operationKey, jobId });
        return;
      }
      try {
        if (record.startDispatchState !== 'dispatching' && record.startDispatchState !== 'sent') {
          throw new ProtocolValidationError(
            'PROTOCOL_EVENT_BEFORE_JOB_START',
            'Worker event arrived outside job:start dispatch causality',
            '/operation'
          );
        }
        const message = validateJobEnvelope(rawMessage, expectedEventRoute(), {
          policyRegistry: options.policyRegistry
        });
        record.incomingSeq.observe(message);

        if (nativeWorkerDurable) {
          record.eventChain = (record.eventChain || Promise.resolve())
            .then(() => processMessage(message))
            .catch((error) => failProtocol(error));
          return;
        }

        switch (message.operation) {
          case 'job:progress':
            observeProgressRate(message);
            if (onProgress) {
              try { onProgress(message.payload.progress); } catch (error) { reportProgressObserverError(error); }
            }
            return;
          case 'unit:progress': {
            unitForMessage(message);
            observeProgressRate(message);
            if (onProgress) {
              try { onProgress(message.payload.progress, Object.freeze({ unitId: message.unitId })); } catch (error) {
                reportProgressObserverError(error);
              }
            }
            return;
          }
          case 'unit:done': {
            const unit = unitForMessage(message);
            unit.result = validateResultBody(policy, message.payload.result, record.resultValidator);
            unit.state = 'done';
            return;
          }
          case 'unit:error': {
            const unit = unitForMessage(message);
            unit.error = message.payload.error;
            unit.state = 'error';
            return;
          }
          case 'critical:ready':
          case 'commit:receipt':
            throw new ProtocolValidationError(
              'PROTOCOL_COMMIT_OPERATION_FORBIDDEN',
              `${message.operation} is not owned by this execution transport`,
              '/operation'
            );
          case 'cancel:ack':
            if (record.cancelCommandState !== 'dispatching' && record.cancelCommandState !== 'sent') {
              throw new ProtocolValidationError(
                'PROTOCOL_UNSOLICITED_CANCEL_ACK',
                'cancel:ack arrived without a dispatched cancel command',
                '/operation'
              );
            }
            if (record.cancelAckState !== 'none') {
              throw new ProtocolValidationError(
                'PROTOCOL_DUPLICATE_CANCEL_ACK',
                'cancel:ack may be observed at most once',
                '/operation'
              );
            }
            record.cancelAckState = 'acknowledged';
            return;
          case 'job:done': {
            const allowUnitError = policy.failure.unitBusinessError === 'collect-and-continue' ||
              policy.failure.unitTransportCrash === 'fail-unit-and-continue';
            const invalidUnits = [...record.units.values()].filter((unit) =>
              unit.state !== 'done' && !(allowUnitError && unit.state === 'error'));
            if (record.unknownUnits.size || invalidUnits.length) {
              throw new ProtocolValidationError(
                'PROTOCOL_JOB_DONE_GATE_FAILED',
                'job:done requires every registered unit to be in a policy-allowed terminal state',
                '/operation'
              );
            }
            const result = validateResultBody(policy, message.payload.result, record.resultValidator);
            finish('job:done', 'completed', null, result);
            return;
          }
          case 'job:error':
            for (const unit of record.units.values()) {
              if (unit.state === 'registered' || unit.state === 'running') unit.state = 'cancelled';
            }
            finish(
              'job:error',
              record.cancelTerminalEvidence ? 'cancelled' : 'failed',
              message.payload.error,
              null
            );
            return;
          default:
            throw new ProtocolValidationError(
              'PROTOCOL_EVENT_OPERATION_UNEXPECTED',
              `Unexpected worker event operation: ${message.operation}`,
              '/operation'
            );
        }
      } catch (error) {
        failProtocol(error);
      }
    }

    function send(operation, payload, unitId = null) {
      const identity = { channel: 'job', direction: 'command', jobId, workerInstanceId };
      const seq = record.outgoingSeq.next(identity);
      let envelope;
      try {
        envelope = createJobEnvelope({
          direction: 'command',
          operation,
          actionKey,
          operationKey,
          jobId,
          workerInstanceId,
          serviceGeneration,
          unitId,
          seq,
          context,
          payload
        }, { policyRegistry: options.policyRegistry });
      } catch (error) {
        failProtocol(error);
        return null;
      }
      try {
        if (operation === 'job:start') record.startDispatchState = 'dispatching';
        record.transport.send(envelope);
      } catch (error) {
        if (operation === 'job:start') record.startDispatchState = 'failed';
        if (!error.code) error.code = 'ADAPTER_SEND_FAILED';
        finish('adapter-error', 'transport-lost', error, null);
        return null;
      }
      if (operation === 'job:start') record.startDispatchState = 'sent';
      return envelope;
    }

    function sendCancel(reason) {
      if (record.terminal || !record.transport) return;
      record.state = 'cancelling';
      record.cancelCommandState = 'dispatching';
      const cancelEnvelope = send('job:cancel', { cancel: reason });
      if (!cancelEnvelope || record.terminal) return;
      record.cancelCommandState = 'sent';
      const timeoutMs = policy.cancellation.cooperativeTimeoutMs;
      const timer = setTimeout(() => {
        const error = new SupervisorError('CANCEL_TIMEOUT', `Cooperative cancellation timed out after ${timeoutMs}ms`);
        finish('cancel-timeout', 'transport-lost', error, null);
      }, timeoutMs);
      record.cancelTimer = timer;
      record.timers.add(timer);
    }

    function requestCancellation(reason, source) {
      if (record.terminal || record.cancelRequested) return false;
      if (record.state === 'protected') return false;
      const awaitingPreDispatch = record.state === 'queued' || record.state === 'admitting' ||
        (record.state === 'spawning' && !record.transport);
      const capability = policy.cancellation.capability;
      const allowed = awaitingPreDispatch || (source === 'shutdown'
        ? capability !== 'not-supported'
        : capability === 'user-cooperative');
      if (!allowed) return false;
      const ownedReason = normalizeCancelReason(reason);
      record.cancelRequested = true;
      record.cancelReason = ownedReason;
      record.cancelSource = source;
      record.cancelCommandState = 'pending';
      if (awaitingPreDispatch) {
        record.admissionAbortController.abort();
        if (policy.lifetime === 'service' && serviceHost && record.state === 'spawning' &&
            !record.transport && record.serviceGenerationCreated !== false) {
          Promise.resolve(serviceHost.closeService(policy.service.serviceKey, { force: true }))
            .catch((error) => reportDiagnostic({
              type: 'service-start-cancel-cleanup-error',
              actionKey,
              operationKey,
              jobId,
              code: error && error.code || 'SERVICE_CLOSE_FAILED'
            }));
        }
        const error = new SupervisorError('ADMISSION_CANCELLED', 'Execution was cancelled during admission');
        finish('spawn-error', 'cancelled', error, null);
      }
      if (record.state === 'running') sendCancel(record.cancelReason);
      return true;
    }
    record.requestCancellation = requestCancellation;

    function resolveAdapter() {
      if (policy.adapterKind === 'existing-dispatch') {
        const configured = record.adapterBinding;
        if (!configured) throw new SupervisorError('ADAPTER_NOT_FOUND', `Adapter is not registered: ${policy.adapterKey}`);
        const publicAdapter = typeof configured === 'function' ||
          (configured && typeof configured.dispatch === 'function')
          ? createExistingDispatchAdapter({ dispatch: configured })
          : configured;
        return Object.freeze({
          adapter: createExistingDispatchTransportAdapter(publicAdapter),
          inspectTopology: publicAdapter.inspectTopology
        });
      }
      const adapter = defaultAdapters[policy.mode];
      if (!adapter) throw new SupervisorError('ADAPTER_NOT_FOUND', `No native adapter for mode ${policy.mode}`);
      if (!record.entry) throw new SupervisorError('ENTRY_NOT_FOUND', `Entry is not registered: ${policy.entryKey}`);
      return Object.freeze({ adapter, inspectTopology: null });
    }

    function admissionRequest(resources) {
      return {
        ownerKey: `job:${jobId}`,
        actionKey,
        operationKey,
        resources,
        priority: policy.resources.admissionPriority || 'normal',
        timeoutMs: request.initTimeoutMs === undefined ? (options.initTimeoutMs || 5000) : request.initTimeoutMs,
        signal: record.admissionAbortController.signal,
        lowMemoryBehavior: policy.resources.lowMemoryBehavior === 'reject' ? 'reject' : 'queue'
      };
    }

    function freezeTopology(inspectTopology) {
      if (!policy.resources.compound) return null;
      let effectiveChildCount;
      if (inspectTopology) {
        const inspected = inspectTopology(Object.freeze({
          actionKey,
          operationKey,
          jobId,
          context,
          input: request.input || {}
        }));
        if (inspected && typeof inspected.then === 'function') {
          throw new SupervisorError(
            'TOPOLOGY_INSPECTOR_ASYNC_UNSUPPORTED',
            'Existing topology inspection must complete synchronously before admission'
          );
        }
        const owned = canonicalJsonSnapshot(inspected);
        if (!owned || typeof owned !== 'object' || Array.isArray(owned) ||
            Object.keys(owned).length !== 1 || !Object.hasOwn(owned, 'effectiveChildCount')) {
          throw new SupervisorError(
            'TOPOLOGY_INSPECTION_INVALID',
            'Topology inspector must return exactly { effectiveChildCount }'
          );
        }
        effectiveChildCount = owned.effectiveChildCount;
      } else {
        effectiveChildCount = policy.production.effectiveWorkerCount || 1;
      }
      if (!Number.isSafeInteger(effectiveChildCount) || effectiveChildCount < 1 ||
          effectiveChildCount > policy.resources.compound.childrenMax) {
        throw new SupervisorError(
          'TOPOLOGY_CHILD_COUNT_INVALID',
          'effectiveChildCount must be within the declared compound childrenMax'
        );
      }
      return Object.freeze({
        topologyKey: policy.resources.compound.topologyKey,
        childrenMax: policy.resources.compound.childrenMax,
        childResource: policy.resources.compound.childResource,
        effectiveChildCount
      });
    }

    async function acquireSimpleJobResources({ includeBase }) {
      if (!resourceGovernor) return true;
      if (includeBase) {
        const baseLease = await resourceGovernor.acquireBaseLease(admissionRequest(policy.resources.base));
        if (!retainGrantedLease(baseLease)) return false;
      }
      const phaseLease = await resourceGovernor.acquirePhaseLease(admissionRequest(policy.resources.phase));
      return retainGrantedLease(phaseLease);
    }

    async function acquireCompoundResources(existingBase = null) {
      if (!resourceGovernor) {
        throw new SupervisorError('RESOURCE_GOVERNOR_REQUIRED', 'Compound execution requires ResourceGovernor');
      }
      const ownerKey = existingBase ? `service:${policy.service.serviceKey}` : `job:${jobId}`;
      const lease = await resourceGovernor.acquireCompoundLease({
        ...admissionRequest(checkedAdd(policy.resources.base, policy.resources.phase)),
        ownerKey,
        base: existingBase ? existingBase.resources : policy.resources.base,
        phase: policy.resources.phase,
        childResource: record.topology.childResource,
        childrenMax: record.topology.childrenMax,
        effectiveChildCount: record.topology.effectiveChildCount,
        lowMemoryBehavior: policy.resources.lowMemoryBehavior,
        ...(existingBase ? { existingBaseLeaseId: existingBase.leaseId } : {})
      });
      if (!retainGrantedLease(lease)) return false;
      if (lease.effectiveChildCount !== record.topology.effectiveChildCount) {
        record.topology = Object.freeze({
          ...record.topology,
          effectiveChildCount: lease.effectiveChildCount,
          downgraded: true,
          downgradeReason: lease.downgradeReason
        });
      }
      record.metrics.workerCount = lease.effectiveChildCount;
      return true;
    }

    async function start() {
      let candidate = null;
      try {
        if (record.terminal) return;
        record.state = 'admitting';
        let resolved = null;
        if (policy.lifetime === 'job') resolved = resolveAdapter();
        record.topology = freezeTopology(resolved && resolved.inspectTopology);
        if (policy.lifetime === 'job') {
          const admitted = record.topology
            ? await acquireCompoundResources()
            : await acquireSimpleJobResources({ includeBase: true });
          if (!admitted) return;
        } else if (!record.topology) {
          if (!await acquireSimpleJobResources({ includeBase: false })) return;
        }
        if (record.terminal) return;
        record.state = 'spawning';
        const callbacks = {
          onMessage,
          onCancellationTerminal() {
            if (!record.terminal && record.cancelRequested &&
                (record.cancelCommandState === 'dispatching' || record.cancelCommandState === 'sent')) {
              record.cancelTerminalEvidence = true;
            }
          },
          onError(error) {
            if (error instanceof ProtocolValidationError || error instanceof ServiceHostProtocolError) {
              failProtocol(error);
            }
            else finish('adapter-error', 'transport-lost', error, null);
          },
          onExit(code, signal) {
            if (!record.terminal) {
              const error = new SupervisorError(
                'UNEXPECTED_EXIT',
                `Execution transport exited before terminal (code=${code}, signal=${signal || ''})`
              );
              finish('unexpected-exit', 'transport-lost', error, null);
            }
          }
        };
        if (policy.lifetime === 'service') {
          if (!serviceHost) {
            throw new SupervisorError('RESOURCE_GOVERNOR_REQUIRED', 'Service execution requires ResourceGovernor');
          }
          const hostSnapshot = serviceHost.snapshot();
          if (hostSnapshot.services.some((service) =>
            service.serviceKey === policy.service.serviceKey)) {
            record.serviceGenerationCreated = false;
          }
          candidate = await serviceHost.openJob({
            actionKey,
            operationKey,
            jobId,
            production: request.production === true,
            initTimeoutMs: request.initTimeoutMs === undefined ? (options.initTimeoutMs || 5000) : request.initTimeoutMs,
            ...callbacks
          });
          record.transport = candidate;
          record.serviceGenerationCreated = serviceTransportCreatedGeneration(candidate);
          workerInstanceId = candidate.workerInstanceId;
          serviceGeneration = candidate.serviceGeneration;
          record.workerInstanceId = workerInstanceId;
          if (record.terminal) return;
          if (record.topology) {
            record.state = 'admitting';
            if (!await acquireCompoundResources({
              leaseId: candidate.baseLeaseId,
              resources: candidate.baseResources
            })) return;
          }
        } else {
          candidate = resolved.adapter.start({
            entry: record.entry,
            policy,
            topology: record.topology,
            ...callbacks
          });
        }
        record.transport = candidate;
        if (!candidate || typeof candidate !== 'object' ||
            !candidate.ready || typeof candidate.ready.then !== 'function' ||
            typeof candidate.send !== 'function' || typeof candidate.close !== 'function' ||
            typeof candidate.terminate !== 'function') {
          throw new SupervisorError(
            'ADAPTER_HANDLE_INVALID',
            'Execution adapter must return ready/send/close/terminate APIs'
          );
        }
      } catch (error) {
        if (candidate) record.transport = candidate;
        finish('spawn-error', record.cancelRequested ? 'cancelled' : 'transport-lost', error, null);
        return;
      } finally {
        finishTransportAssignment();
      }
      if (record.terminal) return;

      try {
        await promiseWithTimeout(
          record.transport.ready,
          request.initTimeoutMs === undefined ? (options.initTimeoutMs || 5000) : request.initTimeoutMs,
          () => new SupervisorError('INIT_TIMEOUT', 'Execution transport initialization timed out')
        );
      } catch (error) {
        if (error && error.code === 'INIT_TIMEOUT') finish('init-timeout', 'transport-lost', error, null);
        else finish('spawn-error', 'transport-lost', error, null);
        return;
      }
      if (record.terminal) return;
      record.state = 'running';
      record.metrics.startedAt = now();
      if (!send('job:start', { input: request.input || {} }) || record.terminal) return;
      finishDispatchReady();
      if (request.deferUnitStart !== true) {
        for (const [unitId, unit] of record.units) {
          unit.state = 'running';
          if (!send('unit:start', { input: unit.input }, unitId) || record.terminal) return;
        }
      }
      if (record.cancelRequested) sendCancel(record.cancelReason);
      if (record.terminal) return;

      const executionTimeoutMs = request.executionTimeoutMs === undefined
        ? options.executionTimeoutMs
        : request.executionTimeoutMs;
      if (Number.isFinite(executionTimeoutMs) && executionTimeoutMs >= 0) {
        const timer = setTimeout(() => {
          const error = new SupervisorError('EXECUTION_TIMEOUT', `Execution timed out after ${executionTimeoutMs}ms`);
          finish('execution-timeout', 'transport-lost', error, null);
        }, executionTimeoutMs);
        record.timers.add(timer);
      }
    }

    queueMicrotask(() => {
      start().catch((error) => {
        finishTransportAssignment();
        if (error instanceof ProtocolValidationError || error instanceof ServiceHostProtocolError) failProtocol(error);
        else finish('adapter-error', 'transport-lost', error, null);
      });
    });

    const control = Object.freeze({
      jobId,
      promise,
      ready: dispatchReady,
      cancel(reason = { reason: 'cancelled' }) {
        return requestCancellation(reason, 'user');
      },
      startUnit(unitId, ...identityOverrides) {
        let resolveDispatchAccepted;
        const dispatchAccepted = new Promise((resolve) => { resolveDispatchAccepted = resolve; });
        const terminal = (async () => {
          try {
            if (request.deferUnitStart !== true) {
              throw new SupervisorError('UNIT_DEFERRED_START_DISABLED', 'This job eagerly dispatches units');
            }
            if (identityOverrides.length !== 0) {
              throw new SupervisorError(
                'UNIT_INPUT_OVERRIDE_FORBIDDEN',
                'Deferred unit input is frozen at parent job registration'
              );
            }
            const unit = record.units.get(unitId);
            if (!unit || unit.state !== 'registered' || record.terminal) {
              throw new SupervisorError('UNIT_START_STATE_INVALID', `Unit cannot start: ${String(unitId)}`);
            }
            unit.state = 'queued';
            await record.dispatchReady;
            if (record.terminal) {
              resolveDispatchAccepted(false);
              return unit.terminalPromise;
            }
            if (record.state !== 'running' || !record.transport) {
              throw new SupervisorError('UNIT_START_STATE_INVALID', `Unit cannot start: ${String(unitId)}`);
            }
            unit.state = 'running';
            const accepted = Boolean(send('unit:start', { input: unit.input }, unitId) && !record.terminal);
            resolveDispatchAccepted(accepted);
            return unit.terminalPromise;
          } catch (error) {
            resolveDispatchAccepted(false);
            throw error;
          }
        })();
        Object.defineProperty(terminal, 'dispatchAccepted', {
          value: dispatchAccepted,
          enumerable: false,
          configurable: false,
          writable: false
        });
        return terminal;
      },
      snapshot() {
        return Object.freeze({
          actionKey,
          operationKey,
          jobId,
          state: record.state,
          units: Object.freeze(Object.fromEntries([...record.units].map(([key, value]) => [key, value.state])))
        });
      }
    });
    record.control = control;
    return control;
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

  function timerSafeDuration(timeoutMs) {
    if (timeoutMs === Number.POSITIVE_INFINITY) return MAX_TIMER_DELAY_MS;
    return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Math.ceil(timeoutMs)));
  }

  function waitUntil(promises, timeoutMs) {
    if (!promises.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const deadline = deadlineAfter(timeoutMs);
      const armTimeout = () => {
        timer = setTimeout(() => {
          if (settled) return;
          if (remainingTimeout(deadline) > 0) {
            armTimeout();
            return;
          }
          settled = true;
          resolve(false);
        }, timerSafeDuration(remainingTimeout(deadline)));
      };
      armTimeout();
      Promise.allSettled(promises).then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  return Object.freeze({
    start(request) {
      return startExecution(request);
    },
    execute(request) {
      try {
        return startExecution(request).promise;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async cancel(jobId, reason = { reason: 'cancelled' }) {
      if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new SupervisorError('JOB_ID_INVALID', 'cancel jobId must be a non-empty string');
      }
      const record = jobs.get(jobId);
      if (!record) return Object.freeze({ jobId, accepted: false, status: 'not-found' });
      const accepted = record.control.cancel(reason);
      return Object.freeze({
        jobId,
        accepted,
        status: accepted ? 'cancelling' : 'not-cancellable'
      });
    },
    inspect(jobId) {
      const record = jobs.get(jobId);
      return record ? Object.freeze({
        actionKey: record.actionKey,
        operationKey: record.operationKey,
        jobId: record.jobId,
        state: record.state,
        workerInstanceId: record.workerInstanceId,
        units: Object.freeze(Object.fromEntries(
          [...record.units].map(([key, value]) => [key, value.state])
        ))
      }) : null;
    },
    async closeService(serviceKey) {
      if (typeof serviceKey !== 'string' || serviceKey.length === 0) {
        throw new SupervisorError('SERVICE_KEY_INVALID', 'closeService serviceKey must be a non-empty string');
      }
      if (!serviceHost) {
        throw new SupervisorError('SERVICE_HOST_UNAVAILABLE', 'ServiceHost requires ResourceGovernor');
      }
      return serviceHost.closeService(serviceKey);
    },
    stopAcceptingNewJobs() {
      acceptingNewJobs = false;
    },
    async shutdown(shutdownOptions = {}) {
      const fallbackTimeoutMs = Number.isFinite(options.shutdownTimeoutMs) && options.shutdownTimeoutMs >= 0
        ? options.shutdownTimeoutMs
        : 5000;
      const timeoutMs = Number.isFinite(shutdownOptions.timeoutMs) && shutdownOptions.timeoutMs >= 0
        ? shutdownOptions.timeoutMs
        : fallbackTimeoutMs;
      const forceServices = shutdownOptions.forceServices === true;
      const deadline = deadlineAfter(timeoutMs);
      acceptingNewJobs = false;
      if (serviceHost) serviceHost.stopAcceptingNewServices();
      if (resourceGovernor) closeResourceGovernor(resourceGovernor, 'supervisor-shutdown');
      const active = [...jobs.values()];
      const protectedJobs = [];
      for (const record of active) {
        if (record.terminal || record.cancelRequested) continue;
        if (!record.requestCancellation({ reason: 'supervisor-shutdown' }, 'shutdown')) {
          protectedJobs.push(record.jobId);
        }
      }

      const resultsByJob = new Map();
      const resultObservers = active.map((record) => record.promise.then((result) => {
        resultsByJob.set(record.jobId, result);
        return result;
      }));
      const settledBeforeTimeout = await waitUntil(resultObservers, remainingTimeout(deadline));
      const reportErrors = [];
      if (!settledBeforeTimeout) {
        for (const record of active) {
          if (record.terminal) continue;
          const error = new SupervisorError(
            'SHUTDOWN_TIMEOUT',
            `Job ${record.jobId} did not settle within shutdown timeout ${timeoutMs}ms`
          );
          reportErrors.push(toProtocolError(error, error.code, {
            maxErrorItems: record.policy.result.maxErrorItems,
            privacyProfile: record.policy.metrics.privacyProfile,
            stage: 'shutdown'
          }));
          record.finish('adapter-error', 'transport-lost', error, null, { forceTransport: true });
        }
        await waitUntil(resultObservers, remainingTimeout(deadline));
      }

      const cleanupRecords = [...new Map(
        [...active, ...pendingTransportCleanups.values(), ...failedTransportCleanups.values()]
          .map((record) => [record.jobId, record])
      ).values()];
      await waitUntil(
        cleanupRecords.map((record) => record.transportCleanup || Promise.resolve()),
        remainingTimeout(deadline)
      );

      const leakedTransports = [];
      for (const record of cleanupRecords) {
        if (record.transport && (!record.transportCleanupSettled || record.transportCleanupErrors.length)) {
          leakedTransports.push(record.jobId);
          if (!record.transportCleanupSettled) {
            const error = new SupervisorError(
              'SHUTDOWN_TRANSPORT_LEAK',
              `Transport for job ${record.jobId} did not close within shutdown timeout ${timeoutMs}ms`
            );
            reportErrors.push(toProtocolError(error, error.code, {
              maxErrorItems: record.policy.result.maxErrorItems,
              privacyProfile: record.policy.metrics.privacyProfile,
              stage: 'shutdown'
            }));
          }
        }
        for (const cleanupError of record.transportCleanupErrors) {
          reportErrors.push(toProtocolError(
            cleanupError.error,
            cleanupError.error.code || 'TRANSPORT_CLEANUP_ERROR',
            {
              maxErrorItems: record.policy.result.maxErrorItems,
              privacyProfile: record.policy.metrics.privacyProfile,
              stage: 'cleanup'
            }
          ));
        }
      }
      const closedServices = serviceHost
        ? serviceHost.snapshot().services.map((service) => service.serviceKey)
        : [];
      const serviceResults = serviceHost
        ? await serviceHost.shutdown({
            force: forceServices,
            timeoutMs: timerSafeDuration(remainingTimeout(deadline))
          })
        : [];
      for (const result of serviceResults) {
        if (result.status === 'rejected') {
          const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          reportErrors.push(toProtocolError(error, error.code || 'SERVICE_CLOSE_FAILED', {
            maxErrorItems: 100,
            stage: 'shutdown'
          }));
        }
      }
      return Object.freeze({
        closedServices: Object.freeze(closedServices),
        cancelledJobs: Object.freeze([...resultsByJob.values()]
          .filter((result) => result.outcome === 'cancelled')
          .map((result) => result.jobId)),
        protectedJobs: Object.freeze(protectedJobs),
        interruptedTasks: Object.freeze([]),
        activeHolds: Object.freeze([]),
        leakedTransports: Object.freeze([...new Set(leakedTransports)]),
        errors: Object.freeze(reportErrors)
      });
    }
  });
}

module.exports = {
  SupervisorError,
  createExecutionSupervisor,
  normalizeCancelReason,
  promiseWithTimeout,
  snapshotExecuteRequest,
  validateResultBody
};
