'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveChangesPath } = require('./lib/changes-paths');

const {
  bindingSnapshot
} = require('../src/main-process/background-execution/action-task-binding-registry');
const { validateApprovedExecutionPolicies } = require('../src/main-process/background-execution/approved-execution-baseline');
const {
  validateActionCoverage
} = require('../src/main-process/background-execution/coverage-check');
const {
  validateCapabilityInventory
} = require('../src/main-process/background-execution/capability-inventory');
const {
  validateEffectiveProductionStrategySnapshot
} = require('../src/main-process/background-execution/production-strategy-snapshot');
const {
  BACKGROUND_EXECUTION_POLICIES
} = require('../src/main-process/execution-descriptors/policy-catalog');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const AUTHORITY_PATH = 'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/recovery-contract-authority.v1.json';
const OUTPUT_PATHS = Object.freeze({
  manifest: 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/manifest-current/e13-g-action-manifest.json',
  capabilityInventory: 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/manifest-current/e13-g-capability-inventory.json',
  productionStrategy: 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/manifest-current/e13-g-production-strategy-snapshot.json',
  coverageReport: 'changes/v3.2.10/codex/v3.2.10-execution-descriptors/evidence/manifest-current/e13-g-coverage-report.json'
});
const SOURCE_PATHS = Object.freeze([
  'scripts/check-background-execution-manifest.js',
  'src/main.js',
  'src/main-process/archive-center/task-policy-registry.js',
  'src/main-process/background-execution/action-task-binding-registry.js',
  'src/main-process/background-execution/action-manifest.js',
  'src/main-process/background-execution/capability-inventory.js',
  'src/main-process/background-execution/coverage-check.js',
  'src/main-process/background-execution/production-strategy-snapshot.js',
  'src/main-process/background-execution/runtime.js',
  'src/main-process/background-execution/supervisor.js',
  'src/main-process/background-execution/approved-execution-baseline.js',
  'src/main-process/background-execution/approved-execution-baseline.json',
  'src/main-process/archive-center/task-policy-common.js',
  'src/main-process/application-recovery/composition.js',
  'src/main-process/task-adapter-composition.js',
  'src/main-process/execution-descriptors/composition.js',
  'src/main-process/execution-descriptors/contract.js',
  'src/main-process/execution-descriptors/descriptor-builder.js',
  'src/main-process/execution-descriptors/legacy-task-policies.js',
  'src/main-process/execution-descriptors/mature-adapters.js',
  'src/main-process/execution-descriptors/policy-catalog.js',
  'src/main-process/biz-op-v327/execution-descriptor.js',
  'src/main-process/duplicate-inbound-match/execution-descriptor.js',
  'src/main-process/fund-recon-worker/execution-descriptor.js',
  'src/main-process/new-account/execution-descriptor.js',
  'src/main-process/new-account/generation-contract.js',
  'src/main-process/new-account/policies.js',
  'src/main-process/new-account/artifact-copy.js',
  'src/main-process/position-reconciliation/execution-descriptor.js',
  'src/main-process/pre-fund-reconciliation/execution-descriptor.js',
  'src/main-process/recon-id-fix-service/execution-descriptor.js',
  'src/main-process/toolbox-background/execution-descriptor.js',
  'src/main-process/vcc-financial-op-output/execution-descriptor.js',
  'src/main-process/biz-op-v327/archive-task-policies.js',
  'src/main-process/duplicate-inbound-match/archive-task-policies.js',
  'src/main-process/fund-recon-worker/archive-task-policies.js',
  'src/main-process/new-account/archive-task-policies.js',
  'src/main-process/position-reconciliation/archive-task-policies.js',
  'src/main-process/pre-fund-reconciliation/archive-task-policies.js',
  'src/main-process/recon-id-fix-service/archive-task-policies.js',
  'src/main-process/toolbox-background/archive-task-policies.js',
  'src/main-process/vcc-financial-op-output/archive-task-policies.js'
]);

function absolute(relativePath) {
  return resolveChangesPath(REPOSITORY_ROOT, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(absolute(relativePath), 'utf8'));
}

function sha256File(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolute(relativePath))).digest('hex');
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_PATHS.map((relativePath) => [relativePath, sha256File(relativePath)]));
}

function buildArtifacts() {
  const authority = readJson(AUTHORITY_PATH);
  const bindings = bindingSnapshot();
  const policies = BACKGROUND_EXECUTION_POLICIES;
  // 先查独立批准基线，再允许任何 --write 产物写入；批准 JSON 从不在输出列表中。
  const { manifest, capabilityInventory, productionStrategy } = validateApprovedExecutionPolicies(policies, { bindings });
  const coverage = validateActionCoverage(manifest, { bindings, policies });
  const capabilityValidation = validateCapabilityInventory(capabilityInventory, { manifest, policies });
  const strategyValidation = validateEffectiveProductionStrategySnapshot(productionStrategy, {
    capabilityInventory,
    policies
  });
  const coverageReport = {
    reportVersion: 1,
    release: 'v3.2.10',
    workItem: 'G7',
    contractAuthority: {
      contractVersion: authority.contractVersion,
      revision: authority.revision,
      genesis: authority.genesis,
      approvalStatus: authority.approvalStatus,
      bindingMapSha256: authority.actionTaskBinding.bindingMapSha256,
      expectedPairCount: authority.actionTaskBinding.expectedPairCount,
      expectedProvenanceCount: authority.actionTaskBinding.expectedProvenanceCount
    },
    coverage,
    capabilityInventory: capabilityValidation,
    productionStrategy: strategyValidation,
    humanRedlineReviewStatus: authority.changeControl.humanRedlineReviewStatus,
    productionEnablementAllowed: false,
    sourceHashes: sourceHashes()
  };
  return { bindings, policies, manifest, capabilityInventory, productionStrategy, coverageReport };
}

function writeJson(relativePath, value) {
  fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true });
  fs.writeFileSync(absolute(relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const write = process.argv.slice(2).includes('--write');
  const expected = buildArtifacts();
  if (write) {
    writeJson(OUTPUT_PATHS.manifest, expected.manifest);
    writeJson(OUTPUT_PATHS.capabilityInventory, expected.capabilityInventory);
    writeJson(OUTPUT_PATHS.productionStrategy, expected.productionStrategy);
    writeJson(OUTPUT_PATHS.coverageReport, expected.coverageReport);
  }

  const manifest = readJson(OUTPUT_PATHS.manifest);
  const capabilityInventory = readJson(OUTPUT_PATHS.capabilityInventory);
  const productionStrategy = readJson(OUTPUT_PATHS.productionStrategy);
  const coverageReport = readJson(OUTPUT_PATHS.coverageReport);

  assert.deepStrictEqual(manifest, expected.manifest, 'E13-G Action Manifest drift');
  assert.deepStrictEqual(
    capabilityInventory,
    expected.capabilityInventory,
    'E13-G Capability Inventory drift'
  );
  assert.deepStrictEqual(
    productionStrategy,
    expected.productionStrategy,
    'E13-G Effective Production Strategy drift'
  );
  assert.deepStrictEqual(coverageReport, expected.coverageReport, 'E13-G coverage report drift');

  validateActionCoverage(manifest, expected);
  validateCapabilityInventory(capabilityInventory, { manifest, policies: expected.policies });
  validateEffectiveProductionStrategySnapshot(productionStrategy, {
    capabilityInventory,
    policies: expected.policies
  });

  process.stdout.write(
    `E13-G manifest gate PASS: ${expected.coverageReport.coverage.coveredActionSurfaceCount}/` +
    `${expected.coverageReport.coverage.expectedActionSurfaceCount} surfaces, ` +
    `${expected.coverageReport.coverage.legacyPairCount} legacy pairs, ` +
    `${expected.coverageReport.productionStrategy.productionEnabledCount} production enabled\n`
  );
}

main();
