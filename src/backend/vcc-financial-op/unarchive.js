'use strict';

const { REQUIRED_DATASET_TYPES, parseBalancesJson } = require('./calculator');
const { SUPPORTED_CURRENCIES } = require('./definitions');
const { canonicalizeVccAmount } = require('./amount-rules');
const { getEffectiveRunResult } = require('./result-adjustments');
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

const UNARCHIVE_OPERATION = 'unarchive';
const REQUIRED_DATASET_SET = new Set(REQUIRED_DATASET_TYPES);

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function inspectRunBalanceSubjects(db, runId) {
  const rows = db.prepare(`
    SELECT subject, currency, calculated_balance
    FROM vcc_fin_op_run_balances
    WHERE run_id = ?
    ORDER BY subject, currency
  `).all(runId);
  const bySubject = new Map();
  const errors = [];
  for (const row of rows) {
    const subject = String(row.subject == null ? '' : row.subject);
    const currency = String(row.currency == null ? '' : row.currency);
    if (!subject || !SUPPORTED_CURRENCIES.includes(currency)) {
      errors.push(`run-balance-coordinate:${subject}/${currency}`);
      continue;
    }
    if (!bySubject.has(subject)) bySubject.set(subject, new Set());
    const currencies = bySubject.get(subject);
    if (currencies.has(currency)) {
      errors.push(`run-balance-duplicate:${subject}/${currency}`);
      continue;
    }
    currencies.add(currency);
    try {
      canonicalizeVccAmount(row.calculated_balance, `${subject} ${currency} 归档计算余额`);
    } catch (_error) {
      errors.push(`run-balance-invalid:${subject}/${currency}`);
    }
  }
  for (const [subject, currencies] of bySubject) {
    const missing = SUPPORTED_CURRENCIES.filter((currency) => !currencies.has(currency));
    if (missing.length > 0) errors.push(`run-balance-currencies:${subject}:${missing.join(',')}`);
  }
  return { subjects: [...bySubject.keys()].sort(), errors };
}

function inspectArchiveConsistencyFromState(db, state) {
  const archivedRuns = state.runs.filter((run) => run.status === 'archived');
  const calculatedRuns = state.runs.filter((run) => run.status === 'calculated');
  const reasons = [];
  if (archivedRuns.length !== 1) reasons.push(`archived-run-count:${archivedRuns.length}`);
  if (calculatedRuns.length > 0) reasons.push(`calculated-run-count:${calculatedRuns.length}`);
  const run = archivedRuns.length === 1 ? archivedRuns[0] : null;
  if (state.archives.length === 0) reasons.push('archives-empty');

  const archiveSubjects = state.archives.map((row) => row.subject);
  if (new Set(archiveSubjects).size !== archiveSubjects.length) reasons.push('archive-subject-duplicate');
  if (run && state.archives.some((row) => row.runId !== run.id)) {
    reasons.push('archive-run-mismatch');
  }
  const parsedArchives = new Map();
  for (const archive of state.archives) {
    try {
      const rawBalances = JSON.parse(archive.balancesJson);
      const currencyKeys = rawBalances && typeof rawBalances === 'object' && !Array.isArray(rawBalances)
        ? Object.keys(rawBalances).sort()
        : [];
      if (
        currencyKeys.length !== SUPPORTED_CURRENCIES.length
        || currencyKeys.some((currency) => !SUPPORTED_CURRENCIES.includes(currency))
      ) {
        reasons.push(`archive-balance-currencies:${archive.subject}`);
      }
      parsedArchives.set(
        archive.subject,
        parseBalancesJson(archive.balancesJson, `${state.targetMonth} ${archive.subject} 归档`)
      );
    } catch (_error) {
      reasons.push(`archive-balance-invalid:${archive.subject}`);
    }
  }

  let runBalanceSubjects = [];
  if (run) {
    const balanceState = inspectRunBalanceSubjects(db, run.id);
    runBalanceSubjects = balanceState.subjects;
    reasons.push(...balanceState.errors);
    if (JSON.stringify(uniqueSorted(archiveSubjects)) !== JSON.stringify(runBalanceSubjects)) {
      reasons.push('archive-run-subjects-mismatch');
    }
    try {
      const effective = getEffectiveRunResult(db, run.id);
      for (const balance of effective ? effective.balances : []) {
        const archivedBalances = parsedArchives.get(balance.subject);
        if (!archivedBalances) continue;
        const archivedAmount = canonicalizeVccAmount(
          archivedBalances[balance.currency],
          `${balance.subject} ${balance.currency} 归档余额`
        );
        if (archivedAmount !== balance.effectiveCalculatedBalance) {
          reasons.push(`archive-balance-mismatch:${balance.subject}/${balance.currency}`);
        }
      }
    } catch (_error) {
      reasons.push('effective-run-result-invalid');
    }
  }

  const datasetTypes = state.datasets.map((row) => row.datasetType);
  if (
    state.datasets.length !== REQUIRED_DATASET_TYPES.length
    || new Set(datasetTypes).size !== REQUIRED_DATASET_TYPES.length
    || datasetTypes.some((type) => !REQUIRED_DATASET_SET.has(type))
  ) {
    reasons.push(`dataset-types:${datasetTypes.join(',')}`);
  }
  if (run && state.datasets.some((row) => (
    row.dataStatus !== 'archived' || row.archivedRunId !== run.id
  ))) {
    reasons.push('dataset-archive-state-mismatch');
  }

  return {
    consistent: reasons.length === 0,
    reasons,
    run,
    archiveSubjects: uniqueSorted(archiveSubjects),
    runBalanceSubjects
  };
}

function previewUnarchive(db, targetMonth, {
  taskActive = false,
  taskGeneration = 0
} = {}) {
  const month = normalizeOperationMonth(targetMonth);
  const state = buildOperationState(db, {
    action: UNARCHIVE_OPERATION,
    targetMonth: month,
    taskGeneration,
    includeLaterRuns: true
  });
  const previewToken = operationPreviewToken(state);
  const consistency = inspectArchiveConsistencyFromState(db, state);
  const dependentMonths = state.laterDependencyMonths.slice();
  let code = '';
  let message = '';
  if (!consistency.consistent) {
    code = 'archive-state-inconsistent';
    message = `${month} 的归档结果、主体余额或五类数据集状态不一致，已阻止操作。`;
  } else if (taskActive || state.sourceFacts.activeImportBatchCount > 0) {
    code = 'active-vcc-task';
    message = '已有 VCC 财务OP任务正在运行，请完成后重试。';
  } else if (state.sourceFacts.unresolvedImportCount > 0) {
    code = 'unresolved-imports';
    message = `${month} 仍有未处理的导入异常，禁止解归档。`;
  } else if (dependentMonths.length > 0) {
    code = 'unarchive-not-tail';
    message = `该月之后仍存在已归档或已计算月份：${dependentMonths.join('、')}，请从最新月份开始处理。`;
  }
  return {
    targetMonth: month,
    runId: consistency.run ? consistency.run.id : null,
    archivedAt: consistency.run ? consistency.run.archivedAt : null,
    resultRevision: consistency.run ? consistency.run.resultRevision : null,
    subjects: consistency.archiveSubjects,
    dependentMonths,
    consistent: consistency.consistent,
    consistencyReasons: consistency.reasons,
    canUnarchive: !code,
    code,
    message,
    previewToken,
    taskGeneration: Number(taskGeneration)
  };
}

function logExcludedArchiveMonth(logger, targetMonth, consistencyReasons) {
  if (!logger) return;
  const payload = Object.freeze({
    event: 'vcc-financial-op-archive-month-excluded',
    targetMonth: String(targetMonth || ''),
    consistencyReasons: Object.freeze([...(consistencyReasons || [])].map(String))
  });
  try {
    if (typeof logger === 'function') logger(payload);
    else if (typeof logger.warn === 'function') logger.warn(payload);
  } catch (_error) {
    // 日志是旁路观测能力；写入失败时仍须排除损坏月份。
  }
}

function listArchivedResultMonths(db, { logger = null } = {}) {
  const candidates = db.prepare(`
    SELECT target_month FROM vcc_fin_op_runs WHERE status = 'archived'
    UNION
    SELECT target_month FROM vcc_fin_op_archives
    UNION
    SELECT target_month FROM vcc_fin_op_datasets WHERE data_status = 'archived'
    ORDER BY target_month DESC
  `).all();
  const months = [];
  for (const row of candidates) {
    const targetMonth = String(row.target_month || '');
    try {
      const state = buildOperationState(db, {
        action: UNARCHIVE_OPERATION,
        targetMonth,
        taskGeneration: 0
      });
      const consistency = inspectArchiveConsistencyFromState(db, state);
      if (!consistency.consistent) {
        logExcludedArchiveMonth(logger, targetMonth, consistency.reasons);
        continue;
      }
      months.push({
        targetMonth,
        runId: consistency.run.id,
        archivedAt: consistency.run.archivedAt,
        resultRevision: consistency.run.resultRevision,
        subjects: consistency.archiveSubjects
      });
    } catch (error) {
      logExcludedArchiveMonth(logger, targetMonth, [error.code || 'archive-state-read-failed']);
      // 非严格 YYYY-MM 或损坏月份不会进入普通前端枚举；直接 preview 仍返回结构化错误。
    }
  }
  return months;
}

function assertUnarchiveAllowed(preview) {
  if (preview.canUnarchive) return;
  throw operationError(
    preview.code || 'unarchive-blocked',
    preview.message || '当前月份不可解归档',
    {
      preview,
      dependentMonths: preview.dependentMonths || [],
      context: { preview }
    }
  );
}

function unarchiveMonth({
  db,
  targetMonth,
  expectedPreviewToken,
  taskGeneration,
  appVersion = null,
  buildSha = null
}) {
  const month = normalizeOperationMonth(targetMonth);
  let failureEvidence = { action: UNARCHIVE_OPERATION, targetMonth: month };
  let runId = null;
  let transactionStarted = false;
  try {
    const confirmedGeneration = validateOperationConfirmation(
      expectedPreviewToken,
      taskGeneration
    );
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const transactionTimestamp = readDatabaseLocalTimestamp(db);
    const preview = previewUnarchive(db, month, { taskGeneration: confirmedGeneration });
    assertPreviewToken(expectedPreviewToken, preview.previewToken);
    assertUnarchiveAllowed(preview);
    runId = preview.runId;
    const operationState = buildOperationState(db, {
      action: UNARCHIVE_OPERATION,
      targetMonth: month,
      taskGeneration: confirmedGeneration,
      includeLaterRuns: true
    });
    const runEvidence = collectRunEvidence(db, runId);
    const preservedBefore = snapshotPreservedOperationState(db, {
      targetMonth: month,
      operation: PRESERVED_OPERATIONS.UNARCHIVE
    });
    failureEvidence = {
      action: UNARCHIVE_OPERATION,
      targetMonth: month,
      preview,
      before: operationState,
      runEvidence,
      preservedState: preservedBefore
    };
    const auditId = insertOperationAudit(db, {
      targetMonth: month,
      operationType: UNARCHIVE_OPERATION,
      runId,
      status: 'success',
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp
    });

    const deletedArchives = Number(db.prepare(`
      DELETE FROM vcc_fin_op_archives WHERE target_month = ?
    `).run(month).changes) || 0;
    if (deletedArchives !== preview.subjects.length) {
      throw operationError('unarchive-invariant-failed', '归档快照未能完整删除，解归档已回滚');
    }
    const updatedRuns = Number(db.prepare(`
      UPDATE vcc_fin_op_runs
      SET status = 'calculated', archived_at = NULL,
          updated_at = ?
      WHERE id = ? AND target_month = ? AND status = 'archived'
    `).run(transactionTimestamp, runId, month).changes) || 0;
    if (updatedRuns !== 1) {
      throw operationError('unarchive-invariant-failed', '归档结果状态未能恢复为未处理，解归档已回滚');
    }
    const updatedDatasets = Number(db.prepare(`
      UPDATE vcc_fin_op_datasets
      SET data_status = 'unprocessed', archived_run_id = NULL,
          updated_at = ?
      WHERE target_month = ? AND data_status = 'archived' AND archived_run_id = ?
    `).run(transactionTimestamp, month, runId).changes) || 0;
    if (updatedDatasets !== REQUIRED_DATASET_TYPES.length) {
      throw operationError('unarchive-invariant-failed', '五类数据集未能完整恢复为未处理，解归档已回滚');
    }

    const postRun = db.prepare(`
      SELECT status, archived_at, updated_at FROM vcc_fin_op_runs WHERE id = ?
    `).get(runId);
    const postArchives = Number(db.prepare(`
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_archives WHERE target_month = ?
    `).get(month).row_count) || 0;
    const postDatasets = db.prepare(`
      SELECT dataset_type, data_status, archived_run_id, updated_at
      FROM vcc_fin_op_datasets WHERE target_month = ? ORDER BY dataset_type
    `).all(month);
    if (
      !postRun
      || postRun.status !== 'calculated'
      || postRun.archived_at !== null
      || postRun.updated_at !== transactionTimestamp
      || postArchives !== 0
      || postDatasets.length !== REQUIRED_DATASET_TYPES.length
      || postDatasets.some((row) => (
        row.data_status !== 'unprocessed'
        || row.archived_run_id !== null
        || row.updated_at !== transactionTimestamp
      ))
    ) {
      throw operationError('unarchive-invariant-failed', '解归档提交前状态断言失败，操作已回滚');
    }

    assertSuccessOperationAudit(db, {
      auditId,
      auditBoundaryId: preservedBefore.boundaries.operationAuditMaxId,
      targetMonth: month,
      operationType: UNARCHIVE_OPERATION,
      runId,
      previewToken: preview.previewToken,
      evidence: failureEvidence,
      appVersion,
      buildSha,
      createdAt: transactionTimestamp,
      code: 'unarchive-invariant-failed',
      message: '解归档成功审计提交前校验失败，操作已回滚。'
    });

    const preservedAfter = snapshotPreservedOperationState(db, {
      targetMonth: month,
      operation: PRESERVED_OPERATIONS.UNARCHIVE,
      phase: 'after',
      baseline: preservedBefore
    });
    assertPreservedOperationState(preservedBefore, preservedAfter, {
      code: 'unarchive-invariant-failed',
      message: '解归档前后保留数据或结果子表发生变化，操作已回滚。'
    });

    db.exec('COMMIT');
    transactionStarted = false;
    return {
      status: 'unarchived',
      targetMonth: month,
      runId,
      subjects: preview.subjects,
      resultRevision: preview.resultRevision,
      auditId
    };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* best-effort audit below */ }
    }
    if (db.isTransaction !== true) {
      persistRolledBackAudit(db, {
        targetMonth: month,
        operationType: UNARCHIVE_OPERATION,
        runId,
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

module.exports = {
  UNARCHIVE_OPERATION,
  inspectRunBalanceSubjects,
  inspectArchiveConsistencyFromState,
  logExcludedArchiveMonth,
  listArchivedResultMonths,
  previewUnarchive,
  unarchiveMonth
};
