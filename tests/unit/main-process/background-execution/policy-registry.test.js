'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PolicyRegistryError,
  createExecutionPolicyRegistry,
  createStaticRegistry,
  semanticPolicyErrors,
  validatePolicyDocument
} = require('../../../../src/main-process/background-execution/execution-policy-registry');
const canary = require('../../../../src/main-process/background-execution/canary');
const { createExistingDispatchAdapter } = require(
  '../../../../src/main-process/background-execution/adapters/existing-dispatch-adapter'
);

const FIXTURES = path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures'
);

function fixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8'));
}

function canaryHarness(policy = canary.pureComputePolicy) {
  const entryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_ENTRY
  });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const registry = createExecutionPolicyRegistry({
    policies: [policy],
    entryRegistry,
    validatorRegistry,
    staticKeys: { resourceProfileKeys: [policy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  return { entryRegistry, registry, validatorRegistry };
}

function canaryDocument(policy = canary.pureComputePolicy) {
  return {
    contractVersion: 1,
    generatedAt: '2026-08-22T00:00:00Z',
    baselineRef: 'reviewer-regression-fixture',
    actions: {
      [policy.actionKey]: policy
    }
  };
}

function canaryRegistryOptions(document) {
  const entryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_ENTRY
  });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  return {
    policies: document,
    entryRegistry,
    validatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] }
  };
}

test('最终 valid policy fixture 通过 Schema 与全部静态引用校验', () => {
  const result = validatePolicyDocument(
    fixture('valid/policy-registry.v3.2.x.json'),
    { staticKeys: fixture('valid/static-key-manifest.v3.2.x.json') }
  );
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('最终 invalid policy fixtures 全量被拒绝', () => {
  const staticKeys = fixture('valid/static-key-manifest.v3.2.x.json');
  const files = fs.readdirSync(path.join(FIXTURES, 'invalid'))
    .filter((name) => name.startsWith('policy-'))
    .sort();
  assert.equal(files.length, 9);
  for (const file of files) {
    const result = validatePolicyDocument(fixture(`invalid/${file}`), { staticKeys });
    assert.equal(result.valid, false, `${file} should be rejected`);
  }
});

test('bundled pure-compute policy 与最终合同 action 对象完全一致且 production disabled', () => {
  const contractPolicy = fixture('valid/policy-registry.v3.2.x.json')
    .actions['background-execution:pure-compute-canary'];
  assert.deepEqual(canary.pureComputePolicy, contractPolicy);
  assert.equal(canary.pureComputePolicy.context.kind, 'none');
  assert.equal(canary.pureComputePolicy.context.validatorKey, 'platform-none');
  assert.equal(canary.pureComputePolicy.commit.kind, 'none');
  assert.equal(canary.pureComputePolicy.production.enabled, false);
});

test('Registry 深冻结、拒绝重复/冻结后注册，并在 production gate fail closed', () => {
  const source = structuredClone(canary.pureComputePolicy);
  const harness = canaryHarness(source);
  source.mode = 'inline-async';
  assert.equal(harness.registry.get(canary.PURE_COMPUTE_ACTION_KEY).mode, 'thread-single');
  assert.throws(
    () => harness.registry.register(canary.pureComputePolicy),
    (error) => error instanceof PolicyRegistryError && error.code === 'POLICY_DUPLICATE_ACTION'
  );
  harness.registry.freeze();
  assert.throws(
    () => harness.registry.register(canary.pureComputePolicy),
    (error) => error.code === 'POLICY_REGISTRY_FROZEN'
  );
  assert.equal(harness.registry.assertRunnable(canary.PURE_COMPUTE_ACTION_KEY).actionKey, canary.PURE_COMPUTE_ACTION_KEY);
  assert.throws(
    () => harness.registry.assertRunnable(canary.PURE_COMPUTE_ACTION_KEY, { production: true }),
    (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
  );
  assert.equal(Object.isFrozen(harness.registry.get(canary.PURE_COMPUTE_ACTION_KEY).resources.phase), true);
});

test('Registry freeze 缺少 entry/result/resource 静态 key 时逐项拒绝', () => {
  const registry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => registry.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.includes('/entryKey')
  );
});

test('Registry generatedAt 在创建时捕获，重复 snapshot 不发生摘要漂移', async () => {
  const { registry } = canaryHarness();
  const first = registry.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = registry.snapshot();
  assert.equal(second.generatedAt, first.generatedAt);
  assert.deepEqual(second, first);
});

test('full policy document 先原样校验并保留 root metadata 与 property key', () => {
  const document = canaryDocument(structuredClone(canary.pureComputePolicy));
  const registry = createExecutionPolicyRegistry(canaryRegistryOptions(document));
  assert.deepEqual(registry.snapshot(), document);

  const extraRoot = structuredClone(document);
  extraRoot.silentlyDroppedBefore = true;
  assert.throws(
    () => createExecutionPolicyRegistry(canaryRegistryOptions(extraRoot)),
    (error) => error.code === 'POLICY_SCHEMA_INVALID' && error.path === '/silentlyDroppedBefore'
  );

  const mismatchedKey = structuredClone(document);
  mismatchedKey.actions = { 'background-execution:different-key': structuredClone(canary.pureComputePolicy) };
  assert.throws(
    () => createExecutionPolicyRegistry(canaryRegistryOptions(mismatchedKey)),
    (error) => error.code === 'POLICY_ACTION_KEY_MISMATCH' && error.path.includes('/actions/')
  );
});

test('full policy document JSON-safe 校验不执行 getter，也不 stringify-drop undefined', () => {
  const accessorDocument = canaryDocument(structuredClone(canary.pureComputePolicy));
  let getterCalls = 0;
  Object.defineProperty(accessorDocument, 'generatedAt', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return '2026-08-22T00:00:00Z';
    }
  });
  assert.throws(
    () => createExecutionPolicyRegistry(canaryRegistryOptions(accessorDocument)),
    (error) => error.code === 'POLICY_NOT_JSON_SAFE' && error.path === '/generatedAt'
  );
  assert.equal(getterCalls, 0);

  const undefinedDocument = canaryDocument(structuredClone(canary.pureComputePolicy));
  undefinedDocument.actions[canary.PURE_COMPUTE_ACTION_KEY].description = undefined;
  assert.throws(
    () => createExecutionPolicyRegistry(canaryRegistryOptions(undefinedDocument)),
    (error) => error.code === 'POLICY_NOT_JSON_SAFE' && error.path.endsWith('/description')
  );
});

test('production.effectiveMode 两条冻结 Python 规则有等价 mutation gate', () => {
  const staticKeys = fixture('valid/static-key-manifest.v3.2.x.json');
  const enabledMismatch = canaryDocument(structuredClone(canary.pureComputePolicy));
  enabledMismatch.actions[canary.PURE_COMPUTE_ACTION_KEY].production.enabled = true;
  enabledMismatch.actions[canary.PURE_COMPUTE_ACTION_KEY].production.effectiveMode = 'legacy';
  let result = validatePolicyDocument(enabledMismatch, { staticKeys });
  assert.equal(result.valid, false);
  assert.ok(result.semanticErrors.some((error) => error.code === 'POLICY_PRODUCTION_EFFECTIVE_MODE_INVALID'));

  const disabledUnexplained = canaryDocument(structuredClone(canary.pureComputePolicy));
  disabledUnexplained.actions[canary.PURE_COMPUTE_ACTION_KEY].production.effectiveMode = 'thread-pool';
  result = validatePolicyDocument(disabledUnexplained, { staticKeys });
  assert.equal(result.valid, false);
  assert.ok(result.semanticErrors.some((error) => error.code === 'POLICY_PRODUCTION_EFFECTIVE_MODE_UNEXPLAINED'));

  const allowedPoolDowngrade = fixture('valid/policy-registry.v3.2.x.json');
  allowedPoolDowngrade.actions['biz-op:import-flow'].production.effectiveMode = 'thread-single';
  result = validatePolicyDocument(allowedPoolDowngrade, { staticKeys });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('pure/durable canary action identity 移植冻结 Python 规则且合法 subset 不要求 canary', () => {
  const staticKeys = fixture('valid/static-key-manifest.v3.2.x.json');
  const baseline = fixture('valid/policy-registry.v3.2.x.json');

  const durableMutation = structuredClone(baseline);
  durableMutation.actions['background-execution:canary'].commit = structuredClone(
    baseline.actions['background-execution:pure-compute-canary'].commit
  );
  let result = validatePolicyDocument(durableMutation, { staticKeys });
  assert.equal(result.valid, false);
  assert.ok(result.semanticErrors.some((error) => error.code === 'POLICY_DURABLE_CANARY_IDENTITY_INVALID'));

  const pureContextMutation = structuredClone(baseline);
  pureContextMutation.actions['background-execution:pure-compute-canary'].context = {
    kind: 'operation',
    validatorKey: 'exact-5'
  };
  result = validatePolicyDocument(pureContextMutation, { staticKeys });
  assert.equal(result.valid, false);
  assert.ok(result.semanticErrors.some((error) => error.code === 'POLICY_PURE_CANARY_IDENTITY_INVALID'));

  const pureProductionMutation = structuredClone(baseline);
  const production = pureProductionMutation.actions['background-execution:pure-compute-canary'].production;
  production.enabled = true;
  production.effectiveMode = 'thread-single';
  production.effectiveWorkerCount = 1;
  production.downgradeReason = null;
  result = validatePolicyDocument(pureProductionMutation, { staticKeys });
  assert.equal(result.valid, false);
  assert.ok(result.semanticErrors.some((error) => error.code === 'POLICY_PURE_CANARY_IDENTITY_INVALID'));

  const subset = structuredClone(baseline);
  subset.actions = {
    'bank-bu:export-aggregate': subset.actions['bank-bu:export-aggregate']
  };
  result = validatePolicyDocument(subset, { staticKeys });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('静态引用不可 opt out，null/undefined value 与不可调用 API 均 fail closed', () => {
  assert.throws(
    () => createStaticRegistry({ invalid: null }),
    (error) => error.code === 'STATIC_REGISTRY_VALUE_INVALID'
  );
  assert.throws(
    () => createStaticRegistry({ invalid: undefined }),
    (error) => error.code === 'STATIC_REGISTRY_VALUE_INVALID'
  );

  const noReferences = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    requireStaticReferences: false,
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => noReferences.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING'
  );

  const invalidEntryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: { path: null }
  });
  const validValidatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  const invalidEntry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: invalidEntryRegistry,
    validatorRegistry: validValidatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => invalidEntry.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_INVALID' && error.path.endsWith('/entryKey')
  );

  const invalidValidatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: { validate: true }
  });
  const invalidValidator = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: createStaticRegistry({
      [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_ENTRY
    }),
    validatorRegistry: invalidValidatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => invalidValidator.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_INVALID' && error.path.endsWith('/result/validatorKey')
  );

  const existingPolicy = structuredClone(canary.pureComputePolicy);
  existingPolicy.adapterKind = 'existing-dispatch';
  existingPolicy.adapterKey = 'adapter.background-execution:pure-compute-canary';
  existingPolicy.entryKey = null;
  const invalidAdapter = createExecutionPolicyRegistry({
    policies: [existingPolicy],
    adapterRegistry: createStaticRegistry({ [existingPolicy.adapterKey]: {} }),
    validatorRegistry: validValidatorRegistry,
    staticKeys: { resourceProfileKeys: [existingPolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => invalidAdapter.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_INVALID' && error.path.endsWith('/adapterKey')
  );

  const validDispatchObject = createExecutionPolicyRegistry({
    policies: [existingPolicy],
    adapterRegistry: createStaticRegistry({
      [existingPolicy.adapterKey]: { dispatch() { return Promise.resolve({}); } }
    }),
    validatorRegistry: validValidatorRegistry,
    staticKeys: { resourceProfileKeys: [existingPolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.doesNotThrow(() => validDispatchObject.freeze());
});

test('plain-object registry 只接受 own data value；getter/inherited/nullish 均不解析', () => {
  let getterCalls = 0;
  const accessorEntries = {};
  Object.defineProperty(accessorEntries, canary.PURE_COMPUTE_ENTRY_KEY, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return canary.PURE_COMPUTE_WORKER_ENTRY;
    }
  });
  assert.throws(
    () => createStaticRegistry(accessorEntries),
    (error) => error.code === 'STATIC_REGISTRY_VALUE_INVALID'
  );
  assert.equal(getterCalls, 0);

  const inheritedEntries = Object.create({
    [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_ENTRY
  });
  const plainValidatorRegistry = {
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  };
  const inherited = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: inheritedEntries,
    validatorRegistry: plainValidatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => inherited.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.endsWith('/entryKey')
  );

  const nullEntry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: { [canary.PURE_COMPUTE_ENTRY_KEY]: null },
    validatorRegistry: plainValidatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => nullEntry.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.endsWith('/entryKey')
  );

  const ownData = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: { [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_ENTRY },
    validatorRegistry: plainValidatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.doesNotThrow(() => ownData.freeze());
});

test('Registry register 在读取 actionKey getter 前先执行 JSON-safe gate', () => {
  const { registry } = canaryHarness();
  let getterCalls = 0;
  const policy = structuredClone(canary.pureComputePolicy);
  Object.defineProperty(policy, 'actionKey', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'background-execution:getter-side-effect';
    }
  });
  assert.throws(
    () => registry.register(policy),
    (error) => error.code === 'POLICY_NOT_JSON_SAFE' && error.path === '/actionKey'
  );
  assert.equal(getterCalls, 0);
});

test('createStaticRegistry 在任何反射前零 trap 拒绝 Proxy', () => {
  let traps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() { traps += 1; return Object.prototype; },
    ownKeys() { traps += 1; return []; },
    getOwnPropertyDescriptor() { traps += 1; return undefined; },
    get() { traps += 1; return undefined; }
  });
  assert.throws(
    () => createStaticRegistry(proxy),
    (error) => error.code === 'STATIC_REGISTRY_ENTRIES_INVALID'
  );
  assert.equal(traps, 0);
});

test('plain {get,has} facade 在 freeze/runtime 一致拒绝且不调用方法', () => {
  let calls = 0;
  const facade = {
    get() { calls += 1; return canary.PURE_COMPUTE_WORKER_ENTRY; },
    has() { calls += 1; return true; }
  };
  const registry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: facade,
    validatorRegistry: createStaticRegistry({
      [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
    }),
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => registry.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.endsWith('/entryKey')
  );
  assert.equal(calls, 0);
});

test('freeze 捕获 Registry-owned implementation binding，后续 Map/property mutation 不生效', () => {
  const originalEntry = { path: '/packaged/original-worker.js' };
  const entryMap = new Map([[canary.PURE_COMPUTE_ENTRY_KEY, originalEntry]]);
  const originalValidator = { validate() { return true; } };
  const validatorMap = new Map([[canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY, originalValidator]]);
  const registry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: entryMap,
    validatorRegistry: validatorMap,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  registry.freeze();

  originalEntry.path = '/packaged/mutated-worker.js';
  originalValidator.validate = () => false;
  entryMap.set(canary.PURE_COMPUTE_ENTRY_KEY, '/packaged/replaced-worker.js');
  validatorMap.set(canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY, () => false);

  assert.deepEqual(registry.getBinding(canary.PURE_COMPUTE_ACTION_KEY, 'entryKey'), {
    path: '/packaged/original-worker.js'
  });
  assert.equal(
    registry.getBinding(canary.PURE_COMPUTE_ACTION_KEY, 'result.validatorKey').validate({}),
    true
  );
});

test('native Map/Set 使用 prototype API 且拒绝 own get/has shadow，getter 零调用', () => {
  let getterCalls = 0;
  const shadowedEntryMap = new Map([
    [canary.PURE_COMPUTE_ENTRY_KEY, canary.PURE_COMPUTE_WORKER_ENTRY]
  ]);
  Object.defineProperty(shadowedEntryMap, 'get', {
    get() {
      getterCalls += 1;
      return Map.prototype.get;
    }
  });
  const validValidatorMap = new Map([
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY, canary.validatePureComputeCanaryResult]
  ]);
  let registryWithShadow = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: shadowedEntryMap,
    validatorRegistry: validValidatorMap,
    staticKeys: { resourceProfileKeys: new Set([canary.pureComputePolicy.resources.profile]) },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => registryWithShadow.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.endsWith('/entryKey')
  );
  assert.equal(getterCalls, 0);

  const shadowedProfiles = new Set([canary.pureComputePolicy.resources.profile]);
  Object.defineProperty(shadowedProfiles, 'has', {
    get() {
      getterCalls += 1;
      return Set.prototype.has;
    }
  });
  registryWithShadow = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: new Map([[canary.PURE_COMPUTE_ENTRY_KEY, canary.PURE_COMPUTE_WORKER_ENTRY]]),
    validatorRegistry: validValidatorMap,
    staticKeys: { resourceProfileKeys: shadowedProfiles },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.throws(
    () => registryWithShadow.freeze(),
    (error) => error.code === 'POLICY_STATIC_REFERENCE_MISSING' && error.path.endsWith('/resources/profile')
  );
  assert.equal(getterCalls, 0);

  const valid = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry: new Map([[canary.PURE_COMPUTE_ENTRY_KEY, canary.PURE_COMPUTE_WORKER_ENTRY]]),
    validatorRegistry: validValidatorMap,
    staticKeys: { resourceProfileKeys: new Set([canary.pureComputePolicy.resources.profile]) },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  assert.doesNotThrow(() => valid.freeze());
});

test('canary identity lookup 只认 own action，不把 inherited canary 当第二份真相', () => {
  const inheritedActions = Object.create({
    'background-execution:pure-compute-canary': {
      context: { kind: 'operation', validatorKey: 'exact-5' },
      commit: { kind: 'worker-durable' },
      production: { enabled: true }
    }
  });
  const errors = semanticPolicyErrors({ actions: inheritedActions });
  assert.equal(errors.some((error) => error.code === 'POLICY_PURE_CANARY_IDENTITY_INVALID'), false);
});

test('同一 serviceKey 只接受一致的 frozen executable/capability binding，且与注册顺序无关', () => {
  const policies = fixture('valid/policy-registry.v3.2.x.json').actions;
  const left = policies['fund-recon:import'];
  const right = policies['fund-recon:run'];
  const staticKeys = fixture('valid/static-key-manifest.v3.2.x.json');
  const validatorRegistry = createStaticRegistry({
    [left.result.validatorKey]: () => true,
    [right.result.validatorKey]: () => true
  });

  function registryFor(orderedPolicies, rightEntry) {
    return createExecutionPolicyRegistry({
      policies: orderedPolicies,
      entryRegistry: createStaticRegistry({
        [left.entryKey]: {
          path: '/packaged/fund-recon-service.js',
          workerData: { capabilities: ['resource-control-v1'] }
        },
        [right.entryKey]: rightEntry
      }),
      validatorRegistry,
      staticKeys,
      generatedAt: '2026-08-22T00:00:00Z'
    });
  }

  const compatible = registryFor([left, right], {
    path: '/packaged/fund-recon-service.js',
    workerData: { capabilities: ['resource-control-v1'] }
  });
  assert.doesNotThrow(() => compatible.freeze());

  for (const order of [[left, right], [right, left]]) {
    const conflicting = registryFor(order, {
      path: '/packaged/other-service.js',
      workerData: { capabilities: ['resource-control-v1', 'other-v1'] }
    });
    assert.throws(
      () => conflicting.freeze(),
      (error) => error.code === 'POLICY_SERVICE_BINDING_CONFLICT' &&
        error.details.serviceKey === 'service.fund-recon'
    );
  }
});

test('official existing adapter freeze snapshot 保留 bind 后的 inspectTopology', () => {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.adapterKind = 'existing-dispatch';
  policy.adapterKey = 'adapter.background-execution:pure-compute-canary';
  policy.entryKey = null;
  let inspected = 0;
  const official = createExistingDispatchAdapter({
    dispatch() { return Promise.resolve({}); },
    inspectTopology(request) {
      inspected += 1;
      assert.equal(request.actionKey, policy.actionKey);
      return { effectiveChildCount: 2 };
    }
  });
  const registry = createExecutionPolicyRegistry({
    policies: [policy],
    adapterRegistry: createStaticRegistry({ [policy.adapterKey]: official }),
    validatorRegistry: createStaticRegistry({
      [policy.result.validatorKey]: canary.validatePureComputeCanaryResult
    }),
    staticKeys: { resourceProfileKeys: [policy.resources.profile] },
    generatedAt: '2026-08-22T00:00:00Z'
  });
  registry.freeze();
  const binding = registry.getBinding(policy.actionKey, 'adapterKey');
  assert.equal(typeof binding.inspectTopology, 'function');
  assert.deepEqual(binding.inspectTopology({ actionKey: policy.actionKey }), { effectiveChildCount: 2 });
  assert.equal(inspected, 1);
});
