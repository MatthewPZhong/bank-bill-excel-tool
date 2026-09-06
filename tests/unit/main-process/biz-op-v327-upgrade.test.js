'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plainTest = require('node:test');
const { durableDirectoryTest: test } = require('../../helpers/durable-directory-tests');
const { DatabaseSync } = require('node:sqlite');
const { createUpgradeHost, seedLegacy, passedGates } = require('../../helpers/biz-op-v327-upgrade');
const { createHost } = require('../../helpers/biz-op-v327-host');
const { evaluateReleaseGates, RELEASE_GATES, REQUIRED_GATES } = require('../../../src/main-process/biz-op-v327/release-gates');
const { buildBizOpPolicies, BIZ_OP_V327_POLICIES } = require('../../../src/main-process/biz-op-v327/policies');
const { TABLES } = require('../../../src/main-process/biz-op-v327/upgrade-legacy');
const { ensureBizOpReconTablesSupport } = require('../../../src/backend/biz-op-recon-db/migrations');
const runDataStore = require('../../../src/backend/run-data-store');
const { registerWithLegacyGuard } = require('../../../src/main-process/biz-op-v327/legacy-ipc');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
const pendingTask = (f) => f.db.prepare("SELECT * FROM archive_task_runs WHERE task_key='bizOpReconV327:maintenance:upgrade'").get();

plainTest('发布配置仍禁用；缺少任一总门禁或单个 action 证据均不创建 Task、不清旧、不放行生产 dispatch', async (t) => {
  assert.equal(RELEASE_GATES.enabled, false); assert.ok(BIZ_OP_V327_POLICIES.every((p) => !p.production.enabled));
  for (const key of REQUIRED_GATES) { const config = passedGates(); config[key] = { status: 'NOT RUN', reference: 'pending' }; assert.equal(evaluateReleaseGates(config).ready, false); }
  const config = passedGates(); delete config.actions['biz-op-v327:export-errors'];
  assert.equal(evaluateReleaseGates(config).ready, false);
  assert.ok(buildBizOpPolicies(passedGates()).every((p) => p.production.enabled && p.production.effectiveMode === 'thread-single'));
  const f = await createHost(t); const { oldFile } = seedLegacy(f);
  const counts = f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n;
  assert.equal((await f.module.activation.run()).status, 'disabled');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, counts);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n, 1);
  assert.ok(fs.existsSync(oldFile)); assert.throws(() => f.module.assertBusinessEnabled(), { code: 'BIZOP_V327_NOT_ENABLED' });
});
test('真实 worker 关闭后只清限定旧表和文件，分阶段收据、原 Task 与最终 ACTIVE 同步，重复不清新数据', async (t) => {
  const f = await createUpgradeHost(t); const { oldFile, external } = seedLegacy(f);
  const prepared = await f.module.activation.run({ quiesceOnly: true }); assert.equal(prepared.status, 'pending');
  assert.equal(pendingTask(f).status, 'running'); assert.equal(f.module.catalog.control().mode, 'MIGRATING');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n, 1);
  const result = await f.module.retryRecovery(); assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(pendingTask(f).status, 'succeeded'); assert.equal(f.module.catalog.control().mode, 'ACTIVE');
  assert.equal(f.module.catalog.receipt(pendingTask(f).task_run_id).action, 'UPGRADE');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);
  for (const table of TABLES) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(fs.existsSync(oldFile), false); assert.equal(fs.readFileSync(external, 'utf8'), 'external original');
  assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
  f.module.assertBusinessEnabled();
  const newer = f.module.payloadStore.writeDocument('upgrade/new-data.json', { retained: true });
  const recovered = await f.module.retryRecovery(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.payloadStore.readDocument('upgrade/new-data.json').digest, newer.digest);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);
});
test('未知旧文件、符号链接和非白名单表都阻断预检，保留原 running Task 和主库数据', async (t) => {
  for (const kind of ['unknown-file', 'symlink', 'foreign-table']) await t.test(kind, async (t) => {
    const f = await createUpgradeHost(t); const { oldFile } = seedLegacy(f);
    if (kind === 'unknown-file') fs.writeFileSync(path.join(path.dirname(oldFile), 'notes.txt'), 'keep');
    if (kind === 'symlink') { fs.renameSync(oldFile, oldFile + '.saved'); fs.symlinkSync(oldFile + '.saved', oldFile); }
    if (kind === 'foreign-table') { const db = new DatabaseSync(oldFile); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close(); }
    await assert.rejects(f.module.activation.run(), { code: kind === 'foreign-table' ? 'BIZOP_LEGACY_SCHEMA_UNKNOWN' : 'BIZOP_LEGACY_INVENTORY_UNSAFE' });
    assert.equal(pendingTask(f).status, 'running'); assert.equal(f.module.catalog.control().mode, 'MIGRATING');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n, 1);
    assert.ok(fs.existsSync(oldFile)); assert.equal(f.module.catalog.receipt(pendingTask(f).task_run_id), null);
  });
});
test('未知旧 Task 不由 generic interrupted sweep 代为终结，整个 Task/batch 保护完整', async (t) => {
  const f = await createUpgradeHost(t); const { oldFile } = seedLegacy(f);
  f.module.catalog.archive.beginTaskRun({ taskRunId: 'old-task', taskKey: 'bizOpRecon:run', moduleId: 'biz-op-recon', operationKey: 'old-op', parentRunId: 'old-parent' });
  await f.service.markTaskRunStarted('old-task');
  await assert.rejects(f.module.activation.run(), { code: 'BIZOP_LEGACY_TASK_PENDING' });
  assert.ok(f.module.protectedTasks().taskRunIds.includes('old-task'));
  assert.equal(f.module.catalog.archive.getTaskRun('old-task').status, 'running'); assert.ok(fs.existsSync(oldFile));
});
test('已有 FK 或同名改写 trigger 不能借清旧级联到其他模块', async (t) => {
  for (const kind of ['foreign-key', 'trigger']) await t.test(kind, async (t) => {
    const f = await createUpgradeHost(t); const { oldFile } = seedLegacy(f);
    if (kind === 'foreign-key') f.db.exec('CREATE TABLE unrelated(id INTEGER REFERENCES biz_op_recon_imports(id) ON DELETE CASCADE)');
    else f.db.exec(`DROP TRIGGER invalidate_biz_op_head_on_delete; CREATE TRIGGER invalidate_biz_op_head_on_delete AFTER DELETE ON biz_op_recon_imports BEGIN DELETE FROM preserve_settings; END`);
    await assert.rejects(f.module.activation.run(), { code: kind === 'foreign-key' ? 'BIZOP_LEGACY_FOREIGN_REFERENCE' : 'BIZOP_LEGACY_TRIGGER_UNKNOWN' });
    assert.ok(fs.existsSync(oldFile)); assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
  });
});
test('清主库后文件替换不能沿旧清单删除；原 task/阶段/收据继续保持未决', async (t) => {
  let changed = false; let oldFile;
  const f = await createUpgradeHost(t, { host: { async afterStage(phase) {
    if (phase === 'LEGACY_DB_CLEARED' && !changed) { changed = true; fs.writeFileSync(oldFile, 'replacement'); }
  } } });
  oldFile = seedLegacy(f).oldFile;
  await assert.rejects(f.module.activation.run(), { code: 'BIZOP_LEGACY_INVENTORY_CHANGED' });
  assert.equal(fs.readFileSync(oldFile, 'utf8'), 'replacement');
  assert.equal(f.db.prepare('SELECT phase FROM biz_op_v327_activation').get().phase, 'LEGACY_DB_CLEARED');
  assert.equal(f.module.catalog.receipt(pendingTask(f).task_run_id), null); assert.equal(pendingTask(f).status, 'running');
});
test('旧二进制的 TaskLifecycle 和原六表写路径被持久约束阻断，旧新版入口不会再创建月库', async (t) => {
  const f = await createUpgradeHost(t); seedLegacy(f); await f.module.activation.run(); await f.module.recovery.run();
  let executed = false;
  const outcome = await f.lifecycle.runOperationOnly({ policy: createTaskPolicyRegistry().require('bizOpRecon:run'),
    meta: { channel: 'bizOpRecon:run' }, execute: async () => { executed = true; } });
  assert.equal(executed, false); assert.notEqual(outcome?.status, 'ok');
  assert.throws(() => f.db.exec("INSERT INTO biz_op_recon_imports(data_date,bu_name,row_index,account_no) VALUES('2026-01-01','BU',1,'x')"), /BIZOP_LEGACY_RETIRED/);
  ensureBizOpReconTablesSupport(f.db);
  assert.throws(() => f.db.exec("INSERT INTO biz_op_recon_dataset_heads(dataset_kind,data_date,normalized_bu,dataset_id,dataset_version,updated_at) VALUES('op','2026-01-01','bu','x',1,'today')"), /BIZOP_LEGACY_RETIRED/);
  assert.throws(() => runDataStore.openSideDb(f.root, runDataStore.MODULE_BIZ_OP, '2026-09'), { code: 'BIZOP_LEGACY_RETIRED' });
  const callbacks = new Map(); const ipc = { handle: (key, callback) => callbacks.set(key, callback) }; const original = ipc.handle;
  registerWithLegacyGuard(ipc, () => f.db, () => { ipc.handle('bizOpRecon:pick', () => { executed = true; }); ipc.handle('other:read', () => 'preserved'); });
  assert.equal(ipc.handle, original); assert.equal(callbacks.get('bizOpRecon:pick')().code, 'BIZOP_LEGACY_RETIRED');
  assert.equal(callbacks.get('other:read')(), 'preserved'); assert.equal(executed, false);
});

for (const phase of ['MIGRATING', 'WORKER_STARTED', 'LEGACY_QUIESCED', 'LEGACY_DB_CLEARED', 'FILE_WORKER_CLOSED', 'LEGACY_FILES_RECLAIMED', 'ACTIVE']) {
  test(`真实进程退出 ${phase}，重启恢复原 Task/intent，缺失已授权文件可幂等收口`, async (t) => {
    const os = require('node:os'); const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-upgrade-crash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const crash = spawnSync(process.execPath, [path.resolve('tests/fixtures/biz-op-v327-upgrade-crash.cjs'), root, phase], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(crash.status, 73, crash.stderr + crash.stdout);
    const original = JSON.parse(fs.readFileSync(path.join(root, 'upgrade-evidence.json')));
    const f = await createUpgradeHost(t, { root, keep: true, expectReady: phase === 'ACTIVE' });
    const recovered = await f.module.retryRecovery(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(pendingTask(f).task_run_id, original.taskRunId); assert.equal(pendingTask(f).status, 'succeeded');
    assert.equal(f.module.catalog.receipt(original.taskRunId).intentDigest, original.intentDigest);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:maintenance:upgrade'").get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);
    assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
    assert.equal(f.module.catalog.control().mode, 'ACTIVE');
  });
}

test('旧 run 的真实未 ACK 收据由原 provider 收口原 Task，再清业务镜像；存档 flow anchor 留存', async (t) => {
  const f = await createUpgradeHost(t); const { oldFile } = seedLegacy(f);
  f.module.catalog.archive.beginTaskRun({ taskRunId: 'legacy-run-task', taskKey: 'bizOpRecon:run', moduleId: 'biz-op-recon', operationKey: 'legacy-run-op', parentRunId: 'legacy-parent' });
  await f.service.markTaskRunStarted('legacy-run-task');
  const side = new DatabaseSync(oldFile);
  side.prepare(`INSERT INTO biz_op_recon_runs(data_date,bu_name,status,archive_contract_version,archive_task_run_id)
    VALUES('2026-08-31','BU','success',1,?)`).run('legacy-run-task'); side.close();
  assert.equal((await f.module.activation.run()).status, 'ok');
  assert.equal(f.module.catalog.archive.getTaskRun('legacy-run-task').status, 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_runs').get().n, 0);
  assert.ok(f.db.prepare("SELECT 1 FROM archive_flow_anchors WHERE parent_run_id='legacy-parent'").get());
});
test('真实旧月末 copy intent 恢复后新增的下月侧库进入最终清单，原批次/用户锁/hold/blob 和外部原件全部保留', async (t) => {
  const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../../src/main-process/archive-center/file-plan');
  const oldSession = require('../../../src/main-process/biz-op-recon-session');
  const shared = require('../../../scripts/integration/fixtures/biz-op-recon-side-db-parity/_shared');
  const f = await createUpgradeHost(t); seedLegacy(f);
  const inputPath = path.join(f.root, 'old-month-end.xlsx'); fs.writeFileSync(inputPath, 'legacy frozen original');
  const taskRun = (await f.service.beginTaskRun({ taskRunId: 'legacy-copy-task', moduleId: 'biz-op-recon',
    taskKey: 'bizOpRecon:import:run-biz-op', operationKey: 'legacy-copy-op', parentRunId: 'legacy-copy-parent' })).taskRun;
  const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: [{ filePath: inputPath, role: 'input', sourceOperation: taskRun.taskKey }], outputs: [] }));
  const reserved = await f.service.reserveFileTaskBatch({ taskRun, manifest, moduleCode: 'BIZOP', moduleName: '业务OP数据核对' });
  await f.service.startFileTask(taskRun.taskRunId, reserved.batch.id);
  f.module.catalog.archive.setLocked(reserved.batch.id, true);
  const artifact = f.module.catalog.archive.listArtifacts(reserved.batch.id)[0];
  const settled = await f.service.settleManifestArtifacts({ batchContext: { ...taskRun, batchId: reserved.batch.id, batchNumber: reserved.batch.batchNumber },
    files: manifest.inputs.map(({ artifactKey }) => ({ artifactKey })) });
  assert.equal(settled.durable, true);
  f.module.catalog.archive.addArtifactHold(artifact.id, { ownerModule: 'biz-op-recon', ownerType: 'legacy-source', ownerId: taskRun.taskRunId, reason: '历史原件保留' });
  const side = runDataStore.openSideDb(f.root, runDataStore.MODULE_BIZ_OP, '2026-06');
  try {
    const imported = await oldSession.runBizOpImportAsync(side, { date: '2026-06-30', filePath: inputPath,
      readBizOpFile: () => ({ rows: [shared.makeBizOp({ rowIndex: 2, bu: 'BU-R', account: 'A001', begin: 0, amtIn: 88, amtOut: 0, end: 88, billDate: '2026-06-30' })] }),
      writeBizOpErrorReportXlsx: async () => { throw new Error('不应产生错误报告'); }, errorReportsDir: f.root,
      datasetSeed: { datasetId: 'legacy-copy-dataset', producerTaskRunId: taskRun.taskRunId },
      monthEndCopyPlan: { targetDbPath: runDataStore.sideDbPath(f.root, runDataStore.MODULE_BIZ_OP, '2026-07'), targetMonth: '2026-07', dataDate: '2026-06-30', nextDate: '2026-07-01' } });
    assert.equal(imported.status, 'success');
  } finally { side.close(); }
  assert.equal(runDataStore.sideDbExists(f.root, runDataStore.MODULE_BIZ_OP, '2026-07'), false);
  assert.equal((await f.module.activation.run()).status, 'ok');
  assert.ok(f.db.prepare("SELECT 1 FROM biz_op_v327_activation_files WHERE file_name='month-2026-07.sqlite' AND reclaimed=1").get());
  assert.equal(f.module.catalog.archive.getTaskRun(taskRun.taskRunId).status, 'succeeded');
  const batch = f.module.catalog.archive.getBatch(reserved.batch.id); assert.equal(batch.batchNumber, reserved.batch.batchNumber); assert.equal(batch.locked, true);
  assert.equal(f.module.catalog.archive.listArtifactHolds(artifact.id).length, 1);
  assert.equal((await f.service.resolveVerifiedArtifact(artifact.id)).ok, true);
  assert.equal(fs.readFileSync(inputPath, 'utf8'), 'legacy frozen original');
});
test('激活后真实导入/计算/七类主出口中的全量出口/删除/重试均使用新目录，旧初始化与孤儿扫描拒绝进入', async (t) => {
  const { seed, compute } = require('../../helpers/biz-op-v327-compute');
  const { request } = require('../../helpers/biz-op-v327-export');
  const legacy = require('../../../src/main-process/biz-op-recon-run-data');
  const f = await createUpgradeHost(t); seedLegacy(f); await f.module.activation.run(); await f.module.recovery.run();
  f.outputRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bizop-active-export-'));
  t.after(() => fs.rmSync(f.outputRoot, { recursive: true, force: true }));
  await seed(f); const run = await compute(f); assert.equal(run.status, 'ok');
  assert.equal((await request(f, 'RESULT_FULL', run.runId)).status, 'ok');
  const preview = f.module.previews.create({ runIds: [run.runId] });
  assert.equal((await f.module.runDelete({ taskLifecycle: f.lifecycle, runtime: f.runtime, previewId: preview.previewId, mode: 'DELETE_ASSOCIATED' })).status, 'ok');
  assert.equal((await f.module.retryRecovery()).ready, true);
  assert.throws(() => legacy.reconcileOrphans({ userDataDir: f.root, mainDb: f.db }), { code: 'BIZOP_LEGACY_RETIRED' });
  assert.throws(() => legacy.deleteMonthSideDb({ userDataDir: f.root, mainDb: f.db, monthKey: '2026-09' }), { code: 'BIZOP_LEGACY_RETIRED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 4);
  assert.ok(fs.existsSync(path.join(f.outputRoot, 'result-full.xlsx')));
});

test('真实旧恢复连接关闭失败被吞后仍阻断，原连接稍后真正关闭才允许清旧', async (t) => {
  let connection; let close;
  const f = await createUpgradeHost(t, { host: { async recoverLegacy() {
    if (connection) return;
    connection = runDataStore.openSideDb(f.root, runDataStore.MODULE_BIZ_OP, '2026-08');
    close = connection.close.bind(connection);
    connection.close = () => { throw Object.assign(new Error('故障注入：关闭失败'), { code: 'EIO' }); };
    try { connection.close(); } catch (_error) { /* 模拟原调用方吞掉关闭异常 */ }
  } } });
  const { oldFile } = seedLegacy(f);
  await assert.rejects(f.module.activation.run(), { code: 'BIZOP_LEGACY_CONNECTION_PENDING' });
  assert.ok(fs.existsSync(oldFile)); assert.equal(pendingTask(f).status, 'running');
  await assert.rejects(f.module.activation.run(), { code: 'BIZOP_LEGACY_CONNECTION_PENDING' });
  close();
  assert.equal((await f.module.retryRecovery()).ready, true); assert.equal(fs.existsSync(oldFile), false);
});
test('完成 ACTIVE 后反馈抛错不把已提交任务写成 failed，恢复仍按原收据收敛', async (t) => {
  let once = true;
  const f = await createUpgradeHost(t, { host: { afterStage(phase) { if (phase === 'ACTIVE' && once) { once = false; throw Object.assign(new Error('反馈丢失'), { code: 'INJECTED' }); } } } });
  seedLegacy(f); await assert.rejects(f.module.activation.run(), { code: 'INJECTED' });
  assert.equal(pendingTask(f).status, 'running'); const saved = f.module.catalog.receipt(pendingTask(f).task_run_id);
  assert.equal((await f.module.retryRecovery()).ready, true);
  assert.deepEqual(f.module.catalog.receipt(saved.taskRunId), saved); assert.equal(pendingTask(f).status, 'succeeded');
});
test('启动条件、磁盘余量和目录耐久失败均发生在迁移 intent/Task 之前，不改变旧写模式', async (t) => {
  for (const kind of ['startup', 'disk', 'directory']) await t.test(kind, async (t) => {
    const f = await createUpgradeHost(t, { host: kind === 'startup' ? { assertStartAllowed() { throw Object.assign(new Error('存在活动业务'), { code: 'BIZOP_ACTIVATION_STARTUP_REQUIRED' }); } } : {} });
    const { oldFile } = seedLegacy(f);
    if (kind === 'disk') t.mock.method(fs, 'statfsSync', () => ({ bavail: 0n, bsize: 4096n }));
    if (kind === 'directory') { const original = fs.fsyncSync; t.mock.method(fs, 'fsyncSync', (fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('目录屏障不可用'), { code: 'ENOTSUP' }); return original(fd);
    }); }
    await assert.rejects(f.module.activation.run(), { code: kind === 'startup' ? 'BIZOP_ACTIVATION_STARTUP_REQUIRED' : kind === 'disk' ? 'BIZOP_ACTIVATION_DISK_SPACE' : 'DURABILITY_BARRIER_UNAVAILABLE' });
    assert.equal(pendingTask(f), undefined); assert.equal(f.module.catalog.control().mode, 'DISABLED'); assert.ok(fs.existsSync(oldFile));
  });
});
test('旧防写约束被替换或移除不能借 ACTIVE 标志开放新版业务，AppDatabase 初始化不会再调用旧 DDL', async (t) => {
  const { AppDatabase } = require('../../../src/backend/database');
  const f = await createUpgradeHost(t); seedLegacy(f); await f.module.activation.run(); await f.module.recovery.run();
  const restarted = new AppDatabase(path.join(f.root, 'tool-data.sqlite'));
  restarted.ensureBizOpReconTablesSupport = () => assert.fail('ACTIVE 不应进入旧 DDL');
  restarted.ensureBizOpReconRunsSideDbPath = () => assert.fail('ACTIVE 不应迁移旧侧库字段');
  try { restarted.init(); } finally { restarted.close(); }
  f.module.assertBusinessEnabled();
  f.db.exec('DROP TRIGGER biz_op_v327_guard_legacy_task');
  assert.throws(() => f.module.assertBusinessEnabled(), { code: 'BIZOP_LEGACY_GUARD_CHANGED' });
  await assert.rejects(f.module.activation.run(), { code: 'BIZOP_LEGACY_GUARD_CHANGED' });
});
plainTest('批准门禁后的策略仍通过现有平台 schema 与语义检查，不新增 commit 类型', () => {
  const { validatePolicyDocument, STATIC_REFERENCE_PATHS } = require('../../../src/main-process/background-execution/execution-policy-registry');
  const { BACKGROUND_EXECUTION_POLICIES } = require('../../../src/main-process/background-execution/runtime');
  const { BIZ_OP_V327_POLICIES } = require('../../../src/main-process/biz-op-v327/policies');
  const { ACTIONS } = require('../../../src/main-process/biz-op-v327/contracts');
  const changed = new Set(BIZ_OP_V327_POLICIES.map((p) => p.actionKey));
  const policies = BACKGROUND_EXECUTION_POLICIES.filter((p) => !changed.has(p.actionKey)).concat(buildBizOpPolicies(passedGates()));
  const staticKeys = Object.fromEntries(STATIC_REFERENCE_PATHS.map(([field, bucket]) => [bucket, BACKGROUND_EXECUTION_POLICIES
    .map((policy) => field.split('.').reduce((value, key) => value?.[key], policy)).filter(Boolean)]));
  const result = validatePolicyDocument({ contractVersion: 1, generatedAt: '2026-09-06T00:00:00.000Z', actions: Object.fromEntries(policies.map((policy) => [policy.actionKey, policy])) }, { staticKeys });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(Object.keys(ACTIONS).length, 12);
});
