'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  blobRelativePath,
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');

function createFixture(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-service-'));
  const rootDir = path.join(tempDir, 'archive-root');
  const sourceDir = path.join(tempDir, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const service = createArchiveService({
    database: db,
    rootDir,
    now: () => new Date(2026, 6, 20, 12, 0, 0),
    ...options
  });
  return {
    db,
    rootDir,
    service,
    sourceDir,
    tempDir,
    close() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function batchPayload(operationKey, overrides = {}) {
  return {
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey,
    ...overrides
  };
}

function writeSource(fixture, name, content) {
  const filePath = path.join(fixture.sourceDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('stageFile/archiveFile 流式发布并按内容去重，最后引用删除才移除本体', async () => {
  const fixture = createFixture();
  try {
    const firstPath = writeSource(fixture, 'first.xlsx', 'same-content');
    const secondPath = writeSource(fixture, 'second.xlsx', 'same-content');

    const initialized = await fixture.service.initialize();
    assert.equal(initialized.ok, true);
    assert.equal(initialized.status, 'ready');

    const first = await fixture.service.stageFile({
      ...batchPayload('single-stage'),
      filePath: firstPath,
      role: 'source',
      sourceOperation: 'import'
    });
    const second = await fixture.service.archiveFile({
      ...batchPayload('single-archive'),
      filePath: secondPath,
      role: 'source',
      sourceOperation: 'import'
    });

    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.batch.archiveStatus, 'complete');
    assert.equal(second.ok, true);
    assert.equal(second.deduplicated, true);
    assert.equal(first.sha256, second.sha256);

    fs.writeFileSync(firstPath, 'changed-after-archive');
    const replayed = await fixture.service.stageFile({
      ...batchPayload('single-stage'),
      filePath: firstPath,
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(replayed.ok, true);
    assert.equal(replayed.created, false);
    assert.equal(replayed.alreadyArchived, true);
    assert.equal(replayed.artifact.id, first.artifact.id);
    assert.equal(replayed.sha256, first.sha256);

    const blobPath = path.join(fixture.rootDir, ...blobRelativePath(first.sha256).split('/'));
    assert.equal(fs.readFileSync(blobPath, 'utf8'), 'same-content');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);

    const stats = await fixture.service.getStats();
    assert.deepEqual(stats.stats, {
      batchCount: 2,
      lockedBatchCount: 0,
      logicalFileCount: 2,
      failedFileCount: 0,
      uniqueFileCount: 1,
      uniqueBytes: 12,
      logicalBytes: 24
    });
    const listed = await fixture.service.listBatches({ moduleId: 'bank-statement' });
    assert.equal(listed.ok, true);
    assert.deepEqual(
      new Set(listed.batches.map((batch) => batch.id)),
      new Set([first.batch.id, second.batch.id])
    );

    const firstDelete = await fixture.service.deleteBatch(first.batch.id);
    assert.equal(firstDelete.ok, true);
    assert.equal(firstDelete.releasedBlobCount, 0);
    assert.equal(fs.existsSync(blobPath), true);

    const secondDelete = await fixture.service.deleteBatch(second.batch.id);
    assert.equal(secondDelete.ok, true);
    assert.equal(secondDelete.releasedBlobCount, 1);
    assert.equal(fs.existsSync(blobPath), false);
  } finally {
    fixture.close();
  }
});

test('createBatch(files) 与 appendFiles 可直接作为 operation tracker 的批量 sink', async () => {
  const fixture = createFixture();
  try {
    const inputPath = writeSource(fixture, 'batch-input.xlsx', 'input');
    const outputPath = writeSource(fixture, 'batch-output.xlsx', 'output');
    const extraPath = writeSource(fixture, 'batch-extra.xlsx', 'extra');
    const created = await fixture.service.createBatch({
      ...batchPayload('batch-sink'),
      sourceOperation: 'business:run',
      files: [
        { filePath: inputPath, role: 'input' },
        { filePath: outputPath, role: 'output', direction: 'output' }
      ]
    });

    assert.equal(created.ok, true);
    assert.equal(created.creationStatus, 'created');
    assert.equal(created.batchId, created.batch.id);
    assert.equal(created.attempted, 2);
    assert.equal(created.succeeded, 2);
    assert.equal(created.batch.archiveStatus, 'complete');
    assert.equal(created.batch.retentionUntil, '2026-09-18');

    const appended = await fixture.service.appendFiles({
      batchId: created.batchId,
      sourceOperation: 'business:export',
      files: [{ filePath: extraPath, role: 'output', direction: 'output' }]
    });
    assert.equal(appended.ok, true);
    assert.equal(appended.attempted, 1);
    assert.equal(appended.batch.artifactCount, 3);

    const duplicate = await fixture.service.appendFiles({
      batchId: created.batchId,
      sourceOperation: 'business:export',
      files: [{ filePath: extraPath, role: 'output', direction: 'output' }]
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.results[0].alreadyArchived, true);
    assert.equal(duplicate.batch.artifactCount, 3);
  } finally {
    fixture.close();
  }
});

test('批量复制开始前先登记整批文件，进程中断后不会丢失后续重试线索', async () => {
  const fixture = createFixture();
  try {
    const sourcePaths = [
      writeSource(fixture, 'first.xlsx', 'first'),
      writeSource(fixture, 'second.xlsx', 'second'),
      writeSource(fixture, 'third.xlsx', 'third')
    ];
    let registeredBeforeFirstRead = 0;
    let firstRead = true;
    fixture.service.fs = {
      ...fs,
      createReadStream(filePath, options) {
        if (firstRead) {
          firstRead = false;
          const [batch] = fixture.service.repository.listBatches({ limit: 10 });
          registeredBeforeFirstRead = fixture.service.repository.listArtifacts(batch.id).length;
        }
        return fs.createReadStream(filePath, options);
      }
    };

    const created = await fixture.service.createBatch({
      ...batchPayload('register-before-copy'),
      sourceOperation: 'business:run',
      files: sourcePaths.map((filePath) => ({ filePath, role: 'input' }))
    });

    assert.equal(created.ok, true);
    assert.equal(registeredBeforeFirstRead, 3);
    assert.equal(created.batch.artifactCount, 3);
  } finally {
    fixture.close();
  }
});

test('存档失败以明确结果返回且不泄露绝对路径，修复源文件后可按批次重试', async () => {
  const fixture = createFixture();
  try {
    const missingPath = path.join(fixture.sourceDir, 'private-customer-source.xlsx');
    const created = await fixture.service.createBatch(batchPayload('retry-batch'));
    assert.equal(created.ok, true);

    let failure;
    await assert.doesNotReject(async () => {
      failure = await fixture.service.attachFile(created.batch.id, {
        filePath: missingPath,
        role: 'source',
        sourceOperation: 'import'
      });
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.metadataRecorded, true);
    assert.equal(failure.code, 'ARCHIVE_ENOENT');
    assert.equal(JSON.stringify(failure).includes(fixture.tempDir), false);

    const failedBatch = await fixture.service.getBatch(created.batch.id);
    assert.equal(failedBatch.batch.archiveStatus, 'incomplete');
    assert.equal(failedBatch.batch.failureCount, 1);
    assert.equal(failedBatch.batch.artifacts[0].status, 'failed');
    assert.equal('sourcePath' in failedBatch.batch.artifacts[0], false);

    fs.writeFileSync(missingPath, 'available-on-retry');
    const retried = await fixture.service.retryBatch(created.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.attempted, 1);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.batch.archiveStatus, 'complete');
    assert.equal(retried.batch.retryCount, 1);

    const detail = await fixture.service.getBatch(created.batch.id);
    assert.equal(detail.batch.artifacts[0].attemptCount, 2);
    assert.equal(detail.batch.artifacts[0].status, 'ready');
    assert.equal('relativePath' in detail.batch.artifacts[0].blob, false);

    const marked = await fixture.service.markBatchStatus(created.batch.id, 'business-complete');
    assert.equal(marked.ok, true);
    assert.equal(marked.batch.businessStatus, 'business-complete');
    const recorded = await fixture.service.recordFailure(created.batch.id, {
      code: 'SOURCE_NOTICE',
      message: '上游补充告警',
      sourceOperation: 'business-operation'
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.batch.failureCount, 2);
  } finally {
    fixture.close();
  }
});

test('源文件仅在存档成功或批次删除后释放，失败重试期间保持可用', async () => {
  const releasedPaths = [];
  const fixture = createFixture({
    onSourceReleased: (paths) => releasedPaths.push(...paths)
  });
  try {
    const retryPath = path.join(fixture.sourceDir, 'position-retry.xlsx');
    const retryBatch = await fixture.service.createBatch(batchPayload('position-retry-source'));
    const failed = await fixture.service.attachFile(retryBatch.batch.id, {
      filePath: retryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(releasedPaths, []);

    fs.writeFileSync(retryPath, 'retry-source');
    const retried = await fixture.service.retryBatch(retryBatch.batch.id);
    assert.equal(retried.ok, true);
    assert.deepEqual(releasedPaths, [retryPath]);

    const deletePath = path.join(fixture.sourceDir, 'position-delete.xlsx');
    const deleteBatch = await fixture.service.createBatch(batchPayload('position-delete-source'));
    const deleteFailure = await fixture.service.attachFile(deleteBatch.batch.id, {
      filePath: deletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(deleteFailure.ok, false);
    assert.deepEqual(releasedPaths, [retryPath]);

    const deleted = await fixture.service.deleteBatch(deleteBatch.batch.id);
    assert.equal(deleted.metadataDeleted, true);
    assert.deepEqual(releasedPaths, [retryPath, deletePath]);
  } finally {
    fixture.close();
  }
});

test('同一源文件仍被其它未完成 artifact 引用时不得提前释放', async () => {
  const releasedPaths = [];
  const fixture = createFixture({
    onSourceReleased: (paths) => releasedPaths.push(...paths)
  });
  try {
    const sharedRetryPath = path.join(fixture.sourceDir, 'position-shared-retry.xlsx');
    const failedBatch = await fixture.service.createBatch(batchPayload('position-shared-failed'));
    const failed = await fixture.service.attachFile(failedBatch.batch.id, {
      filePath: sharedRetryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(failed.ok, false);

    fs.writeFileSync(sharedRetryPath, 'shared-retry-source');
    const completedBatch = await fixture.service.createBatch(batchPayload('position-shared-complete'));
    const completed = await fixture.service.attachFile(completedBatch.batch.id, {
      filePath: sharedRetryPath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(completed.ok, true);
    assert.deepEqual(releasedPaths, []);

    const replacementPath = writeSource(fixture, 'position-shared-replacement.xlsx', 'replacement-source');
    const retried = await fixture.service.retryBatch(failedBatch.batch.id, {
      sourcePaths: {
        [failed.artifact.id]: replacementPath
      }
    });
    assert.equal(retried.ok, true);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath]);

    const sharedDeletePath = path.join(fixture.sourceDir, 'position-shared-delete.xlsx');
    const firstDeleteBatch = await fixture.service.createBatch(batchPayload('position-shared-delete-first'));
    const secondDeleteBatch = await fixture.service.createBatch(batchPayload('position-shared-delete-second'));
    const firstDeleteFailure = await fixture.service.attachFile(firstDeleteBatch.batch.id, {
      filePath: sharedDeletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    const secondDeleteFailure = await fixture.service.attachFile(secondDeleteBatch.batch.id, {
      filePath: sharedDeletePath,
      role: 'input',
      sourceOperation: 'position-import'
    });
    assert.equal(firstDeleteFailure.ok, false);
    assert.equal(secondDeleteFailure.ok, false);

    await fixture.service.deleteBatch(firstDeleteBatch.batch.id);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath]);

    await fixture.service.deleteBatch(secondDeleteBatch.batch.id);
    assert.deepEqual(releasedPaths, [sharedRetryPath, replacementPath, sharedDeletePath]);
  } finally {
    fixture.close();
  }
});

test('源释放回调失败不把已完成存档回滚为失败', async () => {
  const fixture = createFixture({
    onSourceReleased: () => {
      throw new Error('injected release failure');
    }
  });
  try {
    const sourcePath = writeSource(fixture, 'release-failure.xlsx', 'archived');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('release-callback-failure'),
      filePath: sourcePath,
      role: 'input'
    });
    assert.equal(archived.ok, true);
    assert.equal(archived.status, 'ready');
  } finally {
    fixture.close();
  }
});

test('业务完成后源文件发生变化时拒绝错存，并保留明确失败审计', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'changed-after-success.xlsx', 'business-result-v1');
    const sourceSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));
    fs.writeFileSync(sourcePath, 'business-result-v2-changed');

    const result = await fixture.service.archiveFile({
      ...batchPayload('source-changed'),
      filePath: sourcePath,
      role: 'output',
      sourceSnapshot
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal(result.retryable, true);
    assert.match(result.message, /业务完成后发生变化/);
    assert.equal(JSON.stringify(result).includes(fixture.tempDir), false);

    const detail = await fixture.service.getBatch(result.batch.id);
    assert.equal(detail.batch.archiveStatus, 'incomplete');
    assert.equal(detail.batch.artifacts[0].lastErrorCode, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal('sourceSnapshot' in detail.batch.artifacts[0].metadata, false);
  } finally {
    fixture.close();
  }
});

test('源 stat 与当前文件一致但 SHA 不等于业务解析摘要时仍拒绝存档', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'same-stat-different-bytes.xlsx', 'version-A-contents');
    const expectedSha256 = crypto
      .createHash('sha256')
      .update('version-A-contents')
      .digest('hex');
    fs.writeFileSync(sourcePath, 'version-B-contents');
    const currentSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));

    const rejected = await fixture.service.archiveFile({
      ...batchPayload('source-sha-mismatch'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: currentSnapshot,
      expectedSha256
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.equal(rejected.retryable, true);
    assert.match(rejected.message, /业务解析时版本不一致/);
    const detail = await fixture.service.getBatch(rejected.batch.id);
    assert.equal('expectedSha256' in detail.batch.artifacts[0].metadata, false);

    const validPath = writeSource(fixture, 'matching-sha.xlsx', 'matching-contents');
    const valid = await fixture.service.archiveFile({
      ...batchPayload('source-sha-match'),
      filePath: validPath,
      role: 'input',
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(validPath)),
      expectedSha256: crypto.createHash('sha256').update('matching-contents').digest('hex')
    });
    assert.equal(valid.ok, true);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时，同字节文件即使 inode/ctime/mtime 变化仍可按原路径重试', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'same-bytes-new-stat.xlsx', 'same-business-bytes');
    const originalSnapshot = sourceSnapshotFromStat(fs.statSync(sourcePath));
    const expectedSha256 = crypto.createHash('sha256').update('same-business-bytes').digest('hex');
    const expectedSizeBytes = Buffer.byteLength('same-business-bytes');
    fs.rmSync(sourcePath);

    const failed = await fixture.service.archiveFile({
      ...batchPayload('same-bytes-new-stat'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: originalSnapshot,
      expectedSha256,
      expectedSizeBytes
    });
    assert.equal(failed.ok, false);
    fs.writeFileSync(sourcePath, 'same-business-bytes');
    assert.equal(sourceSnapshotMatchesStat(originalSnapshot, fs.statSync(sourcePath)), false);

    const retried = await fixture.service.retryBatch(failed.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    const internal = fixture.service.repository.getArtifact(failed.artifact.id);
    assert.equal(internal.metadata.expectedSizeBytes, expectedSizeBytes);
    const detail = await fixture.service.getBatch(failed.batch.id);
    assert.equal('expectedSizeBytes' in detail.batch.artifacts[0].metadata, false);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时允许同字节替代路径，仍拒绝同长度不同字节', async () => {
  const fixture = createFixture();
  try {
    const originalPath = writeSource(fixture, 'original-for-override.xlsx', 'expected-version');
    const originalSnapshot = sourceSnapshotFromStat(fs.statSync(originalPath));
    const expectedSha256 = crypto.createHash('sha256').update('expected-version').digest('hex');
    const expectedSizeBytes = Buffer.byteLength('expected-version');
    fs.rmSync(originalPath);

    const failed = await fixture.service.archiveFile({
      ...batchPayload('replacement-path-same-sha'),
      filePath: originalPath,
      role: 'input',
      sourceSnapshot: originalSnapshot,
      expectedSha256,
      expectedSizeBytes
    });
    const wrongPath = writeSource(fixture, 'wrong-same-size.xlsx', 'different-bytes!');
    assert.equal(Buffer.byteLength('different-bytes!'), expectedSizeBytes);
    const rejected = await fixture.service.retryBatch(failed.batch.id, {
      sourcePaths: { [failed.artifact.id]: wrongPath }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.results[0].code, 'ARCHIVE_SOURCE_CHANGED');

    const replacementPath = writeSource(fixture, 'replacement.xlsx', 'expected-version');
    const recovered = await fixture.service.retryBatch(failed.batch.id, {
      sourcePaths: { [failed.artifact.id]: replacementPath }
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.succeeded, 1);
  } finally {
    fixture.close();
  }
});

test('有业务 SHA 时仍拒绝存档读取期间发生变化且不留下 part 或 blob', async () => {
  let sourcePath = '';
  let mutated = false;
  const changingFs = {
    ...fs,
    createReadStream(filePath, options) {
      const stream = fs.createReadStream(filePath, options);
      if (path.resolve(filePath) === sourcePath) {
        stream.once('data', () => {
          if (mutated) return;
          mutated = true;
          fs.writeFileSync(filePath, 'changed-during-read');
        });
      }
      return stream;
    }
  };
  const fixture = createFixture({ fsImpl: changingFs });
  try {
    sourcePath = writeSource(fixture, 'changes-during-read.xlsx', 'original-read-bytes');
    const expectedSha256 = crypto.createHash('sha256').update('original-read-bytes').digest('hex');
    const result = await fixture.service.archiveFile({
      ...batchPayload('source-changes-during-read'),
      filePath: sourcePath,
      role: 'input',
      sourceSnapshot: sourceSnapshotFromStat(fs.statSync(sourcePath)),
      expectedSha256,
      expectedSizeBytes: Buffer.byteLength('original-read-bytes')
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SOURCE_CHANGED');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);
    const blobFiles = fs.readdirSync(path.join(fixture.rootDir, 'blobs', 'sha256'), {
      recursive: true
    }).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
    assert.deepEqual(blobFiles, []);
  } finally {
    fixture.close();
  }
});

test('cleanupExpired 按本地日清理，保留日当天不删且锁定批次跳过', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'retention.xlsx', 'retention-content');
    const expired = await fixture.service.archiveFile({
      ...batchPayload('expired', {
        localDate: '2026-07-01',
        retentionUntil: '2026-07-19'
      }),
      filePath: sourcePath,
      role: 'output'
    });
    const boundary = await fixture.service.archiveFile({
      ...batchPayload('boundary', {
        localDate: '2026-07-01',
        retentionUntil: '2026-07-20'
      }),
      filePath: sourcePath,
      role: 'output'
    });
    const locked = await fixture.service.archiveFile({
      ...batchPayload('locked', {
        localDate: '2026-07-01',
        retentionUntil: '2026-07-10',
        locked: true
      }),
      filePath: sourcePath,
      role: 'output'
    });

    const cleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.candidateCount, 1);
    assert.equal(cleanup.deletedBatchCount, 1);
    assert.equal((await fixture.service.getBatch(expired.batch.id)).status, 'not-found');
    assert.equal((await fixture.service.getBatch(boundary.batch.id)).ok, true);
    assert.equal((await fixture.service.getBatch(locked.batch.id)).ok, true);

    const lockedDelete = await fixture.service.deleteBatch(locked.batch.id);
    assert.equal(lockedDelete.ok, false);
    assert.equal(lockedDelete.code, 'ARCHIVE_BATCH_LOCKED');
    const unlocked = await fixture.service.setLocked(locked.batch.id, false);
    assert.equal(unlocked.status, 'unlocked');
    const secondCleanup = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-07-20' });
    assert.equal(secondCleanup.deletedBatchCount, 1);
  } finally {
    fixture.close();
  }
});

test('initialize 清理 staging/只读副本和孤儿 blob，并把缺失本体改为可重试失败态', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'startup.xlsx', 'startup-content');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('startup-consistency'),
      filePath: sourcePath,
      role: 'source'
    });
    assert.equal(archived.ok, true);

    const managedBlob = path.join(
      fixture.rootDir,
      ...blobRelativePath(archived.sha256).split('/')
    );
    fs.rmSync(managedBlob);
    fs.writeFileSync(path.join(fixture.rootDir, '.staging', 'stale.part'), 'partial');
    const readonlyStaleDir = path.join(fixture.rootDir, '.readonly', 'stale');
    fs.mkdirSync(readonlyStaleDir, { recursive: true });
    fs.writeFileSync(path.join(readonlyStaleDir, 'copy.xlsx'), 'copy');

    const orphanContent = 'orphan-content';
    const orphanHash = crypto.createHash('sha256').update(orphanContent).digest('hex');
    const orphanPath = path.join(fixture.rootDir, ...blobRelativePath(orphanHash).split('/'));
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, orphanContent);

    const restarted = createArchiveService({
      database: fixture.db,
      rootDir: fixture.rootDir,
      now: () => new Date(2026, 6, 20, 12, 5, 0)
    });
    const initialized = await restarted.initialize();

    assert.equal(initialized.available, true);
    assert.equal(initialized.consistency.removedStagingEntries, 1);
    assert.equal(initialized.consistency.removedReadonlyEntries, 1);
    assert.equal(initialized.consistency.invalidBlobCount, 1);
    assert.equal(initialized.consistency.removedOrphanBlobFiles, 1);
    assert.equal(fs.existsSync(orphanPath), false);

    const repaired = await restarted.getBatch(archived.batch.id);
    assert.equal(repaired.batch.archiveStatus, 'incomplete');
    assert.equal(repaired.batch.artifacts[0].status, 'failed');
    assert.equal(repaired.batch.artifacts[0].lastErrorCode, 'ARCHIVE_BLOB_MISSING');
  } finally {
    fixture.close();
  }
});

test('openReadonlyCopy 和 saveAs 只复制存档内容，不暴露或改写 blob', async () => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'result.xlsx', 'archived-result');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('copy-actions'),
      filePath: sourcePath,
      role: 'output',
      direction: 'output'
    });

    const readonly = await fixture.service.openReadonlyCopy(archived.artifact.id);
    assert.equal(readonly.ok, true);
    assert.equal(readonly.status, 'copy-ready');
    assert.equal(fs.readFileSync(readonly.filePath, 'utf8'), 'archived-result');
    assert.equal(fs.statSync(readonly.filePath).mode & 0o222, 0);

    const internalTarget = path.join(fixture.rootDir, 'manual-copy.xlsx');
    const rejectedInternal = await fixture.service.saveAs(archived.artifact.id, internalTarget);
    assert.equal(rejectedInternal.ok, false);
    assert.equal(rejectedInternal.code, 'ARCHIVE_SAVE_TARGET_INVALID');
    assert.equal(fs.existsSync(internalTarget), false);

    const targetPath = path.join(fixture.tempDir, 'saved', 'result-copy.xlsx');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'old-target');
    const saved = await fixture.service.saveAs(archived.artifact.id, targetPath);
    assert.equal(saved.ok, true);
    assert.equal(saved.status, 'saved');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'archived-result');
    assert.deepEqual(
      fs.readdirSync(path.dirname(targetPath)).filter((name) => name.startsWith('.archive-save-')),
      []
    );

    const detail = await fixture.service.getBatch(archived.batch.id);
    assert.equal('sourcePath' in detail.batch.artifacts[0], false);
    assert.equal('relativePath' in detail.batch.artifacts[0].blob, false);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'archived-result');
  } finally {
    fixture.close();
  }
});

test('另存目标经目录链接指向存档根时仍拒绝写入', async (t) => {
  const fixture = createFixture();
  try {
    const sourcePath = writeSource(fixture, 'linked-target.xlsx', 'linked-target-content');
    const archived = await fixture.service.archiveFile({
      ...batchPayload('linked-save-target'),
      filePath: sourcePath,
      role: 'output'
    });
    const linkedDir = path.join(fixture.tempDir, 'archive-alias');
    try {
      fs.symlinkSync(
        fixture.rootDir,
        linkedDir,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`当前环境不能创建目录链接：${error.code}`);
        return;
      }
      throw error;
    }

    const result = await fixture.service.saveAs(
      archived.artifact.id,
      path.join(linkedDir, 'must-not-write.xlsx')
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SAVE_TARGET_INVALID');
    assert.equal(fs.existsSync(path.join(fixture.rootDir, 'must-not-write.xlsx')), false);
  } finally {
    fixture.close();
  }
});

test('发布 rename 失败时不 reject、不留下 staging 或半成品 blob', async () => {
  const basePromises = fs.promises;
  const failingFs = {
    ...fs,
    promises: {
      ...basePromises,
      async rename(sourcePath, targetPath) {
        if (sourcePath.endsWith('.part') && targetPath.includes(`${path.sep}blobs${path.sep}`)) {
          const error = new Error('injected publish failure');
          error.code = 'EACCES';
          throw error;
        }
        return basePromises.rename(sourcePath, targetPath);
      }
    }
  };
  const fixture = createFixture({ fsImpl: failingFs });
  try {
    const sourcePath = writeSource(fixture, 'publish-failure.xlsx', 'never-published');
    let result;
    await assert.doesNotReject(async () => {
      result = await fixture.service.archiveFile({
        ...batchPayload('publish-failure'),
        filePath: sourcePath,
        role: 'output'
      });
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_EACCES');
    assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, '.staging')), []);
    const blobFiles = fs.readdirSync(path.join(fixture.rootDir, 'blobs', 'sha256'), {
      recursive: true
    }).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
    assert.deepEqual(blobFiles, []);
  } finally {
    fixture.close();
  }
});

test('blob 已发布但元数据提交失败时保留可恢复内容，重试后接续完成', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-metadata-failure-'));
  const rootDir = path.join(tempDir, 'archive-root');
  const sourcePath = path.join(tempDir, 'source.xlsx');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  fs.writeFileSync(sourcePath, 'published-before-metadata');
  const now = () => new Date(2026, 6, 20, 12, 0, 0);
  const repository = createArchiveRepository(db, { now });
  const completeArtifact = repository.completeArtifact.bind(repository);
  let shouldFail = true;
  repository.completeArtifact = (...args) => {
    if (shouldFail) {
      shouldFail = false;
      const error = new Error('injected metadata failure');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return completeArtifact(...args);
  };
  const service = createArchiveService({ repository, rootDir, now });

  try {
    const failed = await service.archiveFile({
      ...batchPayload('metadata-failure'),
      filePath: sourcePath,
      role: 'output'
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ARCHIVE_SQLITE_BUSY');
    assert.equal(failed.metadataRecorded, true);

    const hash = crypto.createHash('sha256').update('published-before-metadata').digest('hex');
    const publishedPath = path.join(rootDir, ...blobRelativePath(hash).split('/'));
    assert.equal(fs.readFileSync(publishedPath, 'utf8'), 'published-before-metadata');
    assert.equal((await service.getStats()).stats.uniqueFileCount, 0);

    const retried = await service.retryBatch(failed.batch.id);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.results[0].deduplicated, true);
    assert.equal((await service.getStats()).stats.uniqueFileCount, 1);
    assert.deepEqual(fs.readdirSync(path.join(rootDir, '.staging')), []);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('存档目录暂不可写时仍登记失败批次，目录恢复后可重试', async () => {
  const basePromises = fs.promises;
  let storageWritable = false;
  let archiveRoot = '';
  const unavailableFs = {
    ...fs,
    promises: {
      ...basePromises,
      async mkdir(targetPath, options) {
        if (!storageWritable && String(targetPath).startsWith(archiveRoot)) {
          const error = new Error('archive storage denied');
          error.code = 'EACCES';
          throw error;
        }
        return basePromises.mkdir(targetPath, options);
      }
    }
  };
  const fixture = createFixture({ fsImpl: unavailableFs });
  archiveRoot = fixture.rootDir;
  try {
    const sourcePath = writeSource(fixture, 'storage-retry.xlsx', 'retry-after-permission');
    const created = await fixture.service.createBatch({
      ...batchPayload('storage-retry'),
      sourceOperation: 'business:run',
      files: [{ filePath: sourcePath, role: 'input' }]
    });

    assert.equal(created.ok, false);
    assert.ok(created.batchId);
    assert.equal(created.batch.archiveStatus, 'incomplete');
    assert.equal(created.failed, 1);
    const failed = await fixture.service.getBatch(created.batchId);
    assert.equal(failed.ok, true);
    assert.equal(failed.batch.artifacts[0].status, 'failed');
    assert.equal(failed.batch.artifacts[0].lastErrorCode, 'ARCHIVE_EACCES');

    storageWritable = true;
    const retried = await fixture.service.retryBatch(created.batchId);
    assert.equal(retried.ok, true);
    assert.equal(retried.succeeded, 1);
    assert.equal(retried.batch.archiveStatus, 'complete');
  } finally {
    fixture.close();
  }
});

test('数据库初始化不可用也只返回 unavailable，不向业务 Promise 抛错', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-init-failure-'));
  const service = createArchiveService({
    rootDir: path.join(tempDir, 'archive-root'),
    repository: {
      ensureSchema() {
        const error = new Error('database path must stay private');
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
    }
  });
  try {
    let result;
    await assert.doesNotReject(async () => {
      result = await service.createBatch(batchPayload('unavailable'));
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARCHIVE_SQLITE_CANTOPEN');
    assert.equal(result.message.includes('database path must stay private'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
