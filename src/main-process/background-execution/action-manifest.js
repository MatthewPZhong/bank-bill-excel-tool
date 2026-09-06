'use strict';

const { assertJsonSafe } = require('./protocol-validator');

const ACTION_MANIFEST_VERSION = 1;

// 该 inventory 与生产 binding 是两份独立证据；coverage gate 必须双向比较，
// 禁止从 bindingSnapshot() 反向生成自己的期望集合。
const CANONICAL_ACTION_KEYS = Object.freeze([
  'biz-op-v327:import-candidate',
  'biz-op-v327:run-candidate',
  'biz-op-v327:delete-plan',
  'biz-op-v327:upgrade-preflight',
  'biz-op-v327:reclaim',
  'biz-op-v327:export-op-raw',
  'biz-op-v327:export-flow-raw',
  'biz-op-v327:export-op-check',
  'biz-op-v327:export-flow-check',
  'biz-op-v327:export-result-full',
  'biz-op-v327:export-result-diff',
  'biz-op-v327:export-errors',

  'acquiring:copy-existing-diff',
  'acquiring:export-diff-workbook',
  'acquiring:import',
  'acquiring:run-new-eligible',
  'acquiring:run-single-or-resume',
  'background-execution:canary',
  'background-execution:pure-compute-canary',
  'bank-bu:export-aggregate',
  'bank-bu:export-single',
  'bank-bu:import-month',
  'bank-bu:run',
  'biz-op:export-day',
  'biz-op:export-range',
  'biz-op:import-flow',
  'duplicate:export',
  'duplicate:import',
  'duplicate:run',
  'fund-recon:export',
  'fund-recon:import',
  'fund-recon:run',
  'new-account:generate',
  'new-account:save-as',
  'pending:export-diff',
  'pending:export-errors',
  'pending:export-summary',
  'pending:import',
  'position:export-run',
  'position:import',
  'pre-fund:bank-import',
  'pre-fund:export-audit',
  'pre-fund:export-channel',
  'pre-fund:mpt-import',
  'pre-fund:mpt-repair-import',
  'pre-fund:run',
  'recon-fix:export',
  'recon-fix:import',
  'recon-fix:run-jpm',
  'recon-fix:run-readonly',
  'statement:generate-all',
  'statement:generate-current',
  'statement:import',
  'statement:resolve-big-account',
  'statement:resolve-manual-balance',
  'toolbox:merge',
  'toolbox:publish',
  'toolbox:split-large',
  'toolbox:split-multi-output',
  'toolbox:split-single',
  'vcc-financial-op:export-audit',
  'vcc-financial-op:export-single',
  'vcc-financial-op:export-subjects',
  'vcc-op:compute-amounts',
  'vcc-op:save-run',
  'vcc-op:scan-and-compute'
].sort());

const LEGACY_HANDLER_PAIRS = Object.freeze([
  Object.freeze(['biz-op-v327:import-candidate', 'bizOpReconV327:import']),
  Object.freeze(['biz-op-v327:run-candidate', 'bizOpReconV327:run']),
  Object.freeze(['biz-op-v327:delete-plan', 'bizOpReconV327:delete']),
  Object.freeze(['biz-op-v327:upgrade-preflight', 'bizOpReconV327:maintenance:upgrade']),
  Object.freeze(['biz-op-v327:reclaim', 'bizOpReconV327:maintenance:reclaim']),
  Object.freeze(['biz-op-v327:export-op-raw', 'bizOpReconV327:export:op-raw']),
  Object.freeze(['biz-op-v327:export-flow-raw', 'bizOpReconV327:export:flow-raw']),
  Object.freeze(['biz-op-v327:export-op-check', 'bizOpReconV327:export:op-check']),
  Object.freeze(['biz-op-v327:export-flow-check', 'bizOpReconV327:export:flow-check']),
  Object.freeze(['biz-op-v327:export-result-full', 'bizOpReconV327:export:result-full']),
  Object.freeze(['biz-op-v327:export-result-diff', 'bizOpReconV327:export:result-diff']),
  Object.freeze(['biz-op-v327:export-errors', 'bizOpReconV327:export:errors']),

  Object.freeze(['acquiring:copy-existing-diff', 'acquiringBillCurrency:export']),
  Object.freeze(['acquiring:import', 'acquiringBillCurrency:importBill']),
  Object.freeze(['acquiring:import', 'acquiringBillCurrency:importFlow']),
  Object.freeze(['acquiring:run-new-eligible', 'acquiringBillCurrency:run']),
  Object.freeze(['acquiring:run-single-or-resume', 'acquiringBillCurrency:run']),
  Object.freeze(['acquiring:run-single-or-resume', 'acquiringBillCurrency:run:resume']),
  Object.freeze(['bank-bu:export-aggregate', 'bankBuRecon:export:aggregate']),
  Object.freeze(['bank-bu:export-single', 'bankBuRecon:export:single']),
  Object.freeze(['bank-bu:import-month', 'bankBuRecon:import:run']),
  Object.freeze(['bank-bu:run', 'bankBuRecon:run']),
  Object.freeze(['biz-op:export-day', 'bizOpRecon:export:date']),
  Object.freeze(['biz-op:export-range', 'bizOpRecon:export:date-range']),
  Object.freeze(['biz-op:import-flow', 'bizOpRecon:import:run-flow']),
  Object.freeze(['duplicate:export', 'duplicate-inbound-match:export']),
  Object.freeze(['duplicate:import', 'duplicate-inbound-match:import-files']),
  Object.freeze(['duplicate:run', 'duplicate-inbound-match:run']),
  Object.freeze(['fund-recon:export', 'bank-statement:export']),
  Object.freeze(['fund-recon:import', 'bank-statement:batch-import']),
  Object.freeze(['fund-recon:import', 'bank-statement:import']),
  Object.freeze(['fund-recon:run', 'bank-statement:run']),
  Object.freeze(['new-account:generate', 'new-account:generate']),
  Object.freeze(['new-account:save-as', 'new-account:export']),
  Object.freeze(['pending:export-diff', 'pending:diff:export-single']),
  Object.freeze(['pending:export-errors', 'pending:error:export-report']),
  Object.freeze(['pending:export-summary', 'pending:diff:export-aggregate']),
  Object.freeze(['pending:import', 'pending:import:start']),
  Object.freeze(['position:export-run', 'position-reconciliation:run:export']),
  Object.freeze(['position:export-run', 'position-reconciliation:run:export-filtered']),
  Object.freeze(['position:import', 'position-reconciliation:bank:apply-import']),
  Object.freeze(['position:import', 'position-reconciliation:run:import-result']),
  Object.freeze(['position:import', 'position-reconciliation:source:apply-import']),
  Object.freeze(['position:import', 'position-reconciliation:source:prepare-import']),
  Object.freeze(['pre-fund:bank-import', 'pre-fund-reconciliation:import-bank']),
  Object.freeze(['pre-fund:export-audit', 'pre-fund-reconciliation:export']),
  Object.freeze(['pre-fund:export-channel', 'pre-fund-reconciliation:export']),
  Object.freeze(['pre-fund:mpt-import', 'pre-fund-reconciliation:import-mpt']),
  Object.freeze(['pre-fund:mpt-repair-import', 'pre-fund-reconciliation:mpt-errors:repair']),
  Object.freeze(['pre-fund:run', 'pre-fund-reconciliation:run']),
  Object.freeze(['recon-fix:export', 'recon-id-fix:export']),
  Object.freeze(['recon-fix:import', 'recon-id-fix:import']),
  Object.freeze(['recon-fix:run-jpm', 'recon-id-fix:run']),
  Object.freeze(['recon-fix:run-readonly', 'recon-id-fix:run']),
  Object.freeze(['statement:generate-all', 'monthly-balance:assemble']),
  Object.freeze(['statement:generate-all', 'monthly-balance:export']),
  Object.freeze(['statement:generate-current', 'file:export-balance']),
  Object.freeze(['statement:generate-current', 'file:export-detail']),
  Object.freeze(['statement:import', 'file:import']),
  Object.freeze(['statement:resolve-big-account', 'file:complete-big-account-selection']),
  Object.freeze(['statement:resolve-manual-balance', 'file:save-balance-seed']),
  Object.freeze(['toolbox:merge', 'toolbox:merge']),
  Object.freeze(['toolbox:publish', 'toolbox:split:export']),
  Object.freeze(['toolbox:split-large', 'toolbox:split:export']),
  Object.freeze(['toolbox:split-multi-output', 'toolbox:split:export']),
  Object.freeze(['toolbox:split-single', 'toolbox:split:export']),
  Object.freeze(['vcc-financial-op:export-audit', 'vccFinancialOp:data-manager:export']),
  Object.freeze(['vcc-financial-op:export-audit', 'vccFinancialOp:export:import-audit']),
  Object.freeze(['vcc-financial-op:export-single', 'vccFinancialOp:export:result']),
  Object.freeze(['vcc-financial-op:export-subjects', 'vccFinancialOp:export:result']),
  Object.freeze(['vcc-op:compute-amounts', 'vccOpCalc:run:compute-amounts']),
  Object.freeze(['vcc-op:save-run', 'vccOpCalc:run:save']),
  Object.freeze(['vcc-op:scan-and-compute', 'vccOpCalc:import:scan'])
]);

const PLATFORM_CANARY_ACTION_KEYS = Object.freeze([
  'background-execution:canary',
  'background-execution:pure-compute-canary'
]);

class ActionManifestError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ActionManifestError';
    this.code = code;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function jsonSnapshot(value, code, label) {
  try {
    assertJsonSafe(value);
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    throw new ActionManifestError(code, `${label} 必须是 JSON-safe plain data`);
  }
}

function compareStringArrays(expected, actual, code, label) {
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
    throw new ActionManifestError(code, `${label} 集合漂移`, { expected, actual });
  }
}

function expectedBindings() {
  const result = Object.fromEntries(CANONICAL_ACTION_KEYS.map((actionKey) => [actionKey, []]));
  for (const [actionKey, taskKey] of LEGACY_HANDLER_PAIRS) result[actionKey].push(taskKey);
  for (const taskKeys of Object.values(result)) taskKeys.sort();
  return result;
}

function normalizedBindings(bindings) {
  const snapshot = jsonSnapshot(
    bindings,
    'ACTION_MANIFEST_BINDINGS_INVALID',
    'production binding snapshot'
  );
  const actionKeys = Object.keys(snapshot).sort();
  compareStringArrays(
    CANONICAL_ACTION_KEYS,
    actionKeys,
    'ACTION_MANIFEST_ACTION_SET_MISMATCH',
    'production binding action'
  );
  const result = {};
  for (const actionKey of actionKeys) {
    const taskKeys = snapshot[actionKey];
    if (!Array.isArray(taskKeys) || taskKeys.some((taskKey) => typeof taskKey !== 'string')) {
      throw new ActionManifestError(
        'ACTION_MANIFEST_BINDING_VALUE_INVALID',
        `production binding ${actionKey} 必须是 string array`
      );
    }
    const sorted = [...taskKeys].sort();
    if (new Set(sorted).size !== sorted.length) {
      throw new ActionManifestError(
        'ACTION_MANIFEST_BINDING_DUPLICATE',
        `production binding ${actionKey} 存在重复 taskKey`
      );
    }
    result[actionKey] = sorted;
  }
  const expected = expectedBindings();
  for (const actionKey of actionKeys) {
    compareStringArrays(
      expected[actionKey],
      result[actionKey],
      'ACTION_MANIFEST_PAIR_SET_MISMATCH',
      `production binding ${actionKey}`
    );
  }
  return result;
}

function normalizedPolicies(policies) {
  const snapshot = jsonSnapshot(policies, 'ACTION_MANIFEST_POLICIES_INVALID', 'runtime policies');
  if (!Array.isArray(snapshot)) {
    throw new ActionManifestError('ACTION_MANIFEST_POLICIES_INVALID', 'runtime policies 必须是 array');
  }
  const byAction = new Map();
  for (const policy of snapshot) {
    const actionKey = policy && policy.actionKey;
    if (typeof actionKey !== 'string' || !CANONICAL_ACTION_KEYS.includes(actionKey)) {
      throw new ActionManifestError(
        'ACTION_MANIFEST_POLICY_ACTION_UNKNOWN',
        'runtime policy actionKey 不在 canonical inventory'
      );
    }
    if (byAction.has(actionKey)) {
      throw new ActionManifestError(
        'ACTION_MANIFEST_POLICY_DUPLICATE',
        `runtime policy ${actionKey} 重复`
      );
    }
    byAction.set(actionKey, policy);
  }
  return byAction;
}

function createActionManifest({ bindings, policies }) {
  const bindingMap = normalizedBindings(bindings);
  const policyByAction = normalizedPolicies(policies);
  const canaryActions = new Set(PLATFORM_CANARY_ACTION_KEYS);
  const actions = CANONICAL_ACTION_KEYS.map((actionKey) => {
    const policy = policyByAction.get(actionKey) || null;
    const legacyTaskKeys = bindingMap[actionKey];
    const capabilityStatus = policy
      ? 'runtime-policy'
      : (canaryActions.has(actionKey) ? 'platform-canary' : 'legacy-only');
    return {
      actionKey,
      capabilityStatus,
      legacyTaskKeys,
      handlerRoute: legacyTaskKeys.length > 0 ? 'legacy-main' : 'none',
      runtimeRouteEnabled: Boolean(policy && policy.production && policy.production.enabled === true)
    };
  });
  const handlerRoutes = LEGACY_HANDLER_PAIRS.map(([actionKey, legacyTaskKey]) => ({
    actionKey,
    legacyTaskKey,
    routeKind: 'legacy-main',
    managedCapabilityRoute: false
  }));
  const surfaces = {
    handlers: actions.map((action) => ({
      actionKey: action.actionKey,
      evidence: action.legacyTaskKeys.length > 0
        ? 'legacy-task-policy-registration'
        : (action.capabilityStatus === 'runtime-policy'
            ? 'runtime-policy-capability-only'
            : 'platform-canary-contract')
    })),
    filePlans: actions.map((action) => {
      const policy = policyByAction.get(action.actionKey);
      return {
        actionKey: action.actionKey,
        authority: policy && policy.artifacts && policy.artifacts.filePlanRequired === true
          ? 'runtime-policy-required'
          : (action.legacyTaskKeys.length > 0 ? 'legacy-task-policy' : 'not-applicable')
      };
    }),
    inventory: actions.map((action) => ({
      actionKey: action.actionKey,
      owner: 'canonical-action-inventory-v1'
    })),
    registry: actions.map((action) => ({
      actionKey: action.actionKey,
      registration: action.capabilityStatus
    })),
    inspectors: actions.map((action) => {
      const policy = policyByAction.get(action.actionKey);
      return {
        actionKey: action.actionKey,
        inspectorKey: policy && policy.commit ? policy.commit.inspectorKey : null,
        fallback: !policy && action.legacyTaskKeys.length > 0 ? 'legacy-task-policy' : null
      };
    }),
    publishers: actions.map((action) => {
      const policy = policyByAction.get(action.actionKey);
      return {
        actionKey: action.actionKey,
        publisherKey: policy && policy.artifacts ? policy.artifacts.publisherKey : null,
        fallback: !policy && action.legacyTaskKeys.length > 0 ? 'legacy-task-policy' : null
      };
    })
  };
  return deepFreeze({
    manifestVersion: ACTION_MANIFEST_VERSION,
    actions,
    handlerRoutes,
    surfaces,
    counts: {
      actionCount: actions.length,
      legacyPairCount: handlerRoutes.length,
      runtimePolicyCount: policyByAction.size,
      legacyOnlyCount: actions.filter((action) => action.capabilityStatus === 'legacy-only').length,
      platformCanaryCount: actions.filter((action) => action.capabilityStatus === 'platform-canary').length
    }
  });
}

module.exports = {
  ACTION_MANIFEST_VERSION,
  ActionManifestError,
  CANONICAL_ACTION_KEYS,
  LEGACY_HANDLER_PAIRS,
  PLATFORM_CANARY_ACTION_KEYS,
  createActionManifest
};
