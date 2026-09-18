'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');

const owner = {
  version: 1,
  kind: 'file-batch',
  batchContext: {
    batchId: 3, batchNumber: '2026-09-11-003', taskRunId: 'completed-file-task',
    taskKey: 'toolbox:merge', moduleId: 'toolbox', parentRunId: 'completed-parent',
    operationKey: 'completed-operation'
  }
};

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-delete-owner-proof-'));
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  const repository = createArchiveRepository(db);
  repository.ensureSchema();
  const archiveInstanceId = repository.getOrCreateArchiveInstanceId();
  const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
  let finishCalls = 0;
  let finalizerCalls = 0;
  const service = {
    repository, createBatch: async () => ({}), appendFiles: async () => ({}),
    finishFileTask: async () => { finishCalls += 1; throw new Error('已删除批次不可再 finishFileTask'); }
  };
  const controller = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service, outboxStore,
    onTerminalIntentFlushed: async () => { finalizerCalls += 1; }
  });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, repository, archiveInstanceId, outboxStore, controller,
    counts: () => ({ finishCalls, finalizerCalls }) };
}

test('原 owner 收口凭证持久化完整身份，异终态和异 afterTerminal 不可覆盖', (t) => {
  const { db, repository, archiveInstanceId } = createFixture(t);
  const payload = { owner, archiveInstanceId, terminalStatus: 'cancelled',
    afterTerminal: { route: 'position-reconciliation', operationToken: 'completed-original' } };
  repository.recordOwnerTerminalCompletion(payload);
  const reopenedRepository = createArchiveRepository(db);
  assert.deepEqual(reopenedRepository.getOwnerTerminalCompletion(owner).owner, owner);
  assert.throws(() => repository.recordOwnerTerminalCompletion({ ...payload, terminalStatus: 'succeeded' }),
    { code: 'ARCHIVE_OWNER_COMPLETION_CONFLICT' });
  assert.throws(() => repository.recordOwnerTerminalCompletion({ ...payload,
    afterTerminal: { route: 'position-reconciliation', operationToken: 'different-owner' } }),
  { code: 'ARCHIVE_OWNER_COMPLETION_CONFLICT' });
  assert.equal(repository.getOwnerTerminalCompletion({ ...owner,
    batchContext: { ...owner.batchContext, taskRunId: 'different-task' } }), null);
});

test('已删 File Task 仅在实例、完整 owner、终态和后处理证明匹配时 ACK 迟到重复通知', async (t) => {
  for (const mode of ['complete', 'pending-cleanup', 'missing-proof', 'different-status', 'different-route', 'different-instance']) {
    await t.test(mode, async (t) => {
      const fixture = createFixture(t);
      const { controller, repository, archiveInstanceId, outboxStore } = fixture;
      const afterTerminal = { route: 'position-reconciliation', operationToken: 'completed-original' };
      if (mode !== 'missing-proof') repository.recordOwnerTerminalCompletion({ owner, archiveInstanceId,
        terminalStatus: 'cancelled', afterTerminal });
      repository.getDeletionReceipt = () => mode === 'pending-cleanup' ? null : ({
        archiveInstanceId: mode === 'different-instance' ? 'other-instance' : archiveInstanceId
      });
      repository.getCleanupJobForBatch = () => mode === 'pending-cleanup' ? { archiveInstanceId } : null;
      controller.persistTaskTerminalIntent({ owner, terminalOutcome: {
        taskStatus: mode === 'different-status' ? 'succeeded' : 'cancelled',
        afterTerminal: mode === 'different-route'
          ? { ...afterTerminal, operationToken: 'different-original' } : afterTerminal
      } });
      const result = await controller.flushOutbox();
      const expected = mode === 'complete' || mode === 'pending-cleanup';
      assert.equal(result.remaining, expected ? 0 : 1);
      assert.equal(outboxStore.list().length, expected ? 0 : 1);
      assert.deepEqual(fixture.counts(), { finishCalls: 0, finalizerCalls: 0 });
    });
  }
});

test('终态已写但原 afterTerminal 失败时不记录收口证明、不 ACK', async (t) => {
  const { controller, repository, archiveInstanceId, outboxStore } = createFixture(t);
  repository.getBatch = () => ({ id: owner.batchContext.batchId });
  repository.getTaskRun = () => ({ status: 'cancelled' });
  controller.service.finishFileTask = async () => ({ ok: true, batch: { id: 3 } });
  controller.onTerminalIntentFlushed = async () => { throw new Error('原恢复尚未完成'); };
  controller.persistTaskTerminalIntent({ owner, terminalOutcome: { taskStatus: 'cancelled',
    afterTerminal: { route: 'position-reconciliation', operationToken: 'completed-original' } } });
  assert.equal((await controller.flushOutbox()).remaining, 1);
  assert.equal(repository.getOwnerTerminalCompletion(owner), null);
  controller.onTerminalIntentFlushed = async () => {};
  assert.equal((await controller.flushOutbox()).remaining, 0);
  assert.equal(repository.getOwnerTerminalCompletion(owner).archiveInstanceId, archiveInstanceId);
  assert.equal(outboxStore.list().length, 0);
});

test('真实 FileTask 正常完成后由原生命周期登记证明，删除后迟到重复终态安全 ACK', async (t) => {
  const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
  const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
  const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lifecycle-delete-replay-'));
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  const sourcePath = path.join(directory, 'input.xlsx');
  fs.writeFileSync(sourcePath, 'archive-lifecycle-input');
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
  const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
  const controller = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service, outboxStore
  });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await service.initialize()).ok, true);
  const lifecycle = createTaskLifecycle({
    archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'real-owner' }), end() {} },
    flowResolver: {
      resolve: async () => ({ parentRunId: 'real-parent', source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true })
    },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
  });
  const policy = {
    channel: 'toolbox:merge', scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱',
    taskKey: 'toolbox:merge', startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file', allocation: 'eager',
    resultClassifier: () => 'succeeded'
  };
  let batchContext;
  let afterTerminalCalls = 0;
  const result = await lifecycle.runFileTask({
    policy, meta: { channel: policy.channel }, taskRunId: 'real-file-task', operationKey: 'real-file-operation',
    filePlanResolver: () => normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: policy.channel }], outputs: [] }),
    afterTerminal: async () => {
      const pendingDelete = await controller.prepareDeleteBatch(batchContext.batchId);
      assert.equal(pendingDelete.code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED', '原后处理未完成时禁止删除');
      afterTerminalCalls += 1;
    },
    execute: async (context) => { batchContext = context; return { status: 'success' }; }
  });
  assert.equal(result.status, 'success');
  assert.equal(afterTerminalCalls, 1);
  const fullOwner = { version: 1, kind: 'file-batch', batchContext };
  const proof = service.repository.getOwnerTerminalCompletion(fullOwner);
  assert.equal(proof.terminalStatus, 'succeeded');
  assert.equal(proof.afterTerminal, null, '原 owner 已完成已知匿名后处理，未凭空生成恢复路由');
  const prepared = await controller.prepareDeleteBatch(batchContext.batchId);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const deleted = await controller.deleteBatch(batchContext.batchId, prepared.confirmationToken);
  assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
  assert.equal(fs.existsSync(sourcePath), true, '外部导入原文件保留');
  assert.equal(service.repository.getBatch(batchContext.batchId), null);
  controller.persistTaskTerminalIntent({ owner: fullOwner, terminalOutcome: { taskStatus: 'succeeded' } });
  const originalFinish = service.finishFileTask;
  service.finishFileTask = async () => { throw new Error('迟到已删通知禁止调用 finishFileTask'); };
  assert.equal((await controller.flushOutbox()).remaining, 0);
  service.finishFileTask = originalFinish;
  assert.equal(afterTerminalCalls, 1);
  assert.equal(outboxStore.list().length, 0);
});

test('匿名后处理尚未完成的持久通知不误认成无需后处理，内部标记不进入 Task metadata', async (t) => {
  const { controller, repository, outboxStore } = createFixture(t);
  repository.getBatch = () => ({ id: owner.batchContext.batchId });
  repository.getTaskRun = () => ({ status: 'cancelled' });
  let writtenOutcome;
  controller.service.finishFileTask = async (_taskRunId, _batchId, outcome) => {
    writtenOutcome = outcome;
    return { ok: true, batch: { id: 3 } };
  };
  controller.persistTaskTerminalIntent({ owner, terminalOutcome: {
    taskStatus: 'cancelled', metadata: { visible: 'preserved', _archiveAfterTerminalPending: true }
  } });
  assert.equal((await controller.flushOutbox()).remaining, 1);
  assert.deepEqual(writtenOutcome.metadata, { visible: 'preserved' });
  assert.equal(repository.getOwnerTerminalCompletion(owner), null);
  assert.equal(outboxStore.list()[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, true);
});


test('artifact 未耐久时 eager/deferred 都保留原后处理责任，具备恢复路由才可自动收口', async (t) => {
  const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
  const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
  const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
  for (const allocation of ['eager', 'deferred']) {
    for (const afterTerminalMode of ['anonymous', 'routed', 'none']) {
      await t.test(`${allocation}/${afterTerminalMode}`, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-delayed-owner-'));
        const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
        t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
        const sourcePath = path.join(directory, 'input.xlsx');
        fs.writeFileSync(sourcePath, 'delayed-owner-input');
        const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
        await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
        const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
        let callbackCalls = 0;
        let routeCalls = 0;
        const controller = createArchiveCenterController({
          database: { getSetting: () => null, setSetting() {} }, service, outboxStore,
          onTerminalIntentFlushed: async () => { routeCalls += 1; }
        });
        const lifecycle = createTaskLifecycle({
          archiveService: service,
          businessOperationRegistry: { begin: () => ({ accepted: true, token: 'delayed-owner' }), end() {} },
          flowResolver: {
            resolve: async () => ({ parentRunId: 'delayed-parent', source: 'new', identity: null }),
            bind: async () => [], persistBindIntent: async () => ({ ok: true })
          },
          operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
          persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
        });
        const originalSettle = service.settleManifestArtifacts.bind(service);
        let firstSettle = true;
        service.settleManifestArtifacts = async (...args) => {
          if (firstSettle) {
            firstSettle = false;
            return { ok: false, durable: false, code: 'EACCES', message: '临时存档失败' };
          }
          return originalSettle(...args);
        };
        const channel = 'toolbox:merge';
        const eagerPlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
          inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: channel }], outputs: [] });
        const initialPlan = allocation === 'eager' ? eagerPlan
          : normalizeFilePlanV1({ version: 1, allocation: 'deferred', inputs: [], outputs: [] });
        let batchContext;
        const payload = {
          policy: { channel, scopeId: 'toolbox', moduleCode: 'TOOL', moduleName: '工具箱', taskKey: channel,
            startsNewFlow: true, batchPolicy: 'reserve', taskKind: 'file', allocation, resultClassifier: () => 'succeeded' },
          taskRunId: 'delayed-file-task', operationKey: 'delayed-file-operation',
          filePlanResolver: () => initialPlan,
          ...(afterTerminalMode === 'none' ? {} : { afterTerminal: async () => { callbackCalls += 1; } }),
          ...(afterTerminalMode === 'routed' ? { afterTerminalIntent: { route: 'position-reconciliation', operationToken: 'original-route' } } : {}),
          execute: async (context, controls) => {
            batchContext = allocation === 'eager' ? context
              : await controls.ensureFileBatch(artifactManifestFromFilePlan(eagerPlan));
            return { status: 'success' };
          }
        };
        const result = await lifecycle[allocation === 'eager' ? 'runFileTask' : 'runDeferredFileTask'](payload);
        assert.equal(result.status, 'success');
        assert.equal(callbackCalls, 0, '存档未完成时不能提前执行原后处理');
        assert.equal(outboxStore.list().length, 1);
        const persisted = outboxStore.list()[0].payload.terminalOutcome;
        assert.equal(persisted.metadata._archiveAfterTerminalPending === true, afterTerminalMode === 'anonymous');
        const fullOwner = { version: 1, kind: 'file-batch', batchContext };
        const flushed = await controller.flushOutbox();
        const blocked = afterTerminalMode === 'anonymous';
        assert.equal(flushed.remaining, blocked ? 1 : 0);
        assert.equal(routeCalls, afterTerminalMode === 'routed' ? 1 : 0);
        assert.equal(Boolean(service.repository.getOwnerTerminalCompletion(fullOwner)), !blocked);
        const prepared = await controller.prepareDeleteBatch(batchContext.batchId);
        assert.equal(prepared.ok === true, !blocked, JSON.stringify(prepared));
        if (blocked) {
          assert.equal(prepared.code, 'ARCHIVE_DELETE_OWNER_PENDING');
          // 原 owner 恢复回调完成后登记同一凭证；剩余通知才可幂等 ACK。
          await lifecycle._completeFileOwnerAfterTerminal(batchContext, channel,
            { taskStatus: 'succeeded', metadata: {} }, payload, { context: batchContext, terminalStatus: 'succeeded' });
          assert.equal(callbackCalls, 1);
          assert.equal((await controller.flushOutbox()).remaining, 0);
          assert.equal((await controller.prepareDeleteBatch(batchContext.batchId)).ok, true);
        }
      });
    }
  }
});


test('工具箱真实发布恢复在清理完成后记录 owner 凭证，凭证和 receipt 收尾中断均可重启恢复', async (t) => {
  const crypto = require('node:crypto');
  const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
  const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
  const { JOURNAL_INDEX_NAME, prepareToolboxPublication, publishPreparedToolboxPublication,
    recoverPendingToolboxPublications } = require('../../../src/main-process/toolbox-output-publication');
  const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
  for (const interruption of ['none', 'before-cleanup', 'before-proof', 'after-proof', 'routed-outbox', 'routed-proof', 'unknown-owner']) {
    await t.test(interruption, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-owner-recovery-'));
      const userDataDir = path.join(directory, 'user-data');
      const outputDir = path.join(directory, 'output');
      fs.mkdirSync(userDataDir); fs.mkdirSync(outputDir);
      const databasePath = path.join(userDataDir, 'archive.sqlite');
      const inputPath = path.join(directory, 'input.xlsx');
      const generationPath = path.join(directory, 'generation', 'generated.xlsx');
      fs.mkdirSync(path.dirname(generationPath));
      const outputPath = path.join(outputDir, 'result.xlsx');
      fs.writeFileSync(inputPath, 'original-input');
      fs.writeFileSync(generationPath, 'published-result');
      fs.writeFileSync(outputPath, 'old-result');
      let db;
      let service;
      let controller;
      const openArchive = async () => {
        db = new DatabaseSync(databasePath);
        service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
        await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
        controller = createArchiveCenterController({ database: { getSetting: () => null, setSetting() {} }, service,
          outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
      };
      t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
      await openArchive();
      const channel = interruption === 'unknown-owner' ? 'toolbox:unknown-owner' : 'toolbox:merge';
      const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
        inputs: [{ filePath: inputPath, role: 'input', sourceOperation: channel }],
        outputs: [{ filePath: outputPath, role: 'output', sourceOperation: channel }] });
      const taskRun = (await service.beginTaskRun({ taskRunId: 'toolbox-owner-task', taskKey: channel,
        moduleId: 'toolbox', operationKey: 'toolbox-owner-operation', parentRunId: 'toolbox-owner-parent' })).taskRun;
      const { batch } = await service.reserveFileTaskBatch({ taskRun, manifest: artifactManifestFromFilePlan(plan),
        moduleCode: 'TOOL', moduleName: '工具箱' });
      const batchContext = { batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: taskRun.taskRunId,
        taskKey: taskRun.taskKey, moduleId: taskRun.moduleId, operationKey: taskRun.operationKey, parentRunId: taskRun.parentRunId };
      await service.startFileTask(taskRun.taskRunId, batch.id);
      const prepared = prepareToolboxPublication({ taskId: 'owner-publication', userDataDir, batchContext,
        requireArchiveHandoff: true, requireValidatedArtifacts: true, archiveInputFiles: plan.inputs,
        protectedSourcePaths: [inputPath],
        artifacts: [{ sourcePath: generationPath, byteSize: fs.statSync(generationPath).size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(generationPath)).digest('hex') }],
        targets: [outputPath] });
      publishPreparedToolboxPublication(prepared);
      const fullOwner = { version: 1, kind: 'file-batch', batchContext };
      const routed = interruption === 'routed-outbox' || interruption === 'routed-proof';
      const afterTerminalRoute = { route: 'position-reconciliation', operationToken: 'original-owner-route' };
      let routedCalls = 0;
      if (routed) {
        controller.onTerminalIntentFlushed = async () => { routedCalls += 1; };
        if (interruption === 'routed-outbox') {
          controller.persistTaskTerminalIntent({ owner: fullOwner,
            terminalOutcome: { taskStatus: 'succeeded', afterTerminal: afterTerminalRoute } });
        } else {
          await service.settleManifestArtifacts({ batchContext,
            files: [...plan.inputs, ...plan.outputs].map((file) => ({ artifactKey: file.artifactKey })) });
          await service.finishFileTask(batchContext.taskRunId, batchContext.batchId, { taskStatus: 'succeeded' });
          await service.recordFileTaskOwnerCompletion(batchContext,
            { terminalStatus: 'succeeded', afterTerminal: afterTerminalRoute });
        }
      }
      const originalRecord = service.recordFileTaskOwnerCompletion.bind(service);
      if (interruption === 'before-proof') {
        service.recordFileTaskOwnerCompletion = async () => { throw new Error('凭证写入前进程退出'); };
      }
      const runRecovery = () => recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller,
        recoverPublications: async (options) => {
          if (options.acknowledgedCommittedTaskIds && (
            interruption === 'before-cleanup' && options.deferCommittedFinalization
            || interruption === 'after-proof' && !options.deferCommittedFinalization
          )) throw new Error('发布恢复进程退出');
          return recoverPendingToolboxPublications(options);
        } });
      if (!interruption.startsWith('before-') && interruption !== 'after-proof') {
        await runRecovery();
      } else {
        await assert.rejects(runRecovery(), (error) => error.blocksArchiveStartup === true);
        const index = JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8'));
        assert.equal(index.entries.length, 1, '原发布恢复证据必须保留');
        assert.equal(index.entries[0].discoveryState,
          interruption === 'before-cleanup' ? 'prepared' : 'finalizing');
        assert.equal(Boolean(service.repository.getOwnerTerminalCompletion(fullOwner)), interruption === 'after-proof');
        if (interruption !== 'before-cleanup') {
          assert.deepEqual(fs.readdirSync(outputDir).filter((name) => name.endsWith('.backup') || name.endsWith('.stage')), []);
        }
        service.recordFileTaskOwnerCompletion = originalRecord;
        db.close();
        await openArchive();
        await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller });
      }
      if (interruption === 'routed-outbox') {
        assert.equal(service.repository.getOwnerTerminalCompletion(fullOwner), null, 'publication 不能认证其他原 owner 的路由已完成');
        assert.equal(routedCalls, 0);
        assert.equal((await controller.flushOutbox()).remaining, 0);
        assert.equal(routedCalls, 1);
      }
      const proof = service.repository.getOwnerTerminalCompletion(fullOwner);
      if (interruption === 'unknown-owner') {
        assert.equal(proof, null, '未知任务后处理不能按共享 publisher 猜测为已完成');
        assert.equal((await controller.prepareDeleteBatch(batch.id)).code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
        return;
      }
      assert.equal(proof.terminalStatus, 'succeeded');
      assert.deepEqual(proof.afterTerminal, routed ? afterTerminalRoute : null);
      assert.equal(controller.outboxStore.list().length, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries, []);
      assert.equal(fs.existsSync(prepared.journalPath), false);
      const deletePreparation = await controller.prepareDeleteBatch(batch.id);
      assert.equal(deletePreparation.ok, true, JSON.stringify(deletePreparation));
      assert.equal((await controller.deleteBatch(batch.id, deletePreparation.confirmationToken)).fullyDeleted, true);
      assert.equal(fs.readFileSync(inputPath, 'utf8'), 'original-input');
      assert.equal(fs.readFileSync(outputPath, 'utf8'), 'published-result');
    });
  }
});

test('publication owner 仅匹配 Main 登记的精确 taskKey/moduleId，不认未知共享 Publisher 入口', () => {
  const { isPublicationOnlyFileTask } = require('../../../src/main-process/toolbox-archive-recovery');
  const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
  const registry = createTaskPolicyRegistry();
  for (const channel of ['toolbox:merge', 'toolbox:split:export', 'vccFinancialOp:data-manager:export',
    'vccFinancialOp:export:import-audit', 'vccFinancialOp:export:result',
    'pending:error:export-report', 'pending:diff:export-single', 'pending:diff:export-aggregate',
    'bizOpRecon:export:date', 'bizOpRecon:export:date-range', 'pre-fund-reconciliation:export', 'acquiringBillCurrency:export']) {
    const policy = registry.require(channel);
    assert.equal(isPublicationOnlyFileTask({ taskKey: policy.taskKey, moduleId: policy.scopeId }), true);
    assert.equal(isPublicationOnlyFileTask({ taskKey: policy.taskKey, moduleId: 'different-owner' }), false);
  }
  assert.equal(isPublicationOnlyFileTask({ taskKey: 'vccFinancialOp:export:unknown', moduleId: 'vcc-financial-op' }), false);
  assert.equal(isPublicationOnlyFileTask({ taskKey: 'position-reconciliation:source:export-anomaly',
    moduleId: 'position-reconciliation-process' }), false);
  assert.equal(isPublicationOnlyFileTask(), false);
});

test('VCC 与只读导出真实 policy 的临时归档失败由原 publication 恢复，匿名通知安全 ACK 后可初始化和删除', async (t) => {
  const crypto = require('node:crypto');
  const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
  const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
  const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
  const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
  const { JOURNAL_INDEX_NAME, prepareToolboxPublication, publishPreparedToolboxPublication } = require('../../../src/main-process/toolbox-output-publication');
  const { acknowledgeToolboxPublicationReceipts, recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
  for (const channel of ['vccFinancialOp:data-manager:export', 'vccFinancialOp:export:import-audit', 'vccFinancialOp:export:result',
    'pending:error:export-report', 'pending:diff:export-single', 'pending:diff:export-aggregate',
    'bizOpRecon:export:date', 'bizOpRecon:export:date-range', 'pre-fund-reconciliation:export', 'acquiringBillCurrency:export']) {
    await t.test(channel, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-publication-owner-'));
      const userDataDir = path.join(directory, 'user-data');
      fs.mkdirSync(userDataDir);
      const sourcePath = path.join(directory, 'generation', 'generated.xlsx');
      const outputPath = path.join(directory, 'output.xlsx');
      fs.mkdirSync(path.dirname(sourcePath));
      fs.writeFileSync(sourcePath, 'vcc-validated-output');
      let db;
      let service;
      let controller;
      const openArchive = async () => {
        db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
        service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
        await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
        controller = createArchiveCenterController({ database: { getSetting: () => null, setSetting() {} }, service,
          outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')) });
      };
      await openArchive();
      t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
      const policy = createTaskPolicyRegistry().require(channel);
      const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
        outputs: [{ filePath: outputPath, role: 'output', sourceOperation: channel }] });
      const lifecycle = createTaskLifecycle({ archiveService: service,
        businessOperationRegistry: { begin: () => ({ accepted: true, token: 'vcc-publication' }), end() {} },
        flowResolver: { resolve: async () => ({ parentRunId: 'vcc-parent', source: 'new', identity: null }),
          bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
        operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
        persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
      service.settleManifestArtifacts = async () => ({ ok: false, durable: false, code: 'EACCES' });
      let batchContext;
      let normalCallbackCalls = 0;
      const result = await lifecycle.runFileTask({ policy, taskRunId: 'vcc-task', operationKey: 'vcc-operation',
        filePlanResolver: () => plan,
        execute: async (context) => {
          batchContext = context;
          const prepared = prepareToolboxPublication({ taskId: 'vcc-publication', userDataDir, batchContext,
            requireArchiveHandoff: true, requireValidatedArtifacts: true, allowEmptyArchiveInputs: true,
            artifacts: [{ sourcePath, byteSize: fs.statSync(sourcePath).size,
              sha256: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') }], targets: [outputPath] });
          publishPreparedToolboxPublication(prepared);
          return { status: 'success' };
        },
        afterTerminal: async () => {
          normalCallbackCalls += 1;
          return acknowledgeToolboxPublicationReceipts({ userDataDir, archiveCenter: controller, taskIds: ['vcc-publication'] });
        }
      });
      assert.equal(result.status, 'success');
      assert.equal(normalCallbackCalls, 0);
      const pending = controller.outboxStore.list();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, true);
      db.close();
      await openArchive();
      const recovery = await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller });
      assert.deepEqual(recovery.recovered.map((row) => row.action), ['commit-cleanup']);
      const fullOwner = { version: 1, kind: 'file-batch', batchContext };
      const proof = service.repository.getOwnerTerminalCompletion(fullOwner);
      assert.equal(proof.terminalStatus, 'succeeded');
      assert.equal(proof.afterTerminal, null);
      assert.equal((await controller.flushOutbox()).remaining, 0);
      assert.equal((await controller.initialize()).ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME))).entries, []);
      const preparation = await controller.prepareDeleteBatch(batchContext.batchId);
      assert.equal(preparation.ok, true, JSON.stringify(preparation));
      assert.equal((await controller.deleteBatch(batchContext.batchId, preparation.confirmationToken)).fullyDeleted, true);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), 'vcc-validated-output');
      assert.equal((await recoverToolboxPublicationsIntoArchive({ userDataDir, archiveCenter: controller })).recovered.length, 0);
    });
  }
});
