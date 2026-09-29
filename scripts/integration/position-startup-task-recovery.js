'use strict';
// Position 生产启动链：G1 composition → Main 原恢复入口 → 真实 side DB → G2 owner → outbox。
// 用临时 DB、真实银行导入提交构造零 outbox 的中断点；不声称 Electron 强杀/Windows 验收。
// 用法：node scripts/integration/position-startup-task-recovery.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { createPositionStartupRecoveryHarness } = require('../../tests/helpers/position-startup-recovery-harness');
const { createApplicationRecoveryComposition } = require('../../src/main-process/application-recovery/composition');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTerminalRouteRegistry } = require('../../src/main-process/archive-center/terminal-route-registry');
const {
  createTaskPolicyRegistry
} = require('../../src/main-process/execution-descriptors/composition');
const { normalizeFilePlanV1, artifactManifestFromFilePlan } = require('../../src/main-process/archive-center/file-plan');
const { createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { createPositionTaskOwner } = require('../../src/main-process/position-reconciliation/task-owner');
const { createPositionTaskAdapter } = require('../../src/main-process/position-reconciliation/task-adapter');
const { positionInputFilePlanEvidence } = require('../../src/main-process/position-reconciliation/archive-file-plan-evidence');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { BANK_SHEET_NAME, POSITION_SIDE_DB_PENDING_SETTING, POSITION_SIDE_DB_CHECKPOINT_SETTING } = require('../../src/main-process/position-reconciliation/constants');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-startup-task-recovery-'));
const policies = createTaskPolicyRegistry();
const channel = 'position-reconciliation:bank:apply-import';
let passed = 0;
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function material(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const inputPath = path.join(directory, 'external-bank.xlsx');
  const row = { BizId: `STARTUP-${name}`, BillDate: '2026-07-20', Channel: 'DBS', 地区: 'HK',
    MerchantId: 'M001', Currency: 'USD', 'Credit Amount': '100', 'Debit Amount': '0',
    ReconciliationId: 'RID-1', FundType: 'Inbound&FX' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    BANK_STATEMENT_FIELDS, BANK_STATEMENT_FIELDS.map((key) => row[key] ?? '')
  ]), BANK_SHEET_NAME);
  XLSX.writeFile(workbook, inputPath);
  return { directory, inputPath, inputHash: hash(inputPath), taskRunId: `position-startup-${name}` };
}

function boot(item, options = {}) {
  const dbPath = path.join(item.directory, 'main.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS startup_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const diagnostics = [];
  const events = [];
  const tracked = [];
  const counts = { sweep: 0, persistIntent: 0, pendingClear: 0 };
  let service;
  const database = { db, dbPath,
    getSetting: (name) => db.prepare('SELECT value FROM startup_settings WHERE name=?').get(name)?.value || '',
    setSetting(name, value) {
      if (name === POSITION_SIDE_DB_PENDING_SETTING && !value && database.getSetting(name)) {
        counts.pendingClear += 1;
        assert.equal(service.repository.getTaskRun(item.taskRunId).status, 'succeeded', 'pending 只能在原任务 durable 终态之后清除');
        if (options.failPendingClear) throw Object.assign(new Error('注入 durable 后 pending 写失败'), { code: 'FIXTURE_PENDING_CLEAR_FAILED' });
      }
      db.prepare('INSERT INTO startup_settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, String(value));
    },
    listTemplates: () => []
  };
  const main = createPositionStartupRecoveryHarness({ database, diagnostics, tracked });
  let controller;
  const owner = createPositionTaskOwner({
    readSetting: database.getSetting, writeSetting: database.setSetting, settingsAvailable: () => true,
    getDatabasePath: () => dbPath, getCurrentService: main.currentService, getService: main.getService,
    getArchiveCenter: () => controller, initializeArchiveCenter: () => controller,
    getTaskLifecycle: () => null, getTaskPolicy: (key) => policies.require(key),
    supportsArchiveChannel: (key) => policies.require(key).taskKind === 'file'
  });
  service = createArchiveService({ database: db, rootDir: path.join(item.directory, 'archive'),
    onSourceReleased: owner.cleanupPositionArchiveSourcePaths });
  const realSweep = service.markInterruptedTasks.bind(service);
  service.markInterruptedTasks = (...args) => { counts.sweep += 1; events.push('sweep'); return realSweep(...args); };
  const outbox = createArchiveOutboxStore(path.join(item.directory, 'outbox'));
  const noop = async () => {};
  const application = createApplicationRecoveryComposition({
    platform: { scanAndRecover: async () => ({}), recoverSource: noop },
    bizOpModule: { recovery: { bindPlatform() {}, run: async () => ({}), openObligations: () => false },
      activation: { needed: () => false } },
    recoverPendingRuns: noop, recoverLegacyBizOpRuns: noop, recoverPreFundRuns: noop,
    recoverPosition: main.recover,
    recoverToolboxVccPublications: noop, recoverVccImportTerminal: noop, reconcileVccImportLineage: noop
  });
  controller = createArchiveCenterController({ service, database, outboxStore: outbox,
    terminalRouteRegistry: createTerminalRouteRegistry([owner.terminalRegistration]),
    resolveOutboxTerminalIntent: owner.resolvePositionOutboxTerminalIntent,
    recoverInterruptedTaskOwners: application.archiveOwnerHooks(), postOutboxStartupHooks: application.postOutboxHooks(),
    getProtectedInterruptedTaskBatchIds: owner.protectedInterruptedTasks,
    onOutboxFlushed: owner.cleanupPositionArchiveSourcePaths,
    logWarning: (...args) => diagnostics.push(args)
  });
  const realPersist = controller.persistTaskTerminalIntent.bind(controller);
  controller.persistTaskTerminalIntent = (payload) => {
    counts.persistIntent += 1;
    events.push('persist-intent');
    assert.equal(payload.owner.batchContext.taskRunId, item.taskRunId);
    if (item.context) assert.deepEqual(payload.owner.batchContext, item.context);
    return realPersist(payload);
  };
  const realFlush = controller.flushOutbox.bind(controller);
  let flushCalls = 0;
  let firstFlushPending = false;
  controller.flushOutbox = async () => {
    flushCalls += 1;
    // 只闩锁 Main 恢复发起的第一次 flush；Controller 后续 flush 必须能继续，
    // 否则 wrapper 提前返回的回归会被共用闩锁掩盖。
    if (options.flushBarrier && flushCalls === 1) {
      firstFlushPending = true;
      options.flushBarrier.entered.resolve();
      try {
        await options.flushBarrier.release.promise;
        events.push('flush');
        return await realFlush();
      } finally { firstFlushPending = false; }
    }
    assert.equal(firstFlushPending, false, 'Controller 后续 flush 不得越过尚未完成的 Main owner 恢复');
    events.push('flush');
    return realFlush();
  };
  main.attach(owner, controller);
  return { database, db, service, controller, owner, outbox, application, main, counts, events, tracked, diagnostics,
    async initialize() {
      await application.platformFacade.scanAndRecover();
      await application.preflight();
      try {
        const result = await controller.initialize();
        application.completeArchiveInitialization(result);
        return result;
      } catch (error) { application.failArchiveInitialization(error); throw error; }
    },
    async close() { await Promise.allSettled(tracked); main.close(); db.close(); }
  };
}

async function seedCommittedWithoutOutbox(item) {
  const host = boot(item);
  try {
    await host.initialize();
    const position = host.main.getService();
    const preparedImport = await position.prepareBankImport([item.inputPath]);
    assert.equal(preparedImport.status, 'needs-confirmation', JSON.stringify(preparedImport));
    const files = position.bankImportArchiveIntent(preparedImport.token);
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: files.map((file) => ({ filePath: file.filePath, ...positionInputFilePlanEvidence(file),
        originalName: file.originalName, role: 'input', sourceOperation: channel })), outputs: [] });
    const policy = policies.require(channel);
    const invocation = createPositionTaskAdapter({ owner: host.owner, createOperationToken: () => item.taskRunId,
      reportArchiveFailure: (error) => host.diagnostics.push(error) }).createInvocation({ meta: { channel }, policy,
      prepared: { filePlan, positionArchiveEvidence: { inputs: files.map((file) => ({
        sourceType: file.sourceType, sha256: file.expectedSha256 || file.sha256, sizeBytes: file.sizeBytes
      })), outputs: [] } } });
    const begun = await host.service.beginTaskRun({ ...invocation.identity, taskKey: channel,
      moduleId: policy.scopeId, parentRunId: `flow-${item.taskRunId}` });
    assert.equal(begun.ok, true);
    const reserved = await host.service.reserveFileTaskBatch({ taskRun: begun.taskRun,
      manifest: artifactManifestFromFilePlan(filePlan), moduleCode: policy.moduleCode,
      moduleName: policy.moduleName, ownerTerminalRecovery: null });
    assert.equal(reserved.ok, true);
    const batch = reserved.batch;
    item.context = { batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: batch.taskRunId,
      taskKey: batch.taskKey, moduleId: batch.moduleId, parentRunId: batch.parentRunId, operationKey: batch.operationKey };
    assert.equal((await host.service.startFileTask(item.taskRunId, batch.id)).ok, true);
    item.baseCheckpoint = position.persistenceCheckpoint();
    const controls = { fileEvidence: { filePlan }, settleArtifacts: async () => ({ durable: false, message: '注入业务提交后的归档未完成' }) };
    const result = await invocation.execute({ taskContext: createIpcTaskContext(item.context, controls), controls,
      markExecuteStarted() {}, executeBusiness: () => position.applyBankImport(preparedImport.token,
        item.context, filePlan.inputs.map((file) => file.filePath)) });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    item.checkpoint = position.persistenceCheckpoint();
    item.commitInputs = position.listCommittedOperationInputs(item.taskRunId);
    assert.equal(item.commitInputs.length, 1, '必须存在生产 side DB 的文件级提交凭证');
    assert.equal(item.checkpoint.generation, item.baseCheckpoint.generation + 1);
    assert.deepEqual(JSON.parse(host.database.getSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING)), item.baseCheckpoint);
    item.pendingRaw = host.database.getSetting(POSITION_SIDE_DB_PENDING_SETTING);
    const pending = JSON.parse(item.pendingRaw);
    assert.equal(pending.businessState, 'success');
    assert.equal(pending.archiveState, 'incomplete');
    assert.deepEqual(pending.owner.batchContext, item.context);
    item.staging = pending.archiveFiles.filter((file) => file.role === 'input').map((file) => ({ path: file.filePath, hash: hash(file.filePath) }));
    assert.equal(host.outbox.list().length, 0, '中断点在 TaskLifecycle 持久终态 intent 之前，不得预建 outbox');
    assert.equal(host.counts.persistIntent, 0);
    assert.equal(position.store.getBankRows().length, 1);
    // 有意在 adapter 返回后、TaskLifecycle 持久终态 intent 前关库，构造该精确中断窗口。
  } finally { await host.close(); }
}

function assertPreservedFiles(item) {
  assert.equal(hash(item.inputPath), item.inputHash, '外部源不得删除或改写');
  for (const file of item.staging) assert.equal(hash(file.path), file.hash, '未收口的受管暂存必须保留');
}
function assertRecovered(host, item) {
  const position = host.main.getService();
  assert.deepEqual(position.persistenceCheckpoint(), item.checkpoint, '恢复不得再次执行业务提交');
  assert.deepEqual(position.listCommittedOperationInputs(item.taskRunId), item.commitInputs);
  assert.equal(position.store.getBankRows().length, 1);
  assert.deepEqual(JSON.parse(host.database.getSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING)), item.checkpoint);
  assert.equal(host.owner.readPositionPendingOperation(), null);
  assert.equal(host.outbox.list().length, 0);
  assert.equal(host.service.repository.getTaskRun(item.taskRunId).status, 'succeeded');
  assert.equal(host.db.prepare('SELECT COUNT(*) AS count FROM archive_task_runs').get().count, 1);
  assert.equal(host.db.prepare('SELECT COUNT(*) AS count FROM archive_batches').get().count, 1);
  const batch = host.service.repository.getBatchDetail(item.context.batchId);
  assert.equal(batch.taskStatus, 'succeeded');
  assert.equal(batch.artifacts.length, 1);
  assert.equal(batch.artifacts[0].status, 'ready');
  assert.equal(hash(path.join(item.directory, 'archive', batch.artifacts[0].blob.relativePath)), item.staging[0].hash);
  assert.equal(hash(item.inputPath), item.inputHash);
  assert.equal(host.application.snapshot().phase, 'ready');
  // manifest 路径在 artifact release 时仍受 pending/outbox 保护；该原有路径
  // 不在 ACK 后立刻删输入，非过期暂存仍保留供 service 后续安全回收。
  for (const file of item.staging) assert.equal(hash(file.path), file.hash);
  return JSON.stringify(batch.artifacts);
}
async function check(name, task) { await task(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
async function main() {
  await check('真实提交和 pending、零 outbox：生产启动补原身份 intent，等待 durable 后 sweep，二次启动幂等', async () => {
    const item = material('pending-only');
    await seedCommittedWithoutOutbox(item);
    const barrier = { entered: deferred(), release: deferred() };
    const host = boot(item, { flushBarrier: barrier });
    let artifacts;
    let initializationSettled = false;
    const initializing = host.initialize();
    initializing.then(() => { initializationSettled = true; }, () => { initializationSettled = true; });
    try {
      await Promise.race([barrier.entered.promise, initializing.then(() => {
        assert.fail('生产启动在进入恢复 outbox 屏障前已完成');
      })]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(initializationSettled, false, 'Main 必须等待原恢复 promise 才能让 Controller 完成启动');
      assert.equal(host.counts.persistIntent, 1, '必须经生产 owner 恢复补建 intent');
      assert.equal(host.outbox.list().length, 1);
      assert.equal(host.counts.sweep, 0, '真实恢复 promise 未完成，generic sweep 不得先运行');
      assert.equal(host.owner.readPositionPendingOperation().operationToken, item.taskRunId);
      assert.equal(host.tracked.length, 1, '真实 Main 必须把恢复 promise 纳入退出等待');
      assertPreservedFiles(item);
      barrier.release.resolve();
      await initializing;
      artifacts = assertRecovered(host, item);
      assert.equal(host.counts.pendingClear, 1);
      assert.equal(host.counts.sweep, 1);
    } finally { barrier.release.resolve(); await initializing.catch(() => {}); await host.close(); }
    const again = boot(item);
    try {
      await again.initialize();
      assert.equal(assertRecovered(again, item), artifacts);
      assert.equal(again.counts.persistIntent, 0);
      assert.equal(again.counts.pendingClear, 0);
    } finally { await again.close(); }
  });
  await check('真实 side DB checkpoint token 不符：生产入口失败关闸、零 sweep 并保留 pending 与受管材料', async () => {
    const item = material('checkpoint-mismatch');
    await seedCommittedWithoutOutbox(item);
    const host = boot(item);
    try {
      const wrong = { ...item.baseCheckpoint, token: 'different-history-token' };
      host.database.setSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING, JSON.stringify(wrong));
      await assert.rejects(host.initialize(), (error) => {
        assert.equal(error.code, 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED');
        assert.ok(error.errors.some((cause) => cause.code === 'position-side-db-mismatch' && cause.blocksArchiveStartup === true));
        return true;
      });
      assert.equal(host.counts.sweep, 0);
      assert.equal(host.counts.persistIntent, 0);
      assert.equal(host.counts.pendingClear, 0);
      assert.equal(host.main.currentService(), null);
      assert.equal(host.application.snapshot().phase, 'failed');
      assert.equal(host.database.getSetting(POSITION_SIDE_DB_PENDING_SETTING), item.pendingRaw);
      assert.equal(host.outbox.list().length, 0);
      assertPreservedFiles(item);
      host.database.setSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING, JSON.stringify(item.baseCheckpoint));
    } finally { await host.close(); }
    const corrected = boot(item);
    try { await corrected.initialize(); assertRecovered(corrected, item); } finally { await corrected.close(); }
  });
  await check('原任务 durable 后 pending 清理失败：生产启动保留 outbox，下一次启动按原 owner 收口', async () => {
    const item = material('durable-pending');
    await seedCommittedWithoutOutbox(item);
    const failed = boot(item, { failPendingClear: true });
    try {
      await assert.rejects(failed.initialize(), (error) => ['ARCHIVE_STARTUP_OUTBOX_PENDING', 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED'].includes(error.code));
      assert.equal(failed.counts.sweep, 0);
      assert.equal(failed.outbox.list().length, 1);
      assert.equal(failed.service.repository.getTaskRun(item.taskRunId).status, 'succeeded');
      assert.equal(failed.owner.readPositionPendingOperation().archiveState, 'durable');
      assert.equal(hash(item.inputPath), item.inputHash);
    } finally { await failed.close(); }
    const recovered = boot(item);
    try { await recovered.initialize(); assertRecovered(recovered, item); } finally { await recovered.close(); }
  });
  process.stdout.write(`==== ${passed}/${passed} PASS ====\n`);
}
main().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
