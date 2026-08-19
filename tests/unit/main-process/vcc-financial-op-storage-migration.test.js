'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBusinessOperationRegistry
} = require('../../../src/main-process/business-operation-registry');
const {
  createVccStorageMigrationCoordinator,
  restoreWorkerError,
  runMigrationWorker
} = require('../../../src/main-process/vcc-financial-op-storage-migration');

const MAIN_SOURCE = fs.readFileSync(path.join(
  __dirname,
  '../../../src/main.js'
), 'utf8');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-storage-coordinator-'));
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const journalPath = path.join(directory, 'run-data', 'migration.json');
  fs.writeFileSync(sourcePath, 'source-placeholder');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, sourcePath, journalPath };
}

function workerFactoryFor(outcome, calls) {
  return () => {
    calls.push('worker-created');
    const worker = new EventEmitter();
    worker.postMessage = (message) => {
      if (Array.isArray(outcome.messages)) outcome.messages.push({ ...message });
      calls.push(`worker-post:${message.action}`);
      if (message.action === 'release') {
        if (outcome.exitOnRelease === true) {
          queueMicrotask(() => worker.emit('exit', 1));
          return;
        }
        queueMicrotask(() => worker.emit('message', {
          type: 'complete',
          result: outcome.result
        }));
        return;
      }
      queueMicrotask(() => {
        if (outcome.type === 'error') worker.emit('message', {
          type: 'error',
          error: { code: outcome.code, message: outcome.message }
        });
        else if (outcome.ready === true) worker.emit('message', {
          type: 'ready',
          result: outcome.result
        });
        else worker.emit('message', { type: 'complete', result: outcome.result });
      });
    };
    worker.terminate = () => {
      calls.push('worker-terminate');
      return Promise.resolve(0);
    };
    return worker;
  };
}

function maintenanceHarness(calls) {
  return {
    async beginDatabaseMaintenance() {
      calls.push('archive-maintenance-begin');
      return { acquired: true, rootDir: '/archive-root' };
    },
    async endDatabaseMaintenance() {
      calls.push('archive-maintenance-end');
      return { released: true };
    }
  };
}

test('迁移 worker 复用共享错误协议并保留 cause、context 与 detailLines', () => {
  const error = restoreWorkerError({
    name: 'FileValidationError',
    code: 'vcc-storage-verification-failed',
    message: '候选库守恒失败',
    stack: 'worker-stack',
    detailLines: ['effective hash mismatch'],
    context: { targetPath: 'candidate.sqlite', stage: 'verifying' },
    cause: {
      name: 'Error',
      code: 'SQLITE_IOERR',
      message: 'read failed',
      stack: 'cause-stack'
    }
  });
  assert.equal(error.name, 'FileValidationError');
  assert.equal(error.code, 'vcc-storage-verification-failed');
  assert.equal(error.stack, 'worker-stack');
  assert.deepEqual(error.detailLines, ['effective hash mismatch']);
  assert.deepEqual(error.context, { targetPath: 'candidate.sqlite', stage: 'verifying' });
  assert.equal(error.cause.code, 'SQLITE_IOERR');
  assert.equal(error.cause.stack, 'cause-stack');
});

test('worker 未经 ready/ack 直接返回候选库时 fail-closed', async () => {
  const calls = [];
  await assert.rejects(() => runMigrationWorker({
    sourcePath: '/tmp/source.sqlite',
    targetPath: '/tmp/target.sqlite',
    workerFactory: workerFactoryFor({
      type: 'complete',
      result: { noChange: false, sourceBytes: 100, targetBytes: 25 }
    }, calls)
  }), (error) => error.code === 'vcc-storage-migration-worker-protocol');
  assert.equal(calls.includes('worker-terminate'), true);
});

test('维护迁移先阻止新任务并等待活动任务，再暂停存档与本地维护', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const active = registry.begin({ channel: 'vccFinancialOp:run:calculate' });
  const calls = [];
  const messages = [];
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    archiveStorageRootManager: maintenanceHarness(calls),
    workerFactory: workerFactoryFor({
      type: 'complete',
      result: { noChange: true, contractVersion: 2 },
      messages
    }, calls),
    async pauseLocalMaintenance() {
      calls.push('local-maintenance-pause');
      return async () => calls.push('local-maintenance-resume');
    },
    async terminateVccService() {
      calls.push('vcc-terminate');
    }
  });

  const running = coordinator.run();
  await Promise.resolve();
  assert.equal(registry.begin({ channel: 'toolbox:merge' }).accepted, false);
  assert.equal(calls.includes('worker-created'), false);
  registry.end(active.token);
  const result = await running;
  assert.deepEqual(result, { status: 'success', noChange: true, contractVersion: 2 });
  assert.deepEqual(calls, [
    'archive-maintenance-begin',
    'local-maintenance-pause',
    'vcc-terminate',
    'worker-created',
    'worker-post:build',
    'worker-terminate',
    'local-maintenance-resume',
    'archive-maintenance-end'
  ]);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(messages[0].archiveRootDir, '/archive-root');
  assert.equal(registry.begin({ channel: 'toolbox:merge' }).accepted, true);
});

test('候选构建失败保持数据库连接与旧文件，释放维护并保留明确错误', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const calls = [];
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    archiveStorageRootManager: maintenanceHarness(calls),
    workerFactory: workerFactoryFor({
      type: 'error',
      code: 'vcc-storage-space-insufficient',
      message: '磁盘剩余空间不足，旧数据库保持不变'
    }, calls),
    async pauseLocalMaintenance() {
      calls.push('local-maintenance-pause');
      return async () => calls.push('local-maintenance-resume');
    },
    async terminateVccService() {
      calls.push('vcc-terminate');
    },
    async closeDatabase() {
      calls.push('database-close');
    }
  });

  const result = await coordinator.run();
  assert.deepEqual(result, {
    status: 'error',
    code: 'vcc-storage-space-insufficient',
    message: '磁盘剩余空间不足，旧数据库保持不变'
  });
  assert.equal(calls.includes('database-close'), false);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'source-placeholder');
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(registry.isInstallTransitionActive(), false);
  assert.equal(calls.at(-2), 'local-maintenance-resume');
  assert.equal(calls.at(-1), 'archive-maintenance-end');
});

test('候选 ready 后先关闭主库并保持 mutation 门禁，再 ack worker 释放源锁', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const calls = [];
  const candidate = {
    noChange: false,
    sourceBytes: 100,
    targetBytes: 25,
    oldCoreBytes: 80,
    newCoreBytes: 20,
    reductionRatio: 0.75,
    effectiveCount: 3,
    migratedAnomalies: 1
  };
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    archiveStorageRootManager: maintenanceHarness(calls),
    workerFactory: workerFactoryFor({ type: 'complete', ready: true, result: candidate }, calls),
    async pauseLocalMaintenance() {
      calls.push('local-maintenance-pause');
      return async () => calls.push('local-maintenance-resume');
    },
    async terminateVccService() {
      calls.push('vcc-terminate');
    },
    async closeDatabase() {
      calls.push('database-close');
      assert.equal(registry.begin({ channel: 'vccFinancialOp:import:apply' }).accepted, false);
    },
    atomicSwitch() {
      calls.push('atomic-switch');
      return { oldDatabaseDeleted: false };
    },
    async relaunch() {
      calls.push('relaunch');
    }
  });

  const result = await coordinator.run();
  assert.equal(result.status, 'success');
  assert.ok(calls.indexOf('database-close') < calls.indexOf('worker-post:release'));
  assert.ok(calls.indexOf('worker-post:release') < calls.indexOf('atomic-switch'));
  assert.equal(registry.begin({ channel: 'file:import' }).accepted, false);
});

test('updater lease 阻止 migration，migration 不得释放 updater 门禁', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const updater = registry.beginInstallTransition('app-updater');
  const calls = [];
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    workerFactory: workerFactoryFor({
      type: 'complete',
      result: { noChange: true, contractVersion: 2 }
    }, calls)
  });

  const result = await coordinator.run();
  assert.equal(result.status, 'busy');
  assert.equal(result.code, 'business-transition-active');
  assert.equal(calls.includes('worker-created'), false);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(registry.isInstallTransitionActive(), true);
  assert.equal(registry.releaseTransition(updater.token), true);
});

test('ready 后关闭主库失败会 abort worker、恢复旧库并释放 migration lease', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const calls = [];
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    archiveStorageRootManager: maintenanceHarness(calls),
    workerFactory: workerFactoryFor({
      type: 'complete',
      ready: true,
      result: { noChange: false, sourceBytes: 100, targetBytes: 25 }
    }, calls),
    async pauseLocalMaintenance() {
      calls.push('local-maintenance-pause');
      return async () => calls.push('local-maintenance-resume');
    },
    async closeDatabase() {
      calls.push('database-close-failed');
      throw Object.assign(new Error('close failed'), { code: 'database-close-failed' });
    }
  });

  const result = await coordinator.run();
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'database-close-failed');
  assert.equal(calls.includes('worker-post:release'), true);
  assert.equal(calls.includes('worker-terminate'), true);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'source-placeholder');
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(registry.isInstallTransitionActive(), false);
  assert.equal(calls.at(-2), 'local-maintenance-resume');
  assert.equal(calls.at(-1), 'archive-maintenance-end');
});

test('worker 在 ack 后崩溃时不进入原子切换，旧库保持并请求重启恢复', async (t) => {
  const { sourcePath, journalPath } = fixture(t);
  const registry = createBusinessOperationRegistry();
  const calls = [];
  const coordinator = createVccStorageMigrationCoordinator({
    sourcePath,
    journalPath,
    businessOperationRegistry: registry,
    workerFactory: workerFactoryFor({
      type: 'complete',
      ready: true,
      exitOnRelease: true,
      result: { noChange: false, sourceBytes: 100, targetBytes: 25 }
    }, calls),
    async closeDatabase() {
      calls.push('database-close');
    },
    atomicSwitch() {
      calls.push('atomic-switch');
      throw new Error('不应进入切换');
    },
    async relaunch(payload) {
      calls.push(`relaunch:${payload.failed === true ? 'failed' : 'success'}`);
    }
  });

  const result = await coordinator.run();
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'vcc-storage-migration-worker-exit');
  assert.equal(calls.includes('atomic-switch'), false);
  assert.equal(calls.includes('relaunch:failed'), true);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'source-placeholder');
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(registry.isInstallTransitionActive(), true);
});

test('普通 VCC 存储迁移入口移除但启动 journal recovery 保留，partial 导入和存档重放先建业务锁', () => {
  assert.doesNotMatch(MAIN_SOURCE, /vccFinancialOp:storage:(?:inspect|migrate)/);
  assert.doesNotMatch(MAIN_SOURCE, /createVccStorageMigrationCoordinator/);
  const recoveryIndex = MAIN_SOURCE.indexOf('recoverVccStorageMigration({');
  const databaseOpenIndex = MAIN_SOURCE.indexOf('database = new AppDatabase(dataPath)', recoveryIndex);
  assert.ok(recoveryIndex >= 0 && databaseOpenIndex > recoveryIndex,
    '遗留/一次性 journal 必须在主数据库连接打开前恢复');

  const importStart = MAIN_SOURCE.indexOf(
    "trackedIpcHandle('vccFinancialOp:import:apply'"
  );
  const importEnd = MAIN_SOURCE.indexOf(
    "ipcMain.handle('vccFinancialOp:task:cancel'",
    importStart
  );
  const importHandler = MAIN_SOURCE.slice(importStart, importEnd);
  const catchSettle = importHandler.lastIndexOf('await taskContext.settleArtifacts');
  const catchSync = importHandler.lastIndexOf('service.syncImportArchiveLineage()');
  assert.ok(catchSettle > 0 && catchSync > catchSettle,
    'partial import 必须先落存档附件，再建立 VCC source/hold');

  const retryStart = MAIN_SOURCE.indexOf("'archive-center:retry-batch'");
  const retryEnd = MAIN_SOURCE.indexOf("ipcMain.handle('archive-center:get-settings'", retryStart);
  const retryHandler = MAIN_SOURCE.slice(retryStart, retryEnd);
  assert.match(retryHandler, /getVccFinancialOpService\(\)\.syncImportArchiveLineage\(\)/);
  assert.doesNotMatch(retryHandler, /&&\s*vccFinancialOpService/);

  const startupStart = MAIN_SOURCE.indexOf('async function runBackgroundInitChain()');
  const startupEnd = MAIN_SOURCE.indexOf('\nfunction runStartupPostSetup', startupStart);
  const startup = MAIN_SOURCE.slice(startupStart, startupEnd);
  assert.ok(
    startup.indexOf('getVccFinancialOpService().syncImportArchiveLineage()')
      < startup.indexOf('STARTUP_METRIC_MARKS.databaseReady'),
    '启动重放得到的 ready artifact 必须在放行业务前绑定 hold'
  );
});
