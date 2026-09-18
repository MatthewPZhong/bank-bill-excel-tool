'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository,
  ensureArchiveMetadataSupport,
  formatBatchNumber
} = require('../../../../src/backend/database/archive-repository');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function createFixture() {
  let currentTime = new Date('2026-07-20T12:00:00.000Z');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const repository = createArchiveRepository(db, {
    now: () => currentTime
  });
  repository.ensureSchema();
  return {
    db,
    repository,
    setTime(value) {
      currentTime = new Date(value);
    }
  };
}

function createBatch(repository, overrides = {}) {
  return repository.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: `operation-${Math.random()}`,
    localDate: '2026-07-20',
    retentionUntil: '2026-10-18',
    ...overrides
  });
}

function addArtifact(repository, batchId, overrides = {}) {
  return repository.addArtifact(batchId, {
    artifactKey: `artifact-${Math.random()}`,
    direction: 'input',
    role: 'source-file',
    sourceOperation: 'import',
    originalName: 'source.xlsx',
    sourcePath: '/private/source.xlsx',
    ...overrides
  });
}

function completeLayout(repository, artifact, overrides = {}) {
  const batch = repository.getBatch(artifact.batchId);
  const safeFileName = overrides.safeFileName || artifact.originalName;
  return repository.completeMaterialization(artifact.id, {
    storageMode: overrides.storageMode || 'copy',
    storageRelativePath: overrides.storageRelativePath
      || `${batch.localDate.slice(0, 4)}/${batch.localDate.slice(0, 7)}/${batch.localDate}/${batch.batchNumber}/${safeFileName}`,
    safeFileName,
    artifactOrder: artifact.artifactOrder,
    storageFingerprint: overrides.storageFingerprint || {
      sizeBytes: artifact.blob.sizeBytes,
      mtimeMs: 1,
      ctimeMs: 1,
      ino: '1'
    }
  });
}

function ensureAppSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}

test('archive instance ID conflict-safe get-or-create，root switch 与全部 ready mode 同事务提交', () => {
  const { db, repository } = createFixture();
  try {
    ensureAppSettings(db);
    const firstInstanceId = repository.getOrCreateArchiveInstanceId();
    const secondInstanceId = repository.getOrCreateArchiveInstanceId();
    assert.equal(secondInstanceId, firstInstanceId);
    assert.match(firstInstanceId, /^[0-9a-f-]{36}$/);

    const batch = createBatch(repository, { operationKey: 'storage-root-switch' }).batch;
    const artifact = addArtifact(repository, batch.id, { artifactKey: 'storage-root-artifact' });
    repository.startArtifactAttempt(artifact.id);
    const completed = repository.completeArtifact(artifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    const layout = completeLayout(repository, completed.artifact, { storageMode: 'hardlink' });
    repository.recordMaterializationFailure(layout.artifact.id, {
      code: 'ARCHIVE_MATERIALIZATION_FAILED',
      message: '目标模式待提交'
    });
    const before = repository.getArtifact(artifact.id);

    const switched = repository.commitStorageRootSwitch({
      storageRoot: '/new/archive',
      expectedStoredRoot: null,
      materializations: [{
        artifactId: artifact.id,
        storageMode: 'copy',
        storageFingerprint: { sizeBytes: 5, mtimeMs: 2, ctimeMs: 2, ino: '2' }
      }],
      blobFingerprints: [{ blobId: before.blob.id,
        fingerprint: { sizeBytes: 5, mtimeMs: 3, ctimeMs: 3, ino: '300' } }]
    });
    const after = repository.getArtifact(artifact.id);
    assert.equal(switched.materializedArtifactCount, 1);
    assert.equal(db.prepare(`
      SELECT setting_value FROM app_settings
      WHERE setting_key = 'archive_center_storage_root'
    `).get().setting_value, '/new/archive');
    assert.equal(after.storageMode, 'copy');
    assert.equal(after.storageRelativePath, before.storageRelativePath);
    assert.equal(after.safeFileName, before.safeFileName);
    assert.equal(after.artifactOrder, before.artifactOrder);
    assert.equal(after.blob.sha256, before.blob.sha256);
    assert.deepEqual(after.blob.fingerprint, { sizeBytes: 5, mtimeMs: 3, ctimeMs: 3, ino: '300' });
    assert.equal(after.materializationErrorCode, '');

    assert.throws(() => repository.commitStorageRootSwitch({
      storageRoot: '/incomplete/archive', expectedStoredRoot: '/new/archive',
      materializations: [{ artifactId: artifact.id, storageMode: 'copy',
        storageFingerprint: { sizeBytes: 5, mtimeMs: 4, ctimeMs: 4, ino: '400' } }],
      blobFingerprints: []
    }), { code: 'ARCHIVE_STORAGE_BLOB_FINGERPRINT_INCOMPLETE' });
    assert.equal(repository.getArtifact(artifact.id).storageFingerprint.ino, '2');
    assert.equal(repository.findBlobByHash(HASH_A).fingerprint.ino, '300');

    assert.throws(() => repository.commitStorageRootSwitch({
      storageRoot: '/third/archive',
      expectedStoredRoot: '/stale/archive',
      materializations: [{
        artifactId: artifact.id,
        storageMode: 'hardlink',
        storageFingerprint: { sizeBytes: 5, mtimeMs: 3, ctimeMs: 3, ino: '3' }
      }]
    }), (error) => error.code === 'ARCHIVE_STORAGE_ROOT_CONFLICT');
    assert.equal(repository.getArtifact(artifact.id).storageMode, 'copy');
  } finally {
    db.close();
  }
});

test('目录化候选以 artifact id 游标分页，不受单次 5000 上限截断', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: 'materialization-pages' }).batch;
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const sha256 = String.fromCharCode(97 + index).repeat(64);
      const artifact = addArtifact(repository, batch.id, {
        artifactKey: `materialization-page-${index}`,
        originalName: `page-${index}.xlsx`
      });
      repository.startArtifactAttempt(artifact.id);
      repository.completeArtifact(artifact.id, {
        sha256,
        sizeBytes: index + 1,
        relativePath: `blobs/sha256/${index}/${sha256}`,
        fingerprint: { sizeBytes: index + 1, mtimeMs: 1, ctimeMs: 1, ino: '1' }
      });
      ids.push(artifact.id);
    }

    const first = repository.listMaterializationCandidates(2, 0);
    const second = repository.listMaterializationCandidates(2, first.at(-1).id);
    assert.deepEqual([...first, ...second].map((artifact) => artifact.id), ids);
    assert.equal(repository.countMaterializationCandidates(), 3);
    completeLayout(repository, first[0]);
    assert.equal(repository.countMaterializationCandidates(), 2);
    assert.deepEqual(
      repository.listMaterializedArtifactsPage(1, 0).map((artifact) => artifact.id),
      [first[0].id]
    );
    assert.equal(repository.countMaterializedArtifactsAfter(0), 1);
    assert.equal(repository.countMaterializedArtifactsAfter(first[0].id), 0);
    assert.throws(
      () => repository.listMaterializationCandidates(2, -1),
      /afterArtifactId/
    );
    assert.throws(
      () => repository.listMaterializedArtifactsPage(1, -1),
      /afterArtifactId/
    );
    assert.throws(
      () => repository.countMaterializedArtifactsAfter(-1),
      /afterArtifactId/
    );
  } finally {
    db.close();
  }
});

test('任务恢复复用原批次身份，running/failed/cancelled 可重开而 succeeded 闭锁', () => {
  const { db, repository } = createFixture();
  try {
    const reserved = repository.reserveTaskBatch({
      moduleId: 'acquiring-bill-currency',
      moduleCode: 'ACQUIRING',
      moduleName: '收单账单币种检查',
      operationKey: 'run:2026-04:101',
      taskKey: 'acquiringBillCurrency:run',
      taskRunId: 'task-run-101',
      parentRunId: 'parent-run-101'
    });
    const context = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: reserved.batch.taskRunId,
      taskKey: reserved.batch.taskKey,
      moduleId: reserved.batch.moduleId,
      parentRunId: reserved.batch.parentRunId,
      operationKey: reserved.batch.operationKey
    };

    repository.transitionTaskStatus(context.batchId, 'running', { expectedStatuses: ['reserved'] });
    const fromRunning = repository.beginTaskRecovery(context, { evidence: { runId: 101 } });
    assert.equal(fromRunning.status, 'reopened');
    assert.equal(fromRunning.batch.taskStatus, 'running');
    assert.deepEqual(fromRunning.batch.metadata.recovery, {
      previousTaskStatus: 'running',
      previousFailureCode: '',
      previousFailureMessage: '',
      previousFinishedAt: null,
      recoveryCount: 1,
      evidence: { runId: 101 }
    });

    repository.transitionTaskStatus(context.batchId, 'failed', {
      expectedStatuses: ['running'],
      failureCode: 'WORKER_CRASH',
      failureMessage: 'worker exited'
    });
    const failedEvidence = repository.getBatch(context.batchId);
    const fromFailed = repository.beginTaskRecovery(context, { evidence: { runId: 101 } });
    assert.equal(fromFailed.batch.taskStatus, 'running');
    assert.equal(fromFailed.batch.metadata.recovery.previousTaskStatus, 'failed');
    assert.equal(fromFailed.batch.metadata.recovery.previousFailureCode, 'WORKER_CRASH');
    assert.equal(fromFailed.batch.metadata.recovery.previousFailureMessage, 'worker exited');
    assert.equal(fromFailed.batch.metadata.recovery.previousFinishedAt, failedEvidence.finishedAt);
    assert.equal(fromFailed.batch.metadata.recovery.recoveryCount, 2);

    repository.transitionTaskStatus(context.batchId, 'cancelled', { expectedStatuses: ['running'] });
    const fromCancelled = repository.beginTaskRecovery(context, { evidence: { runId: 101 } });
    assert.equal(fromCancelled.batch.taskStatus, 'running');
    assert.equal(fromCancelled.batch.metadata.recovery.previousTaskStatus, 'cancelled');
    assert.equal(fromCancelled.batch.metadata.recovery.recoveryCount, 3);

    const identityConflict = repository.beginTaskRecovery({ ...context, operationKey: 'forged' });
    assert.equal(identityConflict.status, 'identity-conflict');
    assert.equal(identityConflict.mismatchedField, 'operationKey');

    repository.transitionTaskStatus(context.batchId, 'succeeded', { expectedStatuses: ['running'] });
    const succeededConflict = repository.beginTaskRecovery(context);
    assert.equal(succeededConflict.status, 'succeeded-conflict');
    assert.equal(succeededConflict.batch.taskStatus, 'succeeded');
    assert.equal(repository.getLatestIssuedBatch().batchId, context.batchId, '恢复未分配新批次/流水');
    assert.equal(repository.listBatches().length, 1);
  } finally {
    db.close();
  }
});

test('新 File Task 仅按 exact owner + manifest 将 interrupted 原子恢复，终态不复活且不发新号', () => {
  const { db, repository } = createFixture();
  try {
    const taskRun = repository.beginTaskRun({
      taskRunId: 'file-task-recovery-1',
      moduleId: 'acquiring-bill-currency',
      taskKey: 'acquiringBillCurrency:run:resume',
      operationKey: 'acquiring-resume:1',
      parentRunId: 'parent-acquiring-1'
    }).taskRun;
    const manifest = {
      version: 1,
      identity: 'manifest-acquiring-1',
      inputs: [],
      outputs: [{
        artifactKey: 'output-key-1',
        direction: 'output',
        role: 'output',
        sourceOperation: 'acquiringBillCurrency:run',
        originalName: 'diff.xlsx',
        filePath: '/private/diff.xlsx',
        aliasKey: '/private/diff.xlsx',
        targetSnapshot: { existed: false, snapshot: null }
      }]
    };
    const reserved = repository.reserveFileTaskBatch({
      taskRun,
      manifest,
      moduleCode: 'ACQUIRING',
      moduleName: '收单单据币种校验',
      metadata: {}
    });
    const context = {
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: reserved.batch.taskRunId,
      taskKey: reserved.batch.taskKey,
      moduleId: reserved.batch.moduleId,
      parentRunId: reserved.batch.parentRunId,
      operationKey: reserved.batch.operationKey
    };
    const issuanceBefore = repository.getLatestIssuedBatch();

    const preStartContinuation = repository.beginFileTaskRecovery(context, {
      manifestIdentity: manifest.identity
    });
    assert.equal(preStartContinuation.status, 'unchanged');
    assert.equal(preStartContinuation.taskRun.status, 'prepared');
    assert.equal(preStartContinuation.batch.taskStatus, 'reserved');
    repository.startFileTask(taskRun.taskRunId, reserved.batch.id);

    repository.markInterruptedTasks();
    const conflict = repository.beginFileTaskRecovery(context, {
      manifestIdentity: 'forged-manifest'
    });
    assert.equal(conflict.status, 'manifest-conflict');
    assert.equal(repository.getTaskRun(taskRun.taskRunId).status, 'interrupted');

    const recovered = repository.beginFileTaskRecovery(context, {
      manifestIdentity: manifest.identity
    });
    assert.equal(recovered.status, 'reopened');
    assert.equal(recovered.taskRun.status, 'running');
    assert.equal(recovered.batch.taskStatus, 'running');
    assert.equal(repository.getLatestIssuedBatch().batchId, issuanceBefore.batchId);
    assert.equal(repository.listBatches().length, 1);

    repository.finishFileTask(taskRun.taskRunId, reserved.batch.id, {
      taskStatus: 'cancelled',
      code: 'ARCHIVE_TASK_CANCELLED',
      message: 'cancelled'
    });
    const terminal = repository.beginFileTaskRecovery(context, {
      manifestIdentity: manifest.identity
    });
    assert.equal(terminal.status, 'status-conflict');
    assert.equal(terminal.taskRun.status, 'cancelled');
  } finally {
    db.close();
  }
});

test('启动恢复把崩溃遗留 reserved/running 批次终结为 failed，终态批次保持不变', () => {
  const { db, repository } = createFixture();
  try {
    const reserve = (suffix) => repository.reserveTaskBatch({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: `startup-interrupted-${suffix}`,
      taskKey: 'bank-statement:run',
      taskRunId: `task-${suffix}`,
      parentRunId: `parent-${suffix}`
    }).batch;
    const reserved = reserve('reserved');
    const running = reserve('running');
    const succeeded = reserve('succeeded');
    repository.transitionTaskStatus(running.id, 'running', { expectedStatuses: ['reserved'] });
    repository.transitionTaskStatus(succeeded.id, 'succeeded', { expectedStatuses: ['reserved'] });

    const excluded = repository.markInterruptedTasks({ excludeBatchIds: [running.id] });
    assert.deepEqual(excluded.batchIds, [reserved.id]);
    assert.equal(excluded.taskCount, 1);
    assert.equal(repository.getBatch(running.id).taskStatus, 'running');
    const recovered = repository.markInterruptedTasks();
    assert.deepEqual(recovered.batchIds, [running.id]);
    assert.equal(recovered.taskCount, 1);
    for (const id of recovered.batchIds) {
      const batch = repository.getBatch(id);
      assert.equal(batch.taskStatus, 'failed');
      assert.equal(batch.failureCode, 'ARCHIVE_TASK_INTERRUPTED');
      assert.ok(batch.finishedAt);
    }
    assert.equal(repository.getBatch(succeeded.id).taskStatus, 'succeeded');
    assert.deepEqual(repository.markInterruptedTasks(), {
      taskCount: 0,
      batchIds: [],
      taskRunIds: []
    });
  } finally {
    db.close();
  }
});

test('latest issuance 保留已删除批次号与 ID，live status 删除后严格为空且下一号不复用', () => {
  const { db, repository } = createFixture();
  try {
    const first = repository.reserveTaskBatch({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'latest-deleted-1',
      taskKey: 'statement:generate',
      taskRunId: 'latest-deleted-run-1',
      parentRunId: 'latest-deleted-parent-1'
    });
    repository.transitionTaskStatus(first.batch.id, 'failed', {
      expectedStatuses: ['reserved'],
      failureCode: 'EXPECTED_FAILURE'
    });
    assert.equal(repository.getLatestIssuedBatch().taskStatus, 'failed');

    const deleted = repository.deleteBatch(first.batch.id);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual(repository.getLatestIssuedBatch(), {
      batchId: first.batch.id,
      batchNumber: first.batch.batchNumber,
      localDate: '2026-07-20',
      dailySequence: 1,
      globalDailySequence: 1,
      issuedAt: first.batch.reservedAt,
      taskStatus: null
    });

    const second = repository.reserveTaskBatch({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'latest-deleted-2',
      taskKey: 'statement:generate',
      taskRunId: 'latest-deleted-run-2',
      parentRunId: 'latest-deleted-parent-2'
    });
    assert.equal(second.batch.batchNumber, '2026-07-20-002');
  } finally {
    db.close();
  }
});

test('建表幂等，批次按模块代码和本地日期生成独立流水号', () => {
  const fixture = createFixture();
  const { db, repository } = fixture;
  try {
    const first = createBatch(repository, { operationKey: 'same-operation' });
    const second = createBatch(repository, { operationKey: 'second-operation' });
    const idempotent = createBatch(repository, { operationKey: 'same-operation' });
    const otherModule = createBatch(repository, {
      moduleId: 'duplicate-inbound',
      moduleCode: 'DUP',
      moduleName: '重复入金',
      operationKey: 'duplicate-operation'
    });
    const nextDate = createBatch(repository, {
      operationKey: 'next-date-operation',
      localDate: '2026-07-21',
      retentionUntil: '2026-10-19'
    });

    assert.equal(first.created, true);
    assert.equal(first.batch.batchNumber, 'BANK-20260720-001');
    assert.equal(first.batch.dailySequence, 1);
    assert.equal(second.batch.batchNumber, 'BANK-20260720-002');
    assert.equal(otherModule.batch.batchNumber, 'DUP-20260720-001');
    assert.equal(nextDate.batch.batchNumber, 'BANK-20260721-001');
    assert.equal(idempotent.created, false);
    assert.equal(idempotent.batch.id, first.batch.id);
    assert.equal(repository.listBatches().length, 4);

    assert.doesNotThrow(() => ensureArchiveMetadataSupport(db));
    assert.equal(repository.getBatch(first.batch.id).batchNumber, 'BANK-20260720-001');
    assert.equal(formatBatchNumber('mpt', '2026-07-20', 12), 'MPT-20260720-012');

    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'archive_%'
    `).all().map((row) => row.name));
    assert.deepEqual(
      [...tables].sort(),
      [
        'archive_artifact_holds',
        'archive_artifacts',
        'archive_batch_sequences',
        'archive_batches',
        'archive_blobs',
        'archive_cleanup_jobs',
        'archive_daily_sequences',
        'archive_delete_receipts',
        'archive_file_task_owner_recovery',
        'archive_flow_anchors',
        'archive_flow_bind_intents',
        'archive_maintenance_audits',
        'archive_operation_issuances',
        'archive_owned_temporary_files',
        'archive_owner_terminal_completions',
        'archive_task_flow_bind_intents',
        'archive_task_lineage',
        'archive_task_runs'
      ]
    );
    const artifactColumns = new Set(
      db.prepare('PRAGMA table_info(archive_artifacts)').all().map((row) => row.name)
    );
    assert.equal(artifactColumns.has('materialization_error_code'), true);
    assert.equal(artifactColumns.has('materialization_error_message'), true);
    assert.equal(artifactColumns.has('materialization_failed_at'), true);
    for (const name of [
      'storage_fingerprint_size_bytes',
      'storage_fingerprint_mtime_ms',
      'storage_fingerprint_ctime_ms',
      'storage_fingerprint_ino'
    ]) assert.equal(artifactColumns.has(name), true, name);
    const blobColumns = new Set(
      db.prepare('PRAGMA table_info(archive_blobs)').all().map((row) => row.name)
    );
    for (const name of [
      'fingerprint_size_bytes',
      'fingerprint_mtime_ms',
      'fingerprint_ctime_ms',
      'fingerprint_ino'
    ]) assert.equal(blobColumns.has(name), true, name);
    assert.equal(artifactColumns.has('materialization_status'), false);
    const taskRunIndex = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_archive_batches_task_run'
    `).get();
    assert.match(taskRunIndex.sql, /ON archive_batches\(task_run_id\)/);
    assert.match(taskRunIndex.sql, /task_run_id IS NOT NULL AND task_run_id <> ''/);
    const taskRunLookupPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM archive_batches
      WHERE task_run_id IS NOT NULL
        AND task_run_id <> ''
        AND task_run_id = ?
    `).all('missing-task-run');
    assert.equal(
      taskRunLookupPlan.some((row) => String(row.detail).includes('idx_archive_batches_task_run')),
      true
    );
  } finally {
    db.close();
  }
});

test('新 Blob/目录化副本完成事务写指纹，旧 NULL Blob dedupe 不回填，半指纹 mapper 拒绝返回', () => {
  const { db, repository } = createFixture();
  try {
    const fingerprint = {
      sizeBytes: 5,
      mtimeMs: 1763597869000.25,
      ctimeMs: 1763597869001.5,
      ino: '23362423067021943'
    };
    const firstBatch = createBatch(repository, { operationKey: 'fingerprint-new' }).batch;
    const firstArtifact = addArtifact(repository, firstBatch.id, { artifactKey: 'fingerprint-new' });
    repository.startArtifactAttempt(firstArtifact.id);
    assert.throws(() => repository.completeArtifact(firstArtifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`
    }), /最终文件指纹/);
    assert.equal(repository.findBlobByHash(HASH_A), null);
    assert.equal(repository.getArtifact(firstArtifact.id).status, 'pending');
    const first = repository.completeArtifact(firstArtifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint
    });
    assert.deepEqual(first.blob.fingerprint, fingerprint);
    const materialized = completeLayout(repository, first.artifact, {
      storageFingerprint: fingerprint
    });
    assert.deepEqual(materialized.artifact.storageFingerprint, fingerprint);

    db.prepare(`
      INSERT INTO archive_blobs(sha256, size_bytes, relative_path, created_at, last_verified_at)
      VALUES (?, 5, ?, ?, ?)
    `).run(HASH_B, `blobs/sha256/bb/${HASH_B}`, '2026-07-01', '2026-07-01');
    const legacyBatch = createBatch(repository, { operationKey: 'fingerprint-legacy' }).batch;
    const legacyArtifact = addArtifact(repository, legacyBatch.id, { artifactKey: 'fingerprint-legacy' });
    repository.startArtifactAttempt(legacyArtifact.id);
    const deduped = repository.completeArtifact(legacyArtifact.id, {
      sha256: HASH_B,
      sizeBytes: 5,
      relativePath: `blobs/sha256/bb/${HASH_B}`,
      fingerprint
    });
    assert.equal(deduped.deduplicated, true);
    assert.equal(deduped.blob.fingerprint, null);

    db.prepare(`
      UPDATE archive_blobs
      SET fingerprint_size_bytes = 5, fingerprint_mtime_ms = 1,
          fingerprint_ctime_ms = NULL, fingerprint_ino = '9'
      WHERE id = ?
    `).run(first.blob.id);
    assert.equal(repository.findBlobByHash(HASH_A).fingerprint, null);
  } finally {
    db.close();
  }
});

test('VCC 有效数据 business hold 不可被用户解锁、手工删除或 retention 绕过', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, {
      operationKey: 'vcc-business-hold',
      moduleId: 'vcc-financial-op',
      moduleCode: 'VCCFINOP',
      moduleName: 'VCC财务OP校验',
      retentionUntil: '2026-07-21'
    }).batch;
    const artifact = addArtifact(repository, batch.id, {
      artifactKey: 'vcc-input',
      sourceOperation: 'vccFinancialOp:import:apply'
    });
    repository.startArtifactAttempt(artifact.id);
    repository.completeArtifact(artifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    completeLayout(repository, repository.getArtifact(artifact.id));

    const hold = repository.addArtifactHold(artifact.id, {
      ownerModule: 'vcc-financial-op',
      ownerType: 'import-source',
      ownerId: '17',
      reason: '当前有效数据仍引用该输入原表'
    });
    assert.equal(hold.artifactId, artifact.id);
    assert.equal(repository.getArtifact(artifact.id).businessHoldCount, 1);
    assert.equal(repository.getArtifact(artifact.id).businessLocked, true);
    assert.equal(repository.getBatch(batch.id).businessHoldCount, 1);
    assert.equal(repository.getBatch(batch.id).businessLocked, true);

    repository.setLocked(batch.id, true);
    repository.setLocked(batch.id, false);
    const blocked = repository.deleteBatch(batch.id, { allowLocked: true });
    assert.equal(blocked.status, 'business-held');
    assert.deepEqual(blocked.artifactIds, [artifact.id]);
    assert.equal(repository.listExpiredBatches('2026-07-22').length, 0);
    assert.ok(repository.getBatch(batch.id));

    assert.equal(repository.releaseArtifactHold({
      artifactId: artifact.id,
      ownerModule: 'vcc-financial-op',
      ownerType: 'import-source',
      ownerId: '17'
    }), true);
    assert.equal(repository.getArtifact(artifact.id).businessLocked, false);
    assert.equal(repository.getBatch(batch.id).businessLocked, false);
    assert.equal(repository.listExpiredBatches('2026-07-22').length, 1);
    assert.equal(repository.deleteBatch(batch.id, { allowLocked: true }).status, 'deleted');
  } finally {
    db.close();
  }
});

test('删除当天最大批次后流水号不复用，跨模块列表按建批先后倒序', () => {
  const { db, repository } = createFixture();
  try {
    const first = repository.createBatch({
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      localDate: '2026-07-20'
    }).batch;
    const second = repository.createBatch({
      moduleId: 'module-b',
      moduleCode: 'B',
      moduleName: '模块 B',
      localDate: '2026-07-20'
    }).batch;
    const third = repository.createBatch({
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      localDate: '2026-07-20'
    }).batch;

    assert.equal(first.batchNumber, 'A-20260720-001');
    assert.equal(second.batchNumber, 'B-20260720-001');
    assert.equal(third.batchNumber, 'A-20260720-002');
    assert.equal(repository.deleteBatch(third.id).status, 'deleted');

    const fourth = repository.createBatch({
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      localDate: '2026-07-20'
    }).batch;
    assert.equal(fourth.batchNumber, 'A-20260720-003');
    assert.deepEqual(
      repository.listBatches({ localDate: '2026-07-20' }).map((batch) => batch.id),
      [fourth.id, second.id, first.id]
    );
    assert.deepEqual(
      repository.listBatches({ batchNumberContains: '20260720-003' }).map((batch) => batch.id),
      [fourth.id]
    );
  } finally {
    db.close();
  }
});

test('artifact 共享相同 SHA-256 blob，仅最后一个引用删除时释放 blob', () => {
  const { db, repository } = createFixture();
  try {
    const firstBatch = createBatch(repository, { operationKey: 'dedup-first' }).batch;
    const secondBatch = createBatch(repository, { operationKey: 'dedup-second' }).batch;
    const firstArtifact = addArtifact(repository, firstBatch.id, { artifactKey: 'input-1' });
    const secondArtifact = addArtifact(repository, secondBatch.id, { artifactKey: 'input-2' });

    assert.equal(repository.getArtifactByKey(firstBatch.id, 'input-1').id, firstArtifact.id);
    assert.equal(repository.getArtifactByKey(firstBatch.id, 'missing'), null);

    repository.startArtifactAttempt(firstArtifact.id);
    const firstComplete = repository.completeArtifact(firstArtifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    repository.startArtifactAttempt(secondArtifact.id);
    const secondComplete = repository.completeArtifact(secondArtifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    assert.equal(firstComplete.batch.archiveStatus, 'incomplete');
    completeLayout(repository, firstComplete.artifact);
    completeLayout(repository, secondComplete.artifact);

    assert.equal(firstComplete.deduplicated, false);
    assert.equal(secondComplete.deduplicated, true);
    assert.equal(repository.getBatch(firstBatch.id).archiveStatus, 'complete');
    assert.equal(repository.findBlobByHash(HASH_A).referenceCount, 2);
    assert.deepEqual(repository.getStats(), {
      batchCount: 2,
      lockedBatchCount: 0,
      logicalFileCount: 2,
      failedFileCount: 0,
      uniqueFileCount: 1,
      uniqueBytes: 5,
      logicalBytes: 10
    });

    const firstDelete = repository.deleteBatch(firstBatch.id);
    assert.equal(firstDelete.status, 'deleted');
    assert.equal(firstDelete.releasedBlobs.length, 0);
    assert.equal(repository.findBlobByHash(HASH_A).referenceCount, 1);
    assert.deepEqual(firstDelete.cleanupJob.releasedBlobs, []);
    assert.deepEqual(firstDelete.cleanupJob.materializedPaths, [
      `2026/2026-07/2026-07-20/${firstBatch.batchNumber}/source.xlsx`
    ]);

    repository.setLocked(secondBatch.id, true);
    const lockedDelete = repository.deleteBatch(secondBatch.id);
    assert.equal(lockedDelete.status, 'locked');
    assert.ok(repository.getBatch(secondBatch.id));

    repository.setLocked(secondBatch.id, false);
    const finalDelete = repository.deleteBatch(secondBatch.id);
    assert.equal(finalDelete.status, 'deleted');
    assert.equal(finalDelete.releasedBlobs.length, 1);
    assert.equal(finalDelete.releasedBlobs[0].sha256, HASH_A);
    assert.equal(repository.findBlobByHash(HASH_A), null);
    assert.deepEqual(finalDelete.cleanupJob.releasedBlobs, [{
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      sha256: HASH_A,
      sizeBytes: 5
    }]);
    assert.equal(repository.listCleanupJobs().length, 2);
  } finally {
    db.close();
  }
});

test('Blob 元数据按 id 游标分页，供后台 ownership/完整性扫描有界推进', () => {
  const { db, repository: repo } = createFixture();
  try {
    repo.ensureSchema();
    const now = '2026-07-20T04:00:00.000Z';
    for (let index = 0; index < 3; index += 1) {
      db.prepare(`
        INSERT INTO archive_blobs(sha256, size_bytes, relative_path, created_at, last_verified_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        String(index + 1).repeat(64),
        index + 1,
        `blobs/sha256/${String(index + 1).repeat(2)}/${String(index + 1).repeat(64)}`,
        now,
        now
      );
    }
    const first = repo.listBlobsPage(2, 0);
    assert.deepEqual(first.map((blob) => blob.id), [1, 2]);
    assert.deepEqual(repo.listBlobsPage(2, first[1].id).map((blob) => blob.id), [3]);
    assert.equal(repo.countBlobsAfter(0), 3);
    assert.equal(repo.countBlobsAfter(2), 1);
  } finally {
    db.close();
  }
});

test('统计大小只累计 ready artifact 引用，failed/pending 即使残留 blob 引用也不计', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: 'stats-ready-only' }).batch;
    const artifacts = ['ready', 'failed', 'pending'].map((status) => {
      const artifact = addArtifact(repository, batch.id, { artifactKey: `stats-${status}` });
      repository.startArtifactAttempt(artifact.id);
      const completed = repository.completeArtifact(artifact.id, {
        sha256: HASH_A,
        sizeBytes: 5,
        relativePath: `blobs/sha256/aa/${HASH_A}`,
        fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
      });
      completeLayout(repository, completed.artifact);
      return completed.artifact;
    });
    db.prepare("UPDATE archive_artifacts SET status = 'failed' WHERE id = ?").run(artifacts[1].id);
    db.prepare("UPDATE archive_artifacts SET status = 'pending' WHERE id = ?").run(artifacts[2].id);

    const stats = repository.getStats();
    assert.equal(stats.batchCount, 1);
    assert.equal(stats.logicalBytes, 5);
    assert.equal(stats.failedFileCount, 1);
  } finally {
    db.close();
  }
});

test('失败和重试保留累计元数据，最终完成后恢复批次完成态', () => {
  const fixture = createFixture();
  const { db, repository, setTime } = fixture;
  try {
    const batch = createBatch(repository, { operationKey: 'retry-operation' }).batch;
    const artifact = addArtifact(repository, batch.id, { artifactKey: 'retry-file' });

    const interrupted = repository.markInterruptedArtifacts();
    assert.equal(interrupted.artifactCount, 1);
    assert.equal(repository.getArtifact(artifact.id).status, 'failed');
    assert.equal(repository.getBatch(batch.id).failureCount, 1);
    assert.deepEqual(repository.listUnresolvedArtifactSourcePaths(), ['/private/source.xlsx']);

    setTime('2026-07-20T12:01:00.000Z');
    repository.beginBatchRetry(batch.id);
    repository.startArtifactAttempt(artifact.id, { sourcePath: '/private/retry.xlsx' });
    const failed = repository.failArtifact(artifact.id, {
      code: 'ARCHIVE_EBUSY',
      message: '文件暂时被占用',
      sourceOperation: 'export'
    });
    assert.equal(failed.artifact.attemptCount, 1);
    assert.equal(failed.batch.failureCount, 2);
    assert.equal(failed.batch.retryCount, 1);
    assert.equal(failed.batch.archiveStatus, 'incomplete');
    assert.equal(failed.batch.lastFailedOperation, 'export');

    setTime('2026-07-20T12:02:00.000Z');
    repository.beginBatchRetry(batch.id);
    repository.startArtifactAttempt(artifact.id);
    const completed = repository.completeArtifact(artifact.id, {
      sha256: HASH_B,
      sizeBytes: 8,
      relativePath: `blobs/sha256/bb/${HASH_B}`,
      fingerprint: { sizeBytes: 8, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });

    assert.equal(completed.artifact.status, 'ready');
    assert.equal(completed.artifact.attemptCount, 2);
    assert.equal(completed.batch.archiveStatus, 'incomplete');
    const repairPending = repository.recordMaterializationFailure(completed.artifact.id, {
      code: 'ARCHIVE_MATERIALIZATION_FAILED',
      message: '目录暂不可写'
    });
    assert.equal(repairPending.artifact.status, 'ready');
    assert.equal(repairPending.artifact.blob.sha256, HASH_B);
    assert.equal(repairPending.artifact.materializationErrorCode, 'ARCHIVE_MATERIALIZATION_FAILED');
    const materialized = completeLayout(repository, completed.artifact);
    assert.equal(materialized.batch.archiveStatus, 'complete');
    assert.equal(materialized.artifact.materializationErrorCode, '');
    assert.equal(materialized.batch.failureCount, 3);
    assert.equal(materialized.batch.retryCount, 2);
    assert.equal(materialized.batch.lastErrorCode, '');
    assert.deepEqual(repository.listUnresolvedArtifactSourcePaths(), []);
  } finally {
    db.close();
  }
});

test('cleanup job 插入与批次/artifact/最后引用 Blob 删除同事务回滚', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: 'cleanup-rollback' }).batch;
    const artifact = addArtifact(repository, batch.id, { artifactKey: 'cleanup-file' });
    repository.startArtifactAttempt(artifact.id);
    const completed = repository.completeArtifact(artifact.id, {
      sha256: HASH_A,
      sizeBytes: 5,
      relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '1' }
    });
    completeLayout(repository, completed.artifact);
    db.exec(`
      CREATE TRIGGER reject_archive_cleanup_job
      BEFORE INSERT ON archive_cleanup_jobs
      BEGIN
        SELECT RAISE(ABORT, 'cleanup job unavailable');
      END;
    `);

    assert.throws(() => repository.deleteBatch(batch.id), /cleanup job unavailable/);
    assert.ok(repository.getBatch(batch.id));
    assert.ok(repository.getArtifact(artifact.id));
    assert.equal(repository.findBlobByHash(HASH_A).referenceCount, 1);
    assert.deepEqual(repository.listCleanupJobs(), []);
  } finally {
    db.close();
  }
});

test('过期清理只选中保留日早于当前日且未锁定的批次', () => {
  const { db, repository } = createFixture();
  try {
    const expired = createBatch(repository, {
      operationKey: 'expired',
      localDate: '2026-07-01',
      retentionUntil: '2026-07-19'
    }).batch;
    createBatch(repository, {
      operationKey: 'inclusive-boundary',
      localDate: '2026-07-01',
      retentionUntil: '2026-07-20'
    });
    createBatch(repository, {
      operationKey: 'locked-expired',
      localDate: '2026-07-01',
      retentionUntil: '2026-07-10',
      locked: true
    });
    createBatch(repository, {
      operationKey: 'permanent',
      localDate: '2026-07-01',
      retentionUntil: null
    });

    const candidates = repository.listExpiredBatches('2026-07-20');
    assert.deepEqual(candidates.map((batch) => batch.id), [expired.id]);
  } finally {
    db.close();
  }
});

test('启动修复将断裂 ready 引用改为可重试失败态', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: 'dangling' }).batch;
    const artifact = addArtifact(repository, batch.id, { artifactKey: 'dangling-file' });
    db.prepare(`
      UPDATE archive_artifacts
      SET status = 'ready', blob_id = NULL, archived_at = updated_at
      WHERE id = ?
    `).run(artifact.id);

    const repaired = repository.repairDanglingArtifactReferences();
    assert.equal(repaired.artifactCount, 1);
    assert.deepEqual(repaired.batchIds, [batch.id]);
    assert.equal(repository.getArtifact(artifact.id).status, 'failed');
    assert.equal(repository.getArtifact(artifact.id).lastErrorCode, 'ARCHIVE_REFERENCE_INVALID');
    assert.equal(repository.getBatch(batch.id).archiveStatus, 'incomplete');
  } finally {
    db.close();
  }
});

function deletionPlan(repository, batch, items = []) {
  ensureAppSettings(repository.db);
  return {
    version: 2,
    deletionId: crypto.randomUUID(),
    archiveInstanceId: repository.getOrCreateArchiveInstanceId(),
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    localDate: batch.localDate,
    moduleId: batch.moduleId,
    origin: 'manual',
    sourcePolicy: 'managed-only',
    rootIdentity: { rootDir: '/archive', realPath: '/archive', dev: '1', ino: '1' },
    batchRevision: batch.updatedAt,
    items,
    createdAt: '2026-07-20T12:00:00.000Z'
  };
}

function deleteItem(relativePath, kind = 'owned-temp') {
  return {
    itemId: relativePath,
    kind,
    managedRelativePath: relativePath,
    state: 'pending',
    expectedIdentity: { exists: true, dev: '1', ino: '2', sizeBytes: 5, mtimeMs: 1, ctimeMs: 1 }
  };
}

test('零目标旧批次仍保存删除请求，原子完成凭证可在响应丢失后查询', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: '' }).batch;
    const plan = deletionPlan(repository, batch);
    const deleted = repository.deleteBatch(batch.id, { deletePlan: plan });
    assert.equal(deleted.cleanupJob.planVersion, 2);
    assert.equal(deleted.cleanupJob.deletionId, plan.deletionId);
    assert.equal(repository.getDeletionReceipt(batch.id), null);
    assert.equal(repository.getBatch(batch.id), null);
    assert.equal(repository.getCleanupJobForBatch(batch.id).id, deleted.cleanupJob.id);
    assert.equal(repository.completeCleanupJob(deleted.cleanupJob.id), true);
    assert.equal(repository.getCleanupJobForBatch(batch.id), null);
    assert.deepEqual(repository.getDeletionReceipt(batch.id, plan.archiveInstanceId), {
      deletionId: plan.deletionId,
      archiveInstanceId: plan.archiveInstanceId,
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      moduleId: batch.moduleId,
      origin: 'manual',
      sourcePolicy: 'managed-only',
      fullyDeleted: true,
      completedAt: '2026-07-20T12:00:00.000Z'
    });
    assert.equal(repository.getDeletionReceipt(batch.id, crypto.randomUUID()), null);
    assert.equal(repository.completeCleanupJob(deleted.cleanupJob.id), false);
    assert.equal(repository.getDeletionReceipt(999), null);
  } finally { db.close(); }
});

test('受管临时文件先登记创建状态，删除后原计划逐项推进且完成前不能丢弃任务', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository).batch;
    const plan = deletionPlan(repository, batch, [deleteItem('.readonly/owner/source.xlsx')]);
    const temp = repository.registerOwnedTemporaryFile(batch.id, {
      kind: 'readonly', managedRelativePath: plan.items[0].managedRelativePath
    });
    assert.equal(temp.state, 'creating');
    assert.equal(temp.expectedIdentity, null);
    repository.updateOwnedTemporaryFile(temp.id, {
      state: 'ready', expectedIdentity: plan.items[0].expectedIdentity
    });
    const job = repository.deleteBatch(batch.id, { deletePlan: plan }).cleanupJob;
    assert.deepEqual(job.materializedPaths, []);
    assert.deepEqual(job.releasedBlobs, []);
    assert.throws(() => repository.completeCleanupJob(job.id), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.throws(() => db.prepare('DELETE FROM archive_cleanup_jobs WHERE id = ?').run(job.id),
      /ARCHIVE_DELETE_PLAN_REQUIRES_CURRENT_VERSION/);
    assert.throws(() => repository.updateOwnedTemporaryFile(temp.id, {
      expectedIdentity: { exists: true, ino: 'replacement' }
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    const failed = repository.updateCleanupJobProgress(job.id, {
      state: 'failed', items: [{ itemId: plan.items[0].itemId, state: 'failed', lastErrorCode: 'EBUSY' }]
    });
    assert.equal(failed.plan.items[0].state, 'failed');
    assert.deepEqual(failed.plan.items[0].expectedIdentity, plan.items[0].expectedIdentity);
    const done = repository.updateCleanupJobProgress(job.id, {
      state: 'running', items: [{ itemId: plan.items[0].itemId, state: 'deleted', managedRelativePath: '../other' }]
    });
    assert.equal(done.plan.items[0].managedRelativePath, '.readonly/owner/source.xlsx');
    assert.throws(() => repository.updateCleanupJobProgress(job.id, {
      items: [{ itemId: plan.items[0].itemId, state: 'pending' }]
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.equal(repository.completeCleanupJob(job.id), true);
    assert.deepEqual(repository.listOwnedTemporaryFiles(batch.id), []);
  } finally { db.close(); }
});

test('计划漏项或加入未归属路径回滚批次、发行标记与引用', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository, { operationKey: 'delete-plan-scope' }).batch;
    const artifact = addArtifact(repository, batch.id);
    repository.startArtifactAttempt(artifact.id);
    const completed = repository.completeArtifact(artifact.id, {
      sha256: HASH_A, sizeBytes: 5, relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '2' }
    });
    completeLayout(repository, completed.artifact);
    const plan = deletionPlan(repository, batch);
    assert.throws(() => repository.deleteBatch(batch.id, { deletePlan: plan }),
      { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.ok(repository.getBatch(batch.id));
    assert.equal(repository.findBlobByHash(HASH_A).referenceCount, 1);
    assert.equal(db.prepare('SELECT deleted_at FROM archive_operation_issuances WHERE operation_key = ?')
      .get(batch.operationKey).deleted_at, null);
    assert.deepEqual(repository.listCleanupJobs(), []);
    plan.items = [deleteItem('other/file.xlsx')];
    assert.throws(() => repository.deleteBatch(batch.id, { deletePlan: plan }),
      { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
  } finally { db.close(); }
});

test('损坏或未知版本计划不能空清单成功，旧任务的 JSON 也严格校验', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository).batch;
    const plan = deletionPlan(repository, batch);
    const job = repository.deleteBatch(batch.id, { deletePlan: plan }).cleanupJob;
    for (const patch of [
      { column: 'plan_json', value: '{' },
      { column: 'plan_json', value: JSON.stringify({ ...plan, items: undefined }) },
      { column: 'progress_json', value: '{"items":[{"itemId":"unexpected","state":"deleted"}]}' },
      { column: 'plan_version', value: 99 }
    ]) {
      db.prepare(`UPDATE archive_cleanup_jobs SET ${patch.column} = ? WHERE id = ?`).run(patch.value, job.id);
      assert.equal(repository.getCleanupJob(job.id).planError.code, 'ARCHIVE_DELETE_PLAN_INVALID');
      assert.throws(() => repository.completeCleanupJob(job.id), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
      assert.equal(repository.getDeletionReceipt(batch.id), null);
      db.prepare('UPDATE archive_cleanup_jobs SET plan_version = 2, plan_json = ?, progress_json = ? WHERE id = ?')
        .run(JSON.stringify(plan), '{"items":[]}', job.id);
    }
    db.prepare('UPDATE archive_cleanup_jobs SET plan_version = 1, materialized_paths_json = ? WHERE id = ?')
      .run('{', job.id);
    assert.equal(repository.listCleanupJobs()[0].planError.code, 'ARCHIVE_DELETE_PLAN_INVALID');
    assert.throws(() => repository.completeCleanupJob(job.id), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
  } finally { db.close(); }
});

test('完成凭证插入和 cleanup job 移除在故障时一起回滚', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository).batch;
    const job = repository.deleteBatch(batch.id, { deletePlan: deletionPlan(repository, batch) }).cleanupJob;
    db.exec(`CREATE TRIGGER fail_delete_job BEFORE DELETE ON archive_cleanup_jobs BEGIN
      SELECT RAISE(ABORT, 'simulated disk transaction failure'); END;`);
    assert.throws(() => repository.completeCleanupJob(job.id), /simulated disk transaction failure/);
    assert.ok(repository.getCleanupJob(job.id));
    assert.equal(repository.getDeletionReceipt(batch.id), null);
    db.exec('DROP TRIGGER fail_delete_job');
    assert.equal(repository.completeCleanupJob(job.id), true);
  } finally { db.close(); }
});

test('等待历史迁移时必须收到同一 journal 的 done 事实才能完成', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository).batch;
    const plan = deletionPlan(repository, batch);
    const job = repository.deleteBatch(batch.id, { deletePlan: plan }).cleanupJob;
    const migration = {
      migrationId: 'original-journal', archiveInstanceId: plan.archiveInstanceId,
      sourceRoot: '/archive', targetRoot: '/moved/archive'
    };
    const waiting = repository.updateCleanupJobProgress(job.id, { state: 'waiting-migration', migration });
    assert.deepEqual(waiting.migration, migration);
    assert.equal(waiting.state, 'waiting-migration');
    assert.throws(() => repository.completeCleanupJob(job.id), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.throws(() => repository.completeCleanupJob(job.id, {
      migrationCompletion: { ...migration, phase: 'done', migrationId: 'different-journal' }
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.throws(() => repository.updateCleanupJobProgress(job.id, { state: 'running' }),
      { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.equal(repository.getDeletionReceipt(batch.id), null);
    assert.equal(repository.completeCleanupJob(job.id, {
      migrationCompletion: { ...migration, phase: 'done' }
    }), true);
    assert.equal(repository.getDeletionReceipt(batch.id).fullyDeleted, true);
  } finally { db.close(); }
});

test('历史路径清理计划升级保留原授权范围，不追加其他受管文件', () => {
  const { db, repository } = createFixture();
  try {
    const batch = createBatch(repository).batch;
    const artifact = addArtifact(repository, batch.id);
    repository.startArtifactAttempt(artifact.id);
    repository.completeArtifact(artifact.id, {
      sha256: HASH_A, sizeBytes: 5, relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '2' }
    });
    const job = repository.deleteBatch(batch.id).cleanupJob;
    const plan = deletionPlan(repository, batch, [deleteItem(`blobs/sha256/aa/${HASH_A}`, 'blob')]);
    plan.origin = 'legacy-recovery';
    assert.throws(() => repository.upgradeCleanupJobPlan(job.id, {
      ...plan, items: [...plan.items, deleteItem('.readonly/unrelated/file.xlsx')]
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.equal(repository.getCleanupJob(job.id).planVersion, 1);
    const upgraded = repository.upgradeCleanupJobPlan(job.id, plan);
    assert.equal(upgraded.planVersion, 2);
    assert.equal(upgraded.origin, 'legacy-recovery');
    assert.deepEqual(upgraded.releasedBlobs, []);
    assert.equal(upgraded.plan.items[0].managedRelativePath, job.releasedBlobs[0].relativePath);
  } finally { db.close(); }
});

test('Blob 在删除后被新批次重新引用时按当前 hash 和路径保护新引用', () => {
  const { db, repository } = createFixture();
  try {
    const first = createBatch(repository).batch;
    const firstArtifact = addArtifact(repository, first.id);
    repository.startArtifactAttempt(firstArtifact.id);
    const firstBlob = repository.completeArtifact(firstArtifact.id, {
      sha256: HASH_A, sizeBytes: 5, relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '2' }
    }).artifact.blob;
    repository.deleteBatch(first.id);
    assert.equal(repository.findReferencedBlob({ sha256: HASH_A }), null);
    const second = createBatch(repository).batch;
    const secondArtifact = addArtifact(repository, second.id);
    repository.startArtifactAttempt(secondArtifact.id);
    const secondBlob = repository.completeArtifact(secondArtifact.id, {
      sha256: HASH_A, sizeBytes: 5, relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '2' }
    }).artifact.blob;
    assert.notEqual(secondBlob.id, firstBlob.id);
    assert.equal(repository.findReferencedBlob({ sha256: HASH_A }).id, secondBlob.id);
    assert.equal(repository.findReferencedBlob({ sha256: HASH_B, relativePath: secondBlob.relativePath }).id,
      secondBlob.id);
  } finally { db.close(); }
});

function positionManagedSourceFixture(repository) {
  const batch = createBatch(repository, {
    moduleId: 'position-reconciliation-process', moduleCode: 'POSITION'
  }).batch;
  const managedRootIdentity = {
    rootDir: '/app-data/run-data/position-reconciliation/import-staging',
    realPath: '/app-data/run-data/position-reconciliation/import-staging', dev: '1', ino: '10'
  };
  const managedRelativePath = 'source-job/1/source.xlsx';
  const sourcePath = `${managedRootIdentity.rootDir}/${managedRelativePath}`;
  const sourceSnapshot = { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '17' };
  const artifact = addArtifact(repository, batch.id, {
    sourcePath, sourceOperation: 'position-reconciliation:source:prepare-import',
    metadata: { sourceSnapshot, expectedSha256: HASH_A, expectedSizeBytes: 5 }
  });
  const sourceOwnerProof = {
    moduleId: batch.moduleId, batchId: batch.id, artifactId: artifact.id, sourcePath,
    sourceOperation: artifact.sourceOperation, sourceSnapshot, expectedSha256: HASH_A, expectedSizeBytes: 5
  };
  const target = {
    sourceArtifactId: artifact.id, managedRootIdentity, managedRelativePath, sourceOwnerProof,
    expectedIdentity: { ...sourceSnapshot, exists: true, dev: '1', sha256: HASH_A, parents: [] }
  };
  const plan = deletionPlan(repository, batch, [{
    itemId: 'position-staged-source', kind: 'owned-temp', state: 'pending', ...target
  }]);
  return { batch, artifact, target, plan };
}

test('已核定的第二受管根精确源文件进入原删除事务，不能只传持久计划绕过核定', () => {
  const { db, repository } = createFixture();
  try {
    const { batch, artifact, target, plan } = positionManagedSourceFixture(repository);
    assert.throws(() => repository.deleteBatch(batch.id, { deletePlan: plan }),
      { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.ok(repository.getArtifact(artifact.id));
    const deleted = repository.deleteBatch(batch.id, { deletePlan: plan, managedSourceTargets: [target] });
    assert.equal(deleted.cleanupJob.plan.items[0].sourceArtifactId, artifact.id);
    assert.deepEqual(deleted.cleanupJob.plan.items[0].sourceOwnerProof, target.sourceOwnerProof);
    assert.equal(repository.getArtifact(artifact.id), null);
    const corruptPlan = structuredClone(plan);
    delete corruptPlan.items[0].sourceOwnerProof.expectedSha256;
    db.prepare('UPDATE archive_cleanup_jobs SET plan_json = ? WHERE id = ?')
      .run(JSON.stringify(corruptPlan), deleted.cleanupJob.id);
    assert.equal(repository.getCleanupJob(deleted.cleanupJob.id).planError.code, 'ARCHIVE_DELETE_PLAN_INVALID');
    db.prepare('UPDATE archive_cleanup_jobs SET plan_json = ? WHERE id = ?')
      .run(JSON.stringify(plan), deleted.cleanupJob.id);
    repository.updateCleanupJobProgress(deleted.cleanupJob.id, {
      items: [{ itemId: plan.items[0].itemId, state: 'deleted' }]
    });
    assert.equal(repository.completeCleanupJob(deleted.cleanupJob.id), true);
  } finally { db.close(); }
});

test('第二受管根计划不得更换外部路径、扩大目录、跨批次或替换原件身份', () => {
  const { db, repository } = createFixture();
  try {
    const { batch, artifact, target, plan } = positionManagedSourceFixture(repository);
    for (const change of [
      { managedRelativePath: 'source-job/2/other.xlsx' },
      { managedRootIdentity: { ...target.managedRootIdentity, rootDir: '/Users/me/Downloads' } },
      { sourceArtifactId: artifact.id + 1 },
      { sourceOwnerProof: { ...target.sourceOwnerProof, expectedSha256: HASH_B } },
      { expectedIdentity: { ...target.expectedIdentity, ino: 'replacement' } }
    ]) {
      const changed = { ...target, ...change };
      assert.throws(() => repository.deleteBatch(batch.id, {
        deletePlan: { ...plan, items: [{ ...plan.items[0], ...changed }] }, managedSourceTargets: [changed]
      }));
      assert.ok(repository.getBatch(batch.id));
      assert.ok(repository.getArtifact(artifact.id));
      assert.equal(repository.getCleanupJobForBatch(batch.id), null);
    }
    const stalePlan = { ...plan, items: [{ ...plan.items[0], managedRootIdentity: {
      ...target.managedRootIdentity, ino: 'different-root'
    } }] };
    assert.throws(() => repository.deleteBatch(batch.id, {
      deletePlan: stalePlan, managedSourceTargets: [target]
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    db.prepare('UPDATE archive_artifacts SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...artifact.metadata, expectedSha256: HASH_B }), artifact.id);
    assert.throws(() => repository.deleteBatch(batch.id, {
      deletePlan: plan, managedSourceTargets: [target]
    }), { code: 'ARCHIVE_DELETE_PLAN_INVALID' });
    assert.ok(repository.getBatch(batch.id));
  } finally { db.close(); }
});

test('排除本批次 unresolved source 时保留其他批次的同路径引用', () => {
  const { db, repository } = createFixture();
  try {
    const first = createBatch(repository).batch;
    const second = createBatch(repository).batch;
    addArtifact(repository, first.id, { sourcePath: '/shared/source.xlsx' });
    addArtifact(repository, first.id, { sourcePath: '/first/only.xlsx' });
    const secondArtifact = addArtifact(repository, second.id, { sourcePath: '/shared/source.xlsx' });
    assert.deepEqual(repository.listUnresolvedArtifactSourcePaths({ excludeBatchId: first.id }),
      ['/shared/source.xlsx']);
    assert.equal(repository.listUnresolvedArtifactSourcePaths().length, 3);
    repository.startArtifactAttempt(secondArtifact.id);
    repository.completeArtifact(secondArtifact.id, {
      sha256: HASH_A, sizeBytes: 5, relativePath: `blobs/sha256/aa/${HASH_A}`,
      fingerprint: { sizeBytes: 5, mtimeMs: 1, ctimeMs: 1, ino: '2' }
    });
    assert.deepEqual(repository.listUnresolvedArtifactSourcePaths({ excludeBatchId: first.id }), []);
    assert.deepEqual(repository.listUnresolvedArtifactSourcePaths({ excludeBatchId: first.id, includeReady: true }),
      ['/shared/source.xlsx']);
    assert.throws(() => repository.listUnresolvedArtifactSourcePaths({ excludeBatchId: 'invalid' }));
  } finally { db.close(); }
});

function terminalTaskDeletionFixture(repository, { metadata = {}, lineageIntents = [],
  status = 'cancelled', saveProof = true } = {}) {
  const taskPayload = {
    taskRunId: crypto.randomUUID(), moduleId: 'bank-statement', taskKey: 'file:generate',
    operationKey: crypto.randomUUID(), parentRunId: crypto.randomUUID(),
    metadata: { sourceRef: '/private/business/source.xlsx', rows: [{ account: 'test' }], ...metadata },
    lineageIntents: lineageIntents.map((item) => ({ producerTaskRunId: null, ...item }))
  };
  const task = repository.beginTaskRun(taskPayload).taskRun;
  const reserved = repository.reserveFileTaskBatch({
    taskRun: task, moduleCode: 'BANK', moduleName: '网银账单',
    manifest: { version: 1, identity: crypto.randomUUID(), inputs: [], outputs: [] }
  });
  repository.finishFileTask(task.taskRunId, reserved.batch.id, {
    taskStatus: status, code: 'CANCELLED', message: '/private/business/source.xlsx 调用已结束'
  });
  const batch = repository.getBatch(reserved.batch.id);
  const plan = deletionPlan(repository, batch);
  const owner = { version: 1, kind: 'file-batch', batchContext: {
    batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: batch.taskRunId,
    taskKey: batch.taskKey, moduleId: batch.moduleId,
    parentRunId: batch.parentRunId, operationKey: batch.operationKey
  } };
  if (saveProof) repository.recordOwnerTerminalCompletion({
    archiveInstanceId: plan.archiveInstanceId, owner, terminalStatus: status, afterTerminal: null
  });
  return { batch, plan, owner, task, taskPayload };
}

test('已证明收口的专属终态 Task 清空业务 metadata，保留身份与幂等控制', () => {
  const { db, repository } = createFixture();
  try {
    const state = terminalTaskDeletionFixture(repository, {
      lineageIntents: [{ kind: 'dataset-input', lineageKey: 'input-control-key', inputRole: 'input' }]
    });
    const deleted = repository.deleteBatch(state.batch.id, { deletePlan: state.plan });
    assert.equal(deleted.taskMetadataCleanup.compacted, true);
    const after = repository.getTaskRun(state.task.taskRunId);
    assert.deepEqual(after.metadata, {});
    assert.equal(after.failureMessage, '');
    assert.equal(after.failureCode, 'CANCELLED');
    assert.equal(after.status, 'cancelled');
    assert.equal(after.operationKey, state.task.operationKey);
    assert.equal(repository.getOwnerTerminalCompletion(state.owner).terminalStatus, 'cancelled');
    assert.equal(repository.listTaskLineageForConsumer(state.task.taskRunId)[0].state, 'discarded');
    assert.equal(repository.beginTaskRun(state.taskPayload).created, false);
    assert.equal(repository.getOperationIssuance(state.batch.moduleId, state.batch.operationKey).deletedAt !== null, true);
  } finally { db.close(); }
});

test('缺少收口证明、共享 Task、有效 lineage 或恢复标记时保留所需 Task 元数据', () => {
  for (const scenario of ['unproven', 'shared-task', 'active-lineage', 'recovery-pending']) {
    const { db, repository } = createFixture();
    try {
      const state = terminalTaskDeletionFixture(repository, {
        saveProof: scenario !== 'unproven',
        status: scenario === 'active-lineage' ? 'succeeded' : 'cancelled',
        lineageIntents: scenario === 'active-lineage'
          ? [{ kind: 'dataset-input', lineageKey: 'business-input', inputRole: 'input' }] : [],
        metadata: scenario === 'recovery-pending' ? { recoveryMode: true } : {}
      });
      if (scenario === 'shared-task') repository.reserveTaskBatch({
        moduleId: state.batch.moduleId, moduleCode: 'BANK', moduleName: '网银账单',
        operationKey: 'another-shared-batch', taskRunId: state.task.taskRunId,
        taskKey: state.task.taskKey, parentRunId: state.task.parentRunId
      });
      const before = repository.getTaskRun(state.task.taskRunId);
      const deleted = repository.deleteBatch(state.batch.id, { deletePlan: state.plan });
      assert.equal(deleted.taskMetadataCleanup.compacted, false, scenario);
      assert.equal(deleted.taskMetadataCleanup.reason,
        scenario === 'unproven' ? 'owner-completion-unproven' : scenario);
      assert.deepEqual(repository.getTaskRun(state.task.taskRunId).metadata, before.metadata, scenario);
      if (scenario === 'active-lineage') {
        assert.equal(repository.listTaskLineageForConsumer(state.task.taskRunId)[0].state, 'committed');
      }
    } finally { db.close(); }
  }
});
