'use strict';

// v3.2.20 下线业务OP数据核对（BizOP v327）：升级前在发布中途退出留下的 BizOP 导出发布记录，
//   由 retired-module-publication owner 识别并一律 defer。断言：启动恢复不因 owner 未知而中止、
//   journal / staging / 备份 / 目标原样保留；共享发布器对 defer 记录的失败关闭合同不变（新发布被拒并说明处理方式）；
//   前缀命中但证据不一致时仍失败关闭，非 BizOP 记录不认领。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../../../src/main-process/toolbox-output-publication');
const { createWorkerAuthority, seal } = require('../../../src/main-process/publication-recovery/worker-authority');
const {
  BIZOP_V327_EXPORT_TASK_KEYS,
  BIZOP_V327_TASK_PREFIX,
  RETIRED_PUBLICATION_DEFER_CODE,
  RETIRED_PUBLICATION_MANUAL_CODE,
  RETIRED_PUBLICATION_OWNER_ID,
  createRetiredModulePublicationOwner
} = require('../../../src/main-process/publication-recovery/retired-module-owner');
const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
const { createTestPublicationHarness, createTestPublicationOwner, CONTEXT } = require('../../helpers/publication-authority');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');

const key = crypto.randomBytes(32).toString('hex');
const authority = createWorkerAuthority(key);
const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-retired-owner-'));
  roots.push(root);
  return root;
}

function bizOpContext(taskRunId, overrides = {}) {
  return { batchId: 41, batchNumber: 'BIZOP-20261101-001', taskRunId, taskKey: 'bizOpReconV327:export:result-full',
    moduleId: 'biz-op-recon', parentRunId: 'bizop-parent', operationKey: `bizop-export:${taskRunId}`, ...overrides };
}

// 模拟旧版发布在指定阶段崩溃，留下 index / journal / staging / 备份等恢复材料。
// 与旧版 BizOP v327 导出一致：requireTargetParentIdentity，每个目标登记父目录身份。
function parentIdentityOf(targetPath) {
  return normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
    outputs: [{ filePath: targetPath, role: 'publisher-output', sourceOperation: 'bizop:export' }] }).outputs[0].targetParentIdentity;
}

function leftover(root, { taskId, batchContext, state = 'prepared', secondTarget = false }) {
  // 登记父目录身份时，目标目录不得位于发布恢复根内（与真实用户导出目录一致）。
  const outputRoot = secondTarget ? makeRoot() : root;
  const output = path.join(outputRoot, `${taskId}-out`);
  const generation = path.join(root, `${taskId}-generation`);
  fs.mkdirSync(output);
  fs.mkdirSync(generation);
  const source = path.join(generation, `${taskId}.xlsx`);
  const target = path.join(output, 'result.xlsx');
  fs.writeFileSync(source, 'new-output');
  fs.writeFileSync(target, 'old-output');
  const extra = secondTarget ? { source: path.join(generation, `${taskId}-2.xlsx`),
    target: path.join(outputRoot, `${taskId}-out-2`, 'result-2.xlsx') } : null;
  if (extra) {
    fs.mkdirSync(path.dirname(extra.target));
    fs.writeFileSync(extra.source, 'new-output-2');
  }
  const checkpoint = { prepared: 'prepare:after-index', publishing: 'publish:after-publish-rename-before-journal',
    committed: 'publish:after-committed' }[state];
  const targets = [target, ...(extra ? [extra.target] : [])];
  const options = { taskId, userDataDir: root, artifacts: [{ sourcePath: source }, ...(extra ? [{ sourcePath: extra.source }] : [])],
    targets: extra ? targets.map((targetPath) => ({ targetPath, expectedTargetParentIdentity: parentIdentityOf(targetPath) })) : targets,
    ...(extra ? { requireTargetParentIdentity: true } : {}), batchContext,
    checkpoint(name) { if (name === checkpoint) throw new core.ToolboxPublicationCrashError(name); } };
  assert.throws(() => {
    const snapshot = core.discoverToolboxPublicationRecovery(options);
    const prepared = core.prepareToolboxPublication({ ...options, workerAuthority: authority,
      preflight: seal(key, 'preflight', { root: path.resolve(root), taskId, indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID() }) });
    core.publishPreparedToolboxPublication(prepared);
  }, core.ToolboxPublicationCrashError);
  return { target, secondTarget: extra && extra.target };
}

function materials(root) {
  const snapshot = core.discoverToolboxPublicationRecovery({ userDataDir: root });
  const paths = [path.join(root, core.JOURNAL_INDEX_NAME), ...snapshot.records.flatMap((record) => [record.journalPath,
    ...record.indexEntry.stagedAbsolutePaths, ...record.indexEntry.backupAbsolutePaths, ...record.indexEntry.targetAbsolutePaths])];
  return Object.fromEntries(paths.sort().map((file) => [file, fs.existsSync(file)
    ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]));
}

function recordOf(root, taskId) {
  return core.discoverToolboxPublicationRecovery({ userDataDir: root }).records.find((record) => record.taskId === taskId);
}

test('只认领 BizOP v327 导出前缀与 exact-7 身份，认领后一律 defer', async () => {
  const owner = createRetiredModulePublicationOwner();
  assert.equal(owner.id, RETIRED_PUBLICATION_OWNER_ID);
  assert.equal(BIZOP_V327_EXPORT_TASK_KEYS.length, 7);
  for (const state of ['prepared', 'publishing', 'committed']) {
    const root = makeRoot();
    const taskRunId = `run-${state}`;
    const taskId = `biz-op-v327-export-${taskRunId}`;
    leftover(root, { taskId, batchContext: bizOpContext(taskRunId), state });
    const record = recordOf(root, taskId);
    const identity = await owner.identify(record);
    assert.equal(identity.ownerId, RETIRED_PUBLICATION_OWNER_ID);
    assert.equal(identity.publisherTaskId, taskId);
    assert.equal(identity.taskRunId, taskRunId);
    assert.equal(identity.batchId, 41);
    assert.deepEqual(await owner.authorize(record, { ownerId: null, acknowledgedCommittedTaskIds: [] }, identity),
      { disposition: 'defer', identity, permission: null, code: RETIRED_PUBLICATION_DEFER_CODE }, state);
  }
  const other = makeRoot();
  leftover(other, { taskId: 'toolbox-merge-1', batchContext: { ...CONTEXT, taskRunId: 'toolbox-merge-1', operationKey: 'toolbox-merge-1' } });
  assert.equal(await owner.identify(recordOf(other, 'toolbox-merge-1')), 'not-owned');
  assert.equal(await owner.acquireObservation(), null);
});

test('前缀命中但 taskKey、模块或 taskRunId 与身份不符时失败关闭，不猜测归属', async () => {
  const owner = createRetiredModulePublicationOwner();
  for (const [label, taskRunId, context] of [
    ['非 BizOP 导出 taskKey', 'run-a', bizOpContext('run-a', { taskKey: 'bizOpReconV327:run:candidate' })],
    ['模块不是 biz-op-recon', 'run-b', bizOpContext('run-b', { moduleId: 'toolbox' })],
    ['taskRunId 与 taskId 后缀不一致', 'run-c', bizOpContext('someone-else')]
  ]) {
    const root = makeRoot();
    const taskId = `biz-op-v327-export-${taskRunId}`;
    leftover(root, { taskId, batchContext: context });
    await assert.rejects(owner.identify(recordOf(root, taskId)), { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' }, label);
  }
});

test('启动恢复：遗留 BizOP 发布 defer 且材料不变，归档接管不因此报错；新发布按原合同拒绝并说明处理方式', async () => {
  const root = makeRoot();
  const taskRunId = 'run-startup';
  const taskId = `biz-op-v327-export-${taskRunId}`;
  leftover(root, { taskId, batchContext: bizOpContext(taskRunId), state: 'publishing' });
  const before = materials(root);
  const { recovery, dispatcher } = createTestPublicationHarness(root, {
    owners: [createTestPublicationOwner({ id: 'archive-publication', async identify() { return 'not-owned'; } }),
      createRetiredModulePublicationOwner()],
    ownerId: 'archive-publication'
  });

  const startup = await recovery.recover({ reason: 'startup' });
  assert.deepEqual(startup.deferred.map((item) => [item.taskId, item.ownerId, item.code]),
    [[taskId, RETIRED_PUBLICATION_OWNER_ID, RETIRED_PUBLICATION_DEFER_CODE]]);
  assert.deepEqual(materials(root), before, '启动恢复不改动遗留发布材料');

  const archiveCenter = { persistAppendIntent() { throw new Error('不应接管已下线模块的发布'); }, flushOutbox: async () => ({ remaining: 0 }) };
  const aggregate = await recoverToolboxPublicationsIntoArchive({ userDataDir: root, archiveCenter,
    recoverPublications: recovery.recover });
  assert.deepEqual(aggregate.deferred.map((item) => item.code), [RETIRED_PUBLICATION_DEFER_CODE]);
  assert.deepEqual(materials(root), before);

  await assert.rejects(dispatcher.publish({ taskId: 'next-export', batchContext: CONTEXT }), (error) => {
    assert.equal(error.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
    // 多数导出入口只向用户展示 message，处理方式必须在主消息里。
    assert.match(error.message, /已下线模块「业务OP数据核对」有升级前未完成的导出：请先用 v3\.2\.19 及更早版本打开一次/);
    assert.ok(error.detailLines.some((line) => line.includes('已下线模块「业务OP数据核对」')), error.detailLines.join('\n'));
    return true;
  });
  assert.deepEqual(materials(root), before, '被拒绝的新发布同样不触碰遗留材料');
});

// 旧版收尾时自身回滚失败、已把 journal 标为 manual-recovery：旧版同样无法自动收尾。
function markManualRecovery(record) {
  const journal = JSON.parse(fs.readFileSync(record.journalPath, 'utf8'));
  fs.writeFileSync(record.journalPath, JSON.stringify({ ...journal, status: 'manual-recovery',
    manualRecoveryIssues: ['模拟旧版回滚时目标文件被占用'] }, null, 2));
}

test('共享发布器的已下线前缀与 owner 一致', () => {
  assert.deepEqual(core.RETIRED_PUBLICATION_TASK_PREFIXES, [BIZOP_V327_TASK_PREFIX]);
});

test('已下线业务OP的 manual-recovery 记录：启动放行并原样保留，新发布被拒并提示人工处理；其他模块的同类记录仍阻止', async () => {
  const root = makeRoot();
  const taskRunId = 'run-manual';
  const taskId = `biz-op-v327-export-${taskRunId}`;
  const { secondTarget } = leftover(root, { taskId, batchContext: bizOpContext(taskRunId), state: 'publishing', secondTarget: true });
  markManualRecovery(recordOf(root, taskId));
  // 旧版标记 manual-recovery 的常见原因之一是目标目录被替换（父目录身份变化）：发现阶段对此类已下线记录同样只读放行。
  const secondDir = path.dirname(secondTarget);
  fs.renameSync(secondDir, `${secondDir}-moved`);
  fs.mkdirSync(secondDir);
  const before = materials(root);
  const { recovery, dispatcher } = createTestPublicationHarness(root, {
    owners: [createTestPublicationOwner({ id: 'archive-publication', async identify() { return 'not-owned'; } }),
      createRetiredModulePublicationOwner()],
    ownerId: 'archive-publication'
  });
  const startup = await recovery.recover({ reason: 'startup' });
  assert.deepEqual(startup.deferred.map((item) => [item.taskId, item.ownerId, item.code]),
    [[taskId, RETIRED_PUBLICATION_OWNER_ID, RETIRED_PUBLICATION_MANUAL_CODE]]);
  assert.deepEqual(materials(root), before, '启动恢复不改动人工恢复现场');
  await assert.rejects(dispatcher.publish({ taskId: 'next-export', batchContext: CONTEXT }), (error) => {
    assert.equal(error.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
    assert.match(error.message, /需人工恢复的导出（旧版也无法自动收尾）：请按活动日志中列出的恢复路径人工处理/);
    assert.doesNotMatch(error.message, /v3\.2\.19 及更早版本打开一次/);
    return true;
  });
  assert.deepEqual(materials(root), before);

  // 前缀命中但身份证据不符：仍失败关闭。
  const conflict = makeRoot();
  leftover(conflict, { taskId: 'biz-op-v327-export-run-x', batchContext: bizOpContext('someone-else'), state: 'publishing' });
  markManualRecovery(recordOf(conflict, 'biz-op-v327-export-run-x'));
  await assert.rejects(createRetiredModulePublicationOwner().identify(recordOf(conflict, 'biz-op-v327-export-run-x')),
    { code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT' });

  // 非已下线模块的 manual-recovery 记录：发现阶段照旧直接拒绝。
  const other = makeRoot();
  leftover(other, { taskId: 'toolbox-merge-2', batchContext: { ...CONTEXT, taskRunId: 'toolbox-merge-2', operationKey: 'toolbox-merge-2' },
    state: 'publishing' });
  markManualRecovery(recordOf(other, 'toolbox-merge-2'));
  assert.throws(() => core.discoverToolboxPublicationRecovery({ userDataDir: other }), /仍需人工恢复/);
});
