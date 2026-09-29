'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApplicationRecoveryCoordinator } = require('../../../src/main-process/application-recovery/coordinator');
const { createApplicationRecoveryComposition } = require('../../../src/main-process/application-recovery/composition');
const { createBizOpRecoveryParticipant } = require('../../../src/main-process/biz-op-v327/recovery-participant');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');

const participant = (overrides = {}) => ({ id: 'test-owner', ownerName: '测试 owner',
  preflight: null, recoverOwner: null, postOutbox: null, ...overrides });
const platform = (overrides = {}) => ({ async scanAndRecover() { return { sourceCount: 0, activeHoldCount: 0 }; },
  async recoverSource() {}, ...overrides });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('平台完整扫描成功才写应用事实，转发结果/原错误/hold 且成功事实单调', async () => {
  const failure = Object.assign(new Error('检查器暂缺'), { code: 'TEST_SCAN_FAILED' });
  const summary = { sourceCount: 3, activeHoldCount: 1 };
  let fails = true;
  const source = {}; const hold = {};
  const app = createApplicationRecoveryCoordinator({ participants: [], platform: platform({
    async scanAndRecover() { if (fails) throw failure; return summary; },
    recoverSource(actualSource, actualHold) { assert.equal(actualSource, source); assert.equal(actualHold, hold); return summary; }
  }) });
  await assert.rejects(app.platformFacade.scanAndRecover(), (error) => error === failure);
  assert.equal(app.snapshot().platformScanCompleted, false);
  assert.equal(Object.isFrozen(app.snapshot()), true);
  fails = false;
  assert.equal(await app.platformFacade.scanAndRecover(), summary);
  assert.equal(app.platformFacade.recoverSource(source, hold), summary);
  fails = true;
  await assert.rejects(app.platformFacade.scanAndRecover(), (error) => error === failure);
  assert.equal(app.snapshot().platformScanCompleted, true);
  assert.equal(app.platformFacade.snapshot().platformScanCompleted, true);
});

test('预检单飞并保留原诊断，已完成结果和 hook 不重复执行', async () => {
  const gate = deferred();
  let scans = 0; let owners = 0; let posts = 0;
  const result = { ready: false, reason: 'ARCHIVE_OWNER_PHASE_REQUIRED', fullScans: 0, enumerations: 1 };
  const app = createApplicationRecoveryCoordinator({ platform: platform(), participants: [participant({
    async preflight() { scans += 1; await gate.promise; return result; },
    async recoverOwner() { owners += 1; await app.platformFacade.scanAndRecover(); return result; },
    async postOutbox() { posts += 1; return result; }
  })] });
  const first = app.preflight(); const concurrent = app.preflight();
  assert.equal(first, concurrent);
  assert.equal(app.snapshot().phase, 'preflight');
  gate.resolve();
  const preflight = await first;
  assert.equal(preflight.participantResults[0].result, result);
  assert.equal(await app.preflight(), preflight);
  assert.equal(scans, 1);
  assert.equal(app.snapshot().phase, 'archive');
  assert.equal(app.snapshot().platformScanCompleted, false);
  const owner = app.archiveOwnerHooks()[0];
  const pending = owner.recover(); assert.equal(owner.recover(), pending);
  assert.equal(await pending, result);
  await owner.recover();
  await app.postOutboxHooks()[0].run();
  app.completeArchiveInitialization({ ok: true });
  await owner.recover(); await app.postOutboxHooks()[0].run();
  app.failArchiveInitialization(Object.assign(new Error('迟到错误'), { code: 'LATE_ERROR' }));
  app.completeArchiveInitialization({ ok: true });
  assert.deepEqual(app.snapshot(), { phase: 'ready', platformScanCompleted: true, failureCode: null });
  assert.equal(owners, 1); assert.equal(posts, 1);
});

test('失败 hook 允许显式重试，成功 owner 不重做；未扫描不能宣布应用 ready', async () => {
  let attempts = 0;
  const original = Object.assign(new Error('恢复失败'), { code: 'OWNER_FAILED' });
  const app = createApplicationRecoveryCoordinator({ platform: platform(), participants: [participant({
    async recoverOwner() { if (++attempts === 1) throw original; return 'recovered'; }
  })] });
  await app.preflight();
  await assert.rejects(app.archiveOwnerHooks()[0].recover(), (error) => error === original);
  assert.equal(app.snapshot().failureCode, 'OWNER_FAILED');
  assert.equal(await app.archiveOwnerHooks()[0].recover(), 'recovered');
  assert.equal(attempts, 2);
  assert.throws(() => app.completeArchiveInitialization(), { code: 'BACKGROUND_RECOVERY_SCAN_PENDING' });
  await app.platformFacade.scanAndRecover();
  app.completeArchiveInitialization();
  assert.equal(app.snapshot().phase, 'ready');
});

test('非法/重复 participant 在任何恢复调用前拒绝，冻结调用表隔离外部修改', async () => {
  let calls = 0;
  const p = participant({ recoverOwner: async () => { calls += 1; } });
  for (const participants of [[p, p], [participant({ id: '' })], [participant({ preflight: 1 })],
    [participant({ postOutbox: undefined })], [participant({ ownerName: '' })]]) {
    assert.throws(() => createApplicationRecoveryCoordinator({ platform: platform(), participants }),
      { code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID' });
  }
  assert.equal(calls, 0);
  const participants = [p];
  const app = createApplicationRecoveryCoordinator({ platform: platform(), participants });
  participants.length = 0; p.recoverOwner = () => { throw new Error('注册后替换'); };
  assert.equal(Object.isFrozen(app.archiveOwnerHooks()), true);
  await app.archiveOwnerHooks()[0].recover();
  assert.equal(calls, 1);
});

function compositionFixture(order, { deferredScan = false, activation = false, ownerFailure = null,
  onPending = async () => {}, onLineage = async () => {} } = {}) {
  let facade; let needsActivation = activation; let pending = deferredScan;
  const bizOpModule = {
    recovery: {
      bindPlatform(value) { facade = value; },
      openObligations() { return pending; },
      async run(options) {
        order.push(options?.initialPlatformOnly ? 'preflight' : 'biz-op-owner');
        if (options?.initialPlatformOnly && pending) return { ready: false, reason: 'ARCHIVE_OWNER_PHASE_REQUIRED', fullScans: 0 };
        await facade.scanAndRecover();
        pending = false;
        return { ready: !activation, reason: activation ? 'SCOPE_BLOCKED' : null, sourceCount: 0, activeHoldCount: 0 };
      }
    },
    activation: { needed: () => needsActivation, async run(options) { assert.deepEqual(options, { quiesceOnly: true }); order.push('quiesce'); } },
    async retryRecovery() { order.push('activation-post'); needsActivation = false; await facade.scanAndRecover(); }
  };
  const app = createApplicationRecoveryComposition({
    platform: platform({ async scanAndRecover() { order.push('platform'); return {}; } }),
    bizOpModule,
    recoverPendingRuns: async () => { order.push('pending'); await onPending(); if (ownerFailure) throw ownerFailure; },
    recoverLegacyBizOpRuns: async () => { order.push('legacy-biz'); },
    recoverPreFundRuns: async () => { order.push('prefund'); },
    recoverPosition: async () => { order.push('position'); },
    recoverToolboxVccPublications: async () => { order.push('publications'); },
    recoverVccImportTerminal: async () => { order.push('vcc-terminal'); },
    reconcileVccImportLineage: async () => { order.push('lineage'); await onLineage(); },
    onBizOpRecovery: (result) => { order.push(result.ready ? 'biz-info' : 'biz-warning'); }
  });
  return app;
}

async function archiveFixture(t, app, order) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-recovery-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  const settings = new Map();
  const service = createArchiveService({ database: db, rootDir: path.join(root, 'archive') });
  const outbox = createArchiveOutboxStore(path.join(root, 'outbox'));
  const controller = createArchiveCenterController({
    database: { getSetting: (key) => settings.get(key), setSetting: (key, value) => settings.set(key, value) },
    service, outboxStore: outbox,
    recoverInterruptedTaskOwners: app.archiveOwnerHooks(), postOutboxStartupHooks: app.postOutboxHooks(),
    getProtectedInterruptedTaskBatchIds: () => ({ batchIds: [], taskRunIds: [], sweepUnsafe: false })
  });
  const flush = controller.flushOutbox.bind(controller);
  controller.flushOutbox = async () => { order.push('outbox'); return flush(); };
  for (const [method, event] of [['replayFlowBindIntents', 'batch-flow'], ['replayTaskFlowBindIntents', 'task-flow'],
    ['markInterruptedTasks', 'sweep'], ['recoverStartupSafety', 'safety']]) {
    const run = service[method].bind(service);
    service[method] = async (...args) => { order.push(event); return run(...args); };
  }
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller, service, outbox, db };
}

for (const deferredScan of [false, true]) test(`真实 Archive 组合保持 ${deferredScan ? 'deferred' : 'normal'} 启动相对顺序`, async (t) => {
  const order = [];
  const app = compositionFixture(order, { deferredScan });
  const f = await archiveFixture(t, app, order);
  const preflight = await app.preflight();
  assert.equal(preflight.participantResults[0].result.reason, deferredScan ? 'ARCHIVE_OWNER_PHASE_REQUIRED' : null);
  assert.equal(app.snapshot().platformScanCompleted, !deferredScan);
  app.completeArchiveInitialization(await f.controller.initialize());
  assert.equal(app.snapshot().phase, 'ready');
  assert.deepEqual(order, ['preflight', ...(deferredScan ? [] : ['platform']),
    ...(deferredScan ? ['biz-op-owner', 'platform', 'biz-info'] : []),
    'pending', 'legacy-biz', 'prefund', 'position', 'publications', 'vcc-terminal',
    'outbox', 'batch-flow', 'task-flow', 'sweep', 'safety', 'lineage']);
});

test('owner 失败后真实 SQLite/outbox 仍收口耐久 terminal，后续 owner 已执行且不进入 post-outbox', async (t) => {
  const order = [];
  const original = Object.assign(new Error('owner 保留保护'), { code: 'OWNER_PENDING' });
  let f;
  const context = { taskRunId: 'recovered-task', taskKey: 'position-reconciliation:mappings:save',
    moduleId: 'position-reconciliation-process', parentRunId: 'parent', operationKey: 'operation' };
  const app = compositionFixture(order, { ownerFailure: original, onPending: async () => {
    await f.service.beginTaskRun(context); await f.service.markTaskRunStarted(context.taskRunId);
    f.controller.persistTaskTerminalIntent({ owner: { version: 1, kind: 'operation', operationContext: context },
      sourceOperation: context.taskKey, terminalOutcome: { taskStatus: 'succeeded' } });
    assert.equal(f.outbox.list().length, 1);
  } });
  f = await archiveFixture(t, app, order);
  await app.preflight();
  await assert.rejects(f.controller.initialize().catch((error) => { app.failArchiveInitialization(error); throw error; }), (error) => {
    assert.equal(error.code, 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED');
    assert.equal(error.errors[0], original); return true;
  });
  assert.equal(f.service.repository.getTaskRun(context.taskRunId).status, 'succeeded');
  assert.equal(f.outbox.list().length, 0);
  assert.deepEqual(order, ['preflight', 'platform', 'pending', 'legacy-biz', 'prefund', 'position', 'publications', 'vcc-terminal', 'outbox']);
  assert.deepEqual(app.snapshot(), { phase: 'failed', failureCode: 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED', platformScanCompleted: true });
});

test('activation 先 quiesce，真实 outbox/sweep 收口后 retry；业务 ready=false 保留 warning 而非全局新策略', async (t) => {
  const order = [];
  const app = compositionFixture(order, { deferredScan: true, activation: true });
  const f = await archiveFixture(t, app, order);
  await app.preflight();
  app.completeArchiveInitialization(await f.controller.initialize());
  assert.deepEqual(order, ['preflight', 'quiesce', 'pending', 'legacy-biz', 'prefund', 'position', 'publications', 'vcc-terminal',
    'outbox', 'batch-flow', 'task-flow', 'sweep', 'safety', 'activation-post', 'platform', 'lineage']);
  assert.equal(app.snapshot().phase, 'ready');
});

test('post-outbox 错误由 Controller 保留原 cause 并记录失败阶段', async (t) => {
  const order = [];
  const original = Object.assign(new Error('lineage unavailable'), { code: 'VCC_ARCHIVE_LINEAGE_UNAVAILABLE' });
  const app = compositionFixture(order, { onLineage: async () => { throw original; } });
  const f = await archiveFixture(t, app, order);
  await app.preflight();
  await assert.rejects(f.controller.initialize().catch((error) => { app.failArchiveInitialization(error); throw error; }), (error) => {
    assert.equal(error.code, 'ARCHIVE_STARTUP_HOOK_FAILED'); assert.equal(error.cause, original); return true;
  });
  assert.equal(app.snapshot().failureCode, 'ARCHIVE_STARTUP_HOOK_FAILED');
});


test('BizOP participant 保留 preflight reason 规则，owner ready=false 仍返回原保护诊断', async () => {
  const blocked = { ready: false, sourceCount: 2, activeHoldCount: 1, reason: 'SCOPE_BLOCKED' };
  let result = blocked; let logs = 0; let retries = 0;
  const participant = createBizOpRecoveryParticipant({ module: {
    recovery: { async run() { return result; }, openObligations: () => true },
    activation: { needed: () => false },
    async retryRecovery() { retries += 1; }
  }, onRecovery(summary) { assert.equal(summary, blocked); logs += 1; } });
  await assert.rejects(participant.preflight(), { code: 'SCOPE_BLOCKED', message: '业务 OP 恢复预检未通过，已保留启动保护' });
  result = { ...blocked, reason: 'ARCHIVE_OWNER_PHASE_REQUIRED' };
  assert.equal(await participant.preflight(), result);
  result = blocked;
  assert.equal(await participant.recoverOwner(), blocked);
  assert.equal(logs, 1);
  await participant.postOutbox();
  assert.equal(retries, 0);
});

test('应用预检失败保留原错误，可显式重试且成功阶段不会重复', async () => {
  const original = Object.assign(new Error('预算不足'), { code: 'BIZOP_RECOVERY_SOURCES_LIMIT' });
  let attempts = 0;
  const app = createApplicationRecoveryCoordinator({ platform: platform(), participants: [participant({
    async preflight() { if (++attempts === 1) throw original; return { sourceCount: 0 }; }
  })] });
  await assert.rejects(app.preflight(), (error) => error === original);
  assert.equal(app.snapshot().phase, 'failed');
  assert.equal(app.snapshot().failureCode, original.code);
  await app.preflight(); await app.preflight();
  assert.equal(attempts, 2);
  assert.equal(app.snapshot().phase, 'archive');
  assert.equal(app.snapshot().failureCode, null);
});
