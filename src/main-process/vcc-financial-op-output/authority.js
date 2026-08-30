'use strict';

const {
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
  isValidInputFingerprint
} = require('../../backend/vcc-financial-op/calculator');
const {
  buildSubjectRowPlan,
  loadEffectiveRunData
} = require('../vcc-financial-op-writer');
const {
  VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS
} = require('./policies');
const {
  buildVccSubjectAuthority,
  compareVccSubjects,
  subjectDigest
} = require('./subject-evidence');

function authorityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function subjectAuthority(data, subject, subjectIndex) {
  return buildVccSubjectAuthority({
    data,
    plan: buildSubjectRowPlan(data, subject),
    subject,
    subjectIndex
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

function assertVccExportWorkerSnapshotEqual(
  expected,
  actual,
  code = 'VCC_EXPORT_WORKER_AUTHORITY_STALE'
) {
  if (!expected || !actual || canonicalSha256(expected) !== canonicalSha256(actual)) {
    throw authorityError(code, 'VCC Worker scoped authority 已变化');
  }
  return actual;
}

function parseRunInputRevisions(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function readVccExportWorkerSnapshot(db, { expectedAuthority, subjectIndexes } = {}) {
  const authority = expectedAuthority;
  const indexes = Array.isArray(subjectIndexes) ? subjectIndexes.map(Number) : [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority) ||
      !Number.isSafeInteger(authority.runId) || authority.runId < 1 ||
      typeof authority.targetMonth !== 'string' || !authority.targetMonth ||
      !Number.isSafeInteger(authority.resultRevision) || authority.resultRevision < 0 ||
      !(authority.inputFingerprint === null ||
        isValidInputFingerprint(authority.inputFingerprint)) ||
      !Array.isArray(authority.subjects) || authority.subjects.length < 1 ||
      authority.subjects.length > VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS || indexes.length < 1 ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((index) => !Number.isSafeInteger(index) || index < 0 ||
        index >= authority.subjects.length)) {
    throw authorityError('VCC_EXPORT_WORKER_AUTHORITY_INVALID', 'VCC Worker scoped authority 非法');
  }

  const run = db.prepare(`
    SELECT id, target_month, status, input_revisions_json, result_revision,
           input_fingerprint, archived_at
    FROM vcc_fin_op_runs
    WHERE id = ?
  `).get(authority.runId);
  if (!run || run.target_month !== authority.targetMonth || run.status !== 'archived' ||
      Number(run.result_revision) !== authority.resultRevision ||
      run.input_fingerprint !== authority.inputFingerprint || !run.archived_at) {
    throw authorityError('VCC_EXPORT_WORKER_AUTHORITY_STALE', 'VCC Worker run authority 已变化');
  }

  const revisions = parseRunInputRevisions(run.input_revisions_json);
  const datasets = db.prepare(`
    SELECT dataset_type, data_status, archived_run_id, revision
    FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(authority.targetMonth);
  if (!revisions || Object.keys(revisions).sort().join(',') !==
        datasets.map((row) => String(row.dataset_type)).sort().join(',') ||
      datasets.some((row) => row.data_status !== 'archived' ||
        Number(row.archived_run_id) !== authority.runId ||
        !Number.isSafeInteger(revisions[row.dataset_type]) ||
        revisions[row.dataset_type] !== Number(row.revision))) {
    throw authorityError('VCC_EXPORT_WORKER_AUTHORITY_STALE', 'VCC Worker dataset authority 已变化');
  }

  const archives = db.prepare(`
    SELECT subject, run_id, archived_at
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    LIMIT 65
  `).all(authority.targetMonth).map((archive) => Object.freeze({
    subject: String(archive.subject),
    runId: Number(archive.run_id),
    archivedAt: archive.archived_at == null ? null : String(archive.archived_at)
  })).sort((left, right) => compareVccSubjects(left.subject, right.subject));
  if (archives.length !== authority.subjects.length ||
      archives.some((archive) => archive.runId !== authority.runId) ||
      new Set(archives.map((archive) => archive.subject)).size !== archives.length ||
      archives.some((archive, subjectIndex) => {
        const expected = authority.subjects[subjectIndex];
        return !expected || expected.subjectIndex !== subjectIndex ||
          typeof expected.subjectDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(expected.subjectDigest) ||
          subjectDigest(archive.subject) !== expected.subjectDigest;
      })) {
    throw authorityError('VCC_EXPORT_WORKER_AUTHORITY_STALE', 'VCC Worker archive subject authority 已变化');
  }
  const subjects = indexes.map((subjectIndex) => {
    return Object.freeze({ subjectIndex, subject: archives[subjectIndex].subject });
  });

  return Object.freeze({
    run: Object.freeze({
      runId: Number(run.id),
      targetMonth: String(run.target_month),
      resultRevision: Number(run.result_revision),
      inputFingerprint: run.input_fingerprint,
      archivedAt: String(run.archived_at)
    }),
    archiveMetadataDigest: canonicalSha256(archives),
    subjects: Object.freeze(subjects)
  });
}

module.exports = {
  assertVccExportAuthorityEqual,
  assertVccExportWorkerSnapshotEqual,
  readVccExportSnapshot,
  readVccExportWorkerSnapshot,
  subjectDigest
};
