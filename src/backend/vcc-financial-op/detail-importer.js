'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  PENDING_HEADERS,
  getSourceDefinition
} = require('./definitions');
const {
  mapDetailRow,
  mappedRowToInsertParams,
  normalizeYearMonth,
  pendingCanonicalValues
} = require('./row-mapper');
const { inspectSourceFiles, streamDetailRows } = require('./workbook-reader');
const repository = require('../vcc-financial-op-db/repository');

const DETAIL_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING
]);
const IMPORT_CANCELLED_CODE = 'vcc-import-cancelled';
const STAGING_COMMIT_INTERVAL = 50000;

function throwIfCancelled(shouldCancel) {
  if (typeof shouldCancel !== 'function' || !shouldCancel()) return;
  const error = new Error('VCC 财务OP导入已取消，已读取数据未进入有效数据集');
  error.code = IMPORT_CANCELLED_CODE;
  throw error;
}

function commitStagingProgress(db, recordId, rawCount) {
  db.exec('COMMIT');
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET raw_count = ?
    WHERE id = ? AND status = 'importing'
  `).run(rawCount, recordId);
  db.exec('BEGIN IMMEDIATE');
}

function safeRollback(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* ignore */ }
}

function sourceFileNames(files) {
  return files.map((file) => path.basename(file.filePath));
}

function parseRawJson(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function comparableRawValues(sourceType, rawJson, rawContractVersion) {
  const values = parseRawJson(rawJson);
  if (sourceType !== SOURCE_TYPES.PENDING) {
    const definition = getSourceDefinition(sourceType);
    return { headers: definition ? definition.headers : [], values };
  }
  return {
    headers: PENDING_HEADERS,
    values: pendingCanonicalValues(values, rawContractVersion)
  };
}

function diffFieldNames(
  sourceType,
  leftRawJson,
  rightRawJson,
  leftSubject = '',
  rightSubject = '',
  leftRawContractVersion = 1,
  rightRawContractVersion = 1
) {
  const definition = getSourceDefinition(sourceType);
  if (!definition) return [];
  const left = comparableRawValues(sourceType, leftRawJson, leftRawContractVersion);
  const right = comparableRawValues(sourceType, rightRawJson, rightRawContractVersion);
  const fields = left.headers.filter((_header, index) => (
    String(left.values[index] ?? '') !== String(right.values[index] ?? '')
  ));
  if (sourceType === SOURCE_TYPES.CHANNEL && String(leftSubject) !== String(rightSubject)) {
    fields.push('公司主体（导入指定）');
  }
  return fields;
}

function recordResult(db, recordId) {
  const row = repository.getImportRecord(db, recordId);
  return {
    recordId,
    batchId: row.batch_id,
    targetMonth: row.target_month,
    sourceType: row.source_type,
    status: row.status,
    rawCount: Number(row.raw_count) || 0,
    insertedCount: Number(row.inserted_count) || 0,
    skippedCount: Number(row.skipped_count) || 0,
    invalidKeyCount: Number(row.invalid_key_count) || 0,
    conflictCount: Number(row.conflict_count) || 0,
    formatErrorCount: Number(row.format_error_count) || 0,
    rolledBackCount: Number(row.rolled_back_count) || 0,
    errorMessage: row.error_message || ''
  };
}

function updateConflictComparisons(db, recordId, sourceType) {
  const conflictRows = db.prepare(`
    SELECT i.id, i.idempotency_key, i.content_hash, i.raw_json, i.raw_contract_version, i.subject,
           i.existing_effective_id, e.raw_json AS existing_raw_json,
           e.raw_contract_version AS existing_raw_contract_version,
           e.subject AS existing_subject
    FROM vcc_fin_op_import_rows i
    LEFT JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
    WHERE i.import_record_id = ? AND i.disposition = 'idempotent_conflict'
    ORDER BY i.id
  `).all(recordId);
  const findPeer = db.prepare(`
    SELECT id, raw_json, raw_contract_version, subject
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND idempotency_key = ? AND content_hash <> ?
    ORDER BY id
    LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET comparison_import_row_id = ?, diff_fields_json = ?
    WHERE id = ?
  `);
  for (const row of conflictRows) {
    let comparisonId = null;
    let comparisonRaw = row.existing_raw_json;
    let comparisonRawContractVersion = row.existing_raw_contract_version;
    let comparisonSubject = row.existing_subject;
    if (!comparisonRaw) {
      const peer = findPeer.get(recordId, row.idempotency_key, row.content_hash);
      if (peer) {
        comparisonId = peer.id;
        comparisonRaw = peer.raw_json;
        comparisonRawContractVersion = peer.raw_contract_version;
        comparisonSubject = peer.subject;
      }
    }
    update.run(
      comparisonId,
      JSON.stringify(diffFieldNames(
        sourceType,
        row.raw_json,
        comparisonRaw || '[]',
        row.subject,
        comparisonSubject,
        row.raw_contract_version,
        comparisonRawContractVersion
      )),
      row.id
    );
  }
}

function countRows(db, recordId, disposition) {
  const row = db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition = ?
  `).get(recordId, disposition);
  return Number(row.row_count) || 0;
}

function hasArchivedDataset(db, targetMonth, sourceType) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    UNION ALL
    SELECT 1
    FROM vcc_fin_op_datasets
    WHERE target_month = ? AND dataset_type = ? AND data_status = 'archived'
    LIMIT 1
  `).get(targetMonth, targetMonth, sourceType));
}

function finalizeFailedRows(db, recordId, sourceType, message) {
  db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET disposition = 'rolled_back', validation_message = COALESCE(validation_message, ?)
    WHERE import_record_id = ? AND disposition IS NULL
  `).run(message, recordId);
  updateConflictComparisons(db, recordId, sourceType);

  const invalidKeyCount = countRows(db, recordId, 'invalid_key');
  const conflictCount = countRows(db, recordId, 'idempotent_conflict');
  const formatErrorCount = countRows(db, recordId, 'format_error');
  const rolledBackCount = countRows(db, recordId, 'rolled_back');
  const skippedCount = countRows(db, recordId, 'idempotent_skip');
  const rawCount = invalidKeyCount + conflictCount + formatErrorCount + rolledBackCount + skippedCount;
  const status = conflictCount > 0 ? 'failed_conflict' : 'failed_validation';
  repository.finishImportRecord(db, recordId, {
    status,
    rawCount,
    invalidKeyCount,
    conflictCount,
    formatErrorCount,
    skippedCount,
    rolledBackCount,
    errorMessage: message
  });
}

function markConflictRows(db, recordId, sourceType) {
  db.prepare(`
    UPDATE vcc_fin_op_import_rows AS incoming
    SET disposition = 'idempotent_conflict',
        existing_effective_id = (
          SELECT effective.id
          FROM vcc_fin_op_effective_rows effective
          WHERE effective.source_type = incoming.source_type
            AND effective.idempotency_key = incoming.idempotency_key
          LIMIT 1
        ),
        validation_field = 'idempotency_key',
        validation_message = '同一业务键对应的原始业务内容不一致'
    WHERE incoming.import_record_id = ?
      AND incoming.disposition IS NULL
      AND EXISTS (
        SELECT 1
        FROM vcc_fin_op_effective_rows effective
        WHERE effective.source_type = incoming.source_type
          AND effective.idempotency_key = incoming.idempotency_key
          AND effective.content_hash <> incoming.content_hash
      )
  `).run(recordId);

  const mixedKeys = db.prepare(`
    SELECT idempotency_key
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition IS NULL
    GROUP BY idempotency_key
    HAVING COUNT(DISTINCT content_hash) > 1
  `).all(recordId).map((row) => row.idempotency_key);
  const markMixed = db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET disposition = 'idempotent_conflict',
        validation_field = 'idempotency_key',
        validation_message = '同一导入批次内业务键相同但原始业务内容不一致'
    WHERE import_record_id = ? AND idempotency_key = ? AND disposition IS NULL
  `);
  for (const key of mixedKeys) markMixed.run(recordId, key);
  return countRows(db, recordId, 'idempotent_conflict');
}

function markExistingIdenticalRows(db, recordId) {
  db.prepare(`
    UPDATE vcc_fin_op_import_rows AS incoming
    SET disposition = 'idempotent_skip',
        existing_effective_id = (
          SELECT effective.id
          FROM vcc_fin_op_effective_rows effective
          WHERE effective.source_type = incoming.source_type
            AND effective.idempotency_key = incoming.idempotency_key
          LIMIT 1
        ),
        validation_message = '同键同内容，幂等跳过，未参与重复计算'
    WHERE incoming.import_record_id = ?
      AND incoming.disposition IS NULL
      AND EXISTS (
        SELECT 1
        FROM vcc_fin_op_effective_rows effective
        WHERE effective.source_type = incoming.source_type
          AND effective.idempotency_key = incoming.idempotency_key
          AND effective.content_hash = incoming.content_hash
      )
  `).run(recordId);
}

function promoteRows(db, recordId, targetMonth, sourceType) {
  db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET disposition = 'accepted'
    WHERE id IN (
      SELECT MIN(id)
      FROM vcc_fin_op_import_rows
      WHERE import_record_id = ? AND disposition IS NULL
      GROUP BY idempotency_key
    )
  `).run(recordId);

  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
      raw_contract_version,
      target_month, subject, stat_currency, signed_amount,
      business_department, counterparty_department, business_sub_type,
      channel_name, mid, recon_type,
      pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
      source_file, sheet_name, source_row, raw_json, import_record_id
    )
    SELECT
      source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
      raw_contract_version,
      target_month, subject, stat_currency, signed_amount,
      business_department, counterparty_department, business_sub_type,
      channel_name, mid, recon_type,
      pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
      source_file, sheet_name, source_row, raw_json, import_record_id
    FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition = 'accepted'
    ORDER BY id
  `).run(recordId);

  db.prepare(`
    UPDATE vcc_fin_op_import_rows AS incoming
    SET disposition = 'idempotent_skip',
        existing_effective_id = (
          SELECT effective.id
          FROM vcc_fin_op_effective_rows effective
          WHERE effective.source_type = incoming.source_type
            AND effective.idempotency_key = incoming.idempotency_key
          LIMIT 1
        ),
        validation_message = '同键同内容，幂等跳过，未参与重复计算'
    WHERE incoming.import_record_id = ? AND incoming.disposition IS NULL
  `).run(recordId);

  const insertedCount = countRows(db, recordId, 'accepted');
  const skippedCount = countRows(db, recordId, 'idempotent_skip');
  const rawCount = insertedCount + skippedCount;
  const status = insertedCount === 0
    ? 'all_skipped'
    : (skippedCount > 0 ? 'success_with_skips' : 'success');

  repository.finishImportRecord(db, recordId, {
    status,
    rawCount,
    insertedCount,
    skippedCount
  });

  if (insertedCount > 0) {
    db.prepare(`
      INSERT INTO vcc_fin_op_datasets (
        target_month, dataset_type, data_status, generated_at
      ) VALUES (
        ?, ?, 'unprocessed',
        COALESCE(
          (SELECT finished_at FROM vcc_fin_op_import_records WHERE id = ?),
          datetime('now', 'localtime')
        )
      )
      ON CONFLICT(target_month, dataset_type) DO UPDATE SET
        data_status = 'unprocessed', archived_run_id = NULL,
        revision = vcc_fin_op_datasets.revision + 1,
        generated_at = excluded.generated_at,
        updated_at = datetime('now', 'localtime')
    `).run(targetMonth, sourceType, recordId);
  }

  db.prepare(`
    DELETE FROM vcc_fin_op_import_rows
    WHERE import_record_id = ? AND disposition = 'accepted'
  `).run(recordId);
}

function classifyAndPromote(db, recordId, targetMonth, sourceType) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const invalidKeyCount = countRows(db, recordId, 'invalid_key');
    const formatErrorCount = countRows(db, recordId, 'format_error');
    const conflictCount = markConflictRows(db, recordId, sourceType);
    markExistingIdenticalRows(db, recordId);
    if (invalidKeyCount > 0 || formatErrorCount > 0 || conflictCount > 0) {
      const message = conflictCount > 0
        ? `${SOURCE_LABELS[sourceType]}存在同键异内容冲突，整批未导入`
        : `${SOURCE_LABELS[sourceType]}存在空键或格式错误，整批未导入`;
      finalizeFailedRows(db, recordId, sourceType, message);
      db.exec('COMMIT');
      return recordResult(db, recordId);
    }

    const candidateCount = Number(db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_import_rows
      WHERE import_record_id = ? AND disposition IS NULL
    `).get(recordId).row_count) || 0;
    if (candidateCount > 0 && hasArchivedDataset(db, targetMonth, sourceType)) {
      const message = `${targetMonth} 已归档，禁止向 ${SOURCE_LABELS[sourceType]} 新增有效数据`;
      finalizeFailedRows(db, recordId, sourceType, message);
      repository.addImportError(db, recordId, {
        errorCode: 'dataset-archived',
        message
      });
      db.exec('COMMIT');
      return recordResult(db, recordId);
    }

    promoteRows(db, recordId, targetMonth, sourceType);
    db.exec('COMMIT');
    return recordResult(db, recordId);
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

async function importDetailGroup({
  db,
  batchId,
  targetMonth,
  sourceType,
  files,
  recordId: preparedRecordId,
  onProgress,
  shouldCancel
}) {
  if (!DETAIL_SOURCE_TYPES.has(sourceType)) throw new Error(`不是明细原表类型：${sourceType}`);
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`导入账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('逻辑原表至少需要一个文件');

  const recordId = preparedRecordId || repository.createImportRecord(db, {
    batchId,
    targetMonth: normalizedMonth,
    sourceType,
    sourceFiles: sourceFileNames(files)
  });
  const insert = db.prepare(repository.IMPORT_ROW_INSERT_SQL);
  let rawCount = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of files) {
      throwIfCancelled(shouldCancel);
      let fileResult;
      try {
        fileResult = await streamDetailRows(file.filePath, sourceType, {
          onDataRow: ({ rowR, values, sourceFile, sheetName, keyCellType }) => {
            throwIfCancelled(shouldCancel);
            const mapped = mapDetailRow({
              sourceType,
              values,
              targetMonth: normalizedMonth,
              assignedSubject: file.subject,
              sourceFile,
              sheetName,
              sourceRow: rowR,
              keyCellType
            });
            insert.run(...mappedRowToInsertParams(recordId, mapped));
            rawCount += 1;
            if (rawCount % STAGING_COMMIT_INTERVAL === 0) {
              commitStagingProgress(db, recordId, rawCount);
            }
          },
          onProgress: (progress) => {
            if (typeof onProgress === 'function') {
              onProgress({
                recordId,
                sourceType,
                sourceFile: progress.sourceFile,
                rows: rawCount
              });
            }
          }
        });
      } catch (error) {
        if (!error.sourceFile) error.sourceFile = path.basename(file.filePath);
        throw error;
      }
      if (fileResult.rowCount === 0) {
        const error = new Error(`${fileResult.sourceFile}：${SOURCE_LABELS[sourceType]}没有数据行`);
        error.code = 'empty-source-shard';
        error.sourceFile = fileResult.sourceFile;
        throw error;
      }
    }
    throwIfCancelled(shouldCancel);
    if (rawCount === 0) throw new Error(`${SOURCE_LABELS[sourceType]}没有有效数据行`);
    db.exec('COMMIT');
  } catch (error) {
    const wasCancelled = error && error.code === IMPORT_CANCELLED_CODE;
    try {
      db.prepare(`
        UPDATE vcc_fin_op_import_rows
        SET disposition = 'rolled_back',
            validation_message = COALESCE(validation_message, '原表读取未完成，整表未导入')
        WHERE import_record_id = ? AND disposition IS NULL
      `).run(recordId);
      repository.addImportError(db, recordId, {
        errorCode: error.code || 'file-validation-error',
        message: error.message,
        sourceFile: error.sourceFile
      });
      const invalidKeyCount = countRows(db, recordId, 'invalid_key');
      const formatErrorCount = countRows(db, recordId, 'format_error');
      const rolledBackCount = countRows(db, recordId, 'rolled_back');
      repository.finishImportRecord(db, recordId, {
        status: 'failed_validation',
        rawCount,
        invalidKeyCount,
        formatErrorCount,
        rolledBackCount,
        errorMessage: error.message
      });
      db.exec('COMMIT');
    } catch (persistError) {
      safeRollback(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        repository.addImportError(db, recordId, {
          errorCode: error.code || 'file-validation-error',
          message: `${error.message}；逐行审计保存失败：${persistError.message}`,
          sourceFile: error.sourceFile
        });
        repository.finishImportRecord(db, recordId, {
          status: 'failed_validation',
          rawCount,
          rolledBackCount: rawCount,
          errorMessage: error.message
        });
        db.exec('COMMIT');
      } catch (fallbackError) {
        safeRollback(db);
        throw fallbackError;
      }
    }
    if (wasCancelled) throw error;
    return recordResult(db, recordId);
  }

  return classifyAndPromote(db, recordId, normalizedMonth, sourceType);
}

async function importDetailBatch({
  db,
  targetMonth,
  files,
  onProgress,
  shouldCancel,
  batchId = crypto.randomUUID()
}) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`导入账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择至少一个原表文件');

  const grouped = new Map();
  for (const file of files) {
    if (!DETAIL_SOURCE_TYPES.has(file.sourceType)) {
      throw new Error(`明细导入批次包含非明细原表：${file.sourceType || 'unknown'}`);
    }
    if (!grouped.has(file.sourceType)) grouped.set(file.sourceType, []);
    grouped.get(file.sourceType).push(file);
  }

  repository.createImportBatch(db, {
    id: batchId,
    targetMonth: normalizedMonth,
    fileCount: files.length
  });

  const records = [];
  const recordIds = new Map();
  let outerError = null;
  try {
    for (const [sourceType, sourceFiles] of grouped) {
      recordIds.set(sourceType, repository.createImportRecord(db, {
        batchId,
        targetMonth: normalizedMonth,
        sourceType,
        sourceFiles: sourceFileNames(sourceFiles)
      }));
    }
    for (const [sourceType, sourceFiles] of grouped) {
      throwIfCancelled(shouldCancel);
      records.push(await importDetailGroup({
        db,
        batchId,
        targetMonth: normalizedMonth,
        sourceType,
        files: sourceFiles,
        recordId: recordIds.get(sourceType),
        onProgress,
        shouldCancel
      }));
    }
  } catch (error) {
    outerError = error;
  }

  const failures = records.filter((record) => record.status.startsWith('failed'));
  if (outerError) {
    try {
      repository.failImportBatch(db, batchId, {
        errorCode: outerError.code || 'runtime-import-error',
        message: outerError.message || '导入运行异常，导入事务未完成'
      });
    } catch (finalizeError) {
      outerError.message = `${outerError.message}；失败记录即时收口失败：${finalizeError.message}`;
    }
    throw outerError;
  }
  const status = failures.length > 0 ? 'completed_with_errors' : 'success';
  repository.finishImportBatch(db, batchId, status);
  return { batchId, targetMonth: normalizedMonth, status, records };
}

async function inspectAndPrepareFiles(filePaths, subjectByPath = {}) {
  const inspected = await inspectSourceFiles(filePaths);
  return inspected.map((file) => ({
    ...file,
    subject: file.requiresSubject ? String(subjectByPath[file.filePath] || '').trim() : ''
  }));
}

module.exports = {
  DETAIL_SOURCE_TYPES,
  IMPORT_CANCELLED_CODE,
  STAGING_COMMIT_INTERVAL,
  throwIfCancelled,
  diffFieldNames,
  classifyAndPromote,
  importDetailGroup,
  importDetailBatch,
  inspectAndPrepareFiles
};
