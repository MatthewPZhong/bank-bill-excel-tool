'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const { createArchiveOwnerHost, publicationEvidence, emulateLegacyClosedOwner } = require('../../helpers/biz-op-v327-archive-owner');
const { seedHistoricalOwnerCopies, ownerProofCount } = require('../../helpers/biz-op-v327-historical-owner');
const { PAGE_SIZE } = require('../../../src/main-process/biz-op-v327/archive-owner-backfill');
const { createRecoveryBudget } = require('../../../src/main-process/biz-op-v327/recovery-budget');

async function seed(t, count = 3) {
  const f = await createArchiveOwnerHost(t);
  const result = await f.exportInput();
  return { f, taskRunId: result.taskRunId, owners: seedHistoricalOwnerCopies(f, result.taskRunId, count) };
}
const cursor = (f) => f.db.prepare('SELECT last_batch_id FROM biz_op_v327_archive_owner_backfill_cursor WHERE archive_instance_id=?')
  .get(f.service.repository.getArchiveInstanceId())?.last_batch_id || 0;
const failures = (f) => f.db.prepare('SELECT * FROM biz_op_v327_archive_owner_backfill_failures ORDER BY batch_id').all();

test('4097条SQL合成已完成历史不挤占真实恢复预算，64条一页并维持可见续跑状态', async (t) => {
  const { f, taskRunId, owners } = await seed(t, 4097);
  const original = publicationEvidence(f, taskRunId);
  const first = await f.module.recovery.run();
  assert.equal(first.ready, true, JSON.stringify(first));
  assert.equal(first.normalized, 0);
  assert.equal(first.archiveOwnerBackfill.completed, PAGE_SIZE);
  assert.equal(ownerProofCount(f, owners), PAGE_SIZE);
  assert.equal(f.module.getStatus().archiveOwnerBackfillPending, true);
  assert.equal(f.module.admission.read(() => true), true);
  let pages = 1;
  while (f.module.getStatus().archiveOwnerBackfillPending) {
    const result = await f.module.retryRecovery();
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.ok(result.archiveOwnerBackfill.processed <= PAGE_SIZE);
    assert.ok(result.archiveOwnerBackfill.completed > 0, JSON.stringify(result));
    assert.ok(++pages < 70);
  }
  assert.equal(pages, 65);
  assert.equal(ownerProofCount(f, owners), 4097);
  assert.deepEqual(publicationEvidence(f, taskRunId), original);
  assert.equal(f.outboxStore.list().length, 0);
});

test('初始平台扫描不触碰尚未装配的Archive；恢复阶段才补齐', async (t) => {
  const { f, owners } = await seed(t);
  const result = await f.module.recovery.run({ initialPlatformOnly: true });
  assert.equal(result.ready, true);
  assert.equal(result.archiveOwnerBackfill, null);
  assert.equal(ownerProofCount(f, owners), 0);
  assert.equal(cursor(f), 0);
  assert.equal((await f.module.retryRecovery()).archiveOwnerBackfill.completed, 3);
});

for (const fault of ['proof', 'cursor']) test(`历史补齐${fault} SQL写失败：同批proof/游标回滚，重试推进`, async (t) => {
  const { f, owners } = await seed(t);
  const target = owners[1].batchContext.batchId;
  f.db.exec(fault === 'proof'
    ? `CREATE TEMP TRIGGER fail_backfill BEFORE INSERT ON archive_owner_terminal_completions WHEN NEW.batch_id=${target}
       BEGIN SELECT RAISE(ABORT,'历史凭证暂时失败'); END`
    : `CREATE TEMP TRIGGER fail_backfill BEFORE UPDATE ON biz_op_v327_archive_owner_backfill_cursor WHEN NEW.last_batch_id=${target}
       BEGIN SELECT RAISE(ABORT,'历史游标暂时失败'); END`);
  const result = await f.module.retryRecovery();
  assert.equal(result.ready, true);
  assert.equal(result.archiveOwnerBackfill.errorCode, 'ERR_SQLITE_ERROR');
  assert.equal(cursor(f), owners[0].batchContext.batchId);
  assert.equal(ownerProofCount(f, owners), 1);
  assert.equal(f.module.getStatus().archiveOwnerBackfillPending, true);
  f.db.exec('DROP TRIGGER fail_backfill');
  assert.equal((await f.module.retryRecovery()).archiveOwnerBackfill.completed, 2);
  assert.equal(ownerProofCount(f, owners), 3);
});

test('低ID坏历史有持久诊断且不饿死后续页；证据恢复后循环重试', async (t) => {
  const { f, owners } = await seed(t, PAGE_SIZE + 1);
  const bound = f.module.publication.record(owners[0].batchContext.taskRunId);
  const file = f.module.payloadStore.resolve(bound.binding_rel_path);
  const bytes = fs.readFileSync(file); fs.appendFileSync(file, '损坏');
  const first = await f.module.retryRecovery();
  assert.equal(first.ready, true);
  assert.equal(first.archiveOwnerBackfill.completed, PAGE_SIZE - 1);
  assert.equal(first.archiveOwnerBackfill.deferred, 1);
  assert.equal(failures(f)[0].batch_id, owners[0].batchContext.batchId);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owners[0]), null);
  const denied = await f.center.prepareDeleteBatch(owners[0].batchContext.batchId);
  assert.equal(denied.code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
  assert.equal((await f.module.retryRecovery()).archiveOwnerBackfill.completed, 1);
  assert.equal(ownerProofCount(f, owners), PAGE_SIZE);
  fs.writeFileSync(file, bytes);
  assert.equal((await f.module.retryRecovery()).archiveOwnerBackfill.completed, 1);
  assert.equal(ownerProofCount(f, owners), PAGE_SIZE + 1);
  assert.equal(failures(f).length, 0);
  assert.equal(f.module.getStatus().archiveOwnerBackfillPending, false);
});

test('历史归档已失效且外部导出已移动时，仅保留该批次删除诊断', async (t) => {
  const { f, owners } = await seed(t, 1);
  const artifact = f.service.repository.listArtifacts(owners[0].batchContext.batchId)[0];
  fs.unlinkSync(artifact.sourcePath);
  fs.unlinkSync(path.join(f.root, 'archive', artifact.blob.relativePath));
  assert.equal((await f.service.reconcileStartup({ verifyHashes: true })).ok, true);
  const result = await f.module.retryRecovery();
  assert.equal(result.ready, true);
  assert.equal(result.archiveOwnerBackfill.deferred, 1);
  assert.equal(f.module.admission.read(() => true), true);
  assert.equal(f.service.repository.getOwnerTerminalCompletion(owners[0]), null);
  assert.equal(f.module.getStatus().archiveOwnerBackfillPending, true);
  assert.equal((await f.center.prepareDeleteBatch(owners[0].batchContext.batchId)).code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
});

test('当前实例从零补齐，不复用另一个Archive实例的游标', async (t) => {
  const { f, owners } = await seed(t);
  f.db.prepare('INSERT INTO biz_op_v327_archive_owner_backfill_cursor VALUES (?,?,?)').run(randomUUID(), 999999, new Date().toISOString());
  assert.equal((await f.module.retryRecovery()).archiveOwnerBackfill.completed, 3);
  assert.equal(ownerProofCount(f, owners), 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM biz_op_v327_archive_owner_backfill_cursor').get().n, 2);
});

test('4097条历史之外真正未决原owner先恢复；失败时不以历史分页放开业务', async (t) => {
  const f = await createArchiveOwnerHost(t);
  f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(ABORT,'ACK暂时失败'); END`);
  const exported = await f.exportInput();
  const id = exported.taskRunId;
  assert.equal(f.outboxStore.list().length, 1);
  f.db.exec('DROP TRIGGER fail_ack');
  await f.module.publication.acknowledge(id, f.runtime);
  const owners = seedHistoricalOwnerCopies(f, id, 4097, { includeOriginal: false });
  emulateLegacyClosedOwner(f, id);
  f.db.exec(`CREATE TEMP TRIGGER fail_live_owner BEFORE INSERT ON archive_owner_terminal_completions
    WHEN NEW.batch_id=${f.owner(id).batchContext.batchId} BEGIN SELECT RAISE(ABORT,'原owner未完成'); END`);
  f.module.sources.installBudget(createRecoveryBudget());
  const realSources = f.module.sources.collect();
  f.module.sources.clear();
  assert.deepEqual(realSources.map((source) => source.boundedEvidence.category).sort(), ['OPERATION', 'RECLAIM']);
  assert.equal(realSources.find((source) => source.boundedEvidence.category === 'OPERATION').taskRunId, id);
  const reclaim = realSources.find((source) => source.boundedEvidence.category === 'RECLAIM');
  const queue = f.db.prepare('SELECT * FROM biz_op_v327_reclaim_queue WHERE reclaim_id=?').get(reclaim.boundedEvidence.reclaimId);
  assert.equal(queue.owner_task_run_id, reclaim.taskRunId);
  assert.ok(queue.state !== 'DONE' || f.module.catalog.task(reclaim.taskRunId).status !== 'succeeded');
  assert.equal(owners.some((owner) => owner.batchContext.taskRunId === reclaim.taskRunId), false);
  const blocked = await f.module.recovery.run();
  assert.equal(blocked.ready, false);
  assert.equal(blocked.sourceCount, realSources.length);
  assert.ok(blocked.normalized <= 2, '原SQL与outbox可能重复命中同一owner，但历史清单不能进入真实预算');
  assert.equal(blocked.archiveOwnerBackfill, null);
  assert.equal(ownerProofCount(f, owners), 0);
  assert.equal(f.outboxStore.list().length, 1);
  assert.throws(() => f.module.admission.read(() => true), { code: 'BIZOP_RECOVERY_REQUIRED' });
  f.db.exec('DROP TRIGGER fail_live_owner');
  const ready = await f.module.retryRecovery();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.ok(f.service.repository.getOwnerTerminalCompletion(f.owner(id)));
  assert.equal((await f.center.flushOutbox()).remaining, 0);
  assert.equal(ownerProofCount(f, owners), PAGE_SIZE);
});

test('原outbox完整性异常仍拒绝真实恢复，不能当作空历史责任', async (t) => {
  const { f, owners } = await seed(t);
  fs.mkdirSync(f.outboxStore.rootDir, { recursive: true });
  fs.writeFileSync(path.join(f.outboxStore.rootDir, `${randomUUID()}.json`), '{坏记录');
  const result = await f.module.recovery.run();
  assert.equal(result.ready, false);
  assert.equal(ownerProofCount(f, owners), 0);
  assert.equal(result.archiveOwnerBackfill, null);
});

test('4097条真正未决操作仍完整枚举并拒绝超预算，不能借历史分页放行', async (t) => {
  const { f, owners } = await seed(t, 4097);
  f.db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='SETTLING' WHERE action='EXPORT'").run();
  const result = await f.module.recovery.run();
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'BIZOP_RECOVERY_SNAPSHOT_LIMIT');
  assert.equal(result.completedSources, 0);
  assert.equal(result.fullScans, 0);
  assert.equal(result.archiveOwnerBackfill, null);
  assert.equal(ownerProofCount(f, owners), 0);
  assert.equal(cursor(f), 0);
});

test('历史诊断SQL写入失败也不越过原记录；重试后保留诊断再处理后续', async (t) => {
  const { f, owners } = await seed(t);
  const binding = f.module.publication.record(owners[0].batchContext.taskRunId);
  fs.appendFileSync(f.module.payloadStore.resolve(binding.binding_rel_path), '损坏');
  f.db.exec(`CREATE TEMP TRIGGER fail_diagnostic BEFORE INSERT ON biz_op_v327_archive_owner_backfill_failures
    BEGIN SELECT RAISE(ABORT,'诊断写入暂时失败'); END`);
  const failed = await f.module.retryRecovery();
  assert.equal(failed.ready, true);
  assert.equal(failed.archiveOwnerBackfill.errorCode, 'ERR_SQLITE_ERROR');
  assert.equal(cursor(f), 0);
  assert.equal(ownerProofCount(f, owners), 0);
  assert.equal(failures(f).length, 0);
  f.db.exec('DROP TRIGGER fail_diagnostic');
  const retried = await f.module.retryRecovery();
  assert.equal(retried.archiveOwnerBackfill.completed, 2);
  assert.equal(retried.archiveOwnerBackfill.deferred, 1);
  assert.equal(failures(f).length, 1);
  assert.equal(cursor(f), owners[2].batchContext.batchId);
});

test('CLOSED仍有Publisher清理义务而无outbox时继续按真实恢复阻断', async (t) => {
  const { f, owners } = await seed(t, 1);
  f.db.prepare('UPDATE biz_op_v327_publications SET cleanup_completed=0 WHERE task_run_id=?').run(owners[0].batchContext.taskRunId);
  f.db.exec(`CREATE TEMP TRIGGER fail_cleanup BEFORE UPDATE OF cleanup_completed ON biz_op_v327_publications
    WHEN NEW.cleanup_completed=1 BEGIN SELECT RAISE(ABORT,'Publisher清理暂时失败'); END`);
  const blocked = await f.module.recovery.run();
  assert.equal(blocked.ready, false);
  assert.equal(blocked.archiveOwnerBackfill, null);
  assert.equal(f.outboxStore.list().length, 0);
  assert.equal(ownerProofCount(f, owners), 0);
  f.db.exec('DROP TRIGGER fail_cleanup');
  assert.equal((await f.module.retryRecovery()).ready, true);
  assert.equal(ownerProofCount(f, owners), 1);
});
