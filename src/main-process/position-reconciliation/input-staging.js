'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');

const STAGING_RELATIVE_PATH = 'run-data/position-reconciliation/import-staging';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HASH_BUFFER_SIZE = 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const STAGING_BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function normalizeStagingBatchId(value) {
  const batchId = String(value || '').trim();
  if (!STAGING_BATCH_ID_RE.test(batchId) || batchId === '.' || batchId === '..') {
    const error = new TypeError('平盘导入 staging batchId 非法');
    error.code = 'position-import-job-ledger-invalid';
    throw error;
  }
  return batchId;
}

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

async function sourceStatAsync(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  return stat;
}

async function hashFileSha256Async(filePath) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const input = fs.createReadStream(filePath, { highWaterMark: HASH_BUFFER_SIZE });
  for await (const chunk of input) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function captureStagedInputEvidenceAsync(filePath) {
  const before = await sourceStatAsync(filePath);
  const hashed = await hashFileSha256Async(filePath);
  const after = await sourceStatAsync(filePath);
  if (!sameSourceStat(before, after) || hashed.sizeBytes !== Number(after.size)) {
    throw new Error(`计算摘要期间暂存文件发生变化：${path.basename(filePath)}`);
  }
  return {
    stagedSnapshot: sourceSnapshotFromStat(after),
    stagedSha256: hashed.sha256,
    stagedSizeBytes: hashed.sizeBytes
  };
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

async function assertStagedInputUnchangedAsync(descriptor) {
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
    const before = await sourceStatAsync(filePath);
    if (!sourceSnapshotMatchesStat(expectedSnapshot, before)) {
      throw new Error('文件身份快照不一致');
    }
    const actual = await hashFileSha256Async(filePath);
    const after = await sourceStatAsync(filePath);
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

async function copyAndHashInputAsync(
  originalPath,
  stagedPath,
  onProgress,
  cancelToken
) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      if (cancelToken && cancelToken.cancelled) {
        const error = new Error('平盘导入已取消');
        error.code = 'position-import-cancelled';
        callback(error);
        return;
      }
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (typeof onProgress === 'function') onProgress(sizeBytes);
      callback(null, chunk);
    }
  });
  await pipeline(
    fs.createReadStream(originalPath, { highWaterMark: HASH_BUFFER_SIZE }),
    meter,
    fs.createWriteStream(stagedPath, {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: HASH_BUFFER_SIZE
    })
  );
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function stageInputFilesAsync(userDataDir, filePaths, batchId, options = {}) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const normalizedBatchId = normalizeStagingBatchId(batchId);
  const batchRoot = path.join(
    path.resolve(userDataDir),
    STAGING_RELATIVE_PATH,
    normalizedBatchId
  );
  const staged = [];
  try {
    for (let index = 0; index < paths.length; index += 1) {
      if (options.cancelToken && options.cancelToken.cancelled) {
        const error = new Error('平盘导入已取消');
        error.code = 'position-import-cancelled';
        throw error;
      }
      const input = paths[index];
      const originalPath = path.resolve(String(
        input && typeof input === 'object' ? input.filePath : input
      ));
      const before = await sourceStatAsync(originalPath);
      const stagingDir = path.join(batchRoot, String(index + 1));
      await fs.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const stagedPath = path.join(stagingDir, path.basename(originalPath));
      let lastReportedBytes = 0;
      const copied = await copyAndHashInputAsync(
        originalPath,
        stagedPath,
        typeof options.onProgress === 'function'
          ? (copiedBytes) => {
            if (copiedBytes !== Number(before.size)
                && copiedBytes - lastReportedBytes < PROGRESS_INTERVAL_BYTES) {
              return;
            }
            lastReportedBytes = copiedBytes;
            options.onProgress({
              fileIndex: index,
              fileName: path.basename(originalPath),
              copiedBytes,
              totalBytes: Number(before.size)
            });
          }
          : null,
        options.cancelToken
      );
      const after = await sourceStatAsync(originalPath);
      const stagedStat = await sourceStatAsync(stagedPath);
      if (!sameSourceStat(before, after)
          || copied.sizeBytes !== Number(before.size)
          || stagedStat.size !== before.size) {
        throw new Error(`复制期间源文件发生变化：${path.basename(originalPath)}`);
      }
      staged.push({
        fileIndex: index,
        filePath: stagedPath,
        sourceFilePath: originalPath,
        sourceFileName: path.basename(originalPath),
        archivePath: stagedPath,
        stagingDir,
        stagedSnapshot: sourceSnapshotFromStat(stagedStat),
        stagedSha256: copied.sha256,
        stagedSizeBytes: copied.sizeBytes
      });
    }
    return staged;
  } catch (error) {
    await fs.promises.rm(batchRoot, { recursive: true, force: true });
    throw error;
  }
}

function stageInputFiles(userDataDir, filePaths, batchId) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const normalizedBatchId = normalizeStagingBatchId(batchId);
  const batchRoot = path.join(
    path.resolve(userDataDir),
    STAGING_RELATIVE_PATH,
    normalizedBatchId
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

async function cleanupStagingPathsAsync(paths) {
  const unique = new Set((Array.isArray(paths) ? paths : []).filter(Boolean).map((value) => (
    path.resolve(String(value))
  )));
  for (const target of unique) {
    await fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
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
  normalizeStagingBatchId,
  stageInputFiles,
  stageInputFilesAsync,
  hashFileSha256Sync,
  hashFileSha256Async,
  captureStagedInputEvidenceAsync,
  assertStagedInputUnchanged,
  assertStagedInputUnchangedAsync,
  cleanupStagingPaths,
  cleanupStagingPathsAsync,
  filterStagingPathsWithoutProtectedSources,
  pruneStagingRoot
};
