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
  createArchiveStorageRootManager
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
  return fs.realpathSync(rootDir);
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
          && String(targetPath).startsWith(`${fs.realpathSync(sourceRoot)}${path.sep}`)
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
