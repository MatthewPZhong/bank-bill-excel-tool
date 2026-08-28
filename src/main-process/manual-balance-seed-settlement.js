'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const {
  getBalanceSeedFilePath,
  serializeBalanceSeedRecords
} = require('../backend/balance-seed-store');
const {
  canonicalSha256
} = require('./background-execution/canonical-json-v1');
const {
  transitionRequestKey
} = require('./background-execution/recovery-control-contract');
const {
  fsyncDirectory,
  DurabilityBarrierError
} = require('./background-execution/durable-file');
const {
  normalizeRecoverySource
} = require('./background-execution/recovery-source');

const MANUAL_BALANCE_ACTION_KEY = 'statement:resolve-manual-balance';
const MANUAL_BALANCE_TASK_KEY = 'file:save-balance-seed';
const MANUAL_BALANCE_INSPECTOR_KEY = 'inspector.statement:resolve-manual-balance';
const MANUAL_BALANCE_SETTLEMENT_KEY = 'settlement.statement:resolve-manual-balance';
const MANUAL_BALANCE_SOURCE_KIND = 'target-post-image';
const MANUAL_BALANCE_MAX_ORDINAL = 1_000_000;

class ManualBalanceSeedSettlementError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ManualBalanceSeedSettlementError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ManualBalanceSeedSettlementError(code, message, details);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetSnapshot(targetPath, options = {}) {
  const fileSystem = options.fs || fs;
  let bytes;
  try {
    bytes = fileSystem.readFileSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({ exists: false, size: 0, sha256: null });
    }
    throw error;
  }
  return Object.freeze({ exists: true, size: bytes.length, sha256: sha256(bytes) });
}

function snapshotForBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return Object.freeze({ exists: true, size: buffer.length, sha256: sha256(buffer) });
}

function snapshotsEqual(left, right) {
  return Boolean(left && right) && left.exists === right.exists && left.size === right.size &&
    left.sha256 === right.sha256;
}

function ensureTargetDirectoryEntryDurable(directory, options = {}) {
  const fileSystem = options.fs || fs;
  const syncDirectory = options.fsyncDirectory || fsyncDirectory;
  if (fileSystem.existsSync(directory)) {
    return Object.freeze({ created: false, parentFsyncs: Object.freeze([]) });
  }
  const missingDirectories = [];
  let cursor = directory;
  while (!fileSystem.existsSync(cursor)) {
    missingDirectories.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      fail('MANUAL_BALANCE_TARGET_DIRECTORY_INVALID', '余额种子目录没有可用的已存在祖先');
    }
    cursor = parent;
  }
  fileSystem.mkdirSync(directory, { recursive: true });
  const parentFsyncs = [];
  for (const createdDirectory of missingDirectories.reverse()) {
    const result = syncDirectory(path.dirname(createdDirectory), {
      fs: fileSystem,
      platform: options.platform
    });
    parentFsyncs.push(Object.freeze({ directory: createdDirectory, result }));
    if (!result || result.capability !== 'supported') break;
  }
  return Object.freeze({ created: true, parentFsyncs: Object.freeze(parentFsyncs) });
}

function createManualBalanceTargetAlias(bankName) {
  if (typeof bankName !== 'string' || !bankName.trim()) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子银行别名不能为空');
  }
  const normalized = bankName.trim();
  const canonicalTargetName = path.basename(
    getBalanceSeedFilePath('', normalized),
    '.json'
  );
  return `balance-seed:${Buffer.from(canonicalTargetName, 'utf8').toString('base64url')}`;
}

function resolveManualBalanceTargetAlias(storageRoot, targetAliasKey) {
  const prefix = 'balance-seed:';
  if (typeof targetAliasKey !== 'string' || !targetAliasKey.startsWith(prefix)) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名非法');
  }
  let canonicalTargetName;
  try {
    canonicalTargetName = Buffer.from(
      targetAliasKey.slice(prefix.length),
      'base64url'
    ).toString('utf8');
  } catch (_error) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名无法解析');
  }
  if (!canonicalTargetName ||
      createManualBalanceTargetAlias(canonicalTargetName) !== targetAliasKey) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名不规范');
  }
  return getBalanceSeedFilePath(storageRoot, canonicalTargetName);
}

function createManualBalanceOperationIdentity(taskRunId, interactionOrdinal) {
  if (typeof taskRunId !== 'string' || !taskRunId.trim() || taskRunId !== taskRunId.trim() ||
      !Number.isSafeInteger(interactionOrdinal) ||
      interactionOrdinal < 1 || interactionOrdinal > MANUAL_BALANCE_MAX_ORDINAL) {
    fail('MANUAL_BALANCE_OPERATION_IDENTITY_INVALID', 'manual balance operation identity 非法');
  }
  return Object.freeze({
    interactionOrdinal,
    operationKey: `${taskRunId}/${MANUAL_BALANCE_ACTION_KEY}/${interactionOrdinal}`
  });
}

function createManualBalanceInteractionOrdinalAllocator(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('manual balance ordinal allocator 需要 DatabaseSync');
  }
  return Object.freeze({
    allocate({ taskRunId, tokenIdHash }) {
      if (typeof taskRunId !== 'string' || !taskRunId.trim() || taskRunId !== taskRunId.trim() ||
          typeof tokenIdHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenIdHash)) {
        fail('MANUAL_BALANCE_ORDINAL_INPUT_INVALID', 'manual balance ordinal identity 非法');
      }
      const normalizedTaskRunId = taskRunId;
      const normalizedTokenHash = tokenIdHash;
      if (db.isTransaction === true) {
        fail('MANUAL_BALANCE_ORDINAL_TRANSACTION_INVALID', 'ordinal allocator 不得嵌套事务');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare(`
          SELECT metadata_json
          FROM archive_task_runs
          WHERE task_run_id = ?
        `).get(normalizedTaskRunId);
        if (!row) fail('MANUAL_BALANCE_TASK_NOT_FOUND', 'manual balance TaskRun 不存在');
        let metadata;
        try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_error) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance TaskRun metadata 非法');
        }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance TaskRun metadata 必须是对象');
        }
        const current = metadata.statementManualBalanceCurrent;
        if (current !== undefined && (!current || typeof current !== 'object' ||
            Array.isArray(current) || !/^[a-f0-9]{64}$/.test(current.tokenIdHash) ||
            !Number.isSafeInteger(current.interactionOrdinal) || current.interactionOrdinal < 1 ||
            current.interactionOrdinal > MANUAL_BALANCE_MAX_ORDINAL)) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance current ordinal metadata 非法');
        }
        if (current && current.tokenIdHash === normalizedTokenHash) {
          db.exec('COMMIT');
          return createManualBalanceOperationIdentity(
            normalizedTaskRunId,
            current.interactionOrdinal
          );
        }
        const last = metadata.statementManualBalanceOrdinal === undefined
          ? 0
          : metadata.statementManualBalanceOrdinal;
        if (!Number.isSafeInteger(last) || last < 0 || last > MANUAL_BALANCE_MAX_ORDINAL) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance last ordinal metadata 非法');
        }
        const next = last + 1;
        if (!Number.isSafeInteger(next) || next > MANUAL_BALANCE_MAX_ORDINAL) {
          fail('MANUAL_BALANCE_ORDINAL_EXHAUSTED', 'manual balance interactionOrdinal 已耗尽');
        }
        const nextMetadata = {
          ...metadata,
          statementManualBalanceOrdinal: next,
          statementManualBalanceCurrent: {
            tokenIdHash: normalizedTokenHash,
            interactionOrdinal: next
          }
        };
        const updated = db.prepare(`
          UPDATE archive_task_runs
          SET metadata_json = ?, updated_at = ?
          WHERE task_run_id = ?
        `).run(JSON.stringify(nextMetadata), new Date().toISOString(), normalizedTaskRunId);
        if (Number(updated.changes) !== 1) {
          fail('MANUAL_BALANCE_ORDINAL_CAS_CONFLICT', 'manual balance ordinal CAS 失败');
        }
        db.exec('COMMIT');
        return createManualBalanceOperationIdentity(normalizedTaskRunId, next);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 保留原错误。 */ }
        throw error;
      }
    }
  });
}

function writeManualBalanceTargetPostImage(targetPath, bytes, expectedPre, options = {}) {
  const fileSystem = options.fs || fs;
  const syncDirectory = options.fsyncDirectory || fsyncDirectory;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const directory = path.dirname(targetPath);
  const tempPath = options.tempPath || path.join(
    directory,
    `.${path.basename(targetPath)}.manual-balance-${process.pid}-${randomUUID()}.tmp`
  );
  let fd;
  let renamed = false;
  try {
    const directoryEntry = ensureTargetDirectoryEntryDurable(directory, {
      fs: fileSystem,
      fsyncDirectory: syncDirectory,
      platform: options.platform
    });
    const unsupportedEntry = directoryEntry.parentFsyncs.find(
      (item) => !item.result || item.result.capability !== 'supported'
    );
    if (unsupportedEntry) {
      return Object.freeze({
        status: 'durability-unavailable',
        targetPath,
        renamed: false,
        directoryFsync: unsupportedEntry.result || {
          capability: 'unsupported',
          errorCode: 'UNKNOWN'
        }
      });
    }
    const actualPre = targetSnapshot(targetPath, { fs: fileSystem });
    if (!snapshotsEqual(actualPre, expectedPre)) {
      fail('MANUAL_BALANCE_PREIMAGE_STALE', '余额种子 pre-image 已变化');
    }
    fd = fileSystem.openSync(tempPath, 'wx', 0o600);
    fileSystem.writeFileSync(fd, buffer);
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;
    if (typeof options.beforeRename === 'function') options.beforeRename({ targetPath, tempPath });
    fileSystem.renameSync(tempPath, targetPath);
    renamed = true;
    if (typeof options.afterRename === 'function') options.afterRename({ targetPath, tempPath });
    const directoryFsync = syncDirectory(directory, {
      fs: fileSystem,
      platform: options.platform
    });
    if (!directoryFsync || directoryFsync.capability !== 'supported') {
      return Object.freeze({
        status: 'durability-unavailable',
        targetPath,
        renamed: true,
        directoryFsync: directoryFsync || { capability: 'unsupported', errorCode: 'UNKNOWN' }
      });
    }
    if (typeof options.afterDirectoryFsync === 'function') {
      options.afterDirectoryFsync({ targetPath, tempPath });
    }
    return Object.freeze({
      status: 'durable-post-image',
      targetPath,
      renamed: true,
      directoryFsync
    });
  } catch (error) {
    if (error instanceof ManualBalanceSeedSettlementError ||
        error instanceof DurabilityBarrierError || error && error.simulatedCrash === true) {
      if (error && typeof error === 'object') error.manualBalanceRenamed = renamed;
      throw error;
    }
    throw new ManualBalanceSeedSettlementError(
      'MANUAL_BALANCE_ATOMIC_REPLACE_FAILED',
      '余额种子 temp write/fsync/atomic rename 失败',
      { stage: renamed ? 'after-rename' : 'before-rename', errorCode: error && error.code || 'UNKNOWN' }
    );
  } finally {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch (_closeError) { /* 原错误优先。 */ }
    }
    try {
      if (fileSystem.existsSync(tempPath)) fileSystem.unlinkSync(tempPath);
    } catch (_cleanupError) { /* temp 残留不覆盖原始结论。 */ }
  }
}

function sourceForIntent(identity, intentId, boundedEvidence) {
  return normalizeRecoverySource({
    contractVersion: 1,
    sourceKind: MANUAL_BALANCE_SOURCE_KIND,
    sourceRef: `${MANUAL_BALANCE_SOURCE_KIND}:${intentId}`,
    actionKey: MANUAL_BALANCE_ACTION_KEY,
    operationKey: identity.operationKey,
    taskRunId: identity.taskRunId,
    conflictScopeKey: identity.conflictScopeKey,
    inspectorKey: MANUAL_BALANCE_INSPECTOR_KEY,
    settlementKey: MANUAL_BALANCE_SETTLEMENT_KEY,
    intentId,
    evidenceVersion: 1,
    boundedEvidence
  });
}

function createManualBalanceSeedInspector(options = {}) {
  if (typeof options.resolveTargetPath !== 'function') {
    throw new TypeError('manual balance Inspector 需要 resolveTargetPath');
  }
  return async function inspectManualBalanceSeed(sourceInput) {
    const source = normalizeRecoverySource(sourceInput);
    if (source.sourceKind !== MANUAL_BALANCE_SOURCE_KIND ||
        source.actionKey !== MANUAL_BALANCE_ACTION_KEY ||
        source.inspectorKey !== MANUAL_BALANCE_INSPECTOR_KEY) {
      fail('MANUAL_BALANCE_INSPECTOR_SOURCE_INVALID', 'manual balance Inspector source 不匹配');
    }
    const targetPath = options.resolveTargetPath(source.boundedEvidence.targetAliasKey, source);
    const actual = targetSnapshot(targetPath, { fs: options.fs || fs });
    const pre = source.boundedEvidence.pre;
    const post = source.boundedEvidence.expectedPost;
    const matchesPost = snapshotsEqual(actual, post);
    const matchesPre = snapshotsEqual(actual, pre);
    const outcome = matchesPost ? 'committed' : matchesPre ? 'not-committed' : 'unknown';
    const boundedEvidence = {
      targetAliasKey: source.boundedEvidence.targetAliasKey,
      targetExists: actual.exists,
      targetSize: actual.size,
      targetSha256: actual.sha256,
      matchesExpectedPost: matchesPost,
      matchesExpectedPre: matchesPre
    };
    return Object.freeze({
      contractVersion: 1,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      outcome,
      evidenceVersion: 1,
      evidenceHash: canonicalSha256(boundedEvidence),
      boundedEvidence
    });
  };
}

function createRecoveryTransitionWriter(options = {}) {
  const owner = options.requestOwnerRepository;
  const repository = options.recoveryControlRepository;
  if (!owner || typeof owner.reserveTransitionRequest !== 'function' ||
      !repository || typeof repository.runInControlTransaction !== 'function') {
    throw new TypeError('manual balance transition writer 需要 canonical recovery repositories');
  }
  return Object.freeze({
    write(transition, safePayload = {}) {
      const reserved = owner.reserveTransitionRequest({
        requestKey: transitionRequestKey(transition),
        transition,
        safePayload
      });
      return repository.runInControlTransaction(
        (tx) => tx.transitionWithRecoveryEvent(reserved)
      );
    }
  });
}

function validateSettlementIdentity(input) {
  const taskRunId = input.taskRunId;
  const operationKey = input.operationKey;
  const jobId = input.jobId;
  const targetAliasKey = input.targetAliasKey;
  const tokenIdHash = input.tokenIdHash;
  const sessionRevision = input.sessionRevision;
  const interactionOrdinal = input.interactionOrdinal;
  const expected = createManualBalanceOperationIdentity(taskRunId, interactionOrdinal);
  if (typeof operationKey !== 'string' || operationKey !== operationKey.trim() ||
      operationKey !== expected.operationKey || typeof jobId !== 'string' || !jobId.trim() ||
      jobId !== jobId.trim() || typeof targetAliasKey !== 'string' || !targetAliasKey.trim() ||
      targetAliasKey !== targetAliasKey.trim() || typeof tokenIdHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(tokenIdHash) ||
      !Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
    fail('MANUAL_BALANCE_SETTLEMENT_IDENTITY_INVALID', 'manual balance settlement identity 非法');
  }
  return Object.freeze({
    taskRunId,
    operationKey,
    jobId,
    targetAliasKey,
    tokenIdHash,
    sessionRevision,
    interactionOrdinal,
    conflictScopeKey: `statement:manual-balance:${canonicalSha256(targetAliasKey)}`
  });
}

function intentIdForOperation(operationKey) {
  return `intent:manual-balance:${canonicalSha256(operationKey)}`;
}

function createMainSettlementIntentCoordinator(options = {}) {
  if (!options.transitionWriter || typeof options.transitionWriter.write !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 transitionWriter');
  }
  if (typeof options.resolveTargetPath !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 resolveTargetPath');
  }
  const inspect = options.inspect || createManualBalanceSeedInspector({
    resolveTargetPath: options.resolveTargetPath,
    fs: options.fs
  });
  const atomicWrite = options.atomicWrite || writeManualBalanceTargetPostImage;
  const transitionWriter = options.transitionWriter;

  function write(transition, safePayload) {
    return transitionWriter.write(transition, safePayload);
  }

  function hold(source, reasonCode) {
    const holdId = `hold:${canonicalSha256(`${source.sourceKind}|${source.sourceRef}`)}`;
    const safeSummary = {
      reasonCode,
      sourceKind: source.sourceKind,
      sourceRefHash: canonicalSha256(source.sourceRef),
      targetAliasKey: source.boundedEvidence.targetAliasKey
    };
    write({
      entityKind: 'recovery-hold',
      command: 'create-or-get',
      input: {
        contractVersion: 1,
        holdId,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        intentId: source.intentId,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        conflictScopeKey: source.conflictScopeKey,
        reasonCode,
        safeSummary,
        evidenceHash: canonicalSha256(safeSummary)
      }
    }, { reasonCode });
    return holdId;
  }

  function recoverAndClose(intentId, inspection, expectedState = 'acked') {
    write({
      entityKind: 'critical-intent',
      command: 'mark-recovered',
      intentId,
      expectedState,
      inspection
    }, { outcome: inspection.outcome });
    write({
      entityKind: 'critical-intent',
      command: 'close',
      intentId,
      expectedState: 'recovered',
      result: { outcome: inspection.outcome }
    }, { outcome: inspection.outcome, closed: true });
  }

  async function inspectOrHold(source) {
    try {
      return await inspect(source);
    } catch (error) {
      const holdId = hold(source, 'MANUAL_BALANCE_POST_IMAGE_UNKNOWN');
      if (error && typeof error === 'object') {
        error.intentId = source.intentId;
        error.holdId = holdId;
        error.settlementOutcome = 'unknown';
      }
      throw error;
    }
  }

  return Object.freeze({
    async settle(input) {
      const identity = validateSettlementIdentity(input);
      if (typeof options.assertNoHold === 'function') {
        options.assertNoHold({ conflictScopeKey: identity.conflictScopeKey });
      }
      const targetPath = options.resolveTargetPath(identity.targetAliasKey);
      const expectedPostBytes = Buffer.from(serializeBalanceSeedRecords(input.records), 'utf8');
      const pre = targetSnapshot(targetPath, { fs: options.fs || fs });
      const expectedPost = snapshotForBytes(expectedPostBytes);
      if (snapshotsEqual(pre, expectedPost)) {
        return Object.freeze({
          status: 'noop',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId: null
        });
      }

      const intentId = intentIdForOperation(identity.operationKey);
      const boundedEvidence = {
        targetAliasKey: identity.targetAliasKey,
        pre,
        expectedPost,
        sessionRevision: identity.sessionRevision,
        tokenIdHash: identity.tokenIdHash,
        interactionOrdinal: identity.interactionOrdinal
      };
      if (typeof input.preCommitCheck === 'function') {
        input.preCommitCheck({
          operationKey: identity.operationKey,
          targetAliasKey: identity.targetAliasKey,
          pre,
          expectedPost
        });
      }
      const source = sourceForIntent(identity, intentId, boundedEvidence);
      const intentInput = {
        contractVersion: 1,
        intentId,
        actionKey: MANUAL_BALANCE_ACTION_KEY,
        operationKey: identity.operationKey,
        taskRunId: identity.taskRunId,
        jobId: identity.jobId,
        coordinationKind: 'main-owned-settlement',
        conflictScopeKey: identity.conflictScopeKey,
        inspectorKey: MANUAL_BALANCE_INSPECTOR_KEY,
        evidenceVersion: 1,
        evidenceHash: canonicalSha256(boundedEvidence),
        boundedEvidence
      };
      write({ entityKind: 'critical-intent', command: 'create-prepared', input: intentInput }, {
        state: 'prepared',
        targetAliasKey: identity.targetAliasKey
      });
      write({
        entityKind: 'critical-intent',
        command: 'mark-acked',
        intentId,
        expectedState: 'prepared',
        patch: { admission: 'main-owned-settlement' }
      }, { state: 'acked' });

      let writeResult;
      try {
        writeResult = atomicWrite(targetPath, expectedPostBytes, pre, {
          fs: options.fs,
          fsyncDirectory: options.fsyncDirectory,
          platform: options.platform,
          ...(input.faultHooks || {})
        });
      } catch (error) {
        if (error && error.simulatedCrash === true) throw error;
        const inspection = await inspectOrHold(source);
        const durabilityFailure = error && error.code === 'DURABILITY_DIRECTORY_FSYNC_FAILED';
        const durabilityUnprovenPost = durabilityFailure && error.manualBalanceRenamed === true;
        if (inspection.outcome === 'not-committed') {
          recoverAndClose(intentId, inspection);
        } else {
          hold(source, durabilityUnprovenPost
            ? 'DURABILITY_BARRIER_UNAVAILABLE'
            : 'MANUAL_BALANCE_POST_IMAGE_UNKNOWN');
        }
        error.inspectionOutcome = inspection.outcome;
        error.settlementOutcome = durabilityUnprovenPost ? 'unknown' : inspection.outcome;
        error.intentId = intentId;
        throw error;
      }

      if (writeResult.status !== 'durable-post-image') {
        const holdId = hold(source, 'DURABILITY_BARRIER_UNAVAILABLE');
        return Object.freeze({
          status: 'terminal-failure',
          errorCode: 'DURABILITY_BARRIER_UNAVAILABLE',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId,
          holdId
        });
      }

      const inspection = await inspectOrHold(source);
      if (inspection.outcome === 'committed') {
        write({
          entityKind: 'critical-intent',
          command: 'mark-committed',
          intentId,
          expectedState: 'acked',
          receiptRef: { inspectionEvidenceHash: inspection.evidenceHash }
        }, { outcome: 'committed' });
        write({
          entityKind: 'critical-intent',
          command: 'close',
          intentId,
          expectedState: 'committed',
          result: { outcome: 'completed', sessionReimportRequired: false }
        }, { outcome: 'committed', closed: true });
        return Object.freeze({
          status: 'committed',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId,
          inspection
        });
      }
      if (inspection.outcome === 'not-committed') {
        recoverAndClose(intentId, inspection);
        return Object.freeze({
          status: 'not-committed',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId,
          inspection
        });
      }
      const holdId = hold(source, 'MANUAL_BALANCE_POST_IMAGE_UNKNOWN');
      return Object.freeze({
        status: 'unknown',
        operationKey: identity.operationKey,
        interactionOrdinal: identity.interactionOrdinal,
        targetAliasKey: identity.targetAliasKey,
        intentId,
        holdId,
        inspection
      });
    }
  });
}

function createManualBalanceSettlementRecoveryProvider() {
  return Object.freeze({
    async listOpenSources() {
      // Open target-post-image sources are enumerated from Main-owned intents.
      return Object.freeze([]);
    },
    async recover(sourceInput, inspection) {
      const source = normalizeRecoverySource(sourceInput);
      if (source.actionKey !== MANUAL_BALANCE_ACTION_KEY ||
          source.settlementKey !== MANUAL_BALANCE_SETTLEMENT_KEY) {
        fail('MANUAL_BALANCE_RECOVERY_SOURCE_INVALID', 'manual balance recovery source 不匹配');
      }
      const completed = inspection.outcome === 'committed';
      const boundedResult = completed
        ? { seedCommitted: true, sessionReimportRequired: true }
        : { seedCommitted: false, disposition: 'kept-open' };
      return Object.freeze({
        contractVersion: 1,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        settlementKey: source.settlementKey,
        inspectionEvidenceHash: inspection.evidenceHash,
        outcome: completed ? 'completed' : 'incomplete',
        resultVersion: 1,
        resultHash: canonicalSha256(boundedResult),
        boundedResult,
        safeError: null,
        retryAfterMs: null
      });
    }
  });
}

function manualBalanceRecoveryPolicy() {
  // Startup Coordinator 仅需要从既有静态key解析 settlement provider；这里不是
  // production execution policy，也不得复制/覆盖 canonical false/legacy/0 authority。
  return Object.freeze({
    actionKey: MANUAL_BALANCE_ACTION_KEY,
    commit: Object.freeze({
      kind: 'main-settlement',
      criticalIntent: true,
      receiptKind: MANUAL_BALANCE_SOURCE_KIND,
      inspectorKey: MANUAL_BALANCE_INSPECTOR_KEY,
      settlementKey: MANUAL_BALANCE_SETTLEMENT_KEY
    })
  });
}

module.exports = {
  MANUAL_BALANCE_ACTION_KEY,
  MANUAL_BALANCE_INSPECTOR_KEY,
  MANUAL_BALANCE_SETTLEMENT_KEY,
  MANUAL_BALANCE_SOURCE_KIND,
  MANUAL_BALANCE_TASK_KEY,
  ManualBalanceSeedSettlementError,
  createMainSettlementIntentCoordinator,
  createManualBalanceInteractionOrdinalAllocator,
  createManualBalanceOperationIdentity,
  createManualBalanceSeedInspector,
  createManualBalanceSettlementRecoveryProvider,
  createManualBalanceTargetAlias,
  createRecoveryTransitionWriter,
  manualBalanceRecoveryPolicy,
  resolveManualBalanceTargetAlias,
  snapshotForBytes,
  snapshotsEqual,
  targetSnapshot,
  writeManualBalanceTargetPostImage
};
