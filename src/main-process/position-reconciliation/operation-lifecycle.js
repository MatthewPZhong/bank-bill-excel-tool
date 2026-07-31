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
  if (expectedFiles.length === 0) {
    throw new Error('平盘导入没有可提交的普通来源文件');
  }
  const initialPending = readPending();
  const operationToken = String(initialPending && initialPending.operationToken || '').trim();
  if (!operationToken || initialPending.archiveRequired !== true) {
    throw new Error('平盘导入缺少有效的存档 pending 所有权');
  }

  recordArchiveIntentFiles(expectedFiles, 'input');
  const pendingWithFiles = readPending();
  if (!pendingWithFiles || pendingWithFiles.operationToken !== operationToken) {
    throw new Error('平盘导入登记存档意图时 pending 所有权已变化');
  }
  const persistedFiles = requirePositionPendingArchiveFiles(pendingWithFiles);
  assertSameArchiveInputEvidence(persistedFiles, expectedFiles);
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

  return files.filter((file) => (
    file.role !== 'input' || committedKeys.has(recoveryInputKey(file))
  ));
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
      await cleanup(runtime);
    } else if (archiveResult && archiveResult.archiveFailed === true) {
      reportFailure(archiveResult.warning);
      if (archiveResult.persistentRetryAvailable !== true) {
        return registrationFailureResult(result, archiveResult.warning);
      }
      markDurable(archiveResult);
      await cleanup(runtime);
    } else {
      markDurable(archiveResult || {});
      await cleanup(runtime);
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
  positionPersistentStagingProtectionPaths,
  positionPreflightAcceptedInputFiles,
  authorizePositionImportApply,
  positionCommittedRecoveryArchiveFiles,
  positionUncommittedRecoveryInputPaths,
  positionRecoveryArchiveFiles,
  assertPositionRecoveryInputsUnchanged,
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  positionReconciliationFailureResult,
  runPositionOperationLifecycle,
  settlePositionArchiveResult
};
