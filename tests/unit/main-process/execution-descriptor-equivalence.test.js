'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  composeExecutionDescriptors, createBackgroundExecutionRuntimeManager
} = require('../../../src/main-process/execution-descriptors/composition');
const { BACKGROUND_EXECUTION_POLICIES } = require('../../../src/main-process/execution-descriptors/policy-catalog');
const { captureRuntimeBaseline, baselineRuntimeOptions } = require('../../helpers/execution-descriptor-runtime-baseline');
const baseline = require('../../fixtures/execution-descriptors/runtime-baseline.json');

function authorityPaths(generation) {
  const root = path.resolve(`/descriptor-equivalence/${generation}`);
  return {
    pendingDatabasePath: path.join(root, 'pending.sqlite'),
    mainDatabasePath: path.join(root, 'main.sqlite'),
    userDataDir: path.join(root, 'user-data'),
    vccFinancialOpDatabasePath: path.join(root, 'vcc.sqlite'),
    vccFinancialOpAssetsDir: path.join(root, 'assets'),
    reconFixJpmDatabasePath: path.join(root, 'recon.sqlite')
  };
}

function bind(compiled, actionKey, input = { marker: '保留业务输入' }) {
  return compiled.bindInputForAction({ actionKey, operationKey: 'equivalence-operation', input });
}

test('Main 最终装配入口保持原 49 action 的完整冻结 runtime 映射且 catalog 只读', () => {
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions());
  assert.deepEqual(captureRuntimeBaseline(compiled.policyRegistry), baseline);
  assert.equal(Object.isFrozen(BACKGROUND_EXECUTION_POLICIES), true);
  assert.deepEqual([...BACKGROUND_EXECUTION_POLICIES].map((policy) => policy.actionKey).sort(),
    compiled.policies.map((policy) => policy.actionKey).sort());
  assert.equal(compiled.moduleIds.length, 11);
});

test('全部 Main binder 保留输入、注入本代 authority，BizOP 只委派本域授权与 beforeDispatch', () => {
  const context = authorityPaths('generation-a');
  const calls = [];
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions({
    ...context,
    bizOpV327: {
      bindInput(identity) { calls.push({ kind: 'bind', identity }); return { ...identity.input, authority: 'bizop-a' }; },
      beforeDispatch(identity) { calls.push({ kind: 'dispatch', identity }); return 'dispatched-a'; }
    }
  }));
  for (const action of baseline.actions) {
    const input = { marker: action.actionKey };
    const result = bind(compiled, action.actionKey, input);
    const expected = { ...input };
    switch (action.mainBinding.kind) {
      case 'pending-database':
        expected.dbPathOrManagedSource = { kind: 'sqlite', databasePath: context.pendingDatabasePath };
        break;
      case 'biz-op-database':
        expected.dbPathOrManagedSource = { kind: 'biz-op-sqlite', mainDatabasePath: context.mainDatabasePath, userDataDir: context.userDataDir };
        break;
      case 'vcc-database-assets':
        expected.databasePath = context.vccFinancialOpDatabasePath;
        expected.assetsDir = context.vccFinancialOpAssetsDir;
        break;
      case 'recon-fix-jpm-database':
        expected.databasePath = context.reconFixJpmDatabasePath;
        break;
      case 'biz-op-v327-authority': {
        expected.authority = 'bizop-a';
        const identity = { actionKey: action.actionKey, operationKey: 'equivalence-operation' };
        assert.equal(compiled.beforeCarrierDispatch(identity), 'dispatched-a');
        break;
      }
      case 'passthrough':
        break;
      default:
        assert.fail(`未覆盖 binder：${action.mainBinding.kind}`);
    }
    assert.deepEqual(result, expected, action.actionKey);
    assert.deepEqual(input, { marker: action.actionKey }, 'binder 不改变 caller 输入');
    assert.deepEqual(compiled.defaultUnitsForAction(action.actionKey), action.mainBinding.defaultUnits);
  }
  assert.equal(calls.filter((call) => call.kind === 'bind').length, 12);
  assert.equal(calls.filter((call) => call.kind === 'dispatch').length, 12);
  assert.throws(() => bind(compiled, 'descriptor:unregistered'), { code: 'POLICY_NOT_FOUND' });
});

test('路径与 Duplicate startup gate 冻结在本代，后续 composition 不改变旧代 authority', () => {
  const options = { ...baselineRuntimeOptions(), ...authorityPaths('generation-a'),
    duplicateStartupGate: { contractVersion: 1, startupRecoveryReady: false } };
  const first = composeExecutionDescriptors(options);
  Object.assign(options, authorityPaths('generation-b'));
  options.duplicateStartupGate = { contractVersion: 1, startupRecoveryReady: true };
  const second = composeExecutionDescriptors(options);
  for (const [compiled, generation] of [[first, 'generation-a'], [second, 'generation-b']]) {
    const expected = authorityPaths(generation);
    assert.equal(bind(compiled, 'pending:export-diff').dbPathOrManagedSource.databasePath, expected.pendingDatabasePath);
    assert.deepEqual(bind(compiled, 'biz-op:export-day').dbPathOrManagedSource, {
      kind: 'biz-op-sqlite', mainDatabasePath: expected.mainDatabasePath, userDataDir: expected.userDataDir
    });
    const vcc = bind(compiled, 'vcc-financial-op:export-subjects');
    assert.equal(vcc.databasePath, expected.vccFinancialOpDatabasePath);
    assert.equal(vcc.assetsDir, expected.vccFinancialOpAssetsDir);
    assert.equal(bind(compiled, 'recon-fix:run-jpm').databasePath, expected.reconFixJpmDatabasePath);
    const entry = compiled.policyRegistry.getBinding('duplicate:import', 'entryKey');
    assert.equal(entry.workerData.startupGate.startupRecoveryReady, generation === 'generation-b');
    assert.equal(Object.isFrozen(entry.workerData.startupGate), true);
  }
});

test('原 Main 派发回调仅填充无本域回调的 action，不能替代 BizOP authority', () => {
  const calls = [];
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions({
    beforeCarrierDispatch(identity) { calls.push(identity); return 'main-dispatched'; }
  }));
  const identity = { actionKey: 'toolbox:merge', operationKey: 'dispatch-operation' };
  assert.equal(compiled.beforeCarrierDispatch(identity), 'main-dispatched');
  assert.deepEqual(calls, [identity]);
  assert.throws(() => compiled.beforeCarrierDispatch({
    actionKey: 'biz-op-v327:import-candidate', operationKey: 'dispatch-operation'
  }), { code: 'BIZOP_RUNTIME_AUTHORITY_REQUIRED' });
  assert.equal(calls.length, 1);
});

test('runtime manager 经真实 Supervisor 派发本代 binder，drain/resume 后重新读取 provider', async () => {
  let generation = 'generation-a';
  const observed = [];
  let starts = 0;
  const manager = createBackgroundExecutionRuntimeManager(baselineRuntimeOptions({
    pendingDatabasePathProvider: () => authorityPaths(generation).pendingDatabasePath,
    workerThreadAdapter: {
      start() {
        starts += 1;
        return {
          ready: Promise.resolve(),
          send(command) {
            if (command.operation === 'job:start') {
              observed.push(command.payload.input);
              throw Object.assign(new Error('测试完成派发观察'), { code: 'BINDER_DISPATCH_PROBE_STOP' });
            }
          },
          close() {}, terminate() { return Promise.resolve(0); }
        };
      }
    }
  }));
  async function execute(runtime, id) {
    const operationKey = `generation-operation-${id}`;
    return runtime.execute({
      actionKey: 'pending:export-diff', operationKey, production: false, input: { marker: id },
      context: { kind: 'operation', value: { taskRunId: `task-${id}`, taskKey: 'pending:diff:export-single',
        moduleId: 'pending', parentRunId: `parent-${id}`, operationKey } }
    });
  }
  try {
    assert.equal(manager.peek(), null);
    assert.equal(manager.isProductionEnabled('new-account:generate'), false);
    assert.equal(manager.peek(), null, '查询生产策略不提前创建 runtime');
    const first = manager.get();
    assert.equal((await execute(first, 'first')).error.code, 'BINDER_DISPATCH_PROBE_STOP');
    generation = 'generation-b';
    assert.equal((await execute(first, 'old-still-active')).error.code, 'BINDER_DISPATCH_PROBE_STOP');
    const report = await manager.shutdown();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.leakedTransports, []);
    manager.resume();
    const second = manager.get();
    assert.notEqual(second, first);
    assert.equal((await execute(second, 'second')).error.code, 'BINDER_DISPATCH_PROBE_STOP');
    assert.deepEqual(observed.map((input) => input.dbPathOrManagedSource.databasePath), [
      authorityPaths('generation-a').pendingDatabasePath,
      authorityPaths('generation-a').pendingDatabasePath,
      authorityPaths('generation-b').pendingDatabasePath
    ]);
    assert.equal(starts, 3);
  } finally {
    await manager.shutdown();
  }
});
