'use strict';

const { SOURCE_TYPES, SOURCE_LABELS } = require('./definitions');
const { parseBalancesJson } = require('./calculator');
const repository = require('../vcc-financial-op-db/repository');
const {
  ALLOWED_SOURCE_TYPES,
  inspectDatasetDeletion,
  deleteDataset
} = require('./dataset-deletion');
const {
  operationError,
  normalizeOperationMonth,
  buildOperationState,
  operationPreviewToken,
  assertPreviewToken,
  validateOperationConfirmation,
  readDatabaseLocalTimestamp
} = require('./operation-state');
const {
  collectRunEvidence,
  insertOperationAudit,
  assertSuccessOperationAudit,
  persistRolledBackAudit
} = require('./operation-audit');
const {
  PRESERVED_OPERATIONS,
  snapshotPreservedOperationState,
  assertPreservedOperationState
} = require('./preserved-state');

const DELETE_ACTION = 'delete-data-target';
const DELETE_TARGET_TYPES = Object.freeze({
  OPENING: 'opening_initialization',
  RESULT: 'result'
});
const DELETE_TARGET_LABELS = Object.freeze({
  [DELETE_TARGET_TYPES.OPENING]: '首月期初初始化数据',
  [DELETE_TARGET_TYPES.RESULT]: '财务OP校验结果表'
});
const DELETE_OPENING_OPERATION = 'delete_opening_initialization';
const DELETE_RESULT_OPERATION = 'delete_unarchived_result';

function normalizeDeleteTarget(payload = {}) {
  const targetMonth = normalizeOperationMonth(payload.targetMonth);
  const targetType = String(payload.targetType || payload.sourceType || '').trim();
  if (ALLOWED_SOURCE_TYPES.has(targetType)) {
    return { targetMonth, targetType, sourceType: targetType, kind: 'source' };
  }
  if (targetType === DELETE_TARGET_TYPES.OPENING) {
    return { targetMonth, targetType, sourceType: null, kind: 'opening' };
  }
  if (targetType === DELETE_TARGET_TYPES.RESULT) {
    return { targetMonth, targetType, sourceType: null, kind: 'result' };
  }
  throw operationError('invalid-delete-target', `不支持删除的目标表：${targetType || ''}`);
}

function operationStateForTarget(db, target, taskGeneration) {
  return buildOperationState(db, {
    action: DELETE_ACTION,
    targetMonth: target.targetMonth,
    taskGeneration,
    scope: { targetType: target.targetType }
  });
}

function datasetsAreUnarchived(datasets) {
  return datasets.every((row) => row.dataStatus !== 'archived' && row.archivedRunId === null);
}

function previewOpeningDeletion(db, target, state, { taskActive }) {
  const moduleState = repository.getVccFinancialOpModuleState(db);
  const archivedExists = state.runs.some((run) => run.status === 'archived')
    || state.archives.length > 0
    || state.datasets.some((dataset) => dataset.dataStatus === 'archived');
  const calculatedRunCount = state.runs.filter((run) => run.status === 'calculated').length;
  let code = '';
  let message = '';
  if (moduleState.migrationDiagnostic) {
    code = moduleState.migrationDiagnostic.code;
    message = moduleState.migrationDiagnostic.message;
  } else if (target.targetMonth !== moduleState.firstMonth) {
    code = 'not-first-month';
    message = moduleState.firstMonth
      ? `仅首月 ${moduleState.firstMonth} 可删除期初初始化数据。`
      : '尚未确定 VCC 财务OP首月，不能删除期初初始化数据。';
  } else if (state.opening.count === 0) {
    code = 'no-opening-data';
    message = '暂无首月期初初始化数据。';
  } else if (archivedExists) {
    code = 'opening-archived';
    message = '该月财务OP校验结果已归档，请先解归档后再删除首月期初初始化数据。';
  } else if (!datasetsAreUnarchived(state.datasets)) {
    code = 'dataset-state-inconsistent';
    message = '首月现存数据集状态不一致，已阻止删除期初初始化数据。';
  } else if (taskActive || state.sourceFacts.activeImportBatchCount > 0) {
    code = 'active-vcc-task';
    message = '已有 VCC 财务OP任务正在运行，请完成后重试。';
  } else if (state.sourceFacts.unresolvedImportCount > 0) {
    code = 'unresolved-imports';
    message = '该月仍有未处理的导入异常，禁止删除首月期初初始化数据。';
  }
  return {
    targetType: target.targetType,
    targetLabel: DELETE_TARGET_LABELS[target.targetType],
    count: state.opening.count,
    calculatedRunCount,
    firstMonth: moduleState.firstMonth,
    available: !code,
    deletable: !code,
    code,
    disabledReason: message,
    message
  };
}

function previewResultDeletion(target, state, { taskActive }) {
  const calculatedRuns = state.runs.filter((run) => run.status === 'calculated');
  const archivedExists = state.runs.some((run) => run.status === 'archived')
    || state.archives.length > 0
    || state.datasets.some((dataset) => dataset.dataStatus === 'archived');
  let code = '';
  let message = '';
  if (archivedExists) {
    code = 'result-archived-delete-forbidden';
    message = '已归档结果不可删除，请先解归档。';
  } else if (taskActive || state.sourceFacts.activeImportBatchCount > 0) {
    code = 'active-vcc-task';
    message = '已有 VCC 财务OP任务正在运行，请完成后重试。';
  } else if (calculatedRuns.length === 0) {
    code = 'no-result-data';
    message = '当前月份没有可删除的未归档财务OP校验结果。';
  }
  return {
    targetType: target.targetType,
    targetLabel: DELETE_TARGET_LABELS[target.targetType],
    count: calculatedRuns.length,
    calculatedRunCount: calculatedRuns.length,
    runIds: calculatedRuns.map((run) => run.id),
    available: !code,
    deletable: !code,
    code,
    disabledReason: message,
    message
  };
}

function previewDataTargetDeletion(db, payload = {}, {
  taskActive = false,
  taskGeneration = 0
} = {}) {
  const target = normalizeDeleteTarget(payload);
  const state = operationStateForTarget(db, target, taskGeneration);
  const previewToken = operationPreviewToken(state);
  let preview;
  if (target.kind === 'source') {
    const sourcePreview = inspectDatasetDeletion(
      db,
      target.targetMonth,
      target.sourceType,
      { taskActive }
    );
    preview = {
      targetType: target.targetType,
      targetLabel: sourcePreview.sourceLabel,
      count: sourcePreview.dataCount,
      available: sourcePreview.deletable,
      disabledReason: sourcePreview.message,
      ...sourcePreview
    };
  } else if (target.kind === 'opening') {
    preview = previewOpeningDeletion(db, target, state, { taskActive });
  } else {
    preview = previewResultDeletion(target, state, { taskActive });
  }
  return {
    targetMonth: target.targetMonth,
    ...preview,
    previewToken,
    taskGeneration: Number(taskGeneration)
  };
}

function listDeleteTargets(db, targetMonth, options = {}) {
  const month = normalizeOperationMonth(targetMonth);
  const targets = [];
  for (const sourceType of ALLOWED_SOURCE_TYPES) {
    targets.push(previewDataTargetDeletion(db, {
      targetMonth: month,
      targetType: sourceType
    }, options));
  }
  const moduleState = repository.getVccFinancialOpModuleState(db);
  if (moduleState.firstMonth === month) {
    targets.push(previewDataTargetDeletion(db, {
      targetMonth: month,
      targetType: DELETE_TARGET_TYPES.OPENING
    }, options));
  }
  const resultCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs WHERE target_month = ?
  `).get(month).row_count) || 0;
  if (resultCount > 0) {
    targets.push(previewDataTargetDeletion(db, {
      targetMonth: month,
      targetType: DELETE_TARGET_TYPES.RESULT
    }, options));
  }
  return targets;
}

function assertDeletePreview(preview) {
  if (preview.deletable || preview.available) return;
  throw operationError(
    preview.code || 'delete-blocked',
    preview.message || preview.disabledReason || '当前数据不可删除',
    { preview, context: { preview } }
  );
}

function deleteRunChildren(db, runIds) {
  if (!Array.isArray(runIds) || runIds.length === 0) return;
  const placeholders = runIds.map(() => '?').join(', ');
  for (const tableName of [
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals'
  ]) {
    db.prepare(`DELETE FROM ${tableName} WHERE run_id IN (${placeholders})`).run(...runIds);
  }
}

function assertTargetMonthRunsDeleted(db, targetMonth, runIds) {
  const originalRunIds = Array.isArray(runIds) ? runIds : [];
  const originalRunFilter = originalRunIds.length > 0
    ? ` OR child.run_id IN (${originalRunIds.map(() => '?').join(', ')})`
    : '';
  const remainingRunCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_runs
    WHERE target_month = ?
  `).get(targetMonth).row_count) || 0;
  let remainingCount = 0;
  for (const tableName of [
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals'
  ]) {
    remainingCount += Number(db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM ${tableName} child
      LEFT JOIN vcc_fin_op_runs run ON run.id = child.run_id
      WHERE run.target_month = ?${originalRunFilter}
    `).get(targetMonth, ...originalRunIds).row_count) || 0;
  }
  if (remainingRunCount !== 0 || remainingCount !== 0) {
    throw operationError('delete-invariant-failed', '目标月结果或子表未能完整删除，操作已回滚。');
  }
}

function assertOpeningDeletionPostconditions(db, targetMonth, runIds) {
  const remainingOpening = Number(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_opening_balances
    WHERE target_month = ?
  `).get(targetMonth).row_count) || 0;
  const moduleState = repository.getVccFinancialOpModuleState(db);
  if (
    remainingOpening !== 0
    || moduleState.firstMonth !== targetMonth
    || moduleState.migrationDiagnostic
  ) {
    throw operationError('delete-invariant-failed', '删除后首月状态断言失败，操作已回滚。');
  }
  assertTargetMonthRunsDeleted(db, targetMonth, runIds);
  return moduleState;
}

function openingEvidence(db, targetMonth) {
  return db.prepare(`
    SELECT target_month, subject, balances_json, content_hash,
           initialization_note, initialized_at
    FROM vcc_fin_op_opening_balances
    WHERE target_month = ?
    ORDER BY subject
  `).all(targetMonth).map((row) => ({
    targetMonth: row.target_month,
    subject: row.subject,
    balances: parseBalancesJson(row.balances_json, `${targetMonth} ${row.subject} 首月期初`),
    balancesJson: row.balances_json,
    contentHash: row.content_hash,
    initializationNote: row.initialization_note,
    initializedAt: row.initialized_at
  }));
}

function deleteOpeningInitialization({
  db,
  targetMonth,
  expectedPreviewToken,
  taskGeneration,
  reason = '用户在数据管理中删除首月全部期初初始化数据',
  appVersion = null,
  buildSha = null
}) {
  const target = normalizeDeleteTarget({ targetMonth, targetType: DELETE_TARGET_TYPES.OPENING });
  let failureEvidence = { action: DELETE_OPENING_OPERATION, targetMonth: target.targetMonth, reason };
  let transactionStarted = false;
  try {
    const confirmedGeneration = validateOperationConfirmation(
      expectedPreviewToken,
      taskGeneration
    );
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const preview = previewDataTargetDeletion(db, target, { taskGeneration: confirmedGeneration });
    assertPreviewToken(expectedPreviewToken, preview.previewToken);
    assertDeletePreview(preview);
    const before = operationStateForTarget(db, target, confirmedGeneration);
    const openings = openingEvidence(db, target.targetMonth);
    const calculatedRunIds = before.runs
      .filter((run) => run.status === 'calculated')
      .map((run) => run.id);
    const runs = calculatedRunIds.map((runId) => collectRunEvidence(db, runId));
    const preservedBefore = snapshotPreservedOperationState(db, {
      targetMonth: target.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_OPENING
    });
    failureEvidence = {
      action: DELETE_OPENING_OPERATION,
      targetMonth: target.targetMonth,
      reason,
      preview,
      before,
      openings,
      runs,
      preservedState: preservedBefore
    };
    const auditId = insertOperationAudit(db, {
      targetMonth: target.targetMonth,
      operationType: DELETE_OPENING_OPERATION,
      status: 'success',
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp
    });

    deleteRunChildren(db, calculatedRunIds);
    const deletedRuns = Number(db.prepare(`
      DELETE FROM vcc_fin_op_runs
      WHERE target_month = ? AND status = 'calculated'
    `).run(target.targetMonth).changes) || 0;
    const deletedOpenings = Number(db.prepare(`
      DELETE FROM vcc_fin_op_opening_balances WHERE target_month = ?
    `).run(target.targetMonth).changes) || 0;
    if (deletedRuns !== calculatedRunIds.length || deletedOpenings !== openings.length) {
      throw operationError('delete-invariant-failed', '首月期初或未归档结果未能完整删除，操作已回滚。');
    }
    const moduleState = assertOpeningDeletionPostconditions(
      db,
      target.targetMonth,
      calculatedRunIds
    );
    assertSuccessOperationAudit(db, {
      auditId,
      auditBoundaryId: preservedBefore.boundaries.operationAuditMaxId,
      targetMonth: target.targetMonth,
      operationType: DELETE_OPENING_OPERATION,
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp,
      code: 'delete-invariant-failed',
      message: '删除首月期初成功审计提交前校验失败，操作已回滚。'
    });
    const preservedAfter = snapshotPreservedOperationState(db, {
      targetMonth: target.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_OPENING,
      phase: 'after',
      baseline: preservedBefore
    });
    assertPreservedOperationState(preservedBefore, preservedAfter, {
      code: 'delete-invariant-failed',
      message: '删除期初前后保留数据或审计内容发生变化，操作已回滚。'
    });
    assertOpeningDeletionPostconditions(db, target.targetMonth, calculatedRunIds);
    db.exec('COMMIT');
    transactionStarted = false;
    return {
      status: 'deleted',
      targetMonth: target.targetMonth,
      targetType: target.targetType,
      targetLabel: DELETE_TARGET_LABELS[target.targetType],
      deletedOpeningCount: deletedOpenings,
      deletedRunCount: deletedRuns,
      firstMonth: moduleState.firstMonth,
      auditId
    };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* best-effort audit below */ }
    }
    if (db.isTransaction !== true) {
      persistRolledBackAudit(db, {
        targetMonth: target.targetMonth,
        operationType: DELETE_OPENING_OPERATION,
        previewToken: expectedPreviewToken || null,
        evidence: failureEvidence,
        error,
        appVersion,
        buildSha
      });
    }
    throw error;
  }
}

function deleteUnarchivedResult({
  db,
  targetMonth,
  expectedPreviewToken,
  taskGeneration,
  reason = '用户在数据管理中删除目标月全部未归档财务OP校验结果',
  appVersion = null,
  buildSha = null
}) {
  const target = normalizeDeleteTarget({ targetMonth, targetType: DELETE_TARGET_TYPES.RESULT });
  let failureEvidence = { action: DELETE_RESULT_OPERATION, targetMonth: target.targetMonth, reason };
  let transactionStarted = false;
  try {
    const confirmedGeneration = validateOperationConfirmation(
      expectedPreviewToken,
      taskGeneration
    );
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const preview = previewDataTargetDeletion(db, target, { taskGeneration: confirmedGeneration });
    assertPreviewToken(expectedPreviewToken, preview.previewToken);
    assertDeletePreview(preview);
    const before = operationStateForTarget(db, target, confirmedGeneration);
    const runIds = before.runs.filter((run) => run.status === 'calculated').map((run) => run.id);
    const runs = runIds.map((runId) => collectRunEvidence(db, runId));
    const preservedBefore = snapshotPreservedOperationState(db, {
      targetMonth: target.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_RESULT
    });
    failureEvidence = {
      action: DELETE_RESULT_OPERATION,
      targetMonth: target.targetMonth,
      reason,
      preview,
      before,
      runs,
      preservedState: preservedBefore
    };
    const auditId = insertOperationAudit(db, {
      targetMonth: target.targetMonth,
      operationType: DELETE_RESULT_OPERATION,
      status: 'success',
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp
    });

    deleteRunChildren(db, runIds);
    const deletedRuns = Number(db.prepare(`
      DELETE FROM vcc_fin_op_runs
      WHERE target_month = ? AND status = 'calculated'
    `).run(target.targetMonth).changes) || 0;
    if (deletedRuns !== runIds.length) {
      throw operationError('delete-invariant-failed', '未归档结果未能完整删除，操作已回滚。');
    }
    assertTargetMonthRunsDeleted(db, target.targetMonth, runIds);
    assertSuccessOperationAudit(db, {
      auditId,
      auditBoundaryId: preservedBefore.boundaries.operationAuditMaxId,
      targetMonth: target.targetMonth,
      operationType: DELETE_RESULT_OPERATION,
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp,
      code: 'delete-invariant-failed',
      message: '删除未归档结果成功审计提交前校验失败，操作已回滚。'
    });
    const preservedAfter = snapshotPreservedOperationState(db, {
      targetMonth: target.targetMonth,
      operation: PRESERVED_OPERATIONS.DELETE_RESULT,
      phase: 'after',
      baseline: preservedBefore
    });
    assertPreservedOperationState(preservedBefore, preservedAfter, {
      code: 'delete-invariant-failed',
      message: '删除结果前后保留数据或审计内容发生变化，操作已回滚。'
    });
    assertTargetMonthRunsDeleted(db, target.targetMonth, runIds);
    db.exec('COMMIT');
    transactionStarted = false;
    return {
      status: 'deleted',
      targetMonth: target.targetMonth,
      targetType: target.targetType,
      targetLabel: DELETE_TARGET_LABELS[target.targetType],
      deletedRunCount: deletedRuns,
      deletedRunIds: runIds,
      auditId
    };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* best-effort audit below */ }
    }
    if (db.isTransaction !== true) {
      persistRolledBackAudit(db, {
        targetMonth: target.targetMonth,
        operationType: DELETE_RESULT_OPERATION,
        previewToken: expectedPreviewToken || null,
        evidence: failureEvidence,
        error,
        appVersion,
        buildSha
      });
    }
    throw error;
  }
}

function deleteDataTarget({ db, ...payload }) {
  const confirmedGeneration = validateOperationConfirmation(
    payload.expectedPreviewToken,
    payload.taskGeneration
  );
  const target = normalizeDeleteTarget(payload);
  const confirmedPayload = { ...payload, taskGeneration: confirmedGeneration };
  if (target.kind === 'source') {
    return deleteDataset({
      db,
      targetMonth: target.targetMonth,
      sourceType: target.sourceType,
      expectedPreviewToken: confirmedPayload.expectedPreviewToken,
      taskGeneration: confirmedPayload.taskGeneration,
      reason: confirmedPayload.reason,
      appVersion: confirmedPayload.appVersion,
      buildSha: confirmedPayload.buildSha
    });
  }
  if (target.kind === 'opening') return deleteOpeningInitialization({ db, ...confirmedPayload });
  return deleteUnarchivedResult({ db, ...confirmedPayload });
}

module.exports = {
  DELETE_ACTION,
  DELETE_TARGET_TYPES,
  DELETE_TARGET_LABELS,
  DELETE_OPENING_OPERATION,
  DELETE_RESULT_OPERATION,
  normalizeDeleteTarget,
  listDeleteTargets,
  previewDataTargetDeletion,
  deleteOpeningInitialization,
  deleteUnarchivedResult,
  deleteDataTarget
};
