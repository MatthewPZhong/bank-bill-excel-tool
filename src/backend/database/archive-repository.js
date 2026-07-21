'use strict';

// 存档中心只在主库保存轻量元数据：
//   archive_batches   一次业务操作对应的本地日期流水批次；
//   archive_batch_sequences 不因批次删除而回退的本地日期流水游标；
//   archive_artifacts 批次中的逻辑文件及失败重试信息；
//   archive_blobs     以 SHA-256 寻址的唯一物理文件。
//
// 本文件不创建 DatabaseSync。调用方注入已经打开的数据库句柄，并显式调用
// ensureArchiveMetadataSupport/createArchiveRepository(...).ensureSchema()。

const BATCH_ARCHIVE_STATUSES = Object.freeze({
  STAGING: 'staging',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete'
});

const ARTIFACT_STATUSES = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed'
});

const ARTIFACT_DIRECTIONS = new Set(['input', 'output']);
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODULE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

let savepointSequence = 0;

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('archive repository 需要调用方注入 DatabaseSync');
  }
}

function requiredText(value, label, maxLength = 512) {
  const text = value == null ? '' : String(value).trim();
  if (!text) throw new TypeError(`${label}不能为空`);
  if (text.length > maxLength) throw new TypeError(`${label}长度不能超过 ${maxLength}`);
  if (text.includes('\u0000')) throw new TypeError(`${label}不能包含 NUL 字符`);
  return text;
}

function optionalText(value, maxLength = 1024) {
  const text = value == null ? '' : String(value).trim();
  if (text.length > maxLength) throw new TypeError(`文本长度不能超过 ${maxLength}`);
  if (text.includes('\u0000')) throw new TypeError('文本不能包含 NUL 字符');
  return text;
}

function normalizeModuleId(value) {
  const moduleId = requiredText(value, 'moduleId', 128);
  if (!MODULE_ID_RE.test(moduleId)) {
    throw new TypeError('moduleId 只能包含字母、数字、点、下划线和连字符');
  }
  return moduleId;
}

function normalizeModuleCode(value) {
  const moduleCode = requiredText(value, 'moduleCode', 32).toUpperCase();
  if (!MODULE_CODE_RE.test(moduleCode)) {
    throw new TypeError('moduleCode 只能包含字母、数字、下划线和连字符');
  }
  return moduleCode;
}

function normalizeLocalDate(value, label = 'localDate') {
  const text = requiredText(value, label, 10);
  if (!LOCAL_DATE_RE.test(text)) throw new TypeError(`${label}必须为 YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${label}不是有效日历日期`);
  }
  return text;
}

function normalizeRetentionUntil(value, localDate) {
  if (value === null || value === undefined || value === '') return null;
  const retentionUntil = normalizeLocalDate(value, 'retentionUntil');
  if (localDate && retentionUntil < localDate) {
    throw new TypeError('retentionUntil 不能早于批次 localDate');
  }
  return retentionUntil;
}

function normalizeSha256(value) {
  const sha256 = requiredText(value, 'sha256', 64).toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new TypeError('sha256 必须是 64 位十六进制字符串');
  return sha256;
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('sizeBytes 必须是非负安全整数');
  }
  return size;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('metadata 必须是对象');
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('metadata 无法序列化');
  return json;
}

function parseObjectJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function normalizeOriginalName(value) {
  const name = requiredText(value, 'originalName', 255).split(/[\\/]/).pop();
  if (!name || name === '.' || name === '..') throw new TypeError('originalName 非法');
  return name;
}

function dateToIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now() 必须返回有效日期');
  return date.toISOString();
}

function formatBatchNumber(moduleCode, localDate, dailySequence) {
  const code = normalizeModuleCode(moduleCode);
  const date = normalizeLocalDate(localDate).replace(/-/g, '');
  const sequence = Number(dailySequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('dailySequence 必须是正安全整数');
  }
  return `${code}-${date}-${String(sequence).padStart(3, '0')}`;
}

function withWriteTransaction(db, operation) {
  const nested = db.isTransaction === true;
  const savepoint = `archive_repo_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch (_rollbackError) {
      // 保留原始错误；调用方下一次操作仍会由 SQLite 报出真实事务状态。
    }
    throw error;
  }
}

function ensureArchiveMetadataSupport(db) {
  assertDatabase(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number TEXT NOT NULL UNIQUE,
      module_id TEXT NOT NULL,
      module_code TEXT NOT NULL,
      module_name TEXT NOT NULL,
      operation_key TEXT NOT NULL DEFAULT '',
      local_date TEXT NOT NULL,
      daily_sequence INTEGER NOT NULL CHECK (daily_sequence > 0),
      business_status TEXT NOT NULL DEFAULT '',
      archive_status TEXT NOT NULL DEFAULT 'staging'
        CHECK (archive_status IN ('staging', 'complete', 'incomplete')),
      locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
      retention_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      last_failed_operation TEXT,
      last_failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (module_code, local_date, daily_sequence)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_batches_operation
      ON archive_batches(module_id, operation_key)
      WHERE operation_key <> '';
    CREATE INDEX IF NOT EXISTS idx_archive_batches_date_module
      ON archive_batches(local_date DESC, module_id, daily_sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_batches_retention
      ON archive_batches(locked, retention_until)
      WHERE retention_until IS NOT NULL;

    CREATE TABLE IF NOT EXISTS archive_batch_sequences (
      module_code TEXT NOT NULL,
      local_date TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
      PRIMARY KEY (module_code, local_date)
    );

    INSERT INTO archive_batch_sequences (module_code, local_date, last_sequence)
    SELECT module_code, local_date, MAX(daily_sequence)
    FROM archive_batches
    GROUP BY module_code, local_date
    ON CONFLICT(module_code, local_date) DO UPDATE SET
      last_sequence = MAX(archive_batch_sequences.last_sequence, excluded.last_sequence);

    CREATE TABLE IF NOT EXISTS archive_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      artifact_key TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
      role TEXT NOT NULL,
      source_operation TEXT NOT NULL DEFAULT '',
      original_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'failed')),
      blob_id INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES archive_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (blob_id) REFERENCES archive_blobs(id) ON DELETE SET NULL,
      UNIQUE (batch_id, artifact_key)
    );

    CREATE INDEX IF NOT EXISTS idx_archive_artifacts_batch
      ON archive_artifacts(batch_id, id);
    CREATE INDEX IF NOT EXISTS idx_archive_artifacts_blob
      ON archive_artifacts(blob_id)
      WHERE blob_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_archive_artifacts_retry
      ON archive_artifacts(batch_id, status, id);
  `);
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    batchNumber: row.batch_number,
    moduleId: row.module_id,
    moduleCode: row.module_code,
    moduleName: row.module_name,
    operationKey: row.operation_key,
    localDate: row.local_date,
    dailySequence: Number(row.daily_sequence),
    businessStatus: row.business_status,
    archiveStatus: row.archive_status,
    locked: Number(row.locked) === 1,
    retentionUntil: row.retention_until || null,
    metadata: parseObjectJson(row.metadata_json),
    failureCount: Number(row.failure_count) || 0,
    retryCount: Number(row.retry_count) || 0,
    lastErrorCode: row.last_error_code || '',
    lastErrorMessage: row.last_error_message || '',
    lastFailedOperation: row.last_failed_operation || '',
    lastFailedAt: row.last_failed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    artifactCount: Number(row.artifact_count) || 0,
    readyArtifactCount: Number(row.ready_artifact_count) || 0,
    failedArtifactCount: Number(row.failed_artifact_count) || 0,
    pendingArtifactCount: Number(row.pending_artifact_count) || 0,
    logicalBytes: Number(row.logical_bytes) || 0
  };
}

function mapBlob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes) || 0,
    relativePath: row.relative_path,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    referenceCount: Number(row.reference_count) || 0
  };
}

function mapArtifact(row) {
  if (!row) return null;
  const blob = row.blob_row_id == null ? null : {
    id: Number(row.blob_row_id),
    sha256: row.blob_sha256,
    sizeBytes: Number(row.blob_size_bytes) || 0,
    relativePath: row.blob_relative_path
  };
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    artifactKey: row.artifact_key,
    direction: row.direction,
    role: row.role,
    sourceOperation: row.source_operation,
    originalName: row.original_name,
    sourcePath: row.source_path,
    status: row.status,
    blobId: row.blob_id == null ? null : Number(row.blob_id),
    blob,
    attemptCount: Number(row.attempt_count) || 0,
    lastErrorCode: row.last_error_code || '',
    lastErrorMessage: row.last_error_message || '',
    metadata: parseObjectJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null
  };
}

const BATCH_SELECT = `
  SELECT
    b.*,
    COUNT(a.id) AS artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'ready' THEN bl.size_bytes ELSE 0 END), 0) AS logical_bytes
  FROM archive_batches b
  LEFT JOIN archive_artifacts a ON a.batch_id = b.id
  LEFT JOIN archive_blobs bl ON bl.id = a.blob_id
`;

const ARTIFACT_SELECT = `
  SELECT
    a.*,
    bl.id AS blob_row_id,
    bl.sha256 AS blob_sha256,
    bl.size_bytes AS blob_size_bytes,
    bl.relative_path AS blob_relative_path
  FROM archive_artifacts a
  LEFT JOIN archive_blobs bl ON bl.id = a.blob_id
`;

function normalizeArtifactPayload(payload = {}, fallbackKey = '') {
  const direction = optionalText(payload.direction || 'input', 16).toLowerCase();
  if (!ARTIFACT_DIRECTIONS.has(direction)) {
    throw new TypeError('artifact direction 只支持 input 或 output');
  }
  return {
    artifactKey: requiredText(payload.artifactKey || fallbackKey, 'artifactKey', 128),
    direction,
    role: requiredText(payload.role, 'role', 128),
    sourceOperation: optionalText(payload.sourceOperation, 128),
    originalName: normalizeOriginalName(payload.originalName),
    sourcePath: requiredText(payload.sourcePath, 'sourcePath', 4096),
    metadataJson: normalizeMetadata(payload.metadata)
  };
}

class ArchiveRepository {
  constructor(db, options = {}) {
    assertDatabase(db);
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('archive repository now 必须是函数');
    }
    this.db = db;
    this.now = options.now || (() => new Date());
  }

  _timestamp() {
    return dateToIso(this.now());
  }

  ensureSchema() {
    ensureArchiveMetadataSupport(this.db);
  }

  getBatch(batchId) {
    const row = this.db.prepare(`
      ${BATCH_SELECT}
      WHERE b.id = ?
      GROUP BY b.id
    `).get(Number(batchId));
    return mapBatch(row);
  }

  getBatchByOperationKey(moduleId, operationKey) {
    const normalizedModuleId = normalizeModuleId(moduleId);
    const normalizedOperationKey = requiredText(operationKey, 'operationKey', 256);
    const row = this.db.prepare(`
      ${BATCH_SELECT}
      WHERE b.module_id = ? AND b.operation_key = ?
      GROUP BY b.id
    `).get(normalizedModuleId, normalizedOperationKey);
    return mapBatch(row);
  }

  listBatches(filters = {}) {
    const where = [];
    const params = [];
    if (filters.localDate != null && filters.localDate !== '') {
      where.push('b.local_date = ?');
      params.push(normalizeLocalDate(filters.localDate));
    }
    if (filters.moduleId != null && filters.moduleId !== '') {
      where.push('b.module_id = ?');
      params.push(normalizeModuleId(filters.moduleId));
    }
    if (filters.archiveStatus != null && filters.archiveStatus !== '') {
      const status = requiredText(filters.archiveStatus, 'archiveStatus', 32);
      if (!Object.values(BATCH_ARCHIVE_STATUSES).includes(status)) {
        throw new TypeError(`archiveStatus 非法：${status}`);
      }
      where.push('b.archive_status = ?');
      params.push(status);
    }
    if (filters.batchNumberContains != null && filters.batchNumberContains !== '') {
      const batchNumber = requiredText(filters.batchNumberContains, 'batchNumberContains', 128)
        .toUpperCase();
      where.push('INSTR(UPPER(b.batch_number), ?) > 0');
      params.push(batchNumber);
    }
    const limitValue = filters.limit === undefined ? 200 : Number(filters.limit);
    const offsetValue = filters.offset === undefined ? 0 : Number(filters.offset);
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 1000) {
      throw new TypeError('limit 必须为 1 到 1000 的安全整数');
    }
    if (!Number.isSafeInteger(offsetValue) || offsetValue < 0) {
      throw new TypeError('offset 必须是非负安全整数');
    }
    const sqlWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`
      ${BATCH_SELECT}
      ${sqlWhere}
      GROUP BY b.id
      ORDER BY b.local_date DESC, b.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitValue, offsetValue).map(mapBatch);
  }

  listArtifacts(batchId) {
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.batch_id = ?
      ORDER BY a.id ASC
    `).all(Number(batchId)).map(mapArtifact);
  }

  listFailedArtifacts(batchId) {
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.batch_id = ? AND a.status = 'failed'
      ORDER BY a.id ASC
    `).all(Number(batchId)).map(mapArtifact);
  }

  getArtifact(artifactId) {
    return mapArtifact(this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.id = ?
    `).get(Number(artifactId)));
  }

  getArtifactByKey(batchId, artifactKey) {
    const key = requiredText(artifactKey, 'artifactKey', 128);
    return mapArtifact(this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.batch_id = ? AND a.artifact_key = ?
    `).get(Number(batchId), key));
  }

  getBatchDetail(batchId) {
    const batch = this.getBatch(batchId);
    if (!batch) return null;
    return { ...batch, artifacts: this.listArtifacts(batch.id) };
  }

  createBatch(payload = {}) {
    const moduleId = normalizeModuleId(payload.moduleId);
    const moduleCode = normalizeModuleCode(payload.moduleCode || payload.moduleId);
    const moduleName = requiredText(payload.moduleName || payload.moduleId, 'moduleName', 128);
    const operationKey = optionalText(payload.operationKey, 256);
    const localDate = normalizeLocalDate(payload.localDate);
    const retentionUntil = normalizeRetentionUntil(payload.retentionUntil, localDate);
    const businessStatus = optionalText(payload.businessStatus, 64);
    const metadataJson = normalizeMetadata(payload.metadata);
    const locked = payload.locked === true ? 1 : 0;
    const timestamp = this._timestamp();

    return withWriteTransaction(this.db, () => {
      if (operationKey) {
        const existing = this.db.prepare(`
          SELECT id FROM archive_batches WHERE module_id = ? AND operation_key = ?
        `).get(moduleId, operationKey);
        if (existing) return { created: false, batch: this.getBatch(existing.id) };
      }

      this.db.prepare(`
        INSERT INTO archive_batch_sequences (module_code, local_date, last_sequence)
        VALUES (?, ?, 1)
        ON CONFLICT(module_code, local_date) DO UPDATE SET
          last_sequence = archive_batch_sequences.last_sequence + 1
      `).run(moduleCode, localDate);
      const sequenceRow = this.db.prepare(`
        SELECT last_sequence
        FROM archive_batch_sequences
        WHERE module_code = ? AND local_date = ?
      `).get(moduleCode, localDate);
      const dailySequence = Number(sequenceRow.last_sequence);
      const batchNumber = formatBatchNumber(moduleCode, localDate, dailySequence);
      const result = this.db.prepare(`
        INSERT INTO archive_batches (
          batch_number, module_id, module_code, module_name, operation_key,
          local_date, daily_sequence, business_status, archive_status,
          locked, retention_until, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?)
      `).run(
        batchNumber,
        moduleId,
        moduleCode,
        moduleName,
        operationKey,
        localDate,
        dailySequence,
        businessStatus,
        locked,
        retentionUntil,
        metadataJson,
        timestamp,
        timestamp
      );
      return { created: true, batch: this.getBatch(Number(result.lastInsertRowid)) };
    });
  }

  addArtifact(batchId, payload = {}) {
    const id = Number(batchId);
    const artifact = normalizeArtifactPayload(payload, `artifact-${this._timestamp()}`);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      if (!this.db.prepare('SELECT id FROM archive_batches WHERE id = ?').get(id)) {
        throw new Error(`存档批次不存在：${id}`);
      }
      const result = this.db.prepare(`
        INSERT INTO archive_artifacts (
          batch_id, artifact_key, direction, role, source_operation,
          original_name, source_path, status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id,
        artifact.artifactKey,
        artifact.direction,
        artifact.role,
        artifact.sourceOperation,
        artifact.originalName,
        artifact.sourcePath,
        artifact.metadataJson,
        timestamp,
        timestamp
      );
      this.db.prepare(`
        UPDATE archive_batches
        SET archive_status = 'staging', completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, id);
      return this.getArtifact(Number(result.lastInsertRowid));
    });
  }

  _refreshBatchStatus(batchId, timestamp) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM archive_artifacts
      WHERE batch_id = ?
    `).get(Number(batchId));
    const total = Number(counts.total) || 0;
    const ready = Number(counts.ready_count) || 0;
    const pending = Number(counts.pending_count) || 0;
    let status = BATCH_ARCHIVE_STATUSES.INCOMPLETE;
    let completedAt = timestamp;
    if (total > 0 && ready === total) {
      status = BATCH_ARCHIVE_STATUSES.COMPLETE;
    } else if (pending > 0) {
      status = BATCH_ARCHIVE_STATUSES.STAGING;
      completedAt = null;
    }
    this.db.prepare(`
      UPDATE archive_batches
      SET archive_status = ?, completed_at = ?, updated_at = ?,
          last_error_code = CASE WHEN ? = 'complete' THEN NULL ELSE last_error_code END,
          last_error_message = CASE WHEN ? = 'complete' THEN NULL ELSE last_error_message END,
          last_failed_operation = CASE WHEN ? = 'complete' THEN NULL ELSE last_failed_operation END,
          last_failed_at = CASE WHEN ? = 'complete' THEN NULL ELSE last_failed_at END
      WHERE id = ?
    `).run(status, completedAt, timestamp, status, status, status, status, Number(batchId));
    return status;
  }

  startArtifactAttempt(artifactId, options = {}) {
    const id = Number(artifactId);
    const sourcePath = options.sourcePath == null
      ? null
      : requiredText(options.sourcePath, 'sourcePath', 4096);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM archive_artifacts WHERE id = ?').get(id);
      if (!current) throw new Error(`存档 artifact 不存在：${id}`);
      if (current.status === ARTIFACT_STATUSES.READY) {
        throw new Error(`存档 artifact 已完成，不能重复写入：${id}`);
      }
      this.db.prepare(`
        UPDATE archive_artifacts
        SET status = 'pending', source_path = COALESCE(?, source_path),
            blob_id = NULL, attempt_count = attempt_count + 1,
            last_error_code = NULL, last_error_message = NULL,
            archived_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(sourcePath, timestamp, id);
      this.db.prepare(`
        UPDATE archive_batches
        SET archive_status = 'staging', completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, Number(current.batch_id));
      return this.getArtifact(id);
    });
  }

  completeArtifact(artifactId, blobPayload = {}) {
    const id = Number(artifactId);
    const sha256 = normalizeSha256(blobPayload.sha256);
    const sizeBytes = normalizeSize(blobPayload.sizeBytes);
    const relativePath = requiredText(blobPayload.relativePath, 'relativePath', 512);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const artifact = this.db.prepare('SELECT * FROM archive_artifacts WHERE id = ?').get(id);
      if (!artifact) throw new Error(`存档 artifact 不存在：${id}`);
      if (artifact.status !== ARTIFACT_STATUSES.PENDING) {
        throw new Error(`存档 artifact 状态不是 pending：${id}`);
      }

      const inserted = this.db.prepare(`
        INSERT INTO archive_blobs (sha256, size_bytes, relative_path, created_at, last_verified_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO NOTHING
      `).run(sha256, sizeBytes, relativePath, timestamp, timestamp);
      const blob = this.db.prepare('SELECT * FROM archive_blobs WHERE sha256 = ?').get(sha256);
      if (!blob || Number(blob.size_bytes) !== sizeBytes || blob.relative_path !== relativePath) {
        throw new Error(`SHA-256 ${sha256.slice(0, 12)} 对应的 blob 元数据冲突`);
      }
      if (inserted.changes === 0) {
        this.db.prepare(`UPDATE archive_blobs SET last_verified_at = ? WHERE id = ?`)
          .run(timestamp, Number(blob.id));
      }
      const update = this.db.prepare(`
        UPDATE archive_artifacts
        SET status = 'ready', blob_id = ?, last_error_code = NULL,
            last_error_message = NULL, archived_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(Number(blob.id), timestamp, timestamp, id);
      if (update.changes !== 1) throw new Error(`存档 artifact 完成状态竞争：${id}`);
      this._refreshBatchStatus(Number(artifact.batch_id), timestamp);
      return {
        artifact: this.getArtifact(id),
        batch: this.getBatch(Number(artifact.batch_id)),
        blob: mapBlob({ ...blob, reference_count: 0 }),
        deduplicated: inserted.changes === 0
      };
    });
  }

  failArtifact(artifactId, failure = {}) {
    const id = Number(artifactId);
    const code = requiredText(failure.code || 'ARCHIVE_FILE_FAILED', 'failure.code', 128);
    const message = requiredText(failure.message || '文件存档失败', 'failure.message', 512);
    const sourceOperation = optionalText(failure.sourceOperation, 128);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const artifact = this.db.prepare('SELECT * FROM archive_artifacts WHERE id = ?').get(id);
      if (!artifact) throw new Error(`存档 artifact 不存在：${id}`);
      if (artifact.status === ARTIFACT_STATUSES.READY) {
        throw new Error(`已完成的存档 artifact 不能标记失败：${id}`);
      }
      this.db.prepare(`
        UPDATE archive_artifacts
        SET status = 'failed', blob_id = NULL, last_error_code = ?,
            last_error_message = ?, archived_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(code, message, timestamp, id);
      this.db.prepare(`
        UPDATE archive_batches
        SET archive_status = 'incomplete', failure_count = failure_count + 1,
            last_error_code = ?, last_error_message = ?,
            last_failed_operation = ?, last_failed_at = ?,
            completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        code,
        message,
        sourceOperation || artifact.source_operation || '',
        timestamp,
        timestamp,
        timestamp,
        Number(artifact.batch_id)
      );
      this._refreshBatchStatus(Number(artifact.batch_id), timestamp);
      return { artifact: this.getArtifact(id), batch: this.getBatch(Number(artifact.batch_id)) };
    });
  }

  recordBatchFailure(batchId, failure = {}) {
    const id = Number(batchId);
    const code = requiredText(failure.code || 'ARCHIVE_BATCH_FAILED', 'failure.code', 128);
    const message = requiredText(failure.message || '批次存档失败', 'failure.message', 512);
    const sourceOperation = optionalText(failure.sourceOperation, 128);
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_batches
      SET archive_status = 'incomplete', failure_count = failure_count + 1,
          last_error_code = ?, last_error_message = ?, last_failed_operation = ?,
          last_failed_at = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(code, message, sourceOperation, timestamp, timestamp, timestamp, id);
    return result.changes === 1 ? this.getBatch(id) : null;
  }

  beginBatchRetry(batchId) {
    const id = Number(batchId);
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_batches
      SET retry_count = retry_count + 1, archive_status = 'staging',
          completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, id);
    return result.changes === 1 ? this.getBatch(id) : null;
  }

  updateBatchBusinessStatus(batchId, businessStatus) {
    const id = Number(batchId);
    const status = optionalText(businessStatus, 64);
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_batches SET business_status = ?, updated_at = ? WHERE id = ?
    `).run(status, timestamp, id);
    return result.changes === 1 ? this.getBatch(id) : null;
  }

  setLocked(batchId, locked) {
    const id = Number(batchId);
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_batches SET locked = ?, updated_at = ? WHERE id = ?
    `).run(locked === true ? 1 : 0, timestamp, id);
    return result.changes === 1 ? this.getBatch(id) : null;
  }

  setRetentionUntil(batchId, retentionUntil) {
    const id = Number(batchId);
    const batch = this.getBatch(id);
    if (!batch) return null;
    const normalized = normalizeRetentionUntil(retentionUntil, batch.localDate);
    const timestamp = this._timestamp();
    this.db.prepare(`
      UPDATE archive_batches SET retention_until = ?, updated_at = ? WHERE id = ?
    `).run(normalized, timestamp, id);
    return this.getBatch(id);
  }

  listExpiredBatches(asOfLocalDate) {
    const date = normalizeLocalDate(asOfLocalDate, 'asOfLocalDate');
    return this.db.prepare(`
      ${BATCH_SELECT}
      WHERE b.locked = 0
        AND b.retention_until IS NOT NULL
        AND b.retention_until < ?
      GROUP BY b.id
      ORDER BY b.retention_until ASC, b.id ASC
    `).all(date).map(mapBatch);
  }

  findBlobByHash(sha256) {
    const hash = normalizeSha256(sha256);
    return mapBlob(this.db.prepare(`
      SELECT bl.*, COUNT(a.id) AS reference_count
      FROM archive_blobs bl
      LEFT JOIN archive_artifacts a ON a.blob_id = bl.id
      WHERE bl.sha256 = ?
      GROUP BY bl.id
    `).get(hash));
  }

  listBlobs() {
    return this.db.prepare(`
      SELECT bl.*, COUNT(a.id) AS reference_count
      FROM archive_blobs bl
      LEFT JOIN archive_artifacts a ON a.blob_id = bl.id
      GROUP BY bl.id
      ORDER BY bl.id ASC
    `).all().map(mapBlob);
  }

  deleteBlobIfUnreferenced(blobId) {
    const id = Number(blobId);
    return withWriteTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM archive_blobs WHERE id = ?').get(id);
      if (!row) return null;
      const references = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM archive_artifacts WHERE blob_id = ?
      `).get(id).count);
      if (references > 0) return null;
      this.db.prepare('DELETE FROM archive_blobs WHERE id = ?').run(id);
      return mapBlob({ ...row, reference_count: 0 });
    });
  }

  invalidateBlob(blobId, failure = {}) {
    const id = Number(blobId);
    const code = requiredText(failure.code || 'ARCHIVE_BLOB_INVALID', 'failure.code', 128);
    const message = requiredText(failure.message || '存档文件缺失或损坏', 'failure.message', 512);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const blob = this.db.prepare('SELECT * FROM archive_blobs WHERE id = ?').get(id);
      if (!blob) return null;
      const affected = this.db.prepare(`
        SELECT id, batch_id FROM archive_artifacts WHERE blob_id = ? ORDER BY id
      `).all(id);
      this.db.prepare(`
        UPDATE archive_artifacts
        SET status = 'failed', blob_id = NULL, last_error_code = ?,
            last_error_message = ?, archived_at = NULL, updated_at = ?
        WHERE blob_id = ?
      `).run(code, message, timestamp, id);
      const batchIds = [...new Set(affected.map((row) => Number(row.batch_id)))];
      for (const batchId of batchIds) {
        this.db.prepare(`
          UPDATE archive_batches
          SET failure_count = failure_count + 1, last_error_code = ?,
              last_error_message = ?, last_failed_operation = 'startup-consistency',
              last_failed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(code, message, timestamp, timestamp, batchId);
        this._refreshBatchStatus(batchId, timestamp);
      }
      this.db.prepare('DELETE FROM archive_blobs WHERE id = ?').run(id);
      return {
        blob: mapBlob({ ...blob, reference_count: affected.length }),
        affectedArtifactCount: affected.length,
        affectedBatchIds: batchIds
      };
    });
  }

  markInterruptedArtifacts() {
    const pending = this.db.prepare(`
      SELECT id, batch_id FROM archive_artifacts WHERE status = 'pending' ORDER BY id
    `).all();
    if (pending.length === 0) return { artifactCount: 0, batchIds: [] };
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const code = 'ARCHIVE_INTERRUPTED';
      const message = '应用上次退出时文件尚未完成存档，可重试该批次';
      this.db.prepare(`
        UPDATE archive_artifacts
        SET status = 'failed', blob_id = NULL, last_error_code = ?,
            last_error_message = ?, archived_at = NULL, updated_at = ?
        WHERE status = 'pending'
      `).run(code, message, timestamp);
      const counts = new Map();
      for (const row of pending) {
        const batchId = Number(row.batch_id);
        counts.set(batchId, (counts.get(batchId) || 0) + 1);
      }
      for (const [batchId, count] of counts) {
        this.db.prepare(`
          UPDATE archive_batches
          SET failure_count = failure_count + ?, last_error_code = ?,
              last_error_message = ?, last_failed_operation = 'startup-consistency',
              last_failed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(count, code, message, timestamp, timestamp, batchId);
        this._refreshBatchStatus(batchId, timestamp);
      }
      return { artifactCount: pending.length, batchIds: [...counts.keys()] };
    });
  }

  repairDanglingArtifactReferences() {
    const rows = this.db.prepare(`
      SELECT a.id, a.batch_id, a.status, a.blob_id, bl.id AS existing_blob_id
      FROM archive_artifacts a
      LEFT JOIN archive_blobs bl ON bl.id = a.blob_id
      WHERE (a.status = 'ready' AND (a.blob_id IS NULL OR bl.id IS NULL))
         OR (a.status <> 'ready' AND a.blob_id IS NOT NULL)
      ORDER BY a.id
    `).all();
    if (rows.length === 0) return { artifactCount: 0, batchIds: [], releasedBlobs: [] };
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const code = 'ARCHIVE_REFERENCE_INVALID';
      const message = '存档文件引用不完整，可重试该文件';
      const batchIds = new Set();
      const candidateBlobIds = new Set();
      for (const row of rows) {
        batchIds.add(Number(row.batch_id));
        if (row.blob_id != null && row.existing_blob_id != null) {
          candidateBlobIds.add(Number(row.blob_id));
        }
        if (row.status === ARTIFACT_STATUSES.READY) {
          this.db.prepare(`
            UPDATE archive_artifacts
            SET status = 'failed', blob_id = NULL, last_error_code = ?,
                last_error_message = ?, archived_at = NULL, updated_at = ?
            WHERE id = ?
          `).run(code, message, timestamp, Number(row.id));
        } else {
          this.db.prepare(`UPDATE archive_artifacts SET blob_id = NULL, updated_at = ? WHERE id = ?`)
            .run(timestamp, Number(row.id));
        }
      }
      for (const batchId of batchIds) {
        this.db.prepare(`
          UPDATE archive_batches
          SET failure_count = failure_count + 1, last_error_code = ?,
              last_error_message = ?, last_failed_operation = 'startup-consistency',
              last_failed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(code, message, timestamp, timestamp, batchId);
        this._refreshBatchStatus(batchId, timestamp);
      }
      const releasedBlobs = [];
      for (const blobId of candidateBlobIds) {
        const count = Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM archive_artifacts WHERE blob_id = ?
        `).get(blobId).count);
        if (count > 0) continue;
        const blob = this.db.prepare('SELECT * FROM archive_blobs WHERE id = ?').get(blobId);
        if (!blob) continue;
        this.db.prepare('DELETE FROM archive_blobs WHERE id = ?').run(blobId);
        releasedBlobs.push(mapBlob({ ...blob, reference_count: 0 }));
      }
      return { artifactCount: rows.length, batchIds: [...batchIds], releasedBlobs };
    });
  }

  deleteBatch(batchId, options = {}) {
    const id = Number(batchId);
    const allowLocked = options.allowLocked === true;
    return withWriteTransaction(this.db, () => {
      const batch = this.getBatch(id);
      if (!batch) return { status: 'not-found', batchId: id, releasedBlobs: [] };
      if (batch.locked && !allowLocked) {
        return { status: 'locked', batch, releasedBlobs: [] };
      }
      const candidateBlobs = this.db.prepare(`
        SELECT DISTINCT bl.*
        FROM archive_blobs bl
        JOIN archive_artifacts a ON a.blob_id = bl.id
        WHERE a.batch_id = ?
        ORDER BY bl.id
      `).all(id);
      const artifactCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM archive_artifacts WHERE batch_id = ?
      `).get(id).count);
      const logicalBytes = Number(this.db.prepare(`
        SELECT COALESCE(SUM(bl.size_bytes), 0) AS size
        FROM archive_artifacts a
        JOIN archive_blobs bl ON bl.id = a.blob_id
        WHERE a.batch_id = ? AND a.status = 'ready'
      `).get(id).size) || 0;

      this.db.prepare('DELETE FROM archive_artifacts WHERE batch_id = ?').run(id);
      this.db.prepare('DELETE FROM archive_batches WHERE id = ?').run(id);

      const releasedBlobs = [];
      for (const blob of candidateBlobs) {
        const remaining = Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM archive_artifacts WHERE blob_id = ?
        `).get(Number(blob.id)).count);
        if (remaining > 0) continue;
        this.db.prepare('DELETE FROM archive_blobs WHERE id = ?').run(Number(blob.id));
        releasedBlobs.push(mapBlob({ ...blob, reference_count: 0 }));
      }
      return {
        status: 'deleted',
        batch,
        artifactCount,
        logicalBytes,
        releasedBlobs
      };
    });
  }

  getStats() {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM archive_batches) AS batch_count,
        (SELECT COUNT(*) FROM archive_batches WHERE locked = 1) AS locked_batch_count,
        (SELECT COUNT(*) FROM archive_artifacts) AS logical_file_count,
        (SELECT COUNT(*) FROM archive_artifacts WHERE status = 'failed') AS failed_file_count,
        (SELECT COUNT(*) FROM archive_blobs) AS unique_file_count,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM archive_blobs) AS unique_bytes,
        (
          SELECT COALESCE(SUM(bl.size_bytes), 0)
          FROM archive_artifacts a
          JOIN archive_blobs bl ON bl.id = a.blob_id
          WHERE a.status = 'ready'
        ) AS logical_bytes
    `).get();
    return {
      batchCount: Number(row.batch_count) || 0,
      lockedBatchCount: Number(row.locked_batch_count) || 0,
      logicalFileCount: Number(row.logical_file_count) || 0,
      failedFileCount: Number(row.failed_file_count) || 0,
      uniqueFileCount: Number(row.unique_file_count) || 0,
      uniqueBytes: Number(row.unique_bytes) || 0,
      logicalBytes: Number(row.logical_bytes) || 0
    };
  }
}

function createArchiveRepository(db, options = {}) {
  return new ArchiveRepository(db, options);
}

module.exports = {
  ArchiveRepository,
  ARTIFACT_STATUSES,
  BATCH_ARCHIVE_STATUSES,
  createArchiveRepository,
  ensureArchiveMetadataSupport,
  formatBatchNumber,
  normalizeLocalDate
};
