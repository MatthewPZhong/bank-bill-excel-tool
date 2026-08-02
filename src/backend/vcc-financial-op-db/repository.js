'use strict';

const IMPORT_ROW_INSERT_SQL = `
  INSERT INTO vcc_fin_op_import_rows (
    import_record_id, source_type, target_month,
    idempotency_key_raw, idempotency_key, content_hash, hash_version,
    subject, stat_currency, signed_amount,
    business_department, counterparty_department, business_sub_type,
    channel_name, mid, recon_type,
    pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
    source_file, sheet_name, source_row, raw_json,
    disposition, validation_field, validation_message
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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

function finishImportRecord(db, recordId, result) {
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET status = ?, raw_count = ?, inserted_count = ?, skipped_count = ?,
        invalid_key_count = ?, conflict_count = ?, format_error_count = ?,
        rolled_back_count = ?, error_message = ?,
        resolution_status = ?, resolved_at = NULL, resolution_note = NULL,
        resolution_action = NULL,
        finished_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    result.status,
    result.rawCount || 0,
    result.insertedCount || 0,
    result.skippedCount || 0,
    result.invalidKeyCount || 0,
    result.conflictCount || 0,
    result.formatErrorCount || 0,
    result.rolledBackCount || 0,
    result.errorMessage || null,
    String(result.status || '').startsWith('failed') ? 'unresolved' : 'not_applicable',
    recordId
  );
}

function resolveImportRecord(db, recordId, { note, action } = {}) {
  const record = getImportRecord(db, recordId);
  if (!record) throw new Error(`导入记录不存在：${recordId}`);
  if (!String(record.status).startsWith('failed')) {
    throw new Error('仅失败导入记录可以标记为已处理');
  }
  const normalizedNote = String(note == null ? '' : note).trim();
  if (!normalizedNote) throw new Error('处理说明不能为空');
  if (normalizedNote.length > 500) throw new Error('处理说明不能超过 500 个字符');
  if (action !== 'keep_current_effective_dataset') {
    throw new Error('必须明确确认保留当前有效数据集，且本次失败导入不参与计算');
  }
  if (record.resolution_status === 'resolved') {
    if (record.resolution_note === normalizedNote && record.resolution_action === action) {
      return record;
    }
    throw new Error('该失败导入记录已处理，处理结论不可修改');
  }
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET resolution_status = 'resolved', resolution_note = ?, resolution_action = ?,
        resolved_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(normalizedNote, action, recordId);
  return getImportRecord(db, recordId);
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

function countImportRowsByDisposition(db, recordId) {
  const rows = db.prepare(`
    SELECT disposition, COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ?
    GROUP BY disposition
  `).all(recordId);
  return Object.fromEntries(rows.map((row) => [row.disposition || 'pending', Number(row.row_count) || 0]));
}

function finalizeImportingRecords(db, records, {
  rowMessage,
  recordMessage,
  errorCode,
  auditMessage
}) {
  const markRows = db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET disposition = 'rolled_back',
        validation_message = COALESCE(validation_message, ?)
    WHERE import_record_id = ? AND disposition IS NULL
  `);
  for (const record of records) {
    markRows.run(rowMessage, record.id);
    const counts = countImportRowsByDisposition(db, record.id);
    const rawCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
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
    addImportError(db, record.id, {
      errorCode,
      message: auditMessage
    });
  }
}

function failImportBatch(db, batchId, {
  errorCode = 'runtime-import-error',
  message = '导入运行异常，导入事务未完成'
} = {}) {
  const normalizedMessage = String(message || '导入运行异常，导入事务未完成');
  db.exec('BEGIN IMMEDIATE');
  try {
    const records = db.prepare(`
      SELECT id
      FROM vcc_fin_op_import_records
      WHERE batch_id = ? AND status = 'importing'
    `).all(batchId);
    finalizeImportingRecords(db, records, {
      rowMessage: '导入运行异常，整表未导入',
      recordMessage: normalizedMessage,
      errorCode,
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
      errorCode: 'interrupted-import',
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

module.exports = {
  IMPORT_ROW_INSERT_SQL,
  createImportBatch,
  finishImportBatch,
  createImportRecord,
  finishImportRecord,
  addImportError,
  getImportRecord,
  listImportMonths,
  listImportRecords,
  countImportRowsByDisposition,
  failImportBatch,
  recoverInterruptedImports,
  resolveImportRecord
};
