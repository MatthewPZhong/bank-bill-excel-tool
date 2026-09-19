'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const runDataStore = require('../../../src/backend/run-data-store');
const acquiringRunRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');
const acquiringRunData = require('../../../src/main-process/acquiring-bill-currency-run-data');

const crash = () => { throw Object.assign(new Error('模拟进程退出边界'), { code: 'SIMULATED_CRASH' }); };
const rowCount = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
function ownerOf(batch) {
  return { version: 1, kind: 'file-batch', batchContext: Object.fromEntries([
    ['batchId', batch.id], ...['batchNumber', 'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey']
      .map((field) => [field, batch[field]])
  ]) };
}

async function fixture(t, allocation = 'eager', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-owner-recovery-'));
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  const rootDir = path.join(directory, 'archive');
  const service = createArchiveService({ database: db, rootDir });
  await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
  let routeCalls = 0;
  const controller = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service, outboxStore,
    onTerminalIntentFlushed: async () => { routeCalls += 1; },
    getProtectedInterruptedTaskBatchIds: options.protection
  });
  service.runDeleteWithOwnerGuard = (id, operation, payload) => controller.runDeleteWithOwnerGuard(id, operation, payload);
  const channel = options.channel || (allocation === 'eager' ? 'template:import' : 'monthly-balance:assemble');
  const policy = createTaskPolicyRegistry().require(channel);
  assert.equal(policy.allocation, allocation);
  const sourcePath = path.join(directory, 'input.csv');
  fs.writeFileSync(sourcePath, '日期,金额\n2026-09-12,1\n');
  const promotedPlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: channel }], outputs: [] });
  const initialPlan = allocation === 'eager' ? promotedPlan
    : normalizeFilePlanV1({ version: 1, allocation: 'deferred', inputs: [], outputs: [] });
  const lifecycle = createTaskLifecycle({ archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'owner-operation' }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: 'owner-parent', source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload)
  });
  let fileEffects = 0;
  let callbackCalls = 0;
  const run = async ({ boundary = '', mode = 'none', recovery = null } = {}) => {
    if (boundary === 'after-terminal') lifecycle._completeFileOwnerAfterTerminal = async () => crash();
    const payload = { policy, meta: { channel }, taskRunId: 'owner-task', operationKey: 'owner-operation',
      filePlanResolver: () => initialPlan,
      ...(recovery ? { recovery: { batchContext: recovery } } : {}),
      ...(mode === 'anonymous' || mode === 'routed' ? { afterTerminal: async () => { callbackCalls += 1; } } : {}),
      ...(mode === 'routed' || mode === 'route-only' ? { afterTerminalIntent: { route: 'pending-run', taskRunId: 'owner-task' } } : {}),
      ...(boundary === 'running' ? { beforeTerminalSettlement: async () => crash() } : {}),
      execute: async (_context, controls) => {
        if (allocation === 'deferred') await controls.ensureFileBatch(artifactManifestFromFilePlan(promotedPlan));
        fileEffects += 1;
        return { status: 'success' };
      }
    };
    return lifecycle[allocation === 'eager' ? 'runFileTask' : 'runDeferredFileTask'](payload);
  };
  t.after(async () => { await service.pauseBackgroundMaterialization(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, service, controller, outboxStore, run, lifecycle, sourcePath,
    counts: () => ({ fileEffects, callbackCalls, routeCalls }),
    owner: () => ownerOf(service.repository.getBatchByOperationKey(policy.scopeId, 'owner-operation')) };
}

for (const allocation of ['eager', 'deferred']) {
  for (const boundary of ['running', 'after-terminal']) {
    test(`${allocation} 新任务 ${boundary} 中断按原责任恢复，同一身份可删除或到期清理`, async (t) => {
      const f = await fixture(t, allocation);
      await assert.rejects(f.run({ boundary }), { code: 'SIMULATED_CRASH' });
      const owner = f.owner();
      assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
      assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
      assert.equal((await f.controller.initialize()).ok, true);
      const proof = f.service.repository.getOwnerTerminalCompletion(owner);
      assert.equal(proof.terminalStatus, boundary === 'running' ? 'interrupted' : 'succeeded');
      assert.equal(proof.afterTerminal, null);
      assert.deepEqual(f.owner(), owner);
      assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
      assert.equal(f.outboxStore.list().length, 0);
      assert.equal((await f.controller.initialize()).ok, true);
      assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
      const preparation = await f.controller.prepareDeleteBatch(owner.batchContext.batchId);
      assert.equal(preparation.ok, true, JSON.stringify(preparation));
      if (allocation === 'eager') {
        assert.equal((await f.controller.deleteBatch(owner.batchContext.batchId, preparation.confirmationToken)).fullyDeleted, true);
      } else {
        const retention = await f.service.cleanupExpired({ asOfLocalDate: '2099-01-01' });
        assert.equal(retention.deletedBatchCount, 1, JSON.stringify(retention));
      }
      assert.equal(fs.existsSync(f.sourcePath), true);
      assert.equal(f.service.repository.getBatch(owner.batchContext.batchId), null);
    });
  }

  for (const mode of ['anonymous', 'routed', 'route-only']) {
    test(`${allocation} ${mode} 不登记普通责任，原后处理不会被通用恢复跳过`, async (t) => {
      const f = await fixture(t, allocation);
      await assert.rejects(f.run({ boundary: 'after-terminal', mode }), { code: 'SIMULATED_CRASH' });
      const owner = f.owner();
      assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
      await f.controller.initialize();
      assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
      assert.equal((await f.controller.prepareDeleteBatch(owner.batchContext.batchId)).code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
      f.controller.persistTaskTerminalIntent({ owner, terminalOutcome: { taskStatus: 'succeeded',
        ...(mode === 'anonymous' ? { metadata: { _archiveAfterTerminalPending: true } }
          : { afterTerminal: { route: 'pending-run', taskRunId: 'owner-task' } }) } });
      const flushed = await f.controller.flushOutbox();
      assert.equal(flushed.remaining, mode === 'anonymous' ? 1 : 0);
      assert.equal(f.counts().routeCalls, mode === 'anonymous' ? 0 : 1);
      assert.equal(Boolean(f.service.repository.getOwnerTerminalCompletion(owner)), mode !== 'anonymous');
      assert.equal(f.counts().callbackCalls, 0);
    });
  }

  test(`${allocation} 责任 INSERT 失败回滚批次、manifest、issuance与流水，文件副作用不开始`, async (t) => {
    const f = await fixture(t, allocation);
    f.db.exec(`CREATE TRIGGER reject_owner_recovery BEFORE INSERT ON archive_file_task_owner_recovery
      BEGIN SELECT RAISE(ABORT, '模拟责任写入失败'); END;`);
    let failed;
    try { failed = await f.run(); } catch (error) { failed = error; }
    assert.ok(failed.status === 'failed' || failed instanceof Error);
    assert.equal(f.counts().fileEffects, 0);
    for (const table of ['archive_batches', 'archive_artifacts', 'archive_operation_issuances',
      'archive_daily_sequences', 'archive_file_task_owner_recovery']) assert.equal(rowCount(f.db, table), 0, table);
  });
}

for (const recoveryMode of ['normal', 'startup']) {
  test(`${recoveryMode} completion INSERT 后责任 DELETE 失败必须原子回滚，可再次恢复`, async (t) => {
    const f = await fixture(t);
    f.db.exec(`CREATE TRIGGER reject_owner_recovery_delete BEFORE DELETE ON archive_file_task_owner_recovery
      BEGIN SELECT RAISE(ABORT, '模拟责任清除失败'); END;`);
    if (recoveryMode === 'startup') {
      await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
      await assert.rejects(f.controller.initialize());
    } else {
      assert.equal((await f.run()).status, 'success');
      assert.equal(f.outboxStore.list().length, 1);
    }
    const owner = f.owner();
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
    f.db.exec('DROP TRIGGER reject_owner_recovery_delete');
    await f.controller.initialize();
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).terminalStatus,
      recoveryMode === 'startup' ? 'interrupted' : 'succeeded');
    assert.equal(f.outboxStore.list().length, 0);
  });
}

for (const mismatch of ['instance', 'owner']) {
  test(`错 ${mismatch} 的持久责任拒绝恢复并保留原记录`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
    if (mismatch === 'instance') {
      f.db.prepare('UPDATE archive_file_task_owner_recovery SET archive_instance_id = ?').run('other-instance');
    } else {
      f.db.prepare('UPDATE archive_task_runs SET operation_key = ? WHERE task_run_id = ?').run('other-operation', 'owner-task');
    }
    await assert.rejects(f.controller.initialize(), { code: 'ARCHIVE_OWNER_RECOVERY_IDENTITY_CONFLICT' });
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
    assert.equal(rowCount(f.db, 'archive_owner_terminal_completions'), 0);
  });
}

test('受保护或未终态的原 owner 保留责任；解除保护后同一任务再恢复', async (t) => {
  let protectedOwner = true;
  const f = await fixture(t, 'eager', { protection: () => ({ batchIds: protectedOwner ? [1] : [], taskRunIds: [] }) });
  await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
  const owner = f.owner();
  assert.equal((await f.service.recoverFileTaskOwnerCompletions()).pending, 1);
  await f.controller.initialize();
  assert.equal(f.service.repository.getTaskRun('owner-task').status, 'running');
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
  protectedOwner = false;
  await f.controller.initialize();
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).terminalStatus, 'interrupted');
});

test('未完成匿名终态 intent 不被普通责任恢复消费', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
  const owner = f.owner();
  f.controller.persistTaskTerminalIntent({ owner, terminalOutcome: { taskStatus: 'failed',
    metadata: { _archiveAfterTerminalPending: true } } });
  await assert.rejects(f.controller.initialize());
  assert.equal(f.outboxStore.list().length, 1);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
});

test('旧批次重新 reserve 和 schema 幂等升级均不补造无后处理责任', async (t) => {
  const f = await fixture(t);
  const reserve = f.service.reserveFileTaskBatch.bind(f.service);
  let originalPayload;
  f.service.reserveFileTaskBatch = async (payload) => {
    originalPayload = payload;
    return reserve({ ...payload, ownerTerminalRecovery: null });
  };
  await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
  assert.equal((await reserve(originalPayload)).created, false);
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
  // 模拟升级前已有 task/completion schema；重建新表不能自动认领旧任务。
  f.db.exec('DROP TABLE archive_file_task_owner_recovery');
  const reopened = createArchiveRepository(f.db);
  reopened.ensureSchema();
  reopened.ensureSchema();
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
  await f.controller.initialize();
  assert.equal(f.service.repository.getOwnerTerminalCompletion(f.owner()), null);
  assert.equal((await f.controller.prepareDeleteBatch(f.owner().batchContext.batchId)).code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
  assert.throws(() => f.service.repository.recordOwnerTerminalCompletion({ owner: f.owner(),
    archiveInstanceId: f.service.archiveInstanceId, terminalStatus: 'interrupted', afterTerminal: null }),
  /终态收口凭证缺少实例或终态/);
});

async function interruptedAcquiringFixture(t) {
  const f = await fixture(t, 'eager', { channel: 'acquiringBillCurrency:run' });
  await assert.rejects(f.run({ boundary: 'running' }), { code: 'SIMULATED_CRASH' });
  await f.controller.initialize();
  const owner = f.owner();
  const manifestIdentity = f.service.repository.getBatch(owner.batchContext.batchId).metadata._fileManifest.identity;
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).recoveryKind, 'no-after-terminal');
  return { ...f, originalOwner: owner, manifestIdentity };
}

test('Acquiring 原 owner 合法 resume 原子撤销新协议 interrupted proof，再成功完成原批次', async (t) => {
  const f = await interruptedAcquiringFixture(t);
  const context = f.originalOwner.batchContext;
  const resumed = await f.service.beginFileTaskRecovery(context, { manifestIdentity: f.manifestIdentity });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(f.service.repository.getTaskRun(context.taskRunId).status, 'running');
  assert.equal(f.service.repository.getOwnerTerminalCompletion(f.originalOwner), null);
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
  assert.equal((await f.controller.prepareDeleteBatch(context.batchId)).code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
  assert.equal((await f.run({ recovery: context })).status, 'success');
  const proof = f.service.repository.getOwnerTerminalCompletion(f.originalOwner);
  assert.equal(proof.terminalStatus, 'succeeded');
  assert.equal(proof.recoveryKind, '', '正常 completion 不伪装由恢复责任产生');
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
  assert.deepEqual(f.owner(), f.originalOwner);
  assert.equal((await f.controller.prepareDeleteBatch(context.batchId)).ok, true);
});

for (const boundary of ['insert-responsibility', 'delete-proof']) {
  test(`合法 resume 在 ${boundary} 失败时回滚 Task、proof 和新责任，可原样重试`, async (t) => {
    const f = await interruptedAcquiringFixture(t);
    const originalProof = f.service.repository.getOwnerTerminalCompletion(f.originalOwner);
    f.db.exec(boundary === 'insert-responsibility'
      ? `CREATE TRIGGER block_resume BEFORE INSERT ON archive_file_task_owner_recovery
          BEGIN SELECT RAISE(ABORT, 'resume责任写入失败'); END;`
      : `CREATE TRIGGER block_resume BEFORE DELETE ON archive_owner_terminal_completions
          BEGIN SELECT RAISE(ABORT, 'resume证明撤销失败'); END;`);
    const resumed = await f.service.beginFileTaskRecovery(f.originalOwner.batchContext, { manifestIdentity: f.manifestIdentity });
    assert.equal(resumed.ok, false);
    assert.equal(f.service.repository.getTaskRun('owner-task').status, 'interrupted');
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(f.originalOwner), originalProof);
    f.db.exec('DROP TRIGGER block_resume');
    assert.equal((await f.service.beginFileTaskRecovery(f.originalOwner.batchContext, { manifestIdentity: f.manifestIdentity })).ok, true);
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 1);
  });
}

for (const mismatch of ['legacy-proof', 'different-route', 'different-instance', 'manifest', 'owner']) {
  test(`resume 不撤销 ${mismatch} 的证明、不重新登记责任`, async (t) => {
    const f = await interruptedAcquiringFixture(t);
    let context = f.originalOwner.batchContext;
    let manifestIdentity = f.manifestIdentity;
    if (mismatch === 'legacy-proof') f.db.exec("UPDATE archive_owner_terminal_completions SET recovery_kind = ''");
    if (mismatch === 'different-route') f.db.prepare('UPDATE archive_owner_terminal_completions SET after_terminal_json = ?')
      .run(JSON.stringify({ route: 'pending-run', taskRunId: 'owner-task' }));
    if (mismatch === 'different-instance') f.db.exec("UPDATE archive_owner_terminal_completions SET archive_instance_id = 'other-instance'");
    if (mismatch === 'manifest') manifestIdentity = 'other-manifest';
    if (mismatch === 'owner') context = { ...context, operationKey: 'other-operation' };
    const proof = f.service.repository.getOwnerTerminalCompletion(f.originalOwner);
    const resumed = await f.service.beginFileTaskRecovery(context, { manifestIdentity });
    assert.equal(resumed.ok, false);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(f.originalOwner), proof);
    assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
    assert.equal(f.service.repository.getTaskRun('owner-task').status, 'interrupted');
  });
}

test('旧 completion schema 加 provenance 列幂等，旧普通证明不被标记为新恢复证明', async (t) => {
  const f = await fixture(t);
  await f.run();
  const owner = f.owner();
  const proof = f.service.repository.getOwnerTerminalCompletion(owner);
  f.db.exec('ALTER TABLE archive_owner_terminal_completions DROP COLUMN recovery_kind');
  f.service.repository.ensureSchema();
  f.service.repository.ensureSchema();
  assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), { ...proof, recoveryKind: '' });
  assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), 0);
});

for (const boundary of ['running', 'after-terminal', 'recovered']) {
  for (const failure of ['side-db', 'json', 'batch-context', 'inventory']) {
    test(`Acquiring ${boundary} 的 ${failure} 恢复证据不可读时，启动和删除保持原 owner`, async (t) => {
      const f = await fixture(t, 'eager', { channel: 'acquiringBillCurrency:run' });
      await assert.rejects(f.run({ boundary: boundary === 'recovered' ? 'running' : boundary }), { code: 'SIMULATED_CRASH' });
      if (boundary === 'recovered') await f.controller.initialize();
      const owner = f.owner();
      const originalProof = f.service.repository.getOwnerTerminalCompletion(owner);
      if (boundary === 'recovered') assert.equal(originalProof.terminalStatus, 'interrupted');
      else assert.equal(originalProof, null);
      const originalTask = f.service.repository.getTaskRun(owner.batchContext.taskRunId);
      const originalBatch = f.service.repository.getBatch(owner.batchContext.batchId);
      const module = runDataStore.MODULE_ACQUIRING;
      const monthKey = '2026-09';
      const sidePath = runDataStore.sideDbPath(f.directory, module, monthKey);
      const sideDb = runDataStore.openSideDb(f.directory, module, monthKey);
      const inserted = sideDb.prepare(`INSERT INTO acquiring_bill_currency_runs
        (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
        VALUES (?, 1, 1, 0, 0, 'failed')`).run(monthKey);
      acquiringRunRepo.setRunChunkProgress(sideDb, {
        runId: Number(inserted.lastInsertRowid), lastCompletedChunkIndex: 0, totalChunks: 2,
        status: 'partial', chunkSize: 5000, batchContext: owner.batchContext
      });
      const originalProgress = sideDb.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs').get().chunk_progress;
      if (failure === 'json') sideDb.exec("UPDATE acquiring_bill_currency_runs SET chunk_progress = '{'");
      if (failure === 'batch-context') {
        const progress = JSON.parse(originalProgress);
        progress.batchContext.operationKey = '';
        sideDb.prepare('UPDATE acquiring_bill_currency_runs SET chunk_progress = ?').run(JSON.stringify(progress));
      }
      sideDb.close();
      if (failure === 'side-db') {
        fs.renameSync(sidePath, `${sidePath}.preserved`);
        fs.writeFileSync(sidePath, '模拟已发现的侧库暂时无法读取');
      }
      let directoryUnavailable = failure === 'inventory';
      const readdirSync = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', (directory, ...args) => {
        if (directoryUnavailable && directory === runDataStore.moduleDir(f.directory, module)) {
          throw Object.assign(new Error('模拟侧库目录暂时不可读'), { code: 'EACCES' });
        }
        return readdirSync(directory, ...args);
      });
      // 与默认 Main 相同的保护提供者；调用失败必须传到 Controller，不能视作空清单。
      f.controller.getProtectedInterruptedTaskBatchIds = () => ({
        batchIds: acquiringRunData.listRecoverableArchiveBatchIds({ userDataDir: f.directory }), taskRunIds: []
      });
      await assert.rejects(f.controller.initialize(), { code: 'ARCHIVE_STARTUP_RECOVERY_EVIDENCE_UNAVAILABLE' });
      assert.equal((await f.controller.prepareDeleteBatch(owner.batchContext.batchId)).code, 'ACQUIRING_RUN_RECOVERY_EVIDENCE_UNAVAILABLE');
      assert.equal((await f.service.cleanupExpired({ asOfLocalDate: '2099-01-01' })).deletedBatchCount, 0);
      assert.equal(f.service.repository.getTaskRun(owner.batchContext.taskRunId).status, originalTask.status);
      assert.equal(f.service.repository.getBatch(owner.batchContext.batchId).taskStatus, originalBatch.taskStatus);
      assert.equal(f.service.repository.getBatch(owner.batchContext.batchId).archiveStatus, originalBatch.archiveStatus);
      assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), originalProof);
      assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), boundary === 'recovered' ? 0 : 1);
      assert.equal(rowCount(f.db, 'archive_cleanup_jobs'), 0);
      directoryUnavailable = false;
      if (failure === 'side-db') {
        fs.unlinkSync(sidePath);
        fs.renameSync(`${sidePath}.preserved`, sidePath);
      } else if (failure === 'json' || failure === 'batch-context') {
        const restored = new DatabaseSync(sidePath);
        restored.prepare('UPDATE acquiring_bill_currency_runs SET chunk_progress = ?').run(originalProgress);
        restored.close();
      }
      assert.deepEqual(acquiringRunData.listRecoverableArchiveBatchIds({ userDataDir: f.directory }), [owner.batchContext.batchId]);
      assert.equal((await f.controller.initialize()).ok, true);
      assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), originalProof);
      assert.equal((await f.controller.prepareDeleteBatch(owner.batchContext.batchId)).code, 'ARCHIVE_DELETE_OWNER_PENDING');
      assert.equal(rowCount(f.db, 'archive_file_task_owner_recovery'), boundary === 'recovered' ? 0 : 1);
    });
  }
}
