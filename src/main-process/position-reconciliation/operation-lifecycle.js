'use strict';

const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');

const SHA256_RE = /^[a-f0-9]{64}$/;

function parsePositionPendingArchiveFiles(value) {
  if (value === null || value === undefined || value === '') return [];
  let payload = value;
  if (typeof value === 'string') {
    try {
      payload = JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.archiveFiles)) return null;
  const files = [];
  for (const file of payload.archiveFiles) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
    if (typeof file.filePath !== 'string' || file.filePath.trim() === '') return null;
    const role = String(file.role || '').trim();
    if (role === 'input') {
      const sourceSnapshot = normalizeSourceSnapshot(file.sourceSnapshot);
      const sha256 = String(file.sha256 || '').trim().toLowerCase();
      const sizeBytes = Number(file.sizeBytes);
      if (!sourceSnapshot
          || !SHA256_RE.test(sha256)
          || !Number.isSafeInteger(sizeBytes)
          || sizeBytes < 0
          || sourceSnapshot.sizeBytes !== sizeBytes) {
        return null;
      }
      files.push({
        ...file,
        filePath: file.filePath.trim(),
        role,
        sourceSnapshot,
        sha256,
        sizeBytes
      });
      continue;
    }
    if (role === 'output') {
      if (!Object.prototype.hasOwnProperty.call(file, 'beforeSnapshot')) return null;
      const beforeSnapshot = file.beforeSnapshot === null
        ? null
        : normalizeSourceSnapshot(file.beforeSnapshot);
      if (file.beforeSnapshot !== null && !beforeSnapshot) return null;
      files.push({
        ...file,
        filePath: file.filePath.trim(),
        role,
        beforeSnapshot
      });
      continue;
    }
    return null;
  }
  return files;
}

function requirePositionPendingArchiveFiles(value) {
  const files = parsePositionPendingArchiveFiles(value);
  if (files === null) {
    throw new Error('平盘待完成操作的存档文件清单损坏');
  }
  return files;
}

function positionRecoveryArchiveFiles(value, { captureOutputSnapshot }) {
  const files = requirePositionPendingArchiveFiles(value);
  return files.map((file) => {
    if (file.role === 'input') {
      return {
        filePath: file.filePath,
        role: 'input',
        sourceSnapshot: file.sourceSnapshot,
        expectedSha256: file.sha256,
        sizeBytes: file.sizeBytes
      };
    }
    const sourceSnapshot = typeof captureOutputSnapshot === 'function'
      ? captureOutputSnapshot(file.filePath)
      : null;
    if (!sourceSnapshot) {
      throw new Error(`平盘输出文件尚未发布或无法读取：${file.filePath}`);
    }
    return {
      filePath: file.filePath,
      role: 'output',
      sourceSnapshot
    };
  });
}

function assertPositionRecoveryInputsUnchanged(value, assertInput) {
  if (typeof assertInput !== 'function') {
    throw new TypeError('平盘恢复输入校验器缺失');
  }
  const files = requirePositionPendingArchiveFiles(value);
  for (const file of files) {
    if (file.role !== 'input') continue;
    assertInput({
      archivePath: file.filePath,
      stagedSnapshot: file.sourceSnapshot,
      stagedSha256: file.sha256,
      stagedSizeBytes: file.sizeBytes
    });
  }
}

function positionBusinessStateForResult(result, successStatuses) {
  if (result && result.archiveDeferred === true) return 'awaiting-confirmation';
  return result && successStatuses.has(result.status) ? 'success' : 'not-success';
}

function positionArchiveIntentEvidence(pending, currentCheckpoint, {
  statSync,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
}) {
  if (!pending) {
    return {
      sideAdvanced: false,
      businessCompleted: false,
      outputPublished: false,
      requiresPersistence: false
    };
  }
  const base = pending.baseCheckpoint || {};
  const sideAdvanced = String(currentCheckpoint.identity || '') !== String(base.identity || '')
    || Number(currentCheckpoint.generation) !== Number(base.generation)
    || String(currentCheckpoint.token || '') !== String(base.token || '');
  const files = Array.isArray(pending.archiveFiles) ? pending.archiveFiles : [];
  const outputPublished = files.some((file) => {
    if (file.role !== 'output') return false;
    let stat;
    try {
      stat = statSync(file.filePath);
    } catch (_error) {
      return false;
    }
    const currentSnapshot = sourceSnapshotFromStat(stat);
    if (!currentSnapshot) return false;
    return !file.beforeSnapshot
      || !sourceSnapshotMatchesStat(file.beforeSnapshot, stat);
  });
  const businessCompleted = pending.businessState === 'success';
  return {
    sideAdvanced,
    businessCompleted,
    outputPublished,
    requiresPersistence: sideAdvanced || businessCompleted || outputPublished
  };
}

async function settlePositionArchiveResult({
  result,
  archiveTask,
  runtime,
  persistRecovery,
  markDurable,
  cleanup,
  reportFailure,
  registrationFailureResult
}) {
  try {
    const archiveResult = await archiveTask;
    if (archiveResult && archiveResult.handled === false) {
      const recoveryIntent = persistRecovery();
      markDurable(recoveryIntent || archiveResult);
      if (!recoveryIntent) cleanup(runtime);
    } else if (archiveResult && archiveResult.archiveFailed === true) {
      reportFailure(archiveResult.warning);
      if (archiveResult.persistentRetryAvailable !== true) {
        return registrationFailureResult(result, archiveResult.warning);
      }
      markDurable(archiveResult);
    } else {
      markDurable(archiveResult || {});
      cleanup(runtime);
    }
  } catch (error) {
    const warning = { message: error && error.message ? error.message : String(error) };
    reportFailure(warning);
    return registrationFailureResult(result, warning);
  }
  return result;
}

async function runPositionOperationLifecycle({
  operationToken,
  pending,
  writeInitialPending,
  runInContext,
  operation,
  readPending,
  syncCheckpoint,
  clearPending,
  failureResult
}) {
  writeInitialPending(pending);
  return runInContext(async () => {
    let result;
    let operationError = null;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      const persistedPending = readPending();
      if (!persistedPending || persistedPending.operationToken !== operationToken) {
        throw new Error('平盘对账待完成操作所有权已变化，已停止同步 checkpoint');
      }
      requirePositionPendingArchiveFiles(persistedPending);
      if (persistedPending.archiveRequired && persistedPending.archiveState !== 'durable') {
        throw new Error('平盘对账存档尚未完成或形成持久重试记录，已停止同步 checkpoint');
      }
      syncCheckpoint();
      const pendingBeforeClear = readPending();
      if (!pendingBeforeClear || pendingBeforeClear.operationToken !== operationToken) {
        throw new Error('平盘对账待完成操作所有权已变化，禁止清理其他操作记录');
      }
      clearPending();
    } catch (checkpointError) {
      if (result && result.code === 'archive-retry-registration-failed') {
        return result;
      }
      return failureResult(checkpointError);
    }
    if (operationError) throw operationError;
    return result;
  });
}

module.exports = {
  parsePositionPendingArchiveFiles,
  requirePositionPendingArchiveFiles,
  positionRecoveryArchiveFiles,
  assertPositionRecoveryInputsUnchanged,
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  runPositionOperationLifecycle,
  settlePositionArchiveResult
};
