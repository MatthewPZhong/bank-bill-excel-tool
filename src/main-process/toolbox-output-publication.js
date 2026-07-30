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
const INDEX_DISCOVERY_PREPARING = 'preparing';
const INDEX_DISCOVERY_PREPARED = 'prepared';
const INDEX_DISCOVERY_CANCELLING = 'cancelling';
const INDEX_DISCOVERY_ROLLBACK_FINALIZING = 'rollback-finalizing';
const INDEX_DISCOVERY_FINALIZING = 'finalizing';
const INDEX_DISCOVERY_STATES = new Set([
  INDEX_DISCOVERY_PREPARING,
  INDEX_DISCOVERY_PREPARED,
  INDEX_DISCOVERY_CANCELLING,
  INDEX_DISCOVERY_ROLLBACK_FINALIZING,
  INDEX_DISCOVERY_FINALIZING
]);

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
    // 只要仍需人工恢复，generation 可能是辨认/重建正式结果的唯一可信副本。
    // 该字段经 worker 序列化后由四个 main 入口统一消费，禁止 finally 递归删除。
    this.preserveTemporaryFiles = true;
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
  // Windows 的 FlushFileBuffers 需要可写文件句柄；只读句柄会返回 EPERM。
  // staged 文件由本任务刚创建且后续仍需发布，使用 r+ 不改变内容。
  const fd = fsImpl.openSync(filePath, 'r+');
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

function indexEntryDiscoveryState(entry) {
  // 仅用于识别索引状态；无 discoveryState 的 v1 条目没有可信路径锚点，
  // 发布与跨进程恢复入口会在触碰 managed file 前单独 fail-closed。
  return entry && entry.discoveryState === undefined
    ? INDEX_DISCOVERY_PREPARED
    : entry && entry.discoveryState;
}

function validateDiscoverableIndexEntry(runtime, entry, journalPathKey, managedPathKeys) {
  if (entry.discoveryState === undefined) return true;
  if (!INDEX_DISCOVERY_STATES.has(entry.discoveryState) ||
      typeof entry.nonce !== 'string' ||
      !entry.nonce ||
      !Array.isArray(entry.stagedAbsolutePaths) ||
      entry.stagedAbsolutePaths.length === 0 ||
      !Array.isArray(entry.targetAbsolutePaths) ||
      entry.targetAbsolutePaths.length !== entry.stagedAbsolutePaths.length ||
      !Array.isArray(entry.backupAbsolutePaths) ||
      entry.backupAbsolutePaths.length !== entry.stagedAbsolutePaths.length) {
    return false;
  }
  if (!path.basename(entry.journalAbsolutePath).endsWith(
    `-${entry.nonce}.journal.json`
  )) {
    return false;
  }
  const localManagedKeys = new Set();
  for (let index = 0; index < entry.stagedAbsolutePaths.length; index += 1) {
    const stagedPath = entry.stagedAbsolutePaths[index];
    const targetPath = entry.targetAbsolutePaths[index];
    const backupPath = entry.backupAbsolutePaths[index];
    if (typeof stagedPath !== 'string' ||
        !path.isAbsolute(stagedPath) ||
        typeof targetPath !== 'string' ||
        !path.isAbsolute(targetPath) ||
        typeof backupPath !== 'string' ||
        !path.isAbsolute(backupPath) ||
        path.basename(stagedPath) !==
          `.toolbox-publish-${entry.nonce}-${index + 1}.stage` ||
        path.basename(backupPath) !==
          `.toolbox-publish-${entry.nonce}-${index + 1}.backup`) {
      return false;
    }
    let stagedKey = '';
    let targetKey = '';
    let backupKey = '';
    try {
      stagedKey = targetPathAliasKey(runtime.fsImpl, stagedPath);
      targetKey = targetPathAliasKey(runtime.fsImpl, targetPath);
      backupKey = targetPathAliasKey(runtime.fsImpl, backupPath);
      if (
        directoryPathAliasKey(runtime.fsImpl, path.dirname(stagedPath))
          !== directoryPathAliasKey(runtime.fsImpl, path.dirname(targetPath))
        || directoryPathAliasKey(runtime.fsImpl, path.dirname(backupPath))
          !== directoryPathAliasKey(runtime.fsImpl, path.dirname(targetPath))
      ) {
        return false;
      }
    } catch (_error) {
      return false;
    }
    const itemKeys = [stagedKey, targetKey, backupKey];
    if (!stagedKey ||
        !targetKey ||
        !backupKey ||
        stagedKey === journalPathKey ||
        targetKey === journalPathKey ||
        backupKey === journalPathKey ||
        new Set(itemKeys).size !== 3 ||
        itemKeys.some((key) => localManagedKeys.has(key) || managedPathKeys.has(key))) {
      return false;
    }
    for (const key of itemKeys) localManagedKeys.add(key);
  }
  try {
    if (
      directoryPathAliasKey(runtime.fsImpl, path.dirname(entry.journalAbsolutePath))
      !== directoryPathAliasKey(
        runtime.fsImpl,
        path.dirname(entry.targetAbsolutePaths[0])
      )
    ) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  for (const managedKey of localManagedKeys) managedPathKeys.add(managedKey);
  return true;
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
  const managedPathKeys = new Set([
    targetPathAliasKey(runtime.fsImpl, indexPath)
  ]);
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
        || managedPathKeys.has(journalPathKey)
        || !validateDiscoverableIndexEntry(
          runtime,
          entry,
          journalPathKey,
          managedPathKeys
        )
      );
      if (!invalid) {
        taskIds.add(entry.taskId);
        journalPaths.add(journalPathKey);
        managedPathKeys.add(journalPathKey);
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

function markIndexEntryPrepared(runtime, userDataDir, taskId, journalPath) {
  const { indexPath, value } = readIndex(runtime, userDataDir);
  const expectedKey = targetPathAliasKey(runtime.fsImpl, journalPath);
  const matches = value.entries.filter((entry) => (
    entry.taskId === taskId
    && targetPathAliasKey(runtime.fsImpl, entry.journalAbsolutePath) === expectedKey
  ));
  if (matches.length !== 1 ||
      matches[0].discoveryState !== INDEX_DISCOVERY_PREPARING) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${taskId} 的 preparing 恢复索引状态无效，拒绝进入发布阶段`,
      {
        recoveryPaths: [indexPath, journalPath],
        detailLines: [`任务：${taskId}`, `journal：${journalPath}`]
      }
    );
  }
  matches[0].discoveryState = INDEX_DISCOVERY_PREPARED;
  writeIndex(runtime, indexPath, value);
}

function markIndexEntryCleanupState(
  runtime,
  journal,
  nextState,
  allowedCurrentStates,
  operationLabel
) {
  const { indexPath, value } = readIndex(runtime, journal.userDataDir);
  const expectedKey = targetPathAliasKey(runtime.fsImpl, journal.journalPath);
  const matches = value.entries.filter((entry) => (
    entry.taskId === journal.taskId
    && targetPathAliasKey(runtime.fsImpl, entry.journalAbsolutePath) === expectedKey
  ));
  if (
    matches.length !== 1
    || matches[0].discoveryState === undefined
    || !allowedCurrentStates.includes(matches[0].discoveryState)
    || !discoverableAnchorsMatchJournal(
      runtime,
      { ...matches[0], userDataDir: journal.userDataDir },
      journal
    )
  ) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${journal.taskId} 的恢复索引状态或锚点无效，拒绝${operationLabel}`,
      {
        recoveryPaths: [indexPath, journal.journalPath],
        detailLines: [`任务：${journal.taskId}`, `journal：${journal.journalPath}`]
      }
    );
  }
  const entry = matches[0];
  entry.discoveryState = nextState;
  writeIndex(runtime, indexPath, value);
}

function markIndexEntryFinalizing(runtime, journal) {
  markIndexEntryCleanupState(
    runtime,
    journal,
    INDEX_DISCOVERY_FINALIZING,
    [INDEX_DISCOVERY_PREPARED],
    '结束 committed 清理'
  );
}

function markIndexEntryCancelling(runtime, journal) {
  markIndexEntryCleanupState(
    runtime,
    journal,
    INDEX_DISCOVERY_CANCELLING,
    [INDEX_DISCOVERY_PREPARING, INDEX_DISCOVERY_PREPARED],
    '进入 prepared 取消清理'
  );
}

function markIndexEntryRollbackFinalizing(runtime, journal) {
  markIndexEntryCleanupState(
    runtime,
    journal,
    INDEX_DISCOVERY_ROLLBACK_FINALIZING,
    [INDEX_DISCOVERY_PREPARED],
    '结束 rollback 清理'
  );
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
    'preparing',
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
        || (
          entry.validatedGenerated !== undefined
          && !validGenerated(entry.validatedGenerated)
        )
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
    dataRowCount: choose('dataRowCount', null),
    sheetCount: choose('sheetCount', null),
    warningSummary: cloneJsonValue(choose('warningSummary', [])) || [],
    styleStats: cloneJsonValue(choose('styleStats', null))
  };
}

function validatedArtifactSnapshot(artifact, index, required) {
  const value = artifact && typeof artifact === 'object' ? artifact : {};
  const hasSize = value.byteSize !== undefined && value.byteSize !== null;
  const hasSha = value.sha256 !== undefined && value.sha256 !== null;
  if (!hasSize && !hasSha) {
    if (!required) return null;
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_VALIDATION_REQUIRED',
      `第 ${index + 1} 个发布产物缺少写后校验摘要，已阻止发布`
    );
  }
  const size = Number(value.byteSize);
  const sha256 = String(value.sha256 || '').toLowerCase();
  if (
    !Number.isSafeInteger(size)
    || size <= 0
    || !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_INVALID_VALIDATION',
      `第 ${index + 1} 个发布产物的写后校验摘要无效`
    );
  }
  return { size, sha256 };
}

function normalizeInputs(artifacts, targets, options = {}) {
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
    const validatedGenerated = validatedArtifactSnapshot(
      artifact,
      index,
      options.requireValidatedArtifacts === true
    );
    return {
      artifactPath: path.resolve(artifactPath),
      targetPath: resolvedTarget,
      ...(validatedGenerated ? { validatedGenerated } : {}),
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

function regularFileIdentity(fsImpl, filePath, options = {}) {
  let stat;
  try {
    // Node 默认的 Stats 会把 64-bit dev/ino 转成 Number；超过安全整数后会
    // 舍入，不能用于决定是否 unlink source。硬链接发布只信任精确 bigint。
    stat = fsImpl.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_NO_REPLACE_IDENTITY_UNAVAILABLE',
      `${options.operationLabel || '文件移动'}无法取得精确文件身份，已保留两端文件并停止发布`,
      {
        detailLines: [`路径：${filePath}`, `原因：${messageOf(error)}`],
        recoveryPaths: options.recoveryPaths || [filePath],
        cause: error
      }
    );
  }
  if (!stat || !stat.isFile()) return null;
  if (
    typeof stat.dev !== 'bigint'
    || typeof stat.ino !== 'bigint'
    || stat.dev < 0n
    || stat.ino <= 0n
  ) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_NO_REPLACE_IDENTITY_UNAVAILABLE',
      `${options.operationLabel || '文件移动'}无法取得可信文件身份，已保留两端文件并停止发布`,
      {
        detailLines: [
          `路径：${filePath}`,
          `dev 类型：${typeof stat.dev}`,
          `ino：${String(stat.ino)}`
        ],
        recoveryPaths: options.recoveryPaths || [filePath]
      }
    );
  }
  return {
    dev: stat.dev,
    ino: stat.ino
  };
}

function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

function moveFileNoReplace(runtime, sourcePath, destinationPath, options = {}) {
  const operationLabel = options.operationLabel || '文件移动';
  const destinationExistsCode = options.destinationExistsCode
    || 'TOOLBOX_PUBLICATION_DESTINATION_EXISTS';
  const destinationExistsMessage = options.destinationExistsMessage
    || `${operationLabel}的目标路径已存在，拒绝覆盖：${destinationPath}`;
  if (
    typeof runtime.fsImpl.linkSync !== 'function'
    || typeof runtime.fsImpl.unlinkSync !== 'function'
  ) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_NO_REPLACE_UNAVAILABLE',
      `${operationLabel}需要文件系统支持原子硬链接，当前运行环境不支持，已停止发布`,
      {
        detailLines: [`源：${sourcePath}`, `目标：${destinationPath}`],
        recoveryPaths: [sourcePath, destinationPath]
      }
    );
  }

  try {
    // link(2) 对已存在目标原子返回 EEXIST；禁止退回会覆盖目标的 rename。
    // source/destination 均由协议约束在同一目录，因此不会跨文件系统。
    runtime.fsImpl.linkSync(sourcePath, destinationPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new ToolboxPublicationError(
        destinationExistsCode,
        destinationExistsMessage,
        {
          detailLines: [`源：${sourcePath}`, `目标：${destinationPath}`],
          recoveryPaths: [sourcePath, destinationPath],
          cause: error
        }
      );
    }
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_NO_REPLACE_UNAVAILABLE',
      `${operationLabel}无法使用原子不覆盖操作，已停止发布：${destinationPath}`,
      {
        detailLines: [
          `源：${sourcePath}`,
          `目标：${destinationPath}`,
          `原因：${messageOf(error)}`
        ],
        recoveryPaths: [sourcePath, destinationPath],
        cause: error
      }
    );
  }

  try {
    fsyncDirectory(runtime.fsImpl, path.dirname(destinationPath));
    if (options.afterLinkCheckpoint) {
      callCheckpoint(
        runtime,
        options.afterLinkCheckpoint,
        options.checkpointContext || {}
      );
    }
    const identityOptions = {
      operationLabel,
      recoveryPaths: [sourcePath, destinationPath]
    };
    const sourceIdentity = regularFileIdentity(
      runtime.fsImpl,
      sourcePath,
      identityOptions
    );
    const destinationIdentity = regularFileIdentity(
      runtime.fsImpl,
      destinationPath,
      identityOptions
    );
    if (!sameFileIdentity(sourceIdentity, destinationIdentity)) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_SOURCE_REPLACED',
        `${operationLabel}建立目标后源路径被替换，已保留两端文件并停止发布`,
        {
          detailLines: [`源：${sourcePath}`, `目标：${destinationPath}`],
          recoveryPaths: [sourcePath, destinationPath]
        }
      );
    }
    runtime.fsImpl.unlinkSync(sourcePath);
    fsyncDirectory(runtime.fsImpl, path.dirname(sourcePath));
  } catch (error) {
    if (isCrashError(error) || error instanceof ToolboxPublicationError) throw error;
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_NO_REPLACE_MOVE_INCOMPLETE',
      `${operationLabel}已建立安全目标，但源路径未能完成清理`,
      {
        detailLines: [
          `源：${sourcePath}`,
          `目标：${destinationPath}`,
          `原因：${messageOf(error)}`
        ],
        recoveryPaths: [sourcePath, destinationPath],
        cause: error
      }
    );
  }
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
      entry.artifactPath,
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
            moveFileNoReplace(runtime, entry.backupPath, entry.targetPath, {
              operationLabel: '恢复原目标',
              destinationExistsCode: 'TOOLBOX_PUBLICATION_RESTORE_TARGET_EXISTS',
              destinationExistsMessage:
                `恢复原目标时正式路径被并发创建，拒绝覆盖：${entry.targetPath}`
            });
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
    // target/backup/staging 已恢复完成后，先用固定恢复根记录 durable
    // rollback-finalizing，再删 journal，最后删 index。任何收尾失败都可发现。
    markIndexEntryRollbackFinalizing(runtime, journal);
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${journal.taskId} 的文件已回滚，但恢复索引未能进入 rollback-finalizing`,
      {
        detailLines: [`journal：${journal.journalPath}`, `原因：${messageOf(error)}`],
        recoveryPaths: [
          getIndexPath(journal.userDataDir),
          ...collectRecoveryPaths(journal)
        ],
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
        recoveryPaths: [
          getIndexPath(journal.userDataDir),
          ...collectRecoveryPaths(journal)
        ]
      }
    );
  }
  try {
    removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `任务 ${journal.taskId} 已回滚且 journal 已删除，但恢复索引未能收尾`,
      {
        detailLines: [`原因：${messageOf(error)}`],
        recoveryPaths: [
          getIndexPath(journal.userDataDir),
          ...collectRecoveryPaths(journal)
        ],
        cause: error
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

  const warnings = [];
  try {
    // committed 数据与 backup/staging 已完成收尾后，先把固定恢复根切到
    // finalizing。这样 journal 删除失败仍可重试；journal 已删但 index
    // 删除失败时，新进程也能仅凭 finalizing intent 安全移除残留索引。
    markIndexEntryFinalizing(runtime, journal);
  } catch (error) {
    warnings.push(
      `发布已提交，但恢复索引未能进入 finalizing：${messageOf(error)}`
    );
    return { complete: false, warnings };
  }
  try {
    runtime.fsImpl.rmSync(journal.journalPath, { force: true });
    fsyncDirectory(runtime.fsImpl, path.dirname(journal.journalPath));
  } catch (error) {
    warnings.push(
      `发布已提交，但 journal 未能删除：${journal.journalPath}（${messageOf(error)}）`
    );
    return { complete: false, warnings };
  }
  try {
    removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
  } catch (error) {
    warnings.push(
      `发布已提交，journal 已删除，但恢复索引未能收尾：${messageOf(error)}`
    );
    return { complete: false, warnings };
  }
  return { complete: true, warnings };
}

function discoverableAnchorsMatchJournal(runtime, indexEntry, journal) {
  if (!journal ||
      journal.taskId !== indexEntry.taskId ||
      journal.nonce !== indexEntry.nonce ||
      journal.entries.length !== indexEntry.stagedAbsolutePaths.length ||
      journal.entries.length !== indexEntry.targetAbsolutePaths.length ||
      journal.entries.length !== indexEntry.backupAbsolutePaths.length) {
    return false;
  }
  try {
    return directoryPathAliasKey(runtime.fsImpl, journal.userDataDir) ===
        directoryPathAliasKey(runtime.fsImpl, indexEntry.userDataDir)
      && journal.entries.every((entry, index) => (
        targetPathAliasKey(runtime.fsImpl, entry.stagedPath) ===
          targetPathAliasKey(runtime.fsImpl, indexEntry.stagedAbsolutePaths[index])
        && targetPathAliasKey(runtime.fsImpl, entry.targetPath) ===
          targetPathAliasKey(runtime.fsImpl, indexEntry.targetAbsolutePaths[index])
        && targetPathAliasKey(runtime.fsImpl, entry.backupPath) ===
          targetPathAliasKey(runtime.fsImpl, indexEntry.backupAbsolutePaths[index])
      ));
  } catch (_error) {
    return false;
  }
}

function discoverableIntentMatchesJournal(
  runtime,
  indexEntry,
  journal,
  allowedJournalStatuses = ['preparing', 'prepared']
) {
  return Boolean(
    journal
    && allowedJournalStatuses.includes(journal.status)
    && discoverableAnchorsMatchJournal(runtime, indexEntry, journal)
  );
}

function throwDiscoverableAnchorMismatch(runtime, indexEntry) {
  const indexPath = getIndexPath(indexEntry.userDataDir);
  throw new ToolboxPublicationManualRecoveryError(
    `任务 ${indexEntry.taskId} 的恢复索引与 journal 锚点不一致，拒绝触碰任何文件`,
    {
      detailLines: [
        `任务：${indexEntry.taskId}`,
        `journal：${indexEntry.journalAbsolutePath}`,
        '请人工核对 index 与 journal 中的 nonce、userDataDir 及 target/staging/backup 路径。'
      ],
      recoveryPaths: [
        indexPath,
        indexEntry.journalAbsolutePath,
        ...indexEntry.targetAbsolutePaths,
        ...indexEntry.stagedAbsolutePaths,
        ...indexEntry.backupAbsolutePaths
      ]
    }
  );
}

function throwLegacyIndexManualRecovery(runtime, indexEntry) {
  const indexPath = getIndexPath(indexEntry.userDataDir);
  throw new ToolboxPublicationManualRecoveryError(
    `存量 v1 发布任务 ${indexEntry.taskId} 缺少可信路径锚点，只允许人工恢复`,
    {
      detailLines: [
        `任务：${indexEntry.taskId}`,
        `journal：${indexEntry.journalAbsolutePath}`,
        '为避免按未锚定 journal 删除或覆盖未知文件，程序未读取或修改任何 task-managed 文件。'
      ],
      recoveryPaths: [indexPath, indexEntry.journalAbsolutePath]
    }
  );
}

function recoverPreparingIntent(runtime, indexEntry, options = {}) {
  const stateLabel = options.stateLabel || 'preparing';
  const recoveredAction = options.recoveredAction || 'cancelled-preparing';
  const indexPath = getIndexPath(indexEntry.userDataDir);
  const journalStat = lstatOrNull(runtime.fsImpl, indexEntry.journalAbsolutePath);
  if (journalStat) {
    if (!journalStat.isFile()) {
      throw new ToolboxPublicationManualRecoveryError(
        `${stateLabel} 任务 ${indexEntry.taskId} 的 journal 不是普通文件`,
        {
          recoveryPaths: [indexPath, indexEntry.journalAbsolutePath],
          detailLines: [`journal：${indexEntry.journalAbsolutePath}`]
        }
      );
    }
    const journal = readJournal(
      runtime,
      indexEntry.journalAbsolutePath,
      indexEntry.taskId
    );
    if (!discoverableIntentMatchesJournal(runtime, indexEntry, journal)) {
      throwDiscoverableAnchorMismatch(runtime, indexEntry);
    }
  }

  const cleanupErrors = [];
  for (const stagedPath of indexEntry.stagedAbsolutePaths) {
    try {
      const stat = lstatOrNull(runtime.fsImpl, stagedPath);
      if (!stat) continue;
      if (!stat.isFile()) {
        cleanupErrors.push(`staging 不是普通文件，未删除：${stagedPath}`);
        continue;
      }
      // preparing intent 在任何正式目标变更前持久化；该随机路径只属于本任务，
      // copy 中断产生的部分文件也必须直接删除，不能要求它先通过完整 hash。
      runtime.fsImpl.rmSync(stagedPath, { force: true });
      fsyncDirectory(runtime.fsImpl, path.dirname(stagedPath));
    } catch (error) {
      cleanupErrors.push(`删除 staging 失败：${stagedPath}（${messageOf(error)}）`);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new ToolboxPublicationManualRecoveryError(
      `${stateLabel} 任务 ${indexEntry.taskId} 的 staging 清理不完整`,
      {
        recoveryPaths: [
          indexPath,
          indexEntry.journalAbsolutePath,
          ...indexEntry.stagedAbsolutePaths
        ],
        detailLines: cleanupErrors
      }
    );
  }

  try {
    const stat = lstatOrNull(runtime.fsImpl, indexEntry.journalAbsolutePath);
    if (stat) {
      runtime.fsImpl.rmSync(indexEntry.journalAbsolutePath, { force: true });
      fsyncDirectory(runtime.fsImpl, path.dirname(indexEntry.journalAbsolutePath));
    }
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `${stateLabel} 任务 ${indexEntry.taskId} 的 journal 清理失败`,
      {
        recoveryPaths: [indexPath, indexEntry.journalAbsolutePath],
        detailLines: [`原因：${messageOf(error)}`],
        cause: error
      }
    );
  }

  try {
    removeIndexEntry(
      runtime,
      indexEntry.userDataDir,
      indexEntry.taskId,
      indexEntry.journalAbsolutePath
    );
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `${stateLabel} 任务 ${indexEntry.taskId} 已清理，但 index 收尾失败`,
      {
        recoveryPaths: [indexPath],
        detailLines: [`原因：${messageOf(error)}`],
        cause: error
      }
    );
  }
  return { taskId: indexEntry.taskId, action: recoveredAction, warnings: [] };
}

function recoverFinalizingIntent(runtime, indexEntry, options = {}) {
  const stateLabel = options.stateLabel || 'finalizing';
  const allowedJournalStatuses = options.allowedJournalStatuses
    || ['committed', 'committed-cleanup-pending'];
  const recoveredAction = options.recoveredAction || 'commit-cleanup';
  const indexPath = getIndexPath(indexEntry.userDataDir);
  const journalStat = lstatOrNull(runtime.fsImpl, indexEntry.journalAbsolutePath);
  if (journalStat) {
    if (!journalStat.isFile()) {
      throw new ToolboxPublicationManualRecoveryError(
        `${stateLabel} 任务 ${indexEntry.taskId} 的 journal 不是普通文件`,
        {
          recoveryPaths: [indexPath, indexEntry.journalAbsolutePath],
          detailLines: [`journal：${indexEntry.journalAbsolutePath}`]
        }
      );
    }
    const journal = readJournal(
      runtime,
      indexEntry.journalAbsolutePath,
      indexEntry.taskId
    );
    if (!discoverableIntentMatchesJournal(
      runtime,
      indexEntry,
      journal,
      allowedJournalStatuses
    )) {
      throwDiscoverableAnchorMismatch(runtime, indexEntry);
    }
    try {
      runtime.fsImpl.rmSync(indexEntry.journalAbsolutePath, { force: true });
      fsyncDirectory(runtime.fsImpl, path.dirname(indexEntry.journalAbsolutePath));
    } catch (error) {
      throw new ToolboxPublicationManualRecoveryError(
        `${stateLabel} 任务 ${indexEntry.taskId} 的 journal 清理失败`,
        {
          recoveryPaths: [indexPath, indexEntry.journalAbsolutePath],
          detailLines: [`原因：${messageOf(error)}`],
          cause: error
        }
      );
    }
  }
  try {
    removeIndexEntry(
      runtime,
      indexEntry.userDataDir,
      indexEntry.taskId,
      indexEntry.journalAbsolutePath
    );
  } catch (error) {
    throw new ToolboxPublicationManualRecoveryError(
      `${stateLabel} 任务 ${indexEntry.taskId} 的 index 收尾失败`,
      {
        recoveryPaths: [indexPath],
        detailLines: [`原因：${messageOf(error)}`],
        cause: error
      }
    );
  }
  return { taskId: indexEntry.taskId, action: recoveredAction, warnings: [] };
}

function recoverOneJournal(runtime, indexEntry) {
  if (indexEntry.discoveryState === undefined) {
    throwLegacyIndexManualRecovery(runtime, indexEntry);
  }
  const discoveryState = indexEntryDiscoveryState(indexEntry);
  if (discoveryState === INDEX_DISCOVERY_PREPARING) {
    return recoverPreparingIntent(runtime, indexEntry);
  }
  if (discoveryState === INDEX_DISCOVERY_CANCELLING) {
    return recoverPreparingIntent(runtime, indexEntry, {
      stateLabel: 'cancelling',
      recoveredAction: 'cancelled'
    });
  }
  if (discoveryState === INDEX_DISCOVERY_ROLLBACK_FINALIZING) {
    return recoverFinalizingIntent(runtime, indexEntry, {
      stateLabel: 'rollback-finalizing',
      allowedJournalStatuses: ['rolled-back'],
      recoveredAction: 'rolled-back'
    });
  }
  if (discoveryState === INDEX_DISCOVERY_FINALIZING) {
    return recoverFinalizingIntent(runtime, indexEntry);
  }
  const journal = readJournal(
    runtime,
    indexEntry.journalAbsolutePath,
    indexEntry.taskId
  );
  if (
    indexEntry.discoveryState !== undefined
    && !discoverableAnchorsMatchJournal(runtime, indexEntry, journal)
  ) {
    throwDiscoverableAnchorMismatch(runtime, indexEntry);
  }
  if (journal.status === 'preparing') {
    if (indexEntry.discoveryState !== undefined) {
      return recoverPreparingIntent(runtime, indexEntry);
    }
    const cleanupErrors = cancelPrepared(runtime, journal, true);
    if (cleanupErrors.length > 0) {
      throw new ToolboxPublicationManualRecoveryError(
        `preparing 任务 ${journal.taskId} 清理不完整`,
        {
          detailLines: cleanupErrors,
          recoveryPaths: collectRecoveryPaths(journal)
        }
      );
    }
    return { taskId: journal.taskId, action: 'cancelled-preparing', warnings: [] };
  }
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

function pathAliasIsWithinDirectory(fileAliasKey, directoryAliasKey) {
  return fileAliasKey === directoryAliasKey
    || fileAliasKey.startsWith(
      directoryAliasKey.endsWith(path.sep)
        ? directoryAliasKey
        : `${directoryAliasKey}${path.sep}`
    );
}

function preflightJournal(runtime, journal) {
  for (const entry of journal.entries) {
    ensureTargetParent(runtime, entry.targetPath);
    assertRegularFile(runtime.fsImpl, entry.artifactPath, '生成产物');
  }

  const managedPaths = [
    { label: '固定恢复索引', filePath: getIndexPath(journal.userDataDir) },
    { label: '任务 journal', filePath: journal.journalPath },
    ...journal.entries.flatMap((entry, index) => [
      { label: `第 ${index + 1} 个正式目标`, filePath: entry.targetPath },
      { label: `第 ${index + 1} 个 staging`, filePath: entry.stagedPath },
      { label: `第 ${index + 1} 个 backup`, filePath: entry.backupPath }
    ])
  ];
  const managedKeys = new Map();
  for (const managed of managedPaths) {
    const key = targetPathAliasKey(runtime.fsImpl, managed.filePath);
    const previous = managedKeys.get(key);
    if (previous) {
      const duplicateTargets = previous.label.includes('正式目标')
        && managed.label.includes('正式目标');
      throw new ToolboxPublicationError(
        duplicateTargets
          ? 'TOOLBOX_PUBLICATION_DUPLICATE_TARGET'
          : 'TOOLBOX_PUBLICATION_PATH_COLLISION',
        `发布保留路径发生碰撞：${managed.filePath}`,
        {
          detailLines: [
            `${previous.label}：${previous.filePath}`,
            `${managed.label}：${managed.filePath}`
          ],
          recoveryPaths: [previous.filePath, managed.filePath]
        }
      );
    }
    managedKeys.set(key, managed);
  }

  const artifactParents = journal.entries.map((entry) => ({
    artifactPath: entry.artifactPath,
    parentAliasKey: directoryPathAliasKey(
      runtime.fsImpl,
      path.dirname(entry.artifactPath)
    )
  }));
  for (const entry of journal.entries) {
    const artifactKey = targetPathAliasKey(runtime.fsImpl, entry.artifactPath);
    const collision = managedKeys.get(artifactKey);
    if (collision) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_ARTIFACT_PATH_COLLISION',
        `生成产物与发布保留路径发生碰撞：${entry.artifactPath}`,
        {
          detailLines: [
            `生成产物：${entry.artifactPath}`,
            `${collision.label}：${collision.filePath}`
          ],
          recoveryPaths: [entry.artifactPath, collision.filePath]
        }
      );
    }
    const targetKey = targetPathAliasKey(runtime.fsImpl, entry.targetPath);
    const generationOwner = artifactParents.find((item) => (
      pathAliasIsWithinDirectory(targetKey, item.parentAliasKey)
    ));
    if (generationOwner) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_TARGET_IN_GENERATION_DIR',
        `正式目标不能位于生成临时目录内：${entry.targetPath}`,
        {
          detailLines: [
            `正式目标：${entry.targetPath}`,
            `生成产物：${generationOwner.artifactPath}`
          ],
          recoveryPaths: [entry.targetPath, generationOwner.artifactPath]
        }
      );
    }
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
  if (indexRegistered) {
    try {
      // 固定恢复根必须先进入 durable cancelling，再删除任何可发现文件。
      // 任一后续失败/崩溃都由该 intent 继续清理，禁止留下孤儿 journal。
      markIndexEntryCancelling(runtime, journal);
    } catch (error) {
      cleanupErrors.push(`恢复索引未能进入 cancelling：${messageOf(error)}`);
      return cleanupErrors;
    }
  }
  for (const entry of journal.entries) {
    try {
      // 该路径由本任务随机创建，且 cancelPrepared 只会在正式目标尚未被触碰时
      // 执行；即使 copy 中途失败或校验不一致，它也没有恢复价值。
      runtime.fsImpl.rmSync(entry.stagedPath, { force: true });
      fsyncDirectory(runtime.fsImpl, path.dirname(entry.stagedPath));
    } catch (error) {
      cleanupErrors.push(`删除 staging 失败：${entry.stagedPath}（${messageOf(error)}）`);
    }
  }
  if (cleanupErrors.length > 0) return cleanupErrors;
  try {
    runtime.fsImpl.rmSync(journal.journalPath, { force: true });
    fsyncDirectory(runtime.fsImpl, path.dirname(journal.journalPath));
  } catch (error) {
    cleanupErrors.push(`删除 journal 失败：${journal.journalPath}（${messageOf(error)}）`);
    return cleanupErrors;
  }
  if (indexRegistered) {
    try {
      removeIndexEntry(runtime, journal.userDataDir, journal.taskId, journal.journalPath);
    } catch (error) {
      cleanupErrors.push(`移除恢复索引失败：${messageOf(error)}`);
    }
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
    const resolvedUserDataDir = path.resolve(options.userDataDir);
    runtime.fsImpl.mkdirSync(resolvedUserDataDir, { recursive: true });
    recoverPendingInternal(runtime, resolvedUserDataDir);
    if (activeTaskIds.has(taskId)) {
      throw new ToolboxPublicationError(
        'TOOLBOX_PUBLICATION_DUPLICATE_TASK',
        `工具箱发布任务仍在进行：${taskId}`
      );
    }

    const inputs = normalizeInputs(options.artifacts, options.targets, {
      requireValidatedArtifacts: options.requireValidatedArtifacts === true
    });
    const journal = makeJournal(runtime, taskId, resolvedUserDataDir, inputs);
    preflightJournal(runtime, journal);
    const reservationKeys = reserveTargets(runtime, taskId, journal.entries);
    activeTaskIds.add(taskId);
    let indexRegistered = false;

    try {
      // 先完成只读快照；此阶段尚未在目标目录创建任何 staging byte。
      for (let index = 0; index < journal.entries.length; index += 1) {
        const entry = journal.entries[index];
        const generated = inspectRegularFile(runtime.fsImpl, entry.artifactPath);
        if (
          entry.validatedGenerated
          && (
            generated.size !== entry.validatedGenerated.size
            || generated.sha256 !== entry.validatedGenerated.sha256
          )
        ) {
          throw new ToolboxPublicationError(
            'TOOLBOX_PUBLICATION_GENERATION_CHANGED',
            `已验证的工具箱临时产物在发布前发生变化：${entry.artifactPath}`,
            {
              detailLines: [
                `校验时大小：${entry.validatedGenerated.size}`,
                `当前大小：${generated.size}`,
                `校验时 SHA-256：${entry.validatedGenerated.sha256}`,
                `当前 SHA-256：${generated.sha256}`
              ]
            }
          );
        }
        entry.generated = generated;
        const originalStat = lstatOrNull(runtime.fsImpl, entry.targetPath);
        if (originalStat) {
          entry.original = { exists: true, ...inspectRegularFile(runtime.fsImpl, entry.targetPath) };
        }
      }

      // 固定 index 的 preparing intent 必须先于外部 journal/staging 落盘。
      // 即使进程在后续 copy 中途退出，新进程也能只凭 userData index
      // 找到本任务随机 staging 路径并清理，且绝不触碰正式 target。
      addIndexEntry(runtime, journal.userDataDir, {
        taskId,
        journalAbsolutePath: journal.journalPath,
        createdAt: journal.createdAt,
        discoveryState: INDEX_DISCOVERY_PREPARING,
        nonce: journal.nonce,
        stagedAbsolutePaths: journal.entries.map((entry) => entry.stagedPath),
        targetAbsolutePaths: journal.entries.map((entry) => entry.targetPath),
        backupAbsolutePaths: journal.entries.map((entry) => entry.backupPath)
      });
      indexRegistered = true;
      callCheckpoint(runtime, 'prepare:after-index-before-journal', {
        taskId,
        journalPath: journal.journalPath
      });

      persistJournal(runtime, journal);
      callCheckpoint(runtime, 'prepare:after-preparing-journal', {
        taskId,
        journalPath: journal.journalPath
      });

      for (let index = 0; index < journal.entries.length; index += 1) {
        const entry = journal.entries[index];
        runtime.fsImpl.copyFileSync(
          entry.artifactPath,
          entry.stagedPath,
          (runtime.fsImpl.constants || fs.constants).COPYFILE_EXCL
        );
        fsyncFile(runtime.fsImpl, entry.stagedPath);
        fsyncDirectory(runtime.fsImpl, path.dirname(entry.stagedPath));
        const staged = inspectRegularFile(runtime.fsImpl, entry.stagedPath);
        if (
          staged.size !== entry.generated.size
          || staged.sha256 !== entry.generated.sha256
        ) {
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
      markIndexEntryPrepared(
        runtime,
        journal.userDataDir,
        journal.taskId,
        journal.journalPath
      );
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

function assertTargetAbsentImmediatelyBeforePublish(runtime, entry) {
  if (lstatOrNull(runtime.fsImpl, entry.targetPath)) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_TARGET_RECREATED',
      `正式目标在 staging 发布前被并发创建，拒绝覆盖：${entry.targetPath}`
    );
  }
}

function assertAllPublishedTargetsMatch(runtime, entries) {
  const mismatches = [];
  for (const entry of entries) {
    try {
      if (!fileMatches(runtime.fsImpl, entry.targetPath, entry.generated)) {
        mismatches.push(`正式目标大小或 SHA-256 不一致：${entry.targetPath}`);
      }
    } catch (error) {
      mismatches.push(`正式目标最终复核失败：${entry.targetPath}（${messageOf(error)}）`);
    }
  }
  if (mismatches.length > 0) {
    throw new ToolboxPublicationError(
      'TOOLBOX_PUBLICATION_FINAL_TARGET_VERIFY',
      '整批正式目标在 committed 前最终复核失败',
      { detailLines: mismatches }
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
    dataRowCount: entry.metadata.dataRowCount,
    sheetCount: entry.metadata.sheetCount,
    byteSize: entry.generated.size,
    sha256: entry.generated.sha256,
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
    const indexedEntry = index.entries.find((entry) => (
      entry.taskId === journal.taskId
      && targetReservationKey(runtime.fsImpl, entry.journalAbsolutePath) === journalPathKey
    ));
    if (!indexedEntry) {
      releaseReservations(journal.taskId, reservationKeys);
      throw new ToolboxPublicationManualRecoveryError(
        `任务 ${journal.taskId} 的 journal 未登记在固定恢复索引中，拒绝触碰目标`,
        {
          recoveryPaths: [getIndexPath(journal.userDataDir), journal.journalPath]
        }
      );
    }
    if (indexedEntry.discoveryState === undefined) {
      releaseReservations(journal.taskId, reservationKeys);
      throwLegacyIndexManualRecovery(runtime, {
        ...indexedEntry,
        userDataDir: journal.userDataDir
      });
    }
    if (indexEntryDiscoveryState(indexedEntry) !== INDEX_DISCOVERY_PREPARED ||
        (
          indexedEntry.discoveryState !== undefined
          && !discoverableIntentMatchesJournal(
            runtime,
            { ...indexedEntry, userDataDir: journal.userDataDir },
            journal
          )
        )) {
      releaseReservations(journal.taskId, reservationKeys);
      throw new ToolboxPublicationManualRecoveryError(
        `任务 ${journal.taskId} 的 journal/index 尚未完整 prepared，拒绝触碰目标`,
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
        moveFileNoReplace(runtime, entry.targetPath, entry.backupPath, {
          operationLabel: '把原目标移入任务备份',
          destinationExistsCode: 'TOOLBOX_PUBLICATION_BACKUP_RECREATED',
          destinationExistsMessage:
            `任务备份路径被并发创建，拒绝覆盖：${entry.backupPath}`,
          afterLinkCheckpoint: 'publish:after-backup-link-before-target-unlink',
          checkpointContext: {
            taskId: journal.taskId,
            index,
            targetPath: entry.targetPath,
            backupPath: entry.backupPath
          }
        });
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
        // 所有原目标此时都已移入 backup；无论 prepare 时目标是否存在，
        // link 紧前先快速检查，并由 link(2) 在 syscall 边界原子拒绝已存在目标。
        assertTargetAbsentImmediatelyBeforePublish(runtime, entry);
        moveFileNoReplace(runtime, entry.stagedPath, entry.targetPath, {
          operationLabel: '发布 staging 到正式目标',
          destinationExistsCode: 'TOOLBOX_PUBLICATION_TARGET_RECREATED',
          destinationExistsMessage:
            `正式目标在 staging 发布时被并发创建，拒绝覆盖：${entry.targetPath}`,
          afterLinkCheckpoint: 'publish:after-stage-link-before-staging-unlink',
          checkpointContext: {
            taskId: journal.taskId,
            index,
            stagedPath: entry.stagedPath,
            targetPath: entry.targetPath
          }
        });
        callCheckpoint(runtime, 'publish:after-publish-rename-before-journal', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
        if (!fileMatches(runtime.fsImpl, entry.targetPath, entry.generated)) {
          throw new ToolboxPublicationError(
            'TOOLBOX_PUBLICATION_TARGET_VERIFY',
            `正式目标在发布重命名后校验失败：${entry.targetPath}`
          );
        }
        entry.published = true;
        persistJournal(runtime, journal);
        callCheckpoint(runtime, 'publish:after-publish', {
          taskId: journal.taskId,
          index,
          targetPath: entry.targetPath
        });
      }

      callCheckpoint(runtime, 'publish:before-final-target-verify', {
        taskId: journal.taskId
      });
      // 单项 hardlink 发布后校验只能覆盖该时刻；多输出后续发布期间，先前目标仍可能
      // 被外部改写。committed 前必须重新对整批 target 做 size + SHA-256 复核。
      assertAllPublishedTargetsMatch(runtime, journal.entries);

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
