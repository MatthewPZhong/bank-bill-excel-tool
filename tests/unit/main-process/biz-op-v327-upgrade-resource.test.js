'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { durableDirectoryTest } = require('../../helpers/durable-directory-tests');
const { createUpgradeHost, seedLegacy } = require('../../helpers/biz-op-v327-upgrade');
const { createPlatformResourceBudgets } = require('../../../src/main-process/background-execution/resource-budget');
const { createResourceGovernor, closeResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { EXPORT_IO_RESOURCES } = require('../../../src/main-process/biz-op-v327/export-publication');

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
    await assert.rejects(boundedAttempt(f), { code: 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE' });
    assertEmptyGovernor(governor);
    assertNotStarted(f, oldFile, before);
  }
});

test('已有不能满足的排队请求时，启动预检及时拒绝且只撤掉自己的排队申请', async (t) => {
  const governor = createResourceGovernor({ budgets: { ...EXPORT_IO_RESOURCES, memoryBytes: 2 * GIB }, agingMs: 0 });
  t.after(() => closeResourceGovernor(governor, 'test complete'));
  const cancellation = new AbortController();
  const older = governor.acquirePhaseLease({ ownerKey: 'older-recovery', actionKey: 'existing-action',
    operationKey: 'existing-operation', resources: { ...EXPORT_IO_RESOURCES, memoryBytes: 3 * GIB },
    lowMemoryBehavior: 'queue', signal: cancellation.signal }).catch((error) => error);
  t.after(async () => { cancellation.abort(); await older; });
  const queueBefore = governor.snapshot().queued.entries;
  assert.equal(queueBefore.length, 1);
  const f = await createUpgradeHost(t, { host: { getRuntime: () => ({ resourceGovernor: governor }) } });
  const { oldFile } = seedLegacy(f);
  const before = preservedState(f, oldFile);

  await assert.rejects(boundedAttempt(f), { code: 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE' });
  assert.deepEqual(governor.snapshot().queued.entries, queueBefore);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.ok(Object.values(governor.snapshot().activeUsage).every((value) => value === 0));
  assertNotStarted(f, oldFile, before);
  cancellation.abort();
  assert.equal((await older).code, 'ADMISSION_CANCELLED');
  assertEmptyGovernor(governor);
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
