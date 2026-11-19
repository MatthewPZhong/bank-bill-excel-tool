'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertTerminalRouteRegistry, createTerminalRouteRegistry
} = require('../../../src/main-process/archive-center/terminal-route-registry');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createTestTerminalRouteRegistry } = require('../../helpers/archive-terminal-routes');
const {
  createPreFundTerminalRouteRegistration
} = require('../../../src/main-process/pre-fund-archive-lineage');
const {
  createRetiredTerminalRouteRegistrations, RETIRED_TERMINAL_ROUTES
} = require('../../../src/main-process/archive-center/retired-terminal-routes');
const { createPositionTaskOwner } = require('../../../src/main-process/position-reconciliation/task-owner');

function context(taskRunId = 'original-task') {
  return { taskRunId, taskKey: 'test:run', moduleId: 'test', parentRunId: 'original-parent',
    operationKey: 'original-operation' };
}
function operationRecord(taskRunId = 'original-task') {
  return { payload: { owner: { version: 1, kind: 'operation', operationContext: context(taskRunId) } } };
}

for (const [route, field, label] of [
  ['position-reconciliation', 'operationToken', 'Position'],
  ['pre-fund-run', 'taskRunId', 'Pre-fund']
]) {
  test(`${route} 历史 payload trim/裁剪后冻结，空身份保留 TypeError`, () => {
    const registry = createTestTerminalRouteRegistry();
    const input = { route: ` ${route} `, [field]: ' original-task ', legacyExtra: 1 };
    const normalized = registry.normalize(input);
    assert.deepEqual(normalized, { route, [field]: 'original-task' });
    assert.equal(Object.isFrozen(normalized), true);
    assert.throws(() => { normalized[field] = 'other-task'; }, TypeError);
    assert.equal(input[field], ' original-task ');
    for (const invalid of [undefined, null, '', '   ']) {
      assert.throws(() => registry.normalize({ route, [field]: invalid }),
        { name: 'TypeError', message: `${label} terminal route.${field} 为空` });
    }
  });
}

test('registry null 容忍，未知/非法 route 沿用失败关闭异常', async () => {
  const registry = createTestTerminalRouteRegistry();
  assert.equal(registry.normalize(null), null);
  assert.equal(registry.normalize(undefined), null);
  for (const value of [false, 12, 'pending-run', []]) {
    assert.throws(() => registry.normalize(value), { name: 'TypeError', message: '任务终态意图 afterTerminal 格式非法' });
  }
  assert.throws(() => registry.normalize({ route: '  ' }), { name: 'TypeError', message: '任务终态意图 afterTerminal.route 为空' });
  await assert.rejects(registry.finalize({ route: { route: 'unknown' } }),
    { name: 'TypeError', message: '不支持的任务终态 afterTerminal route：unknown' });
});

test('registry 初始化拒绝重复或缺半对，静态快照不被输入修改', async () => {
  const normalize = (value) => ({ route: value.route, nested: { taskRunId: value.taskRunId } });
  let finalized = null;
  const entry = { route: 'demo', normalize, finalize: (payload) => { finalized = payload.route; } };
  for (const entries of [null, {}, [null], [{ route: 'demo', normalize }],
    [{ route: 'demo', finalize() {} }], [entry, { ...entry, route: ' demo ' }]]) {
    assert.throws(() => createTerminalRouteRegistry(entries), { code: 'ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID' });
  }
  const entries = [entry];
  const registry = createTerminalRouteRegistry(entries);
  entry.finalize = () => { throw new Error('注册后篡改'); };
  entries.length = 0;
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(assertTerminalRouteRegistry(registry), registry);
  await registry.finalize({ route: { route: 'demo', taskRunId: 'original' } });
  assert.equal(Object.isFrozen(finalized.nested), true);
  assert.equal(finalized.nested.taskRunId, 'original');
  assert.throws(() => assertTerminalRouteRegistry({ normalize, finalize() {} }),
    { code: 'ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID' });
  assert.throws(() => assertTerminalRouteRegistry(Object.freeze({ normalize, finalize() {} })),
    { code: 'ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID' });
});

test('normalizer 不得跨 route 或将函数/循环对象写入持久终态', () => {
  for (const normalize of [() => ({ route: 'other' }), () => ({ route: 'demo', callback() {} }),
    () => { const value = { route: 'demo' }; value.self = value; return value; }]) {
    const registry = createTerminalRouteRegistry([{ route: 'demo', normalize, finalize() {} }]);
    assert.throws(() => registry.normalize({ route: 'demo' }), TypeError);
  }
});

test('Controller 初始化拒绝未冻结/伪造 registry，无注册时不会默认接管历史 route', () => {
  const options = { database: { getSetting() {}, setSetting() {} }, service: { createBatch() {}, appendFiles() {} } };
  assert.throws(() => createArchiveCenterController({ ...options, terminalRouteRegistry: {} }),
    { code: 'ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID' });
  const controller = createArchiveCenterController(options);
  assert.throws(() => controller.terminalRouteRegistry.normalize({ route: 'pending-run', taskRunId: 'task' }),
    /不支持的任务终态/);
});

test('PreFund live/replay 保留真实终态优先、operation owner 校验及 ACK 路径', async () => {
  const acknowledged = [];
  const registry = createTerminalRouteRegistry([createPreFundTerminalRouteRegistration({
    getService: () => ({ acknowledgeRunByTaskRun: (taskRunId) => acknowledged.push(taskRunId) })
  })]);
  const route = { route: 'pre-fund-run', taskRunId: 'original-task' };
  await registry.finalize({ route, record: operationRecord('wrong-task'),
    terminalOutcome: { taskStatus: 'succeeded' }, terminalResult: { taskRun: { status: 'failed' } } });
  assert.deepEqual(acknowledged, []);
  await assert.rejects(registry.finalize({ route, record: operationRecord('wrong-task'),
    terminalOutcome: { taskStatus: 'succeeded' } }), /owner/);
  await registry.createAfterTerminal(route)({ context: context(), terminalStatus: 'succeeded' });
  await registry.finalize({ route, record: operationRecord(), terminalOutcome: { taskStatus: 'succeeded' } });
  assert.deepEqual(acknowledged, ['original-task', 'original-task']);
  assert.throws(() => registry.createAfterTerminal(route)({ context: { ...context(), batchId: 1 },
    terminalStatus: 'succeeded' }), /exact-5/);
});

// v3.2.20：月度Pending / 业务OP 已下线，遗留 route 只收口任务终态，业务侧收尾不再执行。
test('已下线模块的遗留 route 同形规范化、缺身份不抛错，live/replay 只记录不触达业务数据', async () => {
  const seen = [];
  const registry = createTerminalRouteRegistry(createRetiredTerminalRouteRegistrations({
    onRetiredFinalize: (info) => seen.push(info)
  }));
  assert.deepEqual([...RETIRED_TERMINAL_ROUTES], ['pending-run', 'biz-op-run']);
  for (const route of RETIRED_TERMINAL_ROUTES) {
    const normalized = registry.normalize({ route: ` ${route} `, taskRunId: ' original-task ', legacyExtra: 1 });
    assert.deepEqual(normalized, { route, taskRunId: 'original-task' });
    assert.equal(Object.isFrozen(normalized), true);
    assert.deepEqual(registry.normalize({ route, taskRunId: '' }), { route });
    const result = await registry.finalize({ route: normalized, record: operationRecord(), terminalOutcome: { taskStatus: 'succeeded' } });
    assert.deepEqual(result, { route, retired: true });
    await registry.createAfterTerminal(normalized)({ context: context(), terminalStatus: 'failed' });
  }
  assert.deepEqual(seen, [
    { route: 'pending-run', taskStatus: 'succeeded', taskRunId: 'original-task' },
    { route: 'pending-run', taskStatus: 'failed', taskRunId: 'original-task' },
    { route: 'biz-op-run', taskStatus: 'succeeded', taskRunId: 'original-task' },
    { route: 'biz-op-run', taskStatus: 'failed', taskRunId: 'original-task' }
  ]);
  assert.throws(() => createRetiredTerminalRouteRegistrations({ onRetiredFinalize: 1 }), TypeError);
});

test('Position registry 保留 token/owner 与历史无 owner 批次检查，已清 pending 重放幂等', async () => {
  let pending = null;
  const owner = createPositionTaskOwner({
    settingsAvailable: () => true,
    readSetting: () => pending ? JSON.stringify(pending) : '',
    writeSetting() { throw new Error('拒绝分支不能改设置'); }
  });
  const registry = createTerminalRouteRegistry([owner.terminalRegistration]);
  const route = { route: 'position-reconciliation', operationToken: 'original-task' };
  const record = { payload: { ...operationRecord().payload, metadata: { positionOperationToken: 'original-task' } } };
  await registry.finalize({ route, record });
  await registry.finalize({ route, record });
  await assert.rejects(registry.finalize({ route, record: { payload: { metadata: { positionOperationToken: 'wrong-task' } } } }), /路由与 outbox 身份不一致/);
  pending = { operationToken: 'original-task', owner: operationRecord().payload.owner };
  await assert.rejects(registry.finalize({ route, record: { payload: { ...record.payload,
    owner: operationRecord('wrong-task').payload.owner } } }), /owner 与 pending/);
  await assert.rejects(registry.finalize({ route, record: { payload: { metadata: record.payload.metadata, targetBatchId: 1 } } }), /目标批次与 pending/);
});
