'use strict';

// ACTIVE 默认 IPC → Worker/Publisher → 原 owner 恢复 → outbox/删除；仅合成数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createArchiveOwnerHost, rewriteNewPublicationBinding, publicationEvidence,
  emulateLegacyClosedOwner } = require('../helpers/biz-op-v327-archive-owner');

async function openHost(directory) {
  const hooks = [];
  const f = await createArchiveOwnerHost({ after: (hook) => hooks.push(hook) }, {
    root: path.join(directory, 'app'), outputRoot: path.join(directory, 'outputs'), keep: true
  });
  return { ...f, async close() { await f.service.pauseBackgroundMaterialization(); for (const hook of hooks.reverse()) await hook(); } };
}

async function runChild(directory, mode = 'after-ack-crash') {
  const f = await openHost(directory);
  if (mode === 'failed-terminal-write' || mode === 'closed-compensated') {
    if (mode === 'closed-compensated') {
      rewriteNewPublicationBinding(f, (value) => { delete value.archiveOwnerCompletion; return value; });
      f.db.exec(`CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON archive_owner_terminal_completions
        WHEN json_extract(NEW.owner_json,'$.batchContext.taskKey')='bizOpReconV327:export:op-check'
        BEGIN SELECT RAISE(ABORT,'补偿凭证暂时失败'); END`);
    }
    const result = await f.exportInput({ uncommitted: true, failTerminalOnce: true });
    const taskRunId = result.taskRunId;
    const owner = f.owner(taskRunId);
    assert.equal(f.outboxStore.list().length, 1);
    assert.equal(f.outboxStore.list()[0].payload.terminalOutcome.metadata._archiveAfterTerminalPending, true);
    if (mode === 'closed-compensated') {
      assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
      f.db.exec('DROP TRIGGER fail_completion');
      emulateLegacyClosedOwner(f, taskRunId);
      assert.equal(f.module.recovery.openObligations(), true);
    } else assert.equal(f.service.repository.getOwnerTerminalCompletion(owner).terminalStatus, 'failed');
    assert.equal(f.module.catalog.operation(taskRunId).phase, 'CLOSED');
    fs.writeFileSync(path.join(directory, 'before-crash.json'), JSON.stringify({ taskRunId, owner,
      evidence: publicationEvidence(f, taskRunId) }));
    process.exit(73); // 真退出：留下原匿名终态通知，由新进程核验/恢复后确认。
  }
  const record = f.service.repository.recordOwnerTerminalCompletion.bind(f.service.repository);
  f.service.repository.recordOwnerTerminalCompletion = (payload) => {
    const taskRunId = payload.owner.batchContext.taskRunId;
    if (payload.owner.batchContext.taskKey === 'bizOpReconV327:export:op-check') {
      const publication = f.module.publication.record(taskRunId);
      assert.equal(publication.acknowledged, 1);
      assert.equal(publication.cleanup_completed, 1);
      assert.notEqual(f.module.catalog.operation(taskRunId).phase, 'CLOSED');
      fs.writeFileSync(path.join(directory, 'before-crash.json'), JSON.stringify({ taskRunId,
        owner: payload.owner, evidence: publicationEvidence(f, taskRunId) }));
      process.exit(73); // 真退出：ACK 已完成、completion/phase 同事务尚未提交。
    }
    return record(payload);
  };
  await f.exportInput();
  process.exit(99);
}

async function verifyBizOpOwnerRecovery(parentDirectory, mode = 'ack-failure') {
  assert.ok(['ack-failure', 'after-ack-crash', 'closed-legacy-binding', 'failed-terminal-write', 'closed-compensated'].includes(mode));
  const compensated = mode === 'failed-terminal-write' || mode === 'closed-compensated';
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'bizop-owner-'));
  fs.mkdirSync(path.join(directory, 'app'));
  fs.mkdirSync(path.join(directory, 'outputs'));
  let f;
  try {
    let before;
    let owner;
    let taskRunId;
    if (mode === 'after-ack-crash' || compensated) {
      const child = spawnSync(process.execPath, [__filename, '--child', directory, mode], {
        encoding: 'utf8', timeout: process.platform === 'win32' ? 120000 : 45000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.status, 73, child.stderr || child.stdout);
      const saved = JSON.parse(fs.readFileSync(path.join(directory, 'before-crash.json')));
      ({ owner, taskRunId } = saved);
      before = saved.evidence;
      f = await openHost(directory);
    } else {
      f = await openHost(directory);
      if (mode === 'closed-legacy-binding') rewriteNewPublicationBinding(f, (value) => {
        delete value.archiveOwnerCompletion; return value;
      });
      f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
        WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(FAIL,'临时 ACK 写入故障'); END`);
      const result = await f.exportInput();
      taskRunId = result.taskRunId;
      owner = f.owner(taskRunId);
      assert.equal(f.outboxStore.list().length, 1);
      assert.equal(f.service.repository.getOwnerTerminalCompletion(owner), null);
      f.db.exec('DROP TRIGGER fail_ack');
      if (mode === 'closed-legacy-binding') {
        await f.module.publication.acknowledge(taskRunId, f.runtime);
        emulateLegacyClosedOwner(f, taskRunId);
        assert.equal(f.module.recovery.openObligations(), true);
      }
      before = publicationEvidence(f, taskRunId);
      await f.close(); f = null;
      f = await openHost(directory);
    }
    assert.equal(f.module.catalog.control().mode, 'ACTIVE');
    assert.equal((await f.center.initialize()).ok, true);
    assert.equal(f.outboxStore.list().length, 0);
    assert.equal(f.module.recovery.openObligations(), false);
    const proof = f.service.repository.getOwnerTerminalCompletion(owner);
    assert.deepEqual(proof.owner, owner);
    assert.equal(proof.archiveInstanceId, f.service.repository.getArchiveInstanceId());
    assert.equal(proof.terminalStatus, compensated ? 'failed' : 'succeeded');
    assert.equal(proof.afterTerminal, null);
    assert.deepEqual(publicationEvidence(f, taskRunId), before);
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.equal((await f.center.initialize()).ok, true);
    assert.deepEqual(f.service.repository.getOwnerTerminalCompletion(owner), proof);
    const prepared = await f.center.prepareDeleteBatch(owner.batchContext.batchId);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const deleted = await f.center.deleteBatch(owner.batchContext.batchId, prepared.confirmationToken);
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(f.service.repository.getBatch(owner.batchContext.batchId), null);
    assert.equal(f.service.repository.listCleanupJobs().length, 0);
    assert.equal(f.module.recovery.openObligations(), false, '删除后的 issuance/proof 不重新收集或重建原批次');
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.equal((await f.center.initialize()).ok, true);
    const afterDelete = publicationEvidence(f, taskRunId);
    assert.deepEqual(afterDelete.publication, before.publication, '删除归档后仍保留业务发布事实');
    assert.equal(afterDelete.originalHash, before.originalHash, '删除归档后原件不变');
    assert.equal(afterDelete.outputHash, before.outputHash, '删除归档后外部导出不变');
    assert.equal(afterDelete.businessHash, before.businessHash, '删除归档后原业务数据版本、发布状态和收据不变');
    for (const field of ['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey', 'status']) {
      assert.equal(afterDelete.task[field], before.task[field], `删除归档后 Task ${field} 不变`);
    }
    if (compensated) assert.equal(afterDelete.publication.state, 'NOT_COMMITTED');
    return { mode, active: true, sameOwner: true, outboxRemaining: 0, terminalStatus: proof.terminalStatus,
      ...(compensated ? { independentProcessRestart: true, compensated: true } : {}),
      repeatedRecovery: true, fullyDeleted: true, externalFilesPreserved: true };
  } finally {
    if (f) await f.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyBizOpOwnerRecovery };
if (require.main === module) runChild(process.argv[3], process.argv[4]).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
});
