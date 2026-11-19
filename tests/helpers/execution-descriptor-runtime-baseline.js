'use strict';

const path = require('node:path');
const {
  createBackgroundExecutionRuntime
} = require('../../src/main-process/execution-descriptors/composition');
const {
  STATIC_REFERENCE_PATHS,
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../src/main-process/background-execution/execution-policy-registry');
const { RECON_FIX_JPM_UNIT_ID } = require('../../src/main-process/recon-id-fix-service/policies');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const BASELINE_COMMIT = '11086a3cbf632a30adbcfa796e4cd81810c5aef9';
const GENERATED_AT = '2026-08-25T00:00:00+08:00';
const VALUE_REGISTRIES = Object.freeze([
  'entryRegistry', 'adapterRegistry', 'validatorRegistry',
  'resourceProfileRegistry', 'topologyRegistry'
]);
const ESTIMATOR_OWNER = 'src/main-process/new-account/resource-estimator.js';

// 此清单记录原 runtime 的 Main 分派边界；行为由 runtime.execute 的独立探针验证。
// 它不是生产 authority，不能用于授予新 action 或构造生产 descriptor。
// v3.2.20：BizOP v327 authority、Pending / 业务OP 导出数据库三组随模块下线删除（固定 fixture 仍保留其原记录）。
const MAIN_BINDING_GROUPS = Object.freeze([
  {
    kind: 'vcc-database-assets',
    actions: ['vcc-financial-op:export-single', 'vcc-financial-op:export-subjects'],
    overrideFields: ['databasePath', 'assetsDir'],
    unavailableCode: 'VCC_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE',
    overrideCode: 'VCC_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN'
  },
  {
    kind: 'recon-fix-jpm-database', actions: ['recon-fix:run-jpm'],
    overrideFields: ['databasePath', 'databaseIdentity'],
    unavailableCode: 'RECON_FIX_JPM_DATABASE_AUTHORITY_UNAVAILABLE',
    overrideCode: 'RECON_FIX_JPM_DATABASE_AUTHORITY_OVERRIDE_FORBIDDEN',
    defaultUnits: [{ unitId: RECON_FIX_JPM_UNIT_ID, input: {} }]
  }
]);

function mainBindingForAction(actionKey) {
  const group = MAIN_BINDING_GROUPS.find((item) => item.prefix
    ? actionKey.startsWith(item.prefix)
    : item.actions.includes(actionKey));
  return group ? {
    kind: group.kind,
    overrideFields: group.overrideFields,
    unavailableCode: group.unavailableCode,
    overrideCode: group.overrideCode,
    beforeDispatch: group.beforeDispatch || null,
    defaultUnits: group.defaultUnits || []
  } : {
    kind: 'passthrough', overrideFields: [], unavailableCode: null,
    overrideCode: null, beforeDispatch: null, defaultUnits: []
  };
}

function baselineRuntimeOptions(overrides = {}) {
  return {
    availableParallelism: 6,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    // 只装配 registry；默认不会打开数据库、启动 worker 或访问业务文件。
    ...overrides
  };
}

function valueAtPath(value, field) {
  return field.split('.').reduce((current, key) => current && current[key], value);
}

function portablePath(value) {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(REPOSITORY_ROOT, value);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`基线只接受仓库内 entry：${value}`);
  }
  return relative.split(path.sep).join('/');
}

function describeBinding(value, fieldPath) {
  if (value === undefined) return null;
  if (typeof value === 'function') return { api: 'callable' };
  if (typeof value === 'string') return { api: 'worker-path', path: portablePath(value) };
  if (fieldPath === 'entryKey') {
    return {
      api: 'worker-descriptor', ...value,
      ...(value.path ? { path: portablePath(value.path) } : {})
    };
  }
  return {
    api: 'methods', methods: Object.keys(value).filter((key) => typeof value[key] === 'function').sort()
  };
}

// v3.2.20 下线业务OP数据核对（含 v327）、月度Pending数据核对、收单单据币种校验；固定 runtime 基线本身不改，
//   扣除这些 action 后作为当前期望：counts / staticKeys 由剩余 policy 重算，registryKeys 只保留仍被剩余 action 引用的键。
const RETIRED_RUNTIME_ACTION_PREFIXES = Object.freeze(['biz-op-v327:', 'biz-op:', 'pending:', 'acquiring:', 'bank-bu:']);
function isRetiredRuntimeAction(actionKey) {
  return RETIRED_RUNTIME_ACTION_PREFIXES.some((prefix) => actionKey.startsWith(prefix));
}
function activeRuntimeBaseline(baseline) {
  const actions = baseline.actions.filter((action) => !isRetiredRuntimeAction(action.actionKey));
  const policies = actions.map((action) => action.policy);
  const referenced = Object.fromEntries(VALUE_REGISTRIES.map((name) => [name, new Set()]));
  for (const action of actions) {
    for (const binding of Object.values(action.bindings)) {
      if (binding.runtime !== null && referenced[binding.registry]) referenced[binding.registry].add(binding.key);
    }
  }
  return {
    ...baseline,
    counts: {
      policies: actions.length,
      productionEnabled: policies.filter((policy) => policy.production.enabled).length,
      dynamicEstimators: actions.filter((action) => action.resource.hasEstimator).length
    },
    staticKeys: staticReferenceClosure(policies),
    registryKeys: Object.fromEntries(Object.entries(baseline.registryKeys)
      .map(([name, keys]) => [name, keys.filter((key) => referenced[name].has(key))])),
    actions
  };
}

function staticReferenceClosure(policies) {
  return Object.fromEntries(STATIC_REFERENCE_PATHS.map(([fieldPath, bucket]) => [
    bucket,
    [...new Set(policies.map((policy) => valueAtPath(policy, fieldPath))
      .filter((key) => key !== null && key !== undefined))].sort()
  ]));
}

function captureRuntimeBaseline(policyRegistry) {
  if (!policyRegistry.isFrozen()) throw new Error('必须采集真实已冻结 runtime registry');
  const policies = [...policyRegistry.list()].sort((a, b) => a.actionKey.localeCompare(b.actionKey, 'en'));
  const registryKeys = Object.fromEntries(VALUE_REGISTRIES.map((name) => [name, new Set()]));
  const actions = policies.map((policy) => {
    const bindings = {};
    for (const [fieldPath, bucket, registryName] of STATIC_REFERENCE_PATHS) {
      const key = valueAtPath(policy, fieldPath);
      const value = policyRegistry.getBinding(policy.actionKey, fieldPath);
      if (value !== undefined && registryKeys[registryName]) registryKeys[registryName].add(key);
      bindings[fieldPath] = {
        key: key === undefined ? null : key, bucket, registry: registryName,
        runtime: describeBinding(value, fieldPath)
      };
    }
    const hasEstimator = typeof policyRegistry.getBinding(policy.actionKey, 'resources.profile') === 'function';
    return {
      actionKey: policy.actionKey,
      policy,
      carrier: { mode: policy.mode, lifetime: policy.lifetime, adapterKind: policy.adapterKind },
      bindings,
      mainBinding: mainBindingForAction(policy.actionKey),
      resource: {
        profileKey: policy.resources.profile,
        staticPhase: policy.resources.phase,
        hasEstimator,
        estimatorOwner: hasEstimator ? ESTIMATOR_OWNER : null,
        topologyKey: policy.resources.compound && policy.resources.compound.topologyKey || null
      }
    };
  });
  return {
    schemaVersion: 1,
    sourceCommit: BASELINE_COMMIT,
    generatedAt: policyRegistry.snapshot().generatedAt,
    scope: 'G7-T1a 原 runtime 基线；不表示 descriptor 已装配或 G1/G2 已集成',
    evidenceBoundary: {
      staticKeys: '逐 policy 引用归一化到 14 个 bucket；不是原 runtime 私有 staticKeys 对象快照',
      functions: '只记录 callable/API 形状；不以名称、源码或 identity 声称行为等价',
      mainBindings: '原分派清点；拒绝行为另由 runtime.execute 探针覆盖，正常注入与跨代等价仍待迁移验收'
    },
    counts: {
      policies: policies.length,
      productionEnabled: policies.filter((policy) => policy.production.enabled).length,
      dynamicEstimators: actions.filter((action) => action.resource.hasEstimator).length
    },
    staticKeys: staticReferenceClosure(policies),
    registryKeys: Object.fromEntries(Object.entries(registryKeys)
      .map(([name, keys]) => [name, [...keys].sort()])),
    actions
  };
}

// 从公共 getBinding 重建五个原 registry，复用原 freeze 校验。
// 未传入的其余 registry 保持未传入，静态声明不补造实现。
function rebuildPolicyRegistry(source, options = {}) {
  const policies = options.policies || source.list();
  const values = Object.fromEntries(VALUE_REGISTRIES.map((name) => [name, {}]));
  for (const policy of policies) {
    for (const [fieldPath, , registryName] of STATIC_REFERENCE_PATHS) {
      if (!values[registryName]) continue;
      const value = source.getBinding(policy.actionKey, fieldPath);
      if (value !== undefined) values[registryName][valueAtPath(policy, fieldPath)] = value;
    }
  }
  for (const [registryName, entries] of Object.entries(options.runtimeValues || {})) {
    values[registryName] = { ...values[registryName], ...entries };
  }
  const registries = Object.fromEntries(VALUE_REGISTRIES.map((name) => [
    name, createStaticRegistry(values[name]).freeze()
  ]));
  const registry = createExecutionPolicyRegistry({
    policies,
    ...registries,
    staticKeys: options.staticKeys || staticReferenceClosure(policies),
    generatedAt: source.snapshot().generatedAt
  });
  registry.freeze();
  return registry;
}

async function collectCurrentRuntimeBaseline() {
  const runtime = createBackgroundExecutionRuntime(baselineRuntimeOptions());
  try {
    return captureRuntimeBaseline(runtime.policyRegistry);
  } finally {
    await runtime.shutdown();
  }
}

module.exports = {
  BASELINE_COMMIT,
  GENERATED_AT,
  MAIN_BINDING_GROUPS,
  RETIRED_RUNTIME_ACTION_PREFIXES,
  VALUE_REGISTRIES,
  activeRuntimeBaseline,
  baselineRuntimeOptions,
  captureRuntimeBaseline,
  collectCurrentRuntimeBaseline,
  mainBindingForAction,
  rebuildPolicyRegistry,
  staticReferenceClosure
};
