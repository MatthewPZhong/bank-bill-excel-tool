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

const STAGING_DIR_NAME = '.staging';
const READONLY_DIR_NAME = '.readonly';
const BLOB_ROOT_PARTS = Object.freeze(['blobs', 'sha256']);
const DEFAULT_RETENTION_DAYS = 60;
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

function publicArtifact(artifact) {
  if (!artifact) return null;
  const { sourcePath: _sourcePath, blob, ...visible } = artifact;
  if (visible.metadata && typeof visible.metadata === 'object') {
    const {
      sourceSnapshot: _sourceSnapshot,
      expectedSha256: _expectedSha256,
      expectedSizeBytes: _expectedSizeBytes,
      ...metadata
    } = visible.metadata;
    visible.metadata = metadata;
  }
  if (!blob) return { ...visible, blob: null };
  const { relativePath: _relativePath, ...publicBlob } = blob;
  return { ...visible, blob: publicBlob };
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
  if (!Array.isArray(detail.artifacts)) return { ...detail };
  return { ...detail, artifacts: detail.artifacts.map(publicArtifact) };
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

function runSerialized(rootKey, operation) {
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

    this.rootDir = path.resolve(rootDir);
    this.stagingDir = path.join(this.rootDir, STAGING_DIR_NAME);
    this.readonlyDir = path.join(this.rootDir, READONLY_DIR_NAME);
    this.blobRoot = path.join(this.rootDir, ...BLOB_ROOT_PARTS);
    this.now = options.now || (() => new Date());
    this.fs = options.fsImpl || fs;
    this.opener = options.opener || null;
    this.onSourceReleased = options.onSourceReleased || null;
    this.defaultRetentionDays = defaultRetentionDays;
    this.verifyHashesOnStartup = options.verifyHashesOnStartup === true;
    this.repository = options.repository || createArchiveRepository(database, { now: this.now });
    this.initialized = false;
    this.initialization = null;
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

  async _mkdirs() {
    await this.fs.promises.mkdir(this.stagingDir, { recursive: true });
    await this.fs.promises.mkdir(this.readonlyDir, { recursive: true });
    await this.fs.promises.mkdir(this.blobRoot, { recursive: true });
  }

  async _initializeUnlocked() {
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
      const consistency = await this._reconcileStartupUnlocked({
        verifyHashes: this.verifyHashesOnStartup
      });
      this.initialization = {
        ok: consistency.failures.length === 0,
        available: true,
        status: consistency.failures.length === 0 ? 'ready' : 'ready-with-cleanup-warnings',
        consistency
      };
      return this.initialization;
    } catch (error) {
      const failure = safeFailure(error, '初始化');
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
        }
      };
      return this.initialization;
    }
  }

  async _run(operationName, operation) {
    return runSerialized(this.rootDir, async () => {
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

  async initialize() {
    return runSerialized(this.rootDir, async () => this._initializeUnlocked());
  }

  _batchInput(payload = {}) {
    const localDate = payload.localDate || localDateOf(this.now());
    let retentionUntil = payload.retentionUntil;
    if (retentionUntil === undefined) {
      if (payload.retentionDays === null || payload.retentionDays === 'permanent') {
        retentionUntil = null;
      } else {
        const retentionDays = payload.retentionDays === undefined
          ? this.defaultRetentionDays
          : Number(payload.retentionDays);
        retentionUntil = addCalendarDays(localDate, retentionDays);
      }
    }
    return {
      moduleId: payload.moduleId,
      moduleCode: payload.moduleCode || deriveModuleCode(payload.moduleId),
      moduleName: payload.moduleName || payload.moduleId,
      operationKey: payload.operationKey || crypto.randomUUID(),
      localDate,
      retentionUntil,
      businessStatus: payload.businessStatus || '',
      locked: payload.locked === true,
      metadata: payload.metadata
    };
  }

  _taskBatchInput(payload = {}) {
    const input = {
      ...this._batchInput(payload),
      operationKey: payload.operationKey,
      taskKey: payload.taskKey,
      taskRunId: payload.taskRunId,
      parentRunId: payload.parentRunId
    };
    if (Object.prototype.hasOwnProperty.call(payload, 'batchNumber')) {
      input.batchNumber = payload.batchNumber;
    }
    return input;
  }

  _createBatchUnlocked(payload = {}) {
    const created = this.repository.createBatch(this._batchInput(payload));
    return {
      ok: true,
      status: created.created ? 'created' : 'existing',
      created: created.created,
      batchId: created.batch.id,
      batch: created.batch
    };
  }

  async createBatch(payload = {}) {
    return this._run('createBatch', async () => {
      const created = this._createBatchUnlocked(payload);
      if (!Array.isArray(payload.files) || payload.files.length === 0) return created;
      const appended = await this._appendFilesUnlocked(created.batch.id, {
        files: payload.files,
        sourceOperation: payload.sourceOperation,
        metadata: payload.metadata
      });
      return {
        ...appended,
        created: created.created,
        creationStatus: created.status,
        batchId: created.batch.id
      };
    });
  }

  async reserveTaskBatch(payload = {}) {
    return this._run('reserveTaskBatch', async () => {
      const reserved = this.repository.reserveTaskBatch(this._taskBatchInput(payload));
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

  async completeTaskBatch(batchId) {
    return this._setTaskStatus('completeTaskBatch', batchId, 'succeeded', {
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
    return this._run('getLatestBatch', async () => ({
      ok: true,
      status: 'success',
      latestBatch: this.repository.getLatestIssuedBatch()
    }));
  }

  async listRelatedBatches(parentRunId) {
    return this._run('listRelatedBatches', async () => ({
      ok: true,
      status: 'success',
      batches: this.repository.listRelatedBatches(parentRunId)
    }));
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
      await this.fs.promises.mkdir(this.stagingDir, { recursive: true });
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

  async _assertExistingBlobFile(filePath, sha256, sizeBytes) {
    const stat = await this.fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== sizeBytes) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_CONFLICT',
        `存档内容 ${sha256.slice(0, 12)} 的既有文件不一致`
      );
    }
    const actual = await this._hashFile(filePath);
    if (actual.sha256 !== sha256 || actual.sizeBytes !== sizeBytes) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_CONFLICT',
        `存档内容 ${sha256.slice(0, 12)} 的既有文件校验失败`
      );
    }
  }

  async _publishStagedBlob(staged) {
    const relativePath = blobRelativePath(staged.sha256);
    const targetPath = this._resolveManagedRelative(relativePath);
    const knownBlob = this.repository.findBlobByHash(staged.sha256);
    if (knownBlob
        && (knownBlob.relativePath !== relativePath || knownBlob.sizeBytes !== staged.sizeBytes)) {
      throw new ArchiveOperationError(
        'ARCHIVE_BLOB_METADATA_CONFLICT',
        `存档内容 ${staged.sha256.slice(0, 12)} 的元数据冲突`
      );
    }
    await this.fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    try {
      await this._assertExistingBlobFile(targetPath, staged.sha256, staged.sizeBytes);
      await this.fs.promises.rm(staged.stagedPath, { force: true });
      return { relativePath, targetPath, reused: true };
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        if (error instanceof ArchiveOperationError) throw error;
        throw error;
      }
    }

    try {
      await this.fs.promises.rename(staged.stagedPath, targetPath);
      return { relativePath, targetPath, reused: false };
    } catch (error) {
      try {
        await this._assertExistingBlobFile(targetPath, staged.sha256, staged.sizeBytes);
        await this.fs.promises.rm(staged.stagedPath, { force: true });
        return { relativePath, targetPath, reused: true };
      } catch (_existingError) {
        throw error;
      }
    }
  }

  async _archiveArtifactUnlocked(artifact, sourcePath) {
    const originalName = artifact.originalName;
    const previouslyRegisteredSourcePath = artifact.sourcePath;
    let staged = null;
    try {
      const started = this.repository.startArtifactAttempt(artifact.id, { sourcePath });
      const archivedSourcePath = sourcePath || started.sourcePath;
      staged = await this._stageSourceFile(
        archivedSourcePath,
        originalName,
        artifact.metadata && artifact.metadata.sourceSnapshot,
        artifact.metadata && artifact.metadata.expectedSha256,
        artifact.metadata && (
          artifact.metadata.expectedSizeBytes
          ?? artifact.metadata.sourceSnapshot?.sizeBytes
        )
      );
      const published = await this._publishStagedBlob(staged);
      staged = null;
      const completed = this.repository.completeArtifact(artifact.id, {
        sha256: published.relativePath.split('/').pop(),
        sizeBytes: Number((await this.fs.promises.stat(published.targetPath)).size),
        relativePath: published.relativePath
      });
      await this._releaseSourcePaths([previouslyRegisteredSourcePath, archivedSourcePath]);
      return {
        ok: true,
        status: 'ready',
        artifact: publicArtifact(completed.artifact),
        batch: completed.batch,
        sha256: completed.blob.sha256,
        sizeBytes: completed.blob.sizeBytes,
        deduplicated: completed.deduplicated || published.reused
      };
    } catch (error) {
      if (staged && staged.stagedPath) {
        try { await this.fs.promises.rm(staged.stagedPath, { force: true }); } catch (_cleanupError) {}
      }
      const failure = safeFailure(error, '存档', originalName);
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
        return { result: {
          ok: true,
          status: 'ready',
          alreadyArchived: true,
          artifact: publicArtifact(existingArtifact),
          batch: this.repository.getBatch(batch.id),
          sha256: existingArtifact.blob.sha256,
          sizeBytes: existingArtifact.blob.sizeBytes,
          deduplicated: true
        } };
      }
      if (existingArtifact.status === 'failed') this.repository.beginBatchRetry(batch.id);
      return { artifact: existingArtifact, filePath };
    }
    let artifact;
    try {
      const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? { ...payload.metadata }
        : {};
      const sourceSnapshot = normalizeSourceSnapshot(payload.sourceSnapshot);
      if (sourceSnapshot) metadata.sourceSnapshot = sourceSnapshot;
      const rawExpectedSha256 = payload.expectedSha256 == null
        ? ''
        : String(payload.expectedSha256).trim().toLowerCase();
      if (rawExpectedSha256 && !SHA256_RE.test(rawExpectedSha256)) {
        throw new ArchiveOperationError(
          'ARCHIVE_EXPECTED_SHA_INVALID',
          `文件“${originalName}”缺少合法的业务解析摘要`
        );
      }
      if (rawExpectedSha256) metadata.expectedSha256 = rawExpectedSha256;
      const rawExpectedSizeBytes = payload.expectedSizeBytes
        ?? payload.sizeBytes
        ?? (rawExpectedSha256 && sourceSnapshot ? sourceSnapshot.sizeBytes : undefined);
      if (rawExpectedSizeBytes !== undefined && rawExpectedSizeBytes !== null) {
        const expectedSizeBytes = Number(rawExpectedSizeBytes);
        if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
          throw new ArchiveOperationError(
            'ARCHIVE_EXPECTED_SIZE_INVALID',
            `文件“${originalName}”缺少合法的业务解析大小`
          );
        }
        metadata.expectedSizeBytes = expectedSizeBytes;
      }
      artifact = this.repository.addArtifact(batch.id, {
        artifactKey,
        direction: payload.direction || 'input',
        role: payload.role,
        sourceOperation: payload.sourceOperation,
        originalName,
        sourcePath: filePath,
        metadata
      });
    } catch (error) {
      const failure = safeFailure(error, '登记', originalName);
      this.repository.recordBatchFailure(batch.id, {
        ...failure,
        sourceOperation: payload.sourceOperation
      });
      return { result: { ok: false, status: 'failed', metadataRecorded: true, ...failure } };
    }
    return { artifact, filePath };
  }

  async _attachFileUnlocked(batchId, payload = {}) {
    const prepared = this._prepareFileUnlocked(batchId, payload);
    if (prepared.result) return prepared.result;
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
      results[index] = prepared.result || await this._archiveArtifactUnlocked(
        prepared.artifact,
        prepared.filePath
      );
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
    return this._run('archiveFile', async () => {
      const created = this._createBatchUnlocked(payload);
      if (!created.ok) return created;
      const attached = await this._attachFileUnlocked(created.batch.id, {
        ...payload,
        artifactKey: payload.artifactKey || 'primary'
      });
      return {
        ...attached,
        created: created.created,
        batch: attached.batch || this.repository.getBatch(created.batch.id)
      };
    });
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
      if (failedArtifacts.length === 0) {
        return {
          ok: batch.archiveStatus === 'complete',
          status: 'nothing-to-retry',
          batch,
          attempted: 0,
          succeeded: 0,
          failed: 0
        };
      }
      this.repository.beginBatchRetry(batch.id);
      const sourceOverrides = options.sourcePaths && typeof options.sourcePaths === 'object'
        ? options.sourcePaths
        : {};
      const results = [];
      for (const artifact of failedArtifacts) {
        const override = sourceOverrides[artifact.id] || sourceOverrides[artifact.artifactKey];
        const sourcePath = override ? path.resolve(String(override)) : artifact.sourcePath;
        results.push(await this._archiveArtifactUnlocked(artifact, sourcePath));
      }
      const current = this.repository.getBatch(batch.id);
      const succeeded = results.filter((result) => result.ok).length;
      return {
        ok: results.every((result) => result.ok),
        status: current.archiveStatus,
        batch: current,
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
      batches: this.repository.listBatches(filters)
    }));
  }

  async getBatch(batchId) {
    return this._run('getBatch', async () => {
      const detail = this.repository.getBatchDetail(batchId);
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
        ? { ok: true, status: batch.locked ? 'locked' : 'unlocked', batch }
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
        batch: this.repository.setRetentionUntil(batch.id, retentionUntil)
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
        filePath = this._resolveManagedRelative(blob.relativePath);
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
    await this._releaseSourcePaths(sourcePaths);
    const physical = await this._removeReleasedBlobs(deleted.releasedBlobs);
    return {
      ok: physical.failures.length === 0,
      status: physical.failures.length === 0 ? 'deleted' : 'deleted-cleanup-pending',
      metadataDeleted: true,
      batchId: Number(batchId),
      artifactCount: deleted.artifactCount,
      logicalBytes: deleted.logicalBytes,
      releasedBlobCount: deleted.releasedBlobs.length,
      releasedBytes: physical.releasedBytes,
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
      stats: this.repository.getStats()
    }));
  }

  async _readyArtifact(artifactId) {
    const artifact = this.repository.getArtifact(artifactId);
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
    let filePath;
    try {
      filePath = this._resolveManagedRelative(artifact.blob.relativePath);
      const stat = await this.fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== artifact.blob.sizeBytes) {
        throw new ArchiveOperationError('ARCHIVE_BLOB_INVALID', '存档文件缺失或损坏');
      }
    } catch (error) {
      if (artifact.blobId != null) {
        try {
          this.repository.invalidateBlob(artifact.blobId, {
            code: 'ARCHIVE_BLOB_INVALID',
            message: '存档文件缺失或损坏，可重试该文件'
          });
        } catch (_metadataError) {}
      }
      return {
        ok: false,
        code: 'ARCHIVE_BLOB_INVALID',
        message: '存档文件缺失或损坏，可重试该文件',
        artifact: publicArtifact(this.repository.getArtifact(artifact.id))
      };
    }
    return { ok: true, artifact, filePath };
  }

  async openReadonlyCopy(artifactId, options = {}) {
    return this._run('openReadonlyCopy', async () => {
      const ready = await this._readyArtifact(artifactId);
      if (!ready.ok) return ready;
      const copyDir = path.join(this.readonlyDir, crypto.randomUUID());
      const targetPath = path.join(copyDir, safeName(ready.artifact.originalName));
      const tempPath = `${targetPath}.tmp`;
      try {
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
      names = await this.fs.promises.readdir(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { removed: 0, failures: [] };
      return {
        removed: 0,
        failures: [{ code: safeFailure(error, '扫描').code, item: label }]
      };
    }
    let removed = 0;
    const failures = [];
    for (const name of names) {
      try {
        await this.fs.promises.rm(path.join(directory, name), { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        failures.push({
          code: safeFailure(error, '清理').code,
          item: `${label}/${safeName(name)}`
        });
      }
    }
    return { removed, failures };
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

    const interrupted = this.repository.markInterruptedArtifacts();
    const dangling = this.repository.repairDanglingArtifactReferences();
    const danglingPhysical = await this._removeReleasedBlobs(dangling.releasedBlobs);
    failures.push(...danglingPhysical.failures);

    let removedUnreferencedBlobRecords = 0;
    let invalidBlobCount = 0;
    const blobs = this.repository.listBlobs();
    for (const blob of blobs) {
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
      let filePath = null;
      if (blob.relativePath !== expectedRelativePath) {
        invalidCode = 'ARCHIVE_BLOB_PATH_INVALID';
        invalidMessage = '存档文件路径元数据不一致，可重试该文件';
      } else {
        try {
          filePath = this._resolveManagedRelative(blob.relativePath);
          const stat = await this.fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== blob.sizeBytes) {
            invalidCode = 'ARCHIVE_BLOB_INVALID';
            invalidMessage = '存档文件缺失或大小不一致，可重试该文件';
          } else if (options.verifyHashes === true) {
            const actual = await this._hashFile(filePath);
            if (actual.sha256 !== blob.sha256 || actual.sizeBytes !== blob.sizeBytes) {
              invalidCode = 'ARCHIVE_BLOB_HASH_MISMATCH';
              invalidMessage = '存档文件哈希校验失败，可重试该文件';
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
        const invalidated = this.repository.invalidateBlob(blob.id, {
          code: invalidCode,
          message: invalidMessage
        });
        if (invalidated) invalidBlobCount += 1;
        if (filePath) {
          try { await this.fs.promises.rm(filePath, { force: true }); } catch (error) {
            failures.push({
              code: safeFailure(error, '清理').code,
              blob: blob.sha256.slice(0, 12)
            });
          }
        }
      }
    }

    const referencedPaths = new Set(this.repository.listBlobs().map((blob) => blob.relativePath));
    const physicalFiles = await this._listPhysicalBlobFiles();
    let removedOrphanBlobFiles = 0;
    for (const file of physicalFiles) {
      if (referencedPaths.has(file.relativePath)) continue;
      try {
        await this.fs.promises.rm(file.filePath, { force: true });
        removedOrphanBlobFiles += 1;
      } catch (error) {
        failures.push({
          code: safeFailure(error, '清理').code,
          blob: file.sha256.slice(0, 12)
        });
      }
    }

    return {
      removedStagingEntries: staging.removed,
      removedReadonlyEntries: readonly.removed,
      interruptedArtifactCount: interrupted.artifactCount,
      repairedArtifactCount: dangling.artifactCount,
      invalidBlobCount,
      removedUnreferencedBlobRecords,
      removedOrphanBlobFiles,
      failures
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
}

function createArchiveService(options = {}) {
  return new ArchiveService(options);
}

module.exports = {
  ArchiveOperationError,
  ArchiveService,
  BLOB_ROOT_PARTS,
  DEFAULT_RETENTION_DAYS,
  READONLY_DIR_NAME,
  STAGING_DIR_NAME,
  addCalendarDays,
  blobRelativePath,
  createArchiveService,
  localDateOf
};
