'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    const filePath = path.resolve(String(file.filePath || ''));
    if (!file.filePath) throw new TypeError('存档 outbox 文件路径为空');
    return { ...file, filePath };
  });
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

  append(id, files) {
    const record = this.get(id);
    if (!record) throw new Error(`存档 outbox 记录不存在：${id}`);
    const seen = new Set(record.payload.files.map((file) => (
      `${file.direction || ''}\u0000${file.role || ''}\u0000${file.filePath}`
    )));
    const appended = normalizeFiles(files).filter((file) => {
      const key = `${file.direction || ''}\u0000${file.role || ''}\u0000${file.filePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const updated = {
      ...record,
      payload: {
        ...record.payload,
        files: [...record.payload.files, ...appended]
      }
    };
    updated.integrityHash = recordIntegrityHash(updated);
    return this._writeRecord(updated);
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
