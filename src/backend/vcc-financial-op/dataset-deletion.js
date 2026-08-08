'use strict';

const { SOURCE_TYPES, SOURCE_LABELS } = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const {
  buildOperationState,
  operationPreviewToken,
  assertPreviewToken,
  validateOperationConfirmation,
  fingerprintQuery,
  stableStringify
} = require('./operation-state');
const {
  collectRunEvidence,
  insertOperationAudit,
  persistRolledBackAudit
} = require('./operation-audit');
const {
  PRESERVED_OPERATIONS,
  snapshotPreservedOperationState,
  assertPreservedOperationState
} = require('./preserved-state');

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
  const affectedCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `).get(targetMonth, sourceType));
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
  const mismatchedCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows audit
    JOIN vcc_fin_op_effective_rows effective ON effective.id = audit.existing_effective_id
    WHERE effective.target_month = ? AND effective.source_type = ?
      AND (
        audit.existing_raw_json_snapshot IS NOT effective.raw_json
        OR audit.existing_raw_contract_version_snapshot IS NOT effective.raw_contract_version
        OR audit.existing_subject_snapshot IS NOT effective.subject
        OR audit.existing_source_file_snapshot IS NOT effective.source_file
        OR audit.existing_sheet_name_snapshot IS NOT effective.sheet_name
        OR audit.existing_source_row_snapshot IS NOT effective.source_row
        OR audit.existing_import_record_id_snapshot IS NOT effective.import_record_id
        OR audit.existing_imported_at_snapshot IS NOT effective.first_imported_at
      )
  `).get(targetMonth, sourceType));
  if (mismatchedCount !== 0) {
    throw scopeError('delete-invariant-failed', '有效明细审计血缘物化不完整，删除已回滚');
  }
  db.prepare(`
    UPDATE vcc_fin_op_import_rows
    SET existing_effective_id = NULL
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `).run(targetMonth, sourceType);
  const remainingReferenceCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `).get(targetMonth, sourceType));
  if (remainingReferenceCount !== 0) {
    throw scopeError('delete-invariant-failed', '有效明细审计外键未能完整解除，删除已回滚');
  }
  return affectedCount;
}

function materializeSystemAudit(db, targetMonth) {
  const beforeAttemptMaxId = countValue(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
  `).get());
  const beforeAttemptCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE target_month = ?
  `).get(targetMonth));
  const backfilledAttemptCount = Number(db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, existing_snapshot_id, message
    )
    SELECT snapshot.import_record_id, snapshot.target_month, snapshot.subject,
           snapshot.balances_json, snapshot.content_hash,
           snapshot.source_file, snapshot.sheet_name, snapshot.source_row,
           snapshot.raw_json, 'accepted', snapshot.id,
           '历史快照删除前补录首次成功导入审计'
    FROM vcc_fin_op_system_snapshots snapshot
    WHERE snapshot.target_month = ?
      AND NOT EXISTS (
        SELECT 1
        FROM vcc_fin_op_system_snapshot_attempts attempt
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
      )
  `).run(targetMonth).changes) || 0;
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
  const snapshotCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
  `).get(targetMonth));
  const completeAcceptedCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshots snapshot
    WHERE snapshot.target_month = ?
      AND EXISTS (
        SELECT 1
        FROM vcc_fin_op_system_snapshot_attempts attempt
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
          AND attempt.existing_balances_json_snapshot = snapshot.balances_json
          AND attempt.existing_raw_json_snapshot = snapshot.raw_json
          AND attempt.existing_source_file_snapshot = snapshot.source_file
          AND attempt.existing_sheet_name_snapshot = snapshot.sheet_name
          AND attempt.existing_source_row_snapshot = snapshot.source_row
          AND attempt.existing_import_record_id_snapshot = snapshot.import_record_id
          AND attempt.existing_imported_at_snapshot = snapshot.imported_at
      )
  `).get(targetMonth));
  if (completeAcceptedCount !== snapshotCount) {
    throw scopeError('delete-invariant-failed', '系统财务OP首次成功审计血缘物化不完整，删除已回滚');
  }
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshot_attempts
    SET existing_snapshot_id = NULL
    WHERE existing_snapshot_id IN (
      SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    )
  `).run(targetMonth);
  const remainingReferenceCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE existing_snapshot_id IN (
      SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    )
  `).get(targetMonth));
  const afterAttemptCount = countValue(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE target_month = ?
  `).get(targetMonth));
  if (
    remainingReferenceCount !== 0
    || afterAttemptCount !== beforeAttemptCount + backfilledAttemptCount
  ) {
    throw scopeError('delete-invariant-failed', '系统财务OP审计外键未能完整解除，删除已回滚');
  }
  const afterAttemptMaxId = countValue(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts
  `).get());
  const backfilledFingerprint = fingerprintQuery(db, {
    tableName: 'vcc_fin_op_system_snapshot_attempts:new-backfill',
    sql: `
      SELECT * FROM vcc_fin_op_system_snapshot_attempts
      WHERE id > ? AND id <= ?
      ORDER BY id
    `,
    params: [beforeAttemptMaxId, afterAttemptMaxId]
  });
  return {
    beforeAttemptCount,
    backfilledAttemptCount,
    afterAttemptCount,
    beforeAttemptMaxId,
    afterAttemptMaxId,
    backfilledFingerprint
  };
}

function assertSystemBackfillUnchanged(db, materialization) {
  if (!materialization) return;
  const after = fingerprintQuery(db, {
    tableName: 'vcc_fin_op_system_snapshot_attempts:new-backfill',
    sql: `
      SELECT * FROM vcc_fin_op_system_snapshot_attempts
      WHERE id > ? AND id <= ?
      ORDER BY id
    `,
    params: [materialization.beforeAttemptMaxId, materialization.afterAttemptMaxId]
  });
  if (stableStringify(after) !== stableStringify(materialization.backfilledFingerprint)) {
    throw scopeError('delete-invariant-failed', '历史系统快照补录审计在删除时发生漂移，操作已回滚');
  }
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

function assertDeletionPostconditions(
  db,
  state,
  deletedDataCount,
  invalidatedRunCount,
  deletedDatasetCount,
  invalidatedRunIds
) {
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
  let remainingRunChildCount = 0;
  if (invalidatedRunIds.length > 0) {
    const placeholders = invalidatedRunIds.map(() => '?').join(', ');
    for (const tableName of [
      'vcc_fin_op_run_adjustments',
      'vcc_fin_op_run_rows',
      'vcc_fin_op_run_balances',
      'vcc_fin_op_pending_summary_rows',
      'vcc_fin_op_pending_currency_totals'
    ]) {
      remainingRunChildCount += countValue(db.prepare(`
        SELECT COUNT(*) AS row_count FROM ${tableName}
        WHERE run_id IN (${placeholders})
      `).get(...invalidatedRunIds));
    }
  }
  if (
    deletedDataCount !== state.dataCount
    || invalidatedRunCount !== state.calculatedRunCount
    || deletedDatasetCount !== expectedDatasetCount
    || remainingDataCount !== 0
    || remainingRunCount !== 0
    || remainingDatasetCount !== 0
    || remainingRunChildCount !== 0
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
  expectedPreviewToken,
  taskGeneration,
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
    const confirmedGeneration = validateOperationConfirmation(expectedPreviewToken, taskGeneration);
    const initialOperationState = buildOperationState(db, {
      action: 'delete-data-target',
      targetMonth: scope.targetMonth,
      taskGeneration: confirmedGeneration,
      scope: { targetType: scope.sourceType }
    });
    assertPreviewToken(expectedPreviewToken, operationPreviewToken(initialOperationState));
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
      taskGeneration: confirmedGeneration,
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
    assertPreviewToken(expectedPreviewToken, currentPreviewToken);
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
    const preservedBefore = snapshotPreservedOperationState(db, {
      targetMonth: state.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_SOURCE,
      sourceType: state.sourceType,
      phase: 'before'
    });
    failureEvidence.preservedState = preservedBefore;
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
    let systemAuditMaterialization = null;
    if (state.sourceType === SOURCE_TYPES.SYSTEM_OP) {
      systemAuditMaterialization = materializeSystemAudit(db, state.targetMonth);
      deletedDataCount = Number(db.prepare(`
        DELETE FROM vcc_fin_op_system_snapshots WHERE target_month = ?
      `).run(state.targetMonth).changes) || 0;
      assertSystemBackfillUnchanged(db, systemAuditMaterialization);
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
      deletedDatasetCount,
      calculatedRunIds
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
    const deletionRow = db.prepare(`
      SELECT target_month, source_type, dataset_revision,
             deleted_data_count, invalidated_run_count, deleted_at
      FROM vcc_fin_op_dataset_deletions WHERE id = ?
    `).get(deletionId);
    if (
      !deletionRow
      || deletionRow.target_month !== state.targetMonth
      || deletionRow.source_type !== state.sourceType
      || (deletionRow.dataset_revision === null ? null : Number(deletionRow.dataset_revision))
        !== state.datasetRevision
      || Number(deletionRow.deleted_data_count) !== deletedDataCount
      || Number(deletionRow.invalidated_run_count) !== invalidatedRunCount
      || !deletionRow.deleted_at
    ) {
      throw scopeError('delete-invariant-failed', '数据集删除记录提交前校验失败，删除已回滚');
    }
    const preservedAfter = snapshotPreservedOperationState(db, {
      targetMonth: state.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_SOURCE,
      sourceType: state.sourceType,
      phase: 'after',
      baseline: preservedBefore,
      deletionId
    });
    assertPreservedOperationState(preservedBefore, preservedAfter, {
      code: 'delete-invariant-failed',
      message: '删除前后保留数据或审计内容发生变化，操作已回滚。'
    });
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
