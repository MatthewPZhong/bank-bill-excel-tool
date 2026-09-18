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
  syncStagedFile,
  verifyFile
} = require('./storage-materializer');
const { sourceSnapshotFromStat } = require('./source-snapshot');
const { captureFileIdentity } = require('./batch-delete-plan');

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

function publishedFileIdentity(stat) {
  const snapshot = sourceSnapshotFromStat(stat);
  if (!snapshot || stat.isSymbolicLink()) throw new ArchiveStorageRootError(
    'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', '迁移发布对象不是原普通文件');
  const birthtimeMs = typeof stat.birthtimeNs === 'bigint'
    ? Number(stat.birthtimeNs / 1000000n) + Number(stat.birthtimeNs % 1000000n) / 1e6
    : Number(stat.birthtimeMs);
  return { ...snapshot, dev: String(stat.dev), birthtimeMs, mode: Number(stat.mode), nlink: Number(stat.nlink) };
}

function assertPublishedIdentity(expected, actual, ignored = []) {
  if (!expected || !actual || ['dev', 'ino', 'sizeBytes', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'mode', 'nlink']
    .some((field) => !ignored.includes(field) && expected[field] !== actual[field])) {
    throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',
      '迁移发布路径不再属于本次创建的原文件，保留文件及恢复记录');
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
    handle = await fsImpl.promises.open(directory, process.platform === 'win32' ? 'r+' : 'r');
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
  for (const field of ['sourceFileIdentities', 'targetFileIdentities']) {
    const identities = journal[field];
    if (identities == null) continue;
    if (typeof identities !== 'object' || Array.isArray(identities)
        || Object.entries(identities).some(([relativePath, identity]) => (
          toRelativePath(relativePath) !== relativePath || !identity || typeof identity !== 'object'
          || typeof identity.exists !== 'boolean' || !Array.isArray(identity.parents)
          || !identity.root || !identity.root.dev || !identity.root.ino
          || (identity.exists && (!identity.dev || !identity.ino
            || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 0
            || !Number.isFinite(identity.mtimeMs) || !Number.isFinite(identity.ctimeMs)
            || !Number.isFinite(identity.birthtimeMs) || !Number.isSafeInteger(identity.mode)
            || !Number.isSafeInteger(identity.nlink) || identity.nlink < 1
            || !/^[a-f0-9]{64}$/.test(identity.sha256)))
        ))) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_JOURNAL_INVALID', '迁移文件身份记录无效，已停止自动处理');
    }
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
    this.entryMaintenanceOwnerToken = '';
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

  async hasUnresolvedMigration() {
    // 磁盘 journal 才是迁移收口事实；锁释放或当前根明确都不能替代它。
    return Boolean(await this._readJournal());
  }

  async assertDeleteAllowed(options = {}) {
    const maintenance = this.runtimeDelegate.getMaintenanceState();
    const ownedRetention = options.origin === 'retention'
      && this.entryMaintenanceOwnerToken
      && options.ownerToken === this.entryMaintenanceOwnerToken
      && maintenance.requested && !maintenance.active;
    if (this.migrationPromise || (this.isMaintenanceRequested() && !ownedRetention)) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_MAINTENANCE', '存档位置正在维护，暂不能永久删除');
    }
    if (await this.hasUnresolvedMigration()) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_MIGRATION_PENDING',
        '存档迁移尚未安全收口，请恢复迁移后重新确认删除'
      );
    }
    return true;
  }

  _migrationIdentity(journal) {
    return {
      migrationId: journal.migrationId,
      archiveInstanceId: journal.archiveInstanceId,
      sourceRoot: journal.sourceRoot,
      targetRoot: journal.targetRoot
    };
  }

  _jobMatchesMigration(job, journal) {
    const expected = this._migrationIdentity(journal);
    return Boolean(job.archiveInstanceId === journal.archiveInstanceId
      && job.migration && Object.keys(expected).every(
        (key) => job.migration[key] === expected[key]
      ));
  }

  _jobItemsComplete(job) {
    const items = job.plan && job.plan.items;
    return Array.isArray(items) && items.every((item) => (
      ['deleted', 'already-missing', 'preserved-shared'].includes(item.state)
    ));
  }

  _jobRoot(job) {
    const identity = job.plan && job.plan.rootIdentity;
    return identity && (identity.realPath || identity.rootDir) || '';
  }

  _migrationCleanupConflict(message) {
    return new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_RECOVERY_CONFLICT', message);
  }

  async _captureMigrationFile(rootDir, relativePath, sha256, fingerprint, publishedIdentity) {
    const identity = await captureFileIdentity({
      fs: this.fs,
      rootDir,
      _assertManagedRoot: () => this._assertRootDirectory(rootDir),
      _resolveManagedRelative: (value) => path.join(rootDir, ...toRelativePath(value).split('/'))
    }, relativePath, { sha256, fingerprint });
    const root = await this.fs.promises.lstat(rootDir);
    const result = { ...identity, root: { dev: String(root.dev), ino: String(root.ino) } };
    if (publishedIdentity) {
      assertPublishedIdentity(publishedIdentity, result);
      if (JSON.stringify(publishedIdentity.root) !== JSON.stringify(result.root)
          || JSON.stringify(publishedIdentity.parents) !== JSON.stringify(result.parents)) {
        throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',
          '迁移发布根或父目录已被替换，保留文件及恢复记录');
      }
    }
    return result;
  }

  async _assertMigrationFile(journal, side, relativePath) {
    const rootDir = journal[`${side}Root`];
    const inventory = journal[`${side}FileIdentities`] || {};
    const expected = inventory[relativePath];
    const actual = await this._captureMigrationFile(rootDir, relativePath, expected?.sha256);
    const changed = () => {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED', '迁移文件或父目录已被替换，保留两根及恢复记录');
    };
    if (!expected) {
      if (actual.exists) throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING',
        '旧迁移记录缺少现存文件的持久对象身份，保留两根及恢复记录');
      return actual;
    }
    if (JSON.stringify(expected.root) !== JSON.stringify(actual.root)
        || !actual.parents.every((parent) => expected.parents.some((prior) => (
          prior.relativePath === parent.relativePath && prior.dev === parent.dev && prior.ino === parent.ino
        )))) changed();
    if (!actual.exists) return actual;
    if (!expected.exists || ['dev', 'ino', 'sizeBytes', 'mtimeMs', 'sha256']
      .some((field) => expected[field] !== actual[field])
      || ['birthtimeMs', 'mode'].some((field) => expected[field] !== undefined && expected[field] !== actual[field])
      || JSON.stringify(expected.parents) !== JSON.stringify(actual.parents)) changed();
    if (expected.ctimeMs === actual.ctimeMs
        && (expected.nlink === undefined || expected.nlink === actual.nlink)) return actual;
    // 仅冻结 inventory 内自身已消失的硬链接能解释 unlink 的 ctime/nlink 变化。
    if (!Number.isSafeInteger(expected.nlink) || expected.nlink < 2 || actual.nlink >= expected.nlink) changed();
    let missing = 0;
    for (const [siblingPath, sibling] of Object.entries(inventory)) {
      if (siblingPath === relativePath || !sibling.exists
          || ['dev', 'ino', 'sizeBytes', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'mode', 'nlink', 'sha256']
            .some((field) => sibling[field] !== expected[field])) continue;
      const current = await this._captureMigrationFile(rootDir, siblingPath, expected.sha256);
      if (!current.exists) {
        if (!current.parents.every((parent) => sibling.parents.some((prior) => (
          prior.relativePath === parent.relativePath && prior.dev === parent.dev && prior.ino === parent.ino
        )))) changed();
        missing += 1;
      } else if (['dev', 'ino', 'sizeBytes', 'mtimeMs', 'birthtimeMs', 'mode', 'sha256']
        .some((field) => current[field] !== expected[field])
        || current.ctimeMs !== actual.ctimeMs || current.nlink !== actual.nlink
        || JSON.stringify(current.parents) !== JSON.stringify(sibling.parents)) changed();
    }
    if (!missing || actual.nlink !== expected.nlink - missing) changed();
    return actual;
  }

  async _assertCleanupInventory(journal) {
    // 在任何相关删除之前核验两根；不能先清掉原根再发现目标或旧 job 无法认证。
    for (const job of this.repository.listCleanupJobs()) {
      if (job.planError || job.planVersion < 2 || !job.plan
          || job.archiveInstanceId !== journal.archiveInstanceId) {
        throw this._migrationCleanupConflict('已有删除计划缺少可核验的原对象身份，保留两根及恢复记录');
      }
      const root = comparablePath(this._jobRoot(job));
      if (![comparablePath(journal.sourceRoot), comparablePath(journal.targetRoot)].includes(root)
          || (job.state === 'waiting-migration' && (!this._jobMatchesMigration(job, journal) || !this._jobItemsComplete(job)))) {
        throw this._migrationCleanupConflict('已有删除计划与原迁移身份不一致，保留两根及恢复记录');
      }
      if (job.state === 'waiting-migration') continue;
      if (!PRE_SWITCH_PHASES.has(journal.phase) && root === comparablePath(journal.sourceRoot)
          && job.plan.items.some((item) => !['materialized', 'blob'].includes(item.kind)
            || !(journal.sourceCleanupPaths || []).includes(item.managedRelativePath))) {
        throw this._migrationCleanupConflict('旧根删除计划含迁移清理证据未覆盖的目标');
      }
      const inventories = new Map();
      for (const item of job.plan.items) {
        const originalRoot = item.managedRootIdentity || job.plan.rootIdentity;
        if (!originalRoot?.rootDir || !originalRoot.dev || !originalRoot.ino) {
          throw this._migrationCleanupConflict('已有删除计划缺少原根身份，保留两根及恢复记录');
        }
        if (!inventories.has(originalRoot.rootDir)) inventories.set(originalRoot.rootDir, {});
        inventories.get(originalRoot.rootDir)[item.managedRelativePath] = {
          ...item.expectedIdentity, root: { dev: originalRoot.dev, ino: originalRoot.ino }
        };
      }
      for (const [originalRoot, identities] of inventories) {
        if (comparablePath(originalRoot) === comparablePath(journal.sourceRoot)
            && journal.sourceRootRemovalStartedAt && !await pathExists(this.fs, originalRoot)) continue;
        for (const relativePath of Object.keys(identities)) {
          await this._assertMigrationFile({ sourceRoot: originalRoot, sourceFileIdentities: identities }, 'source', relativePath);
        }
      }
    }
    const sourceExists = await pathExists(this.fs, journal.sourceRoot);
    if (sourceExists) {
      const marker = await this._readMarker(journal.sourceRoot);
      if (marker || !journal.sourceRootRemovalStartedAt) validateMarker(marker, this.instanceId);
      // 旧 journal 缺清单时，DB 路径只用于核验范围，不能当作新文件补造身份。
      const sourcePaths = journal.sourceCleanupPaths || this._sourceCleanupPaths(this._evidence());
      for (const relativePath of sourcePaths) {
        await this._assertMigrationFile(journal, 'source', relativePath);
      }
    } else if (!journal.sourceRootRemovalStartedAt) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_SOURCE_ROOT_OFFLINE', '旧存档位置离线，保留迁移恢复记录');
    }
    validateMarker(await this._readMarker(journal.targetRoot), this.instanceId);
    const desired = new Set(this._targetPublishedPaths(this._evidence()));
    for (const relativePath of journal.targetPublishedPaths || []) {
      if (PRE_SWITCH_PHASES.has(journal.phase) || !desired.has(relativePath)) {
        await this._assertMigrationFile(journal, 'target', relativePath);
      }
    }
  }

  async _prepareOverlappingCleanup(journal) {
    const jobs = this.repository.listCleanupJobs();
    await this._assertCleanupInventory(journal);
    if (jobs.length === 0) return;
    const stored = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY) || this.defaultRoot;
    if (!PRE_SWITCH_PHASES.has(journal.phase)
        || comparablePath(await this._existingRoot(stored, true)) !== comparablePath(journal.sourceRoot)
        || comparablePath(this.currentService.rootDir) !== comparablePath(journal.sourceRoot)) {
      throw this._migrationCleanupConflict('删除计划与切换前迁移的原根不一致，已保留恢复证据');
    }
    validateMarker(await this._readMarker(journal.sourceRoot), this.instanceId);
    validateMarker(await this._readMarker(journal.targetRoot), this.instanceId);
    const knownPaths = new Set(journal.sourceCleanupPaths || []);
    for (const job of jobs) {
      if (job.state === 'waiting-migration') {
        if (!this._jobMatchesMigration(job, journal) || !this._jobItemsComplete(job)) {
          throw this._migrationCleanupConflict('挂起删除计划的迁移身份或逐项完成证据不一致');
        }
        continue;
      }
      const root = this._jobRoot(job);
      if (root && comparablePath(root) !== comparablePath(journal.sourceRoot)) {
        throw this._migrationCleanupConflict('已有删除计划不属于原迁移源根');
      }
      if (!root) {
        const paths = [
          ...(job.materializedPaths || []),
          ...(job.releasedBlobs || []).map((blob) => blob.relativePath)
        ];
        if (job.planVersion >= 2 || paths.length === 0
            || paths.some((relativePath) => !knownPaths.has(relativePath))) {
          throw this._migrationCleanupConflict('历史删除计划缺少可关联原迁移的路径证据');
        }
      }
      const result = await this.currentService._executeCleanupJobUnlocked(job, {
        waitForMigration: this._migrationIdentity(journal)
      });
      const updated = this.repository.getCleanupJob(job.id);
      if (!updated || updated.state !== 'waiting-migration'
          || !this._jobMatchesMigration(updated, journal) || !this._jobItemsComplete(updated)) {
        throw this._migrationCleanupConflict(
          result && result.message || '原根删除计划尚未完成，已停止迁移恢复'
        );
      }
      await this._inject('after-delete-waiting-migration', { migrationId: journal.migrationId, jobId: job.id });
    }
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

  async beginEntryMaintenance(message = '存档后台维护正在进行，请稍后重试新存档') {
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
      // entry maintenance 只关闭新 archive admission 与 storage migration；
      // list/open 继续在每个分页之间进入 root operation tail。
      this.entryMaintenanceOwnerToken = crypto.randomUUID();
      return {
        acquired: true,
        ownerToken: this.entryMaintenanceOwnerToken,
        rootDir: sourceService ? sourceService.rootDir : ''
      };
    } catch (error) {
      this.runtimeDelegate.releaseMaintenance();
      this._resumeBackgroundArchiveChecks();
      throw error;
    }
  }

  async endEntryMaintenance(ownerToken) {
    if (!this.entryMaintenanceOwnerToken
        || String(ownerToken || '') !== this.entryMaintenanceOwnerToken) {
      return { released: false };
    }
    this.entryMaintenanceOwnerToken = '';
    this.runtimeDelegate.releaseMaintenance();
    this._resumeBackgroundArchiveChecks();
    return { released: true };
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

  async _assertRootDirectory(rootDir) {
    let stat;
    try {
      stat = await this.fs.promises.lstat(rootDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_SOURCE_ROOT_OFFLINE',
          '存档位置离线或暂时不可见',
          { retryable: true }
        );
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SYMLINK_REJECTED',
        '存档根被替换为符号链接或目录联接'
      );
    }
  }

  async _readMarker(rootDir) {
    await this._assertRootDirectory(rootDir);
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
      // V2 的旧兼容数组刻意为空，所有权扫描仍须读取真实计划，避免遗失待清理文件证据。
      for (const item of job.plan && job.plan.items || []) {
        if (item.managedRelativePath) files.add(toRelativePath(item.managedRelativePath));
      }
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
    for (const relativePath of stale) await this._assertMigrationFile(journal, 'target', relativePath);
    for (const relativePath of stale) {
      await this._assertMigrationFile(journal, 'target', relativePath);
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
    await this._assertRootDirectory(rootDir);
    const allowMissingMarker = options.allowMissingMarker === true;
    const allowUnknownContent = options.allowUnknownContent === true;
    const allowLegacyEmptyBlobShards = options.allowLegacyEmptyBlobShards === true;
    const rejectInternalTransientContent = options.rejectInternalTransientContent === true;
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
              && !(INTERNAL_TRANSIENT_DIRS.has(top) && !rejectInternalTransientContent)
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
              && !(INTERNAL_TRANSIENT_DIRS.has(top) && !rejectInternalTransientContent)
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
    await this._assertRootDirectory(rootDir);
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
        const code = String(error && error.code || 'ARCHIVE_STORAGE_OWNERSHIP_FAILED');
        this._setOwnershipProgress({
          status: 'failed',
          lastErrorCode: code
        });
        if (this.currentService
            && this.ownershipScan
            && comparablePath(this.currentService.rootDir)
              === comparablePath(this.ownershipScan.rootDir)) {
          this.currentService = null;
          this.runtimeDelegate.clearService(this.ownershipScan.rootDir);
        }
        return {
          ...this.getOwnershipProgress(),
          ok: false,
          code,
          message: String(error && error.message || '存档目录所有权扫描失败')
        };
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

  async runNoncriticalOwnershipScan() {
    if (!this.currentService) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
        '当前存档位置不可用'
      );
    }
    const evidence = this._evidence();
    const paths = this._evidenceOwnershipPaths(evidence);
    this.ownershipScan = {
      rootDir: this.currentService.rootDir,
      paths,
      cursor: 0,
      remaining: paths.length,
      verifiedPaths: new Set()
    };
    this._setOwnershipProgress({
      status: paths.length === 0 ? 'complete' : 'pending',
      processed: 0,
      remaining: paths.length,
      cursor: 0,
      lastErrorCode: ''
    });
    return this.resumeBackgroundOwnershipScan();
  }

  async resumeDeferredCleanup(options = {}) {
    const journal = await this._readJournal();
    if (!journal) {
      if (this.repository.listCleanupJobs().some((job) => job.state === 'waiting-migration')) {
        throw this._migrationCleanupConflict('删除计划等待的迁移完成证据缺失，已停止恢复');
      }
      return { ok: true, status: 'complete', processed: 0 };
    }
    if (PRE_SWITCH_PHASES.has(journal.phase)) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_MIGRATION_PENDING',
        '切换前迁移恢复不能作为后台保洁执行'
      );
    }
    const ownedByEntryLease = Boolean(
      this.entryMaintenanceOwnerToken
      && String(options.ownerToken || '') === this.entryMaintenanceOwnerToken
      && this.runtimeDelegate.getMaintenanceState().requested
      && !this.runtimeDelegate.getMaintenanceState().active
    );
    if (ownedByEntryLease) {
      const result = journal.phase === 'done'
        ? await this._finalizeMigrationDeletes(journal)
        : await this._finishCleanup(journal);
      return { ...result, processed: result.ok ? 1 : 0 };
    }
    if (this.migrationPromise || this.isMaintenanceRequested()) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_MAINTENANCE', '存档位置正在维护');
    }
    if (!this.runtimeDelegate.requestMaintenance('正在清理旧存档位置')) {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_MAINTENANCE', '存档位置正在维护');
    }
    try {
      await this.waitForArchiveOperations();
      this.runtimeDelegate.activateMaintenance();
      const result = journal.phase === 'done'
        ? await this._finalizeMigrationDeletes(journal)
        : await this._finishCleanup(journal);
      return { ...result, processed: result.ok ? 1 : 0 };
    } finally {
      this.runtimeDelegate.releaseMaintenance();
    }
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
      if (stat.isSymbolicLink()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_SYMLINK_REJECTED',
          '存档根被替换为符号链接或目录联接'
        );
      }
      if (!stat.isDirectory()) {
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
    if (marker) {
      validateMarker(marker, this.instanceId);
      // 有效 marker 的稳态启动只核验固定关键祖先。全 DB evidence 与非关键
      // ownership 分页由存档中心首次进入维护接管，不能在这里线性扫描历史记录。
      const criticalPaths = ['.readonly', '.staging', 'blobs', 'blobs/sha256'];
      const verifiedPaths = new Set();
      await this._assertEvidencePathsOwned(resolvedRoot, null, {
        relativePaths: criticalPaths,
        afterIndex: 0,
        limit: criticalPaths.length,
        verifiedPaths
      });
      this.ownershipScan = null;
      this._setOwnershipProgress({
        status: 'deferred',
        processed: 0,
        remaining: 0,
        cursor: 0,
        lastErrorCode: ''
      });
      return resolvedRoot;
    }
    const evidence = this._evidence();
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
    service.assertManagedObjectMutationAllowed = async (relativePath) => {
      // 读取、后台修复与作废共用冻结证据；迁移完成后自动恢复正常维护。
      const journal = await this._readJournal();
      if (!journal || journal.phase === 'done'
          || comparablePath(service.rootDir) !== comparablePath(journal.sourceRoot)) return;
      if (journal.sourceCleanupPaths == null
          || journal.sourceCleanupPaths.includes(toRelativePath(relativePath))) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_MIGRATION_PENDING',
          '迁移恢复期间暂缓修改原存档文件，可继续读取已校验的 canonical Blob',
          { retryable: true }
        );
      }
    };
    service.assertDeleteAllowed = (options) => this.assertDeleteAllowed(options);
    service.getDeleteMigrationContext = async () => {
      const journal = await this._readJournal();
      return journal ? { ...this._migrationIdentity(journal), phase: journal.phase } : null;
    };
    // 历史迁移与删除重叠时由下方恢复协调驱动，不能在 Service 初始化时提前收口 job。
    const migrationPending = await this.hasUnresolvedMigration();
    const initialized = await service.initialize({
      startBackgroundMaterialization: false,
      deferStartupRecovery: this.deferStartupRecovery || migrationPending
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
        if (this.repository.listCleanupJobs().some((job) => job.state === 'waiting-migration')) {
          throw this._migrationCleanupConflict('删除计划等待的迁移 journal 缺失，无法确认清理完成');
        }
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
      await this._assertRootDirectory(this.currentService.rootDir);
      targetRoot = await this._selectTarget();
      if (!targetRoot) return { status: 'cancelled' };
      const realTarget = await this._existingRoot(targetRoot, true);
      if (comparablePath(realTarget) === comparablePath(this.currentService.rootDir)) {
        return { status: 'success', noChange: true, message: '存档位置未变化' };
      }
      if (pathsOverlap(this.currentService.rootDir, realTarget)) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_ROOT_OVERLAP',
          '新存档位置不能是当前存档位置本身、其上级或子目录'
        );
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

  async _assertSourceReady(existingJournal = null) {
    await this._assertOwnershipScanComplete(this.currentService.rootDir);
    const evidence = this._evidence();
    await this._walkOwnedRoot(this.currentService.rootDir, evidence, {
      rejectInternalTransientContent: true,
      allowLegacyEmptyBlobShards: true
    });
    await this._verifyEvidenceFiles(this.currentService.rootDir, evidence);
    const blockingJobs = this.repository.listCleanupJobs().filter((job) => !(
      existingJournal && PRE_SWITCH_PHASES.has(existingJournal.phase)
      && job.state === 'waiting-migration'
      && this._jobMatchesMigration(job, existingJournal)
      && this._jobItemsComplete(job)
      && comparablePath(this._jobRoot(job)) === comparablePath(existingJournal.sourceRoot)
    ));
    if (blockingJobs.length > 0) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SOURCE_NOT_CLEAN',
        '当前存档根仍有完整性或物理清理问题，请解决后再迁移',
        { retryable: true }
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
      await this._walkOwnedRoot(targetRoot, {
        files: new Set([ROOT_MARKER_FILE]),
        directories: new Set([
          '.staging', '.readonly', 'blobs', 'blobs/sha256'
        ])
      }, {
        rejectInternalTransientContent: true,
        allowLegacyEmptyBlobShards: true
      });
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
    for (const name of INTERNAL_TRANSIENT_DIRS) {
      const directory = path.join(targetRoot, name);
      if (await pathExists(this.fs, directory)) {
        const stat = await this.fs.promises.lstat(directory);
        const entries = stat.isDirectory() && !stat.isSymbolicLink()
          ? await this.fs.promises.readdir(directory)
          : [name];
        if (!stat.isDirectory() || stat.isSymbolicLink() || entries.length > 0) {
          throw new ArchiveStorageRootError(
            'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
            '目标存档根的内部临时目录包含未知内容'
          );
        }
      } else {
        await this.fs.promises.mkdir(directory, { recursive: true });
      }
    }
    return { ...probe, requiredBytes, availableBytes };
  }

  async _validateResumeTarget(journal, evidence) {
    const files = new Set([ROOT_MARKER_FILE]);
    const directories = new Set(['.staging', '.readonly', 'blobs', 'blobs/sha256']);
    for (const relativePath of journal.targetPublishedPaths || []) {
      const normalized = toRelativePath(relativePath);
      files.add(normalized);
      for (const parent of parentRelativePaths(normalized)) directories.add(parent);
    }
    validateMarker(await this._readMarker(journal.targetRoot), this.instanceId);
    await this._walkOwnedRoot(journal.targetRoot, { files, directories }, {
      rejectInternalTransientContent: true,
      allowLegacyEmptyBlobShards: true
    });
    await this._probeTarget(journal.targetRoot);
    const missingCanonicalBytes = await this._missingCanonicalBytes(
      journal.targetRoot,
      evidence.blobs
    );
    const missingArtifactBytes = await this._missingArtifactBytes(
      journal.targetRoot,
      evidence.artifacts
    );
    let statfs;
    try {
      statfs = await this.fs.promises.statfs(journal.targetRoot);
    } catch (_error) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_CAPACITY_UNAVAILABLE',
        '无法确认目标存储空间，已拒绝迁移'
      );
    }
    const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
    if (!Number.isFinite(availableBytes)
        || availableBytes < missingCanonicalBytes + missingArtifactBytes) {
      throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_SPACE_INSUFFICIENT',
        '目标存储空间不足，无法安全迁移'
      );
    }
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

  async _newJournal(targetRoot, evidence) {
    const now = new Date().toISOString();
    const sourceCleanupPaths = this._sourceCleanupPaths(evidence);
    const sourceFileIdentities = {};
    for (const relativePath of sourceCleanupPaths) {
      sourceFileIdentities[relativePath] = await this._captureMigrationFile(this.currentService.rootDir, relativePath);
    }
    return {
      schemaVersion: MIGRATION_JOURNAL_SCHEMA_VERSION,
      migrationId: crypto.randomUUID(),
      archiveInstanceId: this.instanceId,
      sourceRoot: this.currentService.rootDir,
      targetRoot,
      sourceCleanupPaths,
      sourceFileIdentities,
      targetPublishedPaths: [],
      targetFileIdentities: {},
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

  async _assertMissingMigrationTarget(journal, relativePath) {
    const actual = await this._assertMigrationFile(journal, 'target', relativePath);
    if (actual.exists) throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',
      '迁移目标校验失败且现存对象不可覆盖，保留两根及恢复记录');
  }

  async _publishMigrationTarget(stagedPath, targetPath, options) {
    // 原 staging 身份来自调用方完成的 hash 校验。发布全程持有原 fd；新路径
    // 只能排他创建，返回原 fd 身份供首次 journal capture 核对，不能现场认领。
    const relativePath = path.relative(options.rootDir, targetPath).split(path.sep).join('/');
    const location = await this._captureMigrationFile(options.rootDir, relativePath);
    if (location.exists) throw new ArchiveStorageRootError('ARCHIVE_STORAGE_UNKNOWN_CONTENT',
      '迁移发布时目标出现其他文件，保留文件及恢复记录');
    let stagedHandle;
    let targetHandle;
    try {
      stagedHandle = await this.fs.promises.open(stagedPath, 'r+');
      const verified = publishedFileIdentity(options.verifiedStat);
      assertPublishedIdentity(verified, publishedFileIdentity(await stagedHandle.stat()));
      const mode = options.mode == null ? verified.mode & 0o777 : options.mode;
      const changedMode = (verified.mode & 0o777) !== mode;
      if (changedMode) await stagedHandle.chmod(mode);
      await stagedHandle.sync();
      const prepared = publishedFileIdentity(await stagedHandle.stat());
      assertPublishedIdentity(verified, prepared, changedMode ? ['ctimeMs', 'mode'] : []);
      if ((prepared.mode & 0o777) !== mode) throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', '迁移 staging 权限与本次设置不符');
      let linked = false;
      try {
        await this.fs.promises.link(stagedPath, targetPath);
        linked = true;
      } catch (error) {
        if (!error || !['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
        // 不支持 hardlink 时，通过排他创建的 fd 写入和刷盘。即使路径随后
        // 被替换，写入/chmod 也只作用于原 fd，替代文件不会被覆盖或认领。
        targetHandle = await this.fs.promises.open(targetPath, 'wx', 0o600);
        await targetHandle.writeFile(stagedHandle.createReadStream({ autoClose: false, start: 0 }));
        await targetHandle.sync();
        await targetHandle.chmod(mode);
        await targetHandle.sync();
      }
      const original = linked ? stagedHandle : targetHandle;
      let published = publishedFileIdentity(await original.stat());
      if (linked) {
        assertPublishedIdentity(prepared, published, ['ctimeMs', 'nlink']);
        if (published.nlink !== prepared.nlink + 1) throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_DELETE_FILE_CHANGED', '迁移发布的硬链接数量与原对象不符');
      } else {
        assertPublishedIdentity(prepared, publishedFileIdentity(await stagedHandle.stat()));
      }
      assertPublishedIdentity(published, publishedFileIdentity(this.fs.lstatSync(targetPath)));
      // 只移除仍属于原 fd 的 staging 名称；同步核验与 unlink 不让出事件循环。
      assertPublishedIdentity(publishedFileIdentity(this.fs.fstatSync(stagedHandle.fd)),
        publishedFileIdentity(this.fs.lstatSync(stagedPath)));
      this.fs.unlinkSync(stagedPath);
      published = publishedFileIdentity(await original.stat());
      if (linked) {
        assertPublishedIdentity(prepared, published, ['ctimeMs']);
      }
      assertPublishedIdentity(published, publishedFileIdentity(this.fs.lstatSync(targetPath)));
      return { ...published, root: location.root, parents: location.parents };
    } catch (error) {
      if (error?.code === 'EEXIST') throw new ArchiveStorageRootError('ARCHIVE_STORAGE_UNKNOWN_CONTENT',
        '迁移发布时目标出现其他文件，保留文件及恢复记录');
      throw error;
    } finally {
      if (targetHandle) await targetHandle.close();
      if (stagedHandle) await stagedHandle.close();
    }
  }

  async _copyBlobs(journal, evidence) {
    journal = await this._writeJournal(journal, 'copying');
    const stagingDir = path.join(journal.targetRoot, '.staging');
    let copied = 0;
    for (const blob of evidence.blobs) {
      await this._assertMigrationFile(journal, 'source', blob.relativePath);
      const sourcePath = await this._assertManagedPath(journal.sourceRoot, blob.relativePath);
      const sourceVerified = await verifyFile(sourcePath, blob, this.fs);
      if (!sourceVerified.valid) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_SOURCE_BLOB_INVALID',
          '源 canonical Blob 校验失败，设置未切换'
        );
      }
      const targetPath = await this._assertManagedPath(journal.targetRoot, blob.relativePath);
      const targetOwnedByJournal = (journal.targetPublishedPaths || [])
        .includes(toRelativePath(blob.relativePath));
      const priorTargetIdentity = targetOwnedByJournal
        ? await this._assertMigrationFile(journal, 'target', blob.relativePath) : null;
      if (!targetOwnedByJournal && await pathExists(this.fs, targetPath)) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
          '目标路径存在未由迁移 journal 授权的文件，设置未切换'
        );
      }
      const existing = await verifyFile(targetPath, blob, this.fs);
      if (existing.valid && !priorTargetIdentity?.exists) {
        throw new ArchiveStorageRootError('ARCHIVE_STORAGE_UNKNOWN_CONTENT',
          '目标 canonical 出现未由原 journal 登记的文件，设置未切换');
      }
      let publishedIdentity;
      if (!existing.valid) {
        await this._assertMissingMigrationTarget(journal, blob.relativePath);
        await this.fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
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
          await syncStagedFile(this.fs, tempPath);
          publishedIdentity = await this._publishMigrationTarget(tempPath, targetPath, {
            rootDir: journal.targetRoot, verifiedStat: staged.stat
          });
          await syncDirectory(this.fs, path.dirname(targetPath));
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
      journal.targetFileIdentities = { ...journal.targetFileIdentities,
        [blob.relativePath]: existing.valid
          ? await this._assertMigrationFile(journal, 'target', blob.relativePath)
          : await this._captureMigrationFile(journal.targetRoot, blob.relativePath, blob.sha256,
            publishedIdentity, publishedIdentity) };
      this._emitProgress('copying', copied, evidence.blobs.length);
      journal = await this._writeJournal(journal, 'copying', {
        progress: journal.progress,
        targetPublishedPaths: journal.targetPublishedPaths,
        targetFileIdentities: journal.targetFileIdentities
      });
      await this._inject('after-copy-blob', { copied, blobId: blob.id });
    }
    return this._writeJournal(journal, 'copying', { progress: journal.progress });
  }

  async _materializeTarget(journal, evidence) {
    journal = await this._writeJournal(journal, 'materializing-layout');
    const publishedIdentities = new Map();
    const materializer = this.createMaterializer({
      rootDir: journal.targetRoot,
      stagingDir: path.join(journal.targetRoot, '.staging'),
      fs: this.fs,
      publishFile: async (source, target, options) => {
        const identity = await this._publishMigrationTarget(source, target, { ...options, rootDir: journal.targetRoot });
        publishedIdentities.set(target, identity);
      }
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
      await this._assertMigrationFile(journal, 'target', artifact.blob.relativePath);
      const canonicalPath = await this._assertManagedPath(
        journal.targetRoot,
        artifact.blob.relativePath
      );
      const targetPath = await this._assertManagedPath(
        journal.targetRoot,
        artifact.storageRelativePath
      );
      const targetOwnedByJournal = (journal.targetPublishedPaths || [])
        .includes(toRelativePath(artifact.storageRelativePath));
      const priorTargetIdentity = targetOwnedByJournal
        ? await this._assertMigrationFile(journal, 'target', artifact.storageRelativePath) : null;
      if (!targetOwnedByJournal && await pathExists(this.fs, targetPath)) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_UNKNOWN_CONTENT',
          '目标目录化路径存在未由迁移 journal 授权的文件，设置未切换'
        );
      }
      const existing = await verifyFile(targetPath, artifact.blob, this.fs);
      if (existing.valid && !priorTargetIdentity?.exists) {
        throw new ArchiveStorageRootError('ARCHIVE_STORAGE_UNKNOWN_CONTENT',
          '目标目录化路径出现未由原 journal 登记的文件，设置未切换');
      }
      let storageMode;
      let reusedCopyIdentity = null;
      let changedMode = false;
      if (existing.valid) {
        const canonicalStat = await this.fs.promises.stat(canonicalPath, { bigint: true });
        const sharesCanonicalInode = canonicalStat.dev === existing.stat.dev
          && canonicalStat.ino === existing.stat.ino;
        if (sharesCanonicalInode) {
          await this._assertMigrationFile(journal, 'target', artifact.storageRelativePath);
          await this.fs.promises.rm(targetPath, { force: true });
          // 旧 journal 的同 inode 路径组证明本次 unlink；先保存剩余原对象的
          // ctime/nlink，再用独立 copy 占用这个路径，重启不能把新 copy 当作旧链接。
          const targetFileIdentities = { ...journal.targetFileIdentities };
          for (const [relativePath, identity] of Object.entries(targetFileIdentities)) {
            if (identity.exists && identity.dev === String(canonicalStat.dev)
                && identity.ino === String(canonicalStat.ino)) {
              targetFileIdentities[relativePath] = await this._assertMigrationFile(journal, 'target', relativePath);
            }
          }
          journal = await this._writeJournal(journal, 'materializing-layout', { targetFileIdentities });
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
          reusedCopyIdentity = await this._assertMigrationFile(journal, 'target', artifact.storageRelativePath);
          if (!reusedCopyIdentity.exists) {
            throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED', '原目录化文件消失，设置未切换');
          }
          changedMode = (reusedCopyIdentity.mode & 0o777) !== 0o444;
          if (changedMode) await this.fs.promises.chmod(targetPath, 0o444);
        }
      } else {
        await this._assertMissingMigrationTarget(journal, artifact.storageRelativePath);
        const result = await materializer.materialize({
          artifactId: artifact.id,
          canonicalPath,
          storageRelativePath: artifact.storageRelativePath,
          sha256: artifact.blob.sha256,
          sizeBytes: artifact.blob.sizeBytes
        });
        storageMode = result.mode;
      }
      const finalStat = await this.fs.promises.lstat(targetPath, { bigint: true });
      const storageFingerprint = sourceSnapshotFromStat(finalStat);
      if (!storageFingerprint || finalStat.isSymbolicLink()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_TARGET_VERIFY_FAILED',
          '目标目录化文件指纹不可用，设置未切换'
        );
      }
      if (!reusedCopyIdentity && !publishedIdentities.has(targetPath)) throw new ArchiveStorageRootError(
        'ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING', '目录化发布缺少原 fd 身份，保留文件及恢复记录');
      const targetIdentity = await this._captureMigrationFile(journal.targetRoot,
        artifact.storageRelativePath, artifact.blob.sha256, storageFingerprint, publishedIdentities.get(targetPath));
      if (reusedCopyIdentity && (['dev', 'ino', 'sizeBytes', 'mtimeMs', 'birthtimeMs', 'nlink', 'sha256',
        ...(changedMode ? [] : ['mode', 'ctimeMs'])].some((field) => targetIdentity[field] !== reusedCopyIdentity[field])
          || JSON.stringify(targetIdentity.root) !== JSON.stringify(reusedCopyIdentity.root)
          || JSON.stringify(targetIdentity.parents) !== JSON.stringify(reusedCopyIdentity.parents)
          || (changedMode && (targetIdentity.mode & 0o777) !== 0o444))) {
        throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',
          '原目录化文件在复用期间被替换，保留两根及恢复记录');
      }
      materializations.push({ artifactId: artifact.id, storageMode, storageFingerprint });
      processed += 1;
      journal.progress.materializedArtifactCount = processed;
      journal.targetPublishedPaths = [...new Set([
        ...(journal.targetPublishedPaths || []),
        toRelativePath(artifact.storageRelativePath)
      ])].sort();
      journal.targetFileIdentities = { ...journal.targetFileIdentities,
        [artifact.storageRelativePath]: targetIdentity };
      this._emitProgress('materializing-layout', processed, evidence.artifacts.length);
      journal = await this._writeJournal(journal, 'materializing-layout', {
        progress: journal.progress,
        targetPublishedPaths: journal.targetPublishedPaths,
        targetFileIdentities: journal.targetFileIdentities
      });
      await this._inject('after-materialize-artifact', {
        processed,
        artifactId: artifact.id
      });
    }
    journal = await this._writeJournal(journal, 'materializing-layout', {
      progress: journal.progress
    });
    return { journal, materializations };
  }

  async _verifyTarget(journal, evidence) {
    journal = await this._writeJournal(journal, 'verifying');
    const blobFingerprints = [];
    let processed = 0;
    const total = evidence.blobs.length + evidence.artifacts.length;
    for (const blob of evidence.blobs) {
      const actual = await this._assertMigrationFile(journal, 'target', blob.relativePath);
      if (!actual.exists || actual.sha256 !== blob.sha256 || actual.sizeBytes !== blob.sizeBytes) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_TARGET_VERIFY_FAILED',
          '目标 canonical Blob 校验失败，设置未切换'
        );
      }
      const identity = journal.targetFileIdentities[blob.relativePath];
      blobFingerprints.push({ blobId: blob.id, fingerprint: {
        sizeBytes: identity.sizeBytes, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, ino: identity.ino
      } });
      processed += 1;
      this._emitProgress('verifying', processed, total);
    }
    for (const artifact of evidence.artifacts) {
      const actual = await this._assertMigrationFile(journal, 'target', artifact.storageRelativePath);
      if (!actual.exists || actual.sha256 !== artifact.blob.sha256 || actual.sizeBytes !== artifact.blob.sizeBytes) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_TARGET_VERIFY_FAILED',
          '目标目录化文件校验失败，设置未切换'
        );
      }
      processed += 1;
      this._emitProgress('verifying', processed, total);
    }
    return { journal, blobFingerprints };
  }

  _assertTargetCommitIdentities(journal) {
    // 最后一次异步 hash 检查后仍可能有其他路径被替换。这里到 SQLite 提交之间
    // 不让出事件循环；只核对 journal 原对象，绝不把现场 stat 登记为新的所有权。
    const changed = () => {
      throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_FILE_CHANGED',
        '迁移目标在提交前已被替换，保留两根及恢复记录');
    };
    for (const relativePath of journal.targetPublishedPaths || []) {
      const expected = journal.targetFileIdentities?.[relativePath];
      if (!expected?.exists) throw new ArchiveStorageRootError('ARCHIVE_STORAGE_DELETE_IDENTITY_MISSING',
        '迁移目标缺少原发布身份，保留两根及恢复记录');
      try {
        const root = this.fs.lstatSync(journal.targetRoot);
        if (!root.isDirectory() || root.isSymbolicLink()
            || String(root.dev) !== expected.root.dev || String(root.ino) !== expected.root.ino) changed();
        for (const parent of expected.parents) {
          const stat = this.fs.lstatSync(path.join(journal.targetRoot, ...parent.relativePath.split('/')));
          if (!stat.isDirectory() || stat.isSymbolicLink()
              || String(stat.dev) !== parent.dev || String(stat.ino) !== parent.ino) changed();
        }
        const stat = this.fs.lstatSync(path.join(journal.targetRoot, ...relativePath.split('/')));
        if (!stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== expected.dev
            || String(stat.ino) !== expected.ino || Number(stat.size) !== expected.sizeBytes
            || ['mtimeMs', 'ctimeMs', 'birthtimeMs', 'mode', 'nlink']
              .some((field) => Number(stat[field]) !== expected[field])) changed();
      } catch (error) {
        if (error instanceof ArchiveStorageRootError) throw error;
        changed();
      }
    }
  }

  async _commitSwitch(journal, materializations, targetService, expectedStoredRoot, blobFingerprints) {
    this._assertTargetCommitIdentities(journal);
    this.repository.commitStorageRootSwitch({
      storageRoot: journal.targetRoot,
      expectedStoredRoot,
      materializations,
      blobFingerprints
    });
    this.currentService = targetService;
    this.runtimeDelegate.switchService(targetService);
    await this._inject('after-switch-commit', { targetRoot: journal.targetRoot });
    journal = await this._writeJournal(journal, 'switched');
    this._emitProgress('switched', 1, 1);
    return journal;
  }

  async _startMigration(targetRoot, existingJournal = null, options = {}) {
    let journal = existingJournal;
    const expectedStoredRoot = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY);
    try {
      if (!journal && await this._readJournal()) {
        throw new ArchiveStorageRootError(
          'ARCHIVE_STORAGE_MIGRATION_PENDING',
          '已存在未收口的存档迁移记录，已拒绝覆盖'
        );
      }
      if (journal) await this._prepareOverlappingCleanup(journal);
      await this._assertSourceReady(journal);
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
        journal = await this._newJournal(targetRoot, evidence);
        await atomicWriteJson(this.fs, this.journalPath, journal);
        await this._inject('after-prepared', { targetRoot });
      } else {
        // pre-switch 失败后 source 仍可新增或删除批次。清理集合只能单调合并：
        // 当前证据补进新增路径，旧 checkpoint 则保留已删除批次可能留下的文件/空目录。
        const sourceCleanupPaths = [...new Set([
          ...(Array.isArray(journal.sourceCleanupPaths) ? journal.sourceCleanupPaths : []),
          ...this._sourceCleanupPaths(evidence)
        ])].sort();
        const previousSourcePaths = new Set(journal.sourceCleanupPaths || []);
        const sourceFileIdentities = { ...journal.sourceFileIdentities };
        for (const relativePath of sourceCleanupPaths) {
          if (!previousSourcePaths.has(relativePath)) {
            sourceFileIdentities[relativePath] = await this._captureMigrationFile(journal.sourceRoot, relativePath);
          }
        }
        // 先按旧 journal 的 durable progress 清掉已经发布、但当前 DB 已删除的
        // 目标副本；随后才能用当前 evidence 重置下一轮发布计划。
        await this._reconcilePreSwitchTargetInventory(journal, evidence);
        const desiredTargetPaths = new Set(this._targetPublishedPaths(evidence));
        const targetPublishedPaths = (journal.targetPublishedPaths || [])
          .filter((relativePath) => desiredTargetPaths.has(relativePath));
        journal = await this._writeJournal(journal, journal.phase, {
          sourceCleanupPaths,
          sourceFileIdentities,
          targetPublishedPaths,
          progress: {
            ...journal.progress,
            copiedBlobCount: 0,
            totalBlobCount: evidence.blobs.length,
            materializedArtifactCount: 0,
            totalArtifactCount: evidence.artifacts.length
          }
        });
        await this._validateResumeTarget(journal, evidence);
      }
      this._emitProgress(journal.phase, 0, evidence.blobs.length + evidence.artifacts.length);
      journal = await this._copyBlobs(journal, evidence);
      const materialized = await this._materializeTarget(journal, evidence);
      const verified = await this._verifyTarget(materialized.journal, evidence);
      journal = verified.journal;
      // Commit 之前只使用上面的只读校验；正常 Service.initialize()
      // 会修复/作废 DB 证据，只能在 setting 已指向目标根后运行。
      const targetService = this.createService(journal.targetRoot);
      journal = await this._commitSwitch(
        journal,
        materialized.materializations,
        targetService,
        expectedStoredRoot,
        verified.blobFingerprints
      );
      try {
        await this._initializeExistingService(targetService);
      } catch (error) {
        this.currentService = null;
        this.runtimeDelegate.clearService(journal.targetRoot);
        throw error;
      }
      return options.deferCleanup === true
        ? this._deferCleanup(journal)
        : this._finishCleanup(journal);
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
      await this._assertMigrationFile(journal, 'source', relativePath);
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
        try {
          await this.fs.promises.rmdir(internalPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
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
      await this._assertCleanupInventory(journal);
      const cleaned = await this._cleanupOldRoot(journal);
      cleanupJournal = cleaned && cleaned.journal ? cleaned.journal : journal;
      // 历史 post-switch 重叠也可能留下已从 DB 删除批次的目标副本；它们仍由原迁移
      // durable inventory 收口，删除执行器不得将原根路径换前缀后自行清理。
      await this._reconcilePreSwitchTargetInventory(cleanupJournal, this._evidence());
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
    await this._inject('after-migration-done', { migrationId: journal.migrationId });
    return this._finalizeMigrationDeletes(journal);
  }

  async _finalizeMigrationDeletes(journal) {
    const durable = await this._readJournal();
    if (!durable || durable.phase !== 'done' || journal.phase !== 'done'
        || durable.migrationId !== journal.migrationId) {
      throw this._migrationCleanupConflict('迁移尚无耐久完成证据，不能完成关联删除');
    }
    const stored = this.database.getSetting(ARCHIVE_STORAGE_ROOT_SETTING_KEY) || this.defaultRoot;
    if (comparablePath(await this._existingRoot(stored, true)) !== comparablePath(journal.targetRoot)) {
      throw this._migrationCleanupConflict('迁移完成证据与当前存档位置不一致');
    }
    validateMarker(await this._readMarker(journal.targetRoot), this.instanceId);
    await runArchiveRootOperation(journal.targetRoot, async () => {
      const migration = this._migrationIdentity(journal);
      for (const original of this.repository.listCleanupJobs()) {
        let job = original;
        if (job.state !== 'waiting-migration') {
          const root = this._jobRoot(job);
          if (root && comparablePath(root) === comparablePath(journal.targetRoot)) {
            await this.currentService._executeCleanupJobUnlocked(job, { waitForMigration: migration });
          } else if (root && comparablePath(root) === comparablePath(journal.sourceRoot)) {
            const knownPaths = new Set(journal.sourceCleanupPaths || []);
            const items = job.plan && job.plan.items;
            if (!Array.isArray(items) || items.some((item) => (
              !['materialized', 'blob'].includes(item.kind)
              || !knownPaths.has(item.managedRelativePath)
            ))) {
              throw this._migrationCleanupConflict('旧根删除计划含迁移完成证据未覆盖的目标');
            }
            // done 证明原根已按冻结清单完成清理；不把原计划路径换为新根重跑。
            this.repository.updateCleanupJobProgress(job.id, {
              state: 'waiting-migration',
              migration,
              items: items.map((item) => ({
                ...item,
                state: ['deleted', 'already-missing', 'preserved-shared'].includes(item.state)
                  ? item.state : 'already-missing'
              }))
            });
          } else {
            throw this._migrationCleanupConflict('已有删除计划缺少可核验的原根，已保留迁移完成证据');
          }
          job = this.repository.getCleanupJob(original.id);
        }
        if (!job || job.state !== 'waiting-migration'
            || !this._jobMatchesMigration(job, journal) || !this._jobItemsComplete(job)) {
          throw this._migrationCleanupConflict('关联删除计划尚未完成或迁移身份不一致');
        }
        const completed = this.repository.completeCleanupJob(job.id, {
          migrationCompletion: { ...migration, phase: 'done' }
        });
        if (!completed) throw this._migrationCleanupConflict('关联删除完成事务未确认，已保留 done journal');
        await this._inject('after-migration-delete-completed', {
          migrationId: journal.migrationId,
          jobId: job.id
        });
      }
    });
    await this.fs.promises.rm(this.journalPath, { force: true });
    return {
      status: 'success',
      ok: true,
      message: '存档位置已变更',
      storageRoot: journal.targetRoot
    };
  }

  async _deferCleanup(journal) {
    const persisted = journal.phase === 'cleanup-pending'
      ? journal
      : await this._writeJournal(journal, 'cleanup-pending', { lastError: null });
    this._emitProgress('cleanup-pending', 0, 1, 'cleanup-pending');
    return {
      status: 'deferred',
      ok: true,
      storageRoot: persisted.targetRoot,
      migrationCleanupPending: true
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
        if (this.deferStartupRecovery) {
          await this._deferCleanup(journal);
          return { ...target.initialized, migrationCleanupPending: true };
        }
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
          ok: false,
          available: true,
          migrationRecovery: publicFailure(error)
        };
      }
      try {
        this.runtimeDelegate.activateMaintenance();
        await runArchiveRootOperation(sourceRoot, async () => {
          const recovered = await this._startMigration(journal.targetRoot, journal, {
            deferCleanup: this.deferStartupRecovery
          });
          return recovered;
        });
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
          ok: false,
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
    const target = await this._initializeService(targetRoot);
    this.currentService = target.service;
    this.runtimeDelegate.switchService(target.service);
    if (journal.phase === 'done') {
      await this._finalizeMigrationDeletes(journal);
    } else if (this.deferStartupRecovery) {
      await this._deferCleanup(journal);
    } else {
      await this._finishCleanup(journal);
    }
    return {
      ...target.initialized,
      migrationCleanupPending: this.deferStartupRecovery && journal.phase !== 'done'
    };
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
