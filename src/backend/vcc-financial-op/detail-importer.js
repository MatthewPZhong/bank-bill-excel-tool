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
const {
  attachSourceIdentity,
  assertSourceFileMatchesSync,
  hashSourceFiles,
  sourceIdentityFromError
} = require('./source-lineage');
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
    anomalyCount: Number(row.anomaly_count) || 0,
    archiveState: row.archive_state || repository.refreshImportRecordArchiveState(db, recordId),
    sourceFiles: repository.listImportSources(db, recordId),
    errorMessage: row.error_message || ''
  };
}

function hasEffectiveRawJson(db) {
  return db.prepare('PRAGMA table_info(vcc_fin_op_effective_rows)').all()
    .some((row) => row.name === 'raw_json');
}

function updateConflictComparisons(db, recordId, sourceType) {
  if (!hasEffectiveRawJson(db)) {
    const conflictRows = db.prepare(`
      SELECT id, idempotency_key, content_hash, raw_json, raw_contract_version,
             subject, existing_effective_id
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND disposition = 'idempotent_conflict'
      ORDER BY id
    `).all(recordId);
    const findPeer = db.prepare(`
      SELECT id, raw_json, raw_contract_version, subject
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND idempotency_key = ? AND content_hash <> ?
      ORDER BY id
      LIMIT 1
    `);
    const update = db.prepare(`
      UPDATE vcc_fin_op_import_staging_rows
      SET comparison_import_row_id = ?, diff_fields_json = ?
      WHERE id = ?
    `);
    for (const row of conflictRows) {
      if (row.existing_effective_id !== null) {
        update.run(null, '["业务内容"]', row.id);
        continue;
      }
      const peer = findPeer.get(recordId, row.idempotency_key, row.content_hash);
      update.run(
        peer ? peer.id : null,
        JSON.stringify(peer
          ? diffFieldNames(
              sourceType,
              row.raw_json,
              peer.raw_json,
              row.subject,
              peer.subject,
              row.raw_contract_version,
              peer.raw_contract_version
            )
          : ['业务内容']),
        row.id
      );
    }
    return;
  }
  const conflictRows = db.prepare(`
    SELECT i.id, i.idempotency_key, i.content_hash, i.raw_json, i.raw_contract_version, i.subject,
           i.existing_effective_id, e.raw_json AS existing_raw_json,
           e.raw_contract_version AS existing_raw_contract_version,
           e.subject AS existing_subject
    FROM vcc_fin_op_import_staging_rows i
    LEFT JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
    WHERE i.import_record_id = ? AND i.disposition = 'idempotent_conflict'
    ORDER BY i.id
  `).all(recordId);
  const findPeer = db.prepare(`
    SELECT id, raw_json, raw_contract_version, subject
    FROM vcc_fin_op_import_staging_rows
    WHERE import_record_id = ? AND idempotency_key = ? AND content_hash <> ?
    ORDER BY id
    LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows
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
    FROM vcc_fin_op_import_staging_rows
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
    UPDATE vcc_fin_op_import_staging_rows
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
  repository.persistStagingAnomalies(db, recordId);
  const anomalyCount = repository.addFileFailureAnomaly(db, recordId, { message });
  repository.finishImportRecord(db, recordId, {
    status,
    rawCount,
    invalidKeyCount,
    conflictCount,
    formatErrorCount,
    skippedCount,
    rolledBackCount,
    anomalyCount,
    errorMessage: message
  });
  repository.clearImportStagingRows(db, recordId);
}

function markConflictRows(db, recordId, sourceType) {
  db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows AS incoming
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
    FROM vcc_fin_op_import_staging_rows
    WHERE import_record_id = ? AND disposition IS NULL
    GROUP BY idempotency_key
    HAVING COUNT(DISTINCT content_hash) > 1
  `).all(recordId).map((row) => row.idempotency_key);
  const markMixed = db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows
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
    UPDATE vcc_fin_op_import_staging_rows AS incoming
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

function filteredRowMessage(sourceType, counts) {
  const parts = [];
  if (counts.invalidKeyCount > 0) parts.push(`空键 ${counts.invalidKeyCount} 行`);
  if (counts.formatErrorCount > 0) parts.push(`格式异常 ${counts.formatErrorCount} 行`);
  if (counts.conflictCount > 0) parts.push(`幂等冲突 ${counts.conflictCount} 行`);
  return parts.length > 0
    ? `${SOURCE_LABELS[sourceType]}已过滤异常数据：${parts.join('、')}`
    : '';
}

function promoteRows(db, recordId, targetMonth, sourceType) {
  db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows
    SET disposition = 'accepted'
    WHERE id IN (
      SELECT MIN(id)
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND disposition IS NULL
      GROUP BY idempotency_key
    )
  `).run(recordId);

  if (hasEffectiveRawJson(db)) {
    db.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
        raw_contract_version,
        target_month, subject, stat_currency, signed_amount,
        business_department, counterparty_department, business_sub_type,
        channel_name, mid, recon_type,
        pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
        source_file, sheet_name, source_row, raw_json, import_record_id, import_source_id
      )
      SELECT
        source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
        raw_contract_version,
        target_month, subject, stat_currency, signed_amount,
        business_department, counterparty_department, business_sub_type,
        channel_name, mid, recon_type,
        pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
        source_file, sheet_name, source_row, raw_json, import_record_id, import_source_id
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND disposition = 'accepted'
      ORDER BY id
    `).run(recordId);
  } else {
    db.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key, content_hash, hash_version, raw_contract_version,
        target_month, subject, stat_currency, signed_amount,
        business_department, counterparty_department, business_sub_type,
        channel_name, mid, recon_type,
        pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
        import_record_id, import_source_id, sheet_name, source_row
      )
      SELECT
        source_type, idempotency_key, content_hash, hash_version, raw_contract_version,
        target_month, subject, stat_currency, signed_amount,
        business_department, counterparty_department, business_sub_type,
        channel_name, mid, recon_type,
        pending_currency, pending_amount, flow_currency, flow_amount, currency_mismatch,
        import_record_id, import_source_id, sheet_name, source_row
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND disposition = 'accepted'
      ORDER BY id
    `).run(recordId);
  }

  db.prepare(`
    INSERT INTO vcc_fin_op_effective_raw_fallback (
      effective_row_id, import_source_id, raw_contract_version, raw_json
    )
    SELECT effective.id, staging.import_source_id,
           staging.raw_contract_version, staging.raw_json
    FROM vcc_fin_op_import_staging_rows staging
    JOIN vcc_fin_op_effective_rows effective
      ON effective.source_type = staging.source_type
     AND effective.idempotency_key = staging.idempotency_key
    WHERE staging.import_record_id = ? AND staging.disposition = 'accepted'
    ON CONFLICT(effective_row_id) DO UPDATE SET
      import_source_id = excluded.import_source_id,
      raw_contract_version = excluded.raw_contract_version,
      raw_json = excluded.raw_json
  `).run(recordId);

  db.prepare(`
    UPDATE vcc_fin_op_import_staging_rows AS incoming
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
  const invalidKeyCount = countRows(db, recordId, 'invalid_key');
  const conflictCount = countRows(db, recordId, 'idempotent_conflict');
  const formatErrorCount = countRows(db, recordId, 'format_error');
  const rolledBackCount = countRows(db, recordId, 'rolled_back');
  const rawCount = insertedCount + skippedCount + invalidKeyCount
    + conflictCount + formatErrorCount + rolledBackCount;
  const filteredCount = invalidKeyCount + conflictCount + formatErrorCount;
  const status = insertedCount === 0
    ? (filteredCount > 0
      ? (conflictCount > 0 ? 'failed_conflict' : 'failed_validation')
      : 'all_skipped')
    : (skippedCount > 0 || filteredCount > 0 ? 'success_with_skips' : 'success');

  const anomalyCount = repository.persistStagingAnomalies(db, recordId);
  repository.finishImportRecord(db, recordId, {
    status,
    rawCount,
    insertedCount,
    skippedCount,
    invalidKeyCount,
    conflictCount,
    formatErrorCount,
    rolledBackCount,
    anomalyCount,
    errorMessage: filteredRowMessage(sourceType, {
      invalidKeyCount,
      conflictCount,
      formatErrorCount
    })
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

  repository.clearImportStagingRows(db, recordId);
}

function classifyAndPromote(db, recordId, targetMonth, sourceType) {
  db.exec('BEGIN IMMEDIATE');
  try {
    markConflictRows(db, recordId, sourceType);
    markExistingIdenticalRows(db, recordId);

    const candidateCount = Number(db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_import_staging_rows
      WHERE import_record_id = ? AND disposition IS NULL
    `).get(recordId).row_count) || 0;
    if (candidateCount > 0 && hasArchivedDataset(db, targetMonth, sourceType)) {
      const message = `${targetMonth} 已归档，禁止向 ${SOURCE_LABELS[sourceType]} 新增有效数据`;
      finalizeFailedRows(db, recordId, sourceType, message);
      db.exec('COMMIT');
      return recordResult(db, recordId);
    }

    updateConflictComparisons(db, recordId, sourceType);
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

  let importFiles = files;
  let recordId = preparedRecordId;
  if (!recordId) {
    const hashedFiles = await hashSourceFiles(files);
    recordId = repository.createImportRecord(db, {
      batchId,
      targetMonth: normalizedMonth,
      sourceType,
      sourceFiles: sourceFileNames(hashedFiles)
    });
    importFiles = hashedFiles.map((file, index) => ({
      ...file,
      sourceOrdinal: index + 1,
      importSourceId: repository.createImportSource(db, recordId, {
        sourceOrdinal: index + 1,
        fileName: file.fileName,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes
      })
    }));
  }
  const insert = db.prepare(repository.STAGING_ROW_INSERT_SQL);
  let rawCount = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of importFiles) {
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
            if (!Number.isSafeInteger(Number(file.importSourceId))) {
              throw new Error(`VCC 导入来源未登记：${path.basename(file.filePath)}`);
            }
            const params = mappedRowToInsertParams(recordId, mapped);
            insert.run(params[0], Number(file.importSourceId), ...params.slice(1));
            rawCount += 1;
            if (rawCount % STAGING_COMMIT_INTERVAL === 0) {
              commitStagingProgress(db, recordId, rawCount);
            }
          },
          onProgress: (progress) => {
            if (typeof onProgress === 'function') {
              onProgress({
                phase: 'reading',
                recordId,
                sourceType,
                sourceFile: progress.sourceFile,
                rows: rawCount
              });
            }
          }
        });
      } catch (error) {
        throw attachSourceIdentity(error, file);
      }
      if (fileResult.rowCount === 0) {
        const error = new Error(`${fileResult.sourceFile}：${SOURCE_LABELS[sourceType]}没有数据行`);
        error.code = 'empty-source-shard';
        throw attachSourceIdentity(error, file);
      }
      // 首次 SHA 记录与实际解析必须属于同一份字节内容。解析完成后、任何
      // effective 提升前再次全量核对；不一致只会留下文件级失败事件。
      assertSourceFileMatchesSync(file);
    }
    throwIfCancelled(shouldCancel);
    if (rawCount === 0) throw new Error(`${SOURCE_LABELS[sourceType]}没有有效数据行`);
    db.exec('COMMIT');
  } catch (error) {
    const wasCancelled = error && error.code === IMPORT_CANCELLED_CODE;
    try {
      db.prepare(`
        UPDATE vcc_fin_op_import_staging_rows
        SET disposition = 'rolled_back',
            validation_message = COALESCE(validation_message, '原表读取未完成，整表未导入')
        WHERE import_record_id = ? AND disposition IS NULL
      `).run(recordId);
      const invalidKeyCount = countRows(db, recordId, 'invalid_key');
      const formatErrorCount = countRows(db, recordId, 'format_error');
      const rolledBackCount = countRows(db, recordId, 'rolled_back');
      repository.persistStagingAnomalies(db, recordId);
      const anomalyCount = repository.addFileFailureAnomaly(db, recordId, {
        ...sourceIdentityFromError(error),
        message: error.message
      });
      repository.finishImportRecord(db, recordId, {
        status: 'failed_validation',
        rawCount,
        invalidKeyCount,
        formatErrorCount,
        rolledBackCount,
        anomalyCount,
        errorMessage: error.message
      });
      repository.clearImportStagingRows(db, recordId);
      db.exec('COMMIT');
    } catch (persistError) {
      safeRollback(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        const anomalyCount = repository.addFileFailureAnomaly(db, recordId, {
          ...sourceIdentityFromError(error),
          message: `${error.message}；异常分类保存失败：${persistError.message}`
        });
        repository.finishImportRecord(db, recordId, {
          status: 'failed_validation',
          rawCount,
          rolledBackCount: rawCount,
          anomalyCount,
          errorMessage: error.message
        });
        repository.clearImportStagingRows(db, recordId);
        db.exec('COMMIT');
      } catch (fallbackError) {
        safeRollback(db);
        throw fallbackError;
      }
    }
    if (wasCancelled) throw error;
    return recordResult(db, recordId);
  }

  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'committing',
      recordId,
      sourceType,
      rows: rawCount
    });
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

  throwIfCancelled(shouldCancel);
  const hashedFiles = await hashSourceFiles(files);
  const grouped = new Map();
  for (const file of hashedFiles) {
    if (!DETAIL_SOURCE_TYPES.has(file.sourceType)) {
      throw new Error(`明细导入批次包含非明细原表：${file.sourceType || 'unknown'}`);
    }
    if (!grouped.has(file.sourceType)) grouped.set(file.sourceType, []);
    grouped.get(file.sourceType).push(file);
  }

  repository.createImportBatch(db, {
    id: batchId,
    targetMonth: normalizedMonth,
    fileCount: hashedFiles.length
  });

  const records = [];
  const recordIds = new Map();
  let outerError = null;
  try {
    for (const [sourceType, sourceFiles] of grouped) {
      const recordId = repository.createImportRecord(db, {
        batchId,
        targetMonth: normalizedMonth,
        sourceType,
        sourceFiles: sourceFileNames(sourceFiles)
      });
      recordIds.set(sourceType, recordId);
      grouped.set(sourceType, sourceFiles.map((file, index) => ({
        ...file,
        sourceOrdinal: index + 1,
        importSourceId: repository.createImportSource(db, recordId, {
          sourceOrdinal: index + 1,
          fileName: file.fileName,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes
        })
      })));
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
        message: outerError.message || '导入运行异常，导入事务未完成',
        ...sourceIdentityFromError(outerError)
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
