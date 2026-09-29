'use strict';

const { types: { isProxy, isAsyncFunction } } = require('node:util');
const {
  PolicyRegistryError,
  STATIC_REFERENCE_PATHS,
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../background-execution/execution-policy-registry');

const DESCRIPTOR_KEYS = Object.freeze([
  'schemaVersion', 'moduleId', 'policies', 'entries', 'adapters', 'validators',
  'resourceProfiles', 'topologies', 'mainBindings', 'staticKeys', 'archivePolicies',
  'taskAdapters', 'taskBindings', 'terminalRoutes', 'recoveryParticipants'
]);
const STATIC_BUCKETS = Object.freeze(STATIC_REFERENCE_PATHS.map(([, bucket]) => bucket));
const VALUE_REGISTRIES = Object.freeze({
  entries: 'entryRegistry', adapters: 'adapterRegistry', validators: 'validatorRegistry',
  resourceProfiles: 'resourceProfileRegistry', topologies: 'topologyRegistry'
});
const RUNTIME_FUNCTION_SLOTS = Object.freeze({
  entries: ['execute'], adapters: ['dispatch', 'start', 'cancel', 'close', 'inspectTopology'],
  validators: ['assertValid', 'validate'], resourceProfiles: [], topologies: ['plan']
});
const ARCHIVE_FUNCTION_SLOTS = new Set([
  'filePlanResolver', 'promotionManifestResolver', 'flowIdentityResolver', 'flowPlanResolver',
  'resultClassifier', 'resultMetadataResolver', 'resultFlowIdentities'
]);
const EMPTY_UNITS = Object.freeze([]);

class ExecutionDescriptorError extends TypeError {
  constructor(code, message, path) {
    super(message);
    this.name = 'ExecutionDescriptorError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ExecutionDescriptorError(code, `${path}：${message}`, path);
}

function invalid(path, message) {
  fail('EXECUTION_DESCRIPTOR_INVALID', path, message);
}

function missing(path, message) {
  fail('EXECUTION_DESCRIPTOR_REFERENCE_MISSING', path, message);
}

function key(value, path) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    invalid(path, '必须为无首尾空白的非空字符串');
  }
  return value;
}

function objectData(value, path, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, '必须为非 Proxy 的 plain own-data 对象');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((name) => typeof name !== 'string')) invalid(path, '不接受 symbol 字段');
  if (requiredKeys && (requiredKeys.some((name) => !Object.hasOwn(descriptors, name))
      || keys.some((name) => !requiredKeys.includes(name) && !optionalKeys.includes(name)))) {
    invalid(path, '字段与已声明的 exact shape 不一致');
  }
  const result = Object.create(null);
  for (const name of keys) {
    const descriptor = descriptors[name];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      invalid(`${path}.${name}`, '必须为 enumerable own data，禁止 accessor');
    }
    result[name] = descriptor.value;
  }
  return result;
}

function arrayData(value, path) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(path, '必须为非 Proxy 的普通 dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some((name) => typeof name !== 'string'
      || (name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name)))) {
    invalid(path, '不接受 sparse array 或额外数组字段');
  }
  return Array.from({ length }, (_unused, index) => {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      invalid(`${path}[${index}]`, '必须为 enumerable own data');
    }
    return descriptor.value;
  });
}

// 仅复制 registry 所有的数据；函数闭包与其 owner 不做递归冻结或调用。
function snapshot(value, path, functionSlots = new Set(), relativePath = '', ancestors = new Set()) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && isProxy(value)) {
    invalid(path, '不接受 Proxy');
  }
  if (typeof value === 'function') {
    if (!functionSlots.has(relativePath)) invalid(path, '此字段不允许函数');
    return value;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) invalid(path, '必须为无循环的普通数据');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = arrayData(value, path).map((entry, index) => snapshot(
      entry, `${path}[${index}]`, functionSlots, relativePath ? `${relativePath}.${index}` : String(index), ancestors
    ));
  } else {
    const data = objectData(value, path);
    result = Object.fromEntries(Object.entries(data).map(([name, entry]) => [name,
      snapshot(entry, `${path}.${name}`, functionSlots, relativePath ? `${relativePath}.${name}` : name, ancestors)
    ]));
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

function callable(value, path, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'function' || isProxy(value)) invalid(path, '必须为非 Proxy 函数');
  return value;
}

function addUnique(collection, name, value, path) {
  if (collection.has(name)) fail('EXECUTION_DESCRIPTOR_DUPLICATE', path, `重复定义 ${name}`);
  collection.set(name, value);
}

function referenceAt(policy, fieldPath) {
  return fieldPath.split('.').reduce((value, field) => value && value[field], policy);
}

function registrationList(descriptor, field, path, required, optional, functionSlots) {
  return arrayData(descriptor[field], `${path}.${field}`).map((entry, index) => {
    const entryPath = `${path}.${field}[${index}]`;
    objectData(entry, entryPath, required, optional);
    return snapshot(entry, entryPath, new Set(functionSlots));
  });
}

function passthroughInput({ input }) { return input; }

// 编译只证明结构与执行引用闭合。生产装配必须额外、无条件地校验独立
// action/task authority 与完整 TaskPolicy inventory；这里不提供授权 override。
function compileExecutionDescriptors(descriptors, options = {}) {
  const optionValues = objectData(options, 'options', [], ['generatedAt']);
  if (Object.hasOwn(optionValues, 'generatedAt')) key(optionValues.generatedAt, 'options.generatedAt');
  const modules = new Map();
  const policies = new Map();
  const mainBindings = new Map();
  const values = Object.fromEntries(Object.keys(VALUE_REGISTRIES).map((field) => [field, new Map()]));
  const staticSets = Object.fromEntries(STATIC_BUCKETS.map((bucket) => [bucket, new Set()]));
  const archivePolicies = new Map();
  const taskAdapters = new Map();
  const taskBindings = new Map();
  const terminalRoutes = new Map();
  const recoveryParticipants = new Map();

  arrayData(descriptors, 'descriptors').forEach((source, index) => {
    let path = `descriptors[${index}]`;
    const descriptor = objectData(source, path, DESCRIPTOR_KEYS);
    const moduleId = key(descriptor.moduleId, `${path}.moduleId`);
    path = `descriptor(${moduleId})`;
    if (descriptor.schemaVersion !== 1) invalid(`${path}.schemaVersion`, '仅支持版本 1');
    addUnique(modules, moduleId, true, path);
    for (const [policyIndex, sourcePolicy] of arrayData(descriptor.policies, `${path}.policies`).entries()) {
      const policyPath = `${path}.policies[${policyIndex}]`;
      const policy = snapshot(sourcePolicy, policyPath);
      objectData(policy, policyPath);
      addUnique(policies, key(policy.actionKey, `${policyPath}.actionKey`), policy, policyPath);
    }
    for (const field of Object.keys(VALUE_REGISTRIES)) {
      for (const [entryIndex, sourceEntry] of arrayData(descriptor[field], `${path}.${field}`).entries()) {
        const entryPath = `${path}.${field}[${entryIndex}]`;
        const entry = objectData(sourceEntry, entryPath, ['key', 'value']);
        const entryKey = key(entry.key, `${entryPath}.key`);
        const value = snapshot(entry.value, `${entryPath}.value`, new Set(['', ...RUNTIME_FUNCTION_SLOTS[field]]));
        if (value === null) invalid(`${entryPath}.value`, 'runtime value 不能为空');
        if (field === 'resourceProfiles') {
          callable(value, `${entryPath}.value`);
          if (isAsyncFunction(value)) invalid(`${entryPath}.value`, '动态 estimator 必须为同步函数');
        }
        addUnique(values[field], entryKey, value, entryPath);
      }
    }
    const declaredKeys = objectData(descriptor.staticKeys, `${path}.staticKeys`, STATIC_BUCKETS);
    for (const bucket of STATIC_BUCKETS) {
      for (const entry of arrayData(declaredKeys[bucket], `${path}.staticKeys.${bucket}`)) {
        staticSets[bucket].add(key(entry, `${path}.staticKeys.${bucket}`));
      }
    }
    for (const [bindingIndex, sourceBinding] of arrayData(descriptor.mainBindings, `${path}.mainBindings`).entries()) {
      const bindingPath = `${path}.mainBindings[${bindingIndex}]`;
      const binding = objectData(sourceBinding, bindingPath, ['actionKey', 'bindInput', 'beforeDispatch', 'defaultUnits']);
      const actionKey = key(binding.actionKey, `${bindingPath}.actionKey`);
      addUnique(mainBindings, actionKey, Object.freeze({
        actionKey,
        bindInput: callable(binding.bindInput, `${bindingPath}.bindInput`),
        beforeDispatch: callable(binding.beforeDispatch, `${bindingPath}.beforeDispatch`, true),
        defaultUnits: callable(binding.defaultUnits, `${bindingPath}.defaultUnits`, true)
      }), bindingPath);
    }
    for (const [policyIndex, sourcePolicy] of arrayData(descriptor.archivePolicies, `${path}.archivePolicies`).entries()) {
      const policyPath = `${path}.archivePolicies[${policyIndex}]`;
      const policy = snapshot(sourcePolicy, policyPath, ARCHIVE_FUNCTION_SLOTS);
      objectData(policy, policyPath);
      addUnique(archivePolicies, key(policy.channel, `${policyPath}.channel`), policy, policyPath);
    }
    for (const entry of registrationList(descriptor, 'taskAdapters', path,
      ['id', 'createInvocation'], [], ['createInvocation'])) {
      const id = key(entry.id, `${path}.taskAdapters.id`);
      callable(entry.createInvocation, `${path}.taskAdapters.createInvocation`);
      addUnique(taskAdapters, id, entry, `${path}.taskAdapters`);
    }
    for (const entry of registrationList(descriptor, 'taskBindings', path,
      ['taskKey', 'adapterId'], [], [])) {
      const taskKey = key(entry.taskKey, `${path}.taskBindings.taskKey`);
      key(entry.adapterId, `${path}.taskBindings.adapterId`);
      addUnique(taskBindings, taskKey, entry, `${path}.taskBindings`);
    }
    for (const entry of registrationList(descriptor, 'terminalRoutes', path,
      ['route', 'normalize', 'finalize'], [], ['normalize', 'finalize'])) {
      const route = key(entry.route, `${path}.terminalRoutes.route`);
      callable(entry.normalize, `${path}.terminalRoutes.normalize`);
      callable(entry.finalize, `${path}.terminalRoutes.finalize`);
      addUnique(terminalRoutes, route, entry, `${path}.terminalRoutes`);
    }
    for (const entry of registrationList(descriptor, 'recoveryParticipants', path,
      ['id', 'ownerName', 'preflight', 'recoverOwner', 'postOutbox'], ['hookName'],
      ['preflight', 'recoverOwner', 'postOutbox'])) {
      const id = key(entry.id, `${path}.recoveryParticipants.id`);
      key(entry.ownerName, `${path}.recoveryParticipants.ownerName`);
      if (Object.hasOwn(entry, 'hookName')) key(entry.hookName, `${path}.recoveryParticipants.hookName`);
      for (const hook of ['preflight', 'recoverOwner', 'postOutbox']) callable(entry[hook], `${path}.${hook}`, true);
      addUnique(recoveryParticipants, id, entry, `${path}.recoveryParticipants`);
    }
  });

  const registries = Object.fromEntries(Object.entries(VALUE_REGISTRIES).map(([field, name]) => [
    name, createStaticRegistry(Object.fromEntries(values[field])).freeze()
  ]));
  const staticKeys = Object.freeze(Object.fromEntries(STATIC_BUCKETS.map((bucket) => [
    bucket, Object.freeze([...staticSets[bucket]])
  ])));
  for (const [actionKey, policy] of policies) {
    if (!mainBindings.has(actionKey)) missing(actionKey, 'runtime action 缺少 Main binding');
    for (const [field, bucket, registryName] of STATIC_REFERENCE_PATHS) {
      const reference = referenceAt(policy, field);
      if (reference === null || reference === undefined) continue;
      if (!staticSets[bucket].has(reference) && !(registries[registryName] && registries[registryName].has(reference))) {
        missing(`${actionKey}.${field}`, `缺少 ${bucket} 能力 ${reference}`);
      }
      if (field === 'resources.profile' && !staticSets.resourceProfileKeys.has(reference)) {
        missing(`${actionKey}.${field}`, `静态 profile 必须显式声明 ${reference}`);
      }
      if (field === 'resources.compound.topologyKey') {
        const planner = registries.topologyRegistry.get(reference);
        if (typeof planner !== 'function' && !(planner && typeof planner.plan === 'function')) {
          missing(`${actionKey}.${field}`, `compound topology 必须提供真实 planner ${reference}`);
        }
      }
    }
  }
  for (const actionKey of mainBindings.keys()) {
    if (!policies.has(actionKey)) missing(actionKey, 'Main binding 没有对应 runtime action');
  }
  const referencedProfiles = new Set([...policies.values()].map((policy) => policy.resources && policy.resources.profile));
  for (const profileKey of values.resourceProfiles.keys()) {
    if (!referencedProfiles.has(profileKey)) missing(profileKey, '动态 estimator 没有对应 policy');
  }
  for (const binding of taskBindings.values()) {
    if (!taskAdapters.has(binding.adapterId)) missing(binding.taskKey, `任务 adapter 未注册 ${binding.adapterId}`);
  }
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [...policies.values()], ...registries, staticKeys, ...optionValues
  });
  policyRegistry.freeze();

  function bindingFor(actionKey) {
    const binding = mainBindings.get(actionKey);
    if (!binding) throw new PolicyRegistryError('POLICY_NOT_FOUND', '未登记执行 action');
    return binding;
  }
  return Object.freeze({
    policies: policyRegistry.list(), ...registries, staticKeys, policyRegistry,
    moduleIds: Object.freeze([...modules.keys()]),
    bindInputForAction(identity) { return bindingFor(identity.actionKey).bindInput(identity); },
    getBeforeCarrierDispatchForAction(actionKey) { return bindingFor(actionKey).beforeDispatch; },
    beforeCarrierDispatch(identity) {
      const binding = bindingFor(identity.actionKey);
      if (!binding.beforeDispatch) {
        throw Object.assign(new Error('关闭观察缺少该模块自己的 Main 派发绑定'), { code: 'CARRIER_DISPATCH_BINDING_REQUIRED' });
      }
      return binding.beforeDispatch(identity);
    },
    defaultUnitsForAction(actionKey) {
      const binding = bindingFor(actionKey);
      return binding.defaultUnits ? binding.defaultUnits(actionKey) : EMPTY_UNITS;
    },
    archivePolicies: Object.freeze([...archivePolicies.values()]),
    taskAdapters: Object.freeze([...taskAdapters.values()]),
    taskBindings: Object.freeze([...taskBindings.values()]),
    terminalRoutes: Object.freeze([...terminalRoutes.values()]),
    recoveryParticipants: Object.freeze([...recoveryParticipants.values()])
  });
}

module.exports = {
  DESCRIPTOR_KEYS, STATIC_BUCKETS, ExecutionDescriptorError,
  compileExecutionDescriptors, passthroughInput
};
