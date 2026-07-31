'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork: forkChild } = require('node:child_process');

const {
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_ENGINES,
  POSITION_IMPORT_MESSAGE_TYPES,
  POSITION_IMPORT_PROGRESS_HEARTBEAT_MS,
  POSITION_IMPORT_PROTOCOL_VERSION,
  normalizePositionImportEngine
} = require('../../backend/position-reconciliation-import/constants');
const {
  recoverPositionImportWorkerExit
} = require('./import-recovery');
const {
  STAGING_RELATIVE_PATH,
  filterStagingPathsWithoutProtectedSources,
  normalizeStagingBatchId
} = require('./input-staging');

const WORKER_ENTRY = require.resolve(
  '../../backend/position-reconciliation-import/worker-entry'
);

function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function loadUtilityProcess() {
  try {
    const electron = require('electron');
    return electron && electron.utilityProcess ? electron.utilityProcess : null;
  } catch (_error) {
    return null;
  }
}

function workerExitedError(code, signal) {
  const error = new Error(
    `平盘导入 utilityProcess 异常退出（code=${code}, signal=${signal || ''}）`
  );
  error.code = 'position-import-worker-exited';
  return error;
}

function fatalError(message) {
  const error = new Error(String(message && message.message || '平盘导入预检失败'));
  error.name = 'PositionReconciliationError';
  error.code = String(message && message.code || 'position-source-import-failed');
  error.detailLines = Array.isArray(message && message.detailLines)
    ? message.detailLines.slice()
    : [];
  error.stage = message && message.stage;
  error.fileIndex = message && message.fileIndex;
  error.scannedRows = Number(message && message.scannedRows || 0);
  return error;
}

function uncommittedJobRoot(input, jobId, preflightReady) {
  const userDataDir = String(input && input.userDataDir || '').trim();
  if (!userDataDir) return '';
  const stagingRoot = path.resolve(userDataDir, STAGING_RELATIVE_PATH);
  const ledgerPath = String(
    preflightReady
    && preflightReady.ledgerEvidence
    && preflightReady.ledgerEvidence.ledgerPath
    || ''
  ).trim();
  let candidate;
  if (ledgerPath) {
    if (path.basename(ledgerPath) !== 'job-ledger.sqlite') return '';
    candidate = path.dirname(path.resolve(ledgerPath));
  } else {
    let batchId;
    try {
      batchId = normalizeStagingBatchId(jobId);
    } catch (_error) {
      return '';
    }
    candidate = path.join(stagingRoot, batchId);
  }
  const relative = path.relative(stagingRoot, candidate);
  if (!relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || relative.split(path.sep).filter(Boolean).length !== 1) {
    return '';
  }
  return candidate;
}

async function cleanupUncommittedImportArtifacts(input, jobId, preflightReady) {
  const jobRoot = uncommittedJobRoot(input, jobId, preflightReady);
  if (!jobRoot) return false;
  if (typeof input.protectedStagingPaths === 'function') {
    let protectedPaths;
    try {
      protectedPaths = input.protectedStagingPaths();
    } catch (_error) {
      return false;
    }
    if (!Array.isArray(protectedPaths)
        || filterStagingPathsWithoutProtectedSources(
          [jobRoot],
          protectedPaths
        ).length === 0) {
      return false;
    }
  }
  await fs.promises.rm(jobRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
  return true;
}

function dispatchPositionImportPreflight(input = {}) {
  const engine = normalizePositionImportEngine(input.engine);
  if (engine !== POSITION_IMPORT_ENGINES.STREAMING) {
    const error = new Error('平盘百万级导入引擎未启用');
    error.code = 'position-import-disabled';
    throw error;
  }
  const jobId = String(input.jobId || crypto.randomUUID());
  const dispatchStartedAt = monotonicNowMs();
  const schemaOnly = input.command === POSITION_IMPORT_COMMANDS.ENSURE_LARGE_IMPORT_INDEXES;
  const utilityProcess = input.utilityProcess || loadUtilityProcess();
  const env = {
    ...process.env,
    POSITION_IMPORT_UTILITY_PROCESS: '1'
  };
  let worker;
  if (utilityProcess) {
    worker = utilityProcess.fork(WORKER_ENTRY, [], {
      env,
      stdio: 'pipe'
    });
  } else {
    worker = forkChild(WORKER_ENTRY, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
  }

  let settled = false;
  let recoveryStarted = false;
  let preflightReady = input.preflightReady
    || (input.payload && input.payload.preflightReady)
    || null;
  let cancelAcknowledged = false;
  let authorizationStarted = false;
  let heartbeatTimer = null;
  let lastProgressMessage = null;
  let lastProgressForwardedAt = 0;
  let applyGrantPayload = (
    input.command === POSITION_IMPORT_COMMANDS.BANK_APPLY
    || input.command === POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY
  ) ? {
      preflightOnly: false,
      baseCheckpoint: input.expectedCheckpoint,
      operationToken: input.operationToken
    } : null;
  const stderr = [];
  if (worker.stderr && typeof worker.stderr.on === 'function') {
    worker.stderr.on('data', (chunk) => {
      if (stderr.join('').length < 8192) stderr.push(chunk.toString());
    });
  }
  const sendToWorker = (message) => {
    if (typeof worker.postMessage === 'function') {
      worker.postMessage(message);
      return;
    }
    if (typeof worker.send === 'function') {
      worker.send(message);
      return;
    }
    throw new Error('平盘导入 worker 消息通道不可用');
  };
  const forwardProgress = (message, { heartbeat = false } = {}) => {
    const now = monotonicNowMs();
    const base = message && typeof message === 'object' ? message : {};
    const progress = {
      ...base,
      heartbeat,
      elapsedMs: Math.max(0, now - dispatchStartedAt)
    };
    lastProgressMessage = {
      ...progress
    };
    lastProgressForwardedAt = now;
    if (typeof input.onProgress === 'function') {
      try { input.onProgress(progress); } catch (_error) {}
    }
  };

  const promise = new Promise((resolve, reject) => {
    const cleanupAndFinish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      callback(value);
    };
    const recoverOrReject = (error) => {
      if (settled || recoveryStarted) return;
      recoveryStarted = true;
      try {
        const recovery = applyGrantPayload && applyGrantPayload.preflightOnly !== true
          ? recoverPositionImportWorkerExit({
              sideDbPath: input.sideDbPath,
              baseCheckpoint: applyGrantPayload.baseCheckpoint,
              operationToken: applyGrantPayload.operationToken,
              preflightReady,
              workerError: error,
              command: input.command
            })
          : null;
        if (recovery) {
          cleanupAndFinish(resolve, {
            ...recovery,
            preflightReady,
            cancelAcknowledged
          });
          return;
        }
      } catch (recoveryError) {
        cleanupAndFinish(reject, recoveryError);
        return;
      }
      cleanupUncommittedImportArtifacts(input, jobId, preflightReady)
        .catch(() => false)
        .finally(() => cleanupAndFinish(reject, error));
    };
    const onMessage = (eventOrMessage) => {
      const message = eventOrMessage && eventOrMessage.data &&
        !eventOrMessage.type
        ? eventOrMessage.data
        : eventOrMessage;
      if (!message || message.jobId !== jobId) return;
      if (recoveryStarted) return;
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.PROGRESS) {
        forwardProgress(message);
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY) {
        if (authorizationStarted) {
          const error = fatalError({
            code: 'position-import-intent-not-durable',
            message: '平盘导入 worker 重复请求 apply 授权'
          });
          if (typeof worker.kill === 'function') worker.kill();
          recoverOrReject(error);
          return;
        }
        preflightReady = message;
        if (typeof input.onPreflightReady === 'function') {
          try { input.onPreflightReady(message); } catch (_error) {}
        }
        authorizationStarted = true;
        Promise.resolve().then(async () => {
          if (typeof input.authorizeApply === 'function') {
            return input.authorizeApply(message);
          }
          return {
            preflightOnly: true,
            archiveManifestHash: message.archiveManifestHash
          };
        }).then((grant) => {
          if (settled || recoveryStarted) return;
          if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
            throw fatalError({
              code: 'position-import-intent-not-durable',
              message: '平盘导入 apply 授权未返回持久化凭证'
            });
          }
          applyGrantPayload = grant;
          sendToWorker({
            ...grant,
            type: POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED,
            jobId,
            archiveManifestHash: message.archiveManifestHash
          });
        }).catch((error) => {
          if (settled || recoveryStarted) return;
          try {
            sendToWorker({
              type: POSITION_IMPORT_MESSAGE_TYPES.APPLY_REJECTED,
              jobId,
              code: String(error && error.code || 'position-import-intent-not-durable'),
              message: String(error && error.message || error || '平盘导入 apply 授权失败'),
              detailLines: Array.isArray(error && error.detailLines)
                ? error.detailLines.slice(0, 100).map(String)
                : []
            });
          } catch (_sendError) {
            if (typeof worker.kill === 'function') worker.kill();
            recoverOrReject(error);
          }
        });
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK) {
        cancelAcknowledged = message.accepted !== false;
        if (typeof input.onCancelAck === 'function') {
          try { input.onCancelAck(message); } catch (_error) {}
        }
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.FILE_COMMITTED) {
        if (typeof input.onFileCommitted === 'function') {
          try { input.onFileCommitted(message); } catch (_error) {}
        }
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.COMPLETE) {
        cleanupAndFinish(resolve, {
          ...message.result,
          preflightReady,
          cancelAcknowledged
        });
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.FATAL) {
        recoverOrReject(fatalError(message));
      }
    };

    worker.on('message', onMessage);
    worker.on('error', (error) => recoverOrReject(error));
    worker.on('exit', (code, signal) => {
      if (settled) return;
      const error = workerExitedError(code, signal);
      if (stderr.length > 0) error.detailLines = [stderr.join('').slice(0, 8192)];
      recoverOrReject(error);
    });

    const configuredHeartbeatMs = Number(input.progressHeartbeatMs);
    const heartbeatMs = Number.isSafeInteger(configuredHeartbeatMs)
      && configuredHeartbeatMs > 0
      ? configuredHeartbeatMs
      : POSITION_IMPORT_PROGRESS_HEARTBEAT_MS;
    heartbeatTimer = setInterval(() => {
      if (settled || !lastProgressMessage) return;
      if (monotonicNowMs() - lastProgressForwardedAt < heartbeatMs) return;
      forwardProgress(lastProgressMessage, { heartbeat: true });
    }, heartbeatMs);
    heartbeatTimer.unref?.();

    try {
      sendToWorker({
        type: POSITION_IMPORT_MESSAGE_TYPES.START_JOB,
        protocolVersion: POSITION_IMPORT_PROTOCOL_VERSION,
        command: input.command,
        jobId,
        files: input.files,
        userDataDir: input.userDataDir,
        sideDbPath: input.sideDbPath || '',
        expectedCheckpoint: input.expectedCheckpoint || null,
        operationToken: input.operationToken || '',
        payload: input.payload || {},
        contractOptions: input.contractOptions || {},
        featureFlags: {
          ...(input.featureFlags || {}),
          ...(schemaOnly
            ? { schemaOnly: true }
            : {
                preflightOnly:
                  !input.featureFlags || input.featureFlags.preflightOnly !== false
              })
        }
      });
    } catch (error) {
      if (typeof worker.kill === 'function') worker.kill();
      recoverOrReject(error);
    }
  });

  return {
    jobId,
    promise,
    cancel() {
      if (settled) return false;
      sendToWorker({
        type: POSITION_IMPORT_MESSAGE_TYPES.CANCEL,
        jobId
      });
      return true;
    },
    terminate() {
      if (typeof worker.kill === 'function') return worker.kill();
      return false;
    }
  };
}

function dispatchPositionLargeImportSchemaMigration(input = {}) {
  return dispatchPositionImportPreflight({
    ...input,
    command: POSITION_IMPORT_COMMANDS.ENSURE_LARGE_IMPORT_INDEXES,
    files: []
  });
}

module.exports = {
  WORKER_ENTRY,
  cleanupUncommittedImportArtifacts,
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration,
  fatalError,
  uncommittedJobRoot,
  workerExitedError
};
