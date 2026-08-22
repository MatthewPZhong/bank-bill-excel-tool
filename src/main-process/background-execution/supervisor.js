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
  const now = options.now || Date.now;
  const diagnostics = options.diagnostics || (() => {});
  const defaultAdapters = Object.freeze({
    'inline-async': options.inlineAsyncAdapter || createInlineAsyncAdapter(),
    'thread-single': options.workerThreadAdapter || createWorkerThreadAdapter(),
    'thread-pool': options.workerThreadAdapter || createWorkerThreadAdapter(),
    'utility-process': options.utilityProcessAdapter || createUtilityProcessAdapter()
  });
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
    if (policy.lifetime !== 'job') {
      throw new SupervisorError('E02A_SERVICE_UNSUPPORTED', 'E02-A supervisor does not host service-lifetime actions');
    }
    if (policy.commit.kind !== 'none') {
      throw new SupervisorError('E02A_DURABLE_COMMIT_UNSUPPORTED', 'E02-A supervisor only executes commit.kind=none actions');
    }

    const context = request.context === undefined
      ? (policy.context.kind === 'none' ? canonicalJsonSnapshot({ kind: 'none', value: {} }) : null)
      : request.context;
    if (!context) throw new SupervisorError('CONTEXT_REQUIRED', 'Execute request requires policy context');
    const jobId = request.jobId || (options.idFactory ? options.idFactory('job') : makeId('job'));
    const workerInstanceId = request.workerInstanceId ||
      (options.idFactory ? options.idFactory('worker') : makeId('worker'));
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
      units.set(unitId, { state: 'registered', input, result: null, error: null });
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
      serviceGeneration: null,
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
        serviceGeneration: null,
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
        await promiseWithTimeout(
          Promise.resolve().then(callback),
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
        const terminateRequired = force || policy.adapterKind !== 'existing-dispatch';
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

    function stageForTerminal(terminalSource) {
      if (terminalSource === 'spawn-error' || terminalSource === 'init-timeout') return 'spawn';
      if (terminalSource === 'cancel-timeout') return 'cancel';
      if (terminalSource === 'protocol-error') return 'protocol';
      return 'execute';
    }

    function finish(terminalSource, outcome, error, result = null, finishOptions = {}) {
      if (record.terminal) {
        reportDiagnostic({ type: 'late-terminal', actionKey, operationKey, jobId, terminalSource });
        return false;
      }
      record.terminal = true;
      record.state = 'settled';
      record.metrics.endedAt = now();
      clearTimers();
      const forceTransport = finishOptions.forceTransport === undefined
        ? !['job:done', 'job:error'].includes(terminalSource)
        : finishOptions.forceTransport;
      const safeError = error
        ? toProtocolError(error, 'BACKGROUND_EXECUTION_ERROR', safeErrorOptions(stageForTerminal(terminalSource)))
        : null;
      const terminalResult = result === null ? null : canonicalJsonSnapshot(result);
      record.settlePromise = Promise.resolve().then(async () => {
        await cleanupTransport({ force: forceTransport });
        const executionResult = createExecutionResult({
          actionKey,
          operationKey,
          jobId,
          outcome,
          terminalSource,
          result: terminalResult,
          error: safeError,
          receiptHint: null,
          metrics: record.metrics
        });
        jobs.delete(jobId);
        resolvePromise(executionResult);
        return executionResult;
      });
      return true;
    }
    record.finish = finish;
    record.cleanupTransport = cleanupTransport;

    function failProtocol(error) {
      const protocolError = error instanceof Error ? error : new Error('Protocol validation failed');
      if (!protocolError.code) protocolError.code = 'PROTOCOL_ERROR';
      finish('protocol-error', 'transport-lost', protocolError, null);
    }

    function expectedEventRoute() {
      return {
        actionKey,
        operationKey,
        jobId,
        workerInstanceId,
        serviceGeneration: null,
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
        const terminalStates = ['done', 'error', 'cancelled'];
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
              `${message.operation} is forbidden for commit.kind=none`,
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
          serviceGeneration: null,
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
      const capability = policy.cancellation.capability;
      const allowed = source === 'shutdown'
        ? capability !== 'not-supported'
        : capability === 'user-cooperative';
      if (!allowed) return false;
      const ownedReason = normalizeCancelReason(reason);
      record.cancelRequested = true;
      record.cancelReason = ownedReason;
      record.cancelSource = source;
      record.cancelCommandState = 'pending';
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
        return createExistingDispatchTransportAdapter(publicAdapter);
      }
      const adapter = defaultAdapters[policy.mode];
      if (!adapter) throw new SupervisorError('ADAPTER_NOT_FOUND', `No native adapter for mode ${policy.mode}`);
      if (!record.entry) throw new SupervisorError('ENTRY_NOT_FOUND', `Entry is not registered: ${policy.entryKey}`);
      return adapter;
    }

    async function start() {
      record.state = 'spawning';
      let candidate = null;
      try {
        const adapter = resolveAdapter();
        candidate = adapter.start({
          entry: record.entry,
          policy,
          onMessage,
          onCancellationTerminal() {
            if (!record.terminal && record.cancelRequested &&
                (record.cancelCommandState === 'dispatching' || record.cancelCommandState === 'sent')) {
              record.cancelTerminalEvidence = true;
            }
          },
          onError(error) {
            if (error instanceof ProtocolValidationError) failProtocol(error);
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
        });
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
        finishTransportAssignment();
        finish('spawn-error', 'transport-lost', error, null);
        return;
      }
      finishTransportAssignment();
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
      for (const [unitId, unit] of record.units) {
        unit.state = 'running';
        if (!send('unit:start', { input: unit.input }, unitId) || record.terminal) return;
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
        if (error instanceof ProtocolValidationError) failProtocol(error);
        else finish('adapter-error', 'transport-lost', error, null);
      });
    });

    const control = Object.freeze({
      jobId,
      promise,
      cancel(reason = { reason: 'cancelled' }) {
        return requestCancellation(reason, 'user');
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

  function remainingTimeout(deadline) {
    return Math.max(0, deadline - Date.now());
  }

  function waitUntil(promises, timeoutMs) {
    if (!promises.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
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
      throw new SupervisorError(
        'E02A_SERVICE_UNSUPPORTED',
        `E02-A ExecutionSupervisor does not own service lifecycle: ${serviceKey}`
      );
    },
    stopAcceptingNewJobs() {
      acceptingNewJobs = false;
    },
    async shutdown(shutdownOptions = {}) {
      acceptingNewJobs = false;
      const timeoutMs = Number.isFinite(shutdownOptions.timeoutMs) && shutdownOptions.timeoutMs >= 0
        ? shutdownOptions.timeoutMs
        : (options.shutdownTimeoutMs || 5000);
      const deadline = Date.now() + timeoutMs;
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
      return Object.freeze({
        closedServices: Object.freeze([]),
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
