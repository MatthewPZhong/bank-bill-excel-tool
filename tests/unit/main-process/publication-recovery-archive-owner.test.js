'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchivePublicationOwner, ARCHIVE_PUBLICATION_TASKS } = require('../../../src/main-process/publication-recovery/archive-owner');
const { aggregateRecoverySummaries, recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
const { acknowledgeNewAccountSaveAsPublication } = require('../../../src/main-process/new-account/artifact-copy');

async function fixture(t, taskKey = 'toolbox:merge', moduleId = 'toolbox') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-publication-owner-'));
  const db = new DatabaseSync(path.join(root, 'archive.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const service = createArchiveService({ database: db, rootDir: path.join(root, 'archive') });
  await service.initialize();
  const reserved = await service.reserveTaskBatch({ moduleId, taskKey, moduleCode: 'TEST',
    moduleName: '测试', taskRunId: 'run-1', operationKey: 'operation-1', parentRunId: 'parent-1' });
  assert.equal(reserved.ok, true);
  const batch = reserved.batch;
  const batchContext = { batchId: batch.id, batchNumber: batch.batchNumber,
    taskRunId: batch.taskRunId, operationKey: batch.operationKey, parentRunId: batch.parentRunId,
    moduleId: batch.moduleId, taskKey: batch.taskKey };
  const center = createArchiveCenterController({ service, database: {
    getSetting: () => null, setSetting() {}, listTemplates: () => []
  } });
  const owner = createArchivePublicationOwner({ getArchiveCenter: () => center });
  const record = { taskId: 'publisher-1', journalPath: path.join(root, 'journal.json'),
    discoveryState: 'prepared', journalStatus: 'prepared', indexEntry: { batchContext },
    journal: { batchContext, entries: [] } };
  return { owner, record, service, center };
}

test('Archive 静态身份表只包含十六个真实 producer task/module 对', () => {
  assert.equal(ARCHIVE_PUBLICATION_TASKS.length, 16);
  assert.ok(ARCHIVE_PUBLICATION_TASKS.some((entry) => entry.taskKey === 'new-account:export' && entry.moduleId === 'new-account'));
  assert.ok(ARCHIVE_PUBLICATION_TASKS.some((entry) => entry.taskKey === 'recon-id-fix:export' && entry.moduleId === 'recon-fix'));
});

test('合法旧 exact-7 从真实 SQLite 证明归属并允许原取消路径', async (t) => {
  const { owner, record } = await fixture(t);
  const identity = await owner.identify(record);
  assert.equal(identity.ownerId, 'archive-publication');
  assert.equal(identity.legacyProofKind, 'archive-exact-7');
  assert.equal((await owner.authorize(record, { ownerId: owner.id }, identity)).permission, 'recover-uncommitted');
  const fabricated = { ...record, journal: { ...record.journal,
    batchContext: { ...record.journal.batchContext, operationKey: 'another-operation' } } };
  await assert.rejects(owner.identify(fabricated), { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' });
});

test('仅前缀、缺持久 batch 及未登记 producer 均无 owner', async (t) => {
  const { owner, record } = await fixture(t, 'unknown:export', 'unknown');
  assert.equal(await owner.identify(record), 'not-owned');
  assert.equal(await owner.identify({ taskId: 'toolbox-merge-1', indexEntry: {} }), 'not-owned');
  const missing = structuredClone(record);
  missing.journal.batchContext = { ...missing.journal.batchContext, taskKey: 'toolbox:merge', moduleId: 'toolbox', batchId: 999 };
  missing.indexEntry.batchContext = missing.journal.batchContext;
  assert.equal(await owner.identify(missing), 'not-owned');
});

test('committed 可观察，但缺 terminal/artifact proof 的 ack 保留且不得拿调用前置作证明', async (t) => {
  const { owner, record } = await fixture(t, 'new-account:export', 'new-account');
  record.discoveryState = record.journalStatus = 'committed';
  const identity = await owner.identify(record);
  assert.equal((await owner.authorize(record, { ownerId: owner.id }, identity)).permission, 'observe-committed');
  const result = await owner.authorize(record, { ownerId: owner.id,
    acknowledgedCommittedTaskIds: [record.taskId], taskTerminalPersisted: true }, identity);
  assert.equal(result.disposition, 'defer');
  assert.equal(result.permission, null);
  await assert.rejects(owner.authorize(record, { ownerId: 'biz-op-v327', acknowledgedCommittedTaskIds: [record.taskId] }, identity),
    { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' });
});

function summary(overrides = {}) {
  return { recovered: [], skippedActive: [], deferred: [],
    observation: { root: '/isolated', indexDigest: 'digest', complete: true,
      requestedTaskIds: [], absentTaskIds: [] }, ...overrides };
}

test('三阶段聚合保留每次 observation 和 deferred，仅同 owner 的 commit-cleanup 撤销未决', () => {
  const deferred = { taskId: 'task', ownerId: 'archive-publication', code: 'PENDING', recoveryPaths: ['/receipt'] };
  const first = summary({ deferred: [deferred], skippedActive: ['active'] });
  const second = summary({ recovered: [{ taskId: 'task', ownerId: 'biz-op-v327', action: 'commit-cleanup' }] });
  const combined = aggregateRecoverySummaries([first, second, summary()]);
  assert.deepEqual(combined.deferred, [deferred]);
  assert.deepEqual(combined.skippedActive, ['active']);
  assert.equal(combined.observations.length, 3);
  const final = aggregateRecoverySummaries([first, summary({ recovered: [
    { taskId: 'task', ownerId: 'archive-publication', action: 'commit-cleanup' }
  ] })]);
  assert.deepEqual(final.deferred, []);
});

test('启动和 live deferred 在 settlement 之前阻断且错误保存恢复材料', async () => {
  for (const request of [{}, { taskIds: ['task'] }]) {
    let writes = 0;
    const deferred = { taskId: 'task', ownerId: 'archive-publication', code: 'PENDING', recoveryPaths: ['/receipt'] };
    await assert.rejects(recoverToolboxPublicationsIntoArchive({ ...request,
      archiveCenter: { persistAppendIntent() { writes++; }, flushOutbox() { writes++; } },
      recoverPublications: async () => summary({ deferred: [deferred] })
    }), (error) => error.code === 'TOOLBOX_ARCHIVE_HANDOFF_INCOMPLETE'
      && error.preserveTemporaryFiles === true && error.deferred[0] === deferred
      && error.recoveryPaths.includes('/receipt'));
    assert.equal(writes, 0);
  }
});

test('未注入 facade 或旧过滤空结果不得执行 Archive recovery/ack', async () => {
  const archiveCenter = { persistAppendIntent() { throw new Error('不应写'); }, flushOutbox() {} };
  await assert.rejects(recoverToolboxPublicationsIntoArchive({ archiveCenter }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  await assert.rejects(recoverToolboxPublicationsIntoArchive({ archiveCenter,
    recoverPublications: async () => ({ recovered: [], skippedActive: [] }) }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  await assert.rejects(acknowledgeNewAccountSaveAsPublication({ taskId: 'task', taskTerminalPersisted: true }),
    { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  await assert.rejects(acknowledgeNewAccountSaveAsPublication({ taskId: 'task', taskTerminalPersisted: true,
    recoverPublications: async () => summary({ deferred: [{ taskId: 'task' }] }) }),
  { code: 'NEW_ACCOUNT_SAVE_AS_RECEIPT_ACK_FAILED' });
});
