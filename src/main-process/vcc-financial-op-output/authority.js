'use strict';

const crypto = require('node:crypto');

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  loadArchiveEvidenceSet
} = require('../../backend/vcc-financial-op/read-snapshot');
const {
  ARCHIVE_CONTRACTS,
  classifyArchiveContract
} = require('../../backend/vcc-financial-op/archive-contract');
const {
  buildSubjectRowPlan,
  loadEffectiveRunData
} = require('../vcc-financial-op-writer');
const {
  VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS
} = require('./policies');

function authorityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function subjectDigest(subject) {
  return crypto.createHash('sha256').update(String(subject), 'utf8').digest('hex');
}

function pendingSummaryProjection(rows, subject) {
  return rows.filter((row) => row.subject === subject).map((row) => ({
    channelName: row.channel_name || '',
    currencyMismatch: Boolean(row.currency_mismatch),
    flowCurrency: row.flow_currency || '',
    pendingCurrency: row.pending_currency || '',
    reconType: row.recon_type || '',
    flowAmount: String(row.flow_amount),
    pendingAmount: String(row.pending_amount)
  }));
}

function pendingTotalsProjection(rows, subject) {
  return rows.filter((row) => row.subject === subject).map((row) => ({
    currency: String(row.currency),
    amount: String(row.amount)
  }));
}

function subjectAuthority(data, subject, subjectIndex) {
  const plan = canonicalJsonSnapshot(buildSubjectRowPlan(data, subject));
  const pendingSummary = canonicalJsonSnapshot(pendingSummaryProjection(data.pendingSummary, subject));
  const pendingTotals = canonicalJsonSnapshot(pendingTotalsProjection(data.pendingTotals, subject));
  return Object.freeze({
    subjectIndex,
    subjectDigest: subjectDigest(subject),
    businessDigest: canonicalSha256({ plan, pendingSummary, pendingTotals }),
    resultRowCount: plan.rows.length + 1,
    pendingRowCount: Math.max(pendingSummary.length, pendingTotals.length, 1) + 1
  });
}

function readVccExportSnapshot(db, { runId, targetMonth = null } = {}) {
  const normalizedRunId = Number(runId);
  if (!Number.isSafeInteger(normalizedRunId) || normalizedRunId < 1) {
    throw authorityError('VCC_EXPORT_RUN_AUTHORITY_INVALID', 'VCC export runId 非法');
  }
  const data = loadEffectiveRunData(db, normalizedRunId);
  const month = String(targetMonth || data.run.targetMonth || '');
  if (data.run.targetMonth !== month) {
    throw authorityError('VCC_EXPORT_RUN_AUTHORITY_STALE', 'VCC export runId/month 不一致');
  }
  const evidenceSet = loadArchiveEvidenceSet(db, { targetMonth: month });
  if (evidenceSet.length !== 1) {
    throw authorityError('VCC_EXPORT_ARCHIVE_AUTHORITY_INVALID', 'VCC export archive evidence 不唯一');
  }
  const archiveEvidence = evidenceSet[0];
  const archiveContract = classifyArchiveContract(archiveEvidence);
  if (archiveContract.contract === ARCHIVE_CONTRACTS.INCONSISTENT ||
      Number(archiveContract.runId) !== normalizedRunId || data.run.status !== 'archived' ||
      data.run.archivedAt !== archiveContract.archivedAt ||
      data.run.resultRevision !== archiveContract.resultRevision ||
      JSON.stringify(data.subjects) !== JSON.stringify(archiveContract.subjects)) {
    throw authorityError(
      'VCC_EXPORT_ARCHIVE_AUTHORITY_STALE',
      'VCC export archive/run/subject authority 不一致'
    );
  }
  if (data.subjects.length < 1 || data.subjects.length > VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS) {
    throw authorityError('VCC_EXPORT_SUBJECT_COUNT_INVALID', 'VCC export 主体数量超出 1..64');
  }
  const subjects = Object.freeze(data.subjects.map((subject, index) => (
    subjectAuthority(data, subject, index)
  )));
  const authorityBody = Object.freeze({
    contractVersion: 1,
    runId: normalizedRunId,
    targetMonth: month,
    resultRevision: data.run.resultRevision,
    inputFingerprint: data.run.inputFingerprint,
    archiveStateDigest: canonicalSha256({ archiveEvidence, archiveContract }),
    subjects
  });
  const authority = Object.freeze({
    ...authorityBody,
    authorityDigest: canonicalSha256(authorityBody)
  });
  return Object.freeze({ authority, data });
}

function assertVccExportAuthorityEqual(expected, actual, code = 'VCC_EXPORT_AUTHORITY_STALE') {
  if (!expected || !actual || expected.authorityDigest !== actual.authorityDigest ||
      canonicalSha256(expected) !== canonicalSha256(actual)) {
    throw authorityError(code, 'VCC export run/revision/fingerprint/archive authority 已变化');
  }
  return actual;
}

module.exports = {
  assertVccExportAuthorityEqual,
  readVccExportSnapshot,
  subjectDigest
};
