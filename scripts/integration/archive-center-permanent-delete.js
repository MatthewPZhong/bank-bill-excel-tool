'use strict';

// 存档中心永久删除集成验证：真实任务归属、受管文件边界、恢复凭证和维护协调。
// 所有数据库与文件位于独立临时目录；运行：node scripts/integration/archive-center-permanent-delete.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createArchiveRepository } = require('../../src/backend/database/archive-repository');
const { createArchiveRuntimeDelegate } = require('../../src/main-process/archive-center/archive-runtime-delegate');
const { createArchiveStorageRootManager } = require('../../src/main-process/archive-center/storage-root-manager');
const { recoverToolboxPublicationsIntoArchive } = require('../../src/main-process/toolbox-archive-recovery');
const { JOURNAL_INDEX_NAME } = require('../../src/main-process/toolbox-output-publication');
const { verifyMigrationDeleteOverlap, verifyMigrationTargetIdentity } = require('../../tests/fixtures/archive-permanent-delete-migration');
const { verifyOrdinaryOwnerRecovery } = require('../../tests/fixtures/archive-permanent-delete-owner-recovery');
const { verifyHardlinkRepublishRemainder } = require('../../tests/fixtures/archive-permanent-delete-hardlink-republish');
const { verifyBizOpOwnerRecovery } = require('../../tests/fixtures/archive-permanent-delete-bizop-owner');
const { verifyBizOpHistoricalOwnerBackfill } = require('../../tests/fixtures/archive-permanent-delete-bizop-history');
const { verifyPositionFilePlanDeletion } = require('../../tests/fixtures/archive-permanent-delete-position-fileplan');
const { READONLY_OWNER_REPLACEMENTS, verifyReadonlyOwnerIdentity } = require('../../tests/fixtures/archive-permanent-delete-readonly-owner');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-archive-permanent-delete-'));
const state = { blocked: false, target: '' };
const archiveRoot = path.join(directory, 'archive');
const settings = new Map();
const dbPath = path.join(directory, 'archive.sqlite');
let db;
let service;
let controller;
let outboxStore;
let passed = 0;
const total = 49;

const fsImpl = { ...fs, promises: fs.promises, unlinkSync(filePath) {
  if (state.blocked && (!state.target || state.target === filePath)) {
    throw Object.assign(new Error('隔离夹具模拟文件占用'), { code: 'EBUSY' });
  }
  return fs.unlinkSync(filePath);
} };

async function openRuntime() {
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  service = createArchiveService({ database: db, rootDir: archiveRoot, fsImpl });
  outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
  controller = createArchiveCenterController({
    database: { getSetting: (key) => settings.get(key) || null, setSetting: (key, value) => settings.set(key, value) },
    service, outboxStore
  });
  assert.equal((await service.initialize({ deferStartupRecovery: true })).ok, true);
}

function lifecycleFor(key) {
  return createTaskLifecycle({
    archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: key }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: `${key}-parent`, source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
  });
}

function filePolicy(terminalStatus = 'succeeded') {
  return { channel: 'toolbox:merge', scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱',
    taskKey: 'toolbox:merge', startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file',
    allocation: 'eager', resultClassifier: () => terminalStatus };
}

async function completedBatch(key) {
  const sourcePath = path.join(directory, `${key}-input.xlsx`);
  const outputPath = path.join(directory, `${key}-output.xlsx`);
  fs.writeFileSync(sourcePath, `${key}-input`);
  const lifecycle = lifecycleFor(key);
  const policy = filePolicy();
  let batchContext;
  let filePlan;
  const result = await lifecycle.runFileTask({
    policy, meta: { channel: policy.channel }, taskRunId: `${key}-task`, operationKey: `${key}-operation`,
    filePlanResolver: () => (filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: policy.channel }],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: policy.channel }] })),
    execute: async (context, controls) => {
      batchContext = context;
      fs.writeFileSync(outputPath, `${key}-output`);
      await controls.settleArtifacts({ files: [...filePlan.inputs, ...filePlan.outputs].map((item) => ({ artifactKey: item.artifactKey })) });
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  const artifacts = service.repository.listArtifacts(batchContext.batchId);
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every((artifact) => artifact.status === 'ready'), JSON.stringify(artifacts.map((artifact) => ({ status: artifact.status, error: artifact.lastErrorCode, message: artifact.lastErrorMessage }))));
  return { key, sourcePath, outputPath, batchContext, artifacts,
    owner: { version: 1, kind: 'file-batch', batchContext } };
}

async function scenario(name, execute) {
  await execute();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function recoverPublicationAfterRestart(mode) {
  const isolatedDir = path.join(directory, mode);
  fs.mkdirSync(isolatedDir);
  const child = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../tests/fixtures/archive-permanent-delete-publication-child.js'), isolatedDir, mode
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, mode === 'crash-before-completion' ? 77 : 0, child.stderr || child.stdout);
  const owner = JSON.parse(fs.readFileSync(path.join(isolatedDir, 'owner.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(isolatedDir, 'publication-evidence.json'), 'utf8'));
  const userDataDir = path.join(isolatedDir, 'userdata');
  const indexPath = path.join(userDataDir, JOURNAL_INDEX_NAME);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries.length, 1,
    '完成凭证落盘前必须保留原发布记录供下个进程接管');
  const isolatedDb = new DatabaseSync(path.join(isolatedDir, 'archive.sqlite'));
  const isolatedService = createArchiveService({ database: isolatedDb, rootDir: path.join(isolatedDir, 'archive') });
  await isolatedService.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const isolatedOutbox = createArchiveOutboxStore(path.join(isolatedDir, 'outbox'));
  const isolatedController = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service: isolatedService, outboxStore: isolatedOutbox
  });
  try {
    assert.equal(isolatedService.repository.getOwnerTerminalCompletion(owner), null);
    assert.equal(isolatedOutbox.list().length, mode === 'vcc-nondurable' ? 1 : 0);
    const recovered = await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: isolatedController });
    assert.ok(recovered.recovered.some((item) => item.taskId === evidence.taskId && item.action === 'commit-cleanup'));
    assert.equal((await isolatedController.initialize()).ok, true);
    assert.equal(isolatedOutbox.list().length, 0);
    assert.equal(isolatedService.repository.getTaskRun(owner.batchContext.taskRunId).status, 'succeeded');
    assert.ok(isolatedService.repository.getOwnerTerminalCompletion(owner));
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries.length, 0);
    assert.deepEqual((await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: isolatedController })).recovered, []);
    const stat = fs.statSync(evidence.outputPath);
    assert.equal(String(stat.ino), evidence.ino, '恢复不得重新发布正式输出');
    assert.equal(stat.mtimeMs, evidence.mtimeMs);
    assert.equal(stat.size, evidence.size);
    assert.equal(fileHash(evidence.outputPath), evidence.sha256);
    const prepared = await isolatedController.prepareDeleteBatch(owner.batchContext.batchId);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const deleted = await isolatedController.deleteBatch(owner.batchContext.batchId, prepared.confirmationToken);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(isolatedService.repository.getBatch(owner.batchContext.batchId), null);
    assert.equal(fileHash(evidence.outputPath), evidence.sha256, '永久删除仅清理受管副本');
    assert.equal(fs.readFileSync(evidence.inputPath, 'utf8'), 'external-original-input');
  } finally {
    await isolatedService.pauseBackgroundMaterialization();
    isolatedDb.close();
  }
}

async function completedSharedBatch(key, content) {
  const outputPath = path.join(directory, `${key}.xlsx`);
  let batchContext;
  const policy = filePolicy();
  await lifecycleFor(key).runFileTask({ policy, meta: { channel: policy.channel },
    taskRunId: `${key}-task`, operationKey: `${key}-operation`,
    filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: policy.channel }] }),
    execute: async (context, controls) => {
      batchContext = context;
      fs.writeFileSync(outputPath, content);
      await controls.settleArtifacts({ files: [{ artifactKey: controls.fileEvidence.filePlan.outputs[0].artifactKey }] });
      return { status: 'success' };
    } });
  const artifacts = service.repository.listArtifacts(batchContext.batchId);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].status, 'ready');
  return { batchContext, artifact: artifacts[0], outputPath };
}

function useHistoricalHardlinks(artifacts) {
  const blob = artifacts[0].blob;
  const blobPath = path.join(archiveRoot, blob.relativePath);
  for (const artifact of artifacts) {
    assert.equal(artifact.blob.id, blob.id);
    const target = path.join(archiveRoot, artifact.storageRelativePath);
    fs.unlinkSync(target);
    fs.linkSync(blobPath, target);
  }
  const stat = fs.statSync(blobPath);
  for (const artifact of artifacts) {
    db.prepare(`UPDATE archive_artifacts SET storage_mode = 'hardlink',
      storage_fingerprint_size_bytes = ?, storage_fingerprint_mtime_ms = ?,
      storage_fingerprint_ctime_ms = ?, storage_fingerprint_ino = ? WHERE id = ?`)
      .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), artifact.id);
  }
  db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = ?, fingerprint_mtime_ms = ?,
    fingerprint_ctime_ms = ?, fingerprint_ino = ? WHERE id = ?`)
    .run(stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), blob.id);
  return blobPath;
}

async function retryHardlinkDeleteAfterOtherOwnerAccess(trigger) {
  const content = `historical-hardlink-${trigger}`;
  const a = await completedSharedBatch(`${trigger}-a`, content);
  const b = await completedSharedBatch(`${trigger}-b`, content);
  const blobPath = useHistoricalHardlinks([a.artifact, b.artifact]);
  const targetA = path.join(archiveRoot, a.artifact.storageRelativePath);
  const targetB = path.join(archiveRoot, b.artifact.storageRelativePath);
  const originalHash = fileHash(blobPath);
  const prepared = await controller.prepareDeleteBatch(a.batchContext.batchId);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  state.blocked = true;
  state.target = targetA;
  try {
    const pending = await controller.deleteBatch(a.batchContext.batchId, prepared.confirmationToken);
    assert.equal(pending.metadataDeleted, true);
    assert.equal(pending.fullyDeleted, false);
    assert.equal(fs.existsSync(targetA), true);
    if (trigger === 'read-other') {
      const read = await controller.openFile(b.artifact.id);
      assert.equal(read.status, 'success', JSON.stringify(read));
      const copies = service.repository.listOwnedTemporaryFiles(b.batchContext.batchId)
        .filter((item) => item.state === 'ready' && item.expectedIdentity.exists);
      assert.ok(copies.length > 0);
      assert.ok(copies.every((item) => fileHash(path.join(archiveRoot, item.managedRelativePath)) === originalHash));
    } else {
      const maintenance = await service.reconcileStartup();
      assert.ok(maintenance.consistency.failures.every((item) => [
        'EBUSY', 'ARCHIVE_DELETE_HARDLINKS_PENDING'
      ].includes(item.code)), JSON.stringify(maintenance));
    }
    assert.equal(fileHash(blobPath), originalHash);
    assert.equal(fileHash(targetB), originalHash);
    state.blocked = false;
    const retried = await controller.retryDeleteCleanupJob(pending.cleanupJobId);
    assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
    assert.equal(fs.existsSync(targetA), false);
    assert.equal(service.repository.getCleanupJobForBatch(a.batchContext.batchId), null);
    const other = await controller.openFile(b.artifact.id);
    assert.equal(other.status, 'success', JSON.stringify(other));
    assert.equal(fileHash((await service.resolveVerifiedArtifact(b.artifact.id)).filePath), originalHash);
    assert.equal(fileHash(b.outputPath), originalHash);
    const next = await controller.prepareDeleteBatch(b.batchContext.batchId);
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal((await controller.deleteBatch(b.batchContext.batchId, next.confirmationToken)).fullyDeleted, true);
  } finally {
    state.blocked = false;
    state.target = '';
  }
}

async function legacyBatchWithUnfingerprintedBlob(key) {
  const sourcePath = path.join(directory, `${key}.xlsx`);
  fs.writeFileSync(sourcePath, `legacy-${key}`);
  const result = await service.archiveFile({ moduleId: 'bank-statement', moduleCode: 'LEGACY', moduleName: '历史夹具',
    operationKey: key, filePath: sourcePath, role: 'output' });
  assert.equal(result.ok, true, JSON.stringify(result));
  // 还原历史 schema 合法状态；当前 archiveFile 入口会创建 TaskRun，升级不得现场补写旧归属。
  db.prepare('UPDATE archive_batches SET task_run_id = NULL WHERE id = ?').run(result.batch.id);
  assert.equal(db.prepare('SELECT task_run_id FROM archive_batches WHERE id = ?').get(result.batch.id).task_run_id, null);
  const artifact = service.repository.getArtifact(result.artifact.id);
  db.prepare(`UPDATE archive_blobs SET fingerprint_size_bytes = NULL, fingerprint_mtime_ms = NULL,
    fingerprint_ctime_ms = NULL, fingerprint_ino = NULL WHERE id = ?`).run(artifact.blob.id);
  return { batch: result.batch, artifact, sourcePath, blobPath: path.join(archiveRoot, artifact.blob.relativePath) };
}

(async () => {
  try {
    await openRuntime();
    let completed;
    await scenario('预检与取消不修改记录，确认后真实删除原件、输出及只读副本并保留外部文件', async () => {
      completed = await completedBatch('complete');
      const readonly = await service.openReadonlyCopy(completed.artifacts[0].id);
      assert.equal(readonly.ok, true);
      const savedPath = path.join(directory, 'user-saved.xlsx');
      assert.equal((await service.saveAs(completed.artifacts[0].id, savedPath)).ok, true);
      const storedPaths = completed.artifacts.flatMap((artifact) => [
        path.join(archiveRoot, artifact.storageRelativePath), path.join(archiveRoot, artifact.blob.relativePath)
      ]).concat(readonly.filePath);
      const before = db.prepare('SELECT COUNT(*) n FROM archive_cleanup_jobs').get().n;
      const cancelled = await controller.prepareDeleteBatch(completed.batchContext.batchId, { senderId: 101 });
      assert.equal(cancelled.ok, true);
      assert.ok(service.repository.getBatch(completed.batchContext.batchId));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_cleanup_jobs').get().n, before);
      assert.ok(storedPaths.every((filePath) => fs.existsSync(filePath)));
      const invalid = await controller.deleteBatch(completed.batchContext.batchId, cancelled.confirmationToken, { senderId: 202 });
      assert.equal(invalid.code, 'ARCHIVE_DELETE_CONFIRMATION_EXPIRED');
      const prepared = await controller.prepareDeleteBatch(completed.batchContext.batchId, { senderId: 101 });
      const deleted = await controller.deleteBatch(completed.batchContext.batchId, prepared.confirmationToken, { senderId: 101 });
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
      assert.ok(storedPaths.every((filePath) => !fs.existsSync(filePath)));
      assert.equal(fs.readFileSync(completed.sourcePath, 'utf8'), 'complete-input');
      assert.equal(fs.readFileSync(completed.outputPath, 'utf8'), 'complete-output');
      assert.equal(fs.readFileSync(savedPath, 'utf8'), 'complete-input');
      assert.equal(service.repository.getBatch(completed.batchContext.batchId), null);
      assert.equal((await controller.listDeleteCleanupJobs()).jobs.length, 0);
    });
    await scenario('已删 owner 迟到重复终态在重启时由收口证明安全 ACK，不复活批次', async () => {
      controller.persistTaskTerminalIntent({ owner: completed.owner, terminalOutcome: { taskStatus: 'succeeded' } });
      db.close();
      db = null;
      await openRuntime();
      assert.equal((await controller.initialize()).ok, true);
      assert.equal(outboxStore.list().length, 0);
      assert.equal(service.repository.getBatch(completed.batchContext.batchId), null);
    });
    await scenario('文件占用返回未完成并显示清理任务，重启后原任务重试完成', async () => {
      const batch = await completedBatch('busy');
      const readonly = await service.openReadonlyCopy(batch.artifacts[0].id);
      assert.equal(readonly.ok, true);
      const prepared = await controller.prepareDeleteBatch(batch.batchContext.batchId);
      state.blocked = true;
      const result = await controller.deleteBatch(batch.batchContext.batchId, prepared.confirmationToken);
      assert.equal(result.metadataDeleted, true);
      assert.equal(result.fullyDeleted, false);
      assert.equal(result.status, 'partial');
      assert.equal(service.repository.getBatch(batch.batchContext.batchId), null);
      assert.equal((await controller.listDeleteCleanupJobs()).jobs[0].cleanupJobId, result.cleanupJobId);
      assert.equal(fs.existsSync(readonly.filePath), true);
      db.close();
      db = null;
      state.blocked = false;
      await openRuntime();
      assert.equal((await controller.listDeleteCleanupJobs()).jobs.length, 1);
      const retried = await controller.retryDeleteCleanupJob(result.cleanupJobId);
      assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
      assert.equal(fs.existsSync(readonly.filePath), false);
      assert.equal((await controller.listDeleteCleanupJobs()).jobs.length, 0);
      assert.equal(fs.readFileSync(batch.sourcePath, 'utf8'), 'busy-input');
    });
    await scenario('预检后新增终态通知使确认失效，原任务收口后可重新确认', async () => {
      const batch = await completedBatch('pending');
      const prepared = await controller.prepareDeleteBatch(batch.batchContext.batchId);
      controller.persistTaskTerminalIntent({ owner: batch.owner, terminalOutcome: { taskStatus: 'succeeded' } });
      const rejected = await controller.deleteBatch(batch.batchContext.batchId, prepared.confirmationToken);
      assert.equal(rejected.code, 'ARCHIVE_DELETE_OWNER_PENDING');
      assert.ok(service.repository.getBatch(batch.batchContext.batchId));
      assert.equal(outboxStore.list().length, 1);
      assert.equal((await controller.flushOutbox()).remaining, 0);
      const refreshed = await controller.prepareDeleteBatch(batch.batchContext.batchId);
      assert.equal((await controller.deleteBatch(batch.batchContext.batchId, refreshed.confirmationToken)).fullyDeleted, true);
    });
    await scenario('失败输出的预分配路径出现未知文件时，完整删除入口保留批次和文件', async () => {
      const outputPath = path.join(directory, 'partial-output.xlsx');
      const missingPath = path.join(directory, 'unproduced-output.xlsx');
      const policy = filePolicy('failed');
      let batchContext;
      await lifecycleFor('partial').runFileTask({
        policy, meta: { channel: policy.channel }, taskRunId: 'partial-task', operationKey: 'partial-operation',
        filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
          outputs: [outputPath, missingPath].map((filePath) => ({ filePath, role: 'output', sourceOperation: policy.channel })) }),
        execute: async (context, controls) => {
          batchContext = context;
          fs.writeFileSync(outputPath, 'valid-output');
          await controls.settleArtifacts({ files: [{ artifactKey: controls.fileEvidence.filePlan.outputs[0].artifactKey }] });
          return { status: 'error', message: '第二份输出未生成' };
        }
      });
      const artifacts = service.repository.listArtifacts(batchContext.batchId);
      const failed = artifacts.find((artifact) => artifact.status === 'failed');
      assert.ok(failed.storageRelativePath);
      assert.equal(failed.blob, null);
      assert.equal(failed.storageFingerprint, null);
      const unknownPath = path.join(archiveRoot, failed.storageRelativePath);
      fs.mkdirSync(path.dirname(unknownPath), { recursive: true });
      fs.writeFileSync(unknownPath, 'unrelated-file');
      const prepared = await controller.prepareDeleteBatch(batchContext.batchId);
      assert.notEqual(prepared.ok, true);
      assert.ok(prepared.code, '拒绝原因应可诊断');
      assert.ok(service.repository.getBatch(batchContext.batchId));
      assert.equal(service.repository.getCleanupJobForBatch(batchContext.batchId), null);
      assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'unrelated-file');
      fs.unlinkSync(unknownPath);
      const safe = await controller.prepareDeleteBatch(batchContext.batchId);
      assert.equal(safe.ok, true, JSON.stringify(safe));
      assert.equal((await controller.deleteBatch(batchContext.batchId, safe.confirmationToken)).fullyDeleted, true);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), 'valid-output');
    });
    await scenario('工具箱发布恢复完成原任务与后处理后，可通过统一入口永久删除', async () => {
      const key = 'publication-recovery';
      const sourcePath = path.join(directory, `${key}.xlsx`);
      fs.writeFileSync(sourcePath, 'recovered-publication-input');
      const { artifactManifestFromFilePlan } = require('../../src/main-process/archive-center/file-plan');
      const task = (await service.beginTaskRun({ taskRunId: `${key}-task`, moduleId: 'toolbox',
        taskKey: 'toolbox:merge', operationKey: `${key}-operation`, parentRunId: `${key}-parent` })).taskRun;
      const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: 'toolbox:merge' }], outputs: [] }));
      const reserved = await service.reserveFileTaskBatch({ taskRun: task, manifest, moduleCode: 'TOOL', moduleName: '工具箱' });
      const batchContext = { batchId: reserved.batch.id, batchNumber: reserved.batch.batchNumber,
        taskRunId: task.taskRunId, taskKey: task.taskKey, moduleId: task.moduleId,
        parentRunId: task.parentRunId, operationKey: task.operationKey };
      await service.startFileTask(task.taskRunId, reserved.batch.id);
      let acknowledged = false;
      const item = { action: 'commit-handoff-pending', taskId: key, batchContext,
        inputFiles: [{ filePath: sourcePath }], files: [] };
      const recovery = await recoverToolboxPublicationsIntoArchive({ userDataDir: directory,
        archiveCenter: controller, recoverPublications: async (options) => {
          if (options.acknowledgedCommittedTaskIds) {
            if (options.deferCommittedFinalization) {
              return { recovered: [{ taskId: key, action: 'commit-finalization-pending' }] };
            }
            acknowledged = true;
            return { recovered: [{ taskId: key, action: 'commit-cleanup' }] };
          }
          return { recovered: acknowledged ? [] : [item] };
        } });
      assert.equal(recovery.recovered[0].action, 'commit-cleanup');
      assert.equal(acknowledged, true);
      assert.ok(service.repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext }));
      const prepared = await controller.prepareDeleteBatch(batchContext.batchId);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      assert.equal((await controller.deleteBatch(batchContext.batchId, prepared.confirmationToken)).fullyDeleted, true);
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'recovered-publication-input');
    });
    await scenario('入口维护持有自身 lease 时可完成到期清理和后续阶段', async () => {
      const root = path.join(directory, 'retention-runtime');
      fs.mkdirSync(root);
      const retentionDb = new DatabaseSync(path.join(root, 'archive.sqlite'));
      retentionDb.exec('CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT NOT NULL)');
      const database = { db: retentionDb,
        getSetting: (key) => retentionDb.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?').get(key)?.setting_value || null,
        setSetting: (key, value) => retentionDb.prepare('INSERT OR REPLACE INTO app_settings VALUES(?,?,?)').run(key, value, new Date().toISOString()) };
      const repository = createArchiveRepository(retentionDb);
      repository.ensureSchema();
      const runtime = createArchiveRuntimeDelegate({ repository, rootDir: path.join(root, 'archive') });
      let retentionController;
      const manager = createArchiveStorageRootManager({ database, repository, runtimeDelegate: runtime,
        defaultRoot: runtime.rootDir, journalPath: path.join(root, 'migration.json'), blockedRoots: [],
        createService(rootDir) {
          const current = createArchiveService({ database: retentionDb, rootDir, now: () => new Date('2026-01-01T12:00:00Z') });
          current.runDeleteWithOwnerGuard = (batchId, operation, options) => retentionController.runDeleteWithOwnerGuard(batchId, operation, options);
          return current;
        } });
      try {
        await manager.initialize();
        retentionController = createArchiveCenterController({ database, service: runtime, storageRootManager: manager });
        const inputPath = path.join(root, 'input.xlsx');
        fs.writeFileSync(inputPath, 'retention-input');
        const retentionLifecycle = createTaskLifecycle({ archiveService: runtime,
          businessOperationRegistry: { begin: () => ({ accepted: true, token: 'retention' }), end() {} },
          flowResolver: { resolve: async () => ({ parentRunId: 'retention-parent', source: 'new', identity: null }),
            bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
          operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
          persistTerminalIntent: (payload) => retentionController.persistTaskTerminalIntent(payload) });
        let batchId;
        const policy = filePolicy();
        await retentionLifecycle.runFileTask({ policy, taskRunId: 'retention-task', operationKey: 'retention',
          meta: { channel: policy.channel },
          filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
            inputs: [{ filePath: inputPath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
          execute: async (context) => { batchId = context.batchId; return { status: 'success' }; } });
        await runtime.setLocked(batchId, false);
        repository.setRetentionUntil(batchId, '2026-01-01');
        manager.currentService.now = () => new Date('2026-09-11T12:00:00Z');
        retentionController.startupVccGateSucceeded = true;
        const maintenance = await retentionController._runEntryMaintenance('integration-retention');
        assert.equal(maintenance.ok, true, JSON.stringify(maintenance));
        assert.equal(repository.getBatch(batchId), null);
        assert.equal(fs.readFileSync(inputPath, 'utf8'), 'retention-input');
        assert.equal(manager.isMaintenanceRequested(), false);
      } finally {
        await manager.pauseBackgroundOwnershipScan();
        if (manager.currentService) await manager.currentService.pauseBackgroundMaterialization();
        retentionDb.close();
      }
    });
    await scenario('真实 VCC 发布归档暂时失败，跨进程恢复后 outbox 清空并可初始化及永久删除', async () => {
      await recoverPublicationAfterRestart('vcc-nondurable');
    });
    await scenario('正常工具箱收尾在完成凭证前退出，原发布记录跨进程收口且不重发布', async () => {
      await recoverPublicationAfterRestart('crash-before-completion');
    });
    await scenario('BizOP 正式导出 ACK 临时失败，原 owner 恢复后 outbox 清空并完成初始化', async () => {
      await verifyBizOpOwnerRecovery(directory, 'ack-failure');
    });
    await scenario('BizOP ACK 后完成凭证前进程退出，重启沿原输出身份完成收口', async () => {
      await verifyBizOpOwnerRecovery(directory, 'after-ack-crash');
    });
    await scenario('BizOP 旧 binding 的业务恢复已关闭，仍可由原发布事实补齐完成凭证', async () => {
      await verifyBizOpOwnerRecovery(directory, 'closed-legacy-binding');
    });
    await scenario('BizOP 未提交导出首次终态落库失败，原补偿完成后可重启及永久删除', async () => {
      await verifyBizOpOwnerRecovery(directory, 'failed-terminal-write');
    });
    await scenario('BizOP 已关闭的未提交导出缺少完成凭证，沿原补偿事实恢复收口', async () => {
      await verifyBizOpOwnerRecovery(directory, 'closed-compensated');
    });
    await scenario('BizOP 大量历史导出分批补齐凭证，重启续跑且真实未决任务继续受保护', async () => {
      await verifyBizOpHistoricalOwnerBackfill(directory);
    });
    await scenario('Position 流式导入及账户确认共享来源，先保留共享副本再由最后批次清理', async () => {
      await verifyPositionFilePlanDeletion(directory, { engine: 'streaming' });
    });
    await scenario('Position 来源已正常回收，重启后逆序删除两个原批次不会互锁', async () => {
      await verifyPositionFilePlanDeletion(directory, { engine: 'streaming', sourceMissing: true, reverse: true, restart: true });
    });
    await scenario('Position 默认导入路径持久保存来源证据，重启后完成受管删除并保留外部原件', async () => {
      await verifyPositionFilePlanDeletion(directory, { restart: true });
    });
    await scenario('Position 过滤报告仍被业务使用时禁止删除，解除引用后清理原受管报告', async () => {
      await verifyPositionFilePlanDeletion(directory, { engine: 'streaming', anomalyReport: true });
    });
    await scenario('Position 过滤报告经 Main 正常清理，重启后按原归属完成批次删除', async () => {
      await verifyPositionFilePlanDeletion(directory, {
        engine: 'streaming', anomalyReport: true, sourceMissing: true, restart: true
      });
    });
    await scenario('普通模板导入执行中退出，重启按原任务身份收口并允许预检和到期删除', async () => {
      await verifyOrdinaryOwnerRecovery(directory, 'running');
    });
    await scenario('普通模板导入终态后退出，重启恢复原完成凭证并通过确认删除', async () => {
      await verifyOrdinaryOwnerRecovery(directory, 'after-terminal');
    });
    await scenario('匿名后处理尚未执行时退出，普通任务恢复不得伪造后处理完成', async () => {
      await verifyOrdinaryOwnerRecovery(directory, 'anonymous-after-terminal');
    });
    await scenario('普通任务责任写入事务中退出，批次和 manifest 回滚且业务尚未执行', async () => {
      await verifyOrdinaryOwnerRecovery(directory, 'reserve-transaction');
    });
    await scenario('原硬链接目录删除失败后同 SHA 新 Blob 发布，原任务重试可收口并保留新批次', async () => {
      await verifyHardlinkRepublishRemainder(directory);
    });
    await scenario('原硬链接残项与同 SHA 新 Blob 跨重启恢复，原任务收口且新批次可读', async () => {
      await verifyHardlinkRepublishRemainder(directory, true);
    });
    await scenario('历史共享硬链接删除占用期间读取另一批次，解除占用后原任务可重试完成', async () => {
      await retryHardlinkDeleteAfterOtherOwnerAccess('read-other');
    });
    await scenario('历史共享硬链接删除占用期间进行维护，解除占用后原任务可重试完成', async () => {
      await retryHardlinkDeleteAfterOtherOwnerAccess('maintenance');
    });
    await scenario('旧 Blob 没有持久指纹且被同 SHA 新 inode 替换时，永久删除拒绝且保留对象', async () => {
      const legacy = await legacyBatchWithUnfingerprintedBlob('replaced-blob');
      const originalInode = String(fs.statSync(legacy.blobPath).ino);
      const originalHash = fileHash(legacy.blobPath);
      const replacementPath = path.join(directory, 'replacement-blob');
      fs.copyFileSync(legacy.blobPath, replacementPath);
      fs.renameSync(replacementPath, legacy.blobPath);
      assert.notEqual(String(fs.statSync(legacy.blobPath).ino), originalInode);
      assert.equal(fileHash(legacy.blobPath), originalHash);
      const prepared = await controller.prepareDeleteBatch(legacy.batch.id);
      assert.equal(prepared.status, 'failed', JSON.stringify(prepared));
      assert.equal(prepared.code, 'ARCHIVE_DELETE_OWNER_IDENTITY_MISSING');
      assert.ok(service.repository.getBatch(legacy.batch.id));
      assert.equal(service.repository.getCleanupJobForBatch(legacy.batch.id), null);
      assert.equal(fileHash(legacy.blobPath), originalHash);
      assert.equal(fileHash(legacy.sourcePath), originalHash);
    });
    await scenario('旧 Blob 缺少指纹且受管文件已缺失时，保留原外部文件并幂等完成删除', async () => {
      const legacy = await legacyBatchWithUnfingerprintedBlob('missing-blob');
      const originalHash = fileHash(legacy.sourcePath);
      fs.unlinkSync(legacy.blobPath);
      fs.unlinkSync(path.join(archiveRoot, legacy.artifact.storageRelativePath));
      const prepared = await controller.prepareDeleteBatch(legacy.batch.id);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const deleted = await controller.deleteBatch(legacy.batch.id, prepared.confirmationToken);
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
      assert.equal(service.repository.getBatch(legacy.batch.id), null);
      assert.equal(service.repository.getCleanupJobForBatch(legacy.batch.id), null);
      assert.equal(fileHash(legacy.sourcePath), originalHash);
    });
    await scenario('只读副本保持创建身份，关闭创建句柄后打开，重启后确认删除保留外部原件', async () => {
      await verifyReadonlyOwnerIdentity(directory);
    });
    for (const replacement of READONLY_OWNER_REPLACEMENTS) {
      await scenario(`只读副本 ${replacement} 替换不被登记为所有者，跨进程恢复保留文件并拒绝删除`, async () => {
        await verifyReadonlyOwnerIdentity(directory, { replacement });
      });
    }
    await scenario('只读副本源流失败后释放创建句柄，不重复关闭其他文件已复用的 fd', async () => {
      await verifyReadonlyOwnerIdentity(directory, { readFailure: true });
    });
    await scenario('正常迁移保持原目标身份，真实任务经确认令牌完成永久删除', async () => {
      await verifyMigrationTargetIdentity(directory, { replacement: null, restart: true });
    });
    for (const replacement of ['canonical', 'materialized']) {
      await scenario(`迁移提交前 ${replacement} 目标发生同内容替换，重启后保留两根及原恢复凭证`, async () => {
        await verifyMigrationTargetIdentity(directory, { replacement, restart: true });
      });
    }
    await scenario('迁移提交后旧根清理中断，原发布身份可恢复完成两根关联删除', async () => {
      await verifyMigrationDeleteOverlap(directory);
    });
    for (const replacement of ['same', 'different']) {
      await scenario(`迁移后目标被 ${replacement} 内容的新 inode 替换时，保留两根文件与清理凭证`, async () => {
        await verifyMigrationDeleteOverlap(directory, { replacement });
      });
      await scenario(`旧 path-only 迁移与删除交叠遇 ${replacement} 内容替代对象，资格核验前不删任何原件`, async () => {
        await verifyMigrationDeleteOverlap(directory, { replacement, legacyJournal: true, legacyJob: true });
      });
    }
    await scenario('旧 path-only 迁移与删除交叠的现存文件缺少原身份时，保留两根等待诊断', async () => {
      await verifyMigrationDeleteOverlap(directory, { legacyJournal: true, legacyJob: true });
    });
    await scenario('旧迁移没有发布身份但删除计划身份完整时，仍须保留两根现存文件', async () => {
      await verifyMigrationDeleteOverlap(directory, { legacyJournal: true });
    });
    await scenario('旧迁移身份缺失但两根目标均已安全缺失时，有原身份的删除计划可幂等完成', async () => {
      await verifyMigrationDeleteOverlap(directory, { legacyJournal: true, alreadyMissing: true });
    });
    await scenario('旧迁移与 V1 删除计划同时缺证，即使目标已缺失仍保留任务诊断', async () => {
      await verifyMigrationDeleteOverlap(directory, { legacyJournal: true, legacyJob: true, alreadyMissing: true });
    });
    await scenario('归档延期时未执行的匿名后处理不会被恢复流程认证完成或放行删除', async () => {
      const sourcePath = path.join(directory, 'nondurable.xlsx');
      fs.writeFileSync(sourcePath, 'nondurable-input');
      const settle = service.settleManifestArtifacts.bind(service);
      let failOnce = true;
      service.settleManifestArtifacts = async (...args) => {
        if (failOnce) { failOnce = false; return { ok: false, durable: false, code: 'EACCES' }; }
        return settle(...args);
      };
      let batchContext;
      let afterTerminalCalls = 0;
      const policy = filePolicy();
      try {
        await lifecycleFor('nondurable').runFileTask({ policy, meta: { channel: policy.channel },
          taskRunId: 'nondurable-task', operationKey: 'nondurable-operation',
          filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
            inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
          afterTerminal: async () => { afterTerminalCalls += 1; },
          execute: async (context) => { batchContext = context; return { status: 'success' }; }
        });
      } finally { service.settleManifestArtifacts = settle; }
      assert.equal(afterTerminalCalls, 0);
      assert.equal((await controller.flushOutbox()).remaining, 1);
      assert.equal(service.repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext }), null);
      assert.equal((await controller.prepareDeleteBatch(batchContext.batchId)).code, 'ARCHIVE_DELETE_OWNER_PENDING');
      assert.ok(service.repository.getBatch(batchContext.batchId));
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'nondurable-input');
    });
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error}\n`);
  } finally {
    if (db) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`==== ${passed}/${total} PASS ====\n`);
  }
})();
