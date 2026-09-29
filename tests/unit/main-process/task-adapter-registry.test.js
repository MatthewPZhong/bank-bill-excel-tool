'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskAdapterRegistry } = require('../../../src/main-process/task-adapters/registry');
const { createPassthroughTaskAdapter } = require('../../../src/main-process/task-adapters/passthrough');
const { createPreparedResourceScope } = require('../../../src/main-process/task-adapters/prepared-resources');

const valid = () => ({ adapters: [createPassthroughTaskAdapter()],
  taskBindings: [{ taskKey: 'ordinary:run', adapterId: 'passthrough' }] });

for (const [name, config] of [
  ['缺少 adapters', () => ({ taskBindings: [] })],
  ['缺少 taskBindings', () => ({ adapters: [] })],
  ['adapters 不是数组', () => ({ adapters: {}, taskBindings: [] })],
  ['缺 id', () => ({ adapters: [{ createInvocation() {} }], taskBindings: [] })],
  ['缺 createInvocation', () => ({ adapters: [{ id: 'bad' }], taskBindings: [] })],
  ['重复 id', () => ({ ...valid(), adapters: [createPassthroughTaskAdapter(), createPassthroughTaskAdapter()] })],
  ['缺 taskKey', () => ({ ...valid(), taskBindings: [{ adapterId: 'passthrough' }] })],
  ['空 taskKey', () => ({ ...valid(), taskBindings: [{ taskKey: ' ', adapterId: 'passthrough' }] })],
  ['缺 adapterId', () => ({ ...valid(), taskBindings: [{ taskKey: 'ordinary:run' }] })],
  ['不存在的 adapter', () => ({ ...valid(), taskBindings: [{ taskKey: 'ordinary:run', adapterId: 'missing' }] })],
  ['重复 taskKey', () => ({ ...valid(), taskBindings: [...valid().taskBindings, ...valid().taskBindings] })]
]) {
  test(`注册失败关闭：${name}`, () => {
    assert.throws(() => createTaskAdapterRegistry(config()), { code: 'TASK_ADAPTER_REGISTRATION_INVALID' });
  });
}

test('只能解析显式 binding；未知任务及相同前缀任务不能隐式 fallback', () => {
  const registry = createTaskAdapterRegistry(valid());
  assert.equal(registry.resolve('ordinary:run').id, 'passthrough');
  for (const key of ['ordinary:run:unknown', 'ordinary:delete', undefined, null, '', ' ordinary:run ']) {
    assert.throws(() => registry.resolve(key), { code: 'TASK_ADAPTER_UNBOUND' });
  }
});

test('registry 与注册项冻结，调用方修改原注册数组不会影响快照', () => {
  const originalFactory = () => ({ identity: 'original' });
  const adapter = { id: 'adapter', createInvocation: originalFactory };
  const binding = { taskKey: 'task', adapterId: 'adapter' };
  const adapters = [adapter];
  const taskBindings = [binding];
  const registry = createTaskAdapterRegistry({ adapters, taskBindings });
  adapter.id = 'other';
  adapter.createInvocation = () => assert.fail('被改写的 factory 不得使用');
  binding.taskKey = 'other';
  adapters.length = 0;
  taskBindings.length = 0;
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.resolve('task')));
  assert.equal(registry.resolve('task').createInvocation, originalFactory);
  assert.deepEqual(registry.resolve('task').createInvocation(), { identity: 'original' });
  assert.throws(() => { registry.resolve('task').createInvocation = () => {}; }, TypeError);
  assert.throws(() => registry.resolve('other'), { code: 'TASK_ADAPTER_UNBOUND' });
});

test('注册快照只保留公开合同字段，无动态注册入口', () => {
  const adapter = { id: 'adapter', createInvocation() {}, privateOwner: 'private' };
  const registry = createTaskAdapterRegistry({ adapters: [adapter], taskBindings: [{ taskKey: 'task', adapterId: 'adapter' }] });
  assert.deepEqual(Object.keys(registry), ['resolve']);
  assert.deepEqual(Object.keys(registry.resolve('task')), ['id', 'createInvocation']);
});

test('passthrough 原样透传显式身份、intent 和 hook，每个 invocation 独立', () => {
  const adapter = createPassthroughTaskAdapter();
  const afterTerminalIntent = { route: 'pending-run', taskRunId: 'task' };
  const afterTerminal = () => {};
  const prepared = { taskRunId: 'prepared-task', operationKey: 'prepared-operation', afterTerminalIntent, afterTerminal };
  const invocation = adapter.createInvocation({ prepared });
  assert.deepEqual(invocation.identity, { taskRunId: prepared.taskRunId, operationKey: prepared.operationKey });
  assert.equal(invocation.afterTerminal, afterTerminal);
  assert.equal(invocation.afterTerminalIntent, afterTerminalIntent);
  const other = adapter.createInvocation({ prepared });
  assert.notEqual(other, invocation);
  assert.notEqual(other.identity, invocation.identity);
  other.identity.taskRunId = 'other';
  assert.equal(invocation.identity.taskRunId, 'prepared-task');
});

test('passthrough 不分配缺省身份，没有 hook 时交还 lifecycle 原默认值', () => {
  const adapter = createPassthroughTaskAdapter();
  for (const prepared of [undefined, null, {}, { taskRunId: '', operationKey: '', afterTerminal: 'invalid' }]) {
    const invocation = adapter.createInvocation({ prepared });
    assert.deepEqual(invocation.identity, { taskRunId: undefined, operationKey: undefined });
    assert.equal(invocation.afterTerminal, null);
    assert.equal(invocation.afterTerminalIntent, null);
  }
});

for (const failed of [false, true]) {
  test(`passthrough 在真实 executeBusiness 紧前接管，业务${failed ? '抛错' : '成功'}保留结果`, async () => {
    const original = new Error('业务失败');
    const result = { status: 'ok' };
    let abandon = 0;
    const order = [];
    const scope = createPreparedResourceScope({ onAbandon() { abandon += 1; } });
    const invocation = createPassthroughTaskAdapter().createInvocation({ prepared: {} });
    const operation = scope.run(() => invocation.execute({
      taskContext: {}, controls: {},
      markExecuteStarted() { order.push('handoff'); scope.markExecuteStarted(); },
      executeBusiness() {
        order.push('business');
        assert.equal(scope.snapshot().owner, 'execution');
        if (failed) throw original;
        return result;
      }
    }));
    if (failed) await assert.rejects(operation, (error) => error === original);
    else assert.equal(await operation, result);
    assert.deepEqual(order, ['handoff', 'business']);
    assert.equal(abandon, 0);
  });
}
