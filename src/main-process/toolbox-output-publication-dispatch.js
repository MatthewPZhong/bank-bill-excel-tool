'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { deserializeError } = require('./serialize-error');
const { JOURNAL_INDEX_NAME } = require('./toolbox-output-publication');

const DEFAULT_WORKER_ENTRY = require.resolve('./toolbox-output-publication-worker');

function createTransportError(message, cause = null) {
  const error = new Error(message);
  error.name = 'ToolboxPublicationWorkerError';
  error.code = 'TOOLBOX_PUBLICATION_WORKER_FAILED';
  error.isToolboxPublicationTransportError = true;
  if (cause) error.cause = cause;
  return error;
}

function createRecoveryFailure(userDataDir, workerError, recoveryError) {
  const error = new Error('工具箱发布进程异常退出，自动恢复也未能完成');
  error.name = 'ToolboxPublicationManualRecoveryError';
  error.code = 'TOOLBOX_PUBLICATION_WORKER_RECOVERY_FAILED';
  error.detailLines = [
    `发布进程错误：${workerError && workerError.message ? workerError.message : String(workerError)}`,
    `自动恢复错误：${recoveryError && recoveryError.message
      ? recoveryError.message
      : String(recoveryError)}`
  ];
  if (recoveryError && Array.isArray(recoveryError.detailLines)) {
    error.detailLines.push(...recoveryError.detailLines);
  }
  error.recoveryPaths = recoveryError && Array.isArray(recoveryError.recoveryPaths)
    ? recoveryError.recoveryPaths.slice()
    : [path.join(path.resolve(userDataDir), JOURNAL_INDEX_NAME)];
  error.preserveTemporaryFiles = true;
  error.cause = recoveryError || workerError;
  return error;
}

function runWorkerJob(workerScriptPath, op, payload, onProgress, onWorkerExit) {
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let resolveExitBarrier;
    const exitBarrier = new Promise((resolveExit) => {
      resolveExitBarrier = resolveExit;
    });
    const jobId = `toolbox-publication-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try { worker.postMessage({ type: 'close' }); } catch (_error) { /* ignore */ }
      try {
        const termination = worker.terminate();
        if (termination && typeof termination.catch === 'function') {
          // Promise 的结算统一由 exitBarrier 驱动；这里只防止 terminate rejection
          // 形成未处理拒绝。若 terminate 失败，close 或 worker 自身退出仍会释放屏障。
          termination.catch(() => undefined);
        }
      } catch (_error) { /* wait for close/exit barrier */ }
      // 发布/恢复队列必须覆盖完整 worker 生命周期。尤其 transport error 后，
      // 只有旧 worker 真正 exit，才允许同一队列项启动 recovery worker。
      exitBarrier.then(() => callback(value));
    };

    try {
      worker = new Worker(workerScriptPath);
    } catch (error) {
      reject(createTransportError('无法启动工具箱发布 worker', error));
      return;
    }

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object' || message.jobId !== jobId) return;
      if (message.type === 'progress') {
        if (typeof onProgress === 'function') {
          try { onProgress(message.payload || {}); } catch (_error) { /* ignore */ }
        }
        return;
      }
      if (message.type === 'done') {
        finish(resolve, message.result);
        return;
      }
      if (message.type === 'error') {
        finish(reject, deserializeError(message.error));
      }
    });
    worker.on('error', (error) => {
      finish(
        reject,
        createTransportError('工具箱发布 worker 运行异常', error)
      );
    });
    worker.on('exit', (code) => {
      if (typeof onWorkerExit === 'function') {
        try { onWorkerExit({ jobId, op, code }); } catch (_error) { /* ignore */ }
      }
      resolveExitBarrier(code);
      if (settled) return;
      settled = true;
      reject(createTransportError(`工具箱发布 worker 异常退出（code=${code}）`));
    });

    try {
      worker.postMessage({ type: 'run', jobId, op, payload });
    } catch (error) {
      finish(reject, createTransportError('无法向工具箱发布 worker 发送作业', error));
    }
  });
}

function createToolboxPublicationDispatcher(options = {}) {
  const workerScriptPath = options.workerScriptPath || DEFAULT_WORKER_ENTRY;
  const onWorkerExit = typeof options.onWorkerExit === 'function'
    ? options.onWorkerExit
    : null;
  let queueTail = Promise.resolve();

  async function execute(op, payload, onProgress) {
    try {
      return await runWorkerJob(workerScriptPath, op, payload, onProgress, onWorkerExit);
    } catch (error) {
      if (!error || error.isToolboxPublicationTransportError !== true) throw error;

      if (op === 'publish') {
        try {
          const recovery = await runWorkerJob(
            workerScriptPath,
            'recover',
            { userDataDir: payload.userDataDir },
            onProgress,
            onWorkerExit
          );
          error.detailLines = [
            ...(Array.isArray(error.detailLines) ? error.detailLines : []),
            '发布进程异常退出后已执行自动恢复；本次任务未报告成功。',
            ...((recovery && Array.isArray(recovery.recovered))
              ? recovery.recovered.map((item) => `${item.taskId}：${item.action}`)
              : [])
          ];
          throw error;
        } catch (recoveryError) {
          if (recoveryError === error) throw error;
          throw createRecoveryFailure(
            payload.userDataDir,
            error,
            recoveryError
          );
        }
      }

      throw createRecoveryFailure(payload.userDataDir, error, error);
    }
  }

  function enqueue(op, payload, onProgress) {
    const run = () => execute(op, payload, onProgress);
    const result = queueTail.then(run, run);
    queueTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return {
    publish(optionsForPublish = {}) {
      return enqueue(
        'publish',
        {
          taskId: optionsForPublish.taskId,
          artifacts: optionsForPublish.artifacts,
          targets: optionsForPublish.targets,
          userDataDir: optionsForPublish.userDataDir,
          requireValidatedArtifacts: optionsForPublish.requireValidatedArtifacts === true
        },
        optionsForPublish.onProgress
      );
    },
    recover(optionsForRecovery = {}) {
      return enqueue(
        'recover',
        { userDataDir: optionsForRecovery.userDataDir },
        optionsForRecovery.onProgress
      );
    }
  };
}

const defaultDispatcher = createToolboxPublicationDispatcher();

function publishToolboxPublicationAsync(options) {
  return defaultDispatcher.publish({
    ...(options || {}),
    requireValidatedArtifacts: true
  });
}

function recoverToolboxPublicationsAsync(options) {
  return defaultDispatcher.recover(options);
}

module.exports = {
  DEFAULT_WORKER_ENTRY,
  createToolboxPublicationDispatcher,
  publishToolboxPublicationAsync,
  recoverToolboxPublicationsAsync,
  runWorkerJob
};
