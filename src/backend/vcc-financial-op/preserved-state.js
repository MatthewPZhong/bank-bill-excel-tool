'use strict';

const { SOURCE_TYPES } = require('./definitions');
const {
  fingerprintQuery,
  normalizeOperationMonth,
  operationError,
  stableStringify
} = require('./operation-state');

const PRESERVED_STATE_VERSION = 2;
const PRESERVED_OPERATIONS = Object.freeze({
  UNARCHIVE: 'unarchive',
  DELETE_OPENING: 'delete-opening',
  DELETE_RESULT: 'delete-result',
  DELETE_SOURCE: 'delete-source'
});
const DELETABLE_IMPORT_STATUSES = new Set([
  'success',
  'success_with_skips',
  'all_skipped'
]);
const EFFECTIVE_FACT_COLUMNS = `
  id, source_type, idempotency_key_raw, idempotency_key, content_hash,
  hash_version, raw_contract_version, legacy_content_hash,
  target_month, subject, stat_currency, signed_amount,
  business_department, counterparty_department, business_sub_type,
  channel_name, mid, recon_type, pending_currency, pending_amount,
  flow_currency, flow_amount, currency_mismatch,
  source_file, sheet_name, source_row, raw_json,
  import_record_id, first_imported_at
`;
const IMPORT_AUDIT_COLUMNS = `
  id, import_record_id, source_type, target_month,
  idempotency_key_raw, idempotency_key, content_hash,
  hash_version, raw_contract_version, subject, stat_currency, signed_amount,
  business_department, counterparty_department, business_sub_type,
  channel_name, mid, recon_type, pending_currency, pending_amount,
  flow_currency, flow_amount, currency_mismatch,
  source_file, sheet_name, source_row, disposition,
  validation_field, validation_message, existing_effective_id,
  comparison_import_row_id, diff_fields_json,
  existing_subject_snapshot, existing_source_file_snapshot,
  existing_sheet_name_snapshot, existing_source_row_snapshot,
  existing_import_record_id_snapshot, existing_imported_at_snapshot,
  existing_raw_contract_version_snapshot,
  raw_json, existing_raw_json_snapshot, created_at
`;
const SYSTEM_SNAPSHOT_COLUMNS = `
  id, target_month, subject, balances_json, content_hash,
  source_file, sheet_name, source_row, raw_json,
  import_record_id, imported_at
`;
const SYSTEM_ATTEMPT_AUDIT_COLUMNS = `
  id, import_record_id, target_month, subject, balances_json, content_hash,
  source_file, sheet_name, source_row, disposition,
  existing_snapshot_id, comparison_attempt_id,
  existing_balances_json_snapshot, existing_source_file_snapshot,
  existing_sheet_name_snapshot, existing_source_row_snapshot,
  existing_import_record_id_snapshot, existing_imported_at_snapshot,
  raw_json, existing_raw_json_snapshot, message, created_at
`;

function maxId(db, tableName) {
  const row = db.prepare(`SELECT MAX(id) AS max_id FROM ${tableName}`).get();
  return row && row.max_id !== null ? Number(row.max_id) : 0;
}

function addFingerprint(fingerprints, db, tableName, sql, params = [], normalizeRow = null) {
  fingerprints.push(fingerprintQuery(db, {
    tableName,
    sql,
    params,
    normalizeRow
  }));
}

function removeInternalColumns(row) {
  const normalized = { ...row };
  for (const column of Object.keys(normalized)) {
    if (column.startsWith('__')) delete normalized[column];
  }
  return normalized;
}

function normalizeExpectedDetailAudit(row) {
  const normalized = { ...row };
  if (row.__effective_id !== null && row.__effective_id !== undefined) {
    normalized.existing_effective_id = null;
    normalized.existing_raw_json_snapshot = normalized.existing_raw_json_snapshot
      ?? row.__effective_raw_json;
    normalized.existing_raw_contract_version_snapshot =
      normalized.existing_raw_contract_version_snapshot
      ?? row.__effective_raw_contract_version;
    normalized.existing_subject_snapshot = normalized.existing_subject_snapshot
      ?? row.__effective_subject;
    normalized.existing_source_file_snapshot = normalized.existing_source_file_snapshot
      ?? row.__effective_source_file;
    normalized.existing_sheet_name_snapshot = normalized.existing_sheet_name_snapshot
      ?? row.__effective_sheet_name;
    normalized.existing_source_row_snapshot = normalized.existing_source_row_snapshot
      ?? row.__effective_source_row;
    normalized.existing_import_record_id_snapshot = normalized.existing_import_record_id_snapshot
      ?? row.__effective_import_record_id;
    normalized.existing_imported_at_snapshot = normalized.existing_imported_at_snapshot
      ?? row.__effective_imported_at;
  }
  return removeInternalColumns(normalized);
}

function normalizeExpectedSystemAttempt(row) {
  const normalized = { ...row };
  if (row.__snapshot_id !== null && row.__snapshot_id !== undefined) {
    normalized.existing_snapshot_id = null;
    normalized.existing_balances_json_snapshot = normalized.existing_balances_json_snapshot
      ?? row.__snapshot_balances_json;
    normalized.existing_raw_json_snapshot = normalized.existing_raw_json_snapshot
      ?? row.__snapshot_raw_json;
    normalized.existing_source_file_snapshot = normalized.existing_source_file_snapshot
      ?? row.__snapshot_source_file;
    normalized.existing_sheet_name_snapshot = normalized.existing_sheet_name_snapshot
      ?? row.__snapshot_sheet_name;
    normalized.existing_source_row_snapshot = normalized.existing_source_row_snapshot
      ?? row.__snapshot_source_row;
    normalized.existing_import_record_id_snapshot = normalized.existing_import_record_id_snapshot
      ?? row.__snapshot_import_record_id;
    normalized.existing_imported_at_snapshot = normalized.existing_imported_at_snapshot
      ?? row.__snapshot_imported_at;
  }
  return removeInternalColumns(normalized);
}

function normalizeTargetImportRecord(row, { phase, deletionId }) {
  const normalized = { ...row };
  const eligible = DELETABLE_IMPORT_STATUSES.has(String(row.status || ''));
  const beforePending = phase === 'before'
    && eligible
    && row.dataset_deleted_at === null
    && row.dataset_deletion_id === null;
  const afterMarked = phase === 'after'
    && eligible
    && row.dataset_deleted_at !== null
    && Number(row.dataset_deletion_id) === Number(deletionId);
  if (beforePending || afterMarked) {
    normalized.dataset_deleted_at = '__EXPECTED_DATASET_DELETION__';
    normalized.dataset_deletion_id = '__EXPECTED_DATASET_DELETION__';
  }
  return normalized;
}

function addSourceFingerprints(fingerprints, db, targetMonth, {
  operation,
  sourceType,
  phase,
  boundaries,
  deletionId
}) {
  const deletingSource = operation === PRESERVED_OPERATIONS.DELETE_SOURCE;
  const deletingSystem = deletingSource && sourceType === SOURCE_TYPES.SYSTEM_OP;
  const deletingDetail = deletingSource && sourceType !== SOURCE_TYPES.SYSTEM_OP;

  const effectiveFilter = deletingDetail ? ' AND source_type <> ?' : '';
  const effectiveParams = deletingDetail ? [targetMonth, sourceType] : [targetMonth];
  addFingerprint(fingerprints, db, 'vcc_fin_op_effective_rows', `
    SELECT ${EFFECTIVE_FACT_COLUMNS} FROM vcc_fin_op_effective_rows
    WHERE target_month = ?${effectiveFilter}
    ORDER BY id
  `, effectiveParams);

  if (!deletingSystem) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_system_snapshots', `
      SELECT ${SYSTEM_SNAPSHOT_COLUMNS}
      FROM vcc_fin_op_system_snapshots
      WHERE target_month = ?
      ORDER BY id
    `, [targetMonth]);
  }

  addFingerprint(fingerprints, db, 'vcc_fin_op_import_batches', `
    SELECT * FROM vcc_fin_op_import_batches
    WHERE target_month = ?
    ORDER BY id
  `, [targetMonth]);

  if (deletingSource) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_import_records:other-sources', `
      SELECT * FROM vcc_fin_op_import_records
      WHERE target_month = ? AND source_type <> ?
      ORDER BY id
    `, [targetMonth, sourceType]);
    addFingerprint(
      fingerprints,
      db,
      'vcc_fin_op_import_records:target-source-expected',
      `
        SELECT * FROM vcc_fin_op_import_records
        WHERE target_month = ? AND source_type = ?
        ORDER BY id
      `,
      [targetMonth, sourceType],
      (row) => normalizeTargetImportRecord(row, { phase, deletionId })
    );
  } else {
    addFingerprint(fingerprints, db, 'vcc_fin_op_import_records', `
      SELECT * FROM vcc_fin_op_import_records
      WHERE target_month = ?
      ORDER BY id
    `, [targetMonth]);
  }

  addFingerprint(fingerprints, db, 'vcc_fin_op_import_errors', `
    SELECT error.*
    FROM vcc_fin_op_import_errors error
    JOIN vcc_fin_op_import_records record ON record.id = error.import_record_id
    WHERE record.target_month = ?
    ORDER BY error.id
  `, [targetMonth]);

  if (deletingDetail) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_import_rows:other-sources', `
      SELECT ${IMPORT_AUDIT_COLUMNS} FROM vcc_fin_op_import_rows
      WHERE target_month = ? AND source_type <> ?
      ORDER BY id
    `, [targetMonth, sourceType]);
    addFingerprint(
      fingerprints,
      db,
      'vcc_fin_op_import_rows:target-source-expected',
      `
        -- 仅目标来源物化校验读取 raw_json；fingerprintQuery 使用 iterate() 增量哈希。
        SELECT audit.*,
               effective.id AS __effective_id,
               effective.raw_json AS __effective_raw_json,
               effective.raw_contract_version AS __effective_raw_contract_version,
               effective.subject AS __effective_subject,
               effective.source_file AS __effective_source_file,
               effective.sheet_name AS __effective_sheet_name,
               effective.source_row AS __effective_source_row,
               effective.import_record_id AS __effective_import_record_id,
               effective.first_imported_at AS __effective_imported_at
        FROM vcc_fin_op_import_rows audit
        LEFT JOIN vcc_fin_op_effective_rows effective
          ON effective.id = audit.existing_effective_id
         AND effective.target_month = ?
         AND effective.source_type = ?
        WHERE audit.target_month = ? AND audit.source_type = ?
        ORDER BY audit.id
      `,
      [targetMonth, sourceType, targetMonth, sourceType],
      normalizeExpectedDetailAudit
    );
  } else {
    addFingerprint(fingerprints, db, 'vcc_fin_op_import_rows', `
      SELECT ${IMPORT_AUDIT_COLUMNS} FROM vcc_fin_op_import_rows
      WHERE target_month = ?
      ORDER BY id
    `, [targetMonth]);
  }

  if (deletingSystem) {
    addFingerprint(
      fingerprints,
      db,
      'vcc_fin_op_system_snapshot_attempts:existing-expected',
      `
        -- 仅目标系统快照物化校验读取 raw_json；fingerprintQuery 使用 iterate() 增量哈希。
        SELECT attempt.*,
               snapshot.id AS __snapshot_id,
               snapshot.balances_json AS __snapshot_balances_json,
               snapshot.raw_json AS __snapshot_raw_json,
               snapshot.source_file AS __snapshot_source_file,
               snapshot.sheet_name AS __snapshot_sheet_name,
               snapshot.source_row AS __snapshot_source_row,
               snapshot.import_record_id AS __snapshot_import_record_id,
               snapshot.imported_at AS __snapshot_imported_at
        FROM vcc_fin_op_system_snapshot_attempts attempt
        LEFT JOIN vcc_fin_op_system_snapshots snapshot
          ON snapshot.id = attempt.existing_snapshot_id
         AND snapshot.target_month = ?
        WHERE attempt.target_month = ? AND attempt.id <= ?
        ORDER BY attempt.id
      `,
      [targetMonth, targetMonth, boundaries.systemAttemptMaxId],
      normalizeExpectedSystemAttempt
    );
  } else {
    addFingerprint(fingerprints, db, 'vcc_fin_op_system_snapshot_attempts', `
      SELECT ${SYSTEM_ATTEMPT_AUDIT_COLUMNS}
      FROM vcc_fin_op_system_snapshot_attempts
      WHERE target_month = ?
      ORDER BY id
    `, [targetMonth]);
  }
}

function addOtherMonthRunChildFingerprints(fingerprints, db, targetMonth) {
  const tables = [{ name: 'vcc_fin_op_run_adjustments', order: 'child.id' },
    { name: 'vcc_fin_op_run_rows', order: 'child.id' },
    { name: 'vcc_fin_op_run_balances', order: 'child.run_id, child.subject, child.currency' },
    { name: 'vcc_fin_op_pending_summary_rows', order: 'child.id' },
    { name: 'vcc_fin_op_pending_currency_totals', order: 'child.run_id, child.subject, child.currency' }];
  for (const table of tables) {
    addFingerprint(fingerprints, db, `${table.name}:other-months`, `
      SELECT child.*
      FROM ${table.name} child
      LEFT JOIN vcc_fin_op_runs run ON run.id = child.run_id
      WHERE run.target_month <> ? OR run.id IS NULL
      ORDER BY ${table.order}
    `, [targetMonth]);
  }
}

function addOtherMonthAndGlobalFingerprints(fingerprints, db, targetMonth, boundaries) {
  addFingerprint(fingerprints, db, 'vcc_fin_op_operation_audit:existing', `
    SELECT * FROM vcc_fin_op_operation_audit
    WHERE id <= ?
    ORDER BY id
  `, [boundaries.operationAuditMaxId]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_import_batches:other-months', `
    SELECT * FROM vcc_fin_op_import_batches
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_import_records:other-months', `
    SELECT * FROM vcc_fin_op_import_records
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_import_errors:other-months', `
    SELECT error.*
    FROM vcc_fin_op_import_errors error
    LEFT JOIN vcc_fin_op_import_records record ON record.id = error.import_record_id
    WHERE record.target_month <> ? OR record.id IS NULL
    ORDER BY error.id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_import_rows:other-months', `
    SELECT ${IMPORT_AUDIT_COLUMNS}
    FROM vcc_fin_op_import_rows
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_effective_rows:other-months', `
    SELECT ${EFFECTIVE_FACT_COLUMNS}
    FROM vcc_fin_op_effective_rows
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_datasets:other-months', `
    SELECT * FROM vcc_fin_op_datasets
    WHERE target_month <> ?
    ORDER BY target_month, dataset_type
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_system_snapshots:other-months', `
    SELECT ${SYSTEM_SNAPSHOT_COLUMNS}
    FROM vcc_fin_op_system_snapshots
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_system_snapshot_attempts:other-months', `
    SELECT ${SYSTEM_ATTEMPT_AUDIT_COLUMNS}
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE target_month <> ?
    ORDER BY id
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_runs:other-months', `
    SELECT * FROM vcc_fin_op_runs
    WHERE target_month <> ?
    ORDER BY target_month, id
  `, [targetMonth]);
  addOtherMonthRunChildFingerprints(fingerprints, db, targetMonth);
  addFingerprint(fingerprints, db, 'vcc_fin_op_archives:other-months', `
    SELECT * FROM vcc_fin_op_archives
    WHERE target_month <> ?
    ORDER BY target_month, subject
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_opening_balances:other-months', `
    SELECT * FROM vcc_fin_op_opening_balances
    WHERE target_month <> ?
    ORDER BY target_month, subject
  `, [targetMonth]);
  addFingerprint(fingerprints, db, 'vcc_fin_op_dataset_deletions:other-months', `
    SELECT * FROM vcc_fin_op_dataset_deletions
    WHERE target_month <> ?
    ORDER BY target_month, id
  `, [targetMonth]);
}

function addRunChildFingerprints(fingerprints, db, targetMonth) {
  const tables = [{ name: 'vcc_fin_op_run_adjustments', order: 'child.id' },
    { name: 'vcc_fin_op_run_rows', order: 'child.id' },
    { name: 'vcc_fin_op_run_balances', order: 'child.run_id, child.subject, child.currency' },
    { name: 'vcc_fin_op_pending_summary_rows', order: 'child.id' },
    { name: 'vcc_fin_op_pending_currency_totals', order: 'child.run_id, child.subject, child.currency' }];
  for (const table of tables) {
    addFingerprint(fingerprints, db, table.name, `
      SELECT child.*
      FROM ${table.name} child
      JOIN vcc_fin_op_runs run ON run.id = child.run_id
      WHERE run.target_month = ?
      ORDER BY ${table.order}
    `, [targetMonth]);
  }
}

function snapshotPreservedOperationState(db, {
  targetMonth,
  operation,
  sourceType = null,
  phase = 'before',
  baseline = null,
  deletionId = null
}) {
  const month = normalizeOperationMonth(targetMonth);
  if (!Object.values(PRESERVED_OPERATIONS).includes(operation)) {
    throw operationError('invalid-preserved-operation', `不支持的保留状态快照：${operation || ''}`);
  }
  if (operation === PRESERVED_OPERATIONS.DELETE_SOURCE && !sourceType) {
    throw operationError('invalid-source-type', '源数据删除保留状态缺少数据类型');
  }
  const boundaries = baseline ? baseline.boundaries : {
    systemAttemptMaxId: maxId(db, 'vcc_fin_op_system_snapshot_attempts'),
    datasetDeletionMaxId: maxId(db, 'vcc_fin_op_dataset_deletions'),
    operationAuditMaxId: maxId(db, 'vcc_fin_op_operation_audit')
  };
  const fingerprints = [];

  addFingerprint(fingerprints, db, 'vcc_fin_op_module_state', `
    SELECT * FROM vcc_fin_op_module_state ORDER BY singleton_id
  `);
  addOtherMonthAndGlobalFingerprints(fingerprints, db, month, boundaries);

  if (operation === PRESERVED_OPERATIONS.UNARCHIVE) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_runs:preserved-columns', `
      SELECT id, target_month, input_revisions_json, result_revision,
             input_fingerprint, created_at
      FROM vcc_fin_op_runs WHERE target_month = ? ORDER BY id
    `, [month]);
    addFingerprint(fingerprints, db, 'vcc_fin_op_datasets:preserved-columns', `
      SELECT target_month, dataset_type, revision, generated_at
      FROM vcc_fin_op_datasets WHERE target_month = ? ORDER BY dataset_type
    `, [month]);
    addRunChildFingerprints(fingerprints, db, month);
  } else if (operation === PRESERVED_OPERATIONS.DELETE_SOURCE) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_datasets:other-targets', `
      SELECT * FROM vcc_fin_op_datasets
      WHERE target_month = ? AND dataset_type <> ?
      ORDER BY dataset_type
    `, [month, sourceType]);
  } else {
    addFingerprint(fingerprints, db, 'vcc_fin_op_datasets', `
      SELECT * FROM vcc_fin_op_datasets
      WHERE target_month = ? ORDER BY dataset_type
    `, [month]);
  }

  if (operation !== PRESERVED_OPERATIONS.DELETE_OPENING) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_opening_balances', `
      SELECT * FROM vcc_fin_op_opening_balances
      WHERE target_month = ? ORDER BY subject
    `, [month]);
  }
  if (operation !== PRESERVED_OPERATIONS.UNARCHIVE) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_archives', `
      SELECT * FROM vcc_fin_op_archives
      WHERE target_month = ? ORDER BY subject
    `, [month]);
  }

  if (operation === PRESERVED_OPERATIONS.DELETE_SOURCE) {
    addFingerprint(fingerprints, db, 'vcc_fin_op_dataset_deletions:existing', `
      SELECT * FROM vcc_fin_op_dataset_deletions
      WHERE target_month = ? AND id <= ? ORDER BY id
    `, [month, boundaries.datasetDeletionMaxId]);
  } else {
    addFingerprint(fingerprints, db, 'vcc_fin_op_dataset_deletions', `
      SELECT * FROM vcc_fin_op_dataset_deletions
      WHERE target_month = ? ORDER BY id
    `, [month]);
  }

  addSourceFingerprints(fingerprints, db, month, {
    operation,
    sourceType,
    phase,
    boundaries,
    deletionId
  });

  return {
    version: PRESERVED_STATE_VERSION,
    targetMonth: month,
    operation,
    sourceType,
    boundaries,
    fingerprints
  };
}

function assertPreservedOperationState(before, after, {
  code,
  message
}) {
  const beforeComparable = { ...before, boundaries: undefined };
  const afterComparable = { ...after, boundaries: undefined };
  if (stableStringify(beforeComparable) === stableStringify(afterComparable)) return;
  throw operationError(code, message, {
    preservedStateBefore: before,
    preservedStateAfter: after,
    context: {
      preservedStateBefore: before,
      preservedStateAfter: after
    }
  });
}

module.exports = {
  PRESERVED_STATE_VERSION,
  PRESERVED_OPERATIONS,
  snapshotPreservedOperationState,
  assertPreservedOperationState
};
