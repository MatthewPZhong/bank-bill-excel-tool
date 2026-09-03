'use strict';

const { isDeepStrictEqual } = require('node:util');
const { assertJsonSafe } = require('./protocol-validator');
const { CANONICAL_ACTION_KEYS } = require('./action-manifest');

const PRODUCTION_STRATEGY_SNAPSHOT_VERSION = 1;

class ProductionStrategySnapshotError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProductionStrategySnapshotError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ProductionStrategySnapshotError(code, message, details);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function safeSnapshot(value, code, label) {
  try {
    assertJsonSafe(value);
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    fail(code, `${label} 必须是 JSON-safe plain data`);
  }
}

function exactActionMap(items, code, label) {
  if (!Array.isArray(items)) fail(code, `${label} 必须是 array`);
  const result = new Map();
  for (const item of items) {
    if (!item || typeof item.actionKey !== 'string' || !CANONICAL_ACTION_KEYS.includes(item.actionKey)) {
      fail(code, `${label} 包含未知 actionKey`);
    }
    if (result.has(item.actionKey)) fail(code, `${label} actionKey 重复: ${item.actionKey}`);
    result.set(item.actionKey, item);
  }
  return result;
}

function actionOptionMap(value, code, label, valueValidator) {
  const snapshot = safeSnapshot(value || {}, code, label);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail(code, `${label} 必须是 object`);
  }
  for (const [actionKey, item] of Object.entries(snapshot)) {
    if (!CANONICAL_ACTION_KEYS.includes(actionKey)) fail(code, `${label} 包含未知 actionKey`);
    if (!valueValidator(item)) fail(code, `${label}.${actionKey} 值非法`);
  }
  return snapshot;
}

function buildExpected({ capabilityInventory, policies, featureFlags, eligibilityThresholds }) {
  const inventory = safeSnapshot(
    capabilityInventory,
    'PRODUCTION_STRATEGY_CAPABILITY_INVALID',
    'capability inventory'
  );
  const policySnapshot = safeSnapshot(
    policies,
    'PRODUCTION_STRATEGY_POLICIES_INVALID',
    'runtime policies'
  );
  const capabilityByAction = exactActionMap(
    inventory.actions,
    'PRODUCTION_STRATEGY_CAPABILITY_INVALID',
    'capability actions'
  );
  if (capabilityByAction.size !== CANONICAL_ACTION_KEYS.length) {
    fail('PRODUCTION_STRATEGY_CAPABILITY_SET_MISMATCH', 'capability action inventory 不完整');
  }
  const policyByAction = exactActionMap(
    policySnapshot,
    'PRODUCTION_STRATEGY_POLICIES_INVALID',
    'runtime policies'
  );
  const flags = actionOptionMap(
    featureFlags,
    'PRODUCTION_STRATEGY_FEATURE_FLAGS_INVALID',
    'feature flags',
    (value) => typeof value === 'boolean'
  );
  const thresholds = actionOptionMap(
    eligibilityThresholds,
    'PRODUCTION_STRATEGY_THRESHOLDS_INVALID',
    'eligibility thresholds',
    (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value)
  );
  const actions = CANONICAL_ACTION_KEYS.map((actionKey) => {
    const capability = capabilityByAction.get(actionKey);
    const policy = policyByAction.get(actionKey) || null;
    if (Boolean(policy) !== capability.runtimeRegistered) {
      fail('PRODUCTION_STRATEGY_REGISTRY_MISMATCH', `${actionKey} capability/runtime 注册状态漂移`);
    }
    if (!policy) {
      const platformCanary = capability.capabilityStatus === 'platform-canary';
      return {
        actionKey,
        disposition: capability.disposition,
        capabilityMode: capability.capabilityMode,
        effectiveMode: 'legacy',
        effectiveWorkerCount: 0,
        adapterKind: capability.adapterKind,
        eligibilityThreshold: Object.prototype.hasOwnProperty.call(thresholds, actionKey)
          ? thresholds[actionKey]
          : null,
        downgradeReason: platformCanary ? 'platform-canary-not-in-app-runtime' : 'no-runtime-policy',
        featureFlag: false,
        benchmarkEvidenceId: null,
        recoveryStatus: 'not-applicable',
        legacyAvailable: capability.legacyAvailable
      };
    }
    const configuredFlag = Object.prototype.hasOwnProperty.call(flags, actionKey)
      ? flags[actionKey]
      : policy.production.enabled;
    const enabled = configuredFlag === true && policy.production.enabled === true;
    return {
      actionKey,
      disposition: capability.disposition,
      capabilityMode: capability.capabilityMode,
      effectiveMode: enabled ? policy.production.effectiveMode : 'legacy',
      effectiveWorkerCount: enabled ? policy.production.effectiveWorkerCount : 0,
      adapterKind: capability.adapterKind,
      eligibilityThreshold: Object.prototype.hasOwnProperty.call(thresholds, actionKey)
        ? thresholds[actionKey]
        : null,
      downgradeReason: enabled
        ? null
        : (policy.production.enabled === true
            ? 'feature-flag-disabled'
            : policy.production.downgradeReason),
      featureFlag: configuredFlag,
      benchmarkEvidenceId: policy.production.benchmarkEvidenceId,
      recoveryStatus: policy.production.recoveryStatus,
      legacyAvailable: capability.legacyAvailable
    };
  });
  return {
    snapshotVersion: PRODUCTION_STRATEGY_SNAPSHOT_VERSION,
    actions,
    counts: {
      actionCount: actions.length,
      productionEnabledCount: actions.filter((action) => action.effectiveMode !== 'legacy').length,
      legacyEffectiveCount: actions.filter((action) => action.effectiveMode === 'legacy').length
    }
  };
}

function createEffectiveProductionStrategySnapshot(options) {
  return deepFreeze(buildExpected(options));
}

function validateEffectiveProductionStrategySnapshot(snapshot, options) {
  const actual = safeSnapshot(
    snapshot,
    'PRODUCTION_STRATEGY_SNAPSHOT_INVALID',
    'production strategy snapshot'
  );
  const expected = buildExpected(options);
  if (!isDeepStrictEqual(actual, expected)) {
    fail('PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH', 'production strategy snapshot 与当前 authority 漂移', {
      expected,
      actual
    });
  }
  return Object.freeze({
    valid: true,
    actionCount: expected.counts.actionCount,
    productionEnabledCount: expected.counts.productionEnabledCount,
    legacyEffectiveCount: expected.counts.legacyEffectiveCount
  });
}

module.exports = {
  PRODUCTION_STRATEGY_SNAPSHOT_VERSION,
  ProductionStrategySnapshotError,
  createEffectiveProductionStrategySnapshot,
  validateEffectiveProductionStrategySnapshot
};
