'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../../../..');
const from = (p) => require(path.join(root, p));
const { createArchiveService } = from('src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = from('src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = from('src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = from('src/main-process/archive-center/task-lifecycle');
const { normalizeFilePlanV1 } = from('src/main-process/archive-center/file-plan');
const { createTaskPolicyRegistry } = from('src/main-process/archive-center/task-policy-registry');
const { createArchiveRuntimeDelegate } = from('src/main-process/archive-center/archive-runtime-delegate');
const { createArchiveStorageRootManager } = from('src/main-process/archive-center/storage-root-manager');
const { resolveRetentionDays, setModuleRetentionDays } = from('src/main-process/archive-center/retention-policy');
let passed = 0;
async function fixture() {
  const base = fs.mkdtempSync(path.join(__dirname, 'data-'));
  const f = { base, archive: path.join(base, 'archive'), dbPath: path.join(base, 'db.sqlite'), seq: 0, blocked: new Set() };
  f.fs = { ...fs, promises: fs.promises, unlinkSync(file) {
    if (f.blocked.has(file)) throw Object.assign(new Error('review-probe-busy'), { code: 'EBUSY' });
    return fs.unlinkSync(file);
  } };
  f.open = async () => {
    f.db = new DatabaseSync(f.dbPath); f.db.exec('PRAGMA foreign_keys=ON');
    f.database = {
      db: f.db,
      getSetting: (key) => f.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?').get(key)?.setting_value ?? null,
      setSetting: (key, value) => f.db.prepare(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES(?,?,?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`).run(key, value, new Date().toISOString())
    };
    f.factory = (rootDir) => createArchiveService({ database: f.db, rootDir, fsImpl: f.fs,
      now: () => new Date(2026, 0, 15, 12), resolveRetentionDays: (moduleId) => resolveRetentionDays(f.database, moduleId) });
    f.service = f.factory(f.archive);
    assert.equal((await f.service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    f.outbox = createArchiveOutboxStore(path.join(base, 'outbox'));
    f.center = createArchiveCenterController({ database: f.database, service: f.service, outboxStore: f.outbox });
    f.bindLifecycle();
  };
  f.bindLifecycle = () => {
    f.lifecycle = createTaskLifecycle({ archiveService: f.service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'review' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'review-flow', source: 'new', identity: null }), bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (payload) => f.center.persistTaskTerminalIntent(payload) });
  };
  f.make = async (content = 'review-managed-bytes') => {
    const id = ++f.seq; const source = path.join(base, `external-${id}.csv`); fs.writeFileSync(source, content);
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: source, role: 'input', sourceOperation: 'file:import' }], outputs: [] });
    let context;
    const result = await f.lifecycle.runFileTask({ policy: createTaskPolicyRegistry().require('file:import'),
      taskRunId: `review-task-${id}`, operationKey: `review-operation-${id}`, filePlanResolver: () => filePlan,
      execute: async (value, controls) => { context = value;
        const settled = await controls.settleArtifacts({ files: filePlan.inputs.map((item) => ({ artifactKey: item.artifactKey })) });
        assert.equal(settled.ok, true, JSON.stringify(settled));
        return { status: 'success' };
      } });
    assert.equal(result.status, 'success');
    const artifact = f.service.repository.listArtifacts(context.batchId)[0];
    const owner = { version: 1, kind: 'file-batch', batchContext: context };
    assert.ok(f.service.repository.getOwnerTerminalCompletion(owner));
    return { source, context, owner, artifact,
      materialized: path.join(f.archive, artifact.storageRelativePath), blob: path.join(f.archive, artifact.blob.relativePath) };
  };
  f.confirm = async (batch) => {
    const p = await f.center.prepareDeleteBatch(batch.context.batchId, { senderId: 7 });
    assert.equal(p.ok, true, JSON.stringify(p));
    return f.center.deleteBatch(batch.context.batchId, p.confirmationToken, { senderId: 7 });
  };
  f.close = async () => { await f.service.pauseBackgroundMaterialization(); f.db.close(); fs.rmSync(base, { recursive: true, force: true }); };
  await f.open(); return f;
}
async function scenario(label, run) { const f = await fixture(); try { await run(f); passed += 1; console.log(`PASS ${label}`); } finally { await f.close(); } }
async function main() {
  await scenario('有效确认绑定原窗口，错误窗口不得删除；随后正常确认保留外部原件', async (f) => {
    const b = await f.make(); const p = await f.center.prepareDeleteBatch(b.context.batchId, { senderId: 7 });
    const invalid = await f.center.deleteBatch(b.context.batchId, p.confirmationToken, { senderId: 8 });
    assert.equal(invalid.code, 'ARCHIVE_DELETE_CONFIRMATION_EXPIRED'); assert.ok(fs.existsSync(b.blob));
    const result = await f.center.deleteBatch(b.context.batchId, p.confirmationToken, { senderId: 7 });
    assert.equal(result.fullyDeleted, true); assert.equal(fs.readFileSync(b.source, 'utf8'), 'review-managed-bytes');
  });
  await scenario('预检后同内容替代目录文件拒绝认领，元数据及替代文件保持', async (f) => {
    const b = await f.make(); const p = await f.center.prepareDeleteBatch(b.context.batchId, { senderId: 7 });
    fs.renameSync(b.materialized, `${b.materialized}.held`); fs.writeFileSync(b.materialized, 'review-managed-bytes');
    const result = await f.center.deleteBatch(b.context.batchId, p.confirmationToken, { senderId: 7 });
    assert.equal(result.code, 'ARCHIVE_DELETE_FILE_CHANGED'); assert.ok(f.service.repository.getBatch(b.context.batchId));
    assert.equal(fs.readFileSync(b.materialized, 'utf8'), 'review-managed-bytes');
  });
  await scenario('预检后新增只读副本使确认失效，新预检完整删除副本与原受管文件', async (f) => {
    const b = await f.make(); const p = await f.center.prepareDeleteBatch(b.context.batchId, { senderId: 7 });
    const opened = await f.service.openReadonlyCopy(b.artifact.id); assert.equal(opened.ok, true);
    const temps = f.service.repository.listOwnedTemporaryFiles(b.context.batchId).map((item) => path.join(f.archive, item.managedRelativePath));
    const stale = await f.center.deleteBatch(b.context.batchId, p.confirmationToken, { senderId: 7 });
    assert.equal(stale.code, 'ARCHIVE_DELETE_CONFIRMATION_STALE'); assert.ok(fs.existsSync(b.materialized));
    assert.equal((await f.confirm(b)).fullyDeleted, true); assert.ok(temps.every((file) => !fs.existsSync(file)));
    assert.equal(fs.readFileSync(b.source, 'utf8'), 'review-managed-bytes');
  });
  await scenario('部分删除后新批次引用同内容，旧计划重试保留新批次并允许最终独占删除', async (f) => {
    const a = await f.make(); f.blocked.add(a.materialized);
    const partial = await f.confirm(a); assert.equal(partial.metadataDeleted, true); assert.equal(partial.fullyDeleted, false);
    f.blocked.clear(); const b = await f.make();
    const retried = await f.center.retryDeleteCleanupJob(partial.cleanupJobId); assert.equal(retried.fullyDeleted, true, JSON.stringify(retried));
    assert.equal(fs.readFileSync(b.materialized, 'utf8'), 'review-managed-bytes'); assert.equal(fs.readFileSync(b.blob, 'utf8'), 'review-managed-bytes');
    assert.equal((await f.confirm(b)).fullyDeleted, true); assert.ok(!fs.existsSync(a.blob));
  });
  await scenario('部分删除后替代文件跨SQLite重开仍受原计划保护', async (f) => {
    const b = await f.make(); f.blocked.add(b.materialized);
    const partial = await f.confirm(b); assert.equal(partial.fullyDeleted, false); assert.equal(partial.metadataDeleted, true);
    f.blocked.clear(); fs.renameSync(b.materialized, `${b.materialized}.held`); fs.writeFileSync(b.materialized, 'review-managed-bytes');
    await f.service.pauseBackgroundMaterialization(); f.db.close(); await f.open();
    const result = await f.center.retryDeleteCleanupJob(partial.cleanupJobId);
    assert.equal(result.fullyDeleted, false); assert.ok(result.failures.some((x) => x.code === 'ARCHIVE_DELETE_FILE_CHANGED'));
    assert.equal(fs.readFileSync(b.materialized, 'utf8'), 'review-managed-bytes'); assert.equal(fs.readFileSync(b.source, 'utf8'), 'review-managed-bytes');
    assert.ok(f.service.repository.getCleanupJob(partial.cleanupJobId));
  });
  await scenario('Main同款manager/delegate转发维护owner token，新期限不追溯既有快照', async (f) => {
    setModuleRetentionDays(f.database, { moduleId: 'statement-generator', retentionDays: 30 });
    const a = await f.make('expired');
    setModuleRetentionDays(f.database, { moduleId: 'statement-generator', retentionDays: null });
    const b = await f.make('permanent');
    assert.equal(f.service.repository.getBatch(a.context.batchId).retentionUntil, '2026-02-14');
    assert.equal(f.service.repository.getBatch(b.context.batchId).retentionUntil, null);
    const runtime = createArchiveRuntimeDelegate({ service: f.service });
    const factory = (rootDir) => { const service = f.factory(rootDir);
      service.runDeleteWithOwnerGuard = (batchId, operation, options) => f.center.runDeleteWithOwnerGuard(batchId, operation, options); return service; };
    const manager = createArchiveStorageRootManager({ database: f.database, repository: f.service.repository,
      runtimeDelegate: runtime, createService: factory, defaultRoot: f.archive,
      journalPath: path.join(f.base, 'migration.json'), blockedRoots: [], deferStartupRecovery: true });
    f.center = createArchiveCenterController({ database: f.database, service: runtime, storageRootManager: manager, outboxStore: f.outbox });
    assert.equal((await manager.initialize()).available, true); f.service = runtime.service;
    const lease = await manager.beginEntryMaintenance(); assert.equal(lease.acquired, true);
    try {
      const forged = await f.service.runRetentionMaintenance({ asOfLocalDate: '2026-03-01', ownerToken: 'wrong' });
      assert.equal(forged.ok, false); assert.equal(forged.code, 'ARCHIVE_STORAGE_MAINTENANCE');
      const clean = await f.service.runRetentionMaintenance({ asOfLocalDate: '2026-03-01', ownerToken: lease.ownerToken });
      assert.equal(clean.ok, true, JSON.stringify(clean)); assert.equal(f.service.repository.getBatch(a.context.batchId), null);
      assert.ok(f.service.repository.getBatch(b.context.batchId)); assert.equal(fs.readFileSync(a.source, 'utf8'), 'expired');
    } finally { await manager.endEntryMaintenance(lease.ownerToken); }
  });
  console.log(JSON.stringify({ passed, total: 6 }));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
