'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreparedResourceScope } = require('../../../src/main-process/task-adapters/prepared-resources');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ cleanupError, abandon } = {}) {
  const diagnostics = [];
  let attempts = 0;
  const scope = createPreparedResourceScope({
    async onAbandon() {
      attempts += 1;
      if (abandon) await abandon();
      if (cleanupError) throw cleanupError;
    }
  }, { reportCleanupFailure: (diagnostic) => diagnostics.push(diagnostic) });
  return { scope, diagnostics, attempts: () => attempts };
}

for (const synchronous of [true, false]) {
  test(`${synchronous ? '同步' : '异步'} work 抛错会 abandon 一次并保留同一原错误`, async () => {
    const original = new Error('构建失败');
    const { scope, attempts } = fixture();
    const work = synchronous ? () => { throw original; } : async () => { throw original; };
    await assert.rejects(scope.run(work), (error) => error === original);
    assert.equal(attempts(), 1);
    assert.deepEqual(scope.snapshot(), { owner: 'released', abandonAttempted: true });
  });
}

for (const enteredLifecycle of [false, true]) {
  test(`${enteredLifecycle ? '生命周期内' : '进入生命周期前'} 双异常按既定优先级并保留两份诊断`, async () => {
    const originalError = Object.assign(new Error('入口拒绝'), { code: 'ORIGINAL_FAILURE' });
    const cleanupError = Object.assign(new Error('清理失败'), { code: 'CLEANUP_FAILURE' });
    const { scope, attempts, diagnostics } = fixture({ cleanupError });
    const promise = scope.run(() => {
      if (enteredLifecycle) scope.enterLifecycle();
      throw originalError;
    });
    const expected = enteredLifecycle ? cleanupError : originalError;
    await assert.rejects(promise, (error) => error === expected);
    assert.equal(scope.run(() => assert.fail('失败后不能再次执行')), promise);
    await assert.rejects(promise, (error) => error === expected);
    assert.equal(attempts(), 1);
    assert.deepEqual(scope.snapshot(), { owner: 'scope', abandonAttempted: true });
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      originalError, cleanupError, enteredLifecycle, owner: 'scope', abandonAttempted: true
    });
    assert.equal(diagnostics[0].originalError.code, 'ORIGINAL_FAILURE');
    assert.equal(diagnostics[0].cleanupError.code, 'CLEANUP_FAILURE');
    assert.throws(() => scope.markExecuteStarted(), /已终结/);
  });
}

for (const enteredLifecycle of [false, true]) {
  for (const failedCleanup of [false, true]) {
    test(`${enteredLifecycle ? '准入拒绝' : 'lifecycle 不可用'}返回时${failedCleanup ? '传播清理异常' : '清理后返回原结果'}`, async () => {
      const result = { status: 'failed', code: 'ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE' };
      const cleanupError = failedCleanup ? new Error('清理失败') : undefined;
      const { scope, attempts, diagnostics } = fixture({ cleanupError });
      const operation = scope.run(() => {
        if (enteredLifecycle) scope.enterLifecycle();
        return result;
      });
      if (failedCleanup) {
        await assert.rejects(operation, (error) => error === cleanupError);
        assert.equal(diagnostics[0].originalError, undefined);
      } else {
        assert.equal(await operation, result);
      }
      assert.equal(attempts(), 1);
    });
  }
}

test('run 并发和完成后复用同一个 Promise，work 与 abandon 均仅执行一次', async () => {
  const workReady = deferred();
  let executions = 0;
  const { scope, attempts } = fixture();
  const result = { status: 'busy' };
  const first = scope.run(async () => { executions += 1; await workReady.promise; return result; });
  const second = scope.run(() => assert.fail('第二份 work 不得执行'));
  assert.equal(first, second);
  workReady.resolve();
  assert.equal(await first, result);
  assert.equal(await second, result);
  assert.equal(scope.run(() => assert.fail('完成后不得重跑')), first);
  assert.equal(executions, 1);
  assert.equal(attempts(), 1);
});

test('接管前异步失败等待延迟 abandon，整个 run 结算前不能再次移交', async () => {
  const original = new Error('beforeStart 失败');
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  const { scope, attempts } = fixture({ abandon: async () => {
    cleanupEntered.resolve();
    await releaseCleanup.promise;
  } });
  let settled = false;
  const operation = scope.run(() => { scope.enterLifecycle(); throw original; });
  const observed = operation.then(
    () => { settled = true; },
    (error) => { settled = true; return error; }
  );
  try {
    await cleanupEntered.promise;
    assert.equal(attempts(), 1);
    assert.equal(settled, false);
    assert.deepEqual(scope.snapshot(), { owner: 'scope', abandonAttempted: true });
    assert.throws(() => scope.markExecuteStarted(), /已终结/);
    assert.equal(scope.run(() => assert.fail('清理中不得重跑')), operation);
  } finally {
    releaseCleanup.resolve();
  }
  assert.equal(await observed, original);
  assert.equal(attempts(), 1);
  assert.deepEqual(scope.snapshot(), { owner: 'released', abandonAttempted: true });
});

for (const failed of [false, true]) {
  test(`execution 接管后${failed ? '失败' : '成功'}均不调用通用 abandon，重复标记幂等`, async () => {
    const original = new Error('业务失败');
    const { scope, attempts } = fixture();
    const operation = scope.run(() => {
      scope.enterLifecycle();
      scope.markExecuteStarted();
      scope.markExecuteStarted();
      assert.deepEqual(scope.snapshot(), { owner: 'execution', abandonAttempted: false });
      if (failed) throw original;
      return '完成';
    });
    if (failed) await assert.rejects(operation, (error) => error === original);
    else assert.equal(await operation, '完成');
    assert.equal(attempts(), 0);
    assert.deepEqual(scope.snapshot(), { owner: 'execution', abandonAttempted: false });
    assert.throws(() => scope.markExecuteStarted(), /已终结/);
    assert.throws(() => scope.enterLifecycle(), /已终结/);
  });
}

test('scope 和 snapshot 冻结，快照独立于后续状态；无 callback 只结算自身义务', async () => {
  const scope = createPreparedResourceScope({});
  const before = scope.snapshot();
  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(before));
  assert.throws(() => { before.owner = 'execution'; }, TypeError);
  assert.equal(await scope.run(() => '无资源'), '无资源');
  assert.deepEqual(before, { owner: 'scope', abandonAttempted: false });
  assert.deepEqual(scope.snapshot(), { owner: 'released', abandonAttempted: true });
  assert.throws(() => scope.markExecuteStarted(), /已终结/);
});

test('清理回调保留 prepared receiver，资源入口不会在 scope 内猜测文件路径', async () => {
  const prepared = {
    resource: 'opaque-owner-token',
    onAbandon() { assert.equal(this, prepared); this.abandoned = this.resource; }
  };
  await createPreparedResourceScope(prepared).run(() => null);
  assert.equal(prepared.abandoned, 'opaque-owner-token');
});

test('新的前置路径连非 Error 拒绝原因也保持原值，不被 cleanup 失败覆盖', async () => {
  const { scope, diagnostics } = fixture({ cleanupError: new Error('清理失败') });
  const result = await scope.run(() => Promise.reject(undefined)).then(
    () => ({ success: true }), (error) => ({ success: false, error })
  );
  assert.deepEqual(result, { success: false, error: undefined });
  assert.equal(diagnostics.length, 1);
});

test('清理诊断写入也是退出等待的一部分', async () => {
  const entered = deferred();
  const released = deferred();
  const cleanupError = new Error('清理失败');
  const scope = createPreparedResourceScope({ onAbandon() { throw cleanupError; } }, {
    async reportCleanupFailure() { entered.resolve(); await released.promise; }
  });
  let settled = false;
  const operation = scope.run(() => undefined).catch((error) => { settled = true; return error; });
  try {
    await entered.promise;
    assert.equal(settled, false);
  } finally {
    released.resolve();
  }
  assert.equal(await operation, cleanupError);
});

test('诊断 callback 失败不改变双异常优先级，并转交兜底内部日志', async (t) => {
  const originalError = Object.assign(new Error('gate 拒绝'), { code: 'GATE_FAILED' });
  const cleanupError = new Error('清理失败');
  const reportingError = new Error('日志失败');
  const logged = [];
  const logger = require('../../../src/backend/logger');
  t.mock.method(logger, 'appendModuleLog', (payload) => logged.push(payload));
  const scope = createPreparedResourceScope({ onAbandon() { throw cleanupError; } }, {
    reportCleanupFailure() { throw reportingError; }
  });
  await assert.rejects(scope.run(() => { throw originalError; }), (error) => error === originalError);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, 'error');
  assert.deepEqual(logged[0].details, [
    'originalError: GATE_FAILED gate 拒绝', 'cleanupError:  清理失败', 'reportingError:  日志失败'
  ]);
  assert.deepEqual(scope.snapshot(), { owner: 'scope', abandonAttempted: true });
});

// 默认诊断也必须进入项目持久日志，不绕过全局日志策略。
test('默认清理诊断使用已配置模块日志并保留原错误与清理错误', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const logger = require('../../../src/backend/logger');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-resource-log-'));
  logger.setActivityLogStorageRoot(root);
  t.after(() => { logger.setActivityLogStorageRoot(null); fs.rmSync(root, { recursive: true, force: true }); });
  const originalError = Object.assign(new Error('构建失败'), { code: 'BUILD_FAILED' });
  const cleanupError = Object.assign(new Error('释放失败'), { code: 'CLEANUP_FAILED' });
  const scope = createPreparedResourceScope({ onAbandon() { throw cleanupError; } });
  await assert.rejects(scope.run(() => { throw originalError; }), (error) => error === originalError);
  const content = fs.readFileSync(logger.getLogFilePath(root, 'error', new Date()), 'utf8');
  assert.match(content, /BUILD_FAILED/);
  assert.match(content, /CLEANUP_FAILED/);
  assert.match(content, /任务准备资源收口失败/);
  assert.deepEqual(scope.snapshot(), { owner: 'scope', abandonAttempted: true });
});
