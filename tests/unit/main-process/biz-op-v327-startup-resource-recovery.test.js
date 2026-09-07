'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { seed, compute } = require('../../helpers/biz-op-v327-compute');
const { createBizOpPublication } = require('../../../src/main-process/biz-op-v327/export-publication');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');

test('真实未发布导出在零预算恢复时保留任务和 pin，资源足够后原任务可收口', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  let taskId;
  await assert.rejects(request(f, 'RESULT_DIFF', run.runId, { afterWorker({ taskRunId }) {
    taskId = taskRunId; throw new Error('发布前中断');
  } }), /发布前中断/);
  const before = JSON.stringify(f.module.publication.record(taskId));
  assert.equal(f.module.publication.record(taskId).state, 'NOT_STARTED');
  const pinCount = () => f.db.prepare('SELECT COUNT(*) n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n;
  assert.equal(pinCount(), 1);
  let runtime = { resourceGovernor: createResourceGovernor({ budgets: {
    cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 0
  } }) };
  const publication = createBizOpPublication({ catalog: f.module.catalog, payloadStore: f.module.payloadStore,
    protection: f.module.protection, userDataDir: f.root, getArchiveService: () => f.service, getRuntime: () => runtime });
  f.module.sources.setPublication(publication);
  const blocked = await f.module.recovery.run();
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
  await assert.rejects(publication.recoverOtherOwners({ userDataDir: f.root, deferCommittedRecovery: true }),
    { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
  assert.equal(JSON.stringify(publication.record(taskId)), before);
  assert.equal(pinCount(), 1);
  assert.equal(runtime.resourceGovernor.snapshot().queued.size, 0);
  runtime = f.runtime;
  const recovered = await f.module.recovery.run();
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(publication.record(taskId).cleanup_completed, 1);
  assert.equal(f.module.catalog.task(taskId).status, 'failed');
  assert.equal(f.module.catalog.operation(taskId).phase, 'CLOSED');
  assert.equal(pinCount(), 0);
});

test('真实已发布导出在零预算归档时保留提交证明，重试完成原任务且不重复发布', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  let taskId;
  await assert.rejects(request(f, 'RESULT_FULL', run.runId, { afterPublish({ taskRunId }) {
    taskId = taskRunId; throw new Error('发布成功后中断');
  } }), { code: 'BIZOP_PUBLICATION_RECOVERY_REQUIRED' });
  const before = JSON.stringify(f.module.publication.record(taskId));
  const committed = f.module.publication.fact(taskId).digest;
  assert.equal(f.module.catalog.task(taskId).status, 'running');
  let runtime = { resourceGovernor: createResourceGovernor({ budgets: {
    cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 0
  } }) };
  const publication = createBizOpPublication({ catalog: f.module.catalog, payloadStore: f.module.payloadStore,
    protection: f.module.protection, userDataDir: f.root, getArchiveService: () => f.service, getRuntime: () => runtime });
  await assert.rejects(publication.settle(taskId), { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
  await assert.rejects(publication.recoverOtherOwners({ userDataDir: f.root, deferCommittedRecovery: true }),
    { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
  assert.equal(JSON.stringify(publication.record(taskId)), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n, 1);
  runtime = f.runtime;
  f.module.sources.setPublication(publication);
  const recovered = await f.module.recovery.run();
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
  assert.equal(publication.record(taskId).cleanup_completed, 1);
  assert.equal(publication.fact(taskId).digest, committed);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n, 0);
});

test('真实 Publisher 排队期间取消立即退出，不等资源释放且保留原目标', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  const controller = new AbortController();
  const targetPath = path.join(f.outputRoot, 'publisher-cancel.xlsx');
  fs.writeFileSync(targetPath, '原目标');
  let blocker; let taskId;
  t.after(() => blocker?.release('test-end'));
  const result = await request(f, 'RESULT_FULL', run.runId, { targetPath, signal: controller.signal,
    async afterWorker({ taskRunId }) {
      taskId = taskRunId;
      blocker = await f.runtime.resourceGovernor.acquirePhaseLease({ ownerKey: 'test-blocker', actionKey: 'test-blocker',
        resources: f.runtime.resourceGovernor.snapshot().budgets });
      setImmediate(() => controller.abort());
    }
  });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(f.module.catalog.task(taskId).status, 'cancelled');
  assert.equal(f.module.publication.record(taskId).state, 'NOT_STARTED');
  assert.equal(f.runtime.resourceGovernor.snapshot().queued.size, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 1);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '原目标');
  blocker.release('test-complete'); blocker = null;
  assert.equal((await f.module.recovery.run()).ready, true);
});

test('真实 RAW 来源准入排队期间取消，不读取原件、不创建发布记录且任务记为取消', async (t) => {
  const f = await createExportHost(t); await seed(f);
  const id = f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='OP' ORDER BY data_date LIMIT 1").get().dataset_id;
  const targetPath = path.join(f.outputRoot, 'raw-cancel.xlsx');
  fs.writeFileSync(targetPath, '原目标');
  const controller = new AbortController();
  let rawReads = 0;
  const originalResolve = f.service.resolveVerifiedArtifact.bind(f.service);
  f.service.resolveVerifiedArtifact = async (...args) => { rawReads += 1; return originalResolve(...args); };
  const blocker = await f.runtime.resourceGovernor.acquirePhaseLease({ ownerKey: 'test-blocker', actionKey: 'test-blocker',
    resources: f.runtime.resourceGovernor.snapshot().budgets });
  t.after(() => blocker.release('test-end'));
  const pending = request(f, 'OP_RAW', id, { targetPath, signal: controller.signal });
  let attempts = 0;
  while (!f.runtime.resourceGovernor.snapshot().queued.size && attempts++ < 100) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const queuedBeforeCancel = f.runtime.resourceGovernor.snapshot().queued.size;
  controller.abort();
  const result = await pending;
  assert.equal(queuedBeforeCancel, 1);
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  const task = f.db.prepare("SELECT task_run_id,status FROM archive_task_runs WHERE task_key='bizOpReconV327:export:op-raw'").get();
  assert.equal(task.status, 'cancelled');
  assert.equal(f.module.publication.record(task.task_run_id), undefined);
  assert.equal(rawReads, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().queued.size, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 1);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '原目标');
  blocker.release('test-complete');
  assert.equal((await f.module.recovery.run()).ready, true);
});
