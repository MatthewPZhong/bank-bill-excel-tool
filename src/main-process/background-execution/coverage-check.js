'use strict';

const { assertJsonSafe } = require('./protocol-validator');
const {
  ACTION_MANIFEST_VERSION,
  CANONICAL_ACTION_KEYS,
  LEGACY_HANDLER_PAIRS
} = require('./action-manifest');

const COVERAGE_SURFACE_KEYS = Object.freeze([
  'handlers',
  'filePlans',
  'inventory',
  'registry',
  'inspectors',
  'publishers'
]);

class ActionCoverageError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ActionCoverageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ActionCoverageError(code, message, details);
}

function safeSnapshot(value, code, label) {
  try {
    assertJsonSafe(value);
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    fail(code, `${label} 必须是 JSON-safe plain data`);
  }
}

function sortedUnique(values, code, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    fail(code, `${label} 必须是 string array`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail(code, `${label} 存在重复值`);
  return sorted;
}

function assertExactSet(actual, expected, code, label) {
  const normalized = sortedUnique(actual, code, label);
  if (normalized.length !== expected.length || normalized.some((value, index) => value !== expected[index])) {
    fail(code, `${label} 集合漂移`, { expected, actual: normalized });
  }
}

function pairIdentity(actionKey, taskKey) {
  return `${actionKey}\u0000${taskKey}`;
}

function expectedPairIdentities() {
  return LEGACY_HANDLER_PAIRS.map(([actionKey, taskKey]) => pairIdentity(actionKey, taskKey)).sort();
}

function bindingPairIdentities(bindings) {
  const snapshot = safeSnapshot(bindings, 'ACTION_COVERAGE_BINDINGS_INVALID', 'bindings');
  assertExactSet(
    Object.keys(snapshot),
    CANONICAL_ACTION_KEYS,
    'ACTION_COVERAGE_BINDING_ACTION_SET_MISMATCH',
    'binding action'
  );
  const pairs = [];
  for (const actionKey of CANONICAL_ACTION_KEYS) {
    const taskKeys = sortedUnique(
      snapshot[actionKey],
      'ACTION_COVERAGE_BINDING_VALUE_INVALID',
      `binding ${actionKey}`
    );
    for (const taskKey of taskKeys) pairs.push(pairIdentity(actionKey, taskKey));
  }
  return pairs.sort();
}

function policyByAction(policies) {
  const snapshot = safeSnapshot(policies, 'ACTION_COVERAGE_POLICIES_INVALID', 'policies');
  if (!Array.isArray(snapshot)) fail('ACTION_COVERAGE_POLICIES_INVALID', 'policies 必须是 array');
  const result = new Map();
  for (const policy of snapshot) {
    if (!policy || typeof policy.actionKey !== 'string') {
      fail('ACTION_COVERAGE_POLICY_ACTION_INVALID', 'policy actionKey 非法');
    }
    if (!CANONICAL_ACTION_KEYS.includes(policy.actionKey)) {
      fail('ACTION_COVERAGE_POLICY_ACTION_UNKNOWN', `未知 policy ${policy.actionKey}`);
    }
    if (result.has(policy.actionKey)) {
      fail('ACTION_COVERAGE_POLICY_DUPLICATE', `policy ${policy.actionKey} 重复`);
    }
    result.set(policy.actionKey, policy);
  }
  return result;
}

function validateActionCoverage(manifest, { bindings, policies }) {
  const snapshot = safeSnapshot(manifest, 'ACTION_COVERAGE_MANIFEST_INVALID', 'manifest');
  const policiesByAction = policyByAction(policies);
  if (snapshot.manifestVersion !== ACTION_MANIFEST_VERSION) {
    fail('ACTION_COVERAGE_VERSION_MISMATCH', 'manifestVersion 漂移');
  }
  if (!snapshot.surfaces || typeof snapshot.surfaces !== 'object' ||
      Object.keys(snapshot.surfaces).sort().join('\u0000') !== [...COVERAGE_SURFACE_KEYS].sort().join('\u0000')) {
    fail('ACTION_COVERAGE_SURFACE_SHAPE_MISMATCH', 'coverage surface exact shape 漂移');
  }
  if (!Array.isArray(snapshot.actions)) fail('ACTION_COVERAGE_ACTIONS_INVALID', 'actions 必须是 array');
  assertExactSet(
    snapshot.actions.map((action) => action.actionKey),
    CANONICAL_ACTION_KEYS,
    'ACTION_COVERAGE_ACTION_SET_MISMATCH',
    'manifest action'
  );
  const manifestPairs = (snapshot.handlerRoutes || []).map((route) => {
    if (route.routeKind !== 'legacy-main' || route.managedCapabilityRoute !== false) {
      fail(
        'ACTION_COVERAGE_HANDLER_ROUTE_INVALID',
        `${route.actionKey}/${route.legacyTaskKey} 不得伪报 managed route`
      );
    }
    return pairIdentity(route.actionKey, route.legacyTaskKey);
  }).sort();
  assertExactSet(
    manifestPairs,
    expectedPairIdentities(),
    'ACTION_COVERAGE_MANIFEST_PAIR_SET_MISMATCH',
    'manifest legacy pair'
  );
  assertExactSet(
    bindingPairIdentities(bindings),
    expectedPairIdentities(),
    'ACTION_COVERAGE_BINDING_PAIR_SET_MISMATCH',
    'production binding pair'
  );
  const actionByKey = new Map(snapshot.actions.map((action) => [action.actionKey, action]));
  for (const surfaceKey of COVERAGE_SURFACE_KEYS) {
    const records = snapshot.surfaces[surfaceKey];
    if (!Array.isArray(records)) {
      fail('ACTION_COVERAGE_SURFACE_INVALID', `${surfaceKey} 必须是 array`);
    }
    assertExactSet(
      records.map((record) => record.actionKey),
      CANONICAL_ACTION_KEYS,
      'ACTION_COVERAGE_SURFACE_SET_MISMATCH',
      surfaceKey
    );
  }
  for (const actionKey of CANONICAL_ACTION_KEYS) {
    const action = actionByKey.get(actionKey);
    const policy = policiesByAction.get(actionKey) || null;
    const expectedStatus = policy
      ? 'runtime-policy'
      : (actionKey.startsWith('background-execution:') ? 'platform-canary' : 'legacy-only');
    if (action.capabilityStatus !== expectedStatus) {
      fail('ACTION_COVERAGE_CAPABILITY_STATUS_MISMATCH', `${actionKey} capabilityStatus 漂移`);
    }
    if (action.runtimeRouteEnabled !== Boolean(policy && policy.production.enabled === true)) {
      fail('ACTION_COVERAGE_RUNTIME_ROUTE_MISMATCH', `${actionKey} runtime route 状态漂移`);
    }
    if (!policy) continue;
    if (policy.disposition === 'blocked' && policy.production.enabled === true) {
      fail('ACTION_COVERAGE_BLOCKED_ENABLED', `${actionKey} blocked 不能启用 production`);
    }
    if (policy.commit.kind === 'worker-durable' && !policy.commit.inspectorKey) {
      fail('ACTION_COVERAGE_DURABLE_INSPECTOR_MISSING', `${actionKey} 缺少 inspector`);
    }
    if (policy.artifacts.kind !== 'none' && !policy.artifacts.publisherKey) {
      fail('ACTION_COVERAGE_ARTIFACT_PUBLISHER_MISSING', `${actionKey} 缺少 Publisher`);
    }
    if (policy.mode === 'service' && (!policy.resources || !policy.resources.profile)) {
      fail('ACTION_COVERAGE_SERVICE_RESOURCE_MISSING', `${actionKey} service 缺少资源 profile`);
    }
  }
  const actionCount = CANONICAL_ACTION_KEYS.length;
  return Object.freeze({
    valid: true,
    actionCount,
    legacyPairCount: expectedPairIdentities().length,
    runtimePolicyCount: policiesByAction.size,
    surfaceCount: COVERAGE_SURFACE_KEYS.length,
    coveredActionSurfaceCount: actionCount * COVERAGE_SURFACE_KEYS.length,
    expectedActionSurfaceCount: actionCount * COVERAGE_SURFACE_KEYS.length,
    coveragePercent: 100
  });
}

module.exports = {
  ActionCoverageError,
  COVERAGE_SURFACE_KEYS,
  validateActionCoverage
};
