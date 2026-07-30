'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  directoryPathAliasKey,
  targetPathAliasKey
} = require('./toolbox-target-identity');

const JOURNAL_INDEX_NAME = 'toolbox-publish-journal-index.json';
const JOURNAL_VERSION = 1;
const COPY_BUFFER_SIZE = 1024 * 1024;
const PREPARED_RUNTIME = Symbol('toolboxPublicationRuntime');

const activeTaskIds = new Set();
const targetReservations = new Map();
let lifecycleMutexLocked = false;

class ToolboxPublicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolboxPublicationError';
    this.code = code;
    this.detailLines = Array.isArray(details.detailLines) ? details.detailLines.slice() : [];
    this.recoveryPaths = Array.isArray(details.recoveryPaths)
      ? details.recoveryPaths.slice()
      : [];
    if (details.cause) this.cause = details.cause;
  }
}

class ToolboxPublicationManualRecoveryError extends ToolboxPublicationError {
  constructor(message, details = {}) {
    super('TOOLBOX_PUBLICATION_MANUAL_RECOVERY', message, details);
    this.name = 'ToolboxPublicationManualRecoveryError';
  }
}

/**
 * 仅用于测试“进程在某个耐久化检查点后立即退出”的状态。
 * 普通 checkpoint 错误会触发在线回滚；该错误会刻意保留 journal/index/backup，
 * 以便下一次 recoverPendingToolboxPublications 验证真正的崩溃恢复路径。
 */
class ToolboxPublicationCrashError extends Error {
  constructor(checkpointName = 'unknown') {
    super(`模拟进程在检查点崩溃：${checkpointName}`);
    this.name = 'ToolboxPublicationCrashError';
    this.code = 'TOOLBOX_PUBLICATION_SIMULATED_CRASH';
    this.checkpointName = checkpointName;
  }
}

function withLifecycleMutex(operationName, operation) {
  if (lifecycleMutexLocked) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_BUSY',
      `工具箱输出发布正在执行其它操作，无法同时${operationName}`
    );
  }
  lifecycleMutexLocked = true;
  try {
    return operation();
  } finally {
    lifecycleMutexLocked = false;
  }
}

function createRuntime(options = {}) {
  return {
    fsImpl: options.fsImpl || fs,
    checkpoint: typeof options.checkpoint === 'function' ? options.checkpoint : null,
    now: typeof options.now === 'function' ? options.now : () => new Date(),
    randomUUID: typeof options.randomUUID === 'function'
      ? options.randomUUID
      : () => crypto.randomUUID()
  };
}

function callCheckpoint(runtime, name, context = {}) {
  if (runtime.checkpoint) runtime.checkpoint(name, context);
}

function dateIso(runtime) {
  const value = runtime.now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function isCrashError(error) {
  return error instanceof ToolboxPublicationCrashError
    || (error && error.code === 'TOOLBOX_PUBLICATION_SIMULATED_CRASH');
}

function lstatOrNull(fsImpl, filePath) {
  try {
    return fsImpl.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegularFile(fsImpl, filePath, label) {
  const stat = lstatOrNull(fsImpl, filePath);
  if (!stat || !stat.isFile()) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_INVALID_FILE',
      `${label}不存在或不是普通文件：${filePath}`
    );
  }
  return stat;
}

function hashFileSync(fsImpl, filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (true) {
      const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return hash.digest('hex');
}

function inspectRegularFile(fsImpl, filePath) {
  const stat = assertRegularFile(fsImpl, filePath, '文件');
  return {
    size: Number(stat.size),
    sha256: hashFileSync(fsImpl, filePath)
  };
}

function fileMatches(fsImpl, filePath, expected) {
  const stat = lstatOrNull(fsImpl, filePath);
  if (!stat) return false;
  if (!stat.isFile() || Number(stat.size) !== Number(expected.size)) return false;
  return hashFileSync(fsImpl, filePath) === expected.sha256;
}

function fsyncFile(fsImpl, filePath) {
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function fsyncDirectory(fsImpl, dirPath) {
  let fd;
  try {
    fd = fsImpl.openSync(dirPath, 'r');
    fsImpl.fsyncSync(fd);
  } catch (error) {
    // Windows 对目录句柄 fsync 的支持因文件系统而异；文件 fsync + 同目录
    // rename 仍已完成。只忽略明确表示“目录 fsync 不受支持”的平台错误。
    if (!error || !['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function atomicWriteJson(fsImpl, filePath, value, runtime) {
  const dirPath = path.dirname(filePath);
  fsImpl.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.tmp-${process.pid}-${runtime.randomUUID()}`
  );
  let fd;
  try {
    fd = fsImpl.openSync(tempPath, 'wx', 0o600);
    fsImpl.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tempPath, filePath);
    fsyncDirectory(fsImpl, dirPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_closeError) { /* best effort */ }
    }
    try { fsImpl.rmSync(tempPath, { force: true }); } catch (_cleanupError) { /* best effort */ }
    throw error;
  }
}

function readJsonFile(fsImpl, filePath, label) {
  let text;
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `${label}缺失或不可读，已阻止新的工具箱发布任务`,
      {
        detailLines: [`路径：${filePath}`, `原因：${messageOf(error)}`],
        recoveryPaths: [filePath],
        cause: error
      }
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `${label}内容损坏，已阻止新的工具箱发布任务`,
      {
        detailLines: [`路径：${filePath}`, `原因：${messageOf(error)}`],
        recoveryPaths: [filePath],
        cause: error
      }
    );
  }
}

function getIndexPath(userDataDir) {
  return path.join(path.resolve(userDataDir), JOURNAL_INDEX_NAME);
}

function emptyIndex() {
  return { version: JOURNAL_VERSION, entries: [] };
}

function readIndex(runtime, userDataDir) {
  const indexPath = getIndexPath(userDataDir);
  const stat = lstatOrNull(runtime.fsImpl, indexPath);
  if (!stat) return { indexPath, value: emptyIndex() };
  if (!stat.isFile()) {
    throw new ToolboxPublicationManualRecoveryError(
      '工具箱发布恢复索引不是普通文件，已阻止新的发布任务',
      { recoveryPaths: [indexPath], detailLines: [`路径：${indexPath}`] }
    );
  }
  const value = readJsonFile(runtime.fsImpl, indexPath, '工具箱发布恢复索引');
  const taskIds = new Set();
  const journalPaths = new Set();
  if (
    !value
    || value.version !== JOURNAL_VERSION
    || !Array.isArray(value.entries)
    || value.entries.some((entry) => {
      let journalPathKey = '';
      if (
        entry
        && typeof entry.journalAbsolutePath === 'string'
        && path.isAbsolute(entry.journalAbsolutePath)
      ) {
        try {
          journalPathKey = targetPathAliasKey(runtime.fsImpl, entry.journalAbsolutePath);
        } catch (_error) {
          journalPathKey = '';
        }
      }
      const invalid = (
        !entry
        || typeof entry.taskId !== 'string'
        || !entry.taskId
        || typeof entry.journalAbsolutePath !== 'string'
        || !path.isAbsolute(entry.journalAbsolutePath)
        || !journalPathKey
        || taskIds.has(entry.taskId)
        || journalPaths.has(journalPathKey)
      );
      if (!invalid) {
        taskIds.add(entry.taskId);
        journalPaths.add(journalPathKey);
      }
      return invalid;
    })
  ) {
    throw new ToolboxPublicationManualRecoveryError(
      '工具箱发布恢复索引结构无效，已阻止新的发布任务',
      { recoveryPaths: [indexPath], detailLines: [`路径：${indexPath}`] }
    );
  }
  return { indexPath, value };
}

function writeIndex(runtime, indexPath, value) {
  atomicWriteJson(runtime.fsImpl, indexPath, value, runtime);
}

function addIndexEntry(runtime, userDataDir, entry) {
  const { indexPath, value } = readIndex(runtime, userDataDir);
  if (value.entries.some((item) => item.taskId === entry.taskId)) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_DUPLICATE_TASK',
      `工具箱发布任务编号已存在：${entry.taskId}`
    );
  }
  value.entries.push(entry);
  writeIndex(runtime, indexPath, value);
  return indexPath;
}

function indexContainsEntry(runtime, userDataDir, taskId, journalPath) {
  const { value } = readIndex(runtime, userDataDir);
  const expectedKey = journalPath
    ? targetPathAliasKey(runtime.fsImpl, journalPath)
    : null;
  return value.entries.some((entry) => (
    entry.taskId === taskId
    && (
      !expectedKey
      || targetPathAliasKey(runtime.fsImpl, entry.journalAbsolutePath) === expectedKey
    )
  ));
}

function removeIndexEntry(runtime, userDataDir, taskId, expectedJournalPath) {
  const { indexPath, value } = readIndex(runtime, userDataDir);
  const expectedKey = expectedJournalPath
    ? targetPathAliasKey(runtime.fsImpl, expectedJournalPath)
    : null;
  const nextEntries = value.entries.filter((entry) => {
    if (entry.taskId !== taskId) return true;
    if (
      expectedKey
      && targetPathAliasKey(runtime.fsImpl, entry.journalAbsolutePath) !== expectedKey
    ) {
      throw new ToolboxPublicationManualRecoveryError(
        `任务 ${taskId} 的恢复索引指向了意外 journal`,
        {
          detailLines: [
            `索引 journal：${entry.journalAbsolutePath}`,
            `预期 journal：${expectedJournalPath}`
          ],
          recoveryPaths: [indexPath, entry.journalAbsolutePath, expectedJournalPath]
        }
      );
    }
    return false;
  });
  if (nextEntries.length !== value.entries.length) {
    writeIndex(runtime, indexPath, { ...value, entries: nextEntries });
  }
}

function persistJournal(runtime, journal) {
  journal.updatedAt = dateIso(runtime);
  atomicWriteJson(runtime.fsImpl, journal.journalPath, journal, runtime);
}

function readJournal(runtime, journalPath, expectedTaskId = null) {
  const stat = lstatOrNull(runtime.fsImpl, journalPath);
  if (!stat || !stat.isFile()) {
    throw new ToolboxPublicationManualRecoveryError(
      '恢复索引指向的工具箱发布 journal 缺失或不是普通文件',
      {
        detailLines: [`journal：${journalPath}`],
        recoveryPaths: [journalPath]
      }
    );
  }
  const journal = readJsonFile(runtime.fsImpl, journalPath, '工具箱发布 journal');
  let journalPathMatches = false;
  try {
    journalPathMatches = Boolean(
      journal
      && typeof journal.journalPath === 'string'
      && path.isAbsolute(journal.journalPath)
      && targetPathAliasKey(runtime.fsImpl, journal.journalPath)
        === targetPathAliasKey(runtime.fsImpl, journalPath)
    );
  } catch (_error) {
    journalPathMatches = false;
  }
  if (
    !journal
    || journal.version !== JOURNAL_VERSION
    || typeof journal.taskId !== 'string'
    || !journalPathMatches
    || !Array.isArray(journal.entries)
    || (expectedTaskId && journal.taskId !== expectedTaskId)
  ) {
    throw new ToolboxPublicationManualRecoveryError(
      '工具箱发布 journal 结构或任务编号无效',
      {
        detailLines: [
          `journal：${journalPath}`,
          expectedTaskId ? `预期任务：${expectedTaskId}` : ''
        ].filter(Boolean),
        recoveryPaths: [journalPath]
      }
    );
  }
  const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validSnapshot = (value, allowMissing) => (
    value
    && typeof value === 'object'
    && typeof value.exists === 'boolean'
    && (
      (allowMissing && value.exists === false)
      || (
        value.exists === true
        && Number.isSafeInteger(value.size)
        && value.size >= 0
        && validSha(value.sha256)
      )
    )
  );
  const validGenerated = (value) => (
    value
    && typeof value === 'object'
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && validSha(value.sha256)
  );
  const validStatuses = new Set([
    'prepared',
    'publishing',
    'rolling-back',
    'rolled-back',
    'committed',
    'committed-cleanup-pending',
    'manual-recovery'
  ]);
  const targets = new Set();
  const entriesValid = journal.entries.length > 0 && journal.entries.every((entry) => {
    if (!entry || !['artifactPath', 'targetPath', 'stagedPath', 'backupPath'].every(
      (key) => typeof entry[key] === 'string' && path.isAbsolute(entry[key])
    )) {
      return false;
    }
    try {
      const targetParentKey = directoryPathAliasKey(
        runtime.fsImpl,
        path.dirname(entry.targetPath)
      );
      const managedKeys = [entry.targetPath, entry.stagedPath, entry.backupPath]
        .map((filePath) => targetPathAliasKey(runtime.fsImpl, filePath));
      const targetKey = managedKeys[0];
      if (
        directoryPathAliasKey(runtime.fsImpl, path.dirname(entry.stagedPath))
          !== targetParentKey
        || directoryPathAliasKey(runtime.fsImpl, path.dirname(entry.backupPath))
          !== targetParentKey
        || !path.basename(entry.stagedPath).startsWith(`.toolbox-publish-${journal.nonce}-`)
        || !path.basename(entry.backupPath).startsWith(`.toolbox-publish-${journal.nonce}-`)
        || !entry.stagedPath.endsWith('.stage')
        || !entry.backupPath.endsWith('.backup')
        || new Set(managedKeys).size !== 3
        || !validSnapshot(entry.original, true)
        || !validGenerated(entry.generated)
        || !entry.metadata
        || typeof entry.metadata !== 'object'
        || targets.has(targetKey)
      ) {
        return false;
      }
      targets.add(targetKey);
      return true;
    } catch (_error) {
      return false;
    }
  });
  let journalDirectoryMatches = false;
  try {
    journalDirectoryMatches = journal.entries.length > 0
      && directoryPathAliasKey(runtime.fsImpl, path.dirname(journal.journalPath))
        === directoryPathAliasKey(runtime.fsImpl, path.dirname(journal.entries[0].targetPath));
  } catch (_error) {
    journalDirectoryMatches = false;
  }
  if (
    typeof journal.nonce !== 'string'
    || !journal.nonce
    || !validStatuses.has(journal.status)
    || typeof journal.userDataDir !== 'string'
    || !path.isAbsolute(journal.userDataDir)
    || !entriesValid
    || !journalDirectoryMatches
    || !path.basename(journal.journalPath).endsWith(`-${journal.nonce}.journal.json`)
  ) {
    throw new ToolboxPublicationManualRecoveryError(
      '工具箱发布 journal 的路径或文件快照无效',
      {
        detailLines: [`journal：${journalPath}`],
        recoveryPaths: [journalPath]
      }
    );
  }
  return journal;
}

function extractPath(item, candidates) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  for (const key of candidates) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key];
  }
  return '';
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return undefined;
  }
}

function publicationMetadata(artifact, target, targetPath) {
  const artifactObject = artifact && typeof artifact === 'object' ? artifact : {};
  const targetObject = target && typeof target === 'object' ? target : {};
  const choose = (key, fallback) => (
    targetObject[key] !== undefined
      ? targetObject[key]
      : artifactObject[key] !== undefined
        ? artifactObject[key]
        : fallback
  );
  return {
    outputId: choose('outputId', null),
    fileName: String(choose('fileName', path.basename(targetPath))),
    matchedCount: choose('matchedCount', null),
    warningSummary: cloneJsonValue(choose('warningSummary', [])) || [],
    styleStats: cloneJsonValue(choose('styleStats', null))
  };
}

function normalizeInputs(artifacts, targets) {
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const targetList = Array.isArray(targets) && targets.length > 0
    ? targets
    : artifactList.map((artifact) => (
      artifact && typeof artifact === 'object' ? artifact.targetPath : ''
    ));
  if (artifactList.length === 0 || artifactList.length !== targetList.length) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_INVALID_INPUT',
      '发布产物与目标路径必须为数量相同的非空数组'
    );
  }
  return artifactList.map((artifact, index) => {
    const target = targetList[index];
    const artifactPath = extractPath(
      artifact,
      ['sourcePath', 'artifactPath', 'generationPath', 'path', 'filePath']
    );
    const targetPath = extractPath(target, ['targetPath', 'path', 'filePath']);
    if (!artifactPath || !targetPath) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_INPUT',
        `第 ${index + 1} 个发布产物缺少源路径或目标路径`
      );
    }
    const resolvedTarget = path.resolve(targetPath);
    return {
      artifactPath: path.resolve(artifactPath),
      targetPath: resolvedTarget,
      metadata: publicationMetadata(artifact, target, resolvedTarget)
    };
  });
}

function targetReservationKey(fsImpl, targetPath) {
  return targetPathAliasKey(fsImpl, targetPath);
}

function reserveTargets(runtime, taskId, entries) {
  const keys = [];
  try {
    for (const entry of entries) {
      const key = targetReservationKey(runtime.fsImpl, entry.targetPath);
      if (keys.includes(key)) {
        throw new ToolboxPublicationError(
          'TOOLBOX_PUBLICATION_DUPLICATE_TARGET',
          `发布目标路径重复：${entry.targetPath}`
        );
      }
      const owner = targetReservations.get(key);
      if (owner && owner !== taskId) {
        throw new ToolboxPublicationError(
          'TOOLBOX_PUBLICATION_TARGET_RESERVED',
          `发布目标正被任务 ${owner} 使用：${entry.targetPath}`
        );
      }
      targetReservations.set(key, taskId);
      keys.push(key);
    }
    return keys;
  } catch (error) {
    for (const key of keys) {
      if (targetReservations.get(key) === taskId) targetReservations.delete(key);
    }
    throw error;
  }
}

function releaseReservations(taskId, reservationKeys = []) {
  for (const key of reservationKeys) {
    if (targetReservations.get(key) === taskId) targetReservations.delete(key);
  }
  activeTaskIds.delete(taskId);
}

function removeKnownFile(runtime, filePath, expected, label) {
  const stat = lstatOrNull(runtime.fsImpl, filePath);
  if (!stat) return;
  if (!stat.isFile() || !fileMatches(runtime.fsImpl, filePath, expected)) {
    throw new Error(`${label}已被外部改写，拒绝删除：${filePath}`);
  }
  runtime.fsImpl.rmSync(filePath, { force: true });
  fsyncDirectory(runtime.fsImpl, path.dirname(filePath));
}

function targetState(runtime, entry) {
  const stat = lstatOrNull(runtime.fsImpl, entry.targetPath);
  if (!stat) return 'missing';
  if (!stat.isFile()) return 'unknown';
  if (fileMatches(runtime.fsImpl, entry.targetPath, entry.generated)) return 'generated';
  if (entry.original.exists && fileMatches(runtime.fsImpl, entry.targetPath, entry.original)) {
    return 'original';
  }
  return 'unknown';
}

function backupState(runtime, entry) {
  const stat = lstatOrNull(runtime.fsImpl, entry.backupPath);
  if (!stat) return 'missing';
  if (!stat.isFile()) return 'unknown';
  if (entry.original.exists && fileMatches(runtime.fsImpl, entry.backupPath, entry.original)) {
    return 'original';
  }
  return 'unknown';
}

function stagingState(runtime, entry) {
  const stat = lstatOrNull(runtime.fsImpl, entry.stagedPath);
  if (!stat) return 'missing';
  if (!stat.isFile()) return 'unknown';
  return fileMatches(runtime.fsImpl, entry.stagedPath, entry.generated)
    ? 'generated'
    : 'unknown';
}

function collectRecoveryPaths(journal) {
  return [
    journal.journalPath,
    ...journal.entries.flatMap((entry) => [
      entry.targetPath,
      entry.backupPath,
      entry.stagedPath
    ])
  ].filter(Boolean);
}

function markManualRecovery(runtime, journal, issues) {
  journal.status = 'manual-recovery';
  journal.manualRecoveryIssues = issues.slice();
  try {
    persistJournal(runtime, journal);
  } catch (persistError) {
    issues.push(`无法更新 manual-recovery journal：${messageOf(persistError)}`);
  }
  throw new ToolboxPublicationManualRecoveryError(
    `工具箱发布任务 ${journal.taskId} 需要人工恢复`,
    {
      detailLines: issues,
      recoveryPaths: collectRecoveryPaths(journal)
    }
  );
}

function rollbackUncommitted(runtime, journal) {
  const issues = [];
  journal.status = 'rolling-back';
  try {
    persistJournal(runtime, journal);
  } catch (_error) {
    // 该状态仅用于可观测性；实际文件恢复完成后会再次耐久写 rolled-back。
    // 短暂写失败不能把一个已经完整恢复的任务误判成人工恢复。
  }

  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const entry = journal.entries[index];
    let currentTarget;
    let currentBackup;
    try {
      currentTarget = targetState(runtime, entry);
      currentBackup = backupState(runtime, entry);
    } catch (error) {
      issues.push(`检查目标或备份失败：${entry.targetPath}（${messageOf(error)}）`);
      continue;
    }

    if (currentTarget === 'unknown') {
      issues.push(`正式目标已被外部改写，未删除：${entry.targetPath}`);
      continue;
    }
    if (currentBackup === 'unknown') {
      issues.push(`任务备份内容与原文件不一致，未处理：${entry.backupPath}`);
      continue;
    }

    try {
      if (entry.original.exists) {
        if (currentBackup === 'original') {
          if (currentTarget === 'generated') {
            removeKnownFile(runtime, entry.targetPath, entry.generated, '本任务新文件');
            currentTarget = 'missing';
          }
          if (currentTarget === 'missing') {
            runtime.fsImpl.renameSync(entry.backupPath, entry.targetPath);
            fsyncDirectory(runtime.fsImpl, path.dirname(entry.targetPath));
          } else if (currentTarget === 'original') {
            removeKnownFile(runtime, entry.backupPath, entry.original, '重复原文件备份');
          }
        } else if (currentTarget !== 'original') {
          issues.push(`原文件备份缺失，无法恢复：${entry.targetPath}`);
        }
      } else {
        if (currentBackup !== 'missing') {
          issues.push(`原目标本不存在但发现意外备份：${entry.backupPath}`);
        } else if (currentTarget === 'generated') {
          removeKnownFile(runtime, entry.targetPath, entry.generated, '本任务新文件');
        }
      }
    } catch (error) {
      issues.push(`回滚目标失败：${entry.targetPath}（${messageOf(error)}）`);
    }
  }

  for (const entry of journal.entries) {
    try {
      const state = stagingState(runtime, entry);
      if (state === 'generated') {
        removeKnownFile(runtime, entry.stagedPath, entry.generated, '本任务 staging 文件');
      } else if (state === 'unknown') {
        issues.push(`staging 文件已被外部改写，未删除：${entry.stagedPath}`);
      }
    } catch (error) {
      issues.push(`清理 staging 失败：${entry.stagedPath}（${messageOf(error)}）`);
    }
  }

  if (issues.length > 0) markManualRecovery(runtime, journal, issues);

  journal.status = 'rolled-back';
  try {
    persistJournal(runtime, journal);
    removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${journal.taskId} 的文件已回滚，但恢复记录收尾失败`,
      {
        detailLines: [`journal：${journal.journalPath}`, `原因：${messageOf(error)}`],
        recoveryPaths: [journal.journalPath, getIndexPath(journal.userDataDir)],
        cause: error
      }
    );
  }
  try {
    runtime.fsImpl.rmSync(journal.journalPath, { force: true });
    fsyncDirectory(runtime.fsImpl, path.dirname(journal.journalPath));
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${journal.taskId} 已回滚，但 journal 清理失败`,
      {
        detailLines: [`journal：${journal.journalPath}`, `原因：${messageOf(error)}`],
        recoveryPaths: [journal.journalPath]
      }
    );
  }
}

function cleanupCommitted(runtime, journal) {
  const issues = [];
  for (const entry of journal.entries) {
    try {
      const backup = backupState(runtime, entry);
      if (backup === 'original') {
        removeKnownFile(runtime, entry.backupPath, entry.original, '已提交任务的旧文件备份');
      } else if (backup === 'unknown') {
        issues.push(`备份已被外部改写，未删除：${entry.backupPath}`);
      }
      const staged = stagingState(runtime, entry);
      if (staged === 'generated') {
        removeKnownFile(runtime, entry.stagedPath, entry.generated, '已提交任务的 staging 文件');
      } else if (staged === 'unknown') {
        issues.push(`staging 已被外部改写，未删除：${entry.stagedPath}`);
      }
    } catch (error) {
      issues.push(`提交后清理失败：${entry.targetPath}（${messageOf(error)}）`);
    }
  }
  if (issues.length > 0) {
    journal.status = 'committed-cleanup-pending';
    journal.cleanupIssues = issues.slice();
    try { persistJournal(runtime, journal); } catch (_error) { /* index 仍保留 */ }
    return { complete: false, warnings: issues };
  }

  removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
  const warnings = [];
  try {
    runtime.fsImpl.rmSync(journal.journalPath, { force: true });
    fsyncDirectory(runtime.fsImpl, path.dirname(journal.journalPath));
  } catch (error) {
    warnings.push(`发布已提交，但 journal 未能删除：${journal.journalPath}（${messageOf(error)}）`);
  }
  return { complete: true, warnings };
}

function recoverOneJournal(runtime, indexEntry) {
  const journal = readJournal(
    runtime,
    indexEntry.journalAbsolutePath,
    indexEntry.taskId
  );
  if (journal.userDataDir !== indexEntry.userDataDir && indexEntry.userDataDir) {
    markManualRecovery(runtime, journal, ['journal 的 userDataDir 与恢复索引上下文不一致']);
  }
  if (journal.status === 'manual-recovery') {
    throw new ToolboxPublicationManualRecoveryError(
      `工具箱发布任务 ${journal.taskId} 仍需人工恢复`,
      {
        detailLines: Array.isArray(journal.manualRecoveryIssues)
          ? journal.manualRecoveryIssues
          : [],
        recoveryPaths: collectRecoveryPaths(journal)
      }
    );
  }
  if (journal.status === 'prepared') {
    const cleanupErrors = cancelPrepared(runtime, journal, true);
    if (cleanupErrors.length > 0) {
      throw new ToolboxPublicationManualRecoveryError(
        `尚未触碰正式目标的任务 ${journal.taskId} 清理不完整`,
        {
          detailLines: cleanupErrors,
          recoveryPaths: collectRecoveryPaths(journal)
        }
      );
    }
    return { taskId: journal.taskId, action: 'cancelled-prepared', warnings: [] };
  }
  if (journal.status === 'committed' || journal.status === 'committed-cleanup-pending') {
    const cleanup = cleanupCommitted(runtime, journal);
    if (!cleanup.complete) {
      throw new ToolboxPublicationManualRecoveryError(
        `任务 ${journal.taskId} 已提交，但残留文件需人工处理`,
        {
          detailLines: cleanup.warnings,
          recoveryPaths: collectRecoveryPaths(journal)
        }
      );
    }
    return { taskId: journal.taskId, action: 'commit-cleanup', warnings: cleanup.warnings };
  }
  rollbackUncommitted(runtime, journal);
  return { taskId: journal.taskId, action: 'rolled-back', warnings: [] };
}

function recoverPendingInternal(runtime, userDataDir) {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const { value } = readIndex(runtime, resolvedUserDataDir);
  const recovered = [];
  const skippedActive = [];
  for (const entry of value.entries.slice()) {
    if (activeTaskIds.has(entry.taskId)) {
      skippedActive.push(entry.taskId);
      continue;
    }
    recovered.push(recoverOneJournal(runtime, {
      ...entry,
      userDataDir: resolvedUserDataDir
    }));
  }
  return { recovered, skippedActive };
}

function recoverPendingToolboxPublications(options = {}) {
  return withLifecycleMutex('执行恢复', () => {
    if (!options.userDataDir) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_INPUT',
        '缺少 userDataDir，无法恢复工具箱发布任务'
      );
    }
    return recoverPendingInternal(createRuntime(options), options.userDataDir);
  });
}

function makeJournal(runtime, taskId, userDataDir, entries) {
  const nonce = runtime.randomUUID();
  const journalDir = path.dirname(entries[0].targetPath);
  const taskSlug = taskId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'task';
  const journalPath = path.join(
    journalDir,
    `.toolbox-publish-${taskSlug}-${nonce}.journal.json`
  );
  const createdAt = dateIso(runtime);
  const normalizedEntries = entries.map((entry, index) => ({
    ...entry,
    stagedPath: path.join(
      path.dirname(entry.targetPath),
      `.toolbox-publish-${nonce}-${index + 1}.stage`
    ),
    backupPath: path.join(
      path.dirname(entry.targetPath),
      `.toolbox-publish-${nonce}-${index + 1}.backup`
    ),
    original: { exists: false, size: null, sha256: null },
    generated: { size: null, sha256: null },
    backupDone: false,
    published: false
  }));
  return {
    version: JOURNAL_VERSION,
    taskId,
    nonce,
    userDataDir: path.resolve(userDataDir),
    journalPath,
    createdAt,
    updatedAt: createdAt,
    status: 'preparing',
    entries: normalizedEntries
  };
}

function ensureTargetParent(runtime, targetPath) {
  const parent = path.dirname(targetPath);
  const stat = lstatOrNull(runtime.fsImpl, parent);
  if (!stat || !stat.isDirectory()) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_TARGET_DIR',
      `目标目录不存在或不是文件夹：${parent}`
    );
  }
  runtime.fsImpl.accessSync(parent, (runtime.fsImpl.constants || fs.constants).W_OK);
}

function preflightJournal(runtime, journal) {
  const targetKeys = new Set();
  for (const entry of journal.entries) {
    ensureTargetParent(runtime, entry.targetPath);
    assertRegularFile(runtime.fsImpl, entry.artifactPath, '生成产物');
    const key = targetReservationKey(runtime.fsImpl, entry.targetPath);
    if (targetKeys.has(key)) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_DUPLICATE_TARGET',
        `发布目标路径重复：${entry.targetPath}`
      );
    }
    targetKeys.add(key);
    const targetStat = lstatOrNull(runtime.fsImpl, entry.targetPath);
    if (targetStat && !targetStat.isFile()) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_TARGET',
        `目标存在但不是可覆盖的普通文件：${entry.targetPath}`
      );
    }
    for (const managedPath of [entry.stagedPath, entry.backupPath]) {
      if (lstatOrNull(runtime.fsImpl, managedPath)) {
        throw new ToolboxPublicationError(
          'TOOLBOX_PUBLICATION_PATH_COLLISION',
          `任务暂存路径已存在：${managedPath}`
        );
      }
    }
  }
  if (lstatOrNull(runtime.fsImpl, journal.journalPath)) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_PATH_COLLISION',
      `任务 journal 路径已存在：${journal.journalPath}`
    );
  }
}

function cancelPrepared(runtime, journal, indexRegistered) {
  const cleanupErrors = [];
  for (const entry of journal.entries) {
    try {
      // 该路径由本任务随机创建，且 cancelPrepared 只会在正式目标尚未被触碰时
      // 执行；即使 copy 中途失败或校验不一致，它也没有恢复价值。
      runtime.fsImpl.rmSync(entry.stagedPath, { force: true });
    } catch (error) {
      cleanupErrors.push(`删除 staging 失败：${entry.stagedPath}（${messageOf(error)}）`);
    }
  }
  if (indexRegistered) {
    try {
      removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
    } catch (error) {
      cleanupErrors.push(`移除恢复索引失败：${messageOf(error)}`);
    }
  }
  try {
    runtime.fsImpl.rmSync(journal.journalPath, { force: true });
  } catch (error) {
    cleanupErrors.push(`删除 journal 失败：${journal.journalPath}（${messageOf(error)}）`);
  }
  return cleanupErrors;
}

function prepareToolboxPublication(options = {}) {
  return withLifecycleMutex('准备新发布', () => {
    const runtime = createRuntime(options);
    const taskId = String(options.taskId || '').trim();
    if (!taskId || !options.userDataDir) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_INPUT',
        '发布任务必须提供非空 taskId 和 userDataDir'
      );
    }
    recoverPendingInternal(runtime, options.userDataDir);
    if (activeTaskIds.has(taskId)) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_DUPLICATE_TASK',
        `工具箱发布任务仍在进行：${taskId}`
      );
    }

    const inputs = normalizeInputs(options.artifacts, options.targets);
    const journal = makeJournal(runtime, taskId, options.userDataDir, inputs);
    preflightJournal(runtime, journal);
    const reservationKeys = reserveTargets(runtime, taskId, journal.entries);
    activeTaskIds.add(taskId);
    let indexRegistered = false;

    try {
      for (let index = 0; index < journal.entries.length; index += 1) {
        const entry = journal.entries[index];
        const generated = inspectRegularFile(runtime.fsImpl, entry.artifactPath);
        entry.generated = generated;
        const originalStat = lstatOrNull(runtime.fsImpl, entry.targetPath);
        if (originalStat) {
          entry.original = { exists: true, ...inspectRegularFile(runtime.fsImpl, entry.targetPath) };
        }
        runtime.fsImpl.copyFileSync(
          entry.artifactPath,
          entry.stagedPath,
          (runtime.fsImpl.constants || fs.constants).COPYFILE_EXCL
        );
        fsyncFile(runtime.fsImpl, entry.stagedPath);
        fsyncDirectory(runtime.fsImpl, path.dirname(entry.stagedPath));
        const staged = inspectRegularFile(runtime.fsImpl, entry.stagedPath);
        if (staged.size !== generated.size || staged.sha256 !== generated.sha256) {
          throw new ToolboxPublicationError(
            'TOOLBOX_PUBLICATION_STAGE_VERIFY',
            `发布暂存文件校验失败：${entry.stagedPath}`
          );
        }
        callCheckpoint(runtime, 'prepare:after-staged', {
          taskId,
          index,
          stagedPath: entry.stagedPath
        });
      }

      journal.status = 'prepared';
      persistJournal(runtime, journal);
      callCheckpoint(runtime, 'prepare:after-journal', {
        taskId,
        journalPath: journal.journalPath
      });
      addIndexEntry(runtime, journal.userDataDir, {
        taskId,
        journalAbsolutePath: journal.journalPath,
        createdAt: journal.createdAt
      });
      indexRegistered = true;
      callCheckpoint(runtime, 'prepare:after-index', {
        taskId,
        journalPath: journal.journalPath
      });

      const prepared = {
        taskId,
        userDataDir: journal.userDataDir,
        journalPath: journal.journalPath,
        reservationKeys: reservationKeys.slice(),
        artifacts: journal.entries.map((entry) => ({
          sourcePath: entry.artifactPath,
          targetPath: entry.targetPath,
          stagedPath: entry.stagedPath,
          ...entry.metadata
        }))
      };
      Object.defineProperty(prepared, PREPARED_RUNTIME, {
        value: runtime,
        enumerable: false,
        configurable: false,
        writable: false
      });
      return prepared;
    } catch (error) {
      if (isCrashError(error)) {
        releaseReservations(taskId, reservationKeys);
        throw error;
      }
      let indexStateError = null;
      if (!indexRegistered) {
        try {
          indexRegistered = indexContainsEntry(
            runtime,
            journal.userDataDir,
            journal.taskId,
            journal.journalPath
          );
        } catch (indexError) {
          indexStateError = indexError;
        }
      }
      if (indexStateError) {
        releaseReservations(taskId, reservationKeys);
        throw new ToolboxPublicationManualRecoveryError(
          `工具箱发布任务 ${taskId} 准备失败，且无法确认恢复索引状态`,
          {
            detailLines: [
              `原始错误：${messageOf(error)}`,
              `索引错误：${messageOf(indexStateError)}`
            ],
            recoveryPaths: [
              getIndexPath(journal.userDataDir),
              ...collectRecoveryPaths(journal)
            ],
            cause: error
          }
        );
      }
      const cleanupErrors = cancelPrepared(runtime, journal, indexRegistered);
      releaseReservations(taskId, reservationKeys);
      if (cleanupErrors.length > 0) {
        throw new ToolboxPublicationManualRecoveryError(
          `工具箱发布任务 ${taskId} 准备失败且清理不完整`,
          {
            detailLines: [
              `原始错误：${messageOf(error)}`,
              ...cleanupErrors
            ],
            recoveryPaths: collectRecoveryPaths(journal),
            cause: error
          }
        );
      }
      throw error;
    }
  });
}

function assertTargetUnchangedSincePrepare(runtime, entry) {
  const stat = lstatOrNull(runtime.fsImpl, entry.targetPath);
  if (!entry.original.exists) {
    if (stat) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_TARGET_CHANGED',
        `目标在准备完成后被创建，已取消发布：${entry.targetPath}`
      );
    }
    return;
  }
  if (!stat || !stat.isFile() || !fileMatches(runtime.fsImpl, entry.targetPath, entry.original)) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_TARGET_CHANGED',
      `目标在准备完成后发生变化，已取消发布：${entry.targetPath}`
    );
  }
}

function collectMetadataWarnings(entries) {
  const warnings = [];
  const append = (value) => {
    if (value !== null && value !== undefined && String(value).trim()) {
      warnings.push(String(value));
    }
  };
  for (const entry of entries) {
    const summary = entry.metadata && entry.metadata.warningSummary;
    if (Array.isArray(summary)) {
      for (const item of summary) append(item);
    } else if (summary && typeof summary === 'object') {
      const items = Array.isArray(summary.items)
        ? summary.items
        : Array.isArray(summary.warnings)
          ? summary.warnings
          : [];
      for (const item of items) append(item);
      append(summary.message);
    } else {
      append(summary);
    }
  }
  return warnings;
}

function buildPublishFiles(journal) {
  return journal.entries.map((entry) => ({
    filePath: entry.targetPath,
    fileName: entry.metadata.fileName || path.basename(entry.targetPath),
    matchedCount: entry.metadata.matchedCount,
    outputId: entry.metadata.outputId,
    warningSummary: entry.metadata.warningSummary,
    styleStats: entry.metadata.styleStats
  }));
}

function finalizeCommittedPublication(runtime, journal, extraWarnings = []) {
  let cleanup;
  try {
    cleanup = cleanupCommitted(runtime, journal);
  } catch (error) {
    cleanup = {
      complete: false,
      warnings: [
        `发布已提交，但自动收尾失败；下次工具箱任务将重试：${messageOf(error)}`,
        `恢复 journal：${journal.journalPath}`
      ]
    };
  }
  return {
    taskId: journal.taskId,
    committed: true,
    pendingCleanup: !cleanup.complete,
    files: buildPublishFiles(journal),
    warnings: [
      ...collectMetadataWarnings(journal.entries),
      ...extraWarnings,
      ...cleanup.warnings
    ]
  };
}

function publishPreparedToolboxPublication(prepared) {
  return withLifecycleMutex('提交发布', () => {
    if (!prepared || typeof prepared !== 'object' || !prepared.journalPath || !prepared.taskId) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_PREPARED',
        '发布参数不是有效的 prepared 工具箱任务'
      );
    }
    const runtime = prepared[PREPARED_RUNTIME] || createRuntime();
    const reservationKeys = Array.isArray(prepared.reservationKeys)
      ? prepared.reservationKeys
      : [];
    let journal = readJournal(runtime, prepared.journalPath, prepared.taskId);
    const { value: index } = readIndex(runtime, journal.userDataDir);
    const journalPathKey = targetReservationKey(runtime.fsImpl, journal.journalPath);
    const indexed = index.entries.some((entry) => (
      entry.taskId === journal.taskId
      && targetReservationKey(runtime.fsImpl, entry.journalAbsolutePath) === journalPathKey
    ));
    if (!indexed) {
      releaseReservations(journal.taskId, reservationKeys);
      throw new ToolboxPublicationManualRecoveryError(
        `任务 ${journal.taskId} 的 journal 未登记在固定恢复索引中，拒绝触碰目标`,
        {
          recoveryPaths: [getIndexPath(journal.userDataDir), journal.journalPath]
        }
      );
    }
    if (journal.status !== 'prepared') {
      releaseReservations(journal.taskId, reservationKeys);
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_INVALID_STATE',
        `任务 ${journal.taskId} 当前状态不能发布：${journal.status}`
      );
    }

    let commitDurable = false;
    try {
      for (const entry of journal.entries) {
        if (!fileMatches(runtime.fsImpl, entry.stagedPath, entry.generated)) {
          throw new ToolboxPublicationError(
            'TOOLBOX_PUBLICATION_STAGE_CHANGED',
            `发布 staging 缺失或校验失败：${entry.stagedPath}`
          );
        }
        assertTargetUnchangedSincePrepare(runtime, entry);
      }
    } catch (error) {
      const cleanupErrors = cancelPrepared(runtime, journal, true);
      releaseReservations(journal.taskId, reservationKeys);
      if (cleanupErrors.length > 0) {
        throw new ToolboxPublicationManualRecoveryError(
          `任务 ${journal.taskId} 发布前检查失败且清理不完整`,
          {
            detailLines: [`原始错误：${messageOf(error)}`, ...cleanupErrors],
            recoveryPaths: collectRecoveryPaths(journal),
            cause: error
          }
        );
      }
      throw error;
    }

    try {
      journal.status = 'publishing';
      persistJournal(runtime, journal);
      callCheckpoint(runtime, 'publish:before-target-mutation', { taskId: journal.taskId });

      for (let index = 0; index < journal.entries.length; index += 1) {
        const entry = journal.entries[index];
        if (!entry.original.exists) continue;
        assertTargetUnchangedSincePrepare(runtime, entry);
        callCheckpoint(runtime, 'publish:before-backup', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
        runtime.fsImpl.renameSync(entry.targetPath, entry.backupPath);
        fsyncDirectory(runtime.fsImpl, path.dirname(entry.targetPath));
        callCheckpoint(runtime, 'publish:after-backup-rename-before-journal', {
          taskId: journal.taskId,
          index,
          backupPath: entry.backupPath
        });
        entry.backupDone = true;
        persistJournal(runtime, journal);
        callCheckpoint(runtime, 'publish:after-backup', {
          taskId: journal.taskId,
          index,
          backupPath: entry.backupPath
        });
      }

      for (let index = 0; index < journal.entries.length; index += 1) {
        const entry = journal.entries[index];
        callCheckpoint(runtime, 'publish:before-publish', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
        runtime.fsImpl.renameSync(entry.stagedPath, entry.targetPath);
        fsyncDirectory(runtime.fsImpl, path.dirname(entry.targetPath));
        callCheckpoint(runtime, 'publish:after-publish-rename-before-journal', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
        entry.published = true;
        persistJournal(runtime, journal);
        callCheckpoint(runtime, 'publish:after-publish', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
      }

      journal.status = 'committed';
      journal.committedAt = dateIso(runtime);
      persistJournal(runtime, journal);
      commitDurable = true;
      callCheckpoint(runtime, 'publish:after-committed', { taskId: journal.taskId });
    } catch (error) {
      if (isCrashError(error)) {
        releaseReservations(journal.taskId, reservationKeys);
        throw error;
      }
      let committedOnDisk = false;
      try {
        committedOnDisk = readJournal(
          runtime,
          journal.journalPath,
          journal.taskId
        ).status === 'committed';
      } catch (_readError) {
        committedOnDisk = false;
      }
      if (commitDurable || committedOnDisk) {
        const result = finalizeCommittedPublication(runtime, journal, [
          `发布已提交；提交后的检查出现异常：${messageOf(error)}`
        ]);
        releaseReservations(journal.taskId, reservationKeys);
        return result;
      }
      try {
        rollbackUncommitted(runtime, journal);
      } finally {
        releaseReservations(journal.taskId, reservationKeys);
      }
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_FAILED',
        `工具箱输出发布失败，已恢复发布前文件：${messageOf(error)}`,
        {
          detailLines: [`原始错误：${messageOf(error)}`],
          cause: error
        }
      );
    }

    const result = finalizeCommittedPublication(runtime, journal);
    releaseReservations(journal.taskId, reservationKeys);
    return result;
  });
}

function generationPathsFrom(value) {
  if (!value) return [];
  if (typeof value === 'string') return [path.resolve(value)];
  if (Array.isArray(value)) return value.flatMap((item) => generationPathsFrom(item));
  if (typeof value !== 'object') return [];
  if (Array.isArray(value.artifacts)) {
    return value.artifacts.flatMap((item) => {
      if (typeof item === 'string') return [path.resolve(item)];
      const sourcePath = extractPath(
        item,
        ['sourcePath', 'artifactPath', 'generationPath', 'filePath']
      );
      return sourcePath ? [path.resolve(sourcePath)] : [];
    });
  }
  const sourcePath = extractPath(
    value,
    ['sourcePath', 'artifactPath', 'generationPath', 'filePath']
  );
  return sourcePath ? [path.resolve(sourcePath)] : [];
}

function disposeToolboxGeneration(generation, options = {}) {
  const runtime = createRuntime(options);
  const disposed = [];
  const warnings = [];
  for (const generationPath of [...new Set(generationPathsFrom(generation))]) {
    try {
      const stat = lstatOrNull(runtime.fsImpl, generationPath);
      if (!stat) continue;
      if (!stat.isFile()) {
        warnings.push(`生成临时路径不是普通文件，未删除：${generationPath}`);
        continue;
      }
      runtime.fsImpl.rmSync(generationPath, { force: true });
      disposed.push(generationPath);
    } catch (error) {
      warnings.push(`删除生成临时文件失败：${generationPath}（${messageOf(error)}）`);
    }
  }
  return { disposed, warnings };
}

module.exports = {
  JOURNAL_INDEX_NAME,
  ToolboxPublicationCrashError,
  ToolboxPublicationError,
  ToolboxPublicationManualRecoveryError,
  disposeToolboxGeneration,
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
};
