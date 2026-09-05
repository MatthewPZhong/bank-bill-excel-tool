'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const HISTORICAL_E13_G_REF = '138c5b43e345ff4c19f3bcf243bcb1f119c7c105';

const {
  bindingSnapshot
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const {
  CANONICAL_ACTION_KEYS,
  LEGACY_HANDLER_PAIRS,
  createActionManifest
} = require('../../../../src/main-process/background-execution/action-manifest');
const {
  validateActionCoverage
} = require('../../../../src/main-process/background-execution/coverage-check');
const {
  createCapabilityInventory,
  validateCapabilityInventory
} = require('../../../../src/main-process/background-execution/capability-inventory');
const {
  createEffectiveProductionStrategySnapshot,
  validateEffectiveProductionStrategySnapshot
} = require('../../../../src/main-process/background-execution/production-strategy-snapshot');
const {
  BACKGROUND_EXECUTION_POLICIES
} = require('../../../../src/main-process/background-execution/runtime');

function harness(overrides = {}) {
  const bindings = overrides.bindings || bindingSnapshot();
  const policies = overrides.policies || BACKGROUND_EXECUTION_POLICIES;
  const manifest = overrides.manifest || createActionManifest({ bindings, policies });
  const capabilityInventory = overrides.capabilityInventory || createCapabilityInventory({
    manifest,
    policies
  });
  return { bindings, policies, manifest, capabilityInventory };
}

function actionByKey(collection, actionKey) {
  return collection.actions.find((action) => action.actionKey === actionKey);
}

test('E13-G current manifest 以独立 54 action / 61 pair authority 达到六面 100% coverage', () => {
  const current = harness();
  const result = validateActionCoverage(current.manifest, current);
  assert.equal(CANONICAL_ACTION_KEYS.length, 54);
  assert.equal(LEGACY_HANDLER_PAIRS.length, 61);
  assert.deepEqual(current.manifest.counts, {
    actionCount: 54,
    legacyPairCount: 61,
    runtimePolicyCount: 36,
    legacyOnlyCount: 16,
    platformCanaryCount: 2
  });
  assert.deepEqual(result, {
    valid: true,
    actionCount: 54,
    legacyPairCount: 61,
    runtimePolicyCount: 36,
    surfaceCount: 6,
    coveredActionSurfaceCount: 324,
    expectedActionSurfaceCount: 324,
    coveragePercent: 100
  });
  assert.equal(Object.isFrozen(current.manifest), true);
  assert.equal(Object.isFrozen(current.manifest.surfaces.publishers), true);
});

test('Capability Inventory 与 Effective Production Strategy 分离，全部 capability 仍 effective legacy', () => {
  const current = harness();
  const snapshot = createEffectiveProductionStrategySnapshot(current);
  assert.deepEqual(current.capabilityInventory.counts, {
    actionCount: 54,
    implementedCount: 36,
    legacyOnlyCount: 16,
    platformCanaryCount: 2
  });
  assert.deepEqual(snapshot.counts, {
    actionCount: 54,
    productionEnabledCount: 0,
    legacyEffectiveCount: 54
  });

  const acquiring = actionByKey(current.capabilityInventory, 'acquiring:run-new-eligible');
  const acquiringStrategy = actionByKey(snapshot, 'acquiring:run-new-eligible');
  assert.equal(acquiring.capabilityMode, 'thread-pool');
  assert.equal(acquiring.runtimeRegistered, true);
  assert.equal(acquiringStrategy.effectiveMode, 'legacy');
  assert.equal(acquiringStrategy.effectiveWorkerCount, 0);
  assert.equal(acquiringStrategy.featureFlag, false);
  assert.equal(acquiringStrategy.legacyAvailable, true);

  const position = actionByKey(current.capabilityInventory, 'position:import');
  const positionStrategy = actionByKey(snapshot, 'position:import');
  assert.equal(position.capabilityMode, 'utility-process');
  assert.equal(position.handlerRoute, 'legacy-main');
  assert.equal(positionStrategy.effectiveMode, 'legacy');
  assert.equal(positionStrategy.downgradeReason, 'PENDING_HUMAN_REVIEW');

  const validation = validateEffectiveProductionStrategySnapshot(snapshot, current);
  assert.deepEqual(validation, {
    valid: true,
    actionCount: 54,
    productionEnabledCount: 0,
    legacyEffectiveCount: 54
  });
  assert.deepEqual(validateCapabilityInventory(current.capabilityInventory, current), {
    valid: true,
    actionCount: 54,
    implementedCount: 36,
    legacyOnlyCount: 16,
    platformCanaryCount: 2
  });
});

test('PreFund deferred bank import/run 必须独立显示 legacy 策略，不得由 MPT/export 代偿', () => {
  const current = harness();
  const snapshot = createEffectiveProductionStrategySnapshot(current);
  for (const [actionKey, taskKey] of [
    ['pre-fund:bank-import', 'pre-fund-reconciliation:import-bank'],
    ['pre-fund:run', 'pre-fund-reconciliation:run']
  ]) {
    const manifestAction = actionByKey(current.manifest, actionKey);
    const capability = actionByKey(current.capabilityInventory, actionKey);
    const strategy = actionByKey(snapshot, actionKey);
    assert.deepEqual(manifestAction.legacyTaskKeys, [taskKey]);
    assert.equal(manifestAction.capabilityStatus, 'legacy-only');
    assert.equal(manifestAction.handlerRoute, 'legacy-main');
    assert.equal(capability.capabilityStatus, 'legacy-only');
    assert.equal(capability.runtimeRegistered, false);
    assert.equal(capability.legacyAvailable, true);
    assert.equal(strategy.effectiveMode, 'legacy');
    assert.equal(strategy.effectiveWorkerCount, 0);
    assert.equal(strategy.featureFlag, false);
    assert.equal(strategy.downgradeReason, 'no-runtime-policy');
  }
});

test('Position import-result 只记录真实 legacy Main route，不伪造 E13-F adapter route', () => {
  const current = harness();
  const route = current.manifest.handlerRoutes.find((item) => (
    item.actionKey === 'position:import' &&
    item.legacyTaskKey === 'position-reconciliation:run:import-result'
  ));
  assert.deepEqual(route, {
    actionKey: 'position:import',
    legacyTaskKey: 'position-reconciliation:run:import-result',
    routeKind: 'legacy-main',
    managedCapabilityRoute: false
  });
  const regenerate = actionByKey(current.manifest, 'acquiring:export-diff-workbook');
  assert.deepEqual(regenerate.legacyTaskKeys, []);
  assert.equal(regenerate.handlerRoute, 'none');
  assert.equal(regenerate.capabilityStatus, 'runtime-policy');
});

test('manifest action/surface/pair 与 production binding 集合 mutant 全部 fail closed', () => {
  const current = harness();

  const missingAction = structuredClone(current.manifest);
  missingAction.actions.pop();
  assert.throws(
    () => validateActionCoverage(missingAction, current),
    (error) => error.code === 'ACTION_COVERAGE_ACTION_SET_MISMATCH'
  );

  const duplicateSurface = structuredClone(current.manifest);
  duplicateSurface.surfaces.handlers[0].actionKey = duplicateSurface.surfaces.handlers[1].actionKey;
  assert.throws(
    () => validateActionCoverage(duplicateSurface, current),
    (error) => error.code === 'ACTION_COVERAGE_SURFACE_SET_MISMATCH'
  );

  const substitutedRoute = structuredClone(current.manifest);
  substitutedRoute.handlerRoutes[0].legacyTaskKey = 'acquiringBillCurrency:run';
  assert.throws(
    () => validateActionCoverage(substitutedRoute, current),
    (error) => error.code === 'ACTION_COVERAGE_MANIFEST_PAIR_SET_MISMATCH'
  );

  const managedRouteClaim = structuredClone(current.manifest);
  const positionRoute = managedRouteClaim.handlerRoutes.find((item) => (
    item.legacyTaskKey === 'position-reconciliation:run:import-result'
  ));
  positionRoute.managedCapabilityRoute = true;
  assert.throws(
    () => validateActionCoverage(managedRouteClaim, current),
    (error) => error.code === 'ACTION_COVERAGE_HANDLER_ROUTE_INVALID'
  );

  const substitutedBinding = structuredClone(current.bindings);
  substitutedBinding['pending:export-summary'] = [];
  substitutedBinding['pending:export-diff'].push('pending:diff:export-aggregate');
  assert.throws(
    () => validateActionCoverage(current.manifest, { ...current, bindings: substitutedBinding }),
    (error) => error.code === 'ACTION_COVERAGE_BINDING_PAIR_SET_MISMATCH'
  );
});

test('重复 policy、durable 缺 inspector、artifact 缺 Publisher、service 缺资源、blocked enabled 均 fail closed', () => {
  const current = harness();

  const duplicatePolicies = structuredClone(current.policies);
  duplicatePolicies.push(structuredClone(duplicatePolicies[0]));
  assert.throws(
    () => validateActionCoverage(current.manifest, { ...current, policies: duplicatePolicies }),
    (error) => error.code === 'ACTION_COVERAGE_POLICY_DUPLICATE'
  );

  const missingInspector = structuredClone(current.policies);
  const durable = missingInspector.find((policy) => policy.commit.kind === 'worker-durable');
  durable.commit.inspectorKey = null;
  assert.throws(
    () => validateActionCoverage(current.manifest, { ...current, policies: missingInspector }),
    (error) => error.code === 'ACTION_COVERAGE_DURABLE_INSPECTOR_MISSING'
  );

  const missingPublisher = structuredClone(current.policies);
  const artifact = missingPublisher.find((policy) => policy.artifacts.kind !== 'none');
  artifact.artifacts.publisherKey = null;
  assert.throws(
    () => validateActionCoverage(current.manifest, { ...current, policies: missingPublisher }),
    (error) => error.code === 'ACTION_COVERAGE_ARTIFACT_PUBLISHER_MISSING'
  );

  const missingServiceResource = structuredClone(current.policies);
  const servicePolicy = missingServiceResource[0];
  servicePolicy.mode = 'service';
  servicePolicy.resources.profile = null;
  assert.throws(
    () => validateActionCoverage(current.manifest, {
      ...current,
      policies: missingServiceResource
    }),
    (error) => error.code === 'ACTION_COVERAGE_SERVICE_RESOURCE_MISSING'
  );

  const blockedEnabled = structuredClone(current.policies);
  blockedEnabled[0].disposition = 'blocked';
  blockedEnabled[0].production.enabled = true;
  const matchingManifest = structuredClone(current.manifest);
  actionByKey(matchingManifest, blockedEnabled[0].actionKey).runtimeRouteEnabled = true;
  assert.throws(
    () => validateActionCoverage(matchingManifest, { ...current, policies: blockedEnabled }),
    (error) => error.code === 'ACTION_COVERAGE_BLOCKED_ENABLED'
  );
});

test('已发布 E13-G 清单和策略快照由独立 gate 对当前模块导出复验', () => {
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const historicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e13-g-history-'));
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--quiet', '--no-checkout', repositoryRoot, historicalRoot],
      { encoding: 'utf8' }
    );
    assert.equal(clone.status, 0, clone.stderr || clone.stdout);
    const checkout = spawnSync(
      'git',
      ['checkout', '--quiet', '--detach', HISTORICAL_E13_G_REF],
      { cwd: historicalRoot, encoding: 'utf8' }
    );
    assert.equal(checkout.status, 0, checkout.stderr || checkout.stdout);
    const result = spawnSync(
      process.execPath,
      [path.join(historicalRoot, 'scripts/check-background-execution-manifest.js')],
      {
        cwd: historicalRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_PATH: path.join(repositoryRoot, 'node_modules')
        }
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /E13-G manifest gate PASS: 324\/324 surfaces, 61 legacy pairs, 0 production enabled/);
  } finally {
    fs.rmSync(historicalRoot, { recursive: true, force: true });
  }
});

test('外部 feature flag 不能绕过 policy disabled，策略快照 drift 与未知 action 均被拒绝', () => {
  const current = harness();
  const flags = { 'acquiring:run-new-eligible': true };
  const snapshot = createEffectiveProductionStrategySnapshot({
    ...current,
    featureFlags: flags,
    eligibilityThresholds: { 'acquiring:run-new-eligible': 'rows>=300000' }
  });
  const action = actionByKey(snapshot, 'acquiring:run-new-eligible');
  assert.equal(action.featureFlag, true);
  assert.equal(action.effectiveMode, 'legacy');
  assert.equal(action.effectiveWorkerCount, 0);
  assert.equal(action.eligibilityThreshold, 'rows>=300000');
  assert.equal(action.downgradeReason, 'PENDING_HUMAN_REVIEW');

  const drifted = structuredClone(snapshot);
  actionByKey(drifted, 'acquiring:run-new-eligible').effectiveWorkerCount = 8;
  assert.throws(
    () => validateEffectiveProductionStrategySnapshot(drifted, {
      ...current,
      featureFlags: flags,
      eligibilityThresholds: { 'acquiring:run-new-eligible': 'rows>=300000' }
    }),
    (error) => error.code === 'PRODUCTION_STRATEGY_SNAPSHOT_MISMATCH'
  );
  assert.throws(
    () => createEffectiveProductionStrategySnapshot({
      ...current,
      featureFlags: { 'unknown:action': true }
    }),
    (error) => error.code === 'PRODUCTION_STRATEGY_FEATURE_FLAGS_INVALID'
  );
});

test('manifest 输入拒绝 accessor 且不执行 getter', () => {
  const bindings = structuredClone(bindingSnapshot());
  let reads = 0;
  Object.defineProperty(bindings, 'position:import', {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    }
  });
  assert.throws(
    () => createActionManifest({ bindings, policies: BACKGROUND_EXECUTION_POLICIES }),
    (error) => error.code === 'ACTION_MANIFEST_BINDINGS_INVALID'
  );
  assert.equal(reads, 0);
});
