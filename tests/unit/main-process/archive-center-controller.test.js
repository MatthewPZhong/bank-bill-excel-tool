'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ARCHIVE_RETENTION_SETTING_KEY,
  ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY,
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');
const {
  createArchiveOutboxStore
} = require('../../../src/main-process/archive-center/outbox-store');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  finalizePendingTerminalIntent
} = require('../../../src/main-process/pending-archive-lineage');
const {
  finalizeRunTerminalIntent: finalizeBizOpRunTerminalIntent
} = require('../../../src/main-process/biz-op-recon-run-data');

function createHarness(options = {}) {
  const settings = new Map(options.initialSettings || []);
  const batches = [];
  const artifacts = new Map();
  const templates = [{ id: 1, name: 'DBS' }, { id: 2, name: 'BOC' }];
  const database = {
    getSetting: (key) => settings.get(key) || null,
    setSetting: (key, value) => settings.set(key, value),
    listTemplates: () => templates
  };
  const repository = {
    getBatch: (id) => batches.find((batch) => batch.id === Number(id)) || null,
    getVisibleBatch: (id) => {
      const batch = batches.find((item) => item.id === Number(id)) || null;
      return batch && [...artifacts.values()].some((artifact) => artifact.batchId === batch.id)
        ? batch
        : null;
    },
    getVisibleBatchByNumber: (batchNumber) => {
      const batch = batches.find((item) => item.batchNumber === String(batchNumber)) || null;
      return batch && [...artifacts.values()].some((artifact) => artifact.batchId === batch.id)
        ? batch
        : null;
    },
    getArtifact: (id) => artifacts.get(Number(id)) || null,
    getTaskRun: (taskRunId) => typeof options.getTaskRun === 'function'
      ? options.getTaskRun(taskRunId)
      : null,
    listArtifacts: (batchId) => [...artifacts.values()].filter(
      (artifact) => artifact.batchId === Number(batchId)
    ),
    getOperationIssuance: () => null,
    listFailedArtifacts: (batchId) => [...artifacts.values()].filter((artifact) => (
      artifact.batchId === Number(batchId) && artifact.status === 'failed'
    ))
  };
  const service = {
    rootDir: '/tmp/archive-center',
    repository,
    async initialize() { return { ok: true, available: true }; },
    async replayFlowBindIntents() { return { ok: true, replayed: 0, remaining: 0 }; },
    async replayTaskFlowBindIntents() { return { ok: true, replayed: 0, remaining: 0 }; },
    async markInterruptedTasks() { return { ok: true, taskCount: 0, batchIds: [] }; },
    async reconcileStartup() { return { ok: true, status: 'complete' }; },
    async cleanupExpired() { return { ok: true }; },
    resumeBackgroundMaterialization() {},
    async createBatch(payload) {
      const batch = {
        id: batches.length + 1,
        batchNumber: `${payload.moduleCode}-20260720-001`,
        moduleId: payload.moduleId,
        moduleCode: payload.moduleCode,
        moduleName: payload.moduleName,
        taskRunId: 'private-task-run',
        taskKey: 'private-task-key',
        parentRunId: 'private-parent-run',
        operationKey: payload.operationKey,
        metadata: payload.metadata,
        archiveStatus: 'complete',
        failedArtifactCount: 0
      };
      batches.push(batch);
      const results = [];
      for (const file of Array.isArray(payload.files) ? payload.files : []) {
        results.push(await this.attachFile(batch.id, file));
      }
      return { ok: results.every((result) => result.ok), created: true, batch, results };
    },
    async attachFile(batchId, payload) {
      const id = artifacts.size + 1;
      artifacts.set(id, {
        id,
        batchId,
        originalName: payload.originalName,
        sourcePath: payload.filePath,
        storageRelativePath: 'BANK/2026/07/20/private.xlsx',
        direction: payload.direction,
        role: payload.role,
        status: 'ready',
        metadata: payload.metadata || {},
        blob: { sizeBytes: 12, relativePath: 'blobs/sha256/private' }
      });
      return { ok: true, artifact: artifacts.get(id) };
    },
    async appendFiles(payload) {
      const results = [];
      for (const file of Array.isArray(payload.files) ? payload.files : []) {
        results.push(await this.attachFile(payload.batchId, file));
      }
      return {
        ok: results.every((result) => result.ok),
        batch: repository.getBatch(payload.batchId),
        results
      };
    },
    async completeTaskBatch(batchId, completion = {}) {
      const batch = repository.getBatch(batchId);
      if (!batch) return { ok: false, code: 'ARCHIVE_BATCH_NOT_FOUND' };
      batch.taskStatus = 'succeeded';
      batch.metadata = { ...(batch.metadata || {}), ...(completion.metadata || {}) };
      return { ok: true, batch };
    },
    async failTaskBatch(batchId, failure = {}) {
      const batch = repository.getBatch(batchId);
      if (!batch) return { ok: false, code: 'ARCHIVE_BATCH_NOT_FOUND' };
      batch.taskStatus = 'failed';
      batch.metadata = { ...(batch.metadata || {}), ...(failure.metadata || {}) };
      return { ok: true, batch };
    },
    async cancelTaskBatch(batchId, cancellation = {}) {
      const batch = repository.getBatch(batchId);
      if (!batch) return { ok: false, code: 'ARCHIVE_BATCH_NOT_FOUND' };
      batch.taskStatus = 'cancelled';
      batch.metadata = { ...(batch.metadata || {}), ...(cancellation.metadata || {}) };
      return { ok: true, batch };
    },
    finishTaskRunCalls: [],
    async finishTaskRun(taskRunId, outcome) {
      this.finishTaskRunCalls.push({ taskRunId, outcome });
      return typeof options.finishTaskRun === 'function'
        ? options.finishTaskRun(taskRunId, outcome)
        : { ok: true, taskRun: { taskRunId, status: outcome.taskStatus } };
    },
    finishFileTaskCalls: [],
    async finishFileTask(taskRunId, batchId, outcome) {
      this.finishFileTaskCalls.push({ taskRunId, batchId, outcome });
      return typeof options.finishFileTask === 'function'
        ? options.finishFileTask(taskRunId, batchId, outcome)
        : { ok: true, taskRun: { taskRunId, status: outcome.taskStatus } };
    },
    async listBatches() { return { ok: true, batches }; },
    async getBatch(id) {
      const batch = repository.getBatch(id);
      return batch
        ? {
            ok: true,
            batch: {
              ...batch,
              relatedBatches: [],
              artifacts: [...artifacts.values()].filter((item) => item.batchId === id)
            }
          }
        : { ok: false, message: 'not found' };
    },
    async setLocked(id, locked) { return { ok: true, batch: { ...repository.getBatch(id), locked } }; },
    async deleteBatch() { return { ok: true }; },
    async retryBatch(id, retryOptions = {}) {
      this.lastRetryCall = { id, options: retryOptions };
      return { ok: true, batch: repository.getBatch(id) };
    },
    async openReadonlyCopy() { return { ok: true }; },
    async saveAs(_id, targetPath) { return { ok: true, filePath: targetPath }; },
    listUnresolvedSourcePaths() { return []; },
    async getLatestBatch() { return { ok: true, latestBatch: null }; },
    async getStats() {
      return {
        ok: true,
        stats: { batchCount: batches.length, logicalFileCount: artifacts.size, logicalBytes: 0 }
      };
    }
  };
  const controller = createArchiveCenterController({
    database,
    service,
    storageRootManager: options.storageRootManager,
    outboxStore: options.outboxStore,
    onOutboxFlushed: options.onOutboxFlushed,
    logWarning: options.logWarning,
    resolveOutboxTerminalIntent: options.resolveOutboxTerminalIntent,
    onTerminalIntentFlushed: options.onTerminalIntentFlushed,
    recoverInterruptedTasks: options.recoverInterruptedTasks,
    recoverInterruptedTaskOwners: options.recoverInterruptedTaskOwners,
    postOutboxStartupHooks: options.postOutboxStartupHooks,
    getProtectedInterruptedTaskBatchIds: options.getProtectedInterruptedTaskBatchIds,
    showOpenDialog: options.showOpenDialog,
    showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/saved.xlsx' })
  });
  return { controller, database, service, settings, templates, artifacts, batches };
}

test('tracker sink 建批次、归档文件并向 UI 映射批次号与文件字段', async () => {
  const { controller, artifacts } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    metadata: { _fileManifest: { identity: 'private' }, visible: true },
    files: [{
      filePath: '/tmp/bank.xlsx',
      role: 'input',
      metadata: {
        aliasKey: 'private-alias',
        targetSnapshot: { exists: false },
        sourceSnapshot: { sizeBytes: 12 },
        visible: true
      }
    }]
  });

  assert.equal(created.batchNumber, 'BANK-20260720-001');
  assert.equal(created.archiveFailed, false);
  const listed = await controller.listBatches({ date: '2026-07-20', batchId: 'BANK-' });
  assert.equal(listed.batches[0].batchId, 'BANK-20260720-001');
  assert.equal('_fileManifest' in listed.batches[0].metadata, false);
  for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
    assert.equal(key in listed.batches[0], false, key);
  }
  const detail = await controller.getBatch('BANK-20260720-001');
  for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
    assert.equal(key in detail.batch, false, key);
  }
  assert.equal(detail.batch.files[0].fileName, 'bank.xlsx');
  assert.equal(detail.batch.files[0].direction, '输入');
  assert.equal(detail.batch.files[0].sizeBytes, 12);
  assert.equal('sourcePath' in detail.batch.files[0], false);
  assert.equal('storageRelativePath' in detail.batch.files[0], false);
  assert.equal('relativePath' in detail.batch.files[0].blob, false);
  assert.equal('aliasKey' in detail.batch.files[0].metadata, false);
  assert.equal('targetSnapshot' in detail.batch.files[0].metadata, false);
  const locked = await controller.setLocked('BANK-20260720-001', true);
  assert.equal('_fileManifest' in locked.batch.metadata, false);
  for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
    assert.equal(key in locked.batch, false, key);
  }
  artifacts.get(1).status = 'failed';
  artifacts.get(1).lastErrorCode = 'ARCHIVE_EIO';
  const retried = await controller.retryBatch('BANK-20260720-001');
  assert.equal('_fileManifest' in retried.batch.metadata, false);
  for (const key of ['taskRunId', 'taskKey', 'operationKey', 'parentRunId']) {
    assert.equal(key in retried.batch, false, key);
  }
});

test('tracked batch 无候选文件时不建批次、不发 pseudo batch 且不写 outbox', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-empty-tracked-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const { controller, batches } = createHarness({ outboxStore });
  const result = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'tracked-empty-files',
    sourceOperation: 'bank-statement:run',
    files: []
  });
  assert.equal(result.archiveFailed, true);
  assert.equal(result.code, 'ARCHIVE_FILE_MANIFEST_EMPTY');
  assert.equal(result.batchId, undefined);
  assert.equal(result.persistentRetryAvailable, false);
  assert.equal(batches.length, 0);
  assert.deepEqual(outboxStore.list(), []);
});

test('保留期默认 60 天并支持新增枚举，既有合法值保持兼容', () => {
  const { controller, settings } = createHarness();
  assert.equal(controller.getSettings().settings.retentionDays, 60);
  assert.equal(controller.setRetentionDays(60).status, 'success');
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), '60');
  assert.equal(controller.setRetentionDays(90).status, 'success');
  assert.equal(controller.getSettings().settings.retentionDays, 90);
  assert.equal(controller.setRetentionDays(45).status, 'failed');
  assert.equal(controller.setRetentionDays(null).status, 'success');
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), 'permanent');
});

test('operation owner 终态 outbox 只重放 Task Run CAS，不创建空 batch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-operation-outbox-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const { controller, service } = createHarness({ outboxStore });
  const persisted = controller.persistTaskTerminalIntent({
    owner: {
      version: 1,
      kind: 'operation',
      operationContext: {
        taskRunId: 'task-operation-only-1',
        taskKey: 'pending:query',
        moduleId: 'pending-reconciliation',
        parentRunId: 'parent-operation-only-1',
        operationKey: 'operation-only-1'
      }
    },
    sourceOperation: 'pending:reconcile:query',
    terminalOutcome: {
      taskStatus: 'failed',
      code: 'DB_TEMPORARY',
      message: 'terminal retry',
      metadata: {}
    }
  });
  assert.equal(persisted.taskRunId, 'task-operation-only-1');
  assert.equal(outboxStore.list()[0].payload.targetBatchId, undefined);

  const flushed = await controller.flushOutbox();
  assert.deepEqual(flushed, { flushed: 1, discarded: 0, remaining: 0 });
  assert.equal(service.finishTaskRunCalls.length, 1);
  assert.equal(service.finishTaskRunCalls[0].taskRunId, 'task-operation-only-1');
  assert.equal(await service.listBatches().then((value) => value.batches.length), 0);
});

test('operation owner 取消终态重放后执行 finalizer，失败时保留 outbox 供二启重试', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-operation-finalizer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const finalized = [];
  let failFinalizer = true;
  const { controller, service } = createHarness({
    outboxStore,
    onTerminalIntentFlushed: async (payload) => {
      finalized.push(payload.route);
      if (failFinalizer) throw new Error('position pending unavailable');
    }
  });
  controller.persistTaskTerminalIntent({
    owner: {
      version: 1,
      kind: 'operation',
      operationContext: {
        taskRunId: 'position-operation-cancelled',
        taskKey: 'position-reconciliation:mappings:save',
        moduleId: 'position-reconciliation-process',
        parentRunId: 'position-parent-cancelled',
        operationKey: 'position:operation-cancelled:mappings-save'
      }
    },
    sourceOperation: 'position-reconciliation:mappings:save',
    terminalOutcome: {
      taskStatus: 'cancelled',
      code: 'POSITION_OPERATION_CANCELLED',
      message: '用户取消平盘任务',
      metadata: {},
      afterTerminal: {
        route: 'position-reconciliation',
        operationToken: 'position-operation-cancelled'
      }
    }
  });

  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 0,
    discarded: 0,
    remaining: 1
  });
  assert.equal(outboxStore.list().length, 1);
  failFinalizer = false;
  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 1,
    discarded: 0,
    remaining: 0
  });
  assert.equal(service.finishTaskRunCalls.length, 2);
  assert.deepEqual(finalized, [
    { route: 'position-reconciliation', operationToken: 'position-operation-cancelled' },
    { route: 'position-reconciliation', operationToken: 'position-operation-cancelled' }
  ]);
});

test('Pending operation terminal route 以 TaskRun identity 持久并在重放后调用 finalizer', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pending-finalizer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const finalized = [];
  const { controller } = createHarness({
    outboxStore,
    onTerminalIntentFlushed: async (payload) => finalized.push(payload)
  });
  controller.persistTaskTerminalIntent({
    owner: {
      version: 1,
      kind: 'operation',
      operationContext: {
        taskRunId: 'pending-run-task-outbox',
        taskKey: 'pending:reconcile:run',
        moduleId: 'pending-reconciliation',
        parentRunId: 'pending-parent-outbox',
        operationKey: 'pending:run:outbox'
      }
    },
    sourceOperation: 'pending:reconcile:run',
    terminalOutcome: {
      taskStatus: 'succeeded',
      metadata: {},
      afterTerminal: {
        route: 'pending-run',
        taskRunId: 'pending-run-task-outbox'
      }
    }
  });
  assert.deepEqual(
    outboxStore.list()[0].payload.terminalOutcome.afterTerminal,
    { route: 'pending-run', taskRunId: 'pending-run-task-outbox' }
  );
  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 1,
    discarded: 0,
    remaining: 0
  });
  assert.deepEqual(finalized[0].route, {
    route: 'pending-run', taskRunId: 'pending-run-task-outbox'
  });
  assert.equal(finalized[0].terminalOutcome.taskStatus, 'succeeded');
});

test('Pre-fund terminal route 只规范非空 TaskRun identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pre-fund-finalizer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const finalized = [];
  const { controller } = createHarness({
    outboxStore,
    onTerminalIntentFlushed: async (payload) => finalized.push(payload)
  });
  const owner = {
    version: 1,
    kind: 'operation',
    operationContext: {
      taskRunId: 'pre-fund-run-task-outbox',
      taskKey: 'pre-fund-reconciliation:run',
      moduleId: 'pre-fund-reconciliation',
      parentRunId: 'pre-fund-parent-outbox',
      operationKey: 'pre-fund:run:outbox'
    }
  };
  controller.persistTaskTerminalIntent({
    owner,
    sourceOperation: 'pre-fund-reconciliation:run',
    terminalOutcome: {
      taskStatus: 'succeeded',
      metadata: {},
      afterTerminal: {
        route: 'pre-fund-run',
        taskRunId: '  pre-fund-run-task-outbox  ',
        ignored: true
      }
    }
  });
  assert.deepEqual(outboxStore.list()[0].payload.terminalOutcome.afterTerminal, {
    route: 'pre-fund-run',
    taskRunId: 'pre-fund-run-task-outbox'
  });
  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 1,
    discarded: 0,
    remaining: 0
  });
  assert.deepEqual(finalized[0].route, {
    route: 'pre-fund-run',
    taskRunId: 'pre-fund-run-task-outbox'
  });
  assert.throws(() => controller.persistTaskTerminalIntent({
    owner,
    sourceOperation: 'pre-fund-reconciliation:run',
    terminalOutcome: {
      taskStatus: 'succeeded',
      metadata: {},
      afterTerminal: { route: 'pre-fund-run', taskRunId: '   ' }
    }
  }), /Pre-fund terminal route\.taskRunId 为空/);
});

test('operation/file owner cancel-wins 时迟到 success 不 finalizer、不移除 outbox', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-owner-terminal-conflict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const finalized = [];
  const { controller, service } = createHarness({
    outboxStore,
    getTaskRun: (taskRunId) => ({ taskRunId, status: 'cancelled' }),
    finishTaskRun: (taskRunId) => ({
      ok: false,
      code: 'ARCHIVE_TASK_STATUS_CONFLICT',
      taskRun: { taskRunId, status: 'cancelled' }
    }),
    finishFileTask: (taskRunId) => ({
      ok: false,
      code: 'ARCHIVE_TASK_STATUS_CONFLICT',
      taskRun: { taskRunId, status: 'cancelled' }
    }),
    onTerminalIntentFlushed: async (payload) => finalized.push(payload)
  });
  const terminalOutcome = {
    taskStatus: 'succeeded',
    metadata: {},
    afterTerminal: { route: 'pending-run', taskRunId: 'owner-conflict-operation' }
  };
  controller.persistTaskTerminalIntent({
    owner: {
      version: 1,
      kind: 'operation',
      operationContext: {
        taskRunId: 'owner-conflict-operation',
        taskKey: 'pending:reconcile:run',
        moduleId: 'pending-reconciliation',
        parentRunId: 'owner-conflict-parent',
        operationKey: 'owner-conflict:operation'
      }
    },
    sourceOperation: 'pending:reconcile:run',
    terminalOutcome
  });
  controller.persistTaskTerminalIntent({
    owner: {
      version: 1,
      kind: 'file-batch',
      batchContext: {
        batchId: 77,
        batchNumber: '2026-08-18-077',
        taskRunId: 'owner-conflict-file',
        taskKey: 'position-reconciliation:run:export',
        moduleId: 'position-reconciliation-process',
        parentRunId: 'owner-conflict-parent',
        operationKey: 'owner-conflict:file'
      }
    },
    sourceOperation: 'position-reconciliation:run:export',
    terminalOutcome: {
      ...terminalOutcome,
      afterTerminal: {
        route: 'position-reconciliation',
        operationToken: 'owner-conflict-file'
      }
    }
  });
  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 0,
    discarded: 0,
    remaining: 2
  });
  assert.equal(finalized.length, 0);
  assert.equal(service.finishTaskRunCalls.length, 1);
  assert.equal(service.finishFileTaskCalls.length, 1);
  assert.equal(outboxStore.list().length, 2);
});

test('failed/no-receipt terminal outbox 重放只收口 TaskRun，Pending/Biz finalizer 均无业务副作用', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-failed-receipt-finalizer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outboxStore = createArchiveOutboxStore(directory);
  const finalized = [];
  const forbiddenDb = new Proxy({}, {
    get() {
      throw new Error('failed terminal 不得读取或确认业务 receipt');
    }
  });
  const { controller, service } = createHarness({
    outboxStore,
    onTerminalIntentFlushed: async (payload) => {
      finalized.push(payload.route.route);
      if (payload.route.route === 'pending-run') {
        return finalizePendingTerminalIntent({ ...payload, db: forbiddenDb });
      }
      return finalizeBizOpRunTerminalIntent({
        ...payload,
        userDataDir: '/path/must/not/be/read',
        mainDb: forbiddenDb
      });
    }
  });

  for (const entry of [
    {
      taskRunId: 'pending-run-failed-no-receipt',
      taskKey: 'pending:reconcile:run',
      moduleId: 'pending-reconciliation',
      route: 'pending-run'
    },
    {
      taskRunId: 'biz-op-run-failed-no-receipt',
      taskKey: 'bizOpRecon:run',
      moduleId: 'biz-op-reconciliation',
      route: 'biz-op-run'
    }
  ]) {
    controller.persistTaskTerminalIntent({
      owner: {
        version: 1,
        kind: 'operation',
        operationContext: {
          taskRunId: entry.taskRunId,
          taskKey: entry.taskKey,
          moduleId: entry.moduleId,
          parentRunId: `${entry.taskRunId}:parent`,
          operationKey: `${entry.taskRunId}:operation`
        }
      },
      sourceOperation: entry.taskKey,
      terminalOutcome: {
        taskStatus: 'failed',
        code: 'BUSINESS_OPERATION_FAILED',
        message: '业务在 receipt 提交前失败',
        metadata: {},
        afterTerminal: { route: entry.route, taskRunId: entry.taskRunId }
      }
    });
  }

  assert.deepEqual(await controller.flushOutbox(), {
    flushed: 2,
    discarded: 0,
    remaining: 0
  });
  assert.deepEqual(finalized.sort(), ['biz-op-run', 'pending-run']);
  assert.equal(service.finishTaskRunCalls.length, 2);
  assert.deepEqual(outboxStore.list(), []);
});

test('控制器启动时将有效、损坏和空模板排除设置统一归一化为空数组', () => {
  const cases = [
    ['有效设置', '["2"]'],
    ['损坏设置', '{broken-json'],
    ['空设置', '']
  ];
  for (const [label, storedValue] of cases) {
    const { controller, settings } = createHarness({
      initialSettings: [[ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY, storedValue]]
    });
    assert.equal(
      settings.get(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY),
      '[]',
      label
    );
    const expectedSettings = typeof controller.changeStorageLocation === 'function'
      ? {
          retentionDays: 60,
          storageRoot: '/tmp/archive-center',
          storageMigration: { status: 'idle', phase: '', processed: 0, total: 0 }
        }
      : { retentionDays: 60 };
    assert.deepEqual(controller.getSettings().settings, expectedSettings, label);
  }

  const missing = createHarness();
  assert.equal(
    missing.settings.get(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY),
    '[]',
    '缺失设置'
  );
});

test('存储根 manager 先于 service 初始化，设置/变更透传且 maintenance 阻止删除重试', async () => {
  const calls = [];
  let maintenance = false;
  const storageRootManager = {
    async initialize() {
      calls.push('manager-initialize');
      return { ok: true, available: true };
    },
    getCurrentRoot: () => '/new/archive-root',
    getMigrationState: () => ({ status: 'running', phase: 'copying', processed: 1, total: 2 }),
    isMaintenanceRequested: () => maintenance,
    resumeBackgroundArchiveChecks() {},
    async changeStorageLocation() {
      calls.push('change-storage');
      return { status: 'success', message: '存档位置已变更' };
    }
  };
  const { controller, service } = createHarness({ storageRootManager });
  service.initialize = async () => {
    calls.push('service-initialize');
    return { ok: true, available: true };
  };
  const initialized = await controller.initialize();
  if (typeof controller.changeStorageLocation !== 'function') {
    assert.equal(initialized.available, true);
    assert.deepEqual(calls, ['service-initialize']);
    return;
  }
  assert.equal(initialized.available, true);
  assert.deepEqual(calls, ['manager-initialize']);
  assert.deepEqual(controller.getSettings().settings, {
    retentionDays: 60,
    storageRoot: '/new/archive-root',
    storageMigration: { status: 'running', phase: 'copying', processed: 1, total: 2 }
  });
  assert.equal((await controller.changeStorageLocation()).status, 'success');
  assert.deepEqual(calls, ['manager-initialize', 'change-storage']);

  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'maintenance-controller-batch',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/maintenance-controller.xlsx', role: 'input' }]
  });
  maintenance = true;
  assert.equal((await controller.deleteBatch(created.batchId)).code, 'ARCHIVE_STORAGE_MAINTENANCE');
  assert.equal((await controller.retryBatch(created.batchId)).code, 'ARCHIVE_STORAGE_MAINTENANCE');
});

test('公开统计 DTO 精确投影 ready 总量、运行次数、不可回退 latest 与迁移状态', async () => {
  const storageRootManager = {
    getCurrentRoot: () => '/current/archive-root',
    getMigrationState: () => ({ status: 'running', phase: 'copying', processed: 3, total: 8 }),
    isMaintenanceRequested: () => false
  };
  const { controller, service } = createHarness({ storageRootManager });
  service.getStats = async () => ({
    ok: true,
    stats: {
      batchCount: 7,
      logicalBytes: 12345,
      uniqueBytes: 999,
      logicalFileCount: 22,
      failedFileCount: 4
    }
  });
  service.getLatestBatch = async () => ({
    ok: true,
    latestBatch: {
      batchId: 41,
      batchNumber: '2026-08-11-041',
      taskStatus: 'cancelled'
    }
  });

  const result = await controller.getStats();
  if (!Object.hasOwn(result.stats || {}, 'latestBatchStatus')) {
    assert.deepEqual(result.stats, {
      batchCount: 7,
      logicalBytes: 12345,
      uniqueBytes: 999,
      logicalFileCount: 22,
      failedFileCount: 4,
      fileRefCount: 22,
      storagePath: '/tmp/archive-center'
    });
    return;
  }
  assert.deepEqual(result.stats, {
    storagePath: '/current/archive-root',
    fileTotalBytes: 12345,
    runCount: 7,
    latestBatchNumber: '2026-08-11-041',
    latestBatchId: 41,
    latestBatchStatus: 'cancelled',
    migrationStatus: { status: 'running', phase: 'copying', processed: 3, total: 8 }
  });
  assert.deepEqual(Object.keys(result.stats), [
    'storagePath',
    'fileTotalBytes',
    'runCount',
    'latestBatchNumber',
    'latestBatchId',
    'latestBatchStatus',
    'migrationStatus'
  ]);

  service.getLatestBatch = async () => ({
    ok: true,
    latestBatch: { batchId: 41, batchNumber: '2026-08-11-041', taskStatus: null }
  });
  assert.equal((await controller.getStats()).stats.latestBatchStatus, null);
});

test('模板排除控制器方法与 main/preload IPC 桥接已移除', () => {
  const { controller } = createHarness();
  assert.equal(controller.listTemplatePolicies, undefined);
  assert.equal(controller.setTemplateExcluded, undefined);
  assert.equal(controller.hasExcludedTemplate, undefined);

  const repositoryRoot = path.resolve(__dirname, '../../..');
  const mainSource = fs.readFileSync(path.join(repositoryRoot, 'src/main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(repositoryRoot, 'src/preload.js'), 'utf8');
  for (const source of [mainSource, preloadSource]) {
    assert.doesNotMatch(source, /archive-center:list-template-policies/);
    assert.doesNotMatch(source, /archive-center:set-template-excluded/);
  }
  assert.doesNotMatch(mainSource, /hasExcludedTemplate/);
});

test('单个文件归档失败保留批次并返回可见告警，不抛业务异常', async () => {
  const { controller, service } = createHarness();
  service.attachFile = async () => ({ ok: false, code: 'ARCHIVE_ENOSPC', message: '磁盘空间不足' });
  const result = await controller.sink.createBatch({
    moduleId: 'statement-generator',
    moduleCode: 'STATEMENT',
    moduleName: '网银账单生成',
    sourceOperation: 'file:import',
    files: [{ filePath: '/tmp/source.xlsx', role: 'input' }]
  });

  assert.ok(result.batchId);
  assert.equal(result.archiveFailed, true);
  assert.match(result.warning.message, /1 个文件/);
  assert.equal(result.warning.failures[0].originalName, 'source.xlsx');
});

test('另存为取消不写文件，成功时使用原文件名作为默认名', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'new-account',
    moduleCode: 'NEW',
    moduleName: '新开账户余额账单生成',
    sourceOperation: 'new-account:generate',
    files: [{ filePath: '/tmp/result.xlsx', role: 'output' }]
  });
  const detail = await controller.getBatch(created.batchNumber);
  const fileRefId = detail.batch.files[0].fileRefId;

  controller.showSaveDialog = async (options) => {
    assert.equal(options.defaultPath, 'result.xlsx');
    return { canceled: true };
  };
  assert.equal((await controller.saveAs(fileRefId)).status, 'cancelled');

  controller.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/copy.xlsx' });
  service.saveAs = async (_id, targetPath) => ({ ok: true, filePath: targetPath });
  assert.equal((await controller.saveAs(fileRefId)).filePath, '/tmp/copy.xlsx');
});

test('批次元数据已删除但物理清理失败时保留部分成功语义', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/bank.xlsx', role: 'input' }]
  });
  service.deleteBatch = async () => ({
    ok: false,
    metadataDeleted: true,
    failures: [{ code: 'ARCHIVE_EBUSY' }]
  });

  const result = await controller.deleteBatch(created.batchNumber);
  assert.equal(result.status, 'partial');
  assert.equal(result.ok, false);
  assert.equal(result.metadataDeleted, true);
  assert.match(result.message, /批次记录已删除/);
});

test('业务完成后源文件已变化的批次要求重新执行业务，不提供无效重试', async () => {
  const { controller, service } = createHarness();
  service.listBatches = async () => ({
    ok: true,
    batches: [{
      id: 9,
      batchNumber: 'BANK-20260720-009',
      moduleId: 'bank-statement',
      moduleName: '资金对账数据处理',
      failedArtifactCount: 1,
      lastErrorCode: 'ARCHIVE_SOURCE_CHANGED',
      lastErrorMessage: '源文件已变化'
    }]
  });

  const listed = await controller.listBatches({});
  assert.equal(listed.batches[0].canRetry, false);
  assert.equal(listed.batches[0].retryMode, 'rerun-business');
  assert.equal(listed.batches[0].requiresBusinessRerun, true);
});

test('未产出 output 与业务失败但归档输入完整均提示从原入口重跑', async () => {
  const output = createHarness();
  const outputCreated = await output.controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:export',
    files: [{ filePath: '/tmp/missing-output.xlsx', role: 'output' }]
  });
  Object.assign(output.service.repository.getBatch(outputCreated.batchId), {
    archiveStatus: 'incomplete',
    failedArtifactCount: 1,
    lastErrorCode: 'ARCHIVE_OUTPUT_NOT_PRODUCED'
  });
  Object.assign(output.service.repository.getArtifact(1), {
    status: 'failed',
    lastErrorCode: 'ARCHIVE_OUTPUT_NOT_PRODUCED'
  });
  const outputDto = (await output.controller.listBatches({})).batches[0];
  assert.equal(outputDto.canRetry, false);
  assert.equal(outputDto.retryMode, 'rerun-business');
  assert.equal(outputDto.requiresBusinessRerun, true);

  const business = createHarness();
  const businessCreated = await business.controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run',
    files: [
      { filePath: '/tmp/position-input-1.xlsx', role: 'input' },
      { filePath: '/tmp/position-input-2.xlsx', role: 'input' }
    ]
  });
  Object.assign(business.service.repository.getBatch(businessCreated.batchId), {
    taskStatus: 'failed',
    archiveStatus: 'complete',
    failedArtifactCount: 0,
    failureMessage: '原业务校验失败：账单币种不一致'
  });
  const businessDto = (await business.controller.listBatches({})).batches[0];
  assert.equal(businessDto.canRetry, false);
  assert.equal(businessDto.retryMode, 'rerun-business');
  assert.equal(businessDto.requiresBusinessRerun, true);
  assert.equal(businessDto.warningMessage, '原业务校验失败：账单币种不一致');
  const detail = await business.controller.getBatch(businessCreated.batchId);
  assert.equal(detail.batch.files.length, 2);
  assert.deepEqual(detail.batch.files.map((file) => file.role), ['input', 'input']);
  assert.equal(detail.batch.warningMessage, '原业务校验失败：账单币种不一致');

  const toolbox = createHarness();
  const historical001 = await toolbox.controller.sink.createBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    sourceOperation: 'toolbox:merge',
    files: [
      { filePath: '/tmp/toolbox-merge-input-1.xlsx', role: 'input' },
      { filePath: '/tmp/toolbox-merge-input-2.xlsx', role: 'input' }
    ]
  });
  Object.assign(toolbox.service.repository.getBatch(historical001.batchId), {
    batchNumber: '2026-08-17-001',
    taskStatus: 'failed',
    archiveStatus: 'complete',
    readyArtifactCount: 2,
    failedArtifactCount: 0,
    failureMessage: '工具箱存档交接缺少输入文件证据'
  });
  const historicalDto = (await toolbox.controller.listBatches({})).batches[0];
  assert.equal(historicalDto.canRetry, false);
  assert.equal(historicalDto.retryMode, 'rerun-business');
  assert.equal(historicalDto.requiresBusinessRerun, true);
  assert.equal(historicalDto.batchNumber, '2026-08-17-001');
  assert.equal(historicalDto.taskStatus, 'failed');
  assert.equal(historicalDto.archiveStatus, 'complete');
  assert.equal(historicalDto.failedArtifactCount, 0);
  assert.equal(historicalDto.rerunHint, '请从工具箱重新执行');
  assert.equal(historicalDto.warningMessage, '工具箱存档交接缺少输入文件证据');
  const historicalDetail = await toolbox.controller.getBatch(historical001.batchId);
  assert.equal(historicalDetail.batch.files.length, 2);
  assert.deepEqual(historicalDetail.batch.files.map((file) => file.direction), ['输入', '输入']);
  assert.equal(historicalDetail.batch.rerunHint, '请从工具箱重新执行');
});

test('源文件变化但保留业务摘要时允许选择等价副本，且不向页面暴露摘要', async () => {
  const replacementPath = path.resolve('/tmp/replacement-source.xlsx');
  const { controller, service } = createHarness({
    showOpenDialog: async (options) => {
      assert.match(options.title, /source\.xlsx/);
      assert.deepEqual(options.properties, ['openFile']);
      return { canceled: false, filePaths: [replacementPath] };
    }
  });
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/source.xlsx', role: 'input' }]
  });
  const batch = service.repository.getBatch(created.batchId);
  const artifact = service.repository.getArtifact(1);
  Object.assign(batch, {
    archiveStatus: 'incomplete',
    failedArtifactCount: 1,
    lastErrorCode: 'ARCHIVE_SOURCE_CHANGED',
    lastErrorMessage: '源文件已变化'
  });
  Object.assign(artifact, {
    status: 'failed',
    lastErrorCode: 'ARCHIVE_SOURCE_CHANGED',
    lastErrorMessage: '源文件已变化',
    metadata: {
      expectedSha256: 'a'.repeat(64),
      expectedSizeBytes: 12
    }
  });

  const listed = await controller.listBatches({});
  assert.equal(listed.batches[0].canRetry, true);
  assert.equal(listed.batches[0].retryMode, 'select-source');
  assert.equal(listed.batches[0].requiresBusinessRerun, false);
  assert.equal(JSON.stringify(listed).includes('a'.repeat(64)), false);
  const detail = await controller.getBatch(created.batchId);
  assert.equal(detail.batch.files[0].canSelectReplacementSource, true);
  assert.equal(JSON.stringify(detail).includes('a'.repeat(64)), false);

  const successfulDialog = controller.showOpenDialog;
  controller.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal((await controller.selectRetrySources(created.batchId)).status, 'cancelled');
  controller.showOpenDialog = successfulDialog;
  const selected = await controller.selectRetrySources(created.batchId);
  assert.deepEqual(selected, {
    status: 'success',
    sourcePaths: { 1: replacementPath },
    selectedCount: 1
  });
  const retried = await controller.retryBatch(created.batchId, selected.sourcePaths);
  assert.equal(retried.status, 'success');
  assert.deepEqual(service.lastRetryCall, {
    id: created.batchId,
    options: { sourcePaths: { 1: replacementPath } }
  });
});

test('普通可重试错误保持原路径重试模式', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/locked.xlsx', role: 'input' }]
  });
  const batch = service.repository.getBatch(created.batchId);
  const artifact = service.repository.getArtifact(1);
  Object.assign(batch, {
    archiveStatus: 'incomplete',
    failedArtifactCount: 1,
    lastErrorCode: 'ARCHIVE_EACCES'
  });
  Object.assign(artifact, {
    status: 'failed',
    lastErrorCode: 'ARCHIVE_EACCES'
  });

  const listed = await controller.listBatches({});
  assert.equal(listed.batches[0].canRetry, true);
  assert.equal(listed.batches[0].retryMode, 'same-source');
  assert.equal(listed.batches[0].requiresBusinessRerun, false);
  assert.equal((await controller.retryBatch(created.batchId)).status, 'success');
  assert.deepEqual(service.lastRetryCall.options, { sourcePaths: {} });
});

test('混合重试部分成功时返回计数和明确提示', async () => {
  const { controller, service } = createHarness();
  const created = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '资金对账数据处理',
    sourceOperation: 'bank-statement:run',
    files: [
      { filePath: '/tmp/first.xlsx', role: 'input' },
      { filePath: '/tmp/second.xlsx', role: 'input' }
    ]
  });
  const batch = service.repository.getBatch(created.batchId);
  Object.assign(batch, {
    archiveStatus: 'incomplete',
    failedArtifactCount: 2,
    lastErrorCode: 'ARCHIVE_EACCES'
  });
  for (const artifactId of [1, 2]) {
    Object.assign(service.repository.getArtifact(artifactId), {
      status: 'failed',
      lastErrorCode: 'ARCHIVE_EACCES'
    });
  }
  service.retryBatch = async () => ({
    ok: false,
    status: 'incomplete',
    batch,
    attempted: 2,
    succeeded: 1,
    failed: 1,
    results: [
      { ok: true },
      { ok: false, code: 'ARCHIVE_EACCES', message: '目标目录暂不可写' }
    ]
  });

  const result = await controller.retryBatch(created.batchId);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_EACCES');
  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.message, '目标目录暂不可写；本次已成功 1 个，仍失败 1 个');
});

test('controller 使用真实 ArchiveService 拒绝错误副本并接受同字节副本', async (t) => {
  const crypto = require('node:crypto');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-replacement-'));
  const archiveRoot = path.join(rootDir, 'archive');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const service = createArchiveService({
    database: db,
    rootDir: archiveRoot,
    now: () => new Date(2026, 6, 20, 12, 0, 0)
  });
  const settings = new Map();
  const controller = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value)
    },
    service
  });
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await service.initialize();

  const originalPath = path.join(rootDir, 'original.xlsx');
  fs.writeFileSync(originalPath, 'expected-version');
  const originalStat = fs.statSync(originalPath);
  const sourceSnapshot = {
    sizeBytes: Number(originalStat.size),
    mtimeMs: Number(originalStat.mtimeMs),
    ctimeMs: Number(originalStat.ctimeMs),
    ino: Number(originalStat.ino)
  };
  const expectedSha256 = crypto
    .createHash('sha256')
    .update('expected-version')
    .digest('hex');
  fs.writeFileSync(originalPath, 'different-bytes!');

  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    files: [{
      filePath: originalPath,
      role: 'input',
      sourceSnapshot,
      expectedSha256,
      expectedSizeBytes: Buffer.byteLength('expected-version')
    }]
  });
  const failedArtifact = service.repository.listFailedArtifacts(created.batchId)[0];
  assert.ok(failedArtifact);

  const wrongPath = path.join(rootDir, 'wrong.xlsx');
  fs.writeFileSync(wrongPath, 'different-bytes!');
  const rejected = await controller.retryBatch(created.batchId, {
    [failedArtifact.id]: wrongPath
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'ARCHIVE_SOURCE_CHANGED');
  assert.equal(
    rejected.message,
    '所选文件与业务处理时的原始内容不一致，请重新选择正确文件'
  );
  assert.equal(service.repository.getArtifact(failedArtifact.id).status, 'failed');

  const replacementPath = path.join(rootDir, 'replacement.xlsx');
  fs.writeFileSync(replacementPath, 'expected-version');
  const recovered = await controller.retryBatch(created.batchId, {
    [failedArtifact.id]: replacementPath
  });
  assert.equal(recovered.status, 'success');
  assert.equal(service.repository.getArtifact(failedArtifact.id).status, 'ready');
  assert.equal(service.repository.getBatch(created.batchId).archiveStatus, 'complete');
});

test('存档主库暂不可用时写入 outbox，跨重启重放后解除源文件保护', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const outputPath = path.join(rootDir, 'result.xlsx');
  const releasedPaths = [];
  const warnings = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths),
    logWarning: (message, detail) => warnings.push(`${message} ${detail}`)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const workingCreateBatch = service.createBatch.bind(service);
  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    operationKey: 'position:operation-1:position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-1' },
    files: [{ filePath: inputPath, role: 'input' }]
  });
  assert.match(created.batchId, /^outbox:/);
  assert.equal(created.archiveFailed, true);
  assert.equal(created.persistentRetryAvailable, true);

  const workingGetOperationIssuance = service.repository.getOperationIssuance;
  service.repository.getOperationIssuance = () => {
    throw new Error('archive database busy');
  };
  const persistedIntent = controller.persistOperationIntent({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run:export',
    operationKey: 'position:operation-1:position-reconciliation:bank:apply-import',
    files: [{ filePath: outputPath, role: 'output' }]
  });
  service.repository.getOperationIssuance = workingGetOperationIssuance;
  assert.equal(persistedIntent.batchId, created.batchId);
  assert.equal(persistedIntent.persisted, true);
  assert.match(warnings.join('\n'), /删除状态读取失败，继续登记持久 outbox/);
  const appended = await controller.sink.appendFiles({
    batchId: created.batchId,
    sourceOperation: 'position-reconciliation:run:export',
    files: [{ filePath: outputPath, role: 'output' }]
  });
  assert.equal(appended.persistentRetryAvailable, true);
  assert.deepEqual(
    controller.listUnresolvedSourcePaths().sort(),
    [inputPath, outputPath].sort()
  );

  service.createBatch = workingCreateBatch;
  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths.sort(), [inputPath, outputPath].sort());
});

test('已永久删除 operation 的 outbox 跨重启后明确丢弃且不复活批次', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-deleted-outbox-'));
  const dbPath = path.join(rootDir, 'archive.sqlite');
  const archiveRoot = path.join(rootDir, 'archive');
  const outboxRoot = path.join(rootDir, 'outbox');
  const sourcePath = path.join(rootDir, 'deleted-source.xlsx');
  const settings = new Map();
  const releasedPaths = [];
  const warnings = [];
  let db = null;
  t.after(() => {
    if (db) db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  fs.writeFileSync(sourcePath, 'deleted-source');
  const database = {
    getSetting: (key) => settings.get(key) || null,
    setSetting: (key, value) => settings.set(key, value)
  };
  const payload = {
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run',
    operationKey: 'position:deleted-outbox'
  };

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  let repository = createArchiveRepository(db, {
    now: () => new Date(2026, 6, 20, 12, 0, 0)
  });
  let service = createArchiveService({ repository, rootDir: archiveRoot });
  let outboxStore = createArchiveOutboxStore(outboxRoot);
  let controller = createArchiveCenterController({ database, service, outboxStore });
  await service.initialize();
  const created = await controller.sink.createBatch({
    ...payload,
    files: [{ filePath: sourcePath, role: 'input' }]
  });
  controller.persistOperationIntent({
    ...payload,
    files: [{ filePath: sourcePath, role: 'input' }]
  });
  assert.equal(outboxStore.list().length, 1);
  assert.equal((await service.deleteBatch(created.batchId)).ok, true);
  db.close();
  db = null;

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  repository = createArchiveRepository(db, {
    now: () => new Date(2026, 6, 20, 12, 1, 0)
  });
  service = createArchiveService({ repository, rootDir: archiveRoot });
  outboxStore = createArchiveOutboxStore(outboxRoot);
  controller = createArchiveCenterController({
    database,
    service,
    outboxStore,
    logWarning: (message, detail) => warnings.push(`${message} ${detail}`),
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  await service.initialize();
  const flushed = await controller.flushOutbox();
  assert.deepEqual(flushed, { flushed: 0, discarded: 1, remaining: 0 });
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths, [sourcePath]);
  assert.match(warnings.join('\n'), /已永久删除，停止重放/);
  assert.equal(repository.getStats().batchCount, 0);

  const issuanceBeforeIntent = repository.getOperationIssuance(
    payload.moduleId,
    payload.operationKey
  );
  const cursorBeforeIntent = db.prepare(`
    SELECT * FROM archive_batch_sequences
    WHERE module_code = ?
  `).get(payload.moduleCode);
  const persistedIntent = controller.persistOperationIntent({
    ...payload,
    files: [{ filePath: sourcePath, role: 'input' }]
  });
  assert.deepEqual(persistedIntent, {
    batchId: created.batchId,
    operationKey: payload.operationKey,
    persisted: false,
    operationStatus: 'deleted',
    code: 'ARCHIVE_OPERATION_DELETED'
  });
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(
    repository.getOperationIssuance(payload.moduleId, payload.operationKey),
    issuanceBeforeIntent
  );
  assert.deepEqual(db.prepare(`
    SELECT * FROM archive_batch_sequences
    WHERE module_code = ?
  `).get(payload.moduleCode), cursorBeforeIntent);

  const directReplay = await controller.sink.createBatch({
    ...payload,
    files: [{ filePath: sourcePath, role: 'input' }]
  });
  assert.equal(directReplay.archiveFailed, true);
  assert.equal(directReplay.operationStatus, 'deleted');
  assert.equal(directReplay.code, 'ARCHIVE_OPERATION_DELETED');
  assert.equal(directReplay.batchId, created.batchId);
  assert.equal(directReplay.persistentRetryAvailable, false);
  assert.deepEqual(outboxStore.list(), []);
  assert.equal(repository.getStats().batchCount, 0);
});

test('outbox 重放为部分失败正式批次时不得释放失败文件源路径', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-partial-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const outputPath = path.join(rootDir, 'result.xlsx');
  const releasedPaths = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-partial' },
    files: [
      { filePath: inputPath, role: 'input' },
      { filePath: outputPath, role: 'output' }
    ]
  });
  assert.match(created.batchId, /^outbox:/);

  service.createBatch = async () => ({
    ok: false,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'failed',
      failedArtifactCount: 1
    },
    attempted: 2,
    succeeded: 1,
    failed: 1,
    results: [
      { ok: false, status: 'failed', artifact: { id: 1 } },
      { ok: true, status: 'ready', artifact: { id: 2 } }
    ]
  });
  service.listUnresolvedSourcePaths = () => [inputPath];

  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths, [outputPath]);
  assert.deepEqual(controller.listUnresolvedSourcePaths(), [inputPath]);
});

test('outbox 重放在附件元数据登记前失败时保留任务和源文件', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-outbox-metadata-'));
  const inputPath = path.join(rootDir, 'bank.xlsx');
  const releasedPaths = [];
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({
    outboxStore,
    onOutboxFlushed: (paths) => releasedPaths.push(...paths)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  service.createBatch = async () => ({ ok: false, message: 'archive database busy' });
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:bank:apply-import',
    metadata: { positionOperationToken: 'operation-metadata' },
    files: [{ filePath: inputPath, role: 'input' }]
  });
  assert.match(created.batchId, /^outbox:/);

  service.createBatch = async () => ({
    ok: false,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'failed',
      failedArtifactCount: 1
    },
    attempted: 1,
    succeeded: 0,
    failed: 1,
    results: [{
      ok: false,
      status: 'failed',
      metadataRecorded: true,
      message: 'artifact insert failed'
    }]
  });
  service.listUnresolvedSourcePaths = () => [];

  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);
  assert.equal(outboxStore.list().length, 1);
  assert.deepEqual(controller.listUnresolvedSourcePaths(), [inputPath]);
  assert.deepEqual(releasedPaths, []);

  service.appendFiles = async () => ({
    ok: true,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      archiveStatus: 'complete',
      failedArtifactCount: 0
    },
    attempted: 1,
    succeeded: 1,
    failed: 0,
    results: [{ ok: true, status: 'ready', artifact: { id: 7 } }]
  });
  const flushed = await controller.flushOutbox();
  assert.equal(flushed.flushed, 1);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(releasedPaths, [inputPath]);
});

test('部分附件 ready 且后续登记失败时终态保持不完整，原附件恢复后才完成', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-artifact-gap-'));
  const archiveRoot = path.join(rootDir, 'archive');
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const now = () => new Date(2026, 6, 20, 12, 0, 0);
  const repository = createArchiveRepository(db, { now });
  const originalAddArtifact = repository.addArtifact.bind(repository);
  let artifactRegistrationCount = 0;
  repository.addArtifact = (...args) => {
    artifactRegistrationCount += 1;
    if (artifactRegistrationCount === 2) {
      const error = new Error('injected artifact insert failure');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return originalAddArtifact(...args);
  };
  const service = createArchiveService({ repository, rootDir: archiveRoot, now });
  const settings = new Map();
  const controller = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value)
    },
    service,
    outboxStore
  });
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await service.initialize();

  const firstInput = path.join(rootDir, 'first.xlsx');
  const secondInput = path.join(rootDir, 'second.xlsx');
  fs.writeFileSync(firstInput, 'first-input');
  fs.writeFileSync(secondInput, 'second-input');
  const reserved = await service.reserveTaskBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    taskKey: 'position-reconciliation:run',
    taskRunId: 'artifact-gap-task',
    operationKey: 'position:artifact-gap:task'
  });
  assert.equal(reserved.ok, true);
  const appended = await controller.sink.appendFiles({
    batchId: reserved.batchId,
    sourceOperation: 'position-reconciliation:run',
    files: [
      { filePath: firstInput, role: 'input' },
      { filePath: secondInput, role: 'output', direction: 'output' }
    ]
  });
  assert.equal(appended.archiveFailed, true);
  assert.equal(appended.persistentRetryAvailable, true);
  assert.equal(appended.results[0].status, 'ready');
  assert.equal(appended.results[1].status, 'failed');
  assert.ok(appended.results[1].artifact.id);
  assert.deepEqual(outboxStore.list(), []);
  assert.deepEqual(controller.listUnresolvedSourcePaths(), [secondInput]);

  const terminal = await service.completeTaskBatch(reserved.batchId);
  assert.equal(terminal.batch.taskStatus, 'succeeded');
  assert.equal(terminal.batch.archiveStatus, 'incomplete');
  assert.equal(terminal.batch.failedArtifactCount, 1);
  assert.equal(terminal.batch.lastErrorCode, 'ARCHIVE_SQLITE_BUSY');

  const recovered = await service.retryBatch(reserved.batchId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.succeeded, 1);
  assert.equal(recovered.batch.taskStatus, 'succeeded');
  assert.equal(recovered.batch.archiveStatus, 'complete');
  assert.equal(recovered.batch.failedArtifactCount, 0);
});

test('终态 outbox 按附件、原 task CAS、业务 finalizer、remove 顺序重放且不建 ghost batch', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-position-original-batch-'));
  const archiveRoot = path.join(rootDir, 'archive');
  const outputPath = path.join(rootDir, 'position-result.xlsx');
  fs.writeFileSync(outputPath, 'position-output');
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const now = () => new Date(2026, 6, 20, 12, 0, 0);
  const repository = createArchiveRepository(db, { now });
  const service = createArchiveService({ repository, rootDir: archiveRoot, now });
  const settings = new Map();
  const replayOrder = [];
  const appendFiles = service.appendFiles.bind(service);
  service.appendFiles = async (payload) => {
    replayOrder.push('append');
    return appendFiles(payload);
  };
  const completeTaskBatch = service.completeTaskBatch.bind(service);
  service.completeTaskBatch = async (...args) => {
    replayOrder.push('terminal');
    return completeTaskBatch(...args);
  };
  const remove = outboxStore.remove.bind(outboxStore);
  outboxStore.remove = (id) => {
    replayOrder.push('remove');
    return remove(id);
  };
  const controller = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value)
    },
    service,
    outboxStore,
    async onTerminalIntentFlushed({ route, record, created }) {
      replayOrder.push('finalizer');
      assert.equal(route.route, 'position-reconciliation');
      assert.equal(created.batch.id, Number(record.payload.targetBatchId));
    }
  });
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await service.initialize();
  const reserved = await service.reserveTaskBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    taskKey: 'position-reconciliation:run:export',
    taskRunId: 'position-recovery-token',
    operationKey: 'position:position-recovery-token:run-export',
    parentRunId: 'position-parent'
  });
  await service.markTaskStarted(reserved.batchId);
  const batchContext = {
    batchId: reserved.batchId,
    batchNumber: reserved.batchNumber,
    taskRunId: 'position-recovery-token',
    taskKey: 'position-reconciliation:run:export',
    moduleId: 'position-reconciliation-process',
    parentRunId: 'position-parent',
    operationKey: 'position:position-recovery-token:run-export'
  };
  const intent = controller.persistAppendIntent({
    batchContext,
    sourceOperation: 'position-reconciliation:run:export',
    metadata: { positionOperationToken: 'position-recovery-token' },
    files: [{ filePath: outputPath, role: 'output', beforeSnapshot: null }]
  });
  const getBatch = repository.getBatch.bind(repository);
  const getSetting = controller.database.getSetting;
  repository.getBatch = () => { throw new Error('archive DB unavailable'); };
  controller.database.getSetting = () => { throw new Error('settings DB unavailable'); };
  try {
    controller.persistTaskTerminalIntent({
      batchContext,
      sourceOperation: 'position-reconciliation:run:export',
      terminalOutcome: {
        taskStatus: 'succeeded',
        metadata: { recoveredPositionOperation: true },
        afterTerminal: {
          route: 'position-reconciliation',
          operationToken: 'position-recovery-token'
        }
      }
    });
  } finally {
    repository.getBatch = getBatch;
    controller.database.getSetting = getSetting;
  }
  assert.equal(intent.batchId, reserved.batchId);
  const terminalRecord = outboxStore.list()[0];
  assert.equal(terminalRecord.payload.targetBatchId, reserved.batchId);
  assert.equal(
    terminalRecord.payload.metadata.positionOperationToken,
    terminalRecord.payload.terminalOutcome.afterTerminal.operationToken
  );

  const replay = await controller.flushOutbox();
  assert.equal(replay.flushed, 1);
  assert.deepEqual(replayOrder, ['append', 'terminal', 'finalizer', 'remove']);
  assert.equal(repository.listBatches({ limit: 10, offset: 0 }).length, 1);
  const recovered = repository.getBatchDetail(reserved.batchId);
  assert.equal(recovered.taskStatus, 'succeeded');
  assert.equal(recovered.artifacts.length, 1);
  assert.equal(recovered.artifacts[0].direction, 'output');
  assert.deepEqual(outboxStore.list(), []);

  replayOrder.length = 0;
  controller.persistTaskTerminalIntent({
    batchContext,
    sourceOperation: 'position-reconciliation:run:export',
    terminalOutcome: terminalRecord.payload.terminalOutcome
  });
  const sameTerminalReplay = await controller.flushOutbox();
  assert.equal(sameTerminalReplay.flushed, 1);
  assert.deepEqual(replayOrder, ['append', 'terminal', 'finalizer', 'remove']);
  assert.deepEqual(outboxStore.list(), [], '同终态 replay 幂等完成后应移除 intent');

  const cancelled = await service.reserveTaskBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    taskKey: 'position-reconciliation:run:export',
    taskRunId: 'position-cancelled-token',
    operationKey: 'position:position-cancelled-token:run-export',
    parentRunId: 'position-cancelled-parent'
  });
  await service.markTaskStarted(cancelled.batchId);
  await service.cancelTaskBatch(cancelled.batchId, { reason: 'user cancelled' });
  controller.persistTaskTerminalIntent({
    batchContext: {
      batchId: cancelled.batchId,
      batchNumber: cancelled.batchNumber,
      taskRunId: 'position-cancelled-token',
      taskKey: 'position-reconciliation:run:export',
      moduleId: 'position-reconciliation-process',
      parentRunId: 'position-cancelled-parent',
      operationKey: 'position:position-cancelled-token:run-export'
    },
    sourceOperation: 'position-reconciliation:run:export',
    terminalOutcome: {
      taskStatus: 'succeeded',
      metadata: { recoveredPositionOperation: true },
      afterTerminal: {
        route: 'position-reconciliation',
        operationToken: 'position-cancelled-token'
      }
    }
  });
  replayOrder.length = 0;
  const conflictingReplay = await controller.flushOutbox();
  assert.equal(conflictingReplay.flushed, 0);
  assert.equal(conflictingReplay.remaining, 1);
  assert.deepEqual(replayOrder, ['append', 'terminal']);
  assert.equal(repository.getBatch(cancelled.batchId).taskStatus, 'cancelled');
  assert.equal(outboxStore.list().length, 1, '异终态 intent 必须保留供可见诊断');

  const initializedWithConflict = await controller.initialize();
  assert.equal(initializedWithConflict.ok, true);
  assert.equal(outboxStore.list().length, 1, '普通 terminal conflict 不得让应用陷入启动循环');
});

test('legacy outbox 无 owner/target 且 files=[] 时拒绝发号并保留诊断记录', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-legacy-target-'));
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({ outboxStore });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const record = outboxStore.enqueue({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    taskKey: 'bank-statement:export',
    taskRunId: 'legacy-task-run',
    operationKey: 'legacy-outbox-without-target',
    parentRunId: 'legacy-parent',
    sourceOperation: 'bank-statement:export',
    files: [],
    terminalOutcome: {
      taskStatus: 'succeeded',
      code: '',
      message: '',
      metadata: { recoveredLegacyOutbox: true }
    }
  });

  const replay = await controller.flushOutbox();
  assert.equal(replay.flushed, 0);
  assert.equal(replay.remaining, 1);
  assert.equal((await service.getStats()).stats.batchCount, 0);
  assert.equal(outboxStore.list().length, 1);
  assert.equal(record.payload.targetBatchId, undefined, 'fixture 确认是旧版无 target 记录');
});

test('正式建批或追加的 artifact 与 outbox 同时失败时不得宣称可重试', async () => {
  const brokenOutbox = {
    findByOperationKey: () => null,
    enqueue: () => {
      throw new Error('outbox unavailable');
    },
    listSourcePaths: () => [],
    list: () => []
  };
  const { controller, service } = createHarness({ outboxStore: brokenOutbox });
  const workingCreateBatch = service.createBatch.bind(service);
  service.createBatch = async () => ({
    ok: false,
    created: true,
    batch: {
      id: 1,
      batchNumber: 'POSITION-20260720-001',
      moduleId: 'position-reconciliation-process',
      moduleCode: 'POSITION',
      moduleName: '平盘对账数据处理',
      operationKey: 'position:artifact-gap:double-failure',
      archiveStatus: 'failed'
    },
    results: [{
      ok: false,
      status: 'failed',
      message: 'artifact insert failed'
    }]
  });

  const result = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run',
    operationKey: 'position:artifact-gap:double-failure',
    files: [{ filePath: '/tmp/missing-artifact.xlsx', role: 'input' }]
  });
  assert.equal(result.archiveFailed, true);
  assert.equal(result.persistentRetryAvailable, false);
  assert.equal(result.failureRecorded, false);
  assert.match(result.warning.message, /持久重试任务登记失败/);

  service.createBatch = workingCreateBatch;
  const created = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run',
    operationKey: 'position:artifact-gap:append-double-failure',
    files: [{ filePath: '/tmp/ready-input.xlsx', role: 'input' }]
  });
  assert.equal(created.archiveFailed, false);
  service.appendFiles = async () => ({
    ok: false,
    results: [{
      ok: false,
      status: 'failed',
      message: 'artifact insert failed'
    }]
  });
  const appended = await controller.sink.appendFiles({
    batchId: created.batchId,
    sourceOperation: 'position-reconciliation:run:export',
    files: [{ filePath: '/tmp/missing-output-artifact.xlsx', role: 'output' }]
  });
  assert.equal(appended.archiveFailed, true);
  assert.equal(appended.persistentRetryAvailable, false);
  assert.equal(appended.failureRecorded, false);
  assert.match(appended.warning.message, /持久重试任务登记失败/);
});

test('同一平盘恢复操作重复登记时复用 outbox 并补齐新文件', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-intent-'));
  const inputPath = path.join(rootDir, 'input.xlsx');
  const outputPath = path.join(rootDir, 'output.xlsx');
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller } = createHarness({ outboxStore });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const shared = {
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘对账数据处理',
    sourceOperation: 'position-reconciliation:run:export',
    operationKey: 'position:operation-2:position-reconciliation:run:export'
  };

  const first = controller.persistOperationIntent({
    ...shared,
    files: [{
      filePath: inputPath,
      role: 'input',
      sourceSnapshot: { sizeBytes: 10, mtimeMs: 20, ctimeMs: 30, ino: 40 },
      expectedSha256: 'c'.repeat(64),
      sizeBytes: 10
    }]
  });
  const second = controller.persistOperationIntent({
    ...shared,
    files: [{ filePath: outputPath, role: 'output' }]
  });

  assert.equal(second.batchId, first.batchId);
  assert.deepEqual(
    outboxStore.list()[0].payload.files.map((file) => file.filePath).sort(),
    [inputPath, outputPath].sort()
  );
  const persistedInput = outboxStore.list()[0].payload.files.find(
    (file) => file.filePath === inputPath
  );
  assert.equal(persistedInput.expectedSha256, 'c'.repeat(64));
  assert.equal(persistedInput.expectedSizeBytes, 10);
  assert.deepEqual(
    persistedInput.sourceSnapshot,
    { sizeBytes: 10, mtimeMs: 20, ctimeMs: 30, ino: 40 }
  );
});

test('启动先重放持久终态，再扫尾无终态任务；未重放终态的目标批次保持 active', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-startup-order-'));
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  const { controller, service } = createHarness({ outboxStore });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const completed = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'startup-terminal-completed',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/startup-terminal-completed.xlsx', role: 'input' }]
  });
  const pending = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'startup-terminal-pending',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/startup-terminal-pending.xlsx', role: 'input' }]
  });
  service.repository.getBatch(completed.batchId).taskStatus = 'running';
  service.repository.getBatch(pending.batchId).taskStatus = 'running';

  const terminalPayload = (batchId, operationKey) => ({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey,
    sourceOperation: 'bank-statement:run',
    targetBatchId: batchId,
    files: [],
    terminalOutcome: {
      taskStatus: 'succeeded',
      code: '',
      message: '',
      metadata: {}
    }
  });
  outboxStore.enqueue(terminalPayload(completed.batchId, 'startup-terminal-completed'));
  outboxStore.enqueue(terminalPayload(pending.batchId, 'startup-terminal-pending'));

  const originalAppendFiles = service.appendFiles.bind(service);
  service.appendFiles = async (payload) => {
    if (Number(payload.batchId) === Number(pending.batchId)) {
      throw new Error('模拟 outbox 暂不可重放');
    }
    return originalAppendFiles(payload);
  };
  let excluded = [];
  service.markInterruptedTasks = async (options = {}) => {
    excluded = options.excludeBatchIds || [];
    const excludedSet = new Set(excluded.map(Number));
    const swept = [completed.batchId, pending.batchId].filter((batchId) => {
      const batch = service.repository.getBatch(batchId);
      if (batch.taskStatus !== 'running' || excludedSet.has(Number(batchId))) return false;
      batch.taskStatus = 'failed';
      return true;
    });
    return { ok: true, taskCount: swept.length, batchIds: swept };
  };

  const initialized = await controller.initialize();
  assert.equal(initialized.ok, true);

  assert.equal(service.repository.getBatch(completed.batchId).taskStatus, 'succeeded');
  assert.equal(service.repository.getBatch(pending.batchId).taskStatus, 'running');
  assert.deepEqual(excluded, [pending.batchId]);
  assert.equal(outboxStore.list().length, 1);
  assert.equal(Number(outboxStore.list()[0].payload.targetBatchId), Number(pending.batchId));
});

test('启动先给模块 owner 恢复原批次，再仅扫尾无人认领任务', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-owner-recovery-'));
  const outboxStore = createArchiveOutboxStore(path.join(rootDir, 'outbox'));
  let recoverCalls = 0;
  let protectedBatchId = 0;
  const { controller, service } = createHarness({
    outboxStore,
    recoverInterruptedTasks: async () => {
      recoverCalls += 1;
      service.repository.getBatch(protectedBatchId).taskStatus = 'succeeded';
    },
    getProtectedInterruptedTaskBatchIds: () => [protectedBatchId]
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const recoverable = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘资金性质校验',
    operationKey: 'position-owner-recovery',
    sourceOperation: 'position-reconciliation:run',
    files: [{ filePath: '/tmp/position-owner-recovery.xlsx', role: 'input' }]
  });
  const orphan = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'orphan-running-task',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/orphan-running-task.xlsx', role: 'input' }]
  });
  protectedBatchId = recoverable.batchId;
  service.repository.getBatch(recoverable.batchId).taskStatus = 'running';
  service.repository.getBatch(orphan.batchId).taskStatus = 'running';

  let excluded = [];
  service.markInterruptedTasks = async (options = {}) => {
    excluded = options.excludeBatchIds || [];
    const excludedSet = new Set(excluded.map(Number));
    const swept = [recoverable.batchId, orphan.batchId].filter((batchId) => {
      const batch = service.repository.getBatch(batchId);
      if (!['reserved', 'running'].includes(batch.taskStatus)
          || excludedSet.has(Number(batchId))) return false;
      batch.taskStatus = 'failed';
      return true;
    });
    return { ok: true, taskCount: swept.length, batchIds: swept };
  };

  await controller.initialize();

  assert.equal(recoverCalls, 1);
  assert.equal(service.repository.getBatch(recoverable.batchId).taskStatus, 'succeeded');
  assert.equal(service.repository.getBatch(orphan.batchId).taskStatus, 'failed');
  assert.deepEqual(excluded, [recoverable.batchId]);
});

test('模块 owner 恢复失败时保留其原批次且仍扫尾其他孤儿任务', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-owner-recovery-failure-'));
  const warnings = [];
  let protectedBatchId = 0;
  const { controller, service } = createHarness({
    recoverInterruptedTasks: async () => {
      throw Object.assign(new Error('position recovery unavailable'), {
        code: 'POSITION_RECOVERY_FAILED'
      });
    },
    getProtectedInterruptedTaskBatchIds: () => [protectedBatchId],
    logWarning: (...args) => warnings.push(args)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const recoverable = await controller.sink.createBatch({
    moduleId: 'position-reconciliation-process',
    moduleCode: 'POSITION',
    moduleName: '平盘资金性质校验',
    operationKey: 'position-owner-recovery-failure',
    sourceOperation: 'position-reconciliation:run',
    files: [{ filePath: '/tmp/position-owner-recovery-failure.xlsx', role: 'input' }]
  });
  const orphan = await controller.sink.createBatch({
    moduleId: 'bank-statement',
    moduleCode: 'BANK',
    moduleName: '网银账单',
    operationKey: 'orphan-after-owner-recovery-failure',
    sourceOperation: 'bank-statement:run',
    files: [{ filePath: '/tmp/orphan-owner-recovery-failure.xlsx', role: 'input' }]
  });
  protectedBatchId = recoverable.batchId;
  service.repository.getBatch(recoverable.batchId).taskStatus = 'running';
  service.repository.getBatch(orphan.batchId).taskStatus = 'running';

  let excluded = [];
  service.markInterruptedTasks = async (options = {}) => {
    excluded = options.excludeBatchIds || [];
    const excludedSet = new Set(excluded.map(Number));
    const swept = [recoverable.batchId, orphan.batchId].filter((batchId) => {
      const batch = service.repository.getBatch(batchId);
      if (!['reserved', 'running'].includes(batch.taskStatus)
          || excludedSet.has(Number(batchId))) return false;
      batch.taskStatus = 'failed';
      return true;
    });
    return { ok: true, taskCount: swept.length, batchIds: swept };
  };

  const initialized = await controller.initialize();

  assert.notEqual(initialized && initialized.available, false);
  assert.equal(service.repository.getBatch(recoverable.batchId).taskStatus, 'running');
  assert.equal(service.repository.getBatch(orphan.batchId).taskStatus, 'failed');
  assert.deepEqual(excluded, [recoverable.batchId]);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /模块任务恢复未完全成功/);
  assert.equal(warnings[0][1].code, 'POSITION_RECOVERY_FAILED');
});

test('多个模块 owner 逐项 settle，失败互不短路且分别上报', async () => {
  const warnings = [];
  const calls = [];
  const { controller } = createHarness({
    recoverInterruptedTaskOwners: [
      {
        ownerName: 'Position',
        recover: async () => {
          calls.push('position');
          throw Object.assign(new Error('position recovery unavailable'), {
            code: 'POSITION_RECOVERY_FAILED'
          });
        }
      },
      {
        ownerName: 'Toolbox',
        recover: async () => {
          calls.push('toolbox');
          throw Object.assign(new Error('toolbox recovery unavailable'), {
            code: 'TOOLBOX_RECOVERY_FAILED'
          });
        }
      }
    ],
    logWarning: (...args) => warnings.push(args)
  });

  await controller.initialize();

  assert.deepEqual(calls, ['position', 'toolbox']);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0][0], /Position/);
  assert.equal(warnings[0][1].code, 'POSITION_RECOVERY_FAILED');
  assert.match(warnings[1][0], /Toolbox/);
  assert.equal(warnings[1][1].code, 'TOOLBOX_RECOVERY_FAILED');
});

test('startup hook 严格位于 owner/outbox/flow/sweep/raw maintenance 后和 retention 前', async () => {
  const order = [];
  const { controller, service } = createHarness({
    recoverInterruptedTaskOwners: [{
      ownerName: 'VCC import terminal',
      recover: async () => { order.push('owner'); }
    }],
    postOutboxStartupHooks: [{
      hookName: 'VCC lineage/hold reconcile',
      run: async () => {
        order.push('hook');
        const error = new Error('VCC lineage unavailable');
        error.code = 'VCC_ARCHIVE_LINEAGE_UNAVAILABLE';
        throw error;
      }
    }]
  });
  controller.flushOutbox = async () => {
    order.push('post-owner-outbox');
    return { flushed: 0, discarded: 0, remaining: 0 };
  };
  service.replayFlowBindIntents = async () => {
    order.push('batch-flow');
    return { ok: true, replayed: 0, remaining: 0 };
  };
  service.replayTaskFlowBindIntents = async () => {
    order.push('task-flow');
    return { ok: true, replayed: 0, remaining: 0 };
  };
  service.markInterruptedTasks = async () => {
    order.push('sweep');
    return { ok: true, taskCount: 0, batchIds: [] };
  };
  service.reconcileStartup = async () => {
    order.push('raw-maintenance');
    return { ok: true, status: 'complete' };
  };
  service.cleanupExpired = async () => {
    order.push('cleanup');
    return { ok: true };
  };

  await assert.rejects(
    controller.initialize(),
    (error) => error && error.code === 'ARCHIVE_STARTUP_HOOK_FAILED'
  );
  assert.deepEqual(order, [
    'owner',
    'post-owner-outbox',
    'batch-flow',
    'task-flow',
    'sweep',
    'raw-maintenance',
    'hook'
  ]);
});

test('无 StorageRootManager 时 defer 初始化后按固定顺序恢复，最后才启动后台维护', async () => {
  const order = [];
  const { controller, service } = createHarness({
    recoverInterruptedTaskOwners: [{
      ownerName: 'owner',
      recover: async () => { order.push('owner'); }
    }]
  });
  service.initialize = async (options) => {
    assert.equal(options.deferStartupRecovery, true);
    order.push('foundation');
    return { ok: true, available: true };
  };
  controller.flushOutbox = async () => {
    order.push('outbox');
    return { flushed: 0, discarded: 0, remaining: 0 };
  };
  service.replayFlowBindIntents = async () => {
    order.push('batch-flow');
    return { ok: true };
  };
  service.replayTaskFlowBindIntents = async () => {
    order.push('task-flow');
    return { ok: true };
  };
  service.markInterruptedTasks = async () => {
    order.push('sweep');
    return { ok: true };
  };
  service.reconcileStartup = async () => {
    order.push('raw-maintenance');
    return { ok: true };
  };
  service.cleanupExpired = async () => {
    order.push('retention');
    return { ok: true };
  };
  service.resumeBackgroundMaterialization = () => { order.push('background'); };

  await controller.initialize();
  assert.deepEqual(order, [
    'foundation',
    'owner',
    'outbox',
    'batch-flow',
    'task-flow',
    'sweep',
    'raw-maintenance',
    'retention',
    'background'
  ]);
});

test('恢复批次清单读取失败时跳过通用扫尾并 fail-closed 阻止启动', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-controller-owner-list-failure-'));
  const warnings = [];
  const { controller, service } = createHarness({
    getProtectedInterruptedTaskBatchIds: async () => {
      throw Object.assign(new Error('side database offline'), {
        code: 'RECOVERY_EVIDENCE_UNAVAILABLE'
      });
    },
    logWarning: (...args) => warnings.push(args)
  });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const active = await controller.sink.createBatch({
    moduleId: 'acquiring-bill-currency',
    moduleCode: 'ACQUIRING',
    moduleName: '收单账单币种校验',
    operationKey: 'recoverable-evidence-offline',
    sourceOperation: 'acquiringBillCurrency:run',
    files: [{ filePath: '/tmp/acquiring-recovery-evidence.xlsx', role: 'input' }]
  });
  service.repository.getBatch(active.batchId).taskStatus = 'running';
  let sweepCalls = 0;
  service.markInterruptedTasks = async () => {
    sweepCalls += 1;
    return { ok: true, taskCount: 1, batchIds: [active.batchId] };
  };

  await assert.rejects(
    controller.initialize(),
    (error) => error && error.code === 'ARCHIVE_STARTUP_RECOVERY_EVIDENCE_UNAVAILABLE'
  );

  assert.equal(sweepCalls, 0);
  assert.equal(service.repository.getBatch(active.batchId).taskStatus, 'running');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /跳过本次异常任务扫尾/);
  assert.equal(warnings[0][1].code, 'RECOVERY_EVIDENCE_UNAVAILABLE');
});
