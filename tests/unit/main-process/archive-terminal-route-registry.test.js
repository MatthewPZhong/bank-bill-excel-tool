'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  assertTerminalRouteRegistry, createTerminalRouteRegistry
} = require('../../../src/main-process/archive-center/terminal-route-registry');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createTestTerminalRouteRegistry } = require('../../helpers/archive-terminal-routes');
const {
  createPendingTerminalRouteRegistration
} = require('../../../src/main-process/pending-archive-lineage');
const {
  createPreFundTerminalRouteRegistration
} = require('../../../src/main-process/pre-fund-archive-lineage');
const {
  createBizOpRunTerminalRouteRegistration
} = require('../../../src/main-process/biz-op-recon-run-data');
const { createPositionTaskOwner } = require('../../../src/main-process/position-reconciliation/task-owner');
const { runMigrations } = require('../../../src/backend/pending-db/migrations');
const diffRepository = require('../../../src/backend/pending-db/diff-repository');

function context(taskRunId = 'original-task') {
  return { taskRunId, taskKey: 'test:run', moduleId: 'test', parentRunId: 'original-parent',
    operationKey: 'original-operation' };
}
function operationRecord(taskRunId = 'original-task') {
  return { payload: { owner: { version: 1, kind: 'operation', operationContext: context(taskRunId) } } };
}

for (const [route, field, label] of [
  ['position-reconciliation', 'operationToken', 'Position'],
  ['pending-run', 'taskRunId', 'Pending'],
  ['biz-op-run', 'taskRunId', 'Biz OP'],
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

test('Pending live/replay 使用真实 receipt，实际 owner 错配不 ACK，重复回放幂等', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  runMigrations(db);
  diffRepository.createRun(db, { upperMonth: '2026-07', lowerMonth: '2026-08', ruleSnapshot: {},
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'original-task' } });
  const registry = createTerminalRouteRegistry([createPendingTerminalRouteRegistration({ getDb: () => db })]);
  const route = { route: 'pending-run', taskRunId: 'original-task' };
  const hook = registry.createAfterTerminal(route);
  await assert.rejects(hook({ context: context('wrong-task'), terminalStatus: 'succeeded' }), /owner/);
  assert.equal(diffRepository.getRunByArchiveTaskRunId(db, 'original-task').archiveTerminalAckAt, null);
  await hook({ context: context(), terminalStatus: 'failed' });
  assert.equal(diffRepository.getRunByArchiveTaskRunId(db, 'original-task').archiveTerminalAckAt, null);
  await hook({ context: context(), terminalStatus: 'succeeded' });
  const acknowledged = diffRepository.getRunByArchiveTaskRunId(db, 'original-task').archiveTerminalAckAt;
  assert.ok(acknowledged);
  await registry.finalize({ route, record: operationRecord(), terminalOutcome: { taskStatus: 'succeeded' } });
  assert.equal(diffRepository.getRunByArchiveTaskRunId(db, 'original-task').archiveTerminalAckAt, acknowledged);
  await assert.rejects(registry.finalize({ route, record: { payload: {} }, terminalOutcome: { taskStatus: 'succeeded' } }), /owner/);
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

test('Biz OP registry live/replay 都通过限定 legacy 能力，retired 拒绝先于数据库访问', async () => {
  let retired = false;
  const calls = [];
  const registry = createTerminalRouteRegistry([createBizOpRunTerminalRouteRegistration({
    getUserDataDir: () => '/tmp/biz-op-terminal-registry',
    getMainDb: () => { calls.push('db'); return null; },
    assertLegacyAvailable: () => { calls.push('guard'); if (retired) throw Object.assign(new Error('已停用'), { code: 'BIZOP_LEGACY_RETIRED' }); },
    withLegacyRecovery: async (directory, run) => { calls.push(['recovery', directory]); return run(); }
  })]);
  const route = { route: 'biz-op-run', taskRunId: 'original-task' };
  await registry.createAfterTerminal(route)({ context: context(), terminalStatus: 'failed' });
  assert.deepEqual(calls, ['guard', ['recovery', '/tmp/biz-op-terminal-registry'], 'db']);
  calls.length = 0;
  await assert.rejects(registry.finalize({ route, record: operationRecord('wrong-task'),
    terminalOutcome: { taskStatus: 'succeeded' } }), /owner/);
  retired = true;
  calls.length = 0;
  await assert.rejects(registry.createAfterTerminal(route)({ context: context(), terminalStatus: 'succeeded' }),
    { code: 'BIZOP_LEGACY_RETIRED' });
  await assert.rejects(registry.finalize({ route, record: operationRecord(), terminalOutcome: { taskStatus: 'succeeded' } }),
    { code: 'BIZOP_LEGACY_RETIRED' });
  assert.deepEqual(calls, ['guard', 'guard']);
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
