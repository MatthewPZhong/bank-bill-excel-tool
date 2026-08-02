'use strict';

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
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
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

  const columns = (tableName) => new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name)
  );
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_import_records_dataset_lifecycle
      ON vcc_fin_op_import_records(target_month, source_type, dataset_deleted_at, status);
    CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_system_attempts_comparison
      ON vcc_fin_op_system_snapshot_attempts(comparison_attempt_id)
  `);
}

module.exports = { ensureVccFinancialOpTablesSupport };
