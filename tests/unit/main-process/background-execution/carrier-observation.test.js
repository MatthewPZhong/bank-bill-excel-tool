'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { createExecutionPolicyRegistry, createStaticRegistry } = require(
  '../../../../src/main-process/background-execution/execution-policy-registry');
const { createExecutionSupervisor } = require('../../../../src/main-process/background-execution/supervisor');
const { createWorkerThreadAdapter } = require(
  '../../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const { createResourceGovernor } = require('../../../../src/main-process/background-execution/resource-governor');
const { createBackgroundExecutionRuntimeManager } = require(
  '../../../../src/main-process/background-execution/runtime');
const canary = require('../../../../src/main-process/background-execution/canary');

const ACTION = 'background-execution:carrier-observation-test';
const fixture = path.resolve(__dirname, '../../../fixtures/carrier-observation-worker.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function eventually(check, message) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

function request(jobId = 'carrier-job', behavior = 'error') {
  return {
    actionKey: ACTION, operationKey: 'carrier-operation', jobId,
    workerInstanceId: `worker-${jobId}`, input: { behavior },
    context: { kind: 'operation', value: {
      taskRunId: 'carrier-task-run', taskKey: 'carrier-task', moduleId: 'background-execution',
      parentRunId: 'carrier-parent', operationKey: 'carrier-operation'
    } }
  };
}

function harness(t, options = {}) {
  const state = {
    workers: [], transports: [], starts: 0, terminateCalls: 0, closeCalls: 0,
    releaseCalls: new Map(), failRelease: false, failClose: false,
    terminatePending: deferred(), closePending: null, callbacks: [], messages: []
  };
  class TestWorker extends Worker {
    constructor(...args) {
      super(...args);
      state.workers.push(this);
    }
    terminate() {
      state.terminateCalls += 1;
      if (options.terminate === 'reject') {
        return Promise.reject(Object.assign(new Error('测试终止失败'), { code: 'FIXTURE_TERMINATE_FAILED' }));
      }
      if (options.terminate === 'pending') return state.terminatePending.promise;
      return super.terminate();
    }
  }
  const adapter = createWorkerThreadAdapter({ WorkerClass: TestWorker });
  const workerThreadAdapter = {
    start(callbacks) {
      state.starts += 1;
      state.callbacks.push(callbacks);
      if (options.startError) throw options.startError;
      const native = adapter.start({ ...callbacks, onMessage(message) {
        state.messages.push(message);
        callbacks.onMessage(message);
      } });
      const transport = Object.freeze({
        ...native,
        close() {
          state.closeCalls += 1;
          if (state.failClose) throw new Error('测试 close 失败');
          native.close();
          return state.closePending ? state.closePending.promise : undefined;
        }
      });
      state.transports.push(transport);
      return transport;
    }
  };
  const policy = structuredClone(canary.pureComputePolicy);
  policy.actionKey = ACTION;
  policy.entryKey = `executor.${ACTION}`;
  policy.context = { kind: 'operation', validatorKey: 'exact-5' };
  policy.cancellation.capability = 'user-cooperative';
  policy.cancellation.cooperativeTimeoutMs = 300;
  policy.cancellation.terminateTimeoutMs = options.cleanupTimeoutMs ||
    (options.terminate === 'pending' ? 30 : 1000);
  if (options.policy) options.policy(policy);
  const entryRegistry = createStaticRegistry({ [policy.entryKey]: fixture });
  const validatorRegistry = createStaticRegistry({
    [policy.result.validatorKey]: canary.validatePureComputeCanaryResult
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [policy], entryRegistry, validatorRegistry,
    staticKeys: { resourceProfileKeys: [policy.resources.profile] }
  });
  policyRegistry.freeze();
  const governor = createResourceGovernor({ budgets: {
    cpuSlots: 4, workerThreadSlots: 4, utilityProcessSlots: 0,
    ioHeavySlots: 4, memoryBytes: 1024 * 1024 * 1024
  } });
  function wrapAcquire(method) {
    return async (...args) => {
      const lease = await governor[method](...args);
      return Object.freeze({ ...lease, release(reason) {
        state.releaseCalls.set(lease.leaseId, (state.releaseCalls.get(lease.leaseId) || 0) + 1);
        if (state.failRelease) throw new Error('测试租约释放失败');
        return lease.release(reason);
      } });
    };
  }
  const resourceGovernor = Object.freeze({ ...governor,
    acquireBaseLease: wrapAcquire('acquireBaseLease'),
    acquirePhaseLease: wrapAcquire('acquirePhaseLease')
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry, entryRegistry, validatorRegistry, workerThreadAdapter,
    resourceGovernor, carrierClosureActionKeys: [ACTION], ...options.supervisor
  });
  t.after(async () => {
    state.failRelease = false;
    state.failClose = false;
    if (state.closePending) state.closePending.resolve();
    // 故障注入只拦截业务 terminate；测试最终总是关闭实际创建的线程。
    const codes = await Promise.all(state.workers.map((worker) => Worker.prototype.terminate.call(worker)));
    state.terminatePending.resolve(codes[0]);
    await supervisor.shutdown({ timeoutMs: 1000 });
  });
  return { supervisor, governor, state };
}

test('真实 native worker 正常完成，关闭观察不可变且重复查询不制造新事实', async (t) => {
  const { supervisor, governor } = harness(t);
  const control = supervisor.start(request('normal', 'done'));
  const identity = control.carrierIdentity;
  assert.equal(identity.taskRunId, 'carrier-task-run');
  assert.equal(identity.workerInstanceId, 'worker-normal');
  assert.ok(Object.isFrozen(identity));
  assert.equal(control.getCarrierObservation().disposition, 'PENDING');
  const waiting = control.waitForCarrierClosure({ timeoutMs: 3000 });
  const result = await control.promise;
  assert.equal(result.outcome, 'completed');
  const observed = await waiting;
  assert.equal(observed.disposition, 'EXITED');
  assert.equal(observed.exitObserved, true);
  const final = control.getCarrierObservation();
  assert.equal(final.resourceDisposition, 'RELEASED');
  assert.ok(Object.isFrozen(final));
  assert.equal(control.getCarrierObservation(), final);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.throws(() => control.waitForCarrierClosure({ timeoutMs: -1 }), TypeError);
});

for (const terminate of ['reject', 'pending']) {
  test(`业务失败且 terminate ${terminate} 后，晚到真实 exit 保留原错误并只释放原租约一次`, async (t) => {
    const { supervisor, governor, state } = harness(t, { terminate });
    const control = supervisor.start(request());
    const result = await control.promise;
    assert.equal(result.error.code, 'FIXTURE_BUSINESS_FAILED');
    assert.equal(result.outcome, 'failed');
    const before = await control.waitForCarrierClosure({ timeoutMs: 10 });
    assert.equal(before.disposition, 'UNKNOWN');
    assert.equal(before.resourceDisposition, 'RETAINED');
    assert.equal(before.exitObserved, false);
    assert.equal(governor.snapshot().activeUsage.workerThreadSlots, 1);
    assert.ok(state.workers[0].listenerCount('exit') >= 1);
    assert.equal(state.releaseCalls.size, 0);
    const waiting = control.waitForCarrierClosure({ timeoutMs: 3000 });
    state.workers[0].postMessage({ fixture: 'exit' });
    assert.equal((await waiting).disposition, 'EXITED');
    await eventually(() => governor.snapshot().activeLeaseCount === 0, '原租约应随关闭收敛');
    state.callbacks[0].onCarrierExit(99);
    await supervisor.shutdown({ timeoutMs: 1000 });
    await supervisor.shutdown({ timeoutMs: 1000 });
    const after = control.getCarrierObservation();
    assert.equal(after.exitCode, 0);
    assert.ok(after.observationSequence > before.observationSequence);
    assert.equal(after.dispatchNonce, before.dispatchNonce);
    assert.deepEqual([...state.releaseCalls.values()], [1, 1]);
    assert.equal(await control.promise, result);
    assert.equal(result.error.code, 'FIXTURE_BUSINESS_FAILED');
  });
}

test('取消 ACK 不证明线程已退出，terminate 失败后仍保留容量', async (t) => {
  const { supervisor, governor, state } = harness(t, { terminate: 'reject' });
  const control = supervisor.start(request('cancelled', 'idle'));
  await control.ready;
  assert.equal(control.cancel({ reason: '测试取消' }), true);
  await eventually(() => state.messages.some((message) => message.operation === 'cancel:ack'), '必须真实收到取消 ACK');
  assert.equal(control.getCarrierObservation().disposition, 'PENDING');
  const result = await control.promise;
  assert.equal(result.terminalSource, 'cancel-timeout');
  assert.equal(control.getCarrierObservation().disposition, 'UNKNOWN');
  assert.equal(governor.snapshot().activeUsage.workerThreadSlots, 1);
  state.workers[0].postMessage({ fixture: 'exit' });
  assert.equal((await control.waitForCarrierClosure({ timeoutMs: 3000 })).disposition, 'EXITED');
  assert.equal(await control.promise, result);
});

test('派发前持久化未完成时取消，确认 hook 收敛前不能声称 NOT_CREATED', async (t) => {
  const binding = deferred();
  let boundIdentity;
  const { supervisor, state, governor } = harness(t, { supervisor: {
    beforeCarrierDispatch(identity) { boundIdentity = identity; return binding.promise; }
  } });
  const control = supervisor.start(request('never-created'));
  await eventually(() => !!boundIdentity, '应进入 Main 持久化接入点');
  assert.equal(boundIdentity, control.carrierIdentity);
  await control.cancel({ reason: '测试派发前取消' });
  assert.notEqual(control.getCarrierObservation().disposition, 'NOT_CREATED');
  binding.resolve();
  await control.promise;
  assert.equal((await control.waitForCarrierClosure()).disposition, 'NOT_CREATED');
  assert.equal(state.starts, 0);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('派发绑定失败确认未创建；adapter 创建抛错只能报告 UNKNOWN', async (t) => {
  const bindingError = Object.assign(new Error('测试绑定失败'), { code: 'BINDING_FAILED' });
  const first = harness(t, { supervisor: { beforeCarrierDispatch() { throw bindingError; } } });
  const control = first.supervisor.start(request('binding-failed'));
  assert.equal((await control.promise).error.code, 'BINDING_FAILED');
  assert.equal(control.getCarrierObservation().disposition, 'NOT_CREATED');
  assert.equal(first.state.starts, 0);
  const second = harness(t, { startError: new Error('构造载体状态不明') });
  const unknown = second.supervisor.start(request('creation-unknown'));
  await unknown.promise;
  assert.equal(unknown.getCarrierObservation().disposition, 'UNKNOWN');
  assert.equal(second.governor.snapshot().activeUsage.workerThreadSlots, 1);
  const report = await second.supervisor.shutdown({ timeoutMs: 1000 });
  assert.ok(report.leakedTransports.includes('creation-unknown'));
  assert.ok(report.errors.some((error) => error.code === 'CARRIER_CLOSURE_UNKNOWN'));
});

test('真实 exit 之后 close 失败仍不宣告完成，重试 close 才释放容量', async (t) => {
  const { supervisor, governor, state } = harness(t);
  state.failClose = true;
  const control = supervisor.start(request('close-failed'));
  const result = await control.promise;
  const before = control.getCarrierObservation();
  assert.equal(before.exitObserved, true);
  assert.equal(before.disposition, 'UNKNOWN');
  assert.equal(governor.snapshot().activeUsage.workerThreadSlots, 1);
  await eventually(() => state.closeCalls >= 2, '首次关闭失败应保留重试所有权');
  state.failClose = false;
  const report = await supervisor.shutdown({ timeoutMs: 1000 });
  assert.deepEqual(report.errors, []);
  assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.equal(await control.promise, result);
});

test('资源 release 失败独立于 EXITED，既有 shutdown 保留并重试原租约', async (t) => {
  const { supervisor, governor, state } = harness(t);
  state.failRelease = true;
  const control = supervisor.start(request('release-failed'));
  const result = await control.promise;
  await delay(10);
  assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  assert.equal(control.getCarrierObservation().resourceDisposition, 'UNKNOWN');
  assert.equal(governor.snapshot().activeUsage.workerThreadSlots, 1);
  const incomplete = await supervisor.shutdown({ timeoutMs: 1000 });
  assert.ok(incomplete.errors.some((error) => error.code === 'RESOURCE_RELEASE_FAILED'));
  state.failRelease = false;
  const clean = await supervisor.shutdown({ timeoutMs: 1000 });
  assert.deepEqual(clean.errors, []);
  assert.equal(control.getCarrierObservation().resourceDisposition, 'RELEASED');
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.equal(governor.snapshot().diagnostics.duplicateRelease, 0);
  assert.equal(await control.promise, result);
});

test('晚到旧载体退出不影响同 operation 的新任务，worker 身份不能重用', async (t) => {
  const { supervisor, governor, state } = harness(t, { terminate: 'reject' });
  const old = supervisor.start(request('old'));
  await old.promise;
  const next = supervisor.start(request('next', 'idle'));
  await next.ready;
  const nextBefore = next.getCarrierObservation();
  assert.notEqual(old.carrierIdentity.dispatchNonce, next.carrierIdentity.dispatchNonce);
  assert.throws(() => supervisor.start(request('old')), (error) => error.code === 'JOB_ID_DUPLICATE');
  state.workers[0].postMessage({ fixture: 'exit' });
  await old.waitForCarrierClosure({ timeoutMs: 3000 });
  await eventually(() => governor.snapshot().activeUsage.workerThreadSlots === 1, '只释放旧任务容量');
  assert.equal(next.getCarrierObservation(), nextBefore);
  assert.equal(next.getCarrierObservation().disposition, 'PENDING');
  assert.equal(supervisor.inspect('next').state, 'running');
});

test('terminate 仍在执行时，shutdown 重试复用原调用，不能并发终止同一载体', async (t) => {
  const { supervisor, state, governor } = harness(t, { terminate: 'pending' });
  const control = supervisor.start(request('terminate-pending'));
  const result = await control.promise;
  await supervisor.shutdown({ timeoutMs: 1000 });
  await supervisor.shutdown({ timeoutMs: 1000 });
  assert.equal(state.terminateCalls, 1);
  assert.equal(governor.snapshot().activeUsage.workerThreadSlots, 1);
  const code = await Worker.prototype.terminate.call(state.workers[0]);
  state.terminatePending.resolve(code);
  await control.waitForCarrierClosure({ timeoutMs: 3000 });
  await eventually(() => governor.snapshot().activeLeaseCount === 0, '原终止完成后释放容量');
  assert.deepEqual((await supervisor.shutdown({ timeoutMs: 1000 })).errors, []);
  assert.equal(await control.promise, result);
});

test('close 超时的原调用仍被拥有，稍后完成后自动收敛且不重复 close', async (t) => {
  const { supervisor, governor, state } = harness(t, { cleanupTimeoutMs: 30 });
  state.closePending = deferred();
  const control = supervisor.start(request('close-pending'));
  const result = await control.promise;
  const report = await supervisor.shutdown({ timeoutMs: 1000 });
  assert.ok(report.leakedTransports.includes('close-pending'));
  assert.equal(state.closeCalls, 1);
  assert.equal(control.getCarrierObservation().disposition, 'UNKNOWN');
  state.closePending.resolve();
  assert.equal((await control.waitForCarrierClosure({ timeoutMs: 3000 })).disposition, 'EXITED');
  await eventually(() => governor.snapshot().activeLeaseCount === 0, '原 close 完成后释放容量');
  assert.equal(state.closeCalls, 1);
  assert.deepEqual((await supervisor.shutdown({ timeoutMs: 1000 })).errors, []);
  assert.equal(await control.promise, result);
});

test('RuntimeManager 在原载体未决时拒绝换 runtime，真实退出后才能重试并换代', async (t) => {
  let creations = 0;
  const original = harness(t, { terminate: 'reject' });
  const replacement = harness(t);
  const manager = createBackgroundExecutionRuntimeManager({
    runtimeFactory() { return ++creations === 1 ? original.supervisor : replacement.supervisor; }
  });
  const control = manager.get().start(request('same-identifiers'));
  const result = await control.promise;
  assert.ok((await manager.shutdown({ timeoutMs: 1000 })).leakedTransports.length > 0);
  assert.throws(() => manager.resume(), (error) => error.code === 'BACKGROUND_EXECUTION_RUNTIME_SHUTDOWN_UNRESOLVED');
  assert.equal(creations, 1);
  original.state.workers[0].postMessage({ fixture: 'exit' });
  await control.waitForCarrierClosure({ timeoutMs: 3000 });
  assert.deepEqual((await manager.shutdown({ timeoutMs: 1000 })).errors, []);
  manager.resume();
  const fresh = manager.get().start(request('same-identifiers', 'done'));
  assert.equal((await fresh.promise).outcome, 'completed');
  assert.notEqual(fresh.carrierIdentity.runtimeInstanceId, control.carrierIdentity.runtimeInstanceId);
  assert.notEqual(fresh.carrierIdentity.dispatchNonce, control.carrierIdentity.dispatchNonce);
  const observation = fresh.getCarrierObservation();
  original.state.callbacks[0].onCarrierExit(77);
  assert.equal(fresh.getCarrierObservation(), observation);
  assert.equal(await control.promise, result);
});

test('显式启用拒绝缺失任务身份、未支持载体和缺少生产持久化接入', async (t) => {
  const simple = harness(t);
  assert.throws(() => simple.supervisor.start({ ...request(), context: { kind: 'none', value: {} } }),
    (error) => error.code === 'CARRIER_TASK_IDENTITY_REQUIRED');
  const unsupported = harness(t, { policy(policy) { policy.mode = 'utility-process'; } });
  assert.throws(() => unsupported.supervisor.start(request()),
    (error) => error.code === 'CARRIER_OBSERVATION_UNSUPPORTED');
  const production = harness(t, { policy(policy) {
    policy.production.enabled = true;
    policy.production.effectiveMode = 'thread-single';
    policy.production.effectiveWorkerCount = 1;
  } });
  assert.throws(() => production.supervisor.start({ ...request(), production: true }),
    (error) => error.code === 'CARRIER_DISPATCH_BINDING_REQUIRED');
  assert.equal(simple.state.starts + unsupported.state.starts + production.state.starts, 0);
});
