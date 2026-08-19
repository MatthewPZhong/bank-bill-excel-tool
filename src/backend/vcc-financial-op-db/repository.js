'use strict';

const {
  diagnoseFirstMonthFacts,
  readFirstMonthFacts
} = require('./state-model');

const IMPORT_ROW_INSERT_SQL = `
  INSERT INTO vcc_fin_op_import_rows (
    import_record_id, source_type, target_month,
    idempotency_key_raw, idempotency_key, content_hash, hash_version, raw_contract_version,
    subject, stat_currency, signed_amount,
    business_department, counterparty_department, business_sub_type,
    channel_name, mid, recon_type,
    pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
    source_file, sheet_name, source_row, raw_json,
    disposition, validation_field, validation_message
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`;

const STAGING_ROW_INSERT_SQL = `
  INSERT INTO vcc_fin_op_import_staging_rows (
    import_record_id, import_source_id, source_type, target_month,
    idempotency_key_raw, idempotency_key, content_hash, hash_version, raw_contract_version,
    subject, stat_currency, signed_amount,
    business_department, counterparty_department, business_sub_type,
    channel_name, mid, recon_type,
    pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
    source_file, sheet_name, source_row, raw_json,
    disposition, validation_field, validation_message
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`;

function createImportBatch(db, { id, targetMonth, fileCount }) {
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
    VALUES (?, ?, ?)
  `).run(id, targetMonth, fileCount);
  return id;
}

function finishImportBatch(db, batchId, status, errorMessage = null) {
  db.prepare(`
    UPDATE vcc_fin_op_import_batches
    SET status = ?, error_message = ?, finished_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(status, errorMessage, batchId);
}

function createImportRecord(db, { batchId, targetMonth, sourceType, sourceFiles }) {
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json
    ) VALUES (?, ?, ?, ?)
  `).run(batchId, targetMonth, sourceType, JSON.stringify(sourceFiles || []));
  return Number(result.lastInsertRowid);
}

function createImportSource(db, recordId, source) {
  const sha256 = String(source.sha256 || '').trim().toLowerCase();
  const sizeBytes = Number(source.sizeBytes);
  const ordinal = Number(source.sourceOrdinal);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('VCC 来源 SHA-256 非法');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('VCC 来源大小非法');
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new TypeError('VCC 来源序号非法');
  const archiveArtifactId = normalizedPositiveInteger(
    source.archiveArtifactId,
    'VCC 来源 artifact ID'
  );
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_import_sources (
      import_record_id, source_ordinal, source_file_name,
      source_sha256, source_size_bytes, archive_artifact_id,
      archive_state, bound_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', 'localtime') END)
  `).run(
    recordId,
    ordinal,
    String(source.fileName || ''),
    sha256,
    sizeBytes,
    archiveArtifactId,
    archiveArtifactId === null ? 'pending' : 'ready',
    archiveArtifactId
  );
  return Number(result.lastInsertRowid);
}

function listImportSources(db, recordId) {
  return db.prepare(`
    SELECT * FROM vcc_fin_op_import_sources
    WHERE import_record_id = ? ORDER BY source_ordinal, id
  `).all(recordId).map((row) => ({
    id: Number(row.id),
    importRecordId: Number(row.import_record_id),
    sourceOrdinal: Number(row.source_ordinal),
    fileName: row.source_file_name,
    sha256: row.source_sha256,
    sizeBytes: Number(row.source_size_bytes),
    archiveArtifactId: row.archive_artifact_id == null ? null : Number(row.archive_artifact_id),
    archiveState: row.archive_state,
    lastErrorCode: row.last_error_code || '',
    lastErrorMessage: row.last_error_message || '',
    boundAt: row.bound_at || null
  }));
}

function normalizedPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${fieldName} 非法`);
  }
  return normalized;
}

function resolveImportSourceForRecord(db, recordId, payload = {}) {
  const normalizedRecordId = normalizedPositiveInteger(recordId, 'VCC 导入记录 ID');
  const importSourceId = normalizedPositiveInteger(
    payload.importSourceId,
    'VCC 导入异常来源 ID'
  );
  const sourceOrdinal = normalizedPositiveInteger(
    payload.sourceOrdinal,
    'VCC 导入异常来源序号'
  );
  const fileName = String(payload.fileName || payload.sourceFile || '');
  let source = null;
  if (importSourceId !== null) {
    source = db.prepare(`
      SELECT * FROM vcc_fin_op_import_sources
      WHERE id = ? AND import_record_id = ?
    `).get(importSourceId, normalizedRecordId);
    if (!source) throw new Error('VCC 导入异常来源不属于目标导入记录');
  } else if (sourceOrdinal !== null) {
    source = db.prepare(`
      SELECT * FROM vcc_fin_op_import_sources
      WHERE import_record_id = ? AND source_ordinal = ?
    `).get(normalizedRecordId, sourceOrdinal);
    if (!source) throw new Error('VCC 导入异常来源序号不属于目标导入记录');
  } else if (fileName) {
    const matches = db.prepare(`
      SELECT * FROM vcc_fin_op_import_sources
      WHERE import_record_id = ? AND source_file_name = ?
      ORDER BY source_ordinal, id
    `).all(normalizedRecordId, fileName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? 'VCC 导入异常文件名不属于目标导入记录'
        : 'VCC 导入异常文件名在目标导入记录内不唯一');
    }
    source = matches[0];
  }
  if (sourceOrdinal !== null && source && Number(source.source_ordinal) !== sourceOrdinal) {
    throw new Error('VCC 导入异常来源 ID 与来源序号不一致');
  }
  if (fileName && source && source.source_file_name !== fileName) {
    throw new Error('VCC 导入异常来源 ID 与文件名不一致');
  }
  return source || null;
}

function refreshImportRecordArchiveState(db, recordId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN archive_state = 'ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN archive_state = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN archive_state = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_count
    FROM vcc_fin_op_import_sources
    WHERE import_record_id = ?
  `).get(recordId);
  const total = Number(row.total) || 0;
  let state = 'pending';
  if (total === 0) state = 'unavailable';
  else if (Number(row.ready_count) === total) state = 'ready';
  else if (Number(row.failed_count) > 0) state = 'failed';
  else if (Number(row.unavailable_count) === total) state = 'unavailable';
  db.prepare(`
    UPDATE vcc_fin_op_import_records SET archive_state = ? WHERE id = ?
  `).run(state, recordId);
  return state;
}

function finishImportRecord(db, recordId, result) {
  const status = String(result.status || '');
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET status = ?, raw_count = ?, inserted_count = ?, skipped_count = ?,
        invalid_key_count = ?, conflict_count = ?, format_error_count = ?,
        rolled_back_count = ?, anomaly_count = COALESCE(?, (
          SELECT COUNT(*) FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
        )), error_message = ?,
        resolution_status = 'not_applicable', resolved_at = NULL, resolution_note = NULL,
        resolution_action = NULL,
        finished_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    status,
    result.rawCount || 0,
    result.insertedCount || 0,
    result.skippedCount || 0,
    result.invalidKeyCount || 0,
    result.conflictCount || 0,
    result.formatErrorCount || 0,
    result.rolledBackCount || 0,
    result.anomalyCount === undefined ? null : Number(result.anomalyCount) || 0,
    recordId,
    result.errorMessage || null,
    recordId
  );
  if (status.startsWith('failed')) {
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_state = 'unavailable',
          updated_at = datetime('now', 'localtime')
      WHERE import_record_id = ? AND archive_state = 'pending'
    `).run(recordId);
    refreshImportRecordArchiveState(db, recordId);
  }
}

function persistStagingAnomalies(db, recordId) {
  db.prepare(`
    INSERT INTO vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id,
      source_type, target_month, idempotency_key,
      source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description,
      incoming_content_hash, existing_content_hash, diff_fields_json
    )
    SELECT
      staging.import_record_id,
      staging.import_source_id,
      staging.existing_effective_id,
      staging.source_type,
      staging.target_month,
      staging.idempotency_key,
      staging.source_file,
      staging.sheet_name,
      staging.source_row,
      staging.disposition,
      CASE
        WHEN COALESCE(staging.validation_field, '') = '' THEN '[]'
        ELSE json_array(staging.validation_field)
      END,
      COALESCE(staging.validation_message, '导入异常'),
      staging.content_hash,
      COALESCE(effective.content_hash, comparison.content_hash),
      COALESCE(staging.diff_fields_json, '[]')
    FROM vcc_fin_op_import_staging_rows staging
    LEFT JOIN vcc_fin_op_effective_rows effective ON effective.id = staging.existing_effective_id
    LEFT JOIN vcc_fin_op_import_staging_rows comparison
      ON comparison.id = staging.comparison_import_row_id
    WHERE staging.import_record_id = ?
      AND staging.disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
      AND NOT EXISTS (
        SELECT 1 FROM vcc_fin_op_import_anomalies anomaly
        WHERE anomaly.import_record_id = staging.import_record_id
          AND anomaly.import_source_id = staging.import_source_id
          AND anomaly.source_row = staging.source_row
          AND anomaly.category = staging.disposition
      )
  `).run(recordId);
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(recordId).count) || 0;
  db.prepare(`
    UPDATE vcc_fin_op_import_records SET anomaly_count = ? WHERE id = ?
  `).run(count, recordId);
  return count;
}

function addFileFailureAnomaly(db, recordId, payload = {}) {
  const record = getImportRecord(db, recordId);
  if (!record) throw new Error(`导入记录不存在：${recordId}`);
  const source = resolveImportSourceForRecord(db, recordId, payload);
  const existing = db.prepare(`
    SELECT 1 FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'file_failure'
    LIMIT 1
  `).get(recordId);
  if (!existing) {
    db.prepare(`
      INSERT INTO vcc_fin_op_import_anomalies (
        import_record_id, import_source_id, source_type, target_month,
        source_file_name, category, abnormal_fields_json, description,
        diff_fields_json
      ) VALUES (?, ?, ?, ?, ?, 'file_failure', '[]', ?, '[]')
    `).run(
      recordId,
      source ? Number(source.id) : null,
      record.source_type,
      record.target_month,
      String((source && source.source_file_name) || payload.fileName || payload.sourceFile || ''),
      String(payload.message || '导入文件处理失败')
    );
  }
  return persistStagingAnomalies(db, recordId);
}

const IMPORT_ANOMALY_CATEGORIES = new Set([
  'invalid_key',
  'format_error',
  'idempotent_conflict',
  'system_subject_error',
  'file_failure'
]);

function addImportAnomaly(db, recordId, payload = {}) {
  const record = getImportRecord(db, recordId);
  if (!record) throw new Error(`导入记录不存在：${recordId}`);
  const category = String(payload.category || 'format_error');
  if (!IMPORT_ANOMALY_CATEGORIES.has(category)) {
    throw new TypeError(`VCC 导入异常分类非法：${category}`);
  }
  const importSourceId = payload.importSourceId == null
    ? null
    : Number(payload.importSourceId);
  if (importSourceId !== null && !Number.isSafeInteger(importSourceId)) {
    throw new TypeError('VCC 导入异常来源 ID 非法');
  }
  const source = importSourceId === null
    ? null
    : resolveImportSourceForRecord(db, recordId, payload);
  const abnormalFields = Array.isArray(payload.abnormalFields)
    ? payload.abnormalFields.map((value) => String(value)).filter(Boolean)
    : [];
  const diffFields = Array.isArray(payload.diffFields)
    ? payload.diffFields.map((value) => String(value)).filter(Boolean)
    : [];
  db.prepare(`
    INSERT INTO vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id,
      source_type, target_month, idempotency_key,
      source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description,
      incoming_content_hash, existing_content_hash, diff_fields_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordId,
    importSourceId,
    payload.effectiveRowId == null ? null : Number(payload.effectiveRowId),
    record.source_type,
    record.target_month,
    payload.idempotencyKey == null ? null : String(payload.idempotencyKey),
    String((source && source.source_file_name) || payload.sourceFile || ''),
    payload.sheetName == null ? null : String(payload.sheetName),
    payload.sourceRow == null ? null : Number(payload.sourceRow),
    category,
    JSON.stringify(abnormalFields),
    String(payload.description || '导入异常'),
    payload.incomingContentHash == null ? null : String(payload.incomingContentHash),
    payload.existingContentHash == null ? null : String(payload.existingContentHash),
    JSON.stringify(diffFields)
  );
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(recordId).count) || 0;
  db.prepare(`
    UPDATE vcc_fin_op_import_records SET anomaly_count = ? WHERE id = ?
  `).run(count, recordId);
  return count;
}

function clearImportStagingRows(db, recordId) {
  return Number(db.prepare(`
    DELETE FROM vcc_fin_op_import_staging_rows WHERE import_record_id = ?
  `).run(recordId).changes) || 0;
}

function addImportError(db, recordId, error) {
  db.prepare(`
    INSERT INTO vcc_fin_op_import_errors (
      import_record_id, source_file, sheet_name, source_row,
      field_name, error_code, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordId,
    error.sourceFile || null,
    error.sheetName || null,
    error.sourceRow || null,
    error.fieldName || null,
    error.errorCode || 'import-error',
    error.message || '导入失败'
  );
}

function getImportRecord(db, recordId) {
  return db.prepare('SELECT * FROM vcc_fin_op_import_records WHERE id = ?').get(recordId) || null;
}

function getImportBatch(db, batchId) {
  return db.prepare('SELECT * FROM vcc_fin_op_import_batches WHERE id = ?').get(batchId) || null;
}

function listImportRecordsByBatch(db, batchId) {
  return db.prepare(`
    SELECT *
    FROM vcc_fin_op_import_records
    WHERE batch_id = ?
    ORDER BY id
  `).all(batchId);
}

function listImportMonths(db) {
  return db.prepare(`
    SELECT target_month AS yearMonth, MAX(started_at) AS latestImportedAt
    FROM vcc_fin_op_import_records
    GROUP BY target_month
    ORDER BY target_month DESC
  `).all();
}

function listImportRecords(db, yearMonth) {
  return db.prepare(`
    SELECT r.*, b.file_count AS batch_file_count
    FROM vcc_fin_op_import_records r
    JOIN vcc_fin_op_import_batches b ON b.id = r.batch_id
    WHERE r.target_month = ?
    ORDER BY r.started_at DESC, r.id DESC
  `).all(yearMonth);
}

const LEGACY_ERROR_CATEGORY_SQL = `
  CASE
    WHEN record.source_type = 'system_op'
      AND (lower(COALESCE(import_error.error_code, '')) LIKE '%subject%'
        OR COALESCE(import_error.field_name, '') IN ('公司主体', '主体', 'subject'))
      THEN 'system_subject_error'
    WHEN import_error.source_row IS NULL AND import_error.field_name IS NULL
      THEN 'file_failure'
    ELSE 'format_error'
  END
`;

const LEGACY_ERROR_NOT_IN_ROWS_SQL = `
  NOT EXISTS (
    SELECT 1
    FROM vcc_fin_op_import_rows AS legacy_row
    WHERE legacy_row.import_record_id = import_error.import_record_id
      AND legacy_row.disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
      AND COALESCE(legacy_row.source_row, -1) = COALESCE(import_error.source_row, -1)
      AND COALESCE(
        NULLIF(legacy_row.validation_message, ''),
        CASE legacy_row.disposition
          WHEN 'invalid_key' THEN '幂等键缺失或无效'
          WHEN 'format_error' THEN '原表字段格式错误'
          ELSE '相同幂等键对应内容不一致'
        END
      ) = import_error.message
  )
`;

function compactImportAnomalyCount(db, recordId) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(recordId).count) || 0;
}

function countExportableImportAnomalies(db, recordId) {
  const normalizedRecordId = Number(recordId);
  const compactCount = compactImportAnomalyCount(db, normalizedRecordId);
  if (compactCount > 0) return compactCount;

  const legacyRowCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ?
      AND disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
  `).get(normalizedRecordId).count) || 0;
  const legacyErrors = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN category = 'file_failure' THEN 1 ELSE 0 END), 0)
             AS file_failure_count
    FROM (
      SELECT ${LEGACY_ERROR_CATEGORY_SQL} AS category
      FROM vcc_fin_op_import_errors AS import_error
      JOIN vcc_fin_op_import_records AS record ON record.id = import_error.import_record_id
      WHERE import_error.import_record_id = ?
        AND ${LEGACY_ERROR_NOT_IN_ROWS_SQL}
    )
  `).get(normalizedRecordId);
  const record = getImportRecord(db, normalizedRecordId);
  const syntheticFileFailure = record
    && String(record.status || '').startsWith('failed')
    && Number(legacyErrors.file_failure_count) === 0
    ? 1
    : 0;
  return legacyRowCount + (Number(legacyErrors.count) || 0) + syntheticFileFailure;
}

function* iterateExportableImportAnomalies(db, recordId) {
  const normalizedRecordId = Number(recordId);
  if (compactImportAnomalyCount(db, normalizedRecordId) > 0) {
    yield* db.prepare(`
      SELECT idempotency_key, source_file_name, source_row, category,
             abnormal_fields_json, diff_fields_json, description
      FROM vcc_fin_op_import_anomalies
      WHERE import_record_id = ?
      ORDER BY id
    `).iterate(normalizedRecordId);
    return;
  }

  yield* db.prepare(`
    SELECT idempotency_key,
           COALESCE(source_file, '') AS source_file_name,
           source_row,
           disposition AS category,
           CASE WHEN validation_field IS NULL OR validation_field = ''
                THEN '[]' ELSE json_array(validation_field) END AS abnormal_fields_json,
           COALESCE(NULLIF(diff_fields_json, ''), '[]') AS diff_fields_json,
           COALESCE(
             NULLIF(validation_message, ''),
             CASE disposition
               WHEN 'invalid_key' THEN '幂等键缺失或无效'
               WHEN 'format_error' THEN '原表字段格式错误'
               ELSE '相同幂等键对应内容不一致'
             END
           ) AS description
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ?
      AND disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
    ORDER BY id
  `).iterate(normalizedRecordId);

  let hasFileFailure = false;
  for (const row of db.prepare(`
    SELECT NULL AS idempotency_key,
           COALESCE(import_error.source_file, '') AS source_file_name,
           import_error.source_row AS source_row,
           ${LEGACY_ERROR_CATEGORY_SQL} AS category,
           CASE WHEN import_error.field_name IS NULL OR import_error.field_name = ''
                THEN '[]' ELSE json_array(import_error.field_name) END AS abnormal_fields_json,
           '[]' AS diff_fields_json,
           import_error.message AS description
    FROM vcc_fin_op_import_errors AS import_error
    JOIN vcc_fin_op_import_records AS record ON record.id = import_error.import_record_id
    WHERE import_error.import_record_id = ?
      AND ${LEGACY_ERROR_NOT_IN_ROWS_SQL}
    ORDER BY import_error.id
  `).iterate(normalizedRecordId)) {
    if (row.category === 'file_failure') hasFileFailure = true;
    yield row;
  }

  const record = getImportRecord(db, normalizedRecordId);
  if (record && String(record.status || '').startsWith('failed') && !hasFileFailure) {
    let sourceFiles = [];
    try { sourceFiles = JSON.parse(record.source_files_json || '[]'); } catch (_error) {}
    yield {
      idempotency_key: null,
      source_file_name: Array.isArray(sourceFiles) ? String(sourceFiles[0] || '') : '',
      source_row: null,
      category: 'file_failure',
      abnormal_fields_json: '[]',
      diff_fields_json: '[]',
      description: record.error_message || '导入事务失败并已回滚'
    };
  }
}

function countImportRowsByDisposition(db, recordId) {
  const rows = db.prepare(`
    SELECT disposition, COUNT(*) AS row_count
    FROM vcc_fin_op_import_staging_rows
    WHERE import_record_id = ?
    GROUP BY disposition
  `).all(recordId);
  return Object.fromEntries(rows.map((row) => [row.disposition || 'pending', Number(row.row_count) || 0]));
}

function countLegacyImportRowsByDisposition(db, recordId) {
  const rows = db.prepare(`
    SELECT disposition, COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ?
    GROUP BY disposition
  `).all(recordId);
  return Object.fromEntries(rows.map((row) => [row.disposition || 'pending', Number(row.row_count) || 0]));
}

function persistLegacyImportAnomalies(db, recordId) {
  db.prepare(`
    INSERT INTO vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id,
      source_type, target_month, idempotency_key,
      source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description,
      incoming_content_hash, existing_content_hash, diff_fields_json
    )
    SELECT
      legacy.import_record_id,
      NULL,
      legacy.existing_effective_id,
      legacy.source_type,
      legacy.target_month,
      legacy.idempotency_key,
      COALESCE(legacy.source_file, ''),
      legacy.sheet_name,
      legacy.source_row,
      legacy.disposition,
      CASE
        WHEN COALESCE(legacy.validation_field, '') = '' THEN '[]'
        ELSE json_array(legacy.validation_field)
      END,
      COALESCE(
        NULLIF(legacy.validation_message, ''),
        CASE legacy.disposition
          WHEN 'invalid_key' THEN '幂等键缺失或无效'
          WHEN 'format_error' THEN '原表字段格式错误'
          ELSE '相同幂等键对应内容不一致'
        END
      ),
      legacy.content_hash,
      COALESCE(effective.content_hash, comparison.content_hash),
      COALESCE(NULLIF(legacy.diff_fields_json, ''), '[]')
    FROM vcc_fin_op_import_rows AS legacy
    LEFT JOIN vcc_fin_op_effective_rows AS effective
      ON effective.id = legacy.existing_effective_id
    LEFT JOIN vcc_fin_op_import_rows AS comparison
      ON comparison.id = legacy.comparison_import_row_id
    WHERE legacy.import_record_id = ?
      AND legacy.disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
      AND NOT EXISTS (
        SELECT 1 FROM vcc_fin_op_import_anomalies AS anomaly
        WHERE anomaly.import_record_id = legacy.import_record_id
          AND anomaly.source_file_name = COALESCE(legacy.source_file, '')
          AND COALESCE(anomaly.source_row, -1) = COALESCE(legacy.source_row, -1)
          AND anomaly.category = legacy.disposition
      )
    ORDER BY legacy.id
  `).run(recordId);

  for (const error of db.prepare(`
    SELECT import_error.source_file, import_error.sheet_name, import_error.source_row,
           import_error.field_name, import_error.error_code, import_error.message,
           ${LEGACY_ERROR_CATEGORY_SQL} AS category
    FROM vcc_fin_op_import_errors AS import_error
    JOIN vcc_fin_op_import_records AS record ON record.id = import_error.import_record_id
    WHERE import_error.import_record_id = ?
      AND ${LEGACY_ERROR_NOT_IN_ROWS_SQL}
    ORDER BY import_error.id
  `).all(recordId)) {
    const category = error.category;
    const duplicate = db.prepare(`
      SELECT 1 FROM vcc_fin_op_import_anomalies
      WHERE import_record_id = ?
        AND source_file_name = ?
        AND COALESCE(source_row, -1) = COALESCE(?, -1)
        AND category = ?
        AND description = ?
      LIMIT 1
    `).get(recordId, String(error.source_file || ''), error.source_row, category, error.message);
    if (duplicate) continue;
    addImportAnomaly(db, recordId, {
      category,
      sourceFile: error.source_file || '',
      sheetName: error.sheet_name,
      sourceRow: error.source_row,
      abnormalFields: error.field_name ? [error.field_name] : [],
      description: error.message
    });
  }
  return compactImportAnomalyCount(db, recordId);
}

function finalizeImportingRecords(db, records, {
  rowMessage,
  recordMessage,
  auditMessage
}) {
  const markRows = db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows
    SET disposition = 'rolled_back',
        validation_message = COALESCE(validation_message, ?)
    WHERE import_record_id = ? AND disposition IS NULL
  `);
  for (const record of records) {
    markRows.run(rowMessage, record.id);
    db.prepare(`
      UPDATE vcc_fin_op_import_rows
      SET disposition = 'rolled_back',
          validation_message = COALESCE(validation_message, ?)
      WHERE import_record_id = ? AND disposition IS NULL
    `).run(rowMessage, record.id);
    const stagingCounts = countImportRowsByDisposition(db, record.id);
    const legacyCounts = countLegacyImportRowsByDisposition(db, record.id);
    const counts = {};
    for (const disposition of [
      'accepted', 'idempotent_skip', 'invalid_key', 'idempotent_conflict',
      'format_error', 'rolled_back'
    ]) {
      counts[disposition] = (stagingCounts[disposition] || 0) + (legacyCounts[disposition] || 0);
    }
    if (counts.accepted > 0) {
      throw new Error(`导入记录 ${record.id} 含未完成但已 accepted 的 legacy 宽行，禁止猜测恢复`);
    }
    const rawCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
    persistStagingAnomalies(db, record.id);
    persistLegacyImportAnomalies(db, record.id);
    finishImportRecord(db, record.id, {
      status: counts.idempotent_conflict > 0 ? 'failed_conflict' : 'failed_validation',
      rawCount,
      skippedCount: counts.idempotent_skip || 0,
      invalidKeyCount: counts.invalid_key || 0,
      conflictCount: counts.idempotent_conflict || 0,
      formatErrorCount: counts.format_error || 0,
      rolledBackCount: counts.rolled_back || 0,
      errorMessage: recordMessage
    });
    const failurePayload = record.failureSource || {};
    addFileFailureAnomaly(db, record.id, { ...failurePayload, message: auditMessage });
    clearImportStagingRows(db, record.id);
    db.prepare(`DELETE FROM vcc_fin_op_import_rows WHERE import_record_id = ?`).run(record.id);
  }
}

function resolveBatchFailureSource(db, batchId, payload) {
  const importSourceId = normalizedPositiveInteger(
    payload.importSourceId,
    'VCC 导入异常来源 ID'
  );
  const sourceOrdinal = normalizedPositiveInteger(
    payload.sourceOrdinal,
    'VCC 导入异常来源序号'
  );
  const fileName = String(payload.fileName || payload.sourceFile || '');
  if (importSourceId === null && sourceOrdinal === null && !fileName) return null;
  const matches = db.prepare(`
    SELECT source.*, record.batch_id
    FROM vcc_fin_op_import_sources AS source
    JOIN vcc_fin_op_import_records AS record ON record.id = source.import_record_id
    WHERE record.batch_id = ?
      AND (? IS NULL OR source.id = ?)
      AND (? IS NULL OR source.source_ordinal = ?)
      AND (? = '' OR source.source_file_name = ?)
    ORDER BY source.id
  `).all(
    batchId,
    importSourceId, importSourceId,
    sourceOrdinal, sourceOrdinal,
    fileName, fileName
  );
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'VCC 导入异常来源不属于目标导入批次'
      : 'VCC 导入异常来源在目标导入批次内不唯一');
  }
  const source = matches[0];
  if (sourceOrdinal !== null && Number(source.source_ordinal) !== sourceOrdinal) {
    throw new Error('VCC 导入异常来源 ID 与来源序号不一致');
  }
  if (fileName && source.source_file_name !== fileName) {
    throw new Error('VCC 导入异常来源 ID 与文件名不一致');
  }
  return source;
}

function failImportBatch(db, batchId, {
  message = '导入运行异常，导入事务未完成',
  importSourceId,
  sourceOrdinal,
  fileName,
  sourceFile
} = {}) {
  const normalizedMessage = String(message || '导入运行异常，导入事务未完成');
  db.exec('BEGIN IMMEDIATE');
  try {
    const failureSource = resolveBatchFailureSource(db, batchId, {
      importSourceId,
      sourceOrdinal,
      fileName,
      sourceFile
    });
    const records = db.prepare(`
      SELECT id
      FROM vcc_fin_op_import_records
      WHERE batch_id = ? AND status = 'importing'
    `).all(batchId).map((record) => ({
      ...record,
      failureSource: failureSource && Number(failureSource.import_record_id) === Number(record.id)
        ? {
            importSourceId: Number(failureSource.id),
            sourceOrdinal: Number(failureSource.source_ordinal),
            fileName: failureSource.source_file_name
          }
        : null
    }));
    finalizeImportingRecords(db, records, {
      rowMessage: '导入运行异常，整表未导入',
      recordMessage: normalizedMessage,
      auditMessage: `${normalizedMessage}；已确认暂存行没有进入有效数据集`
    });
    db.prepare(`
      UPDATE vcc_fin_op_import_batches
      SET status = 'failed', error_message = ?, finished_at = datetime('now', 'localtime')
      WHERE id = ? AND status = 'importing'
    `).run(normalizedMessage, batchId);
    db.exec('COMMIT');
    return records.length;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function recoverInterruptedImports(db) {
  const records = db.prepare(`
    SELECT id FROM vcc_fin_op_import_records WHERE status = 'importing'
  `).all();
  const batchCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_batches WHERE status = 'importing'
  `).get().row_count) || 0;
  if (records.length === 0 && batchCount === 0) return 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    finalizeImportingRecords(db, records, {
      rowMessage: '应用异常退出，导入未完成',
      recordMessage: '应用异常退出，导入事务未完成',
      auditMessage: '检测到未完成的导入记录，已确认没有数据进入有效数据集'
    });
    db.prepare(`
      UPDATE vcc_fin_op_import_batches
      SET status = 'failed', error_message = '应用异常退出，导入未完成',
          finished_at = datetime('now', 'localtime')
      WHERE status = 'importing'
    `).run();
    db.exec('COMMIT');
    return records.length;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function getVccFinancialOpModuleState(db) {
  const facts = readFirstMonthFacts(db);
  const diagnostic = diagnoseFirstMonthFacts(facts);
  return {
    firstMonth: facts.firstMonth,
    openingMonths: facts.openingMonths,
    migrationDiagnostic: diagnostic.blocked ? diagnostic : null
  };
}

function claimVccFinancialOpFirstMonth(db, targetMonth) {
  const before = getVccFinancialOpModuleState(db);
  if (before.migrationDiagnostic) {
    return { claimed: false, firstMonth: before.firstMonth, diagnostic: before.migrationDiagnostic };
  }
  if (before.firstMonth !== null) {
    return {
      claimed: false,
      firstMonth: before.firstMonth,
      conflict: before.firstMonth !== targetMonth
    };
  }
  const result = db.prepare(`
    UPDATE vcc_fin_op_module_state
    SET first_month = ?, updated_at = datetime('now', 'localtime')
    WHERE singleton_id = 1 AND first_month IS NULL
  `).run(targetMonth);
  const after = getVccFinancialOpModuleState(db);
  return {
    claimed: Number(result.changes) === 1,
    firstMonth: after.firstMonth,
    conflict: after.firstMonth !== targetMonth,
    diagnostic: after.migrationDiagnostic
  };
}

module.exports = {
  IMPORT_ROW_INSERT_SQL,
  STAGING_ROW_INSERT_SQL,
  createImportBatch,
  finishImportBatch,
  createImportRecord,
  createImportSource,
  finishImportRecord,
  persistStagingAnomalies,
  addFileFailureAnomaly,
  addImportAnomaly,
  clearImportStagingRows,
  addImportError,
  getImportBatch,
  getImportRecord,
  listImportRecordsByBatch,
  listImportSources,
  listImportMonths,
  listImportRecords,
  countExportableImportAnomalies,
  iterateExportableImportAnomalies,
  countImportRowsByDisposition,
  failImportBatch,
  recoverInterruptedImports,
  refreshImportRecordArchiveState,
  getVccFinancialOpModuleState,
  claimVccFinancialOpFirstMonth
};
