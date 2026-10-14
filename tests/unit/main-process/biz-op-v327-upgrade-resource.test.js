'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { durableDirectoryTest } = require('../../helpers/durable-directory-tests');
const { createUpgradeHost, seedLegacy } = require('../../helpers/biz-op-v327-upgrade');
const { createPlatformResourceBudgets, createPlatformResourceEnvelope } = require('../../../src/main-process/background-execution/resource-budget');
const { createResourceGovernor, closeResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { EXPORT_IO_RESOURCES } = require('../../../src/main-process/biz-op-v327/export-publication');
const { createExperimentalMemoryPolicy } = require('../../../src/main-process/execution-descriptors/memory-profiles');
const { createMemoryAdmissionPolicy } = require('../../../src/main-process/background-execution/memory-admission');
const { inventoryForGovernor, observeMemoryCarrier, sealMemoryActivityInventory } = require('../../../src/main-process/memory-activity');
const { createBizOpRecoveryParticipant } = require('../../../src/main-process/biz-op-v327/recovery-participant');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
const { reportStartupFailure } = require('../../../src/backend/startup-failure');
const { BIZ_OP_RESOURCE_WAIT_MS } = require('../../../src/main-process/biz-op-v327/phase-admission');

const GIB = 1024 ** 3;
const TASK = 'bizOpReconV327:maintenance:upgrade';

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(path.relative(root, file));
    }
  }
  visit(root);
  return files.sort();
}

function preservedState(f, oldFile) {
  return {
    oldSha256: createHash('sha256').update(fs.readFileSync(oldFile)).digest('hex'),
    oldRows: f.db.prepare('SELECT * FROM biz_op_recon_imports').all(),
    settings: f.db.prepare('SELECT * FROM preserve_settings').all(),
    files: filesUnder(f.root)
  };
}

function assertNotStarted(f, oldFile, before) {
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key=?').get(TASK).n, 0);
  for (const table of ['biz_op_v327_activation', 'biz_op_v327_activation_stages', 'biz_op_v327_prepared_ops']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(f.module.catalog.control().mode, 'DISABLED');
  assert.equal(f.module.admission.snapshot().exclusive, false);
  assert.deepEqual(preservedState(f, oldFile), before);
}

async function boundedAttempt(f) {
  let timer;
  try {
    return await Promise.race([
      f.module.activation.run({ quiesceOnly: true }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('启动资源准入未及时结算'), {
          code: 'TEST_RESOURCE_SETTLEMENT_TIMEOUT'
        })), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 预检的排队与 5 秒期限使用可控时钟；升级本身的 worker 仍走真实 runtime。
function clockedGovernor(options) {
  let now = 0;
  const timers = new Set();
  const governor = createResourceGovernor({ agingMs: 0, ...options, now: () => now,
    setTimer(callback, ms) { const timer = { callback, at: now + ms }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); } });
  return { governor,
    async advance(ms) {
      for (let step = 0; step < ms; step += 1000) {
        now += Math.min(1000, ms - step);
        for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    } };
}

// 与 x64 用户机器相同的预算公式和已登记执行档；活动清单接真实的全局载体登记。
function productionLikeGovernor() {
  const envelope = createPlatformResourceEnvelope({ availableParallelism: 12, totalMemoryBytes: 16 * GIB, freeMemoryBytes: 5 * GIB });
  let governor;
  const memoryAdmission = createExperimentalMemoryPolicy({ compatibilityMemoryBytes: envelope.compatibilityBudgets.memoryBytes,
    sampleMemory: () => ({ availableBytes: 5 * GIB, sampledAt: Date.now() }), inventory: () => inventoryForGovernor(() => governor) });
  const clocked = clockedGovernor({ budgets: envelope.hardBudgets, memoryAdmission });
  governor = clocked.governor;
  return clocked;
}

function liveCarrier(t) {
  sealMemoryActivityInventory();
  const carrier = observeMemoryCarrier(() => new EventEmitter());
  t.after(() => carrier.emit('exit'));
  return carrier;
}

async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertEmptyGovernor(governor) {
  const state = governor.snapshot();
  assert.equal(state.queued.size, 0);
  assert.equal(state.activeLeaseCount, 0);
  assert.equal(state.activeDependencyCount, 0);
  assert.ok(Object.values(state.activeUsage).every((value) => value === 0));
}

test('启动预算小于 1 GiB 时明确拒绝，Task、迁移 intent 和旧数据均保持原状', async (t) => {
  const budgets = createPlatformResourceBudgets({ availableParallelism: 4,
    totalMemoryBytes: 16 * GIB, freeMemoryBytes: 2.5 * GIB });
  assert.equal(budgets.memoryBytes, 512 * 1024 ** 2);
  assert.equal(EXPORT_IO_RESOURCES.memoryBytes, GIB);
  const governor = createResourceGovernor({ budgets, agingMs: 0 });
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor }) } });
  const { oldFile } = seedLegacy(f);
  const before = preservedState(f, oldFile);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(boundedAttempt(f), (error) => {
      assert.equal(error.code, 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
      assert.match(error.message, /所需后台资源超过本次可用上限，升级尚未开始/);
      assert.doesNotMatch(error.message, /1024/);
      assert.equal(error.cause.code, 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
      assert.equal(error.detailLines[0], '内部原因：BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
      assert.ok(error.detailLines.includes('内存：需要 1024.0 MiB，本次预算 512.0 MiB，当前剩余 512.0 MiB'));
      return true;
    });
    assertEmptyGovernor(governor);
    assertNotStarted(f, oldFile, before);
  }
});

test('装配内存准入但未匹配执行档资格时，兼容上限不足立即拒绝，明细给出调度器原因与实际上限', async (t) => {
  // 未登记的申请走兼容上限；不用生产策略，避免 Windows x64 宿主上因资格生效而改变路径。
  const memoryAdmission = createMemoryAdmissionPolicy({ compatibilityMemoryBytes: 512 * 1024 ** 2,
    sampleMemory: () => ({ availableBytes: 5 * GIB, sampledAt: Date.now() }) });
  const budgets = createPlatformResourceEnvelope({ availableParallelism: 12, totalMemoryBytes: 16 * GIB, freeMemoryBytes: 5 * GIB }).hardBudgets;
  const governor = createResourceGovernor({ budgets, memoryAdmission, agingMs: 0 });
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  assert.equal(governor.usesMemoryAdmission, true);
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor }) } });
  const { oldFile } = seedLegacy(f);
  const before = preservedState(f, oldFile);
  await assert.rejects(boundedAttempt(f), (error) => {
    assert.equal(error.code, 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
    assert.match(error.message, /所需后台资源超过本次可用上限，升级尚未开始/);
    assert.equal(error.cause.code, 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
    assert.equal(error.cause.cause.code, 'RESOURCE_BUDGET_UNAVAILABLE');
    assert.equal(error.cause.cause.details.reason, 'stable-limit');
    assert.equal(error.detailLines[0], '内部原因：BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
    assert.ok(error.detailLines.includes('实际候选额度：1024.0 MiB'), error.detailLines.join('\n'));
    assert.ok(error.detailLines.includes('调度器原因：stable-limit（兼容上限 512.0 MiB）'), error.detailLines.join('\n'));
    return true;
  });
  assert.equal(governor.snapshot().diagnostics.rejected, 1);
  assertEmptyGovernor(governor);
  assertNotStarted(f, oldFile, before);
});

test('已有不能满足的排队请求时，启动预检最多等待 5 秒，超时只撤掉自己的排队申请', async (t) => {
  const { governor, advance } = clockedGovernor({ budgets: { ...EXPORT_IO_RESOURCES, memoryBytes: 2 * GIB } });
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  const cancellation = new AbortController();
  const older = governor.acquirePhaseLease({ ownerKey: 'older-recovery', actionKey: 'existing-action',
    operationKey: 'existing-operation', resources: { ...EXPORT_IO_RESOURCES, memoryBytes: 3 * GIB },
    lowMemoryBehavior: 'queue', signal: cancellation.signal, timeoutMs: 60000 }).catch((error) => error);
  t.after(async () => { cancellation.abort(); await older; });
  const queueBefore = governor.snapshot().queued.entries;
  assert.equal(queueBefore.length, 1);
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor }) } });
  const { oldFile } = seedLegacy(f);
  const before = preservedState(f, oldFile);

  const attempt = f.module.activation.run({ quiesceOnly: true }).catch((error) => error);
  await until(() => governor.snapshot().queued.size === 2, '预检进入调度器队列');
  await advance(BIZ_OP_RESOURCE_WAIT_MS - 1000);
  assert.equal(governor.snapshot().queued.size, 2, '5 秒期限前仍在排队');
  await advance(1000);
  const error = await attempt;
  assert.equal(error.code, 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
  assert.match(error.message, /等待后台资源超过 5 秒/);
  assert.equal(error.cause.code, 'BIZOP_RESOURCE_WAIT_TIMEOUT');
  assert.ok(error.detailLines.includes('判定记录：等待期间一直没有轮到本申请（入队时前方 1 项）'));
  assert.deepEqual(governor.snapshot().queued.entries, queueBefore);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.ok(Object.values(governor.snapshot().activeUsage).every((value) => value === 0));
  assertNotStarted(f, oldFile, before);
  cancellation.abort();
  assert.equal((await older).code, 'ADMISSION_CANCELLED');
  assertEmptyGovernor(governor);
});

test('生产内存档下有未退出的载体时，5 秒后失败，判定记录指出实际候选和阻塞来源', async (t) => {
  const { governor, advance } = productionLikeGovernor();
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  liveCarrier(t);
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor }) } });
  const { oldFile } = seedLegacy(f);
  const before = preservedState(f, oldFile);
  const attempt = f.module.activation.run({ quiesceOnly: true }).catch((error) => error);
  await until(() => governor.snapshot().queued.size === 1, '预检进入调度器队列');
  await advance(BIZ_OP_RESOURCE_WAIT_MS);
  const error = await attempt;
  assert.equal(error.code, 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
  assert.equal(error.cause.code, 'BIZOP_RESOURCE_WAIT_TIMEOUT');
  const lines = error.detailLines;
  assert.equal(lines[0], '内部原因：BIZOP_RESOURCE_WAIT_TIMEOUT');
  assert.ok(lines.includes('· 普通档 384.0 MiB：存在增长未知的活动（未登记租约 0 / 载体 1 / 主进程活动 0 / 上一代 runtime 0）'), lines.join('\n'));
  assert.ok(lines.includes('· 低内存档 128.0 MiB：低内存档需要独占，但有其他重任务'), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('拒绝后现场（错误处理时采集，可能已变化）：增长未知活动 载体 1 / 主进程活动 0 / 上一代 runtime 0，清单已封存')));
  assert.ok(lines.length <= 19, `明细 ${lines.length} 行`);
  assertNotStarted(f, oldFile, before);
  assertEmptyGovernor(governor);
});

test('载体在等待期间退出后，下一次重查即获批，升级继续推进', async (t) => {
  const { governor, advance } = productionLikeGovernor();
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  const carrier = liveCarrier(t);
  // 预检用可控时钟的 Governor；升级的 inspect worker 仍由 Host 的真实 runtime 启动。
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor, start: (request) => f.runtime.start(request) }) } });
  seedLegacy(f);
  const attempt = f.module.activation.run({ quiesceOnly: true });
  await until(() => governor.snapshot().queued.size === 1, '预检进入调度器队列');
  await advance(2000);
  carrier.emit('exit');
  await advance(1000);
  const result = await attempt;
  assert.equal(result.status, 'pending');
  assert.equal(f.module.catalog.control().mode, 'MIGRATING');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key=?').get(TASK).n, 1);
  assertEmptyGovernor(governor);
});

// 与 main.js 相同的装配：BizOP participant 的 owner 与 post-outbox 钩子挂到真实存档控制器上。
function startupController(t, participant, { afterOwner = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-startup-entry-'));
  const db = new DatabaseSync(path.join(root, 'archive.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = new Map();
  return createArchiveCenterController({
    database: { getSetting: (key) => settings.get(key), setSetting: (key, value) => settings.set(key, value) },
    service: createArchiveService({ database: db, rootDir: path.join(root, 'archive') }),
    outboxStore: createArchiveOutboxStore(path.join(root, 'outbox')),
    recoverInterruptedTaskOwners: [{ ownerName: participant.ownerName,
      recover: async () => { await participant.recoverOwner(); afterOwner(); } }],
    postOutboxStartupHooks: [{ hookName: participant.hookName, run: () => participant.postOutbox() }],
    getProtectedInterruptedTaskBatchIds: () => ({ batchIds: [], taskRunIds: [], sweepUnsafe: false })
  });
}

function startupReport(error) {
  const records = [];
  const report = reportStartupFailure({ error, appendRecord: (_file, record) => records.push(record) });
  return { message: report.message, logged: records[0].details };
}

test('owner 入口的预检超时：启动失败对话框和日志都含内部原因、判定记录和拒绝后现场', async (t) => {
  const { governor, advance } = productionLikeGovernor();
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  liveCarrier(t);
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor, start: (request) => f.runtime.start(request) }) } });
  seedLegacy(f);
  const controller = startupController(t, createBizOpRecoveryParticipant({ module: f.module }));
  const initializing = controller.initialize().catch((error) => error);
  await until(() => governor.snapshot().queued.size === 1, 'owner 预检进入调度器队列');
  await advance(BIZ_OP_RESOURCE_WAIT_MS);
  const error = await initializing;
  assert.equal(error.code, 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED');
  const { message, logged } = startupReport(error);
  assert.match(message, /处理明细：\nbiz-op-v327：\[BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE\] 业务 OP 升级等待后台资源超过 5 秒/);
  for (const text of [message, logged.join('\n')]) {
    assert.match(text, /内部原因：BIZOP_RESOURCE_WAIT_TIMEOUT/);
    assert.match(text, /· 普通档 384.0 MiB：存在增长未知的活动（未登记租约 0 \/ 载体 1/);
    assert.match(text, /拒绝后现场（错误处理时采集，可能已变化）/);
  }
  assert.equal(f.module.catalog.control().mode, 'DISABLED');
});

durableDirectoryTest('post-outbox 入口的续跑预检超时：明细不再丢失，owner 阶段的迁移进度保留', async (t) => {
  const { governor, advance } = productionLikeGovernor();
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor, start: (request) => f.runtime.start(request) }) } });
  seedLegacy(f);
  // owner 阶段预检时调度器为空；此后出现一个未退出的载体，挡住 post-outbox 的续跑预检。
  const controller = startupController(t, createBizOpRecoveryParticipant({ module: f.module }), { afterOwner: () => liveCarrier(t) });
  const initializing = controller.initialize().catch((error) => error);
  await until(() => governor.snapshot().queued.size === 1, 'post-outbox 预检进入调度器队列');
  await advance(BIZ_OP_RESOURCE_WAIT_MS);
  const error = await initializing;
  assert.equal(error.code, 'ARCHIVE_STARTUP_HOOK_FAILED');
  assert.equal(error.cause.code, 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
  const { message, logged } = startupReport(error);
  assert.match(message, /处理明细：\nBizOP activation and recovery：\[BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE\] 业务 OP 升级等待后台资源超过 5 秒/);
  for (const text of [message, logged.join('\n')]) {
    assert.match(text, /内部原因：BIZOP_RESOURCE_WAIT_TIMEOUT/);
    assert.match(text, /· 普通档 384.0 MiB：存在增长未知的活动（未登记租约 0 \/ 载体 1/);
  }
  assert.equal(f.db.prepare('SELECT phase FROM biz_op_v327_activation').get().phase, 'MIGRATING');
  assert.equal(f.module.catalog.control().mode, 'MIGRATING');
});

durableDirectoryTest('预算足够时完成真实升级并释放预检 lease，ACTIVE 重用不重复清理', async (t) => {
  const f = await createUpgradeHost(t);
  const { oldFile, external } = seedLegacy(f);
  const initialGranted = f.runtime.resourceGovernor.snapshot().diagnostics.granted;
  const result = await f.module.activation.run();
  assert.equal(result.status, 'ok');
  assert.equal(result.phase, 'ACTIVE');
  assert.equal(f.module.catalog.control().mode, 'ACTIVE');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key=?').get(TASK).n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external original');
  assert.ok(f.runtime.resourceGovernor.snapshot().diagnostics.granted > initialGranted);
  assertEmptyGovernor(f.runtime.resourceGovernor);
  const granted = f.runtime.resourceGovernor.snapshot().diagnostics.granted;
  assert.equal((await f.module.activation.run()).reused, true);
  assert.equal(f.runtime.resourceGovernor.snapshot().diagnostics.granted, granted);
  assertEmptyGovernor(f.runtime.resourceGovernor);
});

for (const phase of ['MIGRATING', 'LEGACY_DB_CLEARED']) {
  durableDirectoryTest(`${phase} 重启恢复也检查低预算，保留原 intent 后可用同一 Task 继续完成`, async (t) => {
    let root;
    let oldFile;
    let original;
    t.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    await t.test('按真实升级阶段保存后关闭首个 Host', async (t) => {
      const f = await createUpgradeHost(t, { keep: true, host: { async afterStage(current) {
        if (phase === 'LEGACY_DB_CLEARED' && current === phase) {
          throw Object.assign(new Error('保存恢复测试的阶段边界'), { code: 'TEST_PAUSE_UPGRADE' });
        }
      } } });
      root = f.root;
      oldFile = seedLegacy(f).oldFile;
      if (phase === 'MIGRATING') {
        assert.equal((await f.module.activation.run({ quiesceOnly: true })).status, 'pending');
      } else {
        await assert.rejects(f.module.activation.run(), { code: 'TEST_PAUSE_UPGRADE' });
      }
      original = f.db.prepare('SELECT * FROM biz_op_v327_activation').get();
      assert.equal(original.phase, phase);
      assert.equal(f.module.catalog.control().mode, 'MIGRATING');
      assert.ok(fs.existsSync(oldFile));
    });

    await t.test('低内存重开原 Host，恢复准入失败不推进或重建 Task', async (t) => {
      const governor = createResourceGovernor({ budgets: { ...EXPORT_IO_RESOURCES, memoryBytes: GIB / 2 }, agingMs: 0 });
      t.after(() => closeResourceGovernor(governor, 'test complete'));
      const f = await createUpgradeHost(t, { root, keep: true, expectReady: false,
        host: { getRuntime: () => ({ resourceGovernor: governor }) } });
      const before = preservedState(f, oldFile);
      const operation = f.module.catalog.operation(original.task_run_id);
      const task = f.module.catalog.task(original.task_run_id);
      const stages = f.db.prepare('SELECT * FROM biz_op_v327_activation_stages ORDER BY phase').all();
      assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_activation').get(), original);

      await assert.rejects(boundedAttempt(f), { code: 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE' });
      assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_activation').get(), original);
      assert.deepEqual(f.module.catalog.operation(original.task_run_id), operation);
      assert.deepEqual(f.module.catalog.task(original.task_run_id), task);
      assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_activation_stages ORDER BY phase').all(), stages);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key=?').get(TASK).n, 1);
      assert.equal(f.module.catalog.control().mode, 'MIGRATING');
      assert.equal(f.module.admission.snapshot().exclusive, false);
      assert.deepEqual(preservedState(f, oldFile), before);
      assertEmptyGovernor(governor);
    });

    await t.test('再次以足够预算重开，原 Task 与 intent 完整收敛', async (t) => {
      const f = await createUpgradeHost(t, { root, keep: true, expectReady: false });
      const result = await f.module.retryRecovery();
      assert.equal(result.ready, true, JSON.stringify(result));
      const active = f.db.prepare('SELECT * FROM biz_op_v327_activation').get();
      assert.equal(active.phase, 'ACTIVE');
      assert.equal(active.task_run_id, original.task_run_id);
      assert.equal(active.intent_digest, original.intent_digest);
      assert.equal(f.module.catalog.receipt(original.task_run_id).intentDigest, original.intent_digest);
      assert.equal(f.module.catalog.task(original.task_run_id).status, 'succeeded');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key=?').get(TASK).n, 1);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);
      assert.equal(f.module.catalog.control().mode, 'ACTIVE');
      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
      assertEmptyGovernor(f.runtime.resourceGovernor);
    });
  });
}
