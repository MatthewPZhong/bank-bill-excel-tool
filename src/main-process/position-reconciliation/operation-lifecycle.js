'use strict';

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
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  runPositionOperationLifecycle,
  settlePositionArchiveResult
};
