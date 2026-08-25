'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sourceSnapshotMatchesStat
} = require('../../archive-center/source-snapshot');
const { fsyncDirectory } = require('../../background-execution/durable-file');
const { parseMptCandidates } = require('./parser-core');
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

function ensurePrivateDirectory(paths) {
  fs.mkdirSync(paths.fileDir, { recursive: true, mode: 0o700 });
  for (const directory of [paths.mptDir, paths.jobDir, paths.fileDir]) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw spoolError('PREFUND_SPOOL_PATH_INVALID', 'MPT spool目录不能是符号链接且必须是目录');
    }
  }
  for (const basename of Object.values(MPT_SPOOL_FILE_NAMES)) {
    if (fs.existsSync(path.join(paths.fileDir, basename))) {
      throw spoolError('PREFUND_SPOOL_ALREADY_EXISTS', '当前job/fileIndex的spool已存在');
    }
  }
}

function cleanupKnownFiles(paths) {
  for (const basename of Object.values(MPT_SPOOL_FILE_NAMES)) {
    try { fs.rmSync(path.join(paths.fileDir, basename), { force: true }); } catch (_error) { /* best effort */ }
  }
  try { fs.rmdirSync(paths.fileDir); } catch (_error) { /* 非空或已删除时保留给任务级清理 */ }
}

function openPart(filePath) {
  return fs.openSync(filePath, 'wx', 0o600);
}

function writeNdjson(fd, hash, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  fs.writeFileSync(fd, bytes);
  hash.update(bytes);
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
        target.byteSize += writeNdjson(target.fd, target.hash, candidate);
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
    if (ownsFiles) cleanupKnownFiles(paths);
    throw error;
  }
}

function cleanupMptFileSpool(input) {
  const paths = mptSpoolPaths(input);
  cleanupKnownFiles(paths);
}

module.exports = {
  assertDirectoryDurable,
  cleanupMptFileSpool,
  writeMptFileSpool
};
