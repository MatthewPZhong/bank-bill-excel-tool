'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const historical = process.argv[2] || '/private/tmp/g7-r2-baseline-8b12a6d5';
const current = process.argv[3] || '/private/tmp/execution-descriptors-review-20260921-r2';
const scope = 'src/main-process/background-execution';
const load = (name) => require(path.join(historical, scope, name));
const policies = load('runtime').BACKGROUND_EXECUTION_POLICIES;
const bindings = load('action-task-binding-registry').bindingSnapshot();
const manifest = load('action-manifest').createActionManifest({ bindings, policies });
const capabilityInventory = load('capability-inventory').createCapabilityInventory({ manifest, policies });
const productionStrategy = load('production-strategy-snapshot').createEffectiveProductionStrategySnapshot({ capabilityInventory, policies });
const approved = JSON.parse(fs.readFileSync(path.join(current, scope, 'approved-execution-baseline.json'), 'utf8'));
const fixturePath = path.join(current, 'tests/fixtures/execution-descriptors/runtime-baseline.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const provenance = JSON.parse(fs.readFileSync(path.join(current, 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/review-fix-20260921/approved-baseline-provenance.json'), 'utf8'));
const sort = (values) => [...values].sort((a, b) => a.actionKey.localeCompare(b.actionKey));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.deepEqual(capabilityInventory, approved.capabilityInventory);
assert.deepEqual(productionStrategy, approved.productionStrategy);
assert.deepEqual(sort(policies), sort(fixture.actions.map((action) => action.policy)));
for (const [name, hash] of Object.entries(provenance.sourceHashes)) {
  assert.equal(sha(path.join(historical, scope, name)), hash, name);
}
assert.equal(sha(fixturePath), provenance.fixtureSha256);
assert.equal(sha(path.join(current, scope, 'approved-execution-baseline.json')), provenance.approvedBaselineSha256);
console.log(JSON.stringify({
  sourceCommit: approved.sourceCommit,
  historicalProjectionEqualsApproved: true,
  historicalRawPoliciesEqualFrozenFixture: true,
  provenanceHashesMatch: true,
  runtimePolicyCount: policies.length,
  capabilityCounts: capabilityInventory.counts,
  productionCounts: productionStrategy.counts,
  currentDescriptorOrCatalogLoaded: Object.keys(require.cache).some((name) => name.startsWith(current)),
  result: 'PASS'
}, null, 2));
