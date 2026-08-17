'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { deserializeError } = require('./serialize-error');

const {
  VccStorageMigrationError,
  atomicSwitchVccStorage,
  createMigrationJournal,
  inspectVccStorage,
  recoverVccStorageMigration,
  updateJournal
} = require('./vcc-financial-op-storage-rebuild');

const DEFAULT_WORKER_PATH = path.join(__dirname, 'vcc-financial-op-storage-migration-worker.js');

function restoreWorkerError(payload) {
  const error = deserializeError(payload);
  if (!error.message || error.message === 'unknown worker error') {
    error.message = 'VCC 存储迁移 worker 失败';
  }
  if (!error.code) error.code = 'vcc-storage-migration-worker-failed';
  return error;
}

function runMigrationWorker(options) {
  const worker = options.workerFactory
    ? options.workerFactory(options.workerPath || DEFAULT_WORKER_PATH)
    : new Worker(options.workerPath || DEFAULT_WORKER_PATH);
  return new Promise((resolve, reject) => {
    let settled = false;
    let readyHandled = false;
    let readyAcknowledged = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.on('message', (message = {}) => {
      if (message.type === 'progress') {
        if (typeof options.onProgress === 'function') options.onProgress(message.progress || {});
        return;
      }
      if (message.type === 'ready') {
        if (readyHandled) {
          settle(reject, Object.assign(
            new Error('VCC 存储迁移 worker 重复发送 ready'),
            { code: 'vcc-storage-migration-worker-protocol' }
          ));
          return;
        }
        readyHandled = true;
        Promise.resolve().then(async () => {
          if (typeof options.onReady === 'function') await options.onReady(message.result || {});
          readyAcknowledged = true;
          worker.postMessage({ action: 'release', decision: 'commit' });
        }).catch((error) => {
          try { worker.postMessage({ action: 'release', decision: 'abort' }); } catch (_postError) {}
          settle(reject, error);
        });
        return;
      }
      if (message.type === 'complete') {
        const result = message.result || {};
        if (result.noChange !== true && !readyAcknowledged) {
          settle(reject, Object.assign(
            new Error('VCC 存储迁移 worker 未完成 ready/ack 即返回候选库'),
            { code: 'vcc-storage-migration-worker-protocol' }
          ));
          return;
        }
        settle(resolve, result);
      }
      if (message.type === 'error') settle(reject, restoreWorkerError(message.error));
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => {
      if (!settled) {
        settle(reject, Object.assign(
          new Error(`VCC 存储迁移 worker 提前退出（code=${code}）`),
          { code: 'vcc-storage-migration-worker-exit' }
        ));
      }
    });
    worker.postMessage({
      action: 'build',
      sourcePath: options.sourcePath,
      targetPath: options.targetPath
    });
  }).finally(() => {
    if (typeof worker.terminate === 'function') worker.terminate().catch(() => undefined);
  });
}

function publicFailure(error) {
  return {
    status: 'error',
    code: error && error.code ? String(error.code) : 'vcc-storage-migration-failed',
    message: error && error.message ? String(error.message) : String(error)
  };
}

function createVccStorageMigrationCoordinator(options = {}) {
  const sourcePath = path.resolve(String(options.sourcePath || ''));
  const journalPath = path.resolve(String(options.journalPath || ''));
  if (!sourcePath || !journalPath) throw new TypeError('VCC 存储迁移 coordinator 缺少路径');
  if (!options.businessOperationRegistry
      || typeof options.businessOperationRegistry.beginShutdownTransition !== 'function'
      || typeof options.businessOperationRegistry.releaseTransition !== 'function') {
    throw new TypeError('VCC 存储迁移 coordinator 缺少业务任务注册表');
  }
  let activePromise = null;

  const emit = (progress) => {
    if (typeof options.onProgress === 'function') {
      try { options.onProgress({ ...progress }); } catch (_error) {}
    }
  };

  function inspect() {
    if (activePromise) {
      return { status: 'busy', code: 'vcc-storage-migration-active', message: 'VCC 存储正在迁移' };
    }
    return inspectVccStorage(sourcePath);
  }

  async function run(payload = {}) {
    if (activePromise) {
      return { status: 'busy', code: 'vcc-storage-migration-active', message: 'VCC 存储正在迁移' };
    }
    activePromise = (async () => {
      const registry = options.businessOperationRegistry;
      const transition = registry.beginShutdownTransition('vcc-storage-migration');
      if (!transition || transition.acquired !== true) {
        return {
          status: 'busy',
          code: 'business-transition-active',
          message: '应用正在执行升级、退出或其他维护任务，请稍后重试'
        };
      }
      const transitionToken = transition.token;
      const now = Date.now();
      const targetPath = `${sourcePath}.vcc-storage-next-${now}`;
      const backupPath = `${sourcePath}.vcc-storage-v1-${now}.bak`;
      let journal = createMigrationJournal({
        sourcePath,
        targetPath,
        backupPath,
        deleteOldDatabase: payload.deleteOldDatabase === true,
        migrationId: `vcc-storage-${now}`
      });
      let archiveMaintenance = false;
      let localResume = null;
      let databaseClosed = false;
      try {
        updateJournal(journalPath, journal, 'prepared');
        emit({ phase: 'waiting', processed: 0, total: 1, detail: '正在等待活动任务结束' });
        await registry.waitForIdle();
        if (options.archiveStorageRootManager
            && typeof options.archiveStorageRootManager.beginDatabaseMaintenance === 'function') {
          const maintenance = await options.archiveStorageRootManager.beginDatabaseMaintenance(
            '正在优化 VCC 数据库存储，请稍后重试'
          );
          if (!maintenance || maintenance.acquired !== true) {
            throw new VccStorageMigrationError(
              'vcc-storage-archive-maintenance-busy',
              '存档中心正在执行其他维护任务，请稍后重试'
            );
          }
          archiveMaintenance = true;
        }
        if (typeof options.pauseLocalMaintenance === 'function') {
          localResume = await options.pauseLocalMaintenance();
        }
        if (typeof options.terminateVccService === 'function') await options.terminateVccService();
        const result = await runMigrationWorker({
          sourcePath,
          targetPath,
          workerPath: options.workerPath,
          workerFactory: options.workerFactory,
          onProgress: (progress) => {
            const phase = ['copying', 'verifying'].includes(progress.phase)
              ? progress.phase
              : journal.phase;
            if (phase !== journal.phase) {
              journal = updateJournal(journalPath, journal, phase, {
                progress: {
                  processed: progress.processed || 0,
                  total: progress.total || 0,
                  detail: progress.detail || ''
                }
              });
            }
            emit(progress);
          },
          onReady: async (candidate) => {
            journal = updateJournal(journalPath, journal, 'verifying', {
              candidate: {
                sourceBytes: candidate.sourceBytes,
                targetBytes: candidate.targetBytes,
                oldCoreBytes: candidate.oldCoreBytes,
                newCoreBytes: candidate.newCoreBytes,
                reductionRatio: candidate.reductionRatio,
                effectiveCount: candidate.effectiveCount,
                migratedAnomalies: candidate.migratedAnomalies
              }
            });
            emit({ phase: 'switching', processed: 0, total: 1, detail: '正在关闭数据库连接' });
            if (typeof options.closeDatabase !== 'function') {
              throw new TypeError('VCC 存储迁移缺少 closeDatabase callback');
            }
            await options.closeDatabase();
            databaseClosed = true;
          }
        });
        if (result && result.noChange) {
          updateJournal(journalPath, journal, 'done');
          if (typeof options.removeJournal === 'function') options.removeJournal(journalPath);
          else fs.rmSync(journalPath, { force: true });
          return { status: 'success', noChange: true, contractVersion: result.contractVersion };
        }
        emit({ phase: 'switching', processed: 0, total: 1, detail: '正在原子切换数据库' });
        const switchStorage = typeof options.atomicSwitch === 'function'
          ? options.atomicSwitch
          : atomicSwitchVccStorage;
        const switched = switchStorage({ journalPath, journal });
        emit({ phase: 'restarting', processed: 1, total: 1, detail: '迁移完成，正在重启应用' });
        if (typeof options.relaunch === 'function') {
          await options.relaunch({ switched, candidate: result });
        }
        return {
          status: 'success',
          restarting: true,
          oldDatabaseDeleted: switched.oldDatabaseDeleted,
          sourceBytes: result.sourceBytes,
          targetBytes: result.targetBytes,
          oldCoreBytes: result.oldCoreBytes,
          newCoreBytes: result.newCoreBytes,
          reductionRatio: result.reductionRatio
        };
      } catch (error) {
        emit({ phase: 'failed', processed: 0, total: 0, detail: error.message || String(error) });
        if (!databaseClosed) {
          try { recoverVccStorageMigration({ journalPath }); } catch (_recoveryError) {
            // 失败证据无法安全收口时保留 journal，交给下次启动 fail-closed 恢复。
          }
        }
        if (databaseClosed && typeof options.relaunch === 'function') {
          await options.relaunch({ failed: true, error: publicFailure(error) });
        }
        return publicFailure(error);
      } finally {
        if (!databaseClosed) {
          if (typeof localResume === 'function') {
            try { await localResume(); } catch (_error) {}
          }
          if (archiveMaintenance
              && options.archiveStorageRootManager
              && typeof options.archiveStorageRootManager.endDatabaseMaintenance === 'function') {
            try { await options.archiveStorageRootManager.endDatabaseMaintenance(); } catch (_error) {}
          }
          registry.releaseTransition(transitionToken);
        }
      }
    })().finally(() => {
      activePromise = null;
    });
    return activePromise;
  }

  return {
    inspect,
    isActive: () => Boolean(activePromise),
    run
  };
}

module.exports = {
  DEFAULT_WORKER_PATH,
  createVccStorageMigrationCoordinator,
  publicFailure,
  restoreWorkerError,
  runMigrationWorker
};
