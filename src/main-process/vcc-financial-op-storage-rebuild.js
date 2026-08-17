'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { resolveManagedRelative } = require('./archive-center/storage-layout');

const {
  VCC_STORAGE_CONTRACT_VERSION,
  createSlimEffectiveRowsTable,
  setVccStorageContractVersion
} = require('../backend/vcc-financial-op-db/storage-contract');

const PRE_SWITCH_PHASES = new Set(['prepared', 'copying', 'verifying']);
const JOURNAL_SCHEMA_VERSION = 1;
const MIN_REDUCTION_GATE_BYTES = 1024 * 1024 * 1024;
const MIN_VCC_CORE_REDUCTION_RATIO = 0.75;
const EXPECTED_CURRENCIES = Object.freeze([
  'AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD'
]);
const OMITTED_ROW_TABLES = new Set([
  'vcc_fin_op_import_rows',
  'vcc_fin_op_import_errors',
  'vcc_fin_op_import_staging_rows'
]);
const FULLY_PRESERVED_VCC_TABLES = Object.freeze([
  'vcc_fin_op_import_batches',
  'vcc_fin_op_system_snapshots',
  'vcc_fin_op_system_snapshot_attempts',
  'vcc_fin_op_datasets',
  'vcc_fin_op_runs',
  'vcc_fin_op_run_rows',
  'vcc_fin_op_run_balances',
  'vcc_fin_op_pending_summary_rows',
  'vcc_fin_op_pending_currency_totals',
  'vcc_fin_op_archives',
  'vcc_fin_op_module_state',
  'vcc_fin_op_opening_balances',
  'vcc_fin_op_dataset_deletions',
  'vcc_fin_op_run_adjustments',
  'vcc_fin_op_operation_audit'
]);
const IMPORT_COUNTER_COLUMNS = Object.freeze([
  'raw_count',
  'inserted_count',
  'skipped_count',
  'invalid_key_count',
  'conflict_count',
  'format_error_count',
  'rolled_back_count'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;

class VccStorageMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VccStorageMigrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, tableName, schema = 'main') {
  return Boolean(db.prepare(`
    SELECT 1 FROM ${quoteIdentifier(schema)}.sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(String(tableName)));
}

function tableColumns(db, tableName, schema = 'main') {
  return db.prepare(
    `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(tableName)})`
  ).all().map((row) => String(row.name));
}

function tableHasColumn(db, tableName, columnName, schema = 'main') {
  return tableColumns(db, tableName, schema).includes(columnName);
}

function safeUnlink(filePath, fsImpl = fs) {
  try { fsImpl.unlinkSync(filePath); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function safeStatSize(filePath, fsImpl = fs) {
  try { return Number(fsImpl.statSync(filePath).size) || 0; } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function fsyncDirectory(directoryPath, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(directoryPath, 'r');
    fsImpl.fsyncSync(fd);
  } catch (error) {
    // Windows/部分网络盘不支持目录句柄 fsync；数据库文件与 journal 本身均已
    // fsync，且 rename 仍限定在同目录。仅忽略明确的“目录 fsync 不支持”。
    if (!error || !['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function fsyncFile(filePath, fsImpl = fs) {
  let fd;
  try {
    // Windows 的 FlushFileBuffers 需要可写文件句柄；只读句柄会稳定返回
    // EPERM。这里同步的是迁移候选/主数据库，维护模式已要求它们可写，
    // 因此统一使用 r+，不改变文件内容，只保证此前写入真正落盘。
    fd = fsImpl.openSync(filePath, 'r+');
    fsImpl.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function cleanupDatabaseCandidate(filePath, fsImpl = fs) {
  for (const candidate of [
    filePath,
    `${filePath}-wal`,
    `${filePath}-shm`,
    `${filePath}-journal`
  ]) safeUnlink(candidate, fsImpl);
}

function removeJournalDurably(journalPath, fsImpl = fs) {
  safeUnlink(journalPath, fsImpl);
  fsyncDirectory(path.dirname(journalPath), fsImpl);
}

function deleteOldDatabaseDurably(journal, fsImpl = fs) {
  if (!journal.deleteOldDatabase) return false;
  safeUnlink(journal.backupPath, fsImpl);
  safeUnlink(`${journal.backupPath}-wal`, fsImpl);
  safeUnlink(`${journal.backupPath}-shm`, fsImpl);
  fsyncDirectory(path.dirname(journal.backupPath), fsImpl);
  return true;
}

function isOwnedFailedCandidate(journal, candidatePath) {
  if (!candidatePath) return false;
  const resolvedCandidate = path.resolve(String(candidatePath));
  const resolvedTarget = path.resolve(String(journal.targetPath));
  if (path.dirname(resolvedCandidate) !== path.dirname(resolvedTarget)) return false;
  const prefix = `${path.basename(resolvedTarget)}.failed-`;
  const suffix = path.basename(resolvedCandidate).slice(prefix.length);
  return path.basename(resolvedCandidate).startsWith(prefix) && /^\d+$/.test(suffix);
}

function writeJsonAtomic(filePath, payload, fsImpl = fs) {
  const directory = path.dirname(filePath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  let fd;
  try {
    fd = fsImpl.openSync(tempPath, 'w', 0o600);
    fsImpl.writeFileSync(fd, text, 'utf8');
    fsImpl.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
  fsImpl.renameSync(tempPath, filePath);
  fsyncDirectory(directory, fsImpl);
  return payload;
}

function readJournal(journalPath, fsImpl = fs) {
  let parsed;
  try { parsed = JSON.parse(fsImpl.readFileSync(journalPath, 'utf8')); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new VccStorageMigrationError(
      'vcc-storage-journal-invalid',
      'VCC 存储迁移恢复记录损坏，已停止自动处理',
      { cause: error }
    );
  }
  const required = ['sourcePath', 'targetPath', 'backupPath', 'phase', 'migrationId'];
  if (!parsed || parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION
      || required.some((key) => !String(parsed[key] || '').trim())) {
    throw new VccStorageMigrationError(
      'vcc-storage-journal-invalid',
      'VCC 存储迁移恢复记录字段不完整，已停止自动处理'
    );
  }
  return parsed;
}

function updateJournal(journalPath, journal, phase, patch = {}, fsImpl = fs) {
  return writeJsonAtomic(journalPath, {
    ...journal,
    ...patch,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    phase,
    updatedAt: new Date().toISOString()
  }, fsImpl);
}

function emitProgress(onProgress, phase, processed, total, detail = '') {
  if (typeof onProgress !== 'function') return;
  onProgress(Object.freeze({
    phase,
    processed: Number(processed) || 0,
    total: Number(total) || 0,
    detail: String(detail || '')
  }));
}

function invokeFault(faultInjector, checkpoint, details = {}) {
  if (typeof faultInjector === 'function') faultInjector(checkpoint, details);
}

function openReadOnlyDatabase(filePath) {
  return new DatabaseSync(filePath, { readOnly: true });
}

function assertIntegrity(db, label) {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  if (integrityRows.length !== 1 || String(integrityRows[0].integrity_check) !== 'ok') {
    throw new VccStorageMigrationError(
      'vcc-storage-integrity-failed',
      `${label} integrity_check 未通过`,
      { failures: integrityRows.slice(0, 20) }
    );
  }
  const foreignKeyRows = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyRows.length > 0) {
    throw new VccStorageMigrationError(
      'vcc-storage-foreign-key-failed',
      `${label} foreign_key_check 未通过`,
      { failures: foreignKeyRows.slice(0, 20) }
    );
  }
}

function storageContractVersion(db) {
  if (!tableExists(db, 'app_settings')) return 1;
  const row = db.prepare(`
    SELECT setting_value FROM app_settings WHERE setting_key = 'vcc_storage_contract_version'
  `).get();
  return row ? Number(row.setting_value) : 1;
}

function assertSourceReady(sourceDb) {
  assertIntegrity(sourceDb, '旧数据库');
  const version = storageContractVersion(sourceDb);
  if (version === VCC_STORAGE_CONTRACT_VERSION) {
    return { noChange: true, contractVersion: version };
  }
  if (version !== 1) {
    throw new VccStorageMigrationError(
      'vcc-storage-contract-unsupported',
      `不支持从 VCC storage contract v${version} 迁移`
    );
  }
  if (!tableExists(sourceDb, 'vcc_fin_op_effective_rows')) {
    throw new VccStorageMigrationError('vcc-storage-schema-missing', '旧数据库缺少 VCC 有效数据表');
  }
  if (tableExists(sourceDb, 'vcc_fin_op_import_staging_rows')) {
    const staging = Number(sourceDb.prepare(
      'SELECT COUNT(*) AS count FROM vcc_fin_op_import_staging_rows'
    ).get().count) || 0;
    if (staging > 0) {
      throw new VccStorageMigrationError(
        'vcc-storage-staging-not-empty',
        `仍有 ${staging} 条导入 staging 数据，必须先完成或恢复导入任务`
      );
    }
  }
  const importing = Number(sourceDb.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_import_records WHERE status = 'importing'
  `).get().count) || 0;
  if (importing > 0) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-active',
      `仍有 ${importing} 条未终态导入记录，禁止迁移`
    );
  }
  return { noChange: false, contractVersion: version };
}

function collectDbstat(db) {
  try {
    const rows = db.prepare(`
      SELECT master.tbl_name AS table_name, SUM(stat.pgsize) AS bytes
      FROM dbstat AS stat
      JOIN sqlite_master AS master ON master.name = stat.name
      WHERE master.type IN ('table', 'index')
      GROUP BY master.tbl_name
      ORDER BY master.tbl_name
    `).all();
    return Object.fromEntries(rows.map((row) => [String(row.table_name), Number(row.bytes) || 0]));
  } catch (error) {
    throw new VccStorageMigrationError(
      'vcc-storage-dbstat-unavailable',
      '当前 SQLite runtime 不支持 dbstat，无法执行迁移空间与压缩率门禁',
      { cause: error }
    );
  }
}

function collectDbstatFromPath(filePath) {
  const db = openReadOnlyDatabase(filePath);
  try { return collectDbstat(db); } finally { db.close(); }
}

function vccCoreBytes(dbstat) {
  const names = [
    'vcc_fin_op_import_batches',
    'vcc_fin_op_import_records',
    'vcc_fin_op_import_rows',
    'vcc_fin_op_import_errors',
    'vcc_fin_op_import_sources',
    'vcc_fin_op_import_anomalies',
    'vcc_fin_op_import_staging_rows',
    'vcc_fin_op_effective_rows',
    'vcc_fin_op_effective_raw_fallback'
  ];
  return names.reduce((total, name) => total + (Number(dbstat[name]) || 0), 0);
}

function migrationEstimate(sourceDb, sourcePath) {
  const beforeDbstat = collectDbstat(sourceDb);
  const sourceBytes = safeStatSize(sourcePath);
  const oldCoreBytes = vccCoreBytes(beforeDbstat);
  const effectiveCount = Number(sourceDb.prepare(
    'SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows'
  ).get().count) || 0;
  const recordTotals = sourceDb.prepare(`
    SELECT
      COALESCE(SUM(invalid_key_count), 0) AS invalid_count,
      COALESCE(SUM(conflict_count), 0) AS conflict_count,
      COALESCE(SUM(format_error_count), 0) AS format_count
    FROM vcc_fin_op_import_records
  `).get();
  const anomalyCount = Number(recordTotals.invalid_count) + Number(recordTotals.conflict_count)
    + Number(recordTotals.format_count);
  const nonCoreBytes = Math.max(0, sourceBytes - oldCoreBytes);
  const projectedEffectiveBytes = Math.max(effectiveCount * 384, Math.floor(oldCoreBytes * 0.08));
  const projectedAnomalyBytes = anomalyCount * 640;
  const estimatedTargetBytes = Math.ceil(
    nonCoreBytes + projectedEffectiveBytes + projectedAnomalyBytes + 512 * 1024 * 1024
  );
  return {
    sourceBytes,
    oldCoreBytes,
    effectiveCount,
    anomalyCount,
    estimatedTargetBytes,
    requiredFreeBytes: Math.ceil(estimatedTargetBytes * 1.25)
  };
}

function inspectVccStorage(sourcePath) {
  const resolved = path.resolve(String(sourcePath || ''));
  const db = openReadOnlyDatabase(resolved);
  try {
    const contractVersion = storageContractVersion(db);
    const estimate = migrationEstimate(db, resolved);
    const stagingRows = tableExists(db, 'vcc_fin_op_import_staging_rows')
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_import_staging_rows').get().count) || 0
      : 0;
    const importingRecords = tableExists(db, 'vcc_fin_op_import_records')
      ? Number(db.prepare(`
          SELECT COUNT(*) AS count FROM vcc_fin_op_import_records WHERE status = 'importing'
        `).get().count) || 0
      : 0;
    return {
      status: 'success',
      contractVersion,
      migrationRequired: contractVersion < VCC_STORAGE_CONTRACT_VERSION,
      sourceBytes: estimate.sourceBytes,
      vccCoreBytes: estimate.oldCoreBytes,
      estimatedTargetBytes: estimate.estimatedTargetBytes,
      requiredFreeBytes: estimate.requiredFreeBytes,
      effectiveCount: estimate.effectiveCount,
      anomalyCount: estimate.anomalyCount,
      stagingRows,
      importingRecords,
      ready: contractVersion === VCC_STORAGE_CONTRACT_VERSION
        || (stagingRows === 0 && importingRecords === 0)
    };
  } finally {
    db.close();
  }
}

function assertFreeSpace(directory, requiredBytes, fsImpl = fs, availableBytes) {
  let freeBytes = availableBytes;
  if (freeBytes === undefined) {
    if (typeof fsImpl.statfsSync !== 'function') {
      throw new VccStorageMigrationError(
        'vcc-storage-space-unknown',
        '无法读取目标磁盘剩余空间，已阻止迁移'
      );
    }
    const stat = fsImpl.statfsSync(directory);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
  }
  if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
    throw new VccStorageMigrationError(
      'vcc-storage-space-insufficient',
      '磁盘剩余空间不足，旧数据库保持不变',
      { freeBytes, requiredBytes }
    );
  }
  return freeBytes;
}

function writableColumns(db, tableName, schema = 'main') {
  return db.prepare(
    `PRAGMA ${quoteIdentifier(schema)}.table_xinfo(${quoteIdentifier(tableName)})`
  ).all().filter((row) => Number(row.hidden) === 0).map((row) => String(row.name));
}

function createTargetTables(sourceDb, targetDb) {
  const tableList = new Map(sourceDb.prepare('PRAGMA table_list').all()
    .map((row) => [String(row.name), String(row.type)]));
  const tables = sourceDb.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY rowid
  `).all().filter((row) => tableList.get(String(row.name)) !== 'shadow');
  for (const table of tables) {
    if (table.name === 'vcc_fin_op_effective_rows') {
      createSlimEffectiveRowsTable(targetDb);
      continue;
    }
    targetDb.exec(String(table.sql));
  }
  return tables.map((table) => String(table.name));
}

function copyRegularTable(targetDb, tableName) {
  if (OMITTED_ROW_TABLES.has(tableName) || tableName === 'vcc_fin_op_effective_rows') return 0;
  const sourceColumns = new Set(writableColumns(targetDb, tableName, 'source_db'));
  const columns = writableColumns(targetDb, tableName, 'main')
    .filter((column) => sourceColumns.has(column));
  if (columns.length === 0) return 0;
  const sqlColumns = columns.map(quoteIdentifier).join(', ');
  return Number(targetDb.prepare(`
    INSERT INTO main.${quoteIdentifier(tableName)} (${sqlColumns})
    SELECT ${sqlColumns} FROM source_db.${quoteIdentifier(tableName)}
  `).run().changes) || 0;
}

function copySlimEffectiveRows(targetDb) {
  const sourceHasImportSource = tableHasColumn(
    targetDb,
    'vcc_fin_op_effective_rows',
    'import_source_id',
    'source_db'
  );
  const importSourceExpression = sourceHasImportSource ? 'import_source_id' : 'NULL';
  return Number(targetDb.prepare(`
    INSERT INTO main.vcc_fin_op_effective_rows (
      id, source_type, idempotency_key, content_hash, hash_version,
      raw_contract_version, legacy_content_hash, target_month, subject,
      stat_currency, signed_amount, business_department, counterparty_department,
      business_sub_type, channel_name, mid, recon_type, pending_currency,
      pending_amount, flow_currency, flow_amount, currency_mismatch,
      import_record_id, import_source_id, sheet_name, source_row, first_imported_at
    )
    SELECT
      id, source_type, idempotency_key, content_hash, hash_version,
      raw_contract_version, legacy_content_hash, target_month, subject,
      stat_currency, signed_amount, business_department, counterparty_department,
      business_sub_type, channel_name, mid, recon_type, pending_currency,
      pending_amount, flow_currency, flow_amount, currency_mismatch,
      import_record_id, ${importSourceExpression}, sheet_name, source_row, first_imported_at
    FROM source_db.vcc_fin_op_effective_rows
    ORDER BY id
  `).run().changes) || 0;
}

function preserveAutoincrementHighWatermarks(targetDb) {
  if (!tableExists(targetDb, 'sqlite_sequence', 'source_db')
      || !tableExists(targetDb, 'sqlite_sequence')) return 0;
  const findTarget = targetDb.prepare(`
    SELECT seq FROM main.sqlite_sequence WHERE name = ?
  `);
  const updateTarget = targetDb.prepare(`
    UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?
  `);
  const insertTarget = targetDb.prepare(`
    INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)
  `);
  let preserved = 0;
  for (const row of targetDb.prepare(`
    SELECT name, seq FROM source_db.sqlite_sequence ORDER BY name
  `).all()) {
    const tableName = String(row.name || '');
    const sourceSequence = Number(row.seq) || 0;
    if (!tableName || !tableExists(targetDb, tableName)) continue;
    const target = findTarget.get(tableName);
    const targetSequence = target ? Number(target.seq) || 0 : -1;
    if (!target) insertTarget.run(tableName, sourceSequence);
    else if (targetSequence < sourceSequence) updateTarget.run(sourceSequence, tableName);
    preserved += 1;
  }
  return preserved;
}

function migrateLegacyAnomalies(targetDb) {
  if (!tableExists(targetDb, 'vcc_fin_op_import_rows', 'source_db')) return 0;
  const rowColumns = new Set(tableColumns(targetDb, 'vcc_fin_op_import_rows', 'source_db'));
  const incomingHash = rowColumns.has('content_hash') ? 'legacy.content_hash' : 'NULL';
  const existingHash = rowColumns.has('existing_effective_id')
    ? `(SELECT effective.content_hash
        FROM main.vcc_fin_op_effective_rows AS effective
        WHERE effective.id = legacy.existing_effective_id)`
    : 'NULL';
  const changes = targetDb.prepare(`
    INSERT INTO main.vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id, source_type, target_month,
      idempotency_key, source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description, incoming_content_hash, existing_content_hash,
      diff_fields_json, created_at
    )
    SELECT
      legacy.import_record_id,
      NULL,
      legacy.existing_effective_id,
      legacy.source_type,
      legacy.target_month,
      legacy.idempotency_key,
      COALESCE(legacy.source_file, ''),
      legacy.sheet_name,
      legacy.source_row,
      legacy.disposition,
      CASE WHEN legacy.validation_field IS NULL OR legacy.validation_field = ''
           THEN '[]' ELSE json_array(legacy.validation_field) END,
      COALESCE(NULLIF(legacy.validation_message, ''),
        CASE legacy.disposition
          WHEN 'invalid_key' THEN '幂等键缺失或无效'
          WHEN 'format_error' THEN '原表字段格式错误'
          ELSE '相同幂等键对应内容不一致'
        END),
      ${incomingHash},
      ${existingHash},
      COALESCE(NULLIF(legacy.diff_fields_json, ''), '[]'),
      legacy.created_at
    FROM source_db.vcc_fin_op_import_rows AS legacy
    WHERE legacy.disposition IN ('invalid_key', 'format_error', 'idempotent_conflict')
      AND NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_anomalies AS existing
        WHERE existing.import_record_id = legacy.import_record_id
          AND existing.category = legacy.disposition
          AND COALESCE(existing.source_row, -1) = COALESCE(legacy.source_row, -1)
          AND COALESCE(existing.idempotency_key, '') = COALESCE(legacy.idempotency_key, '')
      )
  `).run().changes;
  return Number(changes) || 0;
}

function migrateLegacyImportErrors(targetDb) {
  if (!tableExists(targetDb, 'vcc_fin_op_import_errors', 'source_db')) return 0;
  return Number(targetDb.prepare(`
    INSERT INTO main.vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id, source_type, target_month,
      idempotency_key, source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description, incoming_content_hash, existing_content_hash,
      diff_fields_json, created_at
    )
    SELECT
      error.import_record_id, NULL, NULL, record.source_type, record.target_month,
      NULL, COALESCE(error.source_file, ''), error.sheet_name, error.source_row,
      CASE
        WHEN record.source_type = 'system_op'
          AND (lower(COALESCE(error.error_code, '')) LIKE '%subject%'
            OR COALESCE(error.field_name, '') IN ('公司主体', '主体', 'subject'))
          THEN 'system_subject_error'
        WHEN error.source_row IS NULL AND error.field_name IS NULL THEN 'file_failure'
        ELSE 'format_error'
      END,
      CASE WHEN error.field_name IS NULL OR error.field_name = ''
           THEN '[]' ELSE json_array(error.field_name) END,
      error.message, NULL, NULL, '[]', error.created_at
    FROM source_db.vcc_fin_op_import_errors AS error
    JOIN main.vcc_fin_op_import_records AS record ON record.id = error.import_record_id
    WHERE (
      error.source_row IS NOT NULL
      OR error.field_name IS NOT NULL
      OR error.id = (
        SELECT MIN(first_file_error.id)
        FROM source_db.vcc_fin_op_import_errors AS first_file_error
        WHERE first_file_error.import_record_id = error.import_record_id
          AND first_file_error.source_row IS NULL
          AND first_file_error.field_name IS NULL
      )
    )
      AND NOT EXISTS (
      SELECT 1 FROM main.vcc_fin_op_import_anomalies AS existing
      WHERE existing.import_record_id = error.import_record_id
        AND COALESCE(existing.source_row, -1) = COALESCE(error.source_row, -1)
        AND existing.description = error.message
    )
  `).run().changes) || 0;
}

function migrateFileFailures(targetDb) {
  return Number(targetDb.prepare(`
    INSERT INTO main.vcc_fin_op_import_anomalies (
      import_record_id, import_source_id, effective_row_id, source_type, target_month,
      idempotency_key, source_file_name, sheet_name, source_row, category,
      abnormal_fields_json, description, incoming_content_hash, existing_content_hash,
      diff_fields_json, created_at
    )
    SELECT
      record.id, NULL, NULL, record.source_type, record.target_month,
      NULL,
      COALESCE(json_extract(record.source_files_json, '$[0]'), ''),
      NULL, NULL, 'file_failure', '[]',
      COALESCE(NULLIF(record.error_message, ''), '导入事务失败并已回滚'),
      NULL, NULL, '[]', COALESCE(record.finished_at, record.started_at)
    FROM main.vcc_fin_op_import_records AS record
    WHERE record.status IN ('failed_conflict', 'failed_validation')
      AND NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_anomalies AS anomaly
        WHERE anomaly.import_record_id = record.id AND anomaly.category = 'file_failure'
      )
  `).run().changes) || 0;
}

function parseHistoricalSourceNames(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '[]')); } catch (_error) { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const names = parsed.map((item) => path.basename(String(item || '').trim()));
  if (names.some((name) => !name) || new Set(names).size !== names.length) return null;
  return names;
}

function activeHistoricalSourceNames(targetDb, recordId) {
  const names = new Set();
  if (tableHasColumn(targetDb, 'vcc_fin_op_effective_rows', 'source_file', 'source_db')) {
    for (const row of targetDb.prepare(`
      SELECT DISTINCT source_file
      FROM source_db.vcc_fin_op_effective_rows
      WHERE import_record_id = ?
    `).all(recordId)) names.add(String(row.source_file || ''));
  }
  for (const tableName of ['vcc_fin_op_system_snapshots']) {
    if (!tableExists(targetDb, tableName)
        || !tableHasColumn(targetDb, tableName, 'source_file')) continue;
    for (const row of targetDb.prepare(`
      SELECT DISTINCT source_file FROM main.${quoteIdentifier(tableName)}
      WHERE import_record_id = ?
    `).all(recordId)) names.add(String(row.source_file || ''));
  }
  names.delete('');
  return names;
}

function physicallyVerifyHistoricalArtifact(artifact, options = {}) {
  const archiveRootDir = String(options.archiveRootDir || '').trim();
  if (!archiveRootDir) return false;
  const fsImpl = options.fsImpl || fs;
  const expectedSha256 = String(artifact.sha256 || '').toLowerCase();
  const expectedSizeBytes = Number(artifact.size_bytes);
  if (!SHA256_RE.test(expectedSha256)
      || !Number.isSafeInteger(expectedSizeBytes)
      || expectedSizeBytes < 0) return false;

  let fileDescriptor = null;
  try {
    const artifactPath = resolveManagedRelative(archiveRootDir, artifact.relative_path);
    const leaf = fsImpl.lstatSync(artifactPath);
    if (!leaf.isFile() || leaf.isSymbolicLink() || Number(leaf.size) !== expectedSizeBytes) {
      return false;
    }
    fileDescriptor = fsImpl.openSync(artifactPath, 'r');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let totalBytes = 0;
    while (true) {
      const bytesRead = fsImpl.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return totalBytes === expectedSizeBytes && digest.digest('hex') === expectedSha256;
  } catch (_error) {
    return false;
  } finally {
    if (fileDescriptor !== null) {
      try { fsImpl.closeSync(fileDescriptor); } catch (_error) {}
    }
  }
}

function bindExactHistoricalImportSources(targetDb, options = {}) {
  const requiredTables = [
    'archive_artifacts',
    'archive_batches',
    'archive_blobs',
    'archive_flow_anchors',
    'vcc_fin_op_import_records',
    'vcc_fin_op_import_sources'
  ];
  if (requiredTables.some((tableName) => !tableExists(targetDb, tableName))) {
    return { boundSources: 0, boundRecords: 0, unavailableRecords: 0 };
  }

  const candidates = targetDb.prepare(`
    SELECT record.id, record.source_type, record.source_files_json,
           anchor.source_batch_id
    FROM main.vcc_fin_op_import_records AS record
    JOIN main.archive_flow_anchors AS anchor
      ON anchor.module_id = 'vcc-financial-op'
     AND anchor.identity_type = 'vcc-financial-op-import-record'
     AND anchor.identity_value = CAST(record.id AS TEXT)
    JOIN main.archive_batches AS batch
      ON batch.id = anchor.source_batch_id
     AND batch.module_id = 'vcc-financial-op'
     AND batch.parent_run_id = anchor.parent_run_id
    WHERE record.status IN ('success', 'success_with_skips', 'all_skipped')
      AND NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_sources AS existing
        WHERE existing.import_record_id = record.id
      )
    ORDER BY record.id
  `).all().map((record) => ({
    ...record,
    sourceNames: parseHistoricalSourceNames(record.source_files_json)
  }));

  const artifacts = targetDb.prepare(`
    SELECT artifact.id, artifact.batch_id, artifact.original_name,
           blob.sha256, blob.size_bytes, blob.relative_path
    FROM main.archive_artifacts AS artifact
    JOIN main.archive_blobs AS blob ON blob.id = artifact.blob_id
    WHERE artifact.status = 'ready'
      AND artifact.direction = 'input'
      AND artifact.source_operation = 'vccFinancialOp:import:apply'
    ORDER BY artifact.id
  `).all();
  const artifactsByBatchAndName = new Map();
  for (const artifact of artifacts) {
    const key = `${Number(artifact.batch_id)}\u0000${String(artifact.original_name || '')}`;
    const list = artifactsByBatchAndName.get(key) || [];
    list.push(artifact);
    artifactsByBatchAndName.set(key, list);
  }

  const expectedNameCounts = new Map();
  for (const record of candidates) {
    if (!record.sourceNames) continue;
    for (const name of record.sourceNames) {
      const key = `${Number(record.source_batch_id)}\u0000${name}`;
      expectedNameCounts.set(key, (expectedNameCounts.get(key) || 0) + 1);
    }
  }
  const usedArtifactIds = new Set(targetDb.prepare(`
    SELECT archive_artifact_id AS id
    FROM main.vcc_fin_op_import_sources
    WHERE archive_artifact_id IS NOT NULL
  `).all().map((row) => Number(row.id)));
  const verifiedArtifacts = new Map();

  const insertSource = targetDb.prepare(`
    INSERT INTO main.vcc_fin_op_import_sources (
      import_record_id, source_ordinal, source_file_name,
      source_sha256, source_size_bytes, archive_artifact_id,
      archive_state, bound_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', datetime('now', 'localtime'),
              datetime('now', 'localtime'), datetime('now', 'localtime'))
  `);
  let boundSources = 0;
  let boundRecords = 0;
  let unavailableRecords = 0;

  for (const record of candidates) {
    const sourceNames = record.sourceNames;
    const allowedNames = sourceNames ? new Set(sourceNames) : new Set();
    const activeNames = activeHistoricalSourceNames(targetDb, Number(record.id));
    const activeNamesCovered = [...activeNames].every((name) => allowedNames.has(name));
    const matches = sourceNames && activeNamesCovered
      ? sourceNames.map((name) => {
          const key = `${Number(record.source_batch_id)}\u0000${name}`;
          const choices = artifactsByBatchAndName.get(key) || [];
          if (expectedNameCounts.get(key) !== 1 || choices.length !== 1) return null;
          const artifact = choices[0];
          const sha256 = String(artifact.sha256 || '').toLowerCase();
          const sizeBytes = Number(artifact.size_bytes);
          if (usedArtifactIds.has(Number(artifact.id))
              || !SHA256_RE.test(sha256)
              || !Number.isSafeInteger(sizeBytes)
              || sizeBytes < 0) return null;
          const artifactId = Number(artifact.id);
          if (!verifiedArtifacts.has(artifactId)) {
            verifiedArtifacts.set(artifactId, physicallyVerifyHistoricalArtifact(artifact, options));
          }
          if (!verifiedArtifacts.get(artifactId)) return null;
          return { name, artifact, sha256, sizeBytes };
        })
      : null;
    if (!matches || matches.some((match) => match === null)) {
      unavailableRecords += 1;
      continue;
    }

    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const inserted = insertSource.run(
        Number(record.id),
        index + 1,
        match.name,
        match.sha256,
        match.sizeBytes,
        Number(match.artifact.id)
      );
      const sourceId = Number(inserted.lastInsertRowid);
      usedArtifactIds.add(Number(match.artifact.id));
      targetDb.prepare(`
        UPDATE main.vcc_fin_op_effective_rows
        SET import_source_id = ?
        WHERE id IN (
          SELECT id FROM source_db.vcc_fin_op_effective_rows
          WHERE import_record_id = ? AND source_file = ?
        )
      `).run(sourceId, Number(record.id), match.name);
      for (const tableName of ['vcc_fin_op_system_snapshots', 'vcc_fin_op_system_snapshot_attempts']) {
        if (!tableExists(targetDb, tableName)
            || !tableHasColumn(targetDb, tableName, 'import_source_id')
            || !tableHasColumn(targetDb, tableName, 'source_file')) continue;
        targetDb.prepare(`
          UPDATE main.${quoteIdentifier(tableName)}
          SET import_source_id = ?
          WHERE import_record_id = ? AND source_file = ? AND import_source_id IS NULL
        `).run(sourceId, Number(record.id), match.name);
      }
      targetDb.prepare(`
        UPDATE main.vcc_fin_op_import_anomalies
        SET import_source_id = ?
        WHERE import_record_id = ? AND source_file_name = ? AND import_source_id IS NULL
      `).run(sourceId, Number(record.id), match.name);
      boundSources += 1;
    }
    boundRecords += 1;
  }

  return { boundSources, boundRecords, unavailableRecords };
}

function refreshImportRecordSummaries(targetDb) {
  targetDb.exec(`
    UPDATE main.vcc_fin_op_import_records AS record
    SET anomaly_count = (
      SELECT COUNT(*) FROM main.vcc_fin_op_import_anomalies AS anomaly
      WHERE anomaly.import_record_id = record.id
    ),
    archive_state = CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_sources AS source
        WHERE source.import_record_id = record.id
      ) THEN 'unavailable'
      WHEN EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_sources AS source
        WHERE source.import_record_id = record.id AND source.archive_state = 'failed'
      ) THEN 'failed'
      WHEN NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_sources AS source
        WHERE source.import_record_id = record.id AND source.archive_state <> 'ready'
      ) THEN 'ready'
      ELSE 'pending'
    END;
  `);
}

function removeVerifiedReadyFallbacks(targetDb) {
  if (!tableExists(targetDb, 'archive_artifacts') || !tableExists(targetDb, 'archive_blobs')) return 0;
  return Number(targetDb.prepare(`
    DELETE FROM main.vcc_fin_op_effective_raw_fallback
    WHERE import_source_id IN (
      SELECT source.id
      FROM main.vcc_fin_op_import_sources AS source
      JOIN main.archive_artifacts AS artifact
        ON artifact.id = source.archive_artifact_id AND artifact.status = 'ready'
      JOIN main.archive_blobs AS blob ON blob.id = artifact.blob_id
      WHERE source.archive_state = 'ready'
        AND lower(blob.sha256) = lower(source.source_sha256)
        AND blob.size_bytes = source.source_size_bytes
    )
  `).run().changes) || 0;
}

function activeSourceReferenceSql(alias = 'source') {
  return `(
    EXISTS (SELECT 1 FROM main.vcc_fin_op_effective_rows effective
            WHERE effective.import_source_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM main.vcc_fin_op_effective_raw_fallback fallback
               WHERE fallback.import_source_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM main.vcc_fin_op_system_snapshots snapshot
               WHERE snapshot.import_source_id = ${alias}.id)
  )`;
}

function reconcileVccHolds(targetDb) {
  if (!tableExists(targetDb, 'archive_artifact_holds')) return;
  targetDb.exec(`
    DELETE FROM main.archive_artifact_holds
    WHERE owner_module = 'vcc-financial-op'
      AND owner_type = 'vcc-import-source'
      AND NOT EXISTS (
        SELECT 1 FROM main.vcc_fin_op_import_sources AS source
        WHERE CAST(source.id AS TEXT) = archive_artifact_holds.owner_id
          AND source.archive_artifact_id = archive_artifact_holds.artifact_id
          AND ${activeSourceReferenceSql('source')}
      );

    INSERT OR IGNORE INTO main.archive_artifact_holds (
      artifact_id, owner_module, owner_type, owner_id, reason, created_at
    )
    SELECT source.archive_artifact_id, 'vcc-financial-op', 'vcc-import-source',
      CAST(source.id AS TEXT),
      'VCC 当前有效数据引用导入来源 ' || source.id,
      datetime('now', 'localtime')
    FROM main.vcc_fin_op_import_sources AS source
    JOIN main.archive_artifacts AS artifact ON artifact.id = source.archive_artifact_id
    WHERE source.archive_state = 'ready'
      AND artifact.status = 'ready'
      AND ${activeSourceReferenceSql('source')};
  `);
}

function createSecondarySchema(sourceDb, targetDb) {
  const entries = sourceDb.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, rowid
  `).all();
  for (const entry of entries) targetDb.exec(String(entry.sql));
}

function pragmaValue(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Number(Object.values(row)[0]) || 0 : 0;
}

function exactTableMismatch(targetDb, tableName, excludedColumns = []) {
  if (!tableExists(targetDb, tableName, 'source_db') || !tableExists(targetDb, tableName)) return null;
  const excluded = new Set(excludedColumns);
  const sourceColumns = new Set(tableColumns(targetDb, tableName, 'source_db'));
  const columns = tableColumns(targetDb, tableName)
    .filter((column) => sourceColumns.has(column) && !excluded.has(column));
  if (columns.length === 0) return null;
  const projection = columns.map(quoteIdentifier).join(', ');
  return targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${projection} FROM source_db.${quoteIdentifier(tableName)}
      EXCEPT SELECT ${projection} FROM main.${quoteIdentifier(tableName)}
    ) LIMIT 1
  `).get() || targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${projection} FROM main.${quoteIdentifier(tableName)}
      EXCEPT SELECT ${projection} FROM source_db.${quoteIdentifier(tableName)}
    ) LIMIT 1
  `).get() || null;
}

function sourceTableMismatch(targetDb, tableName, excludedColumns = []) {
  if (!tableExists(targetDb, tableName, 'source_db') || !tableExists(targetDb, tableName)) return null;
  const excluded = new Set(excludedColumns);
  const sourceColumns = new Set(tableColumns(targetDb, tableName, 'source_db'));
  const columns = tableColumns(targetDb, tableName)
    .filter((column) => sourceColumns.has(column) && !excluded.has(column));
  if (columns.length === 0) return null;
  const projection = columns.map(quoteIdentifier).join(', ');
  return targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${projection} FROM source_db.${quoteIdentifier(tableName)}
      EXCEPT SELECT ${projection} FROM main.${quoteIdentifier(tableName)}
    ) LIMIT 1
  `).get() || null;
}

function validatePreservedNonVccTables(targetDb) {
  const tableNames = targetDb.prepare('PRAGMA source_db.table_list').all()
    .filter((row) => String(row.type) === 'table')
    .map((row) => String(row.name))
    .filter((tableName) => !tableName.startsWith('sqlite_'))
    .filter((tableName) => !tableName.startsWith('vcc_fin_op_'))
    .sort();
  for (const tableName of tableNames) {
    // app_settings 会新增 storage contract v2 标记，archive_artifact_holds
    // 会新增由有效 VCC 来源推导出的 business hold；两者都允许目标多行，
    // 但所有源行仍必须逐字段存在。其余非 VCC 表也沿用同一“源集合是
    // 目标子集”门禁，避免 copy-on-write 静默丢失业务数据。
    if (sourceTableMismatch(targetDb, tableName)) {
      throw new VccStorageMigrationError(
        'vcc-storage-non-vcc-table-mismatch',
        `${tableName} 非 VCC 业务数据不守恒`,
        { tableName }
      );
    }
  }
}

function validateAttachedTarget(targetDb) {
  validatePreservedNonVccTables(targetDb);
  const sourceEffectiveCount = Number(targetDb.prepare(
    'SELECT COUNT(*) AS count FROM source_db.vcc_fin_op_effective_rows'
  ).get().count) || 0;
  const targetEffectiveCount = Number(targetDb.prepare(
    'SELECT COUNT(*) AS count FROM main.vcc_fin_op_effective_rows'
  ).get().count) || 0;
  if (sourceEffectiveCount !== targetEffectiveCount) {
    throw new VccStorageMigrationError(
      'vcc-storage-effective-count-mismatch',
      'effective_rows 行数守恒失败',
      { sourceEffectiveCount, targetEffectiveCount }
    );
  }
  const identityMismatch = targetDb.prepare(`
    SELECT source.id
    FROM source_db.vcc_fin_op_effective_rows AS source
    LEFT JOIN main.vcc_fin_op_effective_rows AS target ON target.id = source.id
    WHERE target.id IS NULL
       OR target.source_type <> source.source_type
       OR target.idempotency_key <> source.idempotency_key
       OR target.content_hash <> source.content_hash
       OR target.hash_version <> source.hash_version
       OR target.target_month <> source.target_month
    LIMIT 1
  `).get();
  if (identityMismatch) {
    throw new VccStorageMigrationError(
      'vcc-storage-effective-identity-mismatch',
      `effective_rows 主键/内容哈希集合不一致（id=${identityMismatch.id}）`
    );
  }
  if (exactTableMismatch(targetDb, 'vcc_fin_op_effective_rows', ['import_source_id'])) {
    throw new VccStorageMigrationError(
      'vcc-storage-effective-business-mismatch',
      'effective_rows 保留的计算、金额、币种或最小血缘字段不守恒'
    );
  }
  const groupedMismatch = targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT target_month, source_type, COUNT(*) AS count
      FROM source_db.vcc_fin_op_effective_rows GROUP BY target_month, source_type
      EXCEPT
      SELECT target_month, source_type, COUNT(*) AS count
      FROM main.vcc_fin_op_effective_rows GROUP BY target_month, source_type
    ) LIMIT 1
  `).get() || targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT target_month, source_type, COUNT(*) AS count
      FROM main.vcc_fin_op_effective_rows GROUP BY target_month, source_type
      EXCEPT
      SELECT target_month, source_type, COUNT(*) AS count
      FROM source_db.vcc_fin_op_effective_rows GROUP BY target_month, source_type
    ) LIMIT 1
  `).get();
  if (groupedMismatch) {
    throw new VccStorageMigrationError(
      'vcc-storage-effective-group-mismatch',
      'effective_rows 各月各来源行数不守恒'
    );
  }

  if (tableExists(targetDb, 'sqlite_sequence', 'source_db')
      && tableExists(targetDb, 'sqlite_sequence')) {
    const sequenceMismatch = targetDb.prepare(`
      SELECT source.name, source.seq AS source_seq, target.seq AS target_seq
      FROM source_db.sqlite_sequence AS source
      JOIN main.sqlite_master AS table_schema
        ON table_schema.type = 'table' AND table_schema.name = source.name
      LEFT JOIN main.sqlite_sequence AS target ON target.name = source.name
      WHERE target.seq IS NULL OR target.seq < source.seq
      LIMIT 1
    `).get();
    if (sequenceMismatch) {
      throw new VccStorageMigrationError(
        'vcc-storage-sequence-mismatch',
        `${sequenceMismatch.name} 自增序列高水位不守恒`
      );
    }
  }

  const counterProjection = ['id', ...IMPORT_COUNTER_COLUMNS].map(quoteIdentifier).join(', ');
  const countersMismatch = targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${counterProjection} FROM source_db.vcc_fin_op_import_records
      EXCEPT SELECT ${counterProjection} FROM main.vcc_fin_op_import_records
    ) LIMIT 1
  `).get() || targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${counterProjection} FROM main.vcc_fin_op_import_records
      EXCEPT SELECT ${counterProjection} FROM source_db.vcc_fin_op_import_records
    ) LIMIT 1
  `).get();
  if (countersMismatch) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-counter-mismatch',
      'import record 分类计数守恒失败'
    );
  }
  const counterFormulaMismatch = targetDb.prepare(`
    SELECT id
    FROM main.vcc_fin_op_import_records
    WHERE raw_count <> inserted_count + skipped_count + invalid_key_count
      + conflict_count + format_error_count + rolled_back_count
    LIMIT 1
  `).get();
  if (counterFormulaMismatch) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-counter-formula-mismatch',
      `import record ${counterFormulaMismatch.id} 六类计数不守恒`
    );
  }

  if (exactTableMismatch(
    targetDb,
    'vcc_fin_op_import_records',
    ['anomaly_count', 'archive_state']
  )) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-record-mismatch',
      'import record 身份、状态、六类计数或处理结论不守恒'
    );
  }

  if (sourceTableMismatch(targetDb, 'vcc_fin_op_import_sources')) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-source-mismatch',
      '迁移前已存在的 VCC 输入来源身份或 SHA/size 不守恒'
    );
  }
  if (sourceTableMismatch(targetDb, 'vcc_fin_op_import_anomalies', ['import_source_id'])) {
    throw new VccStorageMigrationError(
      'vcc-storage-import-anomaly-mismatch',
      '迁移前已存在的 VCC 异常审计内容不守恒'
    );
  }

  const fallbackColumnNames = [
    'effective_row_id',
    'import_source_id',
    'raw_contract_version',
    'raw_json',
    'created_at'
  ];
  const fallbackColumns = fallbackColumnNames.map(quoteIdentifier).join(', ');
  const sourceFallbackColumns = fallbackColumnNames
    .map((column) => `fallback.${quoteIdentifier(column)}`)
    .join(', ');
  const sourceHasArchiveEvidence = tableExists(targetDb, 'archive_artifacts', 'source_db')
    && tableExists(targetDb, 'archive_blobs', 'source_db');
  const expectedFallbackSql = sourceHasArchiveEvidence
    ? `
      SELECT ${sourceFallbackColumns}
      FROM source_db.vcc_fin_op_effective_raw_fallback AS fallback
      JOIN source_db.vcc_fin_op_import_sources AS source
        ON source.id = fallback.import_source_id
      LEFT JOIN source_db.archive_artifacts AS artifact
        ON artifact.id = source.archive_artifact_id
      LEFT JOIN source_db.archive_blobs AS blob ON blob.id = artifact.blob_id
      WHERE NOT (
        source.archive_state = 'ready'
        AND artifact.status = 'ready'
        AND lower(blob.sha256) = lower(source.source_sha256)
        AND blob.size_bytes = source.source_size_bytes
      )
    `
    : `
      SELECT ${sourceFallbackColumns}
      FROM source_db.vcc_fin_op_effective_raw_fallback AS fallback
    `;
  const missingFallback = targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      ${expectedFallbackSql}
      EXCEPT
      SELECT ${fallbackColumns} FROM main.vcc_fin_op_effective_raw_fallback
    ) LIMIT 1
  `).get();
  const unexpectedFallback = targetDb.prepare(`
    SELECT 1 AS mismatch FROM (
      SELECT ${fallbackColumns} FROM main.vcc_fin_op_effective_raw_fallback
      EXCEPT
      ${expectedFallbackSql}
    ) LIMIT 1
  `).get();
  if (missingFallback || unexpectedFallback) {
    throw new VccStorageMigrationError(
      'vcc-storage-fallback-mismatch',
      '未归档 fallback 守恒失败，或已验证 artifact 的 fallback 未清理'
    );
  }

  for (const tableName of FULLY_PRESERVED_VCC_TABLES) {
    const derivedColumns = ['vcc_fin_op_system_snapshots', 'vcc_fin_op_system_snapshot_attempts']
      .includes(tableName)
      ? ['import_source_id']
      : [];
    if (exactTableMismatch(targetDb, tableName, derivedColumns)) {
      throw new VccStorageMigrationError(
        'vcc-storage-preserved-table-mismatch',
        `${tableName} 业务结果或审计数据不守恒`,
        { tableName }
      );
    }
  }

  const unexpectedCurrency = targetDb.prepare(`
    SELECT currency FROM main.vcc_fin_op_run_balances
    WHERE currency NOT IN (${EXPECTED_CURRENCIES.map(() => '?').join(', ')})
    LIMIT 1
  `).get(...EXPECTED_CURRENCIES);
  if (unexpectedCurrency) {
    throw new VccStorageMigrationError(
      'vcc-storage-currency-mismatch',
      `结果余额出现九币种以外的 ${unexpectedCurrency.currency}`
    );
  }

  if (tableExists(targetDb, 'archive_artifact_holds')) {
    const invalidReadySource = targetDb.prepare(`
      SELECT source.id
      FROM main.vcc_fin_op_import_sources AS source
      LEFT JOIN main.archive_artifacts AS artifact ON artifact.id = source.archive_artifact_id
      LEFT JOIN main.archive_blobs AS blob ON blob.id = artifact.blob_id
      WHERE source.archive_state = 'ready'
        AND (
          source.archive_artifact_id IS NULL
          OR artifact.id IS NULL
          OR artifact.status <> 'ready'
          OR blob.id IS NULL
          OR lower(blob.sha256) <> lower(source.source_sha256)
          OR blob.size_bytes <> source.source_size_bytes
        )
      LIMIT 1
    `).get();
    if (invalidReadySource) {
      throw new VccStorageMigrationError(
        'vcc-storage-archive-reference-mismatch',
        `VCC 输入来源 ${invalidReadySource.id} 的 ready artifact/SHA/size 不一致`
      );
    }
    const missingHold = targetDb.prepare(`
      SELECT source.id
      FROM main.vcc_fin_op_import_sources AS source
      WHERE source.archive_state = 'ready'
        AND source.archive_artifact_id IS NOT NULL
        AND ${activeSourceReferenceSql('source')}
        AND NOT EXISTS (
          SELECT 1 FROM main.archive_artifact_holds AS hold
          WHERE hold.artifact_id = source.archive_artifact_id
            AND hold.owner_module = 'vcc-financial-op'
            AND hold.owner_type = 'vcc-import-source'
            AND hold.owner_id = CAST(source.id AS TEXT)
        )
      LIMIT 1
    `).get();
    if (missingHold) {
      throw new VccStorageMigrationError(
        'vcc-storage-hold-mismatch',
        `VCC 输入来源 ${missingHold.id} 缺少 archive business hold`
      );
    }
    const unexpectedHold = targetDb.prepare(`
      SELECT hold.id
      FROM main.archive_artifact_holds AS hold
      LEFT JOIN main.vcc_fin_op_import_sources AS source
        ON hold.owner_id = CAST(source.id AS TEXT)
       AND hold.artifact_id = source.archive_artifact_id
      WHERE hold.owner_module = 'vcc-financial-op'
        AND hold.owner_type = 'vcc-import-source'
        AND (source.id IS NULL OR NOT ${activeSourceReferenceSql('source')})
      LIMIT 1
    `).get();
    if (unexpectedHold) {
      throw new VccStorageMigrationError(
        'vcc-storage-hold-mismatch',
        `archive business hold ${unexpectedHold.id} 没有对应的 VCC 有效引用`
      );
    }
  }
}

function buildVccStorageCandidate(options) {
  const sourcePath = path.resolve(String(options.sourcePath || ''));
  const targetPath = path.resolve(String(options.targetPath || ''));
  const fsImpl = options.fsImpl || fs;
  const onProgress = options.onProgress;
  const faultInjector = options.faultInjector;
  if (!sourcePath || !targetPath || sourcePath === targetPath
      || path.dirname(sourcePath) !== path.dirname(targetPath)) {
    throw new TypeError('VCC storage rebuild 要求同目录、不同名的 source/target');
  }
  if (safeStatSize(targetPath, fsImpl) > 0) {
    throw new VccStorageMigrationError('vcc-storage-target-exists', '候选数据库已存在，禁止覆盖');
  }

  const lockDb = new DatabaseSync(sourcePath);
  let targetDb = null;
  let sourceDb = null;
  let sourceLocked = false;
  try {
    emitProgress(onProgress, 'checkpoint', 0, 1, '正在收敛 WAL');
    const checkpoint = lockDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const busy = Number(checkpoint && checkpoint.busy) || 0;
    const log = Number(checkpoint && checkpoint.log) || 0;
    const checkpointed = Number(checkpoint && checkpoint.checkpointed) || 0;
    if (busy !== 0 || log !== checkpointed) {
      throw new VccStorageMigrationError(
        'vcc-storage-checkpoint-failed',
        'WAL checkpoint 未完全收敛，旧数据库保持不变',
        { checkpoint: { busy, log, checkpointed } }
      );
    }
    lockDb.exec('BEGIN IMMEDIATE');
    sourceLocked = true;
    sourceDb = openReadOnlyDatabase(sourcePath);
    const readiness = assertSourceReady(sourceDb);
    if (readiness.noChange) return { noChange: true, contractVersion: readiness.contractVersion };
    const estimate = migrationEstimate(sourceDb, sourcePath);
    const freeBytes = assertFreeSpace(
      path.dirname(sourcePath),
      estimate.requiredFreeBytes,
      fsImpl,
      options.availableBytes
    );
    invokeFault(faultInjector, 'after-preflight', { estimate, freeBytes });

    targetDb = new DatabaseSync(targetPath);
    const pageSize = pragmaValue(sourceDb, 'page_size') || 4096;
    targetDb.exec(`PRAGMA page_size = ${pageSize}`);
    targetDb.exec('PRAGMA journal_mode = OFF');
    targetDb.exec('PRAGMA synchronous = OFF');
    targetDb.exec('PRAGMA foreign_keys = OFF');
    targetDb.exec('PRAGMA temp_store = FILE');
    targetDb.prepare('ATTACH DATABASE ? AS source_db').run(sourcePath);
    targetDb.exec('BEGIN');
    const tables = createTargetTables(sourceDb, targetDb);
    emitProgress(onProgress, 'copying', 0, tables.length + 4, '正在复制数据库');
    let processed = 0;
    for (const tableName of tables) {
      const copied = tableName === 'vcc_fin_op_effective_rows'
        ? copySlimEffectiveRows(targetDb)
        : copyRegularTable(targetDb, tableName);
      processed += 1;
      emitProgress(onProgress, 'copying', processed, tables.length + 4, tableName);
      invokeFault(faultInjector, 'after-table-copy', { tableName, copied, processed });
    }
    const preservedSequenceCount = preserveAutoincrementHighWatermarks(targetDb);
    const migratedAnomalies = migrateLegacyAnomalies(targetDb);
    processed += 1;
    emitProgress(onProgress, 'copying', processed, tables.length + 4, '转换异常审计');
    const migratedLegacyErrors = migrateLegacyImportErrors(targetDb);
    const migratedFailures = migrateFileFailures(targetDb);
    const historicalLineage = bindExactHistoricalImportSources(targetDb, {
      archiveRootDir: options.archiveRootDir,
      fsImpl
    });
    const removedReadyFallbacks = removeVerifiedReadyFallbacks(targetDb);
    refreshImportRecordSummaries(targetDb);
    reconcileVccHolds(targetDb);
    processed += 1;
    emitProgress(onProgress, 'copying', processed, tables.length + 4, '刷新血缘状态');
    setVccStorageContractVersion(targetDb, VCC_STORAGE_CONTRACT_VERSION);
    createSecondarySchema(sourceDb, targetDb);
    const userVersion = pragmaValue(sourceDb, 'user_version');
    targetDb.exec(`PRAGMA user_version = ${userVersion}`);
    processed += 1;
    emitProgress(onProgress, 'verifying', processed, tables.length + 4, '验证业务守恒');
    validateAttachedTarget(targetDb);
    invokeFault(faultInjector, 'before-target-commit');
    targetDb.exec('COMMIT');
    // 仅统计候选库；裸 ANALYZE 会连 attached source 一起尝试写 sqlite_stat，
    // 与旧库 BEGIN IMMEDIATE 保护锁冲突，也违反“旧库只读”合同。
    targetDb.exec('ANALYZE main');
    targetDb.exec('PRAGMA main.optimize');
    targetDb.exec('DETACH DATABASE source_db');
    targetDb.exec('PRAGMA synchronous = FULL');
    targetDb.exec('PRAGMA journal_mode = DELETE');
    targetDb.exec('PRAGMA foreign_keys = ON');
    targetDb.close();
    targetDb = null;
    // 候选库此前使用 synchronous=OFF 提升 copy-on-write 吞吐；关闭连接并不
    // 等价于断电耐久。只有数据库文件和同目录目录项都显式落盘后，才允许
    // 把它作为可切换候选，避免 rename 已完成而候选内容仍滞留页缓存。
    fsyncFile(targetPath, fsImpl);
    fsyncDirectory(path.dirname(targetPath), fsImpl);
    invokeFault(faultInjector, 'after-candidate-fsync');
    const verificationDb = openReadOnlyDatabase(targetPath);
    let afterDbstat;
    try {
      assertIntegrity(verificationDb, '候选数据库');
      if (storageContractVersion(verificationDb) !== VCC_STORAGE_CONTRACT_VERSION) {
        throw new VccStorageMigrationError(
          'vcc-storage-contract-write-failed',
          '候选数据库未写入 VCC storage contract v2'
        );
      }
      if (Number(verificationDb.prepare(
        'SELECT COUNT(*) AS count FROM vcc_fin_op_import_staging_rows'
      ).get().count) !== 0) {
        throw new VccStorageMigrationError('vcc-storage-staging-not-empty', '候选数据库 staging 未清空');
      }
      afterDbstat = collectDbstat(verificationDb);
    } finally {
      verificationDb.close();
    }
    const newCoreBytes = vccCoreBytes(afterDbstat);
    const reductionRatio = estimate.oldCoreBytes > 0
      ? 1 - (newCoreBytes / estimate.oldCoreBytes)
      : 0;
    if (estimate.oldCoreBytes >= MIN_REDUCTION_GATE_BYTES
        && reductionRatio < MIN_VCC_CORE_REDUCTION_RATIO) {
      throw new VccStorageMigrationError(
        'vcc-storage-reduction-gate-failed',
        `VCC 核心表仅下降 ${(reductionRatio * 100).toFixed(2)}%，未达到 75% 门禁`,
        { oldCoreBytes: estimate.oldCoreBytes, newCoreBytes, reductionRatio }
      );
    }
    processed += 1;
    const result = {
      noChange: false,
      sourcePath,
      targetPath,
      sourceBytes: estimate.sourceBytes,
      targetBytes: safeStatSize(targetPath, fsImpl),
      oldCoreBytes: estimate.oldCoreBytes,
      newCoreBytes,
      reductionRatio,
      migratedAnomalies,
      migratedLegacyErrors,
      migratedFailures,
      preservedSequenceCount,
      historicalLineage,
      removedReadyFallbacks,
      effectiveCount: estimate.effectiveCount,
      anomalyCount: estimate.anomalyCount,
      beforeDbstat: collectDbstatFromPath(sourcePath),
      afterDbstat
    };
    emitProgress(onProgress, 'verified', processed, tables.length + 4, '候选数据库验证完成');
    if (typeof options.holdSourceLockUntilAck === 'function') {
      options.holdSourceLockUntilAck(Object.freeze({ ...result }));
    }
    sourceDb.close();
    sourceDb = null;
    lockDb.exec('COMMIT');
    sourceLocked = false;
    return result;
  } catch (error) {
    if (targetDb) {
      try { targetDb.exec('ROLLBACK'); } catch (_rollbackError) {}
      try { targetDb.close(); } catch (_closeError) {}
    }
    if (sourceDb) try { sourceDb.close(); } catch (_closeError) {}
    cleanupDatabaseCandidate(targetPath, fsImpl);
    throw error;
  } finally {
    if (sourceLocked) {
      try { lockDb.exec('ROLLBACK'); } catch (_rollbackError) {}
    }
    try { lockDb.close(); } catch (_closeError) {}
  }
}

function verifyReopenedDatabase(dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  try {
    assertIntegrity(db, '切换后数据库');
    if (storageContractVersion(db) !== VCC_STORAGE_CONTRACT_VERSION) {
      throw new VccStorageMigrationError(
        'vcc-storage-reopen-contract-mismatch',
        '切换后只读复验未识别 VCC storage contract v2'
      );
    }
    const stagingCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM vcc_fin_op_import_staging_rows'
    ).get().count) || 0;
    if (stagingCount !== 0) {
      throw new VccStorageMigrationError(
        'vcc-storage-reopen-staging-not-empty',
        '切换后只读复验发现 staging 未清空'
      );
    }
    return { ok: true, contractVersion: VCC_STORAGE_CONTRACT_VERSION };
  } finally {
    db.close();
  }
}

function beginRollbackJournal(journalPath, journal, error, fsImpl = fs) {
  let suffix = Date.now();
  let failedCandidatePath = `${journal.targetPath}.failed-${suffix}`;
  while (fsImpl.existsSync(failedCandidatePath)) {
    suffix += 1;
    failedCandidatePath = `${journal.targetPath}.failed-${suffix}`;
  }
  return updateJournal(journalPath, journal, 'rolling-back', {
    failedCandidatePath,
    lastError: {
      code: error && error.code ? error.code : 'switch-failed',
      message: error && error.message ? error.message : String(error)
    }
  }, fsImpl);
}

function completeRollbackJournal(journalPath, journal, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const failedCandidatePath = journal.failedCandidatePath;
  if (!isOwnedFailedCandidate(journal, failedCandidatePath)) {
    throw new VccStorageMigrationError(
      'vcc-storage-journal-invalid',
      '回滚记录缺少安全的失败候选路径，已停止自动恢复'
    );
  }
  let sourceExists = fsImpl.existsSync(journal.sourcePath);
  let backupExists = fsImpl.existsSync(journal.backupPath);
  let failedCandidateExists = fsImpl.existsSync(failedCandidatePath);
  const targetExists = fsImpl.existsSync(journal.targetPath);
  if (targetExists) {
    if (sourceExists || !backupExists || failedCandidateExists) {
      throw new VccStorageMigrationError(
        'vcc-storage-recovery-conflict',
        '回滚期间候选路径与数据库状态冲突，已停止自动恢复'
      );
    }
    fsImpl.renameSync(journal.targetPath, failedCandidatePath);
    fsyncDirectory(path.dirname(journal.targetPath), fsImpl);
    invokeFault(options.faultInjector, 'after-failed-candidate-rename');
    failedCandidateExists = true;
  }
  if (backupExists) {
    if (sourceExists) {
      if (failedCandidateExists) {
        throw new VccStorageMigrationError(
          'vcc-storage-recovery-conflict',
          '回滚期间同时存在活动候选与失败候选，已停止自动恢复'
        );
      }
      fsImpl.renameSync(journal.sourcePath, failedCandidatePath);
      fsyncDirectory(path.dirname(journal.sourcePath), fsImpl);
      invokeFault(options.faultInjector, 'after-failed-candidate-rename');
      sourceExists = false;
      failedCandidateExists = true;
    } else if (!failedCandidateExists) {
      throw new VccStorageMigrationError(
        'vcc-storage-recovery-conflict',
        '回滚期间活动库与失败候选均不存在，已停止自动恢复'
      );
    }
    fsImpl.renameSync(journal.backupPath, journal.sourcePath);
    fsyncDirectory(path.dirname(journal.sourcePath), fsImpl);
    invokeFault(options.faultInjector, 'after-rollback-source-restore');
    sourceExists = true;
    backupExists = false;
  }
  if (!sourceExists || backupExists) {
    throw new VccStorageMigrationError(
      'vcc-storage-recovery-conflict',
      '回滚后的旧数据库文件状态不唯一，已停止自动恢复'
    );
  }

  const db = openReadOnlyDatabase(journal.sourcePath);
  try {
    assertIntegrity(db, '已恢复的旧数据库');
    if (storageContractVersion(db) !== 1) {
      throw new VccStorageMigrationError(
        'vcc-storage-rollback-contract-mismatch',
        '回滚后的数据库合同版本不是 v1'
      );
    }
  } finally {
    db.close();
  }

  let cleanupError = null;
  if (fsImpl.existsSync(failedCandidatePath)) {
    try {
      cleanupDatabaseCandidate(failedCandidatePath, fsImpl);
      fsyncDirectory(path.dirname(failedCandidatePath), fsImpl);
    } catch (error) {
      cleanupError = error;
    }
  }
  const rolledBack = updateJournal(journalPath, journal, 'rolled-back', {
    failedCandidatePath: cleanupError ? failedCandidatePath : null,
    lastError: {
      ...(journal.lastError || {}),
      cleanupCode: cleanupError && cleanupError.code ? cleanupError.code : null,
      cleanupMessage: cleanupError ? cleanupError.message || String(cleanupError) : null
    }
  }, fsImpl);
  if (cleanupError) {
    throw new VccStorageMigrationError(
      'vcc-storage-failed-candidate-cleanup-failed',
      '旧数据库已恢复，但失败候选库尚未清理；下次启动将继续处理',
      { cleanupCause: cleanupError, failedCandidatePath }
    );
  }
  return rolledBack;
}

function createMigrationJournal(options) {
  const now = options.now || new Date();
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    migrationId: options.migrationId || `vcc-storage-${now.getTime()}`,
    sourcePath: path.resolve(options.sourcePath),
    targetPath: path.resolve(options.targetPath),
    backupPath: path.resolve(options.backupPath),
    phase: 'prepared',
    deleteOldDatabase: options.deleteOldDatabase === true,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastError: null
  };
}

function atomicSwitchVccStorage(options) {
  const fsImpl = options.fsImpl || fs;
  const journalPath = path.resolve(options.journalPath);
  let journal = options.journal || createMigrationJournal(options);
  const sourcePath = journal.sourcePath;
  const targetPath = journal.targetPath;
  const backupPath = journal.backupPath;
  let reopenVerified = false;
  if (!fsImpl.existsSync(sourcePath) || !fsImpl.existsSync(targetPath) || fsImpl.existsSync(backupPath)) {
    throw new VccStorageMigrationError(
      'vcc-storage-switch-precondition-failed',
      '数据库原子切换前置状态不唯一，已停止处理'
    );
  }
  const sourceWalBytes = safeStatSize(`${sourcePath}-wal`, fsImpl);
  const targetWalBytes = safeStatSize(`${targetPath}-wal`, fsImpl);
  if (sourceWalBytes > 0 || targetWalBytes > 0) {
    throw new VccStorageMigrationError(
      'vcc-storage-switch-wal-not-empty',
      '原子切换前 WAL 仍有未收敛内容，旧数据库保持不变',
      { sourceWalBytes, targetWalBytes }
    );
  }
  // atomicSwitch 也是公共恢复边界：即使调用方不是标准 worker 流程，也必须
  // 在写 switching journal 前确认新旧主文件均已持久化。
  fsyncFile(sourcePath, fsImpl);
  fsyncFile(targetPath, fsImpl);
  fsyncDirectory(path.dirname(sourcePath), fsImpl);
  // 所有连接已关闭且 WAL=0 时，-wal/-shm 仅是可重建的锁旁文件；先移除，
  // 避免旧 shm 名称在新主库首次打开时发生身份碰撞。
  for (const sidecar of [
    `${sourcePath}-wal`, `${sourcePath}-shm`,
    `${targetPath}-wal`, `${targetPath}-shm`, `${targetPath}-journal`
  ]) safeUnlink(sidecar, fsImpl);
  journal = updateJournal(journalPath, journal, 'switching', {}, fsImpl);
  invokeFault(options.faultInjector, 'before-source-rename');
  fsImpl.renameSync(sourcePath, backupPath);
  fsyncDirectory(path.dirname(sourcePath), fsImpl);
  try {
    invokeFault(options.faultInjector, 'after-source-rename');
    fsImpl.renameSync(targetPath, sourcePath);
    fsyncDirectory(path.dirname(sourcePath), fsImpl);
    journal = updateJournal(journalPath, journal, 'switched', {}, fsImpl);
    invokeFault(options.faultInjector, 'after-target-rename');
    const reopened = verifyReopenedDatabase(sourcePath);
    journal = updateJournal(journalPath, journal, 'reopen-verified', { reopened }, fsImpl);
    // 从这一刻起，新库已经完成只读完整性复验，journal 也已持久化唯一
    // authoritative 状态。后续只剩旧库清理与 journal 收口；任何失败都必须
    // 留给启动恢复继续，绝不能再把已验证新库移走后尝试回滚。
    reopenVerified = true;
    if (deleteOldDatabaseDurably(journal, fsImpl)) {
      invokeFault(options.faultInjector, 'after-backup-delete');
    }
    journal = updateJournal(journalPath, journal, 'done', {}, fsImpl);
    removeJournalDurably(journalPath, fsImpl);
    return { status: 'success', sourcePath, backupPath, oldDatabaseDeleted: journal.deleteOldDatabase };
  } catch (error) {
    if (reopenVerified) {
      throw new VccStorageMigrationError(
        'vcc-storage-post-switch-cleanup-failed',
        '新数据库已验证并保持生效，但旧库清理或迁移记录收口失败；下次启动将继续恢复',
        { cause: error, sourcePath, backupPath }
      );
    }
    try {
      journal = beginRollbackJournal(journalPath, journal, error, fsImpl);
      invokeFault(options.faultInjector, 'after-rollback-journal');
      completeRollbackJournal(journalPath, journal, {
        fsImpl,
        faultInjector: options.faultInjector
      });
    } catch (restoreError) {
      if (restoreError && restoreError.code === 'vcc-storage-failed-candidate-cleanup-failed') {
        throw restoreError;
      }
      throw new VccStorageMigrationError(
        'vcc-storage-switch-recovery-failed',
        '新旧数据库切换失败且自动恢复未完成，禁止继续启动',
        { cause: error, recoveryCause: restoreError }
      );
    }
    throw error;
  }
}

function recoverVccStorageMigration(options) {
  const fsImpl = options.fsImpl || fs;
  const journalPath = path.resolve(options.journalPath);
  let journal = readJournal(journalPath, fsImpl);
  if (!journal) return { status: 'none' };
  const sourceExists = fsImpl.existsSync(journal.sourcePath);
  const targetExists = fsImpl.existsSync(journal.targetPath);
  const backupExists = fsImpl.existsSync(journal.backupPath);
  if (PRE_SWITCH_PHASES.has(journal.phase)) {
    if (!sourceExists || backupExists) {
      throw new VccStorageMigrationError(
        'vcc-storage-recovery-conflict',
        '迁移切换前恢复状态与文件不一致，已停止自动处理'
      );
    }
    if (targetExists) {
      cleanupDatabaseCandidate(journal.targetPath, fsImpl);
      fsyncDirectory(path.dirname(journal.targetPath), fsImpl);
    }
    removeJournalDurably(journalPath, fsImpl);
    return { status: 'rolled-back', sourcePath: journal.sourcePath };
  }
  if (journal.phase === 'switching') {
    if (sourceExists && !backupExists) {
      // journal 已持久化，但进程在旧库改名前退出。旧库仍是唯一真相，
      // 候选库（若仍存在）可安全丢弃并回到迁移前状态。
      const db = openReadOnlyDatabase(journal.sourcePath);
      try {
        assertIntegrity(db, '未切换的旧数据库');
        if (storageContractVersion(db) !== 1) {
          throw new VccStorageMigrationError(
            'vcc-storage-recovery-conflict',
            'switching 恢复时源数据库合同版本不符合旧库状态'
          );
        }
      } finally {
        db.close();
      }
      if (targetExists) {
        cleanupDatabaseCandidate(journal.targetPath, fsImpl);
        fsyncDirectory(path.dirname(journal.targetPath), fsImpl);
      }
      removeJournalDurably(journalPath, fsImpl);
      return { status: 'rolled-back', sourcePath: journal.sourcePath };
    }
    if (!sourceExists && backupExists && targetExists) {
      fsImpl.renameSync(journal.targetPath, journal.sourcePath);
      fsyncDirectory(path.dirname(journal.sourcePath), fsImpl);
      journal = updateJournal(journalPath, journal, 'switched', {}, fsImpl);
    } else if (sourceExists && backupExists) {
      const version = (() => {
        const db = openReadOnlyDatabase(journal.sourcePath);
        try { return storageContractVersion(db); } finally { db.close(); }
      })();
      if (version === VCC_STORAGE_CONTRACT_VERSION) {
        journal = updateJournal(journalPath, journal, 'switched', {}, fsImpl);
      } else {
        journal = beginRollbackJournal(
          journalPath,
          journal,
          new VccStorageMigrationError(
            'vcc-storage-reopen-contract-mismatch',
            'switching 恢复时活动候选不符合 v2 合同'
          ),
          fsImpl
        );
        journal = completeRollbackJournal(journalPath, journal, {
          fsImpl,
          faultInjector: options.faultInjector
        });
      }
    } else {
      throw new VccStorageMigrationError(
        'vcc-storage-recovery-conflict',
        '迁移原子切换恢复状态不唯一，已停止自动处理'
      );
    }
  }
  if (journal.phase === 'rolling-back') {
    journal = completeRollbackJournal(journalPath, journal, {
      fsImpl,
      faultInjector: options.faultInjector
    });
  }
  if (journal.phase === 'switched') {
    try {
      const reopened = verifyReopenedDatabase(journal.sourcePath);
      journal = updateJournal(journalPath, journal, 'reopen-verified', { reopened }, fsImpl);
    } catch (error) {
      if (!fsImpl.existsSync(journal.backupPath)) throw error;
      journal = beginRollbackJournal(journalPath, journal, error, fsImpl);
      journal = completeRollbackJournal(journalPath, journal, {
        fsImpl,
        faultInjector: options.faultInjector
      });
    }
  }
  if (journal.phase === 'reopen-verified') {
    verifyReopenedDatabase(journal.sourcePath);
    if (deleteOldDatabaseDurably(journal, fsImpl)) {
      invokeFault(options.faultInjector, 'after-recovery-backup-delete');
    }
    updateJournal(journalPath, journal, 'done', {}, fsImpl);
    removeJournalDurably(journalPath, fsImpl);
    return { status: 'completed', sourcePath: journal.sourcePath };
  }
  if (journal.phase === 'done') {
    verifyReopenedDatabase(journal.sourcePath);
    if (deleteOldDatabaseDurably(journal, fsImpl)) {
      invokeFault(options.faultInjector, 'after-recovery-backup-delete');
    }
    removeJournalDurably(journalPath, fsImpl);
    return { status: 'completed', sourcePath: journal.sourcePath };
  }
  if (journal.phase === 'rolled-back') {
    const db = openReadOnlyDatabase(journal.sourcePath);
    try {
      assertIntegrity(db, '已恢复的旧数据库');
      if (storageContractVersion(db) !== 1) {
        throw new VccStorageMigrationError(
          'vcc-storage-rollback-contract-mismatch',
          '回滚后的数据库合同版本不是 v1'
        );
      }
    } finally {
      db.close();
    }
    if (journal.failedCandidatePath) {
      if (!isOwnedFailedCandidate(journal, journal.failedCandidatePath)) {
        throw new VccStorageMigrationError(
          'vcc-storage-journal-invalid',
          '回滚记录包含不安全的失败候选路径，已停止自动清理'
        );
      }
      cleanupDatabaseCandidate(journal.failedCandidatePath, fsImpl);
      fsyncDirectory(path.dirname(journal.failedCandidatePath), fsImpl);
    }
    removeJournalDurably(journalPath, fsImpl);
    return { status: 'rolled-back', sourcePath: journal.sourcePath };
  }
  throw new VccStorageMigrationError(
    'vcc-storage-journal-phase-invalid',
    `未知迁移阶段 ${journal.phase}`
  );
}

module.exports = {
  EXPECTED_CURRENCIES,
  IMPORT_COUNTER_COLUMNS,
  JOURNAL_SCHEMA_VERSION,
  MIN_VCC_CORE_REDUCTION_RATIO,
  VccStorageMigrationError,
  assertIntegrity,
  assertSourceReady,
  atomicSwitchVccStorage,
  buildVccStorageCandidate,
  collectDbstat,
  createMigrationJournal,
  inspectVccStorage,
  migrationEstimate,
  readJournal,
  recoverVccStorageMigration,
  storageContractVersion,
  updateJournal,
  validateAttachedTarget,
  verifyReopenedDatabase,
  vccCoreBytes
};
