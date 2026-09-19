'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createArchiveOwnerHost, publicationEvidence } = require('../helpers/biz-op-v327-archive-owner');
const { seedHistoricalOwnerCopies, ownerProofCount } = require('../helpers/biz-op-v327-historical-owner');
const { PAGE_SIZE } = require('../../src/main-process/biz-op-v327/archive-owner-backfill');

async function openHost(directory, extra = {}) {
  const hooks = [];
  const f = await createArchiveOwnerHost({ after: (hook) => hooks.push(hook) }, {
    root: path.join(directory, 'app'), outputRoot: path.join(directory, 'outputs'), keep: true, ...extra
  });
  return { ...f, async close() { await f.service.pauseBackgroundMaterialization(); for (const hook of hooks.reverse()) await hook(); } };
}

async function crashBeforeCursor(directory) {
  const f = await openHost(directory);
  const exported = await f.exportInput();
  const owners = seedHistoricalOwnerCopies(f, exported.taskRunId, 4097);
  const before = publicationEvidence(f, exported.taskRunId);
  const proofWriter = f.service.repository.recordOwnerTerminalCompletion.bind(f.service.repository);
  const crashBatchId = owners[9].batchContext.batchId;
  fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify({ taskRunId: exported.taskRunId, owners, before }));
  f.service.repository.recordOwnerTerminalCompletion = (payload) => {
    const result = proofWriter(payload);
    if (payload.owner.batchContext.batchId === crashBatchId) process.exit(73);
    return result;
  };
  await f.module.retryRecovery();
  throw new Error('未到达持久游标提交前的退出点');
}

async function verifyBizOpHistoricalOwnerBackfill(parentDirectory) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'bizop-history-'));
  fs.mkdirSync(path.join(directory, 'app')); fs.mkdirSync(path.join(directory, 'outputs'));
  let f;
  try {
    const child = spawnSync(process.execPath, [__filename, '--child', directory], {
      encoding: 'utf8', timeout: process.platform === 'win32' ? 180000 : 90000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 73, child.stderr || child.stdout);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'before.json')));
    let beforeBootstrap;
    f = await openHost(directory, { beforeBootstrap({ db, service }) {
      const instance = service.repository.getArchiveInstanceId();
      beforeBootstrap = {
        cursor: db.prepare('SELECT last_batch_id FROM biz_op_v327_archive_owner_backfill_cursor WHERE archive_instance_id=?').get(instance).last_batch_id,
        proofs: saved.owners.filter((owner) => service.repository.getOwnerTerminalCompletion(owner) !== null).length
      };
    } });
    assert.equal(beforeBootstrap.cursor, saved.owners[8].batchContext.batchId);
    assert.equal(beforeBootstrap.proofs, 9, '退出时第10批未提交的proof与游标一起回滚');
    assert.equal(f.bootstrap.ready, true);
    assert.equal(f.bootstrap.archiveOwnerBackfill.completed, PAGE_SIZE);
    assert.equal(ownerProofCount(f, saved.owners), 9 + PAGE_SIZE);
    assert.equal(f.module.getStatus().archiveOwnerBackfillPending, true);
    assert.equal(f.module.admission.read(() => true), true);
    const resumedCursor = f.db.prepare('SELECT last_batch_id FROM biz_op_v327_archive_owner_backfill_cursor WHERE archive_instance_id=?')
      .get(f.service.repository.getArchiveInstanceId()).last_batch_id;
    assert.equal(resumedCursor, saved.owners[9 + PAGE_SIZE - 1].batchContext.batchId);
    // 余下批次通过与 UI “继续检查存档”相同的模块入口有界推进，不再导出任何业务数据。
    let pages = 1;
    while (f.module.getStatus().archiveOwnerBackfillPending) {
      const next = await f.module.retryRecovery();
      assert.equal(next.ready, true, JSON.stringify(next));
      assert.ok(next.archiveOwnerBackfill.completed > 0);
      assert.ok(next.archiveOwnerBackfill.processed <= PAGE_SIZE);
      assert.ok(++pages < 70);
    }
    assert.equal(ownerProofCount(f, saved.owners), 4097);
    assert.deepEqual(publicationEvidence(f, saved.taskRunId), saved.before);
    assert.equal(f.outboxStore.list().length, 0);
    return { historicalCopies: 4097, realIpcExports: 1, sqlSyntheticHistory: true,
      independentProcessRestart: true, atomicCursorAndProof: true, businessReady: true,
      remaining: 0, originalOwnerFactsPreserved: true };
  } finally {
    if (f) await f.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyBizOpHistoricalOwnerBackfill };
if (require.main === module) crashBeforeCursor(process.argv[3]).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
});
