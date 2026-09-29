'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { recoveryError, seal } = require('./publication-recovery/worker-authority');
const { Worker } = require('node:worker_threads');
const { deserializeError } = require('./serialize-error');
const { JOURNAL_INDEX_NAME } = require('./toolbox-output-publication');
const { freezeWorkerBatchContext } = require('./archive-center/worker-batch-context');

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

function runWorkerJob(workerScriptPath, op, payload, onProgress, onWorkerExit, workerData) {
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
      worker = new Worker(workerScriptPath, { workerData });
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
  const onWorkerExit = typeof options.onWorkerExit === 'function' ? options.onWorkerExit : null;
  const workerKey = crypto.randomBytes(32).toString('hex');
  let queueTail = Promise.resolve();
  let authority = null;
  function requireAuthority(root) {
    if (!authority) throw recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', root, '共享发布 dispatcher 未绑定 owner authority');
    if (root && path.resolve(root) !== authority.root) {
      throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', authority.root, '发布不能选择其他恢复 root');
    }
    return authority;
  }
  function worker(op, payload, onProgress) {
    return runWorkerJob(workerScriptPath, op, payload, onProgress, onWorkerExit,
      { publicationRecoveryKey: workerKey });
  }
  function enqueue(run) {
    const result = queueTail.then(run, run);
    queueTail = result.then(() => undefined, () => undefined);
    return result;
  }
  // 仅在已经持有 FIFO 项及 observation lease 时调用；不得从这里再次 enqueue。
  async function recoverWithinQueue(request, authorizeSnapshot) {
    const snapshot = await worker('discover-recovery', { userDataDir: authority.root }, request.onProgress);
    const grants = await authorizeSnapshot(snapshot);
    const result = await worker('execute-recovery', { userDataDir: authority.root,
      authorization: seal(workerKey, 'recovery', grants) }, request.onProgress);
    return authority.complete(snapshot, result, request);
  }
  async function publishWithinQueue(payload, request) {
    const preflightRecovery = await recoverWithinQueue(request,
      (snapshot) => authority.authorizeSnapshot(snapshot, request));
    const pending = preflightRecovery.recovered.filter((item) =>
      ['commit-handoff-pending', 'commit-finalization-pending'].includes(item.action));
    if (pending.length || preflightRecovery.deferred.length) {
      const error = recoveryError('TOOLBOX_PUBLICATION_MANUAL_RECOVERY', authority.root,
        '已有输出等待存档中心耐久接管或 owner 放行，已阻止新的发布任务',
        preflightRecovery.deferred.flatMap((item) => item.recoveryPaths));
      error.deferred = preflightRecovery.deferred;
      error.skippedActive = preflightRecovery.skippedActive;
      error.detailLines = [...pending.map((item) => `待接管发布：${item.taskId}`),
        ...preflightRecovery.deferred.map((item) => `待恢复发布：${item.taskId}（${item.code}）`)];
      throw error;
    }
    payload.preflight = seal(workerKey, 'preflight', { root: authority.root, taskId: payload.taskId,
      indexDigest: preflightRecovery.resultingIndexDigest, nonce: crypto.randomUUID() });
    try {
      return await worker('publish', payload, request.onProgress);
    } catch (error) {
      if (!error || error.isToolboxPublicationTransportError !== true) throw error;
      // runWorkerJob 已跨过失败 worker 的真实 exit；复用当前租约和当前 FIFO。
      try {
        const recoveryRequest = authority.requestFor(null, { reason: 'transport-error', taskIds: [payload.taskId],
          observation: request.observation, onProgress: request.onProgress }, true);
        const recovery = await recoverWithinQueue(recoveryRequest,
          (snapshot) => authority.authorizeSnapshot(snapshot, recoveryRequest));
        const recoveredCommit = recovery.recovered.find((item) => item && item.taskId === payload.taskId
          && item.action === 'commit-handoff-pending' && item.batchContext
          && Array.isArray(item.files) && item.files.length > 0
          && JSON.stringify(freezeWorkerBatchContext(item.batchContext, { required: true }))
            === JSON.stringify(freezeWorkerBatchContext(payload.batchContext, { required: true })));
        if (recoveredCommit) {
          return { taskId: recoveredCommit.taskId, committed: true, recoveredAfterWorkerExit: true,
            pendingCleanup: true, pendingArchiveHandoff: true, batchContext: recoveredCommit.batchContext,
            inputFiles: recoveredCommit.inputFiles, files: recoveredCommit.files,
            warnings: ['发布进程在提交后异常退出；已从 durable journal 恢复正式输出并沿用原任务批次。',
              ...(Array.isArray(recoveredCommit.warnings) ? recoveredCommit.warnings : [])] };
        }
        error.detailLines = [...(error.detailLines || []), '发布进程异常退出后已执行授权恢复；本次任务未报告成功。',
          ...recovery.recovered.map((item) => `${item.taskId}：${item.action}`)];
        error.deferred = recovery.deferred;
        error.skippedActive = recovery.skippedActive;
        throw error;
      } catch (recoveryErrorValue) {
        if (recoveryErrorValue === error) throw error;
        throw createRecoveryFailure(authority.root, error, recoveryErrorValue);
      }
    }
  }
  return Object.freeze({
    bindRecoveryAuthority(value) {
      if (authority || !value || !value.root
          || ['requestFor', 'acquire', 'authorizeSnapshot', 'complete'].some((key) => typeof value[key] !== 'function')) {
        throw recoveryError('PUBLICATION_RECOVERY_OWNER_REGISTRATION_INVALID', value && value.root, 'dispatcher authority 必须只绑定一次');
      }
      authority = value;
    },
    runAuthorizedRecovery({ authority: callerAuthority, request, authorizeSnapshot } = {}) {
      requireAuthority(request && request.root);
      if (callerAuthority !== authority || typeof authorizeSnapshot !== 'function') {
        return Promise.reject(recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', authority.root, '恢复必须使用受限 owner facade'));
      }
      return enqueue(() => recoverWithinQueue(request, authorizeSnapshot));
    },
    async publish(optionsForPublish = {}) {
      requireAuthority(optionsForPublish.userDataDir);
      const request = authority.requestFor(null, { reason: 'publish-preflight', taskIds: [optionsForPublish.taskId],
        observation: optionsForPublish.observation, onProgress: optionsForPublish.onProgress }, true);
      const release = await authority.acquire(request);
      try {
        return await enqueue(() => publishWithinQueue({
          taskId: optionsForPublish.taskId, artifacts: optionsForPublish.artifacts, targets: optionsForPublish.targets,
          protectedSourcePaths: optionsForPublish.protectedSourcePaths, userDataDir: authority.root,
          batchContext: optionsForPublish.batchContext, archiveInputFiles: optionsForPublish.archiveInputFiles,
          requireArchiveHandoff: optionsForPublish.requireArchiveHandoff === true,
          allowEmptyArchiveInputs: optionsForPublish.allowEmptyArchiveInputs === true,
          requireValidatedArtifacts: optionsForPublish.requireValidatedArtifacts === true,
          requireTargetParentIdentity: optionsForPublish.requireTargetParentIdentity === true
        }, request));
      } finally { await release('publish-workers-exited'); }
    },
    recover(optionsForRecovery = {}) {
      return Promise.reject(recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', optionsForRecovery.userDataDir,
        'raw recover 已停用；请使用 owner recovery facade'));
    }
  });
}

const defaultDispatcher = createToolboxPublicationDispatcher();

function publishToolboxPublicationAsync(options) {
  return defaultDispatcher.publish({
    ...(options || {}),
    requireArchiveHandoff: true,
    requireValidatedArtifacts: true,
    allowEmptyArchiveInputs: options && options.allowEmptyArchiveInputs === true
  });
}

// 非工具箱 artifact 仍复用同一个进程级 durable FIFO Publisher，并沿用同一
// archive-handoff receipt/recovery authority；调用方只能在 Task artifact durable
// 且 Task 终态持久化后通过既有 recover acknowledgement 清理 receipt。
function publishDurableArtifactAsync(options) {
  return defaultDispatcher.publish({
    ...(options || {}),
    requireArchiveHandoff: true,
    requireValidatedArtifacts: true,
    allowEmptyArchiveInputs: options && options.allowEmptyArchiveInputs === true
  });
}

function createToolboxPublicationMatureBinding(options = {}) {
  const publish = options.publish || publishToolboxPublicationAsync;
  const recover = options.recover;
  return Object.freeze({
    dispatch(request = {}) {
      const input = request.input || {};
      if (input.lifecycleOperation === 'recover') {
        // Recovery 只进入既有 durable-journal recovery；这里没有 generation，
        // 也绝不把 recovery 解释为一次新的 publish。
        if (typeof recover !== 'function') {
          throw recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', null, 'mature recovery 缺少受控 owner facade');
        }
        const recoveryOptions = input.options || {};
        if (recoveryOptions.root || recoveryOptions.userDataDir || recoveryOptions.ownerId || recoveryOptions.observation) {
          throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', null, 'mature recovery request 不能指定 root、owner 或 capability');
        }
        return recover({ reason: recoveryOptions.reason || 'business-retry', taskIds: recoveryOptions.taskIds,
          acknowledgedCommittedTaskIds: recoveryOptions.acknowledgedCommittedTaskIds,
          deferCommittedFinalization: recoveryOptions.deferCommittedFinalization === true, onProgress: request.onProgress });
      }
      if (input.lifecycleOperation !== 'publish') {
        throw new TypeError('toolbox publication mature adapter requires publish or recover lifecycleOperation');
      }
      return publish({ ...(input.options || {}), onProgress: request.onProgress });
    }
  });
}

module.exports = {
  DEFAULT_WORKER_ENTRY,
  createToolboxPublicationDispatcher,
  getDefaultToolboxPublicationDispatcher: () => defaultDispatcher,
  createToolboxPublicationMatureBinding,
  publishDurableArtifactAsync,
  publishToolboxPublicationAsync,
  runWorkerJob
};
