'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ARCHIVE_CONTRACTS,
  classifyArchiveContract
} = require('../../../../src/backend/vcc-financial-op/archive-contract');
const {
  evaluateUnarchiveGate
} = require('../../../../src/backend/vcc-financial-op/unarchive-gate');
const {
  loadLegacyEvidence
} = require('./_archive-evidence-fixture');

function gateEvidence(overrides = {}) {
  return {
    gateVersion: 1,
    taskGeneration: 8,
    taskActive: false,
    activeBatchIds: [],
    importingRecordIds: [],
    unresolvedRecords: [],
    laterDependencies: [],
    ...overrides
  };
}

test('A-09 unarchive gate 固定按 inconsistent → active → unresolved → later → allowed', () => {
  const legacy = classifyArchiveContract(loadLegacyEvidence());
  const inconsistent = { ...legacy, contract: ARCHIVE_CONTRACTS.INCONSISTENT };
  const allBlocked = gateEvidence({
    taskActive: true,
    unresolvedRecords: [{ id: 1, sourceType: 'channel', status: 'failed_validation', resolutionStatus: 'unresolved' }],
    laterDependencies: [{ targetMonth: '2026-07', runs: [], archiveCount: 1, archivedDatasetTypes: [] }]
  });
  assert.equal(evaluateUnarchiveGate(inconsistent, allBlocked).code, 'archive-state-inconsistent');
  assert.equal(evaluateUnarchiveGate(legacy, allBlocked).code, 'active-vcc-task');
  assert.equal(evaluateUnarchiveGate(legacy, { ...allBlocked, taskActive: false }).code, 'unresolved-imports');
  assert.equal(evaluateUnarchiveGate(legacy, gateEvidence({
    laterDependencies: allBlocked.laterDependencies
  })).code, 'unarchive-not-tail');
  assert.deepEqual(evaluateUnarchiveGate(legacy, gateEvidence()), {
    canUnarchive: true,
    code: '',
    message: '',
    dependentMonths: []
  });
});

test('A-10 active/unresolved/later 只改变 gate，不改变 legacy classifier', () => {
  const evidence = loadLegacyEvidence();
  const contract = classifyArchiveContract(evidence);
  const states = [
    gateEvidence({ activeBatchIds: ['batch-1'] }),
    gateEvidence({ importingRecordIds: [9] }),
    gateEvidence({
      unresolvedRecords: [{
        id: 4,
        sourceType: 'fee_fx',
        status: 'failed_validation',
        resolutionStatus: 'unresolved'
      }]
    }),
    gateEvidence({
      laterDependencies: [{
        targetMonth: '2026-08',
        runs: [],
        archiveCount: 1,
        archivedDatasetTypes: ['channel']
      }]
    })
  ];
  assert.equal(contract.contract, ARCHIVE_CONTRACTS.LEGACY);
  assert.deepEqual(
    states.map((state) => evaluateUnarchiveGate(contract, state).code),
    ['active-vcc-task', 'active-vcc-task', 'unresolved-imports', 'unarchive-not-tail']
  );
  assert.equal(classifyArchiveContract(evidence).contract, ARCHIVE_CONTRACTS.LEGACY);
});
