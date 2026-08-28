'use strict';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

// E07-C coordinator-only lifecycle seam. The runtime facade stays unchanged;
// exact runtime object identity owns only its paired Parser finalizers.
const finalizersByRuntime = new WeakMap();

function runtimeState(runtime) {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function')) {
    throw new TypeError('Duplicate paired Parser shutdown runtime非法');
  }
  let state = finalizersByRuntime.get(runtime);
  if (!state) {
    state = { records: new Set() };
    finalizersByRuntime.set(runtime, state);
  }
  return state;
}

function shutdownError(code, message) {
  return Object.freeze({
    code,
    message,
    stage: 'shutdown',
    detailLines: Object.freeze([])
  });
}

function observeBarrier(promise, record, phase) {
  return Promise.resolve(promise).then(() => {
    record[`${phase}Settled`] = true;
    record[`${phase}SettledAt`] = Date.now();
    return Object.freeze({ status: 'fulfilled' });
  }, (error) => {
    record[`${phase}Settled`] = true;
    record[`${phase}SettledAt`] = Date.now();
    return Object.freeze({ status: 'rejected', error });
  });
}

function releaseRecord(runtime, state, record) {
  state.records.delete(record);
  if (state.records.size === 0) finalizersByRuntime.delete(runtime);
}

function observeFinalizationAttempt(runtime, state, record, promise) {
  record.finalizedSettled = false;
  record.finalizedSettledAt = null;
  const observed = observeBarrier(promise, record, 'finalized');
  record.finalized = observed;
  observed.then((outcome) => {
    if (outcome.status === 'fulfilled') releaseRecord(runtime, state, record);
  });
  return observed;
}

function retryRejectedFinalization(runtime, state, record) {
  if (record.retryInFlight) return record.retryInFlight;
  const retry = observeFinalizationAttempt(
    runtime,
    state,
    record,
    Promise.resolve().then(() => record.retryCleanup())
  );
  record.retryInFlight = retry;
  retry.then(() => {
    if (record.retryInFlight === retry) record.retryInFlight = null;
  });
  return retry;
}

async function finalizationBarrier(runtime, state, record) {
  const outcome = await record.finalized;
  if (outcome.status === 'fulfilled') return outcome;
  return retryRejectedFinalization(runtime, state, record);
}

function registerDuplicatePairedParserFinalization(runtime, descriptor) {
  if (!descriptor || typeof descriptor !== 'object' ||
      typeof descriptor.jobId !== 'string' || !descriptor.jobId ||
      typeof descriptor.abort !== 'function' ||
      typeof descriptor.retryCleanup !== 'function' ||
      !descriptor.workersTerminal || typeof descriptor.workersTerminal.then !== 'function' ||
      !descriptor.finalized || typeof descriptor.finalized.then !== 'function') {
    throw new TypeError('Duplicate paired Parser finalization descriptor非法');
  }
  const state = runtimeState(runtime);
  const record = {
    jobId: descriptor.jobId,
    abort: descriptor.abort,
    retryCleanup: descriptor.retryCleanup,
    retryInFlight: null,
    workersTerminalSettled: false,
    workersTerminalSettledAt: null,
    finalizedSettled: false,
    finalizedSettledAt: null,
    workersTerminal: null,
    finalized: null
  };
  record.workersTerminal = observeBarrier(descriptor.workersTerminal, record, 'workersTerminal');
  state.records.add(record);
  observeFinalizationAttempt(runtime, state, record, descriptor.finalized);
}

function beginDuplicatePairedParserShutdown(runtime) {
  const state = runtimeState(runtime);
  const records = [...state.records];
  const errors = [];
  for (const record of records) {
    try {
      record.abort();
    } catch (_error) {
      errors.push(shutdownError(
        'DUPLICATE_PAIRED_SHUTDOWN_ABORT_FAILED',
        `Duplicate paired Parser ${record.jobId} shutdown abort失败`
      ));
    }
  }
  return Object.freeze({
    runtime,
    state,
    records: Object.freeze(records),
    errors: Object.freeze(errors)
  });
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForDuplicatePairedParserShutdownPhase(session, phase, timeoutMs) {
  const workerPhase = phase === 'workersTerminal';
  if (!workerPhase && phase !== 'finalized') {
    throw new TypeError('Duplicate paired Parser shutdown phase非法');
  }
  const promises = session.records.map((record) => workerPhase
    ? record.workersTerminal
    : finalizationBarrier(session.runtime, session.state, record));
  const deadline = deadlineAfter(timeoutMs);
  await waitUntil(promises, timeoutMs);
  const errors = [];
  const leakedTransports = [];
  for (let index = 0; index < session.records.length; index += 1) {
    const record = session.records[index];
    if (!record[`${phase}Settled`] || record[`${phase}SettledAt`] > deadline) {
      leakedTransports.push(record.jobId);
      errors.push(shutdownError(
        workerPhase
          ? 'DUPLICATE_PAIRED_WORKER_SHUTDOWN_TIMEOUT'
          : 'DUPLICATE_PAIRED_FINALIZATION_TIMEOUT',
        workerPhase
          ? `Duplicate paired Parser ${record.jobId} Worker未在shutdown截止前退出`
          : `Duplicate paired Parser ${record.jobId} finalization未在shutdown截止前完成`
      ));
      continue;
    }
    const outcome = await promises[index];
    if (outcome.status === 'rejected') {
      leakedTransports.push(record.jobId);
      errors.push(shutdownError(
        workerPhase
          ? 'DUPLICATE_PAIRED_WORKER_BARRIER_FAILED'
          : 'DUPLICATE_PAIRED_FINALIZATION_FAILED',
        `Duplicate paired Parser ${record.jobId} ${workerPhase ? 'Worker barrier' : 'finalization'}失败`
      ));
    }
  }
  return Object.freeze({
    leakedTransports: Object.freeze([...new Set(leakedTransports)]),
    errors: Object.freeze(errors)
  });
}

module.exports = {
  beginDuplicatePairedParserShutdown,
  registerDuplicatePairedParserFinalization,
  waitForDuplicatePairedParserShutdownPhase
};
