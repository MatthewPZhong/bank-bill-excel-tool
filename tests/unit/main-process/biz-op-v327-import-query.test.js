'use strict';

const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../helpers/biz-op-v327-host');
const { writeXlsx, flowRow } = require('../../helpers/biz-op-v327-xlsx');
const { createBizOpImportCoordinator } = require('../../../src/main-process/biz-op-v327/import-main');

async function diagnosticFixture(t) {
  const host = await createHost(t);
  const file = path.join(host.root, 'invalid.xlsx');
  await writeXlsx(file, { rowCount: 1, row: () => flowRow({ direction: '非法方向' }) });
  const result = await host.run([file]);
  assert.equal(result.status, 'error');
  const report = host.module.catalog.queries.readDiagnosticByRef(result.reportRef);
  assert.equal(report.state, 'READY');
  return { ...host, report };
}

function reader(host, { queries = host.module.catalog.queries, protection = host.module.protection } = {}) {
  // 协调器不能索取句柄；闭包中的 catalog 命令仍使用原连接。
  const catalog = { ...host.module.catalog, queries };
  Object.defineProperty(catalog, 'db', { get() { throw new Error('诊断读取绕过 query'); } });
  return createBizOpImportCoordinator({ catalog, payloadStore: host.module.payloadStore, protection });
}

test('诊断恢复经 query 重读现有 producer 与 digest，不透传 raw DB 或缓存旧验证', async (t) => {
  const f = await diagnosticFixture(t);
  const coordinator = reader(f);
  assert.equal(await coordinator.restoreDiagnostic(f.report.task_run_id), f.report.report_ref);
  for (const field of ['producer_job_id', 'producer_session_id', 'manifest_digest']) {
    // 列名来自本测试固定列表，值使用绑定参数；故障仅在临时库内注入。
    f.db.prepare(`UPDATE biz_op_v327_diagnostic_reports SET ${field}=? WHERE report_ref=?`).run('changed', f.report.report_ref);
    await assert.rejects(coordinator.restoreDiagnostic(f.report.task_run_id), { code: 'BIZOP_REPORT_OWNER_MISMATCH' });
    f.db.prepare(`UPDATE biz_op_v327_diagnostic_reports SET ${field}=? WHERE report_ref=?`).run(f.report[field], f.report.report_ref);
    assert.equal(await coordinator.restoreDiagnostic(f.report.task_run_id), f.report.report_ref);
  }
});

test('诊断关闭屏障先于 query，producer 缺失时先于现有报告读取拒绝', async (t) => {
  const f = await diagnosticFixture(t);
  let reads = 0;
  const queries = { ...f.module.catalog.queries,
    readDispatchesForPlan(...args) { reads += 1; return f.module.catalog.queries.readDispatchesForPlan(...args); },
    readDiagnosticByRef() { throw new Error('缺 producer 时不应读取报告'); } };
  const closedPending = reader(f, { queries, protection: { ...f.module.protection, closed: () => false } });
  await assert.rejects(closedPending.restoreDiagnostic(f.report.task_run_id), { code: 'BIZOP_CARRIER_CLOSURE_PENDING' });
  assert.equal(reads, 0);
  f.db.prepare('UPDATE biz_op_v327_dispatches SET plan_digest=? WHERE task_run_id=?').run('0'.repeat(64), f.report.task_run_id);
  await assert.rejects(reader(f, { queries }).restoreDiagnostic(f.report.task_run_id), { code: 'BIZOP_REPORT_OWNER_MISMATCH' });
  assert.equal(reads, 1);
});

test('尚未登记的诊断在 query 后仍核验真实样本文件，损坏时不注册', async (t) => {
  const f = await diagnosticFixture(t);
  const relative = `diagnostics/${f.report.report_ref}/manifest.json`;
  const manifest = f.module.payloadStore.readDocument(relative).value;
  const sample = f.module.payloadStore.resolve(`diagnostics/${f.report.report_ref}/${manifest.parts[0].name}`);
  fs.appendFileSync(sample, 'corrupted');
  let registered = 0;
  const coordinator = reader(f, {
    queries: { ...f.module.catalog.queries, readDiagnosticByRef: () => null },
    protection: { ...f.module.protection, registerDiagnostic() { registered += 1; throw new Error('不应注册损坏样本'); } }
  });
  await assert.rejects(coordinator.restoreDiagnostic(f.report.task_run_id), { code: 'BIZOP_PART_MISMATCH' });
  assert.equal(registered, 0);
});
