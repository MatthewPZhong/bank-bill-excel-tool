'use strict';

const PRIORITIES = Object.freeze(['maintenance', 'normal', 'interactive', 'recovery']);
const DEFER_ADMISSION = Symbol('defer-admission');
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class AdmissionQueueError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AdmissionQueueError';
    this.code = code;
    this.details = details;
  }
}

function validateDuration(value, name, { allowInfinity = false } = {}) {
  if (allowInfinity && value === Infinity) return value;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new AdmissionQueueError(
      'ADMISSION_DURATION_INVALID',
      `${name} must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`
    );
  }
  return value;
}

function createAdmissionQueue(options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const agingMs = validateDuration(options.agingMs === undefined ? 30000 : options.agingMs, 'agingMs');
  const entries = new Map();
  let insertionSequence = 0;
  let accepting = true;
  let drainCallback = null;
  let agingTimer = null;
  let draining = false;
  let closeReason = null;

  function priorityIndex(priority) {
    const index = PRIORITIES.indexOf(priority);
    if (index < 0) {
      throw new AdmissionQueueError('ADMISSION_PRIORITY_INVALID', `Unsupported admission priority: ${priority}`);
    }
    return index;
  }

  function effectivePriority(entry, timestamp) {
    if (agingMs === 0) return PRIORITIES.length - 1;
    const promotions = Math.floor(Math.max(0, timestamp - entry.enqueuedAt) / agingMs);
    return Math.min(PRIORITIES.length - 1, entry.basePriority + promotions);
  }

  function selectHead() {
    const timestamp = now();
    let selected = null;
    for (const entry of entries.values()) {
      if (entry.state !== 'queued') continue;
      if (!selected) {
        selected = entry;
        continue;
      }
      const candidatePriority = effectivePriority(entry, timestamp);
      const selectedPriority = effectivePriority(selected, timestamp);
      if (candidatePriority > selectedPriority ||
          (candidatePriority === selectedPriority && entry.sequence < selected.sequence)) {
        selected = entry;
      }
    }
    return selected;
  }

  function detach(entry) {
    entries.delete(entry.requestId);
    if (entry.timeoutTimer !== null) clearTimer(entry.timeoutTimer);
    entry.timeoutTimer = null;
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener('abort', entry.abortListener);
    entry.abortListener = null;
  }

  function settle(entry, method, value) {
    if (!entry || entry.state === 'settled' || entry.state === 'committed') return false;
    entry.state = method === 'resolve' ? 'committed' : 'settled';
    detach(entry);
    if (entry.onSettled) {
      try { entry.onSettled(method === 'resolve' ? 'resolved' : 'rejected', value); } catch (_error) {}
    }
    entry[method](value);
    if (method === 'resolve') entry.state = 'settled';
    scheduleAging();
    return true;
  }

  function cancelledError(entry, code, message) {
    return new AdmissionQueueError(code, message, Object.freeze({ requestId: entry.requestId }));
  }

  function cancel(requestId, reason = 'Admission request cancelled') {
    const entry = entries.get(requestId);
    if (!entry || entry.state !== 'queued') return false;
    const cancelled = settle(entry, 'reject', cancelledError(entry, 'ADMISSION_CANCELLED', reason));
    if (cancelled) queueMicrotask(runDrain);
    return cancelled;
  }

  function scheduleAging() {
    if (agingTimer !== null) clearTimer(agingTimer);
    agingTimer = null;
    if (!accepting || entries.size === 0 || agingMs === 0) return;
    const timestamp = now();
    let nextAt = Infinity;
    for (const entry of entries.values()) {
      if (entry.state !== 'queued') continue;
      const elapsed = Math.max(0, timestamp - entry.enqueuedAt);
      const promotions = Math.floor(elapsed / agingMs);
      if (entry.basePriority + promotions >= PRIORITIES.length - 1) continue;
      nextAt = Math.min(nextAt, entry.enqueuedAt + ((promotions + 1) * agingMs));
    }
    if (nextAt !== Infinity) {
      agingTimer = setTimer(() => {
        agingTimer = null;
        runDrain();
        scheduleAging();
      }, Math.max(0, nextAt - timestamp));
    }
  }

  function expireDueEntries(timestamp) {
    for (const entry of [...entries.values()]) {
      if (entry.state !== 'queued' || entry.deadlineAt === Infinity || timestamp < entry.deadlineAt) continue;
      settle(entry, 'reject', cancelledError(
        entry,
        'ADMISSION_TIMEOUT',
        `Admission request timed out after ${entry.timeoutMs}ms`
      ));
    }
  }

  function runDrain() {
    if (draining) return;
    expireDueEntries(now());
    if (typeof drainCallback !== 'function') return;
    draining = true;
    try {
      while (entries.size > 0) {
        expireDueEntries(now());
        const entry = selectHead();
        if (!entry) break;
        if (entry.deadlineAt !== Infinity && now() >= entry.deadlineAt) continue;
        entry.state = 'executing';
        let result;
        try {
          result = drainCallback(entry.payload, Object.freeze({
            requestId: entry.requestId,
            priority: PRIORITIES[effectivePriority(entry, now())],
            enqueuedAt: entry.enqueuedAt
          }));
        } catch (error) {
          settle(entry, 'reject', error);
          continue;
        }
        if (result === DEFER_ADMISSION) {
          entry.state = 'queued';
          if (!accepting) {
            settle(entry, 'reject', cancelledError(
              entry,
              'ADMISSION_QUEUE_CLOSED',
              closeReason || 'Admission queue closed'
            ));
            continue;
          }
          if (entry.signal && entry.signal.aborted) {
            settle(entry, 'reject', cancelledError(entry, 'ADMISSION_CANCELLED', 'Admission request aborted'));
            continue;
          }
          if (entry.deadlineAt !== Infinity && now() >= entry.deadlineAt) {
            settle(entry, 'reject', cancelledError(
              entry,
              'ADMISSION_TIMEOUT',
              `Admission request timed out after ${entry.timeoutMs}ms`
            ));
            continue;
          }
          break;
        }
        settle(entry, 'resolve', result);
      }
    } finally {
      draining = false;
      scheduleAging();
    }
  }

  function enqueue(request) {
    if (!accepting) {
      return Promise.reject(new AdmissionQueueError('ADMISSION_QUEUE_CLOSED', 'Admission queue is closed'));
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return Promise.reject(new AdmissionQueueError('ADMISSION_REQUEST_INVALID', 'Admission request must be an object'));
    }
    const requestId = request.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0 || entries.has(requestId)) {
      return Promise.reject(new AdmissionQueueError('ADMISSION_REQUEST_ID_INVALID', 'Admission requestId must be unique'));
    }
    let basePriority;
    let timeoutMs;
    try {
      basePriority = priorityIndex(request.priority || 'normal');
      timeoutMs = validateDuration(request.timeoutMs === undefined ? Infinity : request.timeoutMs, 'timeoutMs', {
        allowInfinity: true
      });
    } catch (error) {
      return Promise.reject(error);
    }
    if (request.signal !== undefined &&
        (!request.signal || typeof request.signal.addEventListener !== 'function' ||
          typeof request.signal.removeEventListener !== 'function')) {
      return Promise.reject(new AdmissionQueueError('ADMISSION_SIGNAL_INVALID', 'signal must be an AbortSignal'));
    }
    if (request.signal && request.signal.aborted) {
      return Promise.reject(new AdmissionQueueError('ADMISSION_CANCELLED', 'Admission request was already cancelled'));
    }
    const enqueuedAt = now();
    let deadlineAt = Infinity;
    if (timeoutMs !== Infinity) {
      deadlineAt = enqueuedAt + timeoutMs;
      if (!Number.isSafeInteger(deadlineAt)) {
        return Promise.reject(new AdmissionQueueError(
          'ADMISSION_DURATION_INVALID',
          'timeout deadline exceeds the safe integer range'
        ));
      }
    }
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = {
      requestId,
      payload: request.payload,
      basePriority,
      enqueuedAt,
      timeoutMs,
      deadlineAt,
      sequence: ++insertionSequence,
      signal: request.signal || null,
      abortListener: null,
      timeoutTimer: null,
      state: 'queued',
      onSettled: typeof request.onSettled === 'function' ? request.onSettled : null,
      resolve,
      reject
    };
    entries.set(requestId, entry);
    if (entry.signal) {
      entry.abortListener = () => cancel(requestId, 'Admission request aborted');
      entry.signal.addEventListener('abort', entry.abortListener, { once: true });
    }
    if (timeoutMs !== Infinity) {
      entry.timeoutTimer = setTimer(() => {
        queueMicrotask(runDrain);
      }, timeoutMs);
    }
    scheduleAging();
    queueMicrotask(runDrain);
    return promise;
  }

  function drain(callback) {
    if (callback !== undefined) {
      if (typeof callback !== 'function') throw new TypeError('AdmissionQueue drain callback must be a function');
      drainCallback = callback;
    }
    runDrain();
  }

  function close(reason = 'Admission queue closed') {
    if (!accepting) return false;
    accepting = false;
    closeReason = reason;
    if (agingTimer !== null) clearTimer(agingTimer);
    agingTimer = null;
    for (const entry of [...entries.values()]) {
      if (entry.state !== 'queued') continue;
      settle(entry, 'reject', cancelledError(entry, 'ADMISSION_QUEUE_CLOSED', reason));
    }
    return true;
  }

  function snapshot() {
    const timestamp = now();
    return Object.freeze({
      accepting,
      size: entries.size,
      entries: Object.freeze([...entries.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => Object.freeze({
          requestId: entry.requestId,
          priority: PRIORITIES[entry.basePriority],
          effectivePriority: PRIORITIES[effectivePriority(entry, timestamp)],
          enqueuedAt: entry.enqueuedAt,
          deadlineAt: entry.deadlineAt
        })))
    });
  }

  return Object.freeze({ cancel, close, drain, enqueue, snapshot });
}

module.exports = {
  AdmissionQueueError,
  DEFER_ADMISSION,
  MAX_TIMER_DELAY_MS,
  PRIORITIES,
  createAdmissionQueue
};
