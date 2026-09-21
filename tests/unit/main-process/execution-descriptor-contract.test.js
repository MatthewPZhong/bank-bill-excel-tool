'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compileExecutionDescriptors, passthroughInput, STATIC_BUCKETS
} = require('../../../src/main-process/execution-descriptors/contract');
const { STATIC_REFERENCE_PATHS } = require('../../../src/main-process/background-execution/execution-policy-registry');
const canary = require('../../../src/main-process/background-execution/canary');
const { createTaskAdapterRegistry } = require('../../../src/main-process/task-adapters/registry');
const { createTerminalRouteRegistry } = require('../../../src/main-process/archive-center/terminal-route-registry');
const { createApplicationRecoveryCoordinator } = require('../../../src/main-process/application-recovery/coordinator');

const GENERATED_AT = '2026-08-25T00:00:00+08:00';
function descriptor() {
  const policy = structuredClone(canary.pureComputePolicy);
  const staticKeys = Object.fromEntries(STATIC_REFERENCE_PATHS.map(([field, bucket]) => {
    const value = field.split('.').reduce((current, key) => current && current[key], policy);
    return [bucket, value === null || value === undefined ? [] : [value]];
  }));
  return {
    schemaVersion: 1, moduleId: 'contract-fixture', policies: [policy],
    entries: [{ key: policy.entryKey, value: canary.PURE_COMPUTE_WORKER_BINDING }],
    adapters: [], validators: [{ key: policy.result.validatorKey, value: canary.validatePureComputeCanaryResult }],
    resourceProfiles: [], topologies: [],
    mainBindings: [{ actionKey: policy.actionKey, bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }],
    staticKeys, archivePolicies: [], taskAdapters: [], taskBindings: [], terminalRoutes: [], recoveryParticipants: []
  };
}
function emptyDescriptor(moduleId = 'empty') {
  const source = descriptor();
  for (const field of Object.keys(source)) if (Array.isArray(source[field])) source[field] = [];
  source.moduleId = moduleId;
  source.staticKeys = Object.fromEntries(STATIC_BUCKETS.map((bucket) => [bucket, []]));
  return source;
}
function compile(source = descriptor()) { return compileExecutionDescriptors([source], { generatedAt: GENERATED_AT }); }
function assertCode(work, code) { assert.throws(work, (error) => error.code === code); }

test('compile 真实冻结五个 registry 和原 policyRegistry，静态预算继续 fallback', () => {
  const source = descriptor();
  const result = compile(source);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.policyRegistry.isFrozen(), true);
  assert.equal(result.policyRegistry.snapshot().generatedAt, GENERATED_AT);
  assert.equal(result.policyRegistry.getBinding(source.policies[0].actionKey, 'resources.profile'), undefined);
  assert.deepEqual(result.policies[0].resources.phase, source.policies[0].resources.phase);
  for (const name of ['entryRegistry', 'adapterRegistry', 'validatorRegistry', 'resourceProfileRegistry', 'topologyRegistry']) {
    assert.equal(result[name].isFrozen(), true);
    assertCode(() => result[name].register('late', () => {}), 'STATIC_REGISTRY_FROZEN');
  }
  assertCode(() => result.policyRegistry.register(source.policies[0]), 'POLICY_REGISTRY_FROZEN');
  assert.deepEqual(Object.keys(result.staticKeys), STATIC_BUCKETS);
  for (const bucket of STATIC_BUCKETS) assert.equal(Object.isFrozen(result.staticKeys[bucket]), true);
  assert.equal(Object.isFrozen(result.policies[0].resources.phase), true);
  assert.equal(Object.isFrozen(result.entryRegistry.get(source.policies[0].entryKey)), true);
  source.policies[0].resources.phase.memoryBytes = 123;
  source.staticKeys.resourceProfileKeys.push('late');
  assert.notEqual(result.policies[0].resources.phase.memoryBytes, 123);
  assert.equal(result.staticKeys.resourceProfileKeys.includes('late'), false);
  assert.equal(Object.values(result).some((value) => value instanceof Map), false);
});

test('static bucket 稳定并集允许重复引用，但不能以另一 bucket 抵消缺项', () => {
  const first = descriptor();
  const second = emptyDescriptor();
  const profile = first.policies[0].resources.profile;
  first.staticKeys.resourceProfileKeys.push(profile);
  second.staticKeys.resourceProfileKeys.push(profile, 'shared-profile');
  const result = compileExecutionDescriptors([first, second], { generatedAt: GENERATED_AT });
  assert.deepEqual(result.staticKeys.resourceProfileKeys, [profile, 'shared-profile']);
  first.staticKeys.resourceProfileKeys = [];
  first.staticKeys.publisherKeys.push(profile);
  assertCode(() => compile(first), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
});

test('exact shape、schema、每个 static bucket 与 explicit null slot 必须完整', () => {
  for (const mutate of [
    (source) => { source.schemaVersion = 2; },
    (source) => { source.extra = true; },
    (source) => { delete source.archivePolicies; },
    (source) => { delete source.staticKeys.resourceProfileKeys; },
    (source) => { source.staticKeys.resourceProfiles = []; },
    (source) => { source.staticKeys.resourceProfileKeys = ['']; },
    (source) => { delete source.mainBindings[0].beforeDispatch; },
    (source) => { delete source.mainBindings[0].defaultUnits; },
    (source) => { source.mainBindings[0].bindInput = null; },
    (source) => { source.mainBindings[0].defaultUnits = []; },
    (source) => { source.entries[0].extra = true; }
  ]) {
    const source = descriptor(); mutate(source);
    assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_INVALID');
  }
  assertCode(() => compileExecutionDescriptors([descriptor()], { productionOverride: true }), 'EXECUTION_DESCRIPTOR_INVALID');
});

test('getter/Proxy/非法函数槽在副作用前拒绝，不触发陷阱或 hooks', () => {
  let effects = 0;
  const callback = () => { effects += 1; };
  const proxy = (value) => new Proxy(value, { get() { effects += 1; throw new Error('不得调用'); }, ownKeys() { effects += 1; throw new Error('不得调用'); } });
  const sources = [];
  sources.push(proxy(descriptor()));
  for (const mutate of [
    (source) => { Object.defineProperty(source, 'moduleId', { enumerable: true, get: callback }); },
    (source) => { source.policies = proxy(source.policies); },
    (source) => { source.policies[0] = proxy(source.policies[0]); },
    (source) => { Object.defineProperty(source.staticKeys, 'entryKeys', { enumerable: true, get: callback }); },
    (source) => { Object.defineProperty(source.entries, '0', { enumerable: true, get: callback }); },
    (source) => { source.entries[0].value = { path: canary.PURE_COMPUTE_WORKER_ENTRY, get workerData() { effects += 1; } }; },
    (source) => { source.validators[0].value = proxy(callback); },
    (source) => { source.mainBindings[0].bindInput = proxy(callback); },
    (source) => { source.policies[0].resources.phase.callback = callback; },
    (source) => { source.entries[0].value = { path: canary.PURE_COMPUTE_WORKER_ENTRY, workerData: { callback } }; },
    (source) => { source.archivePolicies = [{ channel: 'test', notAHook: callback }]; },
    (source) => { source.taskAdapters = [{ id: 'x', createInvocation: callback, get extra() { effects += 1; } }]; },
    (source) => { source.recoveryParticipants = [proxy({})]; }
  ]) {
    const source = descriptor(); mutate(source); sources.push(source);
  }
  for (const source of sources) assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_INVALID');
  assert.equal(effects, 0);
});

test('稀疏数组、隐藏字段、symbol、循环和非 plain 对象不能伪装 descriptor data', () => {
  for (const mutate of [
    (source) => { delete source.entries[0]; },
    (source) => { source.policies.extra = 1; },
    (source) => { Object.defineProperty(source, 'hidden', { value: true }); },
    (source) => { source[Symbol('extra')] = true; },
    (source) => { source.staticKeys = new Map(); },
    (source) => { source.policies[0].self = source.policies[0]; },
    (source) => { source.entries[0].value = new Date(); }
  ]) {
    const source = descriptor(); mutate(source);
    assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_INVALID');
  }
});

test('module/action/namespace/binding/channel/adapter/route/participant 重复定义均拒绝', () => {
  assertCode(() => compileExecutionDescriptors([descriptor(), descriptor()]), 'EXECUTION_DESCRIPTOR_DUPLICATE');
  const fixtures = [
    ['policies', (source) => source.policies[0]],
    ['mainBindings', (source) => source.mainBindings[0]],
    ['entries', (source) => source.entries[0]],
    ['validators', (source) => source.validators[0]],
    ['adapters', () => ({ key: 'adapter-test', value: { dispatch() {} } })],
    ['resourceProfiles', () => ({ key: 'profile-test', value: () => ({}) })],
    ['topologies', () => ({ key: 'topology-test', value: () => ({}) })],
    ['archivePolicies', () => ({ channel: 'test' })],
    ['taskAdapters', () => ({ id: 'test', createInvocation() {} })],
    ['taskBindings', () => ({ taskKey: 'test', adapterId: 'test' })],
    ['terminalRoutes', () => ({ route: 'test', normalize() {}, finalize() {} })],
    ['recoveryParticipants', () => ({ id: 'test', ownerName: 'Test', preflight: null, recoverOwner: null, postOutbox: null })]
  ];
  for (const [field, makeValue] of fixtures) {
    const first = descriptor();
    const value = makeValue(first);
    first[field] = [value, value];
    assertCode(() => compile(first), 'EXECUTION_DESCRIPTOR_DUPLICATE');
  }
  const first = descriptor(); const second = emptyDescriptor();
  second.validators = first.validators;
  assertCode(() => compileExecutionDescriptors([first, second]), 'EXECUTION_DESCRIPTOR_DUPLICATE');
});

test('缺实现不能被 static key-only 掩盖，原 registry 的 API 检查仍实际运行', () => {
  for (const field of ['entries', 'validators']) {
    const source = descriptor(); source[field] = [];
    assertCode(() => compile(source), 'POLICY_STATIC_REFERENCE_INVALID');
  }
  const noBinder = descriptor(); noBinder.mainBindings = [];
  assertCode(() => compile(noBinder), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
  const orphanBinder = descriptor(); orphanBinder.mainBindings[0].actionKey = 'missing';
  assertCode(() => compile(orphanBinder), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
  const orphanAdapter = descriptor(); orphanAdapter.taskBindings = [{ taskKey: 'test', adapterId: 'missing' }];
  assertCode(() => compile(orphanAdapter), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
});

test('动态 profile 只登记同步 estimator，不制造普通 profile value', () => {
  const source = descriptor(); const policy = source.policies[0];
  const estimate = ({ staticPhase }) => staticPhase;
  source.resourceProfiles = [{ key: policy.resources.profile, value: estimate }];
  const result = compile(source);
  assert.equal(result.policyRegistry.getBinding(policy.actionKey, 'resources.profile'), estimate);
  assert.deepEqual(estimate({ staticPhase: policy.resources.phase }), policy.resources.phase);
  source.resourceProfiles[0].value = async () => policy.resources.phase;
  assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_INVALID');
  source.resourceProfiles[0] = { key: 'orphan-estimator', value: estimate };
  assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
  source.resourceProfiles[0] = { key: policy.resources.profile, value: {} };
  assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_INVALID');
});

test('compound 必须有实际 topology planner，不能由静态引用或占位对象满足', () => {
  const source = descriptor();
  source.policies[0].resources.compound = { topologyKey: 'test-topology' };
  source.staticKeys.topologyKeys = ['test-topology'];
  assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
  source.topologies = [{ key: 'test-topology', value: {} }];
  assertCode(() => compile(source), 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING');
});

test('lookup 只调用已登记 Main closures，未知 action fail closed，保留领域异常', () => {
  const source = descriptor(); const actionKey = source.policies[0].actionKey;
  const effects = [];
  const frozenUnits = Object.freeze([{ unitId: 'test', input: Object.freeze({}) }]);
  source.mainBindings[0] = {
    actionKey,
    bindInput(identity) {
      effects.push('bind');
      if (identity.input.override) throw Object.assign(new Error('拒绝覆盖'), { code: 'DOMAIN_OVERRIDE_FORBIDDEN' });
      return { ...identity.input, databasePath: '/main-only' };
    },
    beforeDispatch(identity) { effects.push(identity.operationKey); },
    defaultUnits() { effects.push('units'); return frozenUnits; }
  };
  const result = compile(source);
  assert.deepEqual(effects, []);
  assert.deepEqual(result.bindInputForAction({ actionKey, input: { value: 1 } }), { value: 1, databasePath: '/main-only' });
  result.beforeCarrierDispatch({ actionKey, operationKey: 'op' });
  assert.equal(result.defaultUnitsForAction(actionKey), frozenUnits);
  assert.deepEqual(effects, ['bind', 'op', 'units']);
  assertCode(() => result.bindInputForAction({ actionKey, input: { override: true } }), 'DOMAIN_OVERRIDE_FORBIDDEN');
  for (const work of [
    () => result.bindInputForAction({ actionKey: 'unknown', input: {} }),
    () => result.beforeCarrierDispatch({ actionKey: 'unknown' }),
    () => result.defaultUnitsForAction('unknown')
  ]) assertCode(work, 'POLICY_NOT_FOUND');
  const passthrough = compile(); const input = {};
  assert.equal(passthrough.bindInputForAction({ actionKey, input }), input);
  assertCode(() => passthrough.beforeCarrierDispatch({ actionKey }), 'CARRIER_DISPATCH_BINDING_REQUIRED');
  assert.deepEqual(passthrough.defaultUnitsForAction(actionKey), []);
  assert.equal(Object.isFrozen(passthrough.defaultUnitsForAction(actionKey)), true);
});

test('G1/G2 registration 用原 registry/coordinator 消费，编译不运行生命周期', async () => {
  let effects = 0;
  const callback = () => { effects += 1; };
  const source = descriptor();
  source.taskAdapters = [{ id: 'test', createInvocation: callback }];
  source.taskBindings = [{ taskKey: 'test-task', adapterId: 'test' }];
  source.terminalRoutes = [{ route: 'test-route', normalize: (value) => value, finalize: callback }];
  source.recoveryParticipants = [{ id: 'test', ownerName: 'Test', preflight: callback, recoverOwner: null, postOutbox: null }];
  const result = compile(source);
  assert.equal(effects, 0);
  const adapters = createTaskAdapterRegistry({ adapters: result.taskAdapters, taskBindings: result.taskBindings });
  assert.equal(adapters.resolve('test-task').id, 'test');
  const terminal = createTerminalRouteRegistry(result.terminalRoutes);
  assert.deepEqual(terminal.normalize({ route: 'test-route' }), { route: 'test-route' });
  const recovery = createApplicationRecoveryCoordinator({
    platform: { scanAndRecover() {}, recoverSource() {} }, participants: result.recoveryParticipants
  });
  assert.equal(effects, 0);
  await recovery.preflight();
  assert.equal(effects, 1);
  assert.notEqual(result.taskAdapters[0], source.taskAdapters[0]);
  assert.equal(Object.isFrozen(source.taskAdapters[0]), false);
  assert.equal(Object.isFrozen(result.taskAdapters[0]), true);
});
