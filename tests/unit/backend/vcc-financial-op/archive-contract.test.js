'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  buildArchiveEvidenceV2
} = require('../../../../src/backend/vcc-financial-op/archive-evidence');
const {
  ARCHIVE_CONTRACTS,
  classifyArchiveContract
} = require('../../../../src/backend/vcc-financial-op/archive-contract');
const {
  createCurrentRawEvidence,
  currentGeneratorSha256,
  legacyFixtureSha256,
  loadLegacyEvidence,
  loadLegacyRawEvidence,
  readLegacyManifest
} = require('./_archive-evidence-fixture');

test('A-04 current-five 按 effectiveCalculatedBalance 分类，按 base archive 的反例失败关闭', () => {
  const raw = createCurrentRawEvidence();
  const current = classifyArchiveContract(buildArchiveEvidenceV2(raw));
  assert.equal(current.contract, ARCHIVE_CONTRACTS.CURRENT);
  assert.deepEqual(current.structuralReasons, []);

  const baseArchive = createCurrentRawEvidence();
  baseArchive.archives[0].balances.EUR = '100';
  const inconsistent = classifyArchiveContract(buildArchiveEvidenceV2(baseArchive));
  assert.equal(inconsistent.contract, ARCHIVE_CONTRACTS.INCONSISTENT);
  assert.ok(inconsistent.structuralReasons.includes('archive-balance-mismatch:PPHK/EUR'));
});

test('A-05 真实 v3.1.7 fixture 经 current migration 后精确分类 legacy-four', () => {
  const manifest = readLegacyManifest();
  assert.equal(manifest.source.tag, 'v3.1.7');
  assert.equal(manifest.source.commit, '1117c8b7d047cf408807b023368c63123a90d81f');
  assert.match(manifest.runtime.sqlite, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.dependencies.locksEqualAfterRootVersionNormalization, true);
  assert.equal(manifest.fixture.generationTimeDbSha256, legacyFixtureSha256());
  assert.equal(manifest.generator.sha256, currentGeneratorSha256());
  const generatorLf = fs.readFileSync(manifest.generator.path, 'utf8').replace(/\r\n/g, '\n');
  const generatorCrlf = generatorLf.replace(/\n/g, '\r\n');
  assert.equal(
    crypto.createHash('sha256').update(generatorCrlf.replace(/\r\n/g, '\n')).digest('hex'),
    manifest.generator.sha256,
    'Windows CRLF checkout 必须归一为同一 generator provenance'
  );
  assert.match(manifest.fixture.sourceEvidence.schemaHash, /^[0-9a-f]{64}$/);
  assert.equal(manifest.fixture.sourceEvidence.tableCounts.vcc_fin_op_runs, 1);
  assert.equal(manifest.fixture.sourceEvidence.tableCounts.vcc_fin_op_datasets, 4);
  assert.equal(manifest.fixture.sourceEvidence.tableCounts.vcc_fin_op_run_rows, 3);
  assert.equal(manifest.fixture.sourceEvidence.tableCounts.vcc_fin_op_run_balances, 9);
  assert.equal(manifest.fixture.sourceEvidence.runs[0].id, 1);
  assert.deepEqual(manifest.fixture.sourceEvidence.runs[0].inputRevisions, {
    channel: 1,
    fee_fx: 1,
    recharge_refund: 1,
    system_op: 1
  });
  assert.equal(manifest.fixture.sourceEvidence.archives[0].subject, 'PPHK');
  assert.equal(Object.keys(manifest.fixture.sourceEvidence.archives[0].balances).length, 9);
  assert.equal(manifest.fixture.sourceEvidence.archives[0].balances.USD, '108');
  assert.equal(manifest.fixture.sourceEvidence.archives[0].balances.EUR, '103');
  assert.equal(manifest.currentMigrationProbe.expectedContract, ARCHIVE_CONTRACTS.LEGACY);
  assert.equal(manifest.currentMigrationProbe.evidence.runs[0].resultRevision, 0);
  assert.equal(manifest.currentMigrationProbe.evidence.runs[0].inputFingerprint, null);
  assert.deepEqual(manifest.currentMigrationProbe.evidence.pendingCounts, {
    effectiveFacts: 0,
    runRows: 0,
    summaries: 0,
    currencyTotals: 0
  });
  const evidence = loadLegacyEvidence();
  const result = classifyArchiveContract(evidence);
  assert.equal(result.contract, ARCHIVE_CONTRACTS.LEGACY);
  assert.deepEqual(result.datasetTypes, ['channel', 'fee_fx', 'recharge_refund', 'system_op']);
  assert.deepEqual(result.subjects, ['PPHK']);
  assert.deepEqual(result.structuralReasons, []);
  assert.equal(evidence.resultValidations[0].effectiveBalances.length, 9);
});

test('A-06 真实 fixture 副本的单一 Pending effective fact 残留归 inconsistent', () => {
  const evidence = loadLegacyEvidence({ pendingResidual: true });
  assert.equal(evidence.pendingEffectiveFactCount, 1);
  const result = classifyArchiveContract(evidence);
  assert.equal(result.contract, ARCHIVE_CONTRACTS.INCONSISTENT);
  assert.ok(result.structuralReasons.includes('legacy-pending-evidence-present'));
});

test('A-07 input revisions 按对象语义比较，不受 JSON key order 影响', () => {
  const raw = loadLegacyRawEvidence();
  raw.runs[0].inputRevisions = {
    system_op: 1,
    recharge_refund: 1,
    fee_fx: 1,
    channel: 1
  };
  const result = classifyArchiveContract(buildArchiveEvidenceV2(raw));
  assert.equal(result.contract, ARCHIVE_CONTRACTS.LEGACY);
});

test('A-08 legacy 严格区分 SQL NULL/空 fingerprint，通用 result violation 直接 inconsistent', () => {
  const legacyRaw = loadLegacyRawEvidence();
  assert.equal(
    classifyArchiveContract(buildArchiveEvidenceV2(legacyRaw)).contract,
    ARCHIVE_CONTRACTS.LEGACY
  );
  legacyRaw.runs[0].inputFingerprint = '';
  const emptyFingerprint = classifyArchiveContract(buildArchiveEvidenceV2(legacyRaw));
  assert.equal(emptyFingerprint.contract, ARCHIVE_CONTRACTS.INCONSISTENT);
  assert.ok(emptyFingerprint.structuralReasons.includes('legacy-input-fingerprint-not-null'));

  const invalidResultRaw = createCurrentRawEvidence();
  invalidResultRaw.storedRunBalances.find((balance) => balance.currency === 'USD').difference = '1';
  const invalidResult = classifyArchiveContract(buildArchiveEvidenceV2(invalidResultRaw));
  assert.equal(invalidResult.contract, ARCHIVE_CONTRACTS.INCONSISTENT);
  assert.deepEqual(invalidResult.structuralReasons, ['effective-run-result-invalid']);

  const missingMetadataRaw = createCurrentRawEvidence();
  missingMetadataRaw.runRows[0].sourceType = null;
  const missingMetadata = classifyArchiveContract(buildArchiveEvidenceV2(missingMetadataRaw));
  assert.equal(missingMetadata.contract, ARCHIVE_CONTRACTS.INCONSISTENT);
  assert.ok(missingMetadata.structuralReasons.includes('effective-run-result-invalid'));
});
