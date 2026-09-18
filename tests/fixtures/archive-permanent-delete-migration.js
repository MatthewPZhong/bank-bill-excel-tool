'use strict';
const { readIdentityStatSync } = require('../../src/main-process/archive-center/filesystem-identity');

// 永久删除与迁移的跨层夹具：所有数据库、根目录和替代文件只创建于调用方的隔离目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveRepository } = require('../../src/backend/database/archive-repository');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createArchiveRuntimeDelegate } = require('../../src/main-process/archive-center/archive-runtime-delegate');
const { createArchiveStorageRootManager } = require('../../src/main-process/archive-center/storage-root-manager');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { buildDeletePlan } = require('../../src/main-process/archive-center/batch-delete-plan');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotFiles(paths) {
  return paths.filter((filePath) => fs.existsSync(filePath)).map((filePath) => ({
    filePath, ino: String(readIdentityStatSync(fs, filePath, 'statSync').ino), hash: hashFile(filePath)
  }));
}

async function verifyMigrationDeleteOverlap(parentDirectory, options = {}) {
  const isolatedDir = fs.mkdtempSync(path.join(parentDirectory, 'migration-delete-'));
  const sourceRoot = path.join(isolatedDir, 'source-root');
  const targetRoot = path.join(isolatedDir, 'target-root');
  const journalPath = path.join(isolatedDir, 'storage-migration.json');
  const db = new DatabaseSync(path.join(isolatedDir, 'archive.sqlite'));
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT NOT NULL)`);
  const database = { db,
    getSetting: (key) => db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key)?.setting_value || null,
    setSetting: (key, value) => db.prepare('INSERT OR REPLACE INTO app_settings VALUES(?,?,?)')
      .run(key, value, new Date().toISOString()) };
  const repository = createArchiveRepository(db);
  repository.ensureSchema();
  let failSourceCleanup = false;
  let sourceCanonicalRoot = sourceRoot;
  const fsImpl = { ...fs, promises: { ...fs.promises, async rm(filePath, rmOptions) {
    if (failSourceCleanup && String(filePath).startsWith(`${sourceCanonicalRoot}${path.sep}`)) {
      failSourceCleanup = false;
      throw Object.assign(new Error('隔离夹具模拟迁移提交后旧根暂时不可写'), { code: 'EACCES' });
    }
    return fs.promises.rm(filePath, rmOptions);
  } } };
  const runtimes = [];
  function createRuntime() {
    const delegate = createArchiveRuntimeDelegate({ repository, rootDir: sourceRoot });
    const manager = createArchiveStorageRootManager({ database, repository, runtimeDelegate: delegate,
      defaultRoot: sourceRoot, journalPath, blockedRoots: [], fsImpl,
      showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }),
      createService: (rootDir) => createArchiveService({ database: db, rootDir, fsImpl }) });
    const controller = createArchiveCenterController({ database, service: delegate, storageRootManager: manager,
      outboxStore: createArchiveOutboxStore(path.join(isolatedDir, 'outbox')) });
    const runtime = { delegate, manager, controller };
    runtimes.push(runtime);
    return runtime;
  }
  try {
    const initial = createRuntime();
    assert.equal((await initial.controller.initialize()).ok, true);
    sourceCanonicalRoot = initial.manager.currentService.rootDir;
    const inputPath = path.join(isolatedDir, 'external-input.xlsx');
    fs.writeFileSync(inputPath, 'migration-owner-original-evidence');
    const originalExternalHash = hashFile(inputPath);
    const policy = { channel: 'toolbox:merge', scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱',
      taskKey: 'toolbox:merge', startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file', allocation: 'eager',
      resultClassifier: () => 'succeeded' };
    const lifecycle = createTaskLifecycle({ archiveService: initial.delegate,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'migration-owner' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'migration-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => initial.controller.persistTaskTerminalIntent(payload) });
    let batchContext;
    await lifecycle.runFileTask({ policy, taskRunId: 'migration-task', operationKey: 'migration-operation',
      meta: { channel: policy.channel },
      filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: inputPath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
      execute: async (context) => { batchContext = context; return { status: 'success' }; } });
    assert.ok(repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext }));
    const artifact = repository.listArtifacts(batchContext.batchId)[0];
    const preparation = await initial.controller.prepareDeleteBatch(batchContext.batchId);
    assert.equal(preparation.ok, true, JSON.stringify(preparation));
    // 冻结原根身份发生在迁移前，随后仅用于还原升级前已存在的删除/迁移重叠。
    const originalDeletePlan = await buildDeletePlan(initial.manager.currentService, batchContext.batchId);
    fs.mkdirSync(targetRoot);
    failSourceCleanup = true;
    const partial = await initial.manager.changeStorageLocation();
    assert.equal(partial.code, 'ARCHIVE_STORAGE_CLEANUP_PENDING', JSON.stringify(partial));
    await initial.manager.pauseBackgroundOwnershipScan();
    await initial.manager.currentService.pauseBackgroundMaterialization();
    const originalJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(originalJournal.phase, 'cleanup-pending');
    assert.ok(originalJournal.targetPublishedPaths.includes(artifact.storageRelativePath));
    const removed = repository.deleteBatch(batchContext.batchId,
      options.legacyJob ? { allowLocked: true } : { deletePlan: originalDeletePlan });
    assert.equal(removed.status, 'deleted');
    assert.ok(removed.cleanupJob);
    assert.equal(repository.getDeletionReceipt(batchContext.batchId), null);
    if (options.legacyJournal) {
      // 还原历史 path-only journal。不能把本次现场 stat 填成其原发布凭证。
      const legacyJournal = { ...originalJournal };
      delete legacyJournal.sourceFileIdentities;
      delete legacyJournal.targetFileIdentities;
      fs.writeFileSync(journalPath, JSON.stringify(legacyJournal));
    }
    const victim = path.join(targetRoot, artifact.storageRelativePath);
    if (options.replacement) {
      const previousInode = String(readIdentityStatSync(fs, victim, 'statSync').ino);
      const replacement = path.join(isolatedDir, 'replacement.xlsx');
      fs.writeFileSync(replacement, options.replacement === 'same'
        ? fs.readFileSync(victim) : 'a different owner owns this replacement');
      fs.chmodSync(victim, 0o600);
      fs.renameSync(replacement, victim);
      assert.notEqual(String(readIdentityStatSync(fs, victim, 'statSync').ino), previousInode);
    }
    const managedFiles = [...new Set([
      ...originalJournal.sourceCleanupPaths.map((relativePath) => path.join(sourceCanonicalRoot, relativePath)),
      ...originalJournal.targetPublishedPaths.map((relativePath) => path.join(targetRoot, relativePath))
    ])];
    if (options.alreadyMissing) {
      for (const filePath of managedFiles) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const before = snapshotFiles(managedFiles);
    const restarted = createRuntime();
    let initialization;
    try { initialization = await restarted.controller.initialize(); } catch (error) {
      initialization = { ok: false, code: error.code, message: error.message };
    }
    const shouldFinish = !options.replacement && (!options.legacyJournal || options.alreadyMissing) && !options.legacyJob;
    let recoveryErrorCode = null;
    if (shouldFinish) {
      assert.equal(initialization.ok, true, JSON.stringify(initialization));
      assert.equal(repository.listCleanupJobs().length, 0);
      assert.ok(repository.getDeletionReceipt(batchContext.batchId));
      assert.equal(fs.existsSync(journalPath), false);
      assert.ok(managedFiles.every((filePath) => !fs.existsSync(filePath)));
    } else {
      for (const saved of before) {
        assert.equal(fs.existsSync(saved.filePath), true, `迁移资格核验前不得删除：${saved.filePath}`);
        assert.equal(String(readIdentityStatSync(fs, saved.filePath, 'statSync').ino), saved.ino);
        assert.equal(hashFile(saved.filePath), saved.hash);
      }
      assert.equal(repository.getDeletionReceipt(batchContext.batchId), null);
      assert.equal(repository.listCleanupJobs().length, 1);
      assert.equal(repository.listCleanupJobs()[0].id, removed.cleanupJob.id);
      assert.equal(fs.existsSync(journalPath), true);
      const pendingJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      assert.equal(pendingJournal.migrationId, originalJournal.migrationId);
      recoveryErrorCode = pendingJournal.lastError?.code;
      const expectedErrorCodes = options.legacyJob ? ['ARCHIVE_STORAGE_DELETE_RECOVERY_CONFLICT']
        : options.legacyJournal ? ['ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING']
          : ['ARCHIVE_STORAGE_DELETE_FILE_CHANGED', 'ARCHIVE_DELETE_FILE_CHANGED'];
      assert.ok(expectedErrorCodes.includes(recoveryErrorCode), `迁移应持久记录明确拒绝原因：${recoveryErrorCode}`);
      const retried = await restarted.controller.retryDeleteCleanupJob(removed.cleanupJob.id);
      assert.notEqual(retried.fullyDeleted, true, JSON.stringify(retried));
      assert.equal(retried.ok, false, JSON.stringify(retried));
      assert.equal(retried.cleanupJobId, removed.cleanupJob.id, JSON.stringify(retried));
      for (const saved of before) {
        assert.equal(fs.existsSync(saved.filePath), true);
        assert.equal(hashFile(saved.filePath), saved.hash);
      }
    }
    assert.equal(hashFile(inputPath), originalExternalHash);
    return { initialization, fullyDeleted: Boolean(repository.getDeletionReceipt(batchContext.batchId)),
      remainingJobs: repository.listCleanupJobs().length, preservedFiles: shouldFinish ? 0 : before.length,
      recoveryErrorCode };
  } finally {
    for (const runtime of runtimes) {
      await runtime.manager.pauseBackgroundOwnershipScan();
      if (runtime.manager.currentService) await runtime.manager.currentService.pauseBackgroundMaterialization();
    }
    db.close();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
}


function createTargetIdentityRuntime(isolatedDir, options = {}) {
  const sourceRoot = path.join(isolatedDir, 'source-root');
  const targetRoot = path.join(isolatedDir, 'target-root');
  const journalPath = path.join(isolatedDir, 'storage-migration.json');
  const db = new DatabaseSync(path.join(isolatedDir, 'archive.sqlite'));
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT NOT NULL)`);
  const database = { db,
    getSetting: (key) => db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key)?.setting_value || null,
    setSetting: (key, value) => db.prepare('INSERT OR REPLACE INTO app_settings VALUES(?,?,?)')
      .run(key, value, new Date().toISOString()) };
  const repository = createArchiveRepository(db);
  repository.ensureSchema();
  const delegate = createArchiveRuntimeDelegate({ repository, rootDir: sourceRoot });
  const manager = createArchiveStorageRootManager({ database, repository, runtimeDelegate: delegate,
    defaultRoot: sourceRoot, journalPath, blockedRoots: [], faultInjector: options.faultInjector, fsImpl: options.fsImpl,
    showOpenDialog: async () => ({ canceled: false, filePaths: [targetRoot] }),
    createService: (rootDir) => createArchiveService({ database: db, rootDir, fsImpl: options.fsImpl }) });
  const controller = createArchiveCenterController({ database, service: delegate, storageRootManager: manager,
    outboxStore: createArchiveOutboxStore(path.join(isolatedDir, 'outbox')) });
  let closed = false;
  return { sourceRoot, targetRoot, journalPath, database, repository, delegate, manager, controller,
    async close() {
      if (closed) return;
      closed = true;
      await manager.pauseBackgroundOwnershipScan();
      await manager.currentService?.pauseBackgroundMaterialization();
      db.close();
    } };
}

async function recoverTargetIdentityInChild(isolatedDir, batchId) {
  const runtime = createTargetIdentityRuntime(isolatedDir);
  try {
    let initialization;
    try { initialization = await runtime.controller.initialize(); } catch (error) {
      initialization = { ok: false, code: error.code };
    }
    const prepared = await runtime.controller.prepareDeleteBatch(batchId);
    const journal = JSON.parse(fs.readFileSync(runtime.journalPath));
    return { initialization, prepared, migrationId: journal.migrationId,
      recoveryCode: journal.lastError?.code,
      artifact: runtime.repository.listArtifacts(batchId)[0],
      activeRoot: runtime.manager.currentService?.rootDir,
      deletionReceipt: runtime.repository.getDeletionReceipt(batchId) };
  } finally { await runtime.close(); }
}

async function verifyMigrationTargetIdentity(parentDirectory, options = {}) {
  const isolatedDir = fs.mkdtempSync(path.join(parentDirectory, 'migration-target-identity-'));
  let artifact;
  let replacementIdentity;
  let victim;
  // fs 代理仅用于隔离夹具；默认仍使用真实 fs，不改变业务入口。
  const fsImpl = options.createFs?.(path.join(await fs.promises.realpath(isolatedDir), 'target-root'));
  let runtime = createTargetIdentityRuntime(isolatedDir, { fsImpl, faultInjector(event) {
    if (event !== 'after-materialize-artifact' || !options.replacement) return;
    const relativePath = options.replacement === 'canonical'
      ? artifact.blob.relativePath : artifact.storageRelativePath;
    victim = path.join(runtime.targetRoot, relativePath);
    const original = readIdentityStatSync(fs, victim, 'statSync');
    const replacement = path.join(isolatedDir, 'replacement.xlsx');
    fs.writeFileSync(replacement, fs.readFileSync(victim));
    fs.chmodSync(victim, 0o600);
    fs.renameSync(replacement, victim);
    replacementIdentity = snapshotFiles([victim])[0];
    assert.notEqual(replacementIdentity.ino, String(original.ino));
  } });
  try {
    assert.equal((await runtime.controller.initialize()).ok, true);
    const externalFile = path.join(isolatedDir, 'original-external.xlsx');
    fs.writeFileSync(externalFile, 'migration-target-identity-lifecycle');
    const externalHash = hashFile(externalFile);
    const policy = { channel: 'toolbox:merge', scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱',
      taskKey: 'toolbox:merge', startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file', allocation: 'eager',
      resultClassifier: () => 'succeeded' };
    const lifecycle = createTaskLifecycle({ archiveService: runtime.delegate,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'migration-target-owner' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'migration-target-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => runtime.controller.persistTaskTerminalIntent(payload) });
    let batchContext;
    await lifecycle.runFileTask({ policy, taskRunId: 'migration-target-task', operationKey: 'migration-target-operation',
      meta: { channel: policy.channel },
      filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: externalFile, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
      execute: async (context) => { batchContext = context; return { status: 'success' }; } });
    assert.ok(runtime.repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext }));
    artifact = runtime.repository.listArtifacts(batchContext.batchId)[0];
    const originalFiles = snapshotFiles([artifact.blob.relativePath, artifact.storageRelativePath]
      .map((relativePath) => path.join(runtime.sourceRoot, relativePath)));
    const before = await runtime.controller.prepareDeleteBatch(batchContext.batchId);
    assert.equal(before.ok, true, JSON.stringify(before));
    fs.mkdirSync(runtime.targetRoot);
    const migrated = await runtime.manager.changeStorageLocation();
    let deleted;
    let recovered;
    let reopenedDatabase = false;
    if (!options.replacement) {
      assert.equal(migrated.status, 'success', JSON.stringify(migrated));
      const migratedArtifact = runtime.repository.getArtifact(artifact.id);
      if (options.reopenBeforeDelete) {
        await runtime.close();
        runtime = createTargetIdentityRuntime(isolatedDir, { fsImpl });
        assert.equal((await runtime.controller.initialize()).ok, true);
        assert.deepEqual(runtime.repository.getArtifact(artifact.id).storageFingerprint, migratedArtifact.storageFingerprint);
        reopenedDatabase = true;
      }
      if (options.verifyMigrated) options.verifyMigrated(runtime, migratedArtifact);
      const prepared = await runtime.controller.prepareDeleteBatch(batchContext.batchId);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      deleted = await runtime.controller.deleteBatch(batchContext.batchId, prepared.confirmationToken);
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
      assert.ok(runtime.repository.getDeletionReceipt(batchContext.batchId));
      for (const relativePath of [migratedArtifact.blob.relativePath, migratedArtifact.storageRelativePath]) {
        assert.equal(fs.existsSync(path.join(runtime.targetRoot, relativePath)), false);
      }
      assert.equal(fs.existsSync(runtime.sourceRoot), false);
      assert.equal(fs.existsSync(runtime.journalPath), false);
    } else {
      assert.equal(migrated.code, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', JSON.stringify(migrated));
      const journal = JSON.parse(fs.readFileSync(runtime.journalPath));
      const originalTargetIdentity = journal.targetFileIdentities[options.replacement === 'canonical'
        ? artifact.blob.relativePath : artifact.storageRelativePath];
      assert.notEqual(originalTargetIdentity.ino, replacementIdentity.ino);
      assert.deepEqual(runtime.repository.getArtifact(artifact.id).blob.fingerprint, artifact.blob.fingerprint);
      assert.deepEqual(runtime.repository.getArtifact(artifact.id).storageFingerprint, artifact.storageFingerprint);
      deleted = await runtime.controller.deleteBatch(batchContext.batchId, before.confirmationToken);
      assert.equal(deleted.ok, false, JSON.stringify(deleted));
      assert.notEqual(deleted.fullyDeleted, true);
      assert.equal(runtime.repository.getDeletionReceipt(batchContext.batchId), null);
      if (options.restart) {
        await runtime.close();
        recovered = JSON.parse(execFileSync(process.execPath,
          [__filename, '--target-identity-restart', isolatedDir, String(batchContext.batchId)],
          { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
        assert.equal(recovered.recoveryCode, 'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', JSON.stringify(recovered));
        assert.equal(recovered.migrationId, journal.migrationId);
        assert.equal(recovered.prepared.code, 'ARCHIVE_STORAGE_MIGRATION_PENDING', JSON.stringify(recovered));
        assert.equal(recovered.deletionReceipt, null);
        assert.deepEqual(recovered.artifact.blob.fingerprint, artifact.blob.fingerprint);
        assert.deepEqual(recovered.artifact.storageFingerprint, artifact.storageFingerprint);
      }
      for (const saved of [...originalFiles, replacementIdentity]) {
        assert.equal(String(readIdentityStatSync(fs, saved.filePath, 'statSync').ino), saved.ino);
        assert.equal(hashFile(saved.filePath), saved.hash);
      }
      assert.ok(fs.existsSync(runtime.journalPath));
    }
    assert.equal(hashFile(externalFile), externalHash);
    return { migrated: migrated.status, migrationCode: migrated.code || null,
      fullyDeleted: deleted.fullyDeleted === true, replacement: options.replacement || null,
      replacementPreserved: replacementIdentity ? fs.existsSync(victim) : null,
      independentRestart: Boolean(recovered), reopenedDatabase, recoveryCode: recovered?.recoveryCode || null };
  } finally {
    await runtime.close();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
}

module.exports = { verifyMigrationDeleteOverlap, verifyMigrationTargetIdentity };

if (require.main === module && process.argv[2] === '--target-identity-restart') {
  recoverTargetIdentityInChild(process.argv[3], Number(process.argv[4])).then((result) => {
    process.stdout.write(JSON.stringify(result));
  }).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
