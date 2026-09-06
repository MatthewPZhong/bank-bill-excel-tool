'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const ACTION_TASK_BINDING_CONTRACT = Object.freeze({
  version: 1,
  canonicalization: 'RFC8785-JCS',
  sha256: 'fc343385b2c99a27d5f26fce5789da405f0fdea523a9541bb7a16dd100b37fca',
  actionCount: 66,
  taskPolicyInventoryCount: 134,
  taskPolicyInventoryCanonicalization: 'RFC8785-JCS',
  taskPolicyInventorySha256: '6912c045c82d260fbe554732e886f4da9fafe01e4f3e64f8dc3b0c870055a773',
  pairCount: 73,
  boundTaskKeyCount: 66,
  unboundTaskPolicyCount: 68
});

// 模块内私有 literal 是 action → legacy TaskPolicy 的唯一 authority。
// caller 不能注入、替换或取得其中任何内部数组。
const ACTION_TASK_BINDINGS = Object.freeze({
  'biz-op-v327:import-candidate': Object.freeze(['bizOpReconV327:import']),
  'biz-op-v327:run-candidate': Object.freeze(['bizOpReconV327:run']),
  'biz-op-v327:delete-plan': Object.freeze(['bizOpReconV327:delete']),
  'biz-op-v327:upgrade-preflight': Object.freeze(['bizOpReconV327:maintenance:upgrade']),
  'biz-op-v327:reclaim': Object.freeze(['bizOpReconV327:maintenance:reclaim']),
  'biz-op-v327:export-op-raw': Object.freeze(['bizOpReconV327:export:op-raw']),
  'biz-op-v327:export-flow-raw': Object.freeze(['bizOpReconV327:export:flow-raw']),
  'biz-op-v327:export-op-check': Object.freeze(['bizOpReconV327:export:op-check']),
  'biz-op-v327:export-flow-check': Object.freeze(['bizOpReconV327:export:flow-check']),
  'biz-op-v327:export-result-full': Object.freeze(['bizOpReconV327:export:result-full']),
  'biz-op-v327:export-result-diff': Object.freeze(['bizOpReconV327:export:result-diff']),
  'biz-op-v327:export-errors': Object.freeze(['bizOpReconV327:export:errors']),

  'acquiring:copy-existing-diff': Object.freeze(['acquiringBillCurrency:export']),
  'acquiring:export-diff-workbook': Object.freeze([]),
  'acquiring:import': Object.freeze(['acquiringBillCurrency:importBill', 'acquiringBillCurrency:importFlow']),
  'acquiring:run-new-eligible': Object.freeze(['acquiringBillCurrency:run']),
  'acquiring:run-single-or-resume': Object.freeze(['acquiringBillCurrency:run', 'acquiringBillCurrency:run:resume']),
  'background-execution:canary': Object.freeze([]),
  'background-execution:pure-compute-canary': Object.freeze([]),
  'bank-bu:export-aggregate': Object.freeze(['bankBuRecon:export:aggregate']),
  'bank-bu:export-single': Object.freeze(['bankBuRecon:export:single']),
  'bank-bu:import-month': Object.freeze(['bankBuRecon:import:run']),
  'bank-bu:run': Object.freeze(['bankBuRecon:run']),
  'biz-op:export-day': Object.freeze(['bizOpRecon:export:date']),
  'biz-op:export-range': Object.freeze(['bizOpRecon:export:date-range']),
  'biz-op:import-flow': Object.freeze(['bizOpRecon:import:run-flow']),
  'duplicate:export': Object.freeze(['duplicate-inbound-match:export']),
  'duplicate:import': Object.freeze(['duplicate-inbound-match:import-files']),
  'duplicate:run': Object.freeze(['duplicate-inbound-match:run']),
  'fund-recon:export': Object.freeze(['bank-statement:export']),
  'fund-recon:import': Object.freeze(['bank-statement:batch-import', 'bank-statement:import']),
  'fund-recon:run': Object.freeze(['bank-statement:run']),
  'new-account:generate': Object.freeze(['new-account:generate']),
  'new-account:save-as': Object.freeze(['new-account:export']),
  'pending:export-diff': Object.freeze(['pending:diff:export-single']),
  'pending:export-errors': Object.freeze(['pending:error:export-report']),
  'pending:export-summary': Object.freeze(['pending:diff:export-aggregate']),
  'pending:import': Object.freeze(['pending:import:start']),
  'position:export-run': Object.freeze(['position-reconciliation:run:export', 'position-reconciliation:run:export-filtered']),
  'position:import': Object.freeze([
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:run:import-result',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:prepare-import'
  ]),
  'pre-fund:bank-import': Object.freeze(['pre-fund-reconciliation:import-bank']),
  'pre-fund:export-audit': Object.freeze(['pre-fund-reconciliation:export']),
  'pre-fund:export-channel': Object.freeze(['pre-fund-reconciliation:export']),
  'pre-fund:mpt-import': Object.freeze(['pre-fund-reconciliation:import-mpt']),
  'pre-fund:mpt-repair-import': Object.freeze(['pre-fund-reconciliation:mpt-errors:repair']),
  'pre-fund:run': Object.freeze(['pre-fund-reconciliation:run']),
  'recon-fix:export': Object.freeze(['recon-id-fix:export']),
  'recon-fix:import': Object.freeze(['recon-id-fix:import']),
  'recon-fix:run-jpm': Object.freeze(['recon-id-fix:run']),
  'recon-fix:run-readonly': Object.freeze(['recon-id-fix:run']),
  'statement:generate-all': Object.freeze(['monthly-balance:assemble', 'monthly-balance:export']),
  'statement:generate-current': Object.freeze(['file:export-balance', 'file:export-detail']),
  'statement:import': Object.freeze(['file:import']),
  'statement:resolve-big-account': Object.freeze(['file:complete-big-account-selection']),
  'statement:resolve-manual-balance': Object.freeze(['file:save-balance-seed']),
  'toolbox:merge': Object.freeze(['toolbox:merge']),
  'toolbox:publish': Object.freeze(['toolbox:split:export']),
  'toolbox:split-large': Object.freeze(['toolbox:split:export']),
  'toolbox:split-multi-output': Object.freeze(['toolbox:split:export']),
  'toolbox:split-single': Object.freeze(['toolbox:split:export']),
  'vcc-financial-op:export-audit': Object.freeze(['vccFinancialOp:data-manager:export', 'vccFinancialOp:export:import-audit']),
  'vcc-financial-op:export-single': Object.freeze(['vccFinancialOp:export:result']),
  'vcc-financial-op:export-subjects': Object.freeze(['vccFinancialOp:export:result']),
  'vcc-op:compute-amounts': Object.freeze(['vccOpCalc:run:compute-amounts']),
  'vcc-op:save-run': Object.freeze(['vccOpCalc:run:save']),
  'vcc-op:scan-and-compute': Object.freeze(['vccOpCalc:import:scan'])
});

const RECOVERABLE_POLICY_KEYS = Object.freeze([
  'channel',
  'scopeId',
  'moduleCode',
  'moduleName',
  'taskKey',
  'batchPolicy',
  'taskKind',
  'allocation',
  'filePlanSourceKind',
  'filePlanResolver',
  'promotionManifestResolver',
  'workerContext',
  'startsNewFlow',
  'flowIdentityResolver',
  'flowPlanResolver',
  'resultClassifier',
  'bindResultFlowIdentitiesOnFailure',
  'resultMetadataResolver',
  'resultFlowIdentities'
].sort());
const EXCLUDE_POLICY_KEYS = Object.freeze([
  'channel',
  'batchPolicy',
  'taskKind',
  'workerContext',
  'excludeReason'
].sort());

class ActionTaskBindingRegistryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ActionTaskBindingRegistryError';
    this.code = code;
    this.details = details;
  }
}

const SUPPRESSED_CAUSE_DETAILS = Object.freeze({
  cause: 'UNTRUSTED_CAUSE_SUPPRESSED'
});

function fail(code, message, details = null) {
  throw new ActionTaskBindingRegistryError(code, message, details);
}

function failCaught(code, message) {
  // 失败原因可能是 Proxy 或带 message accessor 的 hostile object。错误边界只暴露
  // 稳定 code/message，不读取、String() 或透传不可信 cause。
  fail(code, message, SUPPRESSED_CAUSE_DETAILS);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalBindingJson(bindings) {
  const sorted = Object.fromEntries(
    Object.keys(bindings).sort().map((actionKey) => [actionKey, [...bindings[actionKey]]])
  );
  return JSON.stringify(sorted);
}

function bindingDigest(bindings = ACTION_TASK_BINDINGS) {
  if (bindings !== ACTION_TASK_BINDINGS) {
    fail(
      'ACTION_TASK_BINDING_AUTHORITY_REPLACEMENT_FORBIDDEN',
      'action/task binding authority 不接受 caller replacement'
    );
  }
  return sha256(canonicalBindingJson(ACTION_TASK_BINDINGS));
}

function bindingSnapshot() {
  return Object.freeze(Object.fromEntries(
    Object.entries(ACTION_TASK_BINDINGS).map(([actionKey, taskKeys]) => (
      [actionKey, Object.freeze([...taskKeys])]
    ))
  ));
}

function bindingInventory() {
  const actionKeys = Object.keys(ACTION_TASK_BINDINGS).sort();
  const pairs = actionKeys.flatMap((actionKey) => (
    ACTION_TASK_BINDINGS[actionKey].map((taskKey) => ({ actionKey, taskKey }))
  ));
  const boundTaskKeys = new Set(pairs.map((pair) => pair.taskKey));
  return { actionKeys, boundTaskKeys, pairs };
}

function ownDataSnapshot(value, expectedKeys, code, label) {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    fail(code, `${label} 必须是非 Proxy plain data object`);
  }
  let prototype;
  let keys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    failCaught(code, `${label} descriptor 读取失败`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} 必须是 plain data object`);
  }
  if (keys.some((key) => typeof key !== 'string')) {
    fail(code, `${label} 不允许 symbol key`);
  }
  const actualKeys = keys.map(String).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(code, `${label} exact key inventory 漂移`, {
      expected: expectedKeys,
      actual: actualKeys
    });
  }
  const snapshot = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) {
      fail(code, `${label}.${key} 必须是 enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArraySnapshot(value, code, label) {
  if (!Array.isArray(value) || isProxy(value)) {
    fail(code, `${label} 必须是非 Proxy dense array`);
  }
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    failCaught(code, `${label} descriptor 读取失败`);
  }
  if (keys.some((key) => typeof key !== 'string')) {
    fail(code, `${label} 不允许 symbol key`);
  }
  const expectedKeys = [...Array.from({ length: value.length }, (_unused, index) => String(index)), 'length'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail(code, `${label} 不允许 sparse/hidden/extra array property`);
  }
  const snapshot = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) {
      fail(code, `${label}[${index}] 必须是 enumerable own data property`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function frozenTaskPolicyRegistryList(taskPolicyRegistry) {
  const code = 'ACTION_TASK_BINDING_TASK_POLICY_REGISTRY_HOST_INVALID';
  const label = 'TaskPolicyRegistry host';
  const snapshot = ownDataSnapshot(taskPolicyRegistry, ['list'], code, label);
  let frozen;
  try {
    frozen = Object.isFrozen(taskPolicyRegistry);
  } catch (_error) {
    failCaught(code, `${label} freeze 状态读取失败`);
  }
  if (!frozen || typeof snapshot.list !== 'function') {
    fail(code, `${label} 必须是 frozen exact { list } plain data API`);
  }
  return snapshot.list;
}

function validateString(value, field, policyLabel) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(
      'ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID',
      `${policyLabel}.${field} 必须是非空 string`
    );
  }
}

function snapshotTaskPolicy(policy, index) {
  const label = `TaskPolicy[${index}]`;
  if (policy === null || typeof policy !== 'object' || isProxy(policy)) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID', `${label} 必须是非 Proxy plain data object`);
  }
  let batchPolicyDescriptor;
  try {
    batchPolicyDescriptor = Object.getOwnPropertyDescriptor(policy, 'batchPolicy');
  } catch (error) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID', `${label}.batchPolicy descriptor 读取失败`);
  }
  if (!batchPolicyDescriptor
      || !Object.prototype.hasOwnProperty.call(batchPolicyDescriptor, 'value')
      || batchPolicyDescriptor.enumerable !== true) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID', `${label}.batchPolicy 必须是 enumerable own data property`);
  }
  const batchPolicy = batchPolicyDescriptor.value;
  const expectedKeys = batchPolicy === 'exclude' ? EXCLUDE_POLICY_KEYS : RECOVERABLE_POLICY_KEYS;
  const snapshot = ownDataSnapshot(
    policy,
    expectedKeys,
    'ACTION_TASK_BINDING_TASK_POLICY_DESCRIPTOR_INVALID',
    label
  );
  validateString(snapshot.channel, 'channel', label);

  if (batchPolicy === 'exclude') {
    if (snapshot.taskKind !== 'exclude' || snapshot.workerContext !== 'none') {
      fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label} exclude policy shape 漂移`);
    }
    validateString(snapshot.excludeReason, 'excludeReason', label);
    return Object.freeze(snapshot);
  }
  if (batchPolicy !== 'reserve' && batchPolicy !== 'no-file') {
    fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label}.batchPolicy 非法`);
  }
  for (const field of ['scopeId', 'moduleCode', 'moduleName', 'taskKey', 'workerContext']) {
    validateString(snapshot[field], field, label);
  }
  if (snapshot.taskKey !== snapshot.channel) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_IDENTITY_MISMATCH', `${label} taskKey 必须等于 channel`, {
      channel: snapshot.channel,
      taskKey: snapshot.taskKey
    });
  }
  if (typeof snapshot.startsNewFlow !== 'boolean'
      || typeof snapshot.bindResultFlowIdentitiesOnFailure !== 'boolean'
      || typeof snapshot.resultClassifier !== 'function'
      || typeof snapshot.resultMetadataResolver !== 'function'
      || typeof snapshot.resultFlowIdentities !== 'function') {
    fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label} lifecycle/result shape 漂移`);
  }
  for (const field of [
    'filePlanResolver', 'promotionManifestResolver', 'flowIdentityResolver', 'flowPlanResolver'
  ]) {
    if (snapshot[field] !== null && typeof snapshot[field] !== 'function') {
      fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label}.${field} 必须是 function|null`);
    }
  }
  if (batchPolicy === 'reserve') {
    if (snapshot.taskKind !== 'file'
        || !['eager', 'deferred'].includes(snapshot.allocation)
        || typeof snapshot.filePlanSourceKind !== 'string'
        || snapshot.filePlanSourceKind.length === 0
        || typeof snapshot.filePlanResolver !== 'function') {
      fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label} reserve policy shape 漂移`);
    }
  } else if (snapshot.taskKind !== 'no-file'
      || snapshot.allocation !== 'none'
      || snapshot.filePlanSourceKind !== null
      || snapshot.filePlanResolver !== null
      || snapshot.promotionManifestResolver !== null) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_SHAPE_INVALID', `${label} no-file policy shape 漂移`);
  }
  return Object.freeze(snapshot);
}

function readOwnedTaskPolicyInventory(taskPolicyRegistry) {
  const list = frozenTaskPolicyRegistryList(taskPolicyRegistry);
  let listed;
  try {
    listed = list.call(taskPolicyRegistry);
  } catch (_error) {
    failCaught(
      'ACTION_TASK_BINDING_TASK_POLICY_LIST_FAILED',
      'TaskPolicyRegistry.list() 执行失败'
    );
  }
  const policies = exactArraySnapshot(
    listed,
    'ACTION_TASK_BINDING_TASK_POLICY_LIST_INVALID',
    'TaskPolicyRegistry.list() result'
  ).map(snapshotTaskPolicy);
  const allChannels = new Set();
  for (const policy of policies) {
    if (allChannels.has(policy.channel)) {
      fail('ACTION_TASK_BINDING_TASK_POLICY_DUPLICATE', `TaskPolicy channel 重复：${policy.channel}`);
    }
    allChannels.add(policy.channel);
  }
  const recoverable = policies.filter((policy) => (
    policy.batchPolicy === 'reserve' || policy.batchPolicy === 'no-file'
  ));
  const taskKeys = recoverable.map((policy) => policy.taskKey).sort();
  return Object.freeze({
    policies: Object.freeze([...policies]),
    taskKeys: Object.freeze([...taskKeys]),
    taskKeySet: new Set(taskKeys),
    sha256: sha256(JSON.stringify(taskKeys))
  });
}

function validateFactoryOptions(options) {
  return ownDataSnapshot(
    options,
    ['taskPolicyRegistry'],
    'ACTION_TASK_BINDING_OPTIONS_INVALID',
    'ActionTaskBindingRegistry options'
  );
}

function validateBindingAuthority(taskPolicyRegistry) {
  const taskPolicy = readOwnedTaskPolicyInventory(taskPolicyRegistry);
  const { actionKeys, boundTaskKeys, pairs } = bindingInventory();
  const unboundTaskKeys = taskPolicy.taskKeys.filter((taskKey) => !boundTaskKeys.has(taskKey));

  if (actionKeys.length !== ACTION_TASK_BINDING_CONTRACT.actionCount) {
    fail('ACTION_TASK_BINDING_ACTION_COUNT_MISMATCH', 'canonical action 数量漂移', {
      expected: ACTION_TASK_BINDING_CONTRACT.actionCount,
      actual: actionKeys.length
    });
  }
  if (taskPolicy.taskKeys.length !== ACTION_TASK_BINDING_CONTRACT.taskPolicyInventoryCount) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_INVENTORY_MISMATCH', 'TaskPolicy inventory 数量漂移', {
      expected: ACTION_TASK_BINDING_CONTRACT.taskPolicyInventoryCount,
      actual: taskPolicy.taskKeys.length
    });
  }
  if (pairs.length !== ACTION_TASK_BINDING_CONTRACT.pairCount
      || boundTaskKeys.size !== ACTION_TASK_BINDING_CONTRACT.boundTaskKeyCount) {
    fail('ACTION_TASK_BINDING_CARDINALITY_MISMATCH', 'action/task binding 基数漂移', {
      pairs: pairs.length,
      boundTaskKeys: boundTaskKeys.size
    });
  }
  for (const { actionKey, taskKey } of pairs) {
    if (!taskPolicy.taskKeySet.has(taskKey)) {
      fail(
        'ACTION_TASK_BINDING_TASK_POLICY_MISSING',
        `binding 未命中真实可恢复 TaskPolicy：${actionKey} -> ${taskKey}`
      );
    }
  }
  if (unboundTaskKeys.length !== ACTION_TASK_BINDING_CONTRACT.unboundTaskPolicyCount) {
    fail('ACTION_TASK_BINDING_CARDINALITY_MISMATCH', 'unbound TaskPolicy Set 差集基数漂移', {
      unboundTaskPolicies: unboundTaskKeys.length
    });
  }
  if (taskPolicy.sha256 !== ACTION_TASK_BINDING_CONTRACT.taskPolicyInventorySha256) {
    fail('ACTION_TASK_BINDING_TASK_POLICY_INVENTORY_DIGEST_MISMATCH', 'TaskPolicy inventory JCS digest 漂移', {
      expected: ACTION_TASK_BINDING_CONTRACT.taskPolicyInventorySha256,
      actual: taskPolicy.sha256
    });
  }
  const digest = bindingDigest();
  if (digest !== ACTION_TASK_BINDING_CONTRACT.sha256) {
    fail('ACTION_TASK_BINDING_DIGEST_MISMATCH', 'RFC 8785/JCS binding digest 漂移', {
      expected: ACTION_TASK_BINDING_CONTRACT.sha256,
      actual: digest
    });
  }

  return Object.freeze({
    actionKeys: Object.freeze([...actionKeys]),
    taskPolicyInventory: Object.freeze([...taskPolicy.taskKeys]),
    taskPolicyInventorySha256: taskPolicy.sha256,
    pairCount: pairs.length,
    boundTaskKeyCount: boundTaskKeys.size,
    unboundTaskPolicyCount: unboundTaskKeys.length,
    sha256: digest
  });
}

function createActionTaskBindingRegistry(options) {
  const { taskPolicyRegistry } = validateFactoryOptions(options);
  const summary = validateBindingAuthority(taskPolicyRegistry);
  const allowedByAction = new Map(
    Object.entries(ACTION_TASK_BINDINGS).map(([actionKey, taskKeys]) => (
      [actionKey, new Set(taskKeys)]
    ))
  );

  return Object.freeze({
    assertPair(actionKey, expectedTaskKey) {
      if (typeof actionKey !== 'string') {
        fail('ACTION_TASK_BINDING_ACTION_TYPE_INVALID', 'canonical actionKey 必须是 string');
      }
      if (!allowedByAction.has(actionKey)) {
        fail('ACTION_TASK_BINDING_ACTION_UNKNOWN', `未登记 canonical action：${actionKey}`);
      }
      if (typeof expectedTaskKey !== 'string') {
        fail('ACTION_TASK_BINDING_TASK_KEY_TYPE_INVALID', 'expectedTaskKey 必须是 string');
      }
      if (expectedTaskKey.length === 0) {
        fail('ACTION_TASK_BINDING_TASK_KEY_REQUIRED', `canonical action 缺少 expectedTaskKey：${actionKey}`);
      }
      if (!allowedByAction.get(actionKey).has(expectedTaskKey)) {
        fail('ACTION_TASK_BINDING_PAIR_REJECTED', `未授权 action/task pair：${actionKey} -> ${expectedTaskKey}`);
      }
      return Object.freeze({ actionKey, expectedTaskKey });
    },
    allowedTaskKeys(actionKey) {
      if (!allowedByAction.has(actionKey)) return undefined;
      return Object.freeze([...allowedByAction.get(actionKey)]);
    },
    summary
  });
}

function initializeActionTaskBindingRegistry(taskPolicyRegistry) {
  return createActionTaskBindingRegistry({ taskPolicyRegistry });
}

function initializeActionTaskBindingStartup(taskPolicyRegistry, continuations) {
  // Binding authority must freeze before any caller-supplied DB/IPC continuation can run.
  const actionTaskBindingRegistry = initializeActionTaskBindingRegistry(taskPolicyRegistry);
  const code = 'ACTION_TASK_BINDING_STARTUP_CONTINUATIONS_INVALID';
  const label = 'ActionTaskBinding startup continuations';
  const snapshot = ownDataSnapshot(
    continuations,
    ['initializeDatabase', 'registerIpc'],
    code,
    label
  );
  let frozen;
  try {
    frozen = Object.isFrozen(continuations);
  } catch (_error) {
    failCaught(code, `${label} freeze 状态读取失败`);
  }
  if (!frozen
      || typeof snapshot.initializeDatabase !== 'function'
      || typeof snapshot.registerIpc !== 'function') {
    fail(code, `${label} 必须是 frozen exact function API`);
  }

  let started = false;
  return Object.freeze({
    actionTaskBindingRegistry,
    async run() {
      if (started) {
        fail('ACTION_TASK_BINDING_STARTUP_ALREADY_RUN', 'ActionTaskBinding startup 只能执行一次');
      }
      started = true;
      const result = await snapshot.initializeDatabase();
      snapshot.registerIpc();
      return result;
    }
  });
}

module.exports = {
  ACTION_TASK_BINDING_CONTRACT,
  ActionTaskBindingRegistryError,
  bindingDigest,
  bindingSnapshot,
  createActionTaskBindingRegistry,
  initializeActionTaskBindingRegistry,
  initializeActionTaskBindingStartup,
  validateBindingAuthority
};
