'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../../src/main-process/background-execution/execution-policy-registry');
const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('../../../../src/main-process/background-execution/protocol');
const {
  createExistingDispatchAdapter,
  createExistingDispatchTransportAdapter
} = require('../../../../src/main-process/background-execution/adapters/existing-dispatch-adapter');
const {
  createExecutionSupervisor,
  validateResultBody
} = require('../../../../src/main-process/background-execution/supervisor');
const { createResourceGovernor } = require(
  '../../../../src/main-process/background-execution/resource-governor'
);
const { ServiceHostProtocolError } = require(
  '../../../../src/main-process/background-execution/service-host'
);
const { validateProtocolSequence } = require(
  '../../../../src/main-process/background-execution/protocol-sequence-validator'
);
const canary = require('../../../../src/main-process/background-execution/canary');
const servicePolicyFixture = require(
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
).actions['statement:import'];

function applyServicePolicy(policy, serviceKey) {
  policy.lifetime = 'service';
  policy.service = structuredClone(servicePolicyFixture.service);
  policy.service.serviceKey = serviceKey;
  policy.resources.persistentState = structuredClone(servicePolicyFixture.resources.persistentState);
  policy.resources.pendingInteraction = structuredClone(servicePolicyFixture.resources.pendingInteraction);
}

function fakeAdapter(options = {}) {
  const state = { callbacks: null, sent: [], closeCount: 0, terminateCount: 0 };
  const adapter = {
    start(callbacks) {
      state.callbacks = callbacks;
      const handle = {
        ready: options.ready || Promise.resolve(),
        send(message) {
          state.sent.push(message);
          if (options.sendError) throw options.sendError;
          if (options.onSend) {
            if (options.synchronousOnSend) options.onSend(message, callbacks, state);
            else queueMicrotask(() => options.onSend(message, callbacks, state));
          }
        },
        close() {
          state.closeCount += 1;
          return options.close ? options.close() : undefined;
        },
        terminate() {
          state.terminateCount += 1;
          return options.terminate ? options.terminate() : Promise.resolve(0);
        }
      };
      if (options.onStart) options.onStart(callbacks, state, handle);
      return handle;
    }
  };
  return { adapter, state };
}

function eventFor(command, operation, seq, payload, unitId = null) {
  let canonicalPayload = payload;
  if ((operation === 'job:error' || operation === 'unit:error') && payload && payload.error) {
    canonicalPayload = {
      error: {
        code: payload.error.code,
        message: payload.error.message,
        stage: payload.error.stage || 'execute',
        detailLines: payload.error.detailLines || []
      }
    };
  } else if (operation === 'cancel:ack') {
    canonicalPayload = { cancellation: { scope: 'job' } };
  }
  return createJobEnvelope({
    direction: 'event',
    operation,
    actionKey: command.actionKey,
    operationKey: command.operationKey,
    jobId: command.jobId,
    workerInstanceId: command.workerInstanceId,
    serviceGeneration: null,
    unitId,
    seq,
    context: command.context,
    payload: canonicalPayload
  });
}

function harness(
  fake,
  policyMutation,
  resultValidator = canary.validatePureComputeCanaryResult,
  supervisorOptions = {}
) {
  const policy = structuredClone(canary.pureComputePolicy);
  if (policyMutation) policyMutation(policy);
  const entryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: '/packaged/src/pure-compute-worker.js'
  });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: resultValidator
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [policy],
    entryRegistry,
    validatorRegistry,
    staticKeys: {
      resourceProfileKeys: [policy.resources.profile],
      ...(policy.commit.inspectorKey ? { inspectorKeys: [policy.commit.inspectorKey] } : {}),
      ...(policy.commit.conflictScopeResolverKey
        ? { conflictScopeResolverKeys: [policy.commit.conflictScopeResolverKey] }
        : {}),
      ...(policy.commit.settlementKey ? { settlementKeys: [policy.commit.settlementKey] } : {}),
      ...(policy.service ? { serviceKeys: [policy.service.serviceKey] } : {}),
      ...(policy.resources.compound
        ? { topologyKeys: [policy.resources.compound.topologyKey] }
        : {})
    },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  policyRegistry.freeze();
  const diagnosticEntries = [];
  let resourceId = 0;
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 16,
      workerThreadSlots: 16,
      utilityProcessSlots: 4,
      ioHeavySlots: 16,
      memoryBytes: 4 * 1024 * 1024 * 1024
    },
    idFactory: (prefix) => `supervisor-${prefix}-${++resourceId}`
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    entryRegistry,
    validatorRegistry,
    workerThreadAdapter: fake.adapter,
    resourceGovernor,
    diagnostics: (entry) => diagnosticEntries.push(entry),
    ...supervisorOptions
  });
  return { diagnosticEntries, policy, policyRegistry, resourceGovernor, supervisor };
}

function request(overrides = {}) {
  return {
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'supervisor-op',
    jobId: 'supervisor-job',
    workerInstanceId: 'supervisor-worker',
    input: { values: [1, 2], rounds: 2 },
    ...overrides
  };
}

test('公共 API exact：execute 返回 Promise，transport ready 后直接 job:start', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake);
  assert.deepEqual(Object.keys(supervisor).sort(), [
    'cancel', 'closeService', 'execute', 'inspect', 'shutdown', 'start', 'stopAcceptingNewJobs'
  ]);
  const execution = supervisor.execute(request());
  assert.equal(typeof execution.then, 'function');
  assert.equal(supervisor.inspect('supervisor-job').state, 'queued');
  const result = await execution;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(fake.state.sent[0].operation, 'job:start');
  assert.equal(fake.state.sent[0].direction, 'command');
  assert.equal(supervisor.inspect('supervisor-job'), null);
});

function makeWorkerDurable(policy) {
  policy.actionKey = 'test:worker-durable';
  policy.commit = {
    kind: 'worker-durable',
    criticalIntent: true,
    receiptKind: 'module-local',
    inspectorKey: 'inspector.test:worker-durable',
    conflictScopeResolverKey: 'scope.test:worker-durable',
    settlementKey: null
  };
  policy.failure.unitBusinessError = 'collect-and-continue';
}

test('deferred unit在transport ready和job:start后才派发，旧eager路径不变', async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const fake = fakeAdapter({ ready });
  const { supervisor } = harness(fake);
  const control = supervisor.start(request({
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const rejectedDispatch = control.startUnit('file:000000', { fileIndex: 999 });
  await assert.rejects(rejectedDispatch, {
    code: 'UNIT_INPUT_OVERRIDE_FORBIDDEN'
  });
  assert.equal(await rejectedDispatch.dispatchAccepted, false);
  const terminal = control.startUnit('file:000000');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.state.sent, []);
  releaseReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.state.sent.map((message) => message.operation), ['job:start', 'unit:start']);
  assert.equal(await terminal.dispatchAccepted, true);
  fake.state.callbacks.onMessage(eventFor(fake.state.sent[1], 'unit:done', 1, {
    result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
  }, 'file:000000'));
  fake.state.callbacks.onMessage(eventFor(fake.state.sent[0], 'job:done', 2, {
    result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
  }));
  assert.equal((await terminal).status, 'done');
  assert.equal((await control.promise).outcome, 'completed');
});

test('worker-durable逐unit严格执行 persisted prepare/ack、receipt/mark-committed、done gate', async () => {
  const calls = [];
  let finishPrepare;
  const prepareGate = new Promise((resolve) => { finishPrepare = resolve; });
  const coordinator = {
    async prepareAndAck(input) {
      calls.push(['prepare', input.unitId]);
      await prepareGate;
      calls.push(['acked', input.unitId]);
      return { intentId: 'intent-0', fileOperationKey: 'parent/file/000000' };
    },
    async observeReceipt(input) {
      calls.push(['receipt', input.unitId]);
      return { receiptHint: { receiptKind: 'module-local', receiptIdentity: 'receipt-0' } };
    },
    async settleCommitted(input) {
      calls.push(['settled', input.unitId]);
    },
    async resolveUncertain() {
      calls.push(['inspect']);
      return { outcome: 'not-committed' };
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      } else if (message.operation === 'critical:ack') {
        callbacks.onMessage(eventFor(message, 'commit:receipt', 2, {
          receipt: { operationKey: 'parent/file/000000' }
        }, message.unitId));
        callbacks.onMessage(eventFor(message, 'unit:done', 3, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }, message.unitId));
        callbacks.onMessage(eventFor(state.sent[0], 'job:done', 4, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const unitPromise = control.startUnit('file:000000');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.state.sent.map((message) => message.operation), ['job:start', 'unit:start']);
  assert.deepEqual(calls, [['prepare', 'file:000000']]);
  finishPrepare();
  const unit = await unitPromise;
  const result = await control.promise;
  assert.equal(unit.status, 'done');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.receiptHint, null, 'parent多unit不得冒充单receipt identity');
  assert.deepEqual(calls, [
    ['prepare', 'file:000000'],
    ['acked', 'file:000000'],
    ['receipt', 'file:000000'],
    ['settled', 'file:000000']
  ]);
  assert.deepEqual(fake.state.sent.map((message) => message.operation), [
    'job:start', 'unit:start', 'critical:ack'
  ]);
});

test('worker-durable pre-critical transport loss只收口普通file error，不得升级为interrupted', async () => {
  let inspectCount = 0;
  const coordinator = {
    async prepareAndAck() {
      throw new Error('pre-critical transport loss不应prepare');
    },
    async observeReceipt() {},
    async settleCommitted() {},
    async resolveUncertain() {
      inspectCount += 1;
      return { outcome: 'unknown' };
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'unit:start') {
        queueMicrotask(() => callbacks.onExit(17, null));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const terminalPromise = control.startUnit('file:000000');
  assert.equal(await terminalPromise.dispatchAccepted, true);
  const [unit, result] = await Promise.all([terminalPromise, control.promise]);
  assert.equal(unit.status, 'error');
  assert.equal(unit.cleanupOwnership, 'main');
  assert.equal(unit.inspection, null);
  assert.equal(inspectCount, 0);
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.terminalSource, 'unexpected-exit');
});

test('worker-durable ACK后transport loss且inspect not-committed仍是普通file error', async () => {
  let inspectCount = 0;
  const coordinator = {
    async prepareAndAck() {
      return { intentId: 'intent-0', fileOperationKey: 'parent/file/000000' };
    },
    async observeReceipt() {},
    async settleCommitted() {},
    async resolveUncertain() {
      inspectCount += 1;
      return { outcome: 'not-committed' };
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      } else if (message.operation === 'critical:ack') {
        queueMicrotask(() => callbacks.onExit(17, null));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const terminalPromise = control.startUnit('file:000000');
  assert.equal(await terminalPromise.dispatchAccepted, true);
  const [unit, result] = await Promise.all([terminalPromise, control.promise]);
  assert.equal(unit.status, 'error');
  assert.equal(unit.cleanupOwnership, 'main');
  assert.equal(unit.inspection.outcome, 'not-committed');
  assert.equal(inspectCount, 1);
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.terminalSource, 'unexpected-exit');
});

test('worker-durable prepare/ack持久化失败不发ACK且unit保持普通error', async () => {
  const coordinator = {
    async prepareAndAck() {
      throw Object.assign(new Error('atomic prepare/ack failed'), { code: 'TEST_MARK_ACKED_FAILED' });
    },
    async observeReceipt() {},
    async settleCommitted() {},
    async resolveUncertain() {
      throw new Error('Worker未收到ACK，不应inspect');
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const terminalPromise = control.startUnit('file:000000');
  assert.equal(await terminalPromise.dispatchAccepted, true);
  const [unit, result] = await Promise.all([terminalPromise, control.promise]);
  assert.equal(unit.status, 'error');
  assert.equal(unit.cleanupOwnership, 'main');
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.terminalSource, 'protocol-error');
  assert.deepEqual(fake.state.sent.map((message) => message.operation), ['job:start', 'unit:start']);
});

test('worker-durable ACK后unit error必须inspect；committed-lost阻断普通job完成并收口unit promise', async () => {
  const coordinator = {
    async prepareAndAck() {
      return { intentId: 'intent-0', fileOperationKey: 'parent/file/000000' };
    },
    async observeReceipt() {
      throw new Error('不应收到receipt');
    },
    async settleCommitted() {},
    async resolveUncertain() {
      return { outcome: 'committed' };
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      } else if (message.operation === 'critical:ack') {
        callbacks.onMessage(eventFor(message, 'unit:error', 2, {
          error: { code: 'RESULT_LOST', message: 'lost' }
        }, message.unitId));
        callbacks.onMessage(eventFor(state.sent[0], 'job:done', 3, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const unitPromise = control.startUnit('file:000000');
  const unit = await unitPromise;
  const result = await control.promise;
  assert.equal(unit.status, 'interrupted');
  assert.equal(unit.inspection.outcome, 'committed');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.terminalSource, 'protocol-error');
});

test('worker-durable job:error inspect unknown时started unit不得降级为cancelled', async () => {
  const coordinator = {
    async prepareAndAck() {
      return { intentId: 'intent-0', fileOperationKey: 'parent/file/000000' };
    },
    async observeReceipt() {
      throw new Error('不应收到receipt');
    },
    async settleCommitted() {},
    async resolveUncertain() {
      return { outcome: 'unknown' };
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      } else if (message.operation === 'critical:ack') {
        callbacks.onMessage(eventFor(state.sent[0], 'job:error', 2, {
          error: { code: 'SQL_LOST', message: 'writer failed' }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const [unit, result] = await Promise.all([
    control.startUnit('file:000000'),
    control.promise
  ]);
  assert.equal(unit.status, 'interrupted');
  assert.equal(unit.inspection.outcome, 'unknown');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.terminalSource, 'job:error');
});

test('worker-durable inspector异常不悬挂，open Intent语义映射interrupted且started unit确定收口', async () => {
  const coordinator = {
    async prepareAndAck() {
      return { intentId: 'intent-0', fileOperationKey: 'parent/file/000000' };
    },
    async observeReceipt() {
      throw new Error('不应收到receipt');
    },
    async settleCommitted() {},
    async resolveUncertain() {
      throw Object.assign(new Error('inspector unavailable'), { code: 'INSPECTOR_UNAVAILABLE' });
    }
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'unit:start') {
        callbacks.onMessage(eventFor(message, 'critical:ready', 1, {
          critical: { fileOperationKey: 'parent/file/000000' }
        }, message.unitId));
      } else if (message.operation === 'critical:ack') {
        callbacks.onExit(9, null);
      }
    }
  });
  const { supervisor } = harness(fake, makeWorkerDurable, undefined, {
    workerDurableCoordinator: coordinator
  });
  const control = supervisor.start(request({
    actionKey: 'test:worker-durable',
    deferUnitStart: true,
    units: [{ unitId: 'file:000000', input: { fileIndex: 0 } }]
  }));
  const unitPromise = control.startUnit('file:000000');
  const [unit, result] = await Promise.all([unitPromise, control.promise]);
  assert.equal(unit.status, 'interrupted');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.terminalSource, 'unexpected-exit');
});

test('第一个合法 terminal 赢得 settle gate，late terminal 仅诊断不二次 settle', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      callbacks.onMessage(eventFor(message, 'job:done', 1, {
        result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
      }));
      callbacks.onMessage(eventFor(message, 'job:error', 2, {
        error: { name: 'Error', message: 'late', code: 'LATE' }
      }));
    }
  });
  const { diagnosticEntries, supervisor } = harness(fake);
  const result = await supervisor.execute(request());
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(result.result.checksum, 6004);
  assert.ok(diagnosticEntries.some((entry) => entry.type === 'late-message'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
});

test('Supervisor diagnostics 在回调边界统一应用 finance-safe-v1 脱敏', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      callbacks.onMessage(eventFor(message, 'job:progress', 1, { progress: { stage: 'safe' } }));
      callbacks.onMessage(eventFor(message, 'job:done', 2, {
        result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
      }));
      callbacks.onMessage(eventFor(message, 'job:error', 3, {
        error: { name: 'Error', message: 'late', code: 'LATE' }
      }));
    }
  });
  const { diagnosticEntries, supervisor } = harness(fake);
  const result = await supervisor.execute(request({
    jobId: 'ReconID:R-PRIVATE',
    onProgress() {
      throw new Error('file://localhost/Users/alice/private/input.xlsx');
    }
  }));
  assert.equal(result.outcome, 'completed');
  const observerError = diagnosticEntries.find((entry) => entry.type === 'progress-observer-error');
  const lateMessage = diagnosticEntries.find((entry) => entry.type === 'late-message');
  assert.equal(observerError.error.message, '[redacted by finance-safe-v1]');
  assert.equal(lateMessage.jobId, '[redacted by finance-safe-v1]');
});

test('adapter.ready 未完成触发 init-timeout，send 抛错触发 adapter-error 且不悬空', async () => {
  const neverReady = fakeAdapter({ ready: new Promise(() => {}) });
  const timeoutHarness = harness(neverReady);
  const timedOut = await timeoutHarness.supervisor.execute(request({ initTimeoutMs: 5 }));
  assert.equal(timedOut.terminalSource, 'init-timeout');
  assert.equal(timedOut.outcome, 'transport-lost');

  const sendFailure = new Error('postMessage failed');
  sendFailure.code = 'FAKE_SEND_FAILED';
  const throwing = fakeAdapter({ sendError: sendFailure });
  const sendHarness = harness(throwing);
  const failed = await sendHarness.supervisor.execute(request({ jobId: 'send-failure-job' }));
  assert.equal(failed.terminalSource, 'adapter-error');
  assert.equal(failed.error.code, 'FAKE_SEND_FAILED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(throwing.state.terminateCount, 1);
  assert.equal(throwing.state.closeCount, 1);
});

test('job:start send 调用栈内同步 progress/job:error 属于 start 因果链', async () => {
  const progress = [];
  const fake = fakeAdapter({
    synchronousOnSend: true,
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:progress', 1, {
          progress: { stage: 'sync-dispatch' }
        }));
        callbacks.onMessage(eventFor(message, 'job:error', 2, {
          error: { name: 'Error', message: 'sync failure', code: 'SYNC_DISPATCH_FAILED' }
        }));
      }
    }
  });
  const result = await harness(fake).supervisor.execute(request({
    jobId: 'sync-start-dispatch-job',
    onProgress: (value) => progress.push(value)
  }));
  assert.equal(result.terminalSource, 'job:error');
  assert.equal(result.error.code, 'SYNC_DISPATCH_FAILED');
  assert.deepEqual(progress, [{ stage: 'sync-dispatch' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 1);
});

test('adapter.start 调用栈内真正 prestart event 仍 fail closed 且返回 handle 后清理', async () => {
  const start = createJobEnvelope({
    direction: 'command',
    operation: 'job:start',
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'supervisor-op',
    jobId: 'adapter-start-prestart-job',
    workerInstanceId: 'supervisor-worker',
    serviceGeneration: null,
    unitId: null,
    seq: 1,
    context: { kind: 'none', value: {} },
    payload: { input: {} }
  });
  const fake = fakeAdapter({
    onStart(callbacks) {
      callbacks.onMessage(eventFor(start, 'job:error', 1, {
        error: { name: 'Error', message: 'too early', code: 'TOO_EARLY' }
      }));
    }
  });
  const result = await harness(fake).supervisor.execute(request({ jobId: 'adapter-start-prestart-job' }));
  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.error.code, 'PROTOCOL_EVENT_BEFORE_JOB_START');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 1);
});

test('非法 JSON input 在任何 adapter.start 前由 execute request gate 拒绝', async () => {
  const fake = fakeAdapter();
  const { supervisor } = harness(fake);
  await assert.rejects(
    supervisor.execute(request({
      jobId: 'invalid-json-input-job',
      input: { value: Number.NaN }
    })),
    (error) => error.code === 'EXECUTE_REQUEST_NOT_JSON_SAFE'
  );
  assert.equal(fake.state.sent.length, 0);
});

test('execute 在读取 actionKey getter 前先 fail closed，不触发 getter side effect', async () => {
  const fake = fakeAdapter();
  const { supervisor } = harness(fake);
  let getterCalls = 0;
  const executeRequest = request({ jobId: 'getter-action-key-job' });
  Object.defineProperty(executeRequest, 'actionKey', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return canary.PURE_COMPUTE_ACTION_KEY;
    }
  });
  await assert.rejects(
    supervisor.execute(executeRequest),
    (error) => error.code === 'EXECUTE_REQUEST_NOT_JSON_SAFE'
  );
  assert.equal(getterCalls, 0);
  assert.equal(fake.state.sent.length, 0);
});

test('cancel(jobId) 走独立 command seq，私有终态证据而非 ACK 决定 cancelled', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onCancellationTerminal();
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
      callbacks.onMessage(eventFor(start, 'job:error', 2, {
        error: { name: 'Error', message: 'cancelled', code: 'CANARY_CANCELLED' }
      }));
    }
  });
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const executeRequest = request();
  const execution = supervisor.execute(executeRequest);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    supervisor.cancel('supervisor-job', 'must-remain-an-object'),
    (error) => error.code === 'CANCEL_REASON_INVALID'
  );
  const cancelResult = await supervisor.cancel('supervisor-job', { reason: 'test' });
  assert.equal(cancelResult.accepted, true);
  const result = await execution;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'job:error');
  assert.deepEqual(fake.state.sent.map((message) => [message.operation, message.seq]), [
    ['job:start', 1],
    ['job:cancel', 2]
  ]);
  assert.deepEqual(fake.state.sent[1].payload.cancel, { reason: 'test' });
  assert.equal(Object.prototype.hasOwnProperty.call(executeRequest, 'cancelReason'), false);
});

test('cancel command/ack 状态机拒绝 unsolicited/duplicate，command-only terminal 不冒充 cancelled', async () => {
  const unsolicited = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'cancel:ack', 1, {
          cancellation: { acknowledged: true }
        }));
      }
    }
  });
  let result = await harness(unsolicited).supervisor.execute(request({ jobId: 'unsolicited-cancel-ack-job' }));
  assert.equal(result.error.code, 'PROTOCOL_UNSOLICITED_CANCEL_ACK');

  const duplicate = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
      callbacks.onMessage(eventFor(start, 'cancel:ack', 2, {
        cancellation: { acknowledged: true }
      }));
    }
  });
  const duplicateHarness = harness(duplicate, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const duplicateExecution = duplicateHarness.supervisor.execute(request({ jobId: 'duplicate-cancel-ack-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await duplicateHarness.supervisor.cancel('duplicate-cancel-ack-job', { reason: 'duplicate-ack' });
  result = await duplicateExecution;
  assert.equal(result.error.code, 'PROTOCOL_DUPLICATE_CANCEL_ACK');

  const unrelatedWithoutAck = fakeAdapter({
    synchronousOnSend: true,
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'job:error', 1, {
        error: { name: 'Error', message: 'executor failed after cancel command', code: 'EXECUTOR_FAILED' }
      }));
    }
  });
  const terminalHarness = harness(unrelatedWithoutAck, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const terminalExecution = terminalHarness.supervisor.execute(request({ jobId: 'unrelated-no-ack-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await terminalHarness.supervisor.cancel('unrelated-no-ack-job', { reason: 'unrelated-failure' });
  result = await terminalExecution;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'EXECUTOR_FAILED');

  const unrelatedAfterAck = fakeAdapter({
    synchronousOnSend: true,
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
      callbacks.onMessage(eventFor(start, 'job:error', 2, {
        error: { name: 'Error', message: 'unrelated executor failure', code: 'EXECUTOR_FAILED' }
      }));
    }
  });
  const ackOnlyHarness = harness(unrelatedAfterAck, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const ackOnlyExecution = ackOnlyHarness.supervisor.execute(request({ jobId: 'unrelated-after-ack-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await ackOnlyHarness.supervisor.cancel('unrelated-after-ack-job', { reason: 'unrelated-failure' });
  result = await ackOnlyExecution;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'EXECUTOR_FAILED');

  const privatelyProvenTerminal = fakeAdapter({
    synchronousOnSend: true,
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onCancellationTerminal();
      callbacks.onMessage(eventFor(start, 'job:error', 1, {
        error: { name: 'Error', message: 'legacy void cancel', code: 'LEGACY_CANCELLED' }
      }));
    }
  });
  const privateEvidenceHarness = harness(privatelyProvenTerminal, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const privateEvidenceExecution = privateEvidenceHarness.supervisor.execute(request({
    jobId: 'private-cancel-terminal-evidence-job'
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await privateEvidenceHarness.supervisor.cancel(
    'private-cancel-terminal-evidence-job',
    { reason: 'legacy-void' }
  );
  result = await privateEvidenceExecution;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.error.code, 'LEGACY_CANCELLED');

  const nonCanonicalAck = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      const invalid = structuredClone(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: false }
      }));
      invalid.payload.cancellation = { acknowledged: false };
      callbacks.onMessage(invalid);
    }
  });
  const nonCanonicalHarness = harness(nonCanonicalAck, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
  });
  const nonCanonicalExecution = nonCanonicalHarness.supervisor.execute(request({ jobId: 'noncanonical-ack-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await nonCanonicalHarness.supervisor.cancel('noncanonical-ack-job', { reason: 'invalid-ack' });
  result = await nonCanonicalExecution;
  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.error.code, 'PROTOCOL_CANCELLATION_ACK_INVALID');
});

test('Existing 同 tick reject 先于 cancel 时保持 failed；同步 void cancel 引发的 reject 保持 cancelled', async () => {
  async function runExistingRace({ jobId, rejectBeforeCancel }) {
    let rejectDispatch;
    let cancelCalls = 0;
    const transport = createExistingDispatchTransportAdapter(createExistingDispatchAdapter({
      dispatch() {
        return {
          promise: new Promise((_resolve, reject) => { rejectDispatch = reject; }),
          cancel() {
            cancelCalls += 1;
            if (!rejectBeforeCancel) {
              const error = new Error('legacy void cancellation terminal');
              error.code = 'LEGACY_VOID_CANCELLED';
              rejectDispatch(error);
            }
          }
        };
      }
    }));
    const raceHarness = harness({ adapter: transport }, (policy) => {
      policy.cancellation.capability = 'user-cooperative';
    });
    const execution = raceHarness.supervisor.execute(request({ jobId }));
    await new Promise((resolve) => setImmediate(resolve));
    if (rejectBeforeCancel) {
      const error = new Error('dispatcher failed before cancellation');
      error.code = 'EXECUTOR_FAILED';
      rejectDispatch(error);
    }
    const cancelResult = await raceHarness.supervisor.cancel(jobId, { reason: 'same-tick-race' });
    assert.equal(cancelResult.accepted, true);
    return { cancelCalls: () => cancelCalls, result: await execution };
  }

  const failed = await runExistingRace({ jobId: 'existing-reject-before-cancel-job', rejectBeforeCancel: true });
  assert.equal(failed.result.outcome, 'failed');
  assert.equal(failed.result.error.code, 'EXECUTOR_FAILED');
  assert.equal(failed.cancelCalls(), 0);

  const cancelled = await runExistingRace({ jobId: 'existing-void-cancel-race-job', rejectBeforeCancel: false });
  assert.equal(cancelled.result.outcome, 'cancelled');
  assert.equal(cancelled.result.error.code, 'LEGACY_VOID_CANCELLED');
  assert.equal(cancelled.cancelCalls(), 1);
});

test('public cancel 拒绝 shutdown-only；shutdown 使用独立内部取消路径', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onCancellationTerminal();
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
      callbacks.onMessage(eventFor(start, 'job:error', 2, {
        error: { name: 'Error', message: 'shutdown cancelled', code: 'SHUTDOWN_CANCELLED' }
      }));
    }
  });
  const { supervisor } = harness(fake);
  const execution = supervisor.execute(request({ jobId: 'shutdown-only-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await supervisor.cancel('shutdown-only-job', { reason: 'user-requested' }), {
    jobId: 'shutdown-only-job',
    accepted: false,
    status: 'not-cancellable'
  });
  const report = await supervisor.shutdown({ timeoutMs: 100 });
  const result = await execution;
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(report.cancelledJobs, ['shutdown-only-job']);
  assert.deepEqual(report.protectedJobs, []);
});

test('unexpected exit、execution timeout、cancel timeout 各自使用唯一权威 terminalSource', async () => {
  const exited = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') callbacks.onExit(9, null);
    }
  });
  const exitedResult = await harness(exited).supervisor.execute(request({ jobId: 'exit-job' }));
  assert.equal(exitedResult.terminalSource, 'unexpected-exit');

  const silent = fakeAdapter();
  const timedResult = await harness(silent).supervisor.execute(request({
    jobId: 'execution-timeout-job',
    executionTimeoutMs: 5
  }));
  assert.equal(timedResult.terminalSource, 'execution-timeout');

  const ackOnly = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
    }
  });
  const cancelHarness = harness(ackOnly, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
    policy.cancellation.cooperativeTimeoutMs = 5;
  });
  const cancelExecution = cancelHarness.supervisor.execute(request({ jobId: 'cancel-timeout-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await cancelHarness.supervisor.cancel('cancel-timeout-job', { reason: 'timeout-test' });
  const cancelTimedOut = await cancelExecution;
  assert.equal(cancelTimedOut.terminalSource, 'cancel-timeout');
});

test('incoming route/seq violation 均 fail closed 为 protocol-error', async () => {
  const badSequence = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:progress', 2, { progress: { rows: 1 } }));
      }
    }
  });
  const sequenceResult = await harness(badSequence).supervisor.execute(request({ jobId: 'bad-seq-job' }));
  assert.equal(sequenceResult.terminalSource, 'protocol-error');
  assert.equal(sequenceResult.error.code, 'PROTOCOL_SEQUENCE_INVALID');

  const badRoute = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      const routedElsewhere = structuredClone(eventFor(message, 'job:progress', 1, { progress: {} }));
      routedElsewhere.workerInstanceId = 'different-worker';
      callbacks.onMessage(routedElsewhere);
    }
  });
  const routeResult = await harness(badRoute).supervisor.execute(request({ jobId: 'bad-route-job' }));
  assert.equal(routeResult.terminalSource, 'protocol-error');
  assert.equal(routeResult.error.code, 'PROTOCOL_ROUTE_MISMATCH');
});

test('progress rate limit 按 job/direction 使用 1000ms sliding window，边界稳定释放', async () => {
  let clock = 0;
  const observed = [];
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      callbacks.onMessage(eventFor(message, 'job:progress', 1, { progress: { index: 1 } }));
      callbacks.onMessage(eventFor(message, 'job:progress', 2, { progress: { index: 2 } }));
      if (message.jobId === 'progress-boundary-job') {
        clock = 1000;
        callbacks.onMessage(eventFor(message, 'job:progress', 3, { progress: { index: 3 } }));
        callbacks.onMessage(eventFor(message, 'job:done', 4, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      } else {
        callbacks.onMessage(eventFor(message, 'job:progress', 3, { progress: { index: 3 } }));
      }
    }
  });
  const { supervisor } = harness(fake, (policy) => {
    policy.metrics.progressRateLimitPerSecond = 2;
  }, canary.validatePureComputeCanaryResult, { now: () => clock });

  let result = await supervisor.execute(request({
    jobId: 'progress-boundary-job',
    onProgress: (progress) => observed.push(progress.index)
  }));
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(observed, [1, 2, 3]);

  result = await supervisor.execute(request({ jobId: 'progress-overflow-job' }));
  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.error.code, 'PROTOCOL_PROGRESS_RATE_LIMIT_EXCEEDED');
});

test('unknown unit 与未终结 registered unit 的 job:done gate 均拒绝', async () => {
  const unknownUnit = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'unit:done', 1, { result: {} }, 'unknown-unit'));
      }
    }
  });
  const unknownResult = await harness(unknownUnit).supervisor.execute(request({ jobId: 'unknown-unit-job' }));
  assert.equal(unknownResult.terminalSource, 'protocol-error');
  assert.equal(unknownResult.error.code, 'PROTOCOL_UNKNOWN_UNIT');

  const prematureDone = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const gateResult = await harness(prematureDone).supervisor.execute(request({
    jobId: 'unit-gate-job',
    units: [{ unitId: 'unit-1', input: {} }]
  }));
  assert.equal(gateResult.terminalSource, 'protocol-error');
  assert.equal(gateResult.error.code, 'PROTOCOL_JOB_DONE_GATE_FAILED');
});

test('policy 允许的 unit:error 可通过 job:done gate', async () => {
  const collecting = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'unit:start') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'unit:error', 1, {
        error: { name: 'Error', message: 'unit failed', code: 'UNIT_FAILED' }
      }, message.unitId));
      callbacks.onMessage(eventFor(start, 'job:done', 2, {
        result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
      }));
    }
  });
  const collectHarness = harness(collecting, (policy) => {
    policy.failure.unitBusinessError = 'collect-and-continue';
  });
  const result = await collectHarness.supervisor.execute(request({
    jobId: 'collect-unit-error-job',
    units: [{ unitId: 'unit-1', input: {} }]
  }));
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(result.outcome, 'completed');
});

test('unit terminal immutable，重复 terminal/progress 不可改写已终结 unit', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'unit:start') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'unit:done', 1, {
        result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
      }, message.unitId));
      callbacks.onMessage(eventFor(start, 'unit:error', 2, {
        error: { name: 'Error', message: 'late mutation', code: 'LATE_UNIT_ERROR' }
      }, message.unitId));
    }
  });
  const result = await harness(fake).supervisor.execute(request({
    jobId: 'immutable-unit-job',
    units: [{ unitId: 'unit-1', input: {} }]
  }));
  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.error.code, 'PROTOCOL_UNIT_TERMINAL_IMMUTABLE');
});

test('unit:done 与 job:done result 都同步执行严格 validator', async () => {
  let validationCount = 0;
  const strictValidator = (value) => {
    validationCount += 1;
    return { valid: value && value.checksum === 6004 };
  };
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'unit:start') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      const result = { checksum: 6004, count: 2, rounds: 2, sum: 3 };
      callbacks.onMessage(eventFor(start, 'unit:done', 1, { result }, message.unitId));
      callbacks.onMessage(eventFor(start, 'job:done', 2, { result }));
    }
  });
  const result = await harness(fake, null, strictValidator).supervisor.execute(request({
    jobId: 'unit-and-job-result-validation',
    units: [{ unitId: 'unit-1', input: {} }]
  }));
  assert.equal(result.outcome, 'completed');
  assert.equal(validationCount, 2);

  const invalidUnit = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'unit:start') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'unit:done', 1, { result: { checksum: 1 } }, message.unitId));
    }
  });
  const invalidResult = await harness(invalidUnit, null, strictValidator).supervisor.execute(request({
    jobId: 'invalid-unit-result',
    units: [{ unitId: 'unit-1', input: {} }]
  }));
  assert.equal(invalidResult.terminalSource, 'protocol-error');
  assert.equal(invalidResult.error.code, 'RESULT_VALIDATION_FAILED');
});

test('result maxBytes 与 result validator 都在 settle 前 fail closed', async () => {
  const oversized = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const sizeHarness = harness(oversized, (policy) => {
    policy.result.maxBytes = 1;
  });
  const sizeResult = await sizeHarness.supervisor.execute(request({ jobId: 'result-size-job' }));
  assert.equal(sizeResult.terminalSource, 'protocol-error');
  assert.equal(sizeResult.error.code, 'PROTOCOL_RESULT_TOO_LARGE');

  const invalid = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, { result: { unexpected: true } }));
      }
    }
  });
  const validationResult = await harness(invalid).supervisor.execute(request({ jobId: 'result-validator-job' }));
  assert.equal(validationResult.terminalSource, 'protocol-error');
  assert.equal(validationResult.error.code, 'RESULT_VALIDATION_FAILED');
});

test('validator function/validate 严格返回；assertValid 不抛即成功且两类 thenable 均拒绝', async () => {
  function completingFake() {
    return fakeAdapter({
      onSend(message, callbacks) {
        if (message.operation === 'job:start') {
          callbacks.onMessage(eventFor(message, 'job:done', 1, {
            result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
          }));
        }
      }
    });
  }

  let result = await harness(completingFake(), null, () => undefined).supervisor.execute(request({
    jobId: 'undefined-validator-result'
  }));
  assert.equal(result.error.code, 'RESULT_VALIDATION_FAILED');

  result = await harness(completingFake(), null, () => Promise.resolve(true)).supervisor.execute(request({
    jobId: 'thenable-validator-result'
  }));
  assert.equal(result.error.code, 'RESULT_VALIDATOR_ASYNC_UNSUPPORTED');

  result = await harness(completingFake(), null, () => ({ valid: true })).supervisor.execute(request({
    jobId: 'valid-object-validator-result'
  }));
  assert.equal(result.outcome, 'completed');

  result = await harness(completingFake(), null, {
    validate() {}
  }).supervisor.execute(request({ jobId: 'validate-undefined-result' }));
  assert.equal(result.error.code, 'RESULT_VALIDATION_FAILED');

  result = await harness(completingFake(), null, {
    assertValid() {}
  }).supervisor.execute(request({ jobId: 'assert-valid-undefined-result' }));
  assert.equal(result.outcome, 'completed');

  result = await harness(completingFake(), null, {
    assertValid() { return Promise.resolve(); }
  }).supervisor.execute(request({ jobId: 'assert-valid-thenable-result' }));
  assert.equal(result.error.code, 'RESULT_VALIDATOR_ASYNC_UNSUPPORTED');

  let facadeCalls = 0;
  const facade = {
    get() { facadeCalls += 1; return () => true; },
    has() { facadeCalls += 1; return true; }
  };
  assert.throws(
    () => validateResultBody(canary.pureComputePolicy, {
      checksum: 6004, count: 2, rounds: 2, sum: 3
    }, facade),
    (error) => error.code === 'RESULT_VALIDATOR_MISSING'
  );
  assert.equal(facadeCalls, 0);
});

test('first terminal 后 execute 仅在 bounded terminate/close settle pipeline 完整收口后 resolve', async () => {
  let resolveTerminate;
  const terminateGate = new Promise((resolve) => { resolveTerminate = resolve; });
  const fake = fakeAdapter({
    terminate: () => terminateGate,
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.terminateTimeoutMs = 100;
  });
  let resolved = false;
  const execution = supervisor.execute(request({ jobId: 'settle-pipeline-job' })).then((result) => {
    resolved = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 0);
  assert.equal(resolved, false);
  resolveTerminate(0);
  const result = await execution;
  assert.equal(result.outcome, 'completed');
  assert.equal(fake.state.closeCount, 1);
  assert.equal(supervisor.inspect('settle-pipeline-job'), null);
});

test('execute 全 request own-data/类型 gate 与 canonical snapshot 在 adapter.start 前生效', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      assert.deepEqual(message.payload.input, { values: [1, 2], rounds: 2 });
      callbacks.onMessage(eventFor(message, 'job:done', 1, {
        result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
      }));
    }
  });
  const { supervisor } = harness(fake);
  const executeRequest = request({ jobId: 'request-snapshot-job' });
  const execution = supervisor.execute(executeRequest);
  executeRequest.input.values[0] = 999;
  assert.equal((await execution).outcome, 'completed');

  await assert.rejects(
    supervisor.execute(request({ jobId: 'numeric-action-job', actionKey: 1 })),
    (error) => error.code === 'EXECUTE_REQUEST_FIELD_INVALID'
  );
  await assert.rejects(
    supervisor.execute(request({ jobId: 'undefined-callback-job', onProgress: undefined })),
    (error) => error.code === 'EXECUTE_REQUEST_CALLBACK_INVALID'
  );

  let callbackGetterCalls = 0;
  const callbackAccessor = request({ jobId: 'callback-accessor-job' });
  Object.defineProperty(callbackAccessor, 'onProgress', {
    enumerable: true,
    get() {
      callbackGetterCalls += 1;
      return () => {};
    }
  });
  await assert.rejects(
    supervisor.execute(callbackAccessor),
    (error) => error.code === 'EXECUTE_REQUEST_NOT_JSON_SAFE'
  );
  assert.equal(callbackGetterCalls, 0);

  await assert.rejects(
    supervisor.execute(request({
      jobId: 'invalid-context-before-start-job',
      context: { kind: 'none', value: { unexpected: true } }
    })),
    (error) => error.code === 'PROTOCOL_SCHEMA_INVALID'
  );
  assert.equal(fake.state.sent.length, 1);
});

test('terminal result/error 取 owned deep-frozen snapshot，producer 后改不影响 truth', async () => {
  const producerResult = { checksum: 6004, count: 2, rounds: 2, sum: 3 };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation !== 'job:start') return;
      callbacks.onMessage(eventFor(message, 'job:done', 1, { result: producerResult }));
      producerResult.checksum = 1;
    }
  });
  const result = await harness(fake).supervisor.execute(request({ jobId: 'owned-terminal-job' }));
  assert.equal(result.result.checksum, 6004);
  assert.equal(Object.isFrozen(result.result), true);
  assert.equal(result.error, null);

  const privateSpawnError = new Error('failed at /Users/alice/private-worker.js');
  privateSpawnError.code = 'SPAWN_PRIVATE';
  privateSpawnError.stack = 'private stack';
  privateSpawnError.cause = new Error('private cause');
  const spawnFake = fakeAdapter({ onStart() { throw privateSpawnError; } });
  const failed = await harness(spawnFake).supervisor.execute(request({ jobId: 'safe-spawn-error-job' }));
  assert.deepEqual(Object.keys(failed.error), ['code', 'message', 'stage', 'detailLines']);
  assert.equal(failed.error.message, '[redacted by finance-safe-v1]');
  assert.equal(Object.isFrozen(failed.error), true);
});

test('shutdown 有界：non-cancellable + 不退出 transport 进入 protected/leaked/errors 权威报告字段', async () => {
  const fake = fakeAdapter({ terminate: () => new Promise(() => {}) });
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.capability = 'not-supported';
    policy.cancellation.terminateTimeoutMs = 5;
  });
  const execution = supervisor.execute(request({ jobId: 'stuck-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  const report = await supervisor.shutdown({ timeoutMs: 5 });
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(Object.keys(report), [
    'closedServices',
    'cancelledJobs',
    'protectedJobs',
    'interruptedTasks',
    'activeHolds',
    'leakedTransports',
    'errors'
  ]);
  assert.deepEqual(report.protectedJobs, ['stuck-job']);
  assert.deepEqual(report.leakedTransports, ['stuck-job']);
  assert.ok(report.errors.some((error) => error.code === 'SHUTDOWN_TIMEOUT'));
  const result = await execution;
  assert.equal(result.terminalSource, 'adapter-error');
  assert.equal(result.error.code, 'SHUTDOWN_TIMEOUT');
  assert.equal(fake.state.closeCount, 1);
});

test('shutdown 也追踪已 settle 但 terminate 悬挂的 transport', async () => {
  const fake = fakeAdapter({
    terminate: () => new Promise(() => {}),
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.terminateTimeoutMs = 5;
  });
  const result = await supervisor.execute(request({ jobId: 'settled-leak-job' }));
  assert.equal(result.outcome, 'completed');
  assert.equal(fake.state.closeCount, 1);
  await assert.rejects(
    supervisor.execute(request({ jobId: 'settled-leak-job' })),
    (error) => error.code === 'JOB_ID_DUPLICATE'
  );
  const report = await supervisor.shutdown({ timeoutMs: 5 });
  assert.deepEqual(report.leakedTransports, ['settled-leak-job']);
  assert.ok(report.errors.some((error) => error.code === 'TRANSPORT_TERMINATE_TIMEOUT'));
});

test('terminate/close 独立 exactly-once，双失败均保留且阻止 jobId 复用', async () => {
  const terminateError = new Error('terminate rejected');
  terminateError.code = 'TRANSPORT_TERMINATE_REJECTED';
  const closeError = new Error('close rejected');
  closeError.code = 'TRANSPORT_CLOSE_REJECTED';
  const fake = fakeAdapter({
    terminate: () => Promise.reject(terminateError),
    close: () => Promise.reject(closeError),
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake);
  const result = await supervisor.execute(request({ jobId: 'terminate-rejection-job' }));
  assert.equal(result.outcome, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 1);
  await assert.rejects(
    supervisor.execute(request({ jobId: 'terminate-rejection-job' })),
    (error) => error.code === 'JOB_ID_DUPLICATE'
  );
  const report = await supervisor.shutdown({ timeoutMs: 20 });
  assert.deepEqual(report.leakedTransports, ['terminate-rejection-job']);
  assert.ok(report.errors.some((error) => error.code === 'TRANSPORT_TERMINATE_REJECTED'));
  assert.ok(report.errors.some((error) => error.code === 'TRANSPORT_CLOSE_REJECTED'));
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 1);
});

test('transport cleanup 成功后 jobId/worker route 仍是永久 one-shot tombstone', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake);
  const result = await supervisor.execute(request({ jobId: 'reusable-after-cleanup-job' }));
  assert.equal(result.outcome, 'completed');
  await assert.rejects(
    supervisor.execute(request({ jobId: 'reusable-after-cleanup-job' })),
    (error) => error.code === 'JOB_ID_DUPLICATE'
  );
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(fake.state.closeCount, 1);
});

test('shutdown 不把已在 cooperative cancelling 的 job 误报为 protected', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks, state) {
      if (message.operation !== 'job:cancel') return;
      const start = state.sent.find((item) => item.operation === 'job:start');
      callbacks.onMessage(eventFor(start, 'cancel:ack', 1, {
        cancellation: { acknowledged: true }
      }));
    }
  });
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.capability = 'user-cooperative';
    policy.cancellation.cooperativeTimeoutMs = 100;
  });
  const execution = supervisor.execute(request({ jobId: 'already-cancelling-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.cancel('already-cancelling-job', { reason: 'user-requested' });
  const report = await supervisor.shutdown({ timeoutMs: 5 });
  assert.deepEqual(report.protectedJobs, []);
  const result = await execution;
  assert.equal(result.error.code, 'SHUTDOWN_TIMEOUT');
});

test('stopAcceptingNewJobs fail closed，closeService 委托并对未托管 service 返回 false', async () => {
  const fake = fakeAdapter();
  const { supervisor } = harness(fake);
  assert.equal(await supervisor.closeService('service.not-owned'), false);
  supervisor.stopAcceptingNewJobs();
  await assert.rejects(
    supervisor.execute(request()),
    (error) => error.code === 'SUPERVISOR_NOT_ACCEPTING'
  );
});

test('default Supervisor shutdown wire-drains a persistent service before cooperative close', async () => {
  let initCommand = null;
  let jobStart = null;
  let serviceEventSeq = 0;
  const serviceTrace = [];
  const requestOwner = {
    kind: 'service-state',
    ownerKeyHash: 'supervisor-graceful-state',
    candidateRevision: 1
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      function emitService(operation, controlId, jobRef, payload) {
        serviceEventSeq += 1;
        const event = createServiceControlEnvelope({
          direction: 'event',
          operation,
          serviceKey: initCommand.serviceKey,
          controlId,
          workerInstanceId: initCommand.workerInstanceId,
          serviceGeneration: initCommand.serviceGeneration,
          seq: serviceEventSeq,
          jobRef,
          payload
        }, { validate: false });
        serviceTrace.push(event);
        callbacks.onMessage(event);
      }

      if (message.channel === 'service-control') serviceTrace.push(message);
      if (message.operation === 'executor:init') {
        initCommand = message;
        emitService('executor:ready', 'supervisor-graceful-ready', null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1']
        });
      } else if (message.operation === 'job:start') {
        jobStart = message;
        emitService('resource:request', 'supervisor-graceful-request', {
          actionKey: message.actionKey,
          operationKey: message.operationKey,
          jobId: message.jobId,
          unitId: null
        }, {
          requestId: 'supervisor-graceful-request',
          requestKind: 'persistent-state-replace',
          requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: null,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:grant') {
        emitService('resource:adopted', 'supervisor-graceful-adopted', message.jobRef, {
          requestId: message.payload.requestId,
          grantId: message.payload.grantId,
          reservationId: message.payload.reservationId,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:adopt-ack') {
        callbacks.onMessage(createJobEnvelope({
          direction: 'event',
          operation: 'job:done',
          actionKey: jobStart.actionKey,
          operationKey: jobStart.operationKey,
          jobId: jobStart.jobId,
          workerInstanceId: jobStart.workerInstanceId,
          serviceGeneration: jobStart.serviceGeneration,
          unitId: null,
          seq: 1,
          context: jobStart.context,
          payload: { result: { checksum: 6004, count: 2, rounds: 2, sum: 3 } }
        }));
      } else if (message.operation === 'resource:revoke') {
        emitService('resource:release', message.controlId, message.jobRef, {
          reservationId: message.payload.reservationId,
          reason: 'service-close'
        });
      } else if (message.operation === 'executor:close') {
        emitService('executor:close-ack', message.controlId, null, {});
      }
    }
  });
  const { policyRegistry, resourceGovernor, supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.supervisor-graceful');
  });

  const result = await supervisor.execute(request({ jobId: 'supervisor-graceful-job' }));
  assert.equal(result.terminalSource, 'job:done');
  const report = await supervisor.shutdown({ timeoutMs: 100 });

  assert.deepEqual(report.closedServices, ['service.supervisor-graceful']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(serviceTrace.map((message) => message.operation), [
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
  const validation = validateProtocolSequence(serviceTrace, { policyRegistry });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
});

test('Supervisor normal terminal waits for adopted phase detach handshake before default shutdown', async () => {
  let initCommand = null;
  let jobStart = null;
  let revokeCommand = null;
  let emitServiceEvent = null;
  let serviceEventSeq = 0;
  const serviceTrace = [];
  const requestOwner = {
    kind: 'phase',
    ownerKeyHash: 'supervisor-detach-phase',
    candidateRevision: 1
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      function emitService(operation, controlId, jobRef, payload) {
        serviceEventSeq += 1;
        const event = createServiceControlEnvelope({
          direction: 'event',
          operation,
          serviceKey: initCommand.serviceKey,
          controlId,
          workerInstanceId: initCommand.workerInstanceId,
          serviceGeneration: initCommand.serviceGeneration,
          seq: serviceEventSeq,
          jobRef,
          payload
        }, { validate: false });
        serviceTrace.push(event);
        callbacks.onMessage(event);
      }
      emitServiceEvent = emitService;

      if (message.channel === 'service-control') serviceTrace.push(message);
      if (message.operation === 'executor:init') {
        initCommand = message;
        emitService('executor:ready', 'supervisor-detach-ready', null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1']
        });
      } else if (message.operation === 'job:start') {
        jobStart = message;
        emitService('resource:request', 'supervisor-detach-request-control', {
          actionKey: message.actionKey,
          operationKey: message.operationKey,
          jobId: message.jobId,
          unitId: null
        }, {
          requestId: 'supervisor-detach-request',
          requestKind: 'phase-extension',
          requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: null,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:grant') {
        emitService('resource:adopted', 'supervisor-detach-adopted', message.jobRef, {
          requestId: message.payload.requestId,
          grantId: message.payload.grantId,
          reservationId: message.payload.reservationId,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:adopt-ack') {
        callbacks.onMessage(createJobEnvelope({
          direction: 'event',
          operation: 'job:done',
          actionKey: jobStart.actionKey,
          operationKey: jobStart.operationKey,
          jobId: jobStart.jobId,
          workerInstanceId: jobStart.workerInstanceId,
          serviceGeneration: jobStart.serviceGeneration,
          unitId: null,
          seq: 1,
          context: jobStart.context,
          payload: { result: { checksum: 6004, count: 2, rounds: 2, sum: 3 } }
        }));
      } else if (message.operation === 'resource:revoke') {
        revokeCommand = message;
      } else if (message.operation === 'executor:close') {
        emitService('executor:close-ack', message.controlId, null, {});
      }
    }
  });
  const { policyRegistry, resourceGovernor, supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.supervisor-detach-phase');
  });

  let executionSettled = false;
  const execution = supervisor.execute(request({ jobId: 'supervisor-detach-phase-job' }))
    .finally(() => { executionSettled = true; });
  for (let attempt = 0; attempt < 5 && !revokeCommand; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(revokeCommand);
  assert.equal(executionSettled, false);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 3);

  emitServiceEvent('resource:release', revokeCommand.controlId, revokeCommand.jobRef, {
    reservationId: revokeCommand.payload.reservationId,
    reason: 'phase-complete'
  });
  const result = await execution;
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 1);

  const report = await supervisor.shutdown({ timeoutMs: 100 });
  assert.deepEqual(report.closedServices, ['service.supervisor-detach-phase']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(serviceTrace.map((message) => message.operation), [
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
  const validation = validateProtocolSequence(serviceTrace, { policyRegistry });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
});

test('Supervisor successful interaction result retains token until null-ref expiry then shuts down leak-free', async () => {
  let initCommand = null;
  let jobStart = null;
  let tokenReservationId = null;
  let emitServiceEvent = null;
  let serviceEventSeq = 0;
  const serviceTrace = [];
  const requestOwner = {
    kind: 'interaction-token',
    ownerKeyHash: 'supervisor-published-token',
    candidateRevision: 1
  };
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      function emitService(operation, controlId, jobRef, payload) {
        serviceEventSeq += 1;
        const event = createServiceControlEnvelope({
          direction: 'event',
          operation,
          serviceKey: initCommand.serviceKey,
          controlId,
          workerInstanceId: initCommand.workerInstanceId,
          serviceGeneration: initCommand.serviceGeneration,
          seq: serviceEventSeq,
          jobRef,
          payload
        }, { validate: false });
        serviceTrace.push(event);
        callbacks.onMessage(event);
      }
      emitServiceEvent = emitService;

      if (message.channel === 'service-control') serviceTrace.push(message);
      if (message.operation === 'executor:init') {
        initCommand = message;
        emitService('executor:ready', 'supervisor-token-ready', null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1']
        });
      } else if (message.operation === 'job:start') {
        jobStart = message;
        emitService('resource:request', 'supervisor-token-request-control', {
          actionKey: message.actionKey,
          operationKey: message.operationKey,
          jobId: message.jobId,
          unitId: null
        }, {
          requestId: 'supervisor-token-request',
          requestKind: 'pending-interaction-create',
          requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: null,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:grant') {
        tokenReservationId = message.payload.reservationId;
        emitService('resource:adopted', 'supervisor-token-adopted', message.jobRef, {
          requestId: message.payload.requestId,
          grantId: message.payload.grantId,
          reservationId: message.payload.reservationId,
          owner: requestOwner
        });
      } else if (message.operation === 'resource:adopt-ack') {
        callbacks.onMessage(createJobEnvelope({
          direction: 'event',
          operation: 'job:done',
          actionKey: jobStart.actionKey,
          operationKey: jobStart.operationKey,
          jobId: jobStart.jobId,
          workerInstanceId: jobStart.workerInstanceId,
          serviceGeneration: jobStart.serviceGeneration,
          unitId: null,
          seq: 1,
          context: jobStart.context,
          payload: { result: { checksum: 6004, count: 2, rounds: 2, sum: 3 } }
        }));
      } else if (message.operation === 'executor:close') {
        emitService('executor:close-ack', message.controlId, null, {});
      }
    }
  });
  const { policyRegistry, resourceGovernor, supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.supervisor-published-token');
  });

  const result = await supervisor.execute(request({ jobId: 'supervisor-published-token-job' }));
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(result.outcome, 'completed');
  assert.ok(tokenReservationId);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 2);
  assert.equal(
    resourceGovernor.snapshot().activeUsage.memoryBytes,
    canary.pureComputePolicy.resources.base.memoryBytes + 1
  );
  assert.equal(serviceTrace.some((message) => message.operation === 'resource:revoke'), false);

  emitServiceEvent('resource:release', 'supervisor-token-expired', null, {
    reservationId: tokenReservationId,
    reason: 'token-expired'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serviceTrace.some((message) =>
    message.operation === 'resource:release-ack' &&
    message.payload.reservationId === tokenReservationId), true);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 1);

  const report = await supervisor.shutdown({ timeoutMs: 100 });
  assert.deepEqual(report.closedServices, ['service.supervisor-published-token']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(serviceTrace.map((message) => message.operation), [
    'executor:init',
    'executor:ready',
    'resource:request',
    'resource:grant',
    'resource:adopted',
    'resource:adopt-ack',
    'resource:release',
    'resource:release-ack',
    'executor:close',
    'executor:close-ack'
  ]);
  const validation = validateProtocolSequence(serviceTrace, { policyRegistry });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0);
  assert.deepEqual(resourceGovernor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
});

test('Supervisor job:error and cooperative-cancel terminals both revoke interaction tokens before settle', async () => {
  for (const terminal of ['job-error', 'cancel']) {
    let initCommand = null;
    let jobStart = null;
    let serviceEventSeq = 0;
    let jobEventSeq = 0;
    let markTokenReady;
    const tokenReady = new Promise((resolve) => { markTokenReady = resolve; });
    const serviceTrace = [];
    const requestOwner = {
      kind: 'interaction-token',
      ownerKeyHash: `supervisor-${terminal}-token`,
      candidateRevision: 1
    };
    const fake = fakeAdapter({
      onSend(message, callbacks) {
        function emitService(operation, controlId, jobRef, payload) {
          serviceEventSeq += 1;
          const event = createServiceControlEnvelope({
            direction: 'event',
            operation,
            serviceKey: initCommand.serviceKey,
            controlId,
            workerInstanceId: initCommand.workerInstanceId,
            serviceGeneration: initCommand.serviceGeneration,
            seq: serviceEventSeq,
            jobRef,
            payload
          }, { validate: false });
          serviceTrace.push(event);
          callbacks.onMessage(event);
        }
        function emitJob(operation, payload) {
          jobEventSeq += 1;
          callbacks.onMessage(createJobEnvelope({
            direction: 'event',
            operation,
            actionKey: jobStart.actionKey,
            operationKey: jobStart.operationKey,
            jobId: jobStart.jobId,
            workerInstanceId: jobStart.workerInstanceId,
            serviceGeneration: jobStart.serviceGeneration,
            unitId: null,
            seq: jobEventSeq,
            context: jobStart.context,
            payload
          }));
        }

        if (message.channel === 'service-control') serviceTrace.push(message);
        if (message.operation === 'executor:init') {
          initCommand = message;
          emitService('executor:ready', `${terminal}-ready`, null, {
            contractVersion: 1,
            capabilities: ['resource-control-v1']
          });
        } else if (message.operation === 'job:start') {
          jobStart = message;
          emitService('resource:request', `${terminal}-request-control`, {
            actionKey: message.actionKey,
            operationKey: message.operationKey,
            jobId: message.jobId,
            unitId: null
          }, {
            requestId: `${terminal}-request`,
            requestKind: 'pending-interaction-create',
            requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
            replacesReservationId: null,
            owner: requestOwner
          });
        } else if (message.operation === 'resource:grant') {
          emitService('resource:adopted', `${terminal}-adopted`, message.jobRef, {
            requestId: message.payload.requestId,
            grantId: message.payload.grantId,
            reservationId: message.payload.reservationId,
            owner: requestOwner
          });
        } else if (message.operation === 'resource:adopt-ack') {
          markTokenReady();
          if (terminal === 'job-error') {
            emitJob('job:error', {
              error: {
                code: 'EXECUTION_FAILED',
                message: 'safe failure',
                stage: 'execute',
                detailLines: []
              }
            });
          }
        } else if (message.operation === 'job:cancel') {
          emitJob('cancel:ack', { cancellation: { scope: 'job' } });
          emitJob('job:error', {
            error: {
              code: 'CANCELLED',
              message: 'cancelled',
              stage: 'cancel',
              detailLines: []
            }
          });
        } else if (message.operation === 'resource:revoke') {
          emitService('resource:release', message.controlId, message.jobRef, {
            reservationId: message.payload.reservationId,
            reason: 'job-failed'
          });
        } else if (message.operation === 'executor:close') {
          emitService('executor:close-ack', message.controlId, null, {});
        }
      }
    });
    const { policyRegistry, resourceGovernor, supervisor } = harness(fake, (policy) => {
      applyServicePolicy(policy, `service.supervisor-${terminal}-token`);
      if (terminal === 'cancel') policy.cancellation.capability = 'user-cooperative';
    });

    const execution = supervisor.execute(request({ jobId: `supervisor-${terminal}-token-job` }));
    await tokenReady;
    if (terminal === 'cancel') {
      const cancellation = await supervisor.cancel(`supervisor-${terminal}-token-job`, {
        reason: 'user-requested'
      });
      assert.equal(cancellation.accepted, true);
    }
    const result = await execution;
    assert.equal(result.terminalSource, 'job:error', terminal);
    assert.equal(resourceGovernor.snapshot().activeLeaseCount, 1, terminal);
    assert.equal(serviceTrace.some((message) => message.operation === 'resource:revoke'), true, terminal);

    const report = await supervisor.shutdown({ timeoutMs: 100 });
    assert.deepEqual(report.errors, [], terminal);
    const validation = validateProtocolSequence(serviceTrace, { policyRegistry });
    assert.equal(validation.valid, true, `${terminal}: ${JSON.stringify(validation.errors)}`);
    assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0, terminal);
    assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0, terminal);
    assert.equal(fake.state.closeCount, 1, terminal);
    assert.equal(fake.state.terminateCount, 1, terminal);
  }
});

test('Supervisor 在 adapter.start 前完成 Base/Phase admission，terminal 后 exactly-once 释放', async () => {
  const order = [];
  const released = [];
  function lease(kind) {
    let active = true;
    return Object.freeze({
      leaseId: `${kind}-lease`,
      release(reason) {
        if (!active) return false;
        active = false;
        released.push([kind, reason]);
        return true;
      }
    });
  }
  const resourceGovernor = {
    async acquireBaseLease() {
      order.push('admit:base');
      return lease('base');
    },
    async acquirePhaseLease() {
      order.push('admit:phase');
      return lease('phase');
    }
  };
  const fake = fakeAdapter({
    onStart() {
      order.push('adapter:start');
    },
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(fake, null, canary.validatePureComputeCanaryResult, { resourceGovernor });
  const result = await supervisor.execute(request({ jobId: 'admission-order-job' }));

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(order, ['admit:base', 'admit:phase', 'adapter:start']);
  assert.deepEqual(released, [['phase', 'job-terminal'], ['base', 'job-terminal']]);
});

test('E02-A factory without Governor preserves simple job execution and shuts down cleanly', async () => {
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      if (message.operation === 'job:start') {
        callbacks.onMessage(eventFor(message, 'job:done', 1, {
          result: { checksum: 6004, count: 2, rounds: 2, sum: 3 }
        }));
      }
    }
  });
  const { supervisor } = harness(
    fake,
    null,
    canary.validatePureComputeCanaryResult,
    { resourceGovernor: undefined }
  );
  const result = await supervisor.execute(request({ jobId: 'e02a-no-governor-job' }));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(fake.state.sent[0].operation, 'job:start');
  const report = await supervisor.shutdown({ timeoutMs: 20 });
  assert.deepEqual(report.closedServices, []);
});

test('without Governor service and compound paths fail closed before adapter start', async () => {
  const compoundFake = fakeAdapter();
  const compound = harness(compoundFake, (policy) => {
    policy.resources.compound = {
      topologyKey: 'topology.no-governor',
      childrenMax: 1,
      childResource: {
        cpuSlots: 1,
        workerThreadSlots: 1,
        utilityProcessSlots: 0,
        ioHeavySlots: 0,
        memoryBytes: 1
      }
    };
  }, canary.validatePureComputeCanaryResult, { resourceGovernor: undefined });
  await assert.rejects(
    compound.supervisor.execute(request({ jobId: 'compound-no-governor' })),
    (error) => error.code === 'RESOURCE_GOVERNOR_REQUIRED'
  );
  assert.equal(compoundFake.state.callbacks, null);

  const servicePolicy = structuredClone(canary.pureComputePolicy);
  servicePolicy.lifetime = 'service';
  servicePolicy.service = { serviceKey: 'service.no-governor' };
  const policyRegistry = Object.freeze({
    assertRunnable() { return servicePolicy; },
    getBinding(_actionKey, fieldPath) {
      return fieldPath === 'result.validatorKey' ? canary.validatePureComputeCanaryResult : '/service.js';
    }
  });
  const serviceSupervisor = createExecutionSupervisor({ policyRegistry });
  await assert.rejects(
    serviceSupervisor.execute(request({ jobId: 'service-no-governor' })),
    (error) => error.code === 'RESOURCE_GOVERNOR_REQUIRED'
  );
});

test('queued admission cancel aborts request, never calls adapter.start, and releases partial admission', async () => {
  let baseReleaseCount = 0;
  const resourceGovernor = {
    async acquireBaseLease() {
      return Object.freeze({
        leaseId: 'base-lease',
        release() {
          baseReleaseCount += 1;
          return baseReleaseCount === 1;
        }
      });
    },
    acquirePhaseLease(admission) {
      return new Promise((_resolve, reject) => {
        const rejectCancelled = () => {
          const error = new Error('queued admission cancelled');
          error.code = 'ADMISSION_CANCELLED';
          reject(error);
        };
        if (admission.signal.aborted) rejectCancelled();
        else admission.signal.addEventListener('abort', rejectCancelled, { once: true });
      });
    }
  };
  const fake = fakeAdapter();
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.capability = 'not-supported';
  }, canary.validatePureComputeCanaryResult, { resourceGovernor });
  const execution = supervisor.execute(request({ jobId: 'queued-cancel-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = await supervisor.cancel('queued-cancel-job', { reason: 'user-cancelled' });
  const result = await execution;

  assert.equal(cancellation.accepted, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'spawn-error');
  assert.equal(fake.state.callbacks, null);
  assert.equal(baseReleaseCount, 1);
});

test('real Governor grant diagnostics cancellation releases a late phase grant before transport assignment', async () => {
  let supervisor;
  let cancellation;
  let blockerLeaseId = null;
  let resourceId = 0;
  const phase = canary.pureComputePolicy.resources.phase;
  const resourceGovernor = createResourceGovernor({
    budgets: phase,
    idFactory: (prefix) => `diagnostic-cancel-${prefix}-${++resourceId}`,
    diagnostics(event) {
      if (supervisor && event.type === 'resource-granted' && event.kind === 'phase' &&
          event.leaseId !== blockerLeaseId) {
        cancellation = supervisor.cancel('diagnostic-cancel-job', { reason: 'grant-diagnostic' });
        cancellation.catch(() => {});
      }
    }
  });
  const blocker = await resourceGovernor.acquirePhaseLease({
    ownerKey: 'blocker',
    actionKey: canary.PURE_COMPUTE_ACTION_KEY,
    operationKey: 'blocker',
    resources: phase
  });
  blockerLeaseId = blocker.leaseId;
  const fake = fakeAdapter();
  ({ supervisor } = harness(
    fake,
    (policy) => { policy.cancellation.capability = 'not-supported'; },
    canary.validatePureComputeCanaryResult,
    { resourceGovernor }
  ));

  const execution = supervisor.execute(request({ jobId: 'diagnostic-cancel-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resourceGovernor.snapshot().queued.size, 1);
  assert.equal(blocker.release('admit-job'), true);
  const result = await execution;
  await cancellation;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'spawn-error');
  assert.equal(fake.state.callbacks, null);
  assert.equal(resourceGovernor.snapshot().queued.size, 0);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.deepEqual(resourceGovernor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('shutdown cancels queued admission even when runtime cancellation is not supported', async () => {
  let baseReleaseCount = 0;
  const resourceGovernor = {
    async acquireBaseLease() {
      return Object.freeze({
        leaseId: 'shutdown-base-lease',
        release() {
          baseReleaseCount += 1;
          return baseReleaseCount === 1;
        }
      });
    },
    acquirePhaseLease(admission) {
      return new Promise((_resolve, reject) => {
        const rejectCancelled = () => {
          const error = new Error('queued admission cancelled by shutdown');
          error.code = 'ADMISSION_CANCELLED';
          reject(error);
        };
        if (admission.signal.aborted) rejectCancelled();
        else admission.signal.addEventListener('abort', rejectCancelled, { once: true });
      });
    }
  };
  const fake = fakeAdapter();
  const { supervisor } = harness(fake, (policy) => {
    policy.cancellation.capability = 'not-supported';
  }, canary.validatePureComputeCanaryResult, { resourceGovernor });
  const execution = supervisor.execute(request({ jobId: 'queued-shutdown-job' }));
  await new Promise((resolve) => setImmediate(resolve));

  const report = await supervisor.shutdown({ timeoutMs: 100 });
  const result = await execution;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'spawn-error');
  assert.deepEqual(report.cancelledJobs, ['queued-shutdown-job']);
  assert.deepEqual(report.protectedJobs, []);
  assert.equal(fake.state.callbacks, null);
  assert.equal(baseReleaseCount, 1);
});

test('shutdown normalizes all finite non-negative E02-A timeout values before lifecycle mutation', async () => {
  for (const [index, timeoutMs] of [Number.MAX_SAFE_INTEGER, 2_147_483_648, 1000.5].entries()) {
    const fake = fakeAdapter();
    const { supervisor } = harness(fake);
    const report = await supervisor.shutdown({ timeoutMs });
    assert.deepEqual(Object.keys(report), [
      'closedServices',
      'cancelledJobs',
      'protectedJobs',
      'interruptedTasks',
      'activeHolds',
      'leakedTransports',
      'errors'
    ]);
    assert.deepEqual(report.errors, []);
    await assert.rejects(
      supervisor.execute(request({ jobId: `post-large-shutdown-${index}` })),
      (error) => error.code === 'SUPERVISOR_NOT_ACCEPTING'
    );
  }
});

test('existing nested topology is inspected and frozen before compound admission with no wrapper Worker', async () => {
  const order = [];
  let dispatchedTopology = null;
  const policy = structuredClone(canary.pureComputePolicy);
  policy.adapterKind = 'existing-dispatch';
  policy.adapterKey = 'adapter.existing-nested';
  policy.entryKey = null;
  policy.resources.base = {
    cpuSlots: 0,
    workerThreadSlots: 1,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 10
  };
  policy.resources.phase = {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 1,
    memoryBytes: 5
  };
  policy.resources.compound = {
    topologyKey: 'topology.existing-nested',
    childrenMax: 4,
    childResource: {
      cpuSlots: 1,
      workerThreadSlots: 1,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 20
    }
  };
  policy.resources.lowMemoryBehavior = 'downgrade-to-single';
  const existingBinding = createExistingDispatchAdapter({
    inspectTopology() {
      order.push('inspect');
      return { effectiveChildCount: 2 };
    },
    dispatch(dispatchRequest) {
      order.push('dispatch');
      dispatchedTopology = dispatchRequest.topology;
      return Promise.resolve({ checksum: 6004, count: 2, rounds: 2, sum: 3 });
    }
  });
  const adapterRegistry = createStaticRegistry({ [policy.adapterKey]: existingBinding });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  adapterRegistry.freeze();
  validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [policy],
    adapterRegistry,
    validatorRegistry,
    staticKeys: {
      resourceProfileKeys: [policy.resources.profile],
      topologyKeys: [policy.resources.compound.topologyKey]
    }
  });
  policyRegistry.freeze();
  let resourceId = 0;
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 0,
      ioHeavySlots: 2,
      memoryBytes: 100
    },
    idFactory(prefix) {
      order.push('admit');
      return `${prefix}-${++resourceId}`;
    }
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    workerThreadAdapter: {
      start() { throw new Error('wrapper Worker must not be created'); }
    }
  });

  const result = await supervisor.execute(request({ jobId: 'existing-topology-job' }));
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(order, ['inspect', 'admit', 'dispatch']);
  assert.deepEqual(dispatchedTopology, {
    topologyKey: 'topology.existing-nested',
    childrenMax: 4,
    childResource: policy.resources.compound.childResource,
    effectiveChildCount: 2
  });
  assert.equal(Object.isFrozen(dispatchedTopology), true);
  assert.deepEqual(resourceGovernor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('service job 使用 Host generation 路由，正常 terminal 仅 detach 并释放 job admission', async () => {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.lifetime = 'service';
  policy.service = { serviceKey: 'service.test' };
  const policyRegistry = Object.freeze({
    assertRunnable(actionKey) {
      if (actionKey !== policy.actionKey) throw new Error('unknown action');
      return policy;
    },
    get(actionKey) {
      return actionKey === policy.actionKey ? policy : null;
    },
    getBinding(_actionKey, fieldPath) {
      if (fieldPath === 'result.validatorKey') return canary.validatePureComputeCanaryResult;
      return null;
    },
    list() { return Object.freeze([policy]); }
  });
  let hostCallbacks = null;
  let closeCount = 0;
  let terminateCount = 0;
  const sent = [];
  const serviceHost = Object.freeze({
    async openJob(openRequest) {
      hostCallbacks = openRequest;
      return Object.freeze({
        workerInstanceId: 'service-worker-1',
        serviceGeneration: 2,
        baseLeaseId: 'service-base-1',
        baseResources: policy.resources.base,
        ready: Promise.resolve(),
        send(message) {
          sent.push(message);
          if (message.operation !== 'job:start') return;
          queueMicrotask(() => openRequest.onMessage(createJobEnvelope({
            direction: 'event',
            operation: 'job:done',
            actionKey: message.actionKey,
            operationKey: message.operationKey,
            jobId: message.jobId,
            workerInstanceId: 'service-worker-1',
            serviceGeneration: 2,
            unitId: null,
            seq: 1,
            context: message.context,
            payload: { result: { checksum: 6004, count: 2, rounds: 2, sum: 3 } }
          })));
        },
        close() { closeCount += 1; },
        async terminate() { terminateCount += 1; }
      });
    },
    async closeService() { return false; },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  let resourceId = 0;
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 1,
      ioHeavySlots: 4,
      memoryBytes: 1024 * 1024 * 1024
    },
    idFactory: (prefix) => `${prefix}-${++resourceId}`
  });
  const supervisor = createExecutionSupervisor({ policyRegistry, resourceGovernor, serviceHost });
  const result = await supervisor.execute(request({ jobId: 'service-job' }));

  assert.equal(result.outcome, 'completed');
  assert.equal(hostCallbacks.jobId, 'service-job');
  assert.equal(sent[0].workerInstanceId, 'service-worker-1');
  assert.equal(sent[0].serviceGeneration, 2);
  assert.equal(closeCount, 1);
  assert.equal(terminateCount, 0);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('service Host exit callback remains an unexpected-exit terminal in Supervisor', async () => {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.lifetime = 'service';
  policy.service = { serviceKey: 'service.exit' };
  const policyRegistry = Object.freeze({
    assertRunnable(actionKey) {
      if (actionKey !== policy.actionKey) throw new Error('unknown action');
      return policy;
    },
    get(actionKey) {
      return actionKey === policy.actionKey ? policy : null;
    },
    getBinding(_actionKey, fieldPath) {
      if (fieldPath === 'result.validatorKey') return canary.validatePureComputeCanaryResult;
      return null;
    }
  });
  let closeCount = 0;
  let terminateCount = 0;
  const serviceHost = Object.freeze({
    async openJob(openRequest) {
      return Object.freeze({
        workerInstanceId: 'service-exit-worker',
        serviceGeneration: 3,
        baseLeaseId: 'service-exit-base',
        baseResources: policy.resources.base,
        ready: Promise.resolve(),
        send(message) {
          if (message.operation === 'job:start') {
            queueMicrotask(() => openRequest.onExit(17, 'SIGTERM'));
          }
        },
        close() { closeCount += 1; },
        async terminate() { terminateCount += 1; }
      });
    },
    async closeService() { return false; },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  let resourceId = 0;
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 1,
      ioHeavySlots: 4,
      memoryBytes: 1024 * 1024 * 1024
    },
    idFactory: (prefix) => `${prefix}-${++resourceId}`
  });
  const supervisor = createExecutionSupervisor({ policyRegistry, resourceGovernor, serviceHost });

  const result = await supervisor.execute(request({ jobId: 'service-exit-job' }));

  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.terminalSource, 'unexpected-exit');
  assert.equal(result.error.code, 'UNEXPECTED_EXIT');
  assert.equal(terminateCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('service Base startup pending 时取消会关闭 starting generation，且不会悬挂或发送 job:start', async () => {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.lifetime = 'service';
  policy.service = { serviceKey: 'service.starting' };
  policy.cancellation.capability = 'user-cooperative';
  const policyRegistry = Object.freeze({
    assertRunnable(actionKey) {
      if (actionKey !== policy.actionKey) throw new Error('unknown action');
      return policy;
    },
    get(actionKey) {
      return actionKey === policy.actionKey ? policy : null;
    },
    getBinding(_actionKey, fieldPath) {
      if (fieldPath === 'result.validatorKey') return canary.validatePureComputeCanaryResult;
      return null;
    },
    list() { return Object.freeze([policy]); }
  });
  let rejectOpening;
  let closeRequest = null;
  const serviceHost = Object.freeze({
    openJob() {
      return new Promise((_resolve, reject) => { rejectOpening = reject; });
    },
    async closeService(serviceKey, closeOptions) {
      closeRequest = { serviceKey, closeOptions };
      const error = new Error('service start cancelled');
      error.code = 'ADMISSION_CANCELLED';
      rejectOpening(error);
      return true;
    },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  let phaseReleaseCount = 0;
  const resourceGovernor = {
    async acquirePhaseLease() {
      return Object.freeze({
        release() {
          phaseReleaseCount += 1;
          return phaseReleaseCount === 1;
        }
      });
    }
  };
  const supervisor = createExecutionSupervisor({ policyRegistry, resourceGovernor, serviceHost });
  const execution = supervisor.execute(request({ jobId: 'service-start-cancel-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.inspect('service-start-cancel-job').state, 'spawning');

  const cancellation = await supervisor.cancel('service-start-cancel-job', { reason: 'user-cancelled' });
  const result = await execution;

  assert.equal(cancellation.accepted, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'spawn-error');
  assert.deepEqual(closeRequest, {
    serviceKey: 'service.starting',
    closeOptions: { force: true }
  });
  assert.equal(phaseReleaseCount, 1);
  assert.equal(supervisor.inspect('service-start-cancel-job'), null);
});

test('Host semantic protocol errors retain canonical protocol-error terminal classification', async () => {
  let terminateCount = 0;
  let closeCount = 0;
  const serviceHost = Object.freeze({
    async openJob(openRequest) {
      return Object.freeze({
        workerInstanceId: 'semantic-protocol-worker',
        serviceGeneration: 4,
        createdGeneration: false,
        baseLeaseId: 'semantic-protocol-base',
        baseResources: canary.pureComputePolicy.resources.base,
        ready: Promise.resolve(),
        send(message) {
          if (message.operation === 'job:start') {
            queueMicrotask(() => openRequest.onError(new ServiceHostProtocolError(
              'SERVICE_RELEASE_UNKNOWN',
              'Unknown reservation'
            )));
          }
        },
        close() { closeCount += 1; },
        async terminate() { terminateCount += 1; }
      });
    },
    async closeService() { return false; },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  const fake = fakeAdapter();
  const { supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.semantic-protocol');
  }, canary.validatePureComputeCanaryResult, { serviceHost });

  const result = await supervisor.execute(request({ jobId: 'semantic-protocol-job' }));
  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.error.code, 'SERVICE_RELEASE_UNKNOWN');
  assert.equal(terminateCount, 1);
  assert.equal(closeCount, 1);
});

test('real Host control exchange reuse maps to protocol-error without reservation leaks', async () => {
  let initCommand = null;
  let serviceEventSeq = 0;
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      function emitService(operation, controlId, jobRef, payload) {
        serviceEventSeq += 1;
        callbacks.onMessage(createServiceControlEnvelope({
          direction: 'event',
          operation,
          serviceKey: initCommand.serviceKey,
          controlId,
          workerInstanceId: initCommand.workerInstanceId,
          serviceGeneration: initCommand.serviceGeneration,
          seq: serviceEventSeq,
          jobRef,
          payload
        }, { validate: false }));
      }

      if (message.operation === 'executor:init') {
        initCommand = message;
        emitService('executor:ready', 'runtime-control-ready', null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1']
        });
      } else if (message.operation === 'job:start') {
        emitService('resource:request', initCommand.controlId, {
          actionKey: message.actionKey,
          operationKey: message.operationKey,
          jobId: message.jobId,
          unitId: null
        }, {
          requestId: 'runtime-init-id-reuse',
          requestKind: 'pending-interaction-create',
          requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: null,
          owner: {
            kind: 'interaction-token',
            ownerKeyHash: 'runtime-init-id-reuse-owner',
            candidateRevision: 1
          }
        });
      }
    }
  });
  const { resourceGovernor, supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.runtime-control-reuse');
  });

  const result = await supervisor.execute(request({ jobId: 'runtime-control-reuse-job' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.error.code, 'SERVICE_CONTROL_ID_REUSED');
  assert.equal(result.error.stage, 'protocol');
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(resourceGovernor.snapshot().queued.size, 0);
  assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('real Host rejects wire release while a persistent replacement is still queued', async () => {
  let initCommand = null;
  let currentJobRef = null;
  let initialReservationId = null;
  let serviceEventSeq = 0;
  const ownerHash = 'a'.repeat(64);
  const fake = fakeAdapter({
    onSend(message, callbacks) {
      function emitService(operation, controlId, jobRef, payload) {
        serviceEventSeq += 1;
        callbacks.onMessage(createServiceControlEnvelope({
          direction: 'event',
          operation,
          serviceKey: initCommand.serviceKey,
          controlId,
          workerInstanceId: initCommand.workerInstanceId,
          serviceGeneration: initCommand.serviceGeneration,
          seq: serviceEventSeq,
          jobRef,
          payload
        }, { validate: false }));
      }

      if (message.operation === 'executor:init') {
        initCommand = message;
        emitService('executor:ready', 'queued-wire-ready', null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1']
        });
      } else if (message.operation === 'job:start') {
        currentJobRef = {
          actionKey: message.actionKey,
          operationKey: message.operationKey,
          jobId: message.jobId,
          unitId: null
        };
        emitService('resource:request', 'queued-wire-request-1', currentJobRef, {
          requestId: 'queued-wire-request-1',
          requestKind: 'persistent-state-replace',
          requested: { memoryBytes: 1, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: null,
          owner: { kind: 'service-state', ownerKeyHash: ownerHash, candidateRevision: 1 }
        });
      } else if (message.operation === 'resource:grant' &&
          message.payload.requestId === 'queued-wire-request-1') {
        initialReservationId = message.payload.reservationId;
        emitService('resource:adopted', 'queued-wire-adopt-1', currentJobRef, {
          requestId: message.payload.requestId,
          grantId: message.payload.grantId,
          reservationId: message.payload.reservationId,
          owner: { kind: 'service-state', ownerKeyHash: ownerHash, candidateRevision: 1 }
        });
      } else if (message.operation === 'resource:adopt-ack' &&
          message.payload.requestId === 'queued-wire-request-1') {
        emitService('resource:request', 'queued-wire-request-2', currentJobRef, {
          requestId: 'queued-wire-request-2',
          requestKind: 'persistent-state-replace',
          requested: { memoryBytes: 2, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: initialReservationId,
          owner: { kind: 'service-state', ownerKeyHash: ownerHash, candidateRevision: 2 }
        });
        emitService('resource:release', 'queued-wire-release-old', null, {
          reservationId: initialReservationId,
          reason: 'service-close'
        });
      }
    }
  });
  const phase = canary.pureComputePolicy.resources.phase;
  let resourceId = 0;
  const resourceGovernor = createResourceGovernor({
    budgets: {
      ...phase,
      memoryBytes: phase.memoryBytes + 1
    },
    idFactory: (prefix) => `queued-wire-${prefix}-${++resourceId}`
  });
  const { supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.queued-wire-release');
  }, canary.validatePureComputeCanaryResult, { resourceGovernor });

  const result = await supervisor.execute(request({ jobId: 'queued-wire-release-job' }));
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(result.terminalSource, 'protocol-error');
  assert.equal(result.outcome, 'transport-lost');
  assert.equal(result.error.code, 'SERVICE_RELEASE_DURING_TENTATIVE_REPLACEMENT');
  assert.equal(result.error.stage, 'protocol');
  assert.equal(fake.state.sent.some((message) => message.operation === 'resource:release-ack'), false);
  assert.equal(fake.state.closeCount, 1);
  assert.equal(fake.state.terminateCount, 1);
  assert.equal(resourceGovernor.snapshot().queued.size, 0);
  assert.equal(resourceGovernor.snapshot().activeDependencyCount, 0);
  assert.equal(resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.deepEqual(resourceGovernor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('cancelled compound admission on an existing service detaches only the current job', async () => {
  let generationAlive = true;
  let persistentReservationAlive = true;
  let closeCount = 0;
  let terminateCount = 0;
  let jobStartCount = 0;
  let compoundPending = false;
  const serviceHost = Object.freeze({
    async openJob() {
      return Object.freeze({
        workerInstanceId: 'shared-worker',
        serviceGeneration: 7,
        createdGeneration: false,
        baseLeaseId: 'shared-base',
        baseResources: canary.pureComputePolicy.resources.base,
        ready: Promise.resolve(),
        send(message) {
          if (message.operation === 'job:start') jobStartCount += 1;
        },
        close() { closeCount += 1; },
        async terminate() {
          terminateCount += 1;
          generationAlive = false;
          persistentReservationAlive = false;
        }
      });
    },
    async closeService() {
      generationAlive = false;
      persistentReservationAlive = false;
      return true;
    },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  const resourceGovernor = {
    acquireCompoundLease(admission) {
      compoundPending = true;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          compoundPending = false;
          const error = new Error('compound admission cancelled');
          error.code = 'ADMISSION_CANCELLED';
          reject(error);
        };
        if (admission.signal.aborted) abort();
        else admission.signal.addEventListener('abort', abort, { once: true });
      });
    }
  };
  const fake = fakeAdapter();
  const { supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, 'service.shared');
    policy.cancellation.capability = 'not-supported';
    policy.resources.compound = {
      topologyKey: 'topology.shared',
      childrenMax: 2,
      childResource: {
        cpuSlots: 1,
        workerThreadSlots: 1,
        utilityProcessSlots: 0,
        ioHeavySlots: 0,
        memoryBytes: 1
      }
    };
  }, canary.validatePureComputeCanaryResult, { resourceGovernor, serviceHost });
  const execution = supervisor.execute(request({ jobId: 'shared-compound-job' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(compoundPending, true);
  assert.equal(supervisor.inspect('shared-compound-job').state, 'admitting');

  const cancellation = await supervisor.cancel('shared-compound-job', { reason: 'cancel-before-dispatch' });
  const result = await execution;
  assert.equal(cancellation.accepted, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'spawn-error');
  assert.equal(compoundPending, false);
  assert.equal(jobStartCount, 0);
  assert.equal(closeCount, 1);
  assert.equal(terminateCount, 0);
  assert.equal(generationAlive, true);
  assert.equal(persistentReservationAlive, true);
});

test('cancellation while an existing service attach is pending does not close that generation', async () => {
  let resolveOpen;
  let markOpenStarted;
  const openStarted = new Promise((resolve) => { markOpenStarted = resolve; });
  let closeCount = 0;
  let terminateCount = 0;
  let closeServiceCount = 0;
  let jobStartCount = 0;
  const serviceKey = 'service.shared-attach-window';
  const serviceHost = Object.freeze({
    openJob() {
      markOpenStarted();
      return new Promise((resolve) => { resolveOpen = resolve; });
    },
    async closeService() {
      closeServiceCount += 1;
      return true;
    },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() {
      return Object.freeze({
        services: Object.freeze([Object.freeze({ serviceKey })])
      });
    }
  });
  const fake = fakeAdapter();
  const { supervisor } = harness(fake, (policy) => {
    applyServicePolicy(policy, serviceKey);
    policy.cancellation.capability = 'not-supported';
  }, canary.validatePureComputeCanaryResult, { serviceHost });
  const execution = supervisor.execute(request({ jobId: 'shared-attach-window-job' }));
  await openStarted;
  assert.equal(supervisor.inspect('shared-attach-window-job').state, 'spawning');

  const cancellation = await supervisor.cancel(
    'shared-attach-window-job',
    { reason: 'cancel-during-attach' }
  );
  resolveOpen(Object.freeze({
    workerInstanceId: 'shared-attach-window-worker',
    serviceGeneration: 9,
    createdGeneration: false,
    baseLeaseId: 'shared-attach-window-base',
    baseResources: canary.pureComputePolicy.resources.base,
    ready: Promise.resolve(),
    send(message) {
      if (message.operation === 'job:start') jobStartCount += 1;
    },
    close() { closeCount += 1; },
    async terminate() { terminateCount += 1; }
  }));
  const result = await execution;
  assert.equal(cancellation.accepted, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(jobStartCount, 0);
  assert.equal(closeServiceCount, 0);
  assert.equal(closeCount, 1);
  assert.equal(terminateCount, 0);
});
