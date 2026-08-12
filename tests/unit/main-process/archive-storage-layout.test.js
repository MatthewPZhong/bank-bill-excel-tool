'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  STORAGE_LAYOUT_VERSION,
  assignLayoutNames,
  batchRelativeDirectory,
  sanitizeOriginalName
} = require('../../../src/main-process/archive-center/storage-layout');
const {
  createStorageMaterializer,
  verifyFile
} = require('../../../src/main-process/archive-center/storage-materializer');
const {
  blobRelativePath,
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');

function fixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-layout-'));
  const rootDir = path.join(tempDir, 'root');
  const stagingDir = path.join(rootDir, '.staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  return {
    rootDir,
    stagingDir,
    tempDir,
    close() {
      fs.chmodSync(tempDir, 0o700);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function serviceFixture(options = {}) {
  const current = fixture();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const sourceDir = path.join(current.tempDir, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const service = createArchiveService({
    database: db,
    rootDir: current.rootDir,
    now: () => new Date(2026, 7, 11, 12, 0, 0),
    ...options
  });
  return {
    ...current,
    db,
    service,
    sourceDir,
    writeSource(name, content) {
      const filePath = path.join(sourceDir, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    },
    close() {
      db.close();
      current.close();
    }
  };
}

function archivePayload(operationKey, filePath, overrides = {}) {
  return {
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey,
    localDate: '2026-08-11',
    filePath,
    role: 'source',
    sourceOperation: 'import',
    ...overrides
  };
}

test('layout v2 精确使用 local_date/真实批次号，同批输入输出稳定分配文件名', () => {
  const rootDir = path.join(os.tmpdir(), '存档中心');
  const batch = { localDate: '2026-08-11', batchNumber: '2026-08-11-007' };
  const artifacts = [
    { id: 11, artifactOrder: 1, artifactKey: 'input-1', originalName: '账单.xlsx' },
    { id: 12, artifactOrder: 2, artifactKey: 'output-1', originalName: '账单.xlsx' },
    { id: 13, artifactOrder: 3, artifactKey: 'output-2', originalName: 'CON.xlsx' }
  ];

  assert.equal(batchRelativeDirectory(batch), '2026/2026-08/2026-08-11/2026-08-11-007');
  assert.deepEqual(assignLayoutNames(rootDir, batch, artifacts), [
    {
      artifactId: 11,
      artifactOrder: 1,
      safeFileName: '账单.xlsx',
      storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-007/账单.xlsx',
      storageLayoutVersion: STORAGE_LAYOUT_VERSION
    },
    {
      artifactId: 12,
      artifactOrder: 2,
      safeFileName: '账单 (2).xlsx',
      storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-007/账单 (2).xlsx',
      storageLayoutVersion: STORAGE_LAYOUT_VERSION
    },
    {
      artifactId: 13,
      artifactOrder: 3,
      safeFileName: '_CON.xlsx',
      storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-007/_CON.xlsx',
      storageLayoutVersion: STORAGE_LAYOUT_VERSION
    }
  ]);
});

test('Windows 非法字符、保留名、尾点空格与长文件名得到稳定安全名称', () => {
  assert.equal(sanitizeOriginalName('AUX.txt'), '_AUX.txt');
  assert.equal(sanitizeOriginalName('报告<>:"|?*.xlsx  .'), '报告_______.xlsx');
  const first = sanitizeOriginalName(`${'很长'.repeat(120)}.xlsx`, { identity: 'artifact-9' });
  const second = sanitizeOriginalName(`${'很长'.repeat(120)}.xlsx`, { identity: 'artifact-9' });
  assert.equal(first, second);
  assert.ok(Array.from(first).length <= 160);
  assert.match(first, /-[a-f0-9]{8}\.xlsx$/);
});

test('Windows 路径预算按 UTF-16 code units 截断 emoji，过长根路径 fail-closed', () => {
  const batch = { localDate: '2026-08-11', batchNumber: '2026-08-11-127' };
  const rootDir = path.join(os.tmpdir(), '存档中心');
  const [assigned] = assignLayoutNames(rootDir, batch, [{
    id: 91,
    artifactOrder: 1,
    artifactKey: 'emoji-output',
    originalName: `${'😀'.repeat(200)}.xlsx`
  }]);
  const absolutePath = path.join(rootDir, ...assigned.storageRelativePath.split('/'));
  assert.ok(absolutePath.length <= 240);
  assert.ok(assigned.safeFileName.length <= 160);
  assert.equal(/[\uD800-\uDBFF]$/.test(assigned.safeFileName), false);

  const longRoot = path.join(os.tmpdir(), 'r'.repeat(230));
  assert.throws(
    () => assignLayoutNames(longRoot, batch, [{
      id: 92,
      artifactOrder: 1,
      artifactKey: 'too-long-root',
      originalName: 'result.xlsx'
    }]),
    (error) => error && error.code === 'ARCHIVE_LAYOUT_PATH_TOO_LONG'
  );
});

test('真实 hardlink 物化后大小/hash一致且共享 inode 只读', async () => {
  const current = fixture();
  try {
    const content = Buffer.from('hardlink-content');
    const canonicalPath = path.join(current.rootDir, 'blobs', 'canonical');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, content);
    const materializer = createStorageMaterializer(current);
    const result = await materializer.materialize({
      artifactId: 1,
      canonicalPath,
      storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-001/source.xlsx',
      sha256: hash(content),
      sizeBytes: content.length
    });

    assert.equal(result.mode, 'hardlink');
    const canonicalStat = fs.statSync(canonicalPath);
    const targetStat = fs.statSync(result.targetPath);
    assert.equal(canonicalStat.ino, targetStat.ino);
    assert.equal(targetStat.mode & 0o222, 0);
    assert.equal((await verifyFile(result.targetPath, {
      sha256: hash(content),
      sizeBytes: content.length
    })).valid, true);
  } finally {
    current.close();
  }
});

test('hardlink 真实能力错误才降级为流式 copy，校验后文件只读', async () => {
  const current = fixture();
  try {
    const content = Buffer.from('copy-content');
    const canonicalPath = path.join(current.rootDir, 'blobs', 'canonical');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, content);
    const materializer = createStorageMaterializer({
      ...current,
      async linkFile() {
        const error = new Error('cross device');
        error.code = 'EXDEV';
        throw error;
      }
    });
    const result = await materializer.materialize({
      artifactId: 2,
      canonicalPath,
      storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-002/output.xlsx',
      sha256: hash(content),
      sizeBytes: content.length
    });

    assert.equal(result.mode, 'copy');
    assert.notEqual(fs.statSync(canonicalPath).ino, fs.statSync(result.targetPath).ino);
    assert.equal(fs.statSync(result.targetPath).mode & 0o222, 0);
    assert.equal(fs.readFileSync(result.targetPath, 'utf8'), 'copy-content');
  } finally {
    current.close();
  }
});

test('非 hardlink 能力错误不 fallback，失败后不留下空业务目录', async () => {
  const current = fixture();
  try {
    const content = Buffer.from('must-not-copy');
    const canonicalPath = path.join(current.rootDir, 'blobs', 'canonical');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, content);
    const materializer = createStorageMaterializer({
      ...current,
      async linkFile() {
        const error = new Error('io failure');
        error.code = 'EIO';
        throw error;
      }
    });
    await assert.rejects(
      materializer.materialize({
        artifactId: 3,
        canonicalPath,
        storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-003/input.xlsx',
        sha256: hash(content),
        sizeBytes: content.length
      }),
      (error) => error.code === 'ARCHIVE_MATERIALIZATION_FAILED' && error.cause.code === 'EIO'
    );
    assert.equal(fs.existsSync(path.join(current.rootDir, '2026')), false);
    assert.deepEqual(fs.readdirSync(current.stagingDir), []);
  } finally {
    current.close();
  }
});

test('layout 父目录链接不能把物化写出 root containment', async (t) => {
  const current = fixture();
  try {
    const content = Buffer.from('contained');
    const canonicalPath = path.join(current.rootDir, 'blobs', 'canonical');
    const outsideDir = path.join(current.tempDir, 'outside');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    try {
      fs.symlinkSync(
        outsideDir,
        path.join(current.rootDir, '2026'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`当前环境不能创建目录链接：${error.code}`);
        return;
      }
      throw error;
    }
    fs.writeFileSync(canonicalPath, content);
    const materializer = createStorageMaterializer(current);

    await assert.rejects(
      materializer.materialize({
        artifactId: 4,
        canonicalPath,
        storageRelativePath: '2026/2026-08/2026-08-11/2026-08-11-004/input.xlsx',
        sha256: hash(content),
        sizeBytes: content.length
      }),
      (error) => error.code === 'ARCHIVE_LAYOUT_PATH_INVALID'
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
    assert.deepEqual(fs.readdirSync(current.stagingDir), []);
  } finally {
    current.close();
  }
});

test('无 ready artifact 不建业务目录，后续同批输入输出按真实批次号创建', async () => {
  const current = serviceFixture();
  try {
    await current.service.initialize();
    const empty = await current.service.createBatch({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'metadata-only',
      localDate: '2026-08-11'
    });
    assert.equal(empty.ok, true);
    assert.equal(fs.existsSync(path.join(current.rootDir, '2026')), false);

    const inputPath = current.writeSource('same.xlsx', 'input');
    const outputPath = current.writeSource('other.xlsx', 'output');
    const appended = await current.service.appendFiles({
      batchId: empty.batch.id,
      files: [
        { filePath: inputPath, originalName: '同名.xlsx', direction: 'input', role: 'source' },
        { filePath: outputPath, originalName: '同名.xlsx', direction: 'output', role: 'result' }
      ]
    });
    assert.equal(appended.ok, true);
    const batchDir = path.join(
      current.rootDir,
      '2026',
      '2026-08',
      '2026-08-11',
      empty.batch.batchNumber
    );
    assert.deepEqual(fs.readdirSync(batchDir).sort(), ['同名 (2).xlsx', '同名.xlsx']);
  } finally {
    current.close();
  }
});

test('目录化能力失败保留 ready Blob，读取时对同 artifact 修复且不新建批次', async () => {
  let linkUnavailable = true;
  const current = serviceFixture({
    async linkFile(source, target) {
      if (linkUnavailable) {
        const error = new Error('io failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.promises.link(source, target);
    }
  });
  try {
    const sourcePath = current.writeSource('repair.xlsx', 'repair-source');
    const archived = await current.service.archiveFile(archivePayload('repair-pending', sourcePath));
    assert.equal(archived.ok, false);
    assert.equal(archived.status, 'repair-pending');
    assert.equal(archived.canonicalReady, true);
    assert.equal(archived.artifact.status, 'ready');
    assert.equal(archived.batch.archiveStatus, 'incomplete');
    assert.equal(fs.existsSync(path.join(current.rootDir, '2026')), false);
    assert.equal(current.service.repository.listBatches().length, 1);

    linkUnavailable = false;
    const opened = await current.service.openReadonlyCopy(archived.artifact.id);
    assert.equal(opened.ok, true);
    assert.equal(fs.readFileSync(opened.filePath, 'utf8'), 'repair-source');
    const repaired = current.service.repository.getArtifact(archived.artifact.id);
    assert.equal(repaired.id, archived.artifact.id);
    assert.equal(repaired.storageLayoutVersion, STORAGE_LAYOUT_VERSION);
    assert.equal(repaired.materializationErrorCode, '');
    assert.equal(current.service.repository.getBatch(repaired.batchId).archiveStatus, 'complete');
    assert.equal(current.service.repository.listBatches().length, 1);
  } finally {
    current.close();
  }
});

test('copy materialized 被篡改后从 valid canonical 修复，artifact/Blob identity 不变', async () => {
  const current = serviceFixture({
    async linkFile() {
      const error = new Error('cross device');
      error.code = 'EXDEV';
      throw error;
    }
  });
  try {
    const sourcePath = current.writeSource('copy.xlsx', 'copy-original');
    const archived = await current.service.archiveFile(archivePayload('copy-repair', sourcePath));
    assert.equal(archived.ok, true);
    assert.equal(Object.hasOwn(archived.artifact, 'storageRelativePath'), false);
    const before = current.service.repository.getArtifact(archived.artifact.id);
    assert.equal(before.storageMode, 'copy');
    const layoutPath = path.join(current.rootDir, ...before.storageRelativePath.split('/'));
    fs.chmodSync(layoutPath, 0o644);
    fs.writeFileSync(layoutPath, 'copy-tampered');

    const opened = await current.service.openReadonlyCopy(before.id);
    assert.equal(opened.ok, true);
    assert.equal(fs.readFileSync(opened.filePath, 'utf8'), 'copy-original');
    const after = current.service.repository.getArtifact(before.id);
    assert.equal(after.id, before.id);
    assert.equal(after.blobId, before.blobId);
    assert.equal(after.blob.sha256, before.blob.sha256);
    assert.equal(fs.readFileSync(layoutPath, 'utf8'), 'copy-original');
    assert.equal(after.materializationErrorCode, '');
  } finally {
    current.close();
  }
});

test('hardlink/canonical 同 inode 污染按 DB hash fail-closed，只能从可信源重试', async () => {
  const current = serviceFixture();
  try {
    const original = 'hardlink-original';
    const sourcePath = current.writeSource('hardlink.xlsx', original);
    const archived = await current.service.archiveFile(archivePayload('hardlink-tamper', sourcePath));
    const before = current.service.repository.getArtifact(archived.artifact.id);
    const layoutPath = path.join(current.rootDir, ...before.storageRelativePath.split('/'));
    const canonicalPath = path.join(current.rootDir, ...before.blob.relativePath.split('/'));
    assert.equal(fs.statSync(layoutPath).ino, fs.statSync(canonicalPath).ino);
    fs.chmodSync(layoutPath, 0o644);
    fs.writeFileSync(layoutPath, 'x'.repeat(Buffer.byteLength(original)));

    const opened = await current.service.openReadonlyCopy(before.id);
    assert.equal(opened.ok, false);
    assert.equal(opened.code, 'ARCHIVE_BLOB_INVALID');
    const invalid = current.service.repository.getArtifact(before.id);
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.blob, null);
    assert.equal(fs.existsSync(layoutPath), false);
    assert.equal(fs.existsSync(canonicalPath), false);

    const retried = await current.service.retryBatch(before.batchId);
    assert.equal(retried.ok, true);
    const repaired = current.service.repository.getArtifact(before.id);
    assert.equal(repaired.id, before.id);
    assert.equal(repaired.blob.sha256, hash(original));
    assert.equal(fs.readFileSync(
      path.join(current.rootDir, ...repaired.storageRelativePath.split('/')),
      'utf8'
    ), original);
  } finally {
    current.close();
  }
});

test('历史 ready artifact 重启后按旧批次号续跑目录化', async () => {
  const current = serviceFixture();
  try {
    const sourcePath = current.writeSource('legacy.xlsx', 'legacy-content');
    const archived = await current.service.archiveFile(archivePayload('legacy-resume', sourcePath));
    const artifact = current.service.repository.getArtifact(archived.artifact.id);
    const oldBatch = current.service.repository.getBatch(artifact.batchId);
    const layoutPath = path.join(current.rootDir, ...artifact.storageRelativePath.split('/'));
    fs.rmSync(layoutPath, { force: true });
    current.db.prepare(`
      UPDATE archive_artifacts
      SET storage_relative_path = NULL, storage_mode = NULL,
          storage_layout_version = 1, safe_file_name = NULL, artifact_order = NULL,
          materialization_error_code = NULL,
          materialization_error_message = NULL,
          materialization_failed_at = NULL
      WHERE id = ?
    `).run(artifact.id);
    current.db.prepare(`
      UPDATE archive_batches SET archive_status = 'incomplete' WHERE id = ?
    `).run(oldBatch.id);

    const restarted = createArchiveService({
      database: current.db,
      rootDir: current.rootDir,
      now: () => new Date(2026, 7, 11, 12, 0, 0)
    });
    const initialized = await restarted.initialize();
    assert.equal(initialized.available, true);
    const resumed = restarted.repository.getArtifact(artifact.id);
    assert.equal(restarted.repository.getBatch(oldBatch.id).batchNumber, oldBatch.batchNumber);
    assert.equal(resumed.storageLayoutVersion, STORAGE_LAYOUT_VERSION);
    assert.equal(fs.readFileSync(
      path.join(current.rootDir, ...resumed.storageRelativePath.split('/')),
      'utf8'
    ), 'legacy-content');
  } finally {
    current.close();
  }
});

test('共享 Blob 仅最后引用回收，manual/retention 清理批次目录与空年月日层级', async () => {
  const current = serviceFixture();
  try {
    const firstPath = current.writeSource('first.xlsx', 'shared-content');
    const secondPath = current.writeSource('second.xlsx', 'shared-content');
    const first = await current.service.archiveFile(archivePayload('shared-first', firstPath));
    const second = await current.service.archiveFile(archivePayload('shared-second', secondPath, {
      retentionUntil: '2026-08-12'
    }));
    const firstArtifact = current.service.repository.getArtifact(first.artifact.id);
    const secondArtifact = current.service.repository.getArtifact(second.artifact.id);
    const blobPath = path.join(current.rootDir, ...firstArtifact.blob.relativePath.split('/'));
    const firstLayout = path.join(current.rootDir, ...firstArtifact.storageRelativePath.split('/'));
    const secondLayout = path.join(current.rootDir, ...secondArtifact.storageRelativePath.split('/'));

    const manual = await current.service.deleteBatch(first.batch.id);
    assert.equal(manual.ok, true);
    assert.equal(manual.releasedBlobCount, 0);
    assert.equal(fs.existsSync(firstLayout), false);
    assert.equal(fs.existsSync(secondLayout), true);
    assert.equal(fs.existsSync(blobPath), true);

    const retention = await current.service.cleanupExpired({ asOfLocalDate: '2026-08-13' });
    assert.equal(retention.ok, true);
    assert.equal(retention.deletedBatchCount, 1);
    assert.equal(fs.existsSync(secondLayout), false);
    assert.equal(fs.existsSync(blobPath), false);
    assert.equal(fs.existsSync(path.join(current.rootDir, '2026')), false);
  } finally {
    current.close();
  }
});

test('目录清理失败保留单一 cleanup-pending，启动幂等续跑且元数据不复活', async () => {
  let failDirectoryCleanup = true;
  let batchDirectory = '';
  const promises = {
    ...fs.promises,
    async rmdir(targetPath) {
      if (failDirectoryCleanup && path.resolve(targetPath) === batchDirectory) {
        const error = new Error('directory busy');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.rmdir(targetPath);
    }
  };
  const current = serviceFixture({ fsImpl: { ...fs, promises } });
  try {
    const sourcePath = current.writeSource('cleanup.xlsx', 'cleanup-content');
    const archived = await current.service.archiveFile(archivePayload('cleanup-pending', sourcePath));
    const artifact = current.service.repository.getArtifact(archived.artifact.id);
    batchDirectory = path.dirname(path.join(current.rootDir, ...artifact.storageRelativePath.split('/')));
    const canonicalPath = path.join(current.rootDir, ...artifact.blob.relativePath.split('/'));

    const deleted = await current.service.deleteBatch(artifact.batchId);
    assert.equal(deleted.status, 'deleted-cleanup-pending');
    assert.equal(deleted.metadataDeleted, true);
    assert.equal(current.service.repository.getBatch(artifact.batchId), null);
    assert.equal(current.service.repository.listCleanupJobs().length, 1);
    assert.equal(fs.existsSync(canonicalPath), false);

    failDirectoryCleanup = false;
    const restarted = createArchiveService({
      database: current.db,
      rootDir: current.rootDir,
      now: () => new Date(2026, 7, 11, 12, 0, 0),
      fsImpl: { ...fs, promises }
    });
    const initialized = await restarted.initialize();
    assert.equal(initialized.available, true);
    assert.deepEqual(restarted.repository.listCleanupJobs(), []);
    assert.equal(restarted.repository.getBatch(artifact.batchId), null);
    assert.equal(fs.existsSync(batchDirectory), false);
  } finally {
    current.close();
  }
});
