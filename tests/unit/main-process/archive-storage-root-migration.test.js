'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ARCHIVE_INSTANCE_ID_SETTING_KEY,
  ARCHIVE_STORAGE_ROOT_SETTING_KEY,
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  createArchiveRuntimeDelegate
} = require('../../../src/main-process/archive-center/archive-runtime-delegate');
const { buildDeletePlan } = require('../../../src/main-process/archive-center/batch-delete-plan');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  ROOT_MARKER_FILE,
  createArchiveStorageRootManager,
  exactMarker
} = require('../../../src/main-process/archive-center/storage-root-manager');

function portablePathOf(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

function isCanonicalBlobParentOpen(filePath, openMode) {
  return ['r', 'r+'].includes(openMode)
    && /\/blobs\/sha256\/[0-9a-f]{2}$/i.test(portablePathOf(filePath));
}

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    db,
    getSetting(key) {
      const row = db.prepare(`
        SELECT setting_value AS value FROM app_settings WHERE setting_key = ?
      `).get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      db.prepare(`
        INSERT INTO app_settings(setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
      `).run(key, value, new Date().toISOString());
    }
  };
}

async function createFixture(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-root-migration-'));
  const sourceRoot = path.join(tempDir, 'source-root');
  const targetRoot = options.targetMode === 'current'
    ? sourceRoot
    : options.targetMode === 'descendant'
      ? path.join(sourceRoot, 'nested-target')
      : options.targetMode === 'ancestor'
        ? tempDir
        : path.join(tempDir, 'target-root');
  const defaultRoot = path.join(tempDir, 'default-root');
  const journalPath = path.join(tempDir, 'run-data', 'storage-migration.json');
  const database = createDatabase();
  const repository = createArchiveRepository(database.db, {
    now: () => new Date('2026-08-11T04:00:00.000Z')
  });
  repository.ensureSchema();
  const sourceService = createArchiveService({
    database: database.db,
    rootDir: sourceRoot,
    now: () => new Date(2026, 7, 11, 12, 0, 0),
    fsImpl: options.fsImpl
  });
  const sourceFile = path.join(tempDir, 'statement.xlsx');
  fs.writeFileSync(sourceFile, 'archive-root-migration-content');
  const archived = await sourceService.archiveFile({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'storage-migration-fixture',
    localDate: '2026-08-11',
    filePath: sourceFile,
    direction: 'input',
    role: 'source',
    sourceOperation: 'import'
  });
  assert.equal(archived.ok, true);
  const artifact = repository.getArtifact(archived.artifact.id);
  const runtime = createArchiveRuntimeDelegate({ repository, rootDir: sourceRoot });
  const progress = [];
  const manager = createArchiveStorageRootManager({
    database,
    repository,
    runtimeDelegate: runtime,
    defaultRoot: sourceRoot,
    journalPath,
    blockedRoots: [],
    fsImpl: options.fsImpl,
    faultInjector: options.faultInjector,
    waitForArchiveOperations: options.waitForArchiveOperations,
    deferStartupRecovery: options.deferStartupRecovery === true,
    showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }),
    onProgress: (value) => progress.push(value),
    createService: (rootDir) => createArchiveService({
      database: database.db,
      rootDir,
      now: () => new Date(2026, 7, 11, 12, 0, 0),
      fsImpl: options.fsImpl
    })
  });
  return {
    artifact,
    database,
    defaultRoot,
    journalPath,
    manager,
    progress,
    repository,
    runtime,
    sourceRoot,
    targetRoot,
    tempDir,
    close() {
      database.db.close();
      fs.chmodSync(tempDir, 0o700);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function managed(rootDir, relativePath) {
  return path.join(rootDir, ...String(relativePath).split('/'));
}

async function createHistoricalDeleteOverlap({ legacyWithoutIdentity = false } = {}) {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-copy-blob' && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error('模拟升级前迁移中断'), { code: 'SIMULATED_CRASH' });
      }
    }
  });
  await current.manager.initialize();
  await current.manager.currentService.setLocked(current.artifact.batchId, false);
  const deletePlan = legacyWithoutIdentity ? null
    : await buildDeletePlan(current.manager.currentService, current.artifact.batchId);
  fs.mkdirSync(current.targetRoot, { recursive: true });
  assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
  // 直接构造旧准入下已有的持久重叠；V2 对象身份在迁移开始前已采集，不能事后认领。
  const deleted = current.repository.deleteBatch(current.artifact.batchId,
    deletePlan ? { deletePlan } : { allowLocked: true });
  assert.equal(deleted.status, 'deleted');
  assert.ok(deleted.cleanupJob);
  assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null);
  return current;
}

function real(rootDir) {
  // 与 fs.promises.realpath 一样走原生 canonical identity；Windows 不得退回 8.3 short path。
  return fs.realpathSync.native(rootDir);
}

test('fixture 与生产 manager 使用相同的 native canonical path identity', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-native-realpath-'));
  try {
    assert.equal(real(rootDir), await fs.promises.realpath(rootDir));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function createManagerForFixture(current, options = {}) {
  const runtime = options.runtime || createArchiveRuntimeDelegate({
    repository: current.repository,
    rootDir: options.runtimeRoot
  });
  const manager = createArchiveStorageRootManager({
    database: current.database,
    repository: current.repository,
    runtimeDelegate: runtime,
    defaultRoot: current.sourceRoot,
    journalPath: current.journalPath,
    blockedRoots: options.blockedRoots || [],
    fsImpl: options.fsImpl,
    faultInjector: options.faultInjector,
    waitForArchiveOperations: options.waitForArchiveOperations,
    deferStartupRecovery: options.deferStartupRecovery === true,
    showOpenDialog: options.showOpenDialog || (async () => ({
      canceled: false,
      filePaths: [options.targetRoot || current.targetRoot]
    })),
    createService: options.createService || ((rootDir) => createArchiveService({
      database: current.database.db,
      rootDir,
      now: () => new Date(2026, 7, 11, 12, 0, 0),
      fsImpl: options.fsImpl
    }))
  });
  return { manager, runtime };
}

test('legacy 根经 DB 全集/hash 证明后 bootstrap；未知文件阻止自动认领', async () => {
  const current = await createFixture();
  try {
    assert.equal(fs.existsSync(path.join(current.sourceRoot, ROOT_MARKER_FILE)), false);
    const initialized = await current.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    const instanceId = current.database.getSetting(ARCHIVE_INSTANCE_ID_SETTING_KEY);
    const marker = JSON.parse(fs.readFileSync(
      path.join(current.sourceRoot, ROOT_MARKER_FILE),
      'utf8'
    ));
    assert.equal(marker.archiveInstanceId, instanceId);
    assert.deepEqual(Object.keys(marker).sort(), ['archiveInstanceId', 'schemaVersion', 'type']);
  } finally {
    current.close();
  }

  const conflicted = await createFixture();
  try {
    fs.writeFileSync(path.join(conflicted.sourceRoot, '用户文件.txt'), 'unknown');
    const initialized = await conflicted.manager.initialize();
    assert.equal(initialized.available, false);
    assert.equal(initialized.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
    assert.equal(fs.existsSync(path.join(conflicted.sourceRoot, ROOT_MARKER_FILE)), false);
  } finally {
    conflicted.close();
  }
});

test('legacy 根仅兼容空的两位 SHA 分片残留，分片内未知内容仍 fail-closed', async () => {
  const emptyShard = await createFixture();
  try {
    const shardRoot = path.join(emptyShard.sourceRoot, 'blobs', 'sha256');
    const shardName = Array.from({ length: 256 }, (_item, index) => (
      index.toString(16).padStart(2, '0')
    )).find((candidate) => !fs.existsSync(path.join(shardRoot, candidate)));
    assert.ok(shardName, 'fixture 应至少留有一个未使用的 SHA 分片');
    fs.mkdirSync(path.join(shardRoot, shardName));

    const initialized = await emptyShard.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(fs.existsSync(path.join(emptyShard.sourceRoot, ROOT_MARKER_FILE)), true);
  } finally {
    emptyShard.close();
  }

  const shardWithUnknownFile = await createFixture();
  try {
    const unknownShard = path.join(
      shardWithUnknownFile.sourceRoot,
      'blobs',
      'sha256',
      'ff'
    );
    fs.mkdirSync(unknownShard, { recursive: true });
    fs.writeFileSync(path.join(unknownShard, 'unknown.bin'), 'unknown');

    const initialized = await shardWithUnknownFile.manager.initialize();
    assert.equal(initialized.available, false);
    assert.equal(initialized.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
    assert.equal(
      fs.existsSync(path.join(shardWithUnknownFile.sourceRoot, ROOT_MARKER_FILE)),
      false
    );
  } finally {
    shardWithUnknownFile.close();
  }

  const invalidShardName = await createFixture();
  try {
    fs.mkdirSync(path.join(
      invalidShardName.sourceRoot,
      'blobs',
      'sha256',
      'not-a-sha-shard'
    ));

    const initialized = await invalidShardName.manager.initialize();
    assert.equal(initialized.available, false);
    assert.equal(initialized.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
  } finally {
    invalidShardName.close();
  }
});

test('正常迁移只流式复制 canonical，目标重新 materialize 并原子切 setting/delegate', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });

    const result = await current.manager.changeStorageLocation();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(current.runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
    const after = current.repository.getArtifact(current.artifact.id);
    assert.equal(
      fs.readFileSync(managed(current.targetRoot, after.blob.relativePath), 'utf8'),
      'archive-root-migration-content'
    );
    assert.equal(
      fs.readFileSync(managed(current.targetRoot, after.storageRelativePath), 'utf8'),
      'archive-root-migration-content'
    );
    assert.equal(after.storageMode, 'copy');
    assert.notEqual(
      fs.statSync(managed(current.targetRoot, after.blob.relativePath)).ino,
      fs.statSync(managed(current.targetRoot, after.storageRelativePath)).ino
    );
    assert.ok(current.progress.some((item) => item.phase === 'copying'));
    assert.ok(current.progress.some((item) => item.phase === 'materializing-layout'));
    assert.ok(current.progress.some((item) => item.phase === 'verifying'));
  } finally {
    current.close();
  }
});

test('canonical 父目录 fsync 故障注入兼容 Windows drive/extended/UNC 路径表示', () => {
  for (const candidate of [
    'C:\\Temp\\archive-root\\blobs\\sha256\\aF',
    '\\\\?\\c:\\real-root\\blobs\\sha256\\0b',
    '\\\\server\\Share\\archive-root\\blobs\\sha256\\FE\\',
    '/tmp/real-root/blobs/sha256/09'
  ]) {
    assert.equal(isCanonicalBlobParentOpen(candidate, 'r'), true, candidate);
  }
  assert.equal(isCanonicalBlobParentOpen('C:\\root\\blobs\\sha256\\af', 'r+'), true);
  assert.equal(isCanonicalBlobParentOpen('C:\\root\\blobs\\sha256\\af', 'wx'), false);
  assert.equal(isCanonicalBlobParentOpen('C:\\root\\blobs\\sha256\\gg', 'r'), false);
  assert.equal(
    isCanonicalBlobParentOpen(`C:\\root\\blobs\\sha256\\${'a'.repeat(64)}`, 'r'),
    false
  );
});

test('目标 canonical 文件或父目录 fsync 失败时绝不切换 setting', async (t) => {
  for (const failurePoint of ['file', 'parent']) {
    await t.test(failurePoint, async () => {
      let targetRoot = '';
      let injected = false;
      let fileFsyncOpenMode = null;
      const readOpenCandidates = [];
      const promises = {
        ...fs.promises,
        async open(targetPath, ...args) {
          const normalized = String(targetPath);
          const portablePath = portablePathOf(normalized);
          const openMode = args[0];
          if (targetRoot && openMode === 'r' && readOpenCandidates.length < 32) {
            readOpenCandidates.push(portablePath);
          }
          const isFileFsyncTarget = Boolean(
            targetRoot
            && normalized.includes(`${path.sep}.staging${path.sep}`)
            && path.basename(normalized).startsWith('blob-')
          );
          // 源 canonical 不会同步父目录；以宿主所需访问权限打开的 SHA 分片目录
          // 只可能是目标 canonical 发布后的父目录耐久化入口。
          const isParentFsyncTarget = Boolean(targetRoot)
            && isCanonicalBlobParentOpen(portablePath, openMode);
          if (failurePoint === 'parent' && !injected && isParentFsyncTarget) {
            injected = true;
            const error = new Error('injected parent directory fsync open failure');
            error.code = 'EIO';
            throw error;
          }
          const handle = await fs.promises.open(targetPath, ...args);
          if (isFileFsyncTarget) {
            fileFsyncOpenMode = args[0];
          }
          const failThisHandle = failurePoint === 'file' && !injected && isFileFsyncTarget;
          if (!failThisHandle) return handle;
          return new Proxy(handle, {
            get(object, property) {
              if (property === 'sync') {
                return async () => {
                  injected = true;
                  const error = new Error(`injected ${failurePoint} fsync failure`);
                  error.code = 'EIO';
                  throw error;
                };
              }
              const value = Reflect.get(object, property, object);
              return typeof value === 'function' ? value.bind(object) : value;
            }
          });
        }
      };
      const current = await createFixture({ fsImpl: { ...fs, promises } });
      targetRoot = current.targetRoot;
      try {
        await current.manager.initialize();
        fs.mkdirSync(current.targetRoot, { recursive: true });

        const result = await current.manager.changeStorageLocation();

        assert.equal(
          injected,
          true,
          failurePoint === 'parent'
            ? `未命中目标 canonical 父目录 open：${JSON.stringify(readOpenCandidates)}`
            : '未命中目标 canonical 文件 fsync'
        );
        if (failurePoint === 'file') assert.equal(fileFsyncOpenMode, 'r+');
        assert.equal(result.status, 'failed');
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        assert.equal(current.runtime.rootDir, real(current.sourceRoot));
        assert.equal(fs.existsSync(current.sourceRoot), true);
      } finally {
        current.close();
      }
    });
  }
});

test('迁移源的未知 staging/readonly 文件阻断切换且不复制不删除', async () => {
  for (const directory of ['.staging', '.readonly']) {
    const current = await createFixture();
    try {
      await current.manager.initialize();
      const unknownPath = path.join(current.sourceRoot, directory, 'manual-file.xlsx');
      fs.writeFileSync(unknownPath, 'manual-content');
      fs.mkdirSync(current.targetRoot, { recursive: true });

      const result = await current.manager.changeStorageLocation();

      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
      assert.equal(current.runtime.rootDir, real(current.sourceRoot));
      assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'manual-content');
      assert.equal(fs.existsSync(path.join(current.targetRoot, directory, 'manual-file.xlsx')), false);
    } finally {
      current.close();
    }
  }
});

test('带有效 marker 的目标 transient 未知文件阻断迁移且绝不递归清理', async () => {
  for (const directory of ['.staging', '.readonly']) {
    const current = await createFixture();
    try {
      await current.manager.initialize();
      fs.mkdirSync(path.join(current.targetRoot, directory), { recursive: true });
      fs.writeFileSync(
        path.join(current.targetRoot, ROOT_MARKER_FILE),
        JSON.stringify(exactMarker(current.repository.getOrCreateArchiveInstanceId()))
      );
      const unknownPath = path.join(current.targetRoot, directory, 'manual-file.xlsx');
      fs.writeFileSync(unknownPath, 'target-manual-content');

      const result = await current.manager.changeStorageLocation();

      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
      assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'target-manual-content');
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
      assert.equal(current.runtime.rootDir, real(current.sourceRoot));
    } finally {
      current.close();
    }
  }
});

test('fresh target 同相对 canonical 文件无 journal owner 时即使同 SHA 也阻断且保留', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    const targetPath = managed(current.targetRoot, current.artifact.blob.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      path.join(current.targetRoot, ROOT_MARKER_FILE),
      JSON.stringify(exactMarker(current.repository.getOrCreateArchiveInstanceId()))
    );
    fs.copyFileSync(managed(current.sourceRoot, current.artifact.blob.relativePath), targetPath);

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'archive-root-migration-content');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
  } finally {
    current.close();
  }
});

test('pre-switch 续跑不打开或覆盖 journal 未发布的同相对 layout 文件', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-copy-blob' && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error('pause after canonical'), { code: 'SIMULATED_CRASH' });
      }
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
    const unknownLayout = managed(current.targetRoot, current.artifact.storageRelativePath);
    fs.mkdirSync(path.dirname(unknownLayout), { recursive: true });
    fs.writeFileSync(unknownLayout, 'manual-layout-content');

    const runtime = createArchiveRuntimeDelegate({ repository: current.repository });
    const restarted = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: runtime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir,
        now: () => new Date(2026, 7, 11, 12, 0, 0)
      })
    });
    const recovered = await restarted.initialize();

    assert.equal(recovered.available, true);
    assert.equal(recovered.ok, false);
    assert.equal(recovered.migrationRecovery.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
    assert.equal(fs.readFileSync(unknownLayout, 'utf8'), 'manual-layout-content');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'copying');
  } finally {
    current.close();
  }
});

test('journal 已发布 canonical/layout 后中断，重启精确复用 owner 并迁移成功', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-materialize-artifact' && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error('pause after layout'), { code: 'SIMULATED_CRASH' });
      }
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const first = await current.manager.changeStorageLocation();
    assert.equal(first.status, 'failed');
    const persisted = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.equal(persisted.targetPublishedPaths.includes(current.artifact.blob.relativePath), true);
    assert.equal(persisted.targetPublishedPaths.includes(current.artifact.storageRelativePath), true);

    const runtime = createArchiveRuntimeDelegate({ repository: current.repository });
    const restarted = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: runtime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir,
        now: () => new Date(2026, 7, 11, 12, 0, 0)
      })
    });
    const recovered = await restarted.initialize();

    assert.equal(recovered.available, true, JSON.stringify(recovered));
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('暂停后台维护时 orphan drain 不删除未知 SHA，随后迁移按未知内容阻断', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const unknownSha = 'f'.repeat(64);
    const unknownPath = path.join(current.sourceRoot, 'blobs', 'sha256', 'ff', unknownSha);
    fs.mkdirSync(path.dirname(unknownPath), { recursive: true });
    fs.writeFileSync(unknownPath, 'not-owned-by-database');

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_STORAGE_UNKNOWN_CONTENT');
    assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'not-owned-by-database');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
  } finally {
    current.close();
  }
});

test('切换后旧根 transient 出现未知文件时保留文件与 cleanup-pending journal', async () => {
  let current;
  current = await createFixture({
    faultInjector(event) {
      if (event !== 'after-switch-commit') return;
      const unknownPath = path.join(current.sourceRoot, '.staging', 'late-manual-file.xlsx');
      fs.writeFileSync(unknownPath, 'late-manual-content');
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'partial');
    assert.equal(result.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(current.runtime.rootDir, real(current.targetRoot));
    assert.equal(
      fs.readFileSync(path.join(current.sourceRoot, '.staging', 'late-manual-file.xlsx'), 'utf8'),
      'late-manual-content'
    );
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'cleanup-pending');

    const firstLease = await current.manager.beginEntryMaintenance();
    assert.equal(firstLease.acquired, true);
    const stillPending = await current.manager.resumeDeferredCleanup({
      ownerToken: firstLease.ownerToken
    });
    assert.equal(stillPending.ok, false);
    assert.equal(stillPending.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(fs.existsSync(path.join(current.sourceRoot, '.staging', 'late-manual-file.xlsx')), true);
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'cleanup-pending');
    await current.manager.endEntryMaintenance(firstLease.ownerToken);

    fs.rmSync(path.join(current.sourceRoot, '.staging', 'late-manual-file.xlsx'));
    const secondLease = await current.manager.beginEntryMaintenance();
    assert.equal(secondLease.acquired, true);
    const completed = await current.manager.resumeDeferredCleanup({
      ownerToken: secondLease.ownerToken
    });
    assert.equal(completed.ok, true);
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
    await current.manager.endEntryMaintenance(secondLease.ownerToken);
  } finally {
    current.close();
  }
});

test('precommit Blob 失败保持 source/setting，重启从 journal 幂等续跑', async () => {
  let failed = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-copy-blob' && !failed) {
        failed = true;
        const error = new Error('copy interrupted');
        error.code = 'EIO';
        throw error;
      }
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const interrupted = await current.manager.changeStorageLocation();
    assert.equal(interrupted.status, 'failed');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
    assert.equal(current.runtime.rootDir, real(current.sourceRoot));
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'copying');

    const laterSource = path.join(current.tempDir, 'later-statement.xlsx');
    fs.writeFileSync(laterSource, 'archive-root-migration-later-content');
    const laterArchived = await current.manager.currentService.archiveFile({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'storage-migration-later-fixture',
      localDate: '2026-08-12',
      filePath: laterSource,
      direction: 'input',
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(laterArchived.ok, true);
    const laterArtifact = current.repository.getArtifact(laterArchived.artifact.id);

    const runtime = createArchiveRuntimeDelegate({ repository: current.repository });
    const restarted = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: runtime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir,
        now: () => new Date(2026, 7, 11, 12, 0, 0)
      })
    });
    const recovered = await restarted.initialize();
    assert.equal(recovered.available, true, JSON.stringify(recovered));
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.journalPath), false);
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(
      fs.readFileSync(managed(current.targetRoot, laterArtifact.blob.relativePath), 'utf8'),
      'archive-root-migration-later-content'
    );
    assert.equal(
      fs.readFileSync(managed(current.targetRoot, laterArtifact.storageRelativePath), 'utf8'),
      'archive-root-migration-later-content'
    );
  } finally {
    current.close();
  }
});

test('pre-switch 失败释放维护锁后仍拒绝新删除，恢复收口后才允许删除', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-copy-blob' && !interrupted) {
        interrupted = true;
        const error = new Error('stop after target publish');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    }
  });
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');

    const persisted = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.ok(persisted.targetPublishedPaths.includes(current.artifact.blob.relativePath));
    assert.equal(
      persisted.targetPublishedPaths.includes(current.artifact.storageRelativePath),
      false,
      'journal 只能登记 crash 前真正发布到目标根的路径'
    );
    const staleTargetBlob = managed(current.targetRoot, current.artifact.blob.relativePath);
    assert.equal(fs.existsSync(staleTargetBlob), true);

    assert.equal(current.manager.isMaintenanceRequested(), false);
    assert.equal(await current.manager.hasUnresolvedMigration(), true);
    await assert.rejects(current.manager.assertDeleteAllowed(), { code: 'ARCHIVE_STORAGE_MIGRATION_PENDING' });
    const lease = await current.manager.beginEntryMaintenance();
    assert.equal(lease.acquired, true);
    await assert.rejects(current.manager.assertDeleteAllowed({
      origin: 'retention', ownerToken: lease.ownerToken
    }), { code: 'ARCHIVE_STORAGE_MIGRATION_PENDING' });
    await current.manager.endEntryMaintenance(lease.ownerToken);
    const refused = await current.manager.currentService.deleteBatch(current.artifact.batchId);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'ARCHIVE_STORAGE_MIGRATION_PENDING');
    assert.ok(current.repository.getArtifact(current.artifact.id));
    assert.equal(fs.existsSync(staleTargetBlob), true);
    assert.equal(fs.existsSync(managed(current.sourceRoot, current.artifact.blob.relativePath)), true);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(restarted.runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(staleTargetBlob), true);
    assert.equal(
      fs.existsSync(current.journalPath),
      false,
      fs.existsSync(current.journalPath)
        ? fs.readFileSync(current.journalPath, 'utf8')
        : 'journal removed'
    );
    assert.equal(await restarted.manager.hasUnresolvedMigration(), false);
    await restarted.manager.currentService.setLocked(current.artifact.batchId, false);
    const deleted = await restarted.manager.currentService.deleteBatch(current.artifact.batchId);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(fs.existsSync(staleTargetBlob), false);
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.storageRelativePath)), false);
    assert.equal(fs.existsSync(current.sourceRoot), false);
  } finally {
    current.close();
  }
});

test('DB commit 后 journal switched 前崩溃以 setting 为 truth，重启只认 target', async () => {
  let failed = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-switch-commit' && !failed) {
        failed = true;
        const error = new Error('process crash window');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const interrupted = await current.manager.changeStorageLocation();
    assert.equal(interrupted.status, 'failed');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(current.runtime.rootDir, real(current.targetRoot));
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'verifying');

    const targetCanonical = path.join(current.targetRoot, current.artifact.blob.relativePath);
    const sourceCanonical = path.join(current.sourceRoot, current.artifact.blob.relativePath);
    fs.chmodSync(targetCanonical, 0o600);
    fs.writeFileSync(targetCanonical, 'corrupted-committed-target');
    const rejectedRuntime = createArchiveRuntimeDelegate({ repository: current.repository });
    const rejectedRestart = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: rejectedRuntime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir,
        now: () => new Date(2026, 7, 11, 12, 0, 0)
      })
    });
    const rejected = await rejectedRestart.initialize();
    assert.equal(rejected.available, false);
    assert.equal(rejected.code, 'ARCHIVE_STORAGE_BLOB_INVALID');
    assert.equal(rejectedRuntime.service, null);
    assert.equal(current.repository.getArtifact(current.artifact.id).status, 'ready');
    fs.copyFileSync(sourceCanonical, targetCanonical);

    const runtime = createArchiveRuntimeDelegate({ repository: current.repository });
    const restarted = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: runtime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir,
        now: () => new Date(2026, 7, 11, 12, 0, 0)
      })
    });
    const recovered = await restarted.initialize();
    assert.equal(recovered.available, true);
    assert.equal(runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('旧根删除后、done journal 前崩溃凭 durable removal checkpoint 收口', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-source-root-removed' && !interrupted) {
        interrupted = true;
        const error = new Error('crash before done journal');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    }
  });
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const interruptedResult = await current.manager.changeStorageLocation();
    assert.equal(interruptedResult.status, 'partial');
    assert.equal(interruptedResult.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    const persisted = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.ok(persisted.sourceRootRemovalStartedAt);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(restarted.runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('configured root 离线不创建 configured/default，也不静默 fallback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-offline-root-'));
  const database = createDatabase();
  const repository = createArchiveRepository(database.db);
  repository.ensureSchema();
  const offlineRoot = path.join(tempDir, 'offline-volume', 'archive');
  const defaultRoot = path.join(tempDir, 'default-root');
  database.setSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY, offlineRoot);
  const runtime = createArchiveRuntimeDelegate({ repository });
  const manager = createArchiveStorageRootManager({
    database,
    repository,
    runtimeDelegate: runtime,
    defaultRoot,
    journalPath: path.join(tempDir, 'run-data', 'storage-migration.json'),
    createService: (rootDir) => createArchiveService({ database: database.db, rootDir })
  });
  try {
    const initialized = await manager.initialize();
    assert.equal(initialized.available, false);
    assert.equal(initialized.status, 'unavailable');
    assert.equal(initialized.code, 'ARCHIVE_STORAGE_ROOT_OFFLINE');
    assert.equal(fs.existsSync(offlineRoot), false);
    assert.equal(fs.existsSync(defaultRoot), false);
    assert.ok(database.getSetting(ARCHIVE_INSTANCE_ID_SETTING_KEY));
    assert.equal(database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), offlineRoot);
  } finally {
    database.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('switched 后旧根清理失败保持新根唯一可用，cleanup-pending 重启续跑', async () => {
  let sourceRoot = '';
  let failCleanup = false;
  const promises = {
    ...fs.promises,
    async rm(targetPath, options) {
      if (failCleanup
          && sourceRoot
          && String(targetPath).startsWith(`${real(sourceRoot)}${path.sep}`)
          && !String(targetPath).includes(`${path.sep}.staging${path.sep}`)) {
        failCleanup = false;
        const error = new Error('old root busy');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.rm(targetPath, options);
    }
  };
  const fsImpl = { ...fs, promises };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failCleanup = true;
    const result = await current.manager.changeStorageLocation();
    assert.equal(result.status, 'partial');
    assert.equal(result.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(current.runtime.rootDir, real(current.targetRoot));
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'cleanup-pending');
    assert.equal(fs.existsSync(path.join(current.sourceRoot, ROOT_MARKER_FILE)), true);
    const blocked = await current.manager.changeStorageLocation();
    assert.equal(blocked.status, 'busy');
    fs.rmSync(path.join(current.sourceRoot, ROOT_MARKER_FILE));

    const runtime = createArchiveRuntimeDelegate({ repository: current.repository });
    const restarted = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: runtime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({ database: current.database.db, rootDir })
    });
    const initialized = await restarted.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), true);
    assert.equal(fs.existsSync(current.journalPath), true);
    assert.equal(restarted.getMigrationState().phase, 'cleanup-pending');

    fs.copyFileSync(
      path.join(current.targetRoot, ROOT_MARKER_FILE),
      path.join(current.sourceRoot, ROOT_MARKER_FILE)
    );
    const finalRuntime = createArchiveRuntimeDelegate({ repository: current.repository });
    const finalRestart = createArchiveStorageRootManager({
      database: current.database,
      repository: current.repository,
      runtimeDelegate: finalRuntime,
      defaultRoot: current.sourceRoot,
      journalPath: current.journalPath,
      blockedRoots: [],
      createService: (rootDir) => createArchiveService({
        database: current.database.db,
        rootDir
      })
    });
    const finalInitialized = await finalRestart.initialize();
    assert.equal(finalInitialized.available, true, JSON.stringify(finalInitialized));
    assert.equal(finalRuntime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('maintenance 先关闭新 admission/第二迁移，再 drain 现有 archive tail', async () => {
  let releaseDrain;
  let markDrainStarted;
  let drainStarted = false;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const drainEntered = new Promise((resolve) => { markDrainStarted = resolve; });
  const current = await createFixture({
    waitForArchiveOperations() {
      drainStarted = true;
      markDrainStarted();
      return drain;
    }
  });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const migration = current.manager.changeStorageLocation();
    await drainEntered;
    assert.equal(drainStarted, true);
    const blocked = await current.runtime.reserveTaskBatch({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'must-not-reserve'
    });
    assert.equal(blocked.code, 'ARCHIVE_STORAGE_MAINTENANCE');
    assert.equal(current.repository.getBatchByOperationKey('bank-statement', 'must-not-reserve'), null);
    const second = await current.manager.changeStorageLocation();
    assert.equal(second.status, 'busy');
    releaseDrain();
    const result = await migration;
    assert.equal(result.status, 'success', JSON.stringify(result));
  } finally {
    current.close();
  }
});

test('entry maintenance lease 阻止新归档与迁移，但 list 仍可进入分页间隙', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });

    const lease = await current.manager.beginEntryMaintenance();
    assert.equal(lease.acquired, true);
    const rejectedArchive = await current.runtime.archiveFile({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'entry-lease-rejected',
      filePath: path.join(current.tempDir, 'not-admitted.xlsx'),
      role: 'output'
    });
    assert.equal(rejectedArchive.code, 'ARCHIVE_STORAGE_MAINTENANCE');
    assert.equal((await current.runtime.listBatches({})).ok, true);
    assert.equal((await current.manager.changeStorageLocation()).status, 'busy');

    await current.manager.endEntryMaintenance(lease.ownerToken);
    assert.equal(current.runtime.getMaintenanceState().requested, false);
  } finally {
    current.close();
  }
});

test('到期删除仅接受当前 entry lease 的内部 owner，拒绝伪造、过期及迁移维护凭据', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    const lease = await current.manager.beginEntryMaintenance();
    const ownedRetention = { origin: 'retention', ownerToken: lease.ownerToken };
    for (const options of [undefined, { origin: 'retention' },
      { origin: 'retention', ownerToken: 'unknown-owner' },
      { origin: 'manual', ownerToken: lease.ownerToken }]) {
      await assert.rejects(current.manager.assertDeleteAllowed(options),
        { code: 'ARCHIVE_STORAGE_MAINTENANCE' });
    }
    assert.equal(await current.manager.assertDeleteAllowed(ownedRetention), true);
    const controller = createArchiveCenterController({
      database: current.database, service: current.runtime, storageRootManager: current.manager
    });
    const externalPreflight = await controller.prepareDeleteBatch(current.artifact.batchId, {
      senderId: 'renderer', ...ownedRetention
    });
    assert.equal(externalPreflight.code, 'ARCHIVE_STORAGE_MAINTENANCE');
    const externalDelete = await controller.deleteBatch(current.artifact.batchId, 'unknown-confirmation', {
      senderId: 'renderer', ...ownedRetention
    });
    assert.equal(externalDelete.code, 'ARCHIVE_STORAGE_MAINTENANCE');
    assert.equal((await current.manager.changeStorageLocation()).status, 'busy');

    current.runtime.activateMaintenance();
    await assert.rejects(current.manager.assertDeleteAllowed(ownedRetention),
      { code: 'ARCHIVE_STORAGE_MAINTENANCE' });
    await current.manager.endEntryMaintenance(lease.ownerToken);
    const nextLease = await current.manager.beginEntryMaintenance();
    await assert.rejects(current.manager.assertDeleteAllowed(ownedRetention),
      { code: 'ARCHIVE_STORAGE_MAINTENANCE' });
    await current.manager.endEntryMaintenance(nextLease.ownerToken);
    assert.notEqual(current.repository.getBatch(current.artifact.batchId), null);
  } finally {
    await current.manager.pauseBackgroundOwnershipScan();
    await current.manager.currentService.pauseBackgroundMaterialization();
    current.close();
  }
});

test('真实入口维护通过 owner guard 删除到期批次，并继续后续维护阶段', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    const events = [];
    const controller = createArchiveCenterController({
      database: current.database, service: current.runtime, storageRootManager: current.manager,
      onEntryMaintenanceEvent: (eventName, payload) => events.push({ eventName, ...payload })
    });
    current.manager.currentService.runDeleteWithOwnerGuard = (batchId, operation, options) => (
      controller.runDeleteWithOwnerGuard(batchId, operation, options)
    );
    const sourcePath = path.join(current.tempDir, 'expired-input.xlsx');
    fs.writeFileSync(sourcePath, '独占的到期存档内容');
    const lifecycle = createTaskLifecycle({
      archiveService: current.runtime,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'entry-retention-owner' }), end() {} },
      flowResolver: {
        resolve: async () => ({ parentRunId: 'entry-retention-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true })
      },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) }
    });
    const policy = {
      channel: 'toolbox:merge', scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱',
      taskKey: 'toolbox:merge', startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file',
      allocation: 'eager', resultClassifier: () => 'succeeded'
    };
    let batchContext;
    const result = await lifecycle.runFileTask({
      policy, meta: { channel: policy.channel }, taskRunId: 'entry-retention-task',
      operationKey: 'entry-retention-operation',
      filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
      execute: async (context) => { batchContext = context; return { status: 'success' }; }
    });
    assert.equal(result.status, 'success');
    assert.equal((await current.runtime.setLocked(current.artifact.batchId, true)).ok, true);
    current.repository.setRetentionUntil(batchContext.batchId,
      current.repository.getBatch(batchContext.batchId).localDate);
    current.manager.currentService.now = () => new Date('2026-12-31T12:00:00.000Z');
    const artifact = current.repository.listArtifacts(batchContext.batchId)[0];
    const layoutPath = managed(current.sourceRoot, artifact.storageRelativePath);
    const blobPath = managed(current.sourceRoot, artifact.blob.relativePath);
    assert.equal(fs.existsSync(layoutPath), true);
    assert.equal(fs.existsSync(blobPath), true);
    controller.startupVccGateSucceeded = true;

    const maintenance = await controller._runEntryMaintenance('real-retention-lease');

    assert.equal(maintenance.ok, true, JSON.stringify(maintenance));
    assert.equal(current.repository.getBatch(batchContext.batchId), null);
    assert.equal(fs.existsSync(layoutPath), false);
    assert.equal(fs.existsSync(blobPath), false);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), '独占的到期存档内容');
    assert.equal(current.runtime.getMaintenanceState().requested, false);
    assert.equal(events.some((event) => event.phase === 'historical-health-scan'), true);
    assert.deepEqual(events.find((event) => event.eventName === 'completed').deletedBatchIds,
      [batchContext.batchId]);
  } finally {
    await current.manager.pauseBackgroundOwnershipScan();
    await current.manager.currentService.pauseBackgroundMaterialization();
    current.close();
  }
});

test('noncritical ownership 对真实 layout ancestor 链接失败返回显式 ok:false', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    const layoutDirectory = path.dirname(managed(
      current.sourceRoot,
      current.artifact.storageRelativePath
    ));
    const movedDirectory = `${layoutDirectory}-moved`;
    fs.renameSync(layoutDirectory, movedDirectory);
    fs.symlinkSync(movedDirectory, layoutDirectory, 'dir');

    const result = await current.manager.runNoncriticalOwnershipScan();

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_STORAGE_SYMLINK_REJECTED');
    assert.equal(result.lastErrorCode, 'ARCHIVE_STORAGE_SYMLINK_REJECTED');
    assert.equal(current.runtime.service, null);
  } finally {
    current.close();
  }
});

test('启动不跑目录化维护，迁移对缺失 layout 只做非破坏完整性失败', async () => {
  const current = await createFixture();
  const events = [];
  try {
    const writer = createArchiveService({
      database: current.database.db,
      rootDir: current.sourceRoot,
      now: () => new Date(2026, 7, 11, 12, 0, 0)
    });
    const secondSource = path.join(current.tempDir, 'statement-second.xlsx');
    fs.writeFileSync(secondSource, 'archive-root-migration-second-content');
    const second = await writer.archiveFile({
      moduleId: 'bank-statement',
      moduleCode: 'BANK',
      moduleName: '网银账单',
      operationKey: 'storage-migration-second-fixture',
      localDate: '2026-08-11',
      filePath: secondSource,
      direction: 'input',
      role: 'source',
      sourceOperation: 'import'
    });
    assert.equal(second.ok, true);
    fs.writeFileSync(
      path.join(current.sourceRoot, ROOT_MARKER_FILE),
      JSON.stringify(exactMarker(current.repository.getOrCreateArchiveInstanceId()))
    );
    fs.rmSync(path.join(current.sourceRoot, '2026'), { recursive: true, force: true });
    fs.mkdirSync(current.targetRoot, { recursive: true });

    const wrapped = createManagerForFixture(current, {
      deferStartupRecovery: true,
      createService(rootDir) {
        const service = createArchiveService({
          database: current.database.db,
          rootDir,
          now: () => new Date(2026, 7, 11, 12, 0, 0),
          startupMaterializationBatchSize: 1
        });
        const isSourceRoot = real(rootDir) === real(current.sourceRoot);
        const originalReconcile = service._reconcileStartupUnlocked.bind(service);
        service._reconcileStartupUnlocked = async (options = {}) => {
          if (isSourceRoot && options.verifyHashes === true) {
            events.push('full-source-verify');
          }
          return originalReconcile(options);
        };
        return service;
      }
    });
    const originalRequestMaintenance = wrapped.runtime.requestMaintenance;
    wrapped.runtime.requestMaintenance = (...args) => {
      const requested = originalRequestMaintenance(...args);
      if (requested) events.push('maintenance-requested');
      return requested;
    };

    const initialized = await wrapped.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.ok(wrapped.runtime.service);
    assert.deepEqual(events, [], '启动不得执行目录化或历史健康维护');

    const result = await wrapped.manager.changeStorageLocation();
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.code, 'ARCHIVE_STORAGE_LAYOUT_INVALID');
    assert.equal(fs.existsSync(path.join(current.sourceRoot, '2026')), false);
    assert.deepEqual(events, ['maintenance-requested']);
    assert.equal(wrapped.runtime.rootDir, real(current.sourceRoot));
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
  } finally {
    current.close();
  }
});

test('target current/ancestor/descendant/foreign marker/probe/capacity 按真实边界 fail-closed', async (t) => {
  const cases = [
    { name: 'current', targetMode: 'current', expectedStatus: 'success', noChange: true },
    { name: 'ancestor', targetMode: 'ancestor', code: 'ARCHIVE_STORAGE_ROOT_OVERLAP' },
    { name: 'descendant', targetMode: 'descendant', code: 'ARCHIVE_STORAGE_ROOT_OVERLAP' },
    { name: 'foreign-marker', prepare: 'foreign-marker', code: 'ARCHIVE_STORAGE_MARKER_CONFLICT' },
    { name: 'probe', fsMode: 'probe', code: 'ARCHIVE_STORAGE_TARGET_PROBE_FAILED' },
    { name: 'capacity', fsMode: 'capacity', code: 'ARCHIVE_STORAGE_SPACE_INSUFFICIENT' }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const promises = {
        ...fs.promises,
        async open(targetPath, ...args) {
          if (item.fsMode === 'probe' && path.basename(String(targetPath)).startsWith('.archive-probe-')) {
            const error = new Error('write denied');
            error.code = 'EACCES';
            throw error;
          }
          return fs.promises.open(targetPath, ...args);
        },
        async statfs(targetPath) {
          if (item.fsMode === 'capacity') return { bavail: 0, bsize: 1 };
          return fs.promises.statfs(targetPath);
        }
      };
      const current = await createFixture({
        targetMode: item.targetMode,
        fsImpl: { ...fs, promises }
      });
      try {
        const initialized = await current.manager.initialize();
        assert.equal(initialized.available, true, JSON.stringify(initialized));
        if (item.targetMode === 'descendant') fs.mkdirSync(current.targetRoot, { recursive: true });
        if (!item.targetMode) fs.mkdirSync(current.targetRoot, { recursive: true });
        if (item.prepare === 'foreign-marker') {
          fs.writeFileSync(path.join(current.targetRoot, ROOT_MARKER_FILE), JSON.stringify({
            type: 'bank-bill-excel-tool-archive-root',
            schemaVersion: 2,
            archiveInstanceId: '00000000-0000-4000-8000-000000000001'
          }));
        }
        const result = await current.manager.changeStorageLocation();
        assert.equal(result.status, item.expectedStatus || 'failed', JSON.stringify(result));
        if (item.noChange) assert.equal(result.noChange, true);
        if (item.code) assert.equal(result.code, item.code, JSON.stringify(result));
        if (item.code) {
          assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
          assert.equal(current.runtime.rootDir, real(current.sourceRoot));
        }
      } finally {
        current.close();
      }
    });
  }
});

test('marker-present 活跃根仍逐级拒绝内部 symlink，不删外部文件', async (t) => {
  for (const location of ['.staging', 'blobs']) {
    await t.test(location, async () => {
      const current = await createFixture();
      try {
        assert.equal((await current.manager.initialize()).available, true);
        const external = path.join(current.tempDir, `external-${location.replace('.', '')}`);
        if (location === '.staging') {
          fs.rmSync(path.join(current.sourceRoot, location), { recursive: true, force: true });
          fs.mkdirSync(external, { recursive: true });
          fs.writeFileSync(path.join(external, 'sentinel.txt'), 'must-survive');
        } else {
          fs.renameSync(path.join(current.sourceRoot, location), external);
        }
        fs.symlinkSync(external, path.join(current.sourceRoot, location), 'dir');

        const restarted = createManagerForFixture(current);
        const initialized = await restarted.manager.initialize();
        assert.equal(initialized.available, false);
        assert.equal(initialized.code, 'ARCHIVE_STORAGE_SYMLINK_REJECTED');
        if (location === '.staging') {
          assert.equal(fs.readFileSync(path.join(external, 'sentinel.txt'), 'utf8'), 'must-survive');
        } else {
          assert.equal(
            fs.readFileSync(managed(external, current.artifact.blob.relativePath.replace('blobs/', '')), 'utf8'),
            'archive-root-migration-content'
          );
        }
      } finally {
        current.close();
      }
    });
  }
});

test('有效 marker 的活跃根只验证固定祖先，不读取全库 evidence', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    await current.manager.pauseBackgroundOwnershipScan();

    const lstatCounts = new Map();
    const syntheticFs = {
      ...fs,
      promises: {
        ...fs.promises,
        async lstat(targetPath) {
          const normalized = path.resolve(targetPath);
          lstatCounts.set(normalized, (lstatCounts.get(normalized) || 0) + 1);
          if (normalized.startsWith(`${path.join(current.sourceRoot, 'history')}${path.sep}`)) {
            return { isSymbolicLink: () => false };
          }
          return fs.promises.lstat(targetPath);
        }
      }
    };
    const wrapped = createManagerForFixture(current, { fsImpl: syntheticFs });
    wrapped.manager.instanceId = current.repository.getOrCreateArchiveInstanceId();
    wrapped.manager._evidence = () => {
      throw new Error('marker 稳态启动不得读取全库 evidence');
    };

    await wrapped.manager._prepareActiveRoot(real(current.sourceRoot), { configured: true });
    const foreground = wrapped.manager.getOwnershipProgress();
    assert.equal(foreground.status, 'deferred');
    assert.equal(foreground.processed, 0);
    assert.equal(foreground.remaining, 0);
    assert.ok(
      [...lstatCounts.values()].reduce((sum, count) => sum + count, 0) <= 12,
      '含每次操作的 root lstat 在内，固定关键祖先 syscall 不得随历史 evidence 增长'
    );
  } finally {
    current.close();
  }
});

test('目标 Service 只在 root setting 已原子切换后才运行可修改 initialize', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const targetInitializeSettings = [];
    const wrapped = createManagerForFixture(current, {
      runtime: current.runtime,
      createService(rootDir) {
        const service = createArchiveService({
          database: current.database.db,
          rootDir,
          now: () => new Date(2026, 7, 11, 12, 0, 0)
        });
        if (path.resolve(rootDir) === real(current.targetRoot)) {
          const initialize = service.initialize.bind(service);
          service.initialize = async () => {
            targetInitializeSettings.push(
              current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY)
            );
            return initialize();
          };
        }
        return service;
      }
    });
    assert.equal((await wrapped.manager.initialize()).available, true);
    const migrated = await wrapped.manager.changeStorageLocation();
    assert.equal(migrated.status, 'success', JSON.stringify(migrated));
    assert.deepEqual(targetInitializeSettings, [real(current.targetRoot)]);
  } finally {
    current.close();
  }
});

test('pre-switch 自动续跑的永久目标故障不清空已恢复的 source delegate', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-prepared' && !interrupted) {
        interrupted = true;
        const error = new Error('prepared interruption');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    }
  });
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
    const failingFs = {
      ...fs,
      promises: {
        ...fs.promises,
        async open(targetPath, ...args) {
          if (path.dirname(String(targetPath)) === real(current.targetRoot)
              && path.basename(String(targetPath)).startsWith('.archive-probe-')) {
            const error = new Error('target stays read-only');
            error.code = 'EACCES';
            throw error;
          }
          return fs.promises.open(targetPath, ...args);
        }
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restarted = createManagerForFixture(current, { fsImpl: failingFs });
      const initialized = await restarted.manager.initialize();
      assert.equal(initialized.ok, false, JSON.stringify(initialized));
      assert.equal(initialized.migrationRecovery.code, 'ARCHIVE_STORAGE_TARGET_PROBE_FAILED');
      assert.equal(restarted.runtime.rootDir, real(current.sourceRoot));
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
      assert.equal(fs.existsSync(current.journalPath), true);
    }
  } finally {
    current.close();
  }
});

test('cleanup-pending 释放维护锁后仍拒绝新删除，恢复旧根后才允许删除', async () => {
  let sourceRoot = '';
  let failFirstOldFile = false;
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      async rm(targetPath, options) {
        const value = String(targetPath);
        if (failFirstOldFile && sourceRoot
            && value.startsWith(`${real(sourceRoot)}${path.sep}`)
            && !value.includes(`${path.sep}.staging`)
            && !value.includes(`${path.sep}.readonly`)) {
          failFirstOldFile = false;
          const error = new Error('old file temporarily busy');
          error.code = 'EACCES';
          throw error;
        }
        return fs.promises.rm(targetPath, options);
      }
    }
  };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failFirstOldFile = true;
    const partial = await current.manager.changeStorageLocation();
    assert.equal(partial.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    const persisted = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.ok(persisted.sourceCleanupPaths.includes(current.artifact.blob.relativePath));
    assert.ok(persisted.sourceCleanupPaths.includes(current.artifact.storageRelativePath));
    const oldCanonical = managed(current.sourceRoot, current.artifact.blob.relativePath);
    assert.equal(fs.existsSync(oldCanonical), true);

    assert.equal(current.manager.isMaintenanceRequested(), false);
    await assert.rejects(current.manager.assertDeleteAllowed(), { code: 'ARCHIVE_STORAGE_MIGRATION_PENDING' });
    const refused = await current.manager.currentService.deleteBatch(current.artifact.batchId);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'ARCHIVE_STORAGE_MIGRATION_PENDING');
    assert.ok(current.repository.getArtifact(current.artifact.id));
    assert.equal(fs.existsSync(oldCanonical), true);
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.blob.relativePath)), true);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
    await restarted.manager.currentService.setLocked(current.artifact.batchId, false);
    const deleted = await restarted.manager.currentService.deleteBatch(current.artifact.batchId);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.blob.relativePath)), false);
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.storageRelativePath)), false);
  } finally {
    current.close();
  }
});

for (const stopAt of ['after-delete-waiting-migration', 'after-migration-done', 'after-migration-delete-completed']) {
  test(`历史 pre-switch journal 与 cleanup job 重叠在 ${stopAt} 中断后按耐久顺序收口`, async () => {
    const current = await createHistoricalDeleteOverlap();
    try {
      const originalJournal = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
      const restarted = createManagerForFixture(current, {
        faultInjector(event) {
          if (event === stopAt) throw Object.assign(new Error('恢复故障注入'), { code: 'SIMULATED_CRASH' });
        }
      });
      await restarted.manager.initialize();
      assert.equal(fs.existsSync(current.journalPath), true);
      const checkpoint = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
      assert.equal(checkpoint.migrationId, originalJournal.migrationId);
      const job = current.repository.getCleanupJobForBatch(current.artifact.batchId);
      if (stopAt === 'after-migration-delete-completed') {
        assert.equal(job, null);
        assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId).fullyDeleted, true);
      } else {
        assert.equal(job.state, 'waiting-migration', JSON.stringify(job));
        assert.equal(job.migration.migrationId, originalJournal.migrationId);
        assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null);
        assert.ok(job.plan.items.every((item) => ['deleted', 'already-missing', 'preserved-shared'].includes(item.state)));
      }
      if (stopAt !== 'after-delete-waiting-migration') {
        assert.equal(checkpoint.phase, 'done');
        assert.equal(fs.existsSync(current.sourceRoot), false);
      } else {
        assert.notEqual(checkpoint.phase, 'done');
        assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.blob.relativePath)), true);
      }
      const resumed = createManagerForFixture(current, {
        faultInjector(event) {
          if (checkpoint.phase === 'done' && event === 'after-source-root-removed') {
            throw new Error('done 阶段不得再次执行文件清理');
          }
        }
      });
      const result = await resumed.manager.initialize();
      assert.equal(result.available, true, JSON.stringify(result));
      assert.equal(current.repository.getCleanupJobForBatch(current.artifact.batchId), null);
      assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId).fullyDeleted, true);
      assert.equal(fs.existsSync(current.journalPath), false);
      assert.equal(fs.existsSync(current.sourceRoot), false);
      assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.blob.relativePath)), false);
      assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.storageRelativePath)), false);
    } finally {
      current.close();
    }
  });
}

test('waiting-migration 缺失原 journal 时保留 job 且不伪造完成凭证', async () => {
  const current = await createHistoricalDeleteOverlap();
  try {
    const restarted = createManagerForFixture(current, {
      faultInjector(event) {
        if (event === 'after-delete-waiting-migration') throw new Error('模拟等待阶段中断');
      }
    });
    await restarted.manager.initialize();
    assert.equal(current.repository.getCleanupJobForBatch(current.artifact.batchId).state, 'waiting-migration');
    fs.rmSync(current.journalPath);
    const resumed = createManagerForFixture(current);
    const result = await resumed.manager.initialize();
    assert.equal(result.available, false);
    assert.equal(result.code, 'ARCHIVE_STORAGE_DELETE_RECOVERY_CONFLICT');
    assert.equal(current.repository.getCleanupJobForBatch(current.artifact.batchId).state, 'waiting-migration');
    assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null);
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.blob.relativePath)), true);
  } finally {
    current.close();
  }
});

test('历史 V1 job 只有路径摘要而无原对象身份时保留两类恢复记录和两根文件', async () => {
  const current = await createHistoricalDeleteOverlap({ legacyWithoutIdentity: true });
  try {
    const sourceCanonical = managed(current.sourceRoot, current.artifact.blob.relativePath);
    const targetCanonical = managed(current.targetRoot, current.artifact.blob.relativePath);
    const sourceBytes = fs.readFileSync(sourceCanonical);
    const targetBytes = fs.readFileSync(targetCanonical);
    const beforeJournal = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    const resumed = createManagerForFixture(current);
    const initialized = await resumed.manager.initialize();
    assert.equal(initialized.ok, false, JSON.stringify(initialized));
    assert.equal(current.repository.getCleanupJobForBatch(current.artifact.batchId).planVersion, 1);
    assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null);
    const afterJournal = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.equal(afterJournal.migrationId, beforeJournal.migrationId);
    assert.notEqual(afterJournal.phase, 'done');
    assert.deepEqual(fs.readFileSync(sourceCanonical), sourceBytes);
    assert.deepEqual(fs.readFileSync(targetCanonical), targetBytes);
    assert.equal(fs.existsSync(managed(current.sourceRoot, current.artifact.storageRelativePath)), true);
  } finally { current.close(); }
});

test('历史 post-switch 原根计划由迁移 inventory 收口两根后才生成凭证', async () => {
  let sourceRoot = '';
  let failCleanup = false;
  const fsImpl = { ...fs, promises: { ...fs.promises, async rm(filePath, options) {
    if (failCleanup && sourceRoot && String(filePath).startsWith(`${real(sourceRoot)}${path.sep}`)) {
      failCleanup = false;
      throw Object.assign(new Error('模拟旧根清理中断'), { code: 'EACCES' });
    }
    return fs.promises.rm(filePath, options);
  } } };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    await current.manager.initialize();
    await current.manager.currentService.setLocked(current.artifact.batchId, false);
    const plan = await buildDeletePlan(current.manager.currentService, current.artifact.batchId);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failCleanup = true;
    assert.equal((await current.manager.changeStorageLocation()).code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    // 模拟升级前切换已提交的交叠状态，持久计划明确绑定旧根。
    const deleted = current.repository.deleteBatch(current.artifact.batchId, { deletePlan: plan });
    assert.equal(deleted.status, 'deleted');
    const targetCanonical = managed(current.targetRoot, current.artifact.blob.relativePath);
    assert.equal(fs.existsSync(targetCanonical), true);
    const resumed = createManagerForFixture(current);
    const initialized = await resumed.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId).fullyDeleted, true);
    assert.equal(current.repository.getCleanupJobForBatch(current.artifact.batchId), null);
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(targetCanonical), false);
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.storageRelativePath)), false);
  } finally {
    current.close();
  }
});

for (const mode of ['replacement', 'same-content-replacement', 'source-replacement', 'legacy-journal',
  'legacy-target-map', 'legacy-source-map', 'legacy-job', 'unsupported-job-item']) {
  test(`post-switch 交叠 ${mode} 在任何两根清理前拒绝并保留原恢复证据`, async () => {
    let sourceRoot = '';
    let failCleanup = false;
    const fsImpl = { ...fs, promises: { ...fs.promises, async rm(filePath, options) {
      if (failCleanup && sourceRoot && String(filePath).startsWith(`${real(sourceRoot)}${path.sep}`)) {
        failCleanup = false;
        throw Object.assign(new Error('模拟旧根清理中断'), { code: 'EACCES' });
      }
      return fs.promises.rm(filePath, options);
    } } };
    const current = await createFixture({ fsImpl });
    sourceRoot = current.sourceRoot;
    try {
      await current.manager.initialize();
      await current.manager.currentService.setLocked(current.artifact.batchId, false);
      const plan = await buildDeletePlan(current.manager.currentService, current.artifact.batchId);
      fs.mkdirSync(current.targetRoot, { recursive: true });
      failCleanup = true;
      assert.equal((await current.manager.changeStorageLocation()).code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
      const deleted = current.repository.deleteBatch(current.artifact.batchId,
        mode === 'legacy-job' ? { allowLocked: true } : { deletePlan: plan });
      assert.equal(deleted.status, 'deleted');
      if (mode === 'unsupported-job-item') {
        const storedPlan = JSON.parse(current.database.db.prepare('SELECT plan_json FROM archive_cleanup_jobs WHERE id = ?')
          .get(deleted.cleanupJob.id).plan_json);
        storedPlan.items[0].kind = 'owned-temp';
        current.database.db.prepare('UPDATE archive_cleanup_jobs SET plan_json = ? WHERE id = ?')
          .run(JSON.stringify(storedPlan), deleted.cleanupJob.id);
      }
      const targetPath = managed(current.targetRoot, current.artifact.storageRelativePath);
      if (mode.includes('replacement')) {
        const replacedPath = mode === 'source-replacement'
          ? managed(current.sourceRoot, current.artifact.storageRelativePath) : targetPath;
        const replacement = path.join(current.tempDir, 'replacement.xlsx');
        fs.writeFileSync(replacement, mode === 'same-content-replacement'
          ? fs.readFileSync(replacedPath) : '另一个 owner 的文件');
        fs.renameSync(replacement, replacedPath);
      }
      const journal = JSON.parse(fs.readFileSync(current.journalPath));
      if (['legacy-journal', 'legacy-target-map', 'legacy-source-map'].includes(mode)) {
        if (mode !== 'legacy-target-map') delete journal.sourceFileIdentities;
        if (mode !== 'legacy-source-map') delete journal.targetFileIdentities;
        fs.writeFileSync(current.journalPath, JSON.stringify(journal));
      }
      const sourceFiles = [current.artifact.blob.relativePath, current.artifact.storageRelativePath]
        .map((relativePath) => managed(current.sourceRoot, relativePath));
      const before = [...sourceFiles, targetPath].map((filePath) => ({ filePath,
        ino: fs.statSync(filePath).ino, content: fs.readFileSync(filePath) }));
      const resumed = createManagerForFixture(current);
      const initialized = await resumed.manager.initialize();
      assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null, JSON.stringify(initialized));
      assert.ok(current.repository.getCleanupJobForBatch(current.artifact.batchId));
      const afterJournal = JSON.parse(fs.readFileSync(current.journalPath));
      assert.equal(afterJournal.migrationId, journal.migrationId);
      assert.notEqual(afterJournal.phase, 'done');
      for (const item of before) {
        assert.equal(fs.statSync(item.filePath).ino, item.ino);
        assert.deepEqual(fs.readFileSync(item.filePath), item.content);
      }
      assert.equal(resumed.manager.getMigrationState().phase, 'cleanup-pending');
      await resumed.manager.pauseBackgroundOwnershipScan();
      await resumed.manager.currentService?.pauseBackgroundMaterialization();
    } finally { current.close(); }
  });
}

test('pre-switch 旧 journal 缺少源 inventory 时不得将现存路径当作新增身份证据', async () => {
  const current = await createFixture({ faultInjector(event) {
    if (event === 'after-prepared') throw new Error('准备后中断');
  } });
  let resumed;
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
    const journal = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    delete journal.sourceCleanupPaths;
    delete journal.sourceFileIdentities;
    fs.writeFileSync(current.journalPath, JSON.stringify(journal));
    const sourcePaths = [current.artifact.blob.relativePath, current.artifact.storageRelativePath]
      .map((relativePath) => managed(current.sourceRoot, relativePath));
    const sourceInodes = sourcePaths.map((filePath) => fs.statSync(filePath).ino);
    resumed = createManagerForFixture(current);
    const result = await resumed.manager.initialize();
    assert.equal(result.migrationRecovery?.code, 'ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING', JSON.stringify(result));
    const after = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.equal(after.migrationId, journal.migrationId);
    assert.equal(after.sourceFileIdentities, undefined);
    assert.equal(after.sourceCleanupPaths, null);
    assert.deepEqual(after.targetPublishedPaths, []);
    assert.deepEqual(sourcePaths.map((filePath) => fs.statSync(filePath).ino), sourceInodes);
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
  } finally {
    await current.manager.pauseBackgroundOwnershipScan();
    await current.manager.currentService?.pauseBackgroundMaterialization();
    if (resumed) {
      await resumed.manager.pauseBackgroundOwnershipScan();
      await resumed.manager.currentService?.pauseBackgroundMaterialization();
    }
    current.close();
  }
});

test('pre-switch 旧目标无身份时保留两根，目标安全缺失后按原计划幂等收口', async () => {
  const current = await createHistoricalDeleteOverlap();
  try {
    const journal = JSON.parse(fs.readFileSync(current.journalPath));
    delete journal.targetFileIdentities;
    fs.writeFileSync(current.journalPath, JSON.stringify(journal));
    const sourcePath = managed(current.sourceRoot, current.artifact.blob.relativePath);
    const targetPath = managed(current.targetRoot, current.artifact.blob.relativePath);
    const sourceInode = fs.statSync(sourcePath).ino;
    const targetInode = fs.statSync(targetPath).ino;
    const refused = createManagerForFixture(current);
    assert.equal((await refused.manager.initialize()).ok, false);
    assert.equal(fs.statSync(sourcePath).ino, sourceInode);
    assert.equal(fs.statSync(targetPath).ino, targetInode);
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath)).targetFileIdentities, undefined);
    assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId), null);
    fs.unlinkSync(targetPath);
    const resumed = createManagerForFixture(current);
    assert.equal((await resumed.manager.initialize()).available, true);
    assert.equal(current.repository.getDeletionReceipt(current.artifact.batchId).fullyDeleted, true);
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally { current.close(); }
});

test('pre-switch 正常复用不重复 chmod，进度写入失败后保留原 inode/ctime 并可再次恢复', async () => {
  const current = await createFixture({ faultInjector(event) {
    if (event === 'after-materialize-artifact') throw new Error('首次迁移在目录发布后退出');
  } });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
    const targetPath = managed(current.targetRoot, current.artifact.storageRelativePath);
    const original = fs.statSync(targetPath);
    const resumed = createManagerForFixture(current);
    const write = resumed.manager._writeJournal.bind(resumed.manager);
    resumed.manager._writeJournal = async (journal, phase, patch) => {
      if (phase === 'materializing-layout' && patch?.targetFileIdentities) throw new Error('重复进度写入失败');
      return write(journal, phase, patch);
    };
    assert.equal((await resumed.manager.initialize()).ok, false);
    assert.equal(fs.statSync(targetPath).ino, original.ino);
    assert.equal(fs.statSync(targetPath).ctimeMs, original.ctimeMs);
    const retried = createManagerForFixture(current);
    assert.equal((await retried.manager.initialize()).available, true);
    assert.equal(fs.existsSync(current.journalPath), false);
    assert.equal(fs.statSync(targetPath).ino, original.ino);
  } finally { current.close(); }
});

for (const action of ['read', 'retry', 'background', 'missing-read', 'unreadable-journal']) {
  test(`pre-switch 冻结源身份后 ${action} 保留原证据并可诊断恢复`, async () => {
    let interrupted = false;
    const current = await createFixture({ faultInjector(event) {
      if (event === 'after-copy-blob' && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error('复制后中断'), { code: 'SIMULATED_CRASH' });
      }
    } });
    let restarted;
    try {
      await current.manager.initialize();
      await current.manager.pauseBackgroundOwnershipScan();
      await current.manager.currentService.pauseBackgroundMaterialization();
      const sourcePath = managed(current.sourceRoot, current.artifact.storageRelativePath);
      const canonical = managed(current.sourceRoot, current.artifact.blob.relativePath);
      fs.unlinkSync(sourcePath);
      fs.linkSync(canonical, sourcePath);
      const initial = fs.statSync(canonical);
      current.database.db.prepare(`UPDATE archive_artifacts SET storage_mode = 'hardlink',
        storage_fingerprint_size_bytes = ?, storage_fingerprint_mtime_ms = ?,
        storage_fingerprint_ctime_ms = ?, storage_fingerprint_ino = ? WHERE id = ?`)
        .run(initial.size, initial.mtimeMs, initial.ctimeMs, String(initial.ino), current.artifact.id);
      current.database.db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = ?, fingerprint_mtime_ms = ?,
        fingerprint_ctime_ms = ?, fingerprint_ino = ? WHERE id = ?`)
        .run(initial.size, initial.mtimeMs, initial.ctimeMs, String(initial.ino), current.artifact.blob.id);
      fs.mkdirSync(current.targetRoot, { recursive: true });
      assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
      await current.manager.pauseBackgroundOwnershipScan();
      await current.manager.currentService.pauseBackgroundMaterialization();
      const journalText = fs.readFileSync(current.journalPath, 'utf8');
      const journal = JSON.parse(journalText);
      assert.equal(String(fs.statSync(sourcePath).ino), journal.sourceFileIdentities[current.artifact.storageRelativePath].ino);
      if (action === 'missing-read') fs.unlinkSync(sourcePath);
      if (action === 'unreadable-journal') fs.writeFileSync(current.journalPath, '{');
      const before = fs.statSync(canonical);
      const service = current.manager.currentService;
      if (action === 'retry') {
        const retried = await service.retryBatch(current.artifact.batchId);
        assert.equal(retried.ok, false);
        assert.equal(retried.results[0].code, 'ARCHIVE_STORAGE_MIGRATION_PENDING');
      } else if (action === 'background') {
        const background = await current.manager._initializeService(real(current.sourceRoot));
        const progress = await background.service.resumeBackgroundMaterialization();
        await background.service.pauseBackgroundMaterialization();
        assert.equal(progress.failed > 0, true, JSON.stringify(progress));
        assert.equal(current.repository.getArtifact(current.artifact.id).materializationErrorCode,
          'ARCHIVE_STORAGE_MIGRATION_PENDING');
      } else {
        const read = await service.resolveVerifiedArtifact(current.artifact.id);
        assert.equal(read.ok, true, JSON.stringify(read));
        assert.equal(read.filePath, real(canonical));
        const stored = current.repository.getArtifact(current.artifact.id);
        assert.equal(stored.materializationErrorCode, action === 'unreadable-journal'
          ? 'ARCHIVE_STORAGE_METADATA_INVALID' : 'ARCHIVE_STORAGE_MIGRATION_PENDING');
      }
      assert.equal(fs.existsSync(sourcePath), action !== 'missing-read');
      if (action !== 'missing-read') assert.equal(fs.statSync(sourcePath).ino, initial.ino);
      assert.equal(fs.statSync(canonical).ino, before.ino);
      assert.equal(fs.statSync(canonical).ctimeMs, before.ctimeMs);
      assert.equal(fs.statSync(canonical).nlink, before.nlink);
      assert.equal(fs.readFileSync(current.journalPath, 'utf8'), action === 'unreadable-journal' ? '{' : journalText);
      if (action === 'unreadable-journal') fs.writeFileSync(current.journalPath, journalText);
      restarted = createManagerForFixture(current);
      const initialized = await restarted.manager.initialize();
      assert.equal(initialized.available, true, JSON.stringify(initialized));
      if (action === 'missing-read') {
        assert.equal(initialized.migrationRecovery.code, 'ARCHIVE_STORAGE_LAYOUT_INVALID');
        assert.equal(fs.existsSync(current.journalPath), true);
        assert.equal(fs.existsSync(sourcePath), false);
        return;
      }
      assert.equal(fs.existsSync(current.journalPath), false, JSON.stringify(initialized));
      assert.equal(fs.existsSync(current.sourceRoot), false);
      // journal 结束后同一个 service 恢复正常修复，不遗留永久冻结。
      const targetPath = managed(current.targetRoot, current.artifact.storageRelativePath);
      fs.unlinkSync(targetPath);
      const repaired = await restarted.manager.currentService.resolveVerifiedArtifact(current.artifact.id);
      assert.equal(repaired.ok, true);
      assert.equal(repaired.filePath, real(targetPath));
      assert.equal(fs.readFileSync(targetPath, 'utf8'), 'archive-root-migration-content');
    } finally {
      await current.manager.pauseBackgroundOwnershipScan();
      await current.manager.currentService?.pauseBackgroundMaterialization();
      if (restarted) {
        await restarted.manager.pauseBackgroundOwnershipScan();
        await restarted.manager.currentService?.pauseBackgroundMaterialization();
      }
      current.close();
    }
  });
}

test('迁移源历史硬链接自身清理中断后只按冻结 inventory 的链接减少恢复', async () => {
  let sourceRoot = '';
  let failSecondSource = false;
  const fsImpl = { ...fs, promises: { ...fs.promises, async rm(filePath, options) {
    if (failSecondSource && sourceRoot && String(filePath).startsWith(`${real(sourceRoot)}${path.sep}blobs${path.sep}`)) {
      failSecondSource = false;
      throw Object.assign(new Error('原硬链接已删，canonical 清理中断'), { code: 'EACCES' });
    }
    return fs.promises.rm(filePath, options);
  } } };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    await current.manager.initialize();
    const sourcePath = managed(current.sourceRoot, current.artifact.storageRelativePath);
    const canonical = managed(current.sourceRoot, current.artifact.blob.relativePath);
    fs.unlinkSync(sourcePath);
    fs.linkSync(canonical, sourcePath);
    const stat = fs.statSync(canonical);
    current.database.db.prepare(`UPDATE archive_artifacts SET storage_mode = 'hardlink',
      storage_fingerprint_size_bytes = ?, storage_fingerprint_mtime_ms = ?,
      storage_fingerprint_ctime_ms = ?, storage_fingerprint_ino = ? WHERE id = ?`)
      .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), current.artifact.id);
    current.database.db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = ?, fingerprint_mtime_ms = ?,
      fingerprint_ctime_ms = ?, fingerprint_ino = ? WHERE id = ?`)
      .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), current.artifact.blob.id);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failSecondSource = true;
    assert.equal((await current.manager.changeStorageLocation()).code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.statSync(canonical).nlink, 1);
    const resumed = createManagerForFixture(current);
    assert.equal((await resumed.manager.initialize()).available, true);
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
    assert.equal(fs.readFileSync(managed(current.targetRoot, current.artifact.storageRelativePath), 'utf8'),
      'archive-root-migration-content');
  } finally { current.close(); }
});

test('未完成删除 job 拒绝发起新迁移，原计划清理后才放行', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    await current.manager.currentService.setLocked(current.artifact.batchId, false);
    const deletePlan = await buildDeletePlan(current.manager.currentService, current.artifact.batchId);
    const deleted = current.repository.deleteBatch(current.artifact.batchId, { deletePlan });
    assert.ok(deleted.cleanupJob);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const refused = await current.manager.changeStorageLocation();
    assert.equal(refused.code, 'ARCHIVE_STORAGE_SOURCE_NOT_CLEAN');
    assert.equal(fs.existsSync(current.journalPath), false);
    assert.equal(current.runtime.rootDir, real(current.sourceRoot));
    assert.ok(current.repository.getCleanupJobForBatch(current.artifact.batchId));
    const cleaned = await current.manager.currentService.runOwnedOrphanCleanup();
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    const migrated = await current.manager.changeStorageLocation();
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.equal(fs.existsSync(current.sourceRoot), false);
  } finally {
    current.close();
  }
});

test('迁移 journal 损坏时只读删除门禁拒绝且保留原文件', async () => {
  const current = await createFixture();
  try {
    await current.manager.initialize();
    fs.mkdirSync(path.dirname(current.journalPath), { recursive: true });
    fs.writeFileSync(current.journalPath, '{');
    await assert.rejects(current.manager.assertDeleteAllowed());
    assert.equal(fs.readFileSync(current.journalPath, 'utf8'), '{');
    assert.ok(current.repository.getArtifact(current.artifact.id));
    assert.equal(fs.existsSync(managed(current.sourceRoot, current.artifact.blob.relativePath)), true);
  } finally {
    current.close();
  }
});

test('已切换后旧根离线必须保留 cleanup-pending，不得当作删除成功', async () => {
  let sourceRoot = '';
  let failCleanup = false;
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      async rm(targetPath, options) {
        const value = String(targetPath);
        if (failCleanup && sourceRoot && value.startsWith(`${real(sourceRoot)}${path.sep}`)) {
          failCleanup = false;
          const error = new Error('old volume disconnecting');
          error.code = 'EIO';
          throw error;
        }
        return fs.promises.rm(targetPath, options);
      }
    }
  };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failCleanup = true;
    assert.equal(
      (await current.manager.changeStorageLocation()).code,
      'ARCHIVE_STORAGE_CLEANUP_PENDING'
    );
    const detachedRoot = path.join(current.tempDir, 'detached-old-volume');
    fs.renameSync(current.sourceRoot, detachedRoot);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(restarted.runtime.rootDir, real(current.targetRoot));
    const journal = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.equal(journal.phase, 'cleanup-pending');
    assert.equal(journal.lastError.code, 'ARCHIVE_STORAGE_SOURCE_ROOT_OFFLINE');
    assert.equal(fs.existsSync(managed(detachedRoot, current.artifact.blob.relativePath)), true);
  } finally {
    current.close();
  }
});

test('同进程失败后的未决 journal 禁止被第二次迁移覆盖', async () => {
  let interrupted = false;
  const current = await createFixture({
    faultInjector(event) {
      if (event === 'after-prepared' && !interrupted) {
        interrupted = true;
        const error = new Error('keep journal');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    }
  });
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
    const before = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    const second = await current.manager.changeStorageLocation();
    assert.equal(second.status, 'busy');
    assert.equal(second.code, 'ARCHIVE_STORAGE_MIGRATION_PENDING');
    const after = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
    assert.equal(after.migrationId, before.migrationId);
    assert.equal(after.targetRoot, before.targetRoot);
  } finally {
    current.close();
  }
});

test('blocked root 的 symlink/realpath 别名与目标使用同一 canonical 比较', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    const blockedReal = path.join(current.tempDir, 'blocked-real');
    const blockedAlias = path.join(current.tempDir, 'blocked-alias');
    const targetRoot = path.join(blockedReal, 'archive-target');
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.symlinkSync(blockedReal, blockedAlias, 'dir');
    const aliased = createManagerForFixture(current, {
      runtime: current.runtime,
      blockedRoots: [blockedAlias],
      targetRoot
    });
    assert.equal((await aliased.manager.initialize()).available, true);
    const rejected = await aliased.manager.changeStorageLocation();
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.code, 'ARCHIVE_STORAGE_ROOT_FORBIDDEN');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
  } finally {
    current.close();
  }
});

test('迁移操作前 source root 被链接替换时 fail-closed，不跟随或改 setting', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    const movedSource = path.join(current.tempDir, 'moved-source-root');
    fs.renameSync(current.sourceRoot, movedSource);
    fs.symlinkSync(movedSource, current.sourceRoot, 'dir');

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_STORAGE_SYMLINK_REJECTED');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
    assert.equal(
      fs.readFileSync(managed(movedSource, current.artifact.blob.relativePath), 'utf8'),
      'archive-root-migration-content'
    );
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('选择的 target root 本身是链接时拒绝，不解析后迁移', async () => {
  const current = await createFixture();
  try {
    assert.equal((await current.manager.initialize()).available, true);
    const realTarget = path.join(current.tempDir, 'real-target-root');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, current.targetRoot, 'dir');

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_STORAGE_SYMLINK_REJECTED');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
    assert.deepEqual(fs.readdirSync(realTarget), []);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});

test('切换后 old root 本身被链接替换时保留真实旧根并维持 cleanup-pending', async () => {
  let current;
  let movedSource;
  current = await createFixture({
    faultInjector(event) {
      if (event !== 'after-switch-commit') return;
      movedSource = path.join(current.tempDir, 'moved-old-root');
      fs.renameSync(current.sourceRoot, movedSource);
      fs.symlinkSync(movedSource, current.sourceRoot, 'dir');
    }
  });
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });

    const result = await current.manager.changeStorageLocation();

    assert.equal(result.status, 'partial');
    assert.equal(result.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
    assert.equal(current.runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.lstatSync(current.sourceRoot).isSymbolicLink(), true);
    assert.equal(
      fs.readFileSync(managed(movedSource, current.artifact.blob.relativePath), 'utf8'),
      'archive-root-migration-content'
    );
    assert.equal(JSON.parse(fs.readFileSync(current.journalPath, 'utf8')).phase, 'cleanup-pending');
  } finally {
    current.close();
  }
});

test('删 marker 后根目录 rmdir EBUSY 必须恢复 marker 并可重启续跑', async () => {
  let sourceRoot = '';
  let failRootRemoval = false;
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      async rmdir(targetPath, options) {
        if (failRootRemoval && sourceRoot && path.resolve(targetPath) === real(sourceRoot)) {
          failRootRemoval = false;
          const error = new Error('root handle is busy');
          error.code = 'EBUSY';
          throw error;
        }
        return fs.promises.rmdir(targetPath, options);
      }
    }
  };
  const current = await createFixture({ fsImpl });
  sourceRoot = current.sourceRoot;
  try {
    assert.equal((await current.manager.initialize()).available, true);
    fs.mkdirSync(current.targetRoot, { recursive: true });
    failRootRemoval = true;
    const partial = await current.manager.changeStorageLocation();
    assert.equal(partial.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING');
    assert.equal(fs.existsSync(path.join(current.sourceRoot, ROOT_MARKER_FILE)), true);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally {
    current.close();
  }
});


for (const replacement of ['canonical', 'materialized']) {
  for (const phase of ['after-materialize-artifact', 'before-commit']) {
    test(`目标 ${replacement} 在 ${phase} 被同 SHA 的新 inode 替换后保留两根且重启不认领`, async () => {
      let swapped = false;
      let victim;
      let replacementIdentity;
      const replace = () => {
        if (swapped) return;
        swapped = true;
        victim = managed(current.targetRoot, replacement === 'canonical'
          ? current.artifact.blob.relativePath : current.artifact.storageRelativePath);
        const before = fs.statSync(victim);
        const temporary = path.join(current.tempDir, 'other-owner.xlsx');
        fs.writeFileSync(temporary, fs.readFileSync(victim));
        fs.renameSync(temporary, victim);
        replacementIdentity = fs.statSync(victim);
        assert.notEqual(replacementIdentity.ino, before.ino);
      };
      const current = await createFixture({ faultInjector(event) {
        if (phase === event) replace();
      } });
      let resumed;
      try {
        await current.manager.initialize();
        const original = current.repository.getArtifact(current.artifact.id);
        if (phase === 'before-commit') {
          const createService = current.manager.createService;
          current.manager.createService = (rootDir) => { replace(); return createService(rootDir); };
        }
        fs.mkdirSync(current.targetRoot, { recursive: true });
        const result = await current.manager.changeStorageLocation();
        assert.equal(result.code, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', JSON.stringify(result));
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        const journal = JSON.parse(fs.readFileSync(current.journalPath));
        const relativePath = replacement === 'canonical'
          ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
        assert.notEqual(journal.targetFileIdentities[relativePath].ino, String(replacementIdentity.ino));
        assert.deepEqual(current.repository.getArtifact(current.artifact.id).blob.fingerprint, original.blob.fingerprint);
        assert.deepEqual(current.repository.getArtifact(current.artifact.id).storageFingerprint, original.storageFingerprint);
        assert.ok(fs.existsSync(managed(current.sourceRoot, original.blob.relativePath)));
        resumed = createManagerForFixture(current);
        const recovered = await resumed.manager.initialize();
        assert.equal(recovered.migrationRecovery.code, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', JSON.stringify(recovered));
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        assert.equal(fs.statSync(victim).ino, replacementIdentity.ino);
        assert.equal(JSON.parse(fs.readFileSync(current.journalPath)).migrationId, journal.migrationId);
      } finally {
        for (const manager of [current.manager, resumed?.manager].filter(Boolean)) {
          await manager.pauseBackgroundOwnershipScan();
          await manager.currentService?.pauseBackgroundMaterialization();
        }
        current.close();
      }
    });
  }
}

test('canonical 在复制后被替换时禁止目录化消费，即使其 SHA 未改变', async () => {
  const current = await createFixture({ faultInjector(event) {
    if (event !== 'after-copy-blob') return;
    const canonical = managed(current.targetRoot, current.artifact.blob.relativePath);
    const replacement = path.join(current.tempDir, 'replacement.xlsx');
    fs.writeFileSync(replacement, fs.readFileSync(canonical));
    fs.renameSync(replacement, canonical);
  } });
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot);
    assert.equal((await current.manager.changeStorageLocation()).code, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED');
    assert.equal(fs.existsSync(managed(current.targetRoot, current.artifact.storageRelativePath)), false);
    assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
    assert.ok(fs.existsSync(current.journalPath));
  } finally { current.close(); }
});

for (const missing of ['canonical', 'materialized']) {
  test(`历史 ${missing} 目标缺少原身份时不可借助同 SHA 补齐后切换`, async () => {
    const current = await createFixture({ faultInjector(event) {
      if (event === 'after-materialize-artifact') throw new Error('模拟发布后中断');
    } });
    let resumed;
    try {
      await current.manager.initialize();
      fs.mkdirSync(current.targetRoot);
      assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
      const journal = JSON.parse(fs.readFileSync(current.journalPath));
      const relativePath = missing === 'canonical'
        ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
      delete journal.targetFileIdentities[relativePath];
      fs.writeFileSync(current.journalPath, JSON.stringify(journal));
      const originalInode = fs.statSync(managed(current.targetRoot, relativePath)).ino;
      resumed = createManagerForFixture(current);
      const recovered = await resumed.manager.initialize();
      assert.equal(recovered.migrationRecovery.code, 'ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING', JSON.stringify(recovered));
      assert.equal(fs.statSync(managed(current.targetRoot, relativePath)).ino, originalInode);
      assert.equal(JSON.parse(fs.readFileSync(current.journalPath)).targetFileIdentities[relativePath], undefined);
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
      assert.ok(fs.existsSync(current.sourceRoot));
    } finally {
      for (const manager of [current.manager, resumed?.manager].filter(Boolean)) {
        await manager.pauseBackgroundOwnershipScan();
        await manager.currentService?.pauseBackgroundMaterialization();
      }
      current.close();
    }
  });
}

for (const crashPoint of ['none', 'before-unlink-checkpoint', 'after-unlink-checkpoint']) {
  test(`历史目标 hardlink 转为独立 copy，在 ${crashPoint} 按原路径组证明链接减少并可重启`, async () => {
    const current = await createFixture({ faultInjector(event) {
      if (event === 'after-materialize-artifact') throw new Error('模拟旧版本目录发布后中断');
    } });
    const managers = [current.manager];
    try {
      await current.manager.initialize();
      fs.mkdirSync(current.targetRoot);
      assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
      const canonical = managed(current.targetRoot, current.artifact.blob.relativePath);
      const layout = managed(current.targetRoot, current.artifact.storageRelativePath);
      fs.unlinkSync(layout);
      fs.linkSync(canonical, layout);
      // 精确还原旧 migrator 已发布 hardlink 并在原 journal 登记两个路径的事实。
      const journal = JSON.parse(fs.readFileSync(current.journalPath));
      for (const relativePath of journal.targetPublishedPaths) {
        journal.targetFileIdentities[relativePath] = await current.manager._captureMigrationFile(current.targetRoot, relativePath);
      }
      fs.writeFileSync(current.journalPath, JSON.stringify(journal));
      const originalCanonicalInode = fs.statSync(canonical).ino;
      const resumed = createManagerForFixture(current);
      managers.push(resumed.manager);
      if (crashPoint === 'before-unlink-checkpoint') {
        const write = resumed.manager._writeJournal.bind(resumed.manager);
        resumed.manager._writeJournal = (value, phase, patch) => {
          if (patch?.targetFileIdentities?.[current.artifact.storageRelativePath]?.exists === false) {
            throw new Error('unlink 完成而 checkpoint 尚未提交');
          }
          return write(value, phase, patch);
        };
      } else if (crashPoint === 'after-unlink-checkpoint') {
        resumed.manager.createMaterializer = () => ({ materialize() {
          throw new Error('checkpoint 完成而新 copy 尚未发布');
        } });
      }
      const result = await resumed.manager.initialize();
      if (crashPoint !== 'none') {
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        assert.equal(fs.existsSync(layout), false);
        assert.equal(fs.statSync(canonical).ino, originalCanonicalInode);
        const retried = createManagerForFixture(current);
        managers.push(retried.manager);
        assert.equal((await retried.manager.initialize()).ok, true);
      } else assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), real(current.targetRoot));
      assert.equal(fs.statSync(canonical).ino, originalCanonicalInode);
      assert.notEqual(fs.statSync(layout).ino, originalCanonicalInode);
      assert.equal(fs.statSync(canonical).nlink, 1);
      assert.equal(current.repository.getArtifact(current.artifact.id).storageMode, 'copy');
      assert.equal(fs.existsSync(current.journalPath), false);
    } finally {
      for (const manager of managers) {
        await manager.pauseBackgroundOwnershipScan();
        await manager.currentService?.pauseBackgroundMaterialization();
      }
      current.close();
    }
  });
}


for (const replacement of ['canonical', 'materialized']) {
  test(`续跑 ${replacement} 在首次原身份校验后被替换时不得覆盖 journal 重新认领`, async () => {
    const current = await createFixture({ faultInjector(event) {
      if (event === 'after-materialize-artifact') throw new Error('原迁移已登记全部目标');
    } });
    let resumed;
    try {
      await current.manager.initialize();
      fs.mkdirSync(current.targetRoot);
      assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
      const journal = JSON.parse(fs.readFileSync(current.journalPath));
      const relativePath = replacement === 'canonical'
        ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
      const victim = managed(current.targetRoot, relativePath);
      resumed = createManagerForFixture(current);
      const check = resumed.manager._assertMigrationFile.bind(resumed.manager);
      let replacementInode;
      resumed.manager._assertMigrationFile = async (value, side, checkedPath) => {
        const result = await check(value, side, checkedPath);
        if (!replacementInode && side === 'target' && checkedPath === relativePath) {
          const other = path.join(current.tempDir, 'replacement.xlsx');
          fs.writeFileSync(other, fs.readFileSync(victim));
          fs.renameSync(other, victim);
          replacementInode = String(fs.statSync(victim).ino);
        }
        return result;
      };
      const recovered = await resumed.manager.initialize();
      assert.equal(recovered.migrationRecovery.code, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', JSON.stringify(recovered));
      assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
      assert.equal(String(fs.statSync(victim).ino), replacementInode);
      const after = JSON.parse(fs.readFileSync(current.journalPath));
      assert.equal(after.targetFileIdentities[relativePath].ino, journal.targetFileIdentities[relativePath].ino);
      assert.notEqual(after.targetFileIdentities[relativePath].ino, replacementInode);
      assert.ok(fs.existsSync(current.sourceRoot));
    } finally {
      for (const manager of [current.manager, resumed?.manager].filter(Boolean)) {
        await manager.pauseBackgroundOwnershipScan();
        await manager.currentService?.pauseBackgroundMaterialization();
      }
      current.close();
    }
  });
}


for (const targetKind of ['canonical', 'materialized']) {
  for (const sameContent of [false, true]) {
    test(`历史 ${targetKind} 在确认缺失后出现${sameContent ? '同内容' : '不同内容'}文件时保留新文件`, async () => {
      const current = await createFixture({ faultInjector(event) {
        if (event === 'after-materialize-artifact') throw new Error('原迁移已登记全部目标');
      } });
      let resumed;
      try {
        await current.manager.initialize();
        fs.mkdirSync(current.targetRoot);
        assert.equal((await current.manager.changeStorageLocation()).status, 'failed');
        const journal = JSON.parse(fs.readFileSync(current.journalPath));
        const relativePath = targetKind === 'canonical'
          ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
        const victim = managed(current.targetRoot, relativePath);
        const content = sameContent ? fs.readFileSync(victim) : Buffer.from('其他所有者新出现的文件');
        fs.unlinkSync(victim);
        resumed = createManagerForFixture(current);
        const check = resumed.manager._assertMigrationFile.bind(resumed.manager);
        let newInode;
        resumed.manager._assertMigrationFile = async (value, side, checkedPath) => {
          const result = await check(value, side, checkedPath);
          const phase = targetKind === 'canonical' ? 'copying' : 'materializing-layout';
          if (!newInode && value.phase === phase && side === 'target' && checkedPath === relativePath && !result.exists) {
            fs.writeFileSync(victim, content);
            newInode = String(fs.statSync(victim).ino);
          }
          return result;
        };
        const result = await resumed.manager.initialize();
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        assert.equal(String(fs.statSync(victim).ino), newInode);
        assert.deepEqual(fs.readFileSync(victim), content);
        assert.equal(JSON.parse(fs.readFileSync(current.journalPath)).migrationId, journal.migrationId);
        assert.ok(fs.existsSync(current.sourceRoot));
      } finally {
        for (const manager of [current.manager, resumed?.manager].filter(Boolean)) {
          await manager.pauseBackgroundOwnershipScan();
          await manager.currentService?.pauseBackgroundMaterialization();
        }
        current.close();
      }
    });
  }
}

for (const targetKind of ['canonical', 'materialized']) {
  for (const copyFallback of [false, true]) {
    test(`目标 ${targetKind} 在排他发布前出现新文件，${copyFallback ? 'wx fd' : 'link'} 不覆盖且不切换`, async () => {
      const fsImpl = { ...fs, promises: { ...fs.promises, async link(source, target) {
        if (copyFallback) throw Object.assign(new Error('模拟文件系统不支持 hardlink'), { code: 'ENOTSUP' });
        return fs.promises.link(source, target);
      } } };
      const current = await createFixture({ fsImpl });
      try {
        await current.manager.initialize();
        const relativePath = targetKind === 'canonical'
          ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
        const victim = managed(current.targetRoot, relativePath);
        const publish = current.manager._publishMigrationTarget.bind(current.manager);
        let newInode;
        current.manager._publishMigrationTarget = async (source, target, options) => {
          if (portablePathOf(target).endsWith(`/${relativePath}`)) {
            fs.writeFileSync(target, '发布之前已经存在的其他所有者文件');
            newInode = fs.statSync(target).ino;
          }
          return publish(source, target, options);
        };
        fs.mkdirSync(current.targetRoot);
        const result = await current.manager.changeStorageLocation();
        assert.equal(result.code, targetKind === 'canonical'
          ? 'ARCHIVE_STORAGE_UNKNOWN_CONTENT' : 'ARCHIVE_MATERIALIZATION_FAILED', JSON.stringify(result));
        if (targetKind === 'materialized') assert.match(result.message, /ARCHIVE_STORAGE_UNKNOWN_CONTENT/);
        assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
        assert.equal(fs.statSync(victim).ino, newInode);
        assert.equal(fs.readFileSync(victim, 'utf8'), '发布之前已经存在的其他所有者文件');
        assert.ok(fs.existsSync(current.sourceRoot));
        const journal = JSON.parse(fs.readFileSync(current.journalPath));
        assert.equal(journal.targetFileIdentities[relativePath], undefined);
      } finally { current.close(); }
    });
  }
}


test('不支持 hardlink 的文件系统通过 wx 原 fd 写入并刷盘，再以同一 fd 恢复只读模式', async () => {
  let targetRoot;
  const created = [];
  const events = [];
  const expectedTargets = [];
  const fsImpl = { ...fs, promises: { ...fs.promises,
    async link() { throw Object.assign(new Error('模拟文件系统不支持 hardlink'), { code: 'ENOTSUP' }); },
    async open(filePath, flags, mode) {
      const handle = await fs.promises.open(filePath, flags, mode);
      if (targetRoot && expectedTargets.includes(filePath) && flags === 'wx') {
        created.push(filePath);
        assert.equal(fs.fstatSync(handle.fd).mode & 0o777, 0o600);
        const sync = handle.sync.bind(handle);
        const chmod = handle.chmod.bind(handle);
        handle.sync = async () => {
          events.push({ path: filePath, kind: 'sync', mode: fs.fstatSync(handle.fd).mode & 0o777 });
          return sync();
        };
        handle.chmod = async (value) => {
          events.push({ path: filePath, kind: 'chmod', mode: value });
          return chmod(value);
        };
      }
      return handle;
    }
  } };
  const current = await createFixture({ fsImpl });
  targetRoot = path.join(real(current.tempDir), 'target-root');
  expectedTargets.push(...[current.artifact.blob.relativePath, current.artifact.storageRelativePath]
    .map((relativePath) => managed(targetRoot, relativePath)));
  try {
    await current.manager.initialize();
    fs.mkdirSync(current.targetRoot);
    const result = await current.manager.changeStorageLocation();
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(created.length, 2);
    for (const filePath of created) {
      const operations = events.filter((entry) => entry.path === filePath);
      assert.deepEqual(operations.map((entry) => entry.kind), ['sync', 'chmod', 'sync']);
      assert.equal(operations[0].mode, 0o600);
    }
    const canonical = fs.statSync(managed(current.targetRoot, current.artifact.blob.relativePath));
    const layout = fs.statSync(managed(current.targetRoot, current.artifact.storageRelativePath));
    assert.notEqual(canonical.ino, layout.ino);
    assert.equal(layout.mode & 0o777, 0o444);
    assert.equal(canonical.nlink, 1);
    assert.equal(layout.nlink, 1);
    assert.equal(fs.existsSync(current.journalPath), false);
  } finally { current.close(); }
});

for (const targetKind of ['canonical', 'materialized']) {
  for (const copyFallback of [false, true]) {
    for (const stopAt of ['after-create', 'before-first-capture']) {
      test(`新 ${targetKind} 经 ${copyFallback ? 'wx fd' : 'link'} 发布，在 ${stopAt} 换 inode 后不能首次认领`, async () => {
        let current;
        let victim;
        let substitutedInode;
        const substitute = (target) => {
          if (!victim || target !== victim || substitutedInode) return;
          const original = fs.statSync(target);
          const sourcePath = managed(current.sourceRoot, current.artifact.blob.relativePath);
          const replacement = path.join(current.tempDir, 'same-sha-new-owner');
          fs.writeFileSync(replacement, fs.readFileSync(sourcePath));
          fs.renameSync(replacement, target);
          substitutedInode = String(fs.statSync(target).ino);
          assert.notEqual(substitutedInode, String(original.ino));
        };
        const fsImpl = { ...fs, promises: { ...fs.promises,
          async link(source, target) {
            if (copyFallback) throw Object.assign(new Error('模拟文件系统不支持 hardlink'), { code: 'ENOTSUP' });
            await fs.promises.link(source, target);
            if (stopAt === 'after-create') substitute(target);
          },
          async open(filePath, flags, mode) {
            const handle = await fs.promises.open(filePath, flags, mode);
            if (copyFallback && stopAt === 'after-create' && flags === 'wx') substitute(filePath);
            return handle;
          }
        } };
        current = await createFixture({ fsImpl });
        try {
          await current.manager.initialize();
          fs.mkdirSync(current.targetRoot);
          const relativePath = targetKind === 'canonical'
            ? current.artifact.blob.relativePath : current.artifact.storageRelativePath;
          victim = managed(real(current.targetRoot), relativePath);
          if (stopAt === 'before-first-capture') {
            const publish = current.manager._publishMigrationTarget.bind(current.manager);
            current.manager._publishMigrationTarget = async (source, target, options) => {
              const original = await publish(source, target, options);
              substitute(target);
              return original;
            };
          }
          const result = await current.manager.changeStorageLocation();
          assert.equal(result.status, 'failed', JSON.stringify(result));
          assert.ok(substitutedInode);
          assert.equal(current.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY), null);
          assert.equal(String(fs.statSync(victim).ino), substitutedInode);
          assert.equal(fs.readFileSync(victim, 'utf8'), 'archive-root-migration-content');
          const journal = JSON.parse(fs.readFileSync(current.journalPath));
          assert.equal(journal.targetFileIdentities[relativePath], undefined);
          const after = current.repository.getArtifact(current.artifact.id);
          assert.deepEqual(after.blob.fingerprint, current.artifact.blob.fingerprint);
          assert.deepEqual(after.storageFingerprint, current.artifact.storageFingerprint);
          assert.ok(fs.existsSync(current.sourceRoot));
        } finally { current.close(); }
      });
    }
  }
}
