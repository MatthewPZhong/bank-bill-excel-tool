'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createArchiveAwareOperationHarness,
  deferred
} = require('../../helpers/archive-aware-operation-harness');

const codedError = (code) => Object.assign(new Error(code), { code });

function resourceContract(options = {}) {
  const counts = { prepare: 0, abandon: 0, beforeStart: 0 };
  const handler = {
    async prepare() {
      counts.prepare += 1;
      return {
        proceed: true,
        ...options.prepared,
        async onAbandon() {
          counts.abandon += 1;
          if (options.abandon) await options.abandon();
        },
        async beforeStart(...args) {
          counts.beforeStart += 1;
          return options.beforeStart ? options.beforeStart(...args) : {};
        }
      };
    },
    execute: options.execute || (() => ({ status: 'success' }))
  };
  return { counts, handler };
}

function assertNotExecuted(harness) {
  assert.equal(harness.counts.business, 0);
  assert.equal(harness.counts.admission, 0);
}

test('真实入口：首次 Hold gate 拒绝发生在 prepare 之前', async () => {
  const error = codedError('RECOVERY_HOLD_ACTIVE');
  const harness = createArchiveAwareOperationHarness({ gate() { throw error; } });
  const resource = resourceContract();
  await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  assert.equal(resource.counts.prepare, 0);
  assert.equal(resource.counts.abandon, 0);
  assert.equal(harness.counts.lifecycle, 0);
  assertNotExecuted(harness);
});

test('真实入口：prepare 取消原样返回，prepare 自身释放资源且不进入 lifecycle', async () => {
  const harness = createArchiveAwareOperationHarness();
  const cancelled = { status: 'cancelled', source: 'prepare' };
  let prepareReleased = 0;
  let abandonCalls = 0;
  const result = await harness.run({
    async prepare() {
      try {
        return { proceed: false, result: cancelled, onAbandon() { abandonCalls += 1; } };
      } finally {
        prepareReleased += 1;
      }
    },
    execute() { throw new Error('取消后不应执行'); }
  });
  assert.equal(result, cancelled);
  assert.equal(prepareReleased, 1);
  assert.equal(abandonCalls, 0);
  assert.equal(harness.counts.gate, 1);
  assert.equal(harness.counts.lifecycle, 0);
  assertNotExecuted(harness);
});

test('真实入口：prepare 抛错保留原异常，资源仍由 prepare 自身收口', async () => {
  const harness = createArchiveAwareOperationHarness();
  const error = codedError('PREPARE_REJECTED');
  let prepareReleased = 0;
  await assert.rejects(harness.run({
    async prepare() {
      try { throw error; } finally { prepareReleased += 1; }
    },
    execute() { throw new Error('prepare 失败后不应执行'); }
  }), (actual) => actual === error);
  assert.equal(prepareReleased, 1);
  assert.equal(harness.counts.gate, 1);
  assert.equal(harness.counts.lifecycle, 0);
  assertNotExecuted(harness);
});

for (const scenario of ['second-gate', 'archive-initialize']) {
  test(`目标：prepare 成功后 ${scenario} 失败须 abandon 一次并保留原异常`, async () => {
    const error = codedError(scenario === 'second-gate' ? 'RECOVERY_HOLD_ACTIVE' : 'ARCHIVE_INIT_FAILED');
    const harness = createArchiveAwareOperationHarness(scenario === 'second-gate'
      ? { gate(_policy, _prepared, number) { if (number === 2) throw error; } }
      : { initializeError: error });
    const resource = resourceContract();
    await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
    assertNotExecuted(harness);
    assert.equal(harness.counts.lifecycle, 0);
    assert.equal(resource.counts.abandon, 1, 'prepare 成功后的资源须进入唯一收口范围');
  });

  test(`目标：${scenario} 与 cleanup 双异常时保留前置原异常且不重试清理`, async () => {
    const error = codedError(scenario === 'second-gate' ? 'RECOVERY_HOLD_ACTIVE' : 'ARCHIVE_INIT_FAILED');
    const cleanupError = codedError('PREPARED_CLEANUP_FAILED');
    const harness = createArchiveAwareOperationHarness(scenario === 'second-gate'
      ? { gate(_policy, _prepared, number) { if (number === 2) throw error; } }
      : { initializeError: error });
    const resource = resourceContract({ abandon() { throw cleanupError; } });
    await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
    await harness.getTail();
    assertNotExecuted(harness);
    assert.equal(harness.counts.lifecycle, 0);
    assert.equal(resource.counts.abandon, 1);
  });
}

test('真实入口：lifecycle 不可用沿用失败结果并 abandon 一次', async () => {
  const harness = createArchiveAwareOperationHarness({ lifecycleUnavailable: true });
  const resource = resourceContract();
  const result = await harness.run(resource.handler);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE');
  assert.equal(resource.counts.abandon, 1);
  assert.equal(harness.counts.lifecycle, 0);
  assertNotExecuted(harness);
});

test('真实入口：lifecycle 不可用且清理抛错时沿用 cleanup error 优先级', async () => {
  const cleanupError = codedError('PREPARED_CLEANUP_FAILED');
  const harness = createArchiveAwareOperationHarness({ lifecycleUnavailable: true });
  const resource = resourceContract({ abandon() { throw cleanupError; } });
  await assert.rejects(harness.run(resource.handler), (actual) => actual === cleanupError);
  assert.equal(resource.counts.abandon, 1);
  assertNotExecuted(harness);
});

test('真实入口：第三次 Hold gate 拒绝先于 prepared.beforeStart，abandon 一次', async () => {
  const error = codedError('RECOVERY_HOLD_ACTIVE');
  const harness = createArchiveAwareOperationHarness({
    gate(_policy, _prepared, number) { if (number === 3) throw error; }
  });
  const resource = resourceContract();
  await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  assert.equal(harness.counts.gate, 3);
  assert.equal(harness.counts.lifecycle, 1);
  assert.equal(resource.counts.beforeStart, 0);
  assert.equal(resource.counts.abandon, 1);
  assertNotExecuted(harness);
});

test('真实入口：prepared.beforeStart 拒绝尚未接管执行，abandon 一次', async () => {
  const error = codedError('PREPARED_BEFORE_START_FAILED');
  const harness = createArchiveAwareOperationHarness();
  const resource = resourceContract({ beforeStart() { throw error; } });
  await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  assert.equal(resource.counts.beforeStart, 1);
  assert.equal(resource.counts.abandon, 1);
  assertNotExecuted(harness);
});

test('真实入口：已进入 lifecycle 的 beforeStart 与 cleanup 双异常沿用 cleanup 优先级', async () => {
  const error = codedError('PREPARED_BEFORE_START_FAILED');
  const cleanupError = codedError('PREPARED_CLEANUP_FAILED');
  const harness = createArchiveAwareOperationHarness();
  const resource = resourceContract({
    beforeStart() { throw error; },
    abandon() { throw cleanupError; }
  });
  await assert.rejects(harness.run(resource.handler), (actual) => actual === cleanupError);
  await harness.getTail();
  assert.equal(resource.counts.abandon, 1);
  assertNotExecuted(harness);
});

test('真实入口：lifecycle 提前返回 busy 时不接管资源，abandon 一次', async () => {
  const busy = { status: 'busy', message: '测试用 lifecycle 拒绝' };
  const harness = createArchiveAwareOperationHarness({ runLifecycle() { return Promise.resolve(busy); } });
  const resource = resourceContract();
  assert.equal(await harness.run(resource.handler), busy);
  assert.equal(resource.counts.abandon, 1);
  assertNotExecuted(harness);
});

test('真实入口：Position admission 拒绝尚未接管资源，也不做业务 settlement', async () => {
  const busy = { status: 'busy' };
  const harness = createArchiveAwareOperationHarness({
    channel: 'position-reconciliation:run',
    admitPosition() { return busy; },
    // 终态后置由 TaskLifecycle 决定；本例只运行真实入口的 execute 回调。
    async runLifecycle(input, { ownerContext, controls }) {
      await input.beforeStart(ownerContext);
      return input.execute(ownerContext, controls);
    }
  });
  const resource = resourceContract();
  assert.equal(await harness.run(resource.handler), busy);
  assert.equal(harness.counts.business, 0);
  assert.equal(harness.counts.admission, 1);
  assert.equal(resource.counts.abandon, 1);
  assert.equal(harness.calls.some((call) => call === 'settle' || call.name === 'position-outcome'), false);
});

for (const channel of ['template:rename', 'position-reconciliation:run']) {
  for (const fails of [false, true]) {
    test(`真实入口：${channel} 执行接管后${fails ? '抛错' : '成功'}不再 abandon`, async () => {
      const error = codedError('BUSINESS_FAILED');
      const result = { status: 'success' };
      const harness = createArchiveAwareOperationHarness({ channel });
      const resource = resourceContract({ execute() { if (fails) throw error; return result; } });
      if (fails) await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
      else assert.equal(await harness.run(resource.handler), result);
      assert.equal(harness.counts.business, 1);
      assert.equal(resource.counts.abandon, 0);
      assert.equal(harness.counts.gate, 3);
    });
  }
}

test('真实入口：lifecycle 拒绝后的延迟 abandon 纳入 archiveOperationTail', async () => {
  const cleanupStarted = deferred();
  const cleanupRelease = deferred();
  const error = codedError('PREPARED_BEFORE_START_FAILED');
  const harness = createArchiveAwareOperationHarness();
  const resource = resourceContract({
    beforeStart() { throw error; },
    async abandon() { cleanupStarted.resolve(); await cleanupRelease.promise; }
  });
  const result = assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  await cleanupStarted.promise;
  let tailSettled = false;
  const tail = harness.getTail().then(() => { tailSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(tailSettled, false, '退出等待必须覆盖清理 Promise');
    assert.equal(resource.counts.abandon, 1);
  } finally {
    cleanupRelease.resolve();
    await result;
    await tail;
  }
});

test('目标：lifecycle 不可用路径的延迟 abandon 也须纳入 archiveOperationTail', async () => {
  const cleanupStarted = deferred();
  const cleanupRelease = deferred();
  const harness = createArchiveAwareOperationHarness({ lifecycleUnavailable: true });
  const resource = resourceContract({
    async abandon() { cleanupStarted.resolve(); await cleanupRelease.promise; }
  });
  const result = harness.run(resource.handler);
  await cleanupStarted.promise;
  let tailSettled = false;
  const tail = harness.getTail().then(() => { tailSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(tailSettled, false, '退出等待须覆盖 prepare 成功后的全部资源收口');
  } finally {
    cleanupRelease.resolve();
    assert.equal((await result).code, 'ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE');
    await tail;
    assert.equal(resource.counts.abandon, 1);
  }
});

test('目标：真实入口同步调用 lifecycle 抛错也须 abandon 一次', async () => {
  const error = codedError('LIFECYCLE_SYNC_FAILED');
  const harness = createArchiveAwareOperationHarness({ runLifecycle() { throw error; } });
  const resource = resourceContract();
  await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  assertNotExecuted(harness);
  assert.equal(resource.counts.abandon, 1);
});

for (const cleanupFails of [false, true]) {
  test(`真实入口：adapter 构建失败且 cleanupFails=${cleanupFails} 收口一次并保留主错误`, async () => {
    const error = codedError('ADAPTER_BUILD_FAILED');
    const cleanupError = codedError('CLEANUP_FAILED');
    const harness = createArchiveAwareOperationHarness({ adapterRegistry: {
      resolve: () => ({ createInvocation() { throw error; } })
    } });
    const resource = resourceContract({ abandon() { if (cleanupFails) throw cleanupError; } });
    await assert.rejects(harness.run(resource.handler), (actual) => actual === error);
    await harness.getTail();
    assertNotExecuted(harness);
    assert.equal(harness.counts.lifecycle, 0);
    assert.equal(resource.counts.abandon, 1);
    assert.equal(harness.cleanupDiagnostics.length, cleanupFails ? 1 : 0);
    if (cleanupFails) {
      assert.equal(harness.cleanupDiagnostics[0].originalError, error);
      assert.equal(harness.cleanupDiagnostics[0].cleanupError, cleanupError);
    }
  });
}

test('真实入口：第二 gate 失败后的延迟 cleanup 仍阻止退出 tail 结算', async () => {
  const error = codedError('RECOVERY_HOLD_ACTIVE');
  const entered = deferred();
  const release = deferred();
  const harness = createArchiveAwareOperationHarness({ gate(_policy, _prepared, count) {
    if (count === 2) throw error;
  } });
  const resource = resourceContract({ async abandon() { entered.resolve(); await release.promise; } });
  const operation = assert.rejects(harness.run(resource.handler), (actual) => actual === error);
  await entered.promise;
  let settled = false;
  const tail = harness.getTail().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal(settled, false); }
  finally { release.resolve(); await operation; await tail; }
  assert.equal(resource.counts.abandon, 1);
});
