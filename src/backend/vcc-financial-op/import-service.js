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

function detailRecordResult(record) {
  return { ...record, sourceLabel: SOURCE_LABELS[record.sourceType] };
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
  batchId = crypto.randomUUID()
}) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`导入账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择至少一个原表文件');
  for (const file of files) {
    if (!file || !Object.values(SOURCE_TYPES).includes(file.sourceType)) {
      throw new Error('存在未识别的原表文件');
    }
  }
  repository.createImportBatch(db, {
    id: batchId,
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
        batchId,
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
          batchId,
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
          batchId,
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

module.exports = {
  inspectFiles,
  importFiles
};
