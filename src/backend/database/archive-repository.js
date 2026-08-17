'use strict';

const crypto = require('node:crypto');

// 存档中心只在主库保存轻量元数据：
//   archive_batches   一次业务操作对应的本地日期流水批次；
//   archive_batch_sequences 不因批次删除而回退的本地日期流水游标；
//   archive_operation_issuances 跨永久删除保留 operation key 的发行事实；
//   archive_artifacts 批次中的逻辑文件及失败重试信息；
//   archive_blobs     以 SHA-256 寻址的唯一物理文件；
//   archive_cleanup_jobs 已删批次尚待完成的物理回收证据。
//
// 本文件不创建 DatabaseSync。调用方注入已经打开的数据库句柄，并显式调用
// ensureArchiveMetadataSupport/createArchiveRepository(...).ensureSchema()。

const BATCH_ARCHIVE_STATUSES = Object.freeze({
  STAGING: 'staging',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete'
});

const BATCH_TASK_STATUSES = Object.freeze({
  RESERVED: 'reserved',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const BATCH_FORMAT_VERSIONS = Object.freeze({
  LEGACY: 1,
  GLOBAL: 2
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHIVE_INSTANCE_ID_SETTING_KEY = 'archive_center_instance_id';
const ARCHIVE_STORAGE_ROOT_SETTING_KEY = 'archive_center_storage_root';

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

function normalizeTaskStatus(value) {
  const status = requiredText(value, 'taskStatus', 32).toLowerCase();
  if (!Object.values(BATCH_TASK_STATUSES).includes(status)) {
    throw new TypeError(`taskStatus 非法：${status}`);
  }
  return status;
}

function normalizeFlowAnchorIdentity(payload = {}) {
  const identityType = requiredText(payload.identityType, 'identityType', 64).toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(identityType)) {
    throw new TypeError('identityType 只能包含小写字母、数字、点、下划线和连字符');
  }
  return {
    moduleId: normalizeModuleId(payload.moduleId),
    identityType,
    identityValue: requiredText(payload.identityValue, 'identityValue', 1024)
  };
}

function normalizeArtifactHoldIdentity(payload = {}) {
  return {
    ownerModule: normalizeModuleId(payload.ownerModule),
    ownerType: requiredText(payload.ownerType, 'ownerType', 64).toLowerCase(),
    ownerId: requiredText(payload.ownerId, 'ownerId', 256)
  };
}

function parseObjectJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function parseArrayJson(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
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

function localDateOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now() 必须返回有效日期');
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addCalendarDays(localDate, days) {
  const normalized = normalizeLocalDate(localDate);
  const count = Number(days);
  if (!Number.isSafeInteger(count) || count < 1 || count > 36500) {
    throw new TypeError('retentionDays 必须是 1 到 36500 的安全整数');
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
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

function formatGlobalBatchNumber(localDate, dailySequence) {
  const date = normalizeLocalDate(localDate);
  const sequence = Number(dailySequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('dailySequence 必须是正安全整数');
  }
  return `${date}-${String(sequence).padStart(3, '0')}`;
}

function layoutRelativeDirectoryForBatch(batch) {
  const localDate = normalizeLocalDate(batch.localDate);
  const batchNumber = requiredText(batch.batchNumber, 'batchNumber', 128);
  return `${localDate.slice(0, 4)}/${localDate.slice(0, 7)}/${localDate}/${batchNumber}`;
}

function addColumnsIfMissing(db, tableName, definitions) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name))
  );
  for (const [columnName, definition] of definitions) {
    if (columns.has(columnName)) continue;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
    columns.add(columnName);
  }
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
  withWriteTransaction(db, () => {
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

    CREATE TABLE IF NOT EXISTS archive_artifact_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id INTEGER NOT NULL,
      owner_module TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (artifact_id) REFERENCES archive_artifacts(id) ON DELETE RESTRICT,
      UNIQUE (artifact_id, owner_module, owner_type, owner_id)
    );

    CREATE INDEX IF NOT EXISTS idx_archive_artifact_holds_owner
      ON archive_artifact_holds(owner_module, owner_type, owner_id);
    `);

    addColumnsIfMissing(db, 'archive_batches', [
      ['batch_format_version', 'batch_format_version INTEGER NOT NULL DEFAULT 1 CHECK (batch_format_version IN (1, 2))'],
      ['global_daily_sequence', 'global_daily_sequence INTEGER CHECK (global_daily_sequence IS NULL OR global_daily_sequence > 0)'],
      ['task_key', 'task_key TEXT'],
      ['task_run_id', 'task_run_id TEXT'],
      ['parent_run_id', 'parent_run_id TEXT'],
      ['task_status', "task_status TEXT NOT NULL DEFAULT 'succeeded' CHECK (task_status IN ('reserved', 'running', 'succeeded', 'failed', 'cancelled'))"],
      ['reserved_at', 'reserved_at TEXT'],
      ['started_at', 'started_at TEXT'],
      ['finished_at', 'finished_at TEXT'],
      ['failure_code', 'failure_code TEXT'],
      ['failure_message', 'failure_message TEXT']
    ]);

    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_operation_issuances (
        module_id TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        batch_id INTEGER NOT NULL,
        batch_number TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (module_id, operation_key)
      );

      INSERT INTO archive_operation_issuances (
        module_id, operation_key, batch_id, batch_number, issued_at, deleted_at
      )
      SELECT
        module_id,
        operation_key,
        id,
        batch_number,
        COALESCE(reserved_at, created_at),
        NULL
      FROM archive_batches
      WHERE operation_key <> ''
      ON CONFLICT(module_id, operation_key) DO NOTHING;

      INSERT INTO archive_batch_sequences (module_code, local_date, last_sequence)
      SELECT module_code, local_date, MAX(daily_sequence)
      FROM archive_batches
      WHERE batch_format_version = 1
      GROUP BY module_code, local_date
      ON CONFLICT(module_code, local_date) DO UPDATE SET
        last_sequence = MAX(archive_batch_sequences.last_sequence, excluded.last_sequence);
    `);

    addColumnsIfMissing(db, 'archive_artifacts', [
      ['storage_relative_path', 'storage_relative_path TEXT'],
      ['storage_mode', 'storage_mode TEXT'],
      ['storage_layout_version', 'storage_layout_version INTEGER NOT NULL DEFAULT 1'],
      ['safe_file_name', 'safe_file_name TEXT'],
      ['artifact_order', 'artifact_order INTEGER'],
      ['materialization_error_code', 'materialization_error_code TEXT'],
      ['materialization_error_message', 'materialization_error_message TEXT'],
      ['materialization_failed_at', 'materialization_failed_at TEXT']
    ]);

    db.exec(`
      UPDATE archive_artifacts AS target
      SET artifact_order = (
        SELECT COUNT(*)
        FROM archive_artifacts AS prior
        WHERE prior.batch_id = target.batch_id AND prior.id <= target.id
      )
      WHERE target.artifact_order IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM archive_artifacts AS assigned
          WHERE assigned.batch_id = target.batch_id
            AND assigned.artifact_order IS NOT NULL
        );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_cleanup_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL UNIQUE,
        batch_number TEXT NOT NULL,
        local_date TEXT NOT NULL,
        layout_relative_dir TEXT NOT NULL,
        materialized_paths_json TEXT NOT NULL DEFAULT '[]',
        released_blobs_json TEXT NOT NULL DEFAULT '[]',
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_daily_sequences (
        local_date TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
        updated_at TEXT NOT NULL,
        -- latest issuance 必须在批次永久删除后保留，因此不引用 archive_batches 外键。
        last_issued_batch_id INTEGER,
        last_issued_batch_number TEXT,
        last_issued_at TEXT
      );

    `);

    addColumnsIfMissing(db, 'archive_daily_sequences', [
      ['last_issued_batch_id', 'last_issued_batch_id INTEGER'],
      ['last_issued_batch_number', 'last_issued_batch_number TEXT'],
      ['last_issued_at', 'last_issued_at TEXT']
    ]);

    db.exec(`

      INSERT INTO archive_daily_sequences (local_date, last_sequence, updated_at)
      SELECT
        s.local_date,
        SUM(s.last_sequence),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM archive_batch_sequences s
      GROUP BY s.local_date
      ON CONFLICT(local_date) DO UPDATE SET
        last_sequence = MAX(archive_daily_sequences.last_sequence, excluded.last_sequence),
        updated_at = CASE
          WHEN excluded.last_sequence > archive_daily_sequences.last_sequence
            THEN excluded.updated_at
          ELSE archive_daily_sequences.updated_at
        END;

      CREATE TABLE IF NOT EXISTS archive_flow_anchors (
        module_id TEXT NOT NULL,
        identity_type TEXT NOT NULL,
        identity_value TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        source_batch_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (module_id, identity_type, identity_value),
        FOREIGN KEY (source_batch_id) REFERENCES archive_batches(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_archive_flow_anchors_parent_run
        ON archive_flow_anchors(parent_run_id);

      CREATE TABLE IF NOT EXISTS archive_flow_bind_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        identity_type TEXT NOT NULL,
        identity_value TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        source_batch_id INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (module_id, identity_type, identity_value),
        FOREIGN KEY (source_batch_id) REFERENCES archive_batches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_archive_flow_bind_intents_source_batch
        ON archive_flow_bind_intents(source_batch_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_batches_global_daily_sequence
        ON archive_batches(local_date, global_daily_sequence)
        WHERE global_daily_sequence IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_archive_batches_parent_run
        ON archive_batches(parent_run_id, local_date, global_daily_sequence)
        WHERE parent_run_id IS NOT NULL AND parent_run_id <> '';
    `);
  });
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
    batchFormatVersion: Number(row.batch_format_version) || BATCH_FORMAT_VERSIONS.LEGACY,
    globalDailySequence: row.global_daily_sequence == null
      ? null
      : Number(row.global_daily_sequence),
    taskKey: row.task_key || '',
    taskRunId: row.task_run_id || '',
    parentRunId: row.parent_run_id || '',
    taskStatus: row.task_status || BATCH_TASK_STATUSES.SUCCEEDED,
    reservedAt: row.reserved_at || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    failureCode: row.failure_code || '',
    failureMessage: row.failure_message || '',
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
    logicalBytes: Number(row.logical_bytes) || 0,
    businessHoldCount: Number(row.business_hold_count) || 0,
    businessLocked: Number(row.business_hold_count) > 0
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
  const businessHoldCount = Number(row.business_hold_count) || 0;
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
    storageRelativePath: row.storage_relative_path || '',
    storageMode: row.storage_mode || '',
    storageLayoutVersion: Number(row.storage_layout_version) || 1,
    safeFileName: row.safe_file_name || '',
    artifactOrder: row.artifact_order == null ? null : Number(row.artifact_order),
    materializationErrorCode: row.materialization_error_code || '',
    materializationErrorMessage: row.materialization_error_message || '',
    materializationFailedAt: row.materialization_failed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null,
    businessHoldCount,
    businessLocked: businessHoldCount > 0
  };
}

function mapArtifactHold(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    artifactId: Number(row.artifact_id),
    ownerModule: row.owner_module,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    reason: row.reason,
    createdAt: row.created_at
  };
}

function mapCleanupJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    batchNumber: row.batch_number,
    localDate: row.local_date,
    layoutRelativeDir: row.layout_relative_dir,
    materializedPaths: parseArrayJson(row.materialized_paths_json),
    releasedBlobs: parseArrayJson(row.released_blobs_json),
    attemptCount: Number(row.attempt_count) || 0,
    lastErrorCode: row.last_error_code || '',
    lastErrorMessage: row.last_error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFlowAnchor(row) {
  if (!row) return null;
  return {
    moduleId: row.module_id,
    identityType: row.identity_type,
    identityValue: row.identity_value,
    parentRunId: row.parent_run_id,
    sourceBatchId: row.source_batch_id == null ? null : Number(row.source_batch_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOperationIssuance(row) {
  if (!row) return null;
  return {
    moduleId: row.module_id,
    operationKey: row.operation_key,
    batchId: Number(row.batch_id),
    batchNumber: row.batch_number,
    issuedAt: row.issued_at,
    deletedAt: row.deleted_at || null
  };
}

function mapFlowBindIntent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    moduleId: row.module_id,
    identityType: row.identity_type,
    identityValue: row.identity_value,
    parentRunId: row.parent_run_id,
    sourceBatchId: Number(row.source_batch_id),
    attemptCount: Number(row.attempt_count) || 0,
    lastErrorCode: row.last_error_code || '',
    lastErrorMessage: row.last_error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const BATCH_SELECT = `
  SELECT
    b.*,
    COUNT(a.id) AS artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_artifact_count,
    COALESCE(SUM(CASE WHEN a.status = 'ready' THEN bl.size_bytes ELSE 0 END), 0) AS logical_bytes,
    (SELECT COUNT(*)
       FROM archive_artifacts held_artifact
       JOIN archive_artifact_holds hold ON hold.artifact_id = held_artifact.id
      WHERE held_artifact.batch_id = b.id) AS business_hold_count
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
    bl.relative_path AS blob_relative_path,
    (SELECT COUNT(*) FROM archive_artifact_holds h WHERE h.artifact_id = a.id)
      AS business_hold_count
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

  getOrCreateArchiveInstanceId() {
    return withWriteTransaction(this.db, () => {
      const candidate = crypto.randomUUID();
      const timestamp = this._timestamp();
      this.db.prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `).run(ARCHIVE_INSTANCE_ID_SETTING_KEY, candidate, timestamp);
      const row = this.db.prepare(`
        SELECT setting_value AS value
        FROM app_settings
        WHERE setting_key = ?
      `).get(ARCHIVE_INSTANCE_ID_SETTING_KEY);
      const instanceId = String(row && row.value || '').trim();
      if (!UUID_RE.test(instanceId)) {
        const error = new Error('存档实例 ID 无效，无法确认存档根所有权');
        error.code = 'ARCHIVE_INSTANCE_ID_INVALID';
        throw error;
      }
      return instanceId.toLowerCase();
    });
  }

  commitStorageRootSwitch(payload = {}) {
    const storageRoot = requiredText(payload.storageRoot, 'storageRoot', 4096);
    const expectedStoredRoot = payload.expectedStoredRoot == null
      ? null
      : requiredText(payload.expectedStoredRoot, 'expectedStoredRoot', 4096);
    const materializations = Array.isArray(payload.materializations)
      ? payload.materializations
      : [];
    const byId = new Map();
    for (const item of materializations) {
      const artifactId = Number(item && item.artifactId);
      const storageMode = requiredText(item && item.storageMode, 'storageMode', 32);
      if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
        throw new TypeError('artifactId 必须是正安全整数');
      }
      if (!['hardlink', 'copy'].includes(storageMode)) {
        throw new TypeError(`storageMode 非法：${storageMode}`);
      }
      if (byId.has(artifactId)) throw new TypeError(`artifactId 重复：${artifactId}`);
      byId.set(artifactId, storageMode);
    }

    return withWriteTransaction(this.db, () => {
      const stored = this.db.prepare(`
        SELECT setting_value AS value
        FROM app_settings
        WHERE setting_key = ?
      `).get(ARCHIVE_STORAGE_ROOT_SETTING_KEY);
      const currentStoredRoot = stored ? String(stored.value) : null;
      if (currentStoredRoot !== expectedStoredRoot) {
        const error = new Error('存档根设置已变化，拒绝提交迁移');
        error.code = 'ARCHIVE_STORAGE_ROOT_CONFLICT';
        throw error;
      }

      const readyArtifacts = this.db.prepare(`
        SELECT id, storage_layout_version, storage_relative_path,
               safe_file_name, artifact_order
        FROM archive_artifacts
        WHERE status = 'ready'
        ORDER BY id ASC
      `).all();
      if (readyArtifacts.length !== byId.size
          || readyArtifacts.some((artifact) => !byId.has(Number(artifact.id)))) {
        const error = new Error('目标目录化结果未覆盖全部 ready artifact');
        error.code = 'ARCHIVE_STORAGE_MATERIALIZATION_INCOMPLETE';
        throw error;
      }
      for (const artifact of readyArtifacts) {
        if (Number(artifact.storage_layout_version) !== 2
            || !String(artifact.storage_relative_path || '')
            || !String(artifact.safe_file_name || '')
            || !Number.isSafeInteger(Number(artifact.artifact_order))) {
          const error = new Error(`ready artifact ${artifact.id} 缺少 layout v2 证据`);
          error.code = 'ARCHIVE_STORAGE_LAYOUT_INCOMPLETE';
          throw error;
        }
      }

      const timestamp = this._timestamp();
      const updateArtifact = this.db.prepare(`
        UPDATE archive_artifacts
        SET storage_mode = ?, materialization_error_code = NULL,
            materialization_error_message = NULL, materialization_failed_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'ready'
      `);
      for (const artifact of readyArtifacts) {
        const result = updateArtifact.run(
          byId.get(Number(artifact.id)),
          timestamp,
          Number(artifact.id)
        );
        if (result.changes !== 1) throw new Error(`ready artifact ${artifact.id} 更新失败`);
      }
      this.db.prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
      `).run(ARCHIVE_STORAGE_ROOT_SETTING_KEY, storageRoot, timestamp);
      return {
        storageRoot,
        materializedArtifactCount: readyArtifacts.length
      };
    });
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

  getOperationIssuance(moduleId, operationKey) {
    const normalizedModuleId = normalizeModuleId(moduleId);
    const normalizedOperationKey = requiredText(operationKey, 'operationKey', 256);
    return mapOperationIssuance(this.db.prepare(`
      SELECT *
      FROM archive_operation_issuances
      WHERE module_id = ? AND operation_key = ?
    `).get(normalizedModuleId, normalizedOperationKey));
  }

  getLatestIssuedBatch() {
    const row = this.db.prepare(`
      SELECT
        d.local_date,
        d.last_issued_batch_id,
        d.last_issued_batch_number,
        d.last_issued_at,
        b.task_status
      FROM archive_daily_sequences d
      LEFT JOIN archive_batches b ON b.id = d.last_issued_batch_id
      WHERE d.last_issued_batch_id IS NOT NULL
        AND d.last_issued_batch_number IS NOT NULL
        AND d.last_issued_at IS NOT NULL
      ORDER BY d.last_issued_batch_id DESC
      LIMIT 1
    `).get();
    if (!row) return null;
    const match = /-(\d+)$/.exec(row.last_issued_batch_number);
    const sequence = match ? Number(match[1]) : null;
    return {
      batchId: row.last_issued_batch_id == null ? null : Number(row.last_issued_batch_id),
      batchNumber: row.last_issued_batch_number,
      localDate: row.local_date,
      dailySequence: sequence,
      globalDailySequence: sequence,
      issuedAt: row.last_issued_at,
      taskStatus: row.task_status || null
    };
  }

  listRelatedBatches(parentRunId) {
    const normalizedParentRunId = requiredText(parentRunId, 'parentRunId', 256);
    return this.db.prepare(`
      ${BATCH_SELECT}
      WHERE b.parent_run_id = ?
      GROUP BY b.id
      ORDER BY b.local_date ASC, b.global_daily_sequence ASC, b.id ASC
    `).all(normalizedParentRunId).map(mapBatch);
  }

  findFlowAnchor(payload = {}) {
    const identity = normalizeFlowAnchorIdentity(payload);
    return mapFlowAnchor(this.db.prepare(`
      SELECT *
      FROM archive_flow_anchors
      WHERE module_id = ? AND identity_type = ? AND identity_value = ?
    `).get(identity.moduleId, identity.identityType, identity.identityValue));
  }

  bindFlowAnchor(payload = {}) {
    const identity = normalizeFlowAnchorIdentity(payload);
    const parentRunId = requiredText(payload.parentRunId, 'parentRunId', 256);
    let sourceBatchId = null;
    if (payload.sourceBatchId !== undefined && payload.sourceBatchId !== null) {
      sourceBatchId = Number(payload.sourceBatchId);
      if (!Number.isSafeInteger(sourceBatchId) || sourceBatchId < 1) {
        throw new TypeError('sourceBatchId 必须是正安全整数');
      }
    }
    const timestamp = this._timestamp();

    return withWriteTransaction(this.db, () => {
      if (sourceBatchId !== null) {
        const sourceBatch = this.db.prepare(`
          SELECT id, module_id, parent_run_id FROM archive_batches WHERE id = ?
        `).get(sourceBatchId);
        if (!sourceBatch) throw new Error(`存档批次不存在：${sourceBatchId}`);
        if (sourceBatch.module_id !== identity.moduleId
            || sourceBatch.parent_run_id !== parentRunId) {
          const error = new Error('业务身份锚点与来源批次的归属不一致');
          error.code = 'ARCHIVE_FLOW_ANCHOR_CONFLICT';
          throw error;
        }
      }

      const existing = this.findFlowAnchor(identity);
      if (existing) {
        if (existing.parentRunId !== parentRunId) {
          const error = new Error('业务身份已绑定到不同的任务流程');
          error.code = 'ARCHIVE_FLOW_ANCHOR_CONFLICT';
          throw error;
        }
        if (existing.sourceBatchId === null && sourceBatchId !== null) {
          this.db.prepare(`
            UPDATE archive_flow_anchors
            SET source_batch_id = ?, updated_at = ?
            WHERE module_id = ? AND identity_type = ? AND identity_value = ?
          `).run(
            sourceBatchId,
            timestamp,
            identity.moduleId,
            identity.identityType,
            identity.identityValue
          );
          return { created: false, anchor: this.findFlowAnchor(identity) };
        }
        return { created: false, anchor: existing };
      }

      this.db.prepare(`
        INSERT INTO archive_flow_anchors (
          module_id, identity_type, identity_value, parent_run_id,
          source_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.moduleId,
        identity.identityType,
        identity.identityValue,
        parentRunId,
        sourceBatchId,
        timestamp,
        timestamp
      );
      return { created: true, anchor: this.findFlowAnchor(identity) };
    });
  }

  listFlowBindIntents(filters = {}) {
    const where = [];
    const params = [];
    if (filters.moduleId !== undefined && filters.moduleId !== null && filters.moduleId !== '') {
      where.push('module_id = ?');
      params.push(normalizeModuleId(filters.moduleId));
    }
    if (filters.identityType !== undefined
        || filters.identityValue !== undefined) {
      const identity = normalizeFlowAnchorIdentity(filters);
      if (!where.includes('module_id = ?')) {
        where.push('module_id = ?');
        params.push(identity.moduleId);
      }
      where.push('identity_type = ?', 'identity_value = ?');
      params.push(identity.identityType, identity.identityValue);
    }
    const sqlWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT * FROM archive_flow_bind_intents
      ${sqlWhere}
      ORDER BY id ASC
    `).all(...params).map(mapFlowBindIntent);
  }

  persistFlowBindIntent(payload = {}) {
    const identity = normalizeFlowAnchorIdentity(payload);
    const parentRunId = requiredText(payload.parentRunId, 'parentRunId', 256);
    const sourceBatchId = Number(payload.sourceBatchId);
    if (!Number.isSafeInteger(sourceBatchId) || sourceBatchId < 1) {
      throw new TypeError('sourceBatchId 必须是正安全整数');
    }
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const sourceBatch = this.db.prepare(`
        SELECT id, module_id, parent_run_id FROM archive_batches WHERE id = ?
      `).get(sourceBatchId);
      if (!sourceBatch) throw new Error(`存档批次不存在：${sourceBatchId}`);
      if (sourceBatch.module_id !== identity.moduleId
          || String(sourceBatch.parent_run_id || '') !== parentRunId) {
        const error = new Error('flow-bind intent 与来源批次的归属不一致');
        error.code = 'ARCHIVE_FLOW_BIND_INTENT_CONFLICT';
        throw error;
      }

      const anchor = this.findFlowAnchor(identity);
      if (anchor) {
        if (anchor.parentRunId !== parentRunId) {
          const error = new Error('flow-bind intent 与已存在身份锚点冲突');
          error.code = 'ARCHIVE_FLOW_BIND_INTENT_CONFLICT';
          throw error;
        }
        return { created: false, resolved: true, intent: null, anchor };
      }

      const existing = this.db.prepare(`
        SELECT * FROM archive_flow_bind_intents
        WHERE module_id = ? AND identity_type = ? AND identity_value = ?
      `).get(identity.moduleId, identity.identityType, identity.identityValue);
      if (existing) {
        const intent = mapFlowBindIntent(existing);
        if (intent.parentRunId !== parentRunId) {
          const error = new Error('业务身份已有不同的 flow-bind intent');
          error.code = 'ARCHIVE_FLOW_BIND_INTENT_CONFLICT';
          throw error;
        }
        return { created: false, resolved: false, intent };
      }

      const inserted = this.db.prepare(`
        INSERT INTO archive_flow_bind_intents (
          module_id, identity_type, identity_value, parent_run_id,
          source_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        identity.moduleId,
        identity.identityType,
        identity.identityValue,
        parentRunId,
        sourceBatchId,
        timestamp,
        timestamp
      );
      const intent = mapFlowBindIntent(this.db.prepare(`
        SELECT * FROM archive_flow_bind_intents WHERE id = ?
      `).get(Number(inserted.lastInsertRowid)));
      return { created: true, resolved: false, intent };
    });
  }

  replayFlowBindIntents(filters = {}) {
    const intents = this.listFlowBindIntents(filters);
    const results = [];
    for (const intent of intents) {
      try {
        const bound = this.bindFlowAnchor(intent);
        this.db.prepare('DELETE FROM archive_flow_bind_intents WHERE id = ?').run(intent.id);
        results.push({ ok: true, intent, anchor: bound.anchor });
      } catch (error) {
        const code = optionalText(
          error && error.code || 'ARCHIVE_FLOW_BIND_REPLAY_FAILED',
          128
        ) || 'ARCHIVE_FLOW_BIND_REPLAY_FAILED';
        const message = optionalText(
          error && error.message || 'flow-bind intent 重放失败',
          512
        ) || 'flow-bind intent 重放失败';
        this.db.prepare(`
          UPDATE archive_flow_bind_intents
          SET attempt_count = attempt_count + 1,
              last_error_code = ?, last_error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(code, message, this._timestamp(), intent.id);
        results.push({ ok: false, intent, code, message });
      }
    }
    return {
      attempted: results.length,
      replayed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results
    };
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

  listMaterializationCandidates(limit = 500, afterArtifactId = 0) {
    const count = Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 5000) {
      throw new TypeError('limit 必须为 1 到 5000 的安全整数');
    }
    const cursor = Number(afterArtifactId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('afterArtifactId 必须为非负安全整数');
    }
    const rows = this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.status = 'ready'
        AND a.id > ?
        AND (
          a.storage_layout_version <> 2
          OR COALESCE(a.storage_relative_path, '') = ''
          OR COALESCE(a.storage_mode, '') NOT IN ('hardlink', 'copy')
          OR COALESCE(a.safe_file_name, '') = ''
          OR a.artifact_order IS NULL
          OR a.materialization_error_code IS NOT NULL
          OR a.materialization_error_message IS NOT NULL
          OR a.materialization_failed_at IS NOT NULL
        )
      ORDER BY a.id ASC
      LIMIT ?
    `).all(cursor, count).map(mapArtifact);
    return rows.map((artifact) => ({ ...artifact, batch: this.getBatch(artifact.batchId) }));
  }

  countMaterializationCandidates() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_artifacts a
      WHERE a.status = 'ready'
        AND (
          a.storage_layout_version <> 2
          OR COALESCE(a.storage_relative_path, '') = ''
          OR COALESCE(a.storage_mode, '') NOT IN ('hardlink', 'copy')
          OR COALESCE(a.safe_file_name, '') = ''
          OR a.artifact_order IS NULL
          OR a.materialization_error_code IS NOT NULL
          OR a.materialization_error_message IS NOT NULL
          OR a.materialization_failed_at IS NOT NULL
        )
    `).get();
    return Number(row && row.count) || 0;
  }

  listMaterializedArtifacts() {
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.status = 'ready'
        AND a.storage_layout_version = 2
        AND COALESCE(a.storage_relative_path, '') <> ''
      ORDER BY a.batch_id ASC, a.artifact_order ASC, a.id ASC
    `).all().map(mapArtifact);
  }

  listMaterializedArtifactsPage(limit = 500, afterArtifactId = 0) {
    const count = Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 5000) {
      throw new TypeError('limit 必须为 1 到 5000 的安全整数');
    }
    const cursor = Number(afterArtifactId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('afterArtifactId 必须为非负安全整数');
    }
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.status = 'ready'
        AND a.id > ?
        AND a.storage_layout_version = 2
        AND COALESCE(a.storage_relative_path, '') <> ''
        AND COALESCE(a.storage_mode, '') IN ('hardlink', 'copy')
        AND COALESCE(a.safe_file_name, '') <> ''
        AND a.artifact_order IS NOT NULL
        AND a.materialization_error_code IS NULL
        AND a.materialization_error_message IS NULL
        AND a.materialization_failed_at IS NULL
      ORDER BY a.id ASC
      LIMIT ?
    `).all(cursor, count).map(mapArtifact);
  }

  countMaterializedArtifactsAfter(afterArtifactId = 0) {
    const cursor = Number(afterArtifactId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('afterArtifactId 必须为非负安全整数');
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_artifacts a
      WHERE a.status = 'ready'
        AND a.id > ?
        AND a.storage_layout_version = 2
        AND COALESCE(a.storage_relative_path, '') <> ''
        AND COALESCE(a.storage_mode, '') IN ('hardlink', 'copy')
        AND COALESCE(a.safe_file_name, '') <> ''
        AND a.artifact_order IS NOT NULL
        AND a.materialization_error_code IS NULL
        AND a.materialization_error_message IS NULL
        AND a.materialization_failed_at IS NULL
    `).get(cursor);
    return Number(row && row.count) || 0;
  }

  listReadyArtifacts() {
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.status = 'ready'
      ORDER BY a.batch_id ASC, COALESCE(a.artifact_order, a.id) ASC, a.id ASC
    `).all().map(mapArtifact);
  }

  listArtifactsByBlob(blobId) {
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      WHERE a.blob_id = ?
      ORDER BY a.id ASC
    `).all(Number(blobId)).map(mapArtifact);
  }

  listUnresolvedArtifactSourcePaths() {
    return this.db.prepare(`
      SELECT source_path
      FROM archive_artifacts
      WHERE status IN ('pending', 'failed') AND source_path <> ''
      ORDER BY id ASC
    `).all().map((row) => String(row.source_path));
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
        const issuance = this.getOperationIssuance(moduleId, operationKey);
        if (issuance && issuance.deletedAt) {
          return { created: false, status: 'deleted', batch: null, issuance };
        }
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
      let dailySequence = Number(sequenceRow.last_sequence);
      while (this.db.prepare(`
        SELECT 1
        FROM archive_batches
        WHERE module_code = ? AND local_date = ? AND daily_sequence = ?
      `).get(moduleCode, localDate, dailySequence)) {
        this.db.prepare(`
          UPDATE archive_batch_sequences
          SET last_sequence = last_sequence + 1
          WHERE module_code = ? AND local_date = ?
        `).run(moduleCode, localDate);
        dailySequence += 1;
      }
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
      const batchId = Number(result.lastInsertRowid);
      if (operationKey) {
        this.db.prepare(`
          INSERT INTO archive_operation_issuances (
            module_id, operation_key, batch_id, batch_number, issued_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
        `).run(moduleId, operationKey, batchId, batchNumber, timestamp);
      }
      this.db.prepare(`
        INSERT INTO archive_daily_sequences (local_date, last_sequence, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(local_date) DO UPDATE SET
          last_sequence = archive_daily_sequences.last_sequence + 1,
          updated_at = excluded.updated_at
      `).run(localDate, timestamp);
      return { created: true, batch: this.getBatch(batchId) };
    });
  }

  reserveTaskBatch(payload = {}) {
    if (Object.prototype.hasOwnProperty.call(payload, 'batchNumber')) {
      throw new TypeError('batchNumber 只能由存档中心分配');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'localDate')) {
      throw new TypeError('task 批次 localDate 只能由存档中心时钟生成');
    }
    const moduleId = normalizeModuleId(payload.moduleId);
    const moduleCode = normalizeModuleCode(payload.moduleCode || payload.moduleId);
    const moduleName = requiredText(payload.moduleName || payload.moduleId, 'moduleName', 128);
    const operationKey = requiredText(payload.operationKey, 'operationKey', 256);
    const taskKey = requiredText(payload.taskKey, 'taskKey', 128);
    const taskRunId = optionalText(payload.taskRunId, 256);
    const parentRunId = optionalText(payload.parentRunId, 256);
    const businessStatus = optionalText(payload.businessStatus, 64);
    const metadataJson = normalizeMetadata(payload.metadata);
    const locked = payload.locked === true ? 1 : 0;

    return withWriteTransaction(this.db, () => {
      const issuance = this.getOperationIssuance(moduleId, operationKey);
      if (issuance && issuance.deletedAt) {
        return { created: false, status: 'deleted', batch: null, issuance };
      }
      const existing = this.db.prepare(`
        SELECT id FROM archive_batches WHERE module_id = ? AND operation_key = ?
      `).get(moduleId, operationKey);
      if (existing) return { created: false, batch: this.getBatch(existing.id) };

      const reservedAt = this.now();
      const timestamp = dateToIso(reservedAt);
      const localDate = localDateOf(reservedAt);
      const retentionUntil = payload.retentionUntil !== undefined
        ? normalizeRetentionUntil(payload.retentionUntil, localDate)
        : payload.retentionDays === null || payload.retentionDays === 'permanent'
          ? null
          : payload.retentionDays === undefined
            ? null
            : addCalendarDays(localDate, payload.retentionDays);

      this.db.prepare(`
        INSERT INTO archive_daily_sequences (local_date, last_sequence, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(local_date) DO UPDATE SET
          last_sequence = archive_daily_sequences.last_sequence + 1,
          updated_at = excluded.updated_at
      `).run(localDate, timestamp);
      const sequenceRow = this.db.prepare(`
        SELECT last_sequence
        FROM archive_daily_sequences
        WHERE local_date = ?
      `).get(localDate);
      const globalDailySequence = Number(sequenceRow.last_sequence);
      const batchNumber = formatGlobalBatchNumber(localDate, globalDailySequence);
      const result = this.db.prepare(`
        INSERT INTO archive_batches (
          batch_number, module_id, module_code, module_name, operation_key,
          local_date, daily_sequence, business_status, archive_status,
          locked, retention_until, metadata_json, created_at, updated_at,
          batch_format_version, global_daily_sequence, task_key, task_run_id,
          parent_run_id, task_status, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, 'reserved', ?)
      `).run(
        batchNumber,
        moduleId,
        moduleCode,
        moduleName,
        operationKey,
        localDate,
        globalDailySequence,
        businessStatus,
        locked,
        retentionUntil,
        metadataJson,
        timestamp,
        timestamp,
        globalDailySequence,
        taskKey,
        taskRunId || null,
        parentRunId || null,
        timestamp
      );
      const batchId = Number(result.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO archive_operation_issuances (
          module_id, operation_key, batch_id, batch_number, issued_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `).run(moduleId, operationKey, batchId, batchNumber, timestamp);
      this.db.prepare(`
        UPDATE archive_daily_sequences
        SET last_issued_batch_id = ?,
            last_issued_batch_number = ?,
            last_issued_at = ?
        WHERE local_date = ?
      `).run(batchId, batchNumber, timestamp, localDate);
      return { created: true, batch: this.getBatch(batchId) };
    });
  }

  beginTaskRecovery(batchContext = {}, options = {}) {
    const id = Number(batchContext.batchId);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('batchContext.batchId 必须是正安全整数');
    }
    const expectedIdentity = {
      batchNumber: requiredText(batchContext.batchNumber, 'batchContext.batchNumber', 128),
      taskRunId: requiredText(batchContext.taskRunId, 'batchContext.taskRunId', 256),
      taskKey: requiredText(batchContext.taskKey, 'batchContext.taskKey', 128),
      moduleId: normalizeModuleId(batchContext.moduleId),
      parentRunId: requiredText(batchContext.parentRunId, 'batchContext.parentRunId', 256),
      operationKey: requiredText(batchContext.operationKey, 'batchContext.operationKey', 256),
    };
    const evidence = options.evidence === undefined ? {} : options.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new TypeError('recovery evidence 必须是对象');
    }
    const timestamp = this._timestamp();

    return withWriteTransaction(this.db, () => {
      const current = this.getBatch(id);
      if (!current) {
        return { status: 'not-found', updated: false, batch: null };
      }
      const mismatchedField = Object.entries(expectedIdentity).find(
        ([field, value]) => String(current[field] || '') !== String(value)
      );
      if (mismatchedField) {
        return {
          status: 'identity-conflict',
          updated: false,
          mismatchedField: mismatchedField[0],
          batch: current
        };
      }
      if (current.taskStatus === BATCH_TASK_STATUSES.SUCCEEDED) {
        return { status: 'succeeded-conflict', updated: false, batch: current };
      }
      if (![BATCH_TASK_STATUSES.RUNNING, BATCH_TASK_STATUSES.FAILED, BATCH_TASK_STATUSES.CANCELLED]
        .includes(current.taskStatus)) {
        return { status: 'status-conflict', updated: false, batch: current };
      }

      const previousRecovery = current.metadata && current.metadata.recovery;
      const previousCount = Number(previousRecovery && previousRecovery.recoveryCount);
      const recoveryMetadata = {
        previousTaskStatus: current.taskStatus,
        previousFailureCode: current.failureCode || '',
        previousFailureMessage: current.failureMessage || '',
        previousFinishedAt: current.finishedAt || null,
        recoveryCount: Number.isSafeInteger(previousCount) && previousCount >= 0
          ? previousCount + 1
          : 1,
        evidence: { ...evidence }
      };
      const result = this.db.prepare(`
        UPDATE archive_batches
        SET task_status = 'running',
            finished_at = NULL,
            failure_code = NULL,
            failure_message = NULL,
            archive_status = 'staging',
            completed_at = NULL,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ? AND task_status = ?
      `).run(
        normalizeMetadata({ ...(current.metadata || {}), recovery: recoveryMetadata }),
        timestamp,
        id,
        current.taskStatus
      );
      if (result.changes !== 1) {
        return { status: 'conflict', updated: false, batch: this.getBatch(id) };
      }
      return { status: 'reopened', updated: true, batch: this.getBatch(id) };
    });
  }

  transitionTaskStatus(batchId, taskStatus, options = {}) {
    const id = Number(batchId);
    const status = normalizeTaskStatus(taskStatus);
    const rawExpectedStatuses = options.expectedStatuses === undefined
      ? [BATCH_TASK_STATUSES.RESERVED, BATCH_TASK_STATUSES.RUNNING]
      : options.expectedStatuses;
    if (!Array.isArray(rawExpectedStatuses) || rawExpectedStatuses.length === 0) {
      throw new TypeError('expectedStatuses 必须是非空数组');
    }
    const expectedStatuses = [...new Set(rawExpectedStatuses.map(normalizeTaskStatus))];
    const failureCode = optionalText(
      options.failureCode || options.errorCode || options.code,
      128
    );
    const failureMessage = optionalText(
      options.failureMessage || options.errorMessage || options.message || options.reason,
      512
    );
    const metadataPatch = options.metadata === undefined
      ? null
      : options.metadata;
    if (metadataPatch !== null
        && (typeof metadataPatch !== 'object' || Array.isArray(metadataPatch))) {
      throw new TypeError('terminal metadata patch 必须是对象');
    }
    const timestamp = this._timestamp();
    const isFinished = status === BATCH_TASK_STATUSES.SUCCEEDED
      || status === BATCH_TASK_STATUSES.FAILED
      || status === BATCH_TASK_STATUSES.CANCELLED;
    return withWriteTransaction(this.db, () => {
      const current = this.getBatch(id);
      if (!current) {
        return { status: 'not-found', updated: false, idempotent: false, batch: null };
      }
      if (current.taskStatus === status) {
        if (metadataPatch) {
          this.db.prepare(`
            UPDATE archive_batches
            SET metadata_json = ?, updated_at = ?
            WHERE id = ? AND task_status = ?
          `).run(
            normalizeMetadata({ ...(current.metadata || {}), ...metadataPatch }),
            timestamp,
            id,
            status
          );
        }
        if (isFinished) this._refreshBatchStatus(id, timestamp, { emptyIsComplete: true });
        return {
          status: 'unchanged',
          updated: false,
          idempotent: true,
          batch: this.getBatch(id)
        };
      }
      const currentIsTerminal = current.taskStatus === BATCH_TASK_STATUSES.SUCCEEDED
        || current.taskStatus === BATCH_TASK_STATUSES.FAILED
        || current.taskStatus === BATCH_TASK_STATUSES.CANCELLED;
      if (currentIsTerminal || !expectedStatuses.includes(current.taskStatus)) {
        if (currentIsTerminal) {
          this._refreshBatchStatus(id, timestamp, { emptyIsComplete: true });
        }
        return {
          status: 'conflict',
          updated: false,
          idempotent: false,
          batch: currentIsTerminal ? this.getBatch(id) : current
        };
      }
      const result = this.db.prepare(`
        UPDATE archive_batches
        SET task_status = ?,
            started_at = CASE
              WHEN ? = 'running' THEN COALESCE(started_at, ?)
              ELSE started_at
            END,
            finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END,
            failure_code = ?, failure_message = ?,
            metadata_json = COALESCE(?, metadata_json), updated_at = ?
        WHERE id = ? AND task_status = ?
      `).run(
        status,
        status,
        timestamp,
        isFinished ? 1 : 0,
        isFinished ? timestamp : null,
        failureCode || null,
        failureMessage || null,
        metadataPatch
          ? normalizeMetadata({ ...(current.metadata || {}), ...metadataPatch })
          : null,
        timestamp,
        id,
        current.taskStatus
      );
      if (result.changes !== 1) {
        return {
          status: 'conflict',
          updated: false,
          idempotent: false,
          batch: this.getBatch(id)
        };
      }
      if (isFinished) this._refreshBatchStatus(id, timestamp, { emptyIsComplete: true });
      return { status: 'updated', updated: true, idempotent: false, batch: this.getBatch(id) };
    });
  }

  updateTaskStatus(batchId, taskStatus, options = {}) {
    return this.transitionTaskStatus(batchId, taskStatus, options).batch;
  }

  addArtifact(batchId, payload = {}) {
    const id = Number(batchId);
    const artifact = normalizeArtifactPayload(payload, `artifact-${this._timestamp()}`);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      if (!this.db.prepare('SELECT id FROM archive_batches WHERE id = ?').get(id)) {
        throw new Error(`存档批次不存在：${id}`);
      }
      const artifactOrder = Number(this.db.prepare(`
        SELECT COALESCE(MAX(artifact_order), 0) + 1 AS next_order
        FROM archive_artifacts
        WHERE batch_id = ?
      `).get(id).next_order);
      const result = this.db.prepare(`
        INSERT INTO archive_artifacts (
          batch_id, artifact_key, direction, role, source_operation,
          original_name, source_path, status, metadata_json, artifact_order,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id,
        artifact.artifactKey,
        artifact.direction,
        artifact.role,
        artifact.sourceOperation,
        artifact.originalName,
        artifact.sourcePath,
        artifact.metadataJson,
        artifactOrder,
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

  ensureArtifactOrders(batchId) {
    const id = Number(batchId);
    return withWriteTransaction(this.db, () => {
      const rows = this.db.prepare(`
        SELECT id, artifact_order
        FROM archive_artifacts
        WHERE batch_id = ?
        ORDER BY id ASC
      `).all(id);
      let nextOrder = rows.reduce(
        (maximum, row) => row.artifact_order == null ? maximum : Math.max(maximum, Number(row.artifact_order)),
        0
      );
      const timestamp = this._timestamp();
      for (const row of rows) {
        if (row.artifact_order != null) continue;
        nextOrder += 1;
        this.db.prepare(`
          UPDATE archive_artifacts
          SET artifact_order = ?, updated_at = ?
          WHERE id = ? AND artifact_order IS NULL
        `).run(nextOrder, timestamp, Number(row.id));
      }
      return this.listArtifacts(id);
    });
  }

  prepareArtifactLayout(artifactId, assignment = {}) {
    const id = Number(artifactId);
    const artifactOrder = Number(assignment.artifactOrder);
    if (!Number.isSafeInteger(artifactOrder) || artifactOrder < 1) {
      throw new TypeError('artifactOrder 必须是正安全整数');
    }
    const safeFileName = requiredText(assignment.safeFileName, 'safeFileName', 255);
    const storageRelativePath = requiredText(
      assignment.storageRelativePath,
      'storageRelativePath',
      2048
    );
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_artifacts
      SET artifact_order = ?, safe_file_name = ?, storage_relative_path = ?, updated_at = ?
      WHERE id = ?
    `).run(artifactOrder, safeFileName, storageRelativePath, timestamp, id);
    return result.changes === 1 ? this.getArtifact(id) : null;
  }

  completeMaterialization(artifactId, payload = {}) {
    const id = Number(artifactId);
    const mode = requiredText(payload.storageMode, 'storageMode', 32);
    if (!['hardlink', 'copy'].includes(mode)) throw new TypeError(`storageMode 非法：${mode}`);
    const storageRelativePath = requiredText(
      payload.storageRelativePath,
      'storageRelativePath',
      2048
    );
    const safeFileName = requiredText(payload.safeFileName, 'safeFileName', 255);
    const artifactOrder = Number(payload.artifactOrder);
    if (!Number.isSafeInteger(artifactOrder) || artifactOrder < 1) {
      throw new TypeError('artifactOrder 必须是正安全整数');
    }
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const artifact = this.db.prepare(`
        SELECT batch_id, status, materialization_error_code,
               materialization_error_message, materialization_failed_at
        FROM archive_artifacts
        WHERE id = ?
      `).get(id);
      if (!artifact) return null;
      if (artifact.status !== ARTIFACT_STATUSES.READY) {
        throw new Error(`只有 ready artifact 可以完成目录化：${id}`);
      }
      this.db.prepare(`
        UPDATE archive_artifacts
        SET storage_relative_path = ?, storage_mode = ?, storage_layout_version = 2,
            safe_file_name = ?, artifact_order = ?,
            materialization_error_code = NULL,
            materialization_error_message = NULL,
            materialization_failed_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(storageRelativePath, mode, safeFileName, artifactOrder, timestamp, id);
      this._refreshBatchStatus(Number(artifact.batch_id), timestamp);
      return { artifact: this.getArtifact(id), batch: this.getBatch(Number(artifact.batch_id)) };
    });
  }

  recordMaterializationFailure(artifactId, failure = {}) {
    const id = Number(artifactId);
    const code = requiredText(
      failure.code || 'ARCHIVE_MATERIALIZATION_FAILED',
      'failure.code',
      128
    );
    const message = requiredText(
      failure.message || '存档目录化失败，等待修复',
      'failure.message',
      512
    );
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const artifact = this.db.prepare(`
        SELECT batch_id, status, materialization_error_code,
               materialization_error_message, materialization_failed_at
        FROM archive_artifacts
        WHERE id = ?
      `).get(id);
      if (!artifact) return null;
      if (artifact.status !== ARTIFACT_STATUSES.READY) return null;
      this.db.prepare(`
        UPDATE archive_artifacts
        SET materialization_error_code = ?, materialization_error_message = ?,
            materialization_failed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(code, message, timestamp, timestamp, id);
      this.db.prepare(`
        UPDATE archive_batches
        SET archive_status = 'incomplete', failure_count = failure_count + ?,
            last_error_code = ?, last_error_message = ?,
            last_failed_operation = 'materialization', last_failed_at = ?,
            completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ?
      `).run(
        artifact.materialization_error_code == null
          && artifact.materialization_error_message == null
          && artifact.materialization_failed_at == null
          ? 1
          : 0,
        code,
        message,
        timestamp,
        timestamp,
        timestamp,
        Number(artifact.batch_id)
      );
      return { artifact: this.getArtifact(id), batch: this.getBatch(Number(artifact.batch_id)) };
    });
  }

  recordArtifactFailure(batchId, payload = {}, failure = {}) {
    const id = Number(batchId);
    const timestamp = this._timestamp();
    const artifact = normalizeArtifactPayload(payload, `artifact-${timestamp}`);
    const code = requiredText(failure.code || 'ARCHIVE_FILE_FAILED', 'failure.code', 128);
    const message = requiredText(failure.message || '文件存档失败', 'failure.message', 512);
    return withWriteTransaction(this.db, () => {
      if (!this.db.prepare('SELECT id FROM archive_batches WHERE id = ?').get(id)) {
        throw new Error(`存档批次不存在：${id}`);
      }
      const artifactOrder = Number(this.db.prepare(`
        SELECT COALESCE(MAX(artifact_order), 0) + 1 AS next_order
        FROM archive_artifacts
        WHERE batch_id = ?
      `).get(id).next_order);
      const result = this.db.prepare(`
        INSERT INTO archive_artifacts (
          batch_id, artifact_key, direction, role, source_operation,
          original_name, source_path, status, blob_id, attempt_count,
          last_error_code, last_error_message, metadata_json,
          artifact_order, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', NULL, 0, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id,
        artifact.artifactKey,
        artifact.direction,
        artifact.role,
        artifact.sourceOperation,
        artifact.originalName,
        artifact.sourcePath,
        code,
        message,
        artifact.metadataJson,
        artifactOrder,
        timestamp,
        timestamp
      );
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
        artifact.sourceOperation,
        timestamp,
        timestamp,
        timestamp,
        id
      );
      return {
        artifact: this.getArtifact(Number(result.lastInsertRowid)),
        batch: this.getBatch(id)
      };
    });
  }

  _refreshBatchStatus(batchId, timestamp, options = {}) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count,
        COALESCE(SUM(CASE
          WHEN status = 'ready'
           AND storage_layout_version = 2
           AND COALESCE(storage_relative_path, '') <> ''
           AND storage_mode IN ('hardlink', 'copy')
           AND COALESCE(safe_file_name, '') <> ''
           AND artifact_order IS NOT NULL
           AND materialization_error_code IS NULL
           AND materialization_error_message IS NULL
           AND materialization_failed_at IS NULL
          THEN 1 ELSE 0 END), 0) AS materialized_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM archive_artifacts
      WHERE batch_id = ?
    `).get(Number(batchId));
    const total = Number(counts.total) || 0;
    const ready = Number(counts.ready_count) || 0;
    const materialized = Number(counts.materialized_count) || 0;
    const pending = Number(counts.pending_count) || 0;
    const current = this.db.prepare(`
      SELECT archive_status, completed_at, last_error_code, last_error_message,
             last_failed_operation, last_failed_at
      FROM archive_batches
      WHERE id = ?
    `).get(Number(batchId));
    if (!current) return null;
    const hasCurrentArchiveFailure = current.archive_status === BATCH_ARCHIVE_STATUSES.INCOMPLETE
      || Boolean(
        current.last_error_code
        || current.last_error_message
        || current.last_failed_operation
        || current.last_failed_at
      );
    const emptyArchiveComplete = total === 0
      && options.emptyIsComplete === true
      && !hasCurrentArchiveFailure;
    let status = emptyArchiveComplete
      ? BATCH_ARCHIVE_STATUSES.COMPLETE
      : BATCH_ARCHIVE_STATUSES.INCOMPLETE;
    let completedAt = timestamp;
    if (total > 0 && ready === total && materialized === total) {
      status = BATCH_ARCHIVE_STATUSES.COMPLETE;
    } else if (pending > 0) {
      status = BATCH_ARCHIVE_STATUSES.STAGING;
      completedAt = null;
    }
    if (status !== BATCH_ARCHIVE_STATUSES.STAGING
        && current.archive_status === status
        && current.completed_at) {
      completedAt = current.completed_at;
    }
    const shouldClearErrors = status === BATCH_ARCHIVE_STATUSES.COMPLETE
      && Boolean(
        current.last_error_code
        || current.last_error_message
        || current.last_failed_operation
        || current.last_failed_at
      );
    if (current.archive_status === status
        && (current.completed_at || null) === completedAt
        && !shouldClearErrors) {
      return status;
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

  addArtifactHold(artifactId, payload = {}) {
    const id = Number(artifactId);
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('artifactId 必须是正安全整数');
    const identity = normalizeArtifactHoldIdentity(payload);
    const reason = requiredText(payload.reason, 'reason', 512);
    const timestamp = this._timestamp();
    return withWriteTransaction(this.db, () => {
      const artifact = this.db.prepare('SELECT id, status FROM archive_artifacts WHERE id = ?').get(id);
      if (!artifact) throw new Error(`存档 artifact 不存在：${id}`);
      if (artifact.status !== ARTIFACT_STATUSES.READY) {
        throw new Error(`只有 ready artifact 可以建立业务引用锁：${id}`);
      }
      this.db.prepare(`
        INSERT INTO archive_artifact_holds (
          artifact_id, owner_module, owner_type, owner_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id, owner_module, owner_type, owner_id) DO UPDATE SET
          reason = excluded.reason
      `).run(
        id,
        identity.ownerModule,
        identity.ownerType,
        identity.ownerId,
        reason,
        timestamp
      );
      return mapArtifactHold(this.db.prepare(`
        SELECT * FROM archive_artifact_holds
        WHERE artifact_id = ? AND owner_module = ? AND owner_type = ? AND owner_id = ?
      `).get(id, identity.ownerModule, identity.ownerType, identity.ownerId));
    });
  }

  releaseArtifactHold(payload = {}) {
    const id = Number(payload.artifactId);
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('artifactId 必须是正安全整数');
    const identity = normalizeArtifactHoldIdentity(payload);
    return this.db.prepare(`
      DELETE FROM archive_artifact_holds
      WHERE artifact_id = ? AND owner_module = ? AND owner_type = ? AND owner_id = ?
    `).run(id, identity.ownerModule, identity.ownerType, identity.ownerId).changes === 1;
  }

  listArtifactHolds(artifactId) {
    const id = Number(artifactId);
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('artifactId 必须是正安全整数');
    return this.db.prepare(`
      SELECT * FROM archive_artifact_holds WHERE artifact_id = ? ORDER BY id
    `).all(id).map(mapArtifactHold);
  }

  listArtifactHoldsByOwner(ownerModule, ownerType) {
    const identity = normalizeArtifactHoldIdentity({
      ownerModule,
      ownerType,
      ownerId: 'inventory'
    });
    return this.db.prepare(`
      SELECT * FROM archive_artifact_holds
      WHERE owner_module = ? AND owner_type = ?
      ORDER BY id
    `).all(identity.ownerModule, identity.ownerType).map(mapArtifactHold);
  }

  listArtifactsBySourceOperation(moduleId, sourceOperation) {
    const normalizedModuleId = normalizeModuleId(moduleId);
    const operation = requiredText(sourceOperation, 'sourceOperation', 256);
    return this.db.prepare(`
      ${ARTIFACT_SELECT}
      JOIN archive_batches b ON b.id = a.batch_id
      WHERE b.module_id = ? AND a.source_operation = ?
      ORDER BY a.id
    `).all(normalizedModuleId, operation).map(mapArtifact);
  }

  listExpiredBatches(asOfLocalDate) {
    const date = normalizeLocalDate(asOfLocalDate, 'asOfLocalDate');
    return this.db.prepare(`
      ${BATCH_SELECT}
      WHERE b.locked = 0
        AND NOT EXISTS (
          SELECT 1
          FROM archive_artifacts held_artifact
          JOIN archive_artifact_holds hold ON hold.artifact_id = held_artifact.id
          WHERE held_artifact.batch_id = b.id
        )
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

  listBlobsPage(limit = 500, afterBlobId = 0) {
    const count = Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 5000) {
      throw new TypeError('limit 必须为 1 到 5000 的安全整数');
    }
    const cursor = Number(afterBlobId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('afterBlobId 必须为非负安全整数');
    }
    return this.db.prepare(`
      SELECT bl.*, COUNT(a.id) AS reference_count
      FROM archive_blobs bl
      LEFT JOIN archive_artifacts a ON a.blob_id = bl.id
      WHERE bl.id > ?
      GROUP BY bl.id
      ORDER BY bl.id ASC
      LIMIT ?
    `).all(cursor, count).map(mapBlob);
  }

  countBlobsAfter(afterBlobId = 0) {
    const cursor = Number(afterBlobId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError('afterBlobId 必须为非负安全整数');
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM archive_blobs WHERE id > ?
    `).get(cursor);
    return Number(row && row.count) || 0;
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

  markInterruptedTasks(options = {}) {
    const excludedBatchIds = new Set(
      (Array.isArray(options.excludeBatchIds) ? options.excludeBatchIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    );
    const rows = this.db.prepare(`
      SELECT id
      FROM archive_batches
      WHERE task_status IN ('reserved', 'running')
      ORDER BY id
    `).all().filter((row) => !excludedBatchIds.has(Number(row.id)));
    if (rows.length === 0) return { taskCount: 0, batchIds: [] };
    const timestamp = this._timestamp();
    const code = 'ARCHIVE_TASK_INTERRUPTED';
    const message = '应用上次异常退出时任务尚未结束，已安全终结；可从原业务入口重新执行';
    return withWriteTransaction(this.db, () => {
      const batchIds = [];
      const update = this.db.prepare(`
        UPDATE archive_batches
        SET task_status = 'failed',
            finished_at = ?,
            failure_code = ?,
            failure_message = ?,
            updated_at = ?
        WHERE id = ? AND task_status IN ('reserved', 'running')
      `);
      for (const row of rows) {
        const batchId = Number(row.id);
        const changed = update.run(timestamp, code, message, timestamp, batchId);
        if (Number(changed.changes) !== 1) continue;
        batchIds.push(batchId);
        this._refreshBatchStatus(batchId, timestamp, { emptyIsComplete: true });
      }
      return { taskCount: batchIds.length, batchIds };
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

  listCleanupJobs() {
    return this.db.prepare(`
      SELECT * FROM archive_cleanup_jobs ORDER BY id ASC
    `).all().map(mapCleanupJob);
  }

  recordCleanupJobFailure(jobId, failure = {}) {
    const id = Number(jobId);
    const code = requiredText(failure.code || 'ARCHIVE_CLEANUP_FAILED', 'failure.code', 128);
    const message = requiredText(
      failure.message || '存档物理清理失败，等待重试',
      'failure.message',
      512
    );
    const timestamp = this._timestamp();
    const result = this.db.prepare(`
      UPDATE archive_cleanup_jobs
      SET attempt_count = attempt_count + 1,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(code, message, timestamp, id);
    return result.changes === 1
      ? mapCleanupJob(this.db.prepare('SELECT * FROM archive_cleanup_jobs WHERE id = ?').get(id))
      : null;
  }

  completeCleanupJob(jobId) {
    const id = Number(jobId);
    return this.db.prepare('DELETE FROM archive_cleanup_jobs WHERE id = ?').run(id).changes === 1;
  }

  deleteBatch(batchId, options = {}) {
    const id = Number(batchId);
    const allowLocked = options.allowLocked === true;
    return withWriteTransaction(this.db, () => {
      const batch = this.getBatch(id);
      if (!batch) return { status: 'not-found', batchId: id, releasedBlobs: [] };
      if (batch.taskStatus === BATCH_TASK_STATUSES.RESERVED
          || batch.taskStatus === BATCH_TASK_STATUSES.RUNNING) {
        return { status: 'active', batch, releasedBlobs: [] };
      }
      if (batch.locked && !allowLocked) {
        return { status: 'locked', batch, releasedBlobs: [] };
      }
      const heldArtifacts = this.db.prepare(`
        SELECT DISTINCT a.id
        FROM archive_artifacts a
        JOIN archive_artifact_holds h ON h.artifact_id = a.id
        WHERE a.batch_id = ?
        ORDER BY a.id
      `).all(id).map((row) => Number(row.id));
      if (heldArtifacts.length > 0) {
        return {
          status: 'business-held',
          batch,
          artifactIds: heldArtifacts,
          releasedBlobs: []
        };
      }
      if (batch.operationKey) {
        this.db.prepare(`
          UPDATE archive_operation_issuances
          SET deleted_at = COALESCE(deleted_at, ?)
          WHERE module_id = ? AND operation_key = ?
        `).run(this._timestamp(), batch.moduleId, batch.operationKey);
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
      const materializedPaths = this.db.prepare(`
        SELECT storage_relative_path
        FROM archive_artifacts
        WHERE batch_id = ? AND COALESCE(storage_relative_path, '') <> ''
        ORDER BY artifact_order ASC, id ASC
      `).all(id).map((row) => String(row.storage_relative_path));

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
      let cleanupJob = null;
      if (materializedPaths.length > 0 || releasedBlobs.length > 0) {
        const timestamp = this._timestamp();
        const result = this.db.prepare(`
          INSERT INTO archive_cleanup_jobs (
            batch_id, batch_number, local_date, layout_relative_dir,
            materialized_paths_json, released_blobs_json,
            attempt_count, last_error_code, last_error_message,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
        `).run(
          batch.id,
          batch.batchNumber,
          batch.localDate,
          layoutRelativeDirectoryForBatch(batch),
          JSON.stringify(materializedPaths),
          JSON.stringify(releasedBlobs.map((blob) => ({
            relativePath: blob.relativePath,
            sha256: blob.sha256,
            sizeBytes: blob.sizeBytes
          }))),
          timestamp,
          timestamp
        );
        cleanupJob = mapCleanupJob(
          this.db.prepare('SELECT * FROM archive_cleanup_jobs WHERE id = ?')
            .get(Number(result.lastInsertRowid))
        );
      }
      return {
        status: 'deleted',
        batch,
        artifactCount,
        logicalBytes,
        releasedBlobs,
        cleanupJob
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
  ARCHIVE_INSTANCE_ID_SETTING_KEY,
  ARCHIVE_STORAGE_ROOT_SETTING_KEY,
  ArchiveRepository,
  ARTIFACT_STATUSES,
  BATCH_ARCHIVE_STATUSES,
  BATCH_FORMAT_VERSIONS,
  BATCH_TASK_STATUSES,
  createArchiveRepository,
  ensureArchiveMetadataSupport,
  formatBatchNumber,
  formatGlobalBatchNumber,
  normalizeLocalDate
};
