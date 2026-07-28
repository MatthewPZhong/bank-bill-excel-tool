'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');

const STAGING_RELATIVE_PATH = 'run-data/position-reconciliation/import-staging';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HASH_BUFFER_SIZE = 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

function sourceStat(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  return stat;
}

function sameSourceStat(left, right) {
  const snapshot = sourceSnapshotFromStat(left);
  return Boolean(snapshot && sourceSnapshotMatchesStat(snapshot, right));
}

function hashFileSha256Sync(filePath) {
  const handle = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
  let sizeBytes = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function captureStagedInputEvidence(filePath) {
  const before = sourceStat(filePath);
  const hashed = hashFileSha256Sync(filePath);
  const after = sourceStat(filePath);
  if (!sameSourceStat(before, after) || hashed.sizeBytes !== Number(after.size)) {
    throw new Error(`计算摘要期间暂存文件发生变化：${path.basename(filePath)}`);
  }
  return {
    stagedSnapshot: sourceSnapshotFromStat(after),
    stagedSha256: hashed.sha256,
    stagedSizeBytes: hashed.sizeBytes
  };
}

function assertStagedInputUnchanged(descriptor) {
  const input = descriptor && typeof descriptor === 'object' ? descriptor : {};
  const filePath = path.resolve(String(input.archivePath || input.filePath || ''));
  const expectedSnapshot = normalizeSourceSnapshot(input.stagedSnapshot);
  const expectedSha256 = String(input.stagedSha256 || '').trim().toLowerCase();
  const expectedSizeBytes = Number(input.stagedSizeBytes);
  if (!expectedSnapshot
      || !SHA256_RE.test(expectedSha256)
      || !Number.isSafeInteger(expectedSizeBytes)
      || expectedSizeBytes < 0
      || expectedSnapshot.sizeBytes !== expectedSizeBytes) {
    const error = new Error(`暂存输入缺少完整内容证据：${path.basename(filePath)}`);
    error.code = 'position-staged-input-evidence-invalid';
    throw error;
  }

  try {
    const before = sourceStat(filePath);
    if (!sourceSnapshotMatchesStat(expectedSnapshot, before)) {
      throw new Error('文件身份快照不一致');
    }
    const actual = hashFileSha256Sync(filePath);
    const after = sourceStat(filePath);
    if (!sourceSnapshotMatchesStat(expectedSnapshot, after)
        || actual.sizeBytes !== expectedSizeBytes
        || actual.sha256 !== expectedSha256) {
      throw new Error('文件内容摘要不一致');
    }
  } catch (cause) {
    const error = new Error(`导入暂存文件在确认前发生变化：${path.basename(filePath)}`);
    error.code = 'position-staged-input-changed';
    error.cause = cause;
    throw error;
  }
  return true;
}

function stageInputFiles(userDataDir, filePaths, batchId) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const batchRoot = path.join(
    path.resolve(userDataDir),
    STAGING_RELATIVE_PATH,
    String(batchId)
  );
  const staged = [];
  try {
    paths.forEach((filePath, index) => {
      const originalPath = path.resolve(String(filePath || ''));
      const before = sourceStat(originalPath);
      const stagingDir = path.join(batchRoot, String(index + 1));
      fs.mkdirSync(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, path.basename(originalPath));
      fs.copyFileSync(originalPath, stagedPath, fs.constants.COPYFILE_EXCL);
      const after = sourceStat(originalPath);
      const stagedStat = sourceStat(stagedPath);
      if (!sameSourceStat(before, after) || stagedStat.size !== before.size) {
        throw new Error(`复制期间源文件发生变化：${path.basename(originalPath)}`);
      }
      const evidence = captureStagedInputEvidence(stagedPath);
      staged.push({
        filePath: stagedPath,
        sourceFilePath: originalPath,
        sourceFileName: path.basename(originalPath),
        archivePath: stagedPath,
        stagingDir,
        ...evidence
      });
    });
    return staged;
  } catch (error) {
    fs.rmSync(batchRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupStagingPaths(paths) {
  const unique = new Set((Array.isArray(paths) ? paths : []).filter(Boolean).map((value) => (
    path.resolve(String(value))
  )));
  for (const target of unique) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function filterStagingPathsWithoutProtectedSources(paths, protectedSourcePaths) {
  const targets = [...new Set(
    (Array.isArray(paths) ? paths : [])
      .filter(Boolean)
      .map((value) => path.resolve(String(value)))
  )];
  const protectedPaths = [...new Set(
    (Array.isArray(protectedSourcePaths) ? protectedSourcePaths : [])
      .filter(Boolean)
      .map((value) => path.resolve(String(value)))
  )];
  return targets.filter((target) => !protectedPaths.some((sourcePath) => {
    const relative = path.relative(target, sourcePath);
    return relative === '' || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
  }));
}

function pruneStagingRoot(userDataDir, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  protectedPaths = []
} = {}) {
  const root = path.join(path.resolve(userDataDir), STAGING_RELATIVE_PATH);
  if (!fs.existsSync(root)) return 0;
  const protectedBatchRoots = new Set();
  for (const value of Array.isArray(protectedPaths) ? protectedPaths : []) {
    const candidate = path.resolve(String(value || ''));
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    const [batchName] = relative.split(path.sep);
    if (batchName) protectedBatchRoots.add(path.join(root, batchName));
  }
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    if (protectedBatchRoots.has(target)) continue;
    try {
      const stat = fs.statSync(target);
      if (now - Number(stat.mtimeMs) < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (_error) {
      // 清理失败留待下次启动，不影响业务初始化。
    }
  }
  return removed;
}

module.exports = {
  STAGING_RELATIVE_PATH,
  stageInputFiles,
  hashFileSha256Sync,
  assertStagedInputUnchanged,
  cleanupStagingPaths,
  filterStagingPathsWithoutProtectedSources,
  pruneStagingRoot
};
