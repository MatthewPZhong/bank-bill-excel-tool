#!/usr/bin/env node
'use strict';

process.env.POSITION_IMPORT_UTILITY_PROCESS = '1';

const {
  isPositionImportCancellationLocked,
  isPositionImportMutatingCommand,
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_MESSAGE_TYPES,
  POSITION_IMPORT_PROTOCOL_VERSION
} = require('./constants');
const {
  runPositionSourceImport
} = require('./source-import');
const {
  runPositionBankImport
} = require('./bank-import');
const {
  applyPositionAccountSnapshot
} = require('./account-import');
const {
  MAINTENANCE_COMMANDS,
  runPositionMaintenanceJob
} = require('./maintenance-writer');
const {
  freezeWorkerBatchContext
} = require('../../main-process/archive-center/worker-batch-context');
const {
  freezeWorkerOperationContext
} = require('../../main-process/archive-center/worker-operation-context');

function unwrapMessage(eventOrMessage) {
  return eventOrMessage &&
    eventOrMessage.data &&
    !eventOrMessage.type
    ? eventOrMessage.data
    : eventOrMessage;
}

function createChannel() {
  if (process.parentPort && typeof process.parentPort.on === 'function') {
    return {
      onMessage(listener) {
        process.parentPort.on('message', (event) => listener(unwrapMessage(event)));
      },
      send(message) {
        process.parentPort.postMessage(message);
      }
    };
  }
  if (typeof process.send === 'function') {
    return {
      onMessage(listener) {
        process.on('message', listener);
      },
      send(message) {
        if (process.connected) process.send(message);
      }
    };
  }
  throw new Error('平盘导入 worker 缺少父进程消息通道');
}

function serializedError(error, input = {}) {
  return {
    type: POSITION_IMPORT_MESSAGE_TYPES.FATAL,
    jobId: String(input.jobId || ''),
    code: String(error && error.code || 'position-source-import-failed'),
    stage: String(input.stage || 'preflight'),
    fileIndex: Number.isSafeInteger(input.fileIndex) ? input.fileIndex : null,
    scannedRows: Number(input.scannedRows || 0),
    message: String(error && error.message || error || '平盘导入 worker 失败'),
    detailLines: Array.isArray(error && error.detailLines)
      ? error.detailLines.slice(0, 100).map((line) => String(line))
      : []
  };
}

const channel = createChannel();
let active = null;

// 已停用的命令：导入进程收到即拒绝。
const DISABLED_COMMANDS = new Set([
  POSITION_IMPORT_COMMANDS.BANK_PREPARE,
  POSITION_IMPORT_COMMANDS.BANK_APPLY,
  POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
  POSITION_IMPORT_COMMANDS.ENSURE_LARGE_IMPORT_INDEXES
]);

function trackMemory() {
  const memory = process.memoryUsage();
  active.peakRssBytes = Math.max(active.peakRssBytes, memory.rss);
  active.peakHeapUsedBytes = Math.max(active.peakHeapUsedBytes, memory.heapUsed);
  return memory;
}

function sendProgress(progress, totalFiles = 0) {
  active.stage = progress.stage || active.stage;
  const memory = trackMemory();
  channel.send({
    type: POSITION_IMPORT_MESSAGE_TYPES.PROGRESS,
    jobId: active.jobId,
    currentFile: progress.currentFile || null,
    totalFiles: progress.totalFiles || totalFiles,
    fileName: progress.fileName || '',
    scannedRows: Number(progress.scannedRows || 0),
    acceptedRows: Number(progress.acceptedRows || 0),
    committedRows: Number(progress.committedRows || 0),
    copiedBytes: Number(progress.copiedBytes || 0),
    totalBytes: Number(progress.totalBytes || 0),
    workerRssBytes: memory.rss,
    workerHeapUsedBytes: memory.heapUsed,
    elapsedMs: Number(progress.elapsedMs || 0),
    stage: active.stage
  });
}

function sendComplete(result) {
  trackMemory();
  channel.send({
    type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
    jobId: active.jobId,
    result: {
      ...result,
      resourceMetrics: {
        workerPeakRssBytes: active.peakRssBytes,
        workerPeakHeapUsedBytes: active.peakHeapUsedBytes
      }
    }
  });
  active = null;
}

function beginJob(message, stage, extra = {}) {
  active = {
    jobId: String(message.jobId || ''),
    cancelToken: { cancelled: false },
    stage,
    peakRssBytes: process.memoryUsage().rss,
    peakHeapUsedBytes: process.memoryUsage().heapUsed,
    ...extra
  };
  return active;
}

function requireFlag(message, flag, label) {
  if (!message.featureFlags || message.featureFlags[flag] !== true) {
    const error = new Error(`${label}缺少 utilityProcess 授权`);
    error.code = 'position-import-intent-not-durable';
    throw error;
  }
}

// 单遍导入（银行对账单、链接原始表）：解析并写入未提交的事务，发 ready 后等 Main 的写入授权。
async function runGrantedImport(message, run) {
  let resolveApplyGrant;
  let rejectApplyGrant;
  const applyGrant = new Promise((resolve, reject) => {
    resolveApplyGrant = resolve;
    rejectApplyGrant = reject;
  });
  // 取消可能早于等待授权：先挂空处理，避免未被等待的拒绝触发进程级异常。
  applyGrant.catch(() => undefined);
  beginJob(message, 'staging', {
    batchContext: null,
    resolveApplyGrant,
    rejectApplyGrant
  });
  const totalFiles = Array.isArray(message.files) ? message.files.length : 0;
  const contractOptions = message.contractOptions || {};
  const result = await run({
    jobId: active.jobId,
    files: message.files,
    userDataDir: message.userDataDir,
    sideDbPath: message.sideDbPath,
    expectedCheckpoint: message.expectedCheckpoint,
    cancelToken: active.cancelToken,
    sstOptions: contractOptions.sstOptions,
    sourceStructures: contractOptions.sourceStructures,
    bankSourceHeaders: contractOptions.bankSourceHeaders,
    availableBytes: contractOptions.availableBytes,
    allowedSourceTypes: message.featureFlags && message.featureFlags.streamingSourceTypes,
    onProgress: (progress) => sendProgress(progress, totalFiles),
    awaitApplyGrant(ready) {
      active.stage = 'awaiting-apply-grant';
      channel.send({
        type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
        ...ready
      });
      return applyGrant;
    }
  });
  sendComplete(result);
}

async function runJob(message) {
  if (active) throw new Error('平盘导入 worker 同时只允许一个作业');
  if (Number(message.protocolVersion) !== POSITION_IMPORT_PROTOCOL_VERSION) {
    const error = new Error('平盘导入协议版本不兼容');
    error.code = 'position-import-job-ledger-invalid';
    throw error;
  }
  const command = String(message.command || '');
  if (DISABLED_COMMANDS.has(command)) {
    // v3.2.22 起银行对账单与链接原始表只走单遍导入，侧库结构由 Main 建好：
    // 旧的「预检 + 再次解析写入」两段式和独立的结构迁移命令已移除。
    const error = new Error(`平盘导入命令已停用：${command}`);
    error.code = 'position-import-disabled';
    throw error;
  }
  const batchContext = freezeWorkerBatchContext(message.batchContext, { required: false });
  const operationContext = freezeWorkerOperationContext(message.operationContext, {
    required: false
  });
  if (batchContext && operationContext) {
    throw new TypeError('平盘 worker owner 只能是 batchContext 或 operationContext 之一');
  }
  if (isPositionImportMutatingCommand(command) && !batchContext && !operationContext) {
    throw new TypeError('平盘 mutating worker 缺少持久 owner context');
  }
  const contractOptions = message.contractOptions || {};
  if (MAINTENANCE_COMMANDS.has(command)) {
    requireFlag(message, 'maintenance', '平盘维护命令');
    beginJob(message, 'maintenance', { batchContext, operationContext });
    const result = await runPositionMaintenanceJob({
      command,
      sideDbPath: message.sideDbPath,
      expectedCheckpoint: message.expectedCheckpoint,
      operationToken: message.operationToken,
      payload: message.payload,
      cancelToken: active.cancelToken,
      batchSize: contractOptions.batchSize,
      availableBytes: contractOptions.availableBytes,
      onProgress: (progress) => sendProgress({ ...progress, currentFile: null, fileName: '' })
    });
    sendComplete(result);
    return;
  }
  if (command === POSITION_IMPORT_COMMANDS.BANK_IMPORT) {
    requireFlag(message, 'bankImport', '平盘银行单遍导入');
    await runGrantedImport(message, runPositionBankImport);
    return;
  }
  if (command === POSITION_IMPORT_COMMANDS.SOURCE_IMPORT) {
    requireFlag(message, 'sourceImport', '平盘链接原始表单遍导入');
    await runGrantedImport(message, runPositionSourceImport);
    return;
  }
  if (command === POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY) {
    requireFlag(message, 'importApply', '平盘确认导入');
    beginJob(message, 'applying', { batchContext });
    const result = await applyPositionAccountSnapshot({
      sideDbPath: message.sideDbPath,
      expectedCheckpoint: message.expectedCheckpoint,
      operationToken: message.operationToken,
      batchContext,
      preflightReady: message.payload && message.payload.preflightReady,
      cancelToken: active.cancelToken,
      sstOptions: contractOptions.sstOptions,
      sourceStructures: contractOptions.sourceStructures,
      availableBytes: contractOptions.availableBytes,
      onProgress: (progress) => sendProgress(progress)
    });
    sendComplete(result);
    return;
  }
  const error = new Error(`未知的平盘导入命令：${command}`);
  error.code = 'position-import-intent-not-durable';
  throw error;
}

channel.onMessage((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED) {
    if (active && active.jobId === String(message.jobId || '')) {
      try {
        const batchContext = freezeWorkerBatchContext(message.batchContext, {
          required: message.preflightOnly !== true
        });
        active.batchContext = batchContext;
        active.resolveApplyGrant({ ...message, batchContext });
      } catch (error) {
        active.rejectApplyGrant(error);
      }
    }
    return;
  }
  if (message.type === POSITION_IMPORT_MESSAGE_TYPES.APPLY_REJECTED) {
    if (active
        && active.jobId === String(message.jobId || '')
        && active.stage === 'awaiting-apply-grant') {
      const error = new Error(String(message.message || '平盘导入 apply 授权失败'));
      error.code = String(message.code || 'position-import-intent-not-durable');
      error.detailLines = Array.isArray(message.detailLines)
        ? message.detailLines.map(String)
        : [];
      active.rejectApplyGrant(error);
    }
    return;
  }
  if (message.type === POSITION_IMPORT_MESSAGE_TYPES.CANCEL) {
    if (active && active.jobId === String(message.jobId || '')) {
      if (isPositionImportCancellationLocked(active.stage)) {
        channel.send({
          type: POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK,
          jobId: active.jobId,
          stage: active.stage,
          accepted: false
        });
        return;
      }
      active.cancelToken.cancelled = true;
      if (active.stage === 'awaiting-apply-grant') {
        const error = new Error('平盘导入已取消');
        error.code = 'position-import-cancelled';
        active.rejectApplyGrant(error);
      }
      channel.send({
        type: POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK,
        jobId: active.jobId,
        stage: active.stage,
        accepted: true
      });
    }
    return;
  }
  if (message.type !== POSITION_IMPORT_MESSAGE_TYPES.START_JOB) return;
  runJob(message).then(() => {
    setImmediate(() => process.exit(0));
  }).catch((error) => {
    channel.send(serializedError(error, {
      jobId: message.jobId,
      stage: active ? active.stage : 'preflight'
    }));
    active = null;
    setImmediate(() => process.exit(2));
  });
});

module.exports = {
  createChannel,
  serializedError
};
