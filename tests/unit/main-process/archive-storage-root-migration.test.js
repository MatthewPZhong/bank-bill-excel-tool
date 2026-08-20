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
const {
  ROOT_MARKER_FILE,
  createArchiveStorageRootManager,
  exactMarker
} = require('../../../src/main-process/archive-center/storage-root-manager');

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
    fs.writeFileSync(path.join(current.sourceRoot, '.readonly', 'transient.xlsx'), 'readonly-copy');
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
    assert.equal(fs.existsSync(path.join(current.targetRoot, '.readonly', 'transient.xlsx')), false);
    assert.ok(current.progress.some((item) => item.phase === 'copying'));
    assert.ok(current.progress.some((item) => item.phase === 'materializing-layout'));
    assert.ok(current.progress.some((item) => item.phase === 'verifying'));
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

test('pre-switch 恢复按 journal 目标发布清单清除已删除批次的目标残留', async () => {
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

    const deleted = await current.manager.currentService.deleteBatch(current.artifact.batchId, {
      force: true
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(current.repository.getArtifact(current.artifact.id), null);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(restarted.runtime.rootDir, real(current.targetRoot));
    assert.equal(fs.existsSync(staleTargetBlob), false);
    assert.equal(
      fs.existsSync(current.journalPath),
      false,
      fs.existsSync(current.journalPath)
        ? fs.readFileSync(current.journalPath, 'utf8')
        : 'journal removed'
    );
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

test('启动不跑目录化维护，用户迁移仍在完整 SHA 校验后切根', async () => {
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
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(current.repository.countMaterializationCandidates(), 0);
    assert.ok(events.indexOf('maintenance-requested') < events.indexOf('full-source-verify'));
    assert.equal(wrapped.runtime.rootDir, real(current.targetRoot));
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
      [...lstatCounts.values()].reduce((sum, count) => sum + count, 0) <= 6,
      '固定关键祖先 syscall 不得随历史 evidence 增长'
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

test('cleanup-pending 期间新根删除批次不会使旧根冻结清单漂移', async () => {
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

    const deleted = await current.manager.currentService.deleteBatch(current.artifact.batchId, {
      force: true
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(current.repository.getArtifact(current.artifact.id), null);

    const restarted = createManagerForFixture(current);
    const initialized = await restarted.manager.initialize();
    assert.equal(initialized.available, true, JSON.stringify(initialized));
    assert.equal(fs.existsSync(current.sourceRoot), false);
    assert.equal(fs.existsSync(current.journalPath), false);
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
