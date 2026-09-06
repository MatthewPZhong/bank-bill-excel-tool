'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { seed, compute } = require('../../helpers/biz-op-v327-compute');
const { writeXlsx, flowRow } = require('../../helpers/biz-op-v327-xlsx');

function remove(f, preview, mode, extra = {}) { return f.module.runDelete({ taskLifecycle: f.lifecycle,
  runtime: f.runtime, previewId: preview.previewId, mode, ...extra }); }
function startId(f) { return f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='OP' ORDER BY data_date LIMIT 1").get().dataset_id; }
async function twoRuns(f) {
  await seed(f); const first = await compute(f);
  f.db.prepare('UPDATE biz_op_v327_runs SET operation_month=? WHERE run_id=?').run('2026-08', first.runId);
  const file = path.join(f.root, 'new-flow.xlsx'); await writeXlsx(file, { rowCount: 1, row: () => flowRow({ amount: '9' }) });
  assert.equal((await f.run([file])).status, 'ok'); const second = await compute(f);
  assert.notEqual(first.runId, second.runId);
  return [first, second];
}
test('完整跨操作月份预览不删除；KEEP_RESULTS 只清当前输入，历史全量/差异与原件在真实回收后仍可导出', async (t) => {
  const f = await createExportHost(t); const runs = await twoRuns(f); const id = startId(f);
  const generation = f.module.catalog.control().generation;
  const preview = f.module.previews.create({ datasetIds: [id] });
  assert.equal(preview.runs.length, 2); assert.equal(new Set(preview.runs.map((row) => row.operationMonth)).size, 2);
  assert.equal(f.module.catalog.control().generation, generation);
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_datasets WHERE dataset_id=?').get(id).state, 'ACTIVE');
  const result = await remove(f, preview, 'KEEP_RESULTS'); assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.receipt.outcome.deleteMode, 'KEEP_RESULTS');
  const recovery = await f.module.recovery.run(); assert.equal(recovery.ready, true, JSON.stringify(recovery));
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(`inputs/${id}`, { mustExist: false })), false);
  for (const run of runs) for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) assert.equal((await request(f, kind, run.runId)).status, 'ok');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM biz_op_v327_runs WHERE state='PUBLISHED'").get().n, 2);
  const again = await remove(f, preview, 'KEEP_RESULTS'); assert.deepEqual(again.receipt, result.receipt);
  await assert.rejects(remove(f, preview, 'DELETE_ASSOCIATED'), { code: 'BIZOP_DELETE_MODE_CONFLICT' });
});
test('DELETE_ASSOCIATED 删除已列出的结果对，其他输入不受影响，用户锁和外部原文件仍存在', async (t) => {
  const f = await createExportHost(t); const runs = await twoRuns(f); const id = startId(f);
  const artifact = f.module.catalog.archive.getArtifact(f.db.prepare('SELECT artifact_id FROM biz_op_v327_dataset_sources WHERE dataset_id=?').get(id).artifact_id);
  f.module.catalog.archive.setLocked(artifact.batchId, true);
  const preview = f.module.previews.create({ datasetIds: [id] }); assert.ok(preview.references.userLockedOriginals > 0);
  const result = await remove(f, preview, 'DELETE_ASSOCIATED'); assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual([...result.receipt.outcome.runIds].sort(), runs.map((run) => run.runId).sort());
  const recovery = await f.module.recovery.run(); assert.equal(recovery.ready, true, JSON.stringify(recovery));
  assert.equal(f.module.catalog.archive.getBatch(artifact.batchId).locked, true);
  assert.equal(fs.existsSync(path.join(f.root, 'start.xlsx')), true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM biz_op_v327_runs WHERE state='PUBLISHED'").get().n, 0);
  assert.equal((await f.service.resolveVerifiedArtifact(artifact.id)).ok, true);
});
test('直接选择结果不会反向删除输入，KEEP_RESULTS 不能用于结果混选', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  const preview = f.module.previews.create({ runIds: [run.runId] });
  await assert.rejects(remove(f, preview, 'KEEP_RESULTS'), { code: 'BIZOP_DELETE_MODE_INVALID' });
  assert.equal((await remove(f, preview, 'DELETE_ASSOCIATED')).status, 'ok');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
});
test('预览过期、generation 或保护状态变化都拒绝确认，业务数据与 Task 数不变', async (t) => {
  const f = await createExportHost(t); await seed(f); await compute(f); const id = startId(f);
  const tasks = () => f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n;
  const initialTasks = tasks();
  const expired = f.module.previews.create({ datasetIds: [id] });
  f.db.prepare('UPDATE biz_op_v327_delete_previews SET expires_at=? WHERE preview_id=?').run('2000-01-01T00:00:00.000Z', expired.previewId);
  await assert.rejects(remove(f, expired, 'KEEP_RESULTS'), { code: 'BIZOP_DELETE_PREVIEW_EXPIRED' });
  const changed = f.module.previews.create({ datasetIds: [id] });
  const artifactId = f.db.prepare('SELECT artifact_id FROM biz_op_v327_dataset_sources WHERE dataset_id=?').get(id).artifact_id;
  f.module.catalog.archive.setLocked(f.module.catalog.archive.getArtifact(artifactId).batchId, true);
  await assert.rejects(remove(f, changed, 'DELETE_ASSOCIATED'), { code: 'BIZOP_DELETE_PREVIEW_STALE' });
  const generation = f.module.previews.create({ datasetIds: [id] });
  f.db.prepare('UPDATE biz_op_v327_control SET generation=generation+1 WHERE singleton=1').run();
  await assert.rejects(remove(f, generation, 'KEEP_RESULTS'), { code: 'BIZOP_DELETE_PREVIEW_STALE' });
  assert.equal(tasks(), initialTasks);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
});
test('删除预检完成后取消不改变选择，真实 worker 关闭后恢复不删除业务数据', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  const preview = f.module.previews.create({ datasetIds: [startId(f)] }); const controller = new AbortController(); let control;
  const result = await remove(f, preview, 'DELETE_ASSOCIATED', { signal: controller.signal,
    onControl(value) { control = value; }, afterWorker() { controller.abort(); } });
  assert.equal(result.status, 'cancelled'); assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_runs WHERE run_id=?').get(run.runId).state, 'PUBLISHED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
});
test('实际导出持有共享读取时，已确认删除请求仍被 Main 拒绝', async (t) => {
  const f = await createExportHost(t); await seed(f); const run = await compute(f);
  const preview = f.module.previews.create({ datasetIds: [startId(f)] }); let attempt;
  assert.equal((await request(f, 'RESULT_FULL', run.runId, { onPublishProgress() {
    if (!attempt) attempt = remove(f, preview, 'DELETE_ASSOCIATED').then(() => assert.fail('读取期间不能删除'), (error) => error.code);
  } })).status, 'ok');
  assert.equal(await attempt, 'BIZOP_MODULE_BUSY');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
});

for (const mode of ['KEEP_RESULTS', 'DELETE_ASSOCIATED']) for (const phase of ['before-commit', 'after-commit']) {
  test(`真实进程退出 ${phase}/${mode}，重启只收敛原 Task 与原模式，不默认级联`, async (t) => {
    const os = require('node:os'); const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-delete-crash-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-delete-crash-target-'));
    const child = spawnSync(process.execPath, [path.join(__dirname, '../../fixtures/biz-op-v327-delete-crash.cjs'), root, outputRoot, phase, mode],
      { encoding: 'utf8', timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(child.status, 73, child.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'delete-evidence.json'), 'utf8'));
    const f = await createExportHost(t, { root, outputRoot }); assert.equal(f.bootstrap.ready, true, JSON.stringify(f.bootstrap));
    const committed = phase === 'after-commit'; const keep = !committed || mode === 'KEEP_RESULTS';
    assert.equal(f.module.catalog.task(saved.taskRunId).status, committed ? 'succeeded' : 'failed');
    assert.equal(Boolean(f.db.prepare('SELECT 1 FROM biz_op_v327_input_heads WHERE dataset_id=?').get(saved.id)), !committed);
    assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_runs WHERE run_id=?').get(saved.runId).state, keep ? 'PUBLISHED' : 'DELETED');
    if (keep) for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) assert.equal((await request(f, kind, saved.runId)).status, 'ok');
    if (committed) {
      const receipt = f.module.catalog.receipt(saved.taskRunId); assert.equal(receipt.outcome.deleteMode, mode);
      const again = await remove(f, saved, mode); assert.equal(again.reused, true); assert.deepEqual(again.receipt, receipt);
    }
    assert.equal(fs.existsSync(path.join(root, 'start.xlsx')), true);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
  });
}
test('预检 worker 后保护状态变化，重新核对闭包拒绝提交，不扩大影响', async (t) => {
  const f = await createExportHost(t); await seed(f); await compute(f); const id = startId(f);
  const preview = f.module.previews.create({ datasetIds: [id] });
  const artifact = f.module.catalog.archive.getArtifact(preview.datasets[0].originals[0].artifactId);
  await assert.rejects(remove(f, preview, 'DELETE_ASSOCIATED', { afterWorker() { f.module.catalog.archive.setLocked(artifact.batchId, true); } }), { code: 'BIZOP_DELETE_PREVIEW_STALE' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM biz_op_v327_runs WHERE state='PUBLISHED'").get().n, 1);
  assert.equal((await f.module.recovery.run()).ready, true);
});

test('KEEP_RESULTS 提交后崩溃且保留说明丢失，重启阻断收尾，不把缺失结果解释为用户删除', async (t) => {
  const os = require('node:os'); const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-keep-missing-'));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-keep-missing-target-'));
  const child = spawnSync(process.execPath, [path.join(__dirname, '../../fixtures/biz-op-v327-delete-crash.cjs'), root, outputRoot, 'after-commit', 'KEEP_RESULTS'],
    { encoding: 'utf8', timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(child.status, 73, child.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'delete-evidence.json'), 'utf8'));
  const dataRoot = path.join(root, 'run-data', 'biz-op-v327');
  const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, 'results', saved.runId, 'manifest.json')));
  const notes = manifest.parts.find((part) => part.partKind === 'NOTES'); assert.ok(notes);
  fs.unlinkSync(path.join(dataRoot, 'results', saved.runId, notes.name));
  const f = await createExportHost(t, { root, outputRoot, expectReady: false });
  assert.notEqual(f.module.catalog.task(saved.taskRunId).status, 'succeeded');
  assert.equal(f.module.catalog.receipt(saved.taskRunId).outcome.deleteMode, 'KEEP_RESULTS');
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_runs WHERE run_id=?').get(saved.runId).state, 'PUBLISHED');
  assert.equal(fs.existsSync(path.join(dataRoot, 'inputs', saved.id)), true, '保留结果证据未恢复时，原输入的待回收文件仍受保护');
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
