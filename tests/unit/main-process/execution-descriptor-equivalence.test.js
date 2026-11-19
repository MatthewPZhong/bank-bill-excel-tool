'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  composeExecutionDescriptors, createBackgroundExecutionRuntimeManager
} = require('../../../src/main-process/execution-descriptors/composition');
const { BACKGROUND_EXECUTION_POLICIES } = require('../../../src/main-process/execution-descriptors/policy-catalog');
const { activeRuntimeBaseline, captureRuntimeBaseline, baselineRuntimeOptions } = require('../../helpers/execution-descriptor-runtime-baseline');
// 固定 fixture 不改；当前期望 = 扣除 v3.2.20 已下线模块 action 后的基线。
const baseline = activeRuntimeBaseline(require('../../fixtures/execution-descriptors/runtime-baseline.json'));

function authorityPaths(generation) {
  const root = path.resolve(`/descriptor-equivalence/${generation}`);
  return {
    vccFinancialOpDatabasePath: path.join(root, 'vcc.sqlite'),
    vccFinancialOpAssetsDir: path.join(root, 'assets'),
    reconFixJpmDatabasePath: path.join(root, 'recon.sqlite')
  };
}

function bind(compiled, actionKey, input = { marker: '保留业务输入' }) {
  return compiled.bindInputForAction({ actionKey, operationKey: 'equivalence-operation', input });
}

test('Main 最终装配入口保持其余 25 action 的完整冻结 runtime 映射且 catalog 只读', () => {
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions());
  assert.deepEqual(captureRuntimeBaseline(compiled.policyRegistry), baseline);
  assert.equal(Object.isFrozen(BACKGROUND_EXECUTION_POLICIES), true);
  assert.deepEqual([...BACKGROUND_EXECUTION_POLICIES].map((policy) => policy.actionKey).sort(),
    compiled.policies.map((policy) => policy.actionKey).sort());
  assert.equal(compiled.moduleIds.length, 9);
});

test('全部 Main binder 保留输入并注入本代 authority', () => {
  const context = authorityPaths('generation-a');
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions({ ...context }));
  for (const action of baseline.actions) {
    const input = { marker: action.actionKey };
    const result = bind(compiled, action.actionKey, input);
    const expected = { ...input };
    switch (action.mainBinding.kind) {
      case 'vcc-database-assets':
        expected.databasePath = context.vccFinancialOpDatabasePath;
        expected.assetsDir = context.vccFinancialOpAssetsDir;
        break;
      case 'recon-fix-jpm-database':
        expected.databasePath = context.reconFixJpmDatabasePath;
        break;
      case 'passthrough':
        break;
      default:
        assert.fail(`未覆盖 binder：${action.mainBinding.kind}`);
    }
    assert.deepEqual(result, expected, action.actionKey);
    assert.deepEqual(input, { marker: action.actionKey }, 'binder 不改变 caller 输入');
    assert.deepEqual(compiled.defaultUnitsForAction(action.actionKey), action.mainBinding.defaultUnits);
  }
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
    const vcc = bind(compiled, 'vcc-financial-op:export-subjects');
    assert.equal(vcc.databasePath, expected.vccFinancialOpDatabasePath);
    assert.equal(vcc.assetsDir, expected.vccFinancialOpAssetsDir);
    assert.equal(bind(compiled, 'recon-fix:run-jpm').databasePath, expected.reconFixJpmDatabasePath);
    const entry = compiled.policyRegistry.getBinding('duplicate:import', 'entryKey');
    assert.equal(entry.workerData.startupGate.startupRecoveryReady, generation === 'generation-b');
    assert.equal(Object.isFrozen(entry.workerData.startupGate), true);
  }
});

test('原 Main 派发回调填充无本域回调的 action', () => {
  const calls = [];
  const compiled = composeExecutionDescriptors(baselineRuntimeOptions({
    beforeCarrierDispatch(identity) { calls.push(identity); return 'main-dispatched'; }
  }));
  const identity = { actionKey: 'toolbox:merge', operationKey: 'dispatch-operation' };
  assert.equal(compiled.beforeCarrierDispatch(identity), 'main-dispatched');
  assert.deepEqual(calls, [identity]);
});

// v3.2.20：原用 Pending 导出的数据库路径 provider 经真实 Supervisor 观察；Pending 下线后，剩余可用 provider
//   （Duplicate startup gate、ReconFix JPM 库路径、worker 耐久协调器）中 startup gate 冻结在本代 entry，
//   可不启动 worker 直接观察各代 runtime 的冻结值。
test('runtime manager 旧代保持本代 authority，drain/resume 后重新读取 provider', async () => {
  let ready = false;
  let providerCalls = 0;
  const manager = createBackgroundExecutionRuntimeManager(baselineRuntimeOptions({
    duplicateStartupGateProvider: () => {
      providerCalls += 1;
      return { contractVersion: 1, startupRecoveryReady: ready };
    }
  }));
  const gateOf = (runtime) => runtime.policyRegistry.getBinding('duplicate:import', 'entryKey').workerData.startupGate;
  try {
    assert.equal(manager.peek(), null);
    assert.equal(manager.isProductionEnabled('new-account:generate'), false);
    assert.equal(manager.peek(), null, '查询生产策略不提前创建 runtime');
    assert.equal(providerCalls, 0, '查询生产策略不读取 provider');
    const first = manager.get();
    assert.equal(gateOf(first).startupRecoveryReady, false);
    ready = true;
    assert.equal(manager.get(), first, '同代 runtime 复用');
    assert.equal(gateOf(first).startupRecoveryReady, false, 'provider 变化不改变已创建的旧代');
    const report = await manager.shutdown();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.leakedTransports, []);
    manager.resume();
    const second = manager.get();
    assert.notEqual(second, first);
    assert.equal(gateOf(second).startupRecoveryReady, true, 'resume 后新代重新读取 provider');
    assert.equal(Object.isFrozen(gateOf(second)), true);
    assert.equal(providerCalls, 2);
  } finally {
    await manager.shutdown();
  }
});
