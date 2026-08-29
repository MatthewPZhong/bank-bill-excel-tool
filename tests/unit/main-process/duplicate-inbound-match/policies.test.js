'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createBackgroundExecutionRuntime } = require(
  '../../../../src/main-process/background-execution/runtime'
);
const {
  DUPLICATE_POLICIES,
  validateDuplicateExportResult,
  validateDuplicateImportResult,
  validateDuplicateRunResult
} = require('../../../../src/main-process/duplicate-inbound-match/policies');

const fixture = require(path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
));

test('Duplicate policies逐字段等于冻结fixture、共享单Service且production=false', async () => {
  for (const policy of DUPLICATE_POLICIES) {
    assert.deepEqual(policy, fixture.actions[policy.actionKey]);
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.service.serviceKey, 'service.duplicate');
  }
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 2 ** 30,
    totalMemoryBytes: 2 ** 30
  });
  try {
    const bindings = DUPLICATE_POLICIES.map((policy) =>
      runtime.policyRegistry.getBinding(policy.actionKey, 'entryKey'));
    assert.equal(new Set(bindings.map((binding) => binding.path)).size, 1);
    assert.match(bindings[0].path, /duplicate-inbound-match[/\\]worker-entry\.js$/);
    const topology = runtime.policyRegistry.getBinding(
      'duplicate:import',
      'resources.compound.topologyKey'
    );
    assert.deepEqual(topology({ requestedChildCount: 4 }), { effectiveChildCount: 1 });
    assert.throws(
      () => runtime.start({
        actionKey: 'duplicate:run',
        operationKey: 'production-reject',
        production: true,
        context: { kind: 'operation', value: {
          taskRunId: 'task-run-1', taskKey: 'duplicate-inbound-match:run',
          moduleId: 'duplicate', parentRunId: 'parent-1', operationKey: 'production-reject'
        } },
        input: {}
      }),
      (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
    );
  } finally {
    await runtime.shutdown();
  }
});

test('Duplicate result validators只接受有界稳定DTO与单artifact', () => {
  const summary = { bankRowCount: 2, documentRowCount: 3, canRun: true, canExport: false };
  assert.equal(validateDuplicateImportResult({
    status: 'ok', operation: 'import', stateRevision: 2, summary
  }), true);
  assert.equal(validateDuplicateRunResult({
    status: 'ok', operation: 'run', stateRevision: 4,
    summary: { ...summary, canExport: true }, runId: 8
  }), true);
  assert.equal(validateDuplicateRunResult({
    status: 'ok', operation: 'run', stateRevision: 4,
    summary: { ...summary, canExport: true }, runId: 8, leakedDetail: {}
  }), false);
  const artifact = {
    artifactKey: 'duplicate-result', stagingPath: '/tmp/result.xlsx',
    byteSize: 12, sha256: 'a'.repeat(64)
  };
  assert.equal(validateDuplicateExportResult({
    status: 'ok', operation: 'export', stateRevision: 4,
    summary: { ...summary, canExport: true }, artifacts: [artifact]
  }), true);
  assert.equal(validateDuplicateExportResult({
    status: 'ok', operation: 'export', stateRevision: 4,
    summary, artifacts: [artifact, artifact]
  }), false);
});
