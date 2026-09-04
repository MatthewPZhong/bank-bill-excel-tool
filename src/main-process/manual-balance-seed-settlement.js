'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const {
  getBalanceSeedFilePath,
  readBalanceSeedRecords,
  serializeBalanceSeedRecords
} = require('../backend/balance-seed-store');
const {
  balanceSeedRecordsEvidence,
  materializeManualBalanceSeedPlan
} = require('./manual-balance-seed-preflight');
const {
  canonicalSha256
} = require('./background-execution/canonical-json-v1');
const {
  observationRequestKey,
  observationScopeKey,
  transitionRequestKey
} = require('./background-execution/recovery-control-contract');
const {
  fsyncDirectory,
  DurabilityBarrierError
} = require('./background-execution/durable-file');
const {
  normalizeRecoverySource
} = require('./background-execution/recovery-source');
const {
  createRecoveryHoldRequest,
  inspectionObservationSafePayload,
  recoveryHoldReasonForInspection
} = require('./background-execution/recovery-hold-request');
const {
  targetPathAliasKey
} = require('./toolbox-target-identity');

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
  const cleanupCreatedDirectories = () => {
    let complete = true;
    for (const createdDirectory of missingDirectories) {
      try {
        fileSystem.rmdirSync(createdDirectory);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') complete = false;
      }
    }
    return complete;
  };
  const parentFsyncs = [];
  try {
    for (const createdDirectory of [...missingDirectories].reverse()) {
      const result = syncDirectory(path.dirname(createdDirectory), {
        fs: fileSystem,
        platform: options.platform
      });
      parentFsyncs.push(Object.freeze({ directory: createdDirectory, result }));
      if (!result || result.capability !== 'supported') {
        return Object.freeze({
          created: true,
          createdDirectories: Object.freeze([...missingDirectories]),
          parentFsyncs: Object.freeze(parentFsyncs),
          cleanupComplete: cleanupCreatedDirectories()
        });
      }
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      error.manualBalanceParentEntryCleanupComplete = cleanupCreatedDirectories();
    }
    throw error;
  }
  return Object.freeze({
    created: true,
    createdDirectories: Object.freeze([...missingDirectories]),
    parentFsyncs: Object.freeze(parentFsyncs),
    cleanupComplete: null
  });
}

function createManualBalanceTargetAlias(bankName) {
  if (typeof bankName !== 'string' || !bankName.trim()) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子银行别名不能为空');
  }
  const normalized = bankName.trim();
  const legacyTargetName = path.basename(getBalanceSeedFilePath('', normalized), '.json');
  return `balance-seed:${Buffer.from(legacyTargetName, 'utf8').toString('base64url')}`;
}

function resolveManualBalanceTargetAlias(storageRoot, targetAliasKey, options = {}) {
  const prefix = 'balance-seed:';
  if (typeof targetAliasKey !== 'string' || !targetAliasKey.startsWith(prefix)) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名非法');
  }
  let legacyTargetName;
  try {
    legacyTargetName = Buffer.from(
      targetAliasKey.slice(prefix.length),
      'base64url'
    ).toString('utf8');
  } catch (_error) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名无法解析');
  }
  if (!legacyTargetName ||
      createManualBalanceTargetAlias(legacyTargetName, options) !== targetAliasKey) {
    fail('MANUAL_BALANCE_TARGET_ALIAS_INVALID', '余额种子目标别名不规范');
  }
  return getBalanceSeedFilePath(storageRoot, legacyTargetName);
}

function manualBalanceConflictScopeKey(targetPath, options = {}) {
  const targetIdentity = targetPathAliasKey(options.fs || fs, targetPath, {
    platform: options.platform,
    allowMissingParentLexicalFallback: true
  });
  return `statement:manual-balance:${canonicalSha256(targetIdentity)}`;
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
        const hasLast = Object.hasOwn(metadata, 'statementManualBalanceOrdinal');
        const hasCurrent = Object.hasOwn(metadata, 'statementManualBalanceCurrent');
        const hasHistory = Object.hasOwn(metadata, 'statementManualBalanceOrdinalHistory');
        if ((hasLast || hasCurrent || hasHistory) && !(hasLast && hasCurrent && hasHistory)) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance ordinal metadata 必须完整持久化');
        }
        const last = hasLast ? metadata.statementManualBalanceOrdinal : 0;
        const current = hasCurrent ? metadata.statementManualBalanceCurrent : null;
        const history = hasHistory ? metadata.statementManualBalanceOrdinalHistory : [];
        if (!Number.isSafeInteger(last) || last < 0 || last > MANUAL_BALANCE_MAX_ORDINAL ||
            !Array.isArray(history) || history.length !== last ||
            (last === 0 ? current !== null : !current || typeof current !== 'object' ||
              Array.isArray(current))) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance ordinal metadata 形状非法');
        }
        const tokenHashes = new Set();
        for (let index = 0; index < history.length; index += 1) {
          const item = history[index];
          if (!item || typeof item !== 'object' || Array.isArray(item) ||
              Object.keys(item).length !== 2 || !Object.hasOwn(item, 'tokenIdHash') ||
              !Object.hasOwn(item, 'interactionOrdinal') ||
              !/^[a-f0-9]{64}$/.test(item.tokenIdHash) ||
              item.interactionOrdinal !== index + 1 || tokenHashes.has(item.tokenIdHash)) {
            fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance ordinal history 非法');
          }
          tokenHashes.add(item.tokenIdHash);
        }
        if (last > 0 && (Object.keys(current).length !== 2 ||
            current.tokenIdHash !== history[last - 1].tokenIdHash ||
            current.interactionOrdinal !== last)) {
          fail('MANUAL_BALANCE_TASK_METADATA_INVALID', 'manual balance current/history 不一致');
        }
        const historical = history.find((item) => item.tokenIdHash === normalizedTokenHash);
        if (historical) {
          if (historical.interactionOrdinal !== last) {
            fail('MANUAL_BALANCE_TOKEN_STALE', '旧 manual balance token 不得在新 prompt 后恢复');
          }
          db.exec('COMMIT');
          return createManualBalanceOperationIdentity(
            normalizedTaskRunId,
            historical.interactionOrdinal
          );
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
          },
          statementManualBalanceOrdinalHistory: [
            ...history,
            { tokenIdHash: normalizedTokenHash, interactionOrdinal: next }
          ]
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
        durabilityStage: 'parent-directory-entry',
        cleanupComplete: directoryEntry.cleanupComplete === true,
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
        durabilityStage: 'target-directory-entry',
        cleanupComplete: null,
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
      durabilityStage: 'complete',
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

function hasPersistedDurabilityCompletion(source, readRepository) {
  if (!readRepository || typeof readRepository.listRecoveryEvents !== 'function') return false;
  let cursor = 0;
  for (let page = 0; page < 20; page += 1) {
    const events = readRepository.listRecoveryEvents(source.taskRunId, cursor, 500);
    for (const event of events) {
      if (event.sourceKind === source.sourceKind && event.sourceRef === source.sourceRef &&
          event.intentId === source.intentId && event.eventType === 'inspection-completed' &&
          event.safePayload && event.safePayload.durabilityBarrierCompleted === true) {
        return true;
      }
    }
    if (events.length < 500) return false;
    cursor = events[events.length - 1].sequenceId;
  }
  fail('MANUAL_BALANCE_INSPECTION_HISTORY_BOUNDED', 'manual balance observation history 超出有界扫描范围');
}

function createManualBalanceSeedInspector(options = {}) {
  if (typeof options.resolveTargetPath !== 'function') {
    throw new TypeError('manual balance Inspector 需要 resolveTargetPath');
  }
  return async function inspectManualBalanceSeed(sourceInput, context = {}) {
    const source = normalizeRecoverySource(sourceInput);
    if (source.sourceKind !== MANUAL_BALANCE_SOURCE_KIND ||
        source.actionKey !== MANUAL_BALANCE_ACTION_KEY ||
        source.inspectorKey !== MANUAL_BALANCE_INSPECTOR_KEY) {
      fail('MANUAL_BALANCE_INSPECTOR_SOURCE_INVALID', 'manual balance Inspector source 不匹配');
    }
    if (source.boundedEvidence.durabilityBarrierRequired !== true) {
      fail('MANUAL_BALANCE_INSPECTOR_EVIDENCE_INVALID', 'manual balance Inspector 缺少durability barrier contract');
    }
    const targetPath = options.resolveTargetPath(source.boundedEvidence.targetAliasKey, source);
    const actual = targetSnapshot(targetPath, { fs: options.fs || fs });
    const pre = source.boundedEvidence.pre;
    const post = source.boundedEvidence.expectedPost;
    const matchesPost = snapshotsEqual(actual, post);
    const matchesPre = snapshotsEqual(actual, pre);
    const activeHold = options.readRepository &&
      typeof options.readRepository.getActiveRecoveryHoldByScope === 'function'
      ? options.readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey)
      : null;
    const durabilityBlocked = context.forceDurabilityIncomplete === true || Boolean(
      activeHold && activeHold.sourceKind === source.sourceKind &&
      activeHold.sourceRef === source.sourceRef &&
      activeHold.reasonCode === 'DURABILITY_BARRIER_UNAVAILABLE'
    );
    const durabilityBarrierCompleted = !durabilityBlocked && (
      context.durabilityBarrierCompleted === true ||
      hasPersistedDurabilityCompletion(source, options.readRepository)
    );
    const outcome = durabilityBlocked
      ? 'unknown'
      : matchesPost
        ? (durabilityBarrierCompleted ? 'committed' : 'unknown')
        : matchesPre ? 'not-committed' : 'unknown';
    const boundedEvidence = {
      targetAliasKey: source.boundedEvidence.targetAliasKey,
      targetExists: actual.exists,
      targetSize: actual.size,
      targetSha256: actual.sha256,
      matchesExpectedPost: matchesPost,
      matchesExpectedPre: matchesPre,
      durabilityBarrierCompleted
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
  const attempts = options.observationAttemptRepository || null;
  const reserveTransition = (transition, safePayload) => owner.reserveTransitionRequest({
    requestKey: transitionRequestKey(transition),
    transition,
    safePayload
  });
  const writeObservation = ({
    source: sourceInput,
    eventType,
    safePayload,
    transitions,
    holdId = null
  }) => {
    if (!attempts || typeof attempts.allocateNextObservationAttempt !== 'function' ||
        typeof attempts.resumePreparedObservationAttempt !== 'function') {
      throw new TypeError('manual balance canonical observation 需要 observationAttemptRepository');
    }
    const source = normalizeRecoverySource(sourceInput);
    if (!Array.isArray(transitions)) throw new TypeError('inspection transitions 必须是数组');
    const scope = {
      eventType,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      batchId: null,
      intentId: source.intentId,
      holdId,
      recoveryAttemptId: null
    };
    const scopeKey = observationScopeKey(scope);
    const attempt = attempts.resumePreparedObservationAttempt(scopeKey) ||
      attempts.allocateNextObservationAttempt(scope);
    const draft = {
      ...scope,
      observationAttemptId: attempt.observationAttemptId,
      safePayload
    };
    const observation = owner.reserveObservationRequest({
      requestKey: observationRequestKey(draft),
      observationScopeKey: scopeKey,
      event: draft
    });
    const reservedTransitions = transitions.map((item) => {
      if (!item || typeof item !== 'object' || !item.transition) {
        throw new TypeError('inspection transition item 非法');
      }
      return reserveTransition(item.transition, item.safePayload || {});
    });
    return repository.runInControlTransaction((tx) => Object.freeze({
      observation: tx.appendObservationEvent(observation),
      transitions: Object.freeze(
        reservedTransitions.map((request) => tx.transitionWithRecoveryEvent(request))
      )
    }));
  };
  return Object.freeze({
    inspect(transition, safePayload = {}) {
      if (typeof owner.inspectTransitionRequest !== 'function') {
        throw new TypeError('canonical request owner 缺少 read-only transition inspection');
      }
      return owner.inspectTransitionRequest({
        requestKey: transitionRequestKey(transition),
        transition,
        safePayload
      });
    },
    write(transition, safePayload = {}) {
      const reserved = reserveTransition(transition, safePayload);
      return repository.runInControlTransaction(
        (tx) => tx.transitionWithRecoveryEvent(reserved)
      );
    },
    writeObservation,
    writeInspection({ source, inspection, safePayload = {}, transitions, holdId = null }) {
      return writeObservation({
        source,
        eventType: 'inspection-completed',
        safePayload: inspectionObservationSafePayload(inspection, safePayload),
        transitions,
        holdId
      });
    }
  });
}

function manualBalancePlanBinding(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      !Array.isArray(plan.records) || !plan.record || typeof plan.record !== 'object') {
    throw new TypeError('manual balance legacy plan形状非法');
  }
  const planSnapshot = Object.freeze({
    storageRoot: plan.storageRoot,
    bankName: plan.bankName,
    records: Object.freeze(plan.records.map((item) => Object.freeze({ ...item }))),
    recordsEvidence: plan.recordsEvidence,
    existingIndex: plan.existingIndex,
    record: Object.freeze({ ...plan.record })
  });
  const normalized = materializeManualBalanceSeedPlan(planSnapshot, new Date(0));
  const incoming = {
    merchantId: normalized.record.merchantId,
    currency: normalized.record.currency,
    billDate: normalized.record.billDate,
    endBalance: normalized.record.endBalance,
    templateName: normalized.record.templateName,
    generationMethod: normalized.record.generationMethod
  };
  const binding = {
    bankName: normalized.bankName,
    sourceRecordsEvidence: normalized.sourceRecordsEvidence,
    existingIndex: plan.existingIndex,
    incoming
  };
  return Object.freeze({
    binding: Object.freeze(binding),
    bindingHash: canonicalSha256(binding),
    planSnapshot
  });
}

function createManualBalanceSeedPlanFreshnessGate(options = {}) {
  if (typeof options.assertContinuationFresh !== 'function') {
    throw new TypeError('manual balance freshness gate 需要 assertContinuationFresh');
  }
  const readRecords = options.readRecords || readBalanceSeedRecords;
  if (typeof readRecords !== 'function') {
    throw new TypeError('manual balance freshness gate 需要 readRecords');
  }
  const fileSystem = options.fs || fs;
  return Object.freeze({
    async assertFresh(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          typeof input.targetPath !== 'string' ||
          typeof input.targetAliasKey !== 'string' ||
          typeof input.planBindingHash !== 'string') {
        throw new TypeError('manual balance freshness evidence 非法');
      }
      const bound = manualBalancePlanBinding(input.planSnapshot);
      const expectedAlias = createManualBalanceTargetAlias(bound.binding.bankName, {
        platform: options.platform
      });
      if (bound.bindingHash !== input.planBindingHash || expectedAlias !== input.targetAliasKey) {
        fail('MANUAL_BALANCE_PLAN_PROVENANCE_MISMATCH', 'manual balance plan provenance 不一致');
      }
      await options.assertContinuationFresh(Object.freeze({
        taskRunId: input.taskRunId,
        operationKey: input.operationKey,
        jobId: input.jobId,
        tokenIdHash: input.tokenIdHash,
        sessionRevision: input.sessionRevision,
        interactionOrdinal: input.interactionOrdinal,
        targetAliasKey: input.targetAliasKey,
        planBindingHash: input.planBindingHash
      }));

      const legacyTargetPath = getBalanceSeedFilePath(
        bound.planSnapshot.storageRoot,
        bound.binding.bankName
      );
      const targetIdentity = targetPathAliasKey(fileSystem, input.targetPath, {
        platform: options.platform,
        allowMissingParentLexicalFallback: true
      });
      const legacyIdentity = targetPathAliasKey(fileSystem, legacyTargetPath, {
        platform: options.platform,
        allowMissingParentLexicalFallback: true
      });
      if (targetIdentity !== legacyIdentity) {
        fail('MANUAL_BALANCE_PLAN_TARGET_MISMATCH', 'manual balance target 与 legacy plan 不一致');
      }

      const beforeRead = targetSnapshot(input.targetPath, { fs: fileSystem });
      const currentRecords = readRecords(
        bound.planSnapshot.storageRoot,
        bound.binding.bankName
      );
      if (!Array.isArray(currentRecords)) {
        throw new TypeError('manual balance freshness readRecords 必须同步返回数组');
      }
      const afterRead = targetSnapshot(input.targetPath, { fs: fileSystem });
      if (!snapshotsEqual(beforeRead, afterRead)) {
        fail('MANUAL_BALANCE_PREIMAGE_STALE', '余额种子在 freshness 读取期间已变化');
      }
      const recordsEvidence = balanceSeedRecordsEvidence(currentRecords);
      if (recordsEvidence !== bound.binding.sourceRecordsEvidence) {
        fail('MANUAL_BALANCE_PLAN_STALE', '余额种子 records 已偏离 legacy plan provenance');
      }
      return Object.freeze({
        targetSnapshot: afterRead,
        recordsEvidence
      });
    }
  });
}

function validateSettlementIdentity(input, options = {}) {
  const taskRunId = input.taskRunId;
  const operationKey = input.operationKey;
  const jobId = input.jobId;
  const tokenIdHash = input.tokenIdHash;
  const sessionRevision = input.sessionRevision;
  const interactionOrdinal = input.interactionOrdinal;
  const expected = createManualBalanceOperationIdentity(taskRunId, interactionOrdinal);
  if (Object.hasOwn(input, 'records') || Object.hasOwn(input, 'targetAliasKey')) {
    fail('MANUAL_BALANCE_PLAN_BINDING_REQUIRED', 'settlement不得接收独立records或target alias');
  }
  const plan = manualBalancePlanBinding(input.plan);
  const targetAliasKey = createManualBalanceTargetAlias(plan.binding.bankName, {
    platform: options.platform
  });
  const targetPath = options.resolveTargetPath(targetAliasKey);
  const legacyTargetPath = getBalanceSeedFilePath(input.plan.storageRoot, plan.binding.bankName);
  const targetIdentity = targetPathAliasKey(options.fs || fs, targetPath, {
    platform: options.platform,
    allowMissingParentLexicalFallback: true
  });
  const legacyIdentity = targetPathAliasKey(options.fs || fs, legacyTargetPath, {
    platform: options.platform,
    allowMissingParentLexicalFallback: true
  });
  if (typeof operationKey !== 'string' || operationKey !== operationKey.trim() ||
      operationKey !== expected.operationKey || typeof jobId !== 'string' || !jobId.trim() ||
      jobId !== jobId.trim() || targetIdentity !== legacyIdentity ||
      typeof tokenIdHash !== 'string' ||
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
    targetPath,
    planSnapshot: plan.planSnapshot,
    planBinding: plan.binding,
    planBindingHash: plan.bindingHash,
    conflictScopeKey: manualBalanceConflictScopeKey(targetPath, options)
  });
}

function intentIdForOperation(operationKey) {
  return `intent:manual-balance:${canonicalSha256(operationKey)}`;
}

function createMainSettlementIntentCoordinator(options = {}) {
  if (!options.transitionWriter || typeof options.transitionWriter.write !== 'function' ||
      typeof options.transitionWriter.writeInspection !== 'function' ||
      typeof options.transitionWriter.writeObservation !== 'function' ||
      typeof options.transitionWriter.inspect !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 transitionWriter');
  }
  if (typeof options.resolveTargetPath !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 resolveTargetPath');
  }
  if (!options.readRepository ||
      typeof options.readRepository.getCriticalIntentByOperation !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 canonical readRepository');
  }
  if (!options.recoveryHoldGate ||
      typeof options.recoveryHoldGate.assertNoRecoveryHold !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 canonical RecoveryHoldGate');
  }
  if (!options.preCommitGate || typeof options.preCommitGate.assertFresh !== 'function') {
    throw new TypeError('MainSettlementIntentCoordinator 需要 canonical manual balance freshness gate');
  }
  const inspect = options.inspect || createManualBalanceSeedInspector({
    resolveTargetPath: options.resolveTargetPath,
    fs: options.fs,
    readRepository: options.readRepository
  });
  const atomicWrite = options.atomicWrite || writeManualBalanceTargetPostImage;
  const transitionWriter = options.transitionWriter;
  const readRepository = options.readRepository;
  const recoveryHoldGate = options.recoveryHoldGate;
  const preCommitGate = options.preCommitGate;
  const now = options.now || (() => new Date());
  if (typeof now !== 'function') throw new TypeError('MainSettlementIntentCoordinator now 必须是函数');

  function write(transition, safePayload) {
    return transitionWriter.write(transition, safePayload);
  }

  function assertNoHold(conflictScopeKey) {
    const result = recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey });
    if (result && typeof result.then === 'function') {
      throw new TypeError('canonical RecoveryHoldGate 必须同步完成 exact scope 检查');
    }
    if (result !== true) {
      throw new TypeError('canonical RecoveryHoldGate 必须返回 true 或抛错');
    }
  }

  function recoverAndClose(intentId, inspection, expectedState = 'acked') {
    return [
      {
        transition: {
          entityKind: 'critical-intent',
          command: 'mark-recovered',
          intentId,
          expectedState,
          inspection
        },
        safePayload: { outcome: inspection.outcome }
      },
      {
        transition: {
          entityKind: 'critical-intent',
          command: 'close',
          intentId,
          expectedState: 'recovered',
          result: { outcome: inspection.outcome }
        },
        safePayload: { outcome: inspection.outcome, closed: true }
      }
    ];
  }

  function commitAndClose(intentId, inspection) {
    return [
      {
        transition: {
          entityKind: 'critical-intent',
          command: 'mark-committed',
          intentId,
          expectedState: 'acked',
          receiptRef: { inspectionEvidenceHash: inspection.evidenceHash }
        },
        safePayload: { outcome: 'committed' }
      },
      {
        transition: {
          entityKind: 'critical-intent',
          command: 'close',
          intentId,
          expectedState: 'committed',
          result: { outcome: 'completed', sessionReimportRequired: false }
        },
        safePayload: { outcome: 'committed', closed: true }
      }
    ];
  }

  function writeHeldInspection(source, inspection, reasonCode, durabilityBarrierCompleted) {
    const hold = createRecoveryHoldRequest(source, reasonCode);
    transitionWriter.writeInspection({
      source,
      inspection,
      safePayload: { durabilityBarrierCompleted },
      transitions: [{ transition: hold.transition, safePayload: hold.safePayload }],
      holdId: hold.holdId
    });
    return hold.holdId;
  }

  async function inspectOrHold(source, context = {}) {
    try {
      return await inspect(source, context);
    } catch (error) {
      const hold = createRecoveryHoldRequest(source,
        context.durabilityFailure === true || context.durabilityBarrierCompleted === true
          ? 'DURABILITY_BARRIER_UNAVAILABLE'
          : 'INSPECTION_UNKNOWN');
      transitionWriter.writeObservation({
        source,
        eventType: 'inspection-failed-transient',
        safePayload: {
          errorCode: error && error.code || 'MANUAL_BALANCE_TARGET_READ_FAILED',
          thresholdReached: true
        },
        transitions: [{ transition: hold.transition, safePayload: hold.safePayload }],
        holdId: hold.holdId
      });
      if (error && typeof error === 'object') {
        error.intentId = source.intentId;
        error.holdId = hold.holdId;
        error.settlementOutcome = 'unknown';
      }
      throw error;
    }
  }

  function assertIntentMatchesRequest(intent, identity) {
    const evidence = intent && intent.boundedEvidence;
    if (!evidence || evidence.targetAliasKey !== identity.targetAliasKey ||
        intent.jobId !== identity.jobId ||
        intent.conflictScopeKey !== identity.conflictScopeKey ||
        evidence.planBindingHash !== identity.planBindingHash ||
        evidence.sessionRevision !== identity.sessionRevision ||
        evidence.tokenIdHash !== identity.tokenIdHash ||
        evidence.interactionOrdinal !== identity.interactionOrdinal ||
        evidence.durabilityBarrierRequired !== true) {
      fail('MANUAL_BALANCE_OPERATION_CONFLICT', 'manual balance operation 已绑定不同请求');
    }
    return evidence;
  }

  function replayDecidedIntent(intent, identity) {
    const evidence = assertIntentMatchesRequest(intent, identity);
    if (intent.state !== 'closed') {
      fail('MANUAL_BALANCE_OPERATION_PENDING_RECOVERY', 'manual balance operation 尚未完成恢复');
    }
    const actual = targetSnapshot(identity.targetPath, { fs: options.fs || fs });
    if (intent.result && intent.result.outcome === 'completed') {
      if (!snapshotsEqual(actual, evidence.expectedPost)) {
        fail('MANUAL_BALANCE_REPLAY_TARGET_DRIFT', '已提交manual balance target已漂移');
      }
      return Object.freeze({
        status: 'committed',
        replayed: true,
        operationKey: identity.operationKey,
        interactionOrdinal: identity.interactionOrdinal,
        targetAliasKey: identity.targetAliasKey,
        intentId: intent.intentId
      });
    }
    if (intent.result && ['not-committed', 'compensated'].includes(intent.result.outcome)) {
      if (!snapshotsEqual(actual, evidence.pre)) {
        fail('MANUAL_BALANCE_REPLAY_TARGET_DRIFT', '已恢复manual balance pre-image已漂移');
      }
      return Object.freeze({
        status: 'not-committed',
        replayed: true,
        operationKey: identity.operationKey,
        interactionOrdinal: identity.interactionOrdinal,
        targetAliasKey: identity.targetAliasKey,
        intentId: intent.intentId
      });
    }
    fail('MANUAL_BALANCE_OPERATION_RESULT_INVALID', 'closed manual balance operation缺少稳定结果');
  }

  return Object.freeze({
    async settle(input) {
      if (Object.hasOwn(input || {}, 'preCommitCheck')) {
        fail(
          'MANUAL_BALANCE_PRECOMMIT_AUTHORITY_INVALID',
          'manual balance settlement 不接受调用方自带 preCommit authority'
        );
      }
      const identity = validateSettlementIdentity(input, {
        resolveTargetPath: options.resolveTargetPath,
        fs: options.fs,
        platform: options.platform
      });
      const existingIntent = readRepository.getCriticalIntentByOperation(
        MANUAL_BALANCE_ACTION_KEY,
        identity.operationKey,
        identity.taskRunId
      );
      if (existingIntent) return replayDecidedIntent(existingIntent, identity);

      assertNoHold(identity.conflictScopeKey);
      const freshnessEvidence = await preCommitGate.assertFresh(Object.freeze({
        taskRunId: identity.taskRunId,
        operationKey: identity.operationKey,
        jobId: identity.jobId,
        tokenIdHash: identity.tokenIdHash,
        sessionRevision: identity.sessionRevision,
        interactionOrdinal: identity.interactionOrdinal,
        targetAliasKey: identity.targetAliasKey,
        targetPath: identity.targetPath,
        planSnapshot: identity.planSnapshot,
        planBindingHash: identity.planBindingHash
      }));
      if (!freshnessEvidence ||
          freshnessEvidence.recordsEvidence !== identity.planBinding.sourceRecordsEvidence ||
          !freshnessEvidence.targetSnapshot) {
        fail(
          'MANUAL_BALANCE_FRESHNESS_EVIDENCE_INVALID',
          'manual balance freshness gate 未返回 canonical plan/target evidence'
        );
      }
      assertNoHold(identity.conflictScopeKey);
      const pre = targetSnapshot(identity.targetPath, { fs: options.fs || fs });
      if (!snapshotsEqual(pre, freshnessEvidence.targetSnapshot)) {
        fail('MANUAL_BALANCE_PREIMAGE_STALE', '余额种子在 awaited admission 后已变化');
      }

      const commitNow = now();
      const materialized = materializeManualBalanceSeedPlan(identity.planSnapshot, commitNow);
      const expectedPostBytes = Buffer.from(
        serializeBalanceSeedRecords(materialized.records),
        'utf8'
      );
      const expectedPost = snapshotForBytes(expectedPostBytes);
      const intentId = intentIdForOperation(identity.operationKey);
      const boundedEvidence = {
        targetAliasKey: identity.targetAliasKey,
        pre,
        expectedPost,
        sessionRevision: identity.sessionRevision,
        tokenIdHash: identity.tokenIdHash,
        interactionOrdinal: identity.interactionOrdinal,
        planBindingHash: identity.planBindingHash,
        commitUpdatedAt: materialized.commitUpdatedAt,
        durabilityBarrierRequired: true
      };
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
      const createPrepared = { entityKind: 'critical-intent', command: 'create-prepared', input: intentInput };
      const preparedPayload = { state: 'prepared', targetAliasKey: identity.targetAliasKey };
      const orphanedReservation = transitionWriter.inspect(createPrepared, preparedPayload);
      if (orphanedReservation) {
        fail('MANUAL_BALANCE_PREPARED_REQUEST_ORPHANED', 'manual balance prepared request缺少Intent');
      }
      if (snapshotsEqual(pre, expectedPost)) {
        return Object.freeze({
          status: 'noop',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId: null
        });
      }
      const source = sourceForIntent(identity, intentId, boundedEvidence);
      assertNoHold(identity.conflictScopeKey);
      write(createPrepared, preparedPayload);
      write({
        entityKind: 'critical-intent',
        command: 'mark-acked',
        intentId,
        expectedState: 'prepared',
        patch: { admission: 'main-owned-settlement' }
      }, { state: 'acked' });

      let writeResult;
      const writerFaultHooks = { ...(input.faultHooks || {}) };
      const afterCommitBeforeReply = writerFaultHooks.afterCommitBeforeReply;
      delete writerFaultHooks.afterCommitBeforeReply;
      try {
        writeResult = atomicWrite(identity.targetPath, expectedPostBytes, pre, {
          fs: options.fs,
          fsyncDirectory: options.fsyncDirectory,
          platform: options.platform,
          ...writerFaultHooks
        });
      } catch (error) {
        if (error && error.simulatedCrash === true) throw error;
        const durabilityFailure = error instanceof DurabilityBarrierError ||
          error && error.code === 'DURABILITY_DIRECTORY_FSYNC_FAILED';
        const inspection = await inspectOrHold(source, durabilityFailure
          ? { forceDurabilityIncomplete: true, durabilityFailure: true }
          : { durabilityBarrierCompleted: false });
        if (durabilityFailure) {
          error.holdId = writeHeldInspection(
            source,
            inspection,
            'DURABILITY_BARRIER_UNAVAILABLE',
            false
          );
        } else if (inspection.outcome === 'not-committed') {
          transitionWriter.writeInspection({
            source,
            inspection,
            safePayload: { durabilityBarrierCompleted: false },
            transitions: recoverAndClose(intentId, inspection)
          });
        } else {
          error.holdId = writeHeldInspection(
            source,
            inspection,
            recoveryHoldReasonForInspection(inspection),
            false
          );
        }
        error.inspectionOutcome = inspection.outcome;
        error.settlementOutcome = durabilityFailure ? 'unknown' : inspection.outcome;
        error.intentId = intentId;
        throw error;
      }

      if (writeResult.status !== 'durable-post-image') {
        const inspection = await inspectOrHold(source, {
          forceDurabilityIncomplete: true,
          durabilityFailure: true
        });
        const holdId = writeHeldInspection(
          source,
          inspection,
          'DURABILITY_BARRIER_UNAVAILABLE',
          false
        );
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

      const inspection = await inspectOrHold(source, { durabilityBarrierCompleted: true });
      if (inspection.outcome === 'committed') {
        transitionWriter.writeInspection({
          source,
          inspection,
          safePayload: { durabilityBarrierCompleted: true },
          transitions: commitAndClose(intentId, inspection)
        });
        if (typeof afterCommitBeforeReply === 'function') {
          afterCommitBeforeReply({ targetPath: identity.targetPath, intentId });
        }
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
        transitionWriter.writeInspection({
          source,
          inspection,
          safePayload: { durabilityBarrierCompleted: true },
          transitions: recoverAndClose(intentId, inspection)
        });
        return Object.freeze({
          status: 'not-committed',
          operationKey: identity.operationKey,
          interactionOrdinal: identity.interactionOrdinal,
          targetAliasKey: identity.targetAliasKey,
          intentId,
          inspection
        });
      }
      const holdId = writeHeldInspection(
        source,
        inspection,
        recoveryHoldReasonForInspection(inspection),
        true
      );
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

function createManualBalanceRecoveryPlanTransitions(readRepository) {
  if (!readRepository || typeof readRepository.getRecoveryHoldBySource !== 'function') {
    throw new TypeError('manual balance recovery plan需要canonical readRepository');
  }
  return function manualBalanceRecoveryPlanTransitions({ phase, source, inspection }) {
    if (!source || source.actionKey !== MANUAL_BALANCE_ACTION_KEY ||
        phase !== 'inspection-result' || !inspection ||
        !['committed', 'not-committed', 'compensated'].includes(inspection.outcome)) {
      return [];
    }
    const hold = readRepository.getRecoveryHoldBySource(source.sourceKind, source.sourceRef);
    if (!hold || hold.status !== 'active') return [];
    return [{
      transition: {
        entityKind: 'recovery-hold',
        command: 'resolve',
        holdId: hold.holdId,
        expectedState: 'active',
        resolution: inspection.outcome,
        evidence: { inspectionEvidenceHash: inspection.evidenceHash }
      },
      safePayload: { resolution: inspection.outcome }
    }];
  };
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
  createManualBalanceRecoveryPlanTransitions,
  createManualBalanceSeedPlanFreshnessGate,
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
