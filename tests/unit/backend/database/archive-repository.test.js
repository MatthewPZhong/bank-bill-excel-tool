'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
      }]
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
    assert.equal(after.materializationErrorCode, '');

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
        'archive_flow_anchors',
        'archive_flow_bind_intents',
        'archive_maintenance_audits',
        'archive_operation_issuances',
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
