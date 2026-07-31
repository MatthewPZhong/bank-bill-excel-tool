'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');
const {
  inspectPositionOperationCommitChain
} = require('./side-db-mutation');

function recoveryRequired(message, detailLines = []) {
  const error = new Error(message);
  error.code = 'position-recovery-required';
  error.detailLines = detailLines;
  return error;
}

function inputPathKey(value) {
  return path.resolve(String(value || ''));
}

function snapshotsEqual(left, right) {
  const normalizedLeft = normalizeSourceSnapshot(left);
  const normalizedRight = normalizeSourceSnapshot(right);
  return Boolean(normalizedLeft && normalizedRight)
    && normalizedLeft.sizeBytes === normalizedRight.sizeBytes
    && normalizedLeft.mtimeMs === normalizedRight.mtimeMs
    && normalizedLeft.ctimeMs === normalizedRight.ctimeMs
    && normalizedLeft.ino === normalizedRight.ino;
}

function expectedInputEvidence(file) {
  return {
    filePath: inputPathKey(file.archivePath),
    originalName: String(file.fileName || path.basename(file.archivePath || '')).trim(),
    sourceType: String(file.sourceType || '').trim(),
    sourceSnapshot: normalizeSourceSnapshot(file.stagedSnapshot),
    sha256: String(file.stagedSha256 || '').trim().toLowerCase(),
    sizeBytes: Number(file.stagedSizeBytes)
  };
}

function proofMatchesExpected(proof, expected) {
  return inputPathKey(proof.filePath) === expected.filePath
    && String(proof.originalName || '').trim() === expected.originalName
    && String(proof.sourceType || '').trim() === expected.sourceType
    && String(proof.sha256 || '').trim().toLowerCase() === expected.sha256
    && Number(proof.sizeBytes) === expected.sizeBytes
    && snapshotsEqual(proof.sourceSnapshot, expected.sourceSnapshot);
}

function rebuildOrdinarySourceResult(preflightReady, chain, workerError) {
  const acceptedBankFiles = Array.isArray(preflightReady.acceptedBankFiles)
    ? preflightReady.acceptedBankFiles
    : [];
  if (preflightReady.kind === 'bank' || acceptedBankFiles.length > 0) {
    throw recoveryRequired(
      '平盘银行批次提交后的专用恢复尚未启用，禁止按普通来源结果恢复'
    );
  }
  const ordered = Array.isArray(preflightReady.orderedFileResults)
    ? preflightReady.orderedFileResults
    : [];
  const accepted = Array.isArray(preflightReady.acceptedOrdinaryInputFiles)
    ? preflightReady.acceptedOrdinaryInputFiles
    : [];
  const expectedByPath = new Map(accepted.map((file) => {
    const evidence = expectedInputEvidence(file);
    return [evidence.filePath, { file, evidence }];
  }));
  if (expectedByPath.size !== accepted.length) {
    throw recoveryRequired('平盘预检 manifest 存在重复的普通来源文件路径');
  }
  const unexpectedAcceptedResult = ordered.find((item) => (
    item.status === 'ok' && !expectedByPath.has(inputPathKey(item.archivePath))
  ));
  if (unexpectedAcceptedResult) {
    throw recoveryRequired(
      '平盘预检结果包含未登记到普通来源 manifest 的成功文件'
    );
  }
  const committedPaths = new Set();
  for (const proof of chain.committedInputs) {
    const key = inputPathKey(proof.filePath);
    const expected = expectedByPath.get(key);
    if (!expected || !proofMatchesExpected(proof, expected.evidence)) {
      throw recoveryRequired(
        '平盘 worker 退出后发现未知或不一致的文件级提交凭证'
      );
    }
    if (committedPaths.has(key)) {
      throw recoveryRequired('平盘 worker 退出后发现重复文件级提交凭证');
    }
    committedPaths.add(key);
  }
  if (chain.committedMutations !== committedPaths.size) {
    throw recoveryRequired(
      '平盘 worker 退出后的 checkpoint 次数与文件级提交凭证数量不一致'
    );
  }

  const results = ordered.map((item) => {
    if (item.status !== 'ok' || !expectedByPath.has(inputPathKey(item.archivePath))) {
      return item;
    }
    const committed = committedPaths.has(inputPathKey(item.archivePath));
    if (committed) {
      return {
        ...item,
        status: 'ok',
        recoveredFromWorkerExit: true
      };
    }
    return {
      ...item,
      status: 'failed',
      code: 'position-import-worker-exited-before-commit',
      message: 'worker 退出前该文件尚未形成侧库提交凭证',
      detailLines: []
    };
  });
  const success = results.filter((item) => item.status === 'ok');
  const failed = results.filter((item) => item.status === 'failed');
  const confirmation = results.filter((item) => item.status === 'needs-confirmation');
  const committedFiles = success.map((item) => {
    const expected = expectedByPath.get(inputPathKey(item.archivePath)).evidence;
    return {
      filePath: expected.filePath,
      role: 'input',
      sourceType: expected.sourceType,
      originalName: expected.originalName,
      sourceSnapshot: expected.sourceSnapshot,
      expectedSha256: expected.sha256,
      sizeBytes: expected.sizeBytes
    };
  });
  return {
    status: success.length > 0 || confirmation.length > 0 ? 'ok' : 'failed',
    code: success.length > 0 ? 'position-import-worker-exit-recovered' : (
      workerError && workerError.code
        ? workerError.code
        : 'position-import-worker-exited'
    ),
    message:
      `链接原始表导入恢复完成：成功 ${success.length}，` +
      `待确认 ${confirmation.length}，失败 ${failed.length}`,
    results,
    orderedFileResults: results,
    successCount: success.length,
    failedCount: failed.length,
    confirmationCount: confirmation.length,
    inputPaths: committedFiles.map((file) => file.filePath),
    inputFiles: committedFiles,
    cleanupPaths: results
      .filter((item) => item.status !== 'needs-confirmation')
      .map((item) => item.stagingDir)
      .filter(Boolean),
    uncommittedInputPaths: accepted
      .filter((item) => !committedPaths.has(inputPathKey(item.archivePath)))
      .map((item) => inputPathKey(item.archivePath)),
    recoveredFromWorkerExit: true,
    committedMutations: chain.committedMutations,
    checkpoint: chain.currentCheckpoint
  };
}

function recoverPositionImportWorkerExit({
  sideDbPath,
  baseCheckpoint,
  operationToken,
  preflightReady,
  workerError
}) {
  const resolvedPath = path.resolve(String(sideDbPath || ''));
  if (!String(sideDbPath || '').trim()
      || !fs.existsSync(resolvedPath)
      || !preflightReady
      || !operationToken
      || !baseCheckpoint) {
    return null;
  }
  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 30000;');
    const chain = inspectPositionOperationCommitChain(db, {
      baseCheckpoint,
      operationToken
    });
    if (chain.committedMutations === 0 && chain.committedInputs.length === 0) {
      return null;
    }
    return rebuildOrdinarySourceResult(preflightReady, chain, workerError);
  } catch (error) {
    if (error && error.code === 'position-recovery-required') throw error;
    throw recoveryRequired(
      '平盘 worker 退出后的提交证据无法闭合，需要重启恢复',
      [error && error.message ? error.message : String(error)]
    );
  } finally {
    db.close();
  }
}

module.exports = {
  recoverPositionImportWorkerExit,
  rebuildOrdinarySourceResult
};
