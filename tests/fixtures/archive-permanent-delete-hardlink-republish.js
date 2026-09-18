'use strict';

// 历史硬链接残项与同 SHA 新 Blob 的跨层回归；所有材料位于独立临时目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');

async function verifyHardlinkRepublishRemainder(parentDirectory, restart = false) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'hardlink-republish-'));
  const archiveRoot = path.join(directory, 'archive');
  const content = 'historical remaining inode and new shared content';
  const state = { blockedPath: '' };
  const fsImpl = { ...fs, promises: fs.promises, unlinkSync(filePath) {
    if (state.blockedPath === filePath) throw Object.assign(new Error('隔离夹具模拟目录副本占用'), { code: 'EBUSY' });
    fs.unlinkSync(filePath);
  } };
  let db;
  let service;
  let controller;
  async function openRuntime(deferStartupRecovery = false) {
    db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    service = createArchiveService({ database: db, rootDir: archiveRoot, fsImpl });
    controller = createArchiveCenterController({ service,
      database: { getSetting: () => null, setSetting() {} },
      outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
    const initialized = deferStartupRecovery
      ? await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })
      : await controller.initialize();
    assert.equal(initialized.ok, true, JSON.stringify(initialized));
  }
  async function createBatch(key) {
    const inputPath = path.join(directory, `${key}.csv`);
    fs.writeFileSync(inputPath, content);
    const policy = createTaskPolicyRegistry().require('template:import');
    const lifecycle = createTaskLifecycle({ archiveService: service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: key }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: `${key}-parent`, source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
    let batchContext;
    await lifecycle.runFileTask({ policy, taskRunId: `${key}-task`, operationKey: `${key}-operation`,
      meta: { channel: policy.channel },
      filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: inputPath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
      execute: async (context) => { batchContext = context; return { status: 'success' }; } });
    const owner = { version: 1, kind: 'file-batch', batchContext };
    assert.ok(service.repository.getOwnerTerminalCompletion(owner));
    return { batchContext, inputPath, artifact: service.repository.listArtifacts(batchContext.batchId)[0] };
  }
  try {
    await openRuntime();
    const a = await createBatch('original-a');
    const canonicalPath = path.join(archiveRoot, a.artifact.blob.relativePath);
    const originalPath = path.join(archiveRoot, a.artifact.storageRelativePath);
    // 仅在删除准入前还原历史 hardlink 格式；之后身份来自真实删除计划与发布流程。
    fs.unlinkSync(originalPath);
    fs.linkSync(canonicalPath, originalPath);
    const original = fs.statSync(canonicalPath);
    db.prepare(`UPDATE archive_artifacts SET storage_mode = 'hardlink',
      storage_fingerprint_size_bytes = ?, storage_fingerprint_mtime_ms = ?,
      storage_fingerprint_ctime_ms = ?, storage_fingerprint_ino = ? WHERE id = ?`)
      .run(original.size, original.mtimeMs, original.ctimeMs, String(original.ino), a.artifact.id);
    db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = ?, fingerprint_mtime_ms = ?,
      fingerprint_ctime_ms = ?, fingerprint_ino = ? WHERE id = ?`)
      .run(original.size, original.mtimeMs, original.ctimeMs, String(original.ino), a.artifact.blob.id);
    const prepared = await controller.prepareDeleteBatch(a.batchContext.batchId);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    state.blockedPath = originalPath;
    const pending = await controller.deleteBatch(a.batchContext.batchId, prepared.confirmationToken);
    assert.equal(pending.metadataDeleted, true);
    assert.equal(pending.fullyDeleted, false);
    const plan = service.repository.getCleanupJob(pending.cleanupJobId).plan;
    assert.equal(plan.items.find((item) => item.kind === 'blob').state, 'deleted');
    assert.equal(fs.existsSync(canonicalPath), false);
    assert.equal(fs.statSync(originalPath).ino, original.ino);
    assert.equal(fs.statSync(originalPath).nlink, original.nlink - 1);
    state.blockedPath = '';
    const b = await createBatch('replacement-b');
    const published = fs.statSync(canonicalPath);
    assert.notEqual(published.ino, original.ino);
    assert.equal(b.artifact.blob.sha256, a.artifact.blob.sha256);
    assert.equal(b.artifact.blob.fingerprint.ino, String(published.ino));
    if (restart) {
      await service.pauseBackgroundMaterialization();
      db.close();
      await openRuntime(true);
    }
    const retried = await controller.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
    assert.equal(fs.existsSync(originalPath), false);
    assert.equal(service.repository.getCleanupJob(pending.cleanupJobId), null);
    assert.ok(service.repository.getDeletionReceipt(a.batchContext.batchId));
    assert.equal(fs.statSync(canonicalPath).ino, published.ino);
    assert.equal(fs.readFileSync(canonicalPath, 'utf8'), content);
    const read = await service.resolveVerifiedArtifact(b.artifact.id);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(fs.readFileSync(read.filePath, 'utf8'), content);
    assert.equal(service.repository.getTaskRun(b.batchContext.taskRunId).status, 'succeeded');
    assert.equal((await controller.prepareDeleteBatch(b.batchContext.batchId)).ok, true);
    assert.equal(fs.readFileSync(a.inputPath, 'utf8'), content);
    assert.equal(fs.readFileSync(b.inputPath, 'utf8'), content);
    return { restart, oldRemainderDeleted: true, replacementInodePreserved: true, otherBatchReadable: true };
  } finally {
    if (service) await service.pauseBackgroundMaterialization();
    if (db) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyHardlinkRepublishRemainder };
