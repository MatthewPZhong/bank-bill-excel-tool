'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../../src/main-process/background-execution/execution-policy-registry');
const { createJobEnvelope } = require('../../../../src/main-process/background-execution/protocol');
const {
  createExistingDispatchAdapter,
  createExistingDispatchTransportAdapter
} = require('../../../../src/main-process/background-execution/adapters/existing-dispatch-adapter');
const {
  createExecutionSupervisor,
  validateResultBody
} = require('../../../../src/main-process/background-execution/supervisor');
const canary = require('../../../../src/main-process/background-execution/canary');

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
    staticKeys: { resourceProfileKeys: [policy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  policyRegistry.freeze();
  const diagnosticEntries = [];
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    entryRegistry,
    validatorRegistry,
    workerThreadAdapter: fake.adapter,
    diagnostics: (entry) => diagnosticEntries.push(entry),
    ...supervisorOptions
  });
  return { diagnosticEntries, policy, supervisor };
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
    'cancel', 'closeService', 'execute', 'inspect', 'shutdown', 'stopAcceptingNewJobs'
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

test('stopAcceptingNewJobs 与 E02-A closeService 都确定性 fail closed', async () => {
  const fake = fakeAdapter();
  const { supervisor } = harness(fake);
  await assert.rejects(
    supervisor.closeService('service.not-owned'),
    (error) => error.code === 'E02A_SERVICE_UNSUPPORTED'
  );
  supervisor.stopAcceptingNewJobs();
  await assert.rejects(
    supervisor.execute(request()),
    (error) => error.code === 'SUPERVISOR_NOT_ACCEPTING'
  );
});
