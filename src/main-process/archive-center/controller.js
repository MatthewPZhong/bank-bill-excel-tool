'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  outboxBatchId,
  parseOutboxBatchId
} = require('./outbox-store');

const ARCHIVE_RETENTION_SETTING_KEY = 'archive_center_retention_days';
const ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY = 'archive_center_excluded_template_ids';
const DEFAULT_RETENTION_DAYS = 60;
const ALLOWED_RETENTION_DAYS = new Set([30, 60, 90, 180, 365]);

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

function operationFailureMessage(failures) {
  const count = Array.isArray(failures) ? failures.length : 0;
  return count > 0
    ? `${count} 个文件存档失败，可在存档中心重试`
    : '存档文件失败，可在存档中心重试';
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
    this.showSaveDialog = options.showSaveDialog || null;
    this.logWarning = options.logWarning || null;
    this.outboxStore = options.outboxStore || null;
    this.onOutboxFlushed = typeof options.onOutboxFlushed === 'function'
      ? options.onOutboxFlushed
      : null;
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

  async flushOutbox() {
    if (!this.outboxStore) return { flushed: 0, remaining: 0 };
    const records = this.outboxStore.list();
    let flushed = 0;
    for (const record of records) {
      let created;
      try {
        created = await this.service.createBatch(record.payload);
      } catch (error) {
        this._warn('存档 outbox 重放失败', error && error.message ? error.message : String(error));
        continue;
      }
      if (!created || !created.batch) continue;
      this.outboxStore.remove(record.id);
      flushed += 1;
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
    return { flushed, remaining: this.outboxStore.list().length };
  }

  _trackedFilePayload(file, sourceOperation) {
    const direction = file.role === 'output' ? 'output' : 'input';
    return {
      filePath: file.filePath,
      direction,
      role: file.role || direction,
      sourceOperation: file.sourceOperation || sourceOperation || '',
      originalName: file.originalName || path.basename(file.filePath),
      sourceSnapshot: file.sourceSnapshot,
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
      retentionDays: this.getRetentionDays(),
      metadata,
      sourceOperation,
      files
    };
  }

  persistOperationIntent(payload = {}) {
    if (!this.outboxStore) {
      throw new Error('存档持久 outbox 尚未初始化');
    }
    const files = (Array.isArray(payload.files) ? payload.files : []).map(
      (file) => this._trackedFilePayload(file, payload.sourceOperation)
    );
    if (files.length === 0) throw new Error('存档恢复意图缺少文件');
    const batchPayload = this._batchPayload(payload, files);
    const existing = this.outboxStore.findByOperationKey(batchPayload.operationKey);
    const record = existing
      ? this.outboxStore.append(existing.id, files)
      : this.outboxStore.enqueue(batchPayload);
    return {
      batchId: outboxBatchId(record.id),
      operationKey: batchPayload.operationKey,
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
    if (!created || !created.batch) {
      if (this.outboxStore) {
        try {
          const record = this.outboxStore.enqueue(batchPayload);
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
    return {
      persistentRetryAvailable: true,
      failureRecorded: true,
      ...this._summarizeTrackedFiles(appended, files)
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
    return {
      ...batch,
      batchId: batch.batchNumber,
      internalId: batch.id,
      canRetry: Number(batch.failedArtifactCount) > 0
        && batch.lastErrorCode !== 'ARCHIVE_SOURCE_CHANGED',
      requiresBusinessRerun: batch.lastErrorCode === 'ARCHIVE_SOURCE_CHANGED',
      warningMessage: batch.lastErrorMessage || ''
    };
  }

  _mapArtifact(artifact) {
    return {
      ...artifact,
      fileRefId: artifact.id,
      fileName: artifact.originalName,
      direction: artifact.direction === 'output' ? '输出' : '输入',
      sizeBytes: artifact.blob ? artifact.blob.sizeBytes : 0,
      archiveStatus: artifact.status,
      errorMessage: artifact.lastErrorMessage || ''
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

  async retryBatch(batchNumberOrId) {
    const batchId = await this.resolveBatchId(batchNumberOrId);
    if (!batchId) return publicFailure(null, '存档批次不存在');
    const result = await this.service.retryBatch(batchId);
    if (!result || result.ok === false) return publicFailure(result, '重试存档失败');
    return { status: 'success', message: '失败文件已重新存档', batch: this._mapBatch(result.batch) };
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
