'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const { createUtilityProcessAdapter } = require('./adapters/utility-process-adapter');
const { createWorkerThreadAdapter } = require('./adapters/worker-thread-adapter');
const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('./protocol');
const {
  canonicalJsonSnapshot,
  validateJobEnvelope,
  validateServiceControlEnvelope
} = require('./protocol-validator');
const { expandDynamicResourceVector, componentMax } = require('./resource-lease');
const { MAX_TIMER_DELAY_MS } = require('./admission-queue');
const { releaseResourceWhenUnreferenced } = require('./resource-governor');
const { createDirectionSequenceTracker } = require('./sequence-tracker');

const REQUEST_MATRIX = Object.freeze({
  'persistent-state-replace': Object.freeze({ ownerKind: 'service-state', leaseMethod: 'acquirePersistentReservation', resourceKey: 'persistentState' }),
  'pending-interaction-create': Object.freeze({ ownerKind: 'interaction-token', leaseMethod: 'acquirePendingInteractionReservation', resourceKey: 'pendingInteraction' }),
  'phase-extension': Object.freeze({ ownerKind: 'phase', leaseMethod: 'acquirePhaseLease', resourceKey: 'phase' })
});
const REPLACEABLE_REQUEST_KINDS = Object.freeze([
  'persistent-state-replace',
  'pending-interaction-create'
]);
const serviceTransportOwnership = new WeakMap();

class ServiceHostError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ServiceHostError';
    this.code = code;
    this.details = details;
  }
}

class ServiceHostProtocolError extends ServiceHostError {
  constructor(code, message, details = null) {
    super(code, message, details);
    this.name = 'ServiceHostProtocolError';
  }
}

function validateTimerDuration(value, code, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new ServiceHostError(
      code,
      `${name} must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`
    );
  }
  return value;
}

function serviceTransportCreatedGeneration(transport) {
  const owned = serviceTransportOwnership.get(transport);
  if (typeof owned === 'boolean') return owned;
  if (!transport || typeof transport !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(transport, 'createdGeneration');
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'boolean'
    ? descriptor.value
    : null;
}

function defaultIdFactory(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function carrierKind(policy) {
  if (policy.mode === 'utility-process') return 'utility-process';
  if (policy.mode === 'thread-single' || policy.mode === 'thread-pool') return 'worker-thread';
  throw new ServiceHostError('SERVICE_MODE_UNSUPPORTED', `Unsupported service mode: ${policy.mode}`);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jobRefMatches(left, right) {
  return isDeepStrictEqual(left, right);
}

function vectorWithin(requested, maximum) {
  return requested.cpuSlots <= maximum.cpuSlots &&
    requested.ioHeavySlots <= maximum.ioHeavySlots &&
    requested.memoryBytes <= maximum.memoryBytes;
}

function createServiceHost(options = {}) {
  if (!options.policyRegistry || typeof options.policyRegistry.assertRunnable !== 'function' ||
      typeof options.policyRegistry.list !== 'function' || typeof options.policyRegistry.getBinding !== 'function') {
    throw new TypeError('ServiceHost requires a frozen policyRegistry');
  }
  if (!options.resourceGovernor) throw new TypeError('ServiceHost requires resourceGovernor');
  const policyRegistry = options.policyRegistry;
  const governor = options.resourceGovernor;
  const idFactory = options.idFactory || defaultIdFactory;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const diagnostics = options.diagnostics || (() => {});
  const persistentStateAdoptionGate = typeof options.persistentStateAdoptionGate === 'function'
    ? options.persistentStateAdoptionGate
    : null;
  const adapters = Object.freeze({
    'worker-thread': options.workerThreadAdapter || createWorkerThreadAdapter(),
    'utility-process': options.utilityProcessAdapter || createUtilityProcessAdapter()
  });
  const services = new Map();
  const starting = new Map();
  const lastGeneration = new Map();
  const usedIds = new Set();
  let acceptingNewServices = true;
  let shutdownStarted = false;

  function report(type, details) {
    try { diagnostics(Object.freeze({ type, at: now(), ...details })); } catch (_error) {}
  }

  function nextId(prefix) {
    const id = idFactory(prefix);
    if (typeof id !== 'string' || id.length === 0) {
      throw new ServiceHostError('SERVICE_ID_INVALID', `${prefix} ID must be a non-empty string`);
    }
    if (usedIds.has(id)) throw new ServiceHostError('SERVICE_ID_REUSED', `ServiceHost ID was reused: ${id}`);
    usedIds.add(id);
    return id;
  }

  function nextControlId(record) {
    const id = idFactory('control');
    if (typeof id !== 'string' || id.length === 0) {
      throw new ServiceHostError('SERVICE_ID_INVALID', 'control ID must be a non-empty string');
    }
    if (record.controlExchanges.has(id)) {
      throw new ServiceHostError(
        'SERVICE_CONTROL_ID_REUSED',
        `Service generation controlId was reused: ${id}`
      );
    }
    return id;
  }

  function servicePolicies(serviceKey) {
    const matches = policyRegistry.list().filter((policy) =>
      policy.lifetime === 'service' && policy.service && policy.service.serviceKey === serviceKey);
    if (matches.length === 0) {
      throw new ServiceHostError('SERVICE_POLICY_MISSING', `No service policies are registered for ${serviceKey}`);
    }
    const carrier = carrierKind(matches[0]);
    const entry = policyRegistry.getBinding(matches[0].actionKey, 'entryKey');
    for (const policy of matches.slice(1)) {
      if (carrierKind(policy) !== carrier || !isDeepStrictEqual(policy.service, matches[0].service)) {
        throw new ServiceHostError(
          'SERVICE_POLICY_CONFLICT',
          `Policies sharing ${serviceKey} must agree on carrier and service control configuration`
        );
      }
      if (!isDeepStrictEqual(policyRegistry.getBinding(policy.actionKey, 'entryKey'), entry)) {
        throw new ServiceHostError(
          'SERVICE_RUNTIME_BINDING_CONFLICT',
          `Policies sharing ${serviceKey} must resolve to one executable and capability descriptor`
        );
      }
    }
    if (matches.some((policy) => policy.service.busyPolicy !== 'reject')) {
      throw new ServiceHostError(
        'SERVICE_BUSY_POLICY_UNSUPPORTED',
        `ServiceHost does not implement busyPolicy for ${serviceKey}: ${matches[0].service.busyPolicy}`
      );
    }
    const cancellationTerminalErrorCodes = entry && typeof entry === 'object' &&
      Array.isArray(entry.cancellationTerminalErrorCodes)
      ? Object.freeze([...new Set(entry.cancellationTerminalErrorCodes)])
      : Object.freeze([]);
    return Object.freeze({
      policies: Object.freeze(matches),
      carrier,
      entry,
      cancellationTerminalErrorCodes,
      base: componentMax(matches.map((policy) => policy.resources.base)),
      policyDigest: digest(matches.map((policy) => policy.actionKey).sort().map((actionKey) =>
        matches.find((policy) => policy.actionKey === actionKey)))
    });
  }

  function commandEnvelope(record, operation, controlId, jobRef, payload) {
    const identity = {
      channel: 'service-control',
      serviceKey: record.serviceKey,
      workerInstanceId: record.workerInstanceId,
      serviceGeneration: record.serviceGeneration,
      direction: 'command'
    };
    return createServiceControlEnvelope({
      direction: 'command',
      operation,
      serviceKey: record.serviceKey,
      controlId,
      workerInstanceId: record.workerInstanceId,
      serviceGeneration: record.serviceGeneration,
      seq: record.controlSequences.next(identity),
      jobRef,
      payload
    }, { policyRegistry });
  }

  function expectedControlResponses(initiator, operation) {
    if (initiator === 'main') {
      if (operation === 'executor:close') return ['executor:close-ack'];
      if (operation === 'resource:revoke') return ['resource:release'];
      if (operation === 'executor:init') return [];
    } else {
      if (operation === 'resource:request') return ['resource:grant', 'resource:reject'];
      if (operation === 'resource:adopted') return ['resource:adopt-ack'];
      if (operation === 'resource:release') return ['resource:release-ack'];
      if (operation === 'executor:ready' || operation === 'executor:error') return [];
    }
    return null;
  }

  function createControlExchange(message, initiator, expectedOperations) {
    const payload = message.payload || {};
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    completion.catch(() => {});
    const exchange = {
      initiator,
      operation: message.operation,
      state: expectedOperations.length === 0 ? 'settled' : 'live',
      expectedOperations,
      jobRef: message.jobRef,
      requestId: payload.requestId || null,
      grantId: payload.grantId || null,
      reservationId: payload.reservationId || null,
      completion,
      completionSettled: expectedOperations.length === 0,
      resolveCompletion,
      rejectCompletion
    };
    if (exchange.completionSettled) resolveCompletion();
    return exchange;
  }

  function settleControlExchange(exchange, error = null) {
    if (!exchange || exchange.completionSettled) return false;
    exchange.completionSettled = true;
    exchange.state = 'settled';
    exchange.expectedOperations = [];
    if (error) exchange.rejectCompletion(error);
    else exchange.resolveCompletion();
    return true;
  }

  function claimControlExchange(record, message, initiator) {
    const prior = record.controlExchanges.get(message.controlId);
    if (prior) {
      throw new ServiceHostProtocolError(
        'SERVICE_CONTROL_ID_REUSED',
        `controlId was already used by ${prior.initiator} ${prior.operation}: ${message.controlId}`
      );
    }
    const expectedOperations = expectedControlResponses(initiator, message.operation);
    if (expectedOperations === null) {
      record.controlExchanges.set(message.controlId, createControlExchange(message, initiator, []));
      throw new ServiceHostProtocolError(
        'SERVICE_CONTROL_OPERATION_INVALID',
        `${initiator} cannot start a control exchange with ${message.operation}`
      );
    }
    const exchange = createControlExchange(message, initiator, expectedOperations);
    record.controlExchanges.set(message.controlId, exchange);
    return exchange;
  }

  function controlResponseMatches(exchange, message) {
    if (!exchange.expectedOperations.includes(message.operation) ||
        !jobRefMatches(exchange.jobRef, message.jobRef)) {
      return false;
    }
    if (exchange.operation === 'resource:request') {
      return exchange.requestId === message.payload.requestId;
    }
    if (exchange.operation === 'resource:adopted') {
      return exchange.requestId === message.payload.requestId &&
        exchange.grantId === message.payload.grantId &&
        exchange.reservationId === message.payload.reservationId;
    }
    if (exchange.operation === 'resource:revoke' || exchange.operation === 'resource:release') {
      return exchange.reservationId === message.payload.reservationId;
    }
    return exchange.operation === 'executor:close';
  }

  function correlationError(record, message, reason) {
    if (!record.controlExchanges.has(message.controlId)) {
      record.controlExchanges.set(
        message.controlId,
        createControlExchange(message, message.direction === 'command' ? 'main' : 'worker', [])
      );
    }
    return new ServiceHostProtocolError(
      'SERVICE_CONTROL_EXCHANGE_INVALID',
      `${message.operation} does not match a live control exchange: ${reason}`
    );
  }

  function prepareOutgoingControl(record, message) {
    const expectedOperations = expectedControlResponses('main', message.operation);
    if (expectedOperations !== null) {
      return claimControlExchange(record, message, 'main');
    }
    const exchange = record.controlExchanges.get(message.controlId);
    if (!exchange || exchange.state === 'settled' || !controlResponseMatches(exchange, message)) {
      throw correlationError(record, message, 'outbound response correlation failed');
    }
    const validResponse = exchange.initiator === 'worker' ||
      (exchange.operation === 'resource:revoke' && exchange.state === 'response-observed');
    if (!validResponse) {
      throw correlationError(record, message, 'outbound response direction failed');
    }
    settleControlExchange(exchange);
    return exchange;
  }

  function observeIncomingControl(record, message) {
    const prior = record.controlExchanges.get(message.controlId);
    if (!prior) {
      if (message.operation === 'executor:close-ack') {
        throw correlationError(record, message, 'close acknowledgement has no live close');
      }
      return claimControlExchange(record, message, 'worker');
    }
    const isMainResponse = prior.initiator === 'main' && prior.state === 'live';
    if (!isMainResponse) {
      throw new ServiceHostProtocolError(
        'SERVICE_CONTROL_ID_REUSED',
        `controlId was already used by ${prior.initiator} ${prior.operation}: ${message.controlId}`
      );
    }
    if (!controlResponseMatches(prior, message)) {
      throw correlationError(record, message, 'inbound response correlation failed');
    }
    if (prior.operation === 'resource:revoke') {
      prior.state = 'response-observed';
      prior.expectedOperations = ['resource:release-ack'];
    } else {
      settleControlExchange(prior);
    }
    return prior;
  }

  function sendControl(record, operation, controlId, jobRef, payload) {
    const message = commandEnvelope(record, operation, controlId, jobRef, payload);
    prepareOutgoingControl(record, message);
    record.rawTransport.send(message);
    return message;
  }

  function releaseOwnerClaim(record, ownerKey, requestId) {
    if (record.ownerClaims.get(ownerKey) !== requestId) return false;
    record.ownerClaims.delete(ownerKey);
    return true;
  }

  function serializeResourceMutation(record, callback) {
    const operation = record.resourceMutation.then(callback, callback);
    record.resourceMutation = operation.catch(() => {});
    return operation;
  }

  function settlePendingAdmission(pending) {
    if (!pending || pending.admissionDone) return false;
    pending.admissionDone = true;
    pending.resolveAdmission();
    return true;
  }

  function settleResourceRevoke(record, reservationId, error = null) {
    const waiter = record.resourceRevokeWaiters.get(reservationId);
    if (!waiter || waiter.settled) return false;
    waiter.settled = true;
    record.resourceRevokeWaiters.delete(reservationId);
    if (error) waiter.reject(error);
    else waiter.resolve();
    return true;
  }

  function settleAllResourceRevokes(record, error) {
    for (const reservationId of [...record.resourceRevokeWaiters.keys()]) {
      settleResourceRevoke(record, reservationId, error);
    }
  }

  function settleCloseWaiter(record, outcome) {
    if (!record.resolveCloseAck) return false;
    const resolve = record.resolveCloseAck;
    record.resolveCloseAck = null;
    resolve(outcome);
    return true;
  }

  function rejectStartup(record, error) {
    if (record.readySettled) return false;
    record.readySettled = true;
    record.rejectReady(error);
    return true;
  }

  function deadlineFromNow(timeoutMs, code, name) {
    const deadlineAt = now() + timeoutMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new ServiceHostError(code, `${name} deadline exceeds the safe integer range`);
    }
    return deadlineAt;
  }

  function gracefulCloseTimeout(record, timeoutMs, stage) {
    return new ServiceHostError(
      'SERVICE_GRACEFUL_CLOSE_TIMEOUT',
      `Service ${record.serviceKey} did not complete graceful ${stage} within ${timeoutMs}ms`
    );
  }

  function gracefulCloseInterrupted(record) {
    return record.closeError || new ServiceHostError(
      'SERVICE_GRACEFUL_CLOSE_INTERRUPTED',
      `Service ${record.serviceKey} terminated before graceful close completed`
    );
  }

  function jobDetachTimeout(record, job, timeoutMs, stage) {
    return new ServiceHostError(
      'SERVICE_JOB_DETACH_TIMEOUT',
      `Job ${job.jobId} did not complete ${stage} within ${timeoutMs}ms`
    );
  }

  function jobDetachInterrupted(record, job) {
    return record.closeError || new ServiceHostError(
      'SERVICE_JOB_DETACH_INTERRUPTED',
      `Service ${record.serviceKey} terminated before job ${job.jobId} detached`
    );
  }

  function resourceDrainTimeout(record, timeoutMs, stage, drainOptions = {}) {
    if (drainOptions.job) {
      return jobDetachTimeout(record, drainOptions.job, timeoutMs, stage);
    }
    return gracefulCloseTimeout(record, timeoutMs, stage);
  }

  function resourceDrainInterrupted(record, drainOptions = {}) {
    if (drainOptions.job) return jobDetachInterrupted(record, drainOptions.job);
    return gracefulCloseInterrupted(record);
  }

  function waitForAbsoluteDeadline(promise, deadlineAt, errorFactory) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
        callback(value);
      };
      const arm = () => {
        if (settled) return;
        const remaining = deadlineAt - now();
        if (remaining <= 0) {
          finish(reject, errorFactory());
          return;
        }
        timer = setTimer(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      Promise.resolve(promise).then(
        (value) => {
          if (now() >= deadlineAt) finish(reject, errorFactory());
          else finish(resolve, value);
        },
        (error) => finish(reject, error)
      );
      arm();
    });
  }

  function startupTimeoutError(timeoutMs) {
    return new ServiceHostError('SERVICE_INIT_TIMEOUT', `Service init timed out after ${timeoutMs}ms`);
  }

  function armReadyDeadline(record, timeoutMs) {
    if (record.closed || record.readySettled) return false;
    const remaining = record.readyDeadlineAt - now();
    if (remaining <= 0) {
      const error = startupTimeoutError(timeoutMs);
      rejectStartup(record, error);
      void fatal(record, error);
      return false;
    }
    record.readyTimer = setTimer(() => {
      record.readyTimer = null;
      armReadyDeadline(record, timeoutMs);
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    return true;
  }

  function armTentativeDeadline(record, tentative) {
    if (record.closed || tentative.settled) return false;
    const remaining = tentative.deadlineAt - now();
    if (remaining > 0) {
      tentative.timer = setTimer(() => {
        tentative.timer = null;
        void serializeResourceMutation(record, () => {
          if (record.closed || tentative.settled) return;
          if (now() < tentative.deadlineAt) {
            armTentativeDeadline(record, tentative);
            return;
          }
          if (!clearTentative(record, tentative, 'adoption-timeout') || record.closed) return;
          sendControl(record, 'resource:revoke', nextControlId(record), tentative.jobRef, {
            grantId: tentative.grantId,
            reservationId: tentative.reservationId,
            reasonCode: 'adoption-timeout'
          });
        }).catch((error) => fatal(record, error));
      }, Math.min(remaining, MAX_TIMER_DELAY_MS));
      return true;
    }
    return false;
  }

  function stableReservationIdentity(record, ownerKey) {
    return Object.freeze({
      ownerKey: `${record.serviceKey}:${ownerKey}`,
      actionKey: `service:${record.serviceKey}`,
      operationKey: null
    });
  }

  async function cleanupRawTransport(record) {
    if (!record.rawTransport) return;
    if (record.rawCleanupPromise) return record.rawCleanupPromise;
    const rawTransport = record.rawTransport;
    record.rawCleanupPromise = (async () => {
      if (!record.rawCloseCalled) {
        record.rawCloseCalled = true;
        try { await rawTransport.close(); } catch (error) {
          report('service-close-handle-error', {
            serviceKey: record.serviceKey,
            code: error && error.code || 'SERVICE_RAW_CLOSE_FAILED'
          });
        }
      }
      if (!record.rawTerminateCalled) {
        record.rawTerminateCalled = true;
        try { await rawTransport.terminate(); } catch (error) {
          report('service-terminate-error', {
            serviceKey: record.serviceKey,
            code: error && error.code || 'SERVICE_TERMINATE_FAILED'
          });
        }
      }
    })();
    return record.rawCleanupPromise;
  }

  function clearTentative(record, tentative, reason) {
    if (!tentative || tentative.settled) return false;
    tentative.settled = true;
    if (tentative.timer !== null) clearTimer(tentative.timer);
    tentative.timer = null;
    record.tentativeGrants.delete(tentative.grantId);
    record.pendingRequests.delete(tentative.requestId);
    releaseOwnerClaim(record, tentative.ownerKey, tentative.requestId);
    if (tentative.lease.state === 'granted') tentative.lease.release(reason);
    return true;
  }

  function forgetAdopted(record, adopted) {
    adopted.released = true;
    record.adoptedReservations.delete(adopted.reservationId);
    if (record.currentByOwner.get(adopted.ownerKey) === adopted) {
      record.currentByOwner.delete(adopted.ownerKey);
    }
  }

  function releaseAdopted(record, adopted, reason, releaseOptions = {}) {
    if (!adopted || adopted.released) return false;
    let released;
    try {
      released = adopted.lease.release(reason);
    } catch (error) {
      if (releaseOptions.deferIfReferenced === true && error &&
          error.code === 'RESOURCE_DEPENDENCY_ACTIVE') {
        releaseResourceWhenUnreferenced(governor, adopted.lease.leaseId, reason);
        forgetAdopted(record, adopted);
        report('service-reservation-release-deferred', {
          serviceKey: record.serviceKey,
          reservationId: adopted.reservationId,
          code: error.code
        });
        return true;
      }
      throw error;
    }
    if (!released) {
      throw new ServiceHostError(
        'SERVICE_RELEASE_FAILED',
        `Reservation release was not accepted: ${adopted.reservationId}`
      );
    }
    forgetAdopted(record, adopted);
    return true;
  }

  function tentativeByReservation(record, reservationId) {
    return [...record.tentativeGrants.values()].find((tentative) =>
      !tentative.settled && tentative.reservationId === reservationId) || null;
  }

  async function abortPendingAdmissions(record, deadlineAt, timeoutMs, drainOptions = {}) {
    const admissions = [];
    for (const pending of record.pendingRequests.values()) {
      if (drainOptions.job && pending.jobId !== drainOptions.job.jobId) continue;
      pending.abortController.abort();
      if (!pending.admissionDone) admissions.push(pending.admissionSettled);
    }
    if (admissions.length === 0) return;
    await waitForAbsoluteDeadline(
      Promise.allSettled(admissions),
      deadlineAt,
      () => resourceDrainTimeout(record, timeoutMs, 'pending admission drain', drainOptions)
    );
    if (record.closed) throw resourceDrainInterrupted(record, drainOptions);
  }

  async function revokeResourceGracefully(
    record,
    resourceKind,
    resource,
    deadlineAt,
    timeoutMs,
    drainOptions = {}
  ) {
    const waiter = await serializeResourceMutation(record, () => {
      if (record.closed) throw resourceDrainInterrupted(record, drainOptions);
      const liveResource = resourceKind === 'tentative'
        ? tentativeByReservation(record, resource.reservationId)
        : record.adoptedReservations.get(resource.reservationId);
      if (!liveResource || liveResource.released || liveResource.settled) return null;
      if (now() >= deadlineAt) {
        throw resourceDrainTimeout(record, timeoutMs, 'resource drain', drainOptions);
      }
      if (record.resourceRevokeWaiters.has(liveResource.reservationId)) {
        throw new ServiceHostError(
          'SERVICE_RESOURCE_REVOKE_DUPLICATE',
          `Reservation already has a graceful revoke: ${liveResource.reservationId}`
        );
      }
      const controlId = nextControlId(record);
      if (resourceKind === 'tentative') {
        liveResource.revoking = true;
        if (liveResource.timer !== null) clearTimer(liveResource.timer);
        liveResource.timer = null;
      } else {
        liveResource.revoking = true;
      }
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      promise.catch(() => {});
      const created = {
        reservationId: liveResource.reservationId,
        resourceKind,
        controlId,
        deadlineAt,
        timeoutMs,
        job: drainOptions.job || null,
        settled: false,
        resolve,
        reject,
        promise
      };
      record.resourceRevokeWaiters.set(liveResource.reservationId, created);
      try {
        sendControl(record, 'resource:revoke', controlId, liveResource.jobRef, {
          grantId: liveResource.grantId,
          reservationId: liveResource.reservationId,
          reasonCode: drainOptions.reasonCode || 'service-close'
        });
      } catch (error) {
        settleResourceRevoke(record, liveResource.reservationId, error);
        throw error;
      }
      return created;
    });
    if (!waiter) return;
    await waitForAbsoluteDeadline(
      waiter.promise,
      deadlineAt,
      () => resourceDrainTimeout(
        record,
        timeoutMs,
        'resource release handshake',
        drainOptions
      )
    );
    if (record.closed) throw resourceDrainInterrupted(record, drainOptions);
  }

  function jobRefBelongsTo(jobRef, job) {
    return Boolean(jobRef && jobRef.jobId === job.jobId &&
      jobRef.actionKey === job.actionKey && jobRef.operationKey === job.operationKey);
  }

  function jobOwnsTentative(tentative, job) {
    return !tentative.settled && jobRefBelongsTo(tentative.jobRef, job);
  }

  function jobRetainsAdopted(adopted, job) {
    if (!adopted || adopted.released) return false;
    if (adopted.requestKind === 'persistent-state-replace') return true;
    return adopted.requestKind === 'pending-interaction-create' &&
      adopted.tokenPublicationState === 'published' &&
      job.terminalOperation === 'job:done' &&
      jobRefBelongsTo(adopted.jobRef, job);
  }

  function jobOwnsAdopted(adopted, job) {
    return !adopted.released && !jobRetainsAdopted(adopted, job) &&
      jobRefBelongsTo(adopted.jobRef, job);
  }

  function jobHasDrainObligations(record, job) {
    return [...record.pendingRequests.values()].some((item) => item.jobId === job.jobId) ||
      [...record.tentativeGrants.values()].some((item) => jobOwnsTentative(item, job)) ||
      [...record.adoptedReservations.values()].some((item) => jobOwnsAdopted(item, job)) ||
      [...record.resourceRevokeWaiters.values()].some((item) => item.job === job) ||
      [...record.controlExchanges.values()].some((exchange) =>
        exchange.initiator === 'main' && exchange.operation === 'resource:revoke' &&
        !exchange.completionSettled && jobRefBelongsTo(exchange.jobRef, job));
  }

  async function drainJobResources(record, job, deadlineAt, timeoutMs) {
    const drainOptions = { job, reasonCode: 'job-detach' };
    await abortPendingAdmissions(record, deadlineAt, timeoutMs, drainOptions);
    for (const tentative of [...record.tentativeGrants.values()]) {
      if (!jobOwnsTentative(tentative, job)) continue;
      await revokeResourceGracefully(
        record,
        'tentative',
        tentative,
        deadlineAt,
        timeoutMs,
        drainOptions
      );
    }
    for (const adopted of [...record.adoptedReservations.values()]) {
      if (!jobOwnsAdopted(adopted, job)) continue;
      await revokeResourceGracefully(
        record,
        'adopted',
        adopted,
        deadlineAt,
        timeoutMs,
        drainOptions
      );
    }
    const outstandingRevokes = [...record.controlExchanges.values()]
      .filter((exchange) => exchange.initiator === 'main' &&
        exchange.operation === 'resource:revoke' && !exchange.completionSettled &&
        jobRefBelongsTo(exchange.jobRef, job))
      .map((exchange) => exchange.completion);
    if (outstandingRevokes.length) {
      await waitForAbsoluteDeadline(
        Promise.all(outstandingRevokes),
        deadlineAt,
        () => jobDetachTimeout(record, job, timeoutMs, 'outstanding revoke drain')
      );
      if (record.closed) throw jobDetachInterrupted(record, job);
    }
    await serializeResourceMutation(record, () => {
      if (record.closed) throw jobDetachInterrupted(record, job);
      if (jobHasDrainObligations(record, job)) {
        throw new ServiceHostError(
          'SERVICE_JOB_DRAIN_INCOMPLETE',
          `Job ${job.jobId} resource maps were not empty after detach drain`
        );
      }
    });
  }

  async function drainServiceResources(record, deadlineAt, timeoutMs) {
    await abortPendingAdmissions(record, deadlineAt, timeoutMs);
    for (const tentative of [...record.tentativeGrants.values()]) {
      await revokeResourceGracefully(
        record,
        'tentative',
        tentative,
        deadlineAt,
        timeoutMs
      );
    }
    for (const adopted of [...record.adoptedReservations.values()]) {
      await revokeResourceGracefully(
        record,
        'adopted',
        adopted,
        deadlineAt,
        timeoutMs
      );
    }
    const outstandingRevokes = [...record.controlExchanges.values()]
      .filter((exchange) => exchange.initiator === 'main' &&
        exchange.operation === 'resource:revoke' && !exchange.completionSettled)
      .map((exchange) => exchange.completion);
    if (outstandingRevokes.length) {
      await waitForAbsoluteDeadline(
        Promise.all(outstandingRevokes),
        deadlineAt,
        () => gracefulCloseTimeout(record, timeoutMs, 'outstanding revoke drain')
      );
      if (record.closed) throw gracefulCloseInterrupted(record);
    }
    await serializeResourceMutation(record, () => {
      if (record.closed) throw gracefulCloseInterrupted(record);
      if (record.pendingRequests.size || record.ownerClaims.size ||
          record.tentativeGrants.size || record.adoptedReservations.size ||
          record.currentByOwner.size || record.resourceRevokeWaiters.size) {
        throw new ServiceHostError(
          'SERVICE_GRACEFUL_DRAIN_INCOMPLETE',
          'Service resource maps were not empty after graceful drain'
        );
      }
    });
  }

  function closeGeneration(record, reason, error = null, closeOptions = {}) {
    if (!record) return Promise.resolve(false);
    if (record.generationClosePromise) {
      settleCloseWaiter(record, 'closed');
      return record.generationClosePromise;
    }
    const wasReady = record.state === 'ready' || record.state === 'draining' ||
      record.state === 'closing';
    if (error && !record.closeError) record.closeError = error;
    record.closed = true;
    record.state = 'closed';
    record.abortController.abort();
    if (record.readyTimer !== null) clearTimer(record.readyTimer);
    record.readyTimer = null;
    if (record.closeTimer !== null) clearTimer(record.closeTimer);
    record.closeTimer = null;
    settleCloseWaiter(record, 'closed');
    const closeError = gracefulCloseInterrupted(record);
    settleAllResourceRevokes(record, closeError);
    for (const exchange of record.controlExchanges.values()) {
      settleControlExchange(exchange, closeError);
    }
    services.delete(record.serviceKey);
    starting.delete(record.serviceKey);
    if (!wasReady) {
      rejectStartup(record, error || new ServiceHostError(
        'SERVICE_CLOSED_DURING_INIT',
        'Service closed during init'
      ));
    }
    record.generationClosePromise = (async () => {
      try {
        await serializeResourceMutation(record, async () => {
          for (const tentative of [...record.tentativeGrants.values()]) {
            try {
              clearTentative(record, tentative, reason === 'service-crash' ? 'service-crash' : 'service-close');
            } catch (cleanupError) {
              report('service-resource-cleanup-error', {
                serviceKey: record.serviceKey,
                reservationId: tentative.reservationId,
                code: cleanupError && cleanupError.code || 'SERVICE_TENTATIVE_RELEASE_FAILED'
              });
            }
          }
          for (const adopted of [...record.adoptedReservations.values()]) {
            try {
              releaseAdopted(
                record,
                adopted,
                reason === 'service-crash' ? 'service-crash' : 'service-close',
                { deferIfReferenced: true }
              );
            } catch (cleanupError) {
              report('service-resource-cleanup-error', {
                serviceKey: record.serviceKey,
                reservationId: adopted.reservationId,
                code: cleanupError && cleanupError.code || 'SERVICE_RESERVATION_RELEASE_FAILED'
              });
            }
          }
        });
        if (record.baseLease) {
          const releaseReason = reason === 'service-crash' ? 'service-crash' : 'service-close';
          try {
            const released = record.baseLease.release(releaseReason);
            if (released || record.baseLease.state === 'released') record.baseLease = null;
          } catch (cleanupError) {
            if (cleanupError && cleanupError.code === 'RESOURCE_DEPENDENCY_ACTIVE') {
              releaseResourceWhenUnreferenced(governor, record.baseLease.leaseId, releaseReason);
              report('service-base-release-deferred', {
                serviceKey: record.serviceKey,
                reservationId: record.baseLease.leaseId,
                code: cleanupError.code
              });
            } else {
              report('service-resource-cleanup-error', {
                serviceKey: record.serviceKey,
                reservationId: record.baseLease.leaseId,
                code: cleanupError && cleanupError.code || 'SERVICE_BASE_RELEASE_FAILED'
              });
            }
          }
          if (record.baseLease && record.baseLease.state === 'released') {
            record.baseLease = null;
          } else if (record.baseLease) {
            report('service-resource-cleanup-error', {
              serviceKey: record.serviceKey,
              reservationId: record.baseLease.leaseId,
              code: 'SERVICE_BASE_RELEASE_PENDING'
            });
          }
        }
        for (const job of record.jobs.values()) {
          try {
            if (closeOptions.exit && typeof job.onExit === 'function') {
              job.onExit(closeOptions.exit.code, closeOptions.exit.signal);
            } else if (error && typeof job.onError === 'function') {
              job.onError(error);
            } else if (typeof job.onExit === 'function') {
              job.onExit(null, reason);
            }
          } catch (callbackError) {
            report('service-job-callback-error', {
              serviceKey: record.serviceKey,
              jobId: job.jobId,
              code: callbackError && callbackError.code || 'SERVICE_JOB_CALLBACK_FAILED'
            });
          }
        }
        record.jobs.clear();
      } finally {
        await cleanupRawTransport(record);
        report('service-generation-closed', {
          serviceKey: record.serviceKey,
          generation: record.serviceGeneration,
          reason,
          graceful: closeOptions.graceful === true
        });
      }
      return true;
    })();
    return record.generationClosePromise;
  }

  function fatal(record, error) {
    const normalized = error instanceof Error ? error : new ServiceHostError('SERVICE_PROTOCOL_ERROR', String(error));
    report('service-fatal', {
      serviceKey: record.serviceKey,
      generation: record.serviceGeneration,
      code: normalized.code || 'SERVICE_FATAL'
    });
    return closeGeneration(record, 'service-crash', normalized).catch((cleanupError) => {
      report('service-fatal-cleanup-error', {
        serviceKey: record.serviceKey,
        generation: record.serviceGeneration,
        code: cleanupError && cleanupError.code || 'SERVICE_FATAL_CLEANUP_FAILED'
      });
      return false;
    });
  }

  function fatalExit(record, code, signal) {
    const error = new ServiceHostError(
      'SERVICE_UNEXPECTED_EXIT',
      `Service exited unexpectedly (code=${code}, signal=${signal})`
    );
    report('service-fatal', {
      serviceKey: record.serviceKey,
      generation: record.serviceGeneration,
      code: error.code
    });
    return closeGeneration(record, 'service-crash', error, {
      exit: Object.freeze({ code, signal: signal === undefined ? null : signal })
    }).catch((cleanupError) => {
      report('service-fatal-cleanup-error', {
        serviceKey: record.serviceKey,
        generation: record.serviceGeneration,
        code: cleanupError && cleanupError.code || 'SERVICE_FATAL_CLEANUP_FAILED'
      });
      return false;
    });
  }

  function jobForRef(record, jobRef) {
    if (!jobRef || typeof jobRef !== 'object') {
      throw new ServiceHostProtocolError('SERVICE_JOB_REF_INVALID', 'Resource control requires a complete jobRef');
    }
    const job = record.jobs.get(jobRef.jobId);
    if (!job || job.actionKey !== jobRef.actionKey || job.operationKey !== jobRef.operationKey) {
      throw new ServiceHostProtocolError(
        'SERVICE_JOB_REF_MISMATCH',
        'Resource control jobRef is not attached to this generation'
      );
    }
    return job;
  }

  function validateResourceRequest(record, message) {
    const job = jobForRef(record, message.jobRef);
    if (job.detaching) {
      throw new ServiceHostProtocolError(
        'SERVICE_JOB_DETACHING',
        `Job ${job.jobId} cannot start a resource request while detaching`
      );
    }
    const policy = job.policy;
    const payload = message.payload;
    const matrix = REQUEST_MATRIX[payload.requestKind];
    if (!matrix || !policy.service.resourceControl.allowedRequestKinds.includes(payload.requestKind)) {
      throw new ServiceHostProtocolError(
        'SERVICE_REQUEST_KIND_FORBIDDEN',
        `Request kind is not allowed: ${payload.requestKind}`
      );
    }
    if (matrix.ownerKind !== payload.owner.kind) {
      throw new ServiceHostProtocolError(
        'SERVICE_REQUEST_OWNER_KIND_INVALID',
        'requestKind and owner.kind do not match'
      );
    }
    if (record.usedRequestIds.has(payload.requestId)) {
      throw new ServiceHostProtocolError('SERVICE_REQUEST_ID_REUSED', `Duplicate requestId: ${payload.requestId}`);
    }
    if (record.pendingRequests.size >= policy.service.resourceControl.maxPendingRequests) {
      throw new ServiceHostProtocolError(
        'SERVICE_PENDING_REQUEST_LIMIT',
        'Service resource pending-request limit exceeded'
      );
    }
    const requested = expandDynamicResourceVector(payload.requested);
    const maximum = policy.resources[matrix.resourceKey];
    if (!maximum || !vectorWithin(payload.requested, maximum)) {
      throw new ServiceHostProtocolError(
        'SERVICE_RESOURCE_LIMIT_EXCEEDED',
        'Requested vector exceeds the action policy limit'
      );
    }
    const ownerKey = JSON.stringify([payload.owner.kind, payload.owner.ownerKeyHash]);
    const current = record.currentByOwner.get(ownerKey) || null;
    const replacementAllowed = REPLACEABLE_REQUEST_KINDS.includes(payload.requestKind);
    if (replacementAllowed) {
      if ((current && payload.replacesReservationId !== current.reservationId) ||
          (!current && payload.replacesReservationId !== null)) {
        throw new ServiceHostProtocolError(
          'SERVICE_REPLACEMENT_STALE',
          'Replaceable request must reference the current reservation'
        );
      }
    } else if (payload.replacesReservationId !== null) {
      throw new ServiceHostProtocolError(
        'SERVICE_REPLACEMENT_FORBIDDEN',
        'This resource kind may not replace a reservation'
      );
    }
    if (current && payload.owner.candidateRevision <= current.owner.candidateRevision) {
      throw new ServiceHostProtocolError(
        'SERVICE_OWNER_REVISION_STALE',
        'Candidate revision must advance the owner revision'
      );
    }
    if (current && !replacementAllowed) {
      throw new ServiceHostProtocolError(
        'SERVICE_OWNER_DUPLICATE',
        'Owner identity already has an adopted reservation'
      );
    }
    if (record.ownerClaims.has(ownerKey)) {
      throw new ServiceHostProtocolError(
        'SERVICE_OWNER_DUPLICATE',
        'Owner identity already has a pending or tentative request'
      );
    }
    record.usedRequestIds.add(payload.requestId);
    record.ownerClaims.set(ownerKey, payload.requestId);
    return { job, policy, payload, matrix, requested, ownerKey, current };
  }

  async function processResourceRequest(record, message) {
    let validated;
    try {
      validated = validateResourceRequest(record, message);
    } catch (error) {
      fatal(record, error);
      return;
    }
    const { job, policy, payload, matrix, requested, ownerKey, current } = validated;
    let resolveAdmission;
    const admissionSettled = new Promise((resolve) => { resolveAdmission = resolve; });
    const pending = {
      requestId: payload.requestId,
      jobId: job.jobId,
      requestKind: payload.requestKind,
      ownerKey,
      replacesReservationId: payload.replacesReservationId,
      abortController: new AbortController(),
      admissionSettled,
      resolveAdmission,
      admissionDone: false
    };
    record.pendingRequests.set(payload.requestId, pending);
    const onGenerationAbort = () => pending.abortController.abort();
    record.abortController.signal.addEventListener('abort', onGenerationAbort, { once: true });
    try {
      let lease;
      try {
        if (payload.requestKind === 'persistent-state-replace' && persistentStateAdoptionGate) {
          await persistentStateAdoptionGate(Object.freeze({
            actionKey: job.actionKey,
            operationKey: job.operationKey,
            jobId: job.jobId,
            unitId: message.jobRef.unitId,
            workerInstanceId: record.workerInstanceId,
            serviceGeneration: record.serviceGeneration,
            signal: pending.abortController.signal
          }));
        }
        const reservationIdentity = stableReservationIdentity(record, ownerKey);
        lease = await governor[matrix.leaseMethod]({
          ...reservationIdentity,
          resources: requested,
          priority: policy.resources.admissionPriority || 'normal',
          timeoutMs: policy.service.resourceControl.grantTimeoutMs,
          signal: pending.abortController.signal,
          lowMemoryBehavior: policy.resources.lowMemoryBehavior === 'reject' ? 'reject' : 'queue',
          ...(current ? { replacesReservationId: current.reservationId } : {})
        });
      } catch (error) {
        record.pendingRequests.delete(payload.requestId);
        releaseOwnerClaim(record, ownerKey, payload.requestId);
        if (record.closed || !record.jobs.has(job.jobId)) return;
        sendControl(record, 'resource:reject', message.controlId, message.jobRef, {
          requestId: payload.requestId,
          reasonCode: error && error.code || 'RESOURCE_REJECTED',
          retryable: error && ['ADMISSION_TIMEOUT', 'RESOURCE_BUDGET_UNAVAILABLE'].includes(error.code),
          safeSummary: 'Resource request was not admitted'
        });
        return;
      }
      let adoptionDeadlineAt;
      try {
        adoptionDeadlineAt = deadlineFromNow(
          policy.service.resourceControl.adoptionTimeoutMs,
          'SERVICE_ADOPTION_TIMEOUT_INVALID',
          'adoption'
        );
      } catch (error) {
        record.pendingRequests.delete(payload.requestId);
        releaseOwnerClaim(record, ownerKey, payload.requestId);
        lease.release('adoption-deadline-invalid');
        throw error;
      }
      if (record.closed || !record.jobs.has(job.jobId) || job.detaching) {
        record.pendingRequests.delete(payload.requestId);
        releaseOwnerClaim(record, ownerKey, payload.requestId);
        lease.release(record.closed ? 'service-crash' : 'job-failed');
        if (!record.closed && record.jobs.has(job.jobId)) {
          sendControl(record, 'resource:reject', message.controlId, message.jobRef, {
            requestId: payload.requestId,
            reasonCode: 'SERVICE_JOB_DETACHING',
            retryable: false,
            safeSummary: 'Resource request ended while its job was detaching'
          });
        }
        return;
      }
      let grantId;
      try {
        grantId = nextId('grant');
      } catch (error) {
        record.pendingRequests.delete(payload.requestId);
        releaseOwnerClaim(record, ownerKey, payload.requestId);
        lease.release('grant-identity-failed');
        throw error;
      }
      const tentative = {
        requestId: payload.requestId,
        grantId,
        reservationId: lease.leaseId,
        replacesReservationId: payload.replacesReservationId,
        ownerKey,
        owner: payload.owner,
        jobRef: message.jobRef,
        requestKind: payload.requestKind,
        lease,
        timer: null,
        deadlineAt: adoptionDeadlineAt,
        settled: false,
        adopting: false,
        revoking: false
      };
      record.tentativeGrants.set(grantId, tentative);
      if (!armTentativeDeadline(record, tentative)) {
        clearTentative(record, tentative, 'adoption-timeout');
        if (!record.closed && record.jobs.has(job.jobId)) {
          sendControl(record, 'resource:reject', message.controlId, message.jobRef, {
            requestId: payload.requestId,
            reasonCode: 'SERVICE_ADOPTION_TIMEOUT',
            retryable: true,
            safeSummary: 'Resource request could not establish an adoption window'
          });
        }
        return;
      }
      try {
        sendControl(record, 'resource:grant', message.controlId, message.jobRef, {
          requestId: payload.requestId,
          grantId,
          reservationId: lease.leaseId,
          replacesReservationId: payload.replacesReservationId,
          granted: payload.requested,
          adoptionDeadlineMs: policy.service.resourceControl.adoptionTimeoutMs
        });
      } catch (error) {
        clearTentative(record, tentative, 'grant-send-failed');
        throw error;
      }
    } finally {
      record.abortController.signal.removeEventListener('abort', onGenerationAbort);
      settlePendingAdmission(pending);
    }
  }

  function processAdopted(record, message) {
    return serializeResourceMutation(record, async () => {
      const payload = message.payload;
      const tentative = record.tentativeGrants.get(payload.grantId);
      if (tentative && tentative.revoking) {
        throw new ServiceHostProtocolError(
          'SERVICE_ADOPT_AFTER_REVOKE',
          'A reservation being revoked for service close cannot be adopted'
        );
      }
      if (tentative && !tentative.settled && now() >= tentative.deadlineAt) {
        clearTentative(record, tentative, 'adoption-timeout');
        if (!record.closed) {
          sendControl(record, 'resource:revoke', nextControlId(record), tentative.jobRef, {
            grantId: tentative.grantId,
            reservationId: tentative.reservationId,
            reasonCode: 'adoption-timeout'
          });
        }
        throw new ServiceHostProtocolError(
          'SERVICE_ADOPTION_TIMEOUT',
          'Adoption arrived after the tentative grant deadline'
        );
      }
      if (!tentative || tentative.settled || tentative.requestId !== payload.requestId ||
          tentative.reservationId !== payload.reservationId ||
          !jobRefMatches(tentative.jobRef, message.jobRef) ||
          !isDeepStrictEqual(tentative.owner, payload.owner) ||
          record.ownerClaims.get(tentative.ownerKey) !== tentative.requestId) {
        throw new ServiceHostProtocolError(
          'SERVICE_ADOPTION_IDENTITY_INVALID',
          'Adoption does not match a tentative grant'
        );
      }
      const current = tentative.replacesReservationId
        ? record.adoptedReservations.get(tentative.replacesReservationId)
        : null;
      if (tentative.replacesReservationId && (!current || record.currentByOwner.get(tentative.ownerKey) !== current)) {
        throw new ServiceHostProtocolError(
          'SERVICE_REPLACEMENT_STALE',
          'Adoption replacement is no longer current'
        );
      }
      if (current && current.requestKind === 'pending-interaction-create' &&
          current.tokenPublicationState !== 'published') {
        throw new ServiceHostProtocolError(
          'SERVICE_REPLACEMENT_STALE',
          'Pending-interaction replacement requires a published current token'
        );
      }
      tentative.adopting = true;
      let adoptedLease = tentative.lease;
      if (current) {
        adoptedLease = await governor.replaceReservationAtomically({
          oldReservationId: current.reservationId,
          nextRequest: { tentativeReservationId: tentative.reservationId }
        });
      }
      tentative.adopting = false;
      const stillCurrent = !record.closed && record.jobs.has(tentative.jobRef.jobId) &&
        record.tentativeGrants.get(tentative.grantId) === tentative && !tentative.settled &&
        record.ownerClaims.get(tentative.ownerKey) === tentative.requestId &&
        adoptedLease.state === 'granted';
      if (!stillCurrent) {
        if (adoptedLease.state === 'granted') adoptedLease.release('adoption-invalidated');
        tentative.settled = true;
        if (tentative.timer !== null) clearTimer(tentative.timer);
        tentative.timer = null;
        record.tentativeGrants.delete(tentative.grantId);
        record.pendingRequests.delete(tentative.requestId);
        releaseOwnerClaim(record, tentative.ownerKey, tentative.requestId);
        throw new ServiceHostProtocolError(
          'SERVICE_ADOPTION_INVALIDATED',
          'Generation or job ownership changed while adopting the reservation'
        );
      }
      tentative.settled = true;
      if (tentative.timer !== null) clearTimer(tentative.timer);
      tentative.timer = null;
      record.tentativeGrants.delete(tentative.grantId);
      record.pendingRequests.delete(tentative.requestId);
      releaseOwnerClaim(record, tentative.ownerKey, tentative.requestId);
      if (current) {
        current.released = true;
        record.adoptedReservations.delete(current.reservationId);
      }
      const adopted = {
        reservationId: tentative.reservationId,
        grantId: tentative.grantId,
        ownerKey: tentative.ownerKey,
        owner: tentative.owner,
        jobRef: tentative.jobRef,
        requestKind: tentative.requestKind,
        lease: adoptedLease,
        released: false,
        revoking: false,
        tokenPublicationState: tentative.requestKind === 'pending-interaction-create'
          ? 'unpublished'
          : 'not-applicable'
      };
      record.adoptedReservations.set(adopted.reservationId, adopted);
      record.currentByOwner.set(adopted.ownerKey, adopted);
      if (adopted.requestKind === 'pending-interaction-create') {
        adopted.tokenPublicationState = 'adopt-ack-dispatching';
      }
      try {
        sendControl(record, 'resource:adopt-ack', message.controlId, message.jobRef, {
          requestId: tentative.requestId,
          grantId: tentative.grantId,
          reservationId: tentative.reservationId
        });
      } catch (error) {
        if (adopted.tokenPublicationState === 'adopt-ack-dispatching') {
          adopted.tokenPublicationState = 'unpublished';
        }
        throw error;
      }
      if (adopted.tokenPublicationState === 'adopt-ack-dispatching') {
        adopted.tokenPublicationState = 'adopt-acked';
      }
    });
  }

  function processRelease(record, message, controlExchange) {
    return serializeResourceMutation(record, () => {
      const reservationId = message.payload.reservationId;
      const adopted = record.adoptedReservations.get(reservationId);
      const tentative = tentativeByReservation(record, reservationId);
      const revokeWaiter = record.resourceRevokeWaiters.get(reservationId) || null;
      const revokedByMain = controlExchange && controlExchange.initiator === 'main' &&
        controlExchange.operation === 'resource:revoke';
      if (record.state === 'draining' && record.closeDeadlineAt !== null &&
          now() >= record.closeDeadlineAt) {
        throw gracefulCloseTimeout(record, record.closeTimeoutMs, 'resource release handshake');
      }
      if (revokeWaiter && now() >= revokeWaiter.deadlineAt) {
        throw resourceDrainTimeout(
          record,
          revokeWaiter.timeoutMs,
          'resource release handshake',
          { job: revokeWaiter.job }
        );
      }
      if (revokeWaiter &&
          ((revokeWaiter.resourceKind === 'tentative' && !tentative) ||
           (revokeWaiter.resourceKind === 'adopted' && (!adopted || adopted.released)))) {
        throw new ServiceHostError(
          'SERVICE_GRACEFUL_REVOKE_TARGET_LOST',
          `Graceful revoke target disappeared before release: ${reservationId}`
        );
      }
      if ((!adopted || adopted.released) && !tentative && !revokedByMain) {
        throw new ServiceHostProtocolError(
          'SERVICE_RELEASE_UNKNOWN',
          'Release must reference an adopted active reservation'
        );
      }
      if (adopted && message.jobRef !== null && !jobRefMatches(message.jobRef, adopted.jobRef)) {
        throw new ServiceHostProtocolError(
          'SERVICE_RELEASE_JOB_REF_MISMATCH',
          'Release jobRef does not match reservation ownership'
        );
      }
      if (adopted) {
        const livePendingReplacement = [...record.pendingRequests.values()].some((pending) =>
          pending.ownerKey === adopted.ownerKey &&
          pending.replacesReservationId === adopted.reservationId);
        const liveTentativeReplacement = [...record.tentativeGrants.values()].some((tentative) =>
          !tentative.settled && tentative.ownerKey === adopted.ownerKey &&
          tentative.replacesReservationId === adopted.reservationId);
        const liveReplacement = livePendingReplacement || liveTentativeReplacement;
        if (liveReplacement) {
          throw new ServiceHostProtocolError(
            'SERVICE_RELEASE_DURING_TENTATIVE_REPLACEMENT',
            'Release cannot target a reservation with a live tentative replacement'
          );
        }
        releaseAdopted(record, adopted, message.payload.reason);
      } else if (tentative) {
        if (!revokedByMain || !tentative.revoking) {
          throw new ServiceHostProtocolError(
            'SERVICE_RELEASE_UNKNOWN',
            'A tentative reservation may only release an exact Main revoke'
          );
        }
        clearTentative(record, tentative, message.payload.reason);
      }
      sendControl(record, 'resource:release-ack', message.controlId, message.jobRef, {
        reservationId
      });
      if (revokeWaiter) settleResourceRevoke(record, reservationId);
    });
  }

  function routeJobMessage(record, rawMessage) {
    const jobId = rawMessage && rawMessage.jobId;
    const job = record.jobs.get(jobId);
    if (!job) {
      throw new ServiceHostProtocolError('SERVICE_JOB_ROUTE_STALE', `No attached job route for ${String(jobId)}`);
    }
    const message = validateJobEnvelope(rawMessage, {
      actionKey: job.actionKey,
      operationKey: job.operationKey,
      jobId: job.jobId,
      workerInstanceId: record.workerInstanceId,
      serviceGeneration: record.serviceGeneration,
      direction: 'event'
    }, { policyRegistry });
    record.jobSequences.observe(message);
    if (!job.detaching && job.terminalOperation === null &&
        message.operation === 'job:error' && !job.cancellationTerminalForwarded &&
        (job.cancelCommandState === 'dispatching' || job.cancelCommandState === 'sent') &&
        record.profile.cancellationTerminalErrorCodes.includes(
          message.payload && message.payload.error && message.payload.error.code
        )) {
      job.cancellationTerminalForwarded = true;
      if (typeof job.onCancellationTerminal === 'function') job.onCancellationTerminal();
    }
    if (!job.detaching && job.terminalOperation === null &&
        (message.operation === 'job:done' || message.operation === 'job:error')) {
      job.terminalOperation = message.operation;
      if (message.operation === 'job:done') {
        for (const adopted of record.adoptedReservations.values()) {
          if (adopted.requestKind !== 'pending-interaction-create' ||
              !jobRefBelongsTo(adopted.jobRef, job) ||
              !['adopt-ack-dispatching', 'adopt-acked'].includes(adopted.tokenPublicationState)) {
            continue;
          }
          adopted.tokenPublicationState = 'published';
          job.publishedInteractionReservationIds.add(adopted.reservationId);
        }
        job.tokenPublicationState = job.publishedInteractionReservationIds.size > 0
          ? 'published'
          : 'none';
      } else {
        job.tokenPublicationState = 'not-published';
      }
    }
    job.onMessage(message);
  }

  function routeCancellationTerminal(record) {
    // WorkerThreadAdapter 已按 entry 白名单确认 cancellation terminal code；
    // ServiceHost 只把这份现有私有因果证据转交给当前唯一 job。
    const job = record.jobs.values().next().value;
    if (job && typeof job.onCancellationTerminal === 'function') {
      job.onCancellationTerminal();
    }
  }

  function handleMessage(record, rawMessage) {
    if (record.closed) return;
    try {
      if (rawMessage && rawMessage.channel === 'job') {
        routeJobMessage(record, rawMessage);
        return;
      }
      const message = validateServiceControlEnvelope(rawMessage, {
        serviceKey: record.serviceKey,
        workerInstanceId: record.workerInstanceId,
        serviceGeneration: record.serviceGeneration,
        direction: 'event'
      }, { policyRegistry });
      record.controlSequences.observe(message);
      const controlExchange = observeIncomingControl(record, message);
      if (message.operation === 'executor:ready') {
        if (record.readyDeadlineAt !== null && now() >= record.readyDeadlineAt) {
          const error = startupTimeoutError(record.readyTimeoutMs);
          rejectStartup(record, error);
          void fatal(record, error);
          return;
        }
        if (record.state !== 'initializing' || !message.payload.capabilities.includes('resource-control-v1')) {
          throw new ServiceHostProtocolError(
            'SERVICE_READY_INVALID',
            'executor:ready is duplicate or lacks resource-control-v1'
          );
        }
        record.state = 'ready';
        if (record.readyTimer !== null) clearTimer(record.readyTimer);
        record.readyTimer = null;
        if (!record.readySettled) {
          record.readySettled = true;
          record.resolveReady();
        }
      } else if (message.operation === 'executor:error') {
        throw new ServiceHostError('SERVICE_EXECUTOR_ERROR', 'Service reported executor:error');
      } else if (message.operation === 'executor:close-ack') {
        if (record.state !== 'closing' || message.controlId !== record.closeControlId) {
          throw new ServiceHostProtocolError(
            'SERVICE_CLOSE_ACK_INVALID',
            'executor:close-ack does not match active close'
          );
        }
        if (record.closeDeadlineAt !== null && now() >= record.closeDeadlineAt) {
          throw gracefulCloseTimeout(
            record,
            record.closeTimeoutMs,
            'executor close acknowledgement'
          );
        }
        settleCloseWaiter(record, 'ack');
      } else if (message.operation === 'resource:request') {
        if (record.state !== 'ready') {
          throw new ServiceHostProtocolError('SERVICE_NOT_READY', 'Resource request requires a ready service');
        }
        void processResourceRequest(record, message).catch((error) => fatal(record, error));
      } else if (message.operation === 'resource:adopted') {
        void processAdopted(record, message).catch((error) => fatal(record, error));
      } else if (message.operation === 'resource:release') {
        void processRelease(record, message, controlExchange).catch((error) => fatal(record, error));
      } else {
        throw new ServiceHostProtocolError(
          'SERVICE_OPERATION_UNEXPECTED',
          `Unexpected service event: ${message.operation}`
        );
      }
    } catch (error) {
      fatal(record, error);
    }
  }

  async function startService(policy, request) {
    const serviceKey = policy.service.serviceKey;
    if (!acceptingNewServices) {
      throw new ServiceHostError('SERVICE_HOST_NOT_ACCEPTING', 'ServiceHost is not accepting new services');
    }
    const profile = servicePolicies(serviceKey);
    const generation = (lastGeneration.get(serviceKey) || 0) + 1;
    lastGeneration.set(serviceKey, generation);
    const workerInstanceId = nextId('service-worker');
    const abortController = new AbortController();
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const record = {
      serviceKey,
      profile,
      serviceGeneration: generation,
      workerInstanceId,
      baseLease: null,
      rawTransport: null,
      state: 'admitting',
      closed: false,
      abortController,
      jobs: new Map(),
      pendingRequests: new Map(),
      tentativeGrants: new Map(),
      adoptedReservations: new Map(),
      currentByOwner: new Map(),
      ownerClaims: new Map(),
      usedRequestIds: new Set(),
      controlExchanges: new Map(),
      controlSequences: createDirectionSequenceTracker(),
      jobSequences: createDirectionSequenceTracker(),
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      readyTimer: null,
      readyTimeoutMs: null,
      readyDeadlineAt: null,
      closeTimer: null,
      closeControlId: null,
      closeDeadlineAt: null,
      closeTimeoutMs: null,
      closePromise: null,
      resolveCloseAck: null,
      closeError: null,
      generationClosePromise: null,
      resourceRevokeWaiters: new Map(),
      resourceMutation: Promise.resolve(),
      rawCleanupPromise: null,
      rawCloseCalled: false,
      rawTerminateCalled: false
    };
    services.set(serviceKey, record);
    try {
      const baseLease = await governor.acquireBaseLease({
        ownerKey: `service:${serviceKey}`,
        actionKey: policy.actionKey,
        operationKey: null,
        resources: profile.base,
        priority: policy.resources.admissionPriority || 'normal',
        timeoutMs: request.initTimeoutMs,
        signal: abortController.signal,
        lowMemoryBehavior: policy.resources.lowMemoryBehavior === 'reject' ? 'reject' : 'queue'
      });
      if (record.closed || !acceptingNewServices) {
        baseLease.release('service-close');
        throw new ServiceHostError('SERVICE_START_ABORTED', 'Service closed during admission');
      }
      record.baseLease = baseLease;
      record.state = 'starting';
      const timeoutMs = request.initTimeoutMs === undefined ? 30000 : request.initTimeoutMs;
      record.readyTimeoutMs = timeoutMs;
      record.readyDeadlineAt = deadlineFromNow(timeoutMs, 'SERVICE_INIT_TIMEOUT_INVALID', 'init');
      armReadyDeadline(record, timeoutMs);
      if (record.closed) throw startupTimeoutError(timeoutMs);
      const adapter = adapters[profile.carrier];
      record.rawTransport = adapter.start({
        entry: profile.entry,
        policy,
        onMessage: (message) => handleMessage(record, message),
        onCancellationTerminal: () => routeCancellationTerminal(record),
        onError: (error) => { void fatal(record, error); },
        onExit: (code, signal) => { void fatalExit(record, code, signal); }
      });
      if (!record.rawTransport || typeof record.rawTransport !== 'object' ||
          !record.rawTransport.ready || typeof record.rawTransport.ready.then !== 'function' ||
          typeof record.rawTransport.send !== 'function' ||
          typeof record.rawTransport.close !== 'function' ||
          typeof record.rawTransport.terminate !== 'function') {
        throw new ServiceHostError(
          'SERVICE_ADAPTER_HANDLE_INVALID',
          'Service adapter must return ready/send/close/terminate APIs'
        );
      }
      const rawReady = Promise.resolve(record.rawTransport.ready);
      rawReady.catch(() => {});
      if (record.closed) {
        await cleanupRawTransport(record);
        throw new ServiceHostError('SERVICE_START_ABORTED', 'Service closed during adapter start');
      }
      await Promise.race([rawReady, ready]);
      if (record.closed) throw new ServiceHostError('SERVICE_START_ABORTED', 'Service closed during startup');
      if (now() >= record.readyDeadlineAt) throw startupTimeoutError(timeoutMs);
      record.state = 'initializing';
      sendControl(record, 'executor:init', nextControlId(record), null, {
        contractVersion: 1,
        policyDigest: profile.policyDigest,
        baseLeaseId: record.baseLease.leaseId
      });
      await ready;
      report('service-ready', { serviceKey, generation, workerInstanceId });
      return record;
    } catch (error) {
      if (!record.closed) await closeGeneration(record, 'service-crash', error);
      else if (record.generationClosePromise) await record.generationClosePromise;
      throw error;
    }
  }

  async function getService(policy, request) {
    const serviceKey = policy.service.serviceKey;
    const existing = services.get(serviceKey);
    if (existing && existing.state === 'ready' && !existing.closed) {
      return Object.freeze({ record: existing, createdGeneration: false });
    }
    if (starting.has(serviceKey)) {
      return Object.freeze({ record: await starting.get(serviceKey), createdGeneration: false });
    }
    const promise = startService(policy, request);
    starting.set(serviceKey, promise);
    try {
      return Object.freeze({ record: await promise, createdGeneration: true });
    } finally {
      starting.delete(serviceKey);
    }
  }

  async function openJob(request = {}) {
    if (shutdownStarted) {
      throw new ServiceHostError('SERVICE_HOST_SHUTDOWN', 'ServiceHost shutdown has started');
    }
    const policy = policyRegistry.assertRunnable(request.actionKey, { production: request.production === true });
    if (policy.lifetime !== 'service' || !policy.service) {
      throw new ServiceHostError('SERVICE_POLICY_REQUIRED', `Action is not service-lifetime: ${request.actionKey}`);
    }
    for (const name of ['operationKey', 'jobId']) {
      if (typeof request[name] !== 'string' || request[name].length === 0) {
        throw new ServiceHostError('SERVICE_JOB_REQUEST_INVALID', `${name} must be a non-empty string`);
      }
    }
    if (typeof request.onMessage !== 'function') {
      throw new ServiceHostError('SERVICE_JOB_REQUEST_INVALID', 'onMessage must be a function');
    }
    if (request.initTimeoutMs !== undefined) {
      validateTimerDuration(request.initTimeoutMs, 'SERVICE_JOB_REQUEST_INVALID', 'initTimeoutMs');
    }
    if (request.production !== undefined && typeof request.production !== 'boolean') {
      throw new ServiceHostError('SERVICE_JOB_REQUEST_INVALID', 'production must be boolean');
    }
    const service = await getService(policy, request);
    const { record, createdGeneration } = service;
    if (record.closed || record.state !== 'ready') {
      throw new ServiceHostError('SERVICE_NOT_READY', `Service is not ready: ${record.serviceKey}`);
    }
    if (record.jobs.size > 0) {
      throw new ServiceHostError('SERVICE_BUSY', `Service already has an active job: ${record.serviceKey}`);
    }
    if (record.jobs.has(request.jobId)) {
      throw new ServiceHostError('SERVICE_JOB_ID_REUSED', `Service jobId is already attached: ${request.jobId}`);
    }
    const job = {
      actionKey: request.actionKey,
      operationKey: request.operationKey,
      jobId: request.jobId,
      policy,
      onMessage: request.onMessage,
      onCancellationTerminal: request.onCancellationTerminal,
      onError: request.onError,
      onExit: request.onExit,
      cancelCommandState: 'not-dispatched',
      cancellationTerminalForwarded: false,
      detaching: false,
      detached: false,
      detachPromise: null,
      terminalOperation: null,
      tokenPublicationState: 'pending',
      publishedInteractionReservationIds: new Set()
    };
    record.jobs.set(job.jobId, job);

    function detach(reason = 'job-terminal') {
      if (job.detachPromise) return job.detachPromise;
      if (job.detached || !record.jobs.has(job.jobId)) return Promise.resolve(false);
      job.detaching = true;
      const timeoutMs = job.policy.cancellation.terminateTimeoutMs;
      job.detachPromise = (async () => {
        try {
          const removeJobRoute = () => serializeResourceMutation(record, () => {
            if (record.closed) throw jobDetachInterrupted(record, job);
            if (jobHasDrainObligations(record, job)) {
              if (timeoutMs === 0) {
                throw jobDetachTimeout(record, job, timeoutMs, 'resource drain');
              }
              throw new ServiceHostError(
                'SERVICE_JOB_DRAIN_INCOMPLETE',
                `Job ${job.jobId} resource maps were not empty before route deletion`
              );
            }
            if (!record.jobs.delete(job.jobId)) return false;
            job.detached = true;
            report('service-job-detach-complete', {
              serviceKey: record.serviceKey,
              generation: record.serviceGeneration,
              jobId: job.jobId,
              reason,
              graceful: true
            });
            return true;
          });
          if (timeoutMs === 0) return await removeJobRoute();
          const deadlineAt = deadlineFromNow(
            timeoutMs,
            'SERVICE_JOB_DETACH_TIMEOUT_INVALID',
            'job detach'
          );
          await waitForAbsoluteDeadline(
            drainJobResources(record, job, deadlineAt, timeoutMs),
            deadlineAt,
            () => jobDetachTimeout(record, job, timeoutMs, 'resource drain')
          );
          return await removeJobRoute();
        } catch (error) {
          report('service-job-detach-error', {
            serviceKey: record.serviceKey,
            generation: record.serviceGeneration,
            jobId: job.jobId,
            code: error && error.code || 'SERVICE_JOB_DETACH_FAILED',
            reason,
            graceful: false
          });
          await closeGeneration(record, 'service-crash', error, { graceful: false });
          throw error;
        }
      })();
      job.detachPromise.catch(() => {});
      return job.detachPromise;
    }

    const transport = {
      serviceKey: record.serviceKey,
      workerInstanceId: record.workerInstanceId,
      serviceGeneration: record.serviceGeneration,
      baseLeaseId: record.baseLease.leaseId,
      baseResources: record.baseLease.resources,
      ready: Promise.resolve(),
      send(message, transferList) {
        const owned = validateJobEnvelope(message, {
          actionKey: job.actionKey,
          operationKey: job.operationKey,
          jobId: job.jobId,
          workerInstanceId: record.workerInstanceId,
          serviceGeneration: record.serviceGeneration,
          direction: 'command'
        }, { policyRegistry });
        record.jobSequences.observe(owned);
        const dispatchingCancel = owned.operation === 'job:cancel';
        if (dispatchingCancel) job.cancelCommandState = 'dispatching';
        try {
          record.rawTransport.send(owned, transferList);
        } catch (error) {
          if (dispatchingCancel) job.cancelCommandState = 'not-dispatched';
          throw error;
        }
        if (dispatchingCancel) job.cancelCommandState = 'sent';
      },
      close() {
        return detach('job-terminal');
      },
      async terminate() {
        job.detaching = true;
        report('service-job-force-close', {
          serviceKey: record.serviceKey,
          generation: record.serviceGeneration,
          jobId: job.jobId,
          graceful: false
        });
        return await closeGeneration(record, 'service-crash', null, { graceful: false });
      },
      worker: record.rawTransport.worker,
      child: record.rawTransport.child
    };
    const frozenTransport = Object.freeze(transport);
    serviceTransportOwnership.set(frozenTransport, createdGeneration);
    return frozenTransport;
  }

  async function closeService(serviceKey, options = {}) {
    if (typeof serviceKey !== 'string' || serviceKey.length === 0) {
      throw new ServiceHostError('SERVICE_KEY_INVALID', 'serviceKey must be a non-empty string');
    }
    if (options.timeoutMs !== undefined) {
      validateTimerDuration(options.timeoutMs, 'SERVICE_CLOSE_TIMEOUT_INVALID', 'timeoutMs');
    }
    const record = services.get(serviceKey);
    if (!record) return false;
    if (record.closed) return false;
    if (record.closePromise) return record.closePromise;
    if (record.jobs.size > 0 && options.force !== true) {
      throw new ServiceHostError('SERVICE_BUSY', `Cannot close service with an active job: ${serviceKey}`);
    }
    record.closePromise = (async () => {
      if (options.force === true || record.state !== 'ready' || !record.rawTransport) {
        return closeGeneration(record, 'service-close', null, { graceful: false });
      }
      const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
      const deadlineAt = deadlineFromNow(
        timeoutMs,
        'SERVICE_CLOSE_TIMEOUT_INVALID',
        'graceful close'
      );
      record.closeDeadlineAt = deadlineAt;
      record.closeTimeoutMs = timeoutMs;
      record.state = 'draining';
      try {
        await drainServiceResources(record, deadlineAt, timeoutMs);
        if (record.closed) throw gracefulCloseInterrupted(record);
        if (now() >= deadlineAt) throw gracefulCloseTimeout(record, timeoutMs, 'resource drain');
        record.state = 'closing';
        const controlId = nextControlId(record);
        record.closeControlId = controlId;
        const closeAck = new Promise((resolve) => { record.resolveCloseAck = resolve; });
        sendControl(record, 'executor:close', controlId, null, {});
        const outcome = await waitForAbsoluteDeadline(
          closeAck,
          deadlineAt,
          () => gracefulCloseTimeout(record, timeoutMs, 'executor close acknowledgement')
        );
        if (outcome !== 'ack' || record.closed) throw gracefulCloseInterrupted(record);
        report('service-graceful-close-complete', {
          serviceKey: record.serviceKey,
          generation: record.serviceGeneration
        });
        return await closeGeneration(record, 'service-close', null, { graceful: true });
      } catch (error) {
        if (error && error.code === 'SERVICE_GRACEFUL_CLOSE_TIMEOUT') {
          report('service-close-timeout', {
            serviceKey: record.serviceKey,
            generation: record.serviceGeneration,
            timeoutMs,
            graceful: false
          });
        }
        report('service-close-error', {
          serviceKey: record.serviceKey,
          generation: record.serviceGeneration,
          code: error && error.code || 'SERVICE_CLOSE_FAILED',
          graceful: false
        });
        await closeGeneration(record, 'service-close', error, { graceful: false });
        throw error;
      }
    })();
    return record.closePromise;
  }

  function stopAcceptingNewServices() {
    if (!acceptingNewServices) return false;
    acceptingNewServices = false;
    return true;
  }

  async function shutdown(options = {}) {
    if (options.timeoutMs !== undefined) {
      validateTimerDuration(options.timeoutMs, 'SERVICE_SHUTDOWN_TIMEOUT_INVALID', 'timeoutMs');
    }
    shutdownStarted = true;
    stopAcceptingNewServices();
    const startPromises = [...starting.values()];
    const closePromises = [...services.keys()].map((serviceKey) =>
      closeService(serviceKey, { force: options.force === true, timeoutMs: options.timeoutMs }));
    const closeSettlements = Promise.allSettled(closePromises);
    const settlements = Promise.allSettled([...closePromises, ...startPromises]);
    const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    let timer = null;
    const bounded = new Promise((resolve) => {
      timer = setTimer(() => resolve(null), timeoutMs);
    });
    const results = await Promise.race([settlements, bounded]);
    if (timer !== null) clearTimer(timer);
    if (results !== null) return Object.freeze(await closeSettlements);
    const error = new ServiceHostError(
      'SERVICE_SHUTDOWN_TIMEOUT',
      `ServiceHost shutdown timed out after ${timeoutMs}ms`
    );
    report('service-shutdown-timeout', {
      timeoutMs,
      remainingServices: services.size,
      remainingStarts: starting.size
    });
    return Object.freeze([{ status: 'rejected', reason: error }]);
  }

  function snapshot() {
    return Object.freeze({
      acceptingNewServices,
      services: Object.freeze([...services.values()].map((record) => Object.freeze({
        serviceKey: record.serviceKey,
        workerInstanceId: record.workerInstanceId,
        serviceGeneration: record.serviceGeneration,
        state: record.state,
        baseLeaseId: record.baseLease ? record.baseLease.leaseId : null,
        activeJobIds: Object.freeze([...record.jobs.keys()]),
        pendingRequestCount: record.pendingRequests.size,
        ownerClaimCount: record.ownerClaims.size,
        tentativeGrantCount: record.tentativeGrants.size,
        adoptedReservationCount: record.adoptedReservations.size
      })))
    });
  }

  return Object.freeze({
    openJob,
    closeService,
    stopAcceptingNewServices,
    shutdown,
    snapshot
  });
}

module.exports = {
  ServiceHostProtocolError,
  createServiceHost,
  serviceTransportCreatedGeneration
};
