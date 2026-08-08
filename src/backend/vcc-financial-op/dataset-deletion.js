'use strict';

const { SOURCE_TYPES, SOURCE_LABELS } = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const {
  buildOperationState,
  operationPreviewToken,
  assertPreviewToken
} = require('./operation-state');
const {
  collectRunEvidence,
  insertOperationAudit,
  persistRolledBackAudit
} = require('./operation-audit');

const DELETE_SOURCE_DATASET_OPERATION = 'delete-source-dataset';
const DEFAULT_DELETE_REASON = '用户在数据管理中删除目标月原表及关联未归档计算结果';

const DETAIL_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING
]);
const ALLOWED_SOURCE_TYPES = new Set([
  ...DETAIL_SOURCE_TYPES,
  SOURCE_TYPES.SYSTEM_OP
]);
const DELETABLE_IMPORT_STATUSES = Object.freeze([
  'success',
  'success_with_skips',
  'all_skipped'
]);

function scopeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeScope(targetMonth, sourceType) {
  const month = normalizeYearMonth(targetMonth);
  if (!month) throw scopeError('invalid-month', `月份账期格式无效：${targetMonth || ''}`);
  const type = String(sourceType || '').trim();
  if (!ALLOWED_SOURCE_TYPES.has(type)) {
    throw scopeError('invalid-source-type', `不支持删除的目标表：${sourceType || ''}`);
  }
  return { targetMonth: month, sourceType: type };
}

function countValue(row) {
  return Number(row && row.row_count) || 0;
}

function inspectDatasetDeletion(db, targetMonth, sourceType, { taskActive = false } = {}) {
  const scope = normalizeScope(targetMonth, sourceType);
  const dataset = db.prepare(`
    SELECT data_status, revision
    FROM vcc_fin_op_datasets
    WHERE target_month = ? AND dataset_type = ?
  `).get(scope.targetMonth, scope.sourceType) || null;
  const dataCount = scope.sourceType === SOURCE_TYPES.SYSTEM_OP
    ? countValue(db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM vcc_fin_op_system_snapshots
        WHERE target_month = ?
      `).get(scope.targetMonth))
    : countValue(db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      `).get(scope.targetMonth, scope.sourceType));
  const calculatedRunCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
  `).get(scope.targetMonth));
  const archived = Boolean(db.prepare(`
    SELECT 1
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    UNION ALL
    SELECT 1
    FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'archived'
    UNION ALL
    SELECT 1
    FROM vcc_fin_op_datasets
    WHERE target_month = ? AND data_status = 'archived'
    LIMIT 1
  `).get(scope.targetMonth, scope.targetMonth, scope.targetMonth));
  const activeBatch = db.prepare(`
    SELECT id, target_month
    FROM vcc_fin_op_import_batches
    WHERE status = 'importing'
    ORDER BY started_at, id
    LIMIT 1
  `).get() || null;

  let code = '';
  let message = '';
  if (archived || (dataset && dataset.data_status === 'archived')) {
    code = 'archived-month';
    message = `${scope.targetMonth} 已归档，禁止删除`;
  } else if (taskActive || activeBatch) {
    code = 'active-task';
    message = '当前仍有 VCC 财务OP任务或原表导入进行中，禁止删除';
  } else if (dataCount === 0) {
    code = 'no-data';
    message = '当前选择没有可删除的有效数据';
  }

  return {
    ...scope,
    sourceLabel: SOURCE_LABELS[scope.sourceType],
    datasetRevision: dataset ? Number(dataset.revision) || 1 : null,
    dataCount,
    calculatedRunCount,
    deletable: !code,
    code,
    message
  };
}

function assertDeletable(state) {
  if (!state.deletable) throw scopeError(state.code || 'delete-blocked', state.message || '当前数据不可删除');
}

function materializeDetailAudit(db, targetMonth, sourceType) {
  db.prepare(`
    UPDATE vcc_fin_op_import_rows AS audit
    SET existing_raw_json_snapshot = COALESCE(
          existing_raw_json_snapshot,
          (SELECT effective.raw_json FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_raw_contract_version_snapshot = COALESCE(
          existing_raw_contract_version_snapshot,
          (SELECT effective.raw_contract_version FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_subject_snapshot = COALESCE(
          existing_subject_snapshot,
          (SELECT effective.subject FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_source_file_snapshot = COALESCE(
          existing_source_file_snapshot,
          (SELECT effective.source_file FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_sheet_name_snapshot = COALESCE(
          existing_sheet_name_snapshot,
          (SELECT effective.sheet_name FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_source_row_snapshot = COALESCE(
          existing_source_row_snapshot,
          (SELECT effective.source_row FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_import_record_id_snapshot = COALESCE(
          existing_import_record_id_snapshot,
          (SELECT effective.import_record_id FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        ),
        existing_imported_at_snapshot = COALESCE(
          existing_imported_at_snapshot,
          (SELECT effective.first_imported_at FROM vcc_fin_op_effective_rows effective
           WHERE effective.id = audit.existing_effective_id)
        )
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `).run(targetMonth, sourceType);
  db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET existing_effective_id = NULL
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `).run(targetMonth, sourceType);
}

function materializeSystemAudit(db, targetMonth) {
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshot_attempts AS audit
    SET existing_balances_json_snapshot = COALESCE(
          existing_balances_json_snapshot,
          (SELECT snapshot.balances_json FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_raw_json_snapshot = COALESCE(
          existing_raw_json_snapshot,
          (SELECT snapshot.raw_json FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_source_file_snapshot = COALESCE(
          existing_source_file_snapshot,
          (SELECT snapshot.source_file FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_sheet_name_snapshot = COALESCE(
          existing_sheet_name_snapshot,
          (SELECT snapshot.sheet_name FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_source_row_snapshot = COALESCE(
          existing_source_row_snapshot,
          (SELECT snapshot.source_row FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_import_record_id_snapshot = COALESCE(
          existing_import_record_id_snapshot,
          (SELECT snapshot.import_record_id FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        ),
        existing_imported_at_snapshot = COALESCE(
          existing_imported_at_snapshot,
          (SELECT snapshot.imported_at FROM vcc_fin_op_system_snapshots snapshot
           WHERE snapshot.id = audit.existing_snapshot_id)
        )
    WHERE existing_snapshot_id IN (
      SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    )
  `).run(targetMonth);
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshot_attempts
    SET existing_snapshot_id = NULL
    WHERE existing_snapshot_id IN (
      SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    )
  `).run(targetMonth);
}

function deleteCalculatedRuns(db, targetMonth) {
  const runCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
  `).get(targetMonth));
  const childTables = [
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals'
  ];
  for (const tableName of childTables) {
    db.prepare(`
      DELETE FROM ${tableName}
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `).run(targetMonth);
  }
  const deletedRunCount = Number(db.prepare(`
    DELETE FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
  `).run(targetMonth).changes) || 0;
  if (deletedRunCount !== runCount) {
    throw scopeError('delete-invariant-failed', '未归档计算结果未能完整作废，删除已回滚');
  }
  return deletedRunCount;
}

function assertDeletionPostconditions(db, state, deletedDataCount, invalidatedRunCount, deletedDatasetCount) {
  const remainingDataCount = state.sourceType === SOURCE_TYPES.SYSTEM_OP
    ? countValue(db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM vcc_fin_op_system_snapshots
        WHERE target_month = ?
      `).get(state.targetMonth))
    : countValue(db.prepare(`
        SELECT COUNT(*) AS row_count
        FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      `).get(state.targetMonth, state.sourceType));
  const remainingRunCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
  `).get(state.targetMonth));
  const remainingDatasetCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_datasets
    WHERE target_month = ? AND dataset_type = ?
  `).get(state.targetMonth, state.sourceType));
  const expectedDatasetCount = state.datasetRevision === null ? 0 : 1;
  if (
    deletedDataCount !== state.dataCount
    || invalidatedRunCount !== state.calculatedRunCount
    || deletedDatasetCount !== expectedDatasetCount
    || remainingDataCount !== 0
    || remainingRunCount !== 0
    || remainingDatasetCount !== 0
  ) {
    throw scopeError('delete-invariant-failed', '删除后的数据状态校验未通过，删除已回滚');
  }
}

function markImportRecordsDeleted(db, state, deletionId) {
  const statusPlaceholders = DELETABLE_IMPORT_STATUSES.map(() => '?').join(', ');
  const scopeParams = [state.targetMonth, state.sourceType, ...DELETABLE_IMPORT_STATUSES];
  const expectedCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_records
    WHERE target_month = ? AND source_type = ?
      AND status IN (${statusPlaceholders})
      AND dataset_deleted_at IS NULL
  `).get(...scopeParams));
  if (expectedCount === 0) {
    throw scopeError('delete-invariant-failed', '未找到与有效数据对应的成功导入记录，删除已回滚');
  }
  const markedCount = Number(db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET dataset_deleted_at = datetime('now', 'localtime'),
        dataset_deletion_id = ?
    WHERE target_month = ? AND source_type = ?
      AND status IN (${statusPlaceholders})
      AND dataset_deleted_at IS NULL
  `).run(deletionId, ...scopeParams).changes) || 0;
  const linkedCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_records
    WHERE dataset_deletion_id = ? AND dataset_deleted_at IS NOT NULL
  `).get(deletionId));
  if (markedCount !== expectedCount || linkedCount !== expectedCount) {
    throw scopeError('delete-invariant-failed', '导入记录删除状态未能完整更新，删除已回滚');
  }
  return markedCount;
}

function deleteDataset({
  db,
  targetMonth,
  sourceType,
  taskActive = false,
  expectedPreviewToken = '',
  taskGeneration = 0,
  reason = DEFAULT_DELETE_REASON,
  appVersion = null,
  buildSha = null
}) {
  const scope = normalizeScope(targetMonth, sourceType);
  const deletionReason = String(reason || DEFAULT_DELETE_REASON);
  let failureEvidence = {
    action: DELETE_SOURCE_DATASET_OPERATION,
    targetMonth: scope.targetMonth,
    sourceType: scope.sourceType,
    sourceLabel: SOURCE_LABELS[scope.sourceType],
    datasetRevision: null,
    reason: deletionReason,
    previewToken: expectedPreviewToken || null,
    taskGeneration: Number(taskGeneration),
    runs: []
  };
  let transactionStarted = false;
  try {
    const initialState = inspectDatasetDeletion(
      db,
      scope.targetMonth,
      scope.sourceType,
      { taskActive }
    );
    assertDeletable(initialState);
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const state = inspectDatasetDeletion(db, initialState.targetMonth, initialState.sourceType);
    assertDeletable(state);
    const operationState = buildOperationState(db, {
      action: 'delete-data-target',
      targetMonth: state.targetMonth,
      taskGeneration,
      scope: { targetType: state.sourceType }
    });
    const currentPreviewToken = operationPreviewToken(operationState);
    failureEvidence = {
      ...failureEvidence,
      sourceLabel: state.sourceLabel,
      datasetRevision: state.datasetRevision,
      previewToken: expectedPreviewToken || currentPreviewToken,
      operationState,
      runIds: [],
      runs: []
    };
    if (expectedPreviewToken) {
      assertPreviewToken(expectedPreviewToken, currentPreviewToken);
    }
    const calculatedRunIds = db.prepare(`
      SELECT id
      FROM vcc_fin_op_runs
      WHERE target_month = ? AND status = 'calculated'
      ORDER BY id
    `).all(state.targetMonth).map((row) => Number(row.id));
    failureEvidence.runIds = calculatedRunIds;
    for (const runId of calculatedRunIds) {
      failureEvidence.runs.push(collectRunEvidence(db, runId));
    }
    const auditId = insertOperationAudit(db, {
      targetMonth: state.targetMonth,
      operationType: DELETE_SOURCE_DATASET_OPERATION,
      status: 'success',
      previewToken: currentPreviewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha
    });
    const invalidatedRunCount = deleteCalculatedRuns(db, state.targetMonth);
    let deletedDataCount;
    if (state.sourceType === SOURCE_TYPES.SYSTEM_OP) {
      materializeSystemAudit(db, state.targetMonth);
      deletedDataCount = Number(db.prepare(`
        DELETE FROM vcc_fin_op_system_snapshots WHERE target_month = ?
      `).run(state.targetMonth).changes) || 0;
    } else {
      materializeDetailAudit(db, state.targetMonth, state.sourceType);
      deletedDataCount = Number(db.prepare(`
        DELETE FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      `).run(state.targetMonth, state.sourceType).changes) || 0;
    }
    const deletedDatasetCount = Number(db.prepare(`
      DELETE FROM vcc_fin_op_datasets
      WHERE target_month = ? AND dataset_type = ?
    `).run(state.targetMonth, state.sourceType).changes) || 0;
    assertDeletionPostconditions(
      db,
      state,
      deletedDataCount,
      invalidatedRunCount,
      deletedDatasetCount
    );
    const deletionResult = db.prepare(`
      INSERT INTO vcc_fin_op_dataset_deletions (
        target_month, source_type, dataset_revision,
        deleted_data_count, invalidated_run_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      state.targetMonth,
      state.sourceType,
      state.datasetRevision,
      deletedDataCount,
      invalidatedRunCount
    );
    const deletionId = Number(deletionResult.lastInsertRowid);
    const deletedImportRecordCount = markImportRecordsDeleted(db, state, deletionId);
    db.exec('COMMIT');
    transactionStarted = false;
    return {
      targetMonth: state.targetMonth,
      sourceType: state.sourceType,
      sourceLabel: state.sourceLabel,
      deletedDataCount,
      invalidatedRunCount,
      deletionId,
      deletedImportRecordCount,
      auditId
    };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* best-effort audit below */ }
    }
    if (db.isTransaction !== true) {
      persistRolledBackAudit(db, {
        targetMonth: scope.targetMonth,
        operationType: DELETE_SOURCE_DATASET_OPERATION,
        previewToken: failureEvidence.previewToken || expectedPreviewToken || null,
        evidence: failureEvidence,
        error,
        appVersion,
        buildSha
      });
    }
    throw error;
  }
}

module.exports = {
  DELETE_SOURCE_DATASET_OPERATION,
  DEFAULT_DELETE_REASON,
  ALLOWED_SOURCE_TYPES,
  DELETABLE_IMPORT_STATUSES,
  inspectDatasetDeletion,
  deleteDataset
};
