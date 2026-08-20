'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  createArchiveRepository,
  normalizeLocalDate
} = require('../../backend/database/archive-repository');
const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('./source-snapshot');
const {
  STORAGE_LAYOUT_VERSION,
  assignLayoutNames,
  batchRelativeDirectory
} = require('./storage-layout');
const {
  createStorageMaterializer,
  verifyFile
} = require('./storage-materializer');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('./file-plan');

const STAGING_DIR_NAME = '.staging';
const READONLY_DIR_NAME = '.readonly';
const BLOB_ROOT_PARTS = Object.freeze(['blobs', 'sha256']);
const DEFAULT_RETENTION_DAYS = 60;
const DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE = 64;
const MAX_MATERIALIZATION_BATCH_SIZE = 5000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ROOT_MUTATION_TAILS = new Map();

class ArchiveOperationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ArchiveOperationError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

function localDateOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now() 必须返回有效日期');
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addCalendarDays(localDate, days) {
  const normalized = normalizeLocalDate(localDate);
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    throw new TypeError('retentionDays 必须是 1 到 36500 的安全整数');
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeName(value, fallback = '未命名文件') {
  const text = value == null ? '' : String(value).trim();
  const name = text.split(/[\\/]/).pop();
  if (!name || name === '.' || name === '..') return fallback;
  return name.slice(0, 255);
}

function safeCode(value, fallback = 'ARCHIVE_OPERATION_FAILED') {
  const code = value == null ? '' : String(value).trim().toUpperCase();
  return /^[A-Z0-9_-]{1,128}$/.test(code) ? code : fallback;
}

function safeFailure(error, operation, originalName = '') {
  if (error instanceof ArchiveOperationError) {
    return {
      code: safeCode(error.code),
      message: error.message,
      retryable: error.retryable
    };
  }
  const causeCode = safeCode(error && error.code, 'ARCHIVE_OPERATION_FAILED');
  const fileLabel = originalName ? `文件“${safeName(originalName)}”` : '存档操作';
  return {
    code: causeCode.startsWith('ARCHIVE_') ? causeCode : `ARCHIVE_${causeCode}`,
    message: `${fileLabel}${operation}失败（${causeCode}）`,
    retryable: ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE'].includes(causeCode)
  };
}

function legacyFileTaskIdentity(moduleId, operationKey) {
  const digest = crypto.createHash('sha256')
    .update(`${String(moduleId || '')}\u0000${String(operationKey || '')}`)
    .digest('hex');
  return {
    taskRunId: `legacy-file-${digest}`,
    parentRunId: `legacy-parent-${digest}`
  };
}

function legacyManifestFs(fsImpl, inputSources) {
  const persistedByPath = new Map();
  for (const source of inputSources) {
    const snapshot = normalizeSourceSnapshot(source && source.sourceSnapshot);
    if (snapshot) persistedByPath.set(path.resolve(String(source.filePath || '')), snapshot);
  }
  return {
    realpathSync: (...args) => fsImpl.realpathSync(...args),
    statSync: (...args) => fsImpl.statSync(...args),
    lstatSync(filePath, options) {
      try {
        return fsImpl.lstatSync(filePath, options);
      } catch (error) {
        const snapshot = persistedByPath.get(path.resolve(String(filePath || '')));
        if (!error || error.code !== 'ENOENT' || !snapshot) throw error;
        return {
          size: snapshot.sizeBytes,
          mtimeMs: snapshot.mtimeMs,
          ctimeMs: snapshot.ctimeMs,
          ino: snapshot.ino,
          dev: 0,
          isFile: () => true,
          isSymbolicLink: () => false
        };
      }
    }
  };
}

function normalizeExpectedFileEvidence(payload, originalName, sourceSnapshot = null) {
  const payloadMetadata = payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : {};
  const expectedShaValue = payload.expectedSha256 ?? payloadMetadata.expectedSha256;
  const rawExpectedSha256 = expectedShaValue == null
    ? ''
    : String(expectedShaValue).trim().toLowerCase();
  if (rawExpectedSha256 && !SHA256_RE.test(rawExpectedSha256)) {
    throw new ArchiveOperationError(
      'ARCHIVE_EXPECTED_SHA_INVALID',
      `文件“${originalName}”缺少合法的业务解析摘要`
    );
  }
  const rawExpectedSizeBytes = payload.expectedSizeBytes
    ?? payload.sizeBytes
    ?? payloadMetadata.expectedSizeBytes
    ?? (rawExpectedSha256 && sourceSnapshot ? sourceSnapshot.sizeBytes : undefined);
  let expectedSizeBytes = null;
  if (rawExpectedSizeBytes !== undefined && rawExpectedSizeBytes !== null) {
    expectedSizeBytes = Number(rawExpectedSizeBytes);
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
      throw new ArchiveOperationError(
        'ARCHIVE_EXPECTED_SIZE_INVALID',
        `文件“${originalName}”缺少合法的业务解析大小`
      );
    }
  }
  return {
    expectedSha256: rawExpectedSha256,
    expectedSizeBytes,
    hasExpectedSha256: Boolean(rawExpectedSha256),
    hasExpectedSizeBytes: expectedSizeBytes !== null
  };
}

function isFileIntegrityFailure(result) {
  return result && [
    'ARCHIVE_LAYOUT_MISSING',
    'ARCHIVE_LAYOUT_SIZE_MISMATCH',
    'ARCHIVE_LAYOUT_HASH_MISMATCH'
  ].includes(result.code);
}

function publicMetadata(value, omittedKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key))
  );
}

function publicArtifact(artifact) {
  if (!artifact) return null;
  const {
    sourcePath: _sourcePath,
    storageRelativePath: _storageRelativePath,
    blob,
    ...visible
  } = artifact;
  visible.metadata = publicMetadata(visible.metadata, [
    'aliasKey',
    'sourceSnapshot',
    'targetSnapshot',
    'expectedSha256',
    'expectedSizeBytes'
  ]);
  if (!blob) return { ...visible, blob: null };
  const { relativePath: _relativePath, ...publicBlob } = blob;
  return { ...visible, blob: publicBlob };
}

function publicBatch(batch) {
  if (!batch) return null;
  const {
    taskRunId: _taskRunId,
    taskKey: _taskKey,
    operationKey: _operationKey,
    parentRunId: _parentRunId,
    ...visible
  } = batch;
  const omittedMetadataKeys = ['_fileManifest'];
  if (batch.taskRunId && batch.metadata.batchId === batch.taskRunId) {
    omittedMetadataKeys.push('batchId');
  }
  return {
    ...visible,
    metadata: publicMetadata(batch.metadata, omittedMetadataKeys)
  };
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function publicBatchDetail(detail) {
  if (!detail) return null;
  const visible = publicBatch(detail);
  if (!Array.isArray(detail.artifacts)) return visible;
  return { ...visible, artifacts: detail.artifacts.map(publicArtifact) };
}

function publicRelatedBatch(batch) {
  return {
    batchId: Number(batch.id),
    batchNumber: batch.batchNumber,
    localDate: batch.localDate,
    globalDailySequence: batch.globalDailySequence
  };
}

function deriveModuleCode(moduleId) {
  const normalized = String(moduleId || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .toUpperCase();
  return normalized || 'ARCHIVE';
}

function blobRelativePath(sha256) {
  const hash = String(sha256 || '').toLowerCase();
  if (!SHA256_RE.test(hash)) throw new TypeError('blob SHA-256 非法');
  return `${BLOB_ROOT_PARTS.join('/')}/${hash.slice(0, 2)}/${hash}`;
}

function artifactKeyForFile(payload, resolvedFilePath) {
  if (payload.artifactKey) return String(payload.artifactKey);
  const identity = [
    String(payload.direction || 'input'),
    String(payload.role || ''),
    String(payload.sourceOperation || ''),
    resolvedFilePath
  ].join('\u0000');
  return `file-${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

function runArchiveRootOperation(rootKey, operation) {
  const previous = ROOT_MUTATION_TAILS.get(rootKey) || Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.catch(() => undefined);
  ROOT_MUTATION_TAILS.set(rootKey, tail);
  tail.finally(() => {
    if (ROOT_MUTATION_TAILS.get(rootKey) === tail) ROOT_MUTATION_TAILS.delete(rootKey);
  });
  return result;
}

class ArchiveService {
  constructor(options = {}) {
    const database = options.database || options.db;
    const rootDir = options.rootDir || options.archiveRoot;
    if (!rootDir || typeof rootDir !== 'string') {
      throw new TypeError('ArchiveService 需要调用方注入 rootDir');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('ArchiveService now 必须是函数');
    }
    if (options.opener !== undefined && typeof options.opener !== 'function') {
      throw new TypeError('ArchiveService opener 必须是函数');
    }
    if (options.onSourceReleased !== undefined && typeof options.onSourceReleased !== 'function') {
      throw new TypeError('ArchiveService onSourceReleased 必须是函数');
    }
    if (options.repository === undefined && !database) {
      throw new TypeError('ArchiveService 需要调用方注入 DatabaseSync 或 repository');
    }

    const defaultRetentionDays = options.defaultRetentionDays === undefined
      ? DEFAULT_RETENTION_DAYS
      : Number(options.defaultRetentionDays);
    if (!Number.isSafeInteger(defaultRetentionDays)
        || defaultRetentionDays < 1
        || defaultRetentionDays > 36500) {
      throw new TypeError('defaultRetentionDays 必须是 1 到 36500 的安全整数');
    }
    const startupMaterializationBatchSize = options.startupMaterializationBatchSize === undefined
      ? DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE
      : Number(options.startupMaterializationBatchSize);
    if (!Number.isSafeInteger(startupMaterializationBatchSize)
        || startupMaterializationBatchSize < 1
        || startupMaterializationBatchSize > MAX_MATERIALIZATION_BATCH_SIZE) {
      throw new TypeError('startupMaterializationBatchSize 必须是 1 到 5000 的安全整数');
    }

    this.rootDir = path.resolve(rootDir);
    this.stagingDir = path.join(this.rootDir, STAGING_DIR_NAME);
    this.readonlyDir = path.join(this.rootDir, READONLY_DIR_NAME);
    this.blobRoot = path.join(this.rootDir, ...BLOB_ROOT_PARTS);
    this.now = options.now || (() => new Date());
    this.fs = options.fsImpl || fs;
    this.opener = options.opener || null;
    this.onSourceReleased = options.onSourceReleased || null;
    this.defaultRetentionDays = defaultRetentionDays;
    this.startupMaterializationBatchSize = startupMaterializationBatchSize;
    this.verifyHashesOnStartup = options.verifyHashesOnStartup === true;
    this.repository = options.repository || createArchiveRepository(database, { now: this.now });
    this.materializer = createStorageMaterializer({
      rootDir: this.rootDir,
      stagingDir: this.stagingDir,
      fs: this.fs,
      materializeCopyFile: options.materializeCopyFile
    });
    this.initialized = false;
    this.rootEstablished = false;
    this.initialization = null;
    this.materializationGeneration = 0;
    this.materializationPromise = null;
    this.blobVerificationCursor = 0;
    this.blobVerificationRemaining = 0;
    this.materializationScanCursor = 0;
    this.materializationCandidateCursor = 0;
    this.orphanBlobPrefixes = [];
    this.orphanBlobPrefixCursor = 0;
    this.entryMaintenanceCursors = {
      blobMetadata: 0,
      artifactMetadata: 0,
      layoutMaterialization: 0
    };
    this.materializationProgress = {
      status: 'idle',
      processed: 0,
      succeeded: 0,
      failed: 0,
      remaining: 0,
      cursor: 0,
      lastErrorCode: ''
    };
  }

  async _releaseSourcePaths(sourcePaths) {
    if (!this.onSourceReleased) return;
    const paths = [...new Set(
      (Array.isArray(sourcePaths) ? sourcePaths : [])
        .filter(Boolean)
        .map((value) => path.resolve(String(value)))
    )];
    if (paths.length === 0) return;
    let unresolvedPaths;
    try {
      unresolvedPaths = new Set(
        this.listUnresolvedSourcePaths()
          .filter(Boolean)
          .map((value) => path.resolve(String(value)))
      );
    } catch (_error) {
      // 无法证明源文件已无未完成引用时，保守保留以供后续重试。
      return;
    }
    const releasablePaths = paths.filter((sourcePath) => !unresolvedPaths.has(sourcePath));
    if (releasablePaths.length === 0) return;
    try {
      await this.onSourceReleased(releasablePaths);
    } catch (_error) {
      // 业务源暂存清理失败不得把已完成的存档回滚为失败。
    }
  }

  listUnresolvedSourcePaths() {
    return this.repository.listUnresolvedArtifactSourcePaths();
  }

  _resolveManagedRelative(relativePath) {
    const text = String(relativePath || '');
    if (!text || path.isAbsolute(text) || text.includes('\\')) {
      throw new ArchiveOperationError('ARCHIVE_PATH_INVALID', '存档内部路径非法');
    }
    const resolved = path.resolve(this.rootDir, ...text.split('/'));
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new ArchiveOperationError('ARCHIVE_PATH_INVALID', '存档内部路径越界');
    }
    return resolved;
  }

  async _assertManagedRoot(options = {}) {
    try {
      const rootStat = await this.fs.promises.lstat(this.rootDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new ArchiveOperationError(
          'ARCHIVE_PATH_SYMLINK_REJECTED',
          '存档根不能是符号链接或目录联接'
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT' && options.allowMissingRoot === true) {
        return false;
      }
      if (error && error.code === 'ENOENT') {
        throw new ArchiveOperationError(
          'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
          '存档位置离线或暂时不可用',
          { retryable: true }
        );
      }
      throw error;
    }
    return true;
  }

  async _assertManagedFilePath(relativePath, options = {}) {
    const resolved = this._resolveManagedRelative(relativePath);
    const rootAvailable = await this._assertManagedRoot(options);
    if (!rootAvailable) return resolved;
    const parts = String(relativePath).split('/');
    const stop = options.includeLeaf === false ? parts.length - 1 : parts.length;
    let current = this.rootDir;
    for (let index = 0; index < stop; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const stat = await this.fs.promises.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new ArchiveOperationError(
            'ARCHIVE_PATH_SYMLINK_REJECTED',
            '存档内部路径包含符号链接或目录联接'
          );
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') break;
        throw error;
      }
    }
    return resolved;
  }

  async _syncFile(filePath) {
    const handle = await this.fs.promises.open(filePath, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async _syncDirectory(directory) {
    let handle;
    try {
      handle = await this.fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!error || !['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  async _mkdirs() {
    await this.fs.promises.mkdir(this.rootDir, { recursive: true });
    await this._assertManagedRoot();
    this.rootEstablished = true;
    await this._assertManagedFilePath(`${STAGING_DIR_NAME}/.guard`, { includeLeaf: false });
    await this._assertManagedFilePath(`${READONLY_DIR_NAME}/.guard`, { includeLeaf: false });
    await this._assertManagedFilePath(`${BLOB_ROOT_PARTS.join('/')}/.guard`, { includeLeaf: false });
    await this.fs.promises.mkdir(this.stagingDir, { recursive: true });
    await this.fs.promises.mkdir(this.readonlyDir, { recursive: true });
    await this.fs.promises.mkdir(this.blobRoot, { recursive: true });
  }

  _countMaterializationCandidates() {
    if (typeof this.repository.countMaterializationCandidates === 'function') {
      return this.repository.countMaterializationCandidates();
    }
    return this.repository.listMaterializationCandidates(1, 0).length;
  }

  _listMaterializedArtifactPage(limit, afterArtifactId) {
    if (typeof this.repository.listMaterializedArtifactsPage === 'function') {
      return this.repository.listMaterializedArtifactsPage(limit, afterArtifactId);
    }
    return this.repository.listMaterializedArtifacts()
      .filter((artifact) => artifact.id > afterArtifactId)
      .sort((left, right) => left.id - right.id)
      .slice(0, limit);
  }

  _countMaterializedArtifactsAfter(afterArtifactId) {
    if (typeof this.repository.countMaterializedArtifactsAfter === 'function') {
      return this.repository.countMaterializedArtifactsAfter(afterArtifactId);
    }
    return this.repository.listMaterializedArtifacts()
      .filter((artifact) => artifact.id > afterArtifactId)
      .length;
  }

  _countMaterializationWorkRemaining(scanCursor) {
    return this._countMaterializedArtifactsAfter(scanCursor)
      + this._countMaterializationCandidates();
  }

  _listBlobPage(limit, afterBlobId) {
    if (typeof this.repository.listBlobsPage === 'function') {
      return this.repository.listBlobsPage(limit, afterBlobId);
    }
    return this.repository.listBlobs()
      .filter((blob) => blob.id > afterBlobId)
      .sort((left, right) => left.id - right.id)
      .slice(0, limit);
  }

  _countBlobsAfter(afterBlobId) {
    if (typeof this.repository.countBlobsAfter === 'function') {
      return this.repository.countBlobsAfter(afterBlobId);
    }
    return this.repository.listBlobs().filter((blob) => blob.id > afterBlobId).length;
  }

  async _verifyBlobChunkUnlocked({ afterBlobId, limit, verifyHashes = false }) {
    const blobs = this._listBlobPage(limit, afterBlobId);
    const failures = [];
    let cursor = afterBlobId;
    let invalidBlobCount = 0;
    let removedUnreferencedBlobRecords = 0;
    for (const blob of blobs) {
      cursor = Math.max(cursor, blob.id);
      if (blob.referenceCount === 0) {
        const released = this.repository.deleteBlobIfUnreferenced(blob.id);
        if (released) {
          removedUnreferencedBlobRecords += 1;
          const physical = await this._removeReleasedBlobs([released]);
          failures.push(...physical.failures);
        }
        continue;
      }

      const expectedRelativePath = blobRelativePath(blob.sha256);
      let invalidCode = '';
      let invalidMessage = '';
      if (blob.relativePath !== expectedRelativePath) {
        invalidCode = 'ARCHIVE_BLOB_PATH_INVALID';
        invalidMessage = '存档文件路径元数据不一致，可重试该文件';
      } else {
        try {
          const filePath = await this._assertManagedFilePath(blob.relativePath);
          const stat = await this.fs.promises.lstat(filePath, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== blob.sizeBytes) {
            invalidCode = 'ARCHIVE_BLOB_INVALID';
            invalidMessage = '存档文件缺失或大小不一致，可重试该文件';
          } else if (verifyHashes
              || (blob.fingerprint && !sourceSnapshotMatchesStat(blob.fingerprint, stat))) {
            const actual = await this._hashFile(filePath);
            const finalStat = await this.fs.promises.lstat(filePath, { bigint: true });
            const beforeSnapshot = sourceSnapshotFromStat(stat);
            if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, finalStat)) {
              failures.push({
                code: 'ARCHIVE_BLOB_CHANGED_DURING_READ',
                blob: blob.sha256.slice(0, 12)
              });
              continue;
            }
            if (actual.sha256 !== blob.sha256 || actual.sizeBytes !== blob.sizeBytes) {
              invalidCode = 'ARCHIVE_BLOB_HASH_MISMATCH';
              invalidMessage = '存档文件哈希校验失败，可重试该文件';
            } else if (!verifyHashes && blob.fingerprint) {
              const refreshed = sourceSnapshotFromStat(finalStat);
              if (refreshed && typeof this.repository.refreshBlobFingerprint === 'function') {
                this.repository.refreshBlobFingerprint(blob.id, refreshed);
              }
            }
          }
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            invalidCode = 'ARCHIVE_BLOB_MISSING';
            invalidMessage = '存档文件缺失，可重试该文件';
          } else {
            failures.push({
              code: safeFailure(error, '校验').code,
              blob: blob.sha256.slice(0, 12)
            });
            continue;
          }
        }
      }
      if (invalidCode) {
        const invalidation = await this._invalidateBlobUnlocked(blob, {
          code: invalidCode,
          message: invalidMessage
        });
        if (invalidation.invalidated) invalidBlobCount += 1;
        failures.push(...invalidation.failures);
      }
    }
    return {
      cursor,
      fetched: blobs.length,
      invalidBlobCount,
      removedUnreferencedBlobRecords,
      failures,
      remaining: this._countBlobsAfter(cursor)
    };
  }

  async _listPhysicalBlobPrefixes() {
    try {
      await this._assertManagedFilePath(`${BLOB_ROOT_PARTS.join('/')}/.guard`, {
        includeLeaf: false
      });
      const prefixes = await this.fs.promises.readdir(this.blobRoot);
      return prefixes.filter((prefix) => /^[a-f0-9]{2}$/.test(prefix)).sort();
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async _scanOrphanBlobPrefixUnlocked(prefix) {
    const relativePrefix = `${BLOB_ROOT_PARTS.join('/')}/${prefix}`;
    await this._assertManagedFilePath(`${relativePrefix}/.guard`, { includeLeaf: false });
    const prefixDir = this._resolveManagedRelative(relativePrefix);
    const stat = await this.fs.promises.lstat(prefixDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_PATH_INVALID',
        '存档 Blob 分片目录类型无效'
      );
    }
    const pendingCleanupPaths = new Set(
      this.repository.listCleanupJobs()
        .flatMap((job) => job.releasedBlobs.map((blob) => blob.relativePath))
    );
    const names = await this.fs.promises.readdir(prefixDir);
    let reported = 0;
    const pathHashes = [];
    const failures = [];
    for (const name of names) {
      if (!SHA256_RE.test(name) || !name.startsWith(prefix)) continue;
      const relativePath = `${BLOB_ROOT_PARTS.join('/')}/${prefix}/${name}`;
      const known = this.repository.findBlobByHash(name);
      if ((known && known.relativePath === relativePath) || pendingCleanupPaths.has(relativePath)) {
        continue;
      }
      // SHA 形状和所在位置都不是 durable owner。仅记录隐私安全的
      // relative-path hash，不打开、不复制、不删除未知文件。
      reported += 1;
      pathHashes.push(crypto.createHash('sha256').update(relativePath).digest('hex'));
    }
    return { removed: 0, reported, pathHashes, failures };
  }

  async _drainOrphanBlobPrefixes() {
    while (this.orphanBlobPrefixCursor < this.orphanBlobPrefixes.length) {
      const prefix = this.orphanBlobPrefixes[this.orphanBlobPrefixCursor];
      await runArchiveRootOperation(this.rootDir, () => (
        this._scanOrphanBlobPrefixUnlocked(prefix)
      ));
      this.orphanBlobPrefixCursor += 1;
    }
  }

  async _verifyMaterializedArtifactChunkUnlocked({
    afterArtifactId,
    limit,
    verifyHashes = false,
    repairInvalid = true
  }) {
    const artifacts = this._listMaterializedArtifactPage(limit, afterArtifactId);
    let cursor = afterArtifactId;
    let processed = 0;
    let succeeded = 0;
    const failures = [];
    const attemptedIds = new Set();
    for (const artifact of artifacts) {
      cursor = Math.max(cursor, artifact.id);
      let layout = await this.materializer[
        verifyHashes ? 'verify' : 'verifyMetadata'
      ](artifact.storageRelativePath, {
        sha256: artifact.blob.sha256,
        sizeBytes: artifact.blob.sizeBytes
      });
      if (!verifyHashes
          && layout.valid
          && artifact.storageFingerprint
          && !sourceSnapshotMatchesStat(artifact.storageFingerprint, layout.stat)) {
        layout = await this.materializer.verify(artifact.storageRelativePath, {
          sha256: artifact.blob.sha256,
          sizeBytes: artifact.blob.sizeBytes
        });
        if (layout.valid && typeof this.repository.refreshStorageFingerprint === 'function') {
          const refreshed = sourceSnapshotFromStat(layout.stat);
          if (refreshed) this.repository.refreshStorageFingerprint(artifact.id, refreshed);
        }
      }
      const requiresIsolation = artifact.storageMode === 'hardlink';
      if (layout.valid && !requiresIsolation) continue;
      if (!layout.valid) {
        this.repository.recordMaterializationFailure(artifact.id, {
          code: layout.code,
          message: '目录化文件缺失或损坏，等待修复'
        });
      }
      if (!repairInvalid) continue;
      attemptedIds.add(artifact.id);
      processed += 1;
      const repaired = await this._materializeArtifactUnlocked(artifact.id);
      if (repaired.ok) succeeded += 1;
      else failures.push({ code: repaired.code, item: `artifact-${artifact.id}` });
    }
    return {
      cursor,
      fetched: artifacts.length,
      scanned: artifacts.length,
      processed,
      succeeded,
      failures,
      attemptedIds
    };
  }

  async _materializationWorkChunkUnlocked({ scanCursor, candidateCursor, limit }) {
    const scan = await this._verifyMaterializedArtifactChunkUnlocked({
      afterArtifactId: scanCursor,
      limit,
      verifyHashes: false,
      repairInvalid: true
    });
    const candidateLimit = Math.max(0, limit - scan.scanned);
    const candidates = candidateLimit > 0
      ? await this._materializeCandidateChunkUnlocked(
          candidateCursor,
          candidateLimit,
          scan.attemptedIds
        )
      : {
          cursor: candidateCursor,
          fetched: 0,
          processed: 0,
          succeeded: 0,
          failures: []
        };
    const nextScanCursor = scan.fetched < limit
      ? Math.max(scan.cursor, candidates.cursor)
      : scan.cursor;
    return {
      scanCursor: nextScanCursor,
      candidateCursor: candidates.cursor,
      fetched: scan.fetched + candidates.fetched,
      processed: scan.processed + candidates.processed,
      succeeded: scan.succeeded + candidates.succeeded,
      failures: [...scan.failures, ...candidates.failures],
      remaining: this._countMaterializationWorkRemaining(nextScanCursor)
    };
  }

  async _materializeCandidateChunkUnlocked(afterArtifactId, limit, attemptedIds = null) {
    const candidates = this.repository.listMaterializationCandidates(limit, afterArtifactId);
    let cursor = afterArtifactId;
    let processed = 0;
    let succeeded = 0;
    const failures = [];
    for (const artifact of candidates) {
      cursor = Math.max(cursor, artifact.id);
      if (attemptedIds && attemptedIds.has(artifact.id)) continue;
      processed += 1;
      const repaired = await this._materializeArtifactUnlocked(artifact.id);
      if (repaired.ok) succeeded += 1;
      else failures.push({ code: repaired.code, item: `artifact-${artifact.id}` });
    }
    return {
      cursor,
      fetched: candidates.length,
      processed,
      succeeded,
      failures,
      remaining: this._countMaterializationCandidates()
    };
  }

  _setMaterializationProgress(patch = {}) {
    this.materializationProgress = {
      ...this.materializationProgress,
      ...patch
    };
    return this.getMaterializationProgress();
  }

  getMaterializationProgress() {
    return { ...this.materializationProgress };
  }

  _hasBackgroundArchiveMaintenance() {
    return this.blobVerificationRemaining > 0
      || this._countMaterializationWorkRemaining(this.materializationScanCursor) > 0
      || this.orphanBlobPrefixCursor < this.orphanBlobPrefixes.length;
  }

  pauseBackgroundMaterialization() {
    this.materializationGeneration += 1;
    if (this.materializationProgress.status === 'running'
        || this.materializationProgress.status === 'pending') {
      this._setMaterializationProgress({ status: 'paused' });
    }
    const pending = this.materializationPromise || Promise.resolve(this.getMaterializationProgress());
    return Promise.resolve(pending).then(async (progress) => {
      await this._drainOrphanBlobPrefixes();
      return progress;
    });
  }

  resumeBackgroundMaterialization() {
    if (!this.initialized
        || !this.initialization
        || this.initialization.available === false
        || !this._hasBackgroundArchiveMaintenance()) {
      return this.materializationPromise || Promise.resolve(this.getMaterializationProgress());
    }
    if (this.materializationPromise) return this.materializationPromise;

    const generation = ++this.materializationGeneration;
    // cursor 只在当前 service 实例内生效；新进程/新实例天然从 0 重建。
    // 同一实例必须续接前台已验证的 cursor，否则每次 resume 都会重扫首页。
    this._setMaterializationProgress({
      remaining: this._countMaterializationWorkRemaining(this.materializationScanCursor),
      cursor: Math.max(this.materializationScanCursor, this.materializationCandidateCursor)
    });
    this._setMaterializationProgress({ status: 'running', lastErrorCode: '' });
    const drain = async () => {
      try {
        while (generation === this.materializationGeneration) {
          const chunk = await runArchiveRootOperation(this.rootDir, async () => {
            if (generation !== this.materializationGeneration) return null;
            if (this.blobVerificationRemaining > 0) {
              const blobs = await this._verifyBlobChunkUnlocked({
                afterBlobId: this.blobVerificationCursor,
                limit: this.startupMaterializationBatchSize,
                verifyHashes: false
              });
              return {
                blobVerificationCursor: blobs.cursor,
                blobVerificationRemaining: blobs.remaining,
                scanCursor: this.materializationScanCursor,
                candidateCursor: this.materializationCandidateCursor,
                fetched: blobs.fetched,
                processed: 0,
                succeeded: 0,
                failures: blobs.failures,
                remaining: this._countMaterializationWorkRemaining(
                  this.materializationScanCursor
                )
              };
            }
            if (this._countMaterializationWorkRemaining(this.materializationScanCursor) > 0) {
              const materialization = await this._materializationWorkChunkUnlocked({
                scanCursor: this.materializationScanCursor,
                candidateCursor: this.materializationCandidateCursor,
                limit: this.startupMaterializationBatchSize
              });
              return {
                ...materialization,
                remaining: materialization.remaining
              };
            }
            if (this.orphanBlobPrefixCursor < this.orphanBlobPrefixes.length) {
              const prefix = this.orphanBlobPrefixes[this.orphanBlobPrefixCursor];
              const orphan = await this._scanOrphanBlobPrefixUnlocked(prefix);
              this.orphanBlobPrefixCursor += 1;
              return {
                scanCursor: this.materializationScanCursor,
                candidateCursor: this.materializationCandidateCursor,
                fetched: 1,
                processed: 0,
                succeeded: 0,
                failures: orphan.failures,
                remaining: 0
              };
            }
            return {
              scanCursor: this.materializationScanCursor,
              candidateCursor: this.materializationCandidateCursor,
              fetched: 0,
              processed: 0,
              succeeded: 0,
              failures: [],
              remaining: 0
            };
          });
          if (!chunk) break;
          if (Number.isSafeInteger(chunk.blobVerificationCursor)) {
            this.blobVerificationCursor = chunk.blobVerificationCursor;
            this.blobVerificationRemaining = chunk.blobVerificationRemaining;
          }
          this.materializationScanCursor = chunk.scanCursor;
          this.materializationCandidateCursor = chunk.candidateCursor;
          this._setMaterializationProgress({
            cursor: Math.max(chunk.scanCursor, chunk.candidateCursor),
            processed: this.materializationProgress.processed + chunk.processed,
            succeeded: this.materializationProgress.succeeded + chunk.succeeded,
            failed: this.materializationProgress.failed + chunk.failures.length,
            remaining: chunk.remaining
          });
          if (generation !== this.materializationGeneration
              || chunk.fetched === 0
              || !this._hasBackgroundArchiveMaintenance()) break;
        }
      } catch (error) {
        const failure = safeFailure(error, '后台目录化');
        let remaining = this.materializationProgress.remaining;
        try {
          remaining = this._countMaterializationWorkRemaining(this.materializationScanCursor);
        } catch (_countError) {}
        return this._setMaterializationProgress({
          status: 'incomplete',
          remaining,
          lastErrorCode: failure.code
        });
      }
      if (generation !== this.materializationGeneration) {
        return this._setMaterializationProgress({ status: 'paused' });
      }
      return this._setMaterializationProgress({
        status: this.materializationProgress.remaining === 0 ? 'complete' : 'incomplete'
      });
    };
    this.materializationPromise = drain().finally(() => {
      this.materializationPromise = null;
    });
    return this.materializationPromise;
  }

  async _initializeUnlocked(options = {}) {
    if (this.initialized) return this.initialization;
    try {
      this.repository.ensureSchema();
    } catch (error) {
      this.initialized = false;
      const failure = safeFailure(error, '初始化');
      this.initialization = {
        ok: false,
        available: false,
        status: 'unavailable',
        ...failure
      };
      return this.initialization;
    }

    this.initialized = true;
    try {
      await this._mkdirs();
      if (options.deferStartupRecovery === true) {
        this.initialization = {
          ok: true,
          available: true,
          status: 'ready-for-owner-recovery',
          deferredStartupRecovery: true
        };
        return this.initialization;
      }
      const flowBindReplay = this.repository.replayFlowBindIntents();
      const consistency = await this._reconcileStartupUnlocked({
        verifyHashes: this.verifyHashesOnStartup
      });
      this._setMaterializationProgress({
        status: consistency.materializationRemaining === 0 ? 'complete' : 'pending',
        processed: consistency.materializationProcessedCount,
        succeeded: consistency.materializationProcessedCount
          - consistency.materializationFailureCount,
        failed: consistency.materializationFailureCount,
        remaining: consistency.materializationRemaining,
        cursor: consistency.materializationCursor,
        lastErrorCode: ''
      });
      this.blobVerificationCursor = consistency.blobVerificationCursor;
      this.blobVerificationRemaining = consistency.blobVerificationRemaining;
      this.materializationScanCursor = consistency.materializationScanCursor;
      this.materializationCandidateCursor = consistency.materializationCursor;
      this.orphanBlobPrefixes = consistency.orphanBlobPrefixes;
      this.orphanBlobPrefixCursor = consistency.orphanBlobPrefixCursor;
      this.initialization = {
        ok: consistency.failures.length === 0,
        available: true,
        status: consistency.failures.length === 0 ? 'ready' : 'ready-with-cleanup-warnings',
        consistency,
        flowBindReplay
      };
      return this.initialization;
    } catch (error) {
      const failure = safeFailure(error, '初始化');
      this._setMaterializationProgress({ status: 'incomplete' });
      this.initialization = {
        ok: false,
        available: true,
        status: 'ready-with-storage-warning',
        ...failure,
        consistency: {
          removedStagingEntries: 0,
          removedReadonlyEntries: 0,
          interruptedArtifactCount: 0,
          repairedArtifactCount: 0,
          invalidBlobCount: 0,
          removedUnreferencedBlobRecords: 0,
          removedOrphanBlobFiles: 0,
          failures: [{ code: failure.code, item: 'archive-storage' }]
        },
        flowBindReplay: null
      };
      return this.initialization;
    }
  }

  async _run(operationName, operation) {
    return runArchiveRootOperation(this.rootDir, async () => {
      const initialized = await this._initializeUnlocked();
      if (!initialized.available) {
        return {
          ok: false,
          operation: operationName,
          code: initialized.code,
          message: initialized.message,
          retryable: true
        };
      }
      try {
        if (this.rootEstablished) {
          let rootStat;
          try {
            rootStat = await this.fs.promises.lstat(this.rootDir);
          } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
            throw new ArchiveOperationError(
              'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
              '存档位置离线或暂时不可用',
              { retryable: true }
            );
          }
          if (rootStat.isSymbolicLink()) {
            throw new ArchiveOperationError(
              'ARCHIVE_PATH_SYMLINK_REJECTED',
              '存档根不能是符号链接或目录联接'
            );
          }
          if (!rootStat.isDirectory()) {
            throw new ArchiveOperationError(
              'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
              '存档位置离线或暂时不可用',
              { retryable: true }
            );
          }
        }
        return await operation();
      } catch (error) {
        return {
          ok: false,
          operation: operationName,
          ...safeFailure(error, '执行')
        };
      }
    });
  }

  async initialize(options = {}) {
    const initialized = await runArchiveRootOperation(
      this.rootDir,
      async () => this._initializeUnlocked(options)
    );
    if (options.startBackgroundMaterialization !== false
        && options.deferStartupRecovery !== true
        && initialized.available !== false) {
      this.resumeBackgroundMaterialization();
    }
    return initialized;
  }

  _taskBatchInput(payload = {}) {
    const input = {
      moduleId: payload.moduleId,
      moduleCode: payload.moduleCode || deriveModuleCode(payload.moduleId),
      moduleName: payload.moduleName || payload.moduleId,
      operationKey: payload.operationKey,
      taskKey: payload.taskKey,
      taskRunId: payload.taskRunId,
      parentRunId: payload.parentRunId,
      businessStatus: payload.businessStatus || '',
      locked: payload.locked === true,
      metadata: payload.metadata
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'batchNumber')) {
      input.batchNumber = payload.batchNumber;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'localDate')) {
      input.localDate = payload.localDate;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'retentionUntil')
        && payload.retentionUntil !== undefined) {
      input.retentionUntil = payload.retentionUntil;
    } else if (payload.retentionDays === null || payload.retentionDays === 'permanent') {
      input.retentionDays = null;
    } else {
      input.retentionDays = payload.retentionDays === undefined
        ? this.defaultRetentionDays
        : Number(payload.retentionDays);
    }
    return input;
  }

  async createBatch(payload = {}) {
    return this._run('createBatch', async () => {
      if (!Array.isArray(payload.files) || payload.files.length === 0) {
        const error = new TypeError('createBatch(files) 需要非空文件清单');
        error.code = 'ARCHIVE_FILE_MANIFEST_EMPTY';
        throw error;
      }
      const inputs = [];
      const outputs = [];
      const inputSources = [];
      const outputSources = [];
      for (const value of payload.files) {
        const file = value && typeof value === 'object' && !Array.isArray(value)
          ? value
          : { filePath: value };
        const direction = String(file.direction || 'input');
        if (!['input', 'output'].includes(direction)) {
          throw new TypeError(`legacy file direction 非法：${direction}`);
        }
        const item = {
          filePath: file.filePath,
          originalName: file.originalName,
          role: file.role,
          sourceOperation: file.sourceOperation || payload.sourceOperation
        };
        if (direction === 'output') {
          outputs.push(item);
          outputSources.push(file);
        } else {
          inputs.push(item);
          inputSources.push(file);
        }
      }
      const normalizedPlan = normalizeFilePlanV1({
        version: 1,
        allocation: 'eager',
        inputs,
        outputs
      }, { fsImpl: legacyManifestFs(this.fs, inputSources) });
      const filePlan = Object.freeze({
        ...normalizedPlan,
        inputs: Object.freeze(normalizedPlan.inputs.map((item, index) => {
          const persistedSnapshot = inputSources[index].sourceSnapshot;
          if (persistedSnapshot === undefined) return item;
          const expectedSnapshot = normalizeSourceSnapshot(persistedSnapshot);
          if (!expectedSnapshot) throw new TypeError('legacy sourceSnapshot 格式非法');
          return Object.freeze({
            ...item,
            sourceSnapshot: Object.freeze({ ...expectedSnapshot })
          });
        }))
      });
      const manifest = artifactManifestFromFilePlan(filePlan);
      const operationKey = String(payload.operationKey || crypto.randomUUID()).trim();
      const issuance = this.repository.getOperationIssuance(payload.moduleId, operationKey);
      if (issuance && issuance.deletedAt) {
        return {
          ok: false,
          status: 'deleted',
          code: 'ARCHIVE_OPERATION_DELETED',
          message: '该业务操作对应的存档批次已永久删除，不能重新创建',
          retryable: false,
          created: false,
          batchId: issuance.batchId,
          batch: null
        };
      }
      const legacyIdentity = legacyFileTaskIdentity(payload.moduleId, operationKey);
      const begun = this.repository.beginTaskRun({
        taskRunId: payload.taskRunId || legacyIdentity.taskRunId,
        moduleId: payload.moduleId,
        taskKey: payload.taskKey || payload.sourceOperation,
        operationKey,
        parentRunId: payload.parentRunId || legacyIdentity.parentRunId,
        metadata: payload.metadata
      });
      let reserved;
      const existingBatch = this.repository.getBatchByOperationKey(
        begun.taskRun.moduleId,
        begun.taskRun.operationKey
      );
      if (existingBatch && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(
        begun.taskRun.status
      )) {
        const existingIdentity = existingBatch.metadata
          && existingBatch.metadata._fileManifest
          && existingBatch.metadata._fileManifest.identity;
        if (existingIdentity !== manifest.identity) {
          const error = new Error('同 operation key 的文件 manifest 已变化');
          error.code = 'ARCHIVE_MANIFEST_IDENTITY_CONFLICT';
          throw error;
        }
        reserved = { created: false, batch: existingBatch };
      } else {
        reserved = this.repository.reserveFileTaskBatch({
          taskRun: begun.taskRun,
          manifest,
          moduleCode: payload.moduleCode,
          moduleName: payload.moduleName,
          businessStatus: payload.businessStatus,
          locked: payload.locked,
          retentionDays: payload.retentionDays === undefined
            ? this.defaultRetentionDays
            : payload.retentionDays,
          metadata: payload.metadata
        });
      }
      if (reserved.status === 'deleted') {
        return {
          ok: false,
          status: 'deleted',
          code: 'ARCHIVE_OPERATION_DELETED',
          message: '该业务操作对应的存档批次已永久删除，不能重新创建',
          retryable: false,
          created: false,
          batchId: reserved.issuance && reserved.issuance.batchId,
          batch: null
        };
      }
      const batch = reserved.batch;
      const taskAlreadyTerminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(
        begun.taskRun.status
      );
      if (!taskAlreadyTerminal) {
        const started = this._startFileTaskUnlocked(begun.taskRun.taskRunId, batch.id);
        if (!started.ok) throw new Error(started.message);
      }
      const batchContext = {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        taskRunId: batch.taskRunId,
        taskKey: batch.taskKey,
        moduleId: batch.moduleId,
        parentRunId: batch.parentRunId,
        operationKey: batch.operationKey
      };
      const settleFiles = [
        ...filePlan.inputs.map((item, index) => ({ item, source: inputSources[index] })),
        ...filePlan.outputs.map((item, index) => ({ item, source: outputSources[index] }))
      ].map(({ item, source }) => ({
        artifactKey: item.artifactKey,
        ...(source.expectedSha256 !== undefined
          ? {
              expectedSha256: source.expectedSha256,
              expectedSizeBytes: source.expectedSizeBytes
                ?? source.sizeBytes
                ?? source.sourceSnapshot?.sizeBytes
                ?? item.sourceSnapshot?.sizeBytes
            }
          : {})
      }));
      const settled = await this._settleManifestArtifactsUnlocked({
        batchContext,
        files: settleFiles
      });
      if (taskAlreadyTerminal) {
        settled.results = settled.results.map((result) => (
          result && result.status === 'ready'
            ? { ...result, alreadyArchived: true }
            : result
        ));
      }
      if (!taskAlreadyTerminal && settled.durable === true) {
        const terminal = payload.terminalOutcome && payload.terminalOutcome.taskStatus
          ? payload.terminalOutcome
          : { taskStatus: 'succeeded', metadata: {} };
        const finished = this._finishFileTaskUnlocked(
          begun.taskRun.taskRunId,
          batch.id,
          terminal
        );
        if (!finished.ok) throw new Error(finished.message);
      }
      const current = this.repository.getBatch(batch.id);
      return {
        ...settled,
        batch: current,
        created: reserved.created,
        creationStatus: reserved.created ? 'created' : 'existing',
        batchId: batch.id
      };
    });
  }

  async reserveTaskBatch(payload = {}) {
    return this._run('reserveTaskBatch', async () => {
      const reserved = this.repository.reserveTaskBatch(this._taskBatchInput(payload));
      if (reserved.status === 'deleted') {
        return {
          ok: false,
          status: 'deleted',
          code: 'ARCHIVE_OPERATION_DELETED',
          message: '该业务操作对应的存档批次已永久删除，不能重新执行',
          retryable: false,
          created: false,
          batchId: reserved.issuance.batchId,
          batch: null
        };
      }
      return {
        ok: true,
        status: reserved.created ? 'reserved' : 'existing',
        created: reserved.created,
        batchId: reserved.batch.id,
        batchNumber: reserved.batch.batchNumber,
        localDate: reserved.batch.localDate,
        dailySequence: reserved.batch.dailySequence,
        taskStatus: reserved.batch.taskStatus,
        archiveStatus: reserved.batch.archiveStatus,
        batch: reserved.batch
      };
    });
  }

  async beginTaskRun(payload = {}) {
    return this._run('beginTaskRun', async () => {
      const result = this.repository.beginTaskRun(payload);
      return {
        ok: true,
        status: result.created ? 'prepared' : 'existing',
        created: result.created,
        taskRun: result.taskRun,
        lineage: result.lineage
      };
    });
  }

  async reserveFileTaskBatch(payload = {}) {
    return this._run('reserveFileTaskBatch', async () => {
      const metadata = payload.metadata === undefined ? {} : payload.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new TypeError('metadata 必须是对象');
      }
      const result = this.repository.reserveFileTaskBatch({
        ...payload,
        metadata,
        retentionDays: payload.retentionDays === undefined
          ? this.defaultRetentionDays
          : payload.retentionDays
      });
      if (result.status === 'deleted') {
        return {
          ok: false,
          status: 'deleted',
          code: 'ARCHIVE_OPERATION_DELETED',
          message: '该业务操作对应的存档批次已永久删除，不能重新执行',
          created: false,
          batch: null
        };
      }
      return {
        ok: true,
        status: result.created ? 'reserved' : 'existing',
        created: result.created,
        batchId: result.batch.id,
        batchNumber: result.batch.batchNumber,
        batch: result.batch
      };
    });
  }

  async startFileTask(taskRunId, batchId) {
    return this._run(
      'startFileTask',
      async () => this._startFileTaskUnlocked(taskRunId, batchId)
    );
  }

  _startFileTaskUnlocked(taskRunId, batchId) {
    const result = this.repository.startFileTask(taskRunId, batchId);
    return ['updated', 'unchanged'].includes(result.status)
      ? { ok: true, ...result }
      : {
          ok: false,
          ...result,
          code: result.status === 'not-found'
            ? 'ARCHIVE_TASK_RUN_NOT_FOUND'
            : 'ARCHIVE_TASK_STATUS_CONFLICT',
          message: 'File Task 当前状态不能开始执行'
        };
  }

  async finishFileTask(taskRunId, batchId, outcome = {}) {
    return this._run(
      'finishFileTask',
      async () => this._finishFileTaskUnlocked(taskRunId, batchId, outcome)
    );
  }

  _finishFileTaskUnlocked(taskRunId, batchId, outcome = {}) {
    const result = this.repository.finishFileTask(taskRunId, batchId, outcome);
    return ['updated', 'unchanged'].includes(result.status)
      ? { ok: true, ...result }
      : {
          ok: false,
          ...result,
          code: result.status === 'not-found'
            ? 'ARCHIVE_TASK_RUN_NOT_FOUND'
            : 'ARCHIVE_TASK_STATUS_CONFLICT',
          message: 'File Task 终态发生冲突'
        };
  }

  async _settleManifestArtifactsUnlocked(payload = {}) {
      const batchContext = payload.batchContext;
      const batchId = Number(batchContext && batchContext.batchId);
      if (!Number.isSafeInteger(batchId) || batchId < 1) {
        throw new TypeError('settleManifestArtifacts 需要 batchContext');
      }
      if (!Array.isArray(payload.files)) {
        throw new TypeError('settleManifestArtifacts.files 必须是数组');
      }
      const batch = this.repository.getBatch(batchId);
      if (!batch) {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      if (!(batch.metadata && batch.metadata._fileManifest)) {
        throw new TypeError('settleManifestArtifacts 只接受 manifest v1 batch');
      }
      if (batch.taskRunId !== batchContext.taskRunId
          || batch.operationKey !== batchContext.operationKey) {
        throw new ArchiveOperationError(
          'ARCHIVE_TASK_IDENTITY_CONFLICT',
          'settle owner 与 File Batch 身份不一致'
        );
      }
      const artifacts = this.repository.listArtifacts(batch.id);
      const byKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
      const seen = new Set();
      const results = [];
      for (const file of payload.files) {
        const artifactKey = String(file && file.artifactKey || '').trim();
        if (!artifactKey || seen.has(artifactKey) || !byKey.has(artifactKey)) {
          throw new ArchiveOperationError(
            'ARCHIVE_MANIFEST_ARTIFACT_UNKNOWN',
            'settle 只能引用 manifest 中唯一的 artifactKey'
          );
        }
        seen.add(artifactKey);
        const artifact = byKey.get(artifactKey);
        const hasExpectedSha256 = file.expectedSha256 !== undefined;
        const hasExpectedSizeBytes = file.expectedSizeBytes !== undefined;
        if (hasExpectedSha256 !== hasExpectedSizeBytes) {
          throw new TypeError('settle evidence 必须同时包含 SHA-256 与大小');
        }
        const expectedSha256 = hasExpectedSha256
          ? String(file.expectedSha256).trim().toLowerCase()
          : '';
        const expectedSizeBytes = hasExpectedSizeBytes
          ? Number(file.expectedSizeBytes)
          : null;
        if ((expectedSha256 && !SHA256_RE.test(expectedSha256))
            || (expectedSizeBytes !== null
              && (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0))) {
          throw new TypeError('settle evidence 格式非法');
        }
        if (artifact.status === 'ready') {
          const matches = (!expectedSha256 || artifact.blob.sha256 === expectedSha256)
            && (expectedSizeBytes === null || artifact.blob.sizeBytes === expectedSizeBytes);
          if (!matches) {
            throw new ArchiveOperationError(
              'ARCHIVE_READY_ARTIFACT_EXPECTATION_CONFLICT',
              `文件“${artifact.originalName}”的既有存档版本与本次业务证据不一致`
            );
          }
          results.push({
            ok: true,
            status: 'ready',
            artifact: publicArtifact(artifact),
            sha256: artifact.blob.sha256,
            sizeBytes: artifact.blob.sizeBytes,
            deduplicated: true
          });
        } else {
          results.push(await this._archiveArtifactUnlocked(
            artifact,
            artifact.sourcePath,
            expectedSha256
              ? { expectedSha256, expectedSizeBytes }
              : {}
          ));
        }
      }
      const current = this.repository.getBatch(batch.id);
      return {
        ok: results.every((result) => result && result.ok !== false),
        durable: results.every((result) => (
          result && (result.ok !== false || result.metadataRecorded === true)
        )),
        status: current.archiveStatus,
        batchId: batch.id,
        batch: current,
        attempted: results.length,
        succeeded: results.filter((result) => result && result.ok !== false).length,
        failed: results.filter((result) => !result || result.ok === false).length,
        results
      };
  }

  async settleManifestArtifacts(payload = {}) {
    return this._run(
      'settleManifestArtifacts',
      async () => this._settleManifestArtifactsUnlocked(payload)
    );
  }

  async markTaskRunStarted(taskRunId) {
    return this._run('markTaskRunStarted', async () => {
      const result = this.repository.transitionTaskRun(taskRunId, 'running', {
        expectedStatuses: ['prepared']
      });
      return result.status === 'updated' || result.status === 'unchanged'
        ? { ok: true, ...result }
        : {
            ok: false,
            ...result,
            code: result.status === 'not-found'
              ? 'ARCHIVE_TASK_RUN_NOT_FOUND'
              : 'ARCHIVE_TASK_STATUS_CONFLICT',
            message: 'Task Run 当前状态不能开始执行'
          };
    });
  }

  async finishTaskRun(taskRunId, outcome = {}) {
    const status = String(outcome.taskStatus || 'failed');
    return this._run('finishTaskRun', async () => {
      const result = this.repository.transitionTaskRun(taskRunId, status, {
        expectedStatuses: ['prepared', 'running'],
        failureCode: outcome.code,
        failureMessage: outcome.message,
        metadata: outcome.metadata
      });
      return result.status === 'updated' || result.status === 'unchanged'
        ? { ok: true, ...result }
        : {
            ok: false,
            ...result,
            code: result.status === 'not-found'
              ? 'ARCHIVE_TASK_RUN_NOT_FOUND'
              : 'ARCHIVE_TASK_STATUS_CONFLICT',
            message: 'Task Run 终态发生冲突'
          };
    });
  }

  async beginTaskRunRecovery(taskRunId) {
    return this._run('beginTaskRunRecovery', async () => {
      const result = this.repository.transitionTaskRun(taskRunId, 'running', { recovery: true });
      return result.status === 'updated' || result.status === 'unchanged'
        ? { ok: true, ...result }
        : {
            ok: false,
            ...result,
            code: result.status === 'not-found'
              ? 'ARCHIVE_TASK_RUN_NOT_FOUND'
              : 'ARCHIVE_TASK_STATUS_CONFLICT',
            message: 'Task Run 当前状态不能恢复执行'
          };
    });
  }

  async beginTaskRecovery(batchContext, options = {}) {
    return this._run('beginTaskRecovery', async () => {
      const recovery = this.repository.beginTaskRecovery(batchContext, options);
      if (recovery.status === 'not-found') {
        return {
          ok: false,
          status: recovery.status,
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      if (recovery.status !== 'reopened') {
        const succeeded = recovery.status === 'succeeded-conflict';
        const identityConflict = recovery.status === 'identity-conflict';
        return {
          ok: false,
          status: recovery.status,
          code: succeeded
            ? 'ARCHIVE_TASK_ALREADY_SUCCEEDED'
            : identityConflict
              ? 'ARCHIVE_TASK_RECOVERY_IDENTITY_CONFLICT'
              : 'ARCHIVE_TASK_RECOVERY_STATUS_CONFLICT',
          message: succeeded
            ? '已成功任务不能恢复执行'
            : identityConflict
              ? '恢复上下文与存档批次身份不一致'
              : '存档批次当前状态不允许恢复执行',
          mismatchedField: recovery.mismatchedField,
          batch: recovery.batch
        };
      }
      return {
        ok: true,
        status: recovery.status,
        batchId: recovery.batch.id,
        batchNumber: recovery.batch.batchNumber,
        taskStatus: recovery.batch.taskStatus,
        batch: recovery.batch
      };
    });
  }

  async beginFileTaskRecovery(batchContext, options = {}) {
    return this._run('beginFileTaskRecovery', async () => {
      const recovery = this.repository.beginFileTaskRecovery(batchContext, options);
      if (recovery.status === 'reopened' || recovery.status === 'unchanged') {
        return { ok: true, ...recovery };
      }
      return {
        ok: false,
        ...recovery,
        code: recovery.status === 'not-found'
          ? 'ARCHIVE_BATCH_NOT_FOUND'
          : recovery.status === 'identity-conflict'
            ? 'ARCHIVE_TASK_RECOVERY_IDENTITY_CONFLICT'
            : recovery.status === 'manifest-conflict'
              ? 'ARCHIVE_MANIFEST_IDENTITY_CONFLICT'
              : 'ARCHIVE_TASK_RECOVERY_STATUS_CONFLICT',
        message: recovery.status === 'manifest-conflict'
          ? '恢复 FilePlan 与原批次 manifest 不一致'
          : 'File Task 当前状态或持久身份不允许恢复执行'
      };
    });
  }

  async _setTaskStatus(operation, batchId, taskStatus, options = {}) {
    return this._run(operation, async () => {
      const transition = this.repository.transitionTaskStatus(
        batchId,
        taskStatus,
        options
      );
      if (transition.status === 'not-found') {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      if (transition.status === 'conflict') {
        return {
          ok: false,
          status: 'conflict',
          code: 'ARCHIVE_TASK_STATUS_CONFLICT',
          message: '任务已进入终态，迟到结果未覆盖现有状态',
          batch: transition.batch
        };
      }
      return { ok: true, status: transition.status, batch: transition.batch };
    });
  }

  async markTaskStarted(batchId) {
    return this._setTaskStatus('markTaskStarted', batchId, 'running', {
      expectedStatuses: ['reserved']
    });
  }

  async completeTaskBatch(batchId, completion = {}) {
    return this._setTaskStatus('completeTaskBatch', batchId, 'succeeded', {
      ...completion,
      expectedStatuses: ['reserved', 'running']
    });
  }

  async failTaskBatch(batchId, failure = {}) {
    return this._setTaskStatus('failTaskBatch', batchId, 'failed', {
      ...failure,
      expectedStatuses: ['reserved', 'running']
    });
  }

  async cancelTaskBatch(batchId, cancellation = {}) {
    return this._setTaskStatus('cancelTaskBatch', batchId, 'cancelled', {
      ...cancellation,
      expectedStatuses: ['reserved', 'running']
    });
  }

  async getLatestBatch() {
    return this._run('getLatestBatch', async () => {
      const latest = publicBatch(this.repository.getLatestVisibleBatch());
      return {
        ok: true,
        status: 'success',
        latestBatch: latest ? { ...latest, batchId: latest.id } : null
      };
    });
  }

  async listRelatedBatches(batchId) {
    return this._run('listRelatedBatches', async () => {
      const batches = this.repository.listVisibleRelatedBatchesForBatch(batchId);
      return {
        ok: true,
        status: 'success',
        batches: batches.length >= 2 ? batches.map(publicRelatedBatch) : []
      };
    });
  }

  async findFlowAnchor(payload = {}) {
    return this._run('findFlowAnchor', async () => {
      const anchor = this.repository.findFlowAnchor(payload);
      return {
        ok: true,
        status: anchor ? 'found' : 'not-found',
        anchor
      };
    });
  }

  async bindFlowAnchor(payload = {}) {
    return this._run('bindFlowAnchor', async () => {
      const bound = this.repository.bindFlowAnchor(payload);
      return {
        ok: true,
        status: bound.created ? 'bound' : 'existing',
        created: bound.created,
        anchor: bound.anchor
      };
    });
  }

  async persistFlowBindIntent(payload = {}) {
    return this._run('persistFlowBindIntent', async () => {
      const persisted = this.repository.persistFlowBindIntent(payload);
      return {
        ok: true,
        status: persisted.resolved
          ? 'already-bound'
          : (persisted.created ? 'persisted' : 'existing'),
        ...persisted
      };
    });
  }

  async replayFlowBindIntents(payload = {}) {
    return this._run('replayFlowBindIntents', async () => {
      const replay = this.repository.replayFlowBindIntents(payload);
      if (replay.failed > 0) {
        const failure = replay.results.find((result) => !result.ok);
        return {
          ok: false,
          status: 'failed',
          code: failure && failure.code || 'ARCHIVE_FLOW_BIND_REPLAY_FAILED',
          message: failure && failure.message || 'flow-bind intent 重放失败',
          ...replay
        };
      }
      return { ok: true, status: 'replayed', ...replay };
    });
  }

  async persistTaskFlowBindIntent(payload = {}) {
    return this._run('persistTaskFlowBindIntent', async () => {
      const persisted = this.repository.persistTaskFlowBindIntent(payload);
      return {
        ok: true,
        status: persisted.resolved
          ? 'already-bound'
          : (persisted.created ? 'persisted' : 'existing'),
        ...persisted
      };
    });
  }

  async replayTaskFlowBindIntents(payload = {}) {
    return this._run('replayTaskFlowBindIntents', async () => {
      const replay = this.repository.replayTaskFlowBindIntents(payload);
      const failure = replay.results.find((result) => !result.ok);
      return replay.failed === 0
        ? { ok: true, status: 'replayed', ...replay }
        : {
            ok: false,
            status: 'failed',
            code: failure.code,
            message: failure.message,
            ...replay
          };
    });
  }

  async markBatchStatus(batchId, status) {
    return this._run('markBatchStatus', async () => {
      const batch = this.repository.updateBatchBusinessStatus(batchId, status);
      if (!batch) {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      return { ok: true, status: 'updated', batch };
    });
  }

  async recordFailure(batchId, failure = {}) {
    return this._run('recordFailure', async () => {
      const code = safeCode(failure.code, 'ARCHIVE_BATCH_FAILED');
      const message = failure.message
        ? String(failure.message).trim().slice(0, 512)
        : `批次存档失败（${code}）`;
      const batch = this.repository.recordBatchFailure(batchId, {
        code,
        message: message || `批次存档失败（${code}）`,
        sourceOperation: failure.sourceOperation
      });
      if (!batch) {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      return { ok: true, status: 'recorded', batch };
    });
  }

  async _statRegularFile(filePath, originalName) {
    let stat;
    try {
      stat = await this.fs.promises.stat(filePath);
    } catch (error) {
      throw new ArchiveOperationError(
        safeFailure(error, '读取', originalName).code,
        `文件“${safeName(originalName)}”无法读取`,
        { retryable: true }
      );
    }
    if (!stat.isFile()) {
      throw new ArchiveOperationError(
        'ARCHIVE_SOURCE_NOT_FILE',
        `文件“${safeName(originalName)}”不是普通文件`
      );
    }
    return stat;
  }

  async _stageSourceFile(
    filePath,
    originalName,
    expectedSnapshot = null,
    expectedSha256 = '',
    expectedSizeBytes = null
  ) {
    const before = await this._statRegularFile(filePath, originalName);
    const normalizedExpectedSha = String(expectedSha256 || '').toLowerCase();
    const hasExpectedSha = SHA256_RE.test(normalizedExpectedSha);
    const normalizedExpectedSize = Number(expectedSizeBytes);
    const hasExpectedSize = expectedSizeBytes !== null
      && expectedSizeBytes !== undefined
      && expectedSizeBytes !== ''
      && Number.isSafeInteger(normalizedExpectedSize)
      && normalizedExpectedSize >= 0;
    if (hasExpectedSha && hasExpectedSize && Number(before.size) !== normalizedExpectedSize) {
      throw new ArchiveOperationError(
        'ARCHIVE_SOURCE_CHANGED',
        `文件“${safeName(originalName)}”大小与业务解析时版本不一致，未写入存档`,
        { retryable: true }
      );
    }
    if (!hasExpectedSha
        && expectedSnapshot
        && !sourceSnapshotMatchesStat(expectedSnapshot, before)) {
      throw new ArchiveOperationError(
        'ARCHIVE_SOURCE_CHANGED',
        `文件“${safeName(originalName)}”在业务完成后发生变化，未写入存档，请恢复原文件后重试`,
        { retryable: true }
      );
    }
    const beforeSnapshot = sourceSnapshotFromStat(before);
    const stagedPath = path.join(this.stagingDir, `${crypto.randomUUID()}.part`);
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const hashingTransform = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      }
    });

    try {
      await this._assertManagedFilePath(`${STAGING_DIR_NAME}/${path.basename(stagedPath)}`, {
        includeLeaf: false,
        allowMissingRoot: !this.rootEstablished
      });
      await this.fs.promises.mkdir(this.stagingDir, { recursive: true });
      this.rootEstablished = true;
      await pipeline(
        this.fs.createReadStream(filePath),
        hashingTransform,
        this.fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 })
      );
      const after = await this._statRegularFile(filePath, originalName);
      if (sizeBytes !== Number(before.size)
          || !sourceSnapshotMatchesStat(beforeSnapshot, after)) {
        throw new ArchiveOperationError(
          'ARCHIVE_SOURCE_CHANGED',
          `文件“${safeName(originalName)}”在存档过程中发生变化，请重试`,
          { retryable: true }
        );
      }
      const sha256 = hash.digest('hex');
      if (hasExpectedSha && sha256 !== normalizedExpectedSha) {
        throw new ArchiveOperationError(
          'ARCHIVE_SOURCE_CHANGED',
          `文件“${safeName(originalName)}”内容与业务解析时版本不一致，未写入存档`,
          { retryable: true }
        );
      }
      return {
        stagedPath,
        sha256,
        sizeBytes
      };
    } catch (error) {
      try { await this.fs.promises.rm(stagedPath, { force: true }); } catch (_cleanupError) {}
      throw error;
    }
  }

  async _hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const stream = this.fs.createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    return { sha256: hash.digest('hex'), sizeBytes };
  }

  async _fileFingerprint(filePath) {
    const stat = await this.fs.promises.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ArchiveOperationError('ARCHIVE_FILE_INVALID', '存档文件不是普通文件');
    }
    const fingerprint = sourceSnapshotFromStat(stat);
    if (!fingerprint) {
      throw new ArchiveOperationError('ARCHIVE_FINGERPRINT_INVALID', '无法读取存档文件指纹');
    }
    return fingerprint;
  }

  async _assertExistingBlobFile(filePath, sha256, sizeBytes) {
    const stat = await this.fs.promises.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== sizeBytes) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_CONFLICT',
        `存档内容 ${sha256.slice(0, 12)} 的既有文件不一致`
      );
    }
    const actual = await this._hashFile(filePath);
    const finalStat = await this.fs.promises.lstat(filePath, { bigint: true });
    const sourceSnapshot = sourceSnapshotFromStat(stat);
    if (!sourceSnapshot || !sourceSnapshotMatchesStat(sourceSnapshot, finalStat)) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_CHANGED_DURING_READ',
        `存档内容 ${sha256.slice(0, 12)} 在校验期间发生变化`
      );
    }
    if (actual.sha256 !== sha256 || actual.sizeBytes !== sizeBytes) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_CONFLICT',
        `存档内容 ${sha256.slice(0, 12)} 的既有文件校验失败`
      );
    }
    return sourceSnapshotFromStat(finalStat);
  }

  async _publishStagedBlob(staged) {
    const relativePath = blobRelativePath(staged.sha256);
    const targetPath = await this._assertManagedFilePath(relativePath, { includeLeaf: false });
    const knownBlob = this.repository.findBlobByHash(staged.sha256);
    if (knownBlob
        && (knownBlob.relativePath !== relativePath || knownBlob.sizeBytes !== staged.sizeBytes)) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_METADATA_CONFLICT',
        `存档内容 ${staged.sha256.slice(0, 12)} 的元数据冲突`
      );
    }
    await this.fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    if (knownBlob) {
      try {
        const fingerprint = await this._assertExistingBlobFile(
          targetPath,
          staged.sha256,
          staged.sizeBytes
        );
        await this.fs.promises.rm(staged.stagedPath, { force: true });
        return { relativePath, targetPath, reused: true, fingerprint };
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) throw error;
      }
    } else {
      try {
        await this.fs.promises.lstat(targetPath);
        throw new ArchiveOperationError(
          'ARCHIVE_BLOB_UNKNOWN_CONFLICT',
          `存档内容 ${staged.sha256.slice(0, 12)} 的目标位置已有未知文件`
        );
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) throw error;
      }
    }

    try {
      await this._syncFile(staged.stagedPath);
      await this.fs.promises.rename(staged.stagedPath, targetPath);
      await this._syncDirectory(path.dirname(targetPath));
      return {
        relativePath,
        targetPath,
        reused: false,
        fingerprint: await this._fileFingerprint(targetPath)
      };
    } catch (error) {
      if (!knownBlob) throw error;
      try {
        const fingerprint = await this._assertExistingBlobFile(
          targetPath,
          staged.sha256,
          staged.sizeBytes
        );
        await this.fs.promises.rm(staged.stagedPath, { force: true });
        return { relativePath, targetPath, reused: true, fingerprint };
      } catch (_existingError) {
        throw error;
      }
    }
  }

  _ensureLayoutAssignmentUnlocked(artifactId) {
    const current = this.repository.getArtifact(artifactId);
    if (!current) throw new ArchiveOperationError('ARCHIVE_ARTIFACT_NOT_FOUND', '存档文件不存在');
    const batch = this.repository.getBatch(current.batchId);
    if (!batch) throw new ArchiveOperationError('ARCHIVE_BATCH_NOT_FOUND', '存档批次不存在');
    const artifacts = this.repository.ensureArtifactOrders(batch.id);
    const assignments = assignLayoutNames(this.rootDir, batch, artifacts);
    for (const assignment of assignments) {
      const artifact = artifacts.find((item) => item.id === assignment.artifactId);
      if (artifact
          && artifact.storageLayoutVersion === STORAGE_LAYOUT_VERSION
          && artifact.storageRelativePath
          && artifact.safeFileName
          && artifact.artifactOrder != null) {
        continue;
      }
      this.repository.prepareArtifactLayout(assignment.artifactId, assignment);
    }
    const artifact = this.repository.getArtifact(current.id);
    return {
      artifact,
      batch,
      assignment: {
        artifactId: artifact.id,
        artifactOrder: artifact.artifactOrder,
        safeFileName: artifact.safeFileName,
        storageRelativePath: artifact.storageRelativePath,
        storageLayoutVersion: STORAGE_LAYOUT_VERSION
      }
    };
  }

  async _invalidateBlobUnlocked(blob, failure) {
    const artifacts = this.repository.listArtifactsByBlob(blob.id);
    const invalidated = this.repository.invalidateBlob(blob.id, failure);
    const paths = [
      ...artifacts.map((artifact) => artifact.storageRelativePath).filter(Boolean),
      blob.relativePath
    ];
    const failures = [];
    for (const relativePath of [...new Set(paths)]) {
      try {
        await this.materializer.remove(relativePath);
      } catch (error) {
        failures.push({ code: safeFailure(error, '清理').code, item: relativePath });
      }
    }
    return { invalidated, failures };
  }

  _recordMaterializationFailureResult(artifact, error) {
    const failure = safeFailure(error, '目录化', artifact.originalName);
    const recorded = this.repository.recordMaterializationFailure(artifact.id, failure);
    return {
      ok: false,
      status: 'repair-pending',
      canonicalReady: true,
      artifact: publicArtifact(recorded ? recorded.artifact : artifact),
      batch: recorded ? recorded.batch : this.repository.getBatch(artifact.batchId),
      ...failure
    };
  }

  async _materializeArtifactUnlocked(artifactId) {
    let current = this.repository.getArtifact(artifactId);
    if (!current || current.status !== 'ready' || !current.blob) {
      return {
        ok: false,
        status: 'not-ready',
        code: 'ARCHIVE_ARTIFACT_NOT_READY',
        message: '存档文件尚未完成，无法目录化',
        artifact: publicArtifact(current)
      };
    }
    let prepared;
    try {
      prepared = this._ensureLayoutAssignmentUnlocked(current.id);
    } catch (error) {
      return this._recordMaterializationFailureResult(current, error);
    }
    current = prepared.artifact;
    const expected = {
      sha256: current.blob.sha256,
      sizeBytes: current.blob.sizeBytes
    };
    const canonicalPath = this._resolveManagedRelative(current.blob.relativePath);
    await this._assertManagedFilePath(current.blob.relativePath);
    const canonical = await verifyFile(canonicalPath, expected, this.fs);
    if (!canonical.valid) {
      if (!isFileIntegrityFailure(canonical)) {
        return this._recordMaterializationFailureResult(
          current,
          canonical.error || new ArchiveOperationError(
            'ARCHIVE_BLOB_READ_FAILED',
            'canonical Blob 暂时无法读取'
          )
        );
      }
      await this._invalidateBlobUnlocked(current.blob, {
        code: 'ARCHIVE_BLOB_INVALID',
        message: '存档文件大小或哈希不一致，可从可信源重试该文件'
      });
      return {
        ok: false,
        status: 'failed',
        code: 'ARCHIVE_BLOB_INVALID',
        message: '存档文件大小或哈希不一致，可从可信源重试该文件',
        artifact: publicArtifact(this.repository.getArtifact(current.id))
      };
    }

    try {
      const existing = await this.materializer.verify(
        prepared.assignment.storageRelativePath,
        expected
      );
      if (existing.valid) {
        const sharesCanonicalInode = canonical.stat.dev === existing.stat.dev
          && canonical.stat.ino === existing.stat.ino;
        if (!sharesCanonicalInode && current.storageMode !== 'hardlink') {
          const targetPath = this._resolveManagedRelative(prepared.assignment.storageRelativePath);
          await this.fs.promises.chmod(targetPath, 0o444);
          const completed = this.repository.completeMaterialization(current.id, {
            ...prepared.assignment,
            storageMode: 'copy',
            storageFingerprint: await this._fileFingerprint(targetPath)
          });
          return {
            ok: true,
            status: 'ready',
            repaired: current.storageLayoutVersion !== STORAGE_LAYOUT_VERSION
              || Boolean(current.materializationErrorCode)
              || current.storageMode !== 'copy',
            artifact: publicArtifact(completed.artifact),
            batch: completed.batch,
            storageMode: 'copy',
            filePath: targetPath
          };
        }
        // 历史 hardlink 在 canonical 仍可信时原地脱钩为独立 copy。
        await this.materializer.remove(prepared.assignment.storageRelativePath);
      }
      if (!existing.valid && existing.code !== 'ARCHIVE_LAYOUT_MISSING') {
        await this.materializer.remove(prepared.assignment.storageRelativePath);
      }

      const materialized = await this.materializer.materialize({
        artifactId: current.id,
        canonicalPath,
        storageRelativePath: prepared.assignment.storageRelativePath,
        sha256: expected.sha256,
        sizeBytes: expected.sizeBytes
      });
      const completed = this.repository.completeMaterialization(current.id, {
        ...prepared.assignment,
        storageMode: materialized.mode,
        storageFingerprint: await this._fileFingerprint(materialized.targetPath)
      });
      return {
        ok: true,
        status: 'ready',
        repaired: Boolean(current.materializationErrorCode),
        artifact: publicArtifact(completed.artifact),
        batch: completed.batch,
        storageMode: materialized.mode,
        filePath: materialized.targetPath
      };
    } catch (error) {
      return this._recordMaterializationFailureResult(current, error);
    }
  }

  async _archiveArtifactUnlocked(artifact, sourcePath, expectedEvidence = {}) {
    const originalName = artifact.originalName;
    const previouslyRegisteredSourcePath = artifact.sourcePath;
    let staged = null;
    try {
      const started = this.repository.startArtifactAttempt(artifact.id, {
        sourcePath,
        ...expectedEvidence
      });
      const archivedSourcePath = sourcePath || started.sourcePath;
      staged = await this._stageSourceFile(
        archivedSourcePath,
        originalName,
        started.metadata && started.metadata.sourceSnapshot,
        started.metadata && started.metadata.expectedSha256,
        started.metadata && (
          started.metadata.expectedSizeBytes
          ?? started.metadata.sourceSnapshot?.sizeBytes
        )
      );
      const published = await this._publishStagedBlob(staged);
      staged = null;
      const completed = this.repository.completeArtifact(artifact.id, {
        sha256: published.relativePath.split('/').pop(),
        sizeBytes: published.fingerprint.sizeBytes,
        relativePath: published.relativePath,
        fingerprint: published.fingerprint
      });
      await this._releaseSourcePaths([previouslyRegisteredSourcePath, archivedSourcePath]);
      const materialized = await this._materializeArtifactUnlocked(completed.artifact.id);
      return {
        ...materialized,
        artifact: materialized.artifact || publicArtifact(completed.artifact),
        batch: materialized.batch || this.repository.getBatch(completed.artifact.batchId),
        sha256: completed.blob.sha256,
        sizeBytes: completed.blob.sizeBytes,
        deduplicated: completed.deduplicated || published.reused,
        canonicalReady: true
      };
    } catch (error) {
      if (staged && staged.stagedPath) {
        try { await this.fs.promises.rm(staged.stagedPath, { force: true }); } catch (_cleanupError) {}
      }
      const failure = artifact.direction === 'output'
          && error
          && ['ENOENT', 'ARCHIVE_ENOENT'].includes(error.code)
        ? {
            code: 'ARCHIVE_OUTPUT_NOT_PRODUCED',
            message: '任务预期输出文件未形成可归档内容',
            retryable: false
          }
        : safeFailure(error, '存档', originalName);
      let recorded = null;
      try {
        recorded = this.repository.failArtifact(artifact.id, {
          ...failure,
          sourceOperation: artifact.sourceOperation
        });
      } catch (_metadataError) {
        // 物理失败与元数据失败都通过返回值显式报告，绝不向业务流程抛出。
      }
      return {
        ok: false,
        status: 'failed',
        artifact: publicArtifact(recorded ? recorded.artifact : this.repository.getArtifact(artifact.id)),
        batch: recorded ? recorded.batch : this.repository.getBatch(artifact.batchId),
        metadataRecorded: Boolean(recorded),
        ...failure
      };
    }
  }

  _prepareFileUnlocked(batchId, payload = {}) {
    const batch = this.repository.getBatch(batchId);
    if (!batch) {
      return { result: {
        ok: false,
        status: 'not-found',
        code: 'ARCHIVE_BATCH_NOT_FOUND',
        message: '存档批次不存在'
      } };
    }
    const filePath = path.resolve(String(payload.filePath || ''));
    const originalName = safeName(payload.originalName || filePath);
    const artifactKey = artifactKeyForFile(payload, filePath);
    const existingArtifact = this.repository.getArtifactByKey(batch.id, artifactKey);
    if (existingArtifact) {
      if (existingArtifact.status === 'ready' && existingArtifact.blob) {
        let expected;
        try {
          expected = normalizeExpectedFileEvidence(
            payload,
            originalName,
            normalizeSourceSnapshot(payload.sourceSnapshot)
          );
        } catch (error) {
          return { result: {
            ok: false,
            status: 'failed',
            artifact: publicArtifact(existingArtifact),
            batch,
            metadataRecorded: false,
            ...safeFailure(error, '核验', originalName)
          } };
        }
        const expectationConflict = (
          expected.hasExpectedSha256
          && String(existingArtifact.blob.sha256 || '').toLowerCase()
            !== expected.expectedSha256
        ) || (
          expected.hasExpectedSizeBytes
          && Number(existingArtifact.blob.sizeBytes) !== expected.expectedSizeBytes
        );
        if (expectationConflict) {
          return { result: {
            ok: false,
            status: 'conflict',
            code: 'ARCHIVE_READY_ARTIFACT_EXPECTATION_CONFLICT',
            message: `文件“${originalName}”的既有存档版本与本次业务证据不一致`,
            retryable: false,
            artifact: publicArtifact(existingArtifact),
            batch,
            metadataRecorded: false
          } };
        }
        return { artifact: existingArtifact, materializeOnly: true };
      }
      if (existingArtifact.status === 'failed') this.repository.beginBatchRetry(batch.id);
      return { artifact: existingArtifact, filePath };
    }
    let artifact;
    let artifactPayload = null;
    try {
      const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? { ...payload.metadata }
        : {};
      const sourceSnapshot = normalizeSourceSnapshot(payload.sourceSnapshot);
      if (sourceSnapshot) metadata.sourceSnapshot = sourceSnapshot;
      const expected = normalizeExpectedFileEvidence(payload, originalName, sourceSnapshot);
      if (expected.hasExpectedSha256) metadata.expectedSha256 = expected.expectedSha256;
      if (expected.hasExpectedSizeBytes) metadata.expectedSizeBytes = expected.expectedSizeBytes;
      artifactPayload = {
        artifactKey,
        direction: payload.direction || 'input',
        role: payload.role,
        sourceOperation: payload.sourceOperation,
        originalName,
        sourcePath: filePath,
        metadata
      };
      artifact = this.repository.addArtifact(batch.id, artifactPayload);
    } catch (error) {
      const failure = safeFailure(error, '登记', originalName);
      let recorded = null;
      if (artifactPayload) {
        try {
          recorded = this.repository.recordArtifactFailure(
            batch.id,
            artifactPayload,
            failure
          );
        } catch (_artifactMetadataError) {
          // failed artifact 无法持久化时，沿用 batch 级失败证据；controller 会转入 outbox。
        }
      }
      if (!recorded) {
        this.repository.recordBatchFailure(batch.id, {
          ...failure,
          sourceOperation: payload.sourceOperation
        });
      }
      return { result: {
        ok: false,
        status: 'failed',
        artifact: publicArtifact(recorded && recorded.artifact),
        batch: recorded ? recorded.batch : this.repository.getBatch(batch.id),
        metadataRecorded: true,
        ...failure
      } };
    }
    return { artifact, filePath };
  }

  async _attachFileUnlocked(batchId, payload = {}) {
    const prepared = this._prepareFileUnlocked(batchId, payload);
    if (prepared.result) return prepared.result;
    if (prepared.materializeOnly) {
      const materialized = await this._materializeArtifactUnlocked(prepared.artifact.id);
      return {
        ...materialized,
        alreadyArchived: true,
        sha256: prepared.artifact.blob.sha256,
        sizeBytes: prepared.artifact.blob.sizeBytes,
        deduplicated: true,
        canonicalReady: true
      };
    }
    return this._archiveArtifactUnlocked(prepared.artifact, prepared.filePath);
  }

  async attachFile(batchId, payload = {}) {
    return this._run('attachFile', async () => this._attachFileUnlocked(batchId, payload));
  }

  async _appendFilesUnlocked(batchId, payload = {}) {
    const batch = this.repository.getBatch(batchId);
    if (!batch) {
      return {
        ok: false,
        status: 'not-found',
        code: 'ARCHIVE_BATCH_NOT_FOUND',
        message: '存档批次不存在'
      };
    }
    if (batch.metadata && batch.metadata._fileManifest) {
      throw new ArchiveOperationError(
        'ARCHIVE_MANIFEST_ARTIFACT_UNKNOWN',
        'manifest v1 batch 只能按已登记 artifactKey settle'
      );
    }
    const files = Array.isArray(payload.files) ? payload.files : [];
    const preparedFiles = files.map((file) => {
      const spec = file && typeof file === 'object' ? file : { filePath: file };
      return this._prepareFileUnlocked(batch.id, {
        ...spec,
        sourceOperation: spec.sourceOperation || payload.sourceOperation,
        metadata: spec.metadata === undefined ? payload.metadata : spec.metadata
      });
    });
    const results = new Array(preparedFiles.length);
    for (let index = 0; index < preparedFiles.length; index += 1) {
      const prepared = preparedFiles[index];
      if (prepared.result) {
        results[index] = prepared.result;
      } else if (prepared.materializeOnly) {
        const materialized = await this._materializeArtifactUnlocked(prepared.artifact.id);
        results[index] = {
          ...materialized,
          alreadyArchived: true,
          sha256: prepared.artifact.blob.sha256,
          sizeBytes: prepared.artifact.blob.sizeBytes,
          deduplicated: true,
          canonicalReady: true
        };
      } else {
        results[index] = await this._archiveArtifactUnlocked(
          prepared.artifact,
          prepared.filePath
        );
      }
    }
    const current = this.repository.getBatch(batch.id);
    const succeeded = results.filter((result) => result.ok).length;
    return {
      ok: results.every((result) => result.ok),
      status: results.length === 0 ? 'nothing-to-append' : current.archiveStatus,
      batchId: batch.id,
      batch: current,
      attempted: results.length,
      succeeded,
      failed: results.length - succeeded,
      results
    };
  }

  async appendFiles(payload = {}) {
    return this._run('appendFiles', async () => (
      this._appendFilesUnlocked(payload.batchId, payload)
    ));
  }

  async archiveFile(payload = {}) {
    const sourceOperation = payload.sourceOperation || 'archiveFile';
    const created = await this.createBatch({
      ...payload,
      sourceOperation,
      files: [{ ...payload, sourceOperation }]
    });
    const first = created && Array.isArray(created.results) ? created.results[0] : null;
    return first
      ? { ...created, ...first, batch: created.batch }
      : created;
  }

  // main 可把单文件业务直接接到 stageFile；语义等同 archiveFile（建批次 + 附件）。
  async stageFile(payload = {}) {
    return this.archiveFile(payload);
  }

  async retryBatch(batchId, options = {}) {
    return this._run('retryBatch', async () => {
      const batch = this.repository.getBatch(batchId);
      if (!batch) {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      const failedArtifacts = this.repository.listFailedArtifacts(batch.id);
      const layoutArtifacts = this.repository.listArtifacts(batch.id).filter((artifact) => (
        artifact.status === 'ready'
        && (
          artifact.storageLayoutVersion !== STORAGE_LAYOUT_VERSION
          || !artifact.storageRelativePath
          || artifact.storageMode !== 'copy'
          || Boolean(artifact.materializationErrorCode)
        )
      ));
      if (failedArtifacts.length === 0 && layoutArtifacts.length === 0) {
        return {
          ok: batch.archiveStatus === 'complete',
          status: 'nothing-to-retry',
          batch: publicBatch(batch),
          attempted: 0,
          succeeded: 0,
          failed: 0
        };
      }
      if (failedArtifacts.length > 0) this.repository.beginBatchRetry(batch.id);
      const sourceOverrides = options.sourcePaths && typeof options.sourcePaths === 'object'
        ? options.sourcePaths
        : {};
      const results = [];
      for (const artifact of failedArtifacts) {
        const override = sourceOverrides[artifact.id] || sourceOverrides[artifact.artifactKey];
        const sourcePath = override ? path.resolve(String(override)) : artifact.sourcePath;
        results.push(await this._archiveArtifactUnlocked(artifact, sourcePath));
      }
      for (const artifact of layoutArtifacts) {
        results.push(await this._materializeArtifactUnlocked(artifact.id));
      }
      const current = this.repository.getBatch(batch.id);
      const succeeded = results.filter((result) => result.ok).length;
      return {
        ok: results.every((result) => result.ok),
        status: current.archiveStatus,
        batch: publicBatch(current),
        attempted: results.length,
        succeeded,
        failed: results.length - succeeded,
        results
      };
    });
  }

  async listBatches(filters = {}) {
    return this._run('listBatches', async () => ({
      ok: true,
      batches: this.repository.listVisibleBatches(filters).map(publicBatch)
    }));
  }

  async getBatch(batchId) {
    return this._run('getBatch', async () => {
      let detail = this.repository.getVisibleBatchDetail(batchId);
      if (detail) {
        for (const artifact of detail.artifacts) {
          if (artifact.status === 'ready' && artifact.blob) {
            await this._readyArtifact(artifact.id);
          }
        }
        detail = this.repository.getVisibleBatchDetail(batchId);
      }
      if (detail) {
        const related = this.repository.listVisibleRelatedBatchesForBatch(detail.id);
        detail.relatedBatches = related.length >= 2
          ? related.map(publicRelatedBatch)
          : [];
      }
      return detail
        ? { ok: true, batch: publicBatchDetail(detail) }
        : {
            ok: false,
            status: 'not-found',
            code: 'ARCHIVE_BATCH_NOT_FOUND',
            message: '存档批次不存在'
          };
    });
  }

  async setLocked(batchId, locked) {
    return this._run('setLocked', async () => {
      const batch = this.repository.setLocked(batchId, locked === true);
      return batch
        ? { ok: true, status: batch.locked ? 'locked' : 'unlocked', batch: publicBatch(batch) }
        : {
            ok: false,
            status: 'not-found',
            code: 'ARCHIVE_BATCH_NOT_FOUND',
            message: '存档批次不存在'
          };
    });
  }

  async setRetention(batchId, retention = {}) {
    return this._run('setRetention', async () => {
      const batch = this.repository.getBatch(batchId);
      if (!batch) {
        return {
          ok: false,
          status: 'not-found',
          code: 'ARCHIVE_BATCH_NOT_FOUND',
          message: '存档批次不存在'
        };
      }
      let retentionUntil = retention.retentionUntil;
      if (retentionUntil === undefined) {
        retentionUntil = retention.retentionDays === null || retention.retentionDays === 'permanent'
          ? null
          : addCalendarDays(batch.localDate, Number(retention.retentionDays));
      }
      return {
        ok: true,
        status: 'updated',
        batch: publicBatch(this.repository.setRetentionUntil(batch.id, retentionUntil))
      };
    });
  }

  async _removeReleasedBlobs(blobs) {
    const failures = [];
    let deletedBlobFiles = 0;
    let releasedBytes = 0;
    for (const blob of blobs) {
      let filePath;
      try {
        filePath = await this._assertManagedFilePath(blob.relativePath);
        await this.fs.promises.rm(filePath, { force: true });
        deletedBlobFiles += 1;
        releasedBytes += blob.sizeBytes;
      } catch (error) {
        failures.push({
          code: safeFailure(error, '删除').code,
          blob: blob.sha256.slice(0, 12),
          message: `内容 ${blob.sha256.slice(0, 12)} 的物理清理待重试`
        });
      }
    }
    return { deletedBlobFiles, releasedBytes, failures };
  }

  async _removeEmptyLayoutDirectories(job) {
    const failures = [];
    let current = this._resolveManagedRelative(job.layoutRelativeDir);
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        await this.fs.promises.rmdir(current);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          current = path.dirname(current);
          continue;
        }
        if (error && ['ENOTEMPTY', 'EEXIST'].includes(error.code)) break;
        failures.push({
          code: safeFailure(error, '清理空目录').code,
          item: job.batchNumber
        });
        break;
      }
      current = path.dirname(current);
    }
    return failures;
  }

  async _executeCleanupJobUnlocked(job) {
    const materializedFailures = [];
    let deletedMaterializedFiles = 0;
    let expectedRelativeDir = '';
    try {
      expectedRelativeDir = batchRelativeDirectory({
        localDate: job.localDate,
        batchNumber: job.batchNumber
      });
    } catch (_error) {
      expectedRelativeDir = '';
    }
    if (!expectedRelativeDir || job.layoutRelativeDir !== expectedRelativeDir) {
      const failure = {
        code: 'ARCHIVE_CLEANUP_PATH_INVALID',
        item: job.batchNumber
      };
      this.repository.recordCleanupJobFailure(job.id, {
        code: failure.code,
        message: `批次 ${job.batchNumber} 的清理路径证据无效`
      });
      return {
        ok: false,
        status: 'cleanup-pending',
        deletedMaterializedFiles: 0,
        deletedBlobFiles: 0,
        releasedBytes: 0,
        failures: [failure]
      };
    }
    const layoutPrefix = `${job.layoutRelativeDir}/`;
    for (const relativePath of job.materializedPaths) {
      if (!String(relativePath).startsWith(layoutPrefix)) {
        materializedFailures.push({
          code: 'ARCHIVE_CLEANUP_PATH_INVALID',
          item: job.batchNumber
        });
        continue;
      }
      try {
        await this.materializer.remove(relativePath);
        deletedMaterializedFiles += 1;
      } catch (error) {
        materializedFailures.push({
          code: safeFailure(error, '清理目录文件').code,
          item: job.batchNumber
        });
      }
    }
    if (materializedFailures.length > 0) {
      this.repository.recordCleanupJobFailure(job.id, {
        code: materializedFailures[0].code,
        message: `批次 ${job.batchNumber} 的目录文件清理待重试`
      });
      return {
        ok: false,
        status: 'cleanup-pending',
        deletedMaterializedFiles,
        deletedBlobFiles: 0,
        releasedBytes: 0,
        failures: materializedFailures
      };
    }

    const directoryFailures = await this._removeEmptyLayoutDirectories(job);
    const physical = await this._removeReleasedBlobs(job.releasedBlobs);
    const failures = [...directoryFailures, ...physical.failures];
    if (failures.length > 0) {
      this.repository.recordCleanupJobFailure(job.id, {
        code: failures[0].code,
        message: `批次 ${job.batchNumber} 的物理清理待重试`
      });
      return {
        ok: false,
        status: 'cleanup-pending',
        deletedMaterializedFiles,
        ...physical,
        failures
      };
    }
    this.repository.completeCleanupJob(job.id);
    return {
      ok: true,
      status: 'cleaned',
      deletedMaterializedFiles,
      ...physical,
      failures: []
    };
  }

  async _processCleanupJobsUnlocked() {
    const results = [];
    for (const job of this.repository.listCleanupJobs()) {
      results.push(await this._executeCleanupJobUnlocked(job));
    }
    return results;
  }

  async _deleteBatchUnlocked(batchId, options = {}) {
    const sourcePaths = this.repository.listArtifacts(batchId)
      .map((artifact) => artifact.sourcePath)
      .filter(Boolean);
    const deleted = this.repository.deleteBatch(batchId, {
      allowLocked: options.force === true
    });
    if (deleted.status === 'not-found') {
      return {
        ok: false,
        status: 'not-found',
        code: 'ARCHIVE_BATCH_NOT_FOUND',
        message: '存档批次不存在'
      };
    }
    if (deleted.status === 'locked') {
      return {
        ok: false,
        status: 'locked',
        code: 'ARCHIVE_BATCH_LOCKED',
        message: '批次已锁定，请先解除锁定',
        batch: deleted.batch
      };
    }
    if (deleted.status === 'active') {
      return {
        ok: false,
        status: 'active',
        code: 'ARCHIVE_BATCH_ACTIVE',
        message: '批次任务仍在执行，暂不能删除',
        batch: deleted.batch
      };
    }
    if (deleted.status === 'business-held') {
      return {
        ok: false,
        status: 'business-held',
        code: 'ARCHIVE_BATCH_BUSINESS_HELD',
        message: '批次输入文件仍被当前有效业务数据引用，不能解锁或删除',
        batch: deleted.batch,
        artifactIds: deleted.artifactIds
      };
    }
    await this._releaseSourcePaths(sourcePaths);
    const physical = deleted.cleanupJob
      ? await this._executeCleanupJobUnlocked(deleted.cleanupJob)
      : {
          ok: true,
          deletedMaterializedFiles: 0,
          deletedBlobFiles: 0,
          releasedBytes: 0,
          failures: []
        };
    return {
      ok: physical.ok,
      status: physical.ok ? 'deleted' : 'deleted-cleanup-pending',
      metadataDeleted: true,
      batchId: Number(batchId),
      artifactCount: deleted.artifactCount,
      logicalBytes: deleted.logicalBytes,
      releasedBlobCount: deleted.releasedBlobs.length,
      releasedBytes: physical.releasedBytes,
      deletedMaterializedFiles: physical.deletedMaterializedFiles,
      failures: physical.failures
    };
  }

  async deleteBatch(batchId, options = {}) {
    return this._run('deleteBatch', async () => this._deleteBatchUnlocked(batchId, options));
  }

  async cleanupExpired(options = {}) {
    return this._run('cleanupExpired', async () => {
      const asOfLocalDate = options.asOfLocalDate || localDateOf(options.now || this.now());
      const expired = this.repository.listExpiredBatches(asOfLocalDate);
      const results = [];
      for (const batch of expired) {
        results.push(await this._deleteBatchUnlocked(batch.id));
      }
      return {
        ok: results.every((result) => result.ok),
        status: results.some((result) => !result.ok) ? 'partial' : 'complete',
        asOfLocalDate,
        candidateCount: expired.length,
        deletedBatchCount: results.filter((result) => result.metadataDeleted).length,
        releasedBlobCount: results.reduce((sum, result) => sum + (result.releasedBlobCount || 0), 0),
        releasedBytes: results.reduce((sum, result) => sum + (result.releasedBytes || 0), 0),
        results
      };
    });
  }

  async getStats() {
    return this._run('getStats', async () => ({
      ok: true,
      stats: this.repository.getVisibleStats()
    }));
  }

  async _readyArtifact(artifactId) {
    let artifact = this.repository.getArtifact(artifactId);
    if (!artifact) {
      return {
        ok: false,
        code: 'ARCHIVE_ARTIFACT_NOT_FOUND',
        message: '存档文件不存在'
      };
    }
    if (artifact.status !== 'ready' || !artifact.blob) {
      return {
        ok: false,
        code: 'ARCHIVE_ARTIFACT_NOT_READY',
        message: '存档文件尚未完成，无法读取',
        artifact: publicArtifact(artifact)
      };
    }
    const expected = { sha256: artifact.blob.sha256, sizeBytes: artifact.blob.sizeBytes };
    if (artifact.storageLayoutVersion === STORAGE_LAYOUT_VERSION
        && artifact.storageRelativePath
        && artifact.storageMode === 'copy') {
      try {
        const layout = await this.materializer.verify(artifact.storageRelativePath, expected);
        if (layout.valid) {
          if (artifact.materializationErrorCode) {
            const completed = this.repository.completeMaterialization(artifact.id, {
              storageRelativePath: artifact.storageRelativePath,
              storageMode: artifact.storageMode,
              safeFileName: artifact.safeFileName,
              artifactOrder: artifact.artifactOrder,
              storageFingerprint: await this._fileFingerprint(
                this._resolveManagedRelative(artifact.storageRelativePath)
              )
            });
            artifact = completed.artifact;
          }
          return {
            ok: true,
            artifact,
            filePath: this._resolveManagedRelative(artifact.storageRelativePath)
          };
        }
        this.repository.recordMaterializationFailure(artifact.id, {
          code: layout.code,
          message: '目录化文件缺失或损坏，等待从 canonical Blob 修复'
        });
      } catch (error) {
        const failure = safeFailure(error, '校验目录文件', artifact.originalName);
        this.repository.recordMaterializationFailure(artifact.id, failure);
      }
    }

    const canonicalPath = this._resolveManagedRelative(artifact.blob.relativePath);
    await this._assertManagedFilePath(artifact.blob.relativePath);
    const canonical = await verifyFile(canonicalPath, expected, this.fs);
    if (!canonical.valid) {
      if (!isFileIntegrityFailure(canonical)) {
        const failure = safeFailure(
          canonical.error || new ArchiveOperationError(
            'ARCHIVE_BLOB_READ_FAILED',
            'canonical Blob 暂时无法读取'
          ),
          '读取',
          artifact.originalName
        );
        return { ok: false, artifact: publicArtifact(artifact), ...failure };
      }
      await this._invalidateBlobUnlocked(artifact.blob, {
        code: 'ARCHIVE_BLOB_INVALID',
        message: '存档文件缺失或损坏，可从可信源重试该文件'
      });
      return {
        ok: false,
        code: 'ARCHIVE_BLOB_INVALID',
        message: '存档文件缺失或损坏，可从可信源重试该文件',
        artifact: publicArtifact(this.repository.getArtifact(artifact.id))
      };
    }
    const repaired = await this._materializeArtifactUnlocked(artifact.id);
    if (repaired.ok) {
      artifact = this.repository.getArtifact(artifact.id);
      return { ok: true, artifact, filePath: repaired.filePath };
    }
    artifact = this.repository.getArtifact(artifact.id);
    return {
      ok: true,
      artifact,
      filePath: canonicalPath,
      repairPending: true
    };
  }

  async resolveVerifiedArtifact(artifactId) {
    return this._run('resolveVerifiedArtifact', async () => {
      const ready = await this._readyArtifact(artifactId);
      if (!ready.ok) return ready;
      return {
        ok: true,
        artifactId: Number(ready.artifact.id),
        filePath: ready.filePath,
        sha256: ready.artifact.blob.sha256,
        sizeBytes: ready.artifact.blob.sizeBytes,
        originalName: ready.artifact.originalName,
        repairPending: ready.repairPending === true
      };
    });
  }

  async openReadonlyCopy(artifactId, options = {}) {
    return this._run('openReadonlyCopy', async () => {
      const ready = await this._readyArtifact(artifactId);
      if (!ready.ok) return ready;
      const copyDir = path.join(this.readonlyDir, crypto.randomUUID());
      const targetPath = path.join(copyDir, safeName(ready.artifact.originalName));
      const tempPath = `${targetPath}.tmp`;
      try {
        await this._assertManagedFilePath(
          `${READONLY_DIR_NAME}/${path.basename(copyDir)}/${path.basename(targetPath)}`,
          { includeLeaf: false }
        );
        await this.fs.promises.mkdir(copyDir, { recursive: true });
        await pipeline(
          this.fs.createReadStream(ready.filePath),
          this.fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o400 })
        );
        await this.fs.promises.rename(tempPath, targetPath);
        await this.fs.promises.chmod(targetPath, 0o400);
        const opener = options.opener || this.opener;
        let opened = false;
        if (opener) {
          const openResult = await opener(targetPath);
          if (typeof openResult === 'string' && openResult) {
            return {
              ok: false,
              status: 'copy-ready-open-failed',
              code: 'ARCHIVE_OPEN_FAILED',
              message: `只读副本“${safeName(ready.artifact.originalName)}”已生成，但打开失败`,
              filePath: targetPath,
              artifact: publicArtifact(ready.artifact)
            };
          }
          opened = true;
        }
        return {
          ok: true,
          status: opened ? 'opened' : 'copy-ready',
          opened,
          filePath: targetPath,
          artifact: publicArtifact(ready.artifact)
        };
      } catch (error) {
        try { await this.fs.promises.rm(copyDir, { recursive: true, force: true }); } catch (_cleanupError) {}
        return {
          ok: false,
          status: 'failed',
          ...safeFailure(error, '生成只读副本', ready.artifact.originalName)
        };
      }
    });
  }

  async saveAs(artifactId, targetOrOptions) {
    return this._run('saveAs', async () => {
      const ready = await this._readyArtifact(artifactId);
      if (!ready.ok) return ready;
      const rawTarget = typeof targetOrOptions === 'string'
        ? targetOrOptions
        : targetOrOptions && targetOrOptions.targetPath;
      if (!rawTarget) {
        return {
          ok: false,
          code: 'ARCHIVE_SAVE_TARGET_REQUIRED',
          message: '另存副本缺少目标路径'
        };
      }
      const targetPath = path.resolve(String(rawTarget));
      if (isPathInside(this.rootDir, targetPath)) {
        return {
          ok: false,
          code: 'ARCHIVE_SAVE_TARGET_INVALID',
          message: '另存目标不能位于存档中心内部'
        };
      }
      const targetDir = path.dirname(targetPath);
      const nonce = crypto.randomUUID();
      const stagedPath = path.join(targetDir, `.archive-save-${nonce}.tmp`);
      const backupPath = path.join(targetDir, `.archive-save-${nonce}.bak`);
      let backupCreated = false;
      try {
        await this.fs.promises.mkdir(targetDir, { recursive: true });
        const [realRoot, realTargetDir] = await Promise.all([
          this.fs.promises.realpath(this.rootDir),
          this.fs.promises.realpath(targetDir)
        ]);
        if (isPathInside(realRoot, path.join(realTargetDir, path.basename(targetPath)))) {
          throw new ArchiveOperationError(
            'ARCHIVE_SAVE_TARGET_INVALID',
            '另存目标不能通过目录链接指向存档中心内部'
          );
        }
        try {
          const targetStat = await this.fs.promises.lstat(targetPath);
          if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
            throw new ArchiveOperationError(
              'ARCHIVE_SAVE_TARGET_INVALID',
              '另存目标不是可覆盖的普通文件'
            );
          }
        } catch (error) {
          if (!(error && error.code === 'ENOENT')) throw error;
        }
        await pipeline(
          this.fs.createReadStream(ready.filePath),
          this.fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 })
        );
        try {
          await this.fs.promises.rename(targetPath, backupPath);
          backupCreated = true;
        } catch (error) {
          if (!(error && error.code === 'ENOENT')) throw error;
        }
        await this.fs.promises.rename(stagedPath, targetPath);
      } catch (error) {
        try { await this.fs.promises.rm(stagedPath, { force: true }); } catch (_cleanupError) {}
        if (backupCreated) {
          try {
            await this.fs.promises.rm(targetPath, { force: true });
            await this.fs.promises.rename(backupPath, targetPath);
            backupCreated = false;
          } catch (_restoreError) {
            return {
              ok: false,
              status: 'restore-failed',
              code: 'ARCHIVE_SAVE_RESTORE_FAILED',
              message: `副本“${safeName(targetPath)}”另存失败，原目标恢复失败`,
              recoveryPath: backupPath
            };
          }
        }
        return {
          ok: false,
          status: 'failed',
          ...safeFailure(error, '另存', safeName(targetPath))
        };
      }

      const warnings = [];
      if (backupCreated) {
        try {
          await this.fs.promises.rm(backupPath, { force: true });
        } catch (_error) {
          warnings.push('新副本已保存，但旧目标备份清理待重试');
        }
      }
      return {
        ok: true,
        status: 'saved',
        filePath: targetPath,
        artifact: publicArtifact(ready.artifact),
        warnings
      };
    });
  }

  async _cleanupManagedDirectory(directory, label) {
    let names;
    try {
      await this._assertManagedFilePath(`${label}/.guard`, { includeLeaf: false });
      names = await this.fs.promises.readdir(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { removed: 0, failures: [] };
      return {
        removed: 0,
        failures: [{ code: safeFailure(error, '扫描').code, item: label }]
      };
    }
    const pathHashes = [];
    for (const name of names) {
      pathHashes.push(crypto.createHash('sha256')
        .update(`${label}/${String(name)}`)
        .digest('hex'));
    }
    return { removed: 0, reported: names.length, pathHashes, failures: [] };
  }

  async _listPhysicalBlobFiles() {
    const files = [];
    let prefixes;
    try {
      prefixes = await this.fs.promises.readdir(this.blobRoot);
    } catch (error) {
      if (error && error.code === 'ENOENT') return files;
      throw error;
    }
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const prefixDir = path.join(this.blobRoot, prefix);
      let names;
      try {
        names = await this.fs.promises.readdir(prefixDir);
      } catch (_error) {
        continue;
      }
      for (const name of names) {
        if (!SHA256_RE.test(name) || !name.startsWith(prefix)) continue;
        files.push({
          sha256: name,
          relativePath: `${BLOB_ROOT_PARTS.join('/')}/${prefix}/${name}`,
          filePath: path.join(prefixDir, name)
        });
      }
    }
    return files;
  }

  async _reconcileStartupUnlocked(options = {}) {
    const failures = [];
    const staging = await this._cleanupManagedDirectory(this.stagingDir, STAGING_DIR_NAME);
    const readonly = await this._cleanupManagedDirectory(this.readonlyDir, READONLY_DIR_NAME);
    failures.push(...staging.failures, ...readonly.failures);
    const cleanupResults = await this._processCleanupJobsUnlocked();
    for (const result of cleanupResults) failures.push(...result.failures);

    const interrupted = this.repository.markInterruptedArtifacts();
    const dangling = this.repository.repairDanglingArtifactReferences();
    const danglingPhysical = await this._removeReleasedBlobs(dangling.releasedBlobs);
    failures.push(...danglingPhysical.failures);

    let removedUnreferencedBlobRecords = 0;
    let invalidBlobCount = 0;
    const drainAllMetadata = options.verifyHashes === true
      || options.drainMaterializationCandidates === true;
    let blobVerificationCursor = 0;
    let blobVerificationRemaining = 0;
    let blobVerificationBudget = drainAllMetadata
      ? Number.POSITIVE_INFINITY
      : this.startupMaterializationBatchSize;
    do {
      const blobChunk = await this._verifyBlobChunkUnlocked({
        afterBlobId: blobVerificationCursor,
        limit: drainAllMetadata
          ? MAX_MATERIALIZATION_BATCH_SIZE
          : Math.min(MAX_MATERIALIZATION_BATCH_SIZE, blobVerificationBudget),
        verifyHashes: options.verifyHashes === true
      });
      blobVerificationCursor = blobChunk.cursor;
      blobVerificationRemaining = blobChunk.remaining;
      invalidBlobCount += blobChunk.invalidBlobCount;
      removedUnreferencedBlobRecords += blobChunk.removedUnreferencedBlobRecords;
      failures.push(...blobChunk.failures);
      if (!drainAllMetadata) blobVerificationBudget -= blobChunk.fetched;
      if (blobChunk.fetched === 0) break;
    } while (blobVerificationRemaining > 0 && blobVerificationBudget > 0);

    let materializedArtifactCount = 0;
    let materializationProcessedCount = 0;
    let materializationFailureCount = 0;
    const drainAllMaterializationCandidates = options.verifyHashes === true
      || options.drainMaterializationCandidates === true;
    let remainingForegroundBudget = drainAllMaterializationCandidates
      ? Number.POSITIVE_INFINITY
      : this.startupMaterializationBatchSize;
    const attemptedMaterializationIds = new Set();
    let materializedCursor = 0;
    let materializationScanCursor = 0;
    let materializationScanExhausted = false;
    while (remainingForegroundBudget > 0) {
      const scanLimit = drainAllMaterializationCandidates
        ? MAX_MATERIALIZATION_BATCH_SIZE
        : Math.min(MAX_MATERIALIZATION_BATCH_SIZE, remainingForegroundBudget);
      const scan = await this._verifyMaterializedArtifactChunkUnlocked({
        afterArtifactId: materializationScanCursor,
        limit: scanLimit,
        verifyHashes: options.verifyHashes === true,
        repairInvalid: true
      });
      materializationScanCursor = scan.cursor;
      materializationProcessedCount += scan.processed;
      materializedArtifactCount += scan.succeeded;
      materializationFailureCount += scan.failures.length;
      failures.push(...scan.failures);
      for (const artifactId of scan.attemptedIds) attemptedMaterializationIds.add(artifactId);
      if (!drainAllMaterializationCandidates) {
        remainingForegroundBudget -= scan.scanned;
      }
      if (scan.fetched === 0 || scan.fetched < scanLimit) {
        materializationScanExhausted = true;
        break;
      }
    }
    let materializationCursor = 0;
    while (remainingForegroundBudget > 0) {
      const chunk = await this._materializeCandidateChunkUnlocked(
        materializationCursor,
        drainAllMaterializationCandidates
          ? MAX_MATERIALIZATION_BATCH_SIZE
          : Math.min(MAX_MATERIALIZATION_BATCH_SIZE, remainingForegroundBudget),
        attemptedMaterializationIds
      );
      materializationCursor = chunk.cursor;
      if (materializationScanExhausted) {
        materializationScanCursor = Math.max(materializationScanCursor, chunk.cursor);
      }
      materializationProcessedCount += chunk.processed;
      materializedArtifactCount += chunk.succeeded;
      materializationFailureCount += chunk.failures.length;
      failures.push(...chunk.failures);
      remainingForegroundBudget -= chunk.processed;
      if (chunk.fetched === 0) break;
      if (drainAllMaterializationCandidates) continue;
      if (remainingForegroundBudget <= 0) break;
    }
    const materializationRemaining = this._countMaterializationWorkRemaining(
      materializationScanCursor
    );

    let removedOrphanBlobFiles = 0;
    let orphanBlobPrefixes = await this._listPhysicalBlobPrefixes();
    let orphanBlobPrefixCursor = 0;
    if (options.verifyHashes === true || options.drainMaterializationCandidates === true) {
      const pendingCleanupPaths = this.repository.listCleanupJobs()
        .flatMap((job) => job.releasedBlobs.map((blob) => blob.relativePath));
      const referencedPaths = new Set([
        ...this.repository.listBlobs().map((blob) => blob.relativePath),
        ...pendingCleanupPaths
      ]);
      const physicalFiles = await this._listPhysicalBlobFiles();
      for (const file of physicalFiles) {
        if (referencedPaths.has(file.relativePath)) continue;
        // 全量强校验也不能把“文件名像 SHA”升格为所有权证据。
        // 只报告数量；具体路径不进入返回 DTO/日志。
        removedOrphanBlobFiles += 0;
      }
      orphanBlobPrefixCursor = orphanBlobPrefixes.length;
    }

    return {
      removedStagingEntries: staging.removed,
      removedReadonlyEntries: readonly.removed,
      cleanupJobCount: cleanupResults.length,
      interruptedArtifactCount: interrupted.artifactCount,
      repairedArtifactCount: dangling.artifactCount,
      materializedArtifactCount,
      materializationProcessedCount,
      materializationFailureCount,
      materializationCursor,
      materializationScanCursor,
      materializationRemaining,
      blobVerificationCursor,
      blobVerificationRemaining,
      orphanBlobPrefixes,
      orphanBlobPrefixCursor,
      invalidBlobCount,
      removedUnreferencedBlobRecords,
      removedOrphanBlobFiles,
      failures
    };
  }

  async recoverStartupSafety() {
    return this._run('recoverStartupSafety', async () => {
      // 启动 admission 只允许收口数据库内的 interrupted 状态。任何目录扫描、
      // cleanup journal、dangling/blob 修复或物理删除都由 PR4 首进维护接管；
      // 未知 staging/readonly 项没有 durable owner 时尤其不得删除。
      const interrupted = this.repository.markInterruptedArtifacts();
      return {
        ok: true,
        status: 'complete',
        interruptedArtifactCount: interrupted.artifactCount,
        deferredPhysicalRecovery: true
      };
    });
  }

  async runBlobMetadataMaintenance(options = {}) {
    let cursor = this.entryMaintenanceCursors.blobMetadata;
    let processed = 0;
    let failures = 0;
    while (true) {
      const chunkResult = await this._run('runBlobMetadataMaintenancePage', () => (
        this._verifyBlobChunkUnlocked({
          afterBlobId: cursor,
          limit: this.startupMaterializationBatchSize,
          verifyHashes: false
        })
      ));
      if (!chunkResult || chunkResult.ok === false) return chunkResult;
      const chunk = chunkResult;
      if (chunk.failures.length > 0) {
        return {
          ok: false,
          status: 'partial',
          code: chunk.failures[0].code || 'ARCHIVE_BLOB_METADATA_FAILED',
          processed,
          cursor,
          remaining: this._countBlobsAfter(cursor),
          failures: chunk.failures
        };
      }
      cursor = chunk.cursor;
      this.entryMaintenanceCursors.blobMetadata = cursor;
      processed += chunk.fetched;
      failures += chunk.failures.length;
      if (typeof options.onProgress === 'function') {
        options.onProgress({ processed, remaining: chunk.remaining });
      }
      if (chunk.fetched === 0 || chunk.remaining === 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.entryMaintenanceCursors.blobMetadata = 0;
    return {
      ok: failures === 0,
      status: failures === 0 ? 'complete' : 'partial',
      processed,
      cursor,
      failures
    };
  }

  async runArtifactMetadataMaintenance(options = {}) {
    let cursor = this.entryMaintenanceCursors.artifactMetadata;
    let processed = 0;
    let failures = 0;
    while (true) {
      const chunkResult = await this._run('runArtifactMetadataMaintenancePage', () => (
        this._verifyMaterializedArtifactChunkUnlocked({
          afterArtifactId: cursor,
          limit: this.startupMaterializationBatchSize,
          verifyHashes: false,
          repairInvalid: false
        })
      ));
      if (!chunkResult || chunkResult.ok === false) return chunkResult;
      const chunk = chunkResult;
      if (chunk.failures.length > 0) {
        return {
          ok: false,
          status: 'partial',
          code: chunk.failures[0].code || 'ARCHIVE_ARTIFACT_METADATA_FAILED',
          processed,
          cursor,
          remaining: this._countMaterializedArtifactsAfter(cursor),
          failures: chunk.failures
        };
      }
      cursor = chunk.cursor;
      this.entryMaintenanceCursors.artifactMetadata = cursor;
      processed += chunk.fetched;
      failures += chunk.failures.length;
      const remaining = this._countMaterializedArtifactsAfter(cursor);
      if (typeof options.onProgress === 'function') options.onProgress({ processed, remaining });
      if (chunk.fetched === 0 || remaining === 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.entryMaintenanceCursors.artifactMetadata = 0;
    return { ok: failures === 0, status: failures === 0 ? 'complete' : 'partial', processed, failures };
  }

  async runLayoutMaterializationMaintenance(options = {}) {
    let cursor = this.entryMaintenanceCursors.layoutMaterialization;
    let processed = 0;
    let succeeded = 0;
    const failures = [];
    while (true) {
      const chunkResult = await this._run('runLayoutMaterializationMaintenancePage', () => (
        this._materializeCandidateChunkUnlocked(
          cursor,
          this.startupMaterializationBatchSize
        )
      ));
      if (!chunkResult || chunkResult.ok === false) return chunkResult;
      const chunk = chunkResult;
      if (chunk.failures.length > 0) {
        return {
          ok: false,
          status: 'partial',
          code: chunk.failures[0].code || 'ARCHIVE_LAYOUT_MATERIALIZATION_FAILED',
          processed,
          succeeded,
          cursor,
          remaining: this._countMaterializationCandidates(),
          failures: chunk.failures
        };
      }
      cursor = chunk.cursor;
      this.entryMaintenanceCursors.layoutMaterialization = cursor;
      processed += chunk.processed;
      succeeded += chunk.succeeded;
      failures.push(...chunk.failures);
      const remaining = this._countMaterializationCandidates();
      if (typeof options.onProgress === 'function') options.onProgress({ processed, remaining });
      if (chunk.fetched === 0 || remaining === 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.entryMaintenanceCursors.layoutMaterialization = 0;
    return {
      ok: failures.length === 0,
      status: failures.length === 0 ? 'complete' : 'partial',
      processed,
      succeeded,
      failures
    };
  }

  async runOwnedOrphanCleanup() {
    const jobs = this.repository.listCleanupJobs();
    const results = [];
    for (const job of jobs) {
      const result = await this._run('runOwnedOrphanCleanupPage', () => (
        this._executeCleanupJobUnlocked(job)
      ));
      results.push(result);
      if (!result || result.ok === false) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      ok: results.every((result) => result && result.ok),
      status: results.every((result) => result && result.ok) ? 'complete' : 'partial',
      processed: results.length,
      results
    };
  }

  async runHistoricalHealthScan() {
    const transient = await this._run('runHistoricalHealthScanTransient', async () => {
      const staging = await this._cleanupManagedDirectory(this.stagingDir, STAGING_DIR_NAME);
      const readonly = await this._cleanupManagedDirectory(this.readonlyDir, READONLY_DIR_NAME);
      return { staging, readonly, prefixes: await this._listPhysicalBlobPrefixes() };
    });
    if (!transient || transient.ok === false) return transient;
    const transientFailures = [
      ...(transient.staging.failures || []),
      ...(transient.readonly.failures || [])
    ];
    if (transientFailures.length > 0) {
      return {
        ok: false,
        status: 'partial',
        code: transientFailures[0].code || 'ARCHIVE_TRANSIENT_SCAN_FAILED',
        processed: 0,
        failures: transientFailures
      };
    }
    let unknownBlobCount = 0;
    for (const prefix of transient.prefixes) {
      const result = await this._run('runHistoricalHealthScanPrefix', () => (
        this._scanOrphanBlobPrefixUnlocked(prefix)
      ));
      if (!result || result.ok === false) return result;
      if (Array.isArray(result.failures) && result.failures.length > 0) {
        return {
          ok: false,
          status: 'partial',
          code: result.failures[0].code || 'ARCHIVE_BLOB_PREFIX_SCAN_FAILED',
          processed: unknownBlobCount,
          failures: result.failures
        };
      }
      unknownBlobCount += Number(result.reported) || 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      ok: true,
      status: 'complete',
      unknownTransientCount: (transient.staging.reported || 0) + (transient.readonly.reported || 0),
      unknownBlobCount
    };
  }

  async runRetentionMaintenance(options = {}) {
    const asOfLocalDate = options.asOfLocalDate || localDateOf(options.now || this.now());
    const deletedBatchIds = [];
    const results = [];
    while (true) {
      const page = await this._run('runRetentionMaintenancePage', async () => {
        const candidates = this.repository.listExpiredBatches(asOfLocalDate)
          .slice(0, this.startupMaterializationBatchSize);
        const pageResults = [];
        for (const batch of candidates) {
          pageResults.push(await this._deleteBatchUnlocked(batch.id));
        }
        return { candidates, pageResults };
      });
      if (!page || page.ok === false) return page;
      results.push(...page.pageResults);
      deletedBatchIds.push(...page.pageResults
        .filter((result) => result.metadataDeleted)
        .map((result) => Number(result.batchId)));
      const failedPageResult = page.pageResults.find((result) => !result || result.ok === false);
      if (failedPageResult) {
        return {
          ok: false,
          status: 'partial',
          code: failedPageResult.code || 'ARCHIVE_RETENTION_FAILED',
          processed: results.length,
          deletedBatchIds,
          results
        };
      }
      if (typeof options.onProgress === 'function') {
        options.onProgress({ processed: results.length, remaining: page.candidates.length === this.startupMaterializationBatchSize ? 1 : 0 });
      }
      if (page.candidates.length < this.startupMaterializationBatchSize) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      ok: results.every((result) => result.ok),
      status: results.every((result) => result.ok) ? 'complete' : 'partial',
      processed: results.length,
      deletedBatchIds,
      results
    };
  }

  async reconcileStartup(options = {}) {
    return this._run('reconcileStartup', async () => {
      const consistency = await this._reconcileStartupUnlocked({
        verifyHashes: options.verifyHashes === true
      });
      return {
        ok: consistency.failures.length === 0,
        status: consistency.failures.length === 0 ? 'complete' : 'partial',
        consistency
      };
    });
  }

  async markInterruptedTasks(options = {}) {
    return this._run('markInterruptedTasks', async () => ({
      ok: true,
      status: 'complete',
      ...this.repository.markInterruptedTasks({
        excludeBatchIds: options.excludeBatchIds,
        excludeTaskRunIds: options.excludeTaskRunIds
      })
    }));
  }
}

function createArchiveService(options = {}) {
  return new ArchiveService(options);
}

module.exports = {
  ArchiveOperationError,
  ArchiveService,
  BLOB_ROOT_PARTS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE,
  MAX_MATERIALIZATION_BATCH_SIZE,
  READONLY_DIR_NAME,
  STAGING_DIR_NAME,
  addCalendarDays,
  blobRelativePath,
  createArchiveService,
  localDateOf,
  publicArtifact,
  publicBatch,
  runArchiveRootOperation
};
