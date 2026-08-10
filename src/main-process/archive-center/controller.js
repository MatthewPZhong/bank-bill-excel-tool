'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  outboxBatchId,
  parseOutboxBatchId
} = require('./outbox-store');
const {
  freezeWorkerBatchContext
} = require('./worker-batch-context');

const ARCHIVE_RETENTION_SETTING_KEY = 'archive_center_retention_days';
const ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY = 'archive_center_excluded_template_ids';
const DEFAULT_RETENTION_DAYS = 60;
const ALLOWED_RETENTION_DAYS = new Set([30, 60, 90, 180, 365]);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function artifactSupportsReplacementRetry(artifact) {
  const metadata = artifact && artifact.metadata;
  const expectedSizeBytes = Number(metadata && metadata.expectedSizeBytes);
  return Boolean(
    metadata
    && SHA256_RE.test(String(metadata.expectedSha256 || '').trim())
    && Number.isSafeInteger(expectedSizeBytes)
    && expectedSizeBytes >= 0
  );
}

function publicArtifactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const {
    sourceSnapshot: _sourceSnapshot,
    expectedSha256: _expectedSha256,
    expectedSizeBytes: _expectedSizeBytes,
    ...visible
  } = metadata;
  return visible;
}

function parseRetentionDays(value) {
  if (value === null || value === 'permanent') return null;
  const parsed = Number(value);
  return ALLOWED_RETENTION_DAYS.has(parsed) ? parsed : DEFAULT_RETENTION_DAYS;
}

function parseStoredRetentionDays(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_RETENTION_DAYS;
  if (value === 'permanent') return null;
  return parseRetentionDays(value);
}

function publicFailure(result, fallbackMessage) {
  return {
    status: 'failed',
    code: result && result.code ? result.code : 'ARCHIVE_CENTER_FAILED',
    message: result && result.message ? result.message : fallbackMessage
  };
}

function publicRetryFailure(result, failure, fallbackMessage) {
  const response = publicFailure(failure || result, fallbackMessage);
  const counts = {};
  for (const key of ['attempted', 'succeeded', 'failed']) {
    const value = Number(result && result[key]);
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  if (counts.succeeded > 0 && counts.failed > 0) {
    response.message += `；本次已成功 ${counts.succeeded} 个，仍失败 ${counts.failed} 个`;
  }
  return { ...response, ...counts };
}

function operationFailureMessage(failures) {
  const count = Array.isArray(failures) ? failures.length : 0;
  return count > 0
    ? `${count} 个文件存档失败，可在存档中心重试`
    : '存档文件失败，可在存档中心重试';
}

function filesHaveDurableArtifacts(files, created) {
  const specs = Array.isArray(files) ? files : [];
  if (specs.length === 0) return true;
  const results = created && Array.isArray(created.results) ? created.results : [];
  return results.length === specs.length && results.every((result) => {
    const artifactId = Number(result && result.artifact && result.artifact.id);
    return Number.isSafeInteger(artifactId) && artifactId > 0;
  });
}

function outboxFilesHaveDurableArtifacts(record, created) {
  const files = record && record.payload && Array.isArray(record.payload.files)
    ? record.payload.files
    : [];
  if (files.length === 0) return true;
  return filesHaveDurableArtifacts(files, created);
}

function normalizeTerminalOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('任务终态意图格式非法');
  }
  const taskStatus = String(value.taskStatus || '').trim().toLowerCase();
  if (!TERMINAL_TASK_STATUSES.has(taskStatus)) {
    throw new TypeError(`任务终态意图不支持状态：${taskStatus || '<empty>'}`);
  }
  const metadata = value.metadata === undefined ? {} : value.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('任务终态意图 metadata 必须是对象');
  }
  let afterTerminal = null;
  if (value.afterTerminal !== undefined && value.afterTerminal !== null) {
    if (typeof value.afterTerminal !== 'object' || Array.isArray(value.afterTerminal)) {
      throw new TypeError('任务终态意图 afterTerminal 格式非法');
    }
    const route = String(value.afterTerminal.route || '').trim();
    if (!route) throw new TypeError('任务终态意图 afterTerminal.route 为空');
    afterTerminal = {
      route,
      operationToken: String(value.afterTerminal.operationToken || '').trim()
    };
  }
  return {
    taskStatus,
    code: String(value.code || ''),
    message: String(value.message || ''),
    metadata: { ...metadata },
    ...(afterTerminal ? { afterTerminal } : {})
  };
}

class ArchiveCenterController {
  constructor(options = {}) {
    if (!options.database
        || typeof options.database.getSetting !== 'function'
        || typeof options.database.setSetting !== 'function') {
      throw new TypeError('ArchiveCenterController 需要 AppDatabase');
    }
    if (!options.service
        || typeof options.service.createBatch !== 'function'
        || typeof options.service.appendFiles !== 'function') {
      throw new TypeError('ArchiveCenterController 需要 ArchiveService');
    }
    this.database = options.database;
    this.service = options.service;
    this.showOpenDialog = options.showOpenDialog || null;
    this.showSaveDialog = options.showSaveDialog || null;
    this.logWarning = options.logWarning || null;
    this.outboxStore = options.outboxStore || null;
    this.onOutboxFlushed = typeof options.onOutboxFlushed === 'function'
      ? options.onOutboxFlushed
      : null;
    this.resolveOutboxTerminalIntent = typeof options.resolveOutboxTerminalIntent === 'function'
      ? options.resolveOutboxTerminalIntent
      : null;
    this.onTerminalIntentFlushed = typeof options.onTerminalIntentFlushed === 'function'
      ? options.onTerminalIntentFlushed
      : null;
    this.outboxFlushTail = Promise.resolve();
    this.batchNumberToId = new Map();
    this.database.setSetting(ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY, '[]');
    this.sink = Object.freeze({
      createBatch: (payload) => this.createTrackedBatch(payload),
      appendFiles: (payload) => this.appendTrackedFiles(payload)
    });
  }

  _warn(message, detail = '') {
    if (typeof this.logWarning !== 'function') return;
    try { this.logWarning(message, detail); } catch (_error) { /* logging must not break archive */ }
  }

  _rememberBatch(batch) {
    if (batch && batch.batchNumber && batch.id != null) {
      this.batchNumberToId.set(String(batch.batchNumber), Number(batch.id));
    }
    return batch;
  }

  getRetentionDays() {
    return parseStoredRetentionDays(this.database.getSetting(ARCHIVE_RETENTION_SETTING_KEY));
  }

  async initialize() {
    const initialized = await this.service.initialize();
    if (!initialized || initialized.available === false) {
      this._warn('存档中心初始化失败', initialized && initialized.message);
      return initialized;
    }
    if (initialized.ok === false) {
      this._warn('存档目录暂不可用，业务成功时仍会登记可重试批次', initialized.message);
    }
    await this.flushOutbox();
    const cleanup = await this.service.cleanupExpired();
    if (cleanup && cleanup.ok === false) {
      this._warn('存档中心到期清理未完全成功', cleanup.message || cleanup.status);
    }
    return initialized;
  }

  listUnresolvedSourcePaths() {
    const servicePaths = this.service.listUnresolvedSourcePaths();
    const outboxPaths = this.outboxStore ? this.outboxStore.listSourcePaths() : [];
    return [...new Set([...servicePaths, ...outboxPaths])];
  }

  async _flushOutboxUnlocked() {
    if (!this.outboxStore) return { flushed: 0, discarded: 0, remaining: 0 };
    const records = this.outboxStore.list();
    let flushed = 0;
    let discarded = 0;
    for (const record of records) {
      const payload = record && record.payload ? record.payload : {};
      let issuance;
      let created;
      try {
        issuance = this.service.repository.getOperationIssuance(
          payload.moduleId,
          payload.operationKey
        );
        if (!(issuance && issuance.deletedAt)) {
          const targetBatchId = Number(payload.targetBatchId);
          created = Number.isSafeInteger(targetBatchId) && targetBatchId > 0
            ? await this.service.appendFiles({
                batchId: targetBatchId,
                files: payload.files,
                sourceOperation: payload.sourceOperation,
                metadata: payload.metadata
              })
            : await this.service.createBatch(payload);
        }
      } catch (error) {
        this._warn('存档 outbox 重放失败', error && error.message ? error.message : String(error));
        continue;
      }
      const operationDeleted = Boolean(issuance && issuance.deletedAt);
      if (operationDeleted) {
        discarded += 1;
        this._warn(
          '存档 outbox 对应批次已永久删除，停止重放',
          `outbox=${record.id}，批次=${issuance.batchNumber}`
        );
      } else {
        if (!created || !created.batch) continue;
        if (!outboxFilesHaveDurableArtifacts(record, created)) {
          this._warn(
            '存档 outbox 已建批次但附件登记不完整',
            `outbox=${record.id}，已保留重放任务和源文件`
          );
          continue;
        }
      }
      let terminalOutcome = payload.terminalOutcome
        ? normalizeTerminalOutcome(payload.terminalOutcome)
        : null;
      if (!operationDeleted
          && !terminalOutcome
          && payload.metadata
          && payload.metadata.positionOperationToken
          && this.resolveOutboxTerminalIntent) {
        try {
          const resolved = await this.resolveOutboxTerminalIntent(record, created);
          if (resolved) {
            terminalOutcome = normalizeTerminalOutcome(resolved);
            this.outboxStore.merge(record.id, {
              targetBatchId: payload.targetBatchId,
              terminalOutcome
            });
          }
        } catch (error) {
          this._warn(
            '存档 outbox 已追加但任务终态意图持久化失败',
            error && error.message ? error.message : String(error)
          );
          continue;
        }
      }
      let terminalResult = null;
      if (!operationDeleted && terminalOutcome) {
        terminalResult = await this._replayTaskTerminal(
          Number(payload.targetBatchId),
          terminalOutcome
        );
        if (!terminalResult || terminalResult.ok === false) {
          this._warn(
            '存档 outbox 已追加但原任务终态收口失败',
            terminalResult && terminalResult.message || '任务终态写入失败'
          );
          continue;
        }
        if (terminalOutcome.afterTerminal) {
          if (!this.onTerminalIntentFlushed) {
            this._warn('存档 outbox 原任务已终结但缺少 afterTerminal 路由', terminalOutcome.afterTerminal.route);
            continue;
          }
          try {
            await this.onTerminalIntentFlushed({
              route: terminalOutcome.afterTerminal,
              record,
              created,
              terminalResult
            });
          } catch (error) {
            this._warn(
              '存档 outbox 原任务已终结但业务恢复收口失败',
              error && error.message ? error.message : String(error)
            );
            continue;
          }
        }
      }
      this.outboxStore.remove(record.id);
      if (!operationDeleted) flushed += 1;
      if (this.onOutboxFlushed) {
        let releasablePaths;
        try {
          const unresolvedPaths = new Set(
            this.listUnresolvedSourcePaths()
              .filter(Boolean)
              .map((value) => path.resolve(String(value)))
          );
          releasablePaths = record.payload.files
            .map((file) => file.filePath)
            .filter(Boolean)
            .map((value) => path.resolve(String(value)))
            .filter((filePath) => !unresolvedPaths.has(filePath));
        } catch (_error) {
          releasablePaths = [];
        }
        try {
          if (releasablePaths.length > 0) await this.onOutboxFlushed(releasablePaths);
        } catch (_error) {
          // outbox 已转成正式批次；已解决源暂存清理失败留待后续回收。
        }
      }
    }
    return { flushed, discarded, remaining: this.outboxStore.list().length };
  }

  async _replayTaskTerminal(batchId, terminalOutcome) {
    if (!Number.isSafeInteger(batchId) || batchId < 1) {
      return {
        ok: false,
        code: 'ARCHIVE_OUTBOX_TARGET_BATCH_INVALID',
        message: '任务终态 outbox 缺少原 batchId'
      };
    }
    let result;
    if (terminalOutcome.taskStatus === 'succeeded') {
      result = await this.service.completeTaskBatch(batchId, {
        metadata: terminalOutcome.metadata
      });
    } else if (terminalOutcome.taskStatus === 'cancelled') {
      result = await this.service.cancelTaskBatch(batchId, {
        code: terminalOutcome.code,
        reason: terminalOutcome.message,
        metadata: terminalOutcome.metadata
      });
    } else {
      result = await this.service.failTaskBatch(batchId, {
        code: terminalOutcome.code,
        message: terminalOutcome.message,
        metadata: terminalOutcome.metadata
      });
    }
    if (result && result.ok === false
        && result.code === 'ARCHIVE_TASK_STATUS_CONFLICT'
        && result.batch
        && result.batch.taskStatus === terminalOutcome.taskStatus) {
      return { ...result, ok: true, replayed: true };
    }
    return result;
  }

  async flushOutbox() {
    const run = this.outboxFlushTail.then(
      () => this._flushOutboxUnlocked(),
      () => this._flushOutboxUnlocked()
    );
    this.outboxFlushTail = run.catch(() => undefined);
    return run;
  }

  _trackedFilePayload(file, sourceOperation) {
    const direction = file.role === 'output' ? 'output' : 'input';
    return {
      ...file,
      filePath: file.filePath,
      direction,
      role: file.role || direction,
      sourceOperation: file.sourceOperation || sourceOperation || '',
      originalName: file.originalName || path.basename(file.filePath),
      sourceSnapshot: file.sourceSnapshot,
      expectedSha256: file.expectedSha256,
      expectedSizeBytes: file.expectedSizeBytes ?? file.sizeBytes,
      sizeBytes: file.sizeBytes,
      metadata: file.metadata || {}
    };
  }

  _summarizeTrackedFiles(serviceResult, files) {
    const specs = Array.isArray(files) ? files : [];
    const results = Array.isArray(serviceResult && serviceResult.results)
      ? serviceResult.results
      : [];
    const failures = results.flatMap((result, index) => {
      if (result && result.ok !== false) return [];
      const file = specs[index] || {};
      return [{
        originalName: file.originalName || path.basename(file.filePath || ''),
        code: result && result.code,
        message: result && result.message
      }];
    });
    if (failures.length === 0 && serviceResult && serviceResult.ok === false) {
      failures.push({
        originalName: '',
        code: serviceResult.code,
        message: serviceResult.message
      });
    }
    return {
      results,
      failures,
      archiveFailed: failures.length > 0,
      warning: failures.length > 0 ? { message: operationFailureMessage(failures), failures } : null
    };
  }

  _batchPayload(payload, files) {
    const sourceOperation = payload.sourceOperation || 'archive';
    const metadata = {
      ...(payload.metadata || {}),
      sourceOperation
    };
    const positionOperationToken = String(metadata.positionOperationToken || '').trim();
    return {
      moduleId: payload.moduleId,
      moduleCode: payload.moduleCode,
      moduleName: payload.moduleName,
      operationKey: payload.operationKey || (
        positionOperationToken
          ? `position:${positionOperationToken}:${sourceOperation}`
          : `${sourceOperation}:${crypto.randomUUID()}`
      ),
      businessStatus: 'success',
      locked: payload.locked === true,
      retentionDays: this.getRetentionDays(),
      metadata,
      sourceOperation,
      files
    };
  }

  _persistOutboxPayload(batchPayload) {
    if (!this.outboxStore) {
      throw new Error('存档持久 outbox 尚未初始化');
    }
    const existing = this.outboxStore.findByOperationKey(batchPayload.operationKey);
    if (!existing) return this.outboxStore.enqueue(batchPayload);
    if (batchPayload.terminalOutcome !== undefined) {
      if (typeof this.outboxStore.merge !== 'function') {
        throw new Error('存档 outbox 不支持原子合并任务终态意图');
      }
      return this.outboxStore.merge(existing.id, batchPayload);
    }
    return this.outboxStore.append(existing.id, batchPayload.files);
  }

  _requireTaskBatchContext(batchContext) {
    const batchId = Number(batchContext && batchContext.batchId);
    if (!Number.isSafeInteger(batchId) || batchId < 1) {
      throw new TypeError('恢复追加必须携带原任务 batchContext');
    }
    const batch = this.service.repository.getBatch(batchId);
    if (!batch) throw new Error(`恢复追加的原任务批次不存在：${batchId}`);
    for (const [contextKey, batchKey] of [
      ['batchNumber', 'batchNumber'],
      ['operationKey', 'operationKey'],
      ['parentRunId', 'parentRunId'],
      ['taskRunId', 'taskRunId'],
      ['taskKey', 'taskKey'],
      ['moduleId', 'moduleId']
    ]) {
      const expected = String(batchContext && batchContext[contextKey] || '').trim();
      if (!expected || expected !== String(batch[batchKey] || '').trim()) {
        throw new Error(`恢复追加 batchContext.${contextKey} 与原任务批次不一致`);
      }
    }
    return batch;
  }

  persistOperationIntent(payload = {}) {
    const files = (Array.isArray(payload.files) ? payload.files : []).map(
      (file) => this._trackedFilePayload(file, payload.sourceOperation)
    );
    if (files.length === 0) throw new Error('存档恢复意图缺少文件');
    const batchPayload = this._batchPayload(payload, files);
    let issuance;
    try {
      issuance = this.service.repository.getOperationIssuance(
        batchPayload.moduleId,
        batchPayload.operationKey
      );
    } catch (error) {
      this._warn(
        '存档 operation 删除状态读取失败，继续登记持久 outbox',
        error && error.message ? error.message : String(error)
      );
    }
    if (issuance && issuance.deletedAt) {
      return {
        batchId: issuance.batchId,
        operationKey: batchPayload.operationKey,
        persisted: false,
        operationStatus: 'deleted',
        code: 'ARCHIVE_OPERATION_DELETED'
      };
    }
    const record = this._persistOutboxPayload(batchPayload);
    return {
      batchId: outboxBatchId(record.id),
      operationKey: batchPayload.operationKey,
      persisted: true
    };
  }

  persistAppendIntent(payload = {}) {
    if (!this.outboxStore) throw new Error('存档持久 outbox 尚未初始化');
    const batchContext = payload.batchContext;
    const batch = this._requireTaskBatchContext(batchContext);
    const files = (Array.isArray(payload.files) ? payload.files : []).map(
      (file) => this._trackedFilePayload(file, payload.sourceOperation)
    );
    if (files.length === 0) throw new Error('恢复追加意图缺少文件');
    const retryPayload = {
      ...this._batchPayload({
        moduleId: batch.moduleId,
        moduleCode: batch.moduleCode,
        moduleName: batch.moduleName,
        operationKey: batch.operationKey,
        sourceOperation: payload.sourceOperation,
        metadata: {
          ...(batch.metadata || {}),
          ...(payload.metadata || {}),
          recovered: true
        }
      }, files),
      targetBatchId: batch.id,
      ...(payload.terminalOutcome
        ? { terminalOutcome: normalizeTerminalOutcome(payload.terminalOutcome) }
        : {})
    };
    const record = this._persistOutboxPayload(retryPayload);
    return {
      batchId: batch.id,
      outboxId: outboxBatchId(record.id),
      operationKey: batch.operationKey,
      persisted: true
    };
  }

  persistTaskTerminalIntent(payload = {}) {
    if (!this.outboxStore) throw new Error('存档持久 outbox 尚未初始化');
    const batchContext = freezeWorkerBatchContext(payload.batchContext, { required: true });
    const terminalOutcome = normalizeTerminalOutcome(payload.terminalOutcome);
    const sourceOperation = String(payload.sourceOperation || 'archive');
    const retryPayload = {
      moduleId: batchContext.moduleId,
      operationKey: batchContext.operationKey,
      sourceOperation,
      ...(terminalOutcome.afterTerminal
          && terminalOutcome.afterTerminal.route === 'position-reconciliation'
        ? {
            metadata: {
              positionOperationToken: terminalOutcome.afterTerminal.operationToken
            }
          }
        : {}),
      files: [],
      targetBatchId: batchContext.batchId,
      terminalOutcome
    };
    const record = this._persistOutboxPayload(retryPayload);
    return {
      batchId: batchContext.batchId,
      outboxId: outboxBatchId(record.id),
      operationKey: batchContext.operationKey,
      persisted: true
    };
  }

  async createTrackedBatch(payload = {}) {
    const files = (Array.isArray(payload.files) ? payload.files : []).map(
      (file) => this._trackedFilePayload(file, payload.sourceOperation)
    );
    const batchPayload = this._batchPayload(payload, files);
    let created;
    try {
      created = await this.service.createBatch(batchPayload);
    } catch (error) {
      created = {
        ok: false,
        message: error && error.message ? error.message : String(error)
      };
    }
    if (created && created.code === 'ARCHIVE_OPERATION_DELETED') {
      return {
        batchId: created.batchId,
        archiveFailed: true,
        persistentRetryAvailable: false,
        failureRecorded: true,
        operationStatus: 'deleted',
        code: created.code,
        warning: { message: created.message }
      };
    }
    if (!created || !created.batch) {
      if (this.outboxStore) {
        try {
          const record = this._persistOutboxPayload(batchPayload);
          return {
            batchId: outboxBatchId(record.id),
            archiveFailed: true,
            persistentRetryAvailable: true,
            failureRecorded: true,
            warning: {
              message: created && created.message
                ? `${created.message}；已登记持久重试任务`
                : '无法建立存档批次，已登记持久重试任务'
            }
          };
        } catch (outboxError) {
          return {
            archiveFailed: true,
            persistentRetryAvailable: false,
            failureRecorded: false,
            warning: {
              message:
                `${created && created.message ? created.message : '无法建立存档批次'}；` +
                `持久重试任务登记失败：${
                  outboxError && outboxError.message ? outboxError.message : String(outboxError)
                }`
            }
          };
        }
      }
      return {
        archiveFailed: true,
        persistentRetryAvailable: false,
        failureRecorded: false,
        warning: { message: created && created.message ? created.message : '无法建立存档批次' }
      };
    }
    const batch = this._rememberBatch(created.batch);
    const attached = this._summarizeTrackedFiles(created, files);
    if (!filesHaveDurableArtifacts(files, created)) {
      const baseMessage = attached.warning && attached.warning.message
        ? attached.warning.message
        : '存档批次附件登记不完整';
      try {
        const record = this._persistOutboxPayload({ ...batchPayload, targetBatchId: batch.id });
        return {
          ...attached,
          batchId: outboxBatchId(record.id),
          batchNumber: batch.batchNumber,
          created: created.created,
          archiveFailed: true,
          persistentRetryAvailable: true,
          failureRecorded: true,
          warning: {
            ...(attached.warning || {}),
            message: `${baseMessage}；已登记持久重试任务`
          }
        };
      } catch (outboxError) {
        return {
          ...attached,
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          created: created.created,
          archiveFailed: true,
          persistentRetryAvailable: false,
          failureRecorded: false,
          warning: {
            ...(attached.warning || {}),
            message:
              `${baseMessage}；持久重试任务登记失败：${
                outboxError && outboxError.message ? outboxError.message : String(outboxError)
              }`
          }
        };
      }
    }
    return {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      created: created.created,
      persistentRetryAvailable: true,
      failureRecorded: true,
      ...attached
    };
  }

  async appendTrackedFiles(payload = {}) {
    const outboxId = parseOutboxBatchId(payload.batchId);
    if (outboxId) {
      const files = (Array.isArray(payload.files) ? payload.files : []).map(
        (file) => this._trackedFilePayload(file, payload.sourceOperation)
      );
      try {
        this.outboxStore.append(outboxId, files);
        return {
          archiveFailed: true,
          persistentRetryAvailable: true,
          failureRecorded: true,
          warning: { message: '存档中心暂不可用，追加文件已登记持久重试任务' }
        };
      } catch (error) {
        return {
          archiveFailed: true,
          persistentRetryAvailable: false,
          failureRecorded: false,
          warning: {
            message: `存档持久重试任务追加失败：${
              error && error.message ? error.message : String(error)
            }`
          }
        };
      }
    }
    const resolvedBatchId = await this.resolveBatchId(payload.batchId);
    if (!resolvedBatchId) {
      return {
        archiveFailed: true,
        warning: { message: '待追加的存档批次不存在' }
      };
    }
    const files = (Array.isArray(payload.files) ? payload.files : []).map(
      (file) => this._trackedFilePayload(file, payload.sourceOperation)
    );
    const appended = await this.service.appendFiles({
      batchId: resolvedBatchId,
      sourceOperation: payload.sourceOperation,
      files
    });
    const attached = this._summarizeTrackedFiles(appended, files);
    if (!filesHaveDurableArtifacts(files, appended)) {
      const batch = (appended && appended.batch)
        || this.service.repository.getBatch(resolvedBatchId);
      const baseMessage = attached.warning && attached.warning.message
        ? attached.warning.message
        : '存档批次附件登记不完整';
      if (!batch) {
        return {
          ...attached,
          archiveFailed: true,
          persistentRetryAvailable: false,
          failureRecorded: false,
          warning: {
            ...(attached.warning || {}),
            message: `${baseMessage}；无法读取正式批次，未能登记持久重试任务`
          }
        };
      }
      const retryPayload = this._batchPayload({
        moduleId: batch.moduleId,
        moduleCode: batch.moduleCode,
        moduleName: batch.moduleName,
        operationKey: batch.operationKey,
        sourceOperation: payload.sourceOperation,
        metadata: {
          ...(batch.metadata || {}),
          ...(payload.metadata || {})
        }
      }, files);
      retryPayload.targetBatchId = batch.id;
      try {
        this._persistOutboxPayload(retryPayload);
        return {
          ...attached,
          archiveFailed: true,
          persistentRetryAvailable: true,
          failureRecorded: true,
          warning: {
            ...(attached.warning || {}),
            message: `${baseMessage}；已登记持久重试任务`
          }
        };
      } catch (outboxError) {
        return {
          ...attached,
          archiveFailed: true,
          persistentRetryAvailable: false,
          failureRecorded: false,
          warning: {
            ...(attached.warning || {}),
            message:
              `${baseMessage}；持久重试任务登记失败：${
                outboxError && outboxError.message ? outboxError.message : String(outboxError)
              }`
          }
        };
      }
    }
    return {
      persistentRetryAvailable: true,
      failureRecorded: true,
      ...attached
    };
  }

  async resolveBatchId(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;
    if (this.batchNumberToId.has(text)) return this.batchNumberToId.get(text);

    const numeric = Number(text);
    if (Number.isSafeInteger(numeric) && numeric > 0) {
      const direct = this.service.repository.getBatch(numeric);
      if (direct) {
        this._rememberBatch(direct);
        return direct.id;
      }
    }

    let offset = 0;
    while (offset < 100000) {
      const page = await this.service.listBatches({ limit: 1000, offset });
      if (!page || page.ok === false) return null;
      const batches = Array.isArray(page.batches) ? page.batches : [];
      for (const batch of batches) this._rememberBatch(batch);
      if (this.batchNumberToId.has(text)) return this.batchNumberToId.get(text);
      if (batches.length < 1000) break;
      offset += batches.length;
    }
    return null;
  }

  _mapBatch(batch) {
    this._rememberBatch(batch);
    const capability = this._retryCapability(batch);
    const { artifacts: _artifacts, ...visibleBatch } = batch;
    return {
      ...visibleBatch,
      batchId: batch.batchNumber,
      internalId: batch.id,
      ...capability,
      warningMessage: batch.lastErrorMessage || ''
    };
  }

  _mapArtifact(artifact) {
    const rawArtifact = this.service.repository.getArtifact(Number(artifact && artifact.id));
    const visibleMetadata = publicArtifactMetadata(artifact && artifact.metadata);
    const { sourcePath: _sourcePath, ...visibleArtifact } = artifact || {};
    return {
      ...visibleArtifact,
      metadata: visibleMetadata,
      role: visibleMetadata.displayRole || visibleArtifact.role,
      fileRefId: artifact.id,
      fileName: artifact.originalName,
      direction: artifact.direction === 'output' ? '输出' : '输入',
      sizeBytes: artifact.blob ? artifact.blob.sizeBytes : 0,
      archiveStatus: artifact.status,
      errorMessage: artifact.lastErrorMessage || '',
      canSelectReplacementSource: artifact.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED'
        && artifactSupportsReplacementRetry(rawArtifact)
    };
  }

  _failedArtifacts(batchId) {
    const repository = this.service && this.service.repository;
    if (!repository || typeof repository.listFailedArtifacts !== 'function') return [];
    return repository.listFailedArtifacts(Number(batchId));
  }

  _retryCapability(batch) {
    const failedArtifacts = this._failedArtifacts(batch && batch.id);
    const failedCount = Math.max(
      Number(batch && batch.failedArtifactCount) || 0,
      failedArtifacts.length
    );
    if (failedCount === 0) {
      return {
        canRetry: false,
        retryMode: 'none',
        requiresBusinessRerun: false
      };
    }

    const sourceChangedArtifacts = failedArtifacts.filter(
      (artifact) => artifact.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED'
    );
    const fallbackSourceChanged = sourceChangedArtifacts.length === 0
      && batch && batch.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED';
    const unsupportedSourceChanged = sourceChangedArtifacts.some(
      (artifact) => !artifactSupportsReplacementRetry(artifact)
    );
    if (fallbackSourceChanged || unsupportedSourceChanged) {
      return {
        canRetry: false,
        retryMode: 'rerun-business',
        requiresBusinessRerun: true
      };
    }
    if (sourceChangedArtifacts.length > 0) {
      return {
        canRetry: true,
        retryMode: 'select-source',
        requiresBusinessRerun: false
      };
    }
    return {
      canRetry: true,
      retryMode: 'same-source',
      requiresBusinessRerun: false
    };
  }

  async listBatches(filters = {}) {
    const batchNumber = String(filters.batchId || filters.batchNumber || '').trim().toUpperCase();
    const serviceFilters = {
      localDate: filters.date || filters.localDate || '',
      moduleId: filters.moduleId || '',
      batchNumberContains: batchNumber,
      limit: 1000
    };
    const result = await this.service.listBatches(serviceFilters);
    if (!result || result.ok === false) return publicFailure(result, '存档批次加载失败');
    const batches = (result.batches || [])
      .filter((batch) => !batchNumber || String(batch.batchNumber).toUpperCase().includes(batchNumber))
      .map((batch) => this._mapBatch(batch));
    return { status: 'success', batches };
  }

  async getBatch(batchNumberOrId) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const result = await this.service.getBatch(batchId);
    if (!result || result.ok === false || !result.batch) {
      return publicFailure(result, '存档批次加载失败');
    }
    const batch = this._mapBatch(result.batch);
    return {
      status: 'success',
      batch: {
        ...batch,
        files: (result.batch.artifacts || []).map((artifact) => this._mapArtifact(artifact))
      }
    };
  }

  async setLocked(batchNumberOrId, locked) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const result = await this.service.setLocked(batchId, locked === true);
    if (!result || result.ok === false) return publicFailure(result, '批次锁定状态修改失败');
    return { status: 'success', batch: this._mapBatch(result.batch) };
  }

  async deleteBatch(batchNumberOrId) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const result = await this.service.deleteBatch(batchId);
    if (result && result.metadataDeleted === true) {
      for (const [batchNumber, mappedId] of this.batchNumberToId) {
        if (mappedId === batchId) this.batchNumberToId.delete(batchNumber);
      }
      const cleanupPending = result.ok === false;
      return {
        status: cleanupPending ? 'partial' : 'success',
        ok: !cleanupPending,
        metadataDeleted: true,
        message: cleanupPending
          ? '批次记录已删除，但部分物理副本清理待下次启动重试'
          : '存档批次已永久删除',
        failures: Array.isArray(result.failures) ? result.failures : []
      };
    }
    if (!result || result.ok === false) return publicFailure(result, '永久删除存档批次失败');
    return { status: 'success', ok: true, message: '存档批次已永久删除' };
  }

  async selectRetrySources(batchNumberOrId) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const batch = this.service.repository.getBatch(batchId);
    const capability = this._retryCapability(batch);
    if (capability.retryMode !== 'select-source') {
      return publicFailure(null, capability.requiresBusinessRerun
        ? '该批次缺少业务内容摘要，需要重新运行业务'
        : '该批次不需要选择原文件');
    }
    if (typeof this.showOpenDialog !== 'function') {
      return publicFailure(null, '选择原文件服务暂不可用');
    }

    const artifacts = this._failedArtifacts(batchId).filter((artifact) => (
      artifact.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED'
      && artifactSupportsReplacementRetry(artifact)
    ));
    const sourcePaths = {};
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index];
      const extension = path.extname(artifact.originalName).replace(/^\./, '').toLowerCase();
      const selected = await this.showOpenDialog({
        title: `选择“${artifact.originalName}”原文件`,
        buttonLabel: '选择原文件',
        properties: ['openFile'],
        filters: extension
          ? [{ name: extension.toUpperCase(), extensions: [extension] }]
          : undefined
      });
      if (!selected || selected.canceled || !selected.filePaths || !selected.filePaths[0]) {
        return { status: 'cancelled' };
      }
      sourcePaths[artifact.id] = path.resolve(String(selected.filePaths[0]));
    }
    return { status: 'success', sourcePaths, selectedCount: artifacts.length };
  }

  _validatedRetrySourcePaths(batch, sourcePaths) {
    const capability = this._retryCapability(batch);
    if (!capability.canRetry) {
      return {
        error: capability.requiresBusinessRerun
          ? '该批次缺少业务内容摘要，需要重新运行业务'
          : '该批次没有可重试文件'
      };
    }
    const supplied = sourcePaths == null ? {} : sourcePaths;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      return { error: '重试文件参数无效' };
    }
    const replacementArtifacts = this._failedArtifacts(batch.id).filter((artifact) => (
      artifact.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED'
      && artifactSupportsReplacementRetry(artifact)
    ));
    const allowedIds = new Set(replacementArtifacts.map((artifact) => String(artifact.id)));
    const normalized = {};
    for (const [artifactId, filePath] of Object.entries(supplied)) {
      if (!allowedIds.has(String(artifactId))
          || typeof filePath !== 'string'
          || filePath.trim() === '') {
        return { error: '重试文件参数无效' };
      }
      normalized[artifactId] = path.resolve(filePath);
    }
    if (capability.retryMode === 'same-source' && Object.keys(normalized).length > 0) {
      return { error: '普通存档重试不接受替代文件' };
    }
    if (capability.retryMode === 'select-source'
        && replacementArtifacts.some((artifact) => !normalized[artifact.id])) {
      return { error: '请先为全部失败文件选择原文件' };
    }
    return { sourcePaths: normalized };
  }

  async retryBatch(batchNumberOrId, sourcePaths = null) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const batch = this.service.repository.getBatch(batchId);
    const validated = this._validatedRetrySourcePaths(batch, sourcePaths);
    if (validated.error) return publicFailure(null, validated.error);
    const result = await this.service.retryBatch(batchId, {
      sourcePaths: validated.sourcePaths
    });
    if (!result || result.ok === false) {
      const failed = result && Array.isArray(result.results)
        ? result.results.find((item) => item && item.ok === false)
        : null;
      if (failed && failed.code === 'ARCHIVE_SOURCE_CHANGED'
          && Object.keys(validated.sourcePaths).length > 0) {
        return publicRetryFailure(result, {
          code: failed.code,
          message: '所选文件与业务处理时的原始内容不一致，请重新选择正确文件'
        }, '重试存档失败');
      }
      return publicRetryFailure(result, failed || result, '重试存档失败');
    }
    return {
      status: 'success',
      message: '失败文件已重新存档',
      batch: this._mapBatch(result.batch),
      attempted: Number(result.attempted) || 0,
      succeeded: Number(result.succeeded) || 0,
      failed: Number(result.failed) || 0
    };
  }

  async openFile(fileRefId) {
    const result = await this.service.openReadonlyCopy(Number(fileRefId));
    if (!result || result.ok === false) return publicFailure(result, '打开只读副本失败');
    return { status: 'success', message: '已打开只读副本' };
  }

  async saveAs(fileRefId) {
    const artifact = this.service.repository.getArtifact(Number(fileRefId));
    if (!artifact) return publicFailure(null, '存档文件不存在');
    if (typeof this.showSaveDialog !== 'function') {
      return publicFailure(null, '另存为服务暂不可用');
    }
    const extension = path.extname(artifact.originalName).replace(/^\./, '');
    const selected = await this.showSaveDialog({
      title: '另存存档文件',
      defaultPath: artifact.originalName,
      filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined
    });
    if (!selected || selected.canceled || !selected.filePath) return { status: 'cancelled' };
    const result = await this.service.saveAs(Number(fileRefId), selected.filePath);
    if (!result || result.ok === false) {
      const failure = publicFailure(result, '另存存档文件失败');
      if (result && result.recoveryPath) {
        return {
          ...failure,
          recoveryPath: result.recoveryPath,
          message: `${failure.message}；原目标备份保留在：${result.recoveryPath}`
        };
      }
      return failure;
    }
    return { status: 'success', message: '已完成另存为', filePath: result.filePath };
  }

  getSettings() {
    return {
      status: 'success',
      settings: {
        retentionDays: this.getRetentionDays()
      }
    };
  }

  setRetentionDays(value) {
    const retentionDays = value === null ? null : Number(value);
    if (retentionDays !== null && !ALLOWED_RETENTION_DAYS.has(retentionDays)) {
      return publicFailure(null, '保留期限仅支持 30、60、90、180、365 天或永久');
    }
    this.database.setSetting(
      ARCHIVE_RETENTION_SETTING_KEY,
      retentionDays === null ? 'permanent' : String(retentionDays)
    );
    return { status: 'success', settings: { retentionDays } };
  }

  async getStats() {
    const result = await this.service.getStats();
    if (!result || result.ok === false) return publicFailure(result, '存储统计加载失败');
    return {
      status: 'success',
      stats: {
        ...(result.stats || {}),
        fileRefCount: result.stats && result.stats.logicalFileCount,
        storagePath: this.service.rootDir
      }
    };
  }
}

function createArchiveCenterController(options) {
  return new ArchiveCenterController(options);
}

module.exports = {
  ALLOWED_RETENTION_DAYS,
  ARCHIVE_RETENTION_SETTING_KEY,
  ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY,
  ArchiveCenterController,
  DEFAULT_RETENTION_DAYS,
  createArchiveCenterController,
  parseRetentionDays
};
