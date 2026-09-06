'use strict';
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHost } = require('../../helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../../helpers/biz-op-v327-xlsx');
const { openReadonly } = require('../../../src/main-process/biz-op-v327/compute-pipeline');
const { RESULT_COLUMNS } = require('../../../src/main-process/biz-op-v327/result-schema');
const { cases } = require('../../fixtures/biz-op-v327-acceptance-cases.json');

const { seed, compute, readResult } = require('../../helpers/biz-op-v327-compute');

for (const stage of ['manifest', 'afterCommit']) test(`计算 ${stage} 取消保护已有结果，按目录提交事实结算`, async (t) => {
  const f = await createHost(t); await seed(f);
  const original = await compute(f); assert.equal(original.status, 'ok');
  const changed = path.join(f.root, 'changed-for-cancel.xlsx');
  await writeXlsx(changed, { rowCount: 1, row: () => flowRow({ amount: '20' }) });
  assert.equal((await f.run([changed])).status, 'ok');
  const runs = f.db.prepare('SELECT * FROM biz_op_v327_runs').all();
  const counters = f.db.prepare('SELECT * FROM biz_op_v327_version_counters').all();
  const abort = new AbortController(); const readDir = fs.promises.readdir;
  let armed = false; let injected = false; let taskRunId;
  fs.promises.readdir = async function (directory, ...args) {
    const result = await readDir.call(this, directory, ...args);
    if (stage === 'manifest' && armed && !injected && String(directory).includes('/results/')) { injected = true; abort.abort(); }
    return result;
  };
  let result;
  try { result = await compute(f, { signal: abort.signal, afterWorker(value) { armed = true; taskRunId = value.taskRunId; },
    afterCommit() { if (stage === 'afterCommit') { injected = true; abort.abort(); } } });
  } finally { fs.promises.readdir = readDir; }
  assert.equal(injected, true); assert.equal(f.module.protection.closed(taskRunId), true);
  assert.deepEqual(f.module.catalog.receipt(original.receipt.taskRunId), original.receipt);
  if (stage === 'afterCommit') {
    assert.equal(result.status, 'ok'); assert.equal(result.version, 2);
    assert.equal(f.module.catalog.task(taskRunId).status, 'succeeded'); return;
  }
  assert.equal(result.status, 'cancelled'); assert.equal(f.module.catalog.task(taskRunId).status, 'cancelled');
  assert.equal(f.module.catalog.receipt(taskRunId), null);
  assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_runs').all(), runs);
  assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_version_counters').all(), counters);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_runs').all(), runs);
});

test('真实 XLSX 到 no-file Task/worker/RESULT：负向差额、独立说明、同输入重复不占版本', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120', count: 2 });
  const result = await compute(f, { options: { partTargetRows: 3 } });
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.version, 1);
  assert.equal(result.fullRowCount, 1); assert.equal(result.diffRowCount, 1);
  const saved = readResult(f, result.runId);
  assert.deepEqual(RESULT_COLUMNS.map((key) => saved.rows[0][key]), ['Alpha', '主体', '客户001', '000123', '付款', 'USD',
    '2026-09-01', '100', '2026-09-03', '120', '10', '0', '-10', '110', '-10', null, '是', '金额不平；多个OP', '金额不平；多个OP；详见核对说明:1']);
  assert.equal(saved.notes.filter((row) => row.record_type === 'ROW_SOURCE').length, 3);
  assert.equal(saved.manifest.rowCount, 1); assert.equal(saved.manifest.catalog.noteRowCount, saved.notes.length);
  assert.ok(saved.manifest.parts.filter((part) => part.partKind === 'NOTES').length > 1);
  assert.equal(f.module.catalog.task(result.receipt.taskRunId).status, 'succeeded');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM archive_batches WHERE task_run_id=?').get(result.receipt.taskRunId).n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  const repeated = await compute(f); assert.equal(repeated.reused, true); assert.equal(repeated.runId, result.runId);
  assert.equal(repeated.publishedAt, saved.run.published_at);
  assert.equal(f.db.prepare("SELECT last_version FROM biz_op_v327_version_counters WHERE scope='RESULT'").get().last_version, 1);
});
test('完整逐日预检缺任何 FLOW 不开始 Task，文件损坏阻断实际计算且无结果版本', async (t) => {
  const f = await createHost(t);
  await assert.rejects(compute(f), (error) => error.code === 'BIZOP_RUN_INPUT_MISSING' && error.missing.length === 4);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM archive_task_runs').get().n, 0);
  await seed(f);
  const dataset = f.db.prepare("SELECT * FROM biz_op_v327_datasets WHERE kind='FLOW' LIMIT 1").get();
  fs.appendFileSync(f.module.payloadStore.resolve(`${path.posix.dirname(dataset.payload_manifest_rel_path)}/part-000001.sqlite`), 'bad');
  const result = await compute(f); assert.equal(result.status, 'error', JSON.stringify(result));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM biz_op_v327_runs").get().n, 0);
  assert.equal((await f.module.recovery.run()).ready, true);
});

test('17 个批准样例经过真实原表、公共 writer 和磁盘集合计算后，逐列符合全部 19 列', async (t) => {
  const f = await createHost(t); const paths = [];
  for (const [role, date] of [['startOpRows', '2026-08-08'], ['endOpRows', '2026-08-10']]) {
    const rows = cases.flatMap((item) => item[role].map((value) => {
      const row = opRow({ date, bu: 'BU-A', account: `${item.caseId}:000123`, begin: value.balance, amount: '0', incoming: '0', end: value.balance });
      row[2] = value.customer; row[3] = value.entity; row[5] = value.accountType; return row;
    }));
    const file = path.join(f.root, `${role}.xlsx`); paths.push(file);
    await writeXlsx(file, { kind: 'OP', rowCount: rows.length, row: (i) => rows[i] });
  }
  const flows = cases.flatMap((item) => item.flowRows.map((value) => flowRow({ date: value.date, bu: 'BU-A',
    account: `${item.caseId}:000123`, direction: value.direction, amount: value.amount, number: '共享单号不去重' })));
  const file = path.join(f.root, 'flows.xlsx'); paths.push(file); await writeXlsx(file, { rowCount: flows.length, row: (i) => flows[i] });
  assert.equal((await f.run(paths)).status, 'ok');
  const result = await compute(f, { startDate: '2026-08-08', endDate: '2026-08-10', options: { partTargetRows: 13 } });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const saved = readResult(f, result.runId); assert.equal(saved.rows.length, 17);
  for (let i = 0; i < cases.length; i += 1) {
    const fixture = cases[i]; const expected = [...fixture.expected19Values];
    expected[3] = `${fixture.caseId}:000123`;
    if (expected[18]) expected[18] = expected[18].replace(`:${fixture.caseId}`, `:${i + 1}`);
    assert.deepEqual(RESULT_COLUMNS.map((column) => saved.rows[i][column]), expected, fixture.caseId);
    assert.equal(Boolean(saved.rows[i].is_difference), fixture.expectedInDifference, fixture.caseId);
  }
  assert.equal(saved.notes.filter((note) => note.record_type === 'ROW_SOURCE').length,
    cases.reduce((sum, item) => sum + item.startOpRows.length + item.endOpRows.length, 0));
  assert.equal(saved.run.full_row_count, 17);
  assert.equal(saved.run.diff_row_count, cases.filter((item) => item.expectedInDifference).length);
});

test('仅流水变化产生新版；中间 OP 不影响指纹；旧输入回收后历史 19 列和来源保持独立', async (t) => {
  const f = await createHost(t); await seed(f);
  const first = await compute(f); assert.equal(first.status, 'ok', JSON.stringify(first));
  const original = readResult(f, first.runId);
  const mid = path.join(f.root, 'mid-op.xlsx');
  await writeXlsx(mid, { kind: 'OP', rowCount: 1, row: () => opRow({ date: '2026-09-02' }) });
  assert.equal((await f.run([mid])).status, 'ok');
  assert.equal((await compute(f)).runId, first.runId);
  const oldFlow = f.db.prepare("SELECT dataset_id FROM biz_op_v327_input_heads WHERE kind='FLOW' AND data_date='2026-09-02'").get().dataset_id;
  const changed = path.join(f.root, 'changed-flow.xlsx');
  await writeXlsx(changed, { rowCount: 2, row: () => flowRow({ date: '2026-09-02', amount: '7', number: '重复单号' }) });
  assert.equal((await f.run([changed])).status, 'ok');
  const next = await compute(f); assert.equal(next.status, 'ok', JSON.stringify(next)); assert.equal(next.version, 2);
  const second = readResult(f, next.runId); assert.equal(second.rows[0].c11_flow_in, '14'); assert.equal(second.rows[0].c15_difference, '4');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(`inputs/${oldFlow}`, { mustExist: false })), false);
  const retained = readResult(f, first.runId);
  assert.deepEqual(retained.rows, original.rows); assert.deepEqual(retained.notes, original.notes);
  for (const artifact of f.db.prepare('SELECT artifact_id FROM biz_op_v327_run_artifacts WHERE run_id=?').iterate(first.runId)) {
    assert.ok(f.module.catalog.archive.listArtifactHolds(artifact.artifact_id).some((hold) => hold.ownerType === 'v327-result' && hold.ownerId === first.runId));
    assert.equal((await f.service.resolveVerifiedArtifact(artifact.artifact_id)).ok, true);
  }
});

test('巨大同键描述组用磁盘集合比对，输入逆序不制造变化，完整来源逐条保存且输出字段冲突留空', async (t) => {
  const f = await createHost(t); const n = 5000; const files = [];
  for (const [date, reverse] of [['2026-09-01', false], ['2026-09-03', true]]) {
    const file = path.join(f.root, `${date}.xlsx`); files.push(file);
    await writeXlsx(file, { kind: 'OP', rowCount: n, row: (i) => {
      const row = opRow({ date, amount: '0', incoming: '0', end: '100' });
      row[3] = `主体😀-${reverse ? n - i - 1 : i}`; return row;
    } });
  }
  const flow = path.join(f.root, 'flow.xlsx'); files.push(flow);
  await writeXlsx(flow, { rowCount: 2, row: (i) => flowRow({ date: i ? '2026-09-03' : '2026-09-02', amount: '0' }) });
  assert.equal((await f.run(files)).status, 'ok');
  const result = await compute(f); assert.equal(result.status, 'ok', JSON.stringify(result));
  const saved = readResult(f, result.runId); assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].c02_entity, null);
  assert.equal(saved.rows[0].c18_conclusion, '金额相等；多个OP；起始描述冲突；终止描述冲突');
  assert.equal(saved.notes.filter((row) => row.record_type === 'ROW_SOURCE').length, 2 * n);
  const summary = JSON.parse(saved.notes.find((row) => row.record_type === 'DESCRIPTION_SOURCE').value_part);
  assert.equal(summary.fields.entity.startCandidateCount, n); assert.equal(summary.fields.entity.endCandidateCount, n);
  assert.equal(result.metrics.peakInputConnections, 1); assert.equal(result.metrics.peakOutputConnections, 1);
  t.diagnostic(JSON.stringify(result.metrics));
});

test('实际工作库写入后取消：读取 pin 存在、并发请求受互斥、关闭后恢复回收，不占结果版本', async (t) => {
  const f = await createHost(t); await seed(f);
  const large = path.join(f.root, 'large.xlsx');
  await writeXlsx(large, { rowCount: 50000, row: (i) => flowRow({ amount: '0', number: String(i) }) });
  assert.equal((await f.run([large])).status, 'ok');
  let control; let poll; let observed = false; let busy;
  t.after(() => clearInterval(poll));
  const result = await compute(f, { onControl(value) {
    control = value;
    busy = compute(f).catch((error) => error.code);
    const root = f.module.payloadStore.resolve(`staging/${value.carrierIdentity.taskRunId}`, { mustExist: false });
    poll = setInterval(() => {
      if (!fs.existsSync(root)) return;
      for (const name of fs.readdirSync(root).filter((item) => item.startsWith('work-'))) {
        const file = path.join(root, name, 'observations.sqlite');
        if (fs.existsSync(file) && fs.statSync(file).size > 65536) {
          assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(value.carrierIdentity.taskRunId).n, 4);
          observed = true; clearInterval(poll); value.cancel({ reason: '测试实际计算取消' });
        }
      }
    }, 10);
  } });
  clearInterval(poll); assert.equal(observed, true);
  assert.equal(await busy, 'BIZOP_MODULE_BUSY'); assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  const taskId = control.carrierIdentity.taskRunId;
  assert.equal(f.module.catalog.task(taskId).status, 'cancelled');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM biz_op_v327_version_counters WHERE scope='RESULT'").get().n, 0);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(`staging/${taskId}`, { mustExist: false })), false);
});

for (const phase of ['after-worker', 'after-commit']) {
  test(`真实 Main 进程退出 ${phase}：重启按原任务、收据和候选事实收敛`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-compute-crash-'));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../fixtures/biz-op-v327-compute-crash.cjs'), root, phase],
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(child.status, 73, child.stderr + child.stdout);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'compute-evidence.json')));
    const f = await createHost(t, { root });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    if (phase === 'after-commit') {
      assert.equal(f.module.catalog.task(evidence.taskRunId).status, 'succeeded');
      assert.deepEqual(f.module.catalog.receipt(evidence.taskRunId), evidence);
      const repeated = await compute(f); assert.equal(repeated.reused, true); assert.equal(repeated.version, 1);
      assert.equal(repeated.runId, evidence.outcome.runId);
    } else {
      assert.equal(f.module.catalog.task(evidence.taskRunId).status, 'failed');
      assert.equal(f.module.catalog.receipt(evidence.taskRunId), null);
      assert.equal(fs.readdirSync(f.module.payloadStore.resolve('results')).length, 0);
      const next = await compute(f); assert.equal(next.status, 'ok', JSON.stringify(next)); assert.equal(next.version, 1);
    }
  });
}

test('后处理篡改目录 generation 时拒绝提交；输入/结果不被部分替换', async (t) => {
  const f = await createHost(t); await seed(f);
  await assert.rejects(compute(f, { afterWorker() {
    f.db.prepare('UPDATE biz_op_v327_control SET generation=generation+1').run();
  } }), { code: 'BIZOP_GENERATION_CHANGED' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_runs').get().n, 0);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(fs.readdirSync(f.module.payloadStore.resolve('results')).length, 0);
});

test('BU、账户大小写/零位和不同币种不串键；高精度金额不损失，长描述说明分片可无损还原', async (t) => {
  const f = await createHost(t); const files = [];
  const keys = [['000123', 'USD'], ['123', 'USD'], ['Abc', 'USD'], ['abc', 'USD'], ['abc', 'CNY'], ['abc', 'CNH'], ['\uE000', 'USD'], ['😀', 'USD']];
  const long = '主体' + '😀'.repeat(10000); const balance = '9007199254740993.123456789123456789';
  for (const date of ['2026-09-01', '2026-09-03']) {
    for (const bu of ['Alpha', 'Beta']) {
      const file = path.join(f.root, `${date}-${bu}.xlsx`); files.push(file);
      const included = bu === 'Alpha' ? keys : keys.slice(0, 1);
      await writeXlsx(file, { kind: 'OP', rowCount: included.length, row: (i) => {
        const row = opRow({ date, bu, account: included[i][0], begin: balance, amount: '0', incoming: '0', end: balance });
        row[6] = included[i][1]; row[3] = i ? '主体' : long; return row;
      } });
    }
  }
  const file = path.join(f.root, 'flows.xlsx'); files.push(file);
  await writeXlsx(file, { rowCount: 2, row: (i) => flowRow({ date: i ? '2026-09-03' : '2026-09-02', amount: '0' }) });
  assert.equal((await f.run(files)).status, 'ok');
  const result = await compute(f); assert.equal(result.status, 'ok', JSON.stringify(result));
  const saved = readResult(f, result.runId);
  assert.equal(saved.rows.length, 9); assert.equal(result.diffRowCount, 0);
  assert.equal(new Set(saved.rows.map((row) => JSON.stringify([row.key_bu, row.key_account, row.key_currency]))).size, 9);
  assert.ok(saved.rows.every((row) => row.c08_start_balance === balance && row.c10_end_balance === balance && row.c15_difference === '0'));
  assert.equal(saved.rows[0].c02_entity, long);
  const sources = saved.notes.filter((row) => row.record_type === 'ROW_SOURCE' && row.result_row_ordinal === 1 && row.source_role === 'START_OP');
  assert.equal(sources.length, 3); assert.equal(sources[0].part_count, 3);
  assert.equal(JSON.parse(sources.map((row) => row.value_part).join('')).entity, long);
  for (const row of saved.notes) if (row.value_part) {
    assert.ok(row.value_part.length <= 8000);
    assert.equal(/[\uD800-\uDBFF]$/.test(row.value_part), false);
  }
});

test('结果删除后旧 receipt 不复活它，新 Task 同输入产生递增版本；成功结果不因重复请求升版', async (t) => {
  const f = await createHost(t); await seed(f);
  const first = await compute(f); assert.equal(first.status, 'ok');
  const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
  await f.module.admission.exclusive(async () => {
    const intent = f.module.catalog.deleteIntent({ datasetIds: [], runIds: [first.runId], deleteMode: 'DELETE_ASSOCIATED',
      expectedGeneration: f.module.catalog.control().generation });
    const result = await f.lifecycle.runOperationOnly({ policy: createTaskPolicyRegistry().require('bizOpReconV327:delete'),
      meta: { channel: 'bizOpReconV327:delete' }, execute(context) {
        const op = f.module.prepareOperation({ taskRunId: context.taskRunId, operationKey: context.operationKey,
          actionKey: 'biz-op-v327:delete-plan', intent });
        f.module.protection.completeInputObligation(context.taskRunId);
        return { status: 'ok', receipt: f.module.catalog.commitDelete({ taskRunId: context.taskRunId, intentDigest: op.intent_digest, intent }) };
      } });
    assert.equal(result.status, 'ok');
  });
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.deepEqual(f.module.catalog.commitRun({ taskRunId: first.receipt.taskRunId, intentDigest: first.receipt.intentDigest }), first.receipt);
  assert.equal(f.module.catalog.receiptState(first.receipt.taskRunId).currentObjects[0].availability, 'deleted');
  const next = await compute(f); assert.equal(next.status, 'ok', JSON.stringify(next)); assert.equal(next.version, 2);
  assert.notEqual(next.runId, first.runId); assert.equal((await compute(f)).runId, next.runId);
});
