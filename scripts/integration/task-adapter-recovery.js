'use strict';
// G2 任务适配器与 G1 恢复协调器组合验证。
// 覆盖：真实 Position owner/adapter、TaskLifecycle、SQLite task/manifest、文件 outbox；
// 终态后 domain hook 故障、业务提交后归档故障、owner 错配拒绝及两次关闭重开后的幂等。
// 业务侧使用隔离 SQLite 提交/checkpoint 夹具；不替代真实 Excel 引擎或 Electron 崩溃验收。
// 用法：node scripts/integration/task-adapter-recovery.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTerminalRouteRegistry } = require('../../src/main-process/archive-center/terminal-route-registry');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { createBusinessFlowResolver } = require('../../src/main-process/archive-center/business-flow-resolver');
const { createArchiveOperationTracker } = require('../../src/main-process/archive-center/operation-tracker');
const { createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');
const { createApplicationRecoveryCoordinator } = require('../../src/main-process/application-recovery/coordinator');
const { createPositionTaskOwner } = require('../../src/main-process/position-reconciliation/task-owner');
const { createPositionTaskAdapter } = require('../../src/main-process/position-reconciliation/task-adapter');
const { createTaskAdapterRegistry } = require('../../src/main-process/task-adapters/registry');
const { createPreparedResourceScope } = require('../../src/main-process/task-adapters/prepared-resources');
const { POSITION_SIDE_DB_PENDING_SETTING } = require('../../src/main-process/position-reconciliation/constants');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-adapter-recovery-'));
const policyRegistry = createTaskPolicyRegistry();
let passed = 0;

function fixture(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const inputPath = path.join(directory, 'input.csv');
  fs.writeFileSync(inputPath, 'fixture-input\n');
  return { directory, inputPath, outputPath: path.join(directory, 'output.csv'), taskRunId: `position-${name}` };
}

function boot(material, faults = {}) {
  const databasePath = path.join(material.directory, 'main.sqlite');
  const db = new DatabaseSync(databasePath);
  const sideDb = new DatabaseSync(path.join(material.directory, 'business.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS fixture_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sideDb.exec('CREATE TABLE IF NOT EXISTS business_commits (operation_token TEXT PRIMARY KEY, result TEXT NOT NULL)');
  const diagnostics = [];
  const events = [];
  let pendingClears = 0;
  let service;
  const settings = {
    getSetting(name) { return db.prepare('SELECT value FROM fixture_settings WHERE name = ?').get(name)?.value || ''; },
    setSetting(name, value) {
      if (name === POSITION_SIDE_DB_PENDING_SETTING && !value) {
        pendingClears += 1;
        if (faults.clearPending) {
          // 故障只发生在 durable terminal 写入之后，不模拟未提交的任务。
          assert.equal(service.repository.getTaskRun(material.taskRunId).status, 'succeeded');
          throw Object.assign(new Error('注入终态后的 domain pending 清理失败'), { code: 'FIXTURE_DOMAIN_HOOK_FAILED' });
        }
      }
      db.prepare('INSERT INTO fixture_settings(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
        .run(name, String(value));
    },
    listTemplates: () => []
  };
  const businessService = {
    persistenceCheckpoint() {
      return { identity: 'fixture-business-db', generation: sideDb.prepare('SELECT COUNT(*) AS count FROM business_commits').get().count };
    },
    listCommittedOperationInputs: () => []
  };
  service = createArchiveService({ database: db, rootDir: path.join(material.directory, 'archive') });
  let controller;
  let lifecycle;
  const owner = createPositionTaskOwner({
    readSetting: settings.getSetting, writeSetting: settings.setSetting, settingsAvailable: () => true,
    getDatabasePath: () => databasePath, getCurrentService: () => businessService,
    getService: () => businessService, getArchiveCenter: () => controller,
    initializeArchiveCenter: () => controller, getTaskLifecycle: () => lifecycle,
    getTaskPolicy: (channel) => policyRegistry.require(channel),
    supportsArchiveChannel: (channel) => policyRegistry.require(channel).taskKind === 'file'
  });
  const routes = createTerminalRouteRegistry([owner.terminalRegistration]);
  const outbox = createArchiveOutboxStore(path.join(material.directory, 'outbox'));
  const application = createApplicationRecoveryCoordinator({
    platform: {
      async scanAndRecover() { events.push('platform'); return { sourceCount: 0 }; },
      async recoverSource() { assert.fail('本夹具没有平台发布源'); }
    },
    participants: [{
      id: 'position-task-fixture', ownerName: 'Position task fixture',
      preflight: async () => { events.push('preflight'); businessService.persistenceCheckpoint(); },
      recoverOwner: async () => {
        events.push('owner');
        // 与 G1 相同，领域先准备侧库能力，再让 Controller 重放原 owner 的 outbox。
        assert.ok(businessService.persistenceCheckpoint());
      },
      postOutbox: async () => { events.push('post-outbox'); assert.equal(outbox.list().length, 0); }
    }]
  });
  controller = createArchiveCenterController({ service, database: settings, outboxStore: outbox,
    terminalRouteRegistry: routes, resolveOutboxTerminalIntent: owner.resolvePositionOutboxTerminalIntent,
    recoverInterruptedTaskOwners: application.archiveOwnerHooks(),
    postOutboxStartupHooks: application.postOutboxHooks(),
    logWarning: (...args) => diagnostics.push(args) });
  const bor = createBusinessOperationRegistry();
  lifecycle = createTaskLifecycle({ businessOperationRegistry: bor, archiveService: service,
    flowResolver: createBusinessFlowResolver({ archiveService: service }),
    operationTracker: createArchiveOperationTracker({ sink: controller.sink }),
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload),
    onArchiveWarning: (warning) => diagnostics.push(warning) });
  if (faults.artifactSettlement) {
    service.settleManifestArtifacts = async () => ({ ok: false, durable: false, message: '注入归档副本写入失败' });
  }
  if (faults.operationTerminal) {
    service.finishTaskRun = async () => ({ ok: false, code: 'FIXTURE_TERMINAL_WRITE_FAILED', message: '注入无文件任务终态写入失败' });
  }
  return { db, sideDb, service, controller, owner, lifecycle, application, outbox, settings, diagnostics, events, bor,
    pendingClears: () => pendingClears,
    async initialize() {
      await application.platformFacade.scanAndRecover();
      await application.preflight();
      try {
        const result = await controller.initialize();
        application.completeArchiveInitialization(result);
      } catch (error) {
        application.failArchiveInitialization(error);
        throw error;
      }
    },
    close() { sideDb.close(); db.close(); }
  };
}

async function executePosition(host, material, noFile = false) {
  const channel = noFile ? 'position-reconciliation:run' : 'position-reconciliation:bank:export';
  const policy = policyRegistry.require(channel);
  const prepared = { proceed: true, onAbandon() { assert.fail('已经执行业务，不得再次 abandon'); } };
  if (!noFile) {
    prepared.filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager',
      inputs: [{ filePath: material.inputPath, role: 'input', sourceOperation: channel }],
      outputs: [{ filePath: material.outputPath, role: 'output', sourceOperation: channel }] });
  }
  const registry = createTaskAdapterRegistry({
    adapters: [createPositionTaskAdapter({ owner: host.owner, createOperationToken: () => material.taskRunId,
      reportArchiveFailure: (warning) => host.diagnostics.push(warning) })],
    taskBindings: [{ taskKey: policy.taskKey, adapterId: 'position-reconciliation' }]
  });
  const invocation = registry.resolve(policy.taskKey).createInvocation({ meta: { channel }, policy, prepared, args: [] });
  const scope = createPreparedResourceScope(prepared);
  let context;
  const result = await scope.run(() => {
    scope.enterLifecycle();
    const payload = {
      meta: { channel }, policy, prepared, ...invocation.identity,
      ...(policy.startsNewFlow ? {} : { explicitParentRunId: `flow-${material.taskRunId}` }),
      afterTerminalIntent: invocation.afterTerminalIntent, afterTerminal: invocation.afterTerminal,
      filePlanResolver: () => prepared.filePlan,
      execute(ownerContext, controls) {
        context = ownerContext;
        return invocation.execute({ taskContext: createIpcTaskContext(ownerContext, controls), controls,
          markExecuteStarted: scope.markExecuteStarted,
          executeBusiness() {
            assert.equal(host.owner.currentOperationToken(), material.taskRunId);
            host.sideDb.prepare('INSERT INTO business_commits(operation_token, result) VALUES (?, ?)')
              .run(material.taskRunId, 'committed');
            if (!noFile) fs.writeFileSync(material.outputPath, 'fixture-output\n');
            return { status: 'ok', committed: true };
          }
        });
      }
    };
    return noFile ? host.lifecycle.runOperationOnly(payload) : host.lifecycle.runFileTask(payload);
  });
  assert.deepEqual(result, { status: 'ok', committed: true });
  assert.deepEqual(scope.snapshot(), { owner: 'execution', abandonAttempted: false });
  assert.equal(host.bor.listActive().length, 0);
  return context;
}

function assertBusinessCommitted(host, material) {
  const rows = host.sideDb.prepare('SELECT * FROM business_commits').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation_token, material.taskRunId);
  assert.equal(rows[0].result, 'committed');
  assert.equal(fs.readFileSync(material.inputPath, 'utf8'), 'fixture-input\n');
}

async function recoverTwice(material, context, noFile = false) {
  let archiveSnapshot;
  for (let restart = 0; restart < 2; restart += 1) {
    const host = boot(material);
    try {
      await host.initialize();
      assert.deepEqual(host.events, ['platform', 'preflight', 'owner', 'post-outbox']);
      assert.equal(host.application.snapshot().phase, 'ready');
      assert.equal(host.application.snapshot().platformScanCompleted, true);
      assert.equal(host.outbox.list().length, 0);
      assert.equal(host.owner.readPositionPendingOperation(), null);
      assert.equal(host.service.repository.getTaskRun(material.taskRunId).status, 'succeeded');
      assert.equal(host.db.prepare('SELECT COUNT(*) AS count FROM archive_task_runs').get().count, 1);
      assertBusinessCommitted(host, material);
      if (!noFile) {
        const batch = host.service.repository.getBatchDetail(context.batchId);
        assert.equal(batch.taskStatus, 'succeeded');
        assert.equal(batch.artifacts.length, 2);
        assert.ok(batch.artifacts.every((artifact) => artifact.status === 'ready'));
        for (const artifact of batch.artifacts) {
          const archivedBytes = fs.readFileSync(path.join(material.directory, 'archive', artifact.blob.relativePath));
          assert.equal(crypto.createHash('sha256').update(archivedBytes).digest('hex'), artifact.blob.sha256);
          assert.equal(archivedBytes.toString(), artifact.role === 'input' ? 'fixture-input\n' : 'fixture-output\n');
        }
        assert.equal(host.db.prepare('SELECT COUNT(*) AS count FROM archive_batches').get().count, 1);
        assert.equal(fs.readFileSync(material.outputPath, 'utf8'), 'fixture-output\n');
        const snapshot = JSON.stringify(batch.artifacts);
        if (archiveSnapshot) assert.equal(snapshot, archiveSnapshot);
        archiveSnapshot = snapshot;
      }
      assert.equal(host.pendingClears(), restart === 0 ? 1 : 0);
      assert.equal((await host.controller.flushOutbox()).flushed, 0);
    } finally { host.close(); }
  }
}

async function check(name, run) {
  await run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

async function main() {
  await check('文件任务终态已持久化后 domain hook 故障，G1 重启回放且二次重启幂等', async () => {
    const material = fixture('terminal-hook');
    const host = boot(material, { clearPending: true });
    let context;
    try {
      await host.initialize();
      context = await executePosition(host, material);
      assert.equal(host.service.repository.getTaskRun(material.taskRunId).status, 'succeeded');
      assert.equal(host.pendingClears(), 1);
      assert.equal(host.owner.readPositionPendingOperation().archiveState, 'durable');
      assert.equal(host.outbox.list().length, 1);
      assert.equal(host.outbox.list()[0].payload.terminalOutcome.afterTerminal.route, 'position-reconciliation');
      assertBusinessCommitted(host, material);
    } finally { host.close(); }
    await recoverTwice(material, context);
  });
  await check('业务已提交而 artifact 归档失败，保留 pending/outbox 并在重启完成原批次', async () => {
    const material = fixture('archive-incomplete');
    const host = boot(material, { artifactSettlement: true });
    let context;
    try {
      await host.initialize();
      context = await executePosition(host, material);
      const pending = host.owner.readPositionPendingOperation();
      assert.equal(pending.businessState, 'success');
      assert.equal(pending.archiveState, 'incomplete');
      assert.equal(host.outbox.list().length, 1);
      assert.notEqual(host.service.repository.getTaskRun(material.taskRunId).status, 'succeeded');
      assertBusinessCommitted(host, material);
      assert.equal(fs.readFileSync(material.outputPath, 'utf8'), 'fixture-output\n');
    } finally { host.close(); }
    await recoverTwice(material, context);
  });
  await check('pending owner 与持久 route 不匹配时禁止 ack，保留材料后恢复正确 owner 才能继续', async () => {
    const material = fixture('owner-mismatch');
    const initial = boot(material, { clearPending: true });
    let context;
    let originalPending;
    let outboxBefore;
    try {
      await initial.initialize();
      context = await executePosition(initial, material);
      originalPending = initial.owner.readPositionPendingOperation();
      initial.settings.setSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify({ ...originalPending,
        owner: { ...originalPending.owner, batchContext: { ...originalPending.owner.batchContext, operationKey: 'different-owner' } } }));
      outboxBefore = JSON.stringify(initial.outbox.list());
    } finally { initial.close(); }
    const restarted = boot(material);
    try {
      await assert.rejects(restarted.initialize(), { code: 'ARCHIVE_STARTUP_OUTBOX_PENDING' });
      assert.equal(restarted.application.snapshot().phase, 'failed');
      assert.equal(restarted.pendingClears(), 0);
      assert.equal(JSON.stringify(restarted.outbox.list()), outboxBefore);
      assert.ok(restarted.diagnostics.some((warning) => JSON.stringify(warning).includes('owner 与 pending 原任务不一致')));
      assertBusinessCommitted(restarted, material);
      // 仅夹具修复自己注入的错误值，模拟正确领域身份重新可用；生产不会覆盖 pending。
      restarted.settings.setSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(originalPending));
    } finally { restarted.close(); }
    await recoverTwice(material, context);
  });
  await check('无文件任务终态写入失败后持久 operation owner 重放，不创建文件批次或重执行业务', async () => {
    const material = fixture('operation-terminal');
    const host = boot(material, { operationTerminal: true });
    let context;
    try {
      await host.initialize();
      context = await executePosition(host, material, true);
      assert.equal(host.outbox.list().length, 1);
      assert.equal(host.outbox.list()[0].payload.owner.kind, 'operation');
      assert.equal(host.db.prepare('SELECT COUNT(*) AS count FROM archive_batches').get().count, 0);
      assertBusinessCommitted(host, material);
    } finally { host.close(); }
    await recoverTwice(material, context, true);
  });
  process.stdout.write(`==== ${passed}/${passed} PASS ====\n`);
}
main().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
