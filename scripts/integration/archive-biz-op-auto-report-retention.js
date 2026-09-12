// 存档模块期限与业务 OP 自动错误报告组合验证。
// 使用真实 SQLite 设置、production resolver、TaskLifecycle、worker 和 ERRORS 发布；
// 覆盖新批次期限、既有未决任务恢复、读取保护和到期清理的外部文件边界。
// 全部原件、数据库、userData 和 Documents 输出仅位于自建临时目录。
// 用法：node scripts/integration/archive-biz-op-auto-report-retention.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const XLSX = require('xlsx');
const settingsRepository = require('../../src/backend/database/settings-repository');
const { createHost } = require('../../tests/helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { createBizOpAutoErrorReportService } = require('../../src/main-process/biz-op-v327/auto-error-report');
const { createRecoveryControlReadRepository } = require('../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  ARCHIVE_RETENTION_SETTING_KEY,
  resolveRetentionDays,
  setModuleRetentionDays
} = require('../../src/main-process/archive-center/retention-policy');

const cases = [];
const scenario = (name, run) => cases.push({ name, run });
const digest = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function addDays(localDate, days) {
  if (days === null) return null;
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function withHost(work) {
  const cleanup = [];
  try {
    let database;
    const f = await createHost({ after(callback) { cleanup.push(callback); } }, {
      beforeBootstrap({ db, service }) {
        db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
          setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL
        )`);
        database = {
          getSetting: (key) => settingsRepository.getSetting(db, key),
          setSetting: (key, value) => settingsRepository.setSetting(db, key, value)
        };
        database.setSetting(ARCHIVE_RETENTION_SETTING_KEY, '60');
        // 与 Main 一致，设置从真实数据库读取；批次须由真实 TaskLifecycle 固化期限。
        service.resolveRetentionDays = (moduleId) => resolveRetentionDays(database, moduleId);
      }
    });
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-bizop-report-target-'));
    cleanup.push(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
    f.database = database;
    f.storageRoot = path.join(outputRoot, 'Documents', '网银账单生成小助手');
    f.readRepository = createRecoveryControlReadRepository(f.db);
    f.auto = createBizOpAutoErrorReportService({ module: f.module, getStorageRoot: () => f.storageRoot });
    await work(f);
  } finally {
    const errors = [];
    for (const callback of cleanup) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '组合验证临时资源清理失败');
  }
}

function setModule(f, retentionDays, moduleId = 'biz-op-recon') {
  setModuleRetentionDays(f.database, { moduleId, retentionDays });
}

function taskBatch(f, taskRunId) {
  const rows = f.db.prepare('SELECT id FROM archive_batches WHERE task_run_id=?').all(taskRunId);
  assert.equal(rows.length, 1, '每个真实 Task 对应唯一存档批次');
  return f.service.repository.getBatch(rows[0].id);
}

function assertRetention(batch, days) {
  assert.equal(batch.moduleId, 'biz-op-recon', '导入及 ERRORS 导出均归属业务 OP 规范模块');
  assert.equal(batch.retentionUntil, addDays(batch.localDate, days));
}

async function imported(f, name, kind = 'OP', valid = false) {
  const filePath = path.join(f.root, `${name}.xlsx`);
  await writeXlsx(filePath, { kind, rowCount: 1,
    row: () => kind === 'OP' ? opRow(valid ? {} : { end: '999' }) : flowRow(valid ? {} : { direction: '错误方向' }) });
  const identities = [];
  const businessResult = await f.run([filePath], { onTaskIdentified(identity) { identities.push(identity); } });
  assert.equal(identities.length, 1);
  assert.equal(businessResult.status, valid ? 'ok' : 'error');
  if (!valid) assert.equal(businessResult.code, 'BIZOP_IMPORT_REJECTED');
  const recovery = await f.module.recovery.run();
  assert.equal(recovery.ready, true, JSON.stringify(recovery));
  const identity = identities[0];
  return { identity, businessResult, filePath, batch: taskBatch(f, identity.taskRunId) };
}

async function saved(f, input, auto = f.auto) {
  const before = structuredClone(input.businessResult);
  const result = await auto.save({ identity: input.identity, businessResult: input.businessResult,
    taskLifecycle: f.lifecycle, runtime: f.runtime, recoveryReady: true });
  assert.deepEqual(input.businessResult, before, '期限和自动保存不改写原业务失败结论');
  assert.equal(result.errorReport?.status, 'saved', JSON.stringify(result));
  const report = result.errorReport;
  const filePath = path.join(f.storageRoot, report.relativePath);
  assert.equal(path.isAbsolute(report.relativePath), false);
  assert.match(report.relativePath.replaceAll('\\', '/'), /^error-reports\//);
  assert.notEqual(report.taskRunId, input.identity.taskRunId);
  const fact = f.module.publication.fact(report.taskRunId);
  assert.equal(fact.state, 'COMMITTED');
  assert.equal(digest(filePath), fact.outcome.files[0].sha256);
  const workbook = XLSX.readFile(filePath);
  assert.deepEqual(workbook.SheetNames, ['导入错误报告', '核对说明']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['导入错误报告']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['记录类别'], 'ROW');
  assert.equal(rows[0]['来源行号'], 2);
  const binding = f.module.publication.binding(report.taskRunId);
  const batch = taskBatch(f, report.taskRunId);
  assert.equal(binding.batchContext.batchId, batch.id);
  return { result, report, filePath, batch };
}

for (const kind of ['OP', 'FLOW']) {
  scenario(`${kind} 真实失败导入与自动 ERRORS 发布按模块 30 天建批`, () => withHost(async (f) => {
    setModule(f, null, 'toolbox');
    setModule(f, 30, 'BIZOP');
    const input = await imported(f, `finite-${kind}`, kind);
    const output = await saved(f, input);
    assertRetention(input.batch, 30);
    assertRetention(output.batch, 30);
    assert.equal(f.module.catalog.task(input.identity.taskRunId).status, 'failed');
    assert.equal(f.module.catalog.task(output.report.taskRunId).status, 'succeeded');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
  }));
}

scenario('默认继承、模块永久与设置变化仅影响后续新导入/新报告批次', () => withHost(async (f) => {
  const records = [];
  async function pair(name, days) {
    const input = await imported(f, name);
    const output = await saved(f, input);
    for (const batch of [input.batch, output.batch]) {
      assertRetention(batch, days);
      records.push({ id: batch.id, retentionUntil: batch.retentionUntil });
    }
    for (const old of records) assert.equal(f.service.repository.getBatch(old.id).retentionUntil, old.retentionUntil,
      '设置变化不追溯改写既有批次');
  }
  await pair('default-sixty', 60);
  setModule(f, null);
  await pair('module-permanent', null);
  f.database.setSetting(ARCHIVE_RETENTION_SETTING_KEY, '180');
  await pair('permanent-ignores-default-change', null);
  setModule(f, 'inherit');
  await pair('inherit-one-eighty', 180);
  setModule(f, 30);
  await pair('new-module-thirty', 30);
}));

for (const originalDays of [30, null]) {
  scenario(`已发布且 Archive 未决的${originalDays === null ? '永久' : '30 天'}报告改设置后仍恢复原批次`, () => withHost(async (f) => {
    setModule(f, originalDays);
    const input = await imported(f, `pending-${originalDays}`, 'FLOW');
    const originalSettle = f.service.settleManifestArtifacts.bind(f.service);
    let exportTask;
    let exportCalls = 0;
    let blockedSettles = 0;
    f.service.settleManifestArtifacts = async (args) => {
      if (args.batchContext.taskRunId === exportTask) {
        blockedSettles += 1;
        return { ok: false, durable: false, code: 'TEST_ARCHIVE_IO' };
      }
      return originalSettle(args);
    };
    const auto = createBizOpAutoErrorReportService({ getStorageRoot: () => f.storageRoot,
      module: { ...f.module, runExport(args) {
        exportCalls += 1;
        return f.module.runExport({ ...args, afterPublish({ taskRunId }) { exportTask = taskRunId; } });
      } } });
    let output;
    let proof;
    try {
      output = await saved(f, input, auto);
      assertRetention(output.batch, originalDays);
      assert.ok(blockedSettles > 0);
      assert.equal(output.result.cleanupPending, true);
      assert.equal(output.report.pendingArchiveHandoff, true);
      assert.equal(f.module.catalog.task(exportTask).status, 'running');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(exportTask).n, 1);
      assert.equal(f.module.publication.record(exportTask).cleanup_completed, 0);
      proof = f.module.publication.record(exportTask).commit_proof_digest;
      setModule(f, originalDays === null ? 30 : null);
      assert.equal(f.service.repository.getBatch(output.batch.id).retentionUntil, output.batch.retentionUntil);
      const rejected = await f.service.deleteBatch(output.batch.id);
      assert.equal(rejected.ok, false, 'Archive 未决报告的任务保护阻止删除');
      assert.ok(['ARCHIVE_BATCH_ACTIVE', 'ARCHIVE_BATCH_RECOVERY_ACTIVE'].includes(rejected.code), JSON.stringify(rejected));
      assert.equal(digest(output.filePath), f.module.publication.fact(exportTask).outcome.files[0].sha256);
    } finally { f.service.settleManifestArtifacts = originalSettle; }
    const beforeHash = digest(output.filePath);
    const recovered = await f.module.recovery.run();
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    const recoveredBatch = taskBatch(f, exportTask);
    assert.equal(recoveredBatch.id, output.batch.id);
    assert.equal(recoveredBatch.retentionUntil, output.batch.retentionUntil);
    assert.equal(f.module.publication.record(exportTask).commit_proof_digest, proof);
    assert.equal(f.module.publication.record(exportTask).cleanup_completed, 1);
    assert.equal(f.module.catalog.task(exportTask).status, 'succeeded');
    assert.equal(f.module.catalog.task(input.identity.taskRunId).status, 'failed');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 0);
    assert.equal(f.readRepository.listActiveRecoveryHolds().filter((hold) => hold.taskRunId === exportTask).length, 0);
    assert.equal(digest(output.filePath), beforeHash);
    assert.equal(exportCalls, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_publications').get().n, 1);
    assert.equal(f.runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
    const artifacts = f.service.repository.listArtifacts(output.batch.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].status, 'ready');
    assert.equal(digest(path.join(f.service.rootDir, artifacts[0].blob.relativePath)), beforeHash);
  }));
}

scenario('期限清理保留真实业务 INPUT hold，清理报告存档也保留已发布 Documents 文件', () => withHost(async (f) => {
  setModule(f, 30);
  const active = await imported(f, 'active-held-op', 'OP', true);
  const input = await imported(f, 'expired-error-flow', 'FLOW');
  const output = await saved(f, input);
  const heldArtifact = f.service.repository.listArtifacts(active.batch.id)[0];
  const holds = f.service.repository.listArtifactHolds(heldArtifact.id);
  assert.ok(holds.some((hold) => hold.ownerModule === 'biz-op-recon' && hold.ownerType === 'v327-input'),
    '成功业务导入产生真实 INPUT hold');
  const heldBlobPath = path.join(f.service.rootDir, heldArtifact.blob.relativePath);
  const heldHash = digest(heldBlobPath);
  const reportHash = digest(output.filePath);
  setModule(f, null);
  const onBoundary = await f.service.cleanupExpired({ asOfLocalDate: output.batch.retentionUntil });
  assert.equal(onBoundary.ok, true);
  assert.ok(f.service.repository.getBatch(output.batch.id), '到期日当天报告存档仍保留');
  const cleaned = await f.service.cleanupExpired({ asOfLocalDate: addDays(output.batch.localDate, 31) });
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
  assert.equal(f.service.repository.getBatch(output.batch.id), null, '旧 30 天报告按固化期限清理存档');
  assertRetention(f.service.repository.getBatch(active.batch.id), 30);
  assert.deepEqual(f.service.repository.listArtifactHolds(heldArtifact.id), holds);
  assert.equal(digest(heldBlobPath), heldHash);
  assert.equal(digest(output.filePath), reportHash, 'Archive 到期清理不删除或改写已发布的 Documents 报告');
  assert.ok(fs.existsSync(active.filePath));
  assert.ok(fs.existsSync(input.filePath));
}));

async function run() {
  console.log('==== 存档模块期限与业务 OP 自动错误报告组合验证 ====');
  const failures = [];
  for (const entry of cases) {
    try { await entry.run(); console.log(`PASS ${entry.name}`); }
    catch (error) { failures.push({ name: entry.name, error }); console.error(`FAIL ${entry.name}: ${error.stack || error}`); }
  }
  console.log(`\n==== ${cases.length - failures.length}/${cases.length} PASS ====`);
  if (failures.length) {
    console.error('FAILURES');
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  }
}

run().catch((error) => { console.error('FAILURES\n存档与业务 OP 组合验证异常：', error); process.exitCode = 1; });
