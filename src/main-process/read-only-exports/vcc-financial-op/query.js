'use strict';

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { openVccReadDatabase } = require('../../../backend/vcc-financial-op/read-schema');
const repository = require('../../../backend/vcc-financial-op-db/repository');
const {
  exportInspectionEvidence,
  inspectDatasetExport
} = require('../../vcc-financial-op-dataset-writer');

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function nonNegativeRecordInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', `VCC 导入记录 ${label} 非法`);
  }
  return normalized;
}

function parseSourceFiles(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', 'VCC 导入记录 source_files_json 损坏');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', 'VCC 导入记录 source_files_json 结构非法');
  }
  return Object.freeze(parsed.slice());
}

function requireJsonArrayText(value, label) {
  const normalized = value === null || value === undefined || value === ''
    ? '[]'
    : String(value);
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (_error) {
    throw sourceError(
      'VCC_IMPORT_AUDIT_ROW_INVALID',
      `VCC 导入异常 ${label} JSON 损坏`
    );
  }
  if (!Array.isArray(parsed)) {
    throw sourceError(
      'VCC_IMPORT_AUDIT_ROW_INVALID',
      `VCC 导入异常 ${label} JSON 结构非法`
    );
  }
  return normalized;
}

function recordEnvelope(record) {
  const id = Number(record.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', 'VCC 导入记录 ID 非法');
  }
  const datasetDeletionId = record.dataset_deletion_id == null
    ? null
    : Number(record.dataset_deletion_id);
  if (datasetDeletionId !== null &&
      (!Number.isSafeInteger(datasetDeletionId) || datasetDeletionId < 1)) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', 'VCC 导入记录 deletion identity 非法');
  }
  return Object.freeze({
    id,
    batchId: text(record.batch_id),
    targetMonth: text(record.target_month),
    sourceType: text(record.source_type),
    sourceFiles: parseSourceFiles(record.source_files_json),
    status: text(record.status),
    rawCount: nonNegativeRecordInteger(record.raw_count, 'raw_count'),
    insertedCount: nonNegativeRecordInteger(record.inserted_count, 'inserted_count'),
    skippedCount: nonNegativeRecordInteger(record.skipped_count, 'skipped_count'),
    invalidKeyCount: nonNegativeRecordInteger(record.invalid_key_count, 'invalid_key_count'),
    conflictCount: nonNegativeRecordInteger(record.conflict_count, 'conflict_count'),
    formatErrorCount: nonNegativeRecordInteger(record.format_error_count, 'format_error_count'),
    rolledBackCount: nonNegativeRecordInteger(record.rolled_back_count, 'rolled_back_count'),
    startedAt: record.started_at || null,
    finishedAt: record.finished_at || null,
    errorMessage: record.error_message || null,
    resolutionStatus: text(record.resolution_status),
    resolvedAt: record.resolved_at || null,
    resolutionNote: record.resolution_note || null,
    resolutionAction: record.resolution_action || null,
    datasetDeletedAt: record.dataset_deleted_at || null,
    datasetDeletionId
  });
}

function anomalyEnvelope(row) {
  return Object.freeze({
    idempotencyKey: row.idempotency_key || null,
    sourceFileName: text(row.source_file_name),
    sourceRow: row.source_row == null ? null : Number(row.source_row),
    category: text(row.category),
    abnormalFieldsJson: requireJsonArrayText(row.abnormal_fields_json, 'abnormal_fields_json'),
    diffFieldsJson: requireJsonArrayText(row.diff_fields_json, 'diff_fields_json'),
    description: text(row.description)
  });
}

function readDatasetRevisionEnvelope(db, targetMonth, sourceType) {
  const row = db.prepare(`
    SELECT target_month, dataset_type, data_status, archived_run_id,
           revision, generated_at, updated_at
    FROM vcc_fin_op_datasets
    WHERE target_month = ? AND dataset_type = ?
  `).get(targetMonth, sourceType);
  if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) {
    throw sourceError(
      'VCC_DATASET_REVISION_NOT_STABLE',
      'VCC dataset 缺少稳定 revision，禁止导出'
    );
  }
  return Object.freeze({
    targetMonth: text(row.target_month),
    sourceType: text(row.dataset_type),
    dataStatus: text(row.data_status),
    archivedRunId: row.archived_run_id == null ? null : Number(row.archived_run_id),
    revision: Number(row.revision),
    generatedAt: row.generated_at || null,
    updatedAt: row.updated_at || null
  });
}

function readVccImportAuditSourceSnapshotFromDb(db, recordId) {
  const normalizedRecordId = Number(recordId);
  if (!Number.isSafeInteger(normalizedRecordId) || normalizedRecordId < 1) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_INVALID', 'VCC 导入审计记录 ID 非法');
  }
  const record = repository.getImportRecord(db, normalizedRecordId);
  if (!record) throw sourceError('VCC_IMPORT_AUDIT_RECORD_NOT_FOUND', 'VCC 导入审计记录不存在');
  if (record.status === 'importing' || !record.finished_at) {
    throw sourceError('VCC_IMPORT_AUDIT_RECORD_NOT_STABLE', 'VCC 导入记录尚未终态，禁止导出审计');
  }
  const anomalyCount = repository.countExportableImportAnomalies(db, normalizedRecordId);
  if (!Number.isSafeInteger(anomalyCount) || anomalyCount < 1) {
    throw sourceError('VCC_IMPORT_AUDIT_EMPTY', '当前导入记录没有可导出的异常明细');
  }
  const anomalies = [...repository.iterateExportableImportAnomalies(db, normalizedRecordId)]
    .map(anomalyEnvelope);
  if (anomalies.length !== anomalyCount) {
    throw sourceError('VCC_IMPORT_AUDIT_SOURCE_STALE', 'VCC 导入异常集合统计不一致');
  }
  const recordDigest = canonicalSha256(recordEnvelope(record));
  const anomalyDigest = canonicalSha256(Object.freeze(anomalies));
  const archiveSetDigest = canonicalSha256(Object.freeze([]));
  const sourceDigest = canonicalSha256(Object.freeze({
    variant: 'import-audit',
    recordId: normalizedRecordId,
    recordDigest,
    anomalyCount,
    anomalyDigest,
    archiveSetDigest
  }));
  return Object.freeze({
    context: Object.freeze({
      kind: 'vcc-import-audit',
      recordId: normalizedRecordId,
      targetMonth: null,
      sourceType: null,
      targetKind: null,
      expectedInspection: null,
      archiveSources: Object.freeze([])
    }),
    evidence: Object.freeze({
      contractVersion: 1,
      variant: 'import-audit',
      recordId: normalizedRecordId,
      recordDigest,
      anomalyCount,
      anomalyDigest,
      datasetRevisionDigest: null,
      inspectionDigest: null,
      archiveSetDigest,
      sourceDigest
    })
  });
}

function archiveSourceEnvelope(source) {
  return Object.freeze({
    sourceId: Number(source.sourceId),
    fileName: text(source.fileName),
    sha256: text(source.sha256).toLowerCase(),
    sizeBytes: Number(source.sizeBytes)
  });
}

function normalizeArchiveSources(archiveSources) {
  return Object.freeze((Array.isArray(archiveSources) ? archiveSources : [])
    .map((source) => Object.freeze({
      sourceId: Number(source.sourceId),
      filePath: text(source.filePath),
      fileName: text(source.fileName),
      sha256: text(source.sha256).toLowerCase(),
      sizeBytes: Number(source.sizeBytes)
    }))
    .sort((left, right) => left.sourceId - right.sourceId));
}

function readVccDatasetSourceSnapshotFromDb({
  db,
  targetMonth,
  sourceType,
  targetKind,
  archiveSources = []
}) {
  const inspection = inspectDatasetExport(db, targetMonth, sourceType, targetKind);
  if (!inspection.exportable) throw sourceError(inspection.code, inspection.message);
  const expectedInspection = exportInspectionEvidence(inspection);
  const normalizedArchiveSources = normalizeArchiveSources(archiveSources);
  const datasetRevisionDigest = canonicalSha256(readDatasetRevisionEnvelope(
    db,
    expectedInspection.targetMonth,
    expectedInspection.sourceType
  ));
  const inspectionDigest = canonicalSha256(expectedInspection);
  const archiveSetDigest = canonicalSha256(Object.freeze(
    normalizedArchiveSources.map(archiveSourceEnvelope)
  ));
  const sourceDigest = canonicalSha256(Object.freeze({
    variant: 'dataset',
    datasetRevisionDigest,
    inspectionDigest,
    archiveSetDigest
  }));
  return Object.freeze({
    context: Object.freeze({
      kind: 'vcc-dataset-export',
      recordId: null,
      targetMonth: expectedInspection.targetMonth,
      sourceType: expectedInspection.sourceType,
      targetKind: expectedInspection.targetKind,
      expectedInspection,
      archiveSources: normalizedArchiveSources
    }),
    evidence: Object.freeze({
      contractVersion: 1,
      variant: 'dataset',
      recordId: null,
      recordDigest: null,
      anomalyCount: null,
      anomalyDigest: null,
      datasetRevisionDigest,
      inspectionDigest,
      archiveSetDigest,
      sourceDigest
    })
  });
}

function evidenceMatches(current, expected) {
  return Boolean(current && current.evidence && expected) &&
    current.evidence.contractVersion === expected.contractVersion &&
    current.evidence.variant === expected.variant &&
    current.evidence.recordId === expected.recordId &&
    current.evidence.recordDigest === expected.recordDigest &&
    current.evidence.anomalyCount === expected.anomalyCount &&
    current.evidence.anomalyDigest === expected.anomalyDigest &&
    current.evidence.datasetRevisionDigest === expected.datasetRevisionDigest &&
    current.evidence.inspectionDigest === expected.inspectionDigest &&
    current.evidence.archiveSetDigest === expected.archiveSetDigest &&
    current.evidence.sourceDigest === expected.sourceDigest;
}

function assertVccFinancialOpSourceSnapshot(current, expected) {
  if (!evidenceMatches(current, expected)) {
    throw sourceError('VCC_FINANCIAL_OP_EXPORT_SOURCE_STALE', 'VCC Financial OP 导出来源已变化，请重新导出');
  }
  return current;
}

function freezeVccImportAuditSourceSnapshot(options) {
  return readVccImportAuditSourceSnapshotFromDb(options.db, options.recordId);
}

function freezeVccDatasetSourceSnapshot(options) {
  return readVccDatasetSourceSnapshotFromDb(options);
}

function openVccFinancialOpExportDatabase(source) {
  return openVccReadDatabase(source.mainDatabasePath);
}

async function withReadSnapshot(db, work) {
  db.exec('BEGIN');
  try {
    const result = await work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

module.exports = {
  anomalyEnvelope,
  assertVccFinancialOpSourceSnapshot,
  evidenceMatches,
  freezeVccDatasetSourceSnapshot,
  freezeVccImportAuditSourceSnapshot,
  normalizeArchiveSources,
  requireJsonArrayText,
  openVccFinancialOpExportDatabase,
  readDatasetRevisionEnvelope,
  readVccDatasetSourceSnapshotFromDb,
  readVccImportAuditSourceSnapshotFromDb,
  recordEnvelope,
  withReadSnapshot
};
