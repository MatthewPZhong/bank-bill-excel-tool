'use strict';

const crypto = require('node:crypto');
const { SOURCE_TYPES } = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');

const OPERATION_TOKEN_VERSION = 1;
const STATE_CHANGED_CODE = 'state-changed';
const STATE_CHANGED_MESSAGE = '数据状态已变化，请刷新并重新确认。';
const SOURCE_TYPE_ORDER = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING,
  SOURCE_TYPES.SYSTEM_OP
]);

function operationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeOperationMonth(targetMonth) {
  const normalized = normalizeYearMonth(targetMonth);
  if (!normalized || normalized !== targetMonth) {
    throw operationError('invalid-month', `月份账期格式无效：${targetMonth || ''}`);
  }
  return normalized;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fingerprintScalar(value) {
  if (value === null) return { type: 'null', value: null };
  if (Buffer.isBuffer(value)) return { type: 'blob', value: value.toString('base64') };
  if (typeof value === 'number') {
    return { type: 'number', value: Number.isFinite(value) ? String(value) : `non-finite:${value}` };
  }
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (typeof value === 'boolean') return { type: 'boolean', value: value ? '1' : '0' };
  return { type: typeof value, value: String(value) };
}

function appendFingerprintFrame(hash, frame) {
  const encoded = stableStringify(frame);
  hash.update(String(Buffer.byteLength(encoded, 'utf8')), 'utf8');
  hash.update(':', 'utf8');
  hash.update(encoded, 'utf8');
}

function fingerprintQuery(db, {
  tableName,
  sql,
  params = [],
  normalizeRow = null
}) {
  const logicalTable = String(tableName || '');
  const hash = crypto.createHash('sha256');
  appendFingerprintFrame(hash, { version: 1, table: logicalTable });
  let count = 0;
  for (const sourceRow of db.prepare(sql).iterate(...params)) {
    const row = normalizeRow ? normalizeRow(sourceRow) : sourceRow;
    const columns = Object.keys(row).sort().map((column) => ({
      name: column,
      ...fingerprintScalar(row[column])
    }));
    appendFingerprintFrame(hash, {
      table: logicalTable,
      row: count,
      columns
    });
    count += 1;
  }
  appendFingerprintFrame(hash, { table: logicalTable, rowCount: count });
  return {
    table: logicalTable,
    count,
    contentHash: hash.digest('hex')
  };
}

function countRows(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(row && row.row_count) || 0;
}

function snapshotRuns(db, targetMonth) {
  return db.prepare(`
    SELECT id, target_month, status, result_revision, input_fingerprint,
           input_revisions_json, created_at, updated_at, archived_at
    FROM vcc_fin_op_runs
    WHERE target_month = ?
    ORDER BY id
  `).all(targetMonth).map((row) => ({
    id: Number(row.id),
    targetMonth: row.target_month,
    status: row.status,
    resultRevision: Number(row.result_revision) || 0,
    inputFingerprint: row.input_fingerprint || null,
    inputRevisionsJson: row.input_revisions_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }));
}

function snapshotLaterRuns(db, targetMonth) {
  return db.prepare(`
    SELECT id, target_month, status, result_revision, input_fingerprint,
           input_revisions_json, created_at, updated_at, archived_at
    FROM vcc_fin_op_runs
    WHERE target_month > ? AND status IN ('archived', 'calculated')
    ORDER BY target_month, id
  `).all(targetMonth).map((row) => ({
    id: Number(row.id),
    targetMonth: row.target_month,
    status: row.status,
    resultRevision: Number(row.result_revision) || 0,
    inputFingerprint: row.input_fingerprint || null,
    inputRevisionsJson: row.input_revisions_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }));
}

function snapshotLaterDependencyMonths(db, targetMonth) {
  return db.prepare(`
    SELECT target_month
    FROM vcc_fin_op_runs
    WHERE target_month > ? AND status IN ('archived', 'calculated')
    UNION
    SELECT target_month
    FROM vcc_fin_op_archives
    WHERE target_month > ?
    UNION
    SELECT target_month
    FROM vcc_fin_op_datasets
    WHERE target_month > ? AND data_status = 'archived'
    ORDER BY target_month
  `).all(targetMonth, targetMonth, targetMonth)
    .map((row) => String(row.target_month));
}

function snapshotArchives(db, targetMonth) {
  return db.prepare(`
    SELECT target_month, subject, balances_json, run_id, archived_at
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    ORDER BY subject
  `).all(targetMonth).map((row) => ({
    targetMonth: row.target_month,
    subject: row.subject,
    runId: Number(row.run_id),
    archivedAt: row.archived_at,
    balancesHash: sha256(row.balances_json),
    balancesJson: row.balances_json
  }));
}

function snapshotDatasets(db, targetMonth) {
  return db.prepare(`
    SELECT target_month, dataset_type, data_status, archived_run_id,
           revision, generated_at, updated_at
    FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(targetMonth).map((row) => ({
    targetMonth: row.target_month,
    datasetType: row.dataset_type,
    dataStatus: row.data_status,
    archivedRunId: row.archived_run_id === null ? null : Number(row.archived_run_id),
    revision: Number(row.revision) || 1,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at
  }));
}

function snapshotOpening(db, targetMonth) {
  const rows = db.prepare(`
    SELECT target_month, subject, balances_json, content_hash,
           initialization_note, initialized_at
    FROM vcc_fin_op_opening_balances
    WHERE target_month = ?
    ORDER BY subject
  `).all(targetMonth).map((row) => ({
    targetMonth: row.target_month,
    subject: row.subject,
    contentHash: row.content_hash,
    balancesHash: sha256(row.balances_json),
    initializationNote: row.initialization_note,
    initializedAt: row.initialized_at
  }));
  return {
    count: rows.length,
    contentHash: sha256(stableStringify(rows)),
    rows
  };
}

function snapshotSourceFacts(db, targetMonth) {
  const effectiveCounts = Object.fromEntries(SOURCE_TYPE_ORDER.map((sourceType) => [sourceType, 0]));
  for (const row of db.prepare(`
    SELECT source_type, COUNT(*) AS row_count
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ?
    GROUP BY source_type
    ORDER BY source_type
  `).all(targetMonth)) {
    effectiveCounts[row.source_type] = Number(row.row_count) || 0;
  }
  effectiveCounts[SOURCE_TYPES.SYSTEM_OP] = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
  `, targetMonth);

  const importRows = db.prepare(`
    SELECT source_type, COALESCE(disposition, 'pending') AS disposition,
           COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE target_month = ?
    GROUP BY source_type, COALESCE(disposition, 'pending')
    ORDER BY source_type, disposition
  `).all(targetMonth).map((row) => ({
    sourceType: row.source_type,
    disposition: row.disposition,
    count: Number(row.row_count) || 0
  }));
  const importRecords = db.prepare(`
    SELECT source_type, status, resolution_status, COUNT(*) AS row_count
    FROM vcc_fin_op_import_records
    WHERE target_month = ?
    GROUP BY source_type, status, resolution_status
    ORDER BY source_type, status, resolution_status
  `).all(targetMonth).map((row) => ({
    sourceType: row.source_type,
    status: row.status,
    resolutionStatus: row.resolution_status,
    count: Number(row.row_count) || 0
  }));
  const systemAttempts = db.prepare(`
    SELECT disposition, COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE target_month = ?
    GROUP BY disposition
    ORDER BY disposition
  `).all(targetMonth).map((row) => ({
    disposition: row.disposition,
    count: Number(row.row_count) || 0
  }));
  return {
    effectiveCounts,
    importRows,
    importRecords,
    systemAttempts,
    importErrorCount: countRows(db, `
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_import_errors error
      JOIN vcc_fin_op_import_records record ON record.id = error.import_record_id
      WHERE record.target_month = ?
    `, targetMonth),
    unresolvedImportCount: countRows(db, `
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_import_records
      WHERE target_month = ? AND resolution_status = 'unresolved'
    `, targetMonth),
    activeImportBatchCount: countRows(db, `
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_import_batches
      WHERE target_month = ? AND status = 'importing'
    `, targetMonth)
  };
}

function buildOperationState(db, {
  action,
  targetMonth,
  taskGeneration = 0,
  scope = null,
  includeLaterRuns = false
}) {
  const month = normalizeOperationMonth(targetMonth);
  const generation = Number(taskGeneration);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw operationError('invalid-task-generation', 'VCC 财务OP任务代次无效');
  }
  return {
    tokenVersion: OPERATION_TOKEN_VERSION,
    action: String(action || ''),
    targetMonth: month,
    scope,
    taskGeneration: generation,
    runs: snapshotRuns(db, month),
    laterRuns: includeLaterRuns ? snapshotLaterRuns(db, month) : [],
    laterDependencyMonths: includeLaterRuns ? snapshotLaterDependencyMonths(db, month) : [],
    archives: snapshotArchives(db, month),
    datasets: snapshotDatasets(db, month),
    opening: snapshotOpening(db, month),
    sourceFacts: snapshotSourceFacts(db, month)
  };
}

function operationPreviewToken(state) {
  return `v${OPERATION_TOKEN_VERSION}:${sha256(stableStringify(state))}`;
}

function assertPreviewToken(expectedToken, actualToken) {
  const expected = String(expectedToken || '');
  if (!expected || expected !== actualToken) {
    throw operationError(
      STATE_CHANGED_CODE,
      STATE_CHANGED_MESSAGE,
      {
        expectedPreviewToken: expected || null,
        actualPreviewToken: actualToken,
        context: {
          expectedPreviewToken: expected || null,
          actualPreviewToken: actualToken
        }
      }
    );
  }
}

function validateOperationConfirmation(expectedPreviewToken, taskGeneration) {
  if (typeof expectedPreviewToken !== 'string' || expectedPreviewToken.trim() === '') {
    throw operationError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
      expectedPreviewToken: null,
      context: { expectedPreviewToken: null }
    });
  }
  if (
    taskGeneration === undefined
    || taskGeneration === null
    || (typeof taskGeneration === 'string' && taskGeneration.trim() === '')
    || !Number.isSafeInteger(Number(taskGeneration))
    || Number(taskGeneration) < 0
  ) {
    throw operationError('invalid-task-generation', 'VCC 财务OP任务代次无效');
  }
  return Number(taskGeneration);
}

module.exports = {
  OPERATION_TOKEN_VERSION,
  STATE_CHANGED_CODE,
  STATE_CHANGED_MESSAGE,
  SOURCE_TYPE_ORDER,
  operationError,
  normalizeOperationMonth,
  stableStringify,
  sha256,
  fingerprintQuery,
  countRows,
  snapshotRuns,
  snapshotLaterRuns,
  snapshotLaterDependencyMonths,
  snapshotArchives,
  snapshotDatasets,
  snapshotOpening,
  snapshotSourceFacts,
  buildOperationState,
  operationPreviewToken,
  assertPreviewToken,
  validateOperationConfirmation
};
