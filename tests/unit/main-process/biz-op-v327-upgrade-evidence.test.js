'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const { createUpgradeHost, seedLegacy, passedGates } = require('../../helpers/biz-op-v327-upgrade');
const { RELEASE_GATES, evaluateReleaseGates } = require('../../../src/main-process/biz-op-v327/release-gates');
const { hash } = require('../../../src/main-process/biz-op-v327/contracts');

function evidenceSnapshot(f) {
  const activation = f.db.prepare('SELECT * FROM biz_op_v327_activation').get();
  const op = f.module.catalog.operation(activation.task_run_id);
  return { activation, receipt: f.module.catalog.receipt(activation.task_run_id),
    stages: f.db.prepare('SELECT * FROM biz_op_v327_activation_stages ORDER BY phase').all(),
    intent: f.module.payloadStore.readDocument(op.intent_rel_path),
    tasks: f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:maintenance:upgrade'").get().n };
}

test('ACTIVE 重启接受合法证据更新，原授权、收据、阶段和新数据保持原样', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-evidence-active-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let frozen; let retained;
  await t.test('以原人工授权完成激活', async (t) => {
    const f = await createUpgradeHost(t, { root, keep: true, moduleOptions: { releaseGates: RELEASE_GATES } });
    seedLegacy(f); await f.module.activation.run(); await f.module.recovery.run();
    frozen = evidenceSnapshot(f);
    retained = f.module.payloadStore.writeDocument('upgrade/new-data.json', { retained: true });
  });
  const metadata = structuredClone(RELEASE_GATES);
  metadata.fundsAcceptance.reference = 'updated-authorization-reference';
  for (const [label, releaseGates] of [['更新证据引用', metadata], ['以实际 PASS 替换授权', passedGates()]]) {
    await t.test(label, async (t) => {
      assert.notEqual(evaluateReleaseGates(releaseGates).digest, frozen.activation.gates_digest);
      const f = await createUpgradeHost(t, { root, keep: true, moduleOptions: { releaseGates } });
      assert.deepEqual(await f.module.activation.run(), { status: 'ok', phase: 'ACTIVE', reused: true });
      f.module.assertBusinessEnabled();
      assert.deepEqual(evidenceSnapshot(f), frozen);
      assert.equal(f.module.payloadStore.readDocument('upgrade/new-data.json').digest, retained.digest);
      assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
    });
  }
  await t.test('当前授权被撤销仍拒绝启动且不改历史证据', async (t) => {
    const releaseGates = { ...passedGates(), enabled: false };
    const f = await createUpgradeHost(t, { root, keep: true, moduleOptions: { releaseGates } });
    await assert.rejects(f.module.activation.run(), { code: 'BIZOP_RELEASE_GATES_REQUIRED' });
    assert.throws(() => f.module.activation.verifyActive(), { code: 'BIZOP_ACTIVATION_RECEIPT_MISSING' });
    assert.deepEqual(evidenceSnapshot(f), frozen);
  });
  await t.test('篡改冻结授权摘要或移除收据仍拒绝放行', async (t) => {
    const f = await createUpgradeHost(t, { root, keep: true });
    f.db.prepare('UPDATE biz_op_v327_activation SET gates_digest=?').run(evaluateReleaseGates(passedGates()).digest);
    await assert.rejects(f.module.activation.run(), { code: 'BIZOP_ACTIVATION_RECEIPT_MISSING' });
    f.db.prepare('UPDATE biz_op_v327_activation SET gates_digest=?').run(frozen.activation.gates_digest);
    // 模拟收据存储损坏；正常业务删除另有持久防写约束。
    f.db.exec('DROP TRIGGER biz_op_v327_receipt_delete_guard; DELETE FROM biz_op_v327_receipts');
    await assert.rejects(f.module.activation.run(), { code: 'BIZOP_ACTIVATION_RECEIPT_MISSING' });
  });
});

test('未完成升级在证据更新后继续原 Task，最终阶段仍引用首次授权', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-evidence-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let frozen;
  await t.test('冻结首次授权并停在 MIGRATING', async (t) => {
    const f = await createUpgradeHost(t, { root, keep: true, moduleOptions: { releaseGates: RELEASE_GATES } });
    seedLegacy(f); assert.equal((await f.module.activation.run({ quiesceOnly: true })).status, 'pending');
    frozen = evidenceSnapshot(f);
  });
  await t.test('实际 PASS 到达后恢复原任务', async (t) => {
    const f = await createUpgradeHost(t, { root, keep: true, expectReady: false });
    const op = f.module.catalog.operation(frozen.activation.task_run_id);
    const intentPath = f.module.payloadStore.resolve(op.intent_rel_path);
    const originalIntent = fs.readFileSync(intentPath);
    fs.writeFileSync(intentPath, JSON.stringify({ ...frozen.intent.value, root: 'unrelated' }));
    await assert.rejects(f.module.activation.run(), { code: 'BIZOP_ACTIVATION_INTENT_CONFLICT' });
    fs.writeFileSync(intentPath, originalIntent);
    f.db.prepare('UPDATE archive_task_runs SET operation_key=? WHERE task_run_id=?').run('changed-owner', op.task_run_id);
    await assert.rejects(f.module.activation.run(), { code: 'BIZOP_TASK_IDENTITY_MISMATCH' });
    f.db.prepare('UPDATE archive_task_runs SET operation_key=? WHERE task_run_id=?').run(op.operation_key, op.task_run_id);
    assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_activation').get(), frozen.activation);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n, 1);
    assert.ok(fs.existsSync(path.join(root, 'run-data/biz-op-recon/month-2026-08.sqlite')));
    assert.equal((await f.module.retryRecovery()).ready, true);
    const current = evidenceSnapshot(f);
    assert.equal(current.activation.phase, 'ACTIVE');
    assert.equal(current.activation.task_run_id, frozen.activation.task_run_id);
    assert.equal(current.activation.gates_digest, frozen.activation.gates_digest);
    assert.equal(current.activation.intent_digest, frozen.activation.intent_digest);
    assert.deepEqual(current.intent, frozen.intent);
    assert.equal(current.tasks, 1); assert.equal(current.stages.length, 5);
    assert.equal(current.stages.find((stage) => stage.phase === 'ACTIVE').evidence_digest,
      hash({ inventory: current.activation.inventory_digest, gates: frozen.activation.gates_digest }));
    f.module.assertBusinessEnabled();
  });
});
