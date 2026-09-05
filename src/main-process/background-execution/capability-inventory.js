'use strict';

const { isDeepStrictEqual } = require('node:util');
const { assertJsonSafe } = require('./protocol-validator');
const { CANONICAL_ACTION_KEYS } = require('./action-manifest');

const CAPABILITY_INVENTORY_VERSION = 1;

class CapabilityInventoryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CapabilityInventoryError';
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

function safeSnapshot(value, code, label) {
  try {
    assertJsonSafe(value);
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    throw new CapabilityInventoryError(code, `${label} 必须是 JSON-safe plain data`);
  }
}

function exactActionMap(items, code, label) {
  if (!Array.isArray(items)) throw new CapabilityInventoryError(code, `${label} 必须是 array`);
  const result = new Map();
  for (const item of items) {
    if (!item || typeof item.actionKey !== 'string' || !CANONICAL_ACTION_KEYS.includes(item.actionKey)) {
      throw new CapabilityInventoryError(code, `${label} 包含未知 actionKey`);
    }
    if (result.has(item.actionKey)) {
      throw new CapabilityInventoryError(code, `${label} actionKey 重复: ${item.actionKey}`);
    }
    result.set(item.actionKey, item);
  }
  return result;
}

function createCapabilityInventory({ manifest, policies }) {
  const manifestSnapshot = safeSnapshot(
    manifest,
    'CAPABILITY_INVENTORY_MANIFEST_INVALID',
    'action manifest'
  );
  const policySnapshot = safeSnapshot(
    policies,
    'CAPABILITY_INVENTORY_POLICIES_INVALID',
    'runtime policies'
  );
  const actionByKey = exactActionMap(
    manifestSnapshot.actions,
    'CAPABILITY_INVENTORY_ACTIONS_INVALID',
    'manifest actions'
  );
  if (actionByKey.size !== CANONICAL_ACTION_KEYS.length) {
    throw new CapabilityInventoryError(
      'CAPABILITY_INVENTORY_ACTION_SET_MISMATCH',
      'manifest action inventory 不完整'
    );
  }
  const policyByAction = exactActionMap(
    policySnapshot,
    'CAPABILITY_INVENTORY_POLICIES_INVALID',
    'runtime policies'
  );
  const actions = CANONICAL_ACTION_KEYS.map((actionKey) => {
    const action = actionByKey.get(actionKey);
    const policy = policyByAction.get(actionKey) || null;
    const legacyAvailable = action.legacyTaskKeys.length > 0;
    if (policy) {
      if (action.capabilityStatus !== 'runtime-policy') {
        throw new CapabilityInventoryError(
          'CAPABILITY_INVENTORY_STATUS_MISMATCH',
          `${actionKey} manifest 未记录 runtime policy`
        );
      }
      return {
        actionKey,
        capabilityStatus: 'implemented',
        disposition: policy.disposition,
        capabilityMode: policy.mode,
        adapterKind: policy.adapterKind,
        commitKind: policy.commit.kind,
        artifactKind: policy.artifacts.kind,
        resourceProfile: policy.resources.profile,
        handlerRoute: action.handlerRoute,
        runtimeRegistered: true,
        legacyAvailable
      };
    }
    if (!['legacy-only', 'platform-canary'].includes(action.capabilityStatus)) {
      throw new CapabilityInventoryError(
        'CAPABILITY_INVENTORY_STATUS_MISMATCH',
        `${actionKey} 未注册 policy 却声明 ${action.capabilityStatus}`
      );
    }
    const platformCanary = action.capabilityStatus === 'platform-canary';
    return {
      actionKey,
      capabilityStatus: platformCanary ? 'platform-canary' : 'legacy-only',
      disposition: platformCanary ? 'blocked' : 'legacy-preserved',
      capabilityMode: platformCanary ? 'platform-canary' : 'legacy',
      adapterKind: platformCanary ? 'native' : 'legacy-main',
      commitKind: platformCanary ? 'not-registered' : 'legacy-task-policy',
      artifactKind: platformCanary ? 'not-registered' : 'legacy-task-policy',
      resourceProfile: null,
      handlerRoute: action.handlerRoute,
      runtimeRegistered: false,
      legacyAvailable
    };
  });
  return deepFreeze({
    inventoryVersion: CAPABILITY_INVENTORY_VERSION,
    actions,
    counts: {
      actionCount: actions.length,
      implementedCount: actions.filter((action) => action.capabilityStatus === 'implemented').length,
      legacyOnlyCount: actions.filter((action) => action.capabilityStatus === 'legacy-only').length,
      platformCanaryCount: actions.filter((action) => action.capabilityStatus === 'platform-canary').length
    }
  });
}

function validateCapabilityInventory(inventory, options) {
  const actual = safeSnapshot(
    inventory,
    'CAPABILITY_INVENTORY_SNAPSHOT_INVALID',
    'capability inventory snapshot'
  );
  const expected = createCapabilityInventory(options);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new CapabilityInventoryError(
      'CAPABILITY_INVENTORY_SNAPSHOT_MISMATCH',
      'capability inventory snapshot 与当前 authority 漂移',
      { expected, actual }
    );
  }
  return Object.freeze({
    valid: true,
    actionCount: expected.counts.actionCount,
    implementedCount: expected.counts.implementedCount,
    legacyOnlyCount: expected.counts.legacyOnlyCount,
    platformCanaryCount: expected.counts.platformCanaryCount
  });
}

module.exports = {
  CAPABILITY_INVENTORY_VERSION,
  CapabilityInventoryError,
  createCapabilityInventory,
  validateCapabilityInventory
};
