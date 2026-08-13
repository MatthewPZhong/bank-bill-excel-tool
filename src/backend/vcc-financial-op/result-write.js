'use strict';

const { DatabaseSync } = require('node:sqlite');
const {
  SUPPORTED_CURRENCIES
} = require('./definitions');
const {
  CURRENT_DATASET_TYPES,
  LEGACY_DATASET_TYPES
} = require('./archive-contract');
const { isValidInputFingerprint } = require('./calculator');
const {
  normalizeAdjustmentAmount,
  normalizeAdjustmentReason,
  assertExpectedResultRevision
} = require('./result-adjustments');
const {
  STATE_CHANGED_CODE,
  STATE_CHANGED_MESSAGE,
  readDatabaseLocalTimestamp,
  sha256,
  stableStringify
} = require('./operation-state');
const {
  validatedResultDigest
} = require('./operation-token-v2');
const {
  loadResultMutationEvidence
} = require('./read-snapshot');
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

const RESULT_OPERATION_TYPES = Object.freeze({
  [VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT]: 'add_adjustment',
  [VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT]: 'archive_result'
});

function resultWriteError(code, message, context = {}) {
  const error = new Error(message);
  error.code = code;
  error.context = context;
  return error;
}

function normalizeRunId(runId) {
  const normalized = Number(runId);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw resultWriteError('invalid-run-id', `财务OP run id 无效：${runId}`);
  }
  return normalized;
}

function normalizeOperationPayload(action, payload = {}) {
  const runId = normalizeRunId(payload.runId);
  const expectedResultRevision = assertExpectedResultRevision(
    payload.expectedResultRevision,
    Number(payload.expectedResultRevision),
    { runId }
  );
  const expectedPreviewToken = String(payload.expectedPreviewToken || '');
  if (!/^v2:[a-f0-9]{64}$/.test(expectedPreviewToken)) {
    throw resultWriteError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
      expectedPreviewToken: payload.expectedPreviewToken || null
    });
  }
  if (action === VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT) {
    return Object.freeze({ runId, expectedResultRevision, expectedPreviewToken });
  }
  if (action !== VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT) {
    throw resultWriteError('invalid-vcc-write-action', `未知 VCC 结果写入 action：${action || ''}`);
  }
  const rowKey = String(payload.rowKey == null ? '' : payload.rowKey).trim();
  if (!/^v1:[a-f0-9]{64}$/.test(rowKey)) {
    throw resultWriteError('invalid-adjustment-target', '调整目标 rowKey 无效。', { rowKey });
  }
  const currency = String(payload.currency == null ? '' : payload.currency).trim();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw resultWriteError('invalid-adjustment-currency', `不支持调整币种：${currency}`, { currency });
  }
  return Object.freeze({
    runId,
    expectedResultRevision,
    expectedPreviewToken,
    rowKey,
    currency,
    adjustmentAmount: normalizeAdjustmentAmount(payload.adjustmentAmount),
    reason: normalizeAdjustmentReason(payload.reason)
  });
}

function sameTextSet(actual, expected) {
  const normalized = [...actual].map(String).sort();
  return normalized.length === expected.length
    && normalized.every((value, index) => value === expected[index]);
}

function revisionsMatch(run, datasets) {
  const revisions = run.inputRevisions;
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) return false;
  if (!sameTextSet(Object.keys(revisions), datasets.map((dataset) => dataset.datasetType))) {
    return false;
  }
  return datasets.every((dataset) => (
    Number.isSafeInteger(revisions[dataset.datasetType])
    && revisions[dataset.datasetType] === Number(dataset.revision)
  ));
}

function findLockedRun(evidence, runId) {
  return evidence.archiveEvidence.runs.find((run) => Number(run.id) === Number(runId)) || null;
}

function findLockedValidation(evidence, runId) {
  return evidence.archiveEvidence.resultValidations
    .find((validation) => Number(validation.runId) === Number(runId)) || null;
}

function commonCalculatedEvidenceValid(evidence, run, validation, datasetTypes) {
  const archiveEvidence = evidence.archiveEvidence;
  return archiveEvidence.runs.length === 1
    && run
    && run.status === 'calculated'
    && run.archivedAt === null
    && validation
    && validation.violations.length === 0
    && archiveEvidence.archives.length === 0
    && sameTextSet(archiveEvidence.datasets.map((dataset) => dataset.datasetType), datasetTypes)
    && archiveEvidence.datasets.every((dataset) => (
      dataset.dataStatus === 'unprocessed' && dataset.archivedRunId === null
    ))
    && revisionsMatch(run, archiveEvidence.datasets);
}

function isLegacyCalculatedEvidence(evidence, run, validation) {
  const archiveEvidence = evidence.archiveEvidence;
  return commonCalculatedEvidenceValid(evidence, run, validation, LEGACY_DATASET_TYPES)
    && run.inputFingerprint === null
    && Number(run.resultRevision) === 0
    && validation.adjustmentCount === 0
    && validation.adjustmentSequenceMax === 0
    && archiveEvidence.runAdjustments.length === 0
    && archiveEvidence.pendingEffectiveFactCount === 0
    && archiveEvidence.pendingRunRowCount === 0
    && archiveEvidence.pendingSummaryCount === 0
    && archiveEvidence.pendingCurrencyTotalCount === 0;
}

function assertCurrentCalculatedEvidence(evidence, normalizedPayload, action) {
  const run = findLockedRun(evidence, normalizedPayload.runId);
  const validation = findLockedValidation(evidence, normalizedPayload.runId);
  if (isLegacyCalculatedEvidence(evidence, run, validation)) {
    const error = resultWriteError(
      'result-recalculation-required',
      '该结果来自旧版四数据集归档，请真实导入 Pending 原表并重新运行后再修改或归档。',
      { runId: normalizedPayload.runId, targetMonth: evidence.targetMonth }
    );
    error.suppressRollbackAudit = true;
    throw error;
  }
  if (!commonCalculatedEvidenceValid(evidence, run, validation, CURRENT_DATASET_TYPES)) {
    throw resultWriteError(
      'result-evidence-invalid',
      '财务OP结果、五类数据集或生效余额证据不完整，已禁止修改或归档。',
      { runId: normalizedPayload.runId, targetMonth: evidence.targetMonth }
    );
  }
  if (!isValidInputFingerprint(run.inputFingerprint)) {
    throw resultWriteError(
      'result-input-fingerprint-missing',
      '该结果缺少有效输入指纹，请重新运行后再操作。',
      { runId: normalizedPayload.runId }
    );
  }
  if (Number(run.resultRevision) !== normalizedPayload.expectedResultRevision) {
    throw resultWriteError('result-revision-changed', '结果已发生变化，请重新核对后归档。', {
      expectedResultRevision: normalizedPayload.expectedResultRevision,
      actualResultRevision: Number(run.resultRevision)
    });
  }
  if (action === VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT) {
    const gate = evidence.gateEvidence;
    if (gate.activeBatchIds.length > 0 || gate.importingRecordIds.length > 0) {
      throw resultWriteError('active-imports', '当前账期仍有原表正在导入，禁止归档。');
    }
    if (gate.unresolvedRecords.length > 0) {
      throw resultWriteError('unresolved-imports', '仍有未处理的失败导入记录，禁止归档。');
    }
    if (gate.nextOpeningSubjects.length > 0) {
      throw resultWriteError(
        'next-opening-already-initialized',
        '下月已人工初始化期初余额，禁止归档当前月份。',
        { subjects: gate.nextOpeningSubjects }
      );
    }
  }
  return Object.freeze({ run, validation });
}

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({
      ...step,
      bindings: Object.freeze([...step.bindings])
    }))),
    tableBudgets: Object.freeze(Object.fromEntries(Object.entries(plan.tableBudgets)
      .map(([tableName, budget]) => [tableName, Object.freeze({ ...budget })])))
  });
}

function fullRunRow(db, runId) {
  const row = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(runId);
  return row ? { ...row } : null;
}

function buildAdjustmentPlan(db, evidence, normalizedPayload, locked, transactionTimestamp, provenance) {
  const target = evidence.archiveEvidence.runRows.find((row) => (
    Number(row.runId) === normalizedPayload.runId && row.rowKey === normalizedPayload.rowKey
  ));
  if (!target) {
    throw resultWriteError(
      'invalid-adjustment-target',
      '调整目标已变化，请刷新结果表后重试。',
      { runId: normalizedPayload.runId, rowKey: normalizedPayload.rowKey }
    );
  }
  const duplicate = evidence.archiveEvidence.runAdjustments.find((adjustment) => (
    Number(adjustment.runId) === normalizedPayload.runId
    && adjustment.rowKey === normalizedPayload.rowKey
    && adjustment.currency === normalizedPayload.currency
  ));
  if (duplicate) {
    throw resultWriteError(
      'adjustment-already-exists',
      '该结果坐标已经修改过，不能再次调整。',
      { adjustmentId: duplicate.id }
    );
  }
  const boundaryRow = db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_run_adjustments
  `).get();
  const oldRun = fullRunRow(db, normalizedPayload.runId);
  if (!oldRun) throw resultWriteError('result-not-found', '财务OP计算记录不存在。');
  const expectedAdjustment = Object.freeze({
    run_id: normalizedPayload.runId,
    row_key: normalizedPayload.rowKey,
    subject: target.subject,
    source_type: target.sourceType,
    category_major: target.categoryMajor,
    category_minor: target.categoryMinor,
    currency: normalizedPayload.currency,
    adjustment_amount: normalizedPayload.adjustmentAmount,
    reason: normalizedPayload.reason,
    sequence: Number(locked.run.resultRevision) + 1,
    created_at: transactionTimestamp,
    created_app_version: provenance.appVersion,
    created_build_sha: provenance.buildSha
  });
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    targetMonth: evidence.targetMonth,
    runId: normalizedPayload.runId,
    lockedEvidenceToken: normalizedPayload.expectedPreviewToken,
    expectedTotalChanges: 2,
    tableBudgets: {
      vcc_fin_op_run_adjustments: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_runs: { inserts: 0, updates: 1, deletes: 0, protection: 'planned-scope' }
    },
    steps: [{
      stepId: 'adjustment.insert',
      expectedChanges: 1,
      bindings: [
        expectedAdjustment.run_id,
        expectedAdjustment.row_key,
        expectedAdjustment.subject,
        expectedAdjustment.source_type,
        expectedAdjustment.category_major,
        expectedAdjustment.category_minor,
        expectedAdjustment.currency,
        expectedAdjustment.adjustment_amount,
        expectedAdjustment.reason,
        expectedAdjustment.sequence,
        expectedAdjustment.created_at,
        expectedAdjustment.created_app_version,
        expectedAdjustment.created_build_sha
      ]
    }, {
      stepId: 'adjustment.bump-run',
      expectedChanges: 1,
      bindings: [
        transactionTimestamp,
        normalizedPayload.runId,
        normalizedPayload.expectedResultRevision
      ]
    }],
    expectedPostState: Object.freeze({
      adjustmentBoundaryId: Number(boundaryRow.max_id),
      expectedAdjustment,
      oldRun,
      transactionTimestamp
    })
  });
}

function balancesBySubject(validation) {
  const grouped = new Map();
  for (const balance of validation.effectiveBalances) {
    if (!grouped.has(balance.subject)) grouped.set(balance.subject, new Map());
    grouped.get(balance.subject).set(balance.currency, balance.effectiveCalculatedBalance);
  }
  const result = [];
  for (const subject of [...grouped.keys()].sort()) {
    const amounts = grouped.get(subject);
    if (
      amounts.size !== SUPPORTED_CURRENCIES.length
      || SUPPORTED_CURRENCIES.some((currency) => !amounts.has(currency))
    ) {
      throw resultWriteError(
        'result-evidence-invalid',
        `${subject} 的生效计算余额未精确覆盖九币种。`,
        { subject }
      );
    }
    result.push(Object.freeze({
      subject,
      balances: Object.freeze(Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
        currency,
        amounts.get(currency)
      ])))
    }));
  }
  if (result.length === 0) throw resultWriteError('result-evidence-invalid', '计算记录没有可归档的主体余额。');
  return Object.freeze(result);
}

function buildArchivePlan(db, evidence, normalizedPayload, locked, transactionTimestamp, provenance) {
  const subjects = balancesBySubject(locked.validation);
  const oldRun = fullRunRow(db, normalizedPayload.runId);
  const oldDatasets = db.prepare(`
    SELECT * FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(evidence.targetMonth).map((row) => ({ ...row }));
  const auditBoundary = Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_operation_audit
  `).get().max_id);
  const digests = validatedResultDigest(locked.validation);
  const auditEvidence = Object.freeze({
    evidenceVersion: 2,
    operation: 'archive_result',
    targetMonth: evidence.targetMonth,
    runId: normalizedPayload.runId,
    resultRevision: Number(locked.run.resultRevision),
    inputFingerprint: locked.run.inputFingerprint,
    datasetRevisions: Object.freeze(Object.fromEntries(evidence.archiveEvidence.datasets.map((dataset) => [
      dataset.datasetType,
      Number(dataset.revision)
    ]))),
    subjects: Object.freeze(subjects.map((entry) => entry.subject)),
    resultEvidenceDigest: digests.resultEvidenceDigest,
    effectiveBalanceHash: digests.effectiveBalanceHash,
    expectedTotalChanges: subjects.length + 7
  });
  const steps = [{
    stepId: 'archive.audit-success',
    expectedChanges: 1,
    bindings: [
      evidence.targetMonth,
      'archive_result',
      normalizedPayload.runId,
      JSON.stringify(auditEvidence),
      provenance.appVersion,
      provenance.buildSha,
      transactionTimestamp
    ]
  }];
  for (const entry of subjects) {
    steps.push({
      stepId: 'archive.insert-subjects',
      expectedChanges: 1,
      bindings: [
        evidence.targetMonth,
        entry.subject,
        JSON.stringify(entry.balances),
        normalizedPayload.runId,
        transactionTimestamp
      ]
    });
  }
  steps.push({
    stepId: 'archive.mark-run',
    expectedChanges: 1,
    bindings: [
      transactionTimestamp,
      transactionTimestamp,
      normalizedPayload.runId,
      normalizedPayload.expectedResultRevision
    ]
  }, {
    stepId: 'archive.mark-datasets',
    expectedChanges: CURRENT_DATASET_TYPES.length,
    bindings: [
      normalizedPayload.runId,
      transactionTimestamp,
      evidence.targetMonth,
      ...CURRENT_DATASET_TYPES
    ]
  });
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    targetMonth: evidence.targetMonth,
    runId: normalizedPayload.runId,
    lockedEvidenceToken: normalizedPayload.expectedPreviewToken,
    expectedTotalChanges: subjects.length + 7,
    tableBudgets: {
      vcc_fin_op_operation_audit: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_archives: { inserts: subjects.length, updates: 0, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_runs: { inserts: 0, updates: 1, deletes: 0, protection: 'planned-scope' },
      vcc_fin_op_datasets: { inserts: 0, updates: 5, deletes: 0, protection: 'planned-scope' }
    },
    steps,
    expectedPostState: Object.freeze({
      auditBoundary,
      auditEvidence,
      oldRun,
      oldDatasets: Object.freeze(oldDatasets),
      subjects,
      transactionTimestamp
    })
  });
}

function buildResultMutationPlan(db, action, evidence, normalizedPayload, locked, transactionTimestamp, provenance) {
  if (action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT) {
    return buildAdjustmentPlan(
      db,
      evidence,
      normalizedPayload,
      locked,
      transactionTimestamp,
      provenance
    );
  }
  return buildArchivePlan(
    db,
    evidence,
    normalizedPayload,
    locked,
    transactionTimestamp,
    provenance
  );
}

function assertAdjustmentPostconditions(db, plan, stepResults) {
  const insertedStep = stepResults.find((step) => step.stepId === 'adjustment.insert');
  const adjustmentId = insertedStep ? insertedStep.lastInsertRowid : null;
  const post = plan.expectedPostState;
  const adjustment = Number.isSafeInteger(adjustmentId) ? db.prepare(`
    SELECT run_id, row_key, subject, source_type, category_major, category_minor,
           currency, adjustment_amount, reason, sequence, created_at,
           created_app_version, created_build_sha
    FROM vcc_fin_op_run_adjustments WHERE id = ?
  `).get(adjustmentId) : null;
  const boundaryCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_adjustments WHERE id > ?
  `).get(post.adjustmentBoundaryId).row_count);
  const actualRun = fullRunRow(db, plan.runId);
  const expectedRun = {
    ...post.oldRun,
    result_revision: Number(post.oldRun.result_revision) + 1,
    updated_at: post.transactionTimestamp
  };
  if (
    !adjustment
    || adjustmentId <= post.adjustmentBoundaryId
    || boundaryCount !== 1
    || stableStringify(adjustment) !== stableStringify(post.expectedAdjustment)
    || stableStringify(actualRun) !== stableStringify(expectedRun)
  ) {
    throw resultWriteError(
      'adjustment-write-invariant-failed',
      '调整结果提交前精确写入断言失败，操作已回滚。',
      { adjustmentId, boundaryCount }
    );
  }
  return Object.freeze({
    status: 'adjusted',
    runId: plan.runId,
    targetMonth: plan.targetMonth,
    resultRevision: Number(expectedRun.result_revision),
    adjustment: Object.freeze({
      id: adjustmentId,
      runId: adjustment.run_id,
      rowKey: adjustment.row_key,
      subject: adjustment.subject,
      sourceType: adjustment.source_type,
      categoryMajor: adjustment.category_major,
      categoryMinor: adjustment.category_minor,
      currency: adjustment.currency,
      adjustmentAmount: adjustment.adjustment_amount,
      reason: adjustment.reason,
      sequence: adjustment.sequence,
      createdAt: adjustment.created_at,
      createdAppVersion: adjustment.created_app_version,
      createdBuildSha: adjustment.created_build_sha
    })
  });
}

function assertArchivePostconditions(db, plan, stepResults) {
  const post = plan.expectedPostState;
  const actualRun = fullRunRow(db, plan.runId);
  const expectedRun = {
    ...post.oldRun,
    status: 'archived',
    archived_at: post.transactionTimestamp,
    updated_at: post.transactionTimestamp
  };
  const actualDatasets = db.prepare(`
    SELECT * FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(plan.targetMonth).map((row) => ({ ...row }));
  const expectedDatasets = post.oldDatasets.map((row) => ({
    ...row,
    data_status: 'archived',
    archived_run_id: plan.runId,
    updated_at: post.transactionTimestamp
  }));
  const actualArchives = db.prepare(`
    SELECT target_month, subject, balances_json, run_id, archived_at
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    ORDER BY subject
  `).all(plan.targetMonth).map((row) => ({ ...row }));
  const expectedArchives = post.subjects.map((entry) => ({
    target_month: plan.targetMonth,
    subject: entry.subject,
    balances_json: JSON.stringify(entry.balances),
    run_id: plan.runId,
    archived_at: post.transactionTimestamp
  }));
  const auditStep = stepResults.find((step) => step.stepId === 'archive.audit-success');
  const auditId = auditStep ? auditStep.lastInsertRowid : null;
  const audit = Number.isSafeInteger(auditId) ? db.prepare(`
    SELECT id, target_month, operation_type, run_id, status, preview_token,
           evidence_json, error_message, app_version, build_sha, created_at
    FROM vcc_fin_op_operation_audit WHERE id = ?
  `).get(auditId) : null;
  const auditBoundaryCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_operation_audit WHERE id > ?
  `).get(post.auditBoundary).row_count);
  const validAudit = audit
    && auditId > post.auditBoundary
    && auditBoundaryCount === 1
    && audit.target_month === plan.targetMonth
    && audit.operation_type === 'archive_result'
    && Number(audit.run_id) === plan.runId
    && audit.status === 'success'
    && audit.preview_token === null
    && audit.evidence_json === JSON.stringify(post.auditEvidence)
    && audit.error_message === null
    && audit.created_at === post.transactionTimestamp;
  if (
    stableStringify(actualRun) !== stableStringify(expectedRun)
    || stableStringify(actualDatasets) !== stableStringify(expectedDatasets)
    || stableStringify(actualArchives) !== stableStringify(expectedArchives)
    || !validAudit
  ) {
    throw resultWriteError(
      'archive-write-invariant-failed',
      '归档提交前精确写入断言失败，操作已回滚。',
      { auditId, auditBoundaryCount }
    );
  }
  return Object.freeze({
    status: 'archived',
    runId: plan.runId,
    targetMonth: plan.targetMonth,
    resultRevision: Number(expectedRun.result_revision),
    subjects: Object.freeze(post.subjects.map((entry) => entry.subject)),
    auditId
  });
}

function assertResultMutationPostconditions(db, plan, stepResults) {
  return plan.operation === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT
    ? assertAdjustmentPostconditions(db, plan, stepResults)
    : assertArchivePostconditions(db, plan, stepResults);
}

function isUnsafeAuditError(error) {
  if (!error) return true;
  const unsafeSqlitePrimaryCodes = new Set([10, 11, 13, 14, 26]);
  let current = error;
  const visited = new Set();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if ([
      'mutation-guard-unavailable',
      'vcc-trigger-policy-violation',
      'vcc-schema-not-ready'
    ].includes(current.code)) return true;
    if (/^(SQLITE_(?:CORRUPT|IOERR|NOTADB|FULL|CANTOPEN))/.test(String(current.code || ''))) {
      return true;
    }
    const nativeErrcode = Number(current.errcode);
    if (
      Number.isSafeInteger(nativeErrcode)
      && nativeErrcode >= 0
      && unsafeSqlitePrimaryCodes.has(nativeErrcode & 0xff)
    ) return true;
    current = current.cause;
  }
  return false;
}

function rollbackAuditPreviewToken(action, normalizedPayload) {
  return action === VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
    ? null
    : normalizedPayload.expectedPreviewToken;
}

function redactedFailure(error) {
  const code = error && error.code ? String(error.code) : 'unknown';
  return Object.freeze({
    name: error && error.name ? String(error.name) : 'Error',
    code,
    message: `VCC 操作失败（${code}），业务事务已回滚。`
  });
}

function buildFailureAuditPlan({ action, evidence, normalizedPayload, provenance, error }) {
  return Object.freeze({
    operationType: RESULT_OPERATION_TYPES[action],
    targetMonth: evidence.targetMonth,
    runId: normalizedPayload.runId,
    previewToken: rollbackAuditPreviewToken(action, normalizedPayload),
    appVersion: provenance.appVersion,
    buildSha: provenance.buildSha,
    evidence: Object.freeze({
      evidenceVersion: 2,
      operation: RESULT_OPERATION_TYPES[action],
      targetMonth: evidence.targetMonth,
      runId: normalizedPayload.runId,
      expectedResultRevision: normalizedPayload.expectedResultRevision,
      lockedEvidenceTokenDigest: sha256(normalizedPayload.expectedPreviewToken),
      failure: redactedFailure(error)
    })
  });
}

function emitProgress(onProgress, action, targetMonth, runId, phase, cancellable) {
  if (typeof onProgress !== 'function') return;
  onProgress(Object.freeze({
    action: action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT ? 'adjustment' : 'archive',
    targetMonth: targetMonth || '',
    runId: Number.isSafeInteger(Number(runId)) ? Number(runId) : null,
    phase,
    cancellable
  }));
}

function executeLockedResultMutation({
  db,
  action,
  payload,
  taskGeneration,
  appVersion = null,
  buildSha = null,
  onProgress = null,
  hooks = {}
}) {
  const normalizedPayload = normalizeOperationPayload(action, payload);
  const provenance = Object.freeze({ appVersion, buildSha });
  let environmentTrusted = false;
  let transactionStarted = false;
  let evidence = null;
  let guard = null;
  let rollbackSucceeded = true;
  let closeFailures = [];
  emitProgress(onProgress, action, '', normalizedPayload.runId, 'validating', false);
  try {
    assertMutationRuntimeAvailable();
    assertVccMutationSchema(db);
    assertVccTriggerPolicy(db);
    environmentTrusted = true;
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    evidence = loadResultMutationEvidence(db, {
      runId: normalizedPayload.runId,
      taskGeneration
    });
    const tokenKey = action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT ? 'adjustment' : 'archive';
    if (evidence.previewTokens[tokenKey] !== normalizedPayload.expectedPreviewToken) {
      throw resultWriteError(STATE_CHANGED_CODE, STATE_CHANGED_MESSAGE, {
        expectedPreviewToken: normalizedPayload.expectedPreviewToken,
        actualPreviewToken: evidence.previewTokens[tokenKey]
      });
    }
    const locked = assertCurrentCalculatedEvidence(evidence, normalizedPayload, action);
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const plan = buildResultMutationPlan(
      db,
      action,
      evidence,
      normalizedPayload,
      locked,
      transactionTimestamp,
      provenance
    );
    guard = beginMutationGuard(db, plan, hooks.guardOptions || {});
    emitProgress(
      onProgress,
      action,
      evidence.targetMonth,
      normalizedPayload.runId,
      'preserving-audit',
      false
    );
    emitProgress(onProgress, action, evidence.targetMonth, normalizedPayload.runId, 'applying', false);
    const stepResults = executeRegisteredMutationSteps(db, guard, hooks);
    assertMutationGuardPostwrite(db, guard);
    emitProgress(onProgress, action, evidence.targetMonth, normalizedPayload.runId, 'verifying', false);
    const result = assertResultMutationPostconditions(db, plan, stepResults);
    closeFailures = closeMutationGuard(guard);
    if (closeFailures.length > 0) {
      throw resultWriteError(
        'mutation-guard-unavailable',
        'Mutation guard session 关闭失败，已禁止提交。',
        { closeFailures }
      );
    }
    db.exec('COMMIT');
    transactionStarted = false;
    emitProgress(onProgress, action, evidence.targetMonth, normalizedPayload.runId, 'committed', false);
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

function openVccWriteDatabase(dbPath, Database = DatabaseSync) {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function rollbackAuditPlan(db, failurePlan, transactionTimestamp) {
  const boundary = Number(db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS max_id FROM vcc_fin_op_operation_audit
  `).get().max_id);
  return freezePlan({
    operation: VCC_MUTATION_OPERATIONS.ROLLBACK_AUDIT,
    targetMonth: failurePlan.targetMonth,
    runId: failurePlan.runId,
    lockedEvidenceToken: failurePlan.previewToken,
    expectedTotalChanges: 1,
    tableBudgets: {
      vcc_fin_op_operation_audit: { inserts: 1, updates: 0, deletes: 0, protection: 'planned-scope' }
    },
    steps: [{
      stepId: 'audit.rollback',
      expectedChanges: 1,
      bindings: [
        failurePlan.targetMonth,
        failurePlan.operationType,
        failurePlan.runId,
        failurePlan.previewToken,
        JSON.stringify(failurePlan.evidence),
        failurePlan.evidence.failure.message,
        failurePlan.appVersion,
        failurePlan.buildSha,
        transactionTimestamp
      ]
    }],
    expectedPostState: Object.freeze({
      boundary,
      failurePlan,
      transactionTimestamp
    })
  });
}

function assertRollbackAuditPostcondition(db, plan, stepResults) {
  const step = stepResults[0];
  const auditId = step && step.lastInsertRowid;
  const post = plan.expectedPostState;
  const row = Number.isSafeInteger(auditId) ? db.prepare(`
    SELECT id, target_month, operation_type, run_id, status, preview_token,
           evidence_json, error_message, app_version, build_sha, created_at
    FROM vcc_fin_op_operation_audit WHERE id = ?
  `).get(auditId) : null;
  const boundaryCount = Number(db.prepare(`
    SELECT COUNT(*) AS row_count FROM vcc_fin_op_operation_audit WHERE id > ?
  `).get(post.boundary).row_count);
  const failurePlan = post.failurePlan;
  if (
    !row
    || auditId <= post.boundary
    || boundaryCount !== 1
    || row.target_month !== failurePlan.targetMonth
    || row.operation_type !== failurePlan.operationType
    || (row.run_id === null ? null : Number(row.run_id)) !== failurePlan.runId
    || row.status !== 'rolled_back'
    || row.preview_token !== failurePlan.previewToken
    || row.evidence_json !== JSON.stringify(failurePlan.evidence)
    || row.error_message !== failurePlan.evidence.failure.message
    || row.app_version !== failurePlan.appVersion
    || row.build_sha !== failurePlan.buildSha
    || row.created_at !== post.transactionTimestamp
  ) {
    throw resultWriteError(
      'rollback-audit-invariant-failed',
      '独立 rollback audit 提交前精确断言失败。',
      { auditId, boundaryCount }
    );
  }
  return auditId;
}

function persistRolledBackAuditSafely({
  dbPath,
  failurePlan,
  Database = DatabaseSync,
  hooks = {}
}) {
  const db = openVccWriteDatabase(dbPath, Database);
  let transactionStarted = false;
  let guard = null;
  try {
    assertMutationRuntimeAvailable({ Database, force: true });
    assertVccMutationSchema(db);
    assertVccTriggerPolicy(db);
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const plan = rollbackAuditPlan(db, failurePlan, transactionTimestamp);
    guard = beginMutationGuard(db, plan, hooks.guardOptions || {});
    const stepResults = executeRegisteredMutationSteps(db, guard, hooks);
    assertMutationGuardPostwrite(db, guard);
    const auditId = assertRollbackAuditPostcondition(db, plan, stepResults);
    const closeFailures = closeMutationGuard(guard);
    if (closeFailures.length > 0) {
      throw resultWriteError('mutation-guard-unavailable', 'Rollback audit session 关闭失败，已禁止提交。');
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return auditId;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* original audit error wins */ }
    }
    if (guard) closeMutationGuard(guard);
    throw error;
  } finally {
    db.close();
  }
}

function executeResultMutationWithSafeAudit({
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
    result = executeLockedResultMutation({
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
        payload && payload.runId,
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
          event: 'vcc-result-write-rollback-audit-failed',
          action,
          runId: payload && Number(payload.runId),
          primaryCode: primaryError.code || null,
          auditCode: auditError && auditError.code ? auditError.code : null
        }));
      }
    }
  } else if (typeof onDiagnostic === 'function') {
    onDiagnostic(Object.freeze({
      event: 'vcc-result-write-failure-not-audited',
      action,
      runId: payload && Number(payload.runId),
      primaryCode: primaryError.code || null
    }));
  }
  throw primaryError;
}

module.exports = {
  RESULT_OPERATION_TYPES,
  resultWriteError,
  normalizeOperationPayload,
  revisionsMatch,
  isLegacyCalculatedEvidence,
  assertCurrentCalculatedEvidence,
  buildResultMutationPlan,
  assertResultMutationPostconditions,
  executeLockedResultMutation,
  openVccWriteDatabase,
  isUnsafeAuditError,
  redactedFailure,
  persistRolledBackAuditSafely,
  executeResultMutationWithSafeAudit
};
