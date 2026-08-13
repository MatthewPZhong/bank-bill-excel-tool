'use strict';

const VCC_MUTATION_OPERATIONS = Object.freeze({
  ADD_ADJUSTMENT: 'add-adjustment',
  ARCHIVE_RESULT: 'archive-result',
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
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
  ]),
  vcc_fin_op_dataset_deletions: tablePolicy('vcc_fin_op_dataset_deletions', ['id'], 'audit'),
  vcc_fin_op_datasets: tablePolicy('vcc_fin_op_datasets', ['target_month', 'dataset_type'], 'metadata', [
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
  ]),
  vcc_fin_op_effective_rows: tablePolicy('vcc_fin_op_effective_rows', ['id'], 'business'),
  vcc_fin_op_import_batches: tablePolicy('vcc_fin_op_import_batches', ['id'], 'metadata'),
  vcc_fin_op_import_errors: tablePolicy('vcc_fin_op_import_errors', ['id'], 'audit'),
  vcc_fin_op_import_records: tablePolicy('vcc_fin_op_import_records', ['id'], 'metadata'),
  vcc_fin_op_import_rows: tablePolicy('vcc_fin_op_import_rows', ['id'], 'audit'),
  vcc_fin_op_module_state: tablePolicy('vcc_fin_op_module_state', ['singleton_id'], 'metadata'),
  vcc_fin_op_opening_balances: tablePolicy(
    'vcc_fin_op_opening_balances',
    ['target_month', 'subject'],
    'business'
  ),
  vcc_fin_op_operation_audit: tablePolicy('vcc_fin_op_operation_audit', ['id'], 'audit', [
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    VCC_MUTATION_OPERATIONS.ROLLBACK_AUDIT
  ]),
  vcc_fin_op_pending_currency_totals: tablePolicy(
    'vcc_fin_op_pending_currency_totals',
    ['run_id', 'subject', 'currency'],
    'business'
  ),
  vcc_fin_op_pending_summary_rows: tablePolicy(
    'vcc_fin_op_pending_summary_rows',
    ['id'],
    'business'
  ),
  vcc_fin_op_run_adjustments: tablePolicy('vcc_fin_op_run_adjustments', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT
  ]),
  vcc_fin_op_run_balances: tablePolicy(
    'vcc_fin_op_run_balances',
    ['run_id', 'subject', 'currency'],
    'business'
  ),
  vcc_fin_op_run_rows: tablePolicy('vcc_fin_op_run_rows', ['id'], 'business'),
  vcc_fin_op_runs: tablePolicy('vcc_fin_op_runs', ['id'], 'business', [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
  ]),
  vcc_fin_op_system_snapshot_attempts: tablePolicy(
    'vcc_fin_op_system_snapshot_attempts',
    ['id'],
    'audit'
  ),
  vcc_fin_op_system_snapshots: tablePolicy('vcc_fin_op_system_snapshots', ['id'], 'business')
});

const APPROVED_VCC_TRIGGERS = Object.freeze([]);

function step({ tableName, mutation, sql }) {
  return Object.freeze({ tableName, mutation, sql: String(sql).trim() });
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
