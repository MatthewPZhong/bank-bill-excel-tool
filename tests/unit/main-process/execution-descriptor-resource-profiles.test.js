'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/execution-descriptors/composition');
const {
  STATIC_REFERENCE_PATHS
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  createExecutionSupervisor
} = require('../../../src/main-process/background-execution/supervisor');
const {
  createNewAccountGenerationResourceEstimate
} = require('../../../src/main-process/new-account/resource-estimator');
const {
  BASELINE_COMMIT,
  GENERATED_AT,
  baselineRuntimeOptions,
  captureRuntimeBaseline,
  rebuildPolicyRegistry,
  staticReferenceClosure
} = require('../../helpers/execution-descriptor-runtime-baseline');
const baseline = require('../../fixtures/execution-descriptors/runtime-baseline.json');

let runtime;
test.before(() => {
  runtime = createBackgroundExecutionRuntime(baselineRuntimeOptions());
});
test.after(async () => {
  await runtime.shutdown();
});

function newAccountInput() {
  const root = path.resolve('/execution-descriptor-baseline');
  return {
    schemaVersion: 1,
    accounts: [{
      bankName: '测试银行', location: '上海', bankAccount: '测试账号',
      openingDate: '2026-02-27', currencies: ['CNY', 'USD']
    }],
    asOfDate: '2026-03-01',
    template: {
      filePath: path.join(root, 'template.xlsx'),
      snapshot: { sizeBytes: 1, mtimeMs: 1, ctimeMs: 1 }, sha256: 'a'.repeat(64)
    },
    generation: {
      artifactKey: 'baseline-artifact', stagingRoot: root,
      stagingResourceId: 'output.xlsx', generationPath: path.join(root, 'output.xlsx')
    }
  };
}

function executionRequest(policy, input = {}) {
  const operationKey = 'descriptor-baseline-operation';
  return {
    actionKey: policy.actionKey, operationKey, production: false,
    input,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'descriptor-baseline-task', taskKey: `task.${policy.actionKey}`,
        moduleId: policy.moduleId, parentRunId: 'descriptor-baseline-parent', operationKey
      }
    }
  };
}

// 真实 Supervisor 在资源准入后、载体创建前停止；不运行 worker 或业务 IO。
async function observePhaseAdmission(policyRegistry, policy, input) {
  const calls = [];
  let workerStarts = 0;
  let released = 0;
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor: {
      async acquireBaseLease(request) {
        calls.push({ kind: 'base', resources: request.resources, timeoutMs: request.timeoutMs });
        return { release() { released += 1; return true; } };
      },
      async acquirePhaseLease(request) {
        calls.push({ kind: 'phase', resources: request.resources, timeoutMs: request.timeoutMs });
        throw Object.assign(new Error('测试在载体创建前停止'), { code: 'BASELINE_ADMISSION_PROBE_STOP' });
      }
    },
    workerThreadAdapter: {
      start() {
        workerStarts += 1;
        throw new Error('资源探针不得启动 worker');
      }
    }
  });
  try {
    const result = await supervisor.execute(executionRequest(policy, input));
    return { result, calls, workerStarts, released };
  } finally {
    await supervisor.shutdown();
  }
}

test('G7 基线保存全部 49 action 的原 policy、载体映射、冻结 binding 与生产策略', () => {
  assert.equal(baseline.sourceCommit, BASELINE_COMMIT);
  assert.equal(baseline.generatedAt, GENERATED_AT);
  assert.deepEqual(baseline.counts, { policies: 49, productionEnabled: 13, dynamicEstimators: 1 });
  assert.deepEqual(captureRuntimeBaseline(runtime.policyRegistry), baseline);
  assert.equal(runtime.policyRegistry.isFrozen(), true);
  for (const action of baseline.actions) {
    const policy = runtime.policyRegistry.get(action.actionKey);
    assert.equal(Object.isFrozen(policy), true, action.actionKey);
    assert.deepEqual(policy.production, action.policy.production, action.actionKey);
    if (!policy.production.enabled) {
      assert.throws(() => runtime.policyRegistry.assertRunnable(action.actionKey, { production: true }), {
        code: 'POLICY_PRODUCTION_DISABLED'
      });
    }
  }
});

test('14 个精确 bucket 经原五 registry 重建和真实 freeze/getBinding 后仍保持逐 action 基线', () => {
  const buckets = STATIC_REFERENCE_PATHS.map(([, bucket]) => bucket).sort();
  assert.equal(buckets.length, 14);
  assert.deepEqual(Object.keys(baseline.staticKeys).sort(), buckets);
  for (const keys of Object.values(baseline.staticKeys)) {
    assert.ok(keys.every((key) => typeof key === 'string' && key.length > 0));
    assert.equal(keys.length, new Set(keys).size);
  }
  const rebuilt = rebuildPolicyRegistry(runtime.policyRegistry);
  assert.equal(rebuilt.isFrozen(), true);
  assert.deepEqual(captureRuntimeBaseline(rebuilt), baseline);
  assert.throws(() => rebuilt.register(baseline.actions[0].policy), { code: 'POLICY_REGISTRY_FROZEN' });
  assert.throws(() => rebuilt.assertRunnable('descriptor:test-only'), { code: 'POLICY_NOT_FOUND' });
});

test('静态 profile 必须使用 resourceProfileKeys；旧别名无法补偿缺失的静态能力', () => {
  const policies = runtime.policyRegistry.list();
  for (const legacyAlias of [null, 'resourceProfiles', 'profiles']) {
    const staticKeys = staticReferenceClosure(policies);
    const profiles = staticKeys.resourceProfileKeys;
    delete staticKeys.resourceProfileKeys;
    if (legacyAlias) staticKeys[legacyAlias] = profiles;
    assert.throws(() => rebuildPolicyRegistry(runtime.policyRegistry, { staticKeys }), (error) => {
      assert.equal(error.code, 'POLICY_STATIC_REFERENCE_MISSING');
      assert.match(error.message, /resources.profile|resources\/profile/);
      return true;
    });
  }
});

test('48 个静态 action 不补造 estimator；唯一动态 profile 归 NewAccount 所有', () => {
  const dynamic = baseline.actions.filter((action) => action.resource.hasEstimator);
  assert.deepEqual(dynamic.map((action) => action.actionKey), ['new-account:generate']);
  assert.deepEqual(baseline.registryKeys.resourceProfileRegistry, ['resource.new-account:generate']);
  assert.equal(dynamic[0].resource.estimatorOwner, 'src/main-process/new-account/resource-estimator.js');
  for (const action of baseline.actions) {
    const binding = runtime.policyRegistry.getBinding(action.actionKey, 'resources.profile');
    assert.equal(typeof binding, action.resource.hasEstimator ? 'function' : 'undefined', action.actionKey);
    assert.deepEqual(runtime.policyRegistry.get(action.actionKey).resources.phase, action.resource.staticPhase);
  }
});

test('无动态 estimator 的 Toolbox 沿用静态 phase，保留 5 秒准入且不启动 worker', async () => {
  const policy = runtime.policyRegistry.get('toolbox:merge');
  const observed = await observePhaseAdmission(runtime.policyRegistry, policy, {});
  assert.equal(observed.result.error.code, 'BASELINE_ADMISSION_PROBE_STOP');
  assert.deepEqual(observed.calls, [
    { kind: 'base', resources: policy.resources.base, timeoutMs: 5000 },
    { kind: 'phase', resources: policy.resources.phase, timeoutMs: 5000 }
  ]);
  assert.equal(observed.workerStarts, 0);
  assert.equal(observed.released, 1);
});

test('NewAccount 实际 estimator 在准入前根据合法输入提升 memory，保留原 carrier slots', async () => {
  const policy = runtime.policyRegistry.get('new-account:generate');
  const input = newAccountInput();
  const expected = createNewAccountGenerationResourceEstimate(input, policy.resources.phase).resources;
  assert.ok(expected.memoryBytes > policy.resources.phase.memoryBytes);
  const observed = await observePhaseAdmission(runtime.policyRegistry, policy, input);
  assert.equal(observed.result.error.code, 'BASELINE_ADMISSION_PROBE_STOP');
  assert.deepEqual(observed.calls[1].resources, expected);
  assert.equal(observed.calls[1].resources.workerThreadSlots, policy.resources.phase.workerThreadSlots);
  assert.equal(observed.calls[1].resources.utilityProcessSlots, policy.resources.phase.utilityProcessSlots);
  assert.equal(observed.workerStarts, 0);
  assert.equal(observed.released, 1);
});

test('NewAccount estimator 的 Promise 与 topology slot 漂移在任何准入/worker 前被原 Supervisor 拒绝', async (t) => {
  const policy = runtime.policyRegistry.get('new-account:generate');
  const cases = [
    ['Promise', () => Promise.resolve(policy.resources.phase), 'RESOURCE_PROFILE_ESTIMATOR_ASYNC_UNSUPPORTED'],
    ['worker slots', () => ({ ...policy.resources.phase, workerThreadSlots: 2 }), 'RESOURCE_PROFILE_TOPOLOGY_INVALID'],
    ['utility slots', () => ({ ...policy.resources.phase, utilityProcessSlots: 1 }), 'RESOURCE_PROFILE_TOPOLOGY_INVALID']
  ];
  for (const [label, estimator, errorCode] of cases) {
    await t.test(label, async () => {
      const registry = rebuildPolicyRegistry(runtime.policyRegistry, {
        policies: [policy],
        runtimeValues: { resourceProfileRegistry: { [policy.resources.profile]: estimator } }
      });
      const observed = await observePhaseAdmission(registry, policy, newAccountInput());
      assert.equal(observed.result.error.code, errorCode);
      assert.deepEqual(observed.calls, []);
      assert.equal(observed.workerStarts, 0);
      assert.equal(observed.released, 0);
    });
  }
});

test('真实 runtime binder 逐受保护 action 拒绝缺失 authority 与 payload override，且尚未创建载体', async () => {
  let workerStarts = 0;
  const withAuthority = createBackgroundExecutionRuntime(baselineRuntimeOptions({
    pendingDatabasePath: path.resolve('/descriptor-baseline/pending.sqlite'),
    mainDatabasePath: path.resolve('/descriptor-baseline/main.sqlite'),
    userDataDir: path.resolve('/descriptor-baseline/user-data'),
    vccFinancialOpDatabasePath: path.resolve('/descriptor-baseline/vcc.sqlite'),
    vccFinancialOpAssetsDir: path.resolve('/descriptor-baseline/assets'),
    reconFixJpmDatabasePath: path.resolve('/descriptor-baseline/recon.sqlite'),
    workerThreadAdapter: { start() { workerStarts += 1; throw new Error('binder 拒绝前不得启动载体'); } }
  }));
  try {
    let unavailableChecks = 0;
    let overrideChecks = 0;
    for (const action of baseline.actions) {
      if (!action.mainBinding.unavailableCode) continue;
      const request = { actionKey: action.actionKey, operationKey: 'binder-probe', input: {} };
      await assert.rejects(runtime.execute(request), { code: action.mainBinding.unavailableCode }, action.actionKey);
      unavailableChecks += 1;
      for (const field of action.mainBinding.overrideFields) {
        await assert.rejects(withAuthority.execute({ ...request, input: { [field]: 'untrusted' } }), {
          code: action.mainBinding.overrideCode
        }, `${action.actionKey}/${field}`);
        overrideChecks += 1;
      }
    }
    assert.equal(unavailableChecks, 19);
    assert.equal(overrideChecks, 10);
    assert.equal(workerStarts, 0);
  } finally {
    await withAuthority.shutdown();
  }
});
