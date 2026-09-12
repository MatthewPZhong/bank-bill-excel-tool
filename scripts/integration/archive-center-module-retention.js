// 存档中心按模块保留期限集成验证（真实 SQLite、文件和 TaskLifecycle）
// 覆盖：设置保存/重启回读、全部可见模块、三个建批入口、永久/继承/显式期限，
//       已建批次与持久 outbox 快照、到期清理及锁定/业务引用保护。
// 用法：node scripts/integration/archive-center-module-retention.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const settingsRepository = require('../../src/backend/database/settings-repository');
const {
  createArchiveService
} = require('../../src/main-process/archive-center/archive-service');
const {
  ARCHIVE_RETENTION_SETTING_KEY,
  createArchiveCenterController
} = require('../../src/main-process/archive-center/controller');
const {
  resolveRetentionDays
} = require('../../src/main-process/archive-center/retention-policy');
const {
  listVisibleArchiveScopes
} = require('../../src/main-process/archive-center/module-scope-registry');
const {
  createArchiveOutboxStore
} = require('../../src/main-process/archive-center/outbox-store');
const {
  normalizeFilePlanV1,
  artifactManifestFromFilePlan
} = require('../../src/main-process/archive-center/file-plan');
const {
  createTaskLifecycle
} = require('../../src/main-process/archive-center/task-lifecycle');
const {
  createBusinessFlowResolver
} = require('../../src/main-process/archive-center/business-flow-resolver');
const {
  createArchiveOperationTracker
} = require('../../src/main-process/archive-center/operation-tracker');
const {
  createTaskPolicyRegistry
} = require('../../src/main-process/archive-center/task-policy-registry');
const {
  createBusinessOperationRegistry
} = require('../../src/main-process/business-operation-registry');

const LOCAL_DATE = '2026-01-15';
const SCOPES = listVisibleArchiveScopes();
const SCOPE_BY_ID = new Map(SCOPES.map((scope) => [scope.id, scope]));
const cases = [];

function scenario(label, execute) {
  cases.push({ label, execute });
}

function expectedExpiry(days) {
  if (days === null) return null;
  const date = new Date(`${LOCAL_DATE}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-module-retention-'));
  const fixture = {
    tempDir,
    dbPath: path.join(tempDir, 'archive.sqlite'),
    rootDir: path.join(tempDir, 'archive'),
    sourceDir: path.join(tempDir, 'sources'),
    outboxDir: path.join(tempDir, 'outbox'),
    sequence: 0,
    now: () => new Date(2026, 0, 15, 12, 0, 0),
    nextKey() { return `retention-${++this.sequence}`; },
    writeSource(label) {
      const filePath = path.join(this.sourceDir, `${this.nextKey()}.csv`);
      const content = `模块,验证内容\n${label},${path.basename(filePath)}\n`;
      fs.writeFileSync(filePath, content, 'utf8');
      return { filePath, content, direction: 'input', role: 'input' };
    },
    async open() {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS app_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.database = {
        getSetting: (key) => settingsRepository.getSetting(this.db, key),
        setSetting: (key, value) => settingsRepository.setSetting(this.db, key, value)
      };
      this.service = createArchiveService({
        database: this.db,
        rootDir: this.rootDir,
        now: this.now,
        resolveRetentionDays: (moduleId) => resolveRetentionDays(this.database, moduleId)
      });
      this.repository = this.service.repository;
      const initialized = await this.service.initialize({ startBackgroundMaterialization: false });
      assert.equal(initialized.ok, true, '临时存档服务初始化成功');
      this.outboxStore = createArchiveOutboxStore(this.outboxDir, { now: this.now });
      this.controller = createArchiveCenterController({
        database: this.database,
        service: this.service,
        outboxStore: this.outboxStore
      });
      this.lifecycle = createTaskLifecycle({
        businessOperationRegistry: createBusinessOperationRegistry(),
        archiveService: this.service,
        flowResolver: createBusinessFlowResolver({ archiveService: this.service }),
        operationTracker: createArchiveOperationTracker({ sink: this.controller.sink })
      });
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
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  };
  fs.mkdirSync(fixture.sourceDir);
  try {
    await fixture.open();
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

function setModule(fixture, moduleId, retentionDays) {
  const result = fixture.controller.setModuleRetentionDays({ moduleId, retentionDays });
  assert.equal(result.status, 'success', `保存 ${moduleId} 保留期限成功`);
}

function payloadFor(fixture, moduleId, overrides = {}) {
  const scope = SCOPE_BY_ID.get(moduleId);
  return {
    moduleId,
    moduleCode: scope.code,
    moduleName: scope.name,
    operationKey: fixture.nextKey(),
    sourceOperation: 'retention-integration',
    ...overrides
  };
}

async function createFileBatch(fixture, moduleId, overrides = {}) {
  const source = fixture.writeSource(moduleId);
  const payload = payloadFor(fixture, moduleId, { files: [source], ...overrides });
  const result = await fixture.service.createBatch(payload);
  assert.equal(result.ok, true, `真实 createBatch ${moduleId} 成功`);
  assert.ok(result.batch && result.batch.id, '批次身份已落库');
  const artifacts = fixture.repository.listArtifacts(result.batch.id);
  assert.equal(artifacts.length, 1, '真实文件登记为一个 artifact');
  assert.equal(artifacts[0].status, 'ready', '真实文件已归档');
  assert.equal(
    fs.readFileSync(path.join(fixture.rootDir, artifacts[0].blob.relativePath), 'utf8'),
    source.content,
    '归档 Blob 回读内容与源文件相同'
  );
  return { batch: result.batch, artifact: artifacts[0], source, payload };
}

scenario('旧全局设置兼容，14 个模块设置经 SQLite 关闭/重开保持一致', async (fixture) => {
  assert.equal(SCOPES.length, 14, '完整模块清单包含 13 个主模块和工具箱');
  assert.equal(fixture.controller.getRetentionDays(), 60);
  fixture.database.setSetting(ARCHIVE_RETENTION_SETTING_KEY, '180');
  assert.equal(fixture.controller.getRetentionDays('statement-generator'), 180);
  const expected = {};
  for (const [index, scope] of SCOPES.entries()) {
    const days = [30, 60, 90, 180, 365, null][index % 6];
    setModule(fixture, scope.id, days);
    expected[scope.id] = days;
  }
  assert.deepEqual(fixture.controller.getSettings().settings.retentionModules, SCOPES);
  assert.deepEqual(fixture.controller.getSettings().settings.retentionDaysByModule, expected);
  await fixture.restart();
  assert.equal(fixture.database.getSetting(ARCHIVE_RETENTION_SETTING_KEY), '180');
  assert.deepEqual(fixture.controller.getSettings().settings.retentionDaysByModule, expected);
  for (const scope of SCOPES) {
    assert.equal(resolveRetentionDays(fixture.database, scope.id), expected[scope.id]);
  }
});

scenario('模块别名规范化、继承恢复及永久默认不混淆', async (fixture) => {
  assert.equal(fixture.controller.setRetentionDays(90).status, 'success');
  setModule(fixture, 'LINKED', 30);
  setModule(fixture, 'PREFUNDTEMP', null);
  setModule(fixture, 'POSITIONLINK', 365);
  assert.deepEqual(fixture.controller.getSettings().settings.retentionDaysByModule, {
    'bank-statement-process': 30,
    'pre-fund-reconciliation': null,
    'position-reconciliation-process': 365
  });
  assert.equal(fixture.controller.getRetentionDays('LINKED'), 30);
  assert.equal(fixture.controller.getRetentionDays('PREFUNDTEMP'), null);
  setModule(fixture, 'FUNDRECON', 'inherit');
  assert.equal(fixture.controller.getRetentionDays('bank-statement-process'), 90);
  assert.equal(Object.hasOwn(
    fixture.controller.getSettings().settings.retentionDaysByModule,
    'bank-statement-process'
  ), false);
  assert.equal(fixture.controller.setRetentionDays(null).status, 'success');
  assert.equal(fixture.controller.getRetentionDays('bank-statement-process'), null);
  assert.equal(fixture.controller.getRetentionDays('position-reconciliation-process'), 365);
  await fixture.restart();
  assert.equal(fixture.controller.getRetentionDays(), null);
  assert.equal(fixture.controller.getRetentionDays('bank-statement-process'), null);
  assert.equal(fixture.controller.getRetentionDays('position-reconciliation-process'), 365);
});

scenario('未知模块和非法期限拒绝保存，已有设置不被覆盖', async (fixture) => {
  setModule(fixture, 'toolbox', 30);
  const before = fixture.db.prepare('SELECT * FROM app_settings ORDER BY setting_key').all();
  for (const payload of [
    { moduleId: 'unknown-module', retentionDays: 30 },
    { moduleId: '', retentionDays: 60 },
    { moduleId: 'toolbox', retentionDays: 0 },
    { moduleId: 'toolbox', retentionDays: -30 },
    { moduleId: 'toolbox', retentionDays: 31 },
    { moduleId: 'toolbox', retentionDays: 90.5 },
    { moduleId: 'toolbox', retentionDays: 'not-a-period' },
    { moduleId: 'toolbox', retentionDays: {} },
    { moduleId: 'toolbox' }
  ]) {
    assert.equal(fixture.controller.setModuleRetentionDays(payload).status, 'failed');
  }
  assert.deepEqual(fixture.db.prepare('SELECT * FROM app_settings ORDER BY setting_key').all(), before);
});

scenario('全部可见模块的 createBatch 根据独立设置和默认继承固化期限', async (fixture) => {
  assert.equal(fixture.controller.setRetentionDays(90).status, 'success');
  for (const [index, scope] of SCOPES.entries()) {
    const days = [30, null, 90][index % 3];
    if (index % 3 !== 2) setModule(fixture, scope.id, days);
    const { batch } = await createFileBatch(fixture, scope.id);
    assert.equal(batch.localDate, LOCAL_DATE);
    assert.equal(batch.retentionUntil, expectedExpiry(days), scope.id);
    assert.equal(fixture.repository.getBatch(batch.id).retentionUntil, expectedExpiry(days));
  }
});

scenario('reserveTaskBatch 使用模块设置，显式期限优先且幂等重入不改旧快照', async (fixture) => {
  setModule(fixture, 'bank-bu-recon', 30);
  setModule(fixture, 'biz-op-recon', null);
  for (const [moduleId, override, expected] of [
    ['bank-bu-recon', {}, 30],
    ['biz-op-recon', {}, null],
    ['toolbox', {}, 60],
    ['bank-bu-recon', { retentionDays: 365 }, 365],
    ['bank-bu-recon', { retentionDays: null }, null],
    ['biz-op-recon', { retentionDays: 90 }, 90]
  ]) {
    const identity = fixture.nextKey();
    const payload = payloadFor(fixture, moduleId, {
      taskKey: 'retention-integration',
      taskRunId: `task-${identity}`,
      parentRunId: `parent-${identity}`,
      ...override
    });
    const reserved = await fixture.service.reserveTaskBatch(payload);
    assert.equal(reserved.ok, true);
    assert.equal(reserved.batch.retentionUntil, expectedExpiry(expected));
    const repeated = await fixture.service.reserveTaskBatch({ ...payload, retentionDays: 180 });
    assert.equal(repeated.created, false);
    assert.equal(repeated.batch.retentionUntil, expectedExpiry(expected));
    const source = fixture.writeSource(moduleId);
    assert.equal((await fixture.service.attachFile(reserved.batch.id, source)).ok, true);
    assert.equal((await fixture.service.markTaskStarted(reserved.batch.id)).ok, true);
    assert.equal((await fixture.service.completeTaskBatch(reserved.batch.id)).ok, true);
  }
});

scenario('reserveFileTaskBatch 按 Task Run 模块取期限且接受显式覆盖', async (fixture) => {
  setModule(fixture, 'statement-generator', 30);
  setModule(fixture, 'toolbox', null);
  for (const [moduleId, override, expected] of [
    ['statement-generator', {}, 30],
    ['toolbox', {}, null],
    ['pending-reconciliation', {}, 60],
    ['statement-generator', { retentionDays: null }, null],
    ['toolbox', { retentionDays: 180 }, 180]
  ]) {
    const identity = fixture.nextKey();
    const scope = SCOPE_BY_ID.get(moduleId);
    const begun = await fixture.service.beginTaskRun({
      taskRunId: `file-${identity}`,
      taskKey: 'retention-integration',
      moduleId,
      parentRunId: `parent-${identity}`,
      operationKey: identity
    });
    assert.equal(begun.ok, true);
    const source = fixture.writeSource(moduleId);
    const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ ...source, sourceOperation: 'retention-integration' }],
      outputs: []
    }));
    const reserved = await fixture.service.reserveFileTaskBatch({
      taskRun: begun.taskRun,
      manifest,
      moduleCode: scope.code,
      moduleName: scope.name,
      ...override
    });
    assert.equal(reserved.ok, true);
    assert.equal(reserved.batch.retentionUntil, expectedExpiry(expected));
    const batch = reserved.batch;
    const batchContext = {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      taskRunId: batch.taskRunId,
      taskKey: batch.taskKey,
      moduleId: batch.moduleId,
      parentRunId: batch.parentRunId,
      operationKey: batch.operationKey
    };
    assert.equal((await fixture.service.startFileTask(batch.taskRunId, batch.id)).ok, true);
    assert.equal((await fixture.service.settleManifestArtifacts({
      batchContext,
      files: manifest.inputs.map((item) => ({ artifactKey: item.artifactKey }))
    })).ok, true);
    assert.equal((await fixture.service.finishFileTask(batch.taskRunId, batch.id, {
      taskStatus: 'succeeded', metadata: {}
    })).ok, true);
  }
});

scenario('真实 TaskLifecycle 文件入口继承模块规则并完成输入输出归档和终态', async (fixture) => {
  const registry = createTaskPolicyRegistry();
  for (const [channel, days] of [
    ['file:import', 30],
    ['toolbox:merge', null],
    ['pending:import:start', 180]
  ]) {
    const policy = registry.require(channel);
    setModule(fixture, policy.scopeId, days);
    const source = fixture.writeSource(policy.scopeId);
    const outputPath = path.join(fixture.sourceDir, `${fixture.nextKey()}-output.csv`);
    const filePlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ ...source, sourceOperation: channel }],
      outputs: [{ filePath: outputPath, role: 'output', sourceOperation: channel }]
    });
    let taskContext;
    const result = await fixture.lifecycle.runFileTask({
      policy,
      filePlanResolver: () => filePlan,
      resultClassifier: (value) => value.status === 'success' ? 'succeeded' : 'failed',
      execute: async (context, controls) => {
        taskContext = context;
        fs.writeFileSync(outputPath, `归档输出：${channel}\n`, 'utf8');
        const settled = await controls.settleArtifacts({
          files: [...filePlan.inputs, ...filePlan.outputs].map((item) => ({
            artifactKey: item.artifactKey
          }))
        });
        assert.equal(settled.ok, true);
        return { status: 'success' };
      }
    });
    assert.equal(result.status, 'success');
    assert.ok(taskContext, '业务 execute 获得真实 Task 上下文');
    const batch = fixture.repository.getBatch(taskContext.batchId);
    assert.equal(batch.moduleId, policy.scopeId);
    assert.equal(batch.retentionUntil, expectedExpiry(days));
    assert.equal(batch.taskStatus, 'succeeded');
    assert.equal(fixture.repository.getTaskRun(taskContext.taskRunId).status, 'succeeded');
    assert.deepEqual(
      fixture.repository.listArtifacts(batch.id).map((artifact) => artifact.status),
      ['ready', 'ready']
    );
  }
});

scenario('controller 建批显式期限优先，修改设置/重启/重放不回写已有批次', async (fixture) => {
  setModule(fixture, 'statement-generator', 30);
  const old = await createFileBatch(fixture, 'statement-generator');
  setModule(fixture, 'statement-generator', null);
  assert.equal(fixture.controller.setRetentionDays(365).status, 'success');
  assert.equal(fixture.repository.getBatch(old.batch.id).retentionUntil, expectedExpiry(30));
  for (const [override, expected] of [[{}, null], [{ retentionDays: 90 }, 90], [{ retentionDays: null }, null]]) {
    const source = fixture.writeSource('controller');
    const tracked = await fixture.controller.createTrackedBatch(payloadFor(
      fixture, 'statement-generator', { files: [source], ...override }
    ));
    assert.equal(tracked.archiveFailed, false);
    assert.equal(fixture.repository.getBatch(tracked.batchId).retentionUntil, expectedExpiry(expected));
  }
  await fixture.restart();
  const repeated = await fixture.service.createBatch(old.payload);
  assert.equal(repeated.created, false);
  assert.equal(repeated.batch.id, old.batch.id);
  assert.equal(repeated.batch.retentionUntil, expectedExpiry(30));
  const newBatch = await createFileBatch(fixture, 'statement-generator');
  assert.equal(newBatch.batch.retentionUntil, null);
});

scenario('归档位置不可用时 outbox 固化模块期限，设置变更后重启重试沿用原值', async (fixture) => {
  setModule(fixture, 'statement-generator', 30);
  setModule(fixture, 'toolbox', null);
  const savedRoot = `${fixture.rootDir}-offline`;
  fs.renameSync(fixture.rootDir, savedRoot);
  fs.writeFileSync(fixture.rootDir, '模拟归档路径被普通文件占用', 'utf8');
  const queued = [];
  try {
    for (const [moduleId, days] of [['statement-generator', 30], ['toolbox', null]]) {
      const source = fixture.writeSource(moduleId);
      const payload = payloadFor(fixture, moduleId, { files: [source] });
      const tracked = await fixture.controller.createTrackedBatch(payload);
      assert.equal(tracked.archiveFailed, true);
      assert.equal(tracked.persistentRetryAvailable, true);
      const record = fixture.outboxStore.findByOperationKey(payload.operationKey);
      assert.ok(record);
      assert.equal(record.payload.retentionDays, days);
      queued.push({ record, days, disk: fs.readFileSync(path.join(fixture.outboxDir, `${record.id}.json`), 'utf8') });
    }
  } finally {
    fs.rmSync(fixture.rootDir, { force: true });
    fs.renameSync(savedRoot, fixture.rootDir);
  }
  setModule(fixture, 'statement-generator', 365);
  setModule(fixture, 'toolbox', 90);
  fixture.controller.setRetentionDays(180);
  for (const item of queued) {
    assert.equal(fs.readFileSync(path.join(fixture.outboxDir, `${item.record.id}.json`), 'utf8'), item.disk);
  }
  await fixture.restart();
  for (const item of queued) {
    assert.equal(fixture.outboxStore.get(item.record.id).payload.retentionDays, item.days);
  }
  const flushed = await fixture.controller.flushOutbox();
  assert.equal(flushed.flushed, queued.length);
  for (const item of queued) {
    const batch = fixture.repository.getBatchByOperationKey(item.record.payload.moduleId, item.record.payload.operationKey);
    assert.ok(batch);
    assert.equal(batch.retentionUntil, expectedExpiry(item.days));
    assert.equal(fixture.outboxStore.get(item.record.id), null);
    assert.equal(fixture.repository.listArtifacts(batch.id)[0].status, 'ready');
  }
});

scenario('cleanupExpired 按已建批快照区分到期/未到期/永久并尊重锁定与 hold', async (fixture) => {
  setModule(fixture, 'statement-generator', 30);
  setModule(fixture, 'bank-bu-recon', 90);
  setModule(fixture, 'toolbox', null);
  const expired = await createFileBatch(fixture, 'statement-generator');
  const future = await createFileBatch(fixture, 'bank-bu-recon');
  const permanent = await createFileBatch(fixture, 'toolbox');
  const locked = await createFileBatch(fixture, 'statement-generator', { locked: true });
  const held = await createFileBatch(fixture, 'statement-generator');
  fixture.repository.addArtifactHold(held.artifact.id, {
    ownerModule: 'statement-generator',
    ownerType: 'retention-integration',
    ownerId: fixture.nextKey(),
    reason: '正在被后续业务引用'
  });
  setModule(fixture, 'statement-generator', null);
  setModule(fixture, 'bank-bu-recon', 30);
  setModule(fixture, 'toolbox', 30);
  const onBoundary = await fixture.service.cleanupExpired({ asOfLocalDate: expectedExpiry(30) });
  assert.equal(onBoundary.ok, true);
  assert.equal(onBoundary.deletedBatchCount, 0, '保留期限当天仍保留');
  const cleaned = await fixture.service.cleanupExpired({ asOfLocalDate: '2026-02-15' });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.candidateCount, 1);
  assert.equal(cleaned.deletedBatchCount, 1);
  assert.equal(fixture.repository.getBatch(expired.batch.id), null);
  assert.equal(fs.existsSync(path.join(fixture.rootDir, expired.artifact.blob.relativePath)), false);
  for (const retained of [future, permanent, locked, held]) {
    const batch = fixture.repository.getBatch(retained.batch.id);
    assert.ok(batch);
    assert.equal(batch.retentionUntil, retained.batch.retentionUntil);
    assert.equal(fixture.repository.getArtifact(retained.artifact.id).status, 'ready');
    assert.equal(fs.readFileSync(path.join(fixture.rootDir, retained.artifact.blob.relativePath), 'utf8'), retained.source.content);
  }
  assert.equal(fixture.repository.getBatch(locked.batch.id).locked, true);
  assert.equal(fixture.repository.listArtifactHolds(held.artifact.id).length, 1);
  for (const item of [expired, future, permanent, locked, held]) {
    assert.equal(fs.readFileSync(item.source.filePath, 'utf8'), item.source.content, '清理不删除外部源文件');
  }
});

async function run() {
  console.log('==== 存档中心按模块保留期限集成验证 ====');
  const failures = [];
  let passed = 0;
  for (const item of cases) {
    let fixture;
    try {
      fixture = await createFixture();
      await item.execute(fixture);
      passed += 1;
      console.log(`PASS ${item.label}`);
    } catch (error) {
      failures.push({ label: item.label, error });
      console.error(`FAIL ${item.label}`);
    } finally {
      if (fixture) await fixture.close();
    }
  }
  console.log(`\n==== ${passed}/${cases.length} PASS ====`);
  if (failures.length > 0) {
    console.error('FAILURES');
    for (const failure of failures) console.error(`  - ${failure.label}\n${failure.error.stack}`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('FAILURES\nFATAL', error);
  process.exitCode = 1;
});
