'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  SOURCE_TYPES,
  SOURCE_LABELS
} = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const { inspectSourceFiles } = require('./workbook-reader');
const {
  DETAIL_SOURCE_TYPES,
  importDetailGroup,
  throwIfCancelled
} = require('./detail-importer');
const {
  importSystemOpGroup,
  systemRecordResult
} = require('./system-op-importer');
const repository = require('../vcc-financial-op-db/repository');

const IMPORT_BATCH_ID_MAX_LENGTH = 256;
const IMPORT_BATCH_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function normalizeImportBatchId(value) {
  const candidate = value === undefined ? crypto.randomUUID() : value;
  if (typeof candidate !== 'string') {
    throw new TypeError('VCC 导入批次号必须是字符串');
  }
  if (!candidate || candidate !== candidate.trim()) {
    throw new TypeError('VCC 导入批次号不能为空或包含首尾空白');
  }
  if (candidate.length > IMPORT_BATCH_ID_MAX_LENGTH) {
    throw new TypeError(`VCC 导入批次号不能超过 ${IMPORT_BATCH_ID_MAX_LENGTH} 个字符`);
  }
  if (IMPORT_BATCH_ID_CONTROL_PATTERN.test(candidate)) {
    throw new TypeError('VCC 导入批次号不能包含控制字符');
  }
  return candidate;
}

function detailRecordResult(record) {
  return { ...record, sourceLabel: SOURCE_LABELS[record.sourceType] };
}

function storedRecordResult(record) {
  return {
    recordId: Number(record.id),
    batchId: record.batch_id,
    targetMonth: record.target_month,
    sourceType: record.source_type,
    sourceLabel: SOURCE_LABELS[record.source_type],
    status: record.status,
    rawCount: Number(record.raw_count) || 0,
    insertedCount: Number(record.inserted_count) || 0,
    skippedCount: Number(record.skipped_count) || 0,
    invalidKeyCount: Number(record.invalid_key_count) || 0,
    conflictCount: Number(record.conflict_count) || 0,
    formatErrorCount: Number(record.format_error_count) || 0,
    rolledBackCount: Number(record.rolled_back_count) || 0,
    errorMessage: record.error_message || ''
  };
}

async function inspectFiles(filePaths) {
  return inspectSourceFiles(filePaths);
}

async function importFiles({
  db,
  targetMonth,
  files,
  onProgress,
  shouldCancel,
  batchId
}) {
  const normalizedBatchId = normalizeImportBatchId(batchId);
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`导入账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择至少一个原表文件');
  for (const file of files) {
    if (!file || !Object.values(SOURCE_TYPES).includes(file.sourceType)) {
      throw new Error('存在未识别的原表文件');
    }
  }
  repository.createImportBatch(db, {
    id: normalizedBatchId,
    targetMonth: normalizedMonth,
    fileCount: files.length
  });

  const grouped = new Map();
  for (const file of files) {
    if (!grouped.has(file.sourceType)) grouped.set(file.sourceType, []);
    grouped.get(file.sourceType).push(file);
  }

  const records = [];
  const recordIds = new Map();
  let outerError = null;
  try {
    for (const [sourceType, sourceFiles] of grouped) {
      recordIds.set(sourceType, repository.createImportRecord(db, {
        batchId: normalizedBatchId,
        targetMonth: normalizedMonth,
        sourceType,
        sourceFiles: sourceFiles.map((file) => path.basename(file.filePath))
      }));
    }
    for (const [sourceType, sourceFiles] of grouped) {
      throwIfCancelled(shouldCancel);
      if (DETAIL_SOURCE_TYPES.has(sourceType)) {
        const record = await importDetailGroup({
          db,
          batchId: normalizedBatchId,
          targetMonth: normalizedMonth,
          sourceType,
          files: sourceFiles,
          recordId: recordIds.get(sourceType),
          onProgress,
          shouldCancel
        });
        records.push(detailRecordResult(record));
      } else if (sourceType === SOURCE_TYPES.SYSTEM_OP) {
        records.push(systemRecordResult(importSystemOpGroup({
          db,
          batchId: normalizedBatchId,
          targetMonth: normalizedMonth,
          files: sourceFiles,
          recordId: recordIds.get(sourceType)
        })));
      } else {
        throw new Error(`不支持的 VCC 财务OP原表类型：${sourceType}`);
      }
    }
  } catch (error) {
    outerError = error;
  }

  const failures = records.filter((record) => record.status.startsWith('failed'));
  if (outerError) {
    try {
      repository.failImportBatch(db, normalizedBatchId, {
        errorCode: outerError.code || 'runtime-import-error',
        message: outerError.message || '导入运行异常，导入事务未完成'
      });
    } catch (finalizeError) {
      outerError.message = `${outerError.message}；失败记录即时收口失败：${finalizeError.message}`;
    }
    const finalizedRecords = [...recordIds.values()]
      .map((recordId) => repository.getImportRecord(db, recordId))
      .filter(Boolean)
      .map(storedRecordResult);
    outerError.partialResult = Object.freeze({
      batchId: normalizedBatchId,
      targetMonth: normalizedMonth,
      status: 'error',
      partialCommitted: finalizedRecords.some((record) => (
        ['success', 'success_with_skips', 'all_skipped'].includes(record.status)
      )),
      records: Object.freeze(finalizedRecords)
    });
    throw outerError;
  }
  const status = failures.length > 0 ? 'completed_with_errors' : 'success';
  repository.finishImportBatch(db, normalizedBatchId, status);
  return { batchId: normalizedBatchId, targetMonth: normalizedMonth, status, records };
}

module.exports = {
  normalizeImportBatchId,
  inspectFiles,
  importFiles,
  storedRecordResult
};
