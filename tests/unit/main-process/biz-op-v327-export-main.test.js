'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { writeXlsx, opRow, flowRow } = require('../../helpers/biz-op-v327-xlsx');
const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
const { createExportHost: createHost, request } = require('../../helpers/biz-op-v327-export');
const { seed, compute } = require('../../helpers/biz-op-v327-compute');
test('真实 FilePlan Task→原生导出→有独立预算的既有 Publisher→Archive，pin 等待输入消费完成', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120' }); const run = await compute(f);
  const warnings = []; f.lifecycle.onArchiveWarning = (warning) => warnings.push(warning);
  const samples = [];
  const result = await request(f, 'RESULT_FULL', run.runId, { onPublishProgress() {
    samples.push({ usage: f.runtime.resourceGovernor.snapshot().activeUsage,
      pins: f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n });
  } });
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.pendingArchiveHandoff, false);
  assert.ok(fs.statSync(result.filePath).size > 0);
  assert.ok(samples.length > 0); assert.ok(samples.every((sample) => sample.pins === 1));
  assert.ok(samples.every((sample) => sample.usage.workerThreadSlots === 1 && sample.usage.memoryBytes === 1073741824));
  assert.equal(f.module.catalog.task(result.taskRunId).status, 'succeeded');
  assert.equal(f.module.publication.fact(result.taskRunId).state, 'COMMITTED');
  assert.equal(f.module.publication.record(result.taskRunId).acknowledged, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.module.catalog.operation(result.taskRunId).phase, 'CLOSED', JSON.stringify(warnings));
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
test('实际导出 worker 关闭后篡改候选，Main 拒绝发布并经原恢复 driver 释放 pin', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  await assert.rejects(request(f, 'RESULT_FULL', run.runId, { afterWorker({ taskRunId, candidateRef }) {
    fs.appendFileSync(f.module.payloadStore.resolve(`staging/${taskRunId}/${candidateRef}/output.xlsx`), 'tampered');
  } }), { code: 'BIZOP_EXPORT_FILE_CHANGED' });
  assert.equal(fs.existsSync(path.join(f.outputRoot, 'result-full.xlsx')), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 1);
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
});

test('六类均接真实 Publisher；失败导入的独立诊断也能由新读取 Task 导出', async (t) => {
  const f = await createHost(t); await seed(f, { end: '120' }); const run = await compute(f);
  const resolve = f.service.resolveVerifiedArtifact.bind(f.service); let rawBudgetChecks = 0;
  f.service.resolveVerifiedArtifact = async (...args) => {
    const usage = f.runtime.resourceGovernor.snapshot().activeUsage;
    assert.equal(usage.memoryBytes, 1073741824); assert.equal(usage.ioHeavySlots, 1); rawBudgetChecks += 1;
    return resolve(...args);
  };
  for (const kind of ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'RESULT_FULL', 'RESULT_DIFF']) {
    const id = kind.startsWith('RESULT') ? run.runId : f.db.prepare('SELECT dataset_id FROM biz_op_v327_datasets WHERE kind=? ORDER BY data_date LIMIT 1')
      .get(kind.split('_')[0]).dataset_id;
    const result = await request(f, kind, id);
    assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(f.module.catalog.task(result.taskRunId).status, 'succeeded');
    assert.equal(f.module.publication.record(result.taskRunId).cleanup_completed, 1);
  }
  assert.ok(rawBudgetChecks >= 2); f.service.resolveVerifiedArtifact = resolve;
  const bad = path.join(f.root, 'bad.xlsx'); await writeXlsx(bad, { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
  assert.notEqual((await f.run([bad])).status, 'ok');
  assert.equal((await f.module.recovery.run()).ready, true);
  const diagnostic = f.db.prepare("SELECT * FROM biz_op_v327_diagnostic_reports WHERE state='READY'").get();
  assert.equal(f.module.catalog.task(diagnostic.task_run_id).status, 'failed');
  const result = await request(f, 'ERRORS', diagnostic.report_ref);
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.dataRowCount, diagnostic.sample_count);
  assert.notEqual(result.taskRunId, diagnostic.task_run_id);
  assert.equal(f.module.catalog.task(diagnostic.task_run_id).status, 'failed');
});
for (const phase of ['before-publish', 'committed-before-observation', 'after-publish']) {
  test(`真实 Main 进程退出 ${phase}：原导出 Task、唯一 Publisher 事实及 pin 收口，不重算 run`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-export-crash-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-export-crash-target-'));
    const child = spawnSync(process.execPath, [path.join(__dirname, '../../fixtures/biz-op-v327-export-crash.cjs'), root, outputRoot, phase],
      { encoding: 'utf8', timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(child.status, 73, child.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'export-evidence.json'), 'utf8'));
    const f = await createHost(t, { root, outputRoot });
    assert.equal(f.bootstrap.ready, true, JSON.stringify(f.bootstrap));
    assert.equal(f.module.catalog.task(saved.taskRunId).status, phase === 'before-publish' ? 'failed' : 'succeeded');
    assert.equal(f.module.publication.fact(saved.taskRunId).state, phase === 'before-publish' ? 'NOT_COMMITTED' : 'COMMITTED');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    assert.equal(f.db.prepare('SELECT result_version FROM biz_op_v327_runs WHERE run_id=?').get(saved.runId).result_version, 1);
    assert.equal(fs.existsSync(path.join(outputRoot, 'result-full.xlsx')), phase !== 'before-publish');
    assert.equal(fs.existsSync(f.module.payloadStore.resolve(`staging/${saved.taskRunId}`, { mustExist: false })), false);
  });
}

module.exports = { request };

test('提交后异常保留 running Task；旧启动 owner 不抢接管，BizOP 恢复原发布事实', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f); let taskId;
  await assert.rejects(request(f, 'RESULT_FULL', run.runId, { afterPublish({ taskRunId }) {
    taskId = taskRunId; throw new Error('提交后的 Main 故障');
  } }), { code: 'BIZOP_PUBLICATION_RECOVERY_REQUIRED' });
  assert.equal(f.module.catalog.task(taskId).status, 'running');
  assert.equal(f.module.publication.fact(taskId).state, 'COMMITTED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n, 1);
  const legacy = await recoverToolboxPublicationsIntoArchive({ userDataDir: f.root,
    archiveCenter: { service: f.service, persistAppendIntent() { assert.fail('旧 owner 不得接管 BizOP'); },
      flushOutbox() { assert.fail('本次没有旧 owner 的待接管结果'); } },
    recoverPublications: f.module.publication.recoverOtherOwners });
  assert.equal(legacy.recovered.length, 0);
  assert.equal(f.module.catalog.task(taskId).status, 'running');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
  assert.equal(f.module.publication.record(taskId).cleanup_completed, 1);
});

test('Archive 输出复制失败保留已提交结果与读取 pin，重试同 Task 后完成', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  const original = f.service.settleManifestArtifacts.bind(f.service); let taskId;
  f.service.settleManifestArtifacts = async (input) => {
    if (input.batchContext.taskRunId === taskId) return { ok: false, durable: false, code: 'TEST_ARCHIVE_IO' };
    return original(input);
  };
  await assert.rejects(request(f, 'RESULT_FULL', run.runId, { afterPublish({ taskRunId }) { taskId = taskRunId; } }),
    { code: 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED' });
  assert.equal(f.module.catalog.task(taskId).status, 'running');
  assert.equal(f.module.publication.fact(taskId).state, 'COMMITTED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n, 1);
  f.service.settleManifestArtifacts = original;
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('Publisher 已确认清理而本地 ACK 写入失败，持久提交证明防止退回未提交', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
    WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(FAIL,'ACK 本地写入故障'); END`);
  const result = await request(f, 'RESULT_FULL', run.runId);
  assert.equal(result.status, 'ok');
  assert.equal(f.module.catalog.task(result.taskRunId).status, 'succeeded');
  assert.equal(f.module.publication.record(result.taskRunId).acknowledged, 0);
  assert.equal(f.module.publication.fact(result.taskRunId).state, 'COMMITTED');
  f.db.exec('DROP TRIGGER fail_ack');
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.publication.record(result.taskRunId).cleanup_completed, 1);
  assert.equal(f.module.publication.fact(result.taskRunId).outcome.files[0].sha256, result.sha256);
});

test('用户目标在 FilePlan 冻结后被改写，Publisher 拒绝覆盖并保留用户的新内容', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  const targetPath = path.join(f.outputRoot, 'changed.xlsx'); fs.writeFileSync(targetPath, '原内容');
  await assert.rejects(request(f, 'RESULT_FULL', run.runId, { targetPath, afterWorker() {
    fs.writeFileSync(targetPath, '后来写入的用户内容');
  } }), /目标|变化|快照|snapshot/);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '后来写入的用户内容');
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
});

test('实际写出后取消，原 worker 退出前存在 pin，退出后恢复候选且不覆盖旧目标', async (t) => {
  const f = await createHost(t); const file = path.join(f.root, 'large-flow.xlsx');
  await writeXlsx(file, { rowCount: 15000, row: (i) => flowRow({ number: String(i) }) });
  assert.equal((await f.run([file])).status, 'ok');
  const id = f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='FLOW'").get().dataset_id;
  const targetPath = path.join(f.outputRoot, 'cancel.xlsx'); fs.writeFileSync(targetPath, '旧目标');
  let poll; let control; let writing = false;
  t.after(() => clearInterval(poll));
  const result = await request(f, 'FLOW_RAW', id, { targetPath, onControl(value) {
    control = value;
    poll = setInterval(() => {
      const root = f.module.payloadStore.resolve(`staging/${value.carrierIdentity.taskRunId}`, { mustExist: false });
      if (!fs.existsSync(root)) return;
      for (const candidate of fs.readdirSync(root)) {
        const xlsx = path.join(root, candidate, 'output.xlsx');
        if (!fs.existsSync(xlsx) || fs.statSync(xlsx).size < 2048) continue;
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(value.carrierIdentity.taskRunId).n, 1);
        writing = true; clearInterval(poll); value.cancel({ reason: '实际导出写入中取消' });
      }
    }, 5);
  } });
  clearInterval(poll); assert.equal(writing, true); assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(control.getCarrierObservation().disposition, 'EXITED');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '旧目标');
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('诊断生产者已失败，清理仍等待新导出 Task 的 Publisher 消费完成', async (t) => {
  const f = await createHost(t); const bad = path.join(f.root, 'bad.xlsx');
  await writeXlsx(bad, { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
  const imported = await f.run([bad]); assert.notEqual(imported.status, 'ok');
  assert.equal((await f.module.recovery.run()).ready, true);
  const report = f.db.prepare("SELECT * FROM biz_op_v327_diagnostic_reports WHERE state='READY'").get();
  assert.equal(f.module.catalog.task(report.task_run_id).status, 'failed');
  let retired = false;
  const result = await request(f, 'ERRORS', report.report_ref, { onPublishProgress() {
    if (!retired) { f.module.protection.retireDiagnostic(report.report_ref, report.task_run_id); retired = true; }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE object_id=?').get(report.report_ref).n, 1);
    assert.equal(fs.existsSync(f.module.payloadStore.resolve(report.report_rel_path)), true);
    assert.equal(f.db.prepare("SELECT state FROM biz_op_v327_reclaim_queue WHERE object_id=? AND payload_kind='DIAGNOSTIC'").get(report.report_ref).state, 'PENDING');
  } });
  assert.equal(retired, true); assert.equal(result.status, 'ok');
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(report.report_ref).state, 'DELETED');
  assert.equal(f.module.catalog.task(report.task_run_id).status, 'failed');
});

test('原 worker 已退出、Publisher 等待容量期间取消，准入后不触碰用户目标', async (t) => {
  const f = await createHost(t); await seed(f); const run = await compute(f);
  const controller = new AbortController(); let taskId;
  const targetPath = path.join(f.outputRoot, 'queued-cancel.xlsx'); fs.writeFileSync(targetPath, '旧目标');
  const result = await request(f, 'RESULT_FULL', run.runId, { signal: controller.signal, targetPath,
    async afterWorker({ taskRunId }) {
      taskId = taskRunId;
      const lease = await f.runtime.resourceGovernor.acquirePhaseLease({ ownerKey: 'capacity-fixture', actionKey: 'fixture', operationKey: 'fixture',
        resources: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 2147483648 }, lowMemoryBehavior: 'queue' });
      setTimeout(() => { controller.abort(); lease.release('fixture-completed'); }, 25);
    } });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(f.module.publication.record(taskId).state, 'NOT_STARTED');
  assert.equal(f.module.catalog.task(taskId).status, 'cancelled');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '旧目标');
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
