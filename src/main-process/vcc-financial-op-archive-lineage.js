'use strict';

const vccRepository = require('../backend/vcc-financial-op-db/repository');
const { hashSourceFiles } = require('../backend/vcc-financial-op/source-lineage');
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');
const VCC_ARCHIVE_MODULE_ID = 'vcc-financial-op';
const VCC_IMPORT_SOURCE_OPERATION = 'vccFinancialOp:import:apply';
const VCC_IMPORT_HOLD_TYPE = 'vcc-import-source';
function payloadFromArgs(args) {
  if (Array.isArray(args)) return args[0] && typeof args[0] === 'object' ? args[0] : {};
  return args && typeof args === 'object' ? args : {};
}

async function buildVccImportArchiveHandoffFiles(args, batchContext) {
  if (batchContext.moduleId !== VCC_ARCHIVE_MODULE_ID
      || batchContext.taskKey !== VCC_IMPORT_SOURCE_OPERATION) {
    throw new Error('VCC 导入耐久接管上下文与任务身份不一致');
  }
  const payload = payloadFromArgs(args);
  const selectedFiles = Array.isArray(payload.files) ? payload.files : [];
  if (selectedFiles.length === 0) throw new Error('VCC 导入耐久接管缺少输入文件');
  const hashedFiles = await hashSourceFiles(selectedFiles);
  const ordinals = new Map();
  return Object.freeze(hashedFiles.map((file) => {
    const sourceType = String(file.sourceType || '');
    if (!sourceType) throw new Error('VCC 导入耐久接管缺少来源类型');
    const sourceOrdinal = (ordinals.get(sourceType) || 0) + 1;
    ordinals.set(sourceType, sourceOrdinal);
    return Object.freeze({
      filePath: file.filePath,
      role: 'input',
      originalName: file.fileName,
      expectedSha256: file.sha256,
      expectedSizeBytes: file.sizeBytes,
      metadata: Object.freeze({
        vccImportHandoffVersion: 1,
        vccTaskRunId: batchContext.taskRunId,
        vccImportBatchId: batchContext.taskRunId,
        vccSourceType: sourceType,
        vccSourceOrdinal: sourceOrdinal
      })
    });
  }));
}

function tableHasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((row) => row.name === columnName);
}

function activeReferenceCounts(db) {
  const branches = [];
  for (const tableName of [
    'vcc_fin_op_effective_raw_fallback',
    'vcc_fin_op_effective_rows',
    'vcc_fin_op_system_snapshots'
  ]) {
    if (!tableHasColumn(db, tableName, 'import_source_id')) continue;
    branches.push(`
      SELECT import_source_id, COUNT(*) AS reference_count
      FROM ${tableName}
      WHERE import_source_id IS NOT NULL
      GROUP BY import_source_id
    `);
  }
  if (branches.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT import_source_id, SUM(reference_count) AS reference_count
    FROM (${branches.join('\nUNION ALL\n')})
    GROUP BY import_source_id
  `).all();
  return new Map(rows.map((row) => [
    Number(row.import_source_id),
    Number(row.reference_count) || 0
  ]));
}

function holdIdentity(sourceId, artifactId) {
  return {
    artifactId,
    ownerModule: VCC_ARCHIVE_MODULE_ID,
    ownerType: VCC_IMPORT_HOLD_TYPE,
    ownerId: String(sourceId)
  };
}

function markSourceFailure(db, source, code, message) {
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'failed', last_error_code = ?, last_error_message = ?,
        updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(String(code || 'archive-binding-failed'), String(message || '输入文件存档绑定失败'), source.id);
  vccRepository.refreshImportRecordArchiveState(db, source.import_record_id);
}

function markReadySourceUnavailable(db, source) {
  db.prepare(`
    UPDATE vcc_fin_op_import_sources
    SET archive_state = 'unavailable',
        last_error_code = 'archive-artifact-unavailable',
        last_error_message = '已绑定的输入文件存档已不存在',
        updated_at = datetime('now', 'localtime')
    WHERE id = ? AND archive_state = 'ready'
  `).run(Number(source.id));
  vccRepository.refreshImportRecordArchiveState(db, Number(source.import_record_id));
}

function bindReadyArtifact(db, archiveRepository, source, artifact, options = {}) {
  const metadata = artifact.metadata && typeof artifact.metadata === 'object'
    ? artifact.metadata
    : {};
  const blob = artifact.blob;
  const directSourceId = Number(metadata.vccImportSourceId);
  const directIdentity = Number.isSafeInteger(directSourceId) && directSourceId > 0;
  const identityExact = directIdentity
    ? Number(metadata.vccImportRecordId) === Number(source.import_record_id)
      && directSourceId === Number(source.id)
      && Number(metadata.vccSourceOrdinal) === Number(source.source_ordinal)
    : String(metadata.vccTaskRunId || metadata.vccImportBatchId || '') === String(source.batch_id)
      && String(metadata.vccSourceType || '') === String(source.source_type)
      && Number(metadata.vccSourceOrdinal) === Number(source.source_ordinal)
      && String(artifact.originalName || '') === String(source.source_file_name || '');
  const artifactIdentityExact = options.hasPersistedArtifactIdentity === true
    ? options.persistedArtifactIdentityExact === true
    : identityExact;
  const exact = artifactIdentityExact
    && blob
    && String(blob.sha256 || '').toLowerCase() === String(source.source_sha256).toLowerCase()
    && Number(blob.sizeBytes) === Number(source.source_size_bytes);
  if (!exact) {
    markSourceFailure(
      db,
      source,
      'archive-lineage-mismatch',
      '存档 artifact 与导入文件 SHA-256、大小或来源身份不一致'
    );
    return { bound: false, failed: true };
  }

  const referencesBeforeBinding = Number(
    options.activeReferenceCounts?.get(Number(source.id))
  ) || 0;
  let released = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const deletedFallbacks = Number(db.prepare(`
      DELETE FROM vcc_fin_op_effective_raw_fallback WHERE import_source_id = ?
    `).run(Number(source.id)).changes) || 0;
    const remainingReferences = Math.max(0, referencesBeforeBinding - deletedFallbacks);
    if (options.activeReferenceCounts
        && typeof options.activeReferenceCounts.set === 'function') {
      options.activeReferenceCounts.set(Number(source.id), remainingReferences);
    }
    if (remainingReferences > 0) {
      archiveRepository.addArtifactHold(Number(artifact.id), {
        ...holdIdentity(source.id, artifact.id),
        reason: `VCC 当前有效数据引用导入来源 ${source.id}`
      });
    } else {
      released = archiveRepository.releaseArtifactHold(holdIdentity(source.id, artifact.id));
    }
    db.prepare(`
      UPDATE vcc_fin_op_import_sources
      SET archive_artifact_id = ?, archive_state = 'ready',
          last_error_code = NULL, last_error_message = NULL,
          bound_at = COALESCE(bound_at, datetime('now', 'localtime')),
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(Number(artifact.id), Number(source.id));
    vccRepository.refreshImportRecordArchiveState(db, Number(source.import_record_id));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve primary */ }
    throw error;
  }
  return { bound: true, failed: false, released };
}

function reconcileVccImportArchiveLineage({ db, archiveRepository }) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('VCC archive lineage 缺少主数据库');
  if (!archiveRepository
      || typeof archiveRepository.listArtifactsBySourceOperation !== 'function'
      || typeof archiveRepository.addArtifactHold !== 'function') {
    return Object.freeze({ available: false, bound: 0, failed: 0, pending: 0, released: 0 });
  }
  const sources = db.prepare(`
    SELECT source.*, record.batch_id, record.source_type
    FROM vcc_fin_op_import_sources AS source
    JOIN vcc_fin_op_import_records AS record ON record.id = source.import_record_id
    ORDER BY source.id
  `).all();
  const referenceCounts = activeReferenceCounts(db);
  const sourceById = new Map(sources.map((source) => [Number(source.id), source]));
  const sourceByHandoffIdentity = new Map(sources.map((source) => [
    [source.batch_id, source.source_type, source.source_ordinal].join('\u0000'),
    source
  ]));
  const artifacts = archiveRepository.listArtifactsBySourceOperation(
    VCC_ARCHIVE_MODULE_ID,
    VCC_IMPORT_SOURCE_OPERATION
  );
  const artifactBySource = new Map();
  const duplicateSourceIds = new Set();
  const persistedArtifactIdentityExact = new Set();
  const persistedArtifactSourceIds = new Set();
  for (const source of sources) {
    const artifactId = Number(source.archive_artifact_id);
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) continue;
    persistedArtifactSourceIds.add(Number(source.id));
    const artifact = archiveRepository.getArtifact(artifactId);
    if (!artifact) continue;
    artifactBySource.set(Number(source.id), artifact);
    const batch = archiveRepository.getBatch(artifact.batchId);
    if (batch
        && batch.taskRunId === source.batch_id
        && artifact.sourceOperation === VCC_IMPORT_SOURCE_OPERATION) {
      persistedArtifactIdentityExact.add(Number(source.id));
    }
  }
  for (const artifact of artifacts) {
    const metadata = artifact && artifact.metadata && typeof artifact.metadata === 'object'
      ? artifact.metadata
      : {};
    const directSourceId = Number(metadata.vccImportSourceId);
    let source = Number.isSafeInteger(directSourceId) && directSourceId > 0
      ? sourceById.get(directSourceId)
      : null;
    if (!source && !(Number.isSafeInteger(directSourceId) && directSourceId > 0)) {
      source = sourceByHandoffIdentity.get([
        metadata.vccTaskRunId || metadata.vccImportBatchId || '',
        metadata.vccSourceType || '',
        metadata.vccSourceOrdinal
      ].join('\u0000'));
    }
    if (!source) continue;
    const sourceId = Number(source.id);
    if (persistedArtifactSourceIds.has(sourceId)) continue;
    if (artifactBySource.has(sourceId)) duplicateSourceIds.add(sourceId);
    else artifactBySource.set(sourceId, artifact);
  }

  let bound = 0;
  let failed = 0;
  let pending = 0;
  let released = 0;
  for (const source of sources) {
    const sourceId = Number(source.id);
    if (duplicateSourceIds.has(sourceId)) {
      markSourceFailure(db, source, 'archive-lineage-ambiguous', '同一导入来源匹配到多个存档 artifact');
      failed += 1;
      continue;
    }
    const artifact = artifactBySource.get(sourceId);
    if (!artifact) {
      if (source.archive_state === 'ready' && source.archive_artifact_id != null) {
        markReadySourceUnavailable(db, source);
      }
      pending += 1;
      continue;
    }
    if (artifact.status !== 'ready') {
      if (artifact.status === 'failed') {
        markSourceFailure(
          db,
          source,
          artifact.lastErrorCode || 'archive-write-failed',
          artifact.lastErrorMessage || '输入文件存档失败'
        );
        failed += 1;
      } else {
        pending += 1;
      }
      continue;
    }
    const result = bindReadyArtifact(db, archiveRepository, source, artifact, {
      hasPersistedArtifactIdentity: persistedArtifactSourceIds.has(sourceId),
      persistedArtifactIdentityExact: persistedArtifactIdentityExact.has(sourceId),
      activeReferenceCounts: referenceCounts
    });
    if (result.bound) bound += 1;
    if (result.failed) failed += 1;
    if (result.released) released += 1;
  }

  for (const hold of archiveRepository.listArtifactHoldsByOwner(
    VCC_ARCHIVE_MODULE_ID,
    VCC_IMPORT_HOLD_TYPE
  )) {
    const sourceId = Number(hold.ownerId);
    const source = sourceById.get(sourceId);
    if (!source || (Number(referenceCounts.get(sourceId)) || 0) === 0) {
      if (archiveRepository.releaseArtifactHold(holdIdentity(sourceId, hold.artifactId))) released += 1;
    }
  }
  return Object.freeze({ available: true, bound, failed, pending, released });
}

function listActiveVccImportArchiveBatches(archiveRepository) {
  if (!archiveRepository || typeof archiveRepository.listBatches !== 'function') {
    throw new TypeError('VCC 导入恢复缺少 ArchiveRepository.listBatches');
  }
  const active = [];
  for (let offset = 0;; offset += 1000) {
    const page = archiveRepository.listBatches({
      moduleId: VCC_ARCHIVE_MODULE_ID,
      limit: 1000,
      offset
    });
    for (const batch of page) {
      if (batch.taskKey === VCC_IMPORT_SOURCE_OPERATION
          && ['reserved', 'running'].includes(batch.taskStatus)) {
        active.push(batch);
      }
    }
    if (page.length < 1000) break;
  }
  return active;
}

function terminalOutcomeForImportBatch(importBatch) {
  if (!importBatch) return null;
  const status = String(importBatch.status || '');
  if (status === 'success' || status === 'completed_with_errors') {
    return {
      taskStatus: 'succeeded',
      code: '',
      message: '',
      metadata: {
        recoveredVccImport: true,
        vccImportBatchId: String(importBatch.id),
        targetMonth: String(importBatch.target_month || ''),
        importStatus: status
      }
    };
  }
  if (status === 'failed') {
    return {
      taskStatus: 'failed',
      code: 'VCC_IMPORT_RECOVERED_FAILED',
      message: String(importBatch.error_message || 'VCC 导入失败'),
      metadata: {
        recoveredVccImport: true,
        vccImportBatchId: String(importBatch.id),
        targetMonth: String(importBatch.target_month || ''),
        importStatus: status
      }
    };
  }
  return null;
}

function batchContextFromArchiveBatch(batch) {
  return freezeWorkerBatchContext({
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    taskRunId: batch.taskRunId,
    taskKey: batch.taskKey,
    moduleId: batch.moduleId,
    parentRunId: batch.parentRunId,
    operationKey: batch.operationKey
  }, { required: true });
}

function recoverableVccImportBatches({ db, archiveRepository }) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('VCC 导入恢复缺少主数据库');
  return listActiveVccImportArchiveBatches(archiveRepository).flatMap((archiveBatch) => {
    const importBatch = vccRepository.getImportBatch(db, archiveBatch.taskRunId);
    const terminalOutcome = terminalOutcomeForImportBatch(importBatch);
    return terminalOutcome ? [{ archiveBatch, terminalOutcome }] : [];
  });
}

function listRecoverableVccImportArchiveBatchIds(options) {
  return recoverableVccImportBatches(options).map(({ archiveBatch }) => Number(archiveBatch.id));
}

function recoverVccImportArchiveTasks({ db, archiveRepository, archiveCenter }) {
  if (!archiveCenter || typeof archiveCenter.persistTaskTerminalIntent !== 'function') {
    throw new TypeError('VCC 导入恢复缺少 ArchiveCenter terminal outbox');
  }
  const recoveredBatchIds = [];
  try {
    for (const { archiveBatch, terminalOutcome } of recoverableVccImportBatches({
      db,
      archiveRepository
    })) {
      const batchContext = batchContextFromArchiveBatch(archiveBatch);
      const manifestOwned = Boolean(
        archiveBatch.metadata && archiveBatch.metadata._fileManifest
      );
      const persisted = archiveCenter.persistTaskTerminalIntent({
        ...(manifestOwned
          ? {
              owner: {
                version: 1,
                kind: 'file-batch',
                batchContext
              }
            }
          : { batchContext }),
        sourceOperation: VCC_IMPORT_SOURCE_OPERATION,
        terminalOutcome
      });
      if (!persisted || persisted.persisted !== true) {
        throw new Error(`VCC 导入批次 ${archiveBatch.id} 未形成耐久终态意图`);
      }
      recoveredBatchIds.push(Number(archiveBatch.id));
    }
  } catch (error) {
    error.blocksArchiveStartup = true;
    throw error;
  }
  return Object.freeze({ recovered: recoveredBatchIds.length, batchIds: recoveredBatchIds });
}

function reconcileVccImportArchiveLineageAtStartup({ db, archiveRepository }) {
  const result = reconcileVccImportArchiveLineage({ db, archiveRepository });
  if (!result.available) {
    const error = new Error('VCC 导入 Archive lineage 当前不可核验');
    error.code = 'VCC_ARCHIVE_LINEAGE_UNAVAILABLE';
    throw error;
  }
  const unsettledBatchIds = listRecoverableVccImportArchiveBatchIds({ db, archiveRepository });
  if (unsettledBatchIds.length > 0) {
    const error = new Error(
      `VCC 导入任务终态仍未完成耐久重放：${unsettledBatchIds.join('、')}`
    );
    error.code = 'VCC_ARCHIVE_TERMINAL_REPLAY_PENDING';
    error.batchIds = unsettledBatchIds;
    throw error;
  }
  return result;
}

module.exports = {
  VCC_IMPORT_HOLD_TYPE,
  VCC_IMPORT_SOURCE_OPERATION,
  buildVccImportArchiveHandoffFiles,
  activeReferenceCounts,
  listRecoverableVccImportArchiveBatchIds,
  recoverVccImportArchiveTasks,
  reconcileVccImportArchiveLineageAtStartup,
  reconcileVccImportArchiveLineage
};
