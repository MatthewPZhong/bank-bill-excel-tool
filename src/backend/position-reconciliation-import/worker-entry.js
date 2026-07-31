#!/usr/bin/env node
'use strict';

process.env.POSITION_IMPORT_UTILITY_PROCESS = '1';

const {
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_MESSAGE_TYPES,
  POSITION_IMPORT_PROTOCOL_VERSION
} = require('./constants');
const {
  runPositionImportPreflight
} = require('./preflight');
const {
  verifyPositionImportApplyGrant
} = require('./apply-grant');
const {
  applyPositionOrdinarySourceFiles
} = require('./source-writer');
const {
  ensurePositionLargeImportSchemaAtPath
} = require('../../main-process/position-reconciliation/large-import-schema');

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

async function runJob(message) {
  if (active) throw new Error('平盘导入 worker 同时只允许一个作业');
  if (Number(message.protocolVersion) !== POSITION_IMPORT_PROTOCOL_VERSION) {
    const error = new Error('平盘导入协议版本不兼容');
    error.code = 'position-import-job-ledger-invalid';
    throw error;
  }
  const command = String(message.command || '');
  if (command === POSITION_IMPORT_COMMANDS.ENSURE_LARGE_IMPORT_INDEXES) {
    if (!message.featureFlags || message.featureFlags.schemaOnly !== true) {
      const error = new Error('平盘 schema 迁移缺少 schemaOnly 授权');
      error.code = 'position-import-intent-not-durable';
      throw error;
    }
    active = {
      jobId: String(message.jobId || ''),
      cancelToken: { cancelled: false },
      stage: 'schema-migration',
      peakRssBytes: process.memoryUsage().rss,
      peakHeapUsedBytes: process.memoryUsage().heapUsed
    };
    const result = ensurePositionLargeImportSchemaAtPath({
      sideDbPath: message.sideDbPath,
      expectedCheckpoint: message.expectedCheckpoint
    });
    const memory = process.memoryUsage();
    channel.send({
      type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
      jobId: active.jobId,
      result: {
        ...result,
        resourceMetrics: {
          workerPeakRssBytes: Math.max(active.peakRssBytes, memory.rss),
          workerPeakHeapUsedBytes: Math.max(active.peakHeapUsedBytes, memory.heapUsed)
        }
      }
    });
    active = null;
    return;
  }
  const preflightOnly = !message.featureFlags
    || message.featureFlags.preflightOnly !== false;
  if (!preflightOnly
      && command !== POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY) {
    const error = new Error('当前生产 writer 只允许普通链接原始表导入');
    error.code = 'position-import-intent-not-durable';
    throw error;
  }
  const kind = command === POSITION_IMPORT_COMMANDS.BANK_PREPARE
    ? 'bank'
    : command === POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY
      ? 'source'
      : null;
  if (!kind) {
    const error = new Error(`PR-B 尚未启用命令：${command}`);
    error.code = 'position-import-intent-not-durable';
    throw error;
  }

  const cancelToken = { cancelled: false };
  let resolveApplyGrant;
  let rejectApplyGrant;
  const applyGrant = new Promise((resolve, reject) => {
    resolveApplyGrant = resolve;
    rejectApplyGrant = reject;
  });
  active = {
    jobId: String(message.jobId || ''),
    cancelToken,
    stage: 'staging',
    resolveApplyGrant,
    rejectApplyGrant,
    peakRssBytes: process.memoryUsage().rss,
    peakHeapUsedBytes: process.memoryUsage().heapUsed
  };
  const result = await runPositionImportPreflight({
    jobId: active.jobId,
    kind,
    files: message.files,
    userDataDir: message.userDataDir,
    cancelToken,
    sstOptions: message.contractOptions && message.contractOptions.sstOptions,
    onProgress(progress) {
      active.stage = progress.stage || active.stage;
      const memory = process.memoryUsage();
      active.peakRssBytes = Math.max(active.peakRssBytes, memory.rss);
      active.peakHeapUsedBytes = Math.max(active.peakHeapUsedBytes, memory.heapUsed);
      channel.send({
        type: POSITION_IMPORT_MESSAGE_TYPES.PROGRESS,
        jobId: active.jobId,
        currentFile: progress.currentFile || null,
        totalFiles: progress.totalFiles || (Array.isArray(message.files) ? message.files.length : 0),
        fileName: progress.fileName || '',
        scannedRows: Number(progress.scannedRows || 0),
        acceptedRows: Number(progress.acceptedRows || 0),
        committedRows: 0,
        copiedBytes: Number(progress.copiedBytes || 0),
        totalBytes: Number(progress.totalBytes || 0),
        workerRssBytes: memory.rss,
        workerHeapUsedBytes: memory.heapUsed,
        elapsedMs: Number(progress.elapsedMs || 0),
        stage: active.stage
      });
    }
  });
  const finalMemory = process.memoryUsage();
  active.peakRssBytes = Math.max(active.peakRssBytes, finalMemory.rss);
  active.peakHeapUsedBytes = Math.max(
    active.peakHeapUsedBytes,
    finalMemory.heapUsed
  );
  channel.send({
    type: POSITION_IMPORT_MESSAGE_TYPES.PREFLIGHT_READY,
    jobId: active.jobId,
    kind,
    archiveManifestHash: result.archiveManifestHash,
    acceptedOrdinaryInputFiles: result.acceptedOrdinaryInputFiles,
    acceptedBankFiles: result.acceptedBankFiles,
    accountConfirmationDescriptor: result.accountConfirmationDescriptor,
    orderedFileResults: result.orderedFileResults,
    ledgerEvidence: result.ledgerEvidence
  });
  active.stage = 'awaiting-apply-grant';
  const grant = await applyGrant;
  const verifiedGrant = verifyPositionImportApplyGrant({
    grant,
    jobId: active.jobId,
    archiveManifestHash: result.archiveManifestHash,
    sideDbPath: message.sideDbPath,
    allowPreflightOnly: preflightOnly
  });
  let finalResult = result;
  if (!preflightOnly && !verifiedGrant.preflightOnly) {
    active.stage = 'applying';
    finalResult = await applyPositionOrdinarySourceFiles({
      sideDbPath: message.sideDbPath,
      grant: verifiedGrant,
      preflightReady: result,
      cancelToken,
      allowedSourceTypes: message.featureFlags.streamingSourceTypes,
      sstOptions: message.contractOptions && message.contractOptions.sstOptions,
      onProgress(progress) {
        active.stage = progress.stage || active.stage;
        const memory = process.memoryUsage();
        active.peakRssBytes = Math.max(active.peakRssBytes, memory.rss);
        active.peakHeapUsedBytes = Math.max(active.peakHeapUsedBytes, memory.heapUsed);
        channel.send({
          type: POSITION_IMPORT_MESSAGE_TYPES.PROGRESS,
          jobId: active.jobId,
          currentFile: progress.currentFile || null,
          totalFiles: Array.isArray(message.files) ? message.files.length : 0,
          fileName: progress.fileName || '',
          scannedRows: Number(progress.scannedRows || 0),
          acceptedRows: Number(progress.acceptedRows || 0),
          committedRows: Number(progress.committedRows || 0),
          copiedBytes: 0,
          totalBytes: 0,
          workerRssBytes: memory.rss,
          workerHeapUsedBytes: memory.heapUsed,
          elapsedMs: Number(progress.elapsedMs || 0),
          stage: active.stage
        });
      },
      onFileCommitted(file) {
        channel.send({
          type: POSITION_IMPORT_MESSAGE_TYPES.FILE_COMMITTED,
          jobId: active.jobId,
          ...file
        });
      }
    });
  }
  channel.send({
    type: POSITION_IMPORT_MESSAGE_TYPES.COMPLETE,
    jobId: active.jobId,
    result: {
      ...finalResult,
      resourceMetrics: {
        workerPeakRssBytes: active.peakRssBytes,
        workerPeakHeapUsedBytes: active.peakHeapUsedBytes
      }
    }
  });
  active = null;
}

channel.onMessage((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === POSITION_IMPORT_MESSAGE_TYPES.APPLY_GRANTED) {
    if (active && active.jobId === String(message.jobId || '')) {
      active.resolveApplyGrant(message);
    }
    return;
  }
  if (message.type === POSITION_IMPORT_MESSAGE_TYPES.CANCEL) {
    if (active && active.jobId === String(message.jobId || '')) {
      active.cancelToken.cancelled = true;
      if (active.stage === 'awaiting-apply-grant') {
        const error = new Error('平盘导入已取消');
        error.code = 'position-import-cancelled';
        active.rejectApplyGrant(error);
      }
      channel.send({
        type: POSITION_IMPORT_MESSAGE_TYPES.CANCEL_ACK,
        jobId: active.jobId,
        stage: active.stage
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
