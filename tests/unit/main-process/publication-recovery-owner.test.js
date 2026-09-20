'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../../../src/main-process/toolbox-output-publication');
const { createWorkerAuthority, seal } = require('../../../src/main-process/publication-recovery/worker-authority');
const { createPublicationRecoveryCoordinator, isPublicationRecoveryObservation } = require('../../../src/main-process/publication-recovery/coordinator');
const { createTestPublicationHarness, createTestPublicationOwner, CONTEXT } = require('../../helpers/publication-authority');
const key = crypto.randomBytes(32).toString('hex');
const authority = createWorkerAuthority(key);
const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function makeRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-authority-')); roots.push(root); return root; }
function signedPrepare(options) {
  const snapshot = core.discoverToolboxPublicationRecovery(options);
  return core.prepareToolboxPublication({ ...options, workerAuthority: authority,
    preflight: seal(key, 'preflight', { root: path.resolve(options.userDataDir), taskId: options.taskId,
      indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID() }) });
}
function fixture(state, root = makeRoot(), taskId = `task-${state}`) {
  const output = path.join(root, `${taskId}-out`);
  fs.mkdirSync(output);
  const generation = path.join(root, `${taskId}-generation`);
  fs.mkdirSync(generation);
  const source = path.join(generation, `${taskId}.xlsx`);
  const target = path.join(output, 'result.xlsx');
  fs.writeFileSync(source, 'new-output'); fs.writeFileSync(target, 'old-output');
  const checkpoint = { preparing: 'prepare:after-staged', prepared: 'prepare:after-index',
    publishing: 'publish:after-publish-rename-before-journal', committed: 'publish:after-committed', finalizing: 'publish:after-committed' }[state];
  const options = { taskId, userDataDir: root, artifacts: [{ sourcePath: source }], targets: [target],
    batchContext: { ...CONTEXT, taskRunId: taskId, operationKey: taskId },
    checkpoint(name) { if (name === checkpoint) throw new core.ToolboxPublicationCrashError(name); } };
  let prepared;
  assert.throws(() => { prepared = signedPrepare(options); core.publishPreparedToolboxPublication(prepared); }, core.ToolboxPublicationCrashError);
  if (state === 'finalizing') {
    const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
    execute(snapshot, grants(snapshot, 'ack-stage'));
  }
  return { root, taskId, source, target, output };
}
function materials(root) {
  const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  const paths = [path.join(root, core.JOURNAL_INDEX_NAME), ...snapshot.records.flatMap((record) => [record.journalPath,
    ...record.indexEntry.stagedAbsolutePaths, ...record.indexEntry.backupAbsolutePaths, ...record.indexEntry.targetAbsolutePaths])];
  return Object.fromEntries(paths.sort().map((file) => [file, fs.existsSync(file)
    ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]));
}
function grants(snapshot, permission) {
  return { root: snapshot.root, indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID(), entries: snapshot.records.map((record) => {
    const context = record.journal?.batchContext || record.indexEntry.batchContext;
    const committed = record.discoveryState === 'finalizing' || ['committed', 'committed-cleanup-pending'].includes(record.journalStatus);
    const selected = permission || (committed ? 'observe-committed' : 'recover-uncommitted');
    return { taskId: record.taskId, recordDigest: record.recordDigest, ownerId: 'test-publication', disposition: 'allow',
      permission: selected, acknowledged: ['ack-stage', 'ack-finalize'].includes(selected), active: snapshot.skippedActive.includes(record.taskId),
      identity: { ownerId: 'test-publication', publisherTaskId: record.taskId, taskRunId: context.taskRunId,
        batchId: context.batchId, operationKey: context.operationKey, proofDigest: 'fixture' } };
  }) };
}
function execute(snapshot, grant) {
  return core.recoverPendingToolboxPublications({ userDataDir: snapshot.root, workerAuthority: authority,
    authorization: seal(key, 'recovery', grant) });
}
for (const state of ['preparing', 'prepared', 'publishing', 'committed', 'finalizing']) {
  for (const conflict of [false, true]) {
    test(`${state} ${conflict ? '冲突 owner' : '未知 owner'}：五类材料摘要不变、没有 execute worker`, async () => {
      const { root } = fixture(state);
      const before = materials(root);
      const ops = [];
      const owners = conflict ? [createTestPublicationOwner({ id: 'a' }), createTestPublicationOwner({ id: 'b' })]
        : [createTestPublicationOwner({ async identify() { return 'not-owned'; } })];
      const { recovery } = createTestPublicationHarness(root, { owners, dispatcherOptions: { onWorkerExit({ op }) { ops.push(op); } } });
      await assert.rejects(recovery.recover({ reason: 'startup' }), (error) => {
        assert.equal(error.code, conflict ? 'PUBLICATION_RECOVERY_OWNER_CONFLICT' : 'PUBLICATION_RECOVERY_OWNER_UNKNOWN');
        assert.equal(error.preserveTemporaryFiles, true);
        assert.ok(error.recoveryPaths.includes(path.join(root, core.JOURNAL_INDEX_NAME)));
        return true;
      });
      assert.deepEqual(materials(root), before);
      assert.deepEqual(ops, ['discover-recovery']);
    });
  }
}
test('缺 grant、错误 owner identity、错误 permission 先验证全部记录，合法前项不 cleanup', () => {
  const { root } = fixture('prepared', makeRoot(), 'first');
  fixture('publishing', root, 'last');
  const before = materials(root);
  for (const mutate of [(value) => value.entries.pop(), (value) => { value.entries[1].identity.batchId = 999; },
    (value) => { value.entries[1].permission = 'ack-finalize'; }]) {
    const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
    const grant = grants(snapshot); mutate(grant);
    assert.throws(() => execute(snapshot, grant), { code: 'PUBLICATION_RECOVERY_GRANT_INVALID' });
    assert.deepEqual(materials(root), before);
  }
});
test('发现后第二条 target 内容漂移：第一条 journal/stage 也零写', () => {
  const { root } = fixture('prepared', makeRoot(), 'first');
  const last = fixture('publishing', root, 'last');
  const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  fs.writeFileSync(last.target, 'outside-change');
  const before = materials(root);
  assert.throws(() => execute(snapshot, grants(snapshot)), { code: 'PUBLICATION_RECOVERY_SNAPSHOT_CHANGED' });
  assert.deepEqual(materials(root), before);
});
test('raw recover、伪造 authority、raw prepare 不获得任何文件写权限', () => {
  const { root } = fixture('prepared');
  const before = materials(root);
  assert.throws(() => core.recoverPendingToolboxPublications({ userDataDir: root }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  assert.throws(() => core.recoverPendingToolboxPublications({ userDataDir: root, workerAuthority: {}, authorization: {} }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  assert.throws(() => core.prepareToolboxPublication({ userDataDir: root, taskId: 'new' }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  assert.deepEqual(materials(root), before);
});
test('observe-committed 即使 ack 标志被错误带入也不能 cleanup；ack-stage 保留 receipt，finalize 才清理', () => {
  const { root } = fixture('committed');
  const before = materials(root);
  let snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  const observed = grants(snapshot); observed.entries[0].acknowledged = true;
  assert.equal(execute(snapshot, observed).recovered[0].action, 'commit-handoff-pending');
  assert.deepEqual(materials(root), before);
  snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  assert.equal(execute(snapshot, grants(snapshot, 'ack-stage')).recovered[0].action, 'commit-finalization-pending');
  snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  assert.equal(snapshot.records[0].discoveryState, 'finalizing');
  assert.ok(fs.existsSync(snapshot.records[0].journalPath));
  assert.equal(execute(snapshot, grants(snapshot, 'ack-finalize')).recovered[0].action, 'commit-cleanup');
  assert.equal(core.discoverToolboxPublicationRecovery({ userDataDir: root }).records.length, 0);
});
test('缺 lineage 不隐式确认 committed：无 context 的合成历史记录仍保留 receipt', () => {
  const { root } = fixture('committed');
  const indexPath = path.join(root, core.JOURNAL_INDEX_NAME);
  const index = JSON.parse(fs.readFileSync(indexPath));
  const journalPath = index.entries[0].journalAbsolutePath;
  const journal = JSON.parse(fs.readFileSync(journalPath));
  delete index.entries[0].batchContext; delete journal.batchContext;
  index.entries[0].outputFiles.forEach((file) => { file.sourceOperation = 'toolbox:publication'; });
  fs.writeFileSync(indexPath, JSON.stringify(index)); fs.writeFileSync(journalPath, JSON.stringify(journal));
  const before = materials(root);
  const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  const record = snapshot.records[0];
  const grant = { root, indexDigest: snapshot.indexDigest, entries: [{ taskId: record.taskId, recordDigest: record.recordDigest,
    ownerId: 'test-publication', identity: { ownerId: 'test-publication', publisherTaskId: record.taskId, taskRunId: record.taskId, batchId: 1, operationKey: record.taskId, proofDigest: 'fixture' }, disposition: 'allow',
    permission: 'observe-committed', acknowledged: false, active: false }] };
  assert.equal(execute(snapshot, grant).recovered[0].action, 'commit-handoff-pending');
  assert.deepEqual(materials(root), before);
});
test('deferred 全根保留，absence 仅显式请求且真正不存在，不能伪造 complete', async () => {
  const { root, taskId } = fixture('prepared');
  const owner = createTestPublicationOwner({ async authorize(record, request, identity) {
    return { disposition: 'defer', permission: null, identity, code: 'TEST_HOLD' };
  } });
  const { recovery } = createTestPublicationHarness(root, { owners: [owner] });
  const before = materials(root);
  const result = await recovery.recover({ reason: 'business-retry', taskIds: [taskId, 'missing'] });
  assert.deepEqual(result.deferred.map((item) => item.taskId), [taskId]);
  assert.deepEqual(result.observation.absentTaskIds, ['missing']);
  assert.equal(isPublicationRecoveryObservation(result.observation), true);
  assert.equal(isPublicationRecoveryObservation({ ...result.observation }), false);
  assert.deepEqual(materials(root), before);
});
test('owner registry 缺失、重复和不成对方法在任何扫描前拒绝', () => {
  const root = makeRoot();
  const dispatcher = { bindRecoveryAuthority() {}, runAuthorizedRecovery() {} };
  for (const owners of [[], [createTestPublicationOwner(), createTestPublicationOwner()], [{ id: 'a', identify() {} }]]) {
    assert.throws(() => createPublicationRecoveryCoordinator({ userDataDir: root, dispatcher, owners }), { code: 'PUBLICATION_RECOVERY_OWNER_REGISTRATION_INVALID' });
  }
});
test('全根先识别：后项未知不能在此前清除已识别前项', async () => {
  const { root } = fixture('prepared', makeRoot(), 'known');
  fixture('publishing', root, 'unknown');
  const before = materials(root);
  const owner = createTestPublicationOwner();
  const identify = owner.identify;
  owner.identify = (record) => record.taskId === 'known' ? identify(record) : 'not-owned';
  const { recovery } = createTestPublicationHarness(root, { owners: [owner] });
  await assert.rejects(recovery.recover({ reason: 'startup' }), { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' });
  assert.deepEqual(materials(root), before);
});
test('publish preflight 对其他 owner 的 deferred 失败关闭，不启动 publish worker', async () => {
  const { root } = fixture('prepared');
  const events = [];
  const owner = createTestPublicationOwner({ async authorize(record, request, identity) {
    return { disposition: 'defer', identity, permission: null, code: 'OWNER_HOLD' };
  } });
  const { dispatcher } = createTestPublicationHarness(root, { owners: [owner], dispatcherOptions: { onWorkerExit({ op }) { events.push(op); } } });
  const before = materials(root);
  await assert.rejects(dispatcher.publish({ taskId: 'next', batchContext: CONTEXT }), (error) => {
    assert.equal(error.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
    assert.equal(error.deferred[0].code, 'OWNER_HOLD');
    return true;
  });
  assert.deepEqual(events, ['discover-recovery', 'execute-recovery']);
  assert.deepEqual(materials(root), before);
});
test('publish preflight 遇未知 owner 零写保留，prepare 不隐式绕过授权', async () => {
  const { root } = fixture('prepared');
  const ops = [];
  const { dispatcher } = createTestPublicationHarness(root, { owners: [createTestPublicationOwner({ identify: () => 'not-owned' })],
    dispatcherOptions: { onWorkerExit({ op }) { ops.push(op); } } });
  const before = materials(root);
  await assert.rejects(dispatcher.publish({ taskId: 'new', batchContext: CONTEXT }), { code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' });
  assert.deepEqual(ops, ['discover-recovery']);
  assert.deepEqual(materials(root), before);
});
test('transport-error 自动恢复遇未知 owner 保留 crash 五材料，不重入 FIFO', async () => {
  const root = makeRoot();
  const generation = path.join(root, 'generation'); const output = path.join(root, 'output');
  fs.mkdirSync(generation); fs.mkdirSync(output);
  const sourcePath = path.join(generation, 'source.xlsx'); const targetPath = path.join(output, 'target.xlsx');
  fs.writeFileSync(sourcePath, 'new'); fs.writeFileSync(targetPath, 'old');
  let afterCrash;
  const ops = [];
  const { dispatcher } = createTestPublicationHarness(root, { owners: [createTestPublicationOwner({ identify: () => 'not-owned' })],
    dispatcherOptions: { workerScriptPath: path.join(__dirname, '__fixtures__/toolbox-publication-stub-crash-recover.js'),
      onWorkerExit({ op }) { ops.push(op); if (op === 'publish') afterCrash = materials(root); } } });
  await assert.rejects(dispatcher.publish({ taskId: 'committed-crash-recover-unknown', artifacts: [{ sourcePath }], targets: [targetPath],
    batchContext: CONTEXT }), (error) => {
    assert.equal(error.code, 'TOOLBOX_PUBLICATION_WORKER_RECOVERY_FAILED');
    assert.equal(error.cause.code, 'PUBLICATION_RECOVERY_OWNER_UNKNOWN');
    assert.equal(error.preserveTemporaryFiles, true);
    return true;
  });
  assert.deepEqual(ops, ['discover-recovery', 'execute-recovery', 'publish', 'discover-recovery']);
  assert.ok(afterCrash);
  assert.deepEqual(materials(root), afterCrash);
});
test('伪造 observation capability 不申请 lease 或启动 worker', async () => {
  const root = makeRoot(); const calls = [];
  const owner = createTestPublicationOwner({ acquireObservation: async () => { calls.push('lease'); return null; } });
  const { recovery } = createTestPublicationHarness(root, { owners: [owner], dispatcherOptions: { onWorkerExit: () => calls.push('exit') } });
  await assert.rejects(recovery.recover({ reason: 'startup', observation: { verifyScope: () => true, release() {} } }),
    { code: 'PUBLICATION_RECOVERY_GRANT_INVALID' });
  assert.deepEqual(calls, []);
});
test('active 记录仍识别 owner，不以 skippedActive 隐藏冲突', async () => {
  const { root } = fixture('prepared');
  const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  snapshot.skippedActive = [snapshot.records[0].taskId];
  let execute = false;
  const dispatcher = { bindRecoveryAuthority() {}, async runAuthorizedRecovery({ authorizeSnapshot }) {
    await authorizeSnapshot(snapshot); execute = true;
  } };
  const coordinator = createPublicationRecoveryCoordinator({ userDataDir: root, dispatcher,
    owners: [createTestPublicationOwner({ id: 'a' }), createTestPublicationOwner({ id: 'b' })] });
  coordinator.bindDispatcherAuthority();
  await assert.rejects(coordinator.forOwner('a').recover({ reason: 'startup' }), { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' });
  assert.equal(execute, false);
});
test('owner 在 authorize 期间观察到外部 journal 漂移，真实 execute worker 在所有副作用前拒绝', async () => {
  const { root } = fixture('prepared');
  let afterChange;
  const owner = createTestPublicationOwner();
  const authorize = owner.authorize;
  owner.authorize = async (record, request, identity) => {
    const journal = JSON.parse(fs.readFileSync(record.journalPath));
    journal.updatedAt = 'external-change'; fs.writeFileSync(record.journalPath, JSON.stringify(journal));
    afterChange = materials(root);
    return authorize(record, request, identity);
  };
  const { recovery } = createTestPublicationHarness(root, { owners: [owner] });
  await assert.rejects(recovery.recover({ reason: 'startup' }), { code: 'PUBLICATION_RECOVERY_SNAPSHOT_CHANGED' });
  assert.deepEqual(materials(root), afterChange);
});
test('plain prepared 对象不能把历史 prepared journal 重新提交，五类恢复材料零写', () => {
  const { root, taskId } = fixture('prepared');
  const record = core.discoverToolboxPublicationRecovery({ userDataDir: root }).records[0];
  const before = materials(root);
  assert.throws(() => core.publishPreparedToolboxPublication({ taskId, userDataDir: root, journalPath: record.journalPath }),
    (error) => error.code === 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' && error.preserveTemporaryFiles === true);
  assert.deepEqual(materials(root), before);
});
test('成功 prepare 的私有 provenance 拒绝复制/重绑定，合法发布只能消费一次', () => {
  const root = makeRoot(); const generation = path.join(root, 'generation'); const output = path.join(root, 'output');
  fs.mkdirSync(generation); fs.mkdirSync(output);
  const sourcePath = path.join(generation, 'source.xlsx'); const targetPath = path.join(output, 'target.xlsx');
  fs.writeFileSync(sourcePath, 'new'); fs.writeFileSync(targetPath, 'old');
  const options = { taskId: 'one-use', userDataDir: root, artifacts: [{ sourcePath }], targets: [targetPath],
    batchContext: CONTEXT, requireArchiveHandoff: true, allowEmptyArchiveInputs: true };
  const prepared = signedPrepare(options);
  let before = materials(root);
  assert.throws(() => core.publishPreparedToolboxPublication({ ...prepared }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  assert.deepEqual(materials(root), before);
  assert.equal(core.publishPreparedToolboxPublication(prepared).committed, true);
  before = materials(root);
  assert.throws(() => core.publishPreparedToolboxPublication(prepared), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
  assert.deepEqual(materials(root), before);
  const rebound = signedPrepare({ ...options, taskId: 'rebound', targets: [path.join(output, 'second.xlsx')] });
  before = materials(root);
  rebound.taskId = 'other-owner-task';
  assert.throws(() => core.publishPreparedToolboxPublication(rebound), { code: 'PUBLICATION_RECOVERY_GRANT_INVALID' });
  assert.deepEqual(materials(root), before);
});
