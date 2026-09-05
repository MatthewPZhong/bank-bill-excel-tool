'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  bindingSnapshot
} = require('../src/main-process/background-execution/action-task-binding-registry');
const {
  createActionManifest
} = require('../src/main-process/background-execution/action-manifest');
const {
  validateActionCoverage
} = require('../src/main-process/background-execution/coverage-check');
const {
  createCapabilityInventory,
  validateCapabilityInventory
} = require('../src/main-process/background-execution/capability-inventory');
const {
  createEffectiveProductionStrategySnapshot,
  validateEffectiveProductionStrategySnapshot
} = require('../src/main-process/background-execution/production-strategy-snapshot');
const {
  BACKGROUND_EXECUTION_POLICIES
} = require('../src/main-process/background-execution/runtime');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const AUTHORITY_PATH = 'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/recovery-contract-authority.v1.json';
const OUTPUT_PATHS = Object.freeze({
  manifest: 'changes/3.2.5/e13-g-action-manifest.json',
  capabilityInventory: 'changes/3.2.5/e13-g-capability-inventory.json',
  productionStrategy: 'changes/3.2.5/e13-g-production-strategy-snapshot.json',
  coverageReport: 'changes/3.2.5/e13-g-coverage-report.json'
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
  'src/main-process/background-execution/runtime.js'
]);

function absolute(relativePath) {
  return path.join(REPOSITORY_ROOT, relativePath);
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
  const manifest = createActionManifest({ bindings, policies });
  const coverage = validateActionCoverage(manifest, { bindings, policies });
  const capabilityInventory = createCapabilityInventory({ manifest, policies });
  const capabilityValidation = validateCapabilityInventory(capabilityInventory, { manifest, policies });
  const productionStrategy = createEffectiveProductionStrategySnapshot({
    capabilityInventory,
    policies
  });
  const strategyValidation = validateEffectiveProductionStrategySnapshot(productionStrategy, {
    capabilityInventory,
    policies
  });
  const coverageReport = {
    reportVersion: 1,
    release: 'v3.2.5',
    workItem: 'E13-G',
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
