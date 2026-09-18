'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const { createArchiveOwnerHost, rewriteNewPublicationBinding, publicationEvidence,
  emulateLegacyClosedOwner } = require('../../helpers/biz-op-v327-archive-owner');

test('ACTIVE 默认 IPC 未提交导出首次 failed 终态写入失败，原补偿完成凭证并清空 outbox', async (t) => {
  const f = await createArchiveOwnerHost(t);
  const result = await f.exportInput({ uncommitted: true, failTerminalOnce: true });
  assert.equal(result.cleanupPending, false);
  const owner = f.owner(result.taskRunId);
  const before = publicationEvidence(f, result.taskRunId);
  assert.equal(before.publication.state, 'NOT_COMMITTED');
  assert.equal(before.task.status, 'failed');
  assert.equal(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
  const proof = f.service.repository.getOwnerTerminalCompletion(owner);
  assert.ok(proof, '未提交导出补偿完成后必须由原 owner 保存完成凭证');
  assert.deepEqual(proof.owner, owner);
  assert.equal(proof.terminalStatus, 'failed');
  assert.equal(proof.afterTerminal, null);
  assert.equal((await f.center.initialize()).ok, true);
  assert.equal(f.outboxStore.list().length, 0);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
  assert.deepEqual(publicationEvidence(f, result.taskRunId), before);
});

for (const failure of ['proof-insert', 'phase-close', 'abort-finalization', 'stage-reclaim']) {
  test(`未提交导出 ${failure} 故障保留原责任，实际补偿和清理完成后重入`, async (t) => {
    const f = await createArchiveOwnerHost(t);
    const triggers = {
      'proof-insert': `BEFORE INSERT ON archive_owner_terminal_completions
        WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'`,
      'phase-close': `BEFORE UPDATE OF phase ON biz_op_v327_prepared_ops WHEN NEW.action='EXPORT' AND NEW.phase='CLOSED'`,
      'abort-finalization': `BEFORE INSERT ON biz_op_v327_abort_finalizations WHEN NEW.source_kind='publisher-journal'`,
      'stage-reclaim': `BEFORE UPDATE OF state ON biz_op_v327_reclaim_queue WHEN NEW.payload_kind='ABORTED_STAGE' AND NEW.state='DONE'`
    };
    f.db.exec(`CREATE TEMP TRIGGER block_compensation ${triggers[failure]} BEGIN SELECT RAISE(ABORT,'补偿故障'); END`);
    const result = await f.exportInput({ uncommitted: true, failTerminalOnce: true });
    const owner = f.owner(result.taskRunId);
    assert.equal(result.cleanupPending, true);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
    assert.notEqual(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
    assert.equal(f.module.recovery.openObligations(), true);
    assert.equal(f.outboxStore.list().length, 1);
    assert.equal((await f.module.recovery.run()).ready, false);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
    if (failure === 'proof-insert' || failure === 'phase-close') {
      assert.equal(f.db.prepare("SELECT state FROM biz_op_v327_reclaim_queue WHERE payload_kind='ABORTED_STAGE' AND object_id=?")
        .get(result.taskRunId).state, 'DONE');
    }
    f.db.exec('DROP TRIGGER block_compensation');
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.equal((await f.center.initialize()).ok, true);
    assert.equal(f.outboxStore.list().length, 0);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).terminalStatus, 'failed');
    assert.equal(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
  });
}

test('已 CLOSED 的未提交补偿仍枚举缺失凭证，依据原 binding/回收事实恢复', async (t) => {
  const f = await createArchiveOwnerHost(t);
  f.db.exec(`CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON archive_owner_terminal_completions
    WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'
    BEGIN SELECT RAISE(ABORT,'补偿凭证暂时失败'); END`);
  const result = await f.exportInput({ uncommitted: true, failTerminalOnce: true });
  f.db.exec('DROP TRIGGER fail_completion');
  emulateLegacyClosedOwner(f, result.taskRunId);
  const before = publicationEvidence(f, result.taskRunId);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(f.owner(result.taskRunId)), null);
  assert.equal(f.module.recovery.openObligations(), true);
  assert.equal((await f.center.initialize()).ok, true);
  assert.equal(f.outboxStore.list().length, 0);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(f.owner(result.taskRunId)).terminalStatus, 'failed');
  assert.deepEqual(publicationEvidence(f, result.taskRunId), before);
});

for (const failTerminalOnce of [false, true]) test(`publication 登记失败 / 终态首次失败=${failTerminalOnce}，普通责任沿原入口收口`, async (t) => {
  const f = await createArchiveOwnerHost(t);
  f.db.exec(`CREATE TEMP TRIGGER fail_registration BEFORE INSERT ON biz_op_v327_publications
    BEGIN SELECT RAISE(ABORT,'publication登记失败'); END`);
  const result = await f.exportInput({ expectedError: 'ERR_SQLITE_ERROR', failTerminalOnce });
  assert.equal(f.module.publication.record(result.taskRunId), undefined);
  assert.equal(f.module.publication.fact(result.taskRunId).outcome.publisherNeverRegistered, true);
  assert.equal(result.cleanupPending, false);
  assert.equal(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
  const batch = f.db.prepare('SELECT id FROM archive_batches WHERE task_run_id=?').get(result.taskRunId);
  if (failTerminalOnce) {
    assert.equal(f.db.prepare('SELECT 1 FROM archive_owner_terminal_completions WHERE batch_id=?').get(batch.id), undefined);
    assert.equal(f.outboxStore.list()[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, undefined);
  }
  assert.equal((await f.center.initialize()).ok, true);
  assert.equal(f.outboxStore.list().length, 0);
  assert.ok(f.db.prepare('SELECT 1 FROM archive_owner_terminal_completions WHERE batch_id=?').get(batch.id));
});

for (const pending of [false, true]) {
  test(`旧未提交 binding 缺新增实例字段且 CLOSED / pending=${pending}，凭完整原补偿事实兼容恢复`, async (t) => {
    const f = await createArchiveOwnerHost(t);
    rewriteNewPublicationBinding(f, (value) => { delete value.archiveOwnerCompletion; return value; });
    if (pending) f.db.exec(`CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON archive_owner_terminal_completions
      WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'
      BEGIN SELECT RAISE(ABORT,'历史补偿凭证缺失'); END`);
    const result = await f.exportInput({ uncommitted: true, failTerminalOnce: pending });
    const owner = f.owner(result.taskRunId);
    if (pending) f.db.exec('DROP TRIGGER fail_completion');
    else {
      // 旧版没有新增 completion 表；保留已收口的真实业务、原 manifest 和补偿/回收事实。
      f.db.prepare('DELETE FROM archive_owner_terminal_completions WHERE batch_id=?').run(owner.batchContext.batchId);
      assert.equal(f.outboxStore.list().length, 0);
    }
    emulateLegacyClosedOwner(f, result.taskRunId);
    const before = publicationEvidence(f, result.taskRunId);
    assert.equal(f.module.recovery.openObligations(), true);
    assert.equal((await f.center.initialize()).ok, true);
    assert.equal(f.outboxStore.list().length, 0);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).terminalStatus, 'failed');
    assert.deepEqual(publicationEvidence(f, result.taskRunId), before);
  });
}

for (const conflict of ['route', 'proof-instance', 'owner', 'manifest', 'binding-instance', 'binding-null', 'ready-output', 'cleanup-plan']) {
  test(`未提交补偿拒绝 ${conflict} 冲突，保留原匿名通知和恢复责任`, async (t) => {
    const f = await createArchiveOwnerHost(t);
    if (conflict === 'binding-instance' || conflict === 'binding-null') {
      rewriteNewPublicationBinding(f, (value) => {
        if (conflict === 'binding-instance') value.archiveOwnerCompletion.archiveInstanceId = 'other-instance';
        else value.archiveOwnerCompletion = null;
        return value;
      });
    }
    f.db.exec(`CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON archive_owner_terminal_completions
      WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'
      BEGIN SELECT RAISE(ABORT,'补偿凭证暂时失败'); END`);
    const result = await f.exportInput({ uncommitted: true, failTerminalOnce: true });
    f.db.exec('DROP TRIGGER fail_completion');
    const owner = f.owner(result.taskRunId);
    if (conflict === 'route' || conflict === 'proof-instance') {
      f.service.repository.recordOwnerTerminalCompletion({ owner, terminalStatus: 'failed',
        archiveInstanceId: conflict === 'proof-instance' ? 'other-instance' : f.service.repository.getArchiveInstanceId(),
        afterTerminal: conflict === 'route' ? { route: 'pending-run', taskRunId: result.taskRunId } : null });
    }
    if (conflict === 'owner') f.db.prepare('UPDATE archive_batches SET parent_run_id=? WHERE id=?')
      .run('other-owner', owner.batchContext.batchId);
    if (conflict === 'manifest') {
      const batch = f.service.repository.getBatch(owner.batchContext.batchId);
      f.db.prepare('UPDATE archive_batches SET metadata_json=? WHERE id=?')
        .run(JSON.stringify({ ...batch.metadata, _fileManifest: { ...batch.metadata._fileManifest, identity: 'other-manifest' } }), batch.id);
    }
    if (conflict === 'ready-output') f.db.prepare("UPDATE archive_artifacts SET status='ready' WHERE batch_id=?").run(owner.batchContext.batchId);
    if (conflict === 'cleanup-plan') {
      const queue = f.db.prepare("SELECT * FROM biz_op_v327_reclaim_queue WHERE payload_kind='ABORTED_STAGE' AND object_id=?").get(result.taskRunId);
      fs.appendFileSync(f.module.payloadStore.resolve(`operations/${queue.owner_task_run_id}/reclaim-plan.json`), 'changed');
    }
    const proof = f.service.repository.getOwnerTerminalCompletion(owner);
    assert.equal((await f.module.recovery.run()).ready, false);
    assert.equal(f.module.recovery.openObligations(), true);
    assert.notEqual(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
    assert.equal((await f.center.flushOutbox()).remaining, 1);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
    assert.equal(f.service.repository.getBatch(owner.batchContext.batchId) !== null, true);
  });
}

test('ACTIVE 默认 IPC 导出 ACK 暂时失败后，原恢复完成 owner proof/outbox/初始化，重复不重发', async (t) => {
  const f = await createArchiveOwnerHost(t);
  f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(FAIL,'临时 ACK 写入故障'); END`);
  const result = await f.exportInput();
  const owner = f.owner(result.taskRunId);
  const publication = f.module.publication.fact(result.taskRunId);
  assert.equal(f.outboxStore.list().length, 1);
  assert.equal(f.outboxStore.list()[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, true);
  f.db.exec('DROP TRIGGER fail_ack');
  assert.equal((await f.module.recovery.run()).ready, true);
  const proof = f.service.repository.getOwnerTerminalCompletion(owner);
  assert.ok(proof, '原业务恢复收口必须形成 Archive owner completion');
  assert.deepEqual(proof.owner, owner);
  assert.equal(proof.afterTerminal, null);
  assert.equal(proof.archiveInstanceId, f.service.repository.getArchiveInstanceId());
  assert.equal((await f.center.initialize()).ok, true);
  assert.equal(f.outboxStore.list().length, 0);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal((await f.center.initialize()).ok, true);
  assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
  assert.deepEqual(f.module.publication.fact(result.taskRunId), publication);
  const prepared = await f.center.prepareDeleteBatch(owner.batchContext.batchId);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
});

for (const failure of ['proof-insert', 'phase-close']) {
  test(`${failure} 暂时失败保留原业务责任，completion与关闭事务一起回滚，再次恢复收口`, async (t) => {
    const f = await createArchiveOwnerHost(t);
    f.db.exec(failure === 'proof-insert'
      ? `CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON archive_owner_terminal_completions
          WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'
          BEGIN SELECT RAISE(ABORT,'completion暂时失败'); END`
      : `CREATE TEMP TRIGGER fail_completion BEFORE UPDATE OF phase ON biz_op_v327_prepared_ops
          WHEN NEW.action='EXPORT' AND NEW.phase='CLOSED' BEGIN SELECT RAISE(ABORT,'phase关闭暂时失败'); END`);
    const result = await f.exportInput();
    const owner = f.owner(result.taskRunId);
    const before = publicationEvidence(f, result.taskRunId);
    assert.equal(f.module.publication.record(result.taskRunId).acknowledged, 1);
    assert.equal(f.module.publication.record(result.taskRunId).cleanup_completed, 1);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
    assert.notEqual(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
    assert.notEqual(f.module.catalog.operation(result.taskRunId).settlement_state, 'COMPLETE');
    assert.equal(f.module.recovery.openObligations(), true);
    assert.equal(f.outboxStore.list().length, 1);
    assert.equal((await f.module.recovery.run()).ready, false);
    assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
    assert.equal(f.outboxStore.list().length, 1);
    f.db.exec('DROP TRIGGER fail_completion');
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.equal((await f.center.initialize()).ok, true);
    const proof = f.service.repository.getOwnerTerminalCompletion(owner);
    assert.equal(proof.terminalStatus, 'succeeded');
    assert.equal(f.outboxStore.list().length, 0);
    assert.equal(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
    assert.deepEqual(publicationEvidence(f, result.taskRunId), before);
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
  });
}

test('旧binding与已CLOSED的原publication仍能找回缺失proof责任，原pending不永久阻断启动', async (t) => {
  const f = await createArchiveOwnerHost(t);
  rewriteNewPublicationBinding(f, (value) => { delete value.archiveOwnerCompletion; return value; });
  f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(FAIL,'旧版本ACK暂时失败'); END`);
  const result = await f.exportInput();
  f.db.exec('DROP TRIGGER fail_ack');
  await f.module.publication.acknowledge(result.taskRunId, f.runtime);
  emulateLegacyClosedOwner(f, result.taskRunId);
  const before = publicationEvidence(f, result.taskRunId);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(f.owner(result.taskRunId)), null);
  assert.equal(f.module.recovery.openObligations(), true, 'CLOSED 缓存不能隐藏尚缺 owner proof 的原发布');
  assert.equal((await f.center.initialize()).ok, true);
  assert.equal(f.outboxStore.list().length, 0);
  assert.ok(f.service.repository.getOwnerTerminalCompletion(f.owner(result.taskRunId)));
  assert.deepEqual(publicationEvidence(f, result.taskRunId), before);
});

for (const conflict of ['route', 'proof-instance', 'binding-instance', 'binding-null', 'manifest', 'owner']) {
  test(`原owner收口拒绝 ${conflict} 冲突，保留phase和匿名outbox`, async (t) => {
    const f = await createArchiveOwnerHost(t);
    if (conflict === 'binding-instance' || conflict === 'binding-null') {
      rewriteNewPublicationBinding(f, (value) => {
        if (conflict === 'binding-instance') value.archiveOwnerCompletion.archiveInstanceId = 'other-instance';
        else value.archiveOwnerCompletion = null;
        return value;
      });
    }
    const acknowledge = f.module.publication.acknowledge.bind(f.module.publication);
    let armed = true;
    f.module.publication.acknowledge = async (id, runtime) => {
      const result = await acknowledge(id, runtime);
      if (armed && result) {
        armed = false;
        const owner = f.owner(id);
        if (conflict === 'route' || conflict === 'proof-instance') {
          f.service.repository.recordOwnerTerminalCompletion({ owner, terminalStatus: 'succeeded',
            archiveInstanceId: conflict === 'proof-instance' ? 'other-instance' : f.service.repository.getArchiveInstanceId(),
            afterTerminal: conflict === 'route' ? { route: 'pending-run', taskRunId: id } : null });
        }
        if (conflict === 'owner') f.db.prepare('UPDATE archive_batches SET parent_run_id=? WHERE id=?')
          .run('other-owner', owner.batchContext.batchId);
        if (conflict === 'manifest') {
          const batch = f.service.repository.getBatch(owner.batchContext.batchId);
          const metadata = { ...batch.metadata, _fileManifest: { ...batch.metadata._fileManifest, identity: 'other-manifest' } };
          f.db.prepare('UPDATE archive_batches SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), batch.id);
        }
      }
      return result;
    };
    const result = await f.exportInput();
    const owner = f.owner(result.taskRunId);
    const originalProof = f.service.repository.getOwnerTerminalCompletion(owner);
    assert.equal(f.outboxStore.list().length, 1);
    assert.notEqual(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED');
    const recovered = await f.module.recovery.run();
    assert.equal(recovered.ready, false, JSON.stringify(recovered));
    assert.equal(f.module.recovery.openObligations(), true);
    assert.equal((await f.center.flushOutbox()).remaining, 1);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), originalProof);
    assert.equal(f.service.repository.getBatch(owner.batchContext.batchId) !== null, true);
  });
}
