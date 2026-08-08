'use strict';

const {
  SOURCE_TYPES,
  PENDING_HEADERS,
  PENDING_V1_HEADERS,
  PENDING_RAW_CONTRACT_V1,
  PENDING_RAW_CONTRACT_V2
} = require('../vcc-financial-op/definitions');
const {
  PENDING_HASH_VERSION,
  pendingContentHash
} = require('../vcc-financial-op/row-mapper');
const {
  STRICT_YEAR_MONTH_PATTERN,
  diagnoseFirstMonthFacts,
  readFirstMonthFacts
} = require('./state-model');

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function parsePendingRawJson(rawJson, tableName, rowId) {
  let values;
  try { values = JSON.parse(rawJson); } catch (_error) { values = null; }
  if (!Array.isArray(values)) {
    const error = new Error(`${tableName} 记录 ${rowId} 的 Pending raw_json 不是数组，已阻止升级`);
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  if (values.length === PENDING_V1_HEADERS.length) {
    return { values, rawContractVersion: PENDING_RAW_CONTRACT_V1 };
  }
  if (values.length === PENDING_HEADERS.length) {
    return { values, rawContractVersion: PENDING_RAW_CONTRACT_V2 };
  }
  const error = new Error(
    `${tableName} 记录 ${rowId} 的 Pending raw_json 为 ${values.length} 项，既不是历史 48 列也不是最新 46 列，已阻止升级`
  );
  error.code = 'pending-contract-migration-blocked';
  error.recordIds = [Number(rowId)];
  throw error;
}

function pendingMigrationPlan(db, tableName) {
  const columns = tableColumns(db, tableName);
  const totalRows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get().n || 0);
  if (!columns.has('source_type')) {
    if (totalRows === 0) return [];
    const error = new Error(`${tableName} 缺少 source_type，无法识别历史 Pending 记录，已阻止升级`);
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  const pendingCount = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM ${tableName} WHERE source_type = ?
  `).get(SOURCE_TYPES.PENDING).n || 0);
  if (pendingCount === 0) return [];
  const requiredColumns = ['id', 'raw_json', 'content_hash', 'hash_version', 'raw_contract_version'];
  const missingColumns = requiredColumns.filter((column) => !columns.has(column));
  if (missingColumns.length > 0) {
    const error = new Error(
      `${tableName} 存在 ${pendingCount} 条 Pending 记录，但缺少 ${missingColumns.join('、')}，已阻止升级`
    );
    error.code = 'pending-contract-migration-blocked';
    throw error;
  }
  return db.prepare(`
    SELECT id, raw_json, content_hash, hash_version, raw_contract_version
    FROM ${tableName}
    WHERE source_type = ?
    ORDER BY id
  `).all(SOURCE_TYPES.PENDING).map((row) => {
    const parsed = parsePendingRawJson(row.raw_json, tableName, row.id);
    return {
      ...row,
      desiredRawContractVersion: parsed.rawContractVersion,
      desiredContentHash: pendingContentHash(parsed.values, parsed.rawContractVersion)
    };
  });
}

function pendingSnapshotVersion(rawJson, rowId) {
  if (rawJson === null || rawJson === undefined || rawJson === '') return null;
  return parsePendingRawJson(rawJson, 'vcc_fin_op_import_rows(existing snapshot)', rowId)
    .rawContractVersion;
}

function ensurePendingRawContractSupport(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const importColumns = tableColumns(db, 'vcc_fin_op_import_rows');
    if (!importColumns.has('raw_contract_version')) {
      db.exec('ALTER TABLE vcc_fin_op_import_rows ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!importColumns.has('existing_raw_contract_version_snapshot')) {
      db.exec('ALTER TABLE vcc_fin_op_import_rows ADD COLUMN existing_raw_contract_version_snapshot INTEGER');
    }
    const effectiveColumns = tableColumns(db, 'vcc_fin_op_effective_rows');
    if (!effectiveColumns.has('raw_contract_version')) {
      db.exec('ALTER TABLE vcc_fin_op_effective_rows ADD COLUMN raw_contract_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!effectiveColumns.has('legacy_content_hash')) {
      db.exec('ALTER TABLE vcc_fin_op_effective_rows ADD COLUMN legacy_content_hash TEXT');
    }

    // 先构造完整计划；任一未知 raw_json 会在首条 UPDATE 前抛错并回滚加列。
    const importPlan = pendingMigrationPlan(db, 'vcc_fin_op_import_rows');
    const effectivePlan = pendingMigrationPlan(db, 'vcc_fin_op_effective_rows');
    const snapshotPlan = db.prepare(`
      SELECT id, existing_raw_json_snapshot
      FROM vcc_fin_op_import_rows
      WHERE source_type = ? AND existing_raw_json_snapshot IS NOT NULL
      ORDER BY id
    `).all(SOURCE_TYPES.PENDING).map((row) => ({
      id: row.id,
      version: pendingSnapshotVersion(row.existing_raw_json_snapshot, row.id)
    }));

    if (importPlan.length > 0) {
      const updateImport = db.prepare(`
        UPDATE vcc_fin_op_import_rows
        SET content_hash = ?, hash_version = ?, raw_contract_version = ?
        WHERE id = ?
      `);
      for (const row of importPlan) {
        updateImport.run(
          row.desiredContentHash,
          PENDING_HASH_VERSION,
          row.desiredRawContractVersion,
          row.id
        );
      }
    }
    if (effectivePlan.length > 0) {
      const updateEffective = db.prepare(`
        UPDATE vcc_fin_op_effective_rows
        SET legacy_content_hash = CASE
              WHEN legacy_content_hash IS NULL AND hash_version < ? THEN content_hash
              ELSE legacy_content_hash
            END,
            content_hash = ?, hash_version = ?, raw_contract_version = ?
        WHERE id = ?
      `);
      for (const row of effectivePlan) {
        updateEffective.run(
          PENDING_HASH_VERSION,
          row.desiredContentHash,
          PENDING_HASH_VERSION,
          row.desiredRawContractVersion,
          row.id
        );
      }
    }
    const updateSnapshotVersion = db.prepare(`
      UPDATE vcc_fin_op_import_rows
      SET existing_raw_contract_version_snapshot = ?
      WHERE id = ?
    `);
    for (const row of snapshotPlan) updateSnapshotVersion.run(row.version, row.id);

    for (const [tableName, plan] of [
      ['vcc_fin_op_import_rows', importPlan],
      ['vcc_fin_op_effective_rows', effectivePlan]
    ]) {
      if (plan.length === 0) continue;
      const stored = new Map(db.prepare(`
        SELECT id, content_hash, hash_version, raw_contract_version
        FROM ${tableName}
        WHERE source_type = ?
      `).all(SOURCE_TYPES.PENDING).map((row) => [Number(row.id), row]));
      if (stored.size !== plan.length || plan.some((expected) => {
        const actual = stored.get(Number(expected.id));
        return !actual
          || actual.content_hash !== expected.desiredContentHash
          || Number(actual.hash_version) !== PENDING_HASH_VERSION
          || Number(actual.raw_contract_version) !== expected.desiredRawContractVersion;
      })) {
        throw new Error(`${tableName} Pending v2 哈希迁移提交前断言失败`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

const FIRST_MONTH_DIAGNOSTIC_OPERATION = 'first_month_migration_diagnostic';

function persistFirstMonthDiagnostic(db, diagnostic) {
  if (!diagnostic.blocked) return null;
  const evidenceJson = JSON.stringify({
    code: diagnostic.code,
    reason: diagnostic.reason,
    firstMonth: diagnostic.firstMonth,
    openingMonths: diagnostic.openingMonths,
    invalidFirstMonth: diagnostic.invalidFirstMonth || false,
    invalidOpeningMonths: diagnostic.invalidOpeningMonths || []
  });
  const existing = db.prepare(`
    SELECT id
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ? AND status = 'blocked' AND evidence_json = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(FIRST_MONTH_DIAGNOSTIC_OPERATION, evidenceJson);
  if (existing) return Number(existing.id);
  const targetMonth = diagnostic.firstMonth !== null
    ? diagnostic.firstMonth
    : (diagnostic.openingMonths[0] == null ? '' : diagnostic.openingMonths[0]);
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_operation_audit (
      target_month, operation_type, status, evidence_json, error_message
    ) VALUES (?, ?, 'blocked', ?, ?)
  `).run(
    targetMonth,
    FIRST_MONTH_DIAGNOSTIC_OPERATION,
    evidenceJson,
    diagnostic.message
  );
  return Number(result.lastInsertRowid);
}

function ensureVccFinancialOpStateModelSupport(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_fin_op_module_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        first_month TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS vcc_fin_op_run_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        row_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        source_type TEXT NOT NULL,
        category_major TEXT NOT NULL,
        category_minor TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL,
        adjustment_amount TEXT NOT NULL,
        reason TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        created_app_version TEXT,
        created_build_sha TEXT,
        FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, sequence),
        UNIQUE (run_id, row_key, currency)
      );

      CREATE TABLE IF NOT EXISTS vcc_fin_op_operation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_month TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        run_id INTEGER,
        status TEXT NOT NULL,
        preview_token TEXT,
        evidence_json TEXT NOT NULL,
        error_message TEXT,
        app_version TEXT,
        build_sha TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_adjustments_run_row
        ON vcc_fin_op_run_adjustments(run_id, row_key, currency);
      CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_operation_audit_month
        ON vcc_fin_op_operation_audit(target_month, operation_type, created_at DESC, id DESC);
    `);

    const runColumns = tableColumns(db, 'vcc_fin_op_runs');
    if (!runColumns.has('result_revision')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN result_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!runColumns.has('updated_at')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN updated_at TEXT');
    }
    if (!runColumns.has('input_fingerprint')) {
      db.exec('ALTER TABLE vcc_fin_op_runs ADD COLUMN input_fingerprint TEXT');
    }
    db.exec(`
      UPDATE vcc_fin_op_runs
      SET updated_at = COALESCE(
        NULLIF(TRIM(updated_at), ''),
        NULLIF(TRIM(archived_at), ''),
        NULLIF(TRIM(created_at), ''),
        datetime('now', 'localtime')
      )
      WHERE updated_at IS NULL OR TRIM(updated_at) = ''
    `);

    db.prepare(`
      INSERT OR IGNORE INTO vcc_fin_op_module_state (singleton_id, first_month)
      VALUES (1, NULL)
    `).run();

    let facts = readFirstMonthFacts(db);
    if (
      facts.firstMonth === null
      && facts.openingMonths.length === 1
      && STRICT_YEAR_MONTH_PATTERN.test(facts.openingMonths[0])
    ) {
      db.prepare(`
        UPDATE vcc_fin_op_module_state
        SET first_month = ?, updated_at = datetime('now', 'localtime')
        WHERE singleton_id = 1 AND first_month IS NULL
      `).run(facts.openingMonths[0]);
      facts = readFirstMonthFacts(db);
    }
    const diagnostic = diagnoseFirstMonthFacts(facts);
    persistFirstMonthDiagnostic(db, diagnostic);
    db.exec('COMMIT');
    return diagnostic;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function ensureVccFinancialOpTablesSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_batches (
      id TEXT PRIMARY KEY,
      target_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'success', 'completed_with_errors', 'failed')),
      file_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      target_month TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal', 'system_op')),
      source_files_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'success', 'success_with_skips', 'all_skipped', 'failed_conflict', 'failed_validation')),
      raw_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      invalid_key_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      format_error_count INTEGER NOT NULL DEFAULT 0,
      rolled_back_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      error_message TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'not_applicable'
        CHECK (resolution_status IN ('not_applicable', 'unresolved', 'resolved')),
      resolved_at TEXT,
      resolution_note TEXT,
      resolution_action TEXT,
      dataset_deleted_at TEXT,
      dataset_deletion_id INTEGER,
      FOREIGN KEY (batch_id) REFERENCES vcc_fin_op_import_batches(id),
      UNIQUE (batch_id, source_type)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
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
      disposition TEXT
        CHECK (disposition IS NULL OR disposition IN (
          'accepted', 'idempotent_skip', 'idempotent_conflict',
          'invalid_key', 'format_error', 'rolled_back'
        )),
      validation_field TEXT,
      validation_message TEXT,
      existing_effective_id INTEGER,
      comparison_import_row_id INTEGER,
      diff_fields_json TEXT,
      existing_raw_json_snapshot TEXT,
      existing_subject_snapshot TEXT,
      existing_source_file_snapshot TEXT,
      existing_sheet_name_snapshot TEXT,
      existing_source_row_snapshot INTEGER,
      existing_import_record_id_snapshot INTEGER,
      existing_imported_at_snapshot TEXT,
      existing_raw_contract_version_snapshot INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      FOREIGN KEY (existing_effective_id) REFERENCES vcc_fin_op_effective_rows(id),
      FOREIGN KEY (comparison_import_row_id) REFERENCES vcc_fin_op_import_rows(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_effective_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal')),
      idempotency_key_raw TEXT NOT NULL,
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
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      import_record_id INTEGER NOT NULL,
      first_imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      UNIQUE (source_type, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      source_file TEXT,
      sheet_name TEXT,
      source_row INTEGER,
      field_name TEXT,
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_datasets (
      target_month TEXT NOT NULL,
      dataset_type TEXT NOT NULL,
      data_status TEXT NOT NULL DEFAULT 'unprocessed'
        CHECK (data_status IN ('unprocessed', 'archived')),
      archived_run_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      generated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, dataset_type)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_system_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      import_record_id INTEGER NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      UNIQUE (target_month, subject)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_system_snapshot_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_record_id INTEGER NOT NULL,
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_file TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      disposition TEXT NOT NULL
        CHECK (disposition IN ('accepted', 'idempotent_skip', 'idempotent_conflict', 'rolled_back')),
      existing_snapshot_id INTEGER,
      comparison_attempt_id INTEGER,
      existing_balances_json_snapshot TEXT,
      existing_raw_json_snapshot TEXT,
      existing_source_file_snapshot TEXT,
      existing_sheet_name_snapshot TEXT,
      existing_source_row_snapshot INTEGER,
      existing_import_record_id_snapshot INTEGER,
      existing_imported_at_snapshot TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (import_record_id) REFERENCES vcc_fin_op_import_records(id),
      FOREIGN KEY (existing_snapshot_id) REFERENCES vcc_fin_op_system_snapshots(id),
      FOREIGN KEY (comparison_attempt_id) REFERENCES vcc_fin_op_system_snapshot_attempts(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'calculated'
        CHECK (status IN ('calculated', 'archived')),
      input_revisions_json TEXT NOT NULL DEFAULT '{}',
      result_revision INTEGER NOT NULL DEFAULT 0,
      input_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT,
      archived_at TEXT,
      UNIQUE (target_month, id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_run_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      row_kind TEXT NOT NULL,
      source_type TEXT,
      category_major TEXT,
      category_minor TEXT,
      currency TEXT NOT NULL,
      amount TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_run_balances (
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      currency TEXT NOT NULL,
      opening_balance TEXT NOT NULL,
      period_amount TEXT NOT NULL,
      calculated_balance TEXT NOT NULL,
      system_balance TEXT NOT NULL,
      difference TEXT NOT NULL,
      PRIMARY KEY (run_id, subject, currency),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_pending_summary_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      channel_name TEXT,
      currency_mismatch INTEGER NOT NULL,
      flow_currency TEXT,
      pending_currency TEXT,
      recon_type TEXT,
      flow_amount TEXT NOT NULL,
      pending_amount TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_pending_currency_totals (
      run_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount TEXT NOT NULL,
      PRIMARY KEY (run_id, subject, currency),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_archives (
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, subject),
      FOREIGN KEY (run_id) REFERENCES vcc_fin_op_runs(id)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_opening_balances (
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      initialization_note TEXT NOT NULL,
      initialized_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, subject)
    );

    CREATE TABLE IF NOT EXISTS vcc_fin_op_dataset_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('recharge_refund', 'fee_fx', 'channel', 'pending_archive_removal', 'system_op')),
      dataset_revision INTEGER,
      deleted_data_count INTEGER NOT NULL DEFAULT 0,
      invalidated_run_count INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_records_month
      ON vcc_fin_op_import_records(target_month, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_record_disposition
      ON vcc_fin_op_import_rows(import_record_id, disposition, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_key
      ON vcc_fin_op_import_rows(source_type, idempotency_key, content_hash);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_record_key
      ON vcc_fin_op_import_rows(import_record_id, idempotency_key, content_hash, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_existing
      ON vcc_fin_op_import_rows(existing_effective_id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_rows_comparison
      ON vcc_fin_op_import_rows(comparison_import_row_id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_effective_month_source
      ON vcc_fin_op_effective_rows(target_month, source_type, subject, stat_currency);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_effective_pending
      ON vcc_fin_op_effective_rows(target_month, source_type, subject, pending_currency, flow_currency);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_errors_record
      ON vcc_fin_op_import_errors(import_record_id, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_system_attempts_record
      ON vcc_fin_op_system_snapshot_attempts(import_record_id, disposition, id);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_runs_month
      ON vcc_fin_op_runs(target_month, id DESC);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_opening_month
      ON vcc_fin_op_opening_balances(target_month, initialized_at);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_dataset_deletions_month
      ON vcc_fin_op_dataset_deletions(target_month, deleted_at DESC, id DESC);
  `);

  const columns = (tableName) => tableColumns(db, tableName);
  const recordColumns = columns('vcc_fin_op_import_records');
  if (!recordColumns.has('resolution_status')) {
    db.exec("ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'not_applicable'");
  }
  if (!recordColumns.has('resolved_at')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolved_at TEXT');
  }
  if (!recordColumns.has('resolution_note')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_note TEXT');
  }
  if (!recordColumns.has('resolution_action')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN resolution_action TEXT');
  }
  if (!recordColumns.has('dataset_deleted_at')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN dataset_deleted_at TEXT');
  }
  if (!recordColumns.has('dataset_deletion_id')) {
    db.exec('ALTER TABLE vcc_fin_op_import_records ADD COLUMN dataset_deletion_id INTEGER');
  }
  const datasetColumns = columns('vcc_fin_op_datasets');
  if (!datasetColumns.has('revision')) {
    db.exec('ALTER TABLE vcc_fin_op_datasets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!datasetColumns.has('generated_at')) {
    db.exec('ALTER TABLE vcc_fin_op_datasets ADD COLUMN generated_at TEXT');
  }
  db.exec(`
    UPDATE vcc_fin_op_datasets
    SET generated_at = COALESCE(
      (
        SELECT MAX(record.finished_at)
        FROM vcc_fin_op_import_records record
        WHERE record.target_month = vcc_fin_op_datasets.target_month
          AND record.source_type = vcc_fin_op_datasets.dataset_type
          AND record.status IN ('success', 'success_with_skips')
          AND record.inserted_count > 0
          AND record.dataset_deleted_at IS NULL
      ),
      NULLIF(TRIM(updated_at), ''),
      datetime('now', 'localtime')
    )
    WHERE generated_at IS NULL OR TRIM(generated_at) = ''
  `);
  const runColumns = columns('vcc_fin_op_runs');
  if (!runColumns.has('input_revisions_json')) {
    db.exec("ALTER TABLE vcc_fin_op_runs ADD COLUMN input_revisions_json TEXT NOT NULL DEFAULT '{}'");
  }
  const systemAttemptColumns = columns('vcc_fin_op_system_snapshot_attempts');
  if (!systemAttemptColumns.has('comparison_attempt_id')) {
    db.exec('ALTER TABLE vcc_fin_op_system_snapshot_attempts ADD COLUMN comparison_attempt_id INTEGER');
  }
  const importRowColumns = columns('vcc_fin_op_import_rows');
  const importRowSnapshotColumns = [
    ['existing_raw_json_snapshot', 'TEXT'],
    ['existing_subject_snapshot', 'TEXT'],
    ['existing_source_file_snapshot', 'TEXT'],
    ['existing_sheet_name_snapshot', 'TEXT'],
    ['existing_source_row_snapshot', 'INTEGER'],
    ['existing_import_record_id_snapshot', 'INTEGER'],
    ['existing_imported_at_snapshot', 'TEXT']
  ];
  for (const [name, type] of importRowSnapshotColumns) {
    if (!importRowColumns.has(name)) {
      db.exec(`ALTER TABLE vcc_fin_op_import_rows ADD COLUMN ${name} ${type}`);
    }
  }
  const systemSnapshotColumns = [
    ['existing_balances_json_snapshot', 'TEXT'],
    ['existing_raw_json_snapshot', 'TEXT'],
    ['existing_source_file_snapshot', 'TEXT'],
    ['existing_sheet_name_snapshot', 'TEXT'],
    ['existing_source_row_snapshot', 'INTEGER'],
    ['existing_import_record_id_snapshot', 'INTEGER'],
    ['existing_imported_at_snapshot', 'TEXT']
  ];
  for (const [name, type] of systemSnapshotColumns) {
    if (!systemAttemptColumns.has(name)) {
      db.exec(`ALTER TABLE vcc_fin_op_system_snapshot_attempts ADD COLUMN ${name} ${type}`);
    }
  }
  ensurePendingRawContractSupport(db);
  const stateDiagnostic = ensureVccFinancialOpStateModelSupport(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_records_dataset_lifecycle
      ON vcc_fin_op_import_records(target_month, source_type, dataset_deleted_at, status);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_system_attempts_comparison
      ON vcc_fin_op_system_snapshot_attempts(comparison_attempt_id)
  `);
  return { firstMonthDiagnostic: stateDiagnostic };
}

module.exports = {
  FIRST_MONTH_DIAGNOSTIC_OPERATION,
  ensureVccFinancialOpStateModelSupport,
  ensureVccFinancialOpTablesSupport
};
