'use strict';

// 普通文件任务的跨进程恢复夹具；仅使用父进程指定的隔离目录和真实 SQLite。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const EXIT_CODES = { running: 82, 'after-terminal': 81, 'anonymous-after-terminal': 84, 'reserve-transaction': 83 };

function openRuntime(directory) {
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive') });
  const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
  const controller = createArchiveCenterController({
    database: { getSetting: () => null, setSetting() {} }, service, outboxStore
  });
  service.runDeleteWithOwnerGuard = (id, operation, options) => controller.runDeleteWithOwnerGuard(id, operation, options);
  return { db, service, controller, outboxStore };
}

async function runChild(directory, mode) {
  assert.ok(path.isAbsolute(directory));
  assert.ok(Object.hasOwn(EXIT_CODES, mode));
  const current = openRuntime(directory);
  await current.service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const inputPath = path.join(directory, 'template.csv');
  fs.writeFileSync(inputPath, 'date,amount\n2026-09-12,1\n');
  const policy = createTaskPolicyRegistry().require('template:import');
  // 执行 Main 实际 prepare 形成 FilePlan；只将用户文件对话框替换成隔离输入。
  const main = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
  const prepareMatch = main.match(/trackedIpcHandle\('template:import',[\s\S]*?async prepare\(\) \{([\s\S]*?)\n    \},\n    async execute/);
  assert.ok(prepareMatch, 'Main 应保留 template:import 的准备入口');
  const prepared = await vm.runInNewContext(`(async function () {${prepareMatch[1]}\n})()`, {
    showImportOpenDialog: async () => ({ canceled: false, filePaths: [inputPath] }),
    templateFileDialogFilters: () => []
  });
  assert.equal(prepared.proceed, true);
  prepared.filePlan = normalizeFilePlanV1(prepared.filePlan);
  const lifecycle = createTaskLifecycle({ archiveService: current.service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'ordinary-owner' }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: 'ordinary-parent', source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => current.controller.persistTaskTerminalIntent(payload) });
  if (mode === 'after-terminal') current.service.recordFileTaskOwnerCompletion = async () => process.exit(EXIT_CODES[mode]);
  if (mode === 'reserve-transaction') {
    const prepare = current.db.prepare.bind(current.db);
    current.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/INSERT[\s\S]*?INTO\s+archive_file_task_owner_recovery\b/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          const inserted = run(...args);
          assert.equal(Number(inserted.changes), 1);
          fs.writeFileSync(path.join(directory, 'transaction-observed.json'), JSON.stringify({
            batches: prepare('SELECT COUNT(*) n FROM archive_batches').get().n,
            artifacts: prepare('SELECT COUNT(*) n FROM archive_artifacts').get().n,
            responsibilities: prepare('SELECT COUNT(*) n FROM archive_file_task_owner_recovery').get().n
          }));
          process.exit(EXIT_CODES[mode]);
        };
      }
      return statement;
    };
  }
  const result = await lifecycle.runFileTask({ policy, taskRunId: 'ordinary-task', operationKey: 'ordinary-operation',
    meta: { channel: policy.channel },
    filePlanResolver: () => policy.filePlanResolver({ channel: policy.channel, prepared, args: [] }),
    execute: async (batchContext) => {
      fs.writeFileSync(path.join(directory, 'execute-count.txt'), '1');
      fs.writeFileSync(path.join(directory, 'owner-observed.json'), JSON.stringify({
        owner: { version: 1, kind: 'file-batch', batchContext },
        artifactIds: current.service.repository.listArtifacts(batchContext.batchId).map((item) => item.id)
      }));
      if (['running', 'anonymous-after-terminal'].includes(mode)) process.exit(EXIT_CODES[mode]);
      return { status: 'success' };
    },
    ...(mode === 'anonymous-after-terminal' ? {
      afterTerminal: async () => fs.writeFileSync(path.join(directory, 'after-terminal-ran.txt'), 'unexpected')
    } : {})
  });
  process.stderr.write(`退出故障点未命中：${JSON.stringify(result)}\n`);
  process.exit(99); // 任何真实退出点未命中都必须让父进程断言失败。
}

async function verifyOrdinaryOwnerRecovery(parentDirectory, mode) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'owner-recovery-'));
  let current;
  try {
    const child = spawnSync(process.execPath, [__filename, '--child', directory, mode], {
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, EXIT_CODES[mode], child.stderr || child.stdout);
    current = openRuntime(directory);
    if (mode === 'reserve-transaction') {
      const observed = JSON.parse(fs.readFileSync(path.join(directory, 'transaction-observed.json'), 'utf8'));
      assert.equal(observed.batches, 1);
      assert.equal(observed.artifacts, 1);
      assert.equal(observed.responsibilities, 1);
      assert.equal(fs.existsSync(path.join(directory, 'execute-count.txt')), false);
      assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_batches').get().n, 0);
      assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_artifacts').get().n, 0);
      assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_file_task_owner_recovery').get().n, 0);
      assert.equal((await current.controller.initialize()).ok, true);
      assert.equal(current.service.repository.listBatches({}).length, 0);
      assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_task_runs').get().n, 1);
      return { mode, childExit: child.status, transactionRolledBack: true, businessExecuted: false };
    }
    const observation = JSON.parse(fs.readFileSync(path.join(directory, 'owner-observed.json'), 'utf8'));
    const { owner, artifactIds } = observation;
    const before = current.service.repository.getBatch(owner.batchContext.batchId);
    assert.ok(before);
    assert.equal(current.service.repository.getOwnerTerminalCompletion(owner), null);
    assert.equal((await current.controller.initialize()).ok, true);
    const batch = current.service.repository.getBatch(owner.batchContext.batchId);
    const task = current.service.repository.getTaskRun(owner.batchContext.taskRunId);
    for (const field of ['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey']) {
      assert.equal(batch[field], owner.batchContext[field], field);
      assert.equal(task[field], owner.batchContext[field], field);
    }
    assert.equal(batch.batchNumber, owner.batchContext.batchNumber);
    assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_task_runs').get().n, 1);
    assert.deepEqual(current.service.repository.listArtifacts(batch.id).map((item) => item.id), artifactIds);
    assert.equal(task.status, mode === 'after-terminal' ? 'succeeded' : 'interrupted');
    assert.equal(fs.readFileSync(path.join(directory, 'execute-count.txt'), 'utf8'), '1');
    assert.equal(current.outboxStore.list().length, 0);
    const completion = current.service.repository.getOwnerTerminalCompletion(owner);
    const prepared = await current.controller.prepareDeleteBatch(batch.id);
    if (mode === 'anonymous-after-terminal') {
      assert.equal(completion, null);
      assert.notEqual(prepared.ok, true, JSON.stringify(prepared));
      assert.equal(prepared.status, 'failed');
      assert.equal(prepared.code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
      assert.equal(fs.existsSync(path.join(directory, 'after-terminal-ran.txt')), false);
      return { mode, childExit: child.status, taskStatus: task.status, deletionBlocked: true };
    }
    assert.ok(completion, '新任务原 owner 的持久责任应恢复为终态完成凭证');
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_file_task_owner_recovery').get().n, 0);
    await current.service.pauseBackgroundMaterialization();
    current.db.close();
    current = openRuntime(directory);
    assert.equal((await current.controller.initialize()).ok, true);
    assert.deepEqual(current.service.repository.getOwnerTerminalCompletion(owner), completion);
    assert.deepEqual(current.service.repository.getTaskRun(task.taskRunId), task);
    assert.deepEqual(current.service.repository.listArtifacts(batch.id).map((item) => item.id), artifactIds);
    assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_task_runs').get().n, 1);
    assert.equal(current.db.prepare('SELECT COUNT(*) n FROM archive_file_task_owner_recovery').get().n, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'execute-count.txt'), 'utf8'), '1');
    if (mode === 'after-terminal') {
      const confirmation = await current.controller.prepareDeleteBatch(batch.id);
      assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
      const deleted = await current.controller.deleteBatch(batch.id, confirmation.confirmationToken);
      assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    } else {
      await current.service.setLocked(batch.id, false);
      const retained = await current.service.cleanupExpired({ asOfLocalDate: '2099-01-01' });
      assert.equal(retained.ok, true, JSON.stringify(retained));
    }
    assert.equal(current.service.repository.getBatch(batch.id), null);
    assert.ok(current.service.repository.getDeletionReceipt(batch.id));
    assert.equal(current.service.repository.listCleanupJobs().length, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'template.csv'), 'utf8'), 'date,amount\n2026-09-12,1\n');
    return { mode, childExit: child.status, taskStatus: task.status, sameOwner: true,
      secondRestartStable: true, deletionRoute: mode === 'after-terminal' ? 'controller-confirmation' : 'retention' };
  } finally {
    if (current) { await current.service.pauseBackgroundMaterialization(); current.db.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyOrdinaryOwnerRecovery };
if (require.main === module) runChild(process.argv[3], process.argv[4]).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
});
