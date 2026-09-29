'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { deserializeError } = require('./serialize-error');
const { fitsWithin } = require('./background-execution/resource-lease');

const WORKER_PATH = path.join(__dirname, 'vcc-financial-op-result-workbook-worker.js');
const RESULT_EXPORT_RESOURCES = Object.freeze({
  cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
  ioHeavySlots: 1, memoryBytes: 512 * 1024 * 1024
});

function exportError(code, message) { return Object.assign(new Error(message), { code }); }

async function acquireResultExportLease(governor, operationKey) {
  if (!governor || typeof governor.acquirePhaseLease !== 'function') {
    throw exportError('vcc-result-resource-unavailable', '结果导出的资源管理服务尚未就绪，请稍后重试');
  }
  const snapshot = governor.snapshot();
  if (snapshot.accepting && !fitsWithin(RESULT_EXPORT_RESOURCES, snapshot.budgets)) {
    throw exportError('vcc-result-resource-limit', '结果导出所需资源超过本次应用预算，请释放内存后重新启动应用');
  }
  try {
    return await governor.acquirePhaseLease({
      ownerKey: `vcc-result-export:${randomUUID()}`,
      actionKey: 'vccFinancialOp:export:result', operationKey,
      resources: RESULT_EXPORT_RESOURCES, lowMemoryBehavior: 'queue', timeoutMs: 5000
    });
  } catch (error) {
    if (error.code === 'ADMISSION_TIMEOUT') {
      throw exportError('vcc-result-resource-timeout', '结果导出等待后台资源超过 5 秒，请等待其他任务结束后重试');
    }
    throw error;
  }
}

async function runResultWorkbookWorker({ dbPath, runId, outputPaths, assetsDir,
  publicationStagingDirectory, expectedSnapshot, resourceLimits,
  workerFactory = (_filename, options) => new Worker(WORKER_PATH, options),
  acquireLease, operationKey }) {
  // 准入失败时不启动 Worker。业务互斥由 service 持有，不在此建立第二个任务。
  const lease = acquireLease ? await acquireLease(operationKey) : null;
  let ownedGenerationDirectory;
  try {
    if (publicationStagingDirectory) {
      ownedGenerationDirectory = fs.mkdtempSync(path.join(publicationStagingDirectory, 'worker-'));
    }
    const result = await new Promise((resolve, reject) => {
      const worker = workerFactory(WORKER_PATH, {
        workerData: { dbPath, runId, outputPaths, assetsDir,
          publicationStagingDirectory: ownedGenerationDirectory,
          expectedSnapshot, resourceLimits },
        resourceLimits: { maxOldGenerationSizeMb: 384 }
      });
      let result, resultCount = 0, failure;
      worker.on('message', (message) => {
        if (message?.type === 'error') failure ||= deserializeError(message.error);
        else if (message?.type === 'result') {
          resultCount += 1;
          result = message.result;
          if (resultCount !== 1 || !result || typeof result !== 'object') {
            failure ||= exportError('vcc-result-worker-protocol', '结果导出 Worker 返回了无效或重复结果');
          }
        } else failure ||= exportError('vcc-result-worker-protocol', '结果导出 Worker 返回了未知消息');
      });
      worker.once('error', (error) => { failure ||= error; });
      // 收到结果并不代表 SQLite、ZIP 和输出句柄已退出，必须等待真实 exit。
      worker.once('exit', (code) => {
        if (failure) reject(failure);
        else if (code !== 0 || resultCount !== 1) {
          reject(exportError('vcc-result-worker-failed', `结果导出 Worker 异常退出：${code}`));
        } else resolve(result);
      });
    });
    return { ...result, ...(ownedGenerationDirectory ? { ownedGenerationDirectory } : {}) };
  } catch (error) {
    // 从未调用 publisher，且已经等待 Worker exit；仅清理本 runner 创建的目录。
    if (ownedGenerationDirectory && !error.preserveTemporaryFiles) {
      try { fs.rmSync(ownedGenerationDirectory, { recursive: true, force: true }); } catch (_cleanupError) {
        error.detailLines = [...(error.detailLines || []), `导出临时目录待清理：${ownedGenerationDirectory}`];
      }
    }
    throw error;
  } finally {
    lease?.release('vcc-result-worker-exited');
  }
}

module.exports = { runResultWorkbookWorker, acquireResultExportLease, RESULT_EXPORT_RESOURCES };
