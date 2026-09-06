'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createResourceGovernor } = require(
  '../../../../src/main-process/background-execution/resource-governor'
);
const {
  ServiceHostProtocolError,
  createServiceHost
} = require('../../../../src/main-process/background-execution/service-host');
const {
  createJobEnvelope
} = require('../../../../src/main-process/background-execution/protocol');
const {
  validateProtocolSequence
} = require('../../../../src/main-process/background-execution/protocol-sequence-validator');

const fixture = require(path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
));

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

function createFakeClock() {
  let timestamp = 0;
  let timerId = 0;
  const timers = new Map();
  return {
    now: () => timestamp,
    setTimer(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, at: timestamp + delay });
      return timerId;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      timestamp += milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= timestamp)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
      }
    },
    elapse(milliseconds) {
      timestamp += milliseconds;
    },
    get timerCount() { return timers.size; }
  };
}

function createPolicyRegistry(policies = fixture.actions) {
  return Object.freeze({
    assertRunnable(actionKey) {
      const policy = policies[actionKey];
      if (!policy) throw new Error(`Unknown policy: ${actionKey}`);
      return policy;
    },
    get(actionKey) {
      return policies[actionKey];
    },
    getBinding() {
      return 'service-worker.js';
    },
    list() {
      return Object.freeze(Object.values(policies));
    }
  });
}

function createZeroDetachPolicyRegistry() {
  const policies = structuredClone(fixture.actions);
  policies['statement:import'].cancellation.terminateTimeoutMs = 0;
  return createPolicyRegistry(policies);
}

function createFakeAdapter(options = {}) {
  const starts = [];
  const sent = [];
  const received = [];
  const trace = [];
  let terminateCount = 0;
  let closeCount = 0;
  let eventSeq = 0;
  let activeOptions = null;

  function eventFrom(command, operation, fields = {}) {
    eventSeq += 1;
    return {
      protocolVersion: 1,
      channel: 'service-control',
      direction: 'event',
      operation,
      serviceKey: command.serviceKey,
      controlId: fields.controlId || `event-${eventSeq}`,
      workerInstanceId: command.workerInstanceId,
      serviceGeneration: fields.serviceGeneration || command.serviceGeneration,
      seq: eventSeq,
      jobRef: fields.jobRef === undefined ? null : fields.jobRef,
      payload: fields.payload || {}
    };
  }

  const adapter = Object.freeze({
    kind: 'fake-worker-thread',
    start(startOptions) {
      starts.push(startOptions);
      const routedOptions = {
        ...startOptions,
        onMessage(message) {
          received.push(message);
          trace.push(message);
          return startOptions.onMessage(message);
        }
      };
      activeOptions = routedOptions;
      eventSeq = 0;
      if (options.syncError) startOptions.onError(options.syncError);
      if (options.syncExit) startOptions.onExit(options.syncExit.code, options.syncExit.signal || null);
      const handle = Object.freeze({
        ready: options.rawReady || Promise.resolve(),
        send(message) {
          sent.push(message);
          trace.push(message);
          if (message.operation === options.sendErrorOperation) {
            throw new Error(`send failed: ${message.operation}`);
          }
          if (message.operation === 'executor:init' && options.autoReady !== false) {
            queueMicrotask(() => routedOptions.onMessage(eventFrom(message, 'executor:ready', {
              payload: { contractVersion: 1, capabilities: ['resource-control-v1'] }
            })));
          }
          if (message.operation === 'executor:close' && options.autoCloseAck !== false) {
            queueMicrotask(() => routedOptions.onMessage(eventFrom(message, 'executor:close-ack', {
              controlId: message.controlId
            })));
          }
          if (typeof options.onSend === 'function') options.onSend(message, routedOptions, eventFrom);
        },
        close() { closeCount += 1; },
        async terminate() { terminateCount += 1; },
        worker: Object.freeze({ fake: true })
      });
      return handle;
    }
  });

  return {
    adapter,
    starts,
    sent,
    received,
    trace,
    emit(message) {
      activeOptions.onMessage(message);
    },
    error(error) {
      activeOptions.onError(error);
    },
    exit(code = 1, signal = null) {
      activeOptions.onExit(code, signal);
    },
    event(operation, fields = {}) {
      const init = sent.find((message) => message.operation === 'executor:init');
      return eventFrom(init, operation, fields);
    },
    get terminateCount() { return terminateCount; },
    get closeCount() { return closeCount; }
  };
}

function createHarness(options = {}) {
  let id = 0;
  const order = [];
  const diagnosticEvents = [];
  const baseGovernor = createResourceGovernor({
    budgets: vector({
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 2,
      ioHeavySlots: 8,
      memoryBytes: 1024 * 1024 * 1024
    }),
    idFactory: (prefix) => {
      order.push(`governor:${prefix}`);
      return `governor-${prefix}-${++id}`;
    },
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    diagnostics: options.governorDiagnostics
  });
  const governor = typeof options.wrapGovernor === 'function'
    ? options.wrapGovernor(baseGovernor)
    : baseGovernor;
  const fake = createFakeAdapter(options.adapterOptions);
  const originalStart = fake.adapter.start;
  const adapter = Object.freeze({
    kind: fake.adapter.kind,
    start(startOptions) {
      order.push('adapter:start');
      return originalStart(startOptions);
    }
  });
  const host = createServiceHost({
    policyRegistry: options.policyRegistry || createPolicyRegistry(),
    resourceGovernor: governor,
    workerThreadAdapter: adapter,
    idFactory: options.hostIdFactory || ((prefix) => `host-${prefix}-${++id}`),
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    diagnostics: (event) => diagnosticEvents.push(event)
  });
  return { host, governor, fake, order, diagnosticEvents };
}

async function openStatementJob(harness, overrides = {}) {
  const events = [];
  const errors = [];
  const transport = await harness.host.openJob({
    actionKey: 'statement:import',
    operationKey: 'task-1/statement:import/1',
    jobId: 'job-1',
    onMessage: (message) => events.push(message),
    onError: (error) => errors.push(error),
    ...overrides
  });
  return { transport, events, errors };
}

function jobRef(overrides = {}) {
  return {
    actionKey: 'statement:import',
    operationKey: 'task-1/statement:import/1',
    jobId: 'job-1',
    unitId: null,
    ...overrides
  };
}

function jobEvent(transport, operation, seq, payload, overrides = {}) {
  const reference = jobRef(overrides);
  return createJobEnvelope({
    direction: 'event',
    operation,
    actionKey: reference.actionKey,
    operationKey: reference.operationKey,
    jobId: reference.jobId,
    workerInstanceId: transport.workerInstanceId,
    serviceGeneration: transport.serviceGeneration,
    unitId: null,
    seq,
    context: {
      kind: 'operation',
      value: {
        taskRunId: `task-run:${reference.jobId}`,
        taskKey: reference.actionKey,
        moduleId: 'statement',
        parentRunId: `parent-run:${reference.jobId}`,
        operationKey: reference.operationKey
      }
    },
    payload
  }, { validate: false });
}

function owner(kind, ownerKeyHash, candidateRevision = 1) {
  return { kind, ownerKeyHash, candidateRevision };
}

async function adoptServiceResource(harness, options = {}) {
  const requestId = options.requestId || 'adopted-resource-request';
  const requestKind = options.requestKind || 'pending-interaction-create';
  const requestOwner = options.requestOwner || owner('interaction-token', requestId);
  const currentJobRef = options.currentJobRef || jobRef();
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: `${requestId}-control`,
    jobRef: currentJobRef,
    payload: {
      requestId,
      requestKind,
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const grant = harness.fake.sent.find((message) =>
    message.operation === 'resource:grant' && message.payload.requestId === requestId);
  assert.ok(grant);
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: `${requestId}-adopt-control`,
    jobRef: currentJobRef,
    payload: {
      requestId,
      grantId: grant.payload.grantId,
      reservationId: grant.payload.reservationId,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  return grant;
}

test('ServiceHost acquires BaseLease before adapter start and completes init/ready', async () => {
  const harness = createHarness();
  const { transport } = await openStatementJob(harness);

  assert.ok(harness.order.indexOf('governor:lease') < harness.order.indexOf('adapter:start'));
  assert.equal(transport.serviceKey, 'service.statement');
  assert.equal(transport.serviceGeneration, 1);
  assert.equal(Object.hasOwn(transport, 'createdGeneration'), false);
  assert.equal(harness.fake.sent[0].operation, 'executor:init');
  assert.equal(harness.fake.sent[0].payload.baseLeaseId, transport.baseLeaseId);
  assert.equal(harness.host.snapshot().services[0].state, 'ready');
});

test('normal job close only detaches while fatal terminate closes generation and releases base exactly once', async () => {
  const harness = createHarness();
  const first = await openStatementJob(harness);
  await first.transport.close();
  assert.equal(harness.host.snapshot().services.length, 1);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);

  const second = await openStatementJob(harness, {
    actionKey: 'statement:generate-current',
    operationKey: 'task-2/statement:generate-current/1',
    jobId: 'job-2'
  });
  await second.transport.terminate();
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.fake.terminateCount, 1);
  await second.transport.terminate();
  assert.equal(harness.fake.terminateCount, 1);
});

test('successful job:done retains an adopt-acked interaction token across detach until stable-owner release', async () => {
  const harness = createHarness();
  const { transport } = await openStatementJob(harness);
  const grant = await adoptServiceResource(harness, {
    requestId: 'published-token-request',
    requestOwner: owner('interaction-token', 'published-token-owner')
  });

  harness.fake.emit(jobEvent(transport, 'job:done', 1, {
    result: { status: 'interaction-required', token: 'opaque-token' }
  }));
  assert.equal(await transport.close(), true);
  assert.equal(harness.host.snapshot().services[0].activeJobIds.length, 0);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 2);
  assert.equal(
    harness.governor.snapshot().activeUsage.memoryBytes,
    transport.baseResources.memoryBytes + 1
  );
  assert.equal(harness.fake.sent.some((message) => message.operation === 'resource:revoke'), false);

  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: 'published-token-release',
    jobRef: jobRef(),
    payload: { reservationId: grant.payload.reservationId, reason: 'token-consumed' }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const ack = harness.fake.sent.find((message) =>
    message.operation === 'resource:release-ack' &&
    message.payload.reservationId === grant.payload.reservationId);
  assert.ok(ack);
  assert.deepEqual(ack.jobRef, jobRef());
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);

  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
});

test('published interaction tokens are drained by cooperative close and fatal crash after detach', async () => {
  for (const lifecycle of ['cooperative-close', 'raw-exit']) {
    const harness = createHarness({
      adapterOptions: lifecycle === 'cooperative-close'
        ? {
            onSend(message, startOptions, eventFrom) {
              if (message.operation !== 'resource:revoke') return;
              startOptions.onMessage(eventFrom(message, 'resource:release', {
                controlId: message.controlId,
                jobRef: message.jobRef,
                payload: {
                  reservationId: message.payload.reservationId,
                  reason: 'service-close'
                }
              }));
            }
          }
        : {}
    });
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    await adoptServiceResource(harness, {
      requestId: `${lifecycle}-published-token-request`,
      requestOwner: owner('interaction-token', `${lifecycle}-published-token-owner`),
      currentJobRef: jobRef({
        operationKey: `task-${lifecycle}/statement:import/1`,
        jobId: `job-${lifecycle}`
      })
    });
    harness.fake.emit(jobEvent(transport, 'job:done', 1, {
      result: { status: 'interaction-required', token: `${lifecycle}-token` }
    }, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    }));
    assert.equal(await transport.close(), true, lifecycle);
    assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1, lifecycle);

    if (lifecycle === 'cooperative-close') {
      assert.equal(
        await harness.host.closeService('service.statement', { timeoutMs: 50 }),
        true,
        lifecycle
      );
    } else {
      harness.fake.exit(29, null);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(harness.host.snapshot().services.length, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0, lifecycle);
    assert.deepEqual(harness.governor.snapshot().activeUsage, vector(), lifecycle);
  }
});

test('interaction adopted after job:done remains unpublished and is revoked on detach', async () => {
  const harness = createHarness({
    adapterOptions: {
      onSend(message, startOptions, eventFrom) {
        if (message.operation !== 'resource:revoke') return;
        startOptions.onMessage(eventFrom(message, 'resource:release', {
          controlId: message.controlId,
          jobRef: message.jobRef,
          payload: { reservationId: message.payload.reservationId, reason: 'job-failed' }
        }));
      }
    }
  });
  const { transport } = await openStatementJob(harness);
  const requestOwner = owner('interaction-token', 'late-unpublished-token');
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'late-unpublished-request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'late-unpublished-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const grant = harness.fake.sent.find((message) =>
    message.operation === 'resource:grant' &&
    message.payload.requestId === 'late-unpublished-request');
  assert.ok(grant);

  harness.fake.emit(jobEvent(transport, 'job:done', 1, {
    result: { status: 'completed-without-token' }
  }));
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'late-unpublished-adopt-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'late-unpublished-request',
      grantId: grant.payload.grantId,
      reservationId: grant.payload.reservationId,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await transport.close(), true);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);
  assert.equal(harness.fake.sent.some((message) =>
    message.operation === 'resource:revoke' &&
    message.payload.reservationId === grant.payload.reservationId), true);
  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('job:error and cancelled job paths revoke adopt-acked interaction tokens instead of retaining them', async () => {
  for (const terminal of ['job-error', 'cancel']) {
    const harness = createHarness({
      adapterOptions: {
        onSend(message, startOptions, eventFrom) {
          if (message.operation !== 'resource:revoke') return;
          startOptions.onMessage(eventFrom(message, 'resource:release', {
            controlId: message.controlId,
            jobRef: message.jobRef,
            payload: { reservationId: message.payload.reservationId, reason: 'job-failed' }
          }));
        }
      }
    });
    const { transport } = await openStatementJob(harness);
    const grant = await adoptServiceResource(harness, {
      requestId: `${terminal}-token-request`,
      requestOwner: owner('interaction-token', `${terminal}-token-owner`)
    });
    if (terminal === 'cancel') {
      transport.send(createJobEnvelope({
        direction: 'command',
        operation: 'job:cancel',
        actionKey: jobRef().actionKey,
        operationKey: jobRef().operationKey,
        jobId: jobRef().jobId,
        workerInstanceId: transport.workerInstanceId,
        serviceGeneration: transport.serviceGeneration,
        unitId: null,
        seq: 1,
        context: jobEvent(transport, 'job:error', 1, {
          error: { code: 'CANCELLED', message: 'cancelled', stage: 'cancel', detailLines: [] }
        }).context,
        payload: { cancel: { reason: 'user-requested' } }
      }, { validate: false }));
    }
    harness.fake.emit(jobEvent(transport, 'job:error', 1, {
      error: {
        code: terminal === 'cancel' ? 'CANCELLED' : 'EXECUTION_FAILED',
        message: terminal,
        stage: 'execute',
        detailLines: []
      }
    }));

    assert.equal(await transport.close(), true, terminal);
    assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 0, terminal);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 1, terminal);
    assert.equal(harness.fake.sent.some((message) =>
      message.operation === 'resource:revoke' &&
      message.payload.reservationId === grant.payload.reservationId), true, terminal);
    assert.equal(await harness.host.closeService('service.statement'), true, terminal);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0, terminal);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0, terminal);
  }
});

test('zero terminate timeout fast-detaches only empty, persistent-only, or published-token jobs', async () => {
  for (const scenario of ['empty', 'persistent', 'published-token']) {
    const clock = createFakeClock();
    const harness = createHarness({
      ...clock,
      policyRegistry: createZeroDetachPolicyRegistry()
    });
    const { transport } = await openStatementJob(harness);
    let retainedGrant = null;
    if (scenario === 'persistent') {
      retainedGrant = await adoptServiceResource(harness, {
        requestId: 'zero-persistent-request',
        requestKind: 'persistent-state-replace',
        requestOwner: owner('service-state', 'zero-persistent-owner')
      });
    } else if (scenario === 'published-token') {
      retainedGrant = await adoptServiceResource(harness, {
        requestId: 'zero-published-token-request',
        requestOwner: owner('interaction-token', 'zero-published-token-owner')
      });
      harness.fake.emit(jobEvent(transport, 'job:done', 1, {
        result: { status: 'interaction-required', token: 'zero-token' }
      }));
    }

    assert.equal(await transport.close(), true, scenario);
    assert.equal(harness.host.snapshot().services[0].activeJobIds.length, 0, scenario);
    assert.equal(
      harness.host.snapshot().services[0].adoptedReservationCount,
      retainedGrant ? 1 : 0,
      scenario
    );
    assert.equal(clock.timerCount, 0, scenario);

    if (retainedGrant) {
      harness.fake.emit(harness.fake.event('resource:release', {
        controlId: `zero-release-${scenario}`,
        jobRef: null,
        payload: {
          reservationId: retainedGrant.payload.reservationId,
          reason: scenario === 'persistent' ? 'service-close' : 'token-expired'
        }
      }));
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await harness.host.closeService('service.statement'), true, scenario);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0, scenario);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0, scenario);
    assert.equal(clock.timerCount, 0, scenario);
  }
});

test('zero terminate timeout fails closed when pending admission or adopted phase needs cleanup', async () => {
  {
    const harness = createHarness({ policyRegistry: createZeroDetachPolicyRegistry() });
    const { transport } = await openStatementJob(harness);
    await adoptServiceResource(harness, {
      requestId: 'zero-phase-request',
      requestKind: 'phase-extension',
      requestOwner: owner('phase', 'zero-phase-owner')
    });
    await assert.rejects(
      transport.close(),
      (error) => error.code === 'SERVICE_JOB_DETACH_TIMEOUT'
    );
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.diagnosticEvents.some((event) =>
      event.type === 'service-job-detach-error' && event.graceful === false), true);
  }

  {
    const harness = createHarness({ policyRegistry: createZeroDetachPolicyRegistry() });
    const { transport } = await openStatementJob(harness);
    const blocker = await harness.governor.acquirePhaseLease({
      ownerKey: 'zero-pending-blocker',
      actionKey: 'statement:import',
      operationKey: 'zero-pending-blocker-operation',
      resources: vector({ memoryBytes: (1024 * 1024 * 1024) - 67108864 })
    });
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: 'zero-pending-request-control',
      jobRef: jobRef(),
      payload: {
        requestId: 'zero-pending-request',
        requestKind: 'pending-interaction-create',
        requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: null,
        owner: owner('interaction-token', 'zero-pending-owner')
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.host.snapshot().services[0].pendingRequestCount, 1);
    await assert.rejects(
      transport.close(),
      (error) => error.code === 'SERVICE_JOB_DETACH_TIMEOUT'
    );
    blocker.release('zero-pending-test-complete');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  }
});

test('resource grant/adopt/release uses independent direction sequences and exact identities', async () => {
  const harness = createHarness();
  await openStatementJob(harness);
  const requestMessage = harness.fake.event('resource:request', {
    controlId: 'request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'request-1',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1024, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'token-1')
    }
  });
  harness.fake.emit(requestMessage);
  await new Promise((resolve) => setImmediate(resolve));
  const grant = harness.fake.sent.at(-1);
  assert.equal(grant.operation, 'resource:grant');
  assert.equal(grant.seq, 2);
  assert.equal(grant.controlId, 'request-control');

  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'adopt-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'request-1',
      grantId: grant.payload.grantId,
      reservationId: grant.payload.reservationId,
      owner: owner('interaction-token', 'token-1')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const ack = harness.fake.sent.at(-1);
  assert.equal(ack.operation, 'resource:adopt-ack');
  assert.equal(ack.seq, 3);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);

  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: 'release-control',
    jobRef: null,
    payload: { reservationId: grant.payload.reservationId, reason: 'token-consumed' }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const releaseAck = harness.fake.sent.at(-1);
  assert.equal(releaseAck.operation, 'resource:release-ack');
  assert.equal(releaseAck.seq, 4);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);
});

test('persistent replacement keeps old state until adopted then atomically switches accounting', async () => {
  const harness = createHarness();
  await openStatementJob(harness);

  async function requestAndAdopt(requestId, revision, memoryBytes, replacesReservationId) {
    const requestOwner = owner('service-state', 'state-1', revision);
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `request-${requestId}`,
      jobRef: jobRef(),
      payload: {
        requestId,
        requestKind: 'persistent-state-replace',
        requested: { memoryBytes, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId,
        owner: requestOwner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const grant = harness.fake.sent.at(-1);
    harness.fake.emit(harness.fake.event('resource:adopted', {
      controlId: `adopt-${requestId}`,
      jobRef: jobRef(),
      payload: {
        requestId,
        grantId: grant.payload.grantId,
        reservationId: grant.payload.reservationId,
        owner: requestOwner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    return grant.payload.reservationId;
  }

  const firstId = await requestAndAdopt('request-1', 1, 1000, null);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'request-2',
    jobRef: jobRef(),
    payload: {
      requestId: 'request-2',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 1500, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: firstId,
      owner: owner('service-state', 'state-1', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const secondGrant = harness.fake.sent.at(-1);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 1);

  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'adopt-2',
    jobRef: jobRef(),
    payload: {
      requestId: 'request-2',
      grantId: secondGrant.payload.grantId,
      reservationId: secondGrant.payload.reservationId,
      owner: owner('service-state', 'state-1', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);
  assert.equal(harness.governor.snapshot().activeUsage.memoryBytes, 67108864 + 1500);
});

test('published pending-interaction is replaced atomically from a later job without old release', async () => {
  const harness = createHarness();
  const first = await openStatementJob(harness);
  const tokenOwner = owner('interaction-token', 'statement-token-slot', 1);
  const initial = await adoptServiceResource(harness, {
    requestId: 'pending-token-initial',
    requestOwner: tokenOwner
  });
  harness.fake.emit(jobEvent(first.transport, 'job:done', 1, {
    result: { status: 'interaction-required', token: 'opaque-token-1' }
  }));
  assert.equal(await first.transport.close(), true);

  const secondRef = jobRef({
    actionKey: 'statement:resolve-big-account',
    operationKey: 'task-1/statement:resolve-big-account/2',
    jobId: 'job-2'
  });
  const second = await openStatementJob(harness, secondRef);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'pending-token-replacement-control',
    jobRef: secondRef,
    payload: {
      requestId: 'pending-token-replacement',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 2, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: initial.payload.reservationId,
      owner: owner('interaction-token', 'statement-token-slot', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const replacementGrant = harness.fake.sent.find((message) =>
    message.operation === 'resource:grant' &&
    message.payload.requestId === 'pending-token-replacement');
  assert.ok(replacementGrant);
  assert.equal(replacementGrant.payload.replacesReservationId, initial.payload.reservationId);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 1);
  assert.equal(harness.fake.sent.some((message) =>
    message.operation === 'resource:release' &&
    message.payload.reservationId === initial.payload.reservationId), false);

  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'pending-token-replacement-adopt',
    jobRef: secondRef,
    payload: {
      requestId: 'pending-token-replacement',
      grantId: replacementGrant.payload.grantId,
      reservationId: replacementGrant.payload.reservationId,
      owner: owner('interaction-token', 'statement-token-slot', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const replacementAck = harness.fake.sent.find((message) =>
    message.operation === 'resource:adopt-ack' &&
    message.payload.reservationId === replacementGrant.payload.reservationId);
  assert.ok(replacementAck);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);
  assert.equal(harness.governor.snapshot().activeLeases.some((lease) =>
    lease.leaseId === initial.payload.reservationId), false);
  assert.equal(harness.governor.snapshot().activeLeases.some((lease) =>
    lease.leaseId === replacementGrant.payload.reservationId), true);
  assert.equal(harness.fake.sent.some((message) =>
    message.operation === 'resource:release' &&
    message.payload.reservationId === initial.payload.reservationId), false);

  await second.transport.terminate();
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('adoption timeout revokes the tentative grant and returns usage to service baseline', async () => {
  const clock = createFakeClock();
  const harness = createHarness(clock);
  await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'request-timeout',
    jobRef: jobRef(),
    payload: {
      requestId: 'request-timeout',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1024, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'token-timeout')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 1);

  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  const revoke = harness.fake.sent.at(-1);
  assert.equal(revoke.operation, 'resource:revoke');
  assert.equal(revoke.payload.reasonCode, 'adoption-timeout');
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);
  assert.equal(harness.governor.snapshot().activeUsage.memoryBytes, 67108864);
});

test('normal job detach rejects its queued request before route deletion and cooperative close', async () => {
  const clock = createFakeClock();
  const harness = createHarness(clock);
  const { transport } = await openStatementJob(harness);
  const blocker = await harness.governor.acquirePhaseLease({
    ownerKey: 'blocker',
    actionKey: 'statement:import',
    operationKey: 'blocker-operation',
    resources: vector({ memoryBytes: (1024 * 1024 * 1024) - 67108864 })
  });
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'queued-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'queued-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'queued-token')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].pendingRequestCount, 1);

  assert.equal(await transport.close(), true);
  const rejection = harness.fake.sent.find((message) =>
    message.operation === 'resource:reject' && message.controlId === 'queued-request');
  assert.ok(rejection);
  assert.equal(rejection.payload.requestId, 'queued-request');
  assert.equal(harness.host.snapshot().services[0].activeJobIds.length, 0);
  assert.equal(harness.host.snapshot().services[0].pendingRequestCount, 0);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);

  blocker.release('capacity-returned');
  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.deepEqual(harness.fake.trace.map((message) => message.operation), [
    'executor:init',
    'executor:ready',
    'resource:request',
    'resource:reject',
    'executor:close',
    'executor:close-ack'
  ]);
  const validation = validateProtocolSequence(harness.fake.trace, { policyRegistry: fixture });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.deepEqual(harness.governor.snapshot().activeUsage, vector());
  assert.equal(clock.timerCount, 0);
});

test('normal job detach revokes a tentative grant before route deletion and cooperative close', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: {
      onSend(message, startOptions, eventFrom) {
        if (message.operation !== 'resource:revoke') return;
        startOptions.onMessage(eventFrom(message, 'resource:release', {
          controlId: message.controlId,
          jobRef: message.jobRef,
          payload: { reservationId: message.payload.reservationId, reason: 'job-failed' }
        }));
      }
    }
  });
  const { transport } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'tentative-detach-request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'tentative-detach-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'tentative-detach-owner')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 1);

  assert.equal(await transport.close(), true);
  assert.equal(harness.host.snapshot().services[0].activeJobIds.length, 0);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);
  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.deepEqual(harness.fake.trace.map((message) => message.operation), [
    'executor:init',
    'executor:ready',
    'resource:request',
    'resource:grant',
    'resource:revoke',
    'resource:release',
    'resource:release-ack',
    'executor:close',
    'executor:close-ack'
  ]);
  const validation = validateProtocolSequence(harness.fake.trace, { policyRegistry: fixture });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.deepEqual(harness.governor.snapshot().activeUsage, vector());
  assert.equal(clock.timerCount, 0);
});

test('normal job detach revokes an adopted phase before route deletion and cooperative close', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: {
      onSend(message, startOptions, eventFrom) {
        if (message.operation !== 'resource:revoke') return;
        startOptions.onMessage(eventFrom(message, 'resource:release', {
          controlId: message.controlId,
          jobRef: message.jobRef,
          payload: { reservationId: message.payload.reservationId, reason: 'phase-complete' }
        }));
      }
    }
  });
  const { transport } = await openStatementJob(harness);
  await adoptServiceResource(harness, {
    requestId: 'adopted-phase-detach-request',
    requestKind: 'phase-extension',
    requestOwner: owner('phase', 'adopted-phase-detach-owner')
  });
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);

  assert.equal(await transport.close(), true);
  assert.equal(harness.host.snapshot().services[0].activeJobIds.length, 0);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 0);
  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.deepEqual(harness.fake.trace.map((message) => message.operation), [
    'executor:init',
    'executor:ready',
    'resource:request',
    'resource:grant',
    'resource:adopted',
    'resource:adopt-ack',
    'resource:revoke',
    'resource:release',
    'resource:release-ack',
    'executor:close',
    'executor:close-ack'
  ]);
  const validation = validateProtocolSequence(harness.fake.trace, { policyRegistry: fixture });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.deepEqual(harness.governor.snapshot().activeUsage, vector());
  assert.equal(clock.timerCount, 0);
});

test('late admission grant during detach is rejected on the original exchange and released', async () => {
  let deliverLease;
  let admissionSignal;
  const harness = createHarness({
    wrapGovernor(base) {
      return Object.freeze({
        ...base,
        acquirePendingInteractionReservation(request) {
          admissionSignal = request.signal;
          const lease = base.acquirePendingInteractionReservation({ ...request, signal: undefined });
          return new Promise((resolve) => {
            deliverLease = async () => resolve(await lease);
          });
        }
      });
    }
  });
  const { transport } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'late-detach-request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'late-detach-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'late-detach-owner')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const detaching = transport.close();
  assert.equal(admissionSignal.aborted, true);
  let detachSettled = false;
  detaching.finally(() => { detachSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detachSettled, false);

  await deliverLease();
  assert.equal(await detaching, true);
  assert.equal(harness.fake.sent.some((message) => message.operation === 'resource:grant'), false);
  const rejection = harness.fake.sent.find((message) =>
    message.operation === 'resource:reject' &&
    message.controlId === 'late-detach-request-control');
  assert.ok(rejection);
  assert.equal(rejection.payload.requestId, 'late-detach-request');
  assert.equal(rejection.payload.reasonCode, 'SERVICE_JOB_DETACHING');
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);

  assert.equal(await harness.host.closeService('service.statement'), true);
  const validation = validateProtocolSequence(harness.fake.trace, { policyRegistry: fixture });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
});

test('job detach revoke timeout closes non-gracefully without executor close or resource leaks', async () => {
  const clock = createFakeClock();
  const harness = createHarness(clock);
  const { transport } = await openStatementJob(harness);
  await adoptServiceResource(harness, {
    requestId: 'detach-timeout-phase',
    requestKind: 'phase-extension',
    requestOwner: owner('phase', 'detach-timeout-phase')
  });

  const detaching = transport.close();
  const rejection = assert.rejects(detaching, (error) =>
    error.code === 'SERVICE_JOB_DETACH_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.some((message) => message.operation === 'resource:revoke'), true);
  assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);
  clock.advance(5000);
  await rejection;

  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.equal(clock.timerCount, 0);
  assert.equal(harness.diagnosticEvents.some((event) =>
    event.type === 'service-job-detach-error' && event.graceful === false), true);
  assert.equal(harness.diagnosticEvents.some((event) =>
    event.type === 'service-generation-closed' && event.graceful === false), true);
});

test('job detach revoke send throw or synchronous raw crash is bounded and non-graceful', async () => {
  for (const lifecycle of ['send-throw', 'raw-crash']) {
    const harness = createHarness({
      adapterOptions: lifecycle === 'send-throw'
        ? { sendErrorOperation: 'resource:revoke' }
        : {
            onSend(message, startOptions) {
              if (message.operation === 'resource:revoke') startOptions.onExit(19, null);
            }
          }
    });
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-detach-${lifecycle}/statement:import/1`,
      jobId: `job-detach-${lifecycle}`
    });
    await adoptServiceResource(harness, {
      requestId: `detach-${lifecycle}-phase`,
      requestKind: 'phase-extension',
      requestOwner: owner('phase', `detach-${lifecycle}-phase`),
      currentJobRef: jobRef({
        operationKey: `task-detach-${lifecycle}/statement:import/1`,
        jobId: `job-detach-${lifecycle}`
      })
    });

    await assert.rejects(transport.close());
    assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
    assert.equal(harness.fake.closeCount, 1);
    assert.equal(harness.fake.terminateCount, 1);
    assert.equal(harness.diagnosticEvents.some((event) =>
      event.type === 'service-job-detach-error' && event.graceful === false), true);
    assert.equal(harness.diagnosticEvents.some((event) =>
      event.type === 'service-generation-closed' && event.graceful === false), true);
  }
});

test('stale replacement is a fatal protocol error and crash cleanup releases the generation', async () => {
  const harness = createHarness();
  const { errors } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'bad-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'bad-request',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: 'not-current',
      owner: owner('service-state', 'state-1')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors[0].code, 'SERVICE_REPLACEMENT_STALE');
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('cooperative close waits for close-ack then releases all service resources', async () => {
  const harness = createHarness();
  const { transport } = await openStatementJob(harness);
  await transport.close();
  assert.equal(await harness.host.closeService('service.statement'), true);
  assert.equal(harness.fake.sent.at(-1).operation, 'executor:close');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('cooperative close wire-drains persistent and interaction reservations before executor close', async () => {
  const cases = [
    {
      requestKind: 'persistent-state-replace',
      owner: owner('service-state', 'graceful-state-owner')
    },
    {
      requestKind: 'pending-interaction-create',
      owner: owner('interaction-token', 'graceful-token-owner')
    }
  ];
  for (const [index, item] of cases.entries()) {
    const harness = createHarness({
      adapterOptions: {
        onSend(message, startOptions, eventFrom) {
          if (message.operation !== 'resource:revoke') return;
          startOptions.onMessage(eventFrom(message, 'resource:release', {
            controlId: message.controlId,
            jobRef: message.jobRef,
            payload: {
              reservationId: message.payload.reservationId,
              reason: 'service-close'
            }
          }));
        }
      }
    });
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-graceful-${index}/statement:import/1`,
      jobId: `job-graceful-${index}`
    });
    const currentJobRef = jobRef({
      operationKey: `task-graceful-${index}/statement:import/1`,
      jobId: `job-graceful-${index}`
    });
    const requestId = `graceful-request-${index}`;
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `graceful-request-control-${index}`,
      jobRef: currentJobRef,
      payload: {
        requestId,
        requestKind: item.requestKind,
        requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: null,
        owner: item.owner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const grant = harness.fake.sent.find((message) =>
      message.operation === 'resource:grant' && message.payload.requestId === requestId);
    harness.fake.emit(harness.fake.event('resource:adopted', {
      controlId: `graceful-adopt-control-${index}`,
      jobRef: currentJobRef,
      payload: {
        requestId,
        grantId: grant.payload.grantId,
        reservationId: grant.payload.reservationId,
        owner: item.owner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await transport.close();
    assert.equal(
      harness.host.snapshot().services[0].adoptedReservationCount,
      item.requestKind === 'persistent-state-replace' ? 1 : 0
    );

    assert.equal(await harness.host.closeService('service.statement', { timeoutMs: 50 }), true);
    assert.deepEqual(harness.fake.trace.map((message) => message.operation), [
      'executor:init',
      'executor:ready',
      'resource:request',
      'resource:grant',
      'resource:adopted',
      'resource:adopt-ack',
      'resource:revoke',
      'resource:release',
      'resource:release-ack',
      'executor:close',
      'executor:close-ack'
    ]);
    const validation = validateProtocolSequence(harness.fake.trace, {
      policyRegistry: fixture
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  }
});

test('graceful resource revoke timeout never sends executor close and settles without leaks', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: { autoCloseAck: false }
  });
  const { transport } = await openStatementJob(harness);
  await adoptServiceResource(harness, {
    requestId: 'unanswered-close-revoke',
    requestKind: 'persistent-state-replace',
    requestOwner: owner('service-state', 'unanswered-close-revoke')
  });
  await transport.close();

  const closing = harness.host.closeService('service.statement', { timeoutMs: 10 });
  const rejection = assert.rejects(closing, (error) =>
    error.code === 'SERVICE_GRACEFUL_CLOSE_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.some((message) => message.operation === 'resource:revoke'), true);
  assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);
  clock.advance(10);
  await rejection;

  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.equal(clock.timerCount, 0);
  assert.equal(harness.diagnosticEvents.some((event) =>
    event.type === 'service-close-error' && event.graceful === false), true);
});

test('late release and close-ack fail the absolute graceful deadline before timer dispatch', async () => {
  const releaseClock = createFakeClock();
  const releaseHarness = createHarness(releaseClock);
  const { transport } = await openStatementJob(releaseHarness);
  await adoptServiceResource(releaseHarness, {
    requestId: 'late-release-resource',
    requestKind: 'persistent-state-replace',
    requestOwner: owner('service-state', 'late-release-resource')
  });
  await transport.close();
  const releaseClosing = releaseHarness.host.closeService('service.statement', { timeoutMs: 10 });
  const releaseRejection = assert.rejects(releaseClosing, (error) =>
    error.code === 'SERVICE_GRACEFUL_CLOSE_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  const revoke = releaseHarness.fake.sent.find((message) =>
    message.operation === 'resource:revoke');
  releaseClock.elapse(10);
  releaseHarness.fake.emit(releaseHarness.fake.event('resource:release', {
    controlId: revoke.controlId,
    jobRef: revoke.jobRef,
    payload: { reservationId: revoke.payload.reservationId, reason: 'service-close' }
  }));
  await releaseRejection;
  assert.equal(releaseHarness.fake.sent.some((message) =>
    message.operation === 'resource:release-ack'), false);
  assert.equal(releaseHarness.fake.sent.some((message) =>
    message.operation === 'executor:close'), false);
  assert.equal(releaseHarness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(releaseClock.timerCount, 0);

  const ackClock = createFakeClock();
  const ackHarness = createHarness({
    ...ackClock,
    adapterOptions: { autoCloseAck: false }
  });
  const opened = await openStatementJob(ackHarness);
  await opened.transport.close();
  const ackClosing = ackHarness.host.closeService('service.statement', { timeoutMs: 10 });
  const ackRejection = assert.rejects(ackClosing, (error) =>
    error.code === 'SERVICE_GRACEFUL_CLOSE_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  const close = ackHarness.fake.sent.find((message) => message.operation === 'executor:close');
  ackClock.elapse(10);
  ackHarness.fake.emit(ackHarness.fake.event('executor:close-ack', {
    controlId: close.controlId,
    jobRef: null,
    payload: {}
  }));
  await ackRejection;
  assert.equal(ackHarness.host.snapshot().services.length, 0);
  assert.equal(ackHarness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(ackClock.timerCount, 0);
});

test('job detach aborts and awaits pending admission reject before deleting its route', async () => {
  let rejectAdmission;
  let abortObserved = false;
  const harness = createHarness({
    wrapGovernor(base) {
      return Object.freeze({
        ...base,
        acquirePendingInteractionReservation(request) {
          return new Promise((_resolve, reject) => {
            rejectAdmission = reject;
            request.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
          });
        }
      });
    }
  });
  const { transport } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'pending-close-request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'pending-close-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'pending-close-owner')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].pendingRequestCount, 1);
  let detachSettled = false;
  const detaching = transport.close().finally(() => { detachSettled = true; });
  assert.equal(abortObserved, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detachSettled, false);
  assert.deepEqual(harness.host.snapshot().services[0].activeJobIds, ['job-1']);
  await assert.rejects(
    harness.host.closeService('service.statement', { timeoutMs: 50 }),
    (error) => error.code === 'SERVICE_BUSY'
  );
  assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);

  const admissionError = new Error('admission aborted');
  admissionError.code = 'ADMISSION_CANCELLED';
  rejectAdmission(admissionError);
  assert.equal(await detaching, true);
  const rejection = harness.fake.sent.find((message) =>
    message.operation === 'resource:reject' && message.controlId === 'pending-close-request-control');
  assert.ok(rejection);
  assert.equal(rejection.payload.requestId, 'pending-close-request');
  assert.deepEqual(harness.host.snapshot().services[0].activeJobIds, []);
  assert.equal(await harness.host.closeService('service.statement', { timeoutMs: 50 }), true);
  assert.equal(harness.fake.sent.at(-1).operation, 'executor:close');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('graceful close waits for an adoption-timeout revoke tombstone to finish exact echo', async () => {
  const clock = createFakeClock();
  const harness = createHarness(clock);
  const { transport } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'timeout-tombstone-request-control',
    jobRef: jobRef(),
    payload: {
      requestId: 'timeout-tombstone-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'timeout-tombstone-owner')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  const revoke = harness.fake.sent.find((message) =>
    message.operation === 'resource:revoke' &&
    message.payload.reasonCode === 'adoption-timeout');
  assert.ok(revoke);
  let detachSettled = false;
  const detaching = transport.close().finally(() => { detachSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detachSettled, false);
  assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);

  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: revoke.controlId,
    jobRef: revoke.jobRef,
    payload: { reservationId: revoke.payload.reservationId, reason: 'job-failed' }
  }));
  assert.equal(await detaching, true);
  assert.equal(await harness.host.closeService('service.statement', { timeoutMs: 10 }), true);
  const validation = validateProtocolSequence(harness.fake.trace, { policyRegistry: fixture });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(harness.fake.sent.at(-1).operation, 'executor:close');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(clock.timerCount, 0);
});

test('graceful revoke send failure and synchronous raw crash are bounded non-graceful closes', async () => {
  for (const lifecycle of ['send-throw', 'raw-crash']) {
    const harness = createHarness({
      adapterOptions: lifecycle === 'send-throw'
        ? { sendErrorOperation: 'resource:revoke' }
        : {
            onSend(message, startOptions) {
              if (message.operation === 'resource:revoke') startOptions.onExit(17, null);
            }
          }
    });
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    await adoptServiceResource(harness, {
      requestId: `${lifecycle}-resource`,
      requestKind: 'persistent-state-replace',
      requestOwner: owner('service-state', `${lifecycle}-resource`),
      currentJobRef: jobRef({
        operationKey: `task-${lifecycle}/statement:import/1`,
        jobId: `job-${lifecycle}`
      })
    });
    await transport.close();

    await assert.rejects(harness.host.closeService('service.statement', { timeoutMs: 50 }));
    assert.equal(harness.fake.sent.some((message) => message.operation === 'executor:close'), false);
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
    assert.equal(harness.fake.closeCount, 1);
    assert.equal(harness.fake.terminateCount, 1);
    assert.equal(harness.diagnosticEvents.some((event) =>
      event.type === 'service-close-error' && event.graceful === false), true);
  }
});

test('shutdown aborts and awaits a generation queued for BaseLease before any adapter starts', async () => {
  const harness = createHarness();
  const blocker = await harness.governor.acquirePhaseLease({
    ownerKey: 'base-blocker',
    actionKey: 'statement:import',
    operationKey: 'block-base',
    resources: vector({
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 2,
      ioHeavySlots: 8,
      memoryBytes: 1024 * 1024 * 1024
    })
  });
  const opening = openStatementJob(harness);
  const openingRejection = assert.rejects(opening, (error) => error.code === 'ADMISSION_CANCELLED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].state, 'admitting');
  assert.equal(harness.host.snapshot().services[0].baseLeaseId, null);

  const results = await harness.host.shutdown({ timeoutMs: 100 });
  await openingRejection;
  assert.deepEqual(results.map((result) => result.status), ['fulfilled']);
  assert.equal(harness.fake.starts.length, 0);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().queued.size, 0);

  blocker.release('capacity-returned');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.starts.length, 0);
  await assert.rejects(openStatementJob(harness, { jobId: 'job-after-shutdown' }), (error) =>
    error.code === 'SERVICE_HOST_SHUTDOWN');
});

test('cooperative close send failure still closes the generation exactly once and reports diagnostics', async () => {
  const harness = createHarness({ adapterOptions: { sendErrorOperation: 'executor:close' } });
  const { transport } = await openStatementJob(harness);
  await transport.close();

  await assert.rejects(harness.host.closeService('service.statement'), /send failed: executor:close/);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.fake.closeCount, 1);
  assert.equal(harness.fake.terminateCount, 1);
  assert.equal(harness.diagnosticEvents.some((event) => event.type === 'service-close-error'), true);
  assert.equal(await harness.host.closeService('service.statement'), false);
  assert.equal(harness.fake.terminateCount, 1);
});

test('cooperative close ack timeout is reported as non-graceful and still releases the generation', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: { autoCloseAck: false }
  });
  const { transport } = await openStatementJob(harness);
  await transport.close();

  const closing = harness.host.closeService('service.statement', { timeoutMs: 10 });
  const rejection = assert.rejects(closing, (error) =>
    error.code === 'SERVICE_GRACEFUL_CLOSE_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.at(-1).operation, 'executor:close');
  clock.advance(10);
  await rejection;
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.fake.terminateCount, 1);
  assert.equal(harness.diagnosticEvents.some((event) => event.type === 'service-close-timeout'), true);
});

test('unsupported bounded-queue service policy fails closed before BaseLease or adapter start', async () => {
  const policy = structuredClone(fixture.actions['statement:import']);
  policy.service.busyPolicy = 'bounded-queue';
  const policyRegistry = Object.freeze({
    assertRunnable(actionKey) {
      if (actionKey !== policy.actionKey) throw new Error(`Unknown policy: ${actionKey}`);
      return policy;
    },
    getBinding() { return 'service-worker.js'; },
    list() { return Object.freeze([policy]); }
  });
  const harness = createHarness({ policyRegistry });

  await assert.rejects(openStatementJob(harness), (error) =>
    error.code === 'SERVICE_BUSY_POLICY_UNSUPPORTED');
  assert.equal(harness.fake.starts.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.host.snapshot().services.length, 0);
});

test('raw adapter ready is bounded by init timeout and cannot leave startup hanging', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: { rawReady: new Promise(() => {}) }
  });
  const opening = openStatementJob(harness, { initTimeoutMs: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(5);
  await assert.rejects(opening, (error) => error.code === 'SERVICE_INIT_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.fake.closeCount, 1);
  assert.equal(harness.fake.terminateCount, 1);
});

test('force close settles startup blocked on raw ready', async () => {
  const harness = createHarness({
    adapterOptions: { rawReady: new Promise(() => {}) }
  });
  const opening = openStatementJob(harness, { initTimeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = harness.host.closeService('service.statement', { force: true });
  await assert.rejects(opening, (error) =>
    ['SERVICE_CLOSED_DURING_INIT', 'SERVICE_START_ABORTED'].includes(error.code));
  await closing;
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.fake.closeCount, 1);
  assert.equal(harness.fake.terminateCount, 1);
});

test('raw exit or error before close-ack settles every waiter as non-graceful', async () => {
  for (const lifecycle of ['exit', 'error']) {
    const harness = createHarness({ adapterOptions: { autoCloseAck: false } });
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    await transport.close();
    const closing = harness.host.closeService('service.statement', { timeoutMs: 1000 });
    const rejection = assert.rejects(closing);
    await new Promise((resolve) => setImmediate(resolve));
    if (lifecycle === 'exit') harness.fake.exit(7, null);
    else harness.fake.error(new Error('raw transport error'));
    await rejection;
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.fake.closeCount, 1);
    assert.equal(harness.fake.terminateCount, 1);
  }
});

test('raw onExit remains an exit callback instead of being rewritten as onError', async () => {
  const harness = createHarness();
  const exits = [];
  const errors = [];
  await harness.host.openJob({
    actionKey: 'statement:import',
    operationKey: 'task-exit/statement:import/1',
    jobId: 'job-exit',
    onMessage() {},
    onError: (error) => errors.push(error),
    onExit: (code, signal) => exits.push({ code, signal })
  });
  harness.fake.exit(23, 'SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [{ code: 23, signal: 'SIGTERM' }]);
  assert.deepEqual(errors, []);
  assert.equal(harness.host.snapshot().services.length, 0);
});

test('owner identity is claimed while tentative and released after timeout', async () => {
  const firstHarness = createHarness();
  await openStatementJob(firstHarness);
  const requestOwner = owner('interaction-token', 'same-token');
  function emitRequest(harness, requestId) {
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `control-${requestId}`,
      jobRef: jobRef(),
      payload: {
        requestId,
        requestKind: 'pending-interaction-create',
        requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: null,
        owner: requestOwner
      }
    }));
  }
  emitRequest(firstHarness, 'first');
  await new Promise((resolve) => setImmediate(resolve));
  emitRequest(firstHarness, 'duplicate');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    firstHarness.fake.sent.filter((message) => message.operation === 'resource:grant').length,
    1
  );
  assert.equal(firstHarness.host.snapshot().services.length, 0);

  const clock = createFakeClock();
  const retryHarness = createHarness(clock);
  await openStatementJob(retryHarness);
  emitRequest(retryHarness, 'before-timeout');
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  emitRequest(retryHarness, 'after-timeout');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryHarness.fake.sent.at(-1).operation, 'resource:grant');
  assert.equal(retryHarness.host.snapshot().services[0].ownerClaimCount, 1);
});

test('shared serviceKey runtime binding gate is stable in both action startup orders', async () => {
  const policies = [
    fixture.actions['statement:import'],
    fixture.actions['statement:generate-current']
  ];
  function registry(entries) {
    return Object.freeze({
      assertRunnable(actionKey) {
        const policy = policies.find((candidate) => candidate.actionKey === actionKey);
        if (!policy) throw new Error(`Unknown policy: ${actionKey}`);
        return policy;
      },
      getBinding(actionKey) { return entries[actionKey]; },
      list() { return Object.freeze(policies); }
    });
  }

  for (const actionKey of policies.map((policy) => policy.actionKey)) {
    const harness = createHarness({
      policyRegistry: registry({
        'statement:import': '/service-a.js',
        'statement:generate-current': '/service-b.js'
      })
    });
    await assert.rejects(
      openStatementJob(harness, { actionKey }),
      (error) => error.code === 'SERVICE_RUNTIME_BINDING_CONFLICT'
    );
    assert.equal(harness.fake.starts.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  }

  const compatible = createHarness({
    policyRegistry: registry({
      'statement:import': '/shared-service.js',
      'statement:generate-current': '/shared-service.js'
    })
  });
  const first = await openStatementJob(compatible, {
    actionKey: 'statement:generate-current',
    operationKey: 'task-first/statement:generate-current/1'
  });
  await first.transport.close();
  const second = await openStatementJob(compatible, {
    actionKey: 'statement:import',
    operationKey: 'task-second/statement:import/1',
    jobId: 'job-2'
  });
  await second.transport.close();
  assert.equal(compatible.fake.starts.length, 1);
});

test('adoption timer is installed before grant send and synchronous adoption leaves no revoke', async () => {
  const clock = createFakeClock();
  const requestOwner = owner('interaction-token', 'sync-token');
  const harness = createHarness({
    ...clock,
    adapterOptions: {
      onSend(message, startOptions, eventFrom) {
        if (message.operation !== 'resource:grant') return;
        startOptions.onMessage(eventFrom(message, 'resource:adopted', {
          controlId: 'sync-adopt',
          jobRef: message.jobRef,
          payload: {
            requestId: message.payload.requestId,
            grantId: message.payload.grantId,
            reservationId: message.payload.reservationId,
            owner: requestOwner
          }
        }));
      }
    }
  });
  await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'sync-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'sync-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.at(-1).operation, 'resource:adopt-ack');
  assert.equal(clock.timerCount, 0);
  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.some((message) => message.operation === 'resource:revoke'), false);
});

test('replacement adoption already in progress ACKs before serialized detach and preserves persistent state', async () => {
  let releaseReplacement;
  let replacementStarted;
  const started = new Promise((resolve) => { replacementStarted = resolve; });
  const gate = new Promise((resolve) => { releaseReplacement = resolve; });
  const harness = createHarness({
    wrapGovernor(base) {
      return Object.freeze({
        ...base,
        replaceReservationAtomically(request) {
          const adopted = base.replaceReservationAtomically(request);
          replacementStarted();
          return Promise.resolve(adopted).then(async (lease) => {
            await gate;
            return lease;
          });
        }
      });
    }
  });
  const { transport } = await openStatementJob(harness);

  async function grant(requestId, revision, replacesReservationId) {
    const requestOwner = owner('service-state', 'race-state', revision);
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `request-${requestId}`,
      jobRef: jobRef(),
      payload: {
        requestId,
        requestKind: 'persistent-state-replace',
        requested: { memoryBytes: revision + 10, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId,
        owner: requestOwner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    return { message: harness.fake.sent.at(-1), requestOwner };
  }

  const first = await grant('first', 1, null);
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'adopt-first',
    jobRef: jobRef(),
    payload: {
      requestId: 'first',
      grantId: first.message.payload.grantId,
      reservationId: first.message.payload.reservationId,
      owner: first.requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await grant('second', 2, first.message.payload.reservationId);
  const ackCountBefore = harness.fake.sent.filter((message) => message.operation === 'resource:adopt-ack').length;
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'adopt-second',
    jobRef: jobRef(),
    payload: {
      requestId: 'second',
      grantId: second.message.payload.grantId,
      reservationId: second.message.payload.reservationId,
      owner: second.requestOwner
    }
  }));
  await started;
  const detached = transport.close();
  releaseReplacement();
  await detached;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.fake.sent.filter((message) => message.operation === 'resource:adopt-ack').length,
    ackCountBefore + 1
  );
  assert.equal(harness.host.snapshot().services.length, 1);
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 2);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  await harness.host.closeService('service.statement', { force: true });
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('release of old reservation while replacement is tentative has no ACK and closes cleanly', async () => {
  const harness = createHarness();
  const { errors } = await openStatementJob(harness);
  const stateOwner = owner('service-state', 'protected-state', 1);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'initial-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'initial',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 10, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: stateOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const initial = harness.fake.sent.at(-1);
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'initial-adopt',
    jobRef: jobRef(),
    payload: {
      requestId: 'initial',
      grantId: initial.payload.grantId,
      reservationId: initial.payload.reservationId,
      owner: stateOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'replacement-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'replacement',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 11, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: initial.payload.reservationId,
      owner: owner('service-state', 'protected-state', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const releaseAckCount = harness.fake.sent.filter((message) => message.operation === 'resource:release-ack').length;
  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: 'unsafe-release',
    jobRef: null,
    payload: { reservationId: initial.payload.reservationId, reason: 'service-close' }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.fake.sent.filter((message) => message.operation === 'resource:release-ack').length,
    releaseAckCount
  );
  assert.equal(
    errors[0] instanceof ServiceHostProtocolError,
    true,
    `${errors[0] && errors[0].name}:${errors[0] && errors[0].code}`
  );
  assert.equal(errors[0].code, 'SERVICE_RELEASE_DURING_TENTATIVE_REPLACEMENT');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('release of old reservation while its replacement is queued is a protocol error and clears pending linkage', async () => {
  const harness = createHarness();
  const { errors } = await openStatementJob(harness);
  const stateOwner = owner('service-state', 'queued-protected-state', 1);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'queued-initial-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'queued-initial',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 10, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: stateOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const initial = harness.fake.sent.at(-1);
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'queued-initial-adopt',
    jobRef: jobRef(),
    payload: {
      requestId: 'queued-initial',
      grantId: initial.payload.grantId,
      reservationId: initial.payload.reservationId,
      owner: stateOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const blocker = await harness.governor.acquirePhaseLease({
    ownerKey: 'external-blocker',
    actionKey: 'test-action',
    operationKey: 'test-operation',
    resources: vector({ memoryBytes: harness.governor.snapshot().available.memoryBytes })
  });
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'queued-replacement-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'queued-replacement',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 11, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: initial.payload.reservationId,
      owner: owner('service-state', 'queued-protected-state', 2)
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services[0].pendingRequestCount, 1);
  assert.equal(harness.host.snapshot().services[0].tentativeGrantCount, 0);
  assert.equal(harness.governor.snapshot().queued.size, 1);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 1);

  const releaseAckCount = harness.fake.sent.filter((message) =>
    message.operation === 'resource:release-ack').length;
  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: 'queued-unsafe-release',
    jobRef: null,
    payload: { reservationId: initial.payload.reservationId, reason: 'service-close' }
  }));
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(
    harness.fake.sent.filter((message) => message.operation === 'resource:release-ack').length,
    releaseAckCount
  );
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(errors[0].code, 'SERVICE_RELEASE_DURING_TENTATIVE_REPLACEMENT');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().queued.size, 0);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);
  assert.equal(blocker.release('test-end'), true);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.deepEqual(harness.governor.snapshot().activeUsage, vector());
});

test('synchronous replacement grant diagnostics close cannot orphan the adopted parent', async () => {
  for (const lifecycle of ['force-close', 'raw-exit']) {
    let harness;
    let persistentGrantCount = 0;
    let closePromise = null;
    harness = createHarness({
      governorDiagnostics(event) {
        if (event.type !== 'resource-granted' || event.kind !== 'persistent') return;
        persistentGrantCount += 1;
        if (persistentGrantCount !== 2) return;
        if (lifecycle === 'force-close') {
          closePromise = harness.host.closeService('service.statement', { force: true });
          closePromise.catch(() => {});
        } else {
          harness.fake.exit(23, null);
        }
      }
    });
    await openStatementJob(harness, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    const currentJobRef = jobRef({
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    const stateOwner = owner('service-state', `state-${lifecycle}`, 1);
    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `initial-request-${lifecycle}`,
      jobRef: currentJobRef,
      payload: {
        requestId: `initial-${lifecycle}`,
        requestKind: 'persistent-state-replace',
        requested: { memoryBytes: 10, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: null,
        owner: stateOwner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const initial = harness.fake.sent.at(-1);
    harness.fake.emit(harness.fake.event('resource:adopted', {
      controlId: `initial-adopt-${lifecycle}`,
      jobRef: currentJobRef,
      payload: {
        requestId: `initial-${lifecycle}`,
        grantId: initial.payload.grantId,
        reservationId: initial.payload.reservationId,
        owner: stateOwner
      }
    }));
    await new Promise((resolve) => setImmediate(resolve));

    harness.fake.emit(harness.fake.event('resource:request', {
      controlId: `replacement-request-${lifecycle}`,
      jobRef: currentJobRef,
      payload: {
        requestId: `replacement-${lifecycle}`,
        requestKind: 'persistent-state-replace',
        requested: { memoryBytes: 11, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: initial.payload.reservationId,
        owner: owner('service-state', `state-${lifecycle}`, 2)
      }
    }));
    if (closePromise) await closePromise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.host.snapshot().services.length, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0, lifecycle);
    assert.deepEqual(harness.governor.snapshot().activeUsage, vector(), lifecycle);
  }
});

test('synchronous raw exit and throwing job callbacks still cleanup exactly once', async () => {
  const orphan = createHarness({ adapterOptions: { syncExit: { code: 9, signal: null } } });
  await assert.rejects(openStatementJob(orphan), (error) => error.code === 'SERVICE_START_ABORTED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orphan.fake.closeCount, 1);
  assert.equal(orphan.fake.terminateCount, 1);
  assert.equal(orphan.governor.snapshot().activeLeaseCount, 0);

  const harness = createHarness();
  await harness.host.openJob({
    actionKey: 'statement:import',
    operationKey: 'task-callback/statement:import/1',
    jobId: 'job-callback',
    onMessage() {},
    onError() { throw new Error('observer failed'); }
  });
  harness.fake.error(new Error('raw failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.fake.closeCount, 1);
  assert.equal(harness.fake.terminateCount, 1);
  assert.ok(harness.diagnosticEvents.some((event) => event.type === 'service-job-callback-error'));
});

test('persistent reservation identity survives detach and replacement from a later action job', async () => {
  const harness = createHarness();
  const first = await openStatementJob(harness);
  const firstOwner = owner('service-state', 'cross-job-state', 1);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'cross-job-request-1',
    jobRef: jobRef(),
    payload: {
      requestId: 'cross-job-request-1',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 10, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: firstOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const firstGrant = harness.fake.sent.at(-1);
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'cross-job-adopt-1',
    jobRef: jobRef(),
    payload: {
      requestId: 'cross-job-request-1',
      grantId: firstGrant.payload.grantId,
      reservationId: firstGrant.payload.reservationId,
      owner: firstOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await first.transport.close();

  const secondRef = jobRef({
    actionKey: 'statement:generate-current',
    operationKey: 'task-2/statement:generate-current/1',
    jobId: 'job-2'
  });
  const second = await openStatementJob(harness, {
    actionKey: secondRef.actionKey,
    operationKey: secondRef.operationKey,
    jobId: secondRef.jobId
  });
  const secondOwner = owner('service-state', 'cross-job-state', 2);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'cross-job-request-2',
    jobRef: secondRef,
    payload: {
      requestId: 'cross-job-request-2',
      requestKind: 'persistent-state-replace',
      requested: { memoryBytes: 15, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: firstGrant.payload.reservationId,
      owner: secondOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const secondGrant = harness.fake.sent.at(-1);
  assert.equal(secondGrant.operation, 'resource:grant');
  harness.fake.emit(harness.fake.event('resource:adopted', {
    controlId: 'cross-job-adopt-2',
    jobRef: secondRef,
    payload: {
      requestId: 'cross-job-request-2',
      grantId: secondGrant.payload.grantId,
      reservationId: secondGrant.payload.reservationId,
      owner: secondOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fake.sent.at(-1).operation, 'resource:adopt-ack');
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  assert.equal(harness.governor.snapshot().activeDependencyCount, 0);

  await second.transport.close();
  assert.equal(harness.host.snapshot().services[0].adoptedReservationCount, 1);
  await harness.host.closeService('service.statement', { force: true });
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('executor ready and adoption both reject at an elapsed absolute deadline before timer dispatch', async () => {
  const initClock = createFakeClock();
  const initHarness = createHarness({
    ...initClock,
    adapterOptions: { autoReady: false }
  });
  const opening = openStatementJob(initHarness, { initTimeoutMs: 5 });
  const openingRejection = assert.rejects(opening, (error) => error.code === 'SERVICE_INIT_TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  initClock.elapse(5);
  initHarness.fake.emit(initHarness.fake.event('executor:ready', {
    payload: { contractVersion: 1, capabilities: ['resource-control-v1'] }
  }));
  await openingRejection;
  assert.equal(initClock.timerCount, 0);
  assert.equal(initHarness.fake.starts.length, 1);
  assert.equal(initHarness.host.snapshot().services.length, 0);
  assert.equal(initHarness.governor.snapshot().activeLeaseCount, 0);

  const adoptionClock = createFakeClock();
  const adoptionHarness = createHarness(adoptionClock);
  const { errors } = await openStatementJob(adoptionHarness);
  const requestOwner = owner('interaction-token', 'blocked-deadline');
  adoptionHarness.fake.emit(adoptionHarness.fake.event('resource:request', {
    controlId: 'blocked-deadline-request',
    jobRef: jobRef(),
    payload: {
      requestId: 'blocked-deadline-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const grant = adoptionHarness.fake.sent.at(-1);
  adoptionClock.elapse(30000);
  adoptionHarness.fake.emit(adoptionHarness.fake.event('resource:adopted', {
    controlId: 'blocked-deadline-adopt',
    jobRef: jobRef(),
    payload: {
      requestId: grant.payload.requestId,
      grantId: grant.payload.grantId,
      reservationId: grant.payload.reservationId,
      owner: requestOwner
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    adoptionHarness.fake.sent.some((message) =>
      message.operation === 'resource:adopt-ack' && message.payload.grantId === grant.payload.grantId),
    false
  );
  assert.equal(adoptionHarness.fake.sent.some((message) => message.operation === 'resource:revoke'), true);
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(errors[0].code, 'SERVICE_ADOPTION_TIMEOUT');
  assert.equal(adoptionClock.timerCount, 0);
  assert.equal(adoptionHarness.host.snapshot().services.length, 0);
  assert.equal(adoptionHarness.governor.snapshot().activeLeaseCount, 0);
});

test('BaseLease deferred release closes after external compound cleanup for exit, force close, and shutdown', async () => {
  for (const lifecycle of ['raw-exit', 'force-close', 'shutdown']) {
    const harness = createHarness();
    const { transport } = await openStatementJob(harness, {
      operationKey: `task-${lifecycle}/statement:import/1`,
      jobId: `job-${lifecycle}`
    });
    const compound = await harness.governor.acquireCompoundLease({
      ownerKey: 'service:service.statement',
      actionKey: 'compound-job',
      operationKey: lifecycle,
      base: transport.baseResources,
      phase: vector({ ioHeavySlots: 1, memoryBytes: 1 }),
      childResource: vector(),
      childrenMax: 0,
      effectiveChildCount: 0,
      existingBaseLeaseId: transport.baseLeaseId
    });

    if (lifecycle === 'raw-exit') {
      harness.fake.exit(19, null);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } else if (lifecycle === 'force-close') {
      await harness.host.closeService('service.statement', { force: true });
    } else {
      await harness.host.shutdown({ force: true, timeoutMs: 100 });
    }

    assert.equal(harness.host.snapshot().services.length, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 2, lifecycle);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 1, lifecycle);
    assert.equal(compound.release('supervisor-resource-cleanup'), true, lifecycle);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0, lifecycle);
    assert.equal(harness.governor.snapshot().activeDependencyCount, 0, lifecycle);
    assert.deepEqual(harness.governor.snapshot().activeUsage, vector(), lifecycle);
  }
});

test('executor close synchronous exit settles its preinstalled waiter as non-graceful and clears timers', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: {
      autoCloseAck: false,
      onSend(message, startOptions) {
        if (message.operation === 'executor:close') startOptions.onExit(0, null);
      }
    }
  });
  const { transport } = await openStatementJob(harness);
  await transport.close();
  await assert.rejects(
    harness.host.closeService('service.statement', { timeoutMs: 50 }),
    (error) => error.code === 'SERVICE_UNEXPECTED_EXIT'
  );
  assert.equal(clock.timerCount, 0);
  assert.equal(harness.fake.closeCount, 1);
  assert.equal(harness.fake.terminateCount, 1);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

for (const [code, signal, graceful] of [[0, null, true], [1, null, false], [0, 'SIGTERM', false]]) {
  test(`关闭 ACK 后同轮 exit(${code}, ${signal}) 只接受无信号的正常退出`, async () => {
    const clock = createFakeClock();
    const harness = createHarness({ ...clock, adapterOptions: { autoCloseAck: false,
      onSend(message, callbacks, eventFrom) {
        if (message.operation !== 'executor:close') return;
        callbacks.onMessage(eventFrom(message, 'executor:close-ack', { controlId: message.controlId }));
        callbacks.onExit(code, signal);
      }
    } });
    const { transport } = await openStatementJob(harness);
    await transport.close();
    const closing = harness.host.closeService('service.statement', { timeoutMs: 50 });
    if (graceful) assert.equal(await closing, true);
    else await assert.rejects(closing, { code: 'SERVICE_UNEXPECTED_EXIT' });
    assert.equal(clock.timerCount, 0);
    assert.equal(harness.fake.closeCount, 1); assert.equal(harness.fake.terminateCount, 1);
    assert.equal(harness.host.snapshot().services.length, 0);
    assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  });
}

test('schema-valid unknown reservation is exposed as an explicit Host protocol error', async () => {
  const harness = createHarness();
  const { errors } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:release', {
    controlId: 'unknown-release',
    jobRef: null,
    payload: { reservationId: 'unknown-reservation', reason: 'token-consumed' }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(errors[0].code, 'SERVICE_RELEASE_UNKNOWN');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('generation control registry rejects a Worker request that reuses the Main init ID', async () => {
  const harness = createHarness();
  const { errors } = await openStatementJob(harness);
  const init = harness.fake.sent.find((message) => message.operation === 'executor:init');
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: init.controlId,
    jobRef: jobRef(),
    payload: {
      requestId: 'init-id-reuse-request',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'init-id-reuse-owner')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(errors[0].code, 'SERVICE_CONTROL_ID_REUSED');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(
    harness.fake.sent.some((message) => message.payload.requestId === 'init-id-reuse-request'),
    false
  );
});

test('live revoke control ID cannot start an unrelated Worker request', async () => {
  const clock = createFakeClock();
  const harness = createHarness(clock);
  const { errors } = await openStatementJob(harness);
  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'revoke-reuse-source',
    jobRef: jobRef(),
    payload: {
      requestId: 'revoke-reuse-source',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'revoke-reuse-source')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  const revoke = harness.fake.sent.find((message) => message.operation === 'resource:revoke');

  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: revoke.controlId,
    jobRef: jobRef(),
    payload: {
      requestId: 'request-reusing-revoke-control',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'request-reusing-revoke-control')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof ServiceHostProtocolError, true);
  assert.equal(errors[0].code, 'SERVICE_CONTROL_EXCHANGE_INVALID');
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(clock.timerCount, 0);
});

test('init/ready, revoke/release, and close/ack preserve their exact correlation semantics', async () => {
  const clock = createFakeClock();
  const harness = createHarness({
    ...clock,
    adapterOptions: {
      onSend(message, startOptions, eventFrom) {
        if (message.operation !== 'resource:revoke') return;
        startOptions.onMessage(eventFrom(message, 'resource:release', {
          controlId: message.controlId,
          jobRef: message.jobRef,
          payload: { reservationId: message.payload.reservationId, reason: 'job-failed' }
        }));
      }
    }
  });
  const { transport, errors } = await openStatementJob(harness);
  const init = harness.fake.sent.find((message) => message.operation === 'executor:init');
  assert.ok(init);

  harness.fake.emit(harness.fake.event('resource:request', {
    controlId: 'exact-revoke-source',
    jobRef: jobRef(),
    payload: {
      requestId: 'exact-revoke-source',
      requestKind: 'pending-interaction-create',
      requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null,
      owner: owner('interaction-token', 'exact-revoke-source')
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30000);
  await new Promise((resolve) => setImmediate(resolve));
  const revoke = harness.fake.sent.find((message) => message.operation === 'resource:revoke');

  const releaseAck = harness.fake.sent.find((message) =>
    message.operation === 'resource:release-ack' && message.controlId === revoke.controlId);
  assert.ok(releaseAck);
  assert.equal(releaseAck.payload.reservationId, revoke.payload.reservationId);
  assert.equal(errors.length, 0);
  assert.equal(harness.host.snapshot().services[0].state, 'ready');
  assert.equal(harness.governor.snapshot().activeLeaseCount, 1);

  await transport.close();
  assert.equal(await harness.host.closeService('service.statement'), true);
  const close = harness.fake.sent.find((message) => message.operation === 'executor:close');
  assert.ok(close);
  assert.equal(harness.host.snapshot().services.length, 0);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
  assert.equal(clock.timerCount, 0);
});

test('the same control ID string may be reused by a later service generation', async () => {
  let instanceId = 0;
  const harness = createHarness({
    hostIdFactory(prefix) {
      if (prefix === 'control') return 'generation-scoped-control';
      instanceId += 1;
      return `generation-${prefix}-${instanceId}`;
    }
  });
  await openStatementJob(harness);
  assert.equal(await harness.host.closeService('service.statement', { force: true }), true);
  await openStatementJob(harness, {
    operationKey: 'task-2/statement:import/1',
    jobId: 'job-2'
  });

  const initCommands = harness.fake.sent.filter((message) => message.operation === 'executor:init');
  assert.deepEqual(initCommands.map((message) => message.controlId), [
    'generation-scoped-control',
    'generation-scoped-control'
  ]);
  assert.deepEqual(initCommands.map((message) => message.serviceGeneration), [1, 2]);
  assert.equal(await harness.host.closeService('service.statement', { force: true }), true);
  assert.equal(harness.governor.snapshot().activeLeaseCount, 0);
});

test('public ServiceHost facade is limited to lifecycle, job route, and diagnostics methods', () => {
  const { host } = createHarness();
  assert.deepEqual(Object.keys(host), [
    'openJob',
    'closeService',
    'stopAcceptingNewServices',
    'shutdown',
    'snapshot'
  ]);
});
