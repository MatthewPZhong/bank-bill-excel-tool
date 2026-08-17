'use strict';

const VCC_STORAGE_CONTRACT_VERSION = 2;
const VCC_STORAGE_CONTRACT_SETTING_KEY = 'vcc_storage_contract_version';
const VCC_STORAGE_WRITE_CAPABILITY_FUNCTION = 'vcc_storage_write_capability_v2';
const VCC_STORAGE_WRITE_CAPABILITY_TOKEN = 'vcc-storage-contract-v2';
const VCC_STORAGE_GUARD_TRIGGER_PREFIX = 'vcc_storage_contract_v2_guard_';
const VCC_STORAGE_GUARD_ERROR_MESSAGE = 'VCC storage contract v2 write capability required';
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('VCC storage contract 需要 DatabaseSync');
  }
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (tableColumns(db, tableName).has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function assertTableName(tableName) {
  const name = String(tableName || '');
  if (!SQL_IDENTIFIER_RE.test(name)) throw new TypeError('VCC 表名非法');
  return name;
}

function registerVccStorageWriteCapability(db) {
  assertDatabase(db);
  if (typeof db.function !== 'function') {
    throw new Error('当前 SQLite 连接不支持 VCC storage contract 写能力注册');
  }
  db.function(
    VCC_STORAGE_WRITE_CAPABILITY_FUNCTION,
    { deterministic: true },
    () => VCC_STORAGE_WRITE_CAPABILITY_TOKEN
  );
}

function vccTableNames(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name GLOB 'vcc_fin_op_*'
    ORDER BY name
  `).all().map((row) => assertTableName(row.name));
}

function guardTriggerName(tableName, operation) {
  return assertTableName(`${VCC_STORAGE_GUARD_TRIGGER_PREFIX}${tableName}_${operation}`);
}

function vccStorageGuardTriggerDefinition(tableName, operation) {
  const name = assertTableName(tableName);
  const normalizedOperation = String(operation || '').toLowerCase();
  if (!['insert', 'update', 'delete'].includes(normalizedOperation)) {
    throw new TypeError('VCC storage guard trigger 操作非法');
  }
  const triggerName = guardTriggerName(name, normalizedOperation);
  const body = `
    BEFORE ${normalizedOperation.toUpperCase()} ON ${name}
    BEGIN
      SELECT CASE
        WHEN ${VCC_STORAGE_WRITE_CAPABILITY_FUNCTION}() <> '${VCC_STORAGE_WRITE_CAPABILITY_TOKEN}'
        THEN RAISE(ABORT, '${VCC_STORAGE_GUARD_ERROR_MESSAGE}')
      END;
    END
  `;
  return Object.freeze({
    name: triggerName,
    tableName: name,
    operation: normalizedOperation,
    sql: `CREATE TRIGGER ${triggerName}${body}`,
    createSql: `CREATE TRIGGER IF NOT EXISTS ${triggerName}${body}`
  });
}

function installVccStorageWriteGuards(db) {
  assertDatabase(db);
  registerVccStorageWriteCapability(db);
  for (const tableName of vccTableNames(db)) {
    for (const operation of ['insert', 'update', 'delete']) {
      db.exec(vccStorageGuardTriggerDefinition(tableName, operation).createSql);
    }
  }
}

function createSlimEffectiveRowsTable(db, tableName = 'vcc_fin_op_effective_rows') {
  assertDatabase(db);
  const name = assertTableName(tableName);
  db.exec(`
    CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal')),
      idempotency_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hash_version INTEGER NOT NULL DEFAULT 1,
      raw_contract_version INTEGER NOT NULL DEFAULT 1,
      legacy_content_hash TEXT,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      stat_currency TEXT,
      signed_amount TEXT,
      business_department TEXT,
      counterparty_department TEXT,
      business_sub_type TEXT,
      channel_name TEXT,
      mid TEXT,
      recon_type TEXT,
      pending_currency TEXT,
      pending_amount TEXT,
      flow_currency TEXT,
      flow_amount TEXT,
      currency_mismatch INTEGER,
      import_record_id INTEGER NOT NULL,
      import_source_id INTEGER,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      first_imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      FOREIGN KEY (import_source_id) REFERENCES vcc_fin_op_import_sources(id),
      UNIQUE (source_type, idempotency_key)
    );
  `);
}

function ensureVccStorageSideTables(db) {
  assertDatabase(db);
  addColumnIfMissing(
    db,
    'vcc_fin_op_import_records',
    'anomaly_count',
    'anomaly_count INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0)'
  );
  addColumnIfMissing(
    db,
    'vcc_fin_op_import_records',
    'archive_state',
    "archive_state TEXT NOT NULL DEFAULT 'pending'"
  );
  addColumnIfMissing(
    db,
    'vcc_fin_op_effective_rows',
    'import_source_id',
    'import_source_id INTEGER'
  );
  addColumnIfMissing(
    db,
    'vcc_fin_op_system_snapshots',
    'import_source_id',
    'import_source_id INTEGER'
  );
  addColumnIfMissing(
    db,
    'vcc_fin_op_system_snapshot_attempts',
    'import_source_id',
    'import_source_id INTEGER'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 1),
      source_file_name TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes >= 0),
      archive_artifact_id INTEGER,
      archive_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (archive_state IN ('pending', 'ready', 'failed', 'unavailable')),
      last_error_code TEXT,
      last_error_message TEXT,
      bound_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id) ON DELETE CASCADE,
      UNIQUE (import_record_id, source_ordinal)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vcc_fin_op_import_sources_artifact
      ON vcc_fin_op_import_sources(archive_artifact_id)
      WHERE archive_artifact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_sources_record
      ON vcc_fin_op_import_sources(import_record_id, source_ordinal);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_sources_sha
      ON vcc_fin_op_import_sources(source_sha256, source_size_bytes);

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_staging_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      import_source_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      target_month TEXT NOT NULL,
      idempotency_key_raw TEXT,
      idempotency_key TEXT,
      content_hash TEXT,
      hash_version INTEGER NOT NULL DEFAULT 1,
      raw_contract_version INTEGER NOT NULL DEFAULT 1,
      subject TEXT,
      stat_currency TEXT,
      signed_amount TEXT,
      business_department TEXT,
      counterparty_department TEXT,
      business_sub_type TEXT,
      channel_name TEXT,
      mid TEXT,
      recon_type TEXT,
      pending_currency TEXT,
      pending_amount TEXT,
      flow_currency TEXT,
      flow_amount TEXT,
      currency_mismatch INTEGER,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      disposition TEXT CHECK (disposition IS NULL OR disposition IN (
        'accepted', 'idempotent_skip', 'idempotent_conflict',
        'invalid_key', 'format_error', 'rolled_back'
      )),
      validation_field TEXT,
      validation_message TEXT,
      existing_effective_id INTEGER,
      comparison_import_row_id INTEGER,
      diff_fields_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id) ON DELETE CASCADE,
      FOREIGN KEY (import_source_id) REFERENCES vcc_fin_op_import_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (existing_effective_id) REFERENCES vcc_fin_op_effective_rows(id) ON DELETE SET NULL,
      FOREIGN KEY (comparison_import_row_id) REFERENCES vcc_fin_op_import_staging_rows(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_staging_record_disposition
      ON vcc_fin_op_import_staging_rows(import_record_id, disposition, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_staging_record_key
      ON vcc_fin_op_import_staging_rows(import_record_id, idempotency_key, content_hash, id);

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      import_source_id INTEGER,
      effective_row_id INTEGER,
      source_type TEXT NOT NULL,
      target_month TEXT NOT NULL,
      idempotency_key TEXT,
      source_file_name TEXT NOT NULL DEFAULT '',
      sheet_name TEXT,
      source_row INTEGER,
      category TEXT NOT NULL CHECK (category IN (
        'invalid_key', 'format_error', 'idempotent_conflict',
        'system_subject_error', 'file_failure'
      )),
      abnormal_fields_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL,
      incoming_content_hash TEXT,
      existing_content_hash TEXT,
      diff_fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id) ON DELETE CASCADE,
      FOREIGN KEY (import_source_id) REFERENCES vcc_fin_op_import_sources(id) ON DELETE SET NULL,
      FOREIGN KEY (effective_row_id) REFERENCES vcc_fin_op_effective_rows(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_anomalies_record
      ON vcc_fin_op_import_anomalies(import_record_id, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_anomalies_category
      ON vcc_fin_op_import_anomalies(category, target_month, id);

    CREATE TABLE IF NOT EXISTS vcc_fin_op_effective_raw_fallback (
      effective_row_id INTEGER PRIMARY KEY,
      import_source_id INTEGER NOT NULL,
      raw_contract_version INTEGER NOT NULL DEFAULT 1,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (effective_row_id) REFERENCES vcc_fin_op_effective_rows(id) ON DELETE CASCADE,
      FOREIGN KEY (import_source_id) REFERENCES vcc_fin_op_import_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_fallback_source
      ON vcc_fin_op_effective_raw_fallback(import_source_id, effective_row_id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_effective_source_coordinate
      ON vcc_fin_op_effective_rows(
        import_source_id, target_month, source_type, sheet_name, source_row, id
      );
  `);

  // v1 数据库不会在普通启动时隐式执行物理重建。历史终态记录没有
  // import_sources，不能沿用新增列的默认 pending 冒充“输入文件待存档”。
  db.exec(`
    UPDATE vcc_fin_op_import_records
    SET archive_state = 'unavailable'
    WHERE archive_state = 'pending'
      AND status <> 'importing'
      AND NOT EXISTS (
        SELECT 1 FROM vcc_fin_op_import_sources AS source
        WHERE source.import_record_id = vcc_fin_op_import_records.id
      );
  `);

  if (getVccStorageContractVersion(db) >= VCC_STORAGE_CONTRACT_VERSION) {
    installVccStorageWriteGuards(db);
  }
}

function getVccStorageContractVersion(db) {
  assertDatabase(db);
  const hasSettings = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'
  `).get());
  if (!hasSettings) return 1;
  const row = db.prepare(`
    SELECT setting_value FROM app_settings WHERE setting_key = ?
  `).get(VCC_STORAGE_CONTRACT_SETTING_KEY);
  if (!row) return 1;
  const version = Number(row.setting_value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('VCC 存储合同版本无效，禁止继续打开数据库');
  }
  if (version > VCC_STORAGE_CONTRACT_VERSION) {
    throw new Error(`VCC 存储合同版本 ${version} 高于当前程序支持的 ${VCC_STORAGE_CONTRACT_VERSION}`);
  }
  return version;
}

function setVccStorageContractVersion(db, version) {
  assertDatabase(db);
  const normalized = Number(version);
  if (normalized !== VCC_STORAGE_CONTRACT_VERSION) {
    throw new TypeError(`只能写入 VCC storage contract v${VCC_STORAGE_CONTRACT_VERSION}`);
  }
  registerVccStorageWriteCapability(db);
  db.exec('SAVEPOINT vcc_storage_contract_v2_install');
  try {
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, datetime('now', 'localtime'))
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `).run(VCC_STORAGE_CONTRACT_SETTING_KEY, String(normalized));
    installVccStorageWriteGuards(db);
    db.exec('RELEASE SAVEPOINT vcc_storage_contract_v2_install');
  } catch (error) {
    try {
      db.exec(`
        ROLLBACK TO SAVEPOINT vcc_storage_contract_v2_install;
        RELEASE SAVEPOINT vcc_storage_contract_v2_install;
      `);
    } catch (_rollbackError) { /* preserve original error */ }
    throw error;
  }
  return normalized;
}

module.exports = {
  VCC_STORAGE_CONTRACT_SETTING_KEY,
  VCC_STORAGE_CONTRACT_VERSION,
  VCC_STORAGE_GUARD_TRIGGER_PREFIX,
  VCC_STORAGE_WRITE_CAPABILITY_FUNCTION,
  VCC_STORAGE_WRITE_CAPABILITY_TOKEN,
  createSlimEffectiveRowsTable,
  ensureVccStorageSideTables,
  getVccStorageContractVersion,
  installVccStorageWriteGuards,
  registerVccStorageWriteCapability,
  setVccStorageContractVersion,
  vccStorageGuardTriggerDefinition
};
