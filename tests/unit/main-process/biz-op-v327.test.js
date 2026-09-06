'use strict';

const test = require('node:test');
const { durableDirectoryTest } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createBizOpV327Module } = require('../../../src/main-process/biz-op-v327/module');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createTaskLifecycle } = require('../../../src/main-process/archive-center/task-lifecycle');
const { createBusinessFlowResolver } = require('../../../src/main-process/archive-center/business-flow-resolver');
const { createBusinessOperationRegistry } = require('../../../src/main-process/business-operation-registry');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const { createNonProductionBackgroundExecutionRuntime } = require('../../../src/main-process/background-execution/runtime');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { createInspectorRegistry } = require('../../../src/main-process/background-execution/inspector-registry');
const { createSettlementRecoveryProviderRegistry } = require('../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const { createStartupRecoveryCoordinator } = require('../../../src/main-process/background-execution/startup-recovery-coordinator');
const { createRecoveryControlReadRepository } = require('../../../src/main-process/background-execution/critical/recovery-control-read-repository');
const { createRecoveryRequestOwnerRepository } = require('../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const { createRecoveryObservationAttemptRepository } = require('../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const { createRecoveryControlRepository } = require('../../../src/main-process/background-execution/critical/recovery-control-repository');
const { ACTIONS } = require('../../../src/main-process/biz-op-v327/contracts');
const { RECOVERY_LIMITS } = require('../../../src/main-process/biz-op-v327/recovery-budget');
const { createExecutionPolicyRegistry, createStaticRegistry } = require('../../../src/main-process/background-execution/execution-policy-registry');
const { createExecutionSupervisor } = require('../../../src/main-process/background-execution/supervisor');
const { createWorkerThreadAdapter } = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const { BIZ_OP_V327_POLICIES } = require('../../../src/main-process/biz-op-v327/policies');
const { createRecoveryBudget } = require('../../../src/main-process/biz-op-v327/recovery-budget');
const { hash } = require('../../../src/main-process/biz-op-v327/contracts');

for (const stage of ['anchor', 'hold']) {
  durableDirectoryTest(`Inspector unavailable ${stage} 后真实进程退出，原 Task/批次/receipt 重启收敛`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-unavailable-crash-'));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../fixtures/biz-op-v327-crash.cjs'), root, stage],
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(child.status, stage === 'anchor' ? 75 : 76, child.stderr + child.stdout);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'receipt-evidence.json')));
    let context; let first = true;
    const f = await fixture(t, { root, beforeBootstrap(value) { context = value; }, wrapInspector(inspect) {
      return (source) => {
        if (first) {
          first = false;
          assert.equal(context.module.catalog.task(receipt.taskRunId).status, 'interrupted');
          assert.equal(context.module.catalog.task(receipt.taskRunId).failureCode, 'INSPECTOR_UNAVAILABLE');
          assert.equal(context.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_holds WHERE status='active'").get().n, 1);
          assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM background_execution_batch_recovery_states').get().n, 0);
        }
        return inspect(source);
      };
    } });
    assert.equal(first, false);
    assert.equal(f.module.catalog.task(receipt.taskRunId).status, 'succeeded');
    assert.deepEqual(f.module.catalog.receipt(receipt.taskRunId), receipt);
    assert.equal(f.db.prepare('SELECT state FROM background_execution_batch_recovery_states').get().state, 'resolved');
    assert.equal(f.db.prepare('SELECT final_outcome FROM background_execution_batch_recovery_states').get().final_outcome, 'succeeded');
    assert.equal((await f.module.recovery.run()).ready, true);
  });
}

durableDirectoryTest('真实候选校验失败后的 unavailable Hold 可重试收尾，原失败和版本不变', async (t) => {
  let unavailable = false;
  const f = await fixture(t, { wrapInspector(inspect) { return (source) => {
    if (unavailable) throw Object.assign(new Error('临时读取失败'), { code: 'TEST_TRANSIENT' });
    return inspect(source);
  }; } });
  const original = path.join(f.root, 'invalid-candidate.sqlite');
  const input = new DatabaseSync(original); input.exec('CREATE TABLE wrong_table(value TEXT)'); input.close();
  const originalHash = hash(fs.readFileSync(original).toString('base64'));
  await assert.rejects(f.module.runCandidateValidation({ taskLifecycle: f.lifecycle, runtime: f.runtime,
    filePlan: normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original,
      role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] }),
    dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'terminal-failure' } }));
  const task = f.db.prepare("SELECT task_run_id,status,failure_code FROM archive_task_runs WHERE task_key='bizOpReconV327:import'").get();
  assert.equal(task.status, 'failed'); assert.equal(f.module.recovery.openObligations(), true);
  unavailable = true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await f.module.recovery.run()).ready, false);
    assert.equal(f.module.catalog.task(task.task_run_id).status, 'failed');
    assert.equal(f.readRepository.listActiveRecoveryHolds().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_observation_attempts WHERE status='prepared'").get().n, 0);
  }
  unavailable = false;
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.catalog.task(task.task_run_id).status, 'failed');
  assert.equal(f.module.catalog.task(task.task_run_id).failureCode, task.failure_code);
  assert.equal(f.module.catalog.receipt(task.task_run_id), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_input_heads').get().n, 0);
  assert.equal(hash(fs.readFileSync(original).toString('base64')), originalHash);
  assert.equal((await f.module.recovery.run()).ready, true);
});

durableDirectoryTest('已有 unavailable Hold 和 interrupted Task 重试检查失败不重写终态，恢复可继续', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-unavailable-retry-'));
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../fixtures/biz-op-v327-crash.cjs'), root, 'hold'],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(child.status, 76, child.stderr + child.stdout);
  let unavailable = true;
  const f = await fixture(t, { root, expectReady: false, wrapInspector(inspect) { return (source) => {
    if (unavailable) throw Object.assign(new Error('检查器仍不可用'), { code: 'TEST_INSPECTOR_UNAVAILABLE' });
    return inspect(source);
  }; } });
  const task = f.db.prepare("SELECT * FROM archive_task_runs WHERE task_key='bizOpReconV327:import'").get();
  assert.equal(task.status, 'interrupted'); assert.equal(task.failure_code, 'INSPECTOR_UNAVAILABLE');
  assert.equal((await f.module.recovery.run()).ready, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_holds WHERE status='active'").get().n, 1);
  unavailable = false;
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.module.catalog.task(task.task_run_id).status, 'succeeded');
});

for (const terminal of ['failed', 'cancelled']) durableDirectoryTest(`成功 receipt 与 ${terminal} Task 的冲突保留来源，旧 COMPLETE 缓存和重复恢复不能隐藏`, async (t) => {
  let unavailable = false;
  const f = await fixture(t, { wrapInspector(inspect) { return (source) => {
    if (unavailable) throw Object.assign(new Error('临时读取失败'), { code: 'TEST_TRANSIENT' });
    return inspect(source);
  }; } }); const original = path.join(f.root, 'conflict.sqlite');
  const input = new DatabaseSync(original); input.exec("CREATE TABLE candidate_rows(value TEXT); INSERT INTO candidate_rows VALUES ('one');"); input.close();
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original, role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  let receipt;
  const taskLifecycle = terminal === 'failed' ? f.lifecycle : { runFileTask(payload) {
    return f.lifecycle.runFileTask({ ...payload, execute: async (...args) => {
      const result = await payload.execute(...args); receipt = result.receipt;
      // 注入成功提交后返回取消的历史错误；终态仍由真实 TaskLifecycle 写入。
      return { ...result, status: 'cancelled' };
    } });
  } };
  const run = f.module.runCandidateValidation({ taskLifecycle, runtime: f.runtime, filePlan,
    dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'conflict' },
    ...(terminal === 'failed' ? { afterCommit(value) { receipt = value; throw new Error('提交后反馈丢失'); } } : {}) });
  if (terminal === 'failed') await assert.rejects(run, /提交后反馈丢失/); else assert.equal((await run).status, 'cancelled');
  assert.equal(f.module.catalog.task(receipt.taskRunId).status, terminal);
  assert.equal(f.module.admission.snapshot().recoveryReady, false);
  const heads = f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all();
  const counters = f.db.prepare('SELECT * FROM biz_op_v327_version_counters').all();
  unavailable = true;
  assert.equal((await f.module.recovery.run()).ready, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_observation_attempts WHERE status='prepared'").get().n, 0);
  assert.equal(f.readRepository.listActiveRecoveryHolds().length, 1);
  unavailable = false;
  // 模拟旧 syncCompletion 已写入的错误缓存，验证枚举按持久事实重查。
  f.db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='CLOSED' WHERE task_run_id=?").run(receipt.taskRunId);
  f.db.prepare("UPDATE biz_op_v327_settlement_progress SET state='COMPLETE' WHERE task_run_id=?").run(receipt.taskRunId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recovery = await f.module.recovery.run(); assert.equal(recovery.ready, false, JSON.stringify(recovery));
    assert.equal(f.module.catalog.task(receipt.taskRunId).status, terminal);
    assert.equal(f.module.catalog.operation(receipt.taskRunId).phase, 'HOLD');
    assert.equal(f.module.catalog.operation(receipt.taskRunId).settlement_state, 'RECOVERY_BLOCKED');
    assert.equal(f.module.recovery.openObligations(), true);
    assert.deepEqual(f.module.catalog.receipt(receipt.taskRunId), receipt);
    assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all(), heads);
    assert.deepEqual(f.db.prepare('SELECT * FROM biz_op_v327_version_counters').all(), counters);
  }
  const directory = f.module.payloadStore.resolve(`operations/${receipt.taskRunId}`);
  const evidence = fs.readdirSync(directory).filter(name => name.startsWith('terminal-conflict-'));
  assert.equal(evidence.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, evidence[0]))).reason, 'TASK_RESULT_CONFLICT');
});

async function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-v327-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  let service = null;
  const readRepository = createRecoveryControlReadRepository(db);
  const module = createBizOpV327Module({ db, userDataDir: root, readRepository,
    getArchiveService: () => service, budgetOptions: options.budgetOptions });
  const inspectors = createInspectorRegistry();
  const providers = createSettlementRecoveryProviderRegistry();
  module.sources.register(options.wrapInspector ? { register(key, inspect) { inspectors.register(key, options.wrapInspector(inspect)); } } : inspectors, providers);
  inspectors.freeze(); providers.freeze();
  const platform = createStartupRecoveryCoordinator({ readRepository, inspectorRegistry: inspectors, providerRegistry: providers,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db), resolveTaskState: module.plan.taskState,
    planTransitions: module.plan.plan, sleep: async () => {}, transientAttempts: 1 });
  module.recovery.bindPlatform(options.wrapPlatform ? options.wrapPlatform(platform) : platform);
  service = createArchiveService({ database: db, rootDir: path.join(root, 'archive'), onArtifactReady(completed, repository) {
    module.readyHold(completed, repository);
    if (options.afterReady) options.afterReady(completed, repository);
  } });
  await service.initialize({ deferStartupRecovery: true });
  const runtime = createNonProductionBackgroundExecutionRuntime({ bizOpV327: module.runtimeBindings,
    resourceGovernor: createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0,
      ioHeavySlots: 2, memoryBytes: 2 * 1024 * 1024 * 1024 } }) });
  const lifecycle = createTaskLifecycle({ archiveService: service, businessOperationRegistry: createBusinessOperationRegistry(),
    flowResolver: createBusinessFlowResolver({ archiveService: service }),
    operationTracker: { async appendOperationFiles() { return { archiveFailed: false }; } } });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 5000 }); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (options.beforeBootstrap) await options.beforeBootstrap({ module, db, service });
  const bootstrap = await module.recovery.run();
  assert.equal(bootstrap.ready, options.expectReady !== false, JSON.stringify(bootstrap));
  return { root, db, module, service, runtime, lifecycle, platform, readRepository, bootstrap };
}

test('目录屏障不可用时首次及同名文件重试均拒绝，不建立业务提交收据', async (t) => {
  const f = await fixture(t);
  const originalFsync = fs.fsyncSync;
  const originalOpen = fs.openSync;
  const opened = new Map();
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = originalOpen(...args); opened.set(fd, args[1]); return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('目录屏障不支持'), { code: 'ENOTSUP' });
    const flags = opened.get(fd);
    assert.ok(typeof flags === 'number' ? flags & (fs.constants.O_RDWR | fs.constants.O_WRONLY)
      : typeof flags === 'string' && /[wa+]/.test(flags), '文件同步使用可写句柄，覆盖 Windows 要求');
    return originalFsync(fd);
  });
  const relative = 'operations/unsupported-task/intent.json';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => f.module.payloadStore.writeDocument(relative, { phase: 'PREPARING' }), { code: 'DURABILITY_BARRIER_UNAVAILABLE' });
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_receipts').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM biz_op_v327_input_heads').get().n, 0);
});

durableDirectoryTest('主库增量建表默认禁用，真实 Task/Archive/worker 候选原件受保护并提交一个版本', async (t) => {
  const f = await fixture(t);
  assert.equal(f.module.catalog.control().mode, 'DISABLED');
  const original = path.join(f.root, 'source.sqlite');
  const input = new DatabaseSync(original);
  input.exec("CREATE TABLE candidate_rows(value TEXT); INSERT INTO candidate_rows VALUES ('one'),('two');");
  input.close();
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original,
    role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  const result = await f.module.runCandidateValidation({ taskLifecycle: f.lifecycle, runtime: f.runtime,
    filePlan, dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'test' } });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.receipt.outcome.datasets[0].version, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_receipts').get().n, 1);
  const taskId = result.receipt.taskRunId;
  assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
  assert.equal(f.module.catalog.operation(taskId).phase, 'CLOSED');
  const holds = f.db.prepare('SELECT owner_type FROM archive_artifact_holds').all();
  assert.deepEqual(holds.map((row) => row.owner_type), ['v327-input']);
  assert.equal(f.db.prepare('SELECT row_count FROM biz_op_v327_datasets').get().row_count, 2);
  assert.throws(() => f.db.exec("UPDATE biz_op_v327_receipts SET outcome_json='{}'"), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM biz_op_v327_receipts'), /retained/);
});

async function prepareUncommitted(f, index, actionKey = 'biz-op-v327:import-candidate') {
  const taskRunId = `uncommitted-task-${index}`;
  const operationKey = `uncommitted-operation-${index}`;
  await f.service.beginTaskRun({ taskRunId, operationKey, moduleId: 'biz-op-recon',
    taskKey: ACTIONS[actionKey].taskKey, parentRunId: `parent-${index}` });
  await f.service.markTaskRunStarted(taskRunId);
  await f.module.admission.exclusive(() => f.module.prepareOperation({ taskRunId, operationKey, actionKey,
    intent: { index } }));
  return taskRunId;
}

durableDirectoryTest('Task 成功但批次失败的旧 COMPLETE 状态不能开放入口或改写原提交', async (t) => {
  const f = await fixture(t); const original = path.join(f.root, 'batch-conflict.sqlite');
  const input = new DatabaseSync(original); input.exec("CREATE TABLE candidate_rows(value TEXT); INSERT INTO candidate_rows VALUES ('one');"); input.close();
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original,
    role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  const result = await f.module.runCandidateValidation({ taskLifecycle: f.lifecycle, runtime: f.runtime, filePlan,
    dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'batch-conflict' } });
  const taskId = result.receipt.taskRunId;
  // 仅在临时库模拟旧批次结果与 Task 不一致，不把直接 SQL 当生产修复接口。
  f.db.prepare("UPDATE archive_batches SET task_status='failed' WHERE task_run_id=?").run(taskId);
  assert.equal(f.module.recovery.openObligations(), true);
  assert.equal((await f.module.recovery.run()).ready, false);
  assert.equal(f.module.catalog.task(taskId).status, 'succeeded');
  assert.equal(f.module.catalog.operation(taskId).settlement_state, 'RECOVERY_BLOCKED');
  assert.deepEqual(f.module.catalog.receipt(taskId), result.receipt);
  const names = fs.readdirSync(f.module.payloadStore.resolve(`operations/${taskId}`)).filter(name => name.startsWith('terminal-conflict-'));
  assert.equal(names.length, 1);
  assert.equal(f.module.payloadStore.readDocument(`operations/${taskId}/${names[0]}`).value.reason, 'BATCH_RESULT_CONFLICT');
});

durableDirectoryTest('未提交链只经 Main 后处理和真实控制转换，原 Task 失败且终止收据幂等', async (t) => {
  const f = await fixture(t);
  const taskId = await prepareUncommitted(f, 1);
  const result = await f.module.recovery.run();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.fullScans, 2);
  assert.equal(result.inspector, 3);
  assert.equal(result.provider, 0);
  assert.equal(result.main, 1);
  assert.equal(f.module.catalog.task(taskId).status, 'failed');
  assert.equal(f.module.catalog.receipt(taskId), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 1);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.module.catalog.control().generation, 0);
});

durableDirectoryTest('来源数量超限在首次平台扫描前退出，所有 Task 与记录继续保留', async (t) => {
  const f = await fixture(t, { budgetOptions: { limits: { ...RECOVERY_LIMITS, sources: 1 } } });
  const first = await prepareUncommitted(f, 1);
  await prepareUncommitted(f, 2);
  const result = await f.module.recovery.run();
  assert.equal(result.ready, false);
  assert.equal(result.fullScans, 0);
  assert.equal(result.main, 0);
  assert.equal(result.reason, 'BIZOP_RECOVERY_SNAPSHOT_LIMIT');
  assert.equal(f.module.catalog.task(first).status, 'running');
  assert.equal(f.module.admission.snapshot().recoveryReady, false);
});

for (const size of [32, 128, 1024]) {
  durableDirectoryTest(`${size} 个真实 Task 来源使用两次全量扫描及 3N 次 Inspector`, async (t) => {
    // 复杂度合同不把 CI 负载当作准入时钟；60 秒在真实在途调用测试中独立验证。
    const f = await fixture(t, { budgetOptions: { monotonicNow: () => 0 } });
    for (let index = 0; index < size; index += 1) await prepareUncommitted(f, index);
    const started = performance.now();
    const rssStart = process.memoryUsage().rss;
    let rssPeak = rssStart;
    const sample = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 20);
    const result = await f.module.recovery.run();
    clearInterval(sample);
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.fullScans, 2);
    assert.equal(result.inspector, 3 * size);
    assert.equal(result.provider, 0);
    assert.equal(result.main, size);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, size);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_task_runs WHERE status='failed'").get().n, size);
    const observationAttempts = f.db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_observation_attempts').get().n;
    assert.equal(observationAttempts, 3 * size);
    t.diagnostic(JSON.stringify({ ...result, wallElapsedMs: Math.ceil(performance.now() - started),
      observationAttempts, legacySourceCount: 0, rssStart, rssEnd: process.memoryUsage().rss,
      rssPeak: Math.max(rssPeak, process.memoryUsage().rss) }));
  });
}

durableDirectoryTest('READY 完成钩子失败时真实文件归档不会留下无保护的 READY', async (t) => {
  const f = await fixture(t, { afterReady() { throw new Error('故障注入：READY 后同事务失败'); } });
  const source = path.join(f.root, 'input.sqlite');
  fs.writeFileSync(source, '真实归档输入');
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: source,
    role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  await assert.rejects(f.module.runCandidateValidation({ taskLifecycle: f.lifecycle, runtime: f.runtime, filePlan,
    dataset: { kind: 'OP', dataDate: '2026-09-01', bu: 'test' } }), { code: 'BIZOP_ORIGINAL_SETTLEMENT_FAILED' });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_artifacts WHERE status='ready'").get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_artifact_holds').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_receipts').get().n, 0);
  assert.equal(f.module.catalog.control().generation, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), '真实归档输入');
});

durableDirectoryTest('未提交封存目录经真实维护 Task 回收，诊断目录独立保留', async (t) => {
  const f = await fixture(t);
  const taskId = await prepareUncommitted(f, 'cleanup');
  const stage = f.module.payloadStore.prepareCandidate(taskId, 'candidate-unused');
  fs.writeFileSync(path.join(stage.directory, 'part-000001.sqlite'), '未提交文件');
  const diagnostic = f.module.payloadStore.resolve(`diagnostics/report-retained`, { mustExist: false });
  fs.mkdirSync(diagnostic);
  fs.writeFileSync(path.join(diagnostic, 'part-000001.jsonl'), '保留的失败报告');
  const result = await f.module.recovery.run();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.fullScans, 2);
  assert.equal(fs.existsSync(stage.directory), false);
  assert.equal(fs.readFileSync(path.join(diagnostic, 'part-000001.jsonl'), 'utf8'), '保留的失败报告');
  const queue = f.db.prepare('SELECT * FROM biz_op_v327_reclaim_queue').get();
  assert.equal(queue.state, 'DONE');
  assert.equal(f.module.catalog.task(queue.owner_task_run_id).taskKey, 'bizOpReconV327:maintenance:reclaim');
  assert.equal(f.module.catalog.task(queue.owner_task_run_id).status, 'succeeded');
});

async function pendingCarrier(t, f, taskId, actionKey = 'biz-op-v327:import-candidate', reads = []) {
  const task = f.module.catalog.task(taskId);
  let worker;
  class PendingWorker extends Worker {
    constructor(...args) { super(...args); worker = this; }
    terminate() { return Promise.reject(Object.assign(new Error('终止拒绝'), { code: 'FIXTURE_TERMINATE_FAILED' })); }
  }
  const policy = structuredClone(BIZ_OP_V327_POLICIES.find((item) => item.actionKey === actionKey));
  const entryRegistry = createStaticRegistry({ [policy.entryKey]: path.resolve(__dirname, '../../fixtures/carrier-observation-worker.cjs') });
  const validatorRegistry = createStaticRegistry(Object.fromEntries([
    policy.result.validatorKey, policy.artifacts.technicalValidatorKey, policy.artifacts.businessValidatorKey
  ].filter(Boolean).map((key) => [key, () => true])));
  entryRegistry.freeze(); validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({ policies: [policy], entryRegistry, validatorRegistry,
    staticKeys: { resourceProfileKeys: [policy.resources.profile], inspectorKeys: [policy.commit.inspectorKey],
      conflictScopeResolverKeys: [policy.commit.conflictScopeResolverKey], settlementKeys: [policy.commit.settlementKey],
      publisherKeys: [policy.artifacts.publisherKey], technicalValidatorKeys: [policy.artifacts.technicalValidatorKey],
      businessValidatorKeys: [policy.artifacts.businessValidatorKey] } });
  policyRegistry.freeze();
  const governor = createResourceGovernor({ budgets: { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0,
    ioHeavySlots: 2, memoryBytes: 2 * 1024 * 1024 * 1024 } });
  const supervisor = createExecutionSupervisor({ policyRegistry, entryRegistry, validatorRegistry, resourceGovernor: governor,
    workerThreadAdapter: createWorkerThreadAdapter({ WorkerClass: PendingWorker }), carrierClosureActionKeys: [actionKey],
    beforeCarrierDispatch: (identity) => f.module.protection.beforeDispatch(identity, hash({ taskId }), reads) });
  t.after(async () => { if (worker) await Worker.prototype.terminate.call(worker); await supervisor.shutdown({ timeoutMs: 1000 }); });
  const control = await f.module.admission.exclusive(async () => {
    const value = supervisor.start({ actionKey, operationKey: task.operationKey, jobId: `pending-${taskId}`,
      workerInstanceId: `worker-${taskId}`, input: { behavior: 'error' }, context: { kind: 'operation',
        value: Object.fromEntries(['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'].map((key) => [key, task[key]])) } });
    f.module.protection.attachControl(value);
    await value.promise;
    f.module.protection.refresh(taskId);
    return value;
  });
  return { control, governor, async exit() {
    worker.postMessage({ fixture: 'exit' });
    await control.waitForCarrierClosure({ timeoutMs: 3000 });
    f.module.protection.refresh(taskId);
  } };
}

durableDirectoryTest('真实终止失败时阻断后处理；晚到退出后原 Task/同 scope 来源收敛', async (t) => {
  const f = await fixture(t);
  const taskId = await prepareUncommitted(f, 'late-exit');
  const pending = await pendingCarrier(t, f, taskId);
  const blocked = await f.module.recovery.run();
  assert.equal(blocked.ready, false);
  assert.equal(blocked.main, 0);
  assert.equal(pending.control.getCarrierObservation().disposition, 'UNKNOWN');
  assert.equal(pending.governor.snapshot().activeLeaseCount > 0, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 0);
  await pending.exit();
  const recovered = await f.module.recovery.run();
  assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.equal(f.module.catalog.task(taskId).status, 'failed');
  assert.equal(f.readRepository.listActiveRecoveryHolds().length, 0);
  assert.equal(pending.control.getCarrierObservation().disposition, 'EXITED');
  assert.equal((await pending.control.promise).error.code, 'FIXTURE_BUSINESS_FAILED');
});

test('累计费用在拒绝后不会重置，截止时间只禁止启动下一步', () => {
  let now = 0;
  const budget = createRecoveryBudget({ limits: { ...RECOVERY_LIMITS, evaluations: 2 }, monotonicNow: () => now });
  budget.charge('inspector'); budget.charge('provider');
  assert.throws(() => budget.charge('main'), { code: 'BIZOP_RECOVERY_WORK_LIMIT' });
  assert.throws(() => budget.charge('inspector'), { code: 'BIZOP_RECOVERY_WORK_LIMIT' });
  assert.equal(budget.snapshot().evaluations, 2);
  const timed = createRecoveryBudget({ monotonicNow: () => now });
  now = 60000;
  assert.throws(() => timed.begin('fullScans'), { code: 'BIZOP_RECOVERY_DEADLINE' });
  assert.equal(timed.snapshot().fullScans, 0);
});

durableDirectoryTest('真实 Main 进程在提交后退出，重启恢复原 Task、原 receipt 和原版本', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-v327-crash-'));
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../fixtures/biz-op-v327-crash.cjs'), root], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  assert.equal(child.status, 73, child.stderr || child.error?.message);
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'receipt-evidence.json'), 'utf8'));
  const f = await fixture(t, { root, beforeBootstrap({ module }) {
    assert.equal(module.catalog.task(evidence.taskRunId).status, 'running');
    assert.equal(module.catalog.receipt(evidence.taskRunId).committedAt, evidence.committedAt);
  } });
  assert.equal(f.bootstrap.ready, true);
  assert.equal(f.module.catalog.task(evidence.taskRunId).status, 'succeeded');
  assert.deepEqual(f.module.catalog.receipt(evidence.taskRunId), evidence);
  assert.equal(f.db.prepare('SELECT last_version FROM biz_op_v327_version_counters').get().last_version, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, 1);
  assert.equal(f.db.prepare('SELECT state FROM background_execution_batch_recovery_states').get().state, 'resolved');
  assert.equal(f.db.prepare('SELECT final_outcome FROM background_execution_batch_recovery_states').get().final_outcome, 'succeeded');
});

async function importFixture(f, date, content = 'value', kind = 'OP') {
  const original = path.join(f.root, `source-${kind}-${date}.sqlite`);
  if (!fs.existsSync(original)) {
    const input = new DatabaseSync(original);
    input.exec('CREATE TABLE candidate_rows(value TEXT)');
    input.prepare('INSERT INTO candidate_rows VALUES (?)').run(content);
    input.close();
  }
  const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [{ filePath: original,
    role: 'input', sourceOperation: 'bizOpReconV327:import' }], outputs: [] });
  return f.module.runCandidateValidation({ taskLifecycle: f.lifecycle, runtime: f.runtime, filePlan,
    dataset: { kind, dataDate: date, bu: 'test' } });
}

async function runFixture(f) {
  const start = await importFixture(f, '2026-09-01');
  const end = await importFixture(f, '2026-09-02');
  const flow = await importFixture(f, '2026-09-02', 'flow', 'FLOW');
  const id = await prepareUncommitted(f, 'run', 'biz-op-v327:run-candidate');
  const op = f.module.catalog.operation(id);
  const inputs = [start, end, flow].map((result, index) => {
    const entry = result.receipt.outcome.datasets[0];
    const source = f.db.prepare('SELECT * FROM biz_op_v327_datasets WHERE dataset_id=?').get(entry.datasetId);
    return { role: ['START_OP', 'END_OP', 'FLOW'][index], dataDate: entry.dataDate, datasetId: entry.datasetId,
      inputVersion: entry.version, sourceManifestDigest: source.source_manifest_digest };
  });
  const stage = f.module.payloadStore.prepareCandidate(id, 'result-protected');
  const file = new DatabaseSync(path.join(stage.directory, 'part-000001.sqlite'));
  file.exec('CREATE TABLE result_rows(value TEXT)'); file.close();
  const candidate = await f.module.payloadStore.sealCandidate({ taskRunId: id, objectId: 'result-protected', objectKind: 'RESULT',
    intentDigest: op.intent_digest, parts: [{ name: 'part-000001.sqlite', rowCount: 0 }], catalog: {
      startDate: '2026-09-01', endDate: '2026-09-02', inputs, fullRowCount: 0, diffRowCount: 0,
      inputFingerprint: hash(inputs), ruleVersion: 'fixture-v1' } });
  const receipt = await f.module.admission.exclusive(() => f.module.catalog.commitRun({ taskRunId: id,
    intentDigest: op.intent_digest, candidate }));
  assert.equal((await f.module.recovery.run()).ready, true);
  return { start, end, receipt, candidate };
}

async function prepareDelete(f, index, values) {
  const actionKey = 'biz-op-v327:delete-plan';
  const taskRunId = `delete-task-${index}`;
  const operationKey = `delete-operation-${index}`;
  const intent = f.module.catalog.deleteIntent({ ...values, expectedGeneration: f.module.catalog.control().generation });
  await f.service.beginTaskRun({ taskRunId, operationKey, moduleId: 'biz-op-recon',
    taskKey: ACTIONS[actionKey].taskKey, parentRunId: `delete-parent-${index}` });
  await f.service.markTaskRunStarted(taskRunId);
  const op = await f.module.admission.exclusive(() => f.module.prepareOperation({ taskRunId, operationKey, actionKey, intent }));
  return { taskRunId, intentDigest: op.intent_digest, intent };
}

durableDirectoryTest('保留历史结果删除输入：只释放 INPUT，RESULT 原件引用和结果 payload 独立保留', async (t) => {
  const f = await fixture(t);
  const data = await runFixture(f);
  const datasetId = data.start.receipt.outcome.datasets[0].datasetId;
  const selected = await prepareDelete(f, 'keep', { datasetIds: [datasetId], deleteMode: 'KEEP_RESULTS' });
  await f.module.admission.exclusive(() => f.module.catalog.commitDelete(selected));
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare('SELECT state FROM biz_op_v327_runs').get().state, 'PUBLISHED');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_artifact_holds WHERE owner_type='v327-result'").get().n, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_artifact_holds WHERE owner_type='v327-input'").get().n, 2);
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(`inputs/${datasetId}`, { mustExist: false })), false);
  assert.equal(fs.existsSync(f.module.payloadStore.resolve('results/result-protected/part-000001.sqlite')), true);
  const originalReceipt = data.start.receipt;
  assert.deepEqual(f.module.catalog.commitImport({ taskRunId: originalReceipt.taskRunId,
    intentDigest: originalReceipt.intentDigest, candidates: null }), originalReceipt);
  assert.equal(f.module.catalog.receiptState(originalReceipt.taskRunId).currentObjects[0].availability, 'deleted');
  assert.equal(f.module.catalog.receipt(data.receipt.taskRunId).outcome.version, 1);
});

durableDirectoryTest('关联删除必须完整预览；嵌套 SAVEPOINT 故障不留下新收据、任务、回收或少掉的 holds', async (t) => {
  const f = await fixture(t);
  const data = await runFixture(f);
  const datasetId = data.start.receipt.outcome.datasets[0].datasetId;
  const incomplete = await prepareDelete(f, 'incomplete', { datasetIds: [datasetId], deleteMode: 'DELETE_ASSOCIATED' });
  await assert.rejects(f.module.admission.exclusive(() => f.module.catalog.commitDelete(incomplete)), { code: 'BIZOP_DELETE_PREVIEW_INCOMPLETE' });
  assert.equal((await f.module.recovery.run()).ready, true);
  const selected = await prepareDelete(f, 'all', { datasetIds: [datasetId], runIds: ['result-protected'], deleteMode: 'DELETE_ASSOCIATED' });
  const before = { generation: f.module.catalog.control().generation,
    holds: f.db.prepare('SELECT * FROM archive_artifact_holds ORDER BY artifact_id,owner_type').all(),
    tasks: f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n };
  await assert.rejects(f.module.admission.exclusive(() => f.module.catalog.transaction(() => {
    f.module.catalog.commitDelete(selected);
    throw new Error('提交外层故障');
  })), /提交外层故障/);
  assert.equal(f.module.catalog.receipt(selected.taskRunId), null);
  assert.equal(f.module.catalog.control().generation, before.generation);
  assert.deepEqual(f.db.prepare('SELECT * FROM archive_artifact_holds ORDER BY artifact_id,owner_type').all(), before.holds);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, before.tasks);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_reclaim_queue').get().n, 0);
  await f.module.admission.exclusive(() => f.module.catalog.commitDelete(selected));
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM archive_artifact_holds WHERE owner_type='v327-result'").get().n, 0);
  assert.equal(f.module.catalog.receiptState(data.receipt.taskRunId).currentObjects[0].availability, 'deleted');
});

durableDirectoryTest('指纹复用不分配新公开版本，弃用候选由业务 receipt 授权回收', async (t) => {
  const f = await fixture(t);
  const first = await importFixture(f, '2026-09-01');
  const second = await importFixture(f, '2026-09-01');
  assert.equal(second.receipt.outcome.datasets[0].reused, true);
  assert.equal(second.receipt.outcome.datasets[0].datasetId, first.receipt.outcome.datasets[0].datasetId);
  const unused = second.receipt.outcome.unusedCandidates[0];
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(unused.manifestPath)), true);
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(fs.existsSync(f.module.payloadStore.resolve(unused.manifestPath, { mustExist: false })), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_datasets').get().n, 1);
  assert.equal(f.db.prepare('SELECT last_version FROM biz_op_v327_version_counters').get().last_version, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 0);
});

durableDirectoryTest('失败报告的两个真实 reader 独立持 pin，producer 失败与 reader 已退出都不能越过发布义务', async (t) => {
  const f = await fixture(t);
  const producerId = await prepareUncommitted(f, 'report-producer');
  const producer = await pendingCarrier(t, f, producerId);
  await producer.exit();
  const stage = f.module.payloadStore.prepareCandidate(producerId, 'report-independent');
  const bytes = Buffer.from('{"row":2,"code":"INVALID_ACCOUNT"}\n');
  fs.writeFileSync(path.join(stage.directory, 'part-000001.jsonl'), bytes);
  const token = await f.module.payloadStore.sealCandidate({ taskRunId: producerId, objectId: 'report-independent',
    objectKind: 'DIAGNOSTIC', intentDigest: f.module.catalog.operation(producerId).intent_digest, catalog: {},
    parts: [{ name: 'part-000001.jsonl', rowCount: 1 }] });
  const identity = producer.control.carrierIdentity;
  f.module.protection.registerDiagnostic({ taskRunId: producerId, jobId: identity.jobId, sessionId: identity.sessionId,
    token, sampleCount: 1, sampleBytes: bytes.length, scanComplete: true, errorCountExact: true });
  assert.equal((await f.module.recovery.run()).ready, true);
  assert.equal(f.module.catalog.task(producerId).status, 'failed');
  const read = { objectKind: 'DIAGNOSTIC', objectId: token.ref, manifestDigest: token.sha256 };
  const action = 'biz-op-v327:export-errors';
  const firstId = await prepareUncommitted(f, 'reader-one', action);
  const first = await pendingCarrier(t, f, firstId, action, [read]);
  const secondId = await prepareUncommitted(f, 'reader-two', action);
  const second = await pendingCarrier(t, f, secondId, action, [read]);
  await second.exit();
  f.module.protection.retireDiagnostic(token.ref, producerId);
  assert.throws(() => f.module.protection.assertReadable(read), { code: 'BIZOP_READ_OBJECT_UNAVAILABLE' });
  assert.throws(() => f.module.protection.releasePins(firstId), { code: 'BIZOP_READER_OBLIGATION_PENDING' });
  assert.throws(() => f.module.protection.completeInputObligation(secondId), { code: 'BIZOP_PUBLISHER_AUTHORITY_REQUIRED' });
  assert.equal((await f.module.recovery.run()).ready, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 2);
  assert.equal(fs.readFileSync(f.module.payloadStore.resolve(`diagnostics/${token.ref}/part-000001.jsonl`), 'utf8'), bytes.toString());
  assert.equal(f.db.prepare("SELECT state FROM biz_op_v327_reclaim_queue WHERE payload_kind='DIAGNOSTIC'").get().state, 'PENDING');
  await first.exit();
  assert.equal((await f.module.recovery.run()).ready, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins').get().n, 2);
});

durableDirectoryTest('启动预检与 Archive owner 延续同一累计预算，全量扫描总计两次', async (t) => {
  const f = await fixture(t, { async beforeBootstrap({ module, service }) {
    const taskRunId = 'startup-deferred-task';
    await service.beginTaskRun({ taskRunId, operationKey: 'startup-operation', moduleId: 'biz-op-recon',
      taskKey: 'bizOpReconV327:run', parentRunId: 'startup-parent' });
    await service.markTaskRunStarted(taskRunId);
    await module.admission.exclusive(() => module.prepareOperation({ taskRunId, operationKey: 'startup-operation',
      actionKey: 'biz-op-v327:run-candidate', intent: { index: 1 } }), { recovery: true });
    const early = await module.recovery.run({ initialPlatformOnly: true });
    assert.equal(early.reason, 'ARCHIVE_OWNER_PHASE_REQUIRED');
    assert.equal(early.fullScans, 0);
    assert.equal(early.enumerations, 1);
    assert.equal(module.recovery.hasCompletedPlatformScan(), false);
  } });
  assert.equal(f.bootstrap.fullScans, 2);
  assert.equal(f.module.recovery.hasCompletedPlatformScan(), true);
  assert.equal(f.bootstrap.enumerations, 3);
  assert.equal(f.bootstrap.normalized, 2);
  assert.equal(f.module.catalog.task('startup-deferred-task').status, 'failed');
});

durableDirectoryTest('跨过准入期限的在途平台调用仍持有 gate，不提前返回或启动另一 attempt', async (t) => {
  let now = 0;
  let intercept = false;
  let release;
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { budgetOptions: { monotonicNow: () => now }, wrapPlatform(platform) {
    return { recoverSource: platform.recoverSource.bind(platform), async scanAndRecover() {
      if (intercept) { enter(); await blocked; }
      return platform.scanAndRecover();
    } };
  } });
  await prepareUncommitted(f, 'deadline');
  intercept = true;
  const pending = f.module.recovery.run();
  await entered;
  now = 60001;
  assert.equal(f.module.admission.snapshot().exclusive, true);
  assert.equal(f.module.recovery.run(), pending);
  await assert.rejects(f.module.admission.exclusive(async () => {}), { code: 'BIZOP_MODULE_BUSY' });
  release();
  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'BIZOP_RECOVERY_DEADLINE');
  assert.equal(result.main, 0);
  assert.equal(f.module.admission.snapshot().exclusive, false);
});

durableDirectoryTest('异步共享读取在真实等待期间阻止写入，义务未完成后关闭入口并保留恢复路径', async (t) => {
  const f = await fixture(t);
  const taskId = await prepareUncommitted(f, 'shared-reader', 'biz-op-v327:export-errors');
  let finish;
  const reading = f.module.admission.readTask(taskId, async () => {
    f.module.admission.assertTaskAccess(taskId);
    assert.throws(() => f.module.admission.assertTaskAccess('another-task'), { code: 'BIZOP_TASK_ADMISSION_REQUIRED' });
    await new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(f.module.admission.snapshot().readers, 1);
  await assert.rejects(f.module.admission.exclusive(async () => {}), { code: 'BIZOP_MODULE_BUSY' });
  await assert.rejects(f.module.recovery.run(), { code: 'BIZOP_MODULE_BUSY' });
  finish(); await reading;
  assert.equal(f.module.admission.snapshot().readers, 0);
  assert.equal(f.module.admission.snapshot().recoveryReady, false);
  assert.equal((await f.module.recovery.run()).ready, false);
});

durableDirectoryTest('未接入升级权威时 UPGRADE 保持未决，不按普通无 receipt 操作自动失败', async (t) => {
  const f = await fixture(t);
  const taskId = await prepareUncommitted(f, 'upgrade', 'biz-op-v327:upgrade-preflight');
  const result = await f.module.recovery.run();
  assert.equal(result.ready, false);
  assert.equal(result.main, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 0);
  assert.notEqual(f.module.catalog.task(taskId).status, 'failed');
});

durableDirectoryTest('回收中途到期保留授权和原维护 Task，下次 attempt 容忍已删除文件并完成', async (t) => {
  let now = 0;
  const f = await fixture(t, { budgetOptions: { monotonicNow: () => now } });
  const id = await prepareUncommitted(f, 'partial-unlink');
  const stage = f.module.payloadStore.prepareCandidate(id, 'candidate-partial');
  fs.writeFileSync(path.join(stage.directory, 'part-000001.sqlite'), '一');
  fs.writeFileSync(path.join(stage.directory, 'part-000002.sqlite'), '二');
  const unlink = fs.promises.unlink;
  let advance = true;
  t.mock.method(fs.promises, 'unlink', async (...args) => {
    const result = await unlink(...args);
    if (advance) { advance = false; now = 60001; }
    return result;
  });
  const blocked = await f.module.recovery.run();
  assert.equal(blocked.ready, false);
  assert.equal(blocked.reason, 'BIZOP_RECOVERY_DEADLINE');
  const queue = f.db.prepare('SELECT * FROM biz_op_v327_reclaim_queue').get();
  assert.equal(queue.state, 'RECLAIMING');
  assert.ok(queue.authorization_digest);
  assert.equal(fs.existsSync(path.join(stage.directory, 'part-000001.sqlite')), false);
  assert.equal(fs.existsSync(path.join(stage.directory, 'part-000002.sqlite')), true);
  const result = await f.module.recovery.run();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.module.catalog.task(queue.owner_task_run_id).status, 'succeeded');
  assert.equal(fs.existsSync(stage.directory), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_reclaim_queue').get().n, 1);
});

durableDirectoryTest('真实 IPC 注册的十个新区间动作保持禁用，显式恢复重试接通同一 Main driver', async (t) => {
  const f = await fixture(t);
  const { registerBizOpV327Handlers } = require('../../../src/main-process/biz-op-v327/ipc');
  const handlers = new Map();
  registerBizOpV327Handlers({ ipcMain: { handle(key, handler) {
    assert.equal(handlers.has(key), false); handlers.set(key, handler);
  } }, getModule: () => f.module, businessOperationRegistry: createBusinessOperationRegistry() });
  assert.equal(handlers.size, 12);
  for (const [key, handler] of handlers) {
    if (key.endsWith(':status') || key.endsWith(':retry')) continue;
    assert.throws(() => handler(), { code: 'BIZOP_V327_NOT_ENABLED' });
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM archive_task_runs').get().n, 0);
  const taskId = await prepareUncommitted(f, 'retry-ipc');
  assert.deepEqual(f.module.protectedTasks().taskRunIds, [taskId]);
  const result = await handlers.get('bizOpReconV327:recovery:retry')();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.module.catalog.task(taskId).status, 'failed');
  assert.deepEqual(f.module.protectedTasks(), { taskRunIds: [], batchIds: [] });
  assert.equal(handlers.get('bizOpReconV327:status')().mode, 'DISABLED');
});

durableDirectoryTest('真实 Archive controller 启动先调用模块恢复，通用 sweep 不改写未决无文件 Task', async (t) => {
  const f = await fixture(t);
  const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
  const taskId = await prepareUncommitted(f, 'host-reader', 'biz-op-v327:export-errors');
  const settings = new Map();
  const controller = createArchiveCenterController({
    database: { getSetting: (key) => settings.get(key), setSetting: (key, value) => settings.set(key, value), listTemplates: () => [] },
    service: f.service,
    recoverInterruptedTaskOwners: [{ ownerName: 'biz-op-v327', recover: () => f.module.recovery.run() }],
    getProtectedInterruptedTaskBatchIds: f.module.protectedTasks
  });
  const started = await controller.initialize();
  assert.equal(started.ok, true);
  assert.equal(f.module.catalog.task(taskId).status, 'interrupted');
  assert.equal(f.module.catalog.task(taskId).failureCode, 'BIZOP_RECOVERY_PENDING');
  assert.equal(f.module.catalog.operation(taskId).phase, 'PREPARING');
  assert.equal(f.readRepository.listActiveRecoveryHolds().length, 1);
  assert.equal(f.module.catalog.receipt(taskId), null);
});

test('新模块绑定不能替另一个模块满足关闭观察的 Main 持久绑定', async (t) => {
  const f = await fixture(t);
  const runtime = createNonProductionBackgroundExecutionRuntime({ bizOpV327: f.module.runtimeBindings,
    carrierClosureActionKeys: ['toolbox:merge'], resourceGovernor: createResourceGovernor({ budgets: {
      cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 2 * 1024 ** 3 } }) });
  t.after(() => runtime.shutdown({ timeoutMs: 5000 }));
  const control = runtime.start({ actionKey: 'toolbox:merge', operationKey: 'other-module-operation', input: {},
    context: { kind: 'operation', value: { taskRunId: 'other-task', taskKey: 'task.toolbox:merge', moduleId: 'toolbox',
      parentRunId: 'other-parent', operationKey: 'other-module-operation' } } });
  const result = await control.promise;
  assert.equal(result.error.code, 'CARRIER_DISPATCH_BINDING_REQUIRED');
  assert.equal(control.getCarrierObservation().disposition, 'NOT_CREATED');
  assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});

durableDirectoryTest('收据优先仍核验 action 和 intent，不能把导入 Task 作为删除或运行重试', async (t) => {
  const f = await fixture(t);
  const result = await importFixture(f, '2026-09-01');
  const args = { taskRunId: result.receipt.taskRunId, intentDigest: result.receipt.intentDigest };
  assert.throws(() => f.module.catalog.commitRun(args), { code: 'BIZOP_RECEIPT_ACTION_MISMATCH' });
  assert.throws(() => f.module.catalog.commitDelete(args), { code: 'BIZOP_RECEIPT_ACTION_MISMATCH' });
  assert.throws(() => f.module.catalog.commitImport({ ...args, intentDigest: hash('different-intent') }), { code: 'BIZOP_INTENT_CONFLICT' });
  assert.equal(f.module.catalog.control().generation, 1);
});

test('4096 个真实目录任务完整枚举，4097 项在交付平台前拒绝且不返回截断数组', async (t) => {
  const f = await fixture(t);
  function addTask(index) {
    const taskRunId = `enumeration-${index}`;
    const operationKey = `enumeration-operation-${index}`;
    f.module.catalog.archive.beginTaskRun({ taskRunId, operationKey, moduleId: 'biz-op-recon',
      taskKey: 'bizOpReconV327:run', parentRunId: `enumeration-parent-${index}` });
    // 仅测目录枚举；这些记录不进入 Inspector，文件与载体真实性另由真实故障链验收。
    f.module.catalog.prepare({ taskRunId, operationKey, actionKey: 'biz-op-v327:run-candidate',
      intent: { index }, intentRelPath: `operations/${taskRunId}/intent.json`, expectedGeneration: 0 });
  }
  f.module.catalog.transaction(() => { for (let index = 0; index < 4096; index += 1) addTask(index); });
  const budget = createRecoveryBudget({ monotonicNow: () => 0 });
  f.module.sources.installBudget(budget);
  const complete = f.module.sources.collect();
  assert.equal(complete.length, 4096);
  assert.equal(Object.isFrozen(complete), true);
  assert.equal(budget.snapshot().normalized, 4096);
  addTask(4096);
  assert.throws(() => f.module.sources.collect(), { code: 'BIZOP_RECOVERY_SNAPSHOT_LIMIT' });
  assert.equal(budget.snapshot().fullScans, 0);
  assert.equal(budget.snapshot().main, 0);
  f.module.sources.clear();
  t.diagnostic(JSON.stringify({ sourceCount: 4096, sourceBytes: Buffer.byteLength(JSON.stringify(complete)),
    rssBytes: process.memoryUsage().rss, evaluations: budget.snapshot().evaluations }));
});

durableDirectoryTest('单来源与全量 decision 字节预算分别拒绝，后处理和文件清理均不执行', async (t) => {
  const single = await fixture(t, { budgetOptions: { limits: { ...RECOVERY_LIMITS, singleSourceBytes: 64 } } });
  await prepareUncommitted(single, 'source-bytes');
  const oversized = await single.module.recovery.run();
  assert.equal(oversized.reason, 'BIZOP_RECOVERY_SOURCE_TOO_LARGE');
  assert.equal(oversized.fullScans, 0);
  assert.equal(oversized.main, 0);
  const decisions = await fixture(t, { budgetOptions: { limits: { ...RECOVERY_LIMITS, decisionBytes: 64 } } });
  const id = await prepareUncommitted(decisions, 'decision-bytes');
  const blocked = await decisions.module.recovery.run();
  assert.equal(blocked.reason, 'BIZOP_RECOVERY_DECISIONS_LIMIT');
  assert.equal(blocked.main, 0);
  assert.equal(decisions.module.catalog.task(id).status, 'running');
  assert.equal(decisions.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_abort_finalizations').get().n, 0);
});

durableDirectoryTest('最终完整扫描才出现的新任务继续阻断，不能递归发起第三次扫描', async (t) => {
  let f;
  let armed = false;
  let calls = 0;
  f = await fixture(t, { wrapPlatform(platform) {
    return { recoverSource: platform.recoverSource.bind(platform), async scanAndRecover() {
      const summary = await platform.scanAndRecover();
      if (armed && ++calls === 2) {
        await f.service.beginTaskRun({ taskRunId: 'final-new-task', operationKey: 'final-new-operation',
          moduleId: 'biz-op-recon', taskKey: 'bizOpReconV327:run', parentRunId: 'final-new-parent' });
        f.module.prepareOperation({ taskRunId: 'final-new-task', operationKey: 'final-new-operation',
          actionKey: 'biz-op-v327:run-candidate', intent: { observedAtFinalScan: true } });
      }
      return summary;
    } };
  } });
  armed = true;
  const result = await f.module.recovery.run();
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'FINAL_OBLIGATIONS_PENDING');
  assert.equal(result.fullScans, 2);
  assert.equal(calls, 2);
  assert.equal(f.module.catalog.task('final-new-task').status, 'prepared');
  assert.equal(f.module.admission.snapshot().recoveryReady, false);
});
