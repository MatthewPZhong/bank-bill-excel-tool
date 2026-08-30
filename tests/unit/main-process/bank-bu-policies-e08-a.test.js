'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BANK_BU_POLICIES } = require(
  '../../../src/main-process/bank-bu-worker/policies'
);
const frozen = require(
  '../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
);

test('E08-A四个policy逐字段服从冻结Platform fixture且production固定false/legacy/0', () => {
  assert.equal(BANK_BU_POLICIES.length, 4);
  for (const policy of BANK_BU_POLICIES) {
    assert.deepEqual(policy, frozen.actions[policy.actionKey]);
    assert.deepEqual(policy.production, {
      enabled: false,
      effectiveMode: 'legacy',
      effectiveWorkerCount: 0,
      recoveryStatus: 'probe',
      evidenceStatus: 'baseline',
      downgradeReason: 'production gate not yet passed',
      benchmarkEvidenceId: null
    });
  }
});
