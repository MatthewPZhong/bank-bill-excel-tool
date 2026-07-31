'use strict';

const crypto = require('node:crypto');
const { fork: forkChild } = require('node:child_process');

const {
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_ENGINES,
  POSITION_IMPORT_MESSAGE_TYPES,
  POSITION_IMPORT_PROTOCOL_VERSION,
  normalizePositionImportEngine
} = require('../../backend/position-reconciliation-import/constants');
const {
  recoverPositionImportWorkerExit
} = require('./import-recovery');

const WORKER_ENTRY = require.resolve(
  '../../backend/position-reconciliation-import/worker-entry'
);

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

function dispatchPositionImportPreflight(input = {}) {
  const engine = normalizePositionImportEngine(input.engine);
  if (engine !== POSITION_IMPORT_ENGINES.STREAMING) {
    const error = new Error('平盘百万级导入引擎未启用');
    error.code = 'position-import-disabled';
    throw error;
  }
  const jobId = String(input.jobId || crypto.randomUUID());
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
  let preflightReady = null;
  let cancelAcknowledged = false;
  let authorizationStarted = false;
  let applyGrantPayload = null;
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

  const promise = new Promise((resolve, reject) => {
    const cleanupAndFinish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const recoverOrReject = (error) => {
      if (settled) return;
      try {
        const recovery = applyGrantPayload && applyGrantPayload.preflightOnly !== true
          ? recoverPositionImportWorkerExit({
              sideDbPath: input.sideDbPath,
              baseCheckpoint: applyGrantPayload.baseCheckpoint,
              operationToken: applyGrantPayload.operationToken,
              preflightReady,
              workerError: error
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
      cleanupAndFinish(reject, error);
    };
    const onMessage = (eventOrMessage) => {
      const message = eventOrMessage && eventOrMessage.data &&
        !eventOrMessage.type
        ? eventOrMessage.data
        : eventOrMessage;
      if (!message || message.jobId !== jobId) return;
      if (message.type === POSITION_IMPORT_MESSAGE_TYPES.PROGRESS) {
        if (typeof input.onProgress === 'function') {
          try { input.onProgress(message); } catch (_error) {}
        }
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY) {
        preflightReady = message;
        if (typeof input.onPreflightReady === 'function') {
          try { input.onPreflightReady(message); } catch (_error) {}
        }
        if (authorizationStarted) {
          if (typeof worker.kill === 'function') worker.kill();
          cleanupAndFinish(
            reject,
            fatalError({
              code: 'position-import-intent-not-durable',
              message: '平盘导入 worker 重复请求 apply 授权'
            })
          );
          return;
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
          if (settled) return;
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
          if (settled) return;
          if (typeof worker.kill === 'function') worker.kill();
          cleanupAndFinish(reject, error);
        });
      } else if (message.type === POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK) {
        cancelAcknowledged = true;
        if (typeof input.onCancelAck === 'function') {
          try { input.onCancelAck(message); } catch (_error) {}
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

    sendToWorker({
      type: POSITION_IMPORT_MESSAGE_TYPES.START_JOB,
      protocolVersion: POSITION_IMPORT_PROTOCOL_VERSION,
      command: input.command,
      jobId,
      files: input.files,
      userDataDir: input.userDataDir,
      sideDbPath: input.sideDbPath || '',
      expectedCheckpoint: input.expectedCheckpoint || null,
      contractOptions: input.contractOptions || {},
      featureFlags: {
        ...(input.featureFlags || {}),
        ...(schemaOnly ? { schemaOnly: true } : { preflightOnly: true })
      }
    });
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
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration,
  fatalError,
  workerExitedError
};
