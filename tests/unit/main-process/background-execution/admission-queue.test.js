'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFER_ADMISSION,
  MAX_TIMER_DELAY_MS,
  createAdmissionQueue
} = require('../../../../src/main-process/background-execution/admission-queue');

function createFakeClock() {
  let timestamp = 0;
  let timerId = 0;
  const timers = new Map();

  function runDueTimers() {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= timestamp)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      timers.delete(id);
      timer.callback();
    }
  }

  return {
    now: () => timestamp,
    setTimer(callback, delay) {
      timerId += 1;
      timers.set(timerId, { at: timestamp + delay, callback });
      return timerId;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      timestamp += milliseconds;
      runDueTimers();
    }
  };
}

function enqueue(queue, requestId, options = {}) {
  return queue.enqueue({ requestId, payload: requestId, ...options });
}

test('admission queue preserves FIFO within priority and admits higher priority first', async () => {
  const queue = createAdmissionQueue({ agingMs: 100 });
  const order = [];
  const first = enqueue(queue, 'normal-1');
  const second = enqueue(queue, 'normal-2');
  const interactive = enqueue(queue, 'interactive', { priority: 'interactive' });

  queue.drain((payload) => {
    order.push(payload);
    return `granted:${payload}`;
  });

  assert.deepEqual(await Promise.all([first, second, interactive]), [
    'granted:normal-1',
    'granted:normal-2',
    'granted:interactive'
  ]);
  assert.deepEqual(order, ['interactive', 'normal-1', 'normal-2']);
});

test('aging promotes an older request without breaking its insertion order', async () => {
  const clock = createFakeClock();
  const queue = createAdmissionQueue({ ...clock, agingMs: 10 });
  const older = enqueue(queue, 'older', { priority: 'maintenance' });
  clock.advance(20);
  const newer = enqueue(queue, 'newer', { priority: 'normal' });
  const order = [];

  queue.drain((payload) => {
    order.push(payload);
    return payload;
  });

  await Promise.all([older, newer]);
  assert.deepEqual(order, ['older', 'newer']);
});

test('a deferred head stays queued until a later drain and cannot be partially granted', async () => {
  const queue = createAdmissionQueue({ agingMs: 0 });
  let available = false;
  const pending = enqueue(queue, 'pending');
  queue.drain((payload) => available ? payload : DEFER_ADMISSION);
  await Promise.resolve();
  assert.equal(queue.snapshot().size, 1);

  available = true;
  queue.drain();
  assert.equal(await pending, 'pending');
  assert.equal(queue.snapshot().size, 0);
});

test('abort and explicit cancel reject queued requests and detach them', async () => {
  const queue = createAdmissionQueue({ agingMs: 0 });
  const controller = new AbortController();
  const aborted = enqueue(queue, 'aborted', { signal: controller.signal });
  const cancelled = enqueue(queue, 'cancelled');

  controller.abort();
  assert.equal(queue.cancel('cancelled', 'caller cancelled'), true);
  await assert.rejects(aborted, (error) => error.code === 'ADMISSION_CANCELLED');
  await assert.rejects(cancelled, (error) => error.code === 'ADMISSION_CANCELLED');
  assert.deepEqual(queue.snapshot().entries, []);
});

test('fake-clock timeout rejects and removes a request without leaving a pending promise', async () => {
  const clock = createFakeClock();
  const queue = createAdmissionQueue({ ...clock, agingMs: 100 });
  const pending = enqueue(queue, 'timeout', { timeoutMs: 25 });

  clock.advance(24);
  assert.equal(queue.snapshot().size, 1);
  clock.advance(1);
  await assert.rejects(pending, (error) => error.code === 'ADMISSION_TIMEOUT');
  assert.equal(queue.snapshot().size, 0);
});

test('close rejects every queued request, is idempotent, and rejects future enqueue', async () => {
  const queue = createAdmissionQueue({ agingMs: 0 });
  const first = enqueue(queue, 'first');
  const second = enqueue(queue, 'second');

  assert.equal(queue.close('shutdown'), true);
  assert.equal(queue.close('shutdown again'), false);
  await assert.rejects(first, (error) => error.code === 'ADMISSION_QUEUE_CLOSED');
  await assert.rejects(second, (error) => error.code === 'ADMISSION_QUEUE_CLOSED');
  await assert.rejects(enqueue(queue, 'late'), (error) => error.code === 'ADMISSION_QUEUE_CLOSED');
});

test('a drain callback failure rejects only that request and continues draining', async () => {
  const queue = createAdmissionQueue({ agingMs: 0 });
  const failed = enqueue(queue, 'failed');
  const succeeded = enqueue(queue, 'succeeded');

  queue.drain((payload) => {
    if (payload === 'failed') throw new Error('grant failed');
    return payload;
  });

  await assert.rejects(failed, /grant failed/);
  assert.equal(await succeeded, 'succeeded');
});

test('absolute deadline is rechecked after a blocking head before the next callback', async () => {
  const clock = createFakeClock();
  const queue = createAdmissionQueue({ ...clock, agingMs: 100 });
  const blocker = enqueue(queue, 'blocker', { priority: 'recovery' });
  const expired = enqueue(queue, 'expired', { timeoutMs: 1 });
  const calls = [];

  queue.drain((payload) => {
    calls.push(payload);
    if (payload === 'blocker') clock.advance(15);
    return payload;
  });

  assert.equal(await blocker, 'blocker');
  await assert.rejects(expired, (error) => error.code === 'ADMISSION_TIMEOUT');
  assert.deepEqual(calls, ['blocker']);
});

test('close and abort reentry cannot rewrite an executing grant', async () => {
  for (const mode of ['close', 'abort']) {
    const queue = createAdmissionQueue({ agingMs: 0 });
    const controller = new AbortController();
    const pending = enqueue(queue, mode, { signal: controller.signal });
    queue.drain((payload) => {
      if (mode === 'close') queue.close('diagnostics-close');
      else controller.abort();
      return `committed:${payload}`;
    });
    assert.equal(await pending, `committed:${mode}`);
    assert.equal(queue.snapshot().size, 0);
  }
});

test('aging eventually lets an old maintenance request lead newer recovery work', async () => {
  const clock = createFakeClock();
  const queue = createAdmissionQueue({ ...clock, agingMs: 10 });
  const old = enqueue(queue, 'old-maintenance', { priority: 'maintenance' });
  clock.advance(30);
  const newer = enqueue(queue, 'new-recovery', { priority: 'recovery' });
  const order = [];
  queue.drain((payload) => {
    order.push(payload);
    return payload;
  });
  await Promise.all([old, newer]);
  assert.deepEqual(order, ['old-maintenance', 'new-recovery']);
});

test('timer-unsafe timeout values reject before enqueue without scheduling a clamped timer', async () => {
  let timerCalls = 0;
  const queue = createAdmissionQueue({
    agingMs: 0,
    setTimer() {
      timerCalls += 1;
      throw new Error('timer must not be scheduled');
    }
  });

  for (const timeoutMs of [MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      enqueue(queue, `unsafe-${timeoutMs}`, { timeoutMs }),
      (error) => error.code === 'ADMISSION_DURATION_INVALID'
    );
  }
  assert.equal(timerCalls, 0);
  assert.equal(queue.snapshot().size, 0);
});
