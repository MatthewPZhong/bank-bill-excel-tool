'use strict';

const { DatabaseSync } = require('node:sqlite');
const {
  SOURCE_TYPES,
  SOURCE_LABELS
} = require('./definitions');
const {
  ARCHIVE_CONTRACTS,
  classifyArchiveContract
} = require('./archive-contract');
const { evaluateUnarchiveGate } = require('./unarchive-gate');
const {
  loadArchiveEvidenceSet,
  loadUnarchiveGateEvidence,
  loadDeleteEvidenceV2,
  deletePreviewForTarget,
  SOURCE_TARGET_TYPES,
  DELETE_TARGET_TYPES,
  DELETE_TARGET_LABELS
} = require('./read-snapshot');
const {
  buildOperationTokenV2,
  buildDeleteTargetTokenV2,
  sha256,
  stableStringify
} = require('./operation-token-v2');
const {
  STATE_CHANGED_CODE,
  STATE_CHANGED_MESSAGE,
  readDatabaseLocalTimestamp
} = require('./operation-state');
const {
  VCC_MUTATION_OPERATIONS
} = require('./mutation-policy');
const {
  assertMutationRuntimeAvailable,
  assertVccMutationSchema,
  assertVccTriggerPolicy,
  beginMutationGuard,
  executeRegisteredMutationSteps,
  assertMutationGuardPostwrite,
  closeMutationGuard
} = require('./mutation-guard');
const {
  openVccWriteDatabase,
  isUnsafeAuditError,
  redactedFailure,
  persistRolledBackAuditSafely
} = require('./result-write');

const DESTRUCTIVE_OPERATION_TYPES = Object.freeze({
  [VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH]: 'unarchive',
  [VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET]: 'delete-data-target'
});
const DELETE_SUCCESS_OPERATION_TYPES = Object.freeze({
  [DELETE_TARGET_TYPES.RESULT]: 'delete_unarchived_result',
  [DELETE_TARGET_TYPES.OPENING]: 'delete_opening_initialization',
  source: 'delete-source-dataset'
});
const DETAIL_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING
]);
const DELETE_TARGET_TYPE_SET = new Set([
  ...SOURCE_TARGET_TYPES,
  DELETE_TARGET_TYPES.OPENING,
  DELETE_TARGET_TYPES.RESULT
]);
const RUN_CHILD_SCOPES = Object.freeze([{
  stepId: 'delete.run-adjustments',
  tableName: 'vcc_fin_op_run_adjustments',
  symbol: 'C_adj'
}, {
  stepId: 'delete.run-rows',
  tableName: 'vcc_fin_op_run_rows',
  symbol: 'C_row'
}, {
  stepId: 'delete.run-balances',
  tableName: 'vcc_fin_op_run_balances',
  symbol: 'C_bal'
}, {
  stepId: 'delete.pending-summaries',
  tableName: 'vcc_fin_op_pending_summary_rows',
  symbol: 'C_ps'
}, {
  stepId: 'delete.pending-currency-totals',
  tableName: 'vcc_fin_op_pending_currency_totals',
  symbol: 'C_pc'
}]);

function destructiveWriteError(code, message, context = {}) {
  const error = new Error(message);
  error.code = code;
  error.context = context;
  return error;
}

function normalizeMonth(targetMonth) {
  const value = String(targetMonth || '');
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw destructiveWriteError('invalid-month', `月份账期格式无效：${value}`);
  return value;
}

function normalizePreviewToken(value) {
  const token = String(value || '');
  if (!/^v2:[a-f0-9]{64}$/.test(token)) {
    throw destructiveWriteError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
      expectedPreviewToken: value || null
    });
  }
  return token;
}

function normalizeDestructivePayload(action, payload = {}) {
  if (![
    VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET
  ].includes(action)) {
    throw destructiveWriteError(
      'invalid-vcc-write-action',
      `未知 VCC 破坏性写入 action：${action || ''}`
    );
  }
  const normalized = {
    targetMonth: normalizeMonth(payload.targetMonth),
    expectedPreviewToken: normalizePreviewToken(payload.expectedPreviewToken)
  };
  if (action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH) return Object.freeze(normalized);
  const targetType = String(payload.targetType || payload.sourceType || '').trim();
  if (!DELETE_TARGET_TYPE_SET.has(targetType)) {
    throw destructiveWriteError('invalid-delete-target', `不支持删除的目标表：${targetType}`);
  }
  return Object.freeze({
    ...normalized,
    targetType,
    reason: String(payload.reason || '用户在数据管理中删除目标数据')
  });
}

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({
      ...step,
      bindings: Object.freeze([...step.bindings]),
      largeTableScopeProof: step.largeTableScopeProof
        ? Object.freeze({ ...step.largeTableScopeProof })
        : undefined
    }))),
    tableBudgets: Object.freeze(Object.fromEntries(Object.entries(plan.tableBudgets)
      .map(([tableName, budget]) => [tableName, Object.freeze({ ...budget })])))
  });
}

function fullRow(db, tableName, whereSql, params) {
  const row = db.prepare(`SELECT * FROM ${tableName} WHERE ${whereSql}`).get(...params);
  return row ? { ...row } : null;
}

function operationAuditBoundary(db) {
  return Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_operation_audit
  `).get().max_id);
}

function loadLockedUnarchiveEvidence(db, normalizedPayload, taskGeneration) {
  const [archiveEvidence] = loadArchiveEvidenceSet(db, {
    targetMonth: normalizedPayload.targetMonth
  });
  const archiveContract = classifyArchiveContract(archiveEvidence);
  const gateEvidence = loadUnarchiveGateEvidence(db, normalizedPayload.targetMonth, {
    taskGeneration,
    taskActive: false
  });
  const gate = evaluateUnarchiveGate(archiveContract, gateEvidence);
  const token = buildOperationTokenV2({
    action: 'unarchive',
    targetMonth: normalizedPayload.targetMonth,
    scope: null,
    archiveEvidence,
    archiveContract,
    gateEvidence
  });
  const actualPreviewToken = token ? token.previewToken : null;
  return Object.freeze({
    targetMonth: normalizedPayload.targetMonth,
    taskGeneration: Number(taskGeneration),
    archiveEvidence,
    archiveContract,
    gateEvidence,
    gate,
    previewToken: actualPreviewToken
  });
}

function buildUnarchivePlan(db, evidence, transactionTimestamp, provenance) {
  const contract = evidence.archiveContract;
  if (![ARCHIVE_CONTRACTS.CURRENT, ARCHIVE_CONTRACTS.LEGACY].includes(contract.contract)) {
    throw destructiveWriteError(
      'archive-state-inconsistent',
      '归档结构不一致，禁止解归档。',
      { structuralReasons: contract.structuralReasons }
    );
  }
  const runId = Number(contract.runId);
  const datasetTypes = Object.freeze([...contract.datasetTypes]);
  const archiveCount = evidence.archiveEvidence.archives.length;
  const oldRun = fullRow(db, 'vcc_fin_op_runs', 'id = ?', [runId]);
  const oldDatasets = db.prepare(`
    SELECT * FROM vcc_fin_op_datasets
    WHERE target_month = ? ORDER BY dataset_type
  `).all(evidence.targetMonth).map((row) => ({ ...row }));
  const auditBoundary = operationAuditBoundary(db);
  const expectedTotalChanges = archiveCount + datasetTypes.length + 2;
  const auditEvidence = Object.freeze({
    evidenceVersion: 2,
    operation: 'unarchive',
    targetMonth: evidence.targetMonth,
    archiveContract: contract.contract,
    classifierVersion: contract.classifierVersion,
    runId,
    resultRevision: Number(contract.resultRevision),
    subjects: Object.freeze([...contract.subjects]),
    datasetTypes,
    lockedPreviewTokenDigest: sha256(evidence.previewToken),
    expectedTotalChanges,
    minimumSafeAppVersion: '3.1.9'
  });
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    targetMonth: evidence.targetMonth,
    runId,
    lockedEvidenceToken: evidence.previewToken,
    expectedTotalChanges,
    tableBudgets: {
      vcc_fin_op_operation_audit: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_archives: { inserts: 0, updates: 0, deletes: archiveCount, protection: 'planned-scope' },
      vcc_fin_op_runs: { inserts: 0, updates: 1, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_datasets: { inserts: 0, updates: datasetTypes.length, deletes: 0, protection: 'planned-scope' }
    },
    steps: [{
      stepId: 'unarchive.audit-success',
      expectedChanges: 1,
      bindings: [
        evidence.targetMonth,
        runId,
        evidence.previewToken,
        JSON.stringify(auditEvidence),
        provenance.appVersion,
        provenance.buildSha,
        transactionTimestamp
      ]
    }, {
      stepId: 'unarchive.delete-archives',
      expectedChanges: archiveCount,
      bindings: [evidence.targetMonth]
    }, {
      stepId: 'unarchive.restore-run',
      expectedChanges: 1,
      bindings: [transactionTimestamp, runId, evidence.targetMonth]
    }, {
      stepId: 'unarchive.restore-datasets',
      expectedChanges: datasetTypes.length,
      bindings: [transactionTimestamp, evidence.targetMonth, runId, JSON.stringify(datasetTypes)]
    }],
    expectedPostState: Object.freeze({
      auditBoundary,
      auditEvidence,
      oldRun,
      oldDatasets: Object.freeze(oldDatasets),
      subjects: Object.freeze([...contract.subjects]),
      datasetTypes,
      transactionTimestamp,
      provenance
    })
  });
}

function loadLockedDeleteEvidence(db, normalizedPayload, taskGeneration) {
  const deleteEvidence = loadDeleteEvidenceV2(db, {
    targetMonth: normalizedPayload.targetMonth,
    taskGeneration
  });
  const actualPreviewToken = buildDeleteTargetTokenV2(
    deleteEvidence,
    normalizedPayload.targetType
  ).previewToken;
  const preview = deletePreviewForTarget(deleteEvidence, normalizedPayload.targetType, {
    taskActive: false
  });
  return Object.freeze({
    targetMonth: normalizedPayload.targetMonth,
    targetType: normalizedPayload.targetType,
    reason: normalizedPayload.reason,
    taskGeneration: Number(taskGeneration),
    deleteEvidence,
    preview,
    previewToken: actualPreviewToken
  });
}

function assertLockedEvidenceAllowed(action, evidence, normalizedPayload) {
  if (evidence.previewToken !== normalizedPayload.expectedPreviewToken) {
    throw destructiveWriteError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
      expectedPreviewToken: normalizedPayload.expectedPreviewToken,
      actualPreviewToken: evidence.previewToken
    });
  }
  if (action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH) {
    if (!evidence.gate.canUnarchive) {
      const error = destructiveWriteError(
        evidence.gate.code || 'unarchive-blocked',
        evidence.gate.message || '当前月份不可解归档',
        { dependentMonths: evidence.gate.dependentMonths }
      );
      error.dependentMonths = evidence.gate.dependentMonths;
      throw error;
    }
    return;
  }
  if (!evidence.preview.deletable && !evidence.preview.available) {
    const error = destructiveWriteError(
      evidence.preview.code || 'delete-blocked',
      evidence.preview.message || evidence.preview.disabledReason || '当前数据不可删除',
      { preview: evidence.preview }
    );
    if (evidence.preview.code === 'vcc-first-month-migration-blocked') {
      error.suppressRollbackAudit = true;
    }
    throw error;
  }
}

function countRows(db, sql, params = []) {
  return Number(db.prepare(sql).get(...params).row_count);
}

function loadRunDeletionScope(db, targetMonth) {
  const runIds = db.prepare(`
    SELECT id FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
    ORDER BY id
  `).all(targetMonth).map((row) => Number(row.id));
  const childCounts = {};
  for (const scope of RUN_CHILD_SCOPES) {
    childCounts[scope.symbol] = countRows(db, `
      SELECT COUNT(*) AS row_count FROM ${scope.tableName}
      WHERE run_id IN (
        SELECT id FROM vcc_fin_op_runs
        WHERE target_month = ? AND status = 'calculated'
      )
    `, [targetMonth]);
  }
  return Object.freeze({
    runIds: Object.freeze(runIds),
    R: runIds.length,
    childCounts: Object.freeze(childCounts),
    childTotal: Object.values(childCounts).reduce((sum, value) => sum + value, 0)
  });
}

function runDeletionSteps(targetMonth, runScope) {
  const steps = RUN_CHILD_SCOPES.map((scope) => ({
    stepId: scope.stepId,
    expectedChanges: runScope.childCounts[scope.symbol],
    bindings: [targetMonth]
  }));
  steps.push({
    stepId: 'delete.runs',
    expectedChanges: runScope.R,
    bindings: [targetMonth]
  });
  return steps;
}

function runDeletionTableBudgets(runScope) {
  const budgets = {};
  for (const scope of RUN_CHILD_SCOPES) {
    budgets[scope.tableName] = {
      inserts: 0,
      updates: 0,
      deletes: runScope.childCounts[scope.symbol],
      protection: 'planned-scope'
    };
  }
  budgets.vcc_fin_op_runs = {
    inserts: 0,
    updates: 0,
    deletes: runScope.R,
    protection: 'planned-scope'
  };
  return budgets;
}

function deleteOperationType(targetType) {
  return SOURCE_TARGET_TYPES.includes(targetType)
    ? DELETE_SUCCESS_OPERATION_TYPES.source
    : DELETE_SUCCESS_OPERATION_TYPES[targetType];
}

function auditStepBindings({ evidence, operationType, auditEvidence, provenance, transactionTimestamp }) {
  return [
    evidence.targetMonth,
    operationType,
    evidence.previewToken,
    JSON.stringify(auditEvidence),
    provenance.appVersion,
    provenance.buildSha,
    transactionTimestamp
  ];
}

function baseDeletePostState(db, evidence, runScope, transactionTimestamp, provenance) {
  return {
    auditBoundary: operationAuditBoundary(db),
    runIds: runScope.runIds,
    childCounts: runScope.childCounts,
    transactionTimestamp,
    provenance,
    targetType: evidence.targetType
  };
}

function buildResultOrOpeningDeletePlan(db, evidence, transactionTimestamp, provenance) {
  const runScope = loadRunDeletionScope(db, evidence.targetMonth);
  const opening = evidence.targetType === DELETE_TARGET_TYPES.OPENING;
  const openingRows = opening ? db.prepare(`
    SELECT * FROM vcc_fin_op_opening_balances
    WHERE target_month = ? ORDER BY subject
  `).all(evidence.targetMonth).map((row) => ({ ...row })) : [];
  const moduleState = opening
    ? fullRow(db, 'vcc_fin_op_module_state', 'singleton_id = 1', [])
    : null;
  const O = openingRows.length;
  const expectedTotalChanges = 1 + runScope.R + runScope.childTotal + O;
  const operationType = deleteOperationType(evidence.targetType);
  const symbols = Object.freeze({
    R: runScope.R,
    ...runScope.childCounts,
    O
  });
  const auditEvidence = Object.freeze({
    evidenceVersion: 2,
    operation: operationType,
    targetMonth: evidence.targetMonth,
    targetType: evidence.targetType,
    reason: evidence.reason,
    runIds: runScope.runIds,
    symbols,
    lockedPreviewTokenDigest: sha256(evidence.previewToken),
    expectedTotalChanges
  });
  const steps = [{
    stepId: 'delete.audit-success',
    expectedChanges: 1,
    bindings: auditStepBindings({
      evidence,
      operationType,
      auditEvidence,
      provenance,
      transactionTimestamp
    })
  }, ...runDeletionSteps(evidence.targetMonth, runScope)];
  if (opening) {
    steps.push({
      stepId: 'delete.openings',
      expectedChanges: O,
      bindings: [evidence.targetMonth]
    });
  }
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    targetMonth: evidence.targetMonth,
    runId: null,
    lockedEvidenceToken: evidence.previewToken,
    expectedTotalChanges,
    tableBudgets: {
      vcc_fin_op_operation_audit: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      ...runDeletionTableBudgets(runScope),
      ...(opening ? {
        vcc_fin_op_opening_balances: { inserts: 0, updates: 0, deletes: O, protection: 'planned-scope' }
      } : {})
    },
    steps,
    expectedPostState: Object.freeze({
      ...baseDeletePostState(db, evidence, runScope, transactionTimestamp, provenance),
      operationType,
      auditEvidence,
      openingRows: Object.freeze(openingRows),
      moduleState
    })
  });
}

function datasetRow(db, targetMonth, sourceType) {
  return fullRow(
    db,
    'vcc_fin_op_datasets',
    'target_month = ? AND dataset_type = ?',
    [targetMonth, sourceType]
  );
}

function successLikeImportRecords(db, targetMonth, sourceType) {
  return db.prepare(`
    SELECT id FROM vcc_fin_op_import_records
    WHERE target_month = ? AND source_type = ?
      AND status IN ('success', 'success_with_skips', 'all_skipped')
      AND dataset_deleted_at IS NULL
    ORDER BY id
  `).all(targetMonth, sourceType).map((row) => Number(row.id));
}

function detailSourceScope(db, targetMonth, sourceType) {
  const E = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_effective_rows
    WHERE target_month = ? AND source_type = ?
  `, [targetMonth, sourceType]);
  const Q = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_rows AS audit
    JOIN vcc_fin_op_effective_rows AS effective
      ON effective.id = audit.existing_effective_id
    WHERE effective.target_month = ? AND effective.source_type = ?
  `, [targetMonth, sourceType]);
  return Object.freeze({ E, Q });
}

function semanticAcceptedCondition() {
  return `
    attempt.disposition = 'accepted'
    AND attempt.import_record_id IS snapshot.import_record_id
    AND attempt.target_month IS snapshot.target_month
    AND attempt.subject IS snapshot.subject
    AND attempt.balances_json IS snapshot.balances_json
    AND attempt.content_hash IS snapshot.content_hash
    AND attempt.source_file IS snapshot.source_file
    AND attempt.sheet_name IS snapshot.sheet_name
    AND attempt.source_row IS snapshot.source_row
    AND attempt.raw_json IS snapshot.raw_json
    AND attempt.comparison_attempt_id IS NULL
  `;
}

function systemSourceScope(db, targetMonth) {
  const S = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
  `, [targetMonth]);
  const invalidAccepted = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts AS attempt
    JOIN vcc_fin_op_system_snapshots AS snapshot ON snapshot.id = attempt.existing_snapshot_id
    WHERE snapshot.target_month = ? AND attempt.disposition = 'accepted'
      AND NOT (${semanticAcceptedCondition()})
  `, [targetMonth]);
  const duplicateAccepted = countRows(db, `
    SELECT COUNT(*) AS row_count FROM (
      SELECT snapshot.id
      FROM vcc_fin_op_system_snapshots AS snapshot
      LEFT JOIN vcc_fin_op_system_snapshot_attempts AS attempt
        ON attempt.existing_snapshot_id = snapshot.id
       AND ${semanticAcceptedCondition()}
      WHERE snapshot.target_month = ?
      GROUP BY snapshot.id
      HAVING COUNT(attempt.id) > 1
    )
  `, [targetMonth]);
  const materializedMismatch = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts AS attempt
    JOIN vcc_fin_op_system_snapshots AS snapshot ON snapshot.id = attempt.existing_snapshot_id
    WHERE snapshot.target_month = ? AND (
      (attempt.existing_balances_json_snapshot IS NOT NULL AND attempt.existing_balances_json_snapshot IS NOT snapshot.balances_json)
      OR (attempt.existing_raw_json_snapshot IS NOT NULL AND attempt.existing_raw_json_snapshot IS NOT snapshot.raw_json)
      OR (attempt.existing_source_file_snapshot IS NOT NULL AND attempt.existing_source_file_snapshot IS NOT snapshot.source_file)
      OR (attempt.existing_sheet_name_snapshot IS NOT NULL AND attempt.existing_sheet_name_snapshot IS NOT snapshot.sheet_name)
      OR (attempt.existing_source_row_snapshot IS NOT NULL AND attempt.existing_source_row_snapshot IS NOT snapshot.source_row)
      OR (attempt.existing_import_record_id_snapshot IS NOT NULL AND attempt.existing_import_record_id_snapshot IS NOT snapshot.import_record_id)
      OR (attempt.existing_imported_at_snapshot IS NOT NULL AND attempt.existing_imported_at_snapshot IS NOT snapshot.imported_at)
    )
  `, [targetMonth]);
  if (invalidAccepted !== 0 || duplicateAccepted !== 0 || materializedMismatch !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '系统财务OP导入尝试审计与有效快照不一致，删除已回滚。',
      { invalidAccepted, duplicateAccepted, materializedMismatch }
    );
  }
  const B = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshots AS snapshot
    WHERE snapshot.target_month = ?
      AND NOT EXISTS (
        SELECT 1 FROM vcc_fin_op_system_snapshot_attempts AS attempt
        WHERE attempt.existing_snapshot_id = snapshot.id
          AND ${semanticAcceptedCondition()}
      )
  `, [targetMonth]);
  const linkedBefore = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts AS attempt
    JOIN vcc_fin_op_system_snapshots AS snapshot ON snapshot.id = attempt.existing_snapshot_id
    WHERE snapshot.target_month = ?
  `, [targetMonth]);
  const attemptBoundary = Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_system_snapshot_attempts
  `).get().max_id);
  return Object.freeze({ S, B, A: linkedBefore + B, linkedBefore, attemptBoundary });
}

function largeStep(stepId, expectedChanges, bindings, scopeId) {
  return {
    stepId,
    expectedChanges,
    bindings,
    largeTableScopeProof: { scopeId, preCount: expectedChanges }
  };
}

function buildSourceDeletePlan(db, evidence, transactionTimestamp, provenance) {
  const sourceType = evidence.targetType;
  const runScope = loadRunDeletionScope(db, evidence.targetMonth);
  const dataset = datasetRow(db, evidence.targetMonth, sourceType);
  const D = dataset ? 1 : 0;
  const importRecordIds = successLikeImportRecords(db, evidence.targetMonth, sourceType);
  const M = importRecordIds.length;
  if (M === 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '未找到与有效数据对应的成功导入记录，删除已回滚。'
    );
  }
  const deletionBoundary = Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_dataset_deletions
  `).get().max_id);
  const detail = DETAIL_SOURCE_TYPES.has(sourceType);
  const sourceScope = detail
    ? detailSourceScope(db, evidence.targetMonth, sourceType)
    : systemSourceScope(db, evidence.targetMonth);
  const expectedDataCount = detail ? sourceScope.E : sourceScope.S;
  if (expectedDataCount !== Number(evidence.preview.dataCount)) {
    throw destructiveWriteError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
      expectedDataCount: evidence.preview.dataCount,
      actualDataCount: expectedDataCount
    });
  }
  const sourceChanges = detail
    ? (2 * sourceScope.Q) + sourceScope.E
    : sourceScope.B + (2 * sourceScope.A) + sourceScope.S;
  const expectedTotalChanges = 2 + runScope.R + runScope.childTotal + sourceChanges + D + M;
  const operationType = DELETE_SUCCESS_OPERATION_TYPES.source;
  const symbols = Object.freeze({
    R: runScope.R,
    ...runScope.childCounts,
    ...(detail
      ? { Q: sourceScope.Q, E: sourceScope.E }
      : { B: sourceScope.B, A: sourceScope.A, S: sourceScope.S }),
    D,
    M
  });
  const auditEvidence = Object.freeze({
    evidenceVersion: 2,
    operation: operationType,
    targetMonth: evidence.targetMonth,
    targetType: sourceType,
    sourceLabel: SOURCE_LABELS[sourceType],
    reason: evidence.reason,
    datasetRevision: dataset ? Number(dataset.revision) : null,
    orphanDataset: D === 0,
    runIds: runScope.runIds,
    symbols,
    lockedPreviewTokenDigest: sha256(evidence.previewToken),
    expectedTotalChanges
  });
  const steps = [{
    stepId: 'delete.audit-success',
    expectedChanges: 1,
    bindings: auditStepBindings({
      evidence,
      operationType,
      auditEvidence,
      provenance,
      transactionTimestamp
    })
  }, ...runDeletionSteps(evidence.targetMonth, runScope)];
  if (detail) {
    steps.push(
      largeStep(
        'delete.detail-snapshot',
        sourceScope.Q,
        [evidence.targetMonth, sourceType],
        'detail-existing-effective'
      ),
      largeStep(
        'delete.detail-clear-fk',
        sourceScope.Q,
        [evidence.targetMonth, sourceType],
        'detail-existing-effective'
      ),
      largeStep(
        'delete.detail-effective',
        sourceScope.E,
        [evidence.targetMonth, sourceType],
        'detail-month-source'
      )
    );
  } else {
    steps.push(
      largeStep(
        'delete.system-backfill',
        sourceScope.B,
        [transactionTimestamp, evidence.targetMonth],
        'system-missing-accepted'
      ),
      largeStep(
        'delete.system-snapshot',
        sourceScope.A,
        [evidence.targetMonth],
        'system-existing-snapshot'
      ),
      largeStep(
        'delete.system-clear-fk',
        sourceScope.A,
        [evidence.targetMonth],
        'system-existing-snapshot'
      ),
      largeStep(
        'delete.system-snapshots',
        sourceScope.S,
        [evidence.targetMonth],
        'system-month'
      )
    );
  }
  steps.push({
    stepId: 'delete.dataset',
    expectedChanges: D,
    bindings: [evidence.targetMonth, sourceType]
  }, {
    stepId: 'delete.dataset-deletion',
    expectedChanges: 1,
    bindings: [
      evidence.targetMonth,
      sourceType,
      dataset ? Number(dataset.revision) : null,
      expectedDataCount,
      runScope.R,
      transactionTimestamp
    ]
  }, {
    stepId: 'delete.import-records',
    expectedChanges: M,
    bindings: [
      transactionTimestamp,
      deletionBoundary,
      evidence.targetMonth,
      sourceType,
      transactionTimestamp,
      evidence.targetMonth,
      sourceType
    ]
  });
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    targetMonth: evidence.targetMonth,
    runId: null,
    lockedEvidenceToken: evidence.previewToken,
    expectedTotalChanges,
    tableBudgets: {
      vcc_fin_op_operation_audit: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      ...runDeletionTableBudgets(runScope),
      ...(detail ? {
        vcc_fin_op_import_rows: { inserts: 0, updates: 2 * sourceScope.Q, deletes: 0, protection: 'planned-scope' },
        vcc_fin_op_effective_rows: { inserts: 0, updates: 0, deletes: sourceScope.E, protection: 'planned-scope' }
      } : {
        vcc_fin_op_system_snapshot_attempts: {
          inserts: sourceScope.B,
          updates: 2 * sourceScope.A,
          deletes: 0,
          protection: 'planned-scope'
        },
        vcc_fin_op_system_snapshots: { inserts: 0, updates: 0, deletes: sourceScope.S, protection: 'planned-scope' }
      }),
      vcc_fin_op_datasets: { inserts: 0, updates: 0, deletes: D, protection: 'planned-scope' },
      vcc_fin_op_dataset_deletions: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_import_records: { inserts: 0, updates: M, deletes: 0, protection: 'planned-scope' }
    },
    steps,
    expectedPostState: Object.freeze({
      ...baseDeletePostState(db, evidence, runScope, transactionTimestamp, provenance),
      operationType,
      auditEvidence,
      sourceType,
      sourceLabel: SOURCE_LABELS[sourceType],
      dataset,
      deletionBoundary,
      importRecordIds: Object.freeze(importRecordIds),
      sourceScope,
      deletedDataCount: expectedDataCount
    })
  });
}

function buildDeletePlan(db, evidence, transactionTimestamp, provenance) {
  return SOURCE_TARGET_TYPES.includes(evidence.targetType)
    ? buildSourceDeletePlan(db, evidence, transactionTimestamp, provenance)
    : buildResultOrOpeningDeletePlan(db, evidence, transactionTimestamp, provenance);
}

function assertSuccessAudit(db, plan, stepResults) {
  const post = plan.expectedPostState;
  const step = stepResults.find((entry) => entry.stepId === 'unarchive.audit-success');
  const auditId = step ? step.lastInsertRowid : null;
  const row = Number.isSafeInteger(auditId) ? db.prepare(`
    SELECT id, target_month, operation_type, run_id, status, preview_token,
           evidence_json, error_message, app_version, build_sha, created_at
    FROM vcc_fin_op_operation_audit WHERE id = ?
  `).get(auditId) : null;
  const boundaryCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_operation_audit WHERE id > ?
  `).get(post.auditBoundary).row_count);
  if (
    !row
    || auditId <= post.auditBoundary
    || boundaryCount !== 1
    || row.target_month !== plan.targetMonth
    || row.operation_type !== 'unarchive'
    || Number(row.run_id) !== plan.runId
    || row.status !== 'success'
    || row.preview_token !== plan.lockedEvidenceToken
    || row.evidence_json !== JSON.stringify(post.auditEvidence)
    || row.error_message !== null
    || row.app_version !== post.provenance.appVersion
    || row.build_sha !== post.provenance.buildSha
    || row.created_at !== post.transactionTimestamp
  ) {
    throw destructiveWriteError(
      'unarchive-invariant-failed',
      '解归档成功审计提交前精确断言失败，操作已回滚。',
      { auditId, boundaryCount }
    );
  }
  return auditId;
}

function assertUnarchivePostconditions(db, plan, stepResults) {
  const post = plan.expectedPostState;
  const actualRun = fullRow(db, 'vcc_fin_op_runs', 'id = ?', [plan.runId]);
  const expectedRun = {
    ...post.oldRun,
    status: 'calculated',
    updated_at: post.transactionTimestamp,
    archived_at: null
  };
  const actualDatasets = db.prepare(`
    SELECT * FROM vcc_fin_op_datasets
    WHERE target_month = ? ORDER BY dataset_type
  `).all(plan.targetMonth).map((row) => ({ ...row }));
  const expectedDatasets = post.oldDatasets.map((row) => ({
    ...row,
    data_status: 'unprocessed',
    archived_run_id: null,
    updated_at: post.transactionTimestamp
  }));
  const remainingArchives = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_archives WHERE target_month = ?
  `).get(plan.targetMonth).row_count);
  if (
    stableStringify(actualRun) !== stableStringify(expectedRun)
    || stableStringify(actualDatasets) !== stableStringify(expectedDatasets)
    || remainingArchives !== 0
  ) {
    throw destructiveWriteError(
      'unarchive-invariant-failed',
      '解归档提交前状态断言失败，操作已回滚。'
    );
  }
  const auditId = assertSuccessAudit(db, plan, stepResults);
  return Object.freeze({
    status: 'unarchived',
    targetMonth: plan.targetMonth,
    runId: plan.runId,
    subjects: post.subjects,
    resultRevision: Number(expectedRun.result_revision),
    archiveContract: post.auditEvidence.archiveContract,
    auditId
  });
}

function assertDeleteSuccessAudit(db, plan, stepResults) {
  const post = plan.expectedPostState;
  const step = stepResults.find((entry) => entry.stepId === 'delete.audit-success');
  const auditId = step ? step.lastInsertRowid : null;
  const row = Number.isSafeInteger(auditId) ? db.prepare(`
    SELECT id, target_month, operation_type, run_id, status, preview_token,
           evidence_json, error_message, app_version, build_sha, created_at
    FROM vcc_fin_op_operation_audit WHERE id = ?
  `).get(auditId) : null;
  const boundaryCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_operation_audit WHERE id > ?
  `).get(post.auditBoundary).row_count);
  if (
    !row
    || auditId <= post.auditBoundary
    || boundaryCount !== 1
    || row.target_month !== plan.targetMonth
    || row.operation_type !== post.operationType
    || row.run_id !== null
    || row.status !== 'success'
    || row.preview_token !== plan.lockedEvidenceToken
    || row.evidence_json !== JSON.stringify(post.auditEvidence)
    || row.error_message !== null
    || row.app_version !== post.provenance.appVersion
    || row.build_sha !== post.provenance.buildSha
    || row.created_at !== post.transactionTimestamp
  ) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '删除成功审计提交前精确断言失败，操作已回滚。',
      { auditId, boundaryCount }
    );
  }
  return auditId;
}

function assertRunDeletionPostconditions(db, plan) {
  const runIdsJson = JSON.stringify(plan.expectedPostState.runIds);
  const remainingRuns = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs
    WHERE target_month = ?
       OR id IN (SELECT value FROM json_each(?))
  `, [plan.targetMonth, runIdsJson]);
  let remainingChildren = 0;
  for (const scope of RUN_CHILD_SCOPES) {
    remainingChildren += countRows(db, `
      SELECT COUNT(*) AS row_count FROM ${scope.tableName}
      WHERE run_id IN (SELECT value FROM json_each(?))
    `, [runIdsJson]);
  }
  if (remainingRuns !== 0 || remainingChildren !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '目标月结果或五张子表未能完整删除，操作已回滚。',
      { remainingRuns, remainingChildren }
    );
  }
}

function assertResultOrOpeningDeletePostconditions(db, plan, stepResults) {
  const post = plan.expectedPostState;
  assertRunDeletionPostconditions(db, plan);
  if (post.targetType === DELETE_TARGET_TYPES.OPENING) {
    const remainingOpening = countRows(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_opening_balances
      WHERE target_month = ?
    `, [plan.targetMonth]);
    const moduleState = fullRow(db, 'vcc_fin_op_module_state', 'singleton_id = 1', []);
    if (
      remainingOpening !== 0
      || stableStringify(moduleState) !== stableStringify(post.moduleState)
      || !moduleState
      || moduleState.first_month !== plan.targetMonth
    ) {
      throw destructiveWriteError(
        'delete-invariant-failed',
        '删除后首月状态断言失败，操作已回滚。'
      );
    }
  }
  const auditId = assertDeleteSuccessAudit(db, plan, stepResults);
  if (post.targetType === DELETE_TARGET_TYPES.OPENING) {
    return Object.freeze({
      status: 'deleted',
      targetMonth: plan.targetMonth,
      targetType: post.targetType,
      targetLabel: DELETE_TARGET_LABELS[post.targetType],
      deletedOpeningCount: post.openingRows.length,
      deletedRunCount: post.runIds.length,
      firstMonth: post.moduleState.first_month,
      auditId
    });
  }
  return Object.freeze({
    status: 'deleted',
    targetMonth: plan.targetMonth,
    targetType: post.targetType,
    targetLabel: DELETE_TARGET_LABELS[post.targetType],
    deletedRunCount: post.runIds.length,
    deletedRunIds: post.runIds,
    auditId
  });
}

function assertDetailSnapshotMaterialized(db, plan) {
  const post = plan.expectedPostState;
  const mismatched = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_import_rows AS audit
    JOIN vcc_fin_op_effective_rows AS effective ON effective.id = audit.existing_effective_id
    WHERE effective.target_month = ? AND effective.source_type = ? AND (
      audit.existing_raw_json_snapshot IS NOT effective.raw_json
      OR audit.existing_raw_contract_version_snapshot IS NOT effective.raw_contract_version
      OR audit.existing_subject_snapshot IS NOT effective.subject
      OR audit.existing_source_file_snapshot IS NOT effective.source_file
      OR audit.existing_sheet_name_snapshot IS NOT effective.sheet_name
      OR audit.existing_source_row_snapshot IS NOT effective.source_row
      OR audit.existing_import_record_id_snapshot IS NOT effective.import_record_id
      OR audit.existing_imported_at_snapshot IS NOT effective.first_imported_at
    )
  `, [plan.targetMonth, post.sourceType]);
  if (mismatched !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '有效明细审计血缘物化不完整，删除已回滚。',
      { mismatched }
    );
  }
}

function assertDetailReferencesCleared(db, plan) {
  const post = plan.expectedPostState;
  const remaining = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_rows
    WHERE existing_effective_id IN (
      SELECT id FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    )
  `, [plan.targetMonth, post.sourceType]);
  if (remaining !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '有效明细审计外键未能完整解除，删除已回滚。',
      { remaining }
    );
  }
}

function assertSystemAcceptedAndBackfill(db, plan) {
  const post = plan.expectedPostState;
  const scope = post.sourceScope;
  const invalidSnapshots = countRows(db, `
    SELECT COUNT(*) AS row_count FROM (
      SELECT snapshot.id
      FROM vcc_fin_op_system_snapshots AS snapshot
      LEFT JOIN vcc_fin_op_system_snapshot_attempts AS attempt
        ON attempt.existing_snapshot_id = snapshot.id
       AND ${semanticAcceptedCondition()}
      WHERE snapshot.target_month = ?
      GROUP BY snapshot.id
      HAVING COUNT(attempt.id) <> 1
    )
  `, [plan.targetMonth]);
  const linkedCount = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts AS attempt
    JOIN vcc_fin_op_system_snapshots AS snapshot ON snapshot.id = attempt.existing_snapshot_id
    WHERE snapshot.target_month = ?
  `, [plan.targetMonth]);
  const newCount = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshot_attempts
    WHERE id > ?
  `, [scope.attemptBoundary]);
  const wrongTime = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshot_attempts
    WHERE id > ? AND created_at IS NOT ?
  `, [scope.attemptBoundary, post.transactionTimestamp]);
  if (
    invalidSnapshots !== 0
    || linkedCount !== scope.A
    || newCount !== scope.B
    || wrongTime !== 0
  ) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '系统财务OP accepted attempt 补录集合不精确，删除已回滚。',
      { invalidSnapshots, linkedCount, newCount, wrongTime }
    );
  }
}

function assertSystemSnapshotMaterialized(db, plan) {
  const mismatched = countRows(db, `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshot_attempts AS attempt
    JOIN vcc_fin_op_system_snapshots AS snapshot ON snapshot.id = attempt.existing_snapshot_id
    WHERE snapshot.target_month = ? AND (
      attempt.existing_balances_json_snapshot IS NOT snapshot.balances_json
      OR attempt.existing_raw_json_snapshot IS NOT snapshot.raw_json
      OR attempt.existing_source_file_snapshot IS NOT snapshot.source_file
      OR attempt.existing_sheet_name_snapshot IS NOT snapshot.sheet_name
      OR attempt.existing_source_row_snapshot IS NOT snapshot.source_row
      OR attempt.existing_import_record_id_snapshot IS NOT snapshot.import_record_id
      OR attempt.existing_imported_at_snapshot IS NOT snapshot.imported_at
    )
  `, [plan.targetMonth]);
  if (mismatched !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '系统财务OP审计血缘物化不完整，删除已回滚。',
      { mismatched }
    );
  }
}

function assertSystemReferencesCleared(db, plan) {
  const remaining = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshot_attempts
    WHERE existing_snapshot_id IN (
      SELECT id FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    )
  `, [plan.targetMonth]);
  if (remaining !== 0) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '系统财务OP审计外键未能完整解除，删除已回滚。',
      { remaining }
    );
  }
}

function runInterStepPostcondition(db, plan, stepId) {
  if (stepId === 'delete.detail-snapshot') assertDetailSnapshotMaterialized(db, plan);
  else if (stepId === 'delete.detail-clear-fk') assertDetailReferencesCleared(db, plan);
  else if (stepId === 'delete.system-backfill') assertSystemAcceptedAndBackfill(db, plan);
  else if (stepId === 'delete.system-snapshot') assertSystemSnapshotMaterialized(db, plan);
  else if (stepId === 'delete.system-clear-fk') assertSystemReferencesCleared(db, plan);
}

function assertSourceDeletePostconditions(db, plan, stepResults) {
  const post = plan.expectedPostState;
  assertRunDeletionPostconditions(db, plan);
  const remainingData = DETAIL_SOURCE_TYPES.has(post.sourceType)
    ? countRows(db, `
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      `, [plan.targetMonth, post.sourceType])
    : countRows(db, `
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshots
        WHERE target_month = ?
      `, [plan.targetMonth]);
  const remainingDataset = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_datasets
    WHERE target_month = ? AND dataset_type = ?
  `, [plan.targetMonth, post.sourceType]);
  const deletionStep = stepResults.find((entry) => entry.stepId === 'delete.dataset-deletion');
  const deletionId = deletionStep ? deletionStep.lastInsertRowid : null;
  const deletion = Number.isSafeInteger(deletionId) ? db.prepare(`
    SELECT id, target_month, source_type, dataset_revision,
           deleted_data_count, invalidated_run_count, deleted_at
    FROM vcc_fin_op_dataset_deletions WHERE id = ?
  `).get(deletionId) : null;
  const newDeletionCount = countRows(db, `
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_dataset_deletions WHERE id > ?
  `, [post.deletionBoundary]);
  const linkedRecords = db.prepare(`
    SELECT id, dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY id
  `).all(JSON.stringify(post.importRecordIds));
  const recordsValid = linkedRecords.length === post.importRecordIds.length
    && linkedRecords.every((row, index) => (
      Number(row.id) === post.importRecordIds[index]
      && row.dataset_deleted_at === post.transactionTimestamp
      && Number(row.dataset_deletion_id) === deletionId
    ));
  const expectedRevision = post.dataset ? Number(post.dataset.revision) : null;
  if (
    remainingData !== 0
    || remainingDataset !== 0
    || !deletion
    || deletionId <= post.deletionBoundary
    || newDeletionCount !== 1
    || deletion.target_month !== plan.targetMonth
    || deletion.source_type !== post.sourceType
    || (deletion.dataset_revision === null ? null : Number(deletion.dataset_revision)) !== expectedRevision
    || Number(deletion.deleted_data_count) !== post.deletedDataCount
    || Number(deletion.invalidated_run_count) !== post.runIds.length
    || deletion.deleted_at !== post.transactionTimestamp
    || !recordsValid
  ) {
    throw destructiveWriteError(
      'delete-invariant-failed',
      '原表删除提交前状态断言失败，操作已回滚。',
      { remainingData, remainingDataset, deletionId, newDeletionCount, recordsValid }
    );
  }
  if (!DETAIL_SOURCE_TYPES.has(post.sourceType)) {
    const scope = post.sourceScope;
    const newAttempts = db.prepare(`
      SELECT id, existing_snapshot_id, created_at
      FROM vcc_fin_op_system_snapshot_attempts WHERE id > ? ORDER BY id
    `).all(scope.attemptBoundary);
    if (
      newAttempts.length !== scope.B
      || newAttempts.some((row) => (
        row.existing_snapshot_id !== null || row.created_at !== post.transactionTimestamp
      ))
    ) {
      throw destructiveWriteError(
        'delete-invariant-failed',
        '系统财务OP补录审计在删除后发生漂移，操作已回滚。'
      );
    }
  }
  const auditId = assertDeleteSuccessAudit(db, plan, stepResults);
  return Object.freeze({
    status: 'deleted',
    targetMonth: plan.targetMonth,
    targetType: post.sourceType,
    sourceType: post.sourceType,
    sourceLabel: post.sourceLabel,
    deletedDataCount: post.deletedDataCount,
    invalidatedRunCount: post.runIds.length,
    deletionId,
    deletedImportRecordCount: post.importRecordIds.length,
    auditId
  });
}

function assertDeletePostconditions(db, plan, stepResults) {
  return SOURCE_TARGET_TYPES.includes(plan.expectedPostState.targetType)
    ? assertSourceDeletePostconditions(db, plan, stepResults)
    : assertResultOrOpeningDeletePostconditions(db, plan, stepResults);
}

function buildFailureAuditPlan({ action, evidence, normalizedPayload, provenance, error }) {
  const contract = evidence && evidence.archiveContract;
  const deleteTargetType = evidence && evidence.targetType;
  const operationType = action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH
    ? DESTRUCTIVE_OPERATION_TYPES[action]
    : (deleteTargetType ? deleteOperationType(deleteTargetType) : DESTRUCTIVE_OPERATION_TYPES[action]);
  return Object.freeze({
    operationType,
    targetMonth: normalizedPayload.targetMonth,
    runId: contract && Number.isSafeInteger(Number(contract.runId)) ? Number(contract.runId) : null,
    previewToken: normalizedPayload.expectedPreviewToken,
    appVersion: provenance.appVersion,
    buildSha: provenance.buildSha,
    evidence: Object.freeze({
      evidenceVersion: 2,
      operation: operationType,
      targetMonth: normalizedPayload.targetMonth,
      archiveContract: contract ? contract.contract : null,
      targetType: deleteTargetType || null,
      lockedPreviewTokenDigest: sha256(normalizedPayload.expectedPreviewToken),
      failure: redactedFailure(error)
    })
  });
}

function emitProgress(onProgress, action, targetMonth, phase, cancellable) {
  if (typeof onProgress !== 'function') return;
  onProgress(Object.freeze({
    action: action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH ? 'unarchive' : 'delete',
    targetMonth: targetMonth || '',
    runId: null,
    phase,
    cancellable
  }));
}

function executeLockedDestructiveMutation({
  db,
  action,
  payload,
  taskGeneration,
  appVersion = null,
  buildSha = null,
  onProgress = null,
  hooks = {}
}) {
  const normalizedPayload = normalizeDestructivePayload(action, payload);
  const provenance = Object.freeze({ appVersion, buildSha });
  let environmentTrusted = false;
  let transactionStarted = false;
  let evidence = null;
  let guard = null;
  let rollbackSucceeded = true;
  let closeFailures = [];
  emitProgress(onProgress, action, normalizedPayload.targetMonth, 'validating', false);
  try {
    assertMutationRuntimeAvailable();
    assertVccMutationSchema(db);
    assertVccTriggerPolicy(db);
    environmentTrusted = true;
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    evidence = action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH
      ? loadLockedUnarchiveEvidence(db, normalizedPayload, taskGeneration)
      : loadLockedDeleteEvidence(db, normalizedPayload, taskGeneration);
    assertLockedEvidenceAllowed(action, evidence, normalizedPayload);
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const plan = action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH
      ? buildUnarchivePlan(db, evidence, transactionTimestamp, provenance)
      : buildDeletePlan(db, evidence, transactionTimestamp, provenance);
    guard = beginMutationGuard(db, plan, hooks.guardOptions || {});
    emitProgress(onProgress, action, normalizedPayload.targetMonth, 'applying', false);
    const stepResults = executeRegisteredMutationSteps(db, guard, {
      ...hooks,
      afterStep(args) {
        runInterStepPostcondition(db, plan, args.plannedStep.stepId);
        if (typeof hooks.afterStep === 'function') hooks.afterStep(args);
      }
    });
    assertMutationGuardPostwrite(db, guard);
    emitProgress(onProgress, action, normalizedPayload.targetMonth, 'verifying', false);
    const result = action === VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH
      ? assertUnarchivePostconditions(db, plan, stepResults)
      : assertDeletePostconditions(db, plan, stepResults);
    closeFailures = closeMutationGuard(guard);
    if (closeFailures.length > 0) {
      throw destructiveWriteError(
        'mutation-guard-unavailable',
        'Mutation guard session 关闭失败，已禁止提交。',
        { closeFailures }
      );
    }
    emitProgress(onProgress, action, normalizedPayload.targetMonth, 'preserving-audit', false);
    db.exec('COMMIT');
    transactionStarted = false;
    emitProgress(onProgress, action, normalizedPayload.targetMonth, 'committed', false);
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec('ROLLBACK');
        transactionStarted = false;
      } catch (rollbackError) {
        rollbackSucceeded = false;
        error.rollbackFailure = {
          code: rollbackError && rollbackError.code ? String(rollbackError.code) : null,
          message: rollbackError && rollbackError.message
            ? rollbackError.message
            : String(rollbackError)
        };
      }
    }
    if (guard) closeFailures = closeMutationGuard(guard);
    if (
      environmentTrusted
      && rollbackSucceeded
      && closeFailures.length === 0
      && evidence
      && error.suppressRollbackAudit !== true
      && !isUnsafeAuditError(error)
    ) {
      error.failureAuditPlan = buildFailureAuditPlan({
        action,
        evidence,
        normalizedPayload,
        provenance,
        error
      });
    }
    throw error;
  }
}

function executeDestructiveMutationWithSafeAudit({
  dbPath,
  action,
  payload,
  taskGeneration,
  appVersion = null,
  buildSha = null,
  onProgress = null,
  onDiagnostic = null,
  Database = DatabaseSync,
  hooks = {}
}) {
  const db = openVccWriteDatabase(dbPath, Database);
  let result;
  let primaryError = null;
  try {
    result = executeLockedDestructiveMutation({
      db,
      action,
      payload,
      taskGeneration,
      appVersion,
      buildSha,
      onProgress,
      hooks: hooks.business || {}
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    db.close();
  } catch (closeError) {
    if (!primaryError) throw closeError;
    primaryError.failureAuditPlan = null;
    primaryError.connectionCloseFailure = {
      code: closeError && closeError.code ? String(closeError.code) : null,
      message: closeError && closeError.message ? closeError.message : String(closeError)
    };
  }
  if (!primaryError) return result;
  if (primaryError.failureAuditPlan) {
    try {
      emitProgress(
        onProgress,
        action,
        primaryError.failureAuditPlan.targetMonth,
        'preserving-audit',
        false
      );
      persistRolledBackAuditSafely({
        dbPath,
        failurePlan: primaryError.failureAuditPlan,
        Database,
        hooks: hooks.audit || {}
      });
    } catch (auditError) {
      primaryError.auditFailure = {
        name: auditError && auditError.name ? auditError.name : 'Error',
        code: auditError && auditError.code ? auditError.code : null,
        message: auditError && auditError.message ? auditError.message : String(auditError)
      };
      if (typeof onDiagnostic === 'function') {
        onDiagnostic(Object.freeze({
          event: 'vcc-destructive-write-rollback-audit-failed',
          action,
          targetMonth: payload && payload.targetMonth,
          primaryCode: primaryError.code || null,
          auditCode: auditError && auditError.code ? auditError.code : null
        }));
      }
    }
  } else if (typeof onDiagnostic === 'function') {
    onDiagnostic(Object.freeze({
      event: 'vcc-destructive-write-failure-not-audited',
      action,
      targetMonth: payload && payload.targetMonth,
      primaryCode: primaryError.code || null
    }));
  }
  throw primaryError;
}

module.exports = {
  DESTRUCTIVE_OPERATION_TYPES,
  destructiveWriteError,
  normalizeDestructivePayload,
  loadLockedUnarchiveEvidence,
  loadLockedDeleteEvidence,
  buildUnarchivePlan,
  buildDeletePlan,
  assertUnarchivePostconditions,
  assertDeletePostconditions,
  executeLockedDestructiveMutation,
  executeDestructiveMutationWithSafeAudit
};
