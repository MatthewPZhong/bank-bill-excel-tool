// 设置新默认值的真实 SQLite / 文件集成验证；所有读写均位于临时目录。
// 用法：node scripts/integration/archive-center-default-retention.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const settingsRepository = require('../../src/backend/database/settings-repository');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { ARCHIVE_RETENTION_SETTING_KEY, resolveRetentionDays } = require('../../src/main-process/archive-center/retention-policy');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../src/main-process/archive-center/file-plan');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createBusinessFlowResolver } = require('../../src/main-process/archive-center/business-flow-resolver');
const { createArchiveOperationTracker } = require('../../src/main-process/archive-center/operation-tracker');
const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');

const entries = ['createBatch', 'reserveTaskBatch', 'reserveFileTaskBatch'];
const cases = [];
const scenario = (label, run) => cases.push({ label, run });
const expiry = (days) => {
  if (days === null) return null;
  const date = new Date(Date.UTC(2026, 0, 15 + days));
  return date.toISOString().slice(0, 10);
};

async function fixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-default-retention-'));
  const f = {
    tempDir, rootDir: path.join(tempDir, 'archive'), sequence: 0,
    serviceOptions: {}, useResolver: false,
    now: () => new Date(2026, 0, 15, 12),
    nextKey() { return `defaults-${++this.sequence}`; },
    files() {
      return ['input', 'output'].map((role) => {
        const content = `${this.nextKey()},${role}\n`;
        const filePath = path.join(tempDir, `${this.nextKey()}-${role}.csv`);
        fs.writeFileSync(filePath, content);
        return { filePath, role, direction: role, content };
      });
    },
    async open() {
      this.db = new DatabaseSync(path.join(tempDir, 'archive.sqlite'));
      this.db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS app_settings (
          setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL
        );`);
      this.database = {
        getSetting: (key) => settingsRepository.getSetting(this.db, key),
        setSetting: (key, value) => settingsRepository.setSetting(this.db, key, value)
      };
      this.service = createArchiveService({ database: this.db, rootDir: this.rootDir,
        now: this.now, ...this.serviceOptions,
        ...(this.useResolver ? { resolveRetentionDays: (id) => resolveRetentionDays(this.database, id) } : {})
      });
      this.repository = this.service.repository;
      assert.equal((await this.service.initialize({ startBackgroundMaterialization: false })).ok, true);
      this.outbox = createArchiveOutboxStore(path.join(tempDir, 'outbox'), { now: this.now });
      this.controller = createArchiveCenterController({ database: this.database,
        service: this.service, outboxStore: this.outbox });
      this.lifecycle = createTaskLifecycle({ archiveService: this.service,
        businessOperationRegistry: createBusinessOperationRegistry(),
        flowResolver: createBusinessFlowResolver({ archiveService: this.service }),
        operationTracker: createArchiveOperationTracker({ sink: this.controller.sink }) });
    },
    async restart() {
      await this.service.pauseBackgroundMaterialization();
      this.db.close();
      this.db = null;
      await this.open();
    },
    async close() {
      if (this.service) await this.service.pauseBackgroundMaterialization();
      if (this.db) this.db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
  try { await f.open(); return f; } catch (error) { await f.close(); throw error; }
}

function assertFiles(f, item) {
  const artifacts = f.repository.listArtifacts(item.batch.id);
  assert.equal(artifacts.length, 2);
  for (const source of item.files) {
    const artifact = artifacts.find((row) => row.direction === source.direction);
    assert.ok(artifact);
    assert.equal(artifact.status, 'ready');
    for (const relative of [artifact.blob.relativePath, artifact.storageRelativePath]) {
      assert.equal(fs.readFileSync(path.join(f.rootDir, relative), 'utf8'), source.content);
    }
    assert.equal(fs.readFileSync(source.filePath, 'utf8'), source.content);
  }
  return artifacts;
}

async function createAt(f, entry, override = {}) {
  const key = f.nextKey();
  const files = f.files();
  const payload = { moduleId: 'toolbox', moduleCode: 'TOOLBOX', moduleName: '工具箱',
    operationKey: key, taskKey: 'toolbox:merge', taskRunId: `task-${key}`,
    parentRunId: `parent-${key}`, sourceOperation: 'toolbox:merge', ...override };
  let replay;
  if (entry === 'createBatch') {
    replay = () => f.service.createBatch({ ...payload, files });
  } else if (entry === 'reserveTaskBatch') {
    replay = () => f.service.reserveTaskBatch(payload);
  } else {
    const begun = await f.service.beginTaskRun(payload);
    assert.equal(begun.ok, true);
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1, allocation: 'eager',
      inputs: [{ ...files[0], sourceOperation: payload.sourceOperation }],
      outputs: [{ ...files[1], sourceOperation: payload.sourceOperation }]
    }));
    replay = () => f.service.reserveFileTaskBatch({ ...payload, taskRun: begun.taskRun, manifest });
    payload.manifest = manifest;
  }
  const result = await replay();
  assert.equal(result.ok, true, `${entry}: ${JSON.stringify(result)}`);
  const batch = result.batch;
  if (entry === 'reserveTaskBatch') {
    assert.equal((await f.service.markTaskStarted(batch.id)).ok, true);
    assert.equal((await f.service.appendFiles({ batchId: batch.id, files })).ok, true);
    assert.equal((await f.service.completeTaskBatch(batch.id)).ok, true);
  } else if (entry === 'reserveFileTaskBatch') {
    const batchContext = { batchId: batch.id, batchNumber: batch.batchNumber,
      taskRunId: batch.taskRunId, taskKey: batch.taskKey, moduleId: batch.moduleId,
      parentRunId: batch.parentRunId, operationKey: batch.operationKey };
    assert.equal((await f.service.startFileTask(batch.taskRunId, batch.id)).ok, true);
    assert.equal((await f.service.settleManifestArtifacts({ batchContext,
      files: [...payload.manifest.inputs, ...payload.manifest.outputs].map(({ artifactKey }) => ({ artifactKey }))
    })).ok, true);
    // reserveFileTaskBatch 的幂等重入只允许 prepared/running；终态另由 completedTask 验证。
    assert.equal(f.repository.getTaskRun(batch.taskRunId).status, 'running');
  }
  const item = { batch: f.repository.getBatch(batch.id), files, replay };
  assertFiles(f, item);
  return item;
}

async function completedTask(f) {
  const files = f.files();
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ ...files[0], sourceOperation: 'toolbox:merge' }],
    outputs: [{ ...files[1], sourceOperation: 'toolbox:merge' }] });
  let context;
  const result = await f.lifecycle.runFileTask({
    policy: createTaskPolicyRegistry().require('toolbox:merge'), filePlanResolver: () => filePlan,
    resultClassifier: () => 'succeeded',
    execute: async (taskContext, controls) => {
      context = taskContext;
      assert.equal((await controls.settleArtifacts({ files: [...filePlan.inputs, ...filePlan.outputs]
        .map(({ artifactKey }) => ({ artifactKey })) })).ok, true);
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  assert.ok(f.repository.getOwnerTerminalCompletion({ version: 1, kind: 'file-batch', batchContext: context }));
  const item = { batch: f.repository.getBatch(context.batchId), files };
  item.artifacts = assertFiles(f, item);
  return item;
}

for (const [label, options, useResolver] of [
  ['无解析器且省略构造期限', {}, false],
  ['无解析器且构造期限 undefined', { defaultRetentionDays: undefined }, false],
  ['无解析器且构造期限 null', { defaultRetentionDays: null }, false],
  ['注入策略解析器且全局设置缺失', { defaultRetentionDays: 60 }, true]
]) {
  scenario(`${label}：三入口永久、重启幂等、不自动写入期限设置`, async (f) => {
    f.serviceOptions = options;
    f.useResolver = useResolver;
    await f.restart();
    const saved = f.db.prepare("SELECT * FROM app_settings WHERE setting_key LIKE 'archive_center_retention_days%' ORDER BY setting_key").all();
    const items = [];
    for (const entry of entries) {
      const item = await createAt(f, entry);
      assert.equal(item.batch.retentionUntil, null, entry);
      items.push(item);
    }
    await f.restart();
    for (const item of items) {
      const repeated = await item.replay();
      assert.equal(repeated.ok, true, JSON.stringify(repeated));
      assert.equal(repeated.batch.id, item.batch.id);
      assert.equal(repeated.batch.retentionUntil, null);
      assertFiles(f, item);
    }
    const cleanup = await f.service.cleanupExpired({ asOfLocalDate: '2127-01-01' });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.candidateCount, 0, '永久批次不进入到期候选，而非依赖删除保护拦截');
    for (const item of items) assertFiles(f, item);
    assert.deepEqual(f.db.prepare("SELECT * FROM app_settings WHERE setting_key LIKE 'archive_center_retention_days%' ORDER BY setting_key").all(), saved);
  });
}

scenario('有限构造期限 1 / 60 / 36500 / 字符串 60 保留，三入口显式永久优先', async (f) => {
  for (const days of [1, 60, 36500, '60']) {
    f.serviceOptions = { defaultRetentionDays: days };
    await f.restart();
    for (const entry of entries) {
      const finite = await createAt(f, entry);
      assert.equal(finite.batch.retentionUntil, expiry(Number(days)));
      const permanent = await createAt(f, entry, { retentionDays: null });
      assert.equal(permanent.batch.retentionUntil, null);
    }
  }
});

scenario('策略层永久/有限值优先于构造默认，三入口显式有限期限和永久最高优先', async (f) => {
  f.useResolver = true;
  f.serviceOptions = { defaultRetentionDays: 180 };
  await f.restart();
  for (const resolved of [null, 30]) {
    assert.equal(f.controller.setModuleRetentionDays({ moduleId: 'toolbox', retentionDays: resolved }).status, 'success');
    for (const entry of entries) {
      assert.equal((await createAt(f, entry)).batch.retentionUntil, expiry(resolved));
      for (const days of [90, null]) {
        assert.equal((await createAt(f, entry, { retentionDays: days })).batch.retentionUntil, expiry(days));
      }
    }
  }
});

scenario('缺失/空/坏值读取回退永久但不写回，旧全局 60 天跨重启原样保留', async (f) => {
  f.useResolver = true;
  await f.restart();
  for (const [raw, expected] of [[undefined, null], ['', null], ['broken', null], ['45', null], ['60', 60], ['permanent', null]]) {
    if (raw !== undefined) f.database.setSetting(ARCHIVE_RETENTION_SETTING_KEY, raw);
    const saved = f.db.prepare("SELECT * FROM app_settings WHERE setting_key LIKE 'archive_center_retention_days%' ORDER BY setting_key").all();
    await f.restart();
    assert.equal(f.controller.getRetentionDays(), expected);
    assert.deepEqual(f.controller.getSettings().settings.retentionDaysByModule, {});
    for (const entry of entries) assert.equal((await createAt(f, entry)).batch.retentionUntil, expiry(expected));
    assert.deepEqual(f.db.prepare("SELECT * FROM app_settings WHERE setting_key LIKE 'archive_center_retention_days%' ORDER BY setting_key").all(), saved);
  }
});

scenario('升级前有限批次及预留批次跨重启/幂等重入保留期限，新批次默认永久', async (f) => {
  f.serviceOptions = { defaultRetentionDays: 60 };
  await f.restart();
  const old = [];
  for (const entry of entries) old.push(await createAt(f, entry));
  const payload = { moduleId: 'toolbox', moduleCode: 'TOOLBOX', moduleName: '工具箱',
    taskKey: 'toolbox:merge', taskRunId: 'historical-reservation', operationKey: 'historical-reservation' };
  const reservation = await f.service.reserveTaskBatch(payload);
  assert.equal(reservation.ok, true);
  assert.equal(reservation.batch.retentionUntil, expiry(60));
  f.serviceOptions = {};
  await f.restart();
  for (const item of old) {
    const replayed = await item.replay();
    assert.equal(replayed.ok, true, JSON.stringify(replayed));
    assert.equal(replayed.batch.id, item.batch.id);
    assert.equal(replayed.batch.retentionUntil, expiry(60));
    assertFiles(f, item);
  }
  assert.equal((await f.service.reserveTaskBatch(payload)).batch.retentionUntil, expiry(60));
  for (const entry of entries) assert.equal((await createAt(f, entry)).batch.retentionUntil, null);
});

scenario('旧全局 60 天 outbox 快照在新默认永久下重启重放仍按 60 天建批', async (f) => {
  f.useResolver = true;
  await f.restart();
  f.database.setSetting(ARCHIVE_RETENTION_SETTING_KEY, '60');
  const payload = { moduleId: 'toolbox', moduleCode: 'TOOLBOX', moduleName: '工具箱',
    operationKey: f.nextKey(), sourceOperation: 'toolbox:merge', files: f.files() };
  const offline = `${f.rootDir}-offline`;
  fs.renameSync(f.rootDir, offline);
  fs.writeFileSync(f.rootDir, '模拟存档目录不可用');
  let record;
  try {
    const queued = await f.controller.createTrackedBatch(payload);
    assert.equal(queued.persistentRetryAvailable, true);
    record = f.outbox.findByOperationKey(payload.operationKey);
    assert.equal(record.payload.retentionDays, 60);
  } finally {
    fs.rmSync(f.rootDir);
    fs.renameSync(offline, f.rootDir);
  }
  f.db.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(ARCHIVE_RETENTION_SETTING_KEY);
  await f.restart();
  assert.equal(f.controller.getRetentionDays(), null);
  assert.equal(f.outbox.get(record.id).payload.retentionDays, 60);
  assert.equal((await f.controller.flushOutbox()).flushed, 1);
  const batch = f.repository.getBatchByOperationKey(payload.moduleId, payload.operationKey);
  assert.equal(batch.retentionUntil, expiry(60));
  assertFiles(f, { batch, files: payload.files });
});

scenario('真实输入/输出永久保留，有限批次仍到期清理并尊重锁定和 hold', async (f) => {
  f.serviceOptions = { defaultRetentionDays: 60 };
  await f.restart();
  const finite = await completedTask(f);
  const locked = await completedTask(f);
  const held = await completedTask(f);
  assert.equal((await f.service.setLocked(locked.batch.id, true)).ok, true);
  f.repository.addArtifactHold(held.artifacts[0].id, {
    ownerModule: 'toolbox', ownerType: 'defaults-integration', ownerId: f.nextKey(), reason: '回归引用保护'
  });
  f.serviceOptions = {};
  await f.restart();
  const permanent = await completedTask(f);
  assert.equal(permanent.batch.retentionUntil, null);
  const boundary = await f.service.cleanupExpired({ asOfLocalDate: expiry(60) });
  assert.equal(boundary.ok, true);
  assert.equal(boundary.candidateCount, 0);
  const cleaned = await f.service.cleanupExpired({ asOfLocalDate: '2027-01-01' });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
  assert.equal(cleaned.candidateCount, 1);
  assert.equal(cleaned.deletedBatchCount, 1);
  assert.equal(f.repository.getBatch(finite.batch.id), null);
  for (const artifact of finite.artifacts) {
    assert.equal(fs.existsSync(path.join(f.rootDir, artifact.blob.relativePath)), false);
    assert.equal(fs.existsSync(path.join(f.rootDir, artifact.storageRelativePath)), false);
  }
  for (const item of [permanent, locked, held]) {
    assert.equal(f.repository.getBatch(item.batch.id).retentionUntil, item.batch.retentionUntil);
    assertFiles(f, item);
  }
  assert.equal(f.repository.getBatch(locked.batch.id).locked, true);
  assert.equal(f.repository.listArtifactHolds(held.artifacts[0].id).length, 1);
  for (const source of finite.files) assert.equal(fs.readFileSync(source.filePath, 'utf8'), source.content);
});

async function run() {
  let passed = 0;
  for (const item of cases) {
    let f;
    try {
      f = await fixture();
      await item.run(f);
      passed += 1;
      console.log(`PASS ${item.label}`);
    } catch (error) {
      console.error(`FAIL ${item.label}\n${error.stack}`);
      process.exitCode = 1;
    } finally { if (f) await f.close(); }
  }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
