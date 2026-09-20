'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { freezePersistedTaskOwner } = require('../archive-center/worker-operation-context');
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const { assertStagedInputUnchanged, filterStagingPathsWithoutProtectedSources } = require('./input-staging');
const {
  POSITION_SIDE_DB_CHECKPOINT_SETTING,
  POSITION_SIDE_DB_PENDING_SETTING,
  POSITION_SIDE_DB_BOOTSTRAP_SETTING
} = require('./constants');
const {
  assertPositionRecoveryInputsUnchanged,
  positionCommittedRecoveryArchiveFiles,
  positionRecoveryCleanupInputPaths,
  requirePositionPendingArchiveFiles,
  positionRecoveryArchiveFiles,
  positionArchiveIntentEvidence: evaluatePositionArchiveIntentEvidence,
  positionBusinessStateForResult,
  positionTerminalOutcomeForResult,
  positionPersistentStagingProtectionPaths,
  positionReconciliationFailureResult,
  positionRecoveryTerminalOutcome,
  positionCancellationAcceptedPending,
  runPositionOperationLifecycle,
  settlePositionRecoveredTask
} = require('./operation-lifecycle');

const SUCCESS_STATUSES = new Set(['ok', 'success']);

function normalizePositionTerminalRoute(value) {
  const operationToken = String(value.operationToken || '').trim();
  if (!operationToken) throw new TypeError('Position terminal route.operationToken 为空');
  return { route: 'position-reconciliation', operationToken };
}

// 设置访问只由 Main 装配；领域 owner 保留原存储与 AsyncLocalStorage 语义。
function createPositionTaskOwner({
  readSetting,
  writeSetting,
  settingsAvailable,
  getDatabasePath,
  getCurrentService,
  getService,
  getArchiveCenter,
  initializeArchiveCenter,
  getTaskLifecycle,
  getTaskPolicy,
  supportsArchiveChannel
}) {
  const positionReconciliationOperationContext = new AsyncLocalStorage();
  let positionReconciliationOperationActive = null;

  function readPositionPendingOperation() {
    const raw = settingsAvailable()
      ? readSetting(POSITION_SIDE_DB_PENDING_SETTING)
      : '';
    if (!raw) return null;
    let pending;
    try {
      pending = JSON.parse(raw);
    } catch (_error) {
      throw new Error('主库中的平盘待完成操作记录损坏');
    }
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
      throw new Error('主库中的平盘待完成操作记录格式非法');
    }
    return pending;
  }

  function positionPendingOwner(pending) {
    if (pending && pending.owner) {
      return freezePersistedTaskOwner(pending.owner, { required: true });
    }
    if (pending && pending.batchContext) {
      return freezePersistedTaskOwner({
        version: 1,
        kind: 'file-batch',
        batchContext: pending.batchContext
      }, { required: true });
    }
    throw new Error('平盘 pending 缺少持久 owner');
  }

  function samePositionPendingOwner(left, right) {
    if (!left || !right || left.kind !== right.kind) return false;
    const leftContext = left.kind === 'operation'
      ? left.operationContext
      : left.batchContext;
    const rightContext = right.kind === 'operation'
      ? right.operationContext
      : right.batchContext;
    return Object.keys(leftContext).every((key) => leftContext[key] === rightContext[key]);
  }

  function writePositionPendingOperation(pending, operationToken) {
    const current = readPositionPendingOperation();
    if (!current || current.operationToken !== operationToken) {
      throw new Error('平盘待完成操作所有权已变化');
    }
    writeSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(pending));
  }

  function capturePositionArchiveFileSnapshot(filePath) {
    try {
      return sourceSnapshotFromStat(fs.statSync(filePath, { bigint: true }));
    } catch (_error) {
      return null;
    }
  }

  function recordPositionArchiveIntentFiles(filePaths, role, explicitOperationToken = '') {
    const context = positionReconciliationOperationContext.getStore();
    const operationToken = String(
      explicitOperationToken || (context && context.operationToken) || ''
    ).trim();
    if (!operationToken || !Array.isArray(filePaths) || filePaths.length === 0) return;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== operationToken || !pending.archiveRequired) {
      return;
    }
    const seen = new Set(
      (Array.isArray(pending.archiveFiles) ? pending.archiveFiles : []).map(
        (file) => `${file.role || ''}\u0000${file.filePath || ''}`
      )
    );
    const archiveFiles = Array.isArray(pending.archiveFiles)
      ? pending.archiveFiles.slice()
      : [];
    for (const value of filePaths) {
      const descriptor = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : { filePath: value };
      const rawPath = String(descriptor.filePath || '').trim();
      if (!rawPath) continue;
      const filePath = path.resolve(rawPath);
      const key = `${role}\u0000${filePath}`;
      if (seen.has(key)) continue;
      const archiveFile = role === 'input'
        ? {
            filePath,
            role,
            sourceType: String(descriptor.sourceType || '').trim(),
            sourceSnapshot: descriptor.sourceSnapshot,
            sha256: descriptor.expectedSha256 || descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
            artifactKey: String(descriptor.artifactKey || '').trim(),
            sourceOperation: String(descriptor.sourceOperation || '').trim(),
            originalName: String(descriptor.originalName || path.basename(filePath))
          }
        : {
            filePath,
            role,
            beforeSnapshot: Object.prototype.hasOwnProperty.call(descriptor, 'beforeSnapshot')
              ? descriptor.beforeSnapshot
              : capturePositionArchiveFileSnapshot(filePath),
            ...(descriptor.sourceSnapshot ? {
              sourceSnapshot: descriptor.sourceSnapshot,
              sha256: descriptor.expectedSha256 || descriptor.sha256,
              sizeBytes: descriptor.sizeBytes
            } : {}),
            artifactKey: String(descriptor.artifactKey || '').trim(),
            sourceOperation: String(descriptor.sourceOperation || '').trim(),
            originalName: String(descriptor.originalName || path.basename(filePath)),
            requiredInputPaths: descriptor.requiredInputPaths,
            metadata: descriptor.metadata && typeof descriptor.metadata === 'object'
              ? descriptor.metadata
              : {}
          };
      const normalized = requirePositionPendingArchiveFiles({
        archiveFiles: [archiveFile]
      })[0];
      seen.add(key);
      archiveFiles.push(normalized);
    }
    writePositionPendingOperation({
      ...pending,
      archiveState: archiveFiles.length > 0 ? 'intent-recorded' : pending.archiveState,
      archiveFiles
    }, operationToken);
  }

  function recordPositionFilePlanIntent(filePlan, evidence = {}) {
    const inputEvidence = evidence.inputs || [];
    const outputEvidence = evidence.outputs || [];
    recordPositionArchiveIntentFiles(filePlan.inputs.map((item, index) => ({
      ...inputEvidence[index],
      filePath: item.filePath,
      role: 'input',
      sourceSnapshot: item.sourceSnapshot,
      artifactKey: item.artifactKey,
      sourceOperation: item.sourceOperation,
      originalName: item.originalName
    })), 'input');
    recordPositionArchiveIntentFiles(filePlan.outputs.map((item, index) => ({
      ...outputEvidence[index],
      filePath: item.filePath,
      role: 'output',
      beforeSnapshot: item.targetSnapshot.exists ? item.targetSnapshot.snapshot : null,
      artifactKey: item.artifactKey,
      sourceOperation: item.sourceOperation,
      originalName: item.originalName
    })), 'output');
  }

  function markPositionBusinessOutcome(result, { terminalForCurrentTask = false } = {}) {
    const context = positionReconciliationOperationContext.getStore();
    if (!context) return;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== context.operationToken) return;
    const terminalResult = terminalForCurrentTask && result && result.archiveDeferred === true
      ? { ...result, archiveDeferred: false }
      : result;
    writePositionPendingOperation({
      ...pending,
      businessState: positionBusinessStateForResult(terminalResult, SUCCESS_STATUSES),
      terminalOutcome: positionTerminalOutcomeForResult(terminalResult, SUCCESS_STATUSES)
    }, context.operationToken);
  }

  function persistPositionCancellationAccepted(active) {
    const operationToken = String(active && active.operationToken || '').trim();
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== operationToken) {
      throw new Error('平盘取消确认时待完成操作所有权已变化');
    }
    const cancellation = positionCancellationAcceptedPending(
      pending,
      '用户取消平盘对账导入任务'
    );

    // SQLite pending 是取消 ACK 的第一份耐久真相。即使随后主进程崩溃，
    // startup recovery 也会按原 operation/file owner 收口为 cancelled，而不是 failed。
    writePositionPendingOperation(cancellation, operationToken);

    // 同时把 cancelled 终态写入既有 Archive outbox；直接 CAS 或后续业务
    // promise 尚未来得及返回时，仍能在下一次启动重放到同一 Task Run。
    const center = getArchiveCenter() || initializeArchiveCenter();
    center.persistTaskTerminalIntent({
      owner: positionPendingOwner(cancellation),
      sourceOperation: String(cancellation.channel || active.channel || 'position-reconciliation'),
      terminalOutcome: {
        ...cancellation.terminalOutcome,
        metadata: { positionCancellationAccepted: true },
        afterTerminal: {
          route: 'position-reconciliation',
          operationToken
        }
      }
    });

    return getTaskLifecycle()
      ? getTaskLifecycle().cancelActive(
          (context) => Boolean(
            context.moduleId === 'position-reconciliation-process'
            && context.taskRunId === operationToken
          ),
          cancellation.terminalOutcome.message
        )
      : null;
  }

  function markPositionArchiveDurable(archiveResult = {}) {
    const context = positionReconciliationOperationContext.getStore();
    if (!context) return;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== context.operationToken || !pending.archiveRequired) {
      return;
    }
    writePositionPendingOperation({
      ...pending,
      archiveState: 'durable',
      archiveReference: archiveResult.batchId || archiveResult.outboxId || ''
    }, context.operationToken);
  }

  function markPositionArchiveIncomplete(archiveResult = {}) {
    const context = positionReconciliationOperationContext.getStore();
    if (!context) return;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== context.operationToken || !pending.archiveRequired) {
      return;
    }
    writePositionPendingOperation({
      ...pending,
      archiveState: 'incomplete',
      archiveWarning: archiveResult && archiveResult.warning
        ? String(archiveResult.warning.message || '')
        : '存档未形成持久重试记录'
    }, context.operationToken);
  }

  function readDeletedPositionArchiveResult(pending) {
    try {
      const center = getArchiveCenter() || initializeArchiveCenter();
      const repository = center && center.service && center.service.repository;
      if (!repository) return null;
      const policy = getTaskPolicy(String(pending.channel || ''));
      const moduleId = policy && policy.scopeId;
      if (!moduleId) return null;
      const operationKey = `position:${pending.operationToken}:${pending.channel}`;
      const issuance = repository.getOperationIssuance(moduleId, operationKey);
      return issuance && issuance.deletedAt
        ? {
            batchId: issuance.batchId,
            operationKey,
            persisted: false,
            operationStatus: 'deleted',
            code: 'ARCHIVE_OPERATION_DELETED'
          }
        : null;
    } catch (_error) {
      return null;
    }
  }

  function positionArchiveIntentEvidence(pending, currentCheckpoint) {
    return evaluatePositionArchiveIntentEvidence(pending, currentCheckpoint, {
      statSync: fs.statSync,
      sourceSnapshotFromStat,
      sourceSnapshotMatchesStat
    });
  }

  function persistPositionArchiveIntentIfNeeded(
    pending,
    currentCheckpoint,
    service = getCurrentService(),
    options = {}
  ) {
    if (!pending) return null;
    const files = requirePositionPendingArchiveFiles(pending);
    const archiveRequired = pending.archiveRequired === true
      || (
        pending.archiveRequired === undefined
        && supportsArchiveChannel(pending.channel)
      );
    if (!archiveRequired) return null;
    if (pending.archiveState === 'durable') {
      if (options.includeCleanupCandidates !== true
          || !service
          || typeof service.listCommittedOperationInputs !== 'function') {
        return null;
      }
      const committedFiles = positionCommittedRecoveryArchiveFiles(
        { ...pending, archiveFiles: files },
        service.listCommittedOperationInputs(pending.operationToken)
      );
      const archiveResult = readDeletedPositionArchiveResult(pending);
      return {
        archiveResult,
        cleanupInputPaths: positionRecoveryCleanupInputPaths(
          { ...pending, archiveFiles: files },
          committedFiles,
          archiveResult
        )
      };
    }
    const evidence = positionArchiveIntentEvidence(pending, currentCheckpoint);
    if (!evidence.requiresPersistence) {
      return options.includeCleanupCandidates === true
        ? {
            archiveResult: null,
            cleanupInputPaths: positionRecoveryCleanupInputPaths(
              { ...pending, archiveFiles: files },
              [],
              null
            )
          }
        : null;
    }
    if (!service || typeof service.listCommittedOperationInputs !== 'function') {
      throw new Error('平盘业务已提交但无法读取文件级提交凭证，已停止恢复');
    }
    const owner = positionPendingOwner(pending);
    const rawBatch = owner.kind === 'file-batch'
      && getArchiveCenter()
      && getArchiveCenter().service
      && getArchiveCenter().service.repository.getBatch(owner.batchContext.batchId);
    const manifestOwned = Boolean(
      rawBatch && rawBatch.metadata && rawBatch.metadata._fileManifest
    );
    if (manifestOwned) {
      const archiveResult = getArchiveCenter().persistTaskTerminalIntent({
        owner,
        sourceOperation: String(pending.channel || ''),
        settleFiles: files.map((file) => ({
          artifactKey: file.artifactKey,
          ...(file.sha256 ? {
            expectedSha256: file.sha256,
            expectedSizeBytes: file.sizeBytes
          } : {})
        })),
        terminalOutcome: positionOutboxTerminalIntent(pending)
      });
      return options.includeCleanupCandidates === true
        ? { archiveResult, cleanupInputPaths: [] }
        : archiveResult;
    }
    const committedInputs = service.listCommittedOperationInputs(pending.operationToken);
    const committedFiles = positionCommittedRecoveryArchiveFiles(
      { ...pending, archiveFiles: files },
      committedInputs
    );
    if (committedFiles.length === 0 || !getArchiveCenter()
        || typeof getArchiveCenter().persistAppendIntent !== 'function') {
      throw new Error('平盘业务已提交但存档意图不完整，已停止恢复以避免审计文件丢失');
    }
    assertPositionRecoveryInputsUnchanged(
      { archiveFiles: committedFiles },
      assertStagedInputUnchanged
    );
    const recoveryFiles = positionRecoveryArchiveFiles(
      { archiveFiles: committedFiles },
      { captureOutputSnapshot: capturePositionArchiveFileSnapshot }
    );
    if (owner.kind !== 'file-batch') {
      throw new Error('平盘业务已提交但缺少原任务 batchContext，禁止建立幽灵批次');
    }
    const archiveResult = getArchiveCenter().persistAppendIntent({
      batchContext: owner.batchContext,
      sourceOperation: String(pending.channel || ''),
      metadata: { positionOperationToken: pending.operationToken, recovered: true },
      files: recoveryFiles,
      terminalOutcome: positionOutboxTerminalIntent(pending)
    });
    return options.includeCleanupCandidates === true
      ? {
          archiveResult,
          cleanupInputPaths: positionRecoveryCleanupInputPaths(
            { ...pending, archiveFiles: files },
            committedFiles,
            archiveResult
          )
        }
      : archiveResult;
  }

  function recoverPositionArchiveIntent(pending, currentCheckpoint, service) {
    return persistPositionArchiveIntentIfNeeded(
      pending,
      currentCheckpoint,
      service,
      { includeCleanupCandidates: true }
    );
  }

  function clearPositionPendingOperation(operationToken) {
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== operationToken) {
      throw new Error('平盘待完成操作所有权已变化，禁止清理其他操作记录');
    }
    writeSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
  }

  async function finalizePositionPendingAfterTaskTerminal({ context }) {
    const pending = readPositionPendingOperation();
    if (!pending) return;
    const owner = positionPendingOwner(pending);
    const ownerMatches = owner.kind === 'operation'
      ? owner.operationContext.taskRunId === context.taskRunId
      : owner.batchContext.taskRunId === context.taskRunId
        && owner.batchContext.batchId === context.batchId;
    if (pending.operationToken !== context.taskRunId || !ownerMatches) {
      throw new Error('平盘任务终态后的 pending 所有权已变化');
    }
    return finalizePositionOwnedPending(pending.operationToken, {
      recovery: false,
      archiveDurable: owner.kind === 'file-batch',
      archiveReference: context.batchId
    });
  }

  async function finalizeRecoveredPositionPending(operationToken, options = {}) {
    return finalizePositionOwnedPending(operationToken, { ...options, recovery: true });
  }

  // live 与 replay 的 owner 校验由各入口完成，pending/durable 收口只有这一份正文。
  // live 已由 operation lifecycle 同步 checkpoint；replay 仍补做 checkpoint 与受管暂存回收。
  async function finalizePositionOwnedPending(operationToken, options) {
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== operationToken) {
      throw new Error('平盘恢复 pending 所有权已变化');
    }
    if (options.archiveDurable === true && pending.archiveRequired === true
        && pending.archiveState !== 'durable') {
      writePositionPendingOperation({
        ...pending,
        archiveState: 'durable',
        archiveReference: options.archiveReference || ''
      }, operationToken);
    }
    const current = readPositionPendingOperation();
    if (options.recovery !== true) {
      if (current.archiveRequired === true && current.archiveState !== 'durable') return;
      clearPositionPendingOperation(operationToken);
      return;
    }
    const deletedArchiveResult = options.archiveResult
      && options.archiveResult.code === 'ARCHIVE_OPERATION_DELETED'
        ? options.archiveResult
        : readDeletedPositionArchiveResult(current);
    if (current.archiveRequired === true && current.archiveState !== 'durable'
        && !deletedArchiveResult) {
      throw new Error('平盘恢复存档尚未完成，禁止终结原任务或清理 pending');
    }
    const center = getArchiveCenter() || initializeArchiveCenter();
    if (!center || !center.service) throw new Error('平盘恢复缺少存档服务');
    if (!deletedArchiveResult && options.terminalSettled !== true) {
      await settlePositionRecoveredTask({
        pending: current,
        archiveService: center.service
      });
    }
    if (!getCurrentService()) {
      throw new Error('平盘侧库尚未初始化，禁止提前清理恢复 pending');
    }
    if (typeof getCurrentService().listCommittedOperationInputs !== 'function') {
      throw new Error('平盘侧库无法读取当前操作的文件级提交凭证，禁止清理恢复 pending');
    }
    const currentOwner = positionPendingOwner(current);
    const currentBatch = currentOwner.kind === 'file-batch'
      ? center.service.repository.getBatch(currentOwner.batchContext.batchId)
      : null;
    const cleanupInputPaths = currentBatch
      && currentBatch.metadata
      && currentBatch.metadata._fileManifest
        ? []
        : positionRecoveryCleanupInputPaths(
            current,
            positionCommittedRecoveryArchiveFiles(
              current,
              getCurrentService().listCommittedOperationInputs(operationToken)
            ),
            deletedArchiveResult
          );
    syncPositionReconciliationCheckpoint();
    writeSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, '');
    clearPositionPendingOperation(operationToken);
    try {
      await cleanupPositionArchiveSourcePaths(cleanupInputPaths);
    } catch (_error) {
      // 原任务、checkpoint 与 pending 已完成收口；暂存清理失败留待后续启动回收。
    }
  }

  function positionOutboxTerminalIntent(pending) {
    const outcome = positionRecoveryTerminalOutcome(pending);
    const operationToken = String(pending && pending.operationToken || '').trim();
    return {
      ...outcome,
      metadata: {
        recoveredPositionOperation: true,
        positionOperationToken: operationToken,
        positionTerminalOutcome: outcome.taskStatus
      },
      afterTerminal: {
        route: 'position-reconciliation',
        operationToken
      }
    };
  }

  function resolvePositionOutboxTerminalIntent(record) {
    const payload = record && record.payload;
    const targetBatchId = Number(payload && payload.targetBatchId);
    const operationToken = String(
      payload && payload.metadata && payload.metadata.positionOperationToken || ''
    ).trim();
    if (!Number.isSafeInteger(targetBatchId) || targetBatchId < 1 || !operationToken) return null;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== operationToken) return null;
    const owner = positionPendingOwner(pending);
    if (owner.kind !== 'file-batch' || Number(owner.batchContext.batchId) !== targetBatchId) {
      throw new Error('平盘 outbox 目标批次与 pending 原任务不一致');
    }
    return positionOutboxTerminalIntent(pending);
  }

  async function finalizePositionTerminalIntent({ route, record, created }) {
    if (!route || route.route !== 'position-reconciliation') {
      throw new Error(`不支持的任务终态收口路由：${route && route.route || '<empty>'}`);
    }
    const payload = record && record.payload;
    const targetBatchId = Number(payload && payload.targetBatchId);
    const recordOwner = payload && payload.owner
      ? freezePersistedTaskOwner(payload.owner, { required: true })
      : null;
    const operationToken = String(route.operationToken || '').trim();
    const recordOperationToken = String(
      payload && payload.metadata && payload.metadata.positionOperationToken || ''
    ).trim();
    if (!operationToken || recordOperationToken !== operationToken) {
      throw new Error('平盘任务终态路由与 outbox 身份不一致');
    }
    const pending = readPositionPendingOperation();
    if (!pending) return;
    const pendingOwner = positionPendingOwner(pending);
    if (pending.operationToken !== operationToken) {
      throw new Error('平盘 outbox 目标批次与 pending 原任务不一致');
    }
    if (recordOwner) {
      if (!samePositionPendingOwner(recordOwner, pendingOwner)
          || (recordOwner.kind === 'operation'
            ? recordOwner.operationContext.taskRunId !== operationToken
            : recordOwner.batchContext.taskRunId !== operationToken
              || recordOwner.batchContext.batchId !== targetBatchId)) {
        throw new Error('平盘 outbox owner 与 pending 原任务不一致');
      }
    } else if (pendingOwner.kind !== 'file-batch'
        || !Number.isSafeInteger(targetBatchId)
        || targetBatchId < 1
        || pendingOwner.batchContext.batchId !== targetBatchId) {
      throw new Error('平盘 outbox 目标批次与 pending 原任务不一致');
    }
    await finalizeRecoveredPositionPending(operationToken, {
      archiveDurable: true,
      archiveReference: recordOwner && recordOwner.kind === 'operation'
        ? recordOwner.operationContext.taskRunId
        : created && created.batch && created.batch.id || targetBatchId,
      terminalSettled: true
    });
  }


  function persistCurrentPositionArchiveIntentIfNeeded() {
    const context = positionReconciliationOperationContext.getStore();
    if (!context) return null;
    const pending = readPositionPendingOperation();
    if (!pending || pending.operationToken !== context.operationToken) {
      throw new Error('平盘待完成操作所有权已变化，无法登记存档恢复任务');
    }
    const currentCheckpoint = getCurrentService()
      ? getCurrentService().persistenceCheckpoint()
      : pending.baseCheckpoint || {};
    return persistPositionArchiveIntentIfNeeded(
      pending,
      currentCheckpoint,
      getCurrentService()
    );
  }


  function syncPositionReconciliationCheckpoint() {
    if (!settingsAvailable() || !getCurrentService()) return;
    writeSetting(
      POSITION_SIDE_DB_CHECKPOINT_SETTING,
      JSON.stringify(getCurrentService().persistenceCheckpoint())
    );
  }

  async function runPositionReconciliationOperation(channel, operation, options = {}) {
    if (positionReconciliationOperationActive) {
      return {
        status: 'busy',
        code: 'position-operation-busy',
        message: '平盘对账正在完成上一项操作，请稍后重试'
      };
    }
    let service;
    let baseCheckpoint;
    const operationToken = String(options.operationToken || randomUUID());
    positionReconciliationOperationActive = { operationToken, channel };
    try {
      service = getService();
      const unresolvedPending = readSetting(POSITION_SIDE_DB_PENDING_SETTING);
      if (unresolvedPending) {
        throw new Error('上一项平盘对账操作的 checkpoint 尚未完成同步，请重启软件恢复后再试');
      }
      baseCheckpoint = service.persistenceCheckpoint();
      const archiveRequired = Boolean(
        supportsArchiveChannel(channel)
      );
      return await runPositionOperationLifecycle({
        operationToken,
        pending: {
          operationToken,
          channel,
          owner: options.operationContext
            ? { version: 1, kind: 'operation', operationContext: options.operationContext }
            : { version: 1, kind: 'file-batch', batchContext: options.batchContext },
          baseCheckpoint,
          archiveRequired,
          archiveState: archiveRequired ? 'awaiting-intent' : 'not-required',
          businessState: 'running',
          terminalOutcome: null,
          archiveFiles: []
        },
        writeInitialPending: (pending) => {
          writeSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(pending));
        },
        runInContext: (task) => positionReconciliationOperationContext.run(
          { operationToken },
          task
        ),
        operation,
        readPending: () => JSON.parse(
          readSetting(POSITION_SIDE_DB_PENDING_SETTING) || 'null'
        ),
        syncCheckpoint: syncPositionReconciliationCheckpoint,
        clearPending: () => {
          writeSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
        },
        failureResult: positionReconciliationFailureResult,
        deferPendingClear: true
      });
    } catch (error) {
      return positionReconciliationFailureResult(error);
    } finally {
      if (positionReconciliationOperationActive
          && positionReconciliationOperationActive.operationToken === operationToken) {
        positionReconciliationOperationActive = null;
      }
    }
  }


  function positionArchiveStagingRoot() {
    if (!getDatabasePath()) return '';
    return path.resolve(
      path.dirname(getDatabasePath()),
      'run-data',
      'position-reconciliation',
      'import-staging'
    );
  }

  async function cleanupPositionArchiveStagingDirectories(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return;
    const root = positionArchiveStagingRoot();
    if (!root) return;
    for (const value of targets) {
      const target = path.resolve(String(value || ''));
      if (target === root || !target.startsWith(`${root}${path.sep}`)) continue;
      try {
        await fs.promises.rm(target, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100
        });
        const batchRoot = path.dirname(target);
        if (batchRoot !== root && batchRoot.startsWith(`${root}${path.sep}`)) {
          const entries = await fs.promises.readdir(batchRoot);
          if (entries.length === 0) {
            await fs.promises.rmdir(batchRoot);
          }
        }
      } catch (_error) {
        // 成功存档后的临时副本清理失败留待下次启动回收。
      }
    }
  }

  function positionArchivePersistentStagingPaths() {
    if (!getArchiveCenter()
        || typeof getArchiveCenter().listUnresolvedSourcePaths !== 'function') {
      return null;
    }
    try {
      return positionPersistentStagingProtectionPaths(
        getArchiveCenter().listUnresolvedSourcePaths(),
        readPositionPendingOperation()
      );
    } catch (_error) {
      return null;
    }
  }

  function positionArchiveProtectedStagingPaths() {
    let protectedPaths = positionArchivePersistentStagingPaths();
    if (!protectedPaths) return null;
    try {
      if (getCurrentService()
          && typeof getCurrentService().activeImportStagingPaths === 'function') {
        const activePaths = getCurrentService().activeImportStagingPaths();
        if (!Array.isArray(activePaths)) return null;
        protectedPaths = protectedPaths.concat(activePaths);
      }
    } catch (_error) {
      return null;
    }
    return protectedPaths;
  }

  async function cleanupPositionArchiveSourcePaths(sourcePaths) {
    const root = positionArchiveStagingRoot();
    if (!root) return;
    const directories = [];
    const jobRoots = [];
    for (const value of Array.isArray(sourcePaths) ? sourcePaths : []) {
      const sourcePath = path.resolve(String(value || ''));
      const relative = path.relative(root, sourcePath);
      const parts = relative.split(path.sep).filter(Boolean);
      if (relative === '..'
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
          || parts.length < 3) {
        continue;
      }
      directories.push(path.dirname(sourcePath));
      jobRoots.push(path.join(root, parts[0]));
    }
    const protectedPaths = positionArchiveProtectedStagingPaths();
    if (!protectedPaths) return;
    await cleanupPositionArchiveStagingDirectories(
      filterStagingPathsWithoutProtectedSources(
        directories.concat(jobRoots),
        protectedPaths
      )
    );
  }

  async function cleanupPositionArchiveStaging(runtime) {
    const targets = runtime && Array.isArray(runtime.cleanupPaths) ? runtime.cleanupPaths : [];
    if (targets.length === 0) return;
    const protectedPaths = positionArchiveProtectedStagingPaths();
    if (!protectedPaths) return;
    await cleanupPositionArchiveStagingDirectories(
      filterStagingPathsWithoutProtectedSources(targets, protectedPaths)
    );
  }


  function currentOperationToken() {
    const operation = positionReconciliationOperationContext.getStore();
    return operation && operation.operationToken;
  }

  function activeOperation() {
    return positionReconciliationOperationActive
      ? Object.freeze({ ...positionReconciliationOperationActive })
      : null;
  }

  function protectedInterruptedTasks() {
    const pending = readPositionPendingOperation();
    if (!pending) return { batchIds: [], taskRunIds: [] };
    const owner = positionPendingOwner(pending);
    return owner.kind === 'file-batch'
      ? { batchIds: [owner.batchContext.batchId], taskRunIds: [] }
      : { batchIds: [], taskRunIds: [owner.operationContext.taskRunId] };
  }

  function readPositionPendingRaw() {
    return settingsAvailable() ? readSetting(POSITION_SIDE_DB_PENDING_SETTING) : '';
  }

  function completePositionServiceInitialization(checkpoint) {
    writeSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING, JSON.stringify(checkpoint));
    writeSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, '');
    writeSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
  }

  const terminalRegistration = Object.freeze({
    route: 'position-reconciliation',
    normalize: normalizePositionTerminalRoute,
    finalize(payload) {
      return payload.context
        ? finalizePositionPendingAfterTaskTerminal(payload)
        : finalizePositionTerminalIntent(payload);
    }
  });

  return Object.freeze({
    terminalRegistration,
    readPositionPendingOperation,
    positionPendingOwner,
    writePositionPendingOperation,
    recordPositionArchiveIntentFiles,
    recordPositionFilePlanIntent,
    markPositionBusinessOutcome,
    persistPositionCancellationAccepted,
    markPositionArchiveDurable,
    markPositionArchiveIncomplete,
    recoverPositionArchiveIntent,
    finalizePositionPendingAfterTaskTerminal,
    finalizeRecoveredPositionPending,
    resolvePositionOutboxTerminalIntent,
    finalizePositionTerminalIntent,
    persistCurrentPositionArchiveIntentIfNeeded,
    syncPositionReconciliationCheckpoint,
    runPositionReconciliationOperation,
    positionArchivePersistentStagingPaths,
    cleanupPositionArchiveSourcePaths,
    cleanupPositionArchiveStaging,
    currentOperationToken,
    activeOperation,
    protectedInterruptedTasks,
    readPositionPendingRaw,
    completePositionServiceInitialization
  });
}

module.exports = { createPositionTaskOwner, normalizePositionTerminalRoute };
