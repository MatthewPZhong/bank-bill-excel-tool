'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const path = require('node:path');
const XLSX = require('xlsx');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy, profile } = require('../../../src/main-process/execution-descriptors/memory-profiles');
const { createExportHost, request } = require('../../helpers/biz-op-v327-export');
const { seed, compute, readResult } = require('../../helpers/biz-op-v327-compute');
const { writeXlsx, opRow } = require('../../helpers/biz-op-v327-xlsx');

const MiB = 1024 ** 2;
function governor() {
  return createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 1,
    ioHeavySlots: 2, memoryBytes: 2048 * MiB }, memoryAdmission: createExperimentalMemoryPolicy({
    compatibilityMemoryBytes: 0, sampleMemory: () => ({ availableBytes: 512 * MiB, sampledAt: Date.now() })
  }) });
}

// 此用例串联两套导入/计算、六次导出及恢复。Windows CI 成功记录已达 41 秒，
// 为真实 Worker 启动与文件持久化的调度波动预留有限总时限，并记录各阶段耗时。
const fullWorkflowTimeoutMs = process.platform === 'win32' ? 120000 : 45000;
test('512 MiB 注入准入下真实 OP 导入、计算、六类导出、发布及恢复与普通档业务结果一致', { timeout: fullWorkflowTimeoutMs }, async (t) => {
  const startedAt = Date.now();
  const checkpoint = (stage) => t.diagnostic(JSON.stringify({ stage, elapsedMs: Date.now() - startedAt }));
  const f = await createExportHost(t, { resourceGovernor: governor() });
  checkpoint('低档准备完成');
  await seed(f, { end: '120', count: 3 });
  checkpoint('低档导入完成');
  const result = await compute(f);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  checkpoint('低档计算完成');
  const rows = readResult(f, result.runId).rows;
  assert.equal(rows.length, 1);
  const observations = [];
  for (const kind of ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'RESULT_FULL', 'RESULT_DIFF']) {
    const objectId = kind.startsWith('RESULT') ? result.runId
      : f.db.prepare('SELECT dataset_id FROM biz_op_v327_datasets WHERE kind=? ORDER BY data_date LIMIT 1').get(kind.split('_')[0]).dataset_id;
    const exported = await request(f, kind, objectId, { onPublishProgress() {
      const leases = f.runtime.resourceGovernor.snapshot().activeLeases;
      observations.push(...leases.filter((lease) => lease.kind === 'phase').map((lease) => ({
        bytes: lease.resources.memoryBytes, profile: lease.memoryConfig?.profileId
      })));
    } });
    assert.equal(exported.status, 'ok', JSON.stringify(exported));
    const book = XLSX.readFile(exported.filePath);
    assert.ok(book.SheetNames.length > 0);
    assert.equal(f.module.publication.record(exported.taskRunId).cleanup_completed, 1);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    checkpoint(`低档 ${kind} 导出及清理完成`);
  }
  assert.ok(observations.length > 0);
  assert.ok(observations.every((entry) => entry.bytes < 1024 * MiB && entry.profile.startsWith('bizop-io-')));
  assert.deepEqual(readResult(f, result.runId).rows, rows);
  assert.equal((await f.module.recovery.run()).ready, true);
  checkpoint('低档恢复完成');

  const normal = await createExportHost(t);
  await seed(normal, { end: '120', count: 3 });
  checkpoint('普通档导入完成');
  const baseline = await compute(normal);
  checkpoint('普通档计算完成');
  const values = (items) => items.map(({ owner_id, ...row }) => row);
  // 结果表不含运行随机身份；完整业务列逐项比较。
  assert.deepEqual(values(readResult(normal, baseline.runId).rows), values(rows));
  checkpoint('完整业务结果对照通过');
});

test('低档错误行诊断仍可经导出 worker、Publisher 和借用观察完整结算', { timeout: 20000 }, async (t) => {
  const f = await createExportHost(t, { resourceGovernor: governor() });
  const bad = path.join(f.root, 'invalid.xlsx');
  await writeXlsx(bad, { kind: 'OP', rowCount: 3, row: () => opRow({ end: '999' }) });
  const imported = await f.run([bad]);
  assert.notEqual(imported.status, 'ok');
  assert.equal((await f.module.recovery.run()).ready, true);
  const diagnostic = f.db.prepare("SELECT * FROM biz_op_v327_diagnostic_reports WHERE state='READY'").get();
  assert.ok(diagnostic);
  const output = await request(f, 'ERRORS', diagnostic.report_ref);
  assert.equal(output.status, 'ok', JSON.stringify(output));
  assert.equal(output.dataRowCount, diagnostic.sample_count);
  assert.equal(f.module.catalog.task(diagnostic.task_run_id).status, 'failed');
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('候选配置按完整阶段分配，SQLite 合计与流缓冲额度在阶段额度内', () => {
  const computeProfile = profile('bizop-compute', 'low');
  assert.equal(computeProfile.maxOpenConnections, 3);
  assert.equal(computeProfile.validatedEvidenceId, null);
  assert.equal(profile('bizop-io', 'low').phaseMemoryBytes, 128 * MiB);
});


test('低档导入超过错误样本上限后，真实自动报告仍保存且不伪报精确全量', { timeout: 45000 }, async (t) => {
  const f = await createExportHost(t, { resourceGovernor: governor() });
  const bad = path.join(f.root, 'truncated-errors.xlsx');
  await writeXlsx(bad, { kind: 'OP', rowCount: 1100, row: () => opRow({ end: '999' }) });
  let identity;
  const result = await f.run([bad], { onTaskIdentified: (value) => { identity = value; } });
  assert.notEqual(result.status, 'ok');
  const savedResult = structuredClone(result);
  const report = f.db.prepare("SELECT * FROM biz_op_v327_diagnostic_reports WHERE task_run_id=?").get(identity.taskRunId);
  assert.equal(report.sample_count, 1000);
  let exportOutcome;
  const service = require('../../../src/main-process/biz-op-v327/auto-error-report').createBizOpAutoErrorReportService({
    getStorageRoot: () => f.outputRoot, module: { ...f.module, async runExport(options) {
      try { exportOutcome = await f.module.runExport(options); return exportOutcome; }
      catch (error) { exportOutcome = { code: error.code, message: error.message, detailLines: error.detailLines, stack: error.stack }; throw error; }
    } } });
  await f.module.recovery.run();
  const saved = await service.save({ identity: { taskRunId: identity.taskRunId, reportRef: report.report_ref },
    businessResult: result, taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
  assert.equal(saved.errorReport.status, 'saved', JSON.stringify({ saved, exportOutcome }));
  const book = XLSX.readFile(path.join(f.outputRoot, saved.errorReport.relativePath));
  assert.ok(book.SheetNames.length > 0);
  assert.deepEqual(result, savedResult);
  assert.equal(f.module.catalog.task(identity.taskRunId).status, 'failed');
  assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
