'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  FUND_RECON_POLICIES
} = require('../../../src/main-process/fund-recon-worker/policies');

const fixture = require(path.resolve(
  __dirname,
  '../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
));

test('FundRecon policies逐字段等于冻结fixture且production保持关闭', async () => {
  for (const policy of FUND_RECON_POLICIES) {
    assert.deepEqual(policy, fixture.actions[policy.actionKey]);
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
  }

  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 2 ** 30,
    totalMemoryBytes: 2 ** 30
  });
  try {
    const bindings = FUND_RECON_POLICIES.map((policy) =>
      runtime.policyRegistry.getBinding(policy.actionKey, 'entryKey'));
    assert.equal(new Set(bindings.map((binding) => binding.path)).size, 1);
    assert.match(bindings[0].path, /fund-recon-worker[/\\]worker-entry\.js$/);
  } finally {
    await runtime.shutdown();
  }
});

test('FundRecon result validators只接受有界稳定DTO与单manifest artifact', () => {
  const {
    validateFundReconExportResult,
    validateFundReconImportResult,
    validateFundReconRunResult
  } = require('../../../src/main-process/fund-recon-worker/policies');
  const summary = {
    bankRowCount: 1,
    hasGateway: false,
    hasProcessingResult: false,
    hasRefund: false,
    sourceFileCount: 1
  };
  assert.equal(validateFundReconImportResult({
    status: 'ok', operation: 'import', stateRevision: 1, summary
  }), true);
  assert.equal(validateFundReconRunResult({
    status: 'ok', operation: 'run', stateRevision: 2,
    summary: { ...summary, hasProcessingResult: true },
    evidenceSignature: 'a'.repeat(64),
    stats: {}
  }), true);
  const exportResult = {
    status: 'ok', operation: 'export', stateRevision: 2,
    summary: { ...summary, hasProcessingResult: true },
    evidenceSignature: 'a'.repeat(64),
    artifacts: [{
      artifactKey: 'manifest-1',
      stagingPath: '/tmp/manifest.json',
      byteSize: 10,
      sha256: 'b'.repeat(64)
    }]
  };
  assert.equal(validateFundReconExportResult(exportResult), true);
  assert.equal(validateFundReconExportResult({
    ...exportResult,
    artifacts: [exportResult.artifacts[0], exportResult.artifacts[0]]
  }), false, '冻结 policy maxArtifacts=1，validator 不得放宽为多 artifact');
  assert.equal(validateFundReconExportResult({
    status: 'ok', operation: 'export', stateRevision: 2,
    summary: { ...summary, hasProcessingResult: true },
    evidenceSignature: 'a'.repeat(64),
    artifacts: []
  }), false);
});
