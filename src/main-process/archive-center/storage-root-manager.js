'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const {
  ARCHIVE_STORAGE_ROOT_SETTING_KEY
} = require('../../backend/database/archive-repository');
const {
  runArchiveRootOperation
} = require('./archive-service');
const {
  createStorageMaterializer,
  verifyFile
} = require('./storage-materializer');

const ROOT_MARKER_FILE = '.archive-root.json';
const ROOT_MARKER_TYPE = 'bank-bill-excel-tool-archive-root';
const ROOT_MARKER_SCHEMA_VERSION = 2;
const MIGRATION_JOURNAL_SCHEMA_VERSION = 1;
const MIGRATION_PHASES = Object.freeze([
  'prepared',
  'copying',
  'materializing-layout',
  'verifying',
  'switched',
  'cleanup-pending',
  'done'
]);
const PRE_SWITCH_PHASES = new Set([
  'prepared',
  'copying',
  'materializing-layout',
  'verifying'
]);
const INTERNAL_TRANSIENT_DIRS = new Set(['.staging', '.readonly']);
const DEFAULT_STARTUP_OWNERSHIP_BATCH_SIZE = 64;

class ArchiveStorageRootError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ArchiveStorageRootError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

function publicFailure(error, fallback = '存档位置变更失败') {
  return {
    status: 'failed',
    code: String(error && error.code || 'ARCHIVE_STORAGE_MIGRATION_FAILED'),
    message: String(error && error.message || fallback),
    retryable: Boolean(error && error.retryable)
  };
}

function normalizeRoot(rootPath) {
  const text = String(rootPath || '').trim();
  if (!text || !path.isAbsolute(text) || text.includes('\0')) {
    throw new ArchiveStorageRootError('ARCHIVE_STORAGE_ROOT_INVALID', '存档位置必须是绝对路径');
  }
  return path.resolve(text);
}

function comparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(first, second) {
  const a = comparablePath(first);
  const b = comparablePath(second);
  const relative = path.relative(a, b);
  const aContainsB = relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
  const reverse = path.relative(b, a);
  const bContainsA = reverse === '' || (
    reverse !== '..'
    && !reverse.startsWith(`..${path.sep}`)
    && !path.isAbsolute(reverse)
  );
  return aContainsB || bContainsA;
}

function toRelativePath(value) {
  const text = String(value || '').trim();
  if (!text || path.isAbsolute(text) || text.includes('\\')) {
    throw new ArchiveStorageRootError('ARCHIVE_STORAGE_PATH_INVALID', '存档内部路径非法');
  }
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new ArchiveStorageRootError('ARCHIVE_STORAGE_PATH_INVALID', '存档内部路径非法');
  }
  return parts.join('/');
}

function parentRelativePaths(relativePath) {
  const result = [];
  let current = path.posix.dirname(relativePath);
  while (current && current !== '.') {
    result.push(current);
    current = path.posix.dirname(current);
  }
  return result;
}

async function pathExists(fsImpl, targetPath) {
  try {
    await fsImpl.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(fsImpl, directory) {
  let handle;
  try {
    handle = await fsImpl.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!error || !['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWriteJson(fsImpl, filePath, value) {
  const directory = path.dirname(filePath);
  await fsImpl.promises.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsImpl.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.promises.rename(tempPath, filePath);
    await syncDirectory(fsImpl, directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_closeError) {}
    }
    try { await fsImpl.promises.rm(tempPath, { force: true }); } catch (_cleanupError) {}
    throw error;
  }
}

function exactMarker(instanceId) {
  return {
    type: ROOT_MARKER_TYPE,
    schemaVersion: ROOT_MARKER_SCHEMA_VERSION,
    archiveInstanceId: instanceId
  };
}

function validateMarker(marker, instanceId) {
  const keys = marker && typeof marker === 'object' && !Array.isArray(marker)
    ? Object.keys(marker).sort()
    : [];
  if (keys.join(',') !== 'archiveInstanceId,schemaVersion,type'
      || marker.type !== ROOT_MARKER_TYPE
      || marker.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION
      || marker.archiveInstanceId !== instanceId) {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_MARKER_CONFLICT',
      '所选目录不属于当前存档实例'
    );
  }
  return marker;
}

function validateJournal(journal, instanceId) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
      || journal.schemaVersion !== MIGRATION_JOURNAL_SCHEMA_VERSION
      || !MIGRATION_PHASES.includes(journal.phase)
      || journal.archiveInstanceId !== instanceId
      || !journal.migrationId
      || !journal.sourceRoot
      || !journal.targetRoot) {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_JOURNAL_INVALID',
      '存档迁移恢复记录无效，已停止自动处理'
    );
  }
  const sourceCleanupPaths = journal.sourceCleanupPaths == null
    ? null
    : Array.isArray(journal.sourceCleanupPaths)
      ? [...new Set(journal.sourceCleanupPaths.map(toRelativePath))].sort()
      : null;
  const targetPublishedPaths = journal.targetPublishedPaths == null
    ? null
    : Array.isArray(journal.targetPublishedPaths)
      ? [...new Set(journal.targetPublishedPaths.map(toRelativePath))].sort()
      : null;
  if (journal.sourceCleanupPaths != null && sourceCleanupPaths == null) {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_JOURNAL_INVALID',
      '存档迁移恢复记录无效，已停止自动处理'
    );
  }
  if (journal.targetPublishedPaths != null && targetPublishedPaths == null) {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_JOURNAL_INVALID',
      '存档迁移恢复记录无效，已停止自动处理'
    );
  }
  if (journal.sourceRootRemovalStartedAt != null
      && typeof journal.sourceRootRemovalStartedAt !== 'string') {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_JOURNAL_INVALID',
      '存档迁移恢复记录无效，已停止自动处理'
    );
  }
  if (!PRE_SWITCH_PHASES.has(journal.phase) && sourceCleanupPaths == null) {
    throw new ArchiveStorageRootError(
      'ARCHIVE_STORAGE_JOURNAL_INVALID',
      '存档迁移缺少旧根清理证据，已停止自动处理'
    );
  }
  return {
    ...journal,
    sourceRoot: normalizeRoot(journal.sourceRoot),
    targetRoot: normalizeRoot(journal.targetRoot),
    sourceCleanupPaths,
    targetPublishedPaths,
    sourceRootRemovalStartedAt: journal.sourceRootRemovalStartedAt || null
  };
}

class ArchiveStorageRootManager {
  constructor(options = {}) {
    if (!options.database || typeof options.database.getSetting !== 'function') {
      throw new TypeError('ArchiveStorageRootManager 需要 AppDatabase');
    }
    if (!options.repository
        || typeof options.repository.getOrCreateArchiveInstanceId !== 'function') {
      throw new TypeError('ArchiveStorageRootManager 需要 ArchiveRepository');
    }
    if (!options.runtimeDelegate || typeof options.runtimeDelegate.switchService !== 'function') {
      throw new TypeError('ArchiveStorageRootManager 需要 ArchiveRuntimeDelegate');
    }
    if (typeof options.createService !== 'function') {
      throw new TypeError('ArchiveStorageRootManager 需要 createService');
    }
    this.database = options.database;
    this.repository = options.repository;
    this.runtimeDelegate = options.runtimeDelegate;
    this.createService = options.createService;
    this.defaultRoot = normalizeRoot(options.defaultRoot);
    this.journalPath = normalizeRoot(options.journalPath);
    this.blockedRoots = (Array.isArray(options.blockedRoots) ? options.blockedRoots : [])
      .filter(Boolean)
      .map(normalizeRoot);
    this.waitForArchiveOperations = options.waitForArchiveOperations || (() => Promise.resolve());
    this.showOpenDialog = options.showOpenDialog || null;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this.fs = options.fsImpl || fs;
    this.createMaterializer = options.createMaterializer || createStorageMaterializer;
    this.faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;
    this.deferStartupRecovery = options.deferStartupRecovery === true;
    const startupOwnershipBatchSize = options.startupOwnershipBatchSize === undefined
      ? DEFAULT_STARTUP_OWNERSHIP_BATCH_SIZE
      : Number(options.startupOwnershipBatchSize);
    if (!Number.isSafeInteger(startupOwnershipBatchSize)
        || startupOwnershipBatchSize < 1
        || startupOwnershipBatchSize > 5000) {
      throw new TypeError('startupOwnershipBatchSize 必须是 1 到 5000 的安全整数');
    }
    this.startupOwnershipBatchSize = startupOwnershipBatchSize;
    this.instanceId = '';
    this.currentService = null;
    this.initialization = null;
    this.migrationPromise = null;
    this.canonicalBlockedRootsPromise = null;
    this.ownershipGeneration = 0;
    this.ownershipPromise = null;
    this.ownershipScan = null;
    this.ownershipProgress = {
      status: 'idle',
      processed: 0,
      remaining: 0,
      cursor: 0,
      lastErrorCode: ''
    };
    this.publicMigration = { status: 'idle', phase: '', processed: 0, total: 0 };
  }

  getCurrentRoot() {
    return this.currentService ? this.currentService.rootDir : this.runtimeDelegate.rootDir;
  }

  getMigrationState() {
    const materialization = this.currentService
      && typeof this.currentService.getMaterializationProgress === 'function'
      ? this.currentService.getMaterializationProgress()
      : null;
    return { ...this.publicMigration, materialization };
  }

  getOwnershipProgress() {
    return { ...this.ownershipProgress };
  }

  isMaintenanceRequested() {
    const state = this.runtimeDelegate.getMaintenanceState();
    return state.requested || state.active;
  }

  async beginDatabaseMaintenance(message = '数据库正在维护，请稍后重试') {
    if (this.migrationPromise || this.isMaintenanceRequested()) {
      return { acquired: false, reason: 'archive-maintenance-active' };
    }
    if (!this.runtimeDelegate.requestMaintenance(message)) {
      return { acquired: false, reason: 'archive-maintenance-active' };
    }
    const sourceService = this.currentService;
    try {
      await this.waitForArchiveOperations();
      if (sourceService && typeof sourceService.pauseBackgroundMaterialization === 'function') {
        await sourceService.pauseBackgroundMaterialization();
      }
      await this.pauseBackgroundOwnershipScan();
      this.runtimeDelegate.activateMaintenance();
      return { acquired: true, rootDir: sourceService ? sourceService.rootDir : '' };
    } catch (error) {
      this.runtimeDelegate.releaseMaintenance();
      this._resumeBackgroundArchiveChecks();
      throw error;
    }
  }

  async endDatabaseMaintenance() {
    this.runtimeDelegate.releaseMaintenance();
    this._resumeBackgroundArchiveChecks();
    return { released: true };
  }

  _emitProgress(phase, processed = 0, total = 0, status = 'running') {
    this.publicMigration = {
      status,
      phase,
      processed: Number(processed) || 0,
      total: Number(total) || 0
    };
    if (this.onProgress) {
      try { this.onProgress({ ...this.publicMigration }); } catch (_error) {}
    }
  }

  async _inject(event, context = {}) {
    if (this.faultInjector) await this.faultInjector(event, context);
  }

  async _readJson(filePath, missingValue = null) {
    try {
      const stat = await this.fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_METADATA_INVALID',
          '存档根身份文件类型无效'
        );
      }
      return JSON.parse(await this.fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return missingValue;
      if (error instanceof SyntaxError) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_METADATA_INVALID',
          '存档根身份或迁移记录无法解析'
        );
      }
      throw error;
    }
  }

  async _readMarker(rootDir) {
    return this._readJson(path.join(rootDir, ROOT_MARKER_FILE), null);
  }

  async _writeMarker(rootDir) {
    await atomicWriteJson(
      this.fs,
      path.join(rootDir, ROOT_MARKER_FILE),
      exactMarker(this.instanceId)
    );
    return exactMarker(this.instanceId);
  }

  async _readJournal() {
    const journal = await this._readJson(this.journalPath, null);
    return journal ? validateJournal(journal, this.instanceId) : null;
  }

  async _writeJournal(journal, phase = journal.phase, patch = {}) {
    const next = {
      ...journal,
      ...patch,
      schemaVersion: MIGRATION_JOURNAL_SCHEMA_VERSION,
      archiveInstanceId: this.instanceId,
      phase,
      updatedAt: new Date().toISOString()
    };
    await atomicWriteJson(this.fs, this.journalPath, next);
    return next;
  }

  _evidence() {
    const blobs = this.repository.listBlobs();
    const artifacts = this.repository.listReadyArtifacts();
    const cleanupJobs = this.repository.listCleanupJobs();
    const files = new Set([ROOT_MARKER_FILE]);
    const directories = new Set(['blobs', 'blobs/sha256', '.staging', '.readonly']);
    for (const blob of blobs) files.add(toRelativePath(blob.relativePath));
    for (const artifact of artifacts) {
      if (artifact.storageRelativePath) files.add(toRelativePath(artifact.storageRelativePath));
    }
    for (const job of cleanupJobs) {
      for (const relativePath of job.materializedPaths) files.add(toRelativePath(relativePath));
      for (const blob of job.releasedBlobs) files.add(toRelativePath(blob.relativePath));
    }
    for (const file of files) {
      for (const directory of parentRelativePaths(file)) directories.add(directory);
    }
    return { blobs, artifacts, cleanupJobs, files, directories };
  }

  _sourceCleanupPaths(evidence) {
    return [...evidence.files]
      .filter((relativePath) => relativePath !== ROOT_MARKER_FILE)
      .filter((relativePath) => !INTERNAL_TRANSIENT_DIRS.has(relativePath.split('/')[0]))
      .map(toRelativePath)
      .sort();
  }

  _targetPublishedPaths(evidence) {
    const paths = new Set();
    for (const blob of evidence.blobs) paths.add(toRelativePath(blob.relativePath));
    for (const artifact of evidence.artifacts) {
      if (artifact.storageRelativePath) {
        paths.add(toRelativePath(artifact.storageRelativePath));
      }
    }
    return [...paths].sort();
  }

  async _removeEmptyManagedParents(rootDir, relativePaths) {
    const parents = new Set();
    for (const relativePath of relativePaths) {
      for (const parent of parentRelativePaths(relativePath)) parents.add(parent);
    }
    for (const relativeDirectory of [...parents].sort((a, b) => b.length - a.length)) {
      const directory = await this._assertManagedPath(rootDir, relativeDirectory);
      try {
        await this.fs.promises.rmdir(directory);
      } catch (error) {
        if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }

  async _reconcilePreSwitchTargetInventory(journal, evidence) {
    const knownPublished = journal.targetPublishedPaths;
    if (!Array.isArray(knownPublished)) return;
    const desired = new Set(this._targetPublishedPaths(evidence));
    const stale = knownPublished.filter((relativePath) => !desired.has(relativePath));
    for (const relativePath of stale) {
      const filePath = await this._assertManagedPath(journal.targetRoot, relativePath);
      await this.fs.promises.rm(filePath, { force: true });
    }
    await this._removeEmptyManagedParents(journal.targetRoot, stale);
  }

  async _canonicalizeWithExistingAncestor(value) {
    const normalized = normalizeRoot(value);
    const suffix = [];
    let candidate = normalized;
    while (true) {
      try {
        const real = await this.fs.promises.realpath(candidate);
        return path.resolve(real, ...suffix);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) return normalized;
        suffix.unshift(path.basename(candidate));
        candidate = parent;
      }
    }
  }

  async _canonicalBlockedRoots() {
    if (!this.canonicalBlockedRootsPromise) {
      this.canonicalBlockedRootsPromise = Promise.all(
        this.blockedRoots.map((blocked) => this._canonicalizeWithExistingAncestor(blocked))
      );
    }
    return this.canonicalBlockedRootsPromise;
  }

  async _walkOwnedRoot(rootDir, evidence, options = {}) {
    const allowMissingMarker = options.allowMissingMarker === true;
    const allowUnknownContent = options.allowUnknownContent === true;
    const allowLegacyEmptyBlobShards = options.allowLegacyEmptyBlobShards === true;
    const walk = async (directory, relativeDirectory = '') => {
      const entries = await this.fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(directory, entry.name);
        const stat = await this.fs.promises.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_SYMLINK_REJECTED',
            '存档根包含符号链接或目录联接，无法确认所有权'
          );
        }
        const top = relativePath.split('/')[0];
        if (entry.isDirectory()) {
          // PR4 之前删除最后一个 Blob 时可能留下空的两位 SHA 分片目录。它们的路径
          // 完全由本应用生成；递归继续检查可确保目录必须为空，未知文件/子目录仍拒绝。
          const isLegacyEmptyBlobShard = allowLegacyEmptyBlobShards
            && relativeDirectory === 'blobs/sha256'
            && /^[0-9a-f]{2}$/.test(entry.name);
          if (!evidence.directories.has(relativePath)
              && !isLegacyEmptyBlobShard
              && !INTERNAL_TRANSIENT_DIRS.has(top)
              && !allowUnknownContent) {
            throw new ArchiveStorageRootError(
              'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
              '存档根包含无法由数据库解释的目录'
            );
          }
          await walk(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()
            || (!evidence.files.has(relativePath)
              && !INTERNAL_TRANSIENT_DIRS.has(top)
              && !(allowMissingMarker && relativePath === ROOT_MARKER_FILE)
              && !allowUnknownContent)) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
            '存档根包含无法由数据库解释的文件'
          );
        }
      }
    };
    await walk(rootDir);
  }

  async _assertManagedPath(rootDir, relativePath, options = {}) {
    const normalized = toRelativePath(relativePath);
    const resolved = path.resolve(rootDir, ...normalized.split('/'));
    const relative = path.relative(rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_PATH_INVALID', '存档内部路径越界');
    }
    let current = rootDir;
    const parts = normalized.split('/');
    const stop = options.includeLeaf === false ? parts.length - 1 : parts.length;
    const verifiedPaths = options.verifiedPaths instanceof Set ? options.verifiedPaths : null;
    for (let index = 0; index < stop; index += 1) {
      current = path.join(current, parts[index]);
      if (verifiedPaths && verifiedPaths.has(current)) continue;
      try {
        const stat = await this.fs.promises.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_SYMLINK_REJECTED',
            '存档内部路径包含符号链接或目录联接'
          );
        }
        if (verifiedPaths) verifiedPaths.add(current);
      } catch (error) {
        if (error && error.code === 'ENOENT') break;
        throw error;
      }
    }
    return resolved;
  }

  _evidenceOwnershipPaths(evidence) {
    // leaf 文件由 Blob/layout 自身的 lstat + SHA/size 校验负责；root ownership
    // 这里只需验证所有祖先目录，避免每个文件重复扫描同一层级。
    return [...new Set(evidence.directories)].map(toRelativePath).sort();
  }

  _criticalOwnershipPaths(relativePaths) {
    const fixed = new Set(['.readonly', '.staging', 'blobs', 'blobs/sha256']);
    for (const relativePath of relativePaths) {
      if (/^blobs\/sha256\/[0-9a-f]{2}$/.test(relativePath)) fixed.add(relativePath);
    }
    return [...fixed].filter((relativePath) => relativePaths.includes(relativePath)).sort();
  }

  async _assertEvidencePathsOwned(rootDir, evidence, options = {}) {
    const relativePaths = options.relativePaths || this._evidenceOwnershipPaths(evidence);
    const afterIndex = Number.isSafeInteger(options.afterIndex) ? options.afterIndex : 0;
    const limit = options.limit === undefined
      ? relativePaths.length
      : Number(options.limit);
    const end = Math.min(relativePaths.length, afterIndex + Math.max(0, limit));
    const verifiedPaths = options.verifiedPaths instanceof Set
      ? options.verifiedPaths
      : new Set();
    for (let index = afterIndex; index < end; index += 1) {
      await this._assertManagedPath(rootDir, relativePaths[index], { verifiedPaths });
    }
    return {
      paths: relativePaths,
      cursor: end,
      processed: Math.max(0, end - afterIndex),
      remaining: Math.max(0, relativePaths.length - end)
    };
  }

  _setOwnershipProgress(patch = {}) {
    this.ownershipProgress = { ...this.ownershipProgress, ...patch };
    return this.getOwnershipProgress();
  }

  async _drainOwnershipScan(options = {}) {
    const scan = this.ownershipScan;
    if (!scan || scan.remaining <= 0) return this.getOwnershipProgress();
    const generation = options.generation;
    const drainAll = options.drainAll === true;
    do {
      if (generation !== undefined && generation !== this.ownershipGeneration) break;
      const chunk = await runArchiveRootOperation(scan.rootDir, () => (
        this._assertEvidencePathsOwned(scan.rootDir, null, {
          relativePaths: scan.paths,
          afterIndex: scan.cursor,
          limit: drainAll ? scan.paths.length : this.startupOwnershipBatchSize,
          verifiedPaths: scan.verifiedPaths
        })
      ));
      scan.cursor = chunk.cursor;
      scan.remaining = chunk.remaining;
      this._setOwnershipProgress({
        status: scan.remaining === 0 ? 'complete' : 'running',
        processed: scan.cursor,
        remaining: scan.remaining,
        cursor: scan.cursor,
        lastErrorCode: ''
      });
      if (!drainAll) break;
    } while (scan.remaining > 0);
    return this.getOwnershipProgress();
  }

  pauseBackgroundOwnershipScan() {
    this.ownershipGeneration += 1;
    if (this.ownershipProgress.status === 'running'
        || this.ownershipProgress.status === 'pending') {
      this._setOwnershipProgress({ status: 'paused' });
    }
    return this.ownershipPromise || Promise.resolve(this.getOwnershipProgress());
  }

  resumeBackgroundOwnershipScan() {
    if (!this.ownershipScan || this.ownershipScan.remaining <= 0) {
      return this.ownershipPromise || Promise.resolve(this.getOwnershipProgress());
    }
    if (this.ownershipPromise) return this.ownershipPromise;
    const generation = ++this.ownershipGeneration;
    const drain = async () => {
      this._setOwnershipProgress({ status: 'running', lastErrorCode: '' });
      try {
        while (generation === this.ownershipGeneration
            && this.ownershipScan
            && this.ownershipScan.remaining > 0) {
          await this._drainOwnershipScan({ generation });
        }
      } catch (error) {
        this._setOwnershipProgress({
          status: 'failed',
          lastErrorCode: String(error && error.code || 'ARCHIVE_STORAGE_OWNERSHIP_FAILED')
        });
        if (this.currentService
            && this.ownershipScan
            && comparablePath(this.currentService.rootDir)
              === comparablePath(this.ownershipScan.rootDir)) {
          this.currentService = null;
          this.runtimeDelegate.clearService(this.ownershipScan.rootDir);
        }
        return this.getOwnershipProgress();
      }
      if (generation !== this.ownershipGeneration) {
        return this._setOwnershipProgress({ status: 'paused' });
      }
      return this._setOwnershipProgress({ status: 'complete', remaining: 0 });
    };
    this.ownershipPromise = drain().finally(() => {
      this.ownershipPromise = null;
    });
    return this.ownershipPromise;
  }

  resumeBackgroundArchiveChecks() {
    this._resumeBackgroundArchiveChecks();
  }

  async _assertOwnershipScanComplete(rootDir) {
    if (!this.ownershipScan
        || comparablePath(this.ownershipScan.rootDir) !== comparablePath(rootDir)
        || this.ownershipScan.remaining <= 0) return;
    const scan = this.ownershipScan;
    while (scan.remaining > 0) {
      const chunk = await this._assertEvidencePathsOwned(scan.rootDir, null, {
        relativePaths: scan.paths,
        afterIndex: scan.cursor,
        limit: scan.paths.length,
        verifiedPaths: scan.verifiedPaths
      });
      scan.cursor = chunk.cursor;
      scan.remaining = chunk.remaining;
      this._setOwnershipProgress({
        status: scan.remaining === 0 ? 'complete' : 'running',
        processed: scan.cursor,
        remaining: scan.remaining,
        cursor: scan.cursor,
        lastErrorCode: ''
      });
    }
  }

  _resumeBackgroundArchiveChecks() {
    const ownership = this.resumeBackgroundOwnershipScan();
    Promise.resolve(ownership).then((progress) => {
      if (!progress || progress.status !== 'complete' || !this.currentService) return;
      if (typeof this.currentService.resumeBackgroundMaterialization === 'function') {
        this.currentService.resumeBackgroundMaterialization();
      }
    }).catch(() => undefined);
  }

  async _verifyEvidenceFiles(rootDir, evidence) {
    for (const blob of evidence.blobs) {
      const filePath = await this._assertManagedPath(rootDir, blob.relativePath);
      const result = await verifyFile(filePath, {
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes
      }, this.fs);
      if (!result.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_BLOB_INVALID',
          'canonical Blob 与数据库大小或哈希不一致'
        );
      }
    }
    for (const artifact of evidence.artifacts) {
      if (!artifact.storageRelativePath || !artifact.blob) continue;
      const filePath = await this._assertManagedPath(rootDir, artifact.storageRelativePath);
      const result = await verifyFile(filePath, {
        sha256: artifact.blob.sha256,
        sizeBytes: artifact.blob.sizeBytes
      }, this.fs);
      if (!result.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_LAYOUT_INVALID',
          '目录化文件与数据库大小或哈希不一致'
        );
      }
    }
  }

  async _existingRoot(rootDir, configured) {
    try {
      const stat = await this.fs.promises.lstat(rootDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_ROOT_INVALID',
          '存档位置不是可用的真实目录'
        );
      }
      const real = await this.fs.promises.realpath(rootDir);
      return path.resolve(real);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (configured) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_ROOT_OFFLINE',
            '已配置的存档位置暂时离线，请重新连接后再试',
            { retryable: true }
          );
        }
        await this.fs.promises.mkdir(rootDir, { recursive: true });
        return path.resolve(await this.fs.promises.realpath(rootDir));
      }
      throw error;
    }
  }

  async _prepareActiveRoot(rootDir, options = {}) {
    const resolvedRoot = await this._existingRoot(rootDir, options.configured === true);
    const marker = await this._readMarker(resolvedRoot);
    const evidence = this._evidence();
    if (marker) {
      validateMarker(marker, this.instanceId);
      // 已验证 marker 的活跃根可能有旧批次删除后留下的普通残留项；无需递归扫未知文件。
      // 只验证 DB 权威路径与 .staging/.readonly 的每一级祖先，既阻止 junction/symlink
      // 越根，也不把启动恢复重新变成按目录全部内容线性扫描。
      const paths = this._evidenceOwnershipPaths(evidence);
      const criticalPaths = this._criticalOwnershipPaths(paths);
      const verifiedPaths = new Set();
      await this._assertEvidencePathsOwned(resolvedRoot, evidence, {
        relativePaths: criticalPaths,
        afterIndex: 0,
        limit: criticalPaths.length,
        verifiedPaths
      });
      const backgroundPaths = paths.filter((relativePath) => !criticalPaths.includes(relativePath));
      const foreground = await this._assertEvidencePathsOwned(resolvedRoot, evidence, {
        relativePaths: backgroundPaths,
        afterIndex: 0,
        limit: this.startupOwnershipBatchSize,
        verifiedPaths
      });
      this.ownershipScan = {
        rootDir: resolvedRoot,
        paths: backgroundPaths,
        cursor: foreground.cursor,
        remaining: foreground.remaining,
        verifiedPaths
      };
      this._setOwnershipProgress({
        status: foreground.remaining === 0 ? 'complete' : 'pending',
        processed: foreground.processed,
        remaining: foreground.remaining,
        cursor: foreground.cursor,
        lastErrorCode: ''
      });
      return resolvedRoot;
    }
    await this._walkOwnedRoot(resolvedRoot, evidence, {
      allowMissingMarker: true,
      allowLegacyEmptyBlobShards: true
    });
    await this._verifyEvidenceFiles(resolvedRoot, evidence);
    await this._writeMarker(resolvedRoot);
    validateMarker(await this._readMarker(resolvedRoot), this.instanceId);
    this.ownershipScan = null;
    this._setOwnershipProgress({
      status: 'complete',
      processed: 0,
      remaining: 0,
      cursor: 0,
      lastErrorCode: ''
    });
    return resolvedRoot;
  }

  async _initializeExistingService(service) {
    const initialized = await service.initialize({
      startBackgroundMaterialization: false,
      deferStartupRecovery: this.deferStartupRecovery
    });
    if (!initialized || initialized.available === false) {
      throw new ArchiveStorageRootError(
        initialized && initialized.code || 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
        initialized && initialized.message || '存档位置暂不可用',
        { retryable: true }
      );
    }
    return { service, initialized };
  }

  async _initializeService(rootDir) {
    return this._initializeExistingService(this.createService(rootDir));
  }

  async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      this.repository.ensureSchema();
      this.instanceId = this.repository.getOrCreateArchiveInstanceId();
      const storedRoot = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY);
      const effectiveRoot = storedRoot ? normalizeRoot(storedRoot) : this.defaultRoot;
      this.runtimeDelegate.clearService(effectiveRoot);
      const journal = await this._readJournal();
      let initialized;
      if (journal) {
        initialized = await this._recover(journal, storedRoot);
      } else {
        const rootDir = await this._prepareActiveRoot(
          effectiveRoot,
          { configured: Boolean(storedRoot) }
        );
        const active = await this._initializeService(rootDir);
        this.currentService = active.service;
        this.runtimeDelegate.switchService(active.service);
        initialized = active.initialized;
      }
      if (!this.deferStartupRecovery) this._resumeBackgroundArchiveChecks();
      return initialized;
    })().catch((error) => {
      this.runtimeDelegate.clearService(
        this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY) || this.defaultRoot
      );
      return {
        ...publicFailure(error, '存档中心初始化失败'),
        ok: false,
        available: false,
        status: 'unavailable'
      };
    });
    return this.initialization;
  }

  async _selectTarget() {
    if (typeof this.showOpenDialog !== 'function') {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_DIALOG_UNAVAILABLE',
        '选择存档位置服务暂不可用'
      );
    }
    const selected = await this.showOpenDialog({
      title: '选择存档位置',
      buttonLabel: '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (!selected || selected.canceled || !selected.filePaths || !selected.filePaths[0]) return null;
    return normalizeRoot(selected.filePaths[0]);
  }

  async changeStorageLocation() {
    if (this.migrationPromise
        || this.isMaintenanceRequested()
        || this.publicMigration.phase === 'cleanup-pending') {
      return {
        status: 'busy',
        code: 'ARCHIVE_STORAGE_MAINTENANCE',
        message: this.publicMigration.phase === 'cleanup-pending'
          ? '旧存档位置仍待安全清理，请重启软件重试后再变更'
          : '存档位置正在变更，请等待当前迁移完成'
      };
    }
    if (!this.currentService) return publicFailure(null, '当前存档位置不可用，无法迁移');
    let targetRoot;
    try {
      const unresolvedJournal = await this._readJournal();
      if (unresolvedJournal) {
        return {
          status: 'busy',
          code: 'ARCHIVE_STORAGE_MIGRATION_PENDING',
          message: '上一次存档位置变更尚未收口，请重启软件恢复后再试'
        };
      }
      targetRoot = await this._selectTarget();
      if (!targetRoot) return { status: 'cancelled' };
      const realTarget = await this._existingRoot(targetRoot, true);
      if (comparablePath(realTarget) === comparablePath(this.currentService.rootDir)) {
        return { status: 'success', noChange: true, message: '存档位置未变化' };
      }
      targetRoot = realTarget;
    } catch (error) {
      return publicFailure(error);
    }

    if (!this.runtimeDelegate.requestMaintenance('存档位置正在变更，请稍后重试')) {
      return { status: 'busy', code: 'ARCHIVE_STORAGE_MAINTENANCE', message: '存档中心正在维护' };
    }
    const sourceService = this.currentService;
    const backgroundStopped = sourceService
      && typeof sourceService.pauseBackgroundMaterialization === 'function'
      ? sourceService.pauseBackgroundMaterialization()
      : Promise.resolve();
    const ownershipStopped = this.pauseBackgroundOwnershipScan();
    this.migrationPromise = (async () => {
      try {
        await this.waitForArchiveOperations();
        await backgroundStopped;
        await ownershipStopped;
        this.runtimeDelegate.activateMaintenance();
        return await runArchiveRootOperation(
          this.currentService.rootDir,
          () => this._startMigration(targetRoot)
        );
      } catch (error) {
        this._emitProgress(this.publicMigration.phase, this.publicMigration.processed,
          this.publicMigration.total, 'failed');
        return publicFailure(error);
      } finally {
        this.runtimeDelegate.releaseMaintenance();
        this._resumeBackgroundArchiveChecks();
        this.migrationPromise = null;
      }
    })();
    return this.migrationPromise;
  }

  async _assertSourceReady() {
    await this._assertOwnershipScanComplete(this.currentService.rootDir);
    const consistency = await this.currentService._reconcileStartupUnlocked({ verifyHashes: true });
    if (consistency.failures.length > 0 || this.repository.listCleanupJobs().length > 0) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SOURCE_NOT_CLEAN',
        '当前存档根仍有完整性或物理清理问题，请解决后再迁移',
        { retryable: true }
      );
    }
    const stagingEntries = await this.fs.promises.readdir(this.currentService.stagingDir);
    if (stagingEntries.length > 0) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_STAGING_NOT_CLEAN',
        '存档暂存区尚未恢复到安全状态'
      );
    }
  }

  async _probeTarget(rootDir) {
    const token = crypto.randomUUID();
    const first = path.join(rootDir, `.archive-probe-${token}.tmp`);
    const renamed = path.join(rootDir, `.archive-probe-${token}.ready`);
    let handle;
    try {
      handle = await this.fs.promises.open(first, 'wx', 0o600);
      await handle.writeFile('archive-storage-probe', 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.promises.rename(first, renamed);
      if (await this.fs.promises.readFile(renamed, 'utf8') !== 'archive-storage-probe') {
        throw new Error('probe content mismatch');
      }
      await this.fs.promises.rm(renamed, { force: true });
      if (await pathExists(this.fs, renamed)) {
        throw new Error('probe cleanup mismatch');
      }
      await syncDirectory(this.fs, rootDir);
      return {};
    } catch (error) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_TARGET_PROBE_FAILED',
        '所选目录无法完成安全写入探针',
        { retryable: true }
      );
    } finally {
      if (handle) {
        try { await handle.close(); } catch (_closeError) {}
      }
      for (const filePath of [first, renamed]) {
        try { await this.fs.promises.rm(filePath, { force: true }); } catch (_cleanupError) {}
      }
    }
  }

  async _validateTarget(targetRoot, evidence) {
    if (pathsOverlap(this.currentService.rootDir, targetRoot)) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_ROOT_OVERLAP',
        '新存档位置不能是当前存档位置本身、其上级或子目录'
      );
    }
    const blockedRoots = await this._canonicalBlockedRoots();
    if (blockedRoots.some((blocked) => pathsOverlap(blocked, targetRoot))) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_ROOT_FORBIDDEN',
        '所选目录与应用、数据库或临时目录冲突'
      );
    }
    const marker = await this._readMarker(targetRoot);
    const entries = await this.fs.promises.readdir(targetRoot);
    if (marker) {
      validateMarker(marker, this.instanceId);
      await this._walkOwnedRoot(targetRoot, evidence);
    } else if (entries.length > 0) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
        '请选择空目录或当前应用已创建的存档根'
      );
    }
    const probe = await this._probeTarget(targetRoot);
    if (!marker) await this._writeMarker(targetRoot);
    validateMarker(await this._readMarker(targetRoot), this.instanceId);

    const missingCanonicalBytes = await this._missingCanonicalBytes(targetRoot, evidence.blobs);
    const missingArtifactBytes = await this._missingArtifactBytes(
      targetRoot,
      evidence.artifacts
    );
    let statfs;
    try {
      statfs = await this.fs.promises.statfs(targetRoot);
    } catch (_error) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_CAPACITY_UNAVAILABLE',
        '无法确认目标存储空间，已拒绝迁移'
      );
    }
    const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
    const requiredBytes = missingCanonicalBytes + missingArtifactBytes;
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SPACE_INSUFFICIENT',
        '目标存储空间不足，无法安全迁移'
      );
    }
    const targetStaging = path.join(targetRoot, '.staging');
    await this.fs.promises.rm(targetStaging, { recursive: true, force: true });
    await this.fs.promises.mkdir(targetStaging, { recursive: true });
    const targetReadonly = path.join(targetRoot, '.readonly');
    await this.fs.promises.rm(targetReadonly, { recursive: true, force: true });
    await this.fs.promises.mkdir(targetReadonly, { recursive: true });
    return { ...probe, requiredBytes, availableBytes };
  }

  async _missingCanonicalBytes(rootDir, blobs) {
    let total = 0;
    for (const blob of blobs) {
      const filePath = await this._assertManagedPath(rootDir, blob.relativePath);
      const result = await verifyFile(filePath, {
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes
      }, this.fs);
      if (!result.valid) total += blob.sizeBytes;
    }
    return total;
  }

  async _missingArtifactBytes(rootDir, artifacts) {
    let total = 0;
    for (const artifact of artifacts) {
      if (!artifact.storageRelativePath || !artifact.blob) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_LAYOUT_INCOMPLETE',
          'ready artifact 缺少可迁移的 layout v2 证据'
        );
      }
      const filePath = await this._assertManagedPath(rootDir, artifact.storageRelativePath);
      const result = await verifyFile(filePath, {
        sha256: artifact.blob.sha256,
        sizeBytes: artifact.blob.sizeBytes
      }, this.fs);
      if (!result.valid) {
        total += artifact.blob.sizeBytes;
        continue;
      }
      const canonicalPath = await this._assertManagedPath(rootDir, artifact.blob.relativePath);
      try {
        const canonicalStat = await this.fs.promises.stat(canonicalPath);
        if (canonicalStat.dev === result.stat.dev && canonicalStat.ino === result.stat.ino) {
          total += artifact.blob.sizeBytes;
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    return total;
  }

  _newJournal(targetRoot, evidence) {
    const now = new Date().toISOString();
    return {
      schemaVersion: MIGRATION_JOURNAL_SCHEMA_VERSION,
      migrationId: crypto.randomUUID(),
      archiveInstanceId: this.instanceId,
      sourceRoot: this.currentService.rootDir,
      targetRoot,
      sourceCleanupPaths: this._sourceCleanupPaths(evidence),
      targetPublishedPaths: [],
      sourceRootRemovalStartedAt: null,
      phase: 'prepared',
      startedAt: now,
      updatedAt: now,
      progress: {
        copiedBlobCount: 0,
        totalBlobCount: evidence.blobs.length,
        materializedArtifactCount: 0,
        totalArtifactCount: evidence.artifacts.length
      },
      lastError: null
    };
  }

  async _copyBlobs(journal, evidence) {
    journal = await this._writeJournal(journal, 'copying');
    const stagingDir = path.join(journal.targetRoot, '.staging');
    let copied = 0;
    for (const blob of evidence.blobs) {
      const sourcePath = await this._assertManagedPath(journal.sourceRoot, blob.relativePath);
      const sourceVerified = await verifyFile(sourcePath, blob, this.fs);
      if (!sourceVerified.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_SOURCE_BLOB_INVALID',
          '源 canonical Blob 校验失败，设置未切换'
        );
      }
      const targetPath = await this._assertManagedPath(journal.targetRoot, blob.relativePath);
      const existing = await verifyFile(targetPath, blob, this.fs);
      if (!existing.valid) {
        await this.fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await this.fs.promises.rm(targetPath, { force: true });
        const tempPath = path.join(stagingDir, `blob-${blob.id}-${crypto.randomUUID()}.tmp`);
        try {
          await pipeline(
            this.fs.createReadStream(sourcePath),
            this.fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
          );
          const staged = await verifyFile(tempPath, blob, this.fs);
          if (!staged.valid) {
            throw new ArchiveStorageRootError(
              'ARCHIVE_STORAGE_COPY_VERIFY_FAILED',
              'canonical Blob 复制后校验失败，设置未切换'
            );
          }
          await this.fs.promises.rename(tempPath, targetPath);
        } finally {
          try { await this.fs.promises.rm(tempPath, { force: true }); } catch (_error) {}
        }
      }
      copied += 1;
      journal.progress.copiedBlobCount = copied;
      journal.targetPublishedPaths = [...new Set([
        ...(journal.targetPublishedPaths || []),
        toRelativePath(blob.relativePath)
      ])].sort();
      this._emitProgress('copying', copied, evidence.blobs.length);
      journal = await this._writeJournal(journal, 'copying', {
        progress: journal.progress,
        targetPublishedPaths: journal.targetPublishedPaths
      });
      await this._inject('after-copy-blob', { copied, blobId: blob.id });
    }
    return this._writeJournal(journal, 'copying', { progress: journal.progress });
  }

  async _materializeTarget(journal, evidence) {
    journal = await this._writeJournal(journal, 'materializing-layout');
    const materializer = this.createMaterializer({
      rootDir: journal.targetRoot,
      stagingDir: path.join(journal.targetRoot, '.staging'),
      fs: this.fs
    });
    const materializations = [];
    let processed = 0;
    for (const artifact of evidence.artifacts) {
      if (!artifact.storageRelativePath || !artifact.blob) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_LAYOUT_INCOMPLETE',
          'ready artifact 缺少 layout v2 证据'
        );
      }
      const canonicalPath = await this._assertManagedPath(
        journal.targetRoot,
        artifact.blob.relativePath
      );
      const targetPath = await this._assertManagedPath(
        journal.targetRoot,
        artifact.storageRelativePath
      );
      const existing = await verifyFile(targetPath, artifact.blob, this.fs);
      let storageMode;
      if (existing.valid) {
        const canonicalStat = await this.fs.promises.stat(canonicalPath);
        const sharesCanonicalInode = canonicalStat.dev === existing.stat.dev
          && canonicalStat.ino === existing.stat.ino;
        if (sharesCanonicalInode) {
          await this.fs.promises.rm(targetPath, { force: true });
          const result = await materializer.materialize({
            artifactId: artifact.id,
            canonicalPath,
            storageRelativePath: artifact.storageRelativePath,
            sha256: artifact.blob.sha256,
            sizeBytes: artifact.blob.sizeBytes
          });
          storageMode = result.mode;
        } else {
          storageMode = 'copy';
          await this.fs.promises.chmod(targetPath, 0o444);
        }
      } else {
        await this.fs.promises.rm(targetPath, { force: true });
        const result = await materializer.materialize({
          artifactId: artifact.id,
          canonicalPath,
          storageRelativePath: artifact.storageRelativePath,
          sha256: artifact.blob.sha256,
          sizeBytes: artifact.blob.sizeBytes
        });
        storageMode = result.mode;
      }
      materializations.push({ artifactId: artifact.id, storageMode });
      processed += 1;
      journal.progress.materializedArtifactCount = processed;
      journal.targetPublishedPaths = [...new Set([
        ...(journal.targetPublishedPaths || []),
        toRelativePath(artifact.storageRelativePath)
      ])].sort();
      this._emitProgress('materializing-layout', processed, evidence.artifacts.length);
      journal = await this._writeJournal(journal, 'materializing-layout', {
        progress: journal.progress,
        targetPublishedPaths: journal.targetPublishedPaths
      });
    }
    journal = await this._writeJournal(journal, 'materializing-layout', {
      progress: journal.progress
    });
    return { journal, materializations };
  }

  async _verifyTarget(journal, evidence) {
    journal = await this._writeJournal(journal, 'verifying');
    let processed = 0;
    const total = evidence.blobs.length + evidence.artifacts.length;
    for (const blob of evidence.blobs) {
      const filePath = await this._assertManagedPath(journal.targetRoot, blob.relativePath);
      const result = await verifyFile(filePath, blob, this.fs);
      if (!result.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_TARGET_VERIFY_FAILED',
          '目标 canonical Blob 校验失败，设置未切换'
        );
      }
      processed += 1;
      this._emitProgress('verifying', processed, total);
    }
    for (const artifact of evidence.artifacts) {
      const filePath = await this._assertManagedPath(journal.targetRoot, artifact.storageRelativePath);
      const result = await verifyFile(filePath, artifact.blob, this.fs);
      if (!result.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_TARGET_VERIFY_FAILED',
          '目标目录化文件校验失败，设置未切换'
        );
      }
      processed += 1;
      this._emitProgress('verifying', processed, total);
    }
    return journal;
  }

  async _commitSwitch(journal, materializations, targetService, expectedStoredRoot) {
    this.repository.commitStorageRootSwitch({
      storageRoot: journal.targetRoot,
      expectedStoredRoot,
      materializations
    });
    this.currentService = targetService;
    this.runtimeDelegate.switchService(targetService);
    await this._inject('after-switch-commit', { targetRoot: journal.targetRoot });
    journal = await this._writeJournal(journal, 'switched');
    this._emitProgress('switched', 1, 1);
    return journal;
  }

  async _startMigration(targetRoot, existingJournal = null) {
    let journal = existingJournal;
    const expectedStoredRoot = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY);
    try {
      if (!journal && await this._readJournal()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_MIGRATION_PENDING',
          '已存在未收口的存档迁移记录，已拒绝覆盖'
        );
      }
      await this._assertSourceReady();
      const evidence = this._evidence();
      if (evidence.artifacts.some((artifact) => (
        !artifact.storageRelativePath
        || !artifact.blob
        || artifact.storageLayoutVersion !== 2
      ))) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_LAYOUT_INCOMPLETE',
          '当前存档仍有未完成的目录化文件，不能迁移'
        );
      }
      if (!journal) {
        await this._validateTarget(targetRoot, evidence);
        journal = this._newJournal(targetRoot, evidence);
        await atomicWriteJson(this.fs, this.journalPath, journal);
        await this._inject('after-prepared', { targetRoot });
      } else {
        // pre-switch 失败后 source 仍可新增或删除批次。清理集合只能单调合并：
        // 当前证据补进新增路径，旧 checkpoint 则保留已删除批次可能留下的文件/空目录。
        const sourceCleanupPaths = [...new Set([
          ...(Array.isArray(journal.sourceCleanupPaths) ? journal.sourceCleanupPaths : []),
          ...this._sourceCleanupPaths(evidence)
        ])].sort();
        // 先按旧 journal 的 durable progress 清掉已经发布、但当前 DB 已删除的
        // 目标副本；随后才能用当前 evidence 重置下一轮发布计划。
        await this._reconcilePreSwitchTargetInventory(journal, evidence);
        const desiredTargetPaths = new Set(this._targetPublishedPaths(evidence));
        const targetPublishedPaths = (journal.targetPublishedPaths || [])
          .filter((relativePath) => desiredTargetPaths.has(relativePath));
        journal = await this._writeJournal(journal, journal.phase, {
          sourceCleanupPaths,
          targetPublishedPaths,
          progress: {
            ...journal.progress,
            copiedBlobCount: 0,
            totalBlobCount: evidence.blobs.length,
            materializedArtifactCount: 0,
            totalArtifactCount: evidence.artifacts.length
          }
        });
        await this._validateTarget(targetRoot, evidence);
      }
      this._emitProgress(journal.phase, 0, evidence.blobs.length + evidence.artifacts.length);
      journal = await this._copyBlobs(journal, evidence);
      const materialized = await this._materializeTarget(journal, evidence);
      journal = await this._verifyTarget(materialized.journal, evidence);
      // Commit 之前只使用上面的只读校验；正常 Service.initialize()
      // 会修复/作废 DB 证据，只能在 setting 已指向目标根后运行。
      const targetService = this.createService(journal.targetRoot);
      journal = await this._commitSwitch(
        journal,
        materialized.materializations,
        targetService,
        expectedStoredRoot
      );
      try {
        await this._initializeExistingService(targetService);
      } catch (error) {
        this.currentService = null;
        this.runtimeDelegate.clearService(journal.targetRoot);
        throw error;
      }
      return this._finishCleanup(journal);
    } catch (error) {
      if (journal && await pathExists(this.fs, this.journalPath)) {
        try {
          const persistedJournal = await this._readJournal();
          const failureJournal = persistedJournal || journal;
          await this._writeJournal(failureJournal, failureJournal.phase, {
            lastError: {
              code: String(error && error.code || 'ARCHIVE_STORAGE_MIGRATION_FAILED'),
              message: String(error && error.message || '存档迁移失败')
            }
          });
        } catch (_journalError) {}
      }
      throw error;
    }
  }

  async _cleanupOldRoot(journal) {
    const rootDir = journal.sourceRoot;
    if (!await pathExists(this.fs, rootDir)) {
      if (journal.sourceRootRemovalStartedAt) {
        return { ok: true, journal };
      }
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SOURCE_ROOT_OFFLINE',
        '旧存档位置离线或暂时不可见，已保留清理记录',
        { retryable: true }
      );
    }
    const marker = await this._readMarker(rootDir);
    if (marker) {
      validateMarker(marker, this.instanceId);
    } else if (!journal.sourceRootRemovalStartedAt) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_MARKER_MISSING',
        '旧存档根身份标记缺失，已停止自动清理',
        { retryable: true }
      );
    }
    if (!Array.isArray(journal.sourceCleanupPaths)) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_JOURNAL_INVALID',
        '旧存档根清理证据缺失，已停止自动清理'
      );
    }
    const knownFiles = journal.sourceCleanupPaths.map(toRelativePath);
    const directories = new Set(['blobs/sha256', 'blobs']);
    for (const relativePath of knownFiles) {
      const filePath = await this._assertManagedPath(rootDir, relativePath);
      await this.fs.promises.rm(filePath, { force: true });
      for (const directory of parentRelativePaths(relativePath)) directories.add(directory);
    }
    for (const internal of INTERNAL_TRANSIENT_DIRS) {
      const internalPath = path.join(rootDir, internal);
      if (await pathExists(this.fs, internalPath)) {
        const stat = await this.fs.promises.lstat(internalPath);
        if (stat.isSymbolicLink()) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_SYMLINK_REJECTED',
            '旧根内部临时目录被替换为符号链接，已停止清理'
          );
        }
        await this.fs.promises.rm(internalPath, { recursive: true, force: true });
      }
    }
    for (const relativeDirectory of [...directories].sort((a, b) => b.length - a.length)) {
      const directory = await this._assertManagedPath(rootDir, relativeDirectory);
      try {
        await this.fs.promises.rmdir(directory);
      } catch (error) {
        if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
    const entries = await this.fs.promises.readdir(rootDir);
    const unknown = entries.filter((name) => name !== ROOT_MARKER_FILE);
    if (unknown.length > 0) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_OLD_ROOT_NOT_EMPTY',
        '旧存档根包含未知项目，已保留并等待人工处理',
        { retryable: true }
      );
    }
    if (!journal.sourceRootRemovalStartedAt) {
      journal = await this._writeJournal(journal, 'cleanup-pending', {
        sourceRootRemovalStartedAt: new Date().toISOString(),
        lastError: null
      });
    }
    try {
      await this.fs.promises.rm(path.join(rootDir, ROOT_MARKER_FILE), { force: true });
      await this.fs.promises.rmdir(rootDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true };
      try {
        const rootStat = await this.fs.promises.lstat(rootDir);
        if (rootStat.isDirectory() && !rootStat.isSymbolicLink()
            && !await this._readMarker(rootDir)) {
          await this._writeMarker(rootDir);
        }
      } catch (restoreError) {
        if (!restoreError || restoreError.code !== 'ENOENT') {
          error.markerRestoreError = restoreError;
        }
      }
      error.cleanupJournal = journal;
      throw error;
    }
    return { ok: true, journal };
  }

  async _finishCleanup(journal) {
    let cleanupJournal = journal;
    try {
      const cleaned = await this._cleanupOldRoot(journal);
      cleanupJournal = cleaned && cleaned.journal ? cleaned.journal : journal;
      await this._inject('after-source-root-removed', {
        sourceRoot: cleanupJournal.sourceRoot,
        targetRoot: cleanupJournal.targetRoot
      });
    } catch (error) {
      cleanupJournal = error && error.cleanupJournal ? error.cleanupJournal : journal;
      let persistedCleanupJournal = cleanupJournal;
      try {
        const persisted = await this._readJournal();
        if (persisted && persisted.migrationId === journal.migrationId) {
          persistedCleanupJournal = persisted;
        }
      } catch (_readError) {}
      journal = await this._writeJournal(persistedCleanupJournal, 'cleanup-pending', {
        lastError: {
          code: String(error && error.code || 'ARCHIVE_STORAGE_CLEANUP_FAILED'),
          message: String(error && error.message || '旧存档根清理待重试')
        }
      });
      this._emitProgress('cleanup-pending', 0, 1, 'cleanup-pending');
      return {
        status: 'partial',
        ok: false,
        code: 'ARCHIVE_STORAGE_CLEANUP_PENDING',
        message: '存档位置已变更，旧位置部分内容等待下次启动清理',
        storageRoot: journal.targetRoot
      };
    }
    journal = await this._writeJournal(cleanupJournal, 'done', { lastError: null });
    this._emitProgress('done', 1, 1, 'done');
    await this.fs.promises.rm(this.journalPath, { force: true });
    return {
      status: 'success',
      ok: true,
      message: '存档位置已变更',
      storageRoot: journal.targetRoot
    };
  }

  async _recover(journal, storedRoot) {
    const stored = storedRoot ? normalizeRoot(storedRoot) : null;
    const effectiveStored = stored || this.defaultRoot;
    const resolvedEffectiveStored = await this._existingRoot(effectiveStored, true);
    if (PRE_SWITCH_PHASES.has(journal.phase)) {
      if (comparablePath(resolvedEffectiveStored) === comparablePath(journal.targetRoot)) {
        const targetRoot = await this._prepareActiveRoot(journal.targetRoot, { configured: true });
        await this._verifyEvidenceFiles(targetRoot, this._evidence());
        const target = await this._initializeService(targetRoot);
        if (target.initialized.ok === false) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_TARGET_CONSISTENCY_FAILED',
            '已提交的新存档根一致性检查失败'
          );
        }
        this.currentService = target.service;
        this.runtimeDelegate.switchService(target.service);
        if (!journal.sourceCleanupPaths) {
          journal = await this._writeJournal(journal, journal.phase, {
            sourceCleanupPaths: this._sourceCleanupPaths(this._evidence())
          });
        }
        journal = await this._writeJournal(journal, 'switched');
        await this._finishCleanup(journal);
        return target.initialized;
      }
      if (comparablePath(resolvedEffectiveStored) !== comparablePath(journal.sourceRoot)) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_MIGRATION_STATE_CONFLICT',
          '存档设置与迁移恢复记录冲突，已停止自动处理'
        );
      }
      const sourceRoot = await this._prepareActiveRoot(journal.sourceRoot, {
        configured: Boolean(storedRoot)
      });
      const source = await this._initializeService(sourceRoot);
      this.currentService = source.service;
      this.runtimeDelegate.switchService(source.service);
      if (!this.runtimeDelegate.requestMaintenance('正在恢复存档位置迁移')) {
        const error = new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_MAINTENANCE',
          '存档中心正在维护，已保留可用的旧存档位置'
        );
        this._emitProgress(journal.phase, 0, 0, 'failed');
        return {
          ...source.initialized,
          ok: true,
          available: true,
          migrationRecovery: publicFailure(error)
        };
      }
      try {
        this.runtimeDelegate.activateMaintenance();
        await runArchiveRootOperation(sourceRoot, () => this._startMigration(journal.targetRoot, journal));
      } catch (error) {
        const effectiveAfterFailure = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY)
          || this.defaultRoot;
        const resolvedAfterFailure = await this._canonicalizeWithExistingAncestor(
          effectiveAfterFailure
        );
        if (comparablePath(resolvedAfterFailure) !== comparablePath(sourceRoot)) throw error;
        this.currentService = source.service;
        this.runtimeDelegate.switchService(source.service);
        this._emitProgress(journal.phase, 0, 0, 'failed');
        return {
          ...source.initialized,
          ok: true,
          available: true,
          migrationRecovery: publicFailure(error)
        };
      } finally {
        this.runtimeDelegate.releaseMaintenance();
      }
      return source.initialized;
    }
    if (comparablePath(resolvedEffectiveStored) !== comparablePath(journal.targetRoot)) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_MIGRATION_STATE_CONFLICT',
        '迁移已切换记录与当前存档设置冲突，已停止自动处理'
      );
    }
    const targetRoot = await this._prepareActiveRoot(journal.targetRoot, { configured: true });
    await this._verifyEvidenceFiles(targetRoot, this._evidence());
    const target = await this._initializeService(targetRoot);
    this.currentService = target.service;
    this.runtimeDelegate.switchService(target.service);
    if (journal.phase === 'done') {
      await this.fs.promises.rm(this.journalPath, { force: true });
    } else {
      await this._finishCleanup(journal);
    }
    return target.initialized;
  }
}

function createArchiveStorageRootManager(options = {}) {
  return new ArchiveStorageRootManager(options);
}

module.exports = {
  ArchiveStorageRootError,
  ArchiveStorageRootManager,
  MIGRATION_JOURNAL_SCHEMA_VERSION,
  MIGRATION_PHASES,
  ROOT_MARKER_FILE,
  ROOT_MARKER_SCHEMA_VERSION,
  ROOT_MARKER_TYPE,
  atomicWriteJson,
  createArchiveStorageRootManager,
  exactMarker,
  validateJournal,
  validateMarker
};
