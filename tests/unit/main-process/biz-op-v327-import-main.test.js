'use strict';
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHost } = require('../../helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../../helpers/biz-op-v327-xlsx');

test('真实平台混批 A+B → 逆序复用 → A+B′，重复原件只读一份，坏批不替换旧 heads', async (t) => {
  const f = await createHost(t);
  const a = path.join(f.root, 'a.xlsx'); const b = path.join(f.root, 'b.xlsx'); const changed = path.join(f.root, 'changed.xlsx');
  const duplicate = path.join(f.root, 'duplicate.xlsx'); const bad = path.join(f.root, 'bad.xlsx');
  await writeXlsx(a, { kind: 'OP', rowCount: 1, row: () => opRow() });
  await writeXlsx(b, { kind: 'OP', rowCount: 1, row: () => opRow({ bu: 'Beta', account: '000456' }) });
  await writeXlsx(changed, { kind: 'OP', rowCount: 1, row: () => opRow({ bu: 'Beta', account: '000456', begin: '200', end: '210' }) });
  fs.copyFileSync(changed, duplicate);
  await writeXlsx(bad, { rowCount: 5, row: () => flowRow({ direction: '不合法' }) });
  const first = await f.run([a, b]); assert.equal(first.status, 'ok', JSON.stringify(first));
  assert.equal(first.receipt.outcome.datasets[0].version, 1); assert.equal(first.summary.acceptedRows, 2);
  const replay = await f.run([b, a]); assert.equal(replay.status, 'ok', JSON.stringify(replay));
  assert.equal(replay.receipt.outcome.datasets[0].version, 1); assert.equal(replay.receipt.outcome.datasets[0].reused, true);
  const next = await f.run([a, changed, duplicate]); assert.equal(next.status, 'ok', JSON.stringify(next));
  assert.equal(next.receipt.outcome.datasets[0].version, 2); assert.equal(next.summary.acceptedRows, 2);
  assert.equal(f.db.prepare("SELECT row_count FROM biz_op_v327_datasets WHERE state='ACTIVE'").get().row_count, 2);
  const before = f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all();
  const rejected = await f.run([a, bad], { options: { maxSamples: 2 } });
  assert.equal(rejected.status, 'error', JSON.stringify(rejected)); assert.equal(rejected.summary.rowErrorCount, 5);
  assert.equal(rejected.summary.collectedSamples, 2); assert.equal(rejected.summary.errorCountExact, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all(), before);
  const report = f.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(rejected.reportRef);
  assert.equal(report.state, 'READY'); assert.equal(f.module.catalog.task(report.task_run_id).status, 'failed');
  assert.equal(f.module.protection.closed(report.task_run_id), true);
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(rejected.reportRef).state, 'READY');
  assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all(), before);
});
test('真实原生 worker 取消可达，先观察关闭再收口，取消不发布任何版本', async (t) => {
  const f = await createHost(t); const file = path.join(f.root, 'cancel.xlsx');
  await writeXlsx(file, { rowCount: 100000, row: (i) => flowRow({ number: String(i) }) });
  let control;
  let observedRows = false;
  let poll;
  t.after(() => clearInterval(poll));
  const started = Date.now();
  const result = await f.run([file], { onControl(value) {
    control = value;
    poll = setInterval(() => {
      const directory = f.module.payloadStore.resolve(`operations/${value.carrierIdentity.taskRunId}`);
      if (fs.readdirSync(directory).some((name) => name.startsWith('allocated-candidate-'))) {
        observedRows = true; clearInterval(poll); value.cancel({ reason: '测试实际取消' });
      }
    }, 20);
  } });
  clearInterval(poll); assert.equal(observedRows, true);
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  const taskRunId = control.carrierIdentity.taskRunId;
  const intent = f.module.payloadStore.readDocument(f.module.catalog.operation(taskRunId).intent_rel_path).value;
  const partial = f.module.payloadStore.readDocument(`operations/${taskRunId}/${intent.candidateRef}.json`).value;
  assert.ok(partial.scannedDataRows > 0); assert.equal(partial.scanComplete, false); assert.equal(partial.errorCountExact, false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_input_heads').get().n, 0);
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  t.diagnostic(`cancel elapsed including Archive: ${Date.now() - started}ms; observed rows: ${partial.scannedDataRows}`);
});
test('三个动态账期已封存后真实 Main 退出：同 Task 恢复报告并回收全部未发布候选', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-import-crash-'));
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../fixtures/biz-op-v327-import-crash.cjs'), root],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(child.status, 73, child.stderr + child.stdout);
  assert.equal(fs.readdirSync(path.join(root, 'run-data/biz-op-v327/inputs')).length, 3);
  const f = await createHost(t, { root });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_input_heads').get().n, 0);
  assert.equal(fs.readdirSync(f.module.payloadStore.resolve('inputs')).length, 0);
  const report = f.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports').get();
  assert.equal(report.state, 'READY'); assert.equal(f.module.catalog.task(report.task_run_id).status, 'failed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 1);
});
test('worker 关闭后候选文件改变，Main 元数据交接拒绝且不发布', async (t) => {
  const f = await createHost(t); const file = path.join(f.root, 'changed-after-exit.xlsx');
  await writeXlsx(file, { rowCount: 1, row: () => flowRow() });
  await assert.rejects(f.run([file], { afterWorker({ taskRunId, candidateRef }) {
    const doc = f.module.payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`).value;
    fs.appendFileSync(f.module.payloadStore.resolve(`inputs/${doc.references[0].objectId}/part-000001.sqlite`), 'changed');
  } }), { code: 'BIZOP_PART_MISMATCH' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_receipts').get().n, 0);
});
