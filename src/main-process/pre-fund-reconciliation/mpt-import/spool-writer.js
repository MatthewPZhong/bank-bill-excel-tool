'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sourceSnapshotMatchesStat
} = require('../../archive-center/source-snapshot');
const { fsyncDirectory } = require('../../background-execution/durable-file');
const { parseMptCandidates } = require('./parser-core');
const { estimateMptFileSpoolBytes } = require('./spool-admission');
const {
  MPT_SPOOL_FILE_NAMES,
  MPT_SPOOL_SCHEMA_VERSION,
  deriveFileIdentity,
  mptSpoolPaths,
  normalizeFileIndex,
  normalizeJobId,
  normalizeSource,
  spoolError
} = require('./spool-contract');

function assertDirectoryDurable(result) {
  if (!result || result.capability !== 'supported') {
    throw spoolError(
      'PREFUND_SPOOL_DURABILITY_UNAVAILABLE',
      'MPT spool目录fsync不可用，不能发布ready manifest',
      { errorCode: result && result.errorCode ? result.errorCode : 'UNKNOWN' }
    );
  }
}

function assertFreshRegularSource(source) {
  let stat;
  try {
    stat = fs.lstatSync(source.filePath, { bigint: true });
  } catch (_error) {
    throw spoolError('PREFUND_SPOOL_SOURCE_CHANGED', 'MPT源文件不可读或已变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile() ||
      !sourceSnapshotMatchesStat(source.sourceSnapshot, stat)) {
    throw spoolError('PREFUND_SPOOL_SOURCE_CHANGED', 'MPT源文件不是原始普通文件快照');
  }
  return stat;
}

function pathFailure(code, message, paths, invalidPath) {
  return spoolError(code, message, {
    invalidPath,
    residualPaths: [paths.fileDir]
  });
}

function lstatDirectory(directory, code, paths) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    throw pathFailure(code, 'MPT spool目录缺失或不可访问', paths, directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathFailure(code, 'MPT spool目录不能是符号链接且必须是目录', paths, directory);
  }
  try {
    return fs.realpathSync(directory);
  } catch (_error) {
    throw pathFailure(code, 'MPT spool目录真实路径不可访问', paths, directory);
  }
}

function assertContainedDirectory(directory, rootReal, code, paths) {
  const real = lstatDirectory(directory, code, paths);
  if (real === rootReal || !real.startsWith(`${rootReal}${path.sep}`)) {
    throw pathFailure(code, 'MPT spool目录越过task staging边界', paths, directory);
  }
}

function createDirectoryLayer(directory, rootReal, paths) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw pathFailure('PREFUND_SPOOL_PATH_INVALID', 'MPT spool目录创建失败', paths, directory);
    }
  }
  assertContainedDirectory(directory, rootReal, 'PREFUND_SPOOL_PATH_INVALID', paths);
}

function ensurePrivateDirectory(paths, options = {}) {
  try {
    fs.mkdirSync(paths.taskStagingDir, { recursive: true, mode: 0o700 });
  } catch (_error) {
    throw pathFailure(
      'PREFUND_SPOOL_PATH_INVALID',
      'task staging目录创建失败',
      paths,
      paths.taskStagingDir
    );
  }
  const rootReal = lstatDirectory(
    paths.taskStagingDir,
    'PREFUND_SPOOL_PATH_INVALID',
    paths
  );
  for (const directory of [paths.mptDir, paths.jobDir, paths.fileDir]) {
    createDirectoryLayer(directory, rootReal, paths);
  }
  if (options.requireEmpty === false) return;
  for (const basename of Object.values(MPT_SPOOL_FILE_NAMES)) {
    try {
      fs.lstatSync(path.join(paths.fileDir, basename));
      throw spoolError('PREFUND_SPOOL_ALREADY_EXISTS', '当前job/fileIndex的spool已存在');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function ensureMptSpoolDirectory(input) {
  const paths = mptSpoolPaths(input);
  ensurePrivateDirectory(paths, { requireEmpty: false });
  return paths;
}

function existingCleanupTree(paths) {
  let rootReal;
  try {
    rootReal = lstatDirectory(
      paths.taskStagingDir,
      'PREFUND_SPOOL_CLEANUP_PATH_INVALID',
      paths
    );
  } catch (error) {
    if (error.details && error.details.invalidPath === paths.taskStagingDir) {
      try {
        fs.lstatSync(paths.taskStagingDir);
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') return false;
      }
    }
    throw error;
  }
  for (const directory of [paths.mptDir, paths.jobDir, paths.fileDir]) {
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw pathFailure(
        'PREFUND_SPOOL_CLEANUP_PATH_INVALID',
        'MPT spool cleanup目录不可访问',
        paths,
        directory
      );
    }
    assertContainedDirectory(
      directory,
      rootReal,
      'PREFUND_SPOOL_CLEANUP_PATH_INVALID',
      paths
    );
  }
  return true;
}

function cleanupKnownFiles(paths) {
  for (const basename of Object.values(MPT_SPOOL_FILE_NAMES)) {
    try { fs.rmSync(path.join(paths.fileDir, basename), { force: true }); } catch (_error) { /* best effort */ }
  }
  try { fs.rmdirSync(paths.fileDir); } catch (_error) { /* 非空或已删除时保留给任务级清理 */ }
  const residualPaths = [];
  for (const basename of Object.values(MPT_SPOOL_FILE_NAMES)) {
    const artifactPath = path.join(paths.fileDir, basename);
    try {
      fs.lstatSync(artifactPath);
      residualPaths.push(artifactPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') residualPaths.push(artifactPath);
    }
  }
  try {
    fs.lstatSync(paths.fileDir);
    residualPaths.push(paths.fileDir);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') residualPaths.push(paths.fileDir);
  }
  return residualPaths;
}

function openPart(filePath) {
  return fs.openSync(filePath, 'wx', 0o600);
}

function writeNdjson(fd, hash, value, budget) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (budget && bytes.length > budget.remainingBytes) {
    throw spoolError(
      'PREFUND_SPOOL_DISK_BUDGET_EXCEEDED',
      'MPT spool写入超过已批准磁盘预算'
    );
  }
  fs.writeFileSync(fd, bytes);
  hash.update(bytes);
  if (budget) budget.remainingBytes -= bytes.length;
  return bytes.length;
}

function closeDurably(state) {
  if (state.fd === null) return;
  fs.fsyncSync(state.fd);
  fs.closeSync(state.fd);
  state.fd = null;
}

function readyArtifact(filePath, byteSize, count, hash) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== byteSize) {
    throw spoolError('PREFUND_SPOOL_PUBLISH_INVALID', 'MPT spool ready文件回读身份不一致');
  }
  return Object.freeze({
    basename: path.basename(filePath),
    byteSize,
    sha256: hash.digest('hex'),
    count
  });
}

function normalizeWriteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('MPT spool writer input必须是对象');
  }
  const fileIndex = normalizeFileIndex(input.fileIndex);
  const jobId = normalizeJobId(input.jobId);
  const identity = deriveFileIdentity(input.parentOperationKey, fileIndex);
  return Object.freeze({
    taskStagingDir: input.taskStagingDir,
    jobId,
    fileIndex,
    parentOperationKey: String(input.parentOperationKey).trim(),
    ...identity,
    source: normalizeSource(input.source),
    invalidRowDisposition: input.invalidRowDisposition,
    batchSize: input.batchSize,
    rowErrorSampleLimit: input.rowErrorSampleLimit
  });
}

async function writeMptFileSpool(input, options = {}) {
  const normalized = normalizeWriteInput(input);
  const paths = mptSpoolPaths(normalized);
  const syncDirectory = options.fsyncDirectory || fsyncDirectory;
  const signal = options.signal || null;
  const rows = { fd: null, hash: crypto.createHash('sha256'), byteSize: 0, count: 0 };
  const issues = { fd: null, hash: crypto.createHash('sha256'), byteSize: 0, count: 0 };
  const budget = {
    remainingBytes: estimateMptFileSpoolBytes(normalized.source.sourceSnapshot.sizeBytes)
  };
  let manifestFd = null;
  let ownsFiles = false;

  try {
    assertFreshRegularSource(normalized.source);
    ensurePrivateDirectory(paths);
    ownsFiles = true;
    rows.fd = openPart(paths.rowsPart);
    issues.fd = openPart(paths.issuesPart);
    const parsed = await parseMptCandidates({
      filePath: normalized.source.filePath,
      invalidRowDisposition: normalized.invalidRowDisposition,
      batchSize: normalized.batchSize,
      rowErrorSampleLimit: normalized.rowErrorSampleLimit
    }, {
      signal,
      async onCandidate(candidate) {
        const target = candidate.kind === 'valid' ? rows : issues;
        target.byteSize += writeNdjson(target.fd, target.hash, candidate, budget);
        target.count += 1;
        if (typeof options.onCandidateWritten === 'function') {
          await options.onCandidateWritten(candidate);
        }
      }
    });
    assertFreshRegularSource(normalized.source);
    if (typeof parsed.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.contentHash)) {
      throw spoolError('PREFUND_SPOOL_CONTENT_HASH_INVALID', 'MPT Parser Core content hash非法');
    }

    closeDurably(rows);
    closeDurably(issues);
    fs.renameSync(paths.rowsPart, paths.rowsReady);
    fs.renameSync(paths.issuesPart, paths.issuesReady);
    assertDirectoryDurable(syncDirectory(paths.fileDir));

    const rowsArtifact = readyArtifact(paths.rowsReady, rows.byteSize, rows.count, rows.hash);
    const issuesArtifact = readyArtifact(
      paths.issuesReady,
      issues.byteSize,
      issues.count,
      issues.hash
    );
    const manifest = Object.freeze({
      schemaVersion: MPT_SPOOL_SCHEMA_VERSION,
      jobId: normalized.jobId,
      fileIndex: normalized.fileIndex,
      fileOperationKey: normalized.fileOperationKey,
      unitId: normalized.unitId,
      source: Object.freeze({
        fileName: path.basename(normalized.source.filePath),
        snapshot: normalized.source.sourceSnapshot,
        sha256: parsed.contentHash
      }),
      header: Object.freeze({
        sourceType: parsed.sourceType,
        sourceBatch: parsed.sourceBatch,
        sourceDate: parsed.sourceDate,
        sourceFileName: parsed.sourceFileName,
        sourceFileSequence: parsed.sourceFileSequence,
        declaredRowCount: parsed.declaredRowCount,
        identity: parsed.headerIdentity
      }),
      counts: Object.freeze({
        parsed: parsed.parsedRowCount,
        valid: parsed.validRowCount,
        error: parsed.errorRowCount,
        excluded: parsed.excludedRowCount
      }),
      contentHash: parsed.contentHash,
      files: Object.freeze({ rows: rowsArtifact, issues: issuesArtifact })
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    manifestFd = fs.openSync(paths.manifestPart, 'wx', 0o600);
    fs.writeFileSync(manifestFd, manifestBytes);
    fs.fsyncSync(manifestFd);
    fs.closeSync(manifestFd);
    manifestFd = null;
    fs.renameSync(paths.manifestPart, paths.manifestReady);
    assertDirectoryDurable(syncDirectory(paths.fileDir));
    return Object.freeze({
      schemaVersion: MPT_SPOOL_SCHEMA_VERSION,
      jobId: normalized.jobId,
      fileIndex: normalized.fileIndex,
      fileOperationKey: normalized.fileOperationKey,
      unitId: normalized.unitId,
      fileDir: paths.fileDir,
      manifestPath: paths.manifestReady,
      manifest
    });
  } catch (error) {
    if (rows.fd !== null) {
      try { fs.closeSync(rows.fd); } catch (_closeError) { /* original error wins */ }
      rows.fd = null;
    }
    if (issues.fd !== null) {
      try { fs.closeSync(issues.fd); } catch (_closeError) { /* original error wins */ }
      issues.fd = null;
    }
    if (manifestFd !== null) {
      try { fs.closeSync(manifestFd); } catch (_closeError) { /* original error wins */ }
    }
    if (ownsFiles) {
      try {
        cleanupMptFileSpool(normalized);
      } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
    }
    throw error;
  }
}

function cleanupMptFileSpool(input) {
  const paths = mptSpoolPaths(input);
  if (!existingCleanupTree(paths)) {
    return Object.freeze({ status: 'absent', residualPaths: Object.freeze([]) });
  }
  const residualPaths = cleanupKnownFiles(paths);
  if (residualPaths.length > 0) {
    throw spoolError(
      'PREFUND_SPOOL_CLEANUP_INCOMPLETE',
      'MPT spool cleanup未能删除全部当前file artifact',
      { residualPaths: Object.freeze(residualPaths.slice()) }
    );
  }
  return Object.freeze({ status: 'cleaned', residualPaths: Object.freeze([]) });
}

function cleanupMptSpoolParents(input) {
  const paths = mptSpoolPaths(input);
  // 仅rmdir空目录；任一其它file、恢复证据或外来文件存在时都保留owner目录。
  for (const directory of [paths.jobDir, paths.mptDir, paths.taskStagingDir]) {
    try { fs.rmdirSync(directory); } catch (error) {
      if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

module.exports = {
  assertDirectoryDurable,
  cleanupMptFileSpool,
  cleanupMptSpoolParents,
  ensureMptSpoolDirectory,
  writeMptFileSpool
};
