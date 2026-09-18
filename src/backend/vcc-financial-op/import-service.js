'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  SOURCE_TYPES,
  SOURCE_LABELS
} = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const { inspectSourceFiles } = require('./workbook-reader');
const { freezeHandoffV2, buildMemberFiles, membersDigest, assertArtifactMember, handoffError } = require('./import-handoff');
const { createArchiveRepository } = require('../database/archive-repository');
const {
  DETAIL_SOURCE_TYPES,
  importDetailGroup,
  throwIfCancelled
} = require('./detail-importer');
const {
  importSystemOpWorkbookGroup,
  systemRecordResult
} = require('./system-op-importer');
const repository = require('../vcc-financial-op-db/repository');
const { hashSourceFiles, sourceIdentityFromError } = require('./source-lineage');

const IMPORT_BATCH_ID_MAX_LENGTH = 256;
const IMPORT_BATCH_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function importHandoffMismatch(message) {
  const error = new Error(`VCC 导入输入与业务前耐久证据不一致：${message}`);
  error.code = 'vcc-import-handoff-mismatch';
  return error;
}

function freezeImportArchiveHandoffFiles(value, batchId) {
  const normalizedBatchId = normalizeImportBatchId(batchId);
  if (value?.version === 2) return freezeHandoffV2(value, normalizedBatchId);
  if (!Array.isArray(value) || value.length === 0) {
    throw importHandoffMismatch('缺少输入文件证据');
  }
  const paths = new Set();
  const sourceIdentities = new Set();
  const ordinals = new Map();
  const descriptors = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw importHandoffMismatch(`第 ${index + 1} 项格式无效`);
    }
    const metadata = entry.metadata && typeof entry.metadata === 'object'
      ? entry.metadata
      : {};
    const rawPath = String(entry.filePath || '');
    if (!rawPath.trim()) throw importHandoffMismatch(`第 ${index + 1} 项缺少路径`);
    const filePath = path.resolve(rawPath);
    const sourceType = String(entry.sourceType || metadata.vccSourceType || '');
    if (!Object.values(SOURCE_TYPES).includes(sourceType)) {
      throw importHandoffMismatch(`第 ${index + 1} 项来源类型无效`);
    }
    const sourceOrdinal = Number(entry.sourceOrdinal ?? metadata.vccSourceOrdinal);
    if (!Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 1) {
      throw importHandoffMismatch(`第 ${index + 1} 项来源序号无效`);
    }
    const sha256 = String(entry.sha256 || entry.expectedSha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      throw importHandoffMismatch(`第 ${index + 1} 项 SHA-256 无效`);
    }
    const sizeBytes = Number(entry.sizeBytes ?? entry.byteSize ?? entry.expectedSizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw importHandoffMismatch(`第 ${index + 1} 项字节数无效`);
    }
    const taskRunId = String(
      entry.taskRunId || metadata.vccTaskRunId || metadata.vccImportBatchId || ''
    );
    if (taskRunId !== normalizedBatchId) {
      throw importHandoffMismatch(`第 ${index + 1} 项任务身份无效`);
    }
    const archiveArtifactId = Number(entry.archiveArtifactId);
    if (!Number.isSafeInteger(archiveArtifactId) || archiveArtifactId < 1) {
      throw importHandoffMismatch(`第 ${index + 1} 项 artifact 身份无效`);
    }
    const expectedOrdinal = (ordinals.get(sourceType) || 0) + 1;
    ordinals.set(sourceType, expectedOrdinal);
    if (sourceOrdinal !== expectedOrdinal) {
      throw importHandoffMismatch(`第 ${index + 1} 项来源顺序无效`);
    }
    const sourceIdentity = `${sourceType}\u0000${sourceOrdinal}`;
    if (paths.has(filePath) || sourceIdentities.has(sourceIdentity)) {
      throw importHandoffMismatch(`第 ${index + 1} 项来源重复`);
    }
    paths.add(filePath);
    sourceIdentities.add(sourceIdentity);
    return Object.freeze({
      filePath,
      sourceType,
      sourceOrdinal,
      sha256,
      sizeBytes,
      taskRunId,
      archiveArtifactId
    });
  });
  return Object.freeze(descriptors);
}

function assertImportArchiveHandoffMatches(hashedFiles, handoffFiles, batchId) {
  const descriptors = freezeImportArchiveHandoffFiles(handoffFiles, batchId);
  if (!Array.isArray(hashedFiles) || hashedFiles.length !== descriptors.length) {
    throw importHandoffMismatch('输入文件数量已变化');
  }
  for (let index = 0; index < hashedFiles.length; index += 1) {
    const actual = hashedFiles[index];
    const expected = descriptors[index];
    if (!actual
        || path.resolve(String(actual.filePath || '')) !== expected.filePath
        || String(actual.sourceType || '') !== expected.sourceType
        || String(actual.sha256 || '').toLowerCase() !== expected.sha256
        || Number(actual.sizeBytes) !== expected.sizeBytes) {
      throw importHandoffMismatch(`第 ${index + 1} 项路径、类型、SHA-256 或字节数已变化`);
    }
  }
  return descriptors;
}

function detailRecordResult(record, db) {
  const sourceFiles = repository.listImportSources(db, record.recordId);
  return {
    ...record,
    sourceLabel: SOURCE_LABELS[record.sourceType],
    anomalyCount: Number(record.anomalyCount) || 0,
    archiveState: repository.refreshImportRecordArchiveState(db, record.recordId),
    sourceFiles
  };
}

function storedRecordResult(record, db) {
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
    anomalyCount: Number(record.anomaly_count) || 0,
    archiveState: repository.refreshImportRecordArchiveState(db, Number(record.id)),
    sourceFiles: repository.listImportSources(db, Number(record.id)),
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
  batchId,
  archiveHandoffFiles
}) {
  const normalizedBatchId = normalizeImportBatchId(batchId);
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`导入账期格式无效：${targetMonth}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择至少一个原表文件');
  const isWorkbookPlan = archiveHandoffFiles?.version === 2;
  for (const file of files) {
    if (!file || (!isWorkbookPlan && !Object.values(SOURCE_TYPES).includes(file.sourceType))) {
      throw new Error('存在未识别的原表文件');
    }
  }
  throwIfCancelled(shouldCancel);
  const hashedFiles = await hashSourceFiles(files);
  let exactFiles;
  if (isWorkbookPlan) {
    const handoff = freezeHandoffV2(archiveHandoffFiles, normalizedBatchId);
    const expectedFiles = buildMemberFiles(files);
    if (handoff.files.length !== files.length) throw handoffError('物理文件数变化');
    exactFiles = hashedFiles.map((actual, index) => {
      const expected = handoff.files[index];
      if (actual.filePath !== expected.filePath || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes
          || expected.physicalFileId !== expectedFiles[index].physicalFileId
          || membersDigest(expected.members) !== membersDigest(expectedFiles[index].members)) throw handoffError('输入文件或成员发生变化');
      return { ...actual, fileName: expected.fileName, archiveArtifactId: expected.archiveArtifactId,
        members: expected.members };
    });
  } else {
    const descriptors = assertImportArchiveHandoffMatches(hashedFiles, archiveHandoffFiles, normalizedBatchId);
    exactFiles = hashedFiles.map((file, index) => ({ ...file, archiveArtifactId: descriptors[index].archiveArtifactId }));
  }
  const grouped = new Map();
  for (const file of exactFiles) {
    const members = isWorkbookPlan ? [...file.members].sort((a, b) => a.sheets[0].sheetIndex - b.sheets[0].sheetIndex)
      : [{ sourceType: file.sourceType }];
    for (const member of members) {
      if (!grouped.has(member.sourceType)) grouped.set(member.sourceType, []);
      grouped.get(member.sourceType).push({ ...file, sourceType: member.sourceType,
        ...(isWorkbookPlan ? { sheets: member.sheets, sourceOrdinal: member.sourceOrdinal } : {}) });
    }
  }

  const records = [];
  const recordIds = new Map();
  const rowsReadByType = new Map();
  const reportProgress = (progress) => {
    if (progress.phase === 'reading') rowsReadByType.set(progress.sourceType,
      Math.max(rowsReadByType.get(progress.sourceType) || 0, Number(progress.rows) || 0));
    onProgress?.(progress);
  };
  let outerError = null;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      repository.createImportBatch(db, { id: normalizedBatchId, targetMonth: normalizedMonth, fileCount: exactFiles.length });
      const archive = isWorkbookPlan ? createArchiveRepository(db) : null;
    for (const [sourceType, sourceFiles] of grouped) {
      const recordId = repository.createImportRecord(db, {
        batchId: normalizedBatchId,
        targetMonth: normalizedMonth,
        sourceType,
        sourceFiles: sourceFiles.map((file) => file.fileName || path.basename(file.filePath))
      });
      recordIds.set(sourceType, recordId);
      grouped.set(sourceType, sourceFiles.map((file, index) => ({
        ...file,
        sourceOrdinal: index + 1,
        importSourceId: repository.createImportSource(db, recordId, {
          sourceOrdinal: index + 1,
          fileName: file.fileName,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          archiveArtifactId: file.archiveArtifactId
        })
      })));
      if (archive) {
        for (const file of grouped.get(sourceType)) {
          const artifact = archive.getArtifact(file.archiveArtifactId);
          if (!artifact || artifact.status !== 'ready') throw handoffError('输入原件尚未 ready');
          assertArtifactMember(artifact, { id: file.importSourceId, source_type: sourceType, batch_id: normalizedBatchId,
            source_ordinal: file.sourceOrdinal, source_sha256: file.sha256, source_size_bytes: file.sizeBytes,
            source_file_name: file.fileName }, archive.getBatch(artifact.batchId));
          archive.addArtifactHold(file.archiveArtifactId, { ownerModule: 'vcc-financial-op', ownerType: 'vcc-import-source',
            ownerId: String(file.importSourceId), reason: `VCC 导入来源 ${file.importSourceId} 在业务写入前保护原件` });
        }
      }
    }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* keep primary */ }
      recordIds.clear();
      throw error;
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
          onProgress: reportProgress,
          shouldCancel
        });
        records.push(detailRecordResult(record, db));
      } else if (sourceType === SOURCE_TYPES.SYSTEM_OP) {
        records.push(detailRecordResult(systemRecordResult(await importSystemOpWorkbookGroup({
          db,
          batchId: normalizedBatchId,
          targetMonth: normalizedMonth,
          files: sourceFiles,
          recordId: recordIds.get(sourceType),
          onProgress: reportProgress,
          shouldCancel
        })), db));
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
        message: outerError.message || '导入运行异常，导入事务未完成',
        ...sourceIdentityFromError(outerError)
      });
    } catch (finalizeError) {
      outerError.message = `${outerError.message}；失败记录即时收口失败：${finalizeError.message}`;
    }
    const finalizedRecords = [...recordIds.values()]
      .map((recordId) => repository.getImportRecord(db, recordId))
      .filter(Boolean)
      .map((record) => storedRecordResult(record, db));
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
  const physicalFileCount = exactFiles.length;
  const businessSheetCount = exactFiles.reduce((count, file) => count + (file.sheets?.length || 1), 0);
  const readRowCount = records.reduce((count, record) => count + (record.sourceType === SOURCE_TYPES.SYSTEM_OP
    ? rowsReadByType.get(record.sourceType) || 0 : Number(record.rawCount) || 0), 0);
  onProgress?.({ phase: 'summarizing', physicalFileCount, businessSheetCount, rows: readRowCount });
  repository.finishImportBatch(db, normalizedBatchId, status);
  return { batchId: normalizedBatchId, targetMonth: normalizedMonth, status, records,
    physicalFileCount, businessSheetCount, ...(isWorkbookPlan ? { readRowCount } : {}) };
}

module.exports = {
  assertImportArchiveHandoffMatches,
  freezeImportArchiveHandoffFiles,
  normalizeImportBatchId,
  inspectFiles,
  importFiles,
  storedRecordResult
};
