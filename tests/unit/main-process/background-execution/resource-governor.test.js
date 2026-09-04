'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  closeResourceGovernor,
  createResourceGovernor,
  releaseResourceWhenUnreferenced
} = require(
  '../../../../src/main-process/background-execution/resource-governor'
);
const backgroundExecution = require('../../../../src/main-process/background-execution');

function vector(overrides = {}) {
  return {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0,
    ...overrides
  };
}

function createGovernor(options = {}) {
  let id = 0;
  return createResourceGovernor({
    budgets: vector({
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 2,
      ioHeavySlots: 4,
      memoryBytes: 1024
    }),
    idFactory: (prefix) => `${prefix}-${++id}`,
    ...options
  });
}

function request(resources, overrides = {}) {
  return {
    ownerKey: 'owner-1',
    actionKey: 'action-1',
    operationKey: 'operation-1',
    resources,
    ...overrides
  };
}

test('specialized lease APIs account and release every non-compound lease kind', async () => {
  const governor = createGovernor();
  const base = await governor.acquireBaseLease(request(vector({ workerThreadSlots: 1, memoryBytes: 100 })));
  const persistent = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 200 })));
  const pending = await governor.acquirePendingInteractionReservation(request(vector({ memoryBytes: 50 })));
  const phase = await governor.acquirePhaseLease(request(vector({ cpuSlots: 1, ioHeavySlots: 1 })));

  assert.deepEqual(governor.snapshot().activeUsage, vector({
    cpuSlots: 1,
    workerThreadSlots: 1,
    ioHeavySlots: 1,
    memoryBytes: 350
  }));
  assert.deepEqual([base.kind, persistent.kind, pending.kind, phase.kind], [
    'base', 'persistent', 'pending-interaction', 'phase'
  ]);

  assert.equal(base.release('service-closed'), true);
  assert.equal(persistent.release('state-closed'), true);
  assert.equal(pending.release('token-consumed'), true);
  assert.equal(phase.release('phase-ended'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('duplicate cleanup is idempotent and IDs are never reused', async () => {
  let call = 0;
  const governor = createResourceGovernor({
    budgets: vector({ memoryBytes: 10 }),
    idFactory: () => `fixed-${Math.min(++call, 1)}`
  });
  const lease = await governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));
  assert.equal(lease.release('first'), true);
  assert.equal(lease.release('second'), false);
  await assert.rejects(
    governor.acquirePhaseLease(request(vector({ memoryBytes: 1 }))),
    (error) => error.code === 'RESOURCE_ID_REUSED'
  );
  assert.deepEqual(governor.snapshot().activeUsage, vector());
  assert.equal(governor.snapshot().diagnostics.duplicateRelease, 1);
});

test('budget pressure queues exact requests and releasing capacity drains FIFO', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 10 })));
  const first = governor.acquirePhaseLease(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'first'
  }));
  const second = governor.acquirePhaseLease(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'second'
  }));
  assert.equal(governor.snapshot().queued.size, 2);

  blocker.release('capacity-returned');
  const firstLease = await first;
  const secondLease = await second;
  assert.equal(firstLease.ownerKey, 'first');
  assert.equal(secondLease.ownerKey, 'second');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 10 }));
});

test('backlog is a single fairness boundary for fitting and reject-mode arrivals', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 5 }), {
    ownerKey: 'blocker'
  }));
  const older = governor.acquirePhaseLease(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'older-normal'
  }));
  const newer = governor.acquirePhaseLease(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'newer-reject',
    lowMemoryBehavior: 'reject'
  }));

  assert.equal(governor.snapshot().queued.size, 2);
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 5 }));
  blocker.release('capacity-returned');
  const olderLease = await older;
  const newerLease = await newer;
  assert.equal(olderLease.ownerKey, 'older-normal');
  assert.equal(newerLease.ownerKey, 'newer-reject');
});

test('a new maintenance request cannot bypass queued recovery work', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 5 })));
  const recovery = governor.acquirePhaseLease(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'recovery',
    priority: 'recovery'
  }));
  const maintenance = governor.acquirePhaseLease(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'maintenance',
    priority: 'maintenance'
  }));
  assert.equal(governor.snapshot().queued.size, 2);
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 5 }));
  blocker.release('capacity-returned');
  assert.equal((await recovery).ownerKey, 'recovery');
  assert.equal((await maintenance).ownerKey, 'maintenance');
});

test('reject behavior never queues or grants an implicit partial vector', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 8 })));
  await assert.rejects(
    governor.acquirePhaseLease(request(vector({ memoryBytes: 3 }), { lowMemoryBehavior: 'reject' })),
    (error) => error.code === 'RESOURCE_BUDGET_UNAVAILABLE'
  );
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 8 }));
  assert.equal(governor.snapshot().queued.size, 0);
  blocker.release('test-end');
});

test('queued AbortSignal cancellation settles without spawning a lease', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 1 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));
  const controller = new AbortController();
  const queued = governor.acquirePhaseLease(request(vector({ memoryBytes: 1 }), {
    signal: controller.signal
  }));
  controller.abort();
  await assert.rejects(queued, (error) => error.code === 'ADMISSION_CANCELLED');
  assert.equal(governor.snapshot().queued.size, 0);
  blocker.release('test-end');
});

test('compound lease charges one root plus phase plus children and exposes frozen topology', async () => {
  const governor = createGovernor();
  const lease = await governor.acquireCompoundLease({
    ownerKey: 'pool-1',
    actionKey: 'import',
    operationKey: 'op-1',
    base: vector({ workerThreadSlots: 1, memoryBytes: 100 }),
    phase: vector({ ioHeavySlots: 1, memoryBytes: 20 }),
    childResource: vector({ cpuSlots: 1, workerThreadSlots: 1, memoryBytes: 50 }),
    childrenMax: 4,
    effectiveChildCount: 3
  });

  assert.deepEqual(lease.resources, vector({
    cpuSlots: 3,
    workerThreadSlots: 4,
    ioHeavySlots: 1,
    memoryBytes: 270
  }));
  assert.equal(lease.effectiveChildCount, 3);
  assert.equal(lease.topology.childrenMax, 4);
  assert.equal(Object.isFrozen(lease.topology), true);
  assert.deepEqual(governor.snapshot().activeUsage, lease.resources);
});

test('service compound references an existing base and only charges phase plus children', async () => {
  const governor = createGovernor();
  const baseVector = vector({ workerThreadSlots: 1, memoryBytes: 100 });
  const base = await governor.acquireBaseLease(request(baseVector, {
    ownerKey: 'shared-service',
    actionKey: 'service-starter'
  }));
  const compound = await governor.acquireCompoundLease({
    ownerKey: 'shared-service',
    actionKey: 'different-service-action',
    operationKey: 'op-2',
    base: baseVector,
    phase: vector({ ioHeavySlots: 1, memoryBytes: 20 }),
    childResource: vector({ cpuSlots: 1, memoryBytes: 30 }),
    childrenMax: 2,
    effectiveChildCount: 2,
    existingBaseLeaseId: base.leaseId
  });

  assert.deepEqual(compound.resources, vector({
    cpuSlots: 2,
    workerThreadSlots: 1,
    ioHeavySlots: 1,
    memoryBytes: 180
  }));
  assert.deepEqual(governor.snapshot().activeUsage, compound.resources);
  compound.release('job-terminal');
  assert.deepEqual(governor.snapshot().activeUsage, baseVector);
  base.release('service-close');
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('downgrade-to-single is explicit, observable, and otherwise queues the exact topology', async () => {
  const governor = createGovernor({ budgets: vector({ cpuSlots: 1, workerThreadSlots: 2, memoryBytes: 200 }) });
  const lease = await governor.acquireCompoundLease({
    ownerKey: 'pool',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector({ workerThreadSlots: 1, memoryBytes: 50 }),
    phase: vector(),
    childResource: vector({ cpuSlots: 1, workerThreadSlots: 1, memoryBytes: 100 }),
    childrenMax: 3,
    effectiveChildCount: 3,
    lowMemoryBehavior: 'downgrade-to-single'
  });

  assert.equal(lease.effectiveChildCount, 1);
  assert.equal(lease.downgraded, true);
  assert.equal(lease.downgradeReason, 'resource-budget');
  assert.deepEqual(lease.resources, vector({ cpuSlots: 1, workerThreadSlots: 2, memoryBytes: 150 }));
  assert.equal(governor.snapshot().diagnostics.downgraded, 1);
});

test('tentative replacement reserves only growth and keeps old reservation until adoption', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service'
  }));
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 2 }), {
    ownerKey: 'blocker'
  }));
  const candidate = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 8 }), {
    ownerKey: 'service',
    replacesReservationId: old.leaseId
  }));

  assert.equal(old.state, 'granted');
  assert.equal(candidate.replacesReservationId, old.leaseId);
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 10 }));

  blocker.release('phase-end');
  const adopted = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: { tentativeReservationId: candidate.leaseId }
  });
  assert.equal(old.state, 'released');
  assert.equal(adopted.leaseId, candidate.leaseId);
  assert.equal(adopted.replacesReservationId, null);
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 8 }));
});

test('failed replacement leaves the old reservation and tentative grant independently releasable', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service-a'
  }));
  const candidate = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 7 }), {
    ownerKey: 'service-a',
    replacesReservationId: old.leaseId
  }));

  await assert.rejects(
    governor.replaceReservationAtomically({
      oldReservationId: 'stale-reservation',
      nextRequest: { tentativeReservationId: candidate.leaseId }
    }),
    (error) => error.code === 'RESOURCE_REPLACEMENT_STALE'
  );
  assert.equal(old.state, 'granted');
  assert.equal(candidate.state, 'granted');
  candidate.release('candidate-revoked');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 6 }));
});

test('direct atomic replacement releases the old reservation only after the new request succeeds', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 7 }), {
    ownerKey: 'service'
  }));
  const replacement = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: request(vector({ memoryBytes: 4 }), {
      ownerKey: 'service'
    })
  });

  assert.equal(old.state, 'released');
  assert.equal(replacement.resources.memoryBytes, 4);
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 4 }));
});

test('pending-interaction replacement keeps old grant until exact atomic adoption', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePendingInteractionReservation(request(vector({ memoryBytes: 7 }), {
    ownerKey: 'statement-token-slot'
  }));
  const candidate = await governor.acquirePendingInteractionReservation(request(vector({ memoryBytes: 9 }), {
    ownerKey: 'statement-token-slot',
    replacesReservationId: old.leaseId
  }));

  assert.equal(old.state, 'granted');
  assert.equal(candidate.state, 'granted');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 9 }));

  candidate.release('candidate-rejected');
  assert.equal(old.state, 'granted');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 7 }));
  const acceptedCandidate = await governor.acquirePendingInteractionReservation(request(
    vector({ memoryBytes: 9 }),
    { ownerKey: 'statement-token-slot', replacesReservationId: old.leaseId }
  ));

  const adopted = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: { tentativeReservationId: acceptedCandidate.leaseId }
  });
  assert.equal(old.state, 'released');
  assert.equal(adopted.kind, 'pending-interaction');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 9 }));
  adopted.release('token-consumed');
});

test('compound identity and count violations fail before mutating accounting', async () => {
  const governor = createGovernor();
  const base = await governor.acquireBaseLease(request(vector({ workerThreadSlots: 1 }), {
    ownerKey: 'service-a'
  }));
  await assert.rejects(governor.acquireCompoundLease({
    ownerKey: 'service-b',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector({ workerThreadSlots: 1 }),
    phase: vector(),
    childResource: vector({ cpuSlots: 1 }),
    childrenMax: 1,
    effectiveChildCount: 2,
    existingBaseLeaseId: base.leaseId
  }), (error) => error.code === 'RESOURCE_COMPOUND_COUNT_INVALID');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ workerThreadSlots: 1 }));
});

test('package-private lifecycle close rejects queued and future requests without exposing a facade alias', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 1 }) });
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));
  const queued = governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));

  assert.equal(closeResourceGovernor(governor, 'shutdown'), true);
  assert.equal(closeResourceGovernor(governor, 'shutdown-again'), false);
  await assert.rejects(queued, (error) => error.code === 'ADMISSION_QUEUE_CLOSED');
  await assert.rejects(
    governor.acquirePhaseLease(request(vector())),
    (error) => error.code === 'RESOURCE_GOVERNOR_CLOSED'
  );
  assert.equal(governor.snapshot().accepting, false);
  assert.equal(Object.hasOwn(governor, 'close'), false);
  blocker.release('shutdown');
});

test('snapshot and diagnostics expose stable owner hashes, never raw owner keys', async () => {
  const emitted = [];
  const governor = createGovernor({ diagnostics: (entry) => emitted.push(entry) });
  const lease = await governor.acquirePhaseLease(request(vector({ memoryBytes: 1 }), {
    ownerKey: 'sensitive-owner-key'
  }));
  const snapshot = governor.snapshot();
  assert.equal(Object.hasOwn(snapshot.activeLeases[0], 'ownerKey'), false);
  assert.match(snapshot.activeLeases[0].ownerKeyHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes('sensitive-owner-key'), false);
  assert.equal(JSON.stringify(emitted).includes('sensitive-owner-key'), false);
  lease.release('test-end');
});

test('effectiveChildCount overflow has the specific count message and does not mutate usage', async () => {
  const governor = createGovernor();
  await assert.rejects(governor.acquireCompoundLease({
    ownerKey: 'pool',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector(),
    phase: vector(),
    childResource: vector({ cpuSlots: 1 }),
    childrenMax: 1,
    effectiveChildCount: 2
  }), (error) => error.code === 'RESOURCE_COMPOUND_COUNT_INVALID' &&
    error.message === 'effectiveChildCount must not exceed childrenMax');
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('childrenMax is bounded at 128 while zero-child compound charges only root and phase', async () => {
  const governor = createGovernor();
  await assert.rejects(governor.acquireCompoundLease({
    ownerKey: 'pool',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector(),
    phase: vector(),
    childResource: vector(),
    childrenMax: 129,
    effectiveChildCount: 0
  }), (error) => error.code === 'RESOURCE_COMPOUND_COUNT_INVALID');
  assert.deepEqual(governor.snapshot().activeUsage, vector());

  const zeroChild = await governor.acquireCompoundLease({
    ownerKey: 'pool',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector({ workerThreadSlots: 1 }),
    phase: vector({ ioHeavySlots: 1 }),
    childResource: vector({ memoryBytes: 100 }),
    childrenMax: 0,
    effectiveChildCount: 0
  });
  assert.deepEqual(zeroChild.resources, vector({ workerThreadSlots: 1, ioHeavySlots: 1 }));
});

test('active and queued compound dependencies prevent premature BaseLease release', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const base = await governor.acquireBaseLease(request(vector({ memoryBytes: 2 }), {
    ownerKey: 'service'
  }));
  const active = await governor.acquireCompoundLease({
    ownerKey: 'service',
    actionKey: 'job',
    operationKey: 'op',
    base: vector({ memoryBytes: 2 }),
    phase: vector({ memoryBytes: 1 }),
    childResource: vector(),
    childrenMax: 0,
    effectiveChildCount: 0,
    existingBaseLeaseId: base.leaseId
  });
  assert.throws(() => base.release('too-early'), (error) => error.code === 'RESOURCE_DEPENDENCY_ACTIVE');
  active.release('job-terminal');

  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 8 }), {
    ownerKey: 'blocker'
  }));
  const controller = new AbortController();
  const queued = governor.acquireCompoundLease({
    ownerKey: 'service',
    actionKey: 'job',
    operationKey: 'op-2',
    base: vector({ memoryBytes: 2 }),
    phase: vector({ memoryBytes: 1 }),
    childResource: vector(),
    childrenMax: 0,
    effectiveChildCount: 0,
    existingBaseLeaseId: base.leaseId,
    signal: controller.signal
  });
  assert.throws(() => base.release('queued-dependent'), (error) => error.code === 'RESOURCE_DEPENDENCY_ACTIVE');
  controller.abort();
  await assert.rejects(queued, (error) => error.code === 'ADMISSION_CANCELLED');
  assert.equal(base.release('service-close'), true);
  blocker.release('test-end');
});

test('compound vector preparation failure releases its BaseLease dependency', async () => {
  const governor = createGovernor();
  const base = await governor.acquireBaseLease(request(vector(), {
    ownerKey: 'service'
  }));
  await assert.rejects(governor.acquireCompoundLease({
    ownerKey: 'service',
    actionKey: 'job',
    operationKey: 'overflow',
    base: vector(),
    phase: vector(),
    childResource: vector({ memoryBytes: Number.MAX_SAFE_INTEGER }),
    childrenMax: 2,
    effectiveChildCount: 2,
    existingBaseLeaseId: base.leaseId
  }), (error) => error.code === 'RESOURCE_VECTOR_OVERFLOW');
  assert.equal(governor.snapshot().activeDependencyCount, 0);
  assert.equal(base.release('service-close'), true);
});

test('tentative replacement dependency prevents the budget-10 actual-commitment-18 bypass', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 8 }), {
    ownerKey: 'service'
  }));
  const candidate = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 10 }), {
    ownerKey: 'service',
    replacesReservationId: old.leaseId
  }));
  await assert.rejects(
    governor.acquirePersistentReservation(request(vector({ memoryBytes: 9 }), {
      ownerKey: 'service',
      replacesReservationId: old.leaseId
    })),
    (error) => error.code === 'RESOURCE_REPLACEMENT_IN_PROGRESS'
  );
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 10 }));
  assert.throws(() => old.release('unsafe-early-release'), (error) => error.code === 'RESOURCE_DEPENDENCY_ACTIVE');
  await assert.rejects(
    governor.acquirePhaseLease(request(vector({ memoryBytes: 8 }), {
      ownerKey: 'unrelated',
      lowMemoryBehavior: 'reject'
    })),
    (error) => error.code === 'RESOURCE_BUDGET_UNAVAILABLE'
  );
  candidate.release('candidate-revoked');
  assert.equal(old.release('state-close'), true);
});

test('queued replacement dependency blocks old release and is removed synchronously on abort', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service'
  }));
  const blocker = await governor.acquirePhaseLease(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'blocker'
  }));
  const controller = new AbortController();
  const queued = governor.acquirePersistentReservation(request(vector({ memoryBytes: 8 }), {
    ownerKey: 'service',
    replacesReservationId: old.leaseId,
    signal: controller.signal
  }));
  assert.throws(() => old.release('too-early'), (error) => error.code === 'RESOURCE_DEPENDENCY_ACTIVE');
  controller.abort();
  assert.equal(old.release('after-abort'), true);
  await assert.rejects(queued, (error) => error.code === 'ADMISSION_CANCELLED');
  blocker.release('test-end');
});

test('replacement identity requires matching owner, action, and operation', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 2 })));
  for (const [overrides, code] of [
    [{ ownerKey: 'other' }, 'RESOURCE_REPLACEMENT_OWNER_MISMATCH'],
    [{ actionKey: 'other' }, 'RESOURCE_REPLACEMENT_ACTION_MISMATCH'],
    [{ operationKey: 'other' }, 'RESOURCE_REPLACEMENT_OPERATION_MISMATCH']
  ]) {
    await assert.rejects(
      governor.acquirePersistentReservation(request(vector({ memoryBytes: 3 }), {
        ...overrides,
        replacesReservationId: old.leaseId
      })),
      (error) => error.code === code
    );
  }
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 2 }));
});

test('queued grant remains owned when synchronous diagnostics closes the Governor', async () => {
  let governor;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 1 }),
    diagnostics(event) {
      if (event.type === 'resource-granted' && event.kind === 'phase') {
        closeResourceGovernor(governor, 'diagnostic-reentry');
      }
    }
  });
  const blocker = await governor.acquireBaseLease(request(vector({ memoryBytes: 1 })));
  const queued = governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));
  blocker.release('capacity-returned');
  const lease = await queued;
  assert.equal(lease.state, 'granted');
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  lease.release('test-end');
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('package entry exports only specialized Governor/ServiceHost factories, not generic primitives', () => {
  assert.equal(backgroundExecution.createResourceGovernor, createResourceGovernor);
  assert.equal(typeof backgroundExecution.createServiceClient, 'function');
  assert.equal(typeof backgroundExecution.createServiceHost, 'function');
  for (const privateName of ['createAdmissionQueue', 'requestLease', 'closeResourceGovernor']) {
    assert.equal(Object.hasOwn(backgroundExecution, privateName), false);
  }
});

test('immediately available requests still validate timeout, priority, and pre-aborted signal', async () => {
  const governor = createGovernor();
  const controller = new AbortController();
  controller.abort();
  for (const [overrides, code] of [
    [{ timeoutMs: -1 }, 'RESOURCE_TIMEOUT_INVALID'],
    [{ priority: 'urgent' }, 'RESOURCE_PRIORITY_INVALID'],
    [{ signal: controller.signal }, 'ADMISSION_CANCELLED']
  ]) {
    await assert.rejects(
      governor.acquirePhaseLease(request(vector({ memoryBytes: 1 }), overrides)),
      (error) => error.code === code
    );
  }
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('replacement chains require each parent to be adopted before the next candidate', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const first = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'service'
  }));
  const second = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service',
    replacesReservationId: first.leaseId
  }));

  await assert.rejects(
    governor.replaceReservationAtomically({
      oldReservationId: second.leaseId,
      nextRequest: { tentativeReservationId: second.leaseId }
    }),
    (error) => error.code === 'RESOURCE_REPLACEMENT_PARENT_TENTATIVE'
  );
  await assert.rejects(
    governor.replaceReservationAtomically({
      oldReservationId: second.leaseId,
      nextRequest: request(vector({ memoryBytes: 5 }), { ownerKey: 'service' })
    }),
    (error) => error.code === 'RESOURCE_REPLACEMENT_PARENT_TENTATIVE'
  );
  assert.equal(first.state, 'granted');
  assert.equal(second.state, 'granted');

  const adoptedSecond = await governor.replaceReservationAtomically({
    oldReservationId: first.leaseId,
    nextRequest: { tentativeReservationId: second.leaseId }
  });
  const third = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 5 }), {
    ownerKey: 'service',
    replacesReservationId: adoptedSecond.leaseId
  }));
  const adoptedThird = await governor.replaceReservationAtomically({
    oldReservationId: adoptedSecond.leaseId,
    nextRequest: { tentativeReservationId: third.leaseId }
  });
  assert.equal(adoptedThird.release('test-end'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
  assert.equal(governor.snapshot().activeDependencyCount, 0);
});

test('synchronous grant diagnostics cannot release a lease before delivery', async () => {
  let governor;
  let reentrantRelease;
  governor = createGovernor({
    diagnostics(event) {
      if (event.type === 'resource-granted') {
        reentrantRelease = governor.release(event.leaseId, 'diagnostic-reentry');
      }
    }
  });

  const lease = await governor.acquirePhaseLease(request(vector({ memoryBytes: 1 })));
  assert.equal(reentrantRelease, false);
  assert.equal(lease.state, 'granted');
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  assert.equal(lease.release('normal-release'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('synchronous grant diagnostics cannot take an undelivered persistent lease as a replacement parent', async () => {
  let governor;
  let nestedReplacement;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 10 }),
    diagnostics(event) {
      if (event.type === 'resource-granted' && event.kind === 'persistent' && !nestedReplacement) {
        nestedReplacement = governor.replaceReservationAtomically({
          oldReservationId: event.leaseId,
          nextRequest: request(vector({ memoryBytes: 5 }), { ownerKey: 'service' })
        });
        nestedReplacement.catch(() => {});
      }
    }
  });

  const lease = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'service'
  }));
  await assert.rejects(
    nestedReplacement,
    (error) => error.code === 'RESOURCE_PARENT_DELIVERY_PENDING'
  );
  assert.equal(lease.state, 'granted');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 4 }));
  assert.equal(governor.snapshot().activeDependencyCount, 0);
  assert.equal(lease.release('normal-release'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('synchronous grant diagnostics cannot take an undelivered BaseLease as a compound parent', async () => {
  let governor;
  let nestedCompound;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 10 }),
    diagnostics(event) {
      if (event.type === 'resource-granted' && event.kind === 'base') {
        nestedCompound = governor.acquireCompoundLease({
          ownerKey: 'service',
          actionKey: 'action-1',
          operationKey: 'operation-1',
          base: vector({ memoryBytes: 4 }),
          phase: vector({ memoryBytes: 1 }),
          childResource: vector(),
          childrenMax: 0,
          effectiveChildCount: 0,
          existingBaseLeaseId: event.leaseId
        });
        nestedCompound.catch(() => {});
      }
    }
  });

  const base = await governor.acquireBaseLease(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'service'
  }));
  await assert.rejects(
    nestedCompound,
    (error) => error.code === 'RESOURCE_PARENT_DELIVERY_PENDING'
  );
  assert.equal(base.state, 'granted');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 4 }));
  assert.equal(governor.snapshot().activeDependencyCount, 0);
  assert.equal(base.release('normal-release'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('tentative replacement cannot be adopted from its synchronous grant diagnostics', async () => {
  let governor;
  let oldReservationId;
  let earlyAdoption;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 10 }),
    diagnostics(event) {
      if (event.type === 'resource-granted' && oldReservationId && event.leaseId !== oldReservationId) {
        earlyAdoption = governor.replaceReservationAtomically({
          oldReservationId,
          nextRequest: { tentativeReservationId: event.leaseId }
        });
        earlyAdoption.catch(() => {});
      }
    }
  });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 4 }), {
    ownerKey: 'service'
  }));
  oldReservationId = old.leaseId;
  const candidate = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service',
    replacesReservationId: old.leaseId
  }));

  await assert.rejects(
    earlyAdoption,
    (error) => error.code === 'RESOURCE_REPLACEMENT_CANDIDATE_DELIVERY_PENDING'
  );
  assert.equal(old.state, 'granted');
  assert.equal(candidate.state, 'granted');
  const adopted = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: { tentativeReservationId: candidate.leaseId }
  });
  assert.equal(adopted.release('test-end'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('atomic replacement diagnostics cannot release the published lease before delivery', async () => {
  let governor;
  let reentrantRelease;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 10 }),
    diagnostics(event) {
      if (event.type === 'resource-replaced') {
        reentrantRelease = governor.release(event.reservationId, 'diagnostic-reentry');
      }
    }
  });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service'
  }));
  const replacement = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: request(vector({ memoryBytes: 4 }), { ownerKey: 'service' })
  });

  assert.equal(reentrantRelease, false);
  assert.equal(replacement.state, 'granted');
  assert.equal(replacement.release('normal-release'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('replacement diagnostics cannot take the newly published lease as a chained replacement parent', async () => {
  let governor;
  let chainedReplacement;
  governor = createGovernor({
    budgets: vector({ memoryBytes: 10 }),
    diagnostics(event) {
      if (event.type === 'resource-replaced' && !chainedReplacement) {
        chainedReplacement = governor.replaceReservationAtomically({
          oldReservationId: event.reservationId,
          nextRequest: request(vector({ memoryBytes: 5 }), { ownerKey: 'service' })
        });
        chainedReplacement.catch(() => {});
      }
    }
  });
  const old = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 6 }), {
    ownerKey: 'service'
  }));
  const replacement = await governor.replaceReservationAtomically({
    oldReservationId: old.leaseId,
    nextRequest: request(vector({ memoryBytes: 4 }), { ownerKey: 'service' })
  });

  await assert.rejects(
    chainedReplacement,
    (error) => error.code === 'RESOURCE_PARENT_DELIVERY_PENDING'
  );
  assert.equal(replacement.state, 'granted');
  assert.deepEqual(governor.snapshot().activeUsage, vector({ memoryBytes: 4 }));
  assert.equal(governor.snapshot().activeDependencyCount, 0);
  assert.equal(replacement.release('normal-release'), true);
  assert.deepEqual(governor.snapshot().activeUsage, vector());
});

test('timer-unsafe and unsafe-deadline requests never leak compound or replacement parents', async () => {
  const governor = createGovernor({ budgets: vector({ memoryBytes: 10 }) });
  const base = await governor.acquireBaseLease(request(vector({ memoryBytes: 1 }), {
    ownerKey: 'service'
  }));
  const persistent = await governor.acquirePersistentReservation(request(vector({ memoryBytes: 2 }), {
    ownerKey: 'state'
  }));

  for (const timeoutMs of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(governor.acquireCompoundLease({
      ownerKey: 'service',
      actionKey: 'action',
      operationKey: 'operation',
      base: vector({ memoryBytes: 1 }),
      phase: vector(),
      childResource: vector(),
      childrenMax: 0,
      effectiveChildCount: 0,
      existingBaseLeaseId: base.leaseId,
      timeoutMs
    }), (error) => error.code === 'RESOURCE_TIMEOUT_INVALID');
    await assert.rejects(governor.acquirePersistentReservation(request(vector({ memoryBytes: 3 }), {
      ownerKey: 'state',
      replacesReservationId: persistent.leaseId,
      timeoutMs
    })), (error) => error.code === 'RESOURCE_TIMEOUT_INVALID');
  }
  assert.equal(governor.snapshot().activeDependencyCount, 0);
  assert.equal(base.release('test-end'), true);
  assert.equal(persistent.release('test-end'), true);

  const overflowGovernor = createGovernor({
    budgets: vector({ memoryBytes: 1 }),
    now: () => Number.MAX_SAFE_INTEGER - 1
  });
  const overflowBase = await overflowGovernor.acquireBaseLease(request(vector({ memoryBytes: 1 }), {
    ownerKey: 'overflow-service'
  }));
  const overflowRequest = overflowGovernor.acquireCompoundLease({
    ownerKey: 'overflow-service',
    actionKey: 'action',
    operationKey: 'operation',
    base: vector({ memoryBytes: 1 }),
    phase: vector({ memoryBytes: 1 }),
    childResource: vector(),
    childrenMax: 0,
    effectiveChildCount: 0,
    existingBaseLeaseId: overflowBase.leaseId,
    timeoutMs: 2
  });
  await assert.rejects(overflowRequest, (error) => error.code === 'ADMISSION_DURATION_INVALID');
  assert.equal(overflowGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(overflowBase.release('test-end'), true);

  const replacementOverflowGovernor = createGovernor({
    budgets: vector({ memoryBytes: 1 }),
    now: () => Number.MAX_SAFE_INTEGER - 1
  });
  const replacementParent = await replacementOverflowGovernor.acquirePersistentReservation(
    request(vector({ memoryBytes: 1 }), { ownerKey: 'overflow-state' })
  );
  const replacementOverflow = replacementOverflowGovernor.acquirePersistentReservation(
    request(vector({ memoryBytes: 2 }), {
      ownerKey: 'overflow-state',
      replacesReservationId: replacementParent.leaseId,
      timeoutMs: 2
    })
  );
  await assert.rejects(replacementOverflow, (error) => error.code === 'ADMISSION_DURATION_INVALID');
  assert.equal(replacementOverflowGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(replacementParent.release('test-end'), true);
});

test('package-private deferred parent release completes after the last dependency', async () => {
  const governor = createGovernor();
  const base = await governor.acquireBaseLease(request(vector({ memoryBytes: 1 }), {
    ownerKey: 'service'
  }));
  const compound = await governor.acquireCompoundLease({
    ownerKey: 'service',
    actionKey: 'job',
    operationKey: 'operation',
    base: vector({ memoryBytes: 1 }),
    phase: vector({ memoryBytes: 1 }),
    childResource: vector(),
    childrenMax: 0,
    effectiveChildCount: 0,
    existingBaseLeaseId: base.leaseId
  });

  assert.equal(releaseResourceWhenUnreferenced(governor, base.leaseId, 'service-close'), false);
  assert.equal(base.state, 'granted');
  assert.equal(compound.release('job-terminal'), true);
  assert.equal(base.state, 'released');
  assert.deepEqual(governor.snapshot().activeUsage, vector());
  assert.equal(governor.snapshot().activeDependencyCount, 0);
});
