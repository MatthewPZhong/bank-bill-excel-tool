'use strict';

const VCC_MUTATION_OPERATIONS = Object.freeze({
  ADD_ADJUSTMENT: 'add-adjustment',
  ARCHIVE_RESULT: 'archive-result',
  UNARCHIVE_MONTH: 'unarchive-month',
  DELETE_DATA_TARGET: 'delete-data-target',
  ROLLBACK_AUDIT: 'rollback-audit'
});

const LARGE_TABLE_SCOPE_PROOF_TABLES = Object.freeze([
  'vcc_fin_op_effective_rows',
  'vcc_fin_op_import_rows',
  'vcc_fin_op_system_snapshots',
  'vcc_fin_op_system_snapshot_attempts'
]);

const LARGE_TABLE_SCOPE_PROOF_SET = new Set(LARGE_TABLE_SCOPE_PROOF_TABLES);
const ALL_OPERATIONS = Object.freeze(Object.values(VCC_MUTATION_OPERATIONS));

function operations(allowedOperations = []) {
  const allowed = new Set(allowedOperations);
  return Object.freeze(Object.fromEntries(ALL_OPERATIONS.map((operation) => [
    operation,
    allowed.has(operation) ? 'allowed' : 'protected'
  ])));
}

function tablePolicy(tableName, primaryKey, category, allowedOperations = []) {
  return Object.freeze({
    primaryKey: Object.freeze([...primaryKey]),
    category,
    protection: LARGE_TABLE_SCOPE_PROOF_SET.has(tableName)
      ? 'large-table-scope-proof'
      : 'empty-session',
    operations: operations(allowedOperations)
  });
}

const VCC_TABLE_POLICY_REGISTRY = Object.freeze({
  vcc_fin_op_archives: tablePolicy('vcc_fin_op_archives', ['target_month', 'subject'], 'business', [
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH
  ]),
  vcc_fin_op_dataset_deletions: tablePolicy('vcc_fin_op_dataset_deletions', ['id'], 'audit', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_datasets: tablePolicy('vcc_fin_op_datasets', ['target_month', 'dataset_type'], 'metadata', [
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_effective_rows: tablePolicy('vcc_fin_op_effective_rows', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_import_batches: tablePolicy('vcc_fin_op_import_batches', ['id'], 'metadata'),
  vcc_fin_op_import_errors: tablePolicy('vcc_fin_op_import_errors', ['id'], 'audit'),
  vcc_fin_op_import_records: tablePolicy('vcc_fin_op_import_records', ['id'], 'metadata', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_import_rows: tablePolicy('vcc_fin_op_import_rows', ['id'], 'audit', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_module_state: tablePolicy('vcc_fin_op_module_state', ['singleton_id'], 'metadata'),
  vcc_fin_op_opening_balances: tablePolicy(
    'vcc_fin_op_opening_balances',
    ['target_month', 'subject'],
    'business',
    [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]
  ),
  vcc_fin_op_operation_audit: tablePolicy('vcc_fin_op_operation_audit', ['id'], 'audit', [
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    VCC_MUTATION_OPERATIONS.ROLLBACK_AUDIT
  ]),
  vcc_fin_op_pending_currency_totals: tablePolicy(
    'vcc_fin_op_pending_currency_totals',
    ['run_id', 'subject', 'currency'],
    'business',
    [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]
  ),
  vcc_fin_op_pending_summary_rows: tablePolicy(
    'vcc_fin_op_pending_summary_rows',
    ['id'],
    'business',
    [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]
  ),
  vcc_fin_op_run_adjustments: tablePolicy('vcc_fin_op_run_adjustments', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_run_balances: tablePolicy(
    'vcc_fin_op_run_balances',
    ['run_id', 'subject', 'currency'],
    'business',
    [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]
  ),
  vcc_fin_op_run_rows: tablePolicy('vcc_fin_op_run_rows', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_runs: tablePolicy('vcc_fin_op_runs', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ]),
  vcc_fin_op_system_snapshot_attempts: tablePolicy(
    'vcc_fin_op_system_snapshot_attempts',
    ['id'],
    'audit',
    [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]
  ),
  vcc_fin_op_system_snapshots: tablePolicy('vcc_fin_op_system_snapshots', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ])
});

const APPROVED_VCC_TRIGGERS = Object.freeze([]);

function step({ tableName, mutation, sql, largeTableScopeId = null }) {
  return Object.freeze({
    tableName,
    mutation,
    sql: String(sql).trim(),
    largeTableScopeId
  });
}

const MUTATION_SQL_STEP_REGISTRY = Object.freeze({
  'adjustment.insert': step({
    tableName: 'vcc_fin_op_run_adjustments',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_run_adjustments (
        run_id, row_key, subject, source_type, category_major, category_minor,
        currency, adjustment_amount, reason, sequence,
        created_at, created_app_version, created_build_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  }),
  'adjustment.bump-run': step({
    tableName: 'vcc_fin_op_runs',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_runs
      SET result_revision = result_revision + 1,
          updated_at = ?
      WHERE id = ? AND status = 'calculated' AND result_revision = ?
    `
  }),
  'archive.audit-success': step({
    tableName: 'vcc_fin_op_operation_audit',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_operation_audit (
        target_month, operation_type, run_id, status, preview_token,
        evidence_json, error_message, app_version, build_sha, created_at
      ) VALUES (?, ?, ?, 'success', NULL, ?, NULL, ?, ?, ?)
    `
  }),
  'archive.insert-subjects': step({
    tableName: 'vcc_fin_op_archives',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_archives (
        target_month, subject, balances_json, run_id, archived_at
      ) VALUES (?, ?, ?, ?, ?)
    `
  }),
  'archive.mark-run': step({
    tableName: 'vcc_fin_op_runs',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_runs
      SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND status = 'calculated' AND result_revision = ?
    `
  }),
  'archive.mark-datasets': step({
    tableName: 'vcc_fin_op_datasets',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_datasets
      SET data_status = 'archived', archived_run_id = ?, updated_at = ?
      WHERE target_month = ?
        AND dataset_type IN (?, ?, ?, ?, ?)
        AND data_status = 'unprocessed'
        AND archived_run_id IS NULL
    `
  }),
  'unarchive.audit-success': step({
    tableName: 'vcc_fin_op_operation_audit',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_operation_audit (
        target_month, operation_type, run_id, status, preview_token,
        evidence_json, error_message, app_version, build_sha, created_at
      ) VALUES (?, 'unarchive', ?, 'success', ?, ?, NULL, ?, ?, ?)
    `
  }),
  'unarchive.delete-archives': step({
    tableName: 'vcc_fin_op_archives',
    mutation: 'delete',
    sql: `DELETE FROM vcc_fin_op_archives WHERE target_month = ?`
  }),
  'unarchive.restore-run': step({
    tableName: 'vcc_fin_op_runs',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_runs
      SET status = 'calculated', archived_at = NULL, updated_at = ?
      WHERE id = ? AND target_month = ? AND status = 'archived'
    `
  }),
  'unarchive.restore-datasets': step({
    tableName: 'vcc_fin_op_datasets',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_datasets
      SET data_status = 'unprocessed', archived_run_id = NULL, updated_at = ?
      WHERE target_month = ? AND archived_run_id = ? AND data_status = 'archived'
        AND dataset_type IN (SELECT value FROM json_each(?))
    `
  }),
  'delete.audit-success': step({
    tableName: 'vcc_fin_op_operation_audit',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_operation_audit (
        target_month, operation_type, run_id, status, preview_token,
        evidence_json, error_message, app_version, build_sha, created_at
      ) VALUES (?, ?, NULL, 'success', ?, ?, NULL, ?, ?, ?)
    `
  }),
  'delete.run-adjustments': step({
    tableName: 'vcc_fin_op_run_adjustments',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_run_adjustments
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `
  }),
  'delete.run-rows': step({
    tableName: 'vcc_fin_op_run_rows',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_run_rows
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `
  }),
  'delete.run-balances': step({
    tableName: 'vcc_fin_op_run_balances',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_run_balances
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `
  }),
  'delete.pending-summaries': step({
    tableName: 'vcc_fin_op_pending_summary_rows',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_pending_summary_rows
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `
  }),
  'delete.pending-currency-totals': step({
    tableName: 'vcc_fin_op_pending_currency_totals',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_pending_currency_totals
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `
  }),
  'delete.runs': step({
    tableName: 'vcc_fin_op_runs',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_runs
      WHERE target_month = ? AND status = 'calculated'
    `
  }),
  'delete.openings': step({
    tableName: 'vcc_fin_op_opening_balances',
    mutation: 'delete',
    sql: `DELETE FROM vcc_fin_op_opening_balances WHERE target_month = ?`
  }),
  'delete.detail-snapshot': step({
    tableName: 'vcc_fin_op_import_rows',
    mutation: 'update',
    largeTableScopeId: 'detail-existing-effective',
    sql: `
      UPDATE vcc_fin_op_import_rows AS audit
      SET existing_raw_json_snapshot = COALESCE(audit.existing_raw_json_snapshot, effective.raw_json),
          existing_raw_contract_version_snapshot = COALESCE(audit.existing_raw_contract_version_snapshot, effective.raw_contract_version),
          existing_subject_snapshot = COALESCE(audit.existing_subject_snapshot, effective.subject),
          existing_source_file_snapshot = COALESCE(audit.existing_source_file_snapshot, effective.source_file),
          existing_sheet_name_snapshot = COALESCE(audit.existing_sheet_name_snapshot, effective.sheet_name),
          existing_source_row_snapshot = COALESCE(audit.existing_source_row_snapshot, effective.source_row),
          existing_import_record_id_snapshot = COALESCE(audit.existing_import_record_id_snapshot, effective.import_record_id),
          existing_imported_at_snapshot = COALESCE(audit.existing_imported_at_snapshot, effective.first_imported_at)
      FROM vcc_fin_op_effective_rows AS effective
      WHERE audit.existing_effective_id = effective.id
        AND effective.target_month = ? AND effective.source_type = ?
    `
  }),
  'delete.detail-clear-fk': step({
    tableName: 'vcc_fin_op_import_rows',
    mutation: 'update',
    largeTableScopeId: 'detail-existing-effective',
    sql: `
      UPDATE vcc_fin_op_import_rows
      SET existing_effective_id = NULL
      WHERE existing_effective_id IN (
        SELECT id FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      )
    `
  }),
  'delete.detail-effective': step({
    tableName: 'vcc_fin_op_effective_rows',
    mutation: 'delete',
    largeTableScopeId: 'detail-month-source',
    sql: `
      DELETE FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    `
  }),
  'delete.system-backfill': step({
    tableName: 'vcc_fin_op_system_snapshot_attempts',
    mutation: 'insert',
    largeTableScopeId: 'system-missing-accepted',
    sql: `
      INSERT INTO vcc_fin_op_system_snapshot_attempts (
        import_record_id, target_month, subject, balances_json, content_hash,
        source_file, sheet_name, source_row, raw_json,
        disposition, existing_snapshot_id, message, created_at
      )
      SELECT snapshot.import_record_id, snapshot.target_month, snapshot.subject,
             snapshot.balances_json, snapshot.content_hash,
             snapshot.source_file, snapshot.sheet_name, snapshot.source_row,
             snapshot.raw_json, 'accepted', snapshot.id,
             '历史快照删除前补录首次成功导入审计', ?
      FROM vcc_fin_op_system_snapshots AS snapshot
      WHERE snapshot.target_month = ?
        AND NOT EXISTS (
          SELECT 1 FROM vcc_fin_op_system_snapshot_attempts AS attempt
          WHERE attempt.disposition = 'accepted'
            AND attempt.existing_snapshot_id = snapshot.id
            AND attempt.import_record_id = snapshot.import_record_id
            AND attempt.target_month = snapshot.target_month
            AND attempt.subject = snapshot.subject
            AND attempt.balances_json = snapshot.balances_json
            AND attempt.content_hash = snapshot.content_hash
            AND attempt.source_file = snapshot.source_file
            AND attempt.sheet_name = snapshot.sheet_name
            AND attempt.source_row = snapshot.source_row
            AND attempt.raw_json = snapshot.raw_json
            AND attempt.comparison_attempt_id IS NULL
        )
    `
  }),
  'delete.system-snapshot': step({
    tableName: 'vcc_fin_op_system_snapshot_attempts',
    mutation: 'update',
    largeTableScopeId: 'system-existing-snapshot',
    sql: `
      UPDATE vcc_fin_op_system_snapshot_attempts AS audit
      SET existing_balances_json_snapshot = COALESCE(audit.existing_balances_json_snapshot, snapshot.balances_json),
          existing_raw_json_snapshot = COALESCE(audit.existing_raw_json_snapshot, snapshot.raw_json),
          existing_source_file_snapshot = COALESCE(audit.existing_source_file_snapshot, snapshot.source_file),
          existing_sheet_name_snapshot = COALESCE(audit.existing_sheet_name_snapshot, snapshot.sheet_name),
          existing_source_row_snapshot = COALESCE(audit.existing_source_row_snapshot, snapshot.source_row),
          existing_import_record_id_snapshot = COALESCE(audit.existing_import_record_id_snapshot, snapshot.import_record_id),
          existing_imported_at_snapshot = COALESCE(audit.existing_imported_at_snapshot, snapshot.imported_at)
      FROM vcc_fin_op_system_snapshots AS snapshot
      WHERE audit.existing_snapshot_id = snapshot.id
        AND snapshot.target_month = ?
    `
  }),
  'delete.system-clear-fk': step({
    tableName: 'vcc_fin_op_system_snapshot_attempts',
    mutation: 'update',
    largeTableScopeId: 'system-existing-snapshot',
    sql: `
      UPDATE vcc_fin_op_system_snapshot_attempts
      SET existing_snapshot_id = NULL
      WHERE existing_snapshot_id IN (
        SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
      )
    `
  }),
  'delete.system-snapshots': step({
    tableName: 'vcc_fin_op_system_snapshots',
    mutation: 'delete',
    largeTableScopeId: 'system-month',
    sql: `DELETE FROM vcc_fin_op_system_snapshots WHERE target_month = ?`
  }),
  'delete.dataset': step({
    tableName: 'vcc_fin_op_datasets',
    mutation: 'delete',
    sql: `
      DELETE FROM vcc_fin_op_datasets
      WHERE target_month = ? AND dataset_type = ?
    `
  }),
  'delete.dataset-deletion': step({
    tableName: 'vcc_fin_op_dataset_deletions',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_dataset_deletions (
        target_month, source_type, dataset_revision,
        deleted_data_count, invalidated_run_count, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
  }),
  'delete.import-records': step({
    tableName: 'vcc_fin_op_import_records',
    mutation: 'update',
    sql: `
      UPDATE vcc_fin_op_import_records
      SET dataset_deleted_at = ?,
          dataset_deletion_id = (
            SELECT id FROM vcc_fin_op_dataset_deletions
            WHERE id > ? AND target_month = ? AND source_type = ? AND deleted_at = ?
            ORDER BY id
          )
      WHERE target_month = ? AND source_type = ?
        AND status IN ('success', 'success_with_skips', 'all_skipped')
        AND dataset_deleted_at IS NULL
    `
  }),
  'audit.rollback': step({
    tableName: 'vcc_fin_op_operation_audit',
    mutation: 'insert',
    sql: `
      INSERT INTO vcc_fin_op_operation_audit (
        target_month, operation_type, run_id, status, preview_token,
        evidence_json, error_message, app_version, build_sha, created_at
      ) VALUES (?, ?, ?, 'rolled_back', ?, ?, ?, ?, ?, ?)
    `
  })
});

module.exports = {
  VCC_MUTATION_OPERATIONS,
  LARGE_TABLE_SCOPE_PROOF_TABLES,
  VCC_TABLE_POLICY_REGISTRY,
  APPROVED_VCC_TRIGGERS,
  MUTATION_SQL_STEP_REGISTRY
};
