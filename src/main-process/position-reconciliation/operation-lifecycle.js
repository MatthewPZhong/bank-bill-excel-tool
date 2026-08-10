'use strict';

const path = require('node:path');

const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');
const {
  normalizePositionCheckpoint
} = require('./side-db-mutation');

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
      const hasExpectedEvidence = file.sourceSnapshot !== undefined
        || file.sha256 !== undefined
        || file.sizeBytes !== undefined;
      const sourceSnapshot = hasExpectedEvidence
        ? normalizeSourceSnapshot(file.sourceSnapshot)
        : null;
      const sha256 = hasExpectedEvidence
        ? String(file.sha256 || '').trim().toLowerCase()
        : '';
      const sizeBytes = hasExpectedEvidence ? Number(file.sizeBytes) : null;
      if (hasExpectedEvidence && (
        !sourceSnapshot
        || !SHA256_RE.test(sha256)
        || !Number.isSafeInteger(sizeBytes)
        || sizeBytes < 0
        || sourceSnapshot.sizeBytes !== sizeBytes
      )) {
        return null;
      }
      let requiredInputPaths;
      if (file.requiredInputPaths !== undefined) {
        if (!Array.isArray(file.requiredInputPaths)
            || file.requiredInputPaths.length === 0) {
          return null;
        }
        const normalizedDependencies = file.requiredInputPaths.map((item) => (
          String(item || '').trim()
        ));
        if (normalizedDependencies.some((item) => !item)) return null;
        requiredInputPaths = [...new Set(normalizedDependencies.map((item) => (
          path.resolve(item)
        )))];
      }
      files.push({
        ...file,
        filePath: file.filePath.trim(),
        role,
        beforeSnapshot,
        ...(requiredInputPaths ? { requiredInputPaths } : {}),
        ...(hasExpectedEvidence ? { sourceSnapshot, sha256, sizeBytes } : {})
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

function positionPersistentStagingProtectionPaths(unresolvedSourcePaths, pending) {
  if (!Array.isArray(unresolvedSourcePaths)) return null;
  const pendingFiles = parsePositionPendingArchiveFiles(pending);
  if (pendingFiles === null) return null;
  return [...new Set([
    ...unresolvedSourcePaths,
    ...pendingFiles
      .filter((file) => file.role === 'input')
      .map((file) => file.filePath)
  ].filter(Boolean).map(String))];
}

function positionPreflightAcceptedInputFiles(preflightReady) {
  const accepted = preflightReady
    && Array.isArray(preflightReady.acceptedOrdinaryInputFiles)
    ? preflightReady.acceptedOrdinaryInputFiles
    : [];
  return requirePositionPendingArchiveFiles({
    archiveFiles: accepted.map((file) => ({
      filePath: file.archivePath,
      role: 'input',
      sourceType: file.sourceType,
      sourceSnapshot: file.stagedSnapshot,
      sha256: file.stagedSha256,
      sizeBytes: file.stagedSizeBytes
    }))
  });
}

function positionPreflightAnomalyOutputFiles(preflightReady) {
  const outputs = preflightReady && Array.isArray(preflightReady.outputFiles)
    ? preflightReady.outputFiles
    : [];
  return requirePositionPendingArchiveFiles({
    archiveFiles: outputs.map((file) => ({
      ...file,
      filePath: file.filePath,
      role: 'output',
      beforeSnapshot: file.sourceSnapshot || null,
      sourceSnapshot: file.sourceSnapshot,
      sha256: file.expectedSha256 || file.sha256,
      sizeBytes: file.sizeBytes
    }))
  });
}

function assertSameArchiveInputEvidence(actualFiles, expectedFiles) {
  const actualInputs = actualFiles.filter((file) => file.role === 'input');
  if (actualInputs.length !== expectedFiles.length) {
    throw new Error('平盘导入 pending 的输入文件清单与预检 manifest 不一致');
  }
  const expectedByKey = new Map(expectedFiles.map((file) => [
    recoveryInputKey(file),
    file
  ]));
  for (const actual of actualInputs) {
    const expected = expectedByKey.get(recoveryInputKey(actual));
    if (!expected
        || String(actual.sourceType || '').trim() !== String(expected.sourceType || '').trim()
        || actual.sha256 !== expected.sha256
        || actual.sizeBytes !== expected.sizeBytes
        || !snapshotsEqual(actual.sourceSnapshot, expected.sourceSnapshot)) {
      throw new Error('平盘导入 pending 的文件证据与预检 manifest 不一致');
    }
  }
}

function assertSameArchiveOutputEvidence(actualFiles, expectedFiles) {
  const actualOutputs = actualFiles.filter((file) => file.role === 'output');
  if (actualOutputs.length !== expectedFiles.length) {
    throw new Error('平盘导入 pending 的异常报告清单与预检 manifest 不一致');
  }
  const expectedByPath = new Map(expectedFiles.map((file) => [
    path.resolve(file.filePath),
    file
  ]));
  for (const actual of actualOutputs) {
    const expected = expectedByPath.get(path.resolve(actual.filePath));
    if (!expected
        || actual.sha256 !== expected.sha256
        || actual.sizeBytes !== expected.sizeBytes
        || !snapshotsEqual(actual.sourceSnapshot, expected.sourceSnapshot)
        || String(actual.artifactKey || '') !== String(expected.artifactKey || '')
        || JSON.stringify(actual.requiredInputPaths || [])
          !== JSON.stringify(expected.requiredInputPaths || [])) {
      throw new Error('平盘导入 pending 的异常报告证据与预检 manifest 不一致');
    }
  }
}

function authorizePositionImportApply({
  preflightReady,
  currentCheckpoint,
  schemaFingerprint,
  readPending,
  writePending,
  recordArchiveIntentFiles
}) {
  const manifestHash = String(
    preflightReady && preflightReady.archiveManifestHash || ''
  ).trim().toLowerCase();
  const fingerprint = String(schemaFingerprint || '').trim().toLowerCase();
  const checkpoint = normalizePositionCheckpoint(
    currentCheckpoint,
    '导入 apply 基准 checkpoint'
  );
  if (!SHA256_RE.test(manifestHash)
      || !SHA256_RE.test(fingerprint)
      || !checkpoint
      || typeof readPending !== 'function'
      || typeof writePending !== 'function'
      || typeof recordArchiveIntentFiles !== 'function') {
    throw new Error('平盘导入 apply 授权参数不完整');
  }
  const expectedFiles = positionPreflightAcceptedInputFiles(preflightReady);
  const expectedOutputs = positionPreflightAnomalyOutputFiles(preflightReady);
  if (expectedFiles.length === 0) {
    throw new Error('平盘导入没有可提交的普通来源文件');
  }
  const initialPending = readPending();
  const operationToken = String(initialPending && initialPending.operationToken || '').trim();
  if (!operationToken || initialPending.archiveRequired !== true) {
    throw new Error('平盘导入缺少有效的存档 pending 所有权');
  }

  recordArchiveIntentFiles(expectedFiles, 'input', operationToken);
  if (expectedOutputs.length > 0) {
    recordArchiveIntentFiles(expectedOutputs, 'output', operationToken);
  }
  const pendingWithFiles = readPending();
  if (!pendingWithFiles || pendingWithFiles.operationToken !== operationToken) {
    throw new Error('平盘导入登记存档意图时 pending 所有权已变化');
  }
  const persistedFiles = requirePositionPendingArchiveFiles(pendingWithFiles);
  assertSameArchiveInputEvidence(persistedFiles, expectedFiles);
  assertSameArchiveOutputEvidence(persistedFiles, expectedOutputs);
  writePending({
    ...pendingWithFiles,
    archiveManifestHash: manifestHash
  }, operationToken);

  const verifiedPending = readPending();
  if (!verifiedPending
      || verifiedPending.operationToken !== operationToken
      || String(verifiedPending.archiveManifestHash || '').trim().toLowerCase() !== manifestHash) {
    throw new Error('平盘导入 archive manifest 未持久化，禁止 apply');
  }
  assertSameArchiveInputEvidence(
    requirePositionPendingArchiveFiles(verifiedPending),
    expectedFiles
  );
  assertSameArchiveOutputEvidence(
    requirePositionPendingArchiveFiles(verifiedPending),
    expectedOutputs
  );
  return {
    operationToken,
    archiveManifestHash: manifestHash,
    schemaFingerprint: fingerprint,
    baseCheckpoint: checkpoint
  };
}

function recoveryIntegrityError(message) {
  const error = new Error(message);
  error.code = 'position-side-data-invalid';
  return error;
}

function recoveryInputKey(file) {
  return `${String(file && file.role || '').trim()}\u0000${
    path.resolve(String(file && file.filePath || ''))
  }`;
}

function snapshotsEqual(left, right) {
  const normalizedLeft = normalizeSourceSnapshot(left);
  const normalizedRight = normalizeSourceSnapshot(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.sizeBytes === normalizedRight.sizeBytes
    && normalizedLeft.mtimeMs === normalizedRight.mtimeMs
    && normalizedLeft.ctimeMs === normalizedRight.ctimeMs
    && normalizedLeft.ino === normalizedRight.ino;
}

function normalizeCommittedInputProof(value, operationToken) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryIntegrityError('平盘侧库文件级提交凭证格式非法');
  }
  const proofOperationToken = String(value.operationToken || '').trim();
  if (!proofOperationToken || proofOperationToken !== operationToken) {
    throw recoveryIntegrityError('平盘侧库文件级提交凭证 operation token 不一致');
  }
  const role = String(value.role || '').trim();
  const filePath = String(value.filePath || '').trim();
  const sourceType = String(value.sourceType || '').trim();
  const sourceSnapshot = normalizeSourceSnapshot(value.sourceSnapshot);
  const sha256 = String(value.sha256 || value.expectedSha256 || '').trim().toLowerCase();
  const sizeBytes = Number(value.sizeBytes ?? value.expectedSizeBytes);
  if (role !== 'input'
      || !filePath
      || !sourceType
      || !sourceSnapshot
      || !SHA256_RE.test(sha256)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
      || sourceSnapshot.sizeBytes !== sizeBytes) {
    throw recoveryIntegrityError('平盘侧库文件级提交凭证内容损坏');
  }
  return {
    ...value,
    operationToken: proofOperationToken,
    role,
    filePath: path.resolve(filePath),
    sourceType,
    sourceSnapshot,
    sha256,
    sizeBytes
  };
}

function positionCommittedRecoveryArchiveFiles(value, committedInputs) {
  const operationToken = String(value && value.operationToken || '').trim();
  if (!operationToken) {
    throw recoveryIntegrityError('平盘待完成操作缺少 operation token');
  }
  if (!Array.isArray(committedInputs)) {
    throw recoveryIntegrityError('平盘侧库文件级提交凭证集合格式非法');
  }
  const files = requirePositionPendingArchiveFiles(value);
  const pendingInputs = new Map();
  for (const file of files) {
    if (file.role !== 'input') continue;
    const key = recoveryInputKey(file);
    if (pendingInputs.has(key)) {
      throw recoveryIntegrityError('平盘待完成操作存在重复输入文件');
    }
    pendingInputs.set(key, file);
  }

  const committedKeys = new Set();
  for (const value of committedInputs) {
    const proof = normalizeCommittedInputProof(value, operationToken);
    const key = recoveryInputKey(proof);
    if (committedKeys.has(key)) {
      throw recoveryIntegrityError('平盘侧库存在重复文件级提交凭证');
    }
    const pending = pendingInputs.get(key);
    if (!pending) {
      throw recoveryIntegrityError('平盘侧库已提交输入在主库 pending 中缺失');
    }
    const pendingSourceType = String(pending.sourceType || '').trim();
    if ((pendingSourceType && pendingSourceType !== proof.sourceType)
        || pending.sha256 !== proof.sha256
        || pending.sizeBytes !== proof.sizeBytes
        || !snapshotsEqual(pending.sourceSnapshot, proof.sourceSnapshot)) {
      throw recoveryIntegrityError('平盘输入的 pending 证据与 side DB 提交凭证不一致');
    }
    committedKeys.add(key);
  }

  const allInputsCommitted = committedKeys.size === pendingInputs.size;
  return files.filter((file) => {
    if (file.role === 'input') return committedKeys.has(recoveryInputKey(file));
    if (!Array.isArray(file.requiredInputPaths)) {
      if (pendingInputs.size > 0 && !allInputsCommitted) {
        throw recoveryIntegrityError(
          '部分提交恢复遇到未声明输入依赖的输出文件，禁止归入成功批次'
        );
      }
      return true;
    }
    for (const inputPath of file.requiredInputPaths) {
      const key = recoveryInputKey({ role: 'input', filePath: inputPath });
      if (!pendingInputs.has(key)) {
        throw recoveryIntegrityError('异常报告引用了 pending 之外的输入文件');
      }
      if (!committedKeys.has(key)) return false;
    }
    return true;
  });
}

function positionUncommittedRecoveryInputPaths(value, committedFiles) {
  const pendingFiles = requirePositionPendingArchiveFiles(value);
  const retainedFiles = requirePositionPendingArchiveFiles({
    archiveFiles: Array.isArray(committedFiles) ? committedFiles : []
  });
  const pendingInputKeys = new Set(
    pendingFiles
      .filter((file) => file.role === 'input')
      .map(recoveryInputKey)
  );
  const committedInputKeys = new Set();
  for (const file of retainedFiles) {
    if (file.role !== 'input') continue;
    const key = recoveryInputKey(file);
    if (!pendingInputKeys.has(key)) {
      throw recoveryIntegrityError('平盘恢复保留输入在主库 pending 中缺失');
    }
    committedInputKeys.add(key);
  }
  return pendingFiles
    .filter((file) => file.role === 'input' && !committedInputKeys.has(recoveryInputKey(file)))
    .map((file) => path.resolve(file.filePath));
}

function positionRecoveryCleanupInputPaths(value, committedFiles, archiveResult) {
  return positionUncommittedRecoveryInputPaths(
    value,
    archiveResult && archiveResult.code === 'ARCHIVE_OPERATION_DELETED'
      ? []
      : committedFiles
  );
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
      sourceSnapshot,
      ...(file.sha256 ? {
        expectedSha256: file.sha256,
        sizeBytes: file.sizeBytes
      } : {}),
      artifactKey: file.artifactKey,
      sourceOperation: file.sourceOperation,
      originalName: file.originalName,
      metadata: file.metadata
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
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return result && successStatuses.has(result.status) ? 'success' : 'failed';
}

function positionTerminalOutcomeForResult(result, successStatuses) {
  if (result && result.archiveDeferred === true) return null;
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return {
      taskStatus: 'cancelled',
      code: String(result && result.code || 'POSITION_OPERATION_CANCELLED'),
      message: String(result && result.message || '平盘任务已取消')
    };
  }
  if (result && successStatuses.has(result.status)) {
    return { taskStatus: 'succeeded', code: '', message: '' };
  }
  return {
    taskStatus: 'failed',
    code: String(result && result.code || 'POSITION_OPERATION_FAILED'),
    message: String(result && result.message || '平盘任务失败')
  };
}

function positionReconciliationFailureResult(error) {
  const code = error && error.code
    ? String(error.code)
    : 'position-reconciliation-failed';
  return {
    status: code === 'position-import-cancelled' ? 'cancelled' : 'failed',
    code,
    message: error && error.message ? String(error.message) : String(error),
    detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
  };
}

function positionRecoveryTerminalOutcome(pending) {
  const explicit = pending && pending.terminalOutcome;
  const explicitStatus = String(explicit && explicit.taskStatus || '').trim().toLowerCase();
  if (['succeeded', 'failed', 'cancelled'].includes(explicitStatus)) {
    return {
      taskStatus: explicitStatus,
      code: String(explicit.code || ''),
      message: String(explicit.message || '')
    };
  }
  const businessState = String(pending && pending.businessState || '').trim().toLowerCase();
  if (businessState === 'success') {
    return { taskStatus: 'succeeded', code: '', message: '' };
  }
  if (businessState === 'cancelled') {
    return {
      taskStatus: 'cancelled',
      code: 'POSITION_OPERATION_CANCELLED',
      message: '平盘任务已取消'
    };
  }
  if (businessState === 'failed' || businessState === 'not-success') {
    return {
      taskStatus: 'failed',
      code: 'POSITION_OPERATION_FAILED',
      message: '平盘任务失败'
    };
  }
  return {
    taskStatus: 'failed',
    code: 'POSITION_OPERATION_INTERRUPTED',
    message: '平盘任务在写入终态前中断'
  };
}

async function settlePositionRecoveredTask({ pending, archiveService }) {
  const context = pending && pending.batchContext;
  const batchId = Number(context && context.batchId);
  if (!Number.isSafeInteger(batchId) || batchId < 1
      || !archiveService
      || typeof archiveService.getBatch !== 'function') {
    throw new Error('平盘恢复缺少原任务 batchContext 或存档服务');
  }
  const lookup = await archiveService.getBatch(batchId);
  if (!lookup || lookup.ok !== true || !lookup.batch) {
    throw new Error(lookup && lookup.message
      ? lookup.message
      : `平盘恢复的原任务批次不存在：${batchId}`);
  }
  const batch = lookup.batch;
  if (String(batch.operationKey || '') !== String(context.operationKey || '')
      || String(batch.parentRunId || '') !== String(context.parentRunId || '')
      || String(batch.taskRunId || '') !== String(context.taskRunId || '')
      || String(batch.moduleId || '') !== String(context.moduleId || '')) {
    throw new Error('平盘恢复 batchContext 与原任务批次身份不一致');
  }

  const outcome = positionRecoveryTerminalOutcome(pending);
  const metadata = {
    recoveredPositionOperation: true,
    positionOperationToken: String(pending.operationToken || ''),
    positionTerminalOutcome: outcome.taskStatus
  };
  let result;
  if (outcome.taskStatus === 'succeeded') {
    result = await archiveService.completeTaskBatch(batchId, { metadata });
  } else if (outcome.taskStatus === 'cancelled') {
    result = await archiveService.cancelTaskBatch(batchId, {
      reason: outcome.message || '平盘任务已取消',
      code: outcome.code || 'POSITION_OPERATION_CANCELLED',
      metadata
    });
  } else {
    result = await archiveService.failTaskBatch(batchId, {
      code: outcome.code || 'POSITION_OPERATION_FAILED',
      message: outcome.message || '平盘任务失败',
      metadata
    });
  }
  const existingTerminal = result && result.batch
    && ['succeeded', 'failed', 'cancelled'].includes(result.batch.taskStatus);
  if (!result || (result.ok === false
      && !(result.code === 'ARCHIVE_TASK_STATUS_CONFLICT' && existingTerminal))) {
    throw new Error(result && result.message
      ? result.message
      : '平盘恢复无法终结原任务批次');
  }
  return { batchId, outcome, result };
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
  markIncomplete,
  cleanup,
  reportFailure
}) {
  const setIncomplete = typeof markIncomplete === 'function' ? markIncomplete : () => {};
  const warn = typeof reportFailure === 'function' ? reportFailure : () => {};
  try {
    const archiveResult = await archiveTask;
    if (archiveResult && archiveResult.handled === false) {
      const recoveryIntent = persistRecovery();
      markDurable(recoveryIntent || archiveResult);
      await cleanup(runtime);
    } else if (archiveResult && archiveResult.archiveFailed === true) {
      if (archiveResult.persistentRetryAvailable !== true) {
        setIncomplete(archiveResult);
        return result;
      }
      markDurable(archiveResult);
      await cleanup(runtime);
    } else {
      markDurable(archiveResult || {});
      await cleanup(runtime);
    }
  } catch (error) {
    const warning = { message: error && error.message ? error.message : String(error) };
    warn(warning);
    setIncomplete({ warning });
    return result;
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
  failureResult,
  deferPendingClear = false
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
      if (persistedPending.archiveRequired && persistedPending.archiveState === 'incomplete') {
        // 业务结果原样返回；保留 pending 并阻止后续操作，重启后只向原 batch 恢复追加。
        if (operationError) throw operationError;
        return result;
      }
      if (persistedPending.archiveRequired && persistedPending.archiveState !== 'durable') {
        throw new Error('平盘对账存档尚未完成或形成持久重试记录，已停止同步 checkpoint');
      }
      syncCheckpoint();
      if (!deferPendingClear) {
        const pendingBeforeClear = readPending();
        if (!pendingBeforeClear || pendingBeforeClear.operationToken !== operationToken) {
          throw new Error('平盘对账待完成操作所有权已变化，禁止清理其他操作记录');
        }
        clearPending();
      }
    } catch (checkpointError) {
      return failureResult(checkpointError);
    }
    if (operationError) throw operationError;
    return result;
  });
}

module.exports = {
  parsePositionPendingArchiveFiles,
  requirePositionPendingArchiveFiles,
  positionPersistentStagingProtectionPaths,
  positionPreflightAcceptedInputFiles,
  positionPreflightAnomalyOutputFiles,
  authorizePositionImportApply,
  positionCommittedRecoveryArchiveFiles,
  positionRecoveryCleanupInputPaths,
  positionUncommittedRecoveryInputPaths,
  positionRecoveryArchiveFiles,
  positionRecoveryTerminalOutcome,
  assertPositionRecoveryInputsUnchanged,
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  positionTerminalOutcomeForResult,
  positionReconciliationFailureResult,
  runPositionOperationLifecycle,
  settlePositionRecoveredTask,
  settlePositionArchiveResult
};
