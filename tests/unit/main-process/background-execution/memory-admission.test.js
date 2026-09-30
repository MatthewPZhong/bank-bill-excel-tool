'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createResourceGovernor, closeResourceGovernor } = require('../../../../src/main-process/background-execution/resource-governor');
const { createMemoryAdmissionPolicy } = require('../../../../src/main-process/background-execution/memory-admission');
const { validateExecutionMemoryConfig } = require('../../../../src/main-process/background-execution/execution-memory-config');
const { createMemorySampler } = require('../../../../src/main-process/background-execution/memory-telemetry');
const { createPlatformResourceEnvelope, createPlatformResourceBudgets } = require('../../../../src/main-process/background-execution/resource-budget');

const MiB = 1024 ** 2;
function vector(memoryBytes, extra = {}) {
  return { cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes, ...extra };
}
function config(overrides = {}) {
  return {
    version: 1, profileId: 'rows-low-test', policyDigest: 'a'.repeat(64), phaseKey: 'rows',
    phaseMemoryBytes: 256 * MiB, systemReserveBytes: 128 * MiB,
    sstMemoryBytes: 4 * MiB, sstCacheBytes: MiB, styleCacheBytes: MiB,
    sqliteAggregateCacheBytes: 8 * MiB, maxOpenConnections: 2,
    maxInFlightBytes: 4 * MiB, maxSingleRecordBytes: MiB,
    workerLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
    validatedEvidenceId: 'test-only', ...overrides
  };
}
function fakeClock() {
  let time = 10000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { const id = ++nextId; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    get timerCount() { return timers.size; },
    advance(ms) {
      time += ms;
      for (;;) {
        const due = [...timers].filter(([, item]) => item.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    }
  };
}
function fixture(options = {}) {
  const clock = fakeClock();
  const state = { free: 512 * MiB, samples: 0, inventoryComplete: true, blockers: [] };
  const policy = createMemoryAdmissionPolicy({
    compatibilityMemoryBytes: options.compatibilityMemoryBytes ?? 1024 * MiB,
    resolveRequest: options.resolveRequest || ((request) => request.actionKey === 'rows' ? {
      migrated: true, heavy: true, maxGrowthBytes: 0,
      candidates: options.candidates || [{ mode: 'low', config: config() }]
    } : null),
    isEvidenceValid: options.isEvidenceValid || ((value) => value.validatedEvidenceId === 'test-only'),
    externalPressure: () => state,
    sampleMemory: options.sampleMemory || (() => {
      state.samples += 1;
      return { availableBytes: state.free, sampledAt: clock.now() };
    }),
    now: clock.now
  });
  const governor = createResourceGovernor({ budgets: vector(2048 * MiB, { cpuSlots: 4, workerThreadSlots: 4 }),
    memoryAdmission: policy, ...clock, agingMs: 0 });
  return { governor, state, clock };
}
function request(actionKey = 'rows', overrides = {}) {
  return { ownerKey: 'test-owner', actionKey, operationKey: 'test-op', resources: vector(1024 * MiB),
    timeoutMs: 5000, ...overrides };
}

test('hardware ceiling is stable while the existing budget API retains startup compatibility', () => {
  const options = { availableParallelism: 4, totalMemoryBytes: 8 * 1024 * MiB, freeMemoryBytes: 512 * MiB };
  const low = createPlatformResourceEnvelope(options);
  const high = createPlatformResourceEnvelope({ ...options, freeMemoryBytes: 4 * 1024 * MiB });
  assert.equal(low.hardBudgets.memoryBytes, 2048 * MiB);
  assert.equal(low.compatibilityBudgets.memoryBytes, 0);
  assert.deepEqual(low.hardBudgets, high.hardBudgets);
  assert.deepEqual(createPlatformResourceBudgets(options), low.compatibilityBudgets);
});

test('zero compatibility budget rejects before queueing and cannot block a migrated successor', async () => {
  const { governor, clock } = fixture({ compatibilityMemoryBytes: 0 });
  await assert.rejects(governor.acquirePhaseLease(request('legacy')), (error) =>
    error.code === 'RESOURCE_BUDGET_UNAVAILABLE' && error.details.reason === 'stable-limit');
  assert.equal(governor.snapshot().queued.size, 0);
  const lease = await governor.acquirePhaseLease(request());
  assert.equal(lease.memoryMode, 'low');
  assert.equal(lease.resources.memoryBytes, 256 * MiB);
  assert.equal(clock.timerCount, 0);
  lease.release();
});

test('grant binds the selected frozen config instead of trusting caller profile or resources', async () => {
  const normal = config({ profileId: 'normal', phaseMemoryBytes: 4096 * MiB });
  const low = config();
  const { governor } = fixture({ candidates: [{ mode: 'normal', config: normal }, { mode: 'low', config: low }] });
  const lease = await governor.acquirePhaseLease(request('rows', { resources: vector(0), memoryConfig: normal, lowMemory: false }));
  low.sstMemoryBytes = 999;
  assert.equal(lease.memoryMode, 'low');
  assert.equal(lease.memoryConfig.sstMemoryBytes, 4 * MiB);
  assert.ok(Object.isFrozen(lease.memoryConfig));
  assert.ok(Object.isFrozen(lease.memoryConfig.workerLimits));
  assert.equal(governor.snapshot().activeUsage.memoryBytes, lease.memoryConfig.phaseMemoryBytes);
  lease.release();
});

test('ordinary candidate is preferred when both fit', async () => {
  const { governor, state } = fixture({ candidates: [
    { mode: 'normal', config: config({ profileId: 'normal', phaseMemoryBytes: 768 * MiB }) },
    { mode: 'low', config: config() }
  ] });
  state.free = 1200 * MiB;
  const lease = await governor.acquirePhaseLease(request());
  assert.equal(lease.memoryMode, 'normal');
  assert.equal(lease.memoryConfig.profileId, 'normal');
  lease.release();
});

test('queued work resamples without a release event and stops polling after grant', async () => {
  const { governor, state, clock } = fixture();
  state.free = 200 * MiB;
  const pending = governor.acquirePhaseLease(request());
  await Promise.resolve();
  assert.equal(governor.snapshot().queued.size, 1);
  state.free = 512 * MiB;
  clock.advance(1000);
  const lease = await pending;
  assert.ok(state.samples >= 2);
  assert.equal(clock.timerCount, 0);
  lease.release();
});

test('grant checks the fresh sample after queueing, not the earlier fitting sample', async () => {
  const { governor, state, clock } = fixture();
  const blocker = await governor.acquirePhaseLease(request('legacy', { resources: vector(10 * MiB) }));
  const pending = governor.acquirePhaseLease(request());
  state.free = 200 * MiB;
  blocker.release();
  await Promise.resolve();
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.equal(governor.snapshot().queued.size, 1);
  state.free = 512 * MiB;
  clock.advance(1000);
  (await pending).release();
});

test('available memory counts new peak, reserve and future growth without deducting resident quota twice', async () => {
  const { governor, state } = fixture({ resolveRequest: (req) => req.kind === 'base'
    ? { migrated: true, heavy: false, maxGrowthBytes: 16 * MiB }
    : { migrated: true, heavy: true, maxGrowthBytes: 0, candidates: [{ mode: 'low', config: config() }] } });
  const base = await governor.acquireBaseLease(request('base', { resources: vector(256 * MiB) }));
  state.free = (256 + 128 + 16) * MiB;
  const phase = await governor.acquirePhaseLease(request());
  assert.equal(governor.snapshot().activeUsage.memoryBytes, 512 * MiB);
  phase.release();
  base.release();
});

test('unknown growth or incomplete external inventory cannot admit the low candidate', async () => {
  for (const pressure of [
    { inventoryComplete: false },
    { blockers: [{ heavy: false, maxGrowthBytes: null }] },
    { blockers: [{ heavy: true, maxGrowthBytes: 0 }] },
    { blockers: [null] }
  ]) {
    const { governor, state } = fixture();
    Object.assign(state, pressure);
    await assert.rejects(governor.acquirePhaseLease(request('rows', { lowMemoryBehavior: 'reject' })),
      { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
    assert.equal(governor.snapshot().activeLeaseCount, 0);
  }
});

test('low mode serializes other low grants and legacy heavy arrivals through one ledger', async () => {
  const { governor, state } = fixture();
  state.free = 2000 * MiB;
  const first = await governor.acquirePhaseLease(request());
  const second = governor.acquirePhaseLease(request());
  const old = governor.acquirePhaseLease(request('legacy', { resources: vector(10 * MiB) }));
  await Promise.resolve();
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  first.release();
  const next = await second;
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  next.release();
  (await old).release();
});

test('invalid, future, negative, or stale samples reject distinctly and never grant', async () => {
  for (const sample of [null, { availableBytes: NaN, sampledAt: 10000 },
    { availableBytes: 1e9, sampledAt: 10001 }, { availableBytes: 1e9, sampledAt: -1 },
    { availableBytes: 1e9, sampledAt: 8999 }]) {
    const { governor } = fixture({ sampleMemory: () => sample });
    await assert.rejects(governor.acquirePhaseLease(request()), { code: 'RESOURCE_MEMORY_SAMPLE_UNAVAILABLE' });
    assert.equal(governor.snapshot().activeLeaseCount, 0);
  }
});

test('unvalidated profiles are rejected even when memory is plentiful', async () => {
  const { governor } = fixture({ isEvidenceValid: () => false });
  await assert.rejects(governor.acquirePhaseLease(request()), { code: 'RESOURCE_MEMORY_PROFILE_UNVALIDATED' });
  assert.equal(governor.snapshot().queued.size, 0);
});

test('deadlines, cancellation and shutdown remove the periodic sampler', async () => {
  for (const reason of ['deadline', 'cancel', 'shutdown']) {
    const { governor, state, clock } = fixture();
    state.free = 0;
    const controller = new AbortController();
    const pending = governor.acquirePhaseLease(request('rows', { signal: controller.signal, timeoutMs: 100 }));
    const rejected = assert.rejects(pending, { code: { deadline: 'ADMISSION_TIMEOUT',
      cancel: 'ADMISSION_CANCELLED', shutdown: 'ADMISSION_QUEUE_CLOSED' }[reason] });
    if (reason === 'deadline') clock.advance(100);
    if (reason === 'cancel') controller.abort();
    if (reason === 'shutdown') closeResourceGovernor(governor);
    await rejected;
    assert.equal(clock.timerCount, 0);
    assert.equal(governor.snapshot().activeLeaseCount, 0);
  }
});

test('compound stable check uses full topology and still permits the explicit single-child fallback', async () => {
  const { governor } = fixture({ compatibilityMemoryBytes: 600 * MiB });
  const base = await governor.acquireBaseLease(request('legacy', { resources: vector(256 * MiB) }));
  const compound = { ...request('legacy'), base: vector(256 * MiB), phase: vector(128 * MiB),
    childResource: vector(200 * MiB), childrenMax: 2, effectiveChildCount: 2, existingBaseLeaseId: base.leaseId };
  await assert.rejects(governor.acquireCompoundLease(compound), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
  const single = await governor.acquireCompoundLease({ ...compound, lowMemoryBehavior: 'downgrade-to-single' });
  assert.equal(single.effectiveChildCount, 1);
  assert.equal(governor.snapshot().activeUsage.memoryBytes, 584 * MiB);
  single.release();
  base.release();
});

test('rejected replacement frees its parent dependency and successful replacement charges only growth', async () => {
  const { governor } = fixture({ compatibilityMemoryBytes: 600 * MiB });
  const old = await governor.acquirePersistentReservation(request('legacy', { resources: vector(256 * MiB) }));
  await assert.rejects(governor.acquirePersistentReservation(request('legacy', {
    resources: vector(700 * MiB), replacesReservationId: old.leaseId
  })), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
  const replacement = await governor.acquirePersistentReservation(request('legacy', {
    resources: vector(512 * MiB), replacesReservationId: old.leaseId
  }));
  assert.equal(governor.snapshot().activeUsage.memoryBytes, 512 * MiB);
  replacement.release();
  assert.equal(old.release(), true);
});

test('config rejects unrecognized fields, accessors, unsafe byte counts and oversized caches', () => {
  const getter = config();
  let invoked = false;
  Object.defineProperty(getter, 'phaseMemoryBytes', { enumerable: true, get() { invoked = true; return MiB; } });
  for (const invalid of [getter, { ...config(), bypass: true }, config({ maxSingleRecordBytes: -1 }),
    config({ phaseMemoryBytes: Number.MAX_SAFE_INTEGER + 1 }), config({ sstMemoryBytes: 256 * MiB }),
    config({ workerLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 8 } })]) {
    assert.throws(() => validateExecutionMemoryConfig(invalid), { code: 'RESOURCE_MEMORY_CONFIG_INVALID' });
  }
  assert.equal(invoked, false);
});

test('system sampler reports failure instead of manufacturing zero or infinite memory', () => {
  const sample = createMemorySampler({ freeMemory: () => 512 * MiB, now: () => 100 });
  assert.deepEqual(sample(), { availableBytes: 512 * MiB, sampledAt: 100, commitAvailableBytes: null });
  assert.throws(createMemorySampler({ freeMemory: () => { throw new Error('unavailable'); } }),
    { code: 'RESOURCE_MEMORY_SAMPLE_UNAVAILABLE' });
});

test('synchronous sampling cannot reenter a second grant between the snapshot and ledger update', async () => {
  let nested;
  const f = fixture({ sampleMemory: () => {
    if (!nested) nested = f.governor.acquirePhaseLease(request('legacy', { resources: vector(10 * MiB) }));
    return { availableBytes: 2048 * MiB, sampledAt: f.clock.now() };
  } });
  const lease = await f.governor.acquirePhaseLease(request());
  assert.equal(f.governor.snapshot().activeLeaseCount, 1);
  assert.equal(f.governor.snapshot().queued.size, 1);
  lease.release();
  (await nested).release();
});

test('shutdown or cancellation during the final sample cannot publish a lease', async () => {
  for (const reason of ['close', 'abort']) {
    const controller = new AbortController();
    const f = fixture({ sampleMemory: () => {
      if (reason === 'close') closeResourceGovernor(f.governor);
      else controller.abort();
      return { availableBytes: 2048 * MiB, sampledAt: f.clock.now() };
    } });
    await assert.rejects(f.governor.acquirePhaseLease(request('rows', { signal: controller.signal })),
      { code: reason === 'close' ? 'RESOURCE_GOVERNOR_CLOSED' : 'ADMISSION_CANCELLED' });
    assert.equal(f.governor.snapshot().activeLeaseCount, 0);
  }
});
