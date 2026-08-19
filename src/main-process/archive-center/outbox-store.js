'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 磁盘容器格式仍为 v1；TerminalOutboxRecord 的 v2 位于 payload.version，
// 两者是独立合同，不能用 terminal envelope 版本替换外层完整性容器版本。
const OUTBOX_VERSION = 1;
const OUTBOX_ID_PREFIX = 'outbox:';

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordIntegrityHash(record) {
  const persistedRecord = JSON.parse(JSON.stringify({
    version: record.version,
    id: record.id,
    createdAt: record.createdAt,
    payload: record.payload
  }));
  return crypto.createHash('sha256').update(stableSerialize(persistedRecord)).digest('hex');
}

function normalizeFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError('存档 outbox 文件记录格式非法');
    }
    if (typeof file.filePath !== 'string' || file.filePath.trim() === '') {
      throw new TypeError('存档 outbox 文件路径为空或格式非法');
    }
    const filePath = path.resolve(file.filePath);
    return { ...file, filePath };
  });
}

function outboxConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRecord(record, fileName = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`存档 outbox 记录损坏：${fileName}`);
  }
  const id = String(record.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new TypeError(`存档 outbox ID 非法：${fileName}`);
  }
  if (Number(record.version) !== OUTBOX_VERSION) {
    throw new TypeError(`存档 outbox 版本不兼容：${fileName}`);
  }
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(`存档 outbox payload 损坏：${fileName}`);
  }
  const normalized = {
    version: OUTBOX_VERSION,
    id,
    createdAt: String(record.createdAt || ''),
    payload: {
      ...payload,
      files: normalizeFiles(payload.files)
    }
  };
  const expectedHash = recordIntegrityHash(normalized);
  if (String(record.integrityHash || '') !== expectedHash) {
    throw new TypeError(`存档 outbox 完整性校验失败：${fileName}`);
  }
  return { ...normalized, integrityHash: expectedHash };
}

function outboxBatchId(id) {
  return `${OUTBOX_ID_PREFIX}${id}`;
}

function parseOutboxBatchId(value) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized.startsWith(OUTBOX_ID_PREFIX)) return '';
  const id = normalized.slice(OUTBOX_ID_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

class ArchiveOutboxStore {
  constructor(rootDir, { fsImpl = fs, now = () => new Date() } = {}) {
    if (!rootDir) throw new TypeError('存档 outbox 需要 rootDir');
    this.rootDir = path.resolve(rootDir);
    this.fs = fsImpl;
    this.now = now;
  }

  _recordPath(id) {
    return path.join(this.rootDir, `${id}.json`);
  }

  _syncRootDirectory() {
    let handle = null;
    try {
      handle = this.fs.openSync(this.rootDir, 'r');
      this.fs.fsyncSync(handle);
    } catch (_error) {
      // Windows may not allow fsync on directory handles; the file itself is already durable.
    } finally {
      if (handle !== null) {
        try { this.fs.closeSync(handle); } catch (_closeError) {}
      }
    }
  }

  _writeRecord(record) {
    this.fs.mkdirSync(this.rootDir, { recursive: true });
    const targetPath = this._recordPath(record.id);
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    let handle = null;
    try {
      handle = this.fs.openSync(temporaryPath, 'wx', 0o600);
      this.fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
      this.fs.fsyncSync(handle);
      this.fs.closeSync(handle);
      handle = null;
      this.fs.renameSync(temporaryPath, targetPath);
      this._syncRootDirectory();
      return record;
    } catch (error) {
      if (handle !== null) {
        try { this.fs.closeSync(handle); } catch (_closeError) {}
      }
      try { this.fs.rmSync(temporaryPath, { force: true }); } catch (_cleanupError) {}
      throw error;
    }
  }

  enqueue(payload) {
    const record = {
      version: OUTBOX_VERSION,
      id: crypto.randomUUID(),
      createdAt: this.now().toISOString(),
      payload: {
        ...payload,
        files: normalizeFiles(payload && payload.files)
      }
    };
    record.integrityHash = recordIntegrityHash(record);
    return this._writeRecord(record);
  }

  merge(id, payload = {}) {
    const record = this.get(id);
    if (!record) throw new Error(`存档 outbox 记录不存在：${id}`);
    const incomingTargetBatchId = Object.prototype.hasOwnProperty.call(payload, 'targetBatchId')
      ? Number(payload.targetBatchId)
      : null;
    if (incomingTargetBatchId !== null
        && (!Number.isSafeInteger(incomingTargetBatchId) || incomingTargetBatchId < 1)) {
      throw new TypeError('存档 outbox targetBatchId 必须是正安全整数');
    }
    const existingTargetBatchId = Object.prototype.hasOwnProperty.call(
      record.payload,
      'targetBatchId'
    ) ? Number(record.payload.targetBatchId) : null;
    if (existingTargetBatchId !== null
        && incomingTargetBatchId !== null
        && existingTargetBatchId !== incomingTargetBatchId) {
      throw outboxConflict(
        'ARCHIVE_OUTBOX_TARGET_BATCH_CONFLICT',
        '同一 operation 的存档 outbox 指向不同任务批次'
      );
    }

    const incomingTerminalOutcome = payload.terminalOutcome;
    if (incomingTerminalOutcome !== undefined
        && (!incomingTerminalOutcome
          || typeof incomingTerminalOutcome !== 'object'
          || Array.isArray(incomingTerminalOutcome))) {
      throw new TypeError('存档 outbox terminalOutcome 格式非法');
    }
    const existingTerminalOutcome = record.payload.terminalOutcome;
    if (existingTerminalOutcome !== undefined
        && incomingTerminalOutcome !== undefined
        && stableSerialize(existingTerminalOutcome) !== stableSerialize(incomingTerminalOutcome)) {
      throw outboxConflict(
        'ARCHIVE_OUTBOX_TERMINAL_CONFLICT',
        '同一 operation/batch 的任务终态意图冲突'
      );
    }
    const incomingOwner = payload.owner;
    if (incomingOwner !== undefined
        && (!incomingOwner || typeof incomingOwner !== 'object' || Array.isArray(incomingOwner))) {
      throw new TypeError('存档 outbox owner 格式非法');
    }
    const existingOwner = record.payload.owner;
    if (existingOwner !== undefined
        && incomingOwner !== undefined
        && stableSerialize(existingOwner) !== stableSerialize(incomingOwner)) {
      throw outboxConflict(
        'ARCHIVE_OUTBOX_OWNER_CONFLICT',
        '同一 operation 的存档 outbox owner 冲突'
      );
    }
    const incomingSettleFiles = payload.settleFiles;
    if (incomingSettleFiles !== undefined && !Array.isArray(incomingSettleFiles)) {
      throw new TypeError('存档 outbox settleFiles 格式非法');
    }
    const existingSettleFiles = record.payload.settleFiles;
    if (existingSettleFiles !== undefined
        && incomingSettleFiles !== undefined
        && stableSerialize(existingSettleFiles) !== stableSerialize(incomingSettleFiles)) {
      throw outboxConflict(
        'ARCHIVE_OUTBOX_SETTLE_EVIDENCE_CONFLICT',
        '同一 operation 的 manifest settle evidence 冲突'
      );
    }
    const incomingPayloadVersion = payload.version === undefined ? null : Number(payload.version);
    if (incomingPayloadVersion !== null && incomingPayloadVersion !== 2) {
      throw new TypeError('存档 outbox payload version 非法');
    }
    const existingPayloadVersion = record.payload.version === undefined
      ? null
      : Number(record.payload.version);
    if (existingPayloadVersion !== null
        && incomingPayloadVersion !== null
        && existingPayloadVersion !== incomingPayloadVersion) {
      throw outboxConflict(
        'ARCHIVE_OUTBOX_OWNER_CONFLICT',
        '同一 operation 的存档 outbox payload version 冲突'
      );
    }

    const seen = new Set(record.payload.files.map((file) => (
      `${file.direction || ''}\u0000${file.role || ''}\u0000${file.filePath}`
    )));
    const appended = normalizeFiles(payload.files).filter((file) => {
      const key = `${file.direction || ''}\u0000${file.role || ''}\u0000${file.filePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const updated = {
      ...record,
      payload: {
        ...record.payload,
        ...(existingTargetBatchId === null && incomingTargetBatchId !== null
          ? { targetBatchId: incomingTargetBatchId }
          : {}),
        ...(existingTerminalOutcome === undefined && incomingTerminalOutcome !== undefined
          ? { terminalOutcome: JSON.parse(JSON.stringify(incomingTerminalOutcome)) }
          : {}),
        ...(existingOwner === undefined && incomingOwner !== undefined
          ? { owner: JSON.parse(JSON.stringify(incomingOwner)) }
          : {}),
        ...(existingSettleFiles === undefined && incomingSettleFiles !== undefined
          ? { settleFiles: JSON.parse(JSON.stringify(incomingSettleFiles)) }
          : {}),
        ...(existingPayloadVersion === null && incomingPayloadVersion !== null
          ? { version: incomingPayloadVersion }
          : {}),
        files: [...record.payload.files, ...appended]
      }
    };
    updated.integrityHash = recordIntegrityHash(updated);
    return this._writeRecord(updated);
  }

  append(id, files) {
    return this.merge(id, { files });
  }

  get(id) {
    const targetPath = this._recordPath(id);
    if (!this.fs.existsSync(targetPath)) return null;
    return normalizeRecord(
      JSON.parse(this.fs.readFileSync(targetPath, 'utf8')),
      path.basename(targetPath)
    );
  }

  list() {
    if (!this.fs.existsSync(this.rootDir)) return [];
    return this.fs.readdirSync(this.rootDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => normalizeRecord(
        JSON.parse(this.fs.readFileSync(path.join(this.rootDir, name), 'utf8')),
        name
      ));
  }

  findByOperationKey(operationKey) {
    const normalized = String(operationKey || '').trim();
    if (!normalized) return null;
    return this.list().find(
      (record) => String(record.payload.operationKey || '').trim() === normalized
    ) || null;
  }

  remove(id) {
    this.fs.rmSync(this._recordPath(id), { force: true });
    this._syncRootDirectory();
  }

  listSourcePaths() {
    return [...new Set(
      this.list().flatMap((record) => record.payload.files.map((file) => file.filePath))
    )];
  }
}

function createArchiveOutboxStore(rootDir, options) {
  return new ArchiveOutboxStore(rootDir, options);
}

module.exports = {
  OUTBOX_ID_PREFIX,
  ArchiveOutboxStore,
  createArchiveOutboxStore,
  outboxBatchId,
  parseOutboxBatchId
};
