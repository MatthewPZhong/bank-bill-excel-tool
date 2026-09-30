'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const baseline = require('../../fixtures/execution-descriptors/archive-baseline.json');
const {
  snapshotArchivePolicies,
  observeArchiveBehavior
} = require('../../helpers/execution-descriptor-archive-baseline');
const {
  createTaskPolicyRegistry,
  FILE_ACTION_CHANNELS,
  NO_FILE_ACTION_CHANNELS,
  RESERVE_CHANNELS_BY_SCOPE,
  EXCLUDED_CHANNELS_BY_REASON,
  SUPPORT_ACTION_POLICIES
} = require('../../../src/main-process/archive-center/task-policy-registry');
const {
  ACTION_TASK_BINDING_CONTRACT,
  bindingSnapshot,
  createActionTaskBindingRegistry
} = require('../../../src/main-process/background-execution/action-task-binding-registry');
const {
  CANONICAL_ACTION_KEYS,
  LEGACY_HANDLER_PAIRS,
  PLATFORM_CANARY_ACTION_KEYS
} = require('../../../src/main-process/background-execution/action-manifest');

function sorted(values) {
  return [...values].sort();
}

function authorityFor(policies) {
  return createActionTaskBindingRegistry({
    taskPolicyRegistry: Object.freeze({ list: () => policies })
  });
}

const { createTaskPolicyRegistry: createComposedTaskPolicyRegistry } = require('../../../src/main-process/execution-descriptors/composition');
const archivePolicies = createComposedTaskPolicyRegistry().list();
const policies = archivePolicies;
const policyByChannel = new Map(policies.map((policy) => [policy.channel, policy]));
const baselineRecoverable = baseline.policies.filter((policy) => policy.taskKind !== 'exclude');
const newPreparationPolicies = [
  { batchPolicy: 'exclude', channel: 'toolbox:split:cancel-read', excludeReason: 'cancel-active-task', taskKind: 'exclude', workerContext: 'none' },
  { batchPolicy: 'exclude', channel: 'toolbox:split:read-values', excludeReason: 'preview-only', taskKind: 'exclude', workerContext: 'none' }
];

// 固定 fixture 与当前公开 API 分开读取；此测试不提供更新/重建 fixture 入口。
test('Archive 固定基线逐 channel 保留全部 268 项、模块身份、file/no-file/exclude 和 hook 注册', () => {
  assert.equal(baseline.baselineCommit, '11086a3cbf632a30adbcfa796e4cd81810c5aef9');
  assert.equal(baseline.policies.length, 268);
  const baselineChannels = new Set(baseline.policies.map((policy) => policy.channel));
  assert.deepEqual(snapshotArchivePolicies(policies.filter((policy) => baselineChannels.has(policy.channel))), baseline.policies);
  assert.deepEqual(snapshotArchivePolicies(policies.filter((policy) => !baselineChannels.has(policy.channel))), newPreparationPolicies);
  assert.deepEqual(SUPPORT_ACTION_POLICIES, baseline.supportActions);
  assert.deepEqual(
    sorted(FILE_ACTION_CHANNELS),
    sorted(baseline.policies.filter((policy) => policy.taskKind === 'file').map((policy) => policy.channel))
  );
  assert.deepEqual(
    sorted(NO_FILE_ACTION_CHANNELS),
    sorted(baseline.policies.filter((policy) => policy.taskKind === 'no-file').map((policy) => policy.channel))
  );
  assert.equal(FILE_ACTION_CHANNELS.length, 71);
  assert.equal(NO_FILE_ACTION_CHANNELS.length, 63);
  assert.deepEqual(
    sorted(Object.values(RESERVE_CHANNELS_BY_SCOPE).flat()),
    sorted(baselineRecoverable.map((policy) => policy.channel))
  );
  assert.deepEqual(
    sorted(Object.values(EXCLUDED_CHANNELS_BY_REASON).flat()),
    sorted([...baseline.policies.filter((policy) => policy.taskKind === 'exclude'), ...newPreparationPolicies].map((policy) => policy.channel))
  );
});

test('私有 authority、独立 manifest 与固定 67-action/74-pair/134-task 清单双向闭合', () => {
  assert.deepEqual(ACTION_TASK_BINDING_CONTRACT, baseline.authority.contract);
  assert.deepEqual(bindingSnapshot(), baseline.authority.bindings);
  assert.deepEqual(CANONICAL_ACTION_KEYS, baseline.authority.canonicalActionKeys);
  assert.deepEqual(LEGACY_HANDLER_PAIRS, baseline.authority.legacyHandlerPairs);
  assert.deepEqual(PLATFORM_CANARY_ACTION_KEYS, baseline.authority.platformCanaryActionKeys);
  const registry = authorityFor(policies);
  assert.deepEqual(registry.summary.actionKeys, baseline.authority.canonicalActionKeys);
  assert.deepEqual(registry.summary.taskPolicyInventory, sorted(baselineRecoverable.map((policy) => policy.taskKey)));
  assert.equal(registry.summary.actionKeys.length, 67);
  assert.equal(registry.summary.pairCount, 74);
  assert.equal(registry.summary.taskPolicyInventory.length, 134);
  assert.equal(registry.summary.boundTaskKeyCount, 66);
  assert.equal(registry.summary.unboundTaskPolicyCount, 68);
  assert.equal(registry.summary.sha256, baseline.authority.contract.sha256);
  assert.equal(registry.summary.taskPolicyInventorySha256, baseline.authority.contract.taskPolicyInventorySha256);
  const bindingPairs = [];
  for (const [actionKey, taskKeys] of Object.entries(baseline.authority.bindings)) {
    assert.deepEqual(registry.allowedTaskKeys(actionKey), taskKeys);
    for (const taskKey of taskKeys) {
      assert.deepEqual(registry.assertPair(actionKey, taskKey), { actionKey, expectedTaskKey: taskKey });
      bindingPairs.push([actionKey, taskKey]);
    }
  }
  assert.deepEqual(sorted(bindingPairs.map(JSON.stringify)), sorted(LEGACY_HANDLER_PAIRS.map(JSON.stringify)));
  assert.throws(() => registry.assertPair('descriptor:test-action', 'toolbox:merge'), {
    code: 'ACTION_TASK_BINDING_ACTION_UNKNOWN'
  });
  assert.throws(() => registry.assertPair('toolbox:merge', 'new-account:generate'), {
    code: 'ACTION_TASK_BINDING_PAIR_REJECTED'
  });
});

test('保持数量但篡改 TaskPolicy 身份仍被独立 authority 拒绝', () => {
  const changed = policies.map((policy) => policy.channel === 'toolbox:merge'
    ? { ...policy, channel: 'descriptor:test-task', taskKey: 'descriptor:test-task' }
    : policy);
  assert.throws(() => authorityFor(changed), { code: 'ACTION_TASK_BINDING_TASK_POLICY_MISSING' });
});

test('行为样例覆盖每个可恢复 channel 的分类/metadata/lineage，及全部已登记可选 hook', () => {
  const covered = new Map();
  for (const group of Object.values(baseline.groups)) {
    assert.equal(new Set(group).size, group.length);
    for (const channel of group) assert.ok(policyByChannel.has(channel), channel);
  }
  for (const scenario of baseline.behaviorCases) {
    assert.ok(scenario.samples.length > 0, scenario.group);
    const channels = baseline.groups[scenario.group];
    assert.ok(channels && channels.length > 0, scenario.group);
    for (const channel of channels) {
      const hooks = covered.get(channel) || new Set();
      hooks.add(scenario.hook);
      covered.set(channel, hooks);
    }
  }
  for (const policy of baseline.policies) {
    if (policy.taskKind === 'exclude') {
      assert.equal(covered.has(policy.channel), false, policy.channel);
      continue;
    }
    for (const hook of ['resultClassifier', 'resultMetadataResolver', 'resultFlowIdentities',
      'flowIdentityResolver', 'flowPlanResolver', 'filePlanResolver', 'promotionManifestResolver']) {
      if (policy[hook] === '[callable]') {
        assert.ok(covered.get(policy.channel)?.has(hook), `${policy.channel}.${hook} 未执行行为样例`);
      }
    }
  }
});

for (const scenario of baseline.behaviorCases) {
  test(`Archive 固定行为：${scenario.group} / ${scenario.hook}`, async () => {
    for (const channel of baseline.groups[scenario.group]) {
      const policy = policyByChannel.get(channel);
      for (const sample of scenario.samples) {
        const observed = await observeArchiveBehavior(policy, { ...sample, hook: scenario.hook });
        assert.deepEqual(observed, sample.expected, `${channel} / ${scenario.hook} / ${sample.id}`);
      }
    }
  });
}

test('探针可识别相同 callable 形状下的分类和 lineage 行为漂移', async () => {
  const original = policyByChannel.get('vccFinancialOp:import:apply');
  const classifierScenario = baseline.behaviorCases.find((scenario) => (
    scenario.group === 'vccClassifier' && scenario.hook === 'resultClassifier'
  ));
  const classifierSample = classifierScenario.samples.find((sample) => sample.id === 'blocked');
  const wrongClassifier = { ...original, resultClassifier: () => 'succeeded' };
  assert.deepEqual(snapshotArchivePolicies([wrongClassifier]), snapshotArchivePolicies([original]));
  assert.notDeepEqual(
    await observeArchiveBehavior(wrongClassifier, { ...classifierSample, hook: 'resultClassifier' }),
    classifierSample.expected
  );
  const lineageScenario = baseline.behaviorCases.find((scenario) => (
    scenario.group === 'vccFinancialOp:import:apply' && scenario.hook === 'resultFlowIdentities'
  ));
  const lineageSample = lineageScenario.samples.find((sample) => sample.id === 'partial-import-lineage');
  const wrongLineage = { ...original, resultFlowIdentities: () => [] };
  assert.notDeepEqual(
    await observeArchiveBehavior(wrongLineage, { ...lineageSample, hook: 'resultFlowIdentities' }),
    lineageSample.expected
  );
});


test('公共 Archive registry 必须显式装配并在返回可用 registry 前拒绝漂移', () => {
  assert.throws(() => createTaskPolicyRegistry(), /必须显式传入/);
  assert.throws(() => createTaskPolicyRegistry([...archivePolicies, archivePolicies[0]]), /缺失或重复/);
  assert.throws(() => createTaskPolicyRegistry(archivePolicies.slice(1)), /未精确闭合/);
  for (const patch of [
    { channel: 'unregistered:task' },
    { unregisteredField: true },
    { taskKind: 'no-file' },
    { scopeId: 'unregistered-module' },
    { resultClassifier: null },
    { filePlanResolver: null }
  ]) {
    const changed = archivePolicies.map((policy) => policy.channel === 'toolbox:merge'
      ? { ...policy, ...patch }
      : policy);
    assert.throws(() => createTaskPolicyRegistry(changed), TypeError);
  }
  let getterCalls = 0;
  const changed = archivePolicies.map((policy) => policy.channel === 'toolbox:merge'
    ? Object.defineProperty({ ...policy }, 'resultClassifier', { enumerable: true, get() { getterCalls += 1; } })
    : policy);
  assert.throws(() => createTaskPolicyRegistry(changed), /own data property/);
  assert.equal(getterCalls, 0);
});

test('公共 Archive registry 冻结自己的快照并隐藏可变 Map', () => {
  const inputs = archivePolicies.map((policy) => ({ ...policy }));
  const registry = createTaskPolicyRegistry(inputs);
  const index = inputs.findIndex((policy) => policy.channel === 'toolbox:merge');
  inputs[index].resultClassifier = () => 'failed';
  inputs.splice(index, 1);
  assert.equal(registry.require('toolbox:merge').resultClassifier({ status: 'ok' }), 'succeeded');
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.require('toolbox:merge')), true);
  assert.equal(registry.policies, undefined);
  const copy = registry.list();
  copy.length = 0;
  assert.equal(registry.list().length, baseline.policies.length + newPreparationPolicies.length);
});

test('公共 Archive registry/common 的依赖闭包只含公共机制，没有领域或 composition 回边', () => {
  const allowed = new Set([
    require.resolve('../../../src/main-process/archive-center/task-policy-registry'),
    require.resolve('../../../src/main-process/archive-center/task-policy-common'),
    require.resolve('../../../src/main-process/archive-center/task-file-plan-registry'),
    require.resolve('../../../src/main-process/archive-center/module-scope-registry')
  ]);
  const visited = new Set();
  function visit(module) {
    if (visited.has(module.id)) return;
    visited.add(module.id);
    assert.ok(allowed.has(module.id), '公共模块依赖越界：' + module.id);
    for (const child of module.children) visit(child);
  }
  for (const entry of ['task-policy-registry', 'task-policy-common']) {
    visit(require.cache[require.resolve('../../../src/main-process/archive-center/' + entry)]);
  }
});
