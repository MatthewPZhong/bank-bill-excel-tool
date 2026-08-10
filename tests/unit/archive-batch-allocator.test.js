'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository,
  ensureArchiveMetadataSupport,
  formatGlobalBatchNumber
} = require('../../src/backend/database/archive-repository');

function createFixture() {
  let currentTime = new Date(2026, 7, 10, 1, 0, 0);
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const repository = createArchiveRepository(db, { now: () => currentTime });
  repository.ensureSchema();
  return {
    db,
    repository,
    setTime(value) {
      currentTime = new Date(value);
    }
  };
}

function reserve(repository, overrides = {}) {
  return repository.reserveTaskBatch({
    moduleId: 'statement-generator',
    moduleCode: 'STATEMENT',
    moduleName: '网银账单生成',
    taskKey: 'generate',
    taskRunId: `task-${Math.random()}`,
    operationKey: `operation-${Math.random()}`,
    parentRunId: 'parent-1',
    retentionUntil: '2026-10-09',
    ...overrides
  });
}

function createLegacyArchiveSchema(db) {
  db.exec(`
    CREATE TABLE archive_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number TEXT NOT NULL UNIQUE,
      module_id TEXT NOT NULL,
      module_code TEXT NOT NULL,
      module_name TEXT NOT NULL,
      operation_key TEXT NOT NULL DEFAULT '',
      local_date TEXT NOT NULL,
      daily_sequence INTEGER NOT NULL CHECK (daily_sequence > 0),
      business_status TEXT NOT NULL DEFAULT '',
      archive_status TEXT NOT NULL DEFAULT 'staging'
        CHECK (archive_status IN ('staging', 'complete', 'incomplete')),
      locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
      retention_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      last_failed_operation TEXT,
      last_failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (module_code, local_date, daily_sequence)
    );
    CREATE TABLE archive_batch_sequences (
      module_code TEXT NOT NULL,
      local_date TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
      PRIMARY KEY (module_code, local_date)
    );
    CREATE TABLE archive_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL
    );
    CREATE TABLE archive_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      artifact_key TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
      role TEXT NOT NULL,
      source_operation TEXT NOT NULL DEFAULT '',
      original_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'failed')),
      blob_id INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES archive_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (blob_id) REFERENCES archive_blobs(id) ON DELETE SET NULL,
      UNIQUE (batch_id, artifact_key)
    );
  `);
}

test('v1 旧库纯加法迁移保持历史身份与 archiveStatus 三态，并按历史游标之和 seed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    createLegacyArchiveSchema(db);
    const timestamp = '2026-08-09T12:00:00.000Z';
    const firstId = Number(db.prepare(`
      INSERT INTO archive_batches (
        batch_number, module_id, module_code, module_name, operation_key,
        local_date, daily_sequence, archive_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
    `).run(
      'A-20260809-001', 'module-a', 'A', '模块 A', 'legacy-a',
      '2026-08-09', 1, timestamp, timestamp
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO archive_batches (
        batch_number, module_id, module_code, module_name, operation_key,
        local_date, daily_sequence, archive_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
    `).run(
      'A-20260809-002', 'module-a', 'A', '模块 A', 'legacy-a-2',
      '2026-08-09', 2, timestamp, timestamp
    );
    db.prepare(`
      INSERT INTO archive_batches (
        batch_number, module_id, module_code, module_name, operation_key,
        local_date, daily_sequence, archive_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, ?)
    `).run(
      'B-20260809-001', 'module-b', 'B', '模块 B', 'legacy-b',
      '2026-08-09', 1, timestamp, timestamp
    );
    db.prepare(`
      INSERT INTO archive_batch_sequences (module_code, local_date, last_sequence)
      VALUES ('A', '2026-08-09', 3), ('B', '2026-08-09', 2)
    `).run();
    db.prepare(`
      INSERT INTO archive_artifacts (
        batch_id, artifact_key, direction, role, original_name, source_path,
        status, created_at, updated_at
      ) VALUES (?, 'legacy-artifact', 'input', 'source', 'old.xlsx', '/old.xlsx',
        'pending', ?, ?)
    `).run(firstId, timestamp, timestamp);

    ensureArchiveMetadataSupport(db);
    ensureArchiveMetadataSupport(db);
    const repository = createArchiveRepository(db, {
      now: () => new Date(2026, 7, 9, 12, 0, 0)
    });
    const legacy = repository.getBatch(firstId);
    assert.equal(legacy.batchNumber, 'A-20260809-001');
    assert.equal(legacy.dailySequence, 1);
    assert.equal(legacy.batchFormatVersion, 1);
    assert.equal(legacy.globalDailySequence, null);
    assert.equal(legacy.taskStatus, 'succeeded');
    assert.equal(legacy.parentRunId, '');
    assert.equal(legacy.archiveStatus, 'complete');

    const artifact = repository.getArtifactByKey(firstId, 'legacy-artifact');
    assert.equal(artifact.storageLayoutVersion, 1);
    assert.equal(artifact.storageRelativePath, '');
    assert.equal(artifact.storageMode, '');
    assert.equal(artifact.safeFileName, '');
    assert.equal(artifact.artifactOrder, null);

    assert.deepEqual(
      { ...db.prepare(`SELECT local_date, last_sequence FROM archive_daily_sequences`).get() },
      { local_date: '2026-08-09', last_sequence: 5 }
    );
    assert.equal(repository.getLatestIssuedBatch(), null);
    const next = reserve(repository, {
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      operationKey: 'first-v2',
      retentionUntil: null
    }).batch;
    assert.equal(next.batchNumber, '2026-08-09-006');
    assert.equal(next.dailySequence, 6);
    assert.equal(next.globalDailySequence, 6);
    const crossModule = reserve(repository, {
      moduleId: 'module-b',
      moduleCode: 'B',
      moduleName: '模块 B',
      operationKey: 'second-v2',
      retentionUntil: null
    }).batch;
    assert.equal(crossModule.batchNumber, '2026-08-09-007');

    ensureArchiveMetadataSupport(db);
    ensureArchiveMetadataSupport(db);
    assert.deepEqual(
      db.prepare(`
        SELECT module_code, last_sequence
        FROM archive_batch_sequences
        WHERE local_date = '2026-08-09'
        ORDER BY module_code
      `).all().map((row) => ({ ...row })),
      [
        { module_code: 'A', last_sequence: 3 },
        { module_code: 'B', last_sequence: 2 }
      ]
    );
    assert.equal(db.prepare(`
      SELECT last_sequence FROM archive_daily_sequences WHERE local_date = '2026-08-09'
    `).get().last_sequence, 7);

    assert.throws(
      () => db.prepare(`UPDATE archive_batches SET archive_status = 'failed' WHERE id = ?`).run(firstId),
      /constraint/i
    );
    assert.throws(
      () => db.prepare(`UPDATE archive_batches SET task_status = 'unknown' WHERE id = ?`).run(firstId),
      /constraint/i
    );
    assert.equal(repository.getBatch(firstId).archiveStatus, 'complete');
  } finally {
    db.close();
  }
});

test('reserveTaskBatch 使用全局日流水、持久幂等和 v2 DTO，latest 查询保持只读且删除不倒退', () => {
  const { db, repository, setTime } = createFixture();
  try {
    const first = reserve(repository, {
      operationKey: 'op-1',
      taskRunId: 'task-1'
    });
    const second = reserve(repository, {
      moduleId: 'toolbox',
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱',
      taskKey: 'merge',
      operationKey: 'op-2',
      taskRunId: 'task-2'
    });
    const replay = reserve(repository, {
      operationKey: 'op-1',
      taskRunId: 'task-1'
    });
    const third = reserve(repository, {
      operationKey: 'op-3',
      taskRunId: 'task-3'
    });

    assert.equal(first.batch.batchNumber, '2026-08-10-001');
    assert.equal(second.batch.batchNumber, '2026-08-10-002');
    assert.equal(third.batch.batchNumber, '2026-08-10-003');
    assert.equal(first.batch.batchFormatVersion, 2);
    assert.equal(first.batch.dailySequence, first.batch.globalDailySequence);
    assert.equal(first.batch.taskStatus, 'reserved');
    assert.equal(first.batch.archiveStatus, 'staging');
    assert.equal(first.batch.reservedAt, new Date(2026, 7, 10, 1, 0, 0).toISOString());
    assert.equal(replay.created, false);
    assert.equal(replay.batch.id, first.batch.id);

    const beforeRead = db.prepare(`
      SELECT last_sequence FROM archive_daily_sequences WHERE local_date = '2026-08-10'
    `).get().last_sequence;
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-003');
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-003');
    assert.equal(db.prepare(`
      SELECT last_sequence FROM archive_daily_sequences WHERE local_date = '2026-08-10'
    `).get().last_sequence, beforeRead);

    assert.equal(repository.deleteBatch(third.batch.id).status, 'active');
    repository.updateTaskStatus(third.batch.id, 'succeeded');
    assert.equal(repository.deleteBatch(third.batch.id).status, 'deleted');
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-003');
    setTime(new Date(2026, 7, 10, 1, 1, 0));
    const fourth = reserve(repository, {
      operationKey: 'op-4',
      taskRunId: 'task-4'
    }).batch;
    assert.equal(fourth.batchNumber, '2026-08-10-004');

    const batchCount = repository.getStats().batchCount;
    assert.throws(
      () => reserve(repository, { operationKey: 'forged', batchNumber: '2026-08-10-999' }),
      /只能由存档中心分配/
    );
    assert.equal(repository.getStats().batchCount, batchCount);
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-004');
  } finally {
    db.close();
  }
});

test('reserved/running 批次拒绝物理删除，原批次进入终态后才可删除', () => {
  const { db, repository } = createFixture();
  try {
    for (const scenario of [
      { taskStatus: 'reserved', locked: false },
      { taskStatus: 'running', locked: true }
    ]) {
      const batch = reserve(repository, {
        operationKey: `delete-active-${scenario.taskStatus}`,
        taskRunId: `delete-active-task-${scenario.taskStatus}`,
        locked: scenario.locked
      }).batch;
      if (scenario.taskStatus === 'running') {
        repository.updateTaskStatus(batch.id, 'running');
      }

      const active = repository.deleteBatch(batch.id, { allowLocked: true });
      assert.equal(active.status, 'active');
      assert.equal(active.batch.id, batch.id);
      assert.equal(repository.getBatch(batch.id).taskStatus, scenario.taskStatus);

      const terminal = repository.updateTaskStatus(batch.id, 'succeeded');
      assert.equal(terminal.id, batch.id);
      assert.equal(terminal.taskStatus, 'succeeded');
      assert.equal(repository.deleteBatch(batch.id, { allowLocked: true }).status, 'deleted');
    }
  } finally {
    db.close();
  }
});

test('task 预留拒绝调用方日期，并由事务内单次时钟采样统一日期、号码、时间和默认保留期', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const beforeMidnight = new Date(2026, 7, 10, 23, 59, 59, 900);
  const afterMidnight = new Date(2026, 7, 11, 0, 0, 0, 100);
  let clockCalls = 0;
  const repository = createArchiveRepository(db, {
    now: () => (clockCalls++ === 0 ? beforeMidnight : afterMidnight)
  });
  repository.ensureSchema();
  const payload = {
    moduleId: 'statement-generator',
    moduleCode: 'STATEMENT',
    moduleName: '网银账单生成',
    taskKey: 'generate',
    taskRunId: 'authoritative-clock-task',
    operationKey: 'authoritative-clock-operation',
    parentRunId: 'authoritative-clock-parent',
    retentionDays: 60
  };
  try {
    assert.throws(
      () => repository.reserveTaskBatch({ ...payload, localDate: '2099-01-01' }),
      /localDate 只能由存档中心时钟生成/
    );
    assert.equal(clockCalls, 0);
    assert.equal(repository.getStats().batchCount, 0);

    const reserved = repository.reserveTaskBatch(payload).batch;
    assert.equal(clockCalls, 1);
    assert.equal(reserved.localDate, '2026-08-10');
    assert.equal(reserved.batchNumber, '2026-08-10-001');
    assert.equal(reserved.reservedAt, beforeMidnight.toISOString());
    assert.equal(reserved.retentionUntil, '2026-10-09');
  } finally {
    db.close();
  }
});

test('task 状态、时间与失败 DTO 独立于 archiveStatus，parent 关联按日期和全局序号排序', () => {
  const { db, repository, setTime } = createFixture();
  try {
    const first = reserve(repository, {
      operationKey: 'related-1',
      taskRunId: 'related-task-1',
      parentRunId: 'flow-1'
    }).batch;
    setTime(new Date(2026, 7, 10, 1, 1, 0));
    const second = reserve(repository, {
      operationKey: 'related-2',
      taskRunId: 'related-task-2',
      parentRunId: 'flow-1'
    }).batch;
    setTime(new Date(2026, 7, 11, 1, 0, 0));
    const third = reserve(repository, {
      operationKey: 'related-3',
      taskRunId: 'related-task-3',
      parentRunId: 'flow-1',
      retentionUntil: '2026-10-10'
    }).batch;
    reserve(repository, {
      operationKey: 'other-flow',
      taskRunId: 'other-flow-task',
      parentRunId: 'flow-2',
      retentionUntil: '2026-10-10'
    });

    setTime(new Date(2026, 7, 10, 1, 2, 0));
    const running = repository.updateTaskStatus(first.id, 'running');
    assert.equal(running.taskStatus, 'running');
    assert.equal(running.startedAt, new Date(2026, 7, 10, 1, 2, 0).toISOString());
    assert.equal(running.archiveStatus, 'staging');

    setTime(new Date(2026, 7, 10, 1, 3, 0));
    const failed = repository.updateTaskStatus(first.id, 'failed', {
      failureCode: 'TASK_FAILED',
      failureMessage: '任务失败'
    });
    assert.equal(failed.taskStatus, 'failed');
    assert.equal(failed.finishedAt, new Date(2026, 7, 10, 1, 3, 0).toISOString());
    assert.equal(failed.failureCode, 'TASK_FAILED');
    assert.equal(failed.failureMessage, '任务失败');
    assert.equal(failed.artifactCount, 0);
    assert.equal(failed.archiveStatus, 'complete');

    setTime(new Date(2026, 7, 10, 1, 4, 0));
    const cancelled = repository.updateTaskStatus(second.id, 'cancelled', {
      code: 'USER_CANCELLED',
      message: '用户取消'
    });
    assert.equal(cancelled.taskStatus, 'cancelled');
    assert.equal(cancelled.failureCode, 'USER_CANCELLED');
    assert.equal(cancelled.artifactCount, 0);
    assert.equal(cancelled.archiveStatus, 'complete');

    setTime(new Date(2026, 7, 11, 1, 5, 0));
    const succeeded = repository.updateTaskStatus(third.id, 'succeeded');
    assert.equal(succeeded.taskStatus, 'succeeded');
    assert.equal(succeeded.finishedAt, new Date(2026, 7, 11, 1, 5, 0).toISOString());
    assert.equal(succeeded.failureCode, '');
    assert.equal(succeeded.artifactCount, 0);
    assert.equal(succeeded.archiveStatus, 'complete');

    assert.deepEqual(
      repository.listRelatedBatches('flow-1').map((batch) => batch.id),
      [first.id, second.id, third.id]
    );
    repository.deleteBatch(second.id);
    assert.deepEqual(
      repository.listRelatedBatches('flow-1').map((batch) => batch.id),
      [first.id, third.id]
    );
    assert.throws(() => repository.updateTaskStatus(first.id, 'other'), /taskStatus 非法/);
  } finally {
    db.close();
  }
});

test('task terminal 按 artifact 聚合 archiveStatus，且不把业务终态写入存档状态', () => {
  const { db, repository } = createFixture();
  try {
    const pendingBatch = reserve(repository, {
      operationKey: 'archive-pending',
      taskRunId: 'archive-pending-task'
    }).batch;
    repository.addArtifact(pendingBatch.id, {
      artifactKey: 'pending-file',
      direction: 'input',
      role: 'source',
      originalName: 'pending.xlsx',
      sourcePath: '/pending.xlsx'
    });
    const pendingTerminal = repository.transitionTaskStatus(pendingBatch.id, 'succeeded');
    assert.equal(pendingTerminal.batch.taskStatus, 'succeeded');
    assert.equal(pendingTerminal.batch.archiveStatus, 'staging');

    const failedBatch = reserve(repository, {
      operationKey: 'archive-failed',
      taskRunId: 'archive-failed-task'
    }).batch;
    const failedArtifact = repository.addArtifact(failedBatch.id, {
      artifactKey: 'failed-file',
      direction: 'output',
      role: 'result',
      originalName: 'failed.xlsx',
      sourcePath: '/failed.xlsx'
    });
    repository.failArtifact(failedArtifact.id, {
      code: 'ARCHIVE_FILE_FAILED',
      message: '文件存档失败'
    });
    const failedTerminal = repository.transitionTaskStatus(failedBatch.id, 'failed', {
      code: 'BUSINESS_FAILED',
      message: '业务任务失败'
    });
    assert.equal(failedTerminal.batch.taskStatus, 'failed');
    assert.equal(failedTerminal.batch.failureCode, 'BUSINESS_FAILED');
    assert.equal(failedTerminal.batch.archiveStatus, 'incomplete');
    assert.equal(failedTerminal.batch.lastErrorCode, 'ARCHIVE_FILE_FAILED');

    const readyBatch = reserve(repository, {
      operationKey: 'archive-ready',
      taskRunId: 'archive-ready-task'
    }).batch;
    const readyArtifact = repository.addArtifact(readyBatch.id, {
      artifactKey: 'ready-file',
      direction: 'output',
      role: 'result',
      originalName: 'ready.xlsx',
      sourcePath: '/ready.xlsx'
    });
    repository.completeArtifact(readyArtifact.id, {
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      relativePath: 'blobs/aa/ready'
    });
    const readyTerminal = repository.transitionTaskStatus(readyBatch.id, 'cancelled', {
      reason: '用户取消后处理'
    });
    assert.equal(readyTerminal.batch.taskStatus, 'cancelled');
    assert.equal(readyTerminal.batch.archiveStatus, 'complete');

    const registrationFailedBatch = reserve(repository, {
      operationKey: 'archive-registration-failed',
      taskRunId: 'archive-registration-failed-task'
    }).batch;
    repository.recordBatchFailure(registrationFailedBatch.id, {
      code: 'ARCHIVE_METADATA_FAILED',
      message: '文件元数据登记失败',
      sourceOperation: 'attach-file'
    });
    const terminalAfterRegistrationFailure = repository.transitionTaskStatus(
      registrationFailedBatch.id,
      'succeeded'
    );
    assert.equal(terminalAfterRegistrationFailure.batch.artifactCount, 0);
    assert.equal(terminalAfterRegistrationFailure.batch.taskStatus, 'succeeded');
    assert.equal(terminalAfterRegistrationFailure.batch.archiveStatus, 'incomplete');
    assert.equal(
      terminalAfterRegistrationFailure.batch.lastErrorCode,
      'ARCHIVE_METADATA_FAILED'
    );

    const recoveredArtifact = repository.addArtifact(registrationFailedBatch.id, {
      artifactKey: 'recovered-file',
      direction: 'output',
      role: 'result',
      originalName: 'recovered.xlsx',
      sourcePath: '/recovered.xlsx'
    });
    repository.completeArtifact(recoveredArtifact.id, {
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
      relativePath: 'blobs/bb/recovered'
    });
    const recovered = repository.getBatch(registrationFailedBatch.id);
    assert.equal(recovered.failureCount, 1);
    assert.equal(recovered.archiveStatus, 'complete');
    assert.equal(recovered.lastErrorCode, '');
  } finally {
    db.close();
  }
});

test('task terminal 状态使用 CAS：取消与成功都不能被迟到的相反结果覆盖', () => {
  const { db, repository, setTime } = createFixture();
  try {
    const cancelledBatch = reserve(repository, {
      operationKey: 'cancel-race',
      taskRunId: 'cancel-race-task'
    }).batch;
    setTime(new Date(2026, 7, 10, 1, 1, 0));
    const cancelled = repository.transitionTaskStatus(cancelledBatch.id, 'cancelled', {
      expectedStatuses: ['reserved', 'running'],
      code: 'USER_CANCELLED',
      message: '用户取消'
    });
    assert.equal(cancelled.status, 'updated');
    assert.equal(cancelled.batch.taskStatus, 'cancelled');
    assert.equal(cancelled.batch.archiveStatus, 'complete');
    const cancelledAt = cancelled.batch.finishedAt;

    setTime(new Date(2026, 7, 10, 1, 2, 0));
    const lateSuccess = repository.transitionTaskStatus(cancelledBatch.id, 'succeeded', {
      expectedStatuses: ['reserved', 'running']
    });
    assert.equal(lateSuccess.status, 'conflict');
    assert.equal(lateSuccess.batch.taskStatus, 'cancelled');
    assert.equal(lateSuccess.batch.finishedAt, cancelledAt);
    const cancelReplay = repository.transitionTaskStatus(cancelledBatch.id, 'cancelled', {
      expectedStatuses: ['reserved', 'running']
    });
    assert.equal(cancelReplay.status, 'unchanged');
    assert.equal(cancelReplay.idempotent, true);
    assert.equal(cancelReplay.batch.finishedAt, cancelledAt);
    assert.equal(cancelReplay.batch.archiveStatus, 'complete');

    const succeededBatch = reserve(repository, {
      operationKey: 'success-race',
      taskRunId: 'success-race-task'
    }).batch;
    setTime(new Date(2026, 7, 10, 1, 3, 0));
    const succeeded = repository.transitionTaskStatus(succeededBatch.id, 'succeeded', {
      expectedStatuses: ['reserved', 'running']
    });
    assert.equal(succeeded.status, 'updated');
    assert.equal(succeeded.batch.taskStatus, 'succeeded');
    assert.equal(succeeded.batch.archiveStatus, 'complete');
    const succeededAt = succeeded.batch.finishedAt;

    setTime(new Date(2026, 7, 10, 1, 4, 0));
    const lateCancel = repository.transitionTaskStatus(succeededBatch.id, 'cancelled', {
      expectedStatuses: ['reserved', 'running']
    });
    assert.equal(lateCancel.status, 'conflict');
    assert.equal(lateCancel.batch.taskStatus, 'succeeded');
    assert.equal(lateCancel.batch.finishedAt, succeededAt);
  } finally {
    db.close();
  }
});

test('跨日从 001 开始，999/1000/1001 不截断', () => {
  const { db, repository, setTime } = createFixture();
  try {
    db.prepare(`
      INSERT INTO archive_daily_sequences (local_date, last_sequence, updated_at)
      VALUES ('2026-08-12', 998, '2026-08-12T00:00:00.000Z')
    `).run();
    setTime(new Date(2026, 7, 12, 12, 0, 0));
    const batch999 = reserve(repository, {
      operationKey: 'seq-999',
      retentionUntil: null
    }).batch;
    const batch1000 = reserve(repository, {
      operationKey: 'seq-1000',
      retentionUntil: null
    }).batch;
    const batch1001 = reserve(repository, {
      operationKey: 'seq-1001',
      retentionUntil: null
    }).batch;
    setTime(new Date(2026, 7, 13, 12, 0, 0));
    const nextDay = reserve(repository, {
      operationKey: 'next-day',
      retentionUntil: null
    }).batch;

    assert.equal(batch999.batchNumber, '2026-08-12-999');
    assert.equal(batch1000.batchNumber, '2026-08-12-1000');
    assert.equal(batch1001.batchNumber, '2026-08-12-1001');
    assert.equal(nextDay.batchNumber, '2026-08-13-001');
    assert.equal(formatGlobalBatchNumber('2026-08-12', 1000), '2026-08-12-1000');
  } finally {
    db.close();
  }
});

test('预留 INSERT 中途失败时全局游标和批次整体回滚', () => {
  const { db, repository } = createFixture();
  try {
    reserve(repository, { operationKey: 'before-failure' });
    db.exec(`
      CREATE TRIGGER reject_v2_reservation
      BEFORE INSERT ON archive_batches
      WHEN NEW.batch_format_version = 2 AND NEW.operation_key = 'forced-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced reservation failure');
      END;
    `);
    assert.throws(
      () => reserve(repository, { operationKey: 'forced-failure' }),
      /forced reservation failure/
    );
    assert.equal(db.prepare(`
      SELECT last_sequence FROM archive_daily_sequences WHERE local_date = '2026-08-10'
    `).get().last_sequence, 1);
    assert.equal(repository.getStats().batchCount, 1);
    db.exec('DROP TRIGGER reject_v2_reservation');
    assert.equal(
      reserve(repository, { operationKey: 'after-failure' }).batch.batchNumber,
      '2026-08-10-002'
    );
  } finally {
    db.close();
  }
});

test('v1 createBatch 与 v2 reserveTaskBatch 在迁移窗口可交错且各自格式兼容', () => {
  const { db, repository } = createFixture();
  try {
    const legacy1 = repository.createBatch({
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      operationKey: 'legacy-1',
      localDate: '2026-08-10'
    }).batch;
    const global2 = reserve(repository, {
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      operationKey: 'global-2'
    }).batch;
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-002');
    const legacy3 = repository.createBatch({
      moduleId: 'module-a',
      moduleCode: 'A',
      moduleName: '模块 A',
      operationKey: 'legacy-3',
      localDate: '2026-08-10'
    }).batch;
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-002');
    const global4 = reserve(repository, {
      moduleId: 'module-b',
      moduleCode: 'B',
      moduleName: '模块 B',
      operationKey: 'global-4'
    }).batch;

    assert.equal(legacy1.batchNumber, 'A-20260810-001');
    assert.equal(legacy1.batchFormatVersion, 1);
    assert.equal(global2.batchNumber, '2026-08-10-002');
    assert.equal(legacy3.batchNumber, 'A-20260810-003');
    assert.equal(legacy3.batchFormatVersion, 1);
    assert.equal(global4.batchNumber, '2026-08-10-004');
    assert.equal(repository.getLatestIssuedBatch().batchNumber, '2026-08-10-004');
  } finally {
    db.close();
  }
});

test('业务身份锚点跨 repository 重启可查询、重复绑定幂等且冲突不覆盖', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-flow-anchor-'));
  const dbPath = path.join(tempDir, 'archive.sqlite');
  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    let repository = createArchiveRepository(db, {
      now: () => new Date(2026, 7, 10, 4, 0, 0)
    });
    repository.ensureSchema();
    const source = reserve(repository, {
      operationKey: 'anchor-source',
      taskRunId: 'anchor-task',
      parentRunId: 'parent-anchor'
    }).batch;
    const identity = {
      moduleId: 'statement-generator',
      identityType: 'business-run-id',
      identityValue: 'statement-business-run-20260810-001',
      parentRunId: 'parent-anchor',
      sourceBatchId: source.id
    };
    const created = repository.bindFlowAnchor(identity);
    const replay = repository.bindFlowAnchor(identity);
    assert.equal(created.created, true);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.anchor, created.anchor);

    db.close();
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    repository = createArchiveRepository(db, {
      now: () => new Date(2026, 7, 10, 5, 0, 0)
    });
    repository.ensureSchema();
    assert.equal(repository.findFlowAnchor(identity).parentRunId, 'parent-anchor');

    assert.throws(
      () => repository.bindFlowAnchor({
        ...identity,
        moduleId: 'toolbox'
      }),
      (error) => error.code === 'ARCHIVE_FLOW_ANCHOR_CONFLICT'
    );
    assert.equal(repository.findFlowAnchor(identity).sourceBatchId, source.id);

    assert.throws(
      () => repository.bindFlowAnchor({ ...identity, parentRunId: 'different-parent' }),
      (error) => error.code === 'ARCHIVE_FLOW_ANCHOR_CONFLICT'
    );
    assert.equal(repository.findFlowAnchor(identity).parentRunId, 'parent-anchor');

    const parentlessSource = reserve(repository, {
      operationKey: 'anchor-parentless-source',
      taskRunId: 'anchor-parentless-task',
      parentRunId: ''
    }).batch;
    assert.throws(
      () => repository.bindFlowAnchor({
        moduleId: 'statement-generator',
        identityType: 'business-run-id',
        identityValue: 'parentless-source-must-not-prove-flow',
        parentRunId: 'parent-anchor',
        sourceBatchId: parentlessSource.id
      }),
      (error) => error.code === 'ARCHIVE_FLOW_ANCHOR_CONFLICT'
    );

    repository.updateTaskStatus(source.id, 'succeeded');
    repository.deleteBatch(source.id);
    const afterDelete = repository.findFlowAnchor(identity);
    assert.equal(afterDelete.parentRunId, 'parent-anchor');
    assert.equal(afterDelete.sourceBatchId, null);
  } finally {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const WORKER_SOURCE = `
  'use strict';
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const { createArchiveRepository } = require(workerData.repositoryPath);
  const db = new DatabaseSync(workerData.dbPath);
  db.exec('PRAGMA busy_timeout = 30000');
  const repository = createArchiveRepository(db, {
    now: () => new Date(2026, 7, 10, 12, 0, 0)
  });
  try {
    const results = workerData.operations.map((operation) => repository.reserveTaskBatch({
      moduleId: workerData.moduleId,
      moduleCode: workerData.moduleCode,
      moduleName: workerData.moduleName,
      taskKey: 'concurrent-task',
      taskRunId: operation,
      operationKey: operation,
      parentRunId: 'concurrent-flow',
      retentionUntil: null
    }));
    parentPort.postMessage(results.map((result) => ({
      created: result.created,
      id: result.batch.id,
      batchNumber: result.batch.batchNumber,
      sequence: result.batch.globalDailySequence
    })));
  } catch (error) {
    parentPort.postMessage({ error: error && error.stack ? error.stack : String(error) });
  } finally {
    db.close();
  }
`;

function runAllocatorWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData });
    worker.once('message', (message) => {
      if (message && message.error) reject(new Error(message.error));
      else resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`allocator worker 退出码 ${code}`));
    });
  });
}

test('14 个范围通过真实多连接并发预留 100 次无重复无丢号，重启后继续递增', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-batch-allocator-'));
  const dbPath = path.join(tempDir, 'archive.sqlite');
  const repositoryPath = require.resolve('../../src/backend/database/archive-repository');
  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000');
    ensureArchiveMetadataSupport(db);
    db.close();
    db = null;

    const workerInputs = Array.from({ length: 14 }, (_, workerIndex) => {
      const count = workerIndex < 2 ? 8 : 7;
      return {
        dbPath,
        repositoryPath,
        moduleId: workerIndex === 13 ? 'toolbox' : `module-${workerIndex + 1}`,
        moduleCode: workerIndex === 13 ? 'TOOLBOX' : `M${workerIndex + 1}`,
        moduleName: workerIndex === 13 ? '工具箱' : `模块 ${workerIndex + 1}`,
        operations: Array.from(
          { length: count },
          (_, operationIndex) => `concurrent-${workerIndex}-${operationIndex}`
        )
      };
    });
    const allocations = (await Promise.all(workerInputs.map(runAllocatorWorker))).flat();
    assert.equal(allocations.length, 100);
    assert.equal(new Set(allocations.map((item) => item.id)).size, 100);
    assert.equal(new Set(allocations.map((item) => item.batchNumber)).size, 100);
    assert.deepEqual(
      allocations.map((item) => item.sequence).sort((a, b) => a - b),
      Array.from({ length: 100 }, (_, index) => index + 1)
    );

    const idempotentPayload = {
      dbPath,
      repositoryPath,
      moduleId: 'module-idempotent',
      moduleCode: 'IDEMPOTENT',
      moduleName: '幂等模块',
      operations: ['shared-operation']
    };
    const replays = (await Promise.all(
      Array.from({ length: 10 }, () => runAllocatorWorker(idempotentPayload))
    )).flat();
    assert.equal(new Set(replays.map((item) => item.id)).size, 1);
    assert.equal(replays.filter((item) => item.created).length, 1);
    assert.equal(new Set(replays.map((item) => item.sequence)).size, 1);
    assert.equal(replays[0].sequence, 101);

    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 30000');
    const restarted = createArchiveRepository(db, {
      now: () => new Date(2026, 7, 10, 3, 0, 0)
    });
    const next = reserve(restarted, {
      operationKey: 'after-restart',
      taskRunId: 'after-restart-task',
      retentionUntil: null
    }).batch;
    assert.equal(next.batchNumber, '2026-08-10-102');
    assert.equal(next.globalDailySequence, 102);
  } finally {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
