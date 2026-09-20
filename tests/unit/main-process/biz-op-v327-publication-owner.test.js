'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { seed, compute } = require('../../helpers/biz-op-v327-compute');

async function ready(t, options) {
  const f = await createExportHost(t, options);
  await seed(f);
  f.run = await compute(f);
  return f;
}
function tree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(root, entry.name);
    return entry.isDirectory() ? tree(name) : [[name, fs.readFileSync(name).toString('base64')]];
  });
}
function ackWriteCounter(f) {
  f.db.exec(`CREATE TEMP TABLE ack_writes(n INTEGER);
    CREATE TEMP TRIGGER count_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    BEGIN INSERT INTO ack_writes(n) VALUES(1); END;`);
  return () => f.db.prepare('SELECT COUNT(*) n FROM ack_writes').get().n;
}

for (const pending of ['deferred', 'skippedActive', 'no-observation', 'forged-absence', 'non-finalized']) {
  test(`真实已提交 BizOP receipt ${pending}：ACK_PENDING 前零 acknowledgement 写入和零 staging cleanup`, async (t) => {
    let mode = pending;
    const f = await ready(t, { wrapPublicationRecovery(facade, context) {
      return { recover(options) {
        if (options.reason !== 'receipt-ack' || mode === 'normal') return facade.recover(options);
        const taskId = options.taskIds[0];
        assert.deepEqual(options.acknowledgedCommittedTaskIds, [taskId]);
        return { recovered: mode === 'non-finalized' ? [{ taskId, action: 'commit-cleanup-staged' }] : [],
          deferred: mode === 'deferred' ? [{ taskId, ownerId: 'biz-op-v327', code: 'BIZOP_PUBLICATION_ACK_PENDING' }] : [],
          skippedActive: mode === 'skippedActive' ? [taskId] : [],
          ...(mode === 'forged-absence' ? { observation: { root: context.root, complete: true,
            requestedTaskIds: [taskId], absentTaskIds: [taskId] } } : {}) };
      } };
    } });
    const writes = ackWriteCounter(f);
    const result = await request(f, 'RESULT_FULL', f.run.runId);
    assert.equal(result.status, 'ok');
    const taskId = result.taskRunId;
    assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
    assert.equal(f.module.publication.record(taskId).archive_settled, 1);
    const stage = f.module.payloadStore.resolve(`staging/${taskId}`);
    const before = tree(stage);
    assert.ok(before.length > 0);
    await assert.rejects(f.module.publication.acknowledge(taskId), { code: 'BIZOP_PUBLICATION_ACK_PENDING' });
    assert.equal(writes(), 0);
    assert.equal(f.module.publication.record(taskId).acknowledged, 0);
    assert.equal(f.module.publication.record(taskId).cleanup_completed, 0);
    assert.deepEqual(tree(stage), before);
    assert.equal(f.module.publication.closed(taskId), true);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    mode = 'normal';
    assert.equal(await f.module.publication.acknowledge(taskId), true);
    assert.equal(f.module.publication.record(taskId).cleanup_completed, 1);
  });
}

for (const action of ['rolled-back', 'cancelled', 'cancelled-preparing', 'cancelled-prepared']) {
  test(`BizOP reconcile 的明确 ${action} 不要求额外 absence 证明`, async (t) => {
    const f = await ready(t, { wrapPublicationRecovery(facade) {
      return { recover(options) {
        if (options.reason !== 'business-retry') return facade.recover(options);
        assert.equal(options.taskIds.length, 1);
        return { recovered: [{ taskId: options.taskIds[0], action }], deferred: [], skippedActive: [] };
      } };
    } });
    let taskId;
    await assert.rejects(request(f, 'RESULT_FULL', f.run.runId, { afterWorker(value) {
      taskId = value.taskRunId; throw new Error('在发布前中断');
    } }), /在发布前中断/);
    await f.module.publication.reconcile(taskId);
    const fact = f.module.publication.fact(taskId);
    assert.equal(fact.state, 'NOT_COMMITTED');
    assert.equal(fact.outcome.recoveredAction, action);
  });
}

test('BizOP reconcile 空结果缺可信 absence 或 task deferred 都保留 UNKNOWN，不能记 NOT_COMMITTED', async (t) => {
  let mode = 'empty';
  const f = await ready(t, { wrapPublicationRecovery(facade) {
    return { recover(options) {
      if (options.reason !== 'business-retry') return facade.recover(options);
      return { recovered: [], deferred: mode === 'deferred'
        ? [{ taskId: options.taskIds[0], ownerId: 'biz-op-v327', code: 'BIZOP_PUBLICATION_CLOSURE_PENDING' }] : [], skippedActive: [] };
    } };
  } });
  let taskId;
  await assert.rejects(request(f, 'RESULT_FULL', f.run.runId, { afterWorker(value) {
    taskId = value.taskRunId; throw new Error('在发布前中断');
  } }), /在发布前中断/);
  await assert.rejects(f.module.publication.reconcile(taskId), { code: 'BIZOP_PUBLICATION_RECOVERY_UNKNOWN' });
  assert.equal(f.module.publication.fact(taskId), null);
  mode = 'deferred';
  await assert.rejects(f.module.publication.reconcile(taskId), { code: 'BIZOP_PUBLICATION_CLOSURE_PENDING' });
  assert.equal(f.module.publication.fact(taskId), null);
});

test('借用 observation 绑定本次 task/nonce/kind 和进入前 closure，真实恢复与 ack 不自阻塞、不二次申请', async (t) => {
  const capabilities = [];
  const f = await ready(t, { wrapPublicationRecovery(facade, context) {
    return { async recover(options) {
      const owner = context.module.publication.publicationOwner;
      const taskId = options.taskIds[0];
      const taskRunId = taskId.slice('biz-op-v327-export-'.length);
      const fullRequest = { root: context.root, ownerId: owner.id, ...options };
      assert.equal(context.module.publication.closed(taskRunId), false);
      assert.equal(owner.verifyObservation(options.observation, fullRequest), true);
      assert.equal(owner.verifyObservation({ verifyScope() { return true; }, release() {} }, fullRequest), false);
      assert.equal(owner.verifyObservation(options.observation, { ...fullRequest, taskIds: ['biz-op-v327-export-other'] }), false);
      assert.equal(owner.verifyObservation(options.observation, { ...fullRequest, reason: 'startup' }), false);
      assert.equal(await owner.acquireObservation(fullRequest), options.observation);
      capabilities.push({ owner, observation: options.observation, fullRequest });
      return facade.recover(options);
    } };
  } });
  const result = await request(f, 'RESULT_FULL', f.run.runId);
  assert.equal(result.status, 'ok');
  assert.equal(f.module.publication.record(result.taskRunId).cleanup_completed, 1);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.ok(capabilities.length > 0);
  for (const value of capabilities) assert.equal(value.owner.verifyObservation(value.observation, value.fullRequest), false);
});

test('BizOP owner 需持久 binding/intent/exact-7，领域 HOLD 只 defer，未知与冲突零修改', async (t) => {
  const f = await ready(t);
  let taskId;
  await assert.rejects(request(f, 'RESULT_FULL', f.run.runId, { afterWorker(value) {
    taskId = value.taskRunId; throw new Error('在发布前中断');
  } }), /在发布前中断/);
  const owner = f.module.publication.publicationOwner;
  const binding = f.module.publication.binding(taskId);
  const evidence = { taskId: binding.publisherTaskId, batchContext: binding.batchContext,
    targetAbsolutePaths: [binding.output.filePath], entries: [{ targetPath: binding.output.filePath }] };
  const record = { taskId: binding.publisherTaskId, discoveryState: 'prepared', journalStatus: 'prepared',
    indexEntry: evidence, journal: evidence };
  const identity = owner.identify(record);
  assert.equal(identity.ownerId, owner.id);
  const before = tree(f.root);
  assert.equal(owner.identify({ ...record, taskId: 'biz-op-v327-export-unknown' }), 'not-owned');
  assert.throws(() => owner.identify({ ...record, journal: { ...evidence,
    batchContext: { ...binding.batchContext, operationKey: 'wrong-operation' } } }), { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' });
  assert.throws(() => owner.identify({ ...record, journal: { taskId: binding.publisherTaskId } }), { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' });
  assert.deepEqual(tree(f.root), before);
  f.db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='HOLD' WHERE task_run_id=?").run(taskId);
  const decision = owner.authorize(record, { root: f.root, ownerId: 'archive-publication', reason: 'startup' }, identity);
  assert.equal(decision.disposition, 'defer');
  assert.equal(decision.permission, null);
});

test('可信完整 absence 仍要求原 Archive artifact proof；缺 proof 时不补写 acknowledged，恢复 proof 后幂等成功', async (t) => {
  const f = await ready(t);
  f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    BEGIN SELECT RAISE(FAIL, '测试确认写入失败'); END;`);
  const result = await request(f, 'RESULT_FULL', f.run.runId);
  const taskId = result.taskRunId;
  assert.equal(result.status, 'ok');
  assert.equal(f.module.publication.record(taskId).acknowledged, 0);
  f.db.exec('DROP TRIGGER fail_ack');
  const writes = ackWriteCounter(f);
  const bound = f.module.publication.binding(taskId);
  const artifact = f.module.catalog.archive.listArtifacts(bound.batchContext.batchId)[0];
  f.db.prepare("UPDATE archive_artifacts SET status='failed' WHERE id=?").run(artifact.id);
  const stage = f.module.payloadStore.resolve(`staging/${taskId}`);
  const before = tree(stage);
  await assert.rejects(f.module.publication.acknowledge(taskId), { code: 'BIZOP_PUBLICATION_ACK_PENDING' });
  assert.equal(writes(), 0);
  assert.equal(f.module.publication.record(taskId).cleanup_completed, 0);
  assert.deepEqual(tree(stage), before);
  f.db.prepare("UPDATE archive_artifacts SET status='ready' WHERE id=?").run(artifact.id);
  assert.equal(await f.module.publication.acknowledge(taskId), true);
  assert.equal(f.module.publication.record(taskId).cleanup_completed, 1);
});
