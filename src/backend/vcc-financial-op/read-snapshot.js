'use strict';

const {
  SOURCE_TYPES,
  SOURCE_LABELS
} = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const { buildArchiveEvidenceV2 } = require('./archive-evidence');
const {
  ARCHIVE_CONTRACTS,
  classifyArchiveContract
} = require('./archive-contract');
const {
  UNARCHIVE_GATE_VERSION,
  evaluateUnarchiveGate
} = require('./unarchive-gate');
const {
  sha256,
  buildOperationTokenV2,
  buildDeleteTargetTokenV2,
  buildResultMutationTokenV2
} = require('./operation-token-v2');
const { getEffectiveRunResult } = require('./result-adjustments');

const ARCHIVE_CANDIDATE_SQL = `
  SELECT target_month FROM vcc_fin_op_runs WHERE status = 'archived'
  UNION
  SELECT target_month FROM vcc_fin_op_archives
  UNION
  SELECT target_month FROM vcc_fin_op_datasets WHERE data_status = 'archived'
`;

const ACTIVE_MONTHS_SQL = `
  SELECT target_month FROM vcc_fin_op_datasets
  UNION SELECT target_month FROM vcc_fin_op_runs
  UNION SELECT target_month FROM vcc_fin_op_archives
  UNION SELECT target_month FROM vcc_fin_op_opening_balances
  UNION SELECT target_month FROM vcc_fin_op_import_batches WHERE status = 'importing'
  UNION
  SELECT target_month FROM vcc_fin_op_import_records
  WHERE status = 'importing'
     OR resolution_status = 'unresolved'
     OR (
       status IN ('success', 'success_with_skips', 'all_skipped')
       AND dataset_deleted_at IS NULL
     )
  UNION SELECT target_month FROM vcc_fin_op_effective_rows
  UNION SELECT target_month FROM vcc_fin_op_system_snapshots
  ORDER BY target_month DESC
`;

const SOURCE_TARGET_TYPES = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING,
  SOURCE_TYPES.SYSTEM_OP
]);

const DELETE_TARGET_TYPES = Object.freeze({
  OPENING: 'opening_initialization',
  RESULT: 'result'
});

const DELETE_TARGET_LABELS = Object.freeze({
  [DELETE_TARGET_TYPES.OPENING]: '首月期初初始化数据',
  [DELETE_TARGET_TYPES.RESULT]: '财务OP校验结果表'
});

function operationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeMonth(targetMonth) {
  const normalized = normalizeYearMonth(targetMonth);
  if (!normalized || normalized !== targetMonth) {
    throw operationError('invalid-month', `月份账期格式无效：${targetMonth || ''}`);
  }
  return normalized;
}

function executeQuery(db, trace, name, sql, params = [], mode = 'all') {
  if (typeof trace === 'function') trace(Object.freeze({ name, sql }));
  return db.prepare(sql)[mode](...params);
}

function parseJsonEvidence(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, parseError: true };
    }
    return { value: parsed, parseError: false };
  } catch (_error) {
    return { value: null, parseError: true };
  }
}

function candidateRelation(targetMonth) {
  if (targetMonth) return { sql: 'SELECT ? AS target_month', params: [targetMonth] };
  return { sql: ARCHIVE_CANDIDATE_SQL, params: [] };
}

function withCandidates(relation, bodySql) {
  return `WITH candidate_months(target_month) AS (${relation.sql}) ${bodySql}`;
}

function loadArchiveEvidenceSet(db, { targetMonth = null, trace = null } = {}) {
  const normalizedTarget = targetMonth === null ? null : normalizeMonth(targetMonth);
  const relation = candidateRelation(normalizedTarget);
  const candidates = executeQuery(db, trace, 'archive-candidates', withCandidates(relation, `
    SELECT target_month FROM candidate_months ORDER BY target_month DESC
  `), relation.params).map((row) => String(row.target_month));
  const runs = executeQuery(db, trace, 'archive-runs', withCandidates(relation, `
    SELECT run.id, run.target_month, run.status, run.result_revision,
           run.input_fingerprint, run.input_revisions_json,
           run.created_at, run.updated_at, run.archived_at
    FROM vcc_fin_op_runs run
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    ORDER BY run.target_month DESC, run.id
  `), relation.params);
  const datasets = executeQuery(db, trace, 'archive-datasets', withCandidates(relation, `
    SELECT dataset.target_month, dataset.dataset_type, dataset.data_status,
           dataset.archived_run_id, dataset.revision,
           dataset.generated_at, dataset.updated_at
    FROM vcc_fin_op_datasets dataset
    JOIN candidate_months candidate ON candidate.target_month = dataset.target_month
    ORDER BY dataset.target_month DESC, dataset.dataset_type
  `), relation.params);
  const archives = executeQuery(db, trace, 'archive-rows', withCandidates(relation, `
    SELECT archive.target_month, archive.subject, archive.balances_json,
           archive.run_id, archive.archived_at
    FROM vcc_fin_op_archives archive
    JOIN candidate_months candidate ON candidate.target_month = archive.target_month
    ORDER BY archive.target_month DESC, archive.subject
  `), relation.params);
  const runRows = executeQuery(db, trace, 'archive-run-rows', withCandidates(relation, `
    SELECT run.target_month, row.id, row.run_id, row.subject, row.row_kind,
           row.source_type, row.category_major, row.category_minor,
           row.currency, row.amount
    FROM vcc_fin_op_run_rows row
    JOIN vcc_fin_op_runs run ON run.id = row.run_id
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    ORDER BY run.target_month DESC, row.run_id, row.id
  `), relation.params);
  const runBalances = executeQuery(db, trace, 'archive-run-balances', withCandidates(relation, `
    SELECT run.target_month, balance.run_id, balance.subject, balance.currency,
           balance.opening_balance, balance.period_amount,
           balance.calculated_balance, balance.system_balance, balance.difference
    FROM vcc_fin_op_run_balances balance
    JOIN vcc_fin_op_runs run ON run.id = balance.run_id
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    ORDER BY run.target_month DESC, balance.run_id, balance.subject, balance.currency
  `), relation.params);
  const runAdjustments = executeQuery(db, trace, 'archive-run-adjustments', withCandidates(relation, `
    SELECT run.target_month, adjustment.id, adjustment.run_id,
           adjustment.row_key, adjustment.subject, adjustment.source_type,
           adjustment.category_major, adjustment.category_minor,
           adjustment.currency, adjustment.adjustment_amount,
           adjustment.reason, adjustment.sequence, adjustment.created_at,
           adjustment.created_app_version, adjustment.created_build_sha
    FROM vcc_fin_op_run_adjustments adjustment
    JOIN vcc_fin_op_runs run ON run.id = adjustment.run_id
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    ORDER BY run.target_month DESC, adjustment.run_id, adjustment.sequence, adjustment.id
  `), relation.params);
  const pendingSummaryCounts = executeQuery(db, trace, 'archive-pending-summaries', withCandidates(relation, `
    SELECT run.target_month, COUNT(*) AS row_count
    FROM vcc_fin_op_pending_summary_rows summary
    JOIN vcc_fin_op_runs run ON run.id = summary.run_id
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    GROUP BY run.target_month
    ORDER BY run.target_month DESC
  `), relation.params);
  const pendingCurrencyCounts = executeQuery(db, trace, 'archive-pending-currency-totals', withCandidates(relation, `
    SELECT run.target_month, COUNT(*) AS row_count
    FROM vcc_fin_op_pending_currency_totals total
    JOIN vcc_fin_op_runs run ON run.id = total.run_id
    JOIN candidate_months candidate ON candidate.target_month = run.target_month
    GROUP BY run.target_month
    ORDER BY run.target_month DESC
  `), relation.params);
  const pendingEffectiveCounts = executeQuery(db, trace, 'archive-pending-effective-facts', withCandidates(relation, `
    SELECT candidate.target_month, COUNT(*) AS row_count
    FROM candidate_months candidate
    CROSS JOIN vcc_fin_op_effective_rows fact
      INDEXED BY idx_vcc_fin_op_effective_month_source
    WHERE fact.target_month = candidate.target_month
      AND fact.source_type = 'pending_archive_removal'
    GROUP BY candidate.target_month
    ORDER BY candidate.target_month DESC
  `), relation.params);

  const rawByMonth = new Map(candidates.map((month) => [month, {
    targetMonth: month,
    runs: [],
    datasets: [],
    archives: [],
    runRows: [],
    runAdjustments: [],
    storedRunBalances: [],
    pendingEffectiveFactCount: 0,
    pendingRunRowCount: 0,
    pendingSummaryCount: 0,
    pendingCurrencyTotalCount: 0
  }]));
  const target = (row) => rawByMonth.get(String(row.target_month));

  for (const row of runs) {
    const revisions = parseJsonEvidence(row.input_revisions_json);
    target(row).runs.push({
      id: Number(row.id),
      targetMonth: row.target_month,
      status: row.status,
      resultRevision: Number(row.result_revision),
      inputFingerprint: row.input_fingerprint,
      inputRevisions: revisions.value,
      inputRevisionsParseError: revisions.parseError,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at
    });
  }
  for (const row of datasets) {
    target(row).datasets.push({
      datasetType: row.dataset_type,
      dataStatus: row.data_status,
      revision: Number(row.revision),
      archivedRunId: row.archived_run_id === null ? null : Number(row.archived_run_id),
      generatedAt: row.generated_at,
      updatedAt: row.updated_at
    });
  }
  for (const row of archives) {
    const balances = parseJsonEvidence(row.balances_json);
    target(row).archives.push({
      subject: row.subject,
      runId: Number(row.run_id),
      archivedAt: row.archived_at,
      balances: balances.value,
      balancesParseError: balances.parseError,
      balancesHash: sha256(row.balances_json)
    });
  }
  for (const row of runRows) {
    const evidence = {
      id: Number(row.id),
      runId: Number(row.run_id),
      subject: row.subject,
      rowKind: row.row_kind,
      sourceType: row.source_type,
      categoryMajor: row.category_major,
      categoryMinor: row.category_minor,
      currency: row.currency,
      amount: row.amount
    };
    target(row).runRows.push(evidence);
    if (row.row_kind === 'pending' || row.source_type === SOURCE_TYPES.PENDING) {
      target(row).pendingRunRowCount += 1;
    }
  }
  for (const row of runAdjustments) {
    target(row).runAdjustments.push({
      id: Number(row.id),
      runId: Number(row.run_id),
      rowKey: row.row_key,
      subject: row.subject,
      sourceType: row.source_type,
      categoryMajor: row.category_major,
      categoryMinor: row.category_minor,
      currency: row.currency,
      adjustmentAmount: row.adjustment_amount,
      reason: row.reason,
      sequence: Number(row.sequence),
      createdAt: row.created_at,
      createdAppVersion: row.created_app_version,
      createdBuildSha: row.created_build_sha
    });
  }
  for (const row of runBalances) {
    target(row).storedRunBalances.push({
      runId: Number(row.run_id),
      subject: row.subject,
      currency: row.currency,
      openingBalance: row.opening_balance,
      periodAmount: row.period_amount,
      calculatedBalance: row.calculated_balance,
      systemBalance: row.system_balance,
      difference: row.difference
    });
  }
  for (const row of pendingSummaryCounts) target(row).pendingSummaryCount = Number(row.row_count);
  for (const row of pendingCurrencyCounts) target(row).pendingCurrencyTotalCount = Number(row.row_count);
  for (const row of pendingEffectiveCounts) target(row).pendingEffectiveFactCount = Number(row.row_count);

  return candidates.map((month) => buildArchiveEvidenceV2(rawByMonth.get(month)));
}

function archiveListItem(contractResult, targetMonth) {
  return Object.freeze({
    targetMonth,
    runId: contractResult.runId,
    archivedAt: contractResult.archivedAt,
    resultRevision: contractResult.resultRevision,
    subjects: contractResult.subjects,
    archiveContract: contractResult.contract
  });
}

function listArchiveMonthsSnapshot(db, { targetMonth = null, trace = null } = {}) {
  const evidenceSet = loadArchiveEvidenceSet(db, { targetMonth, trace });
  const months = [];
  const diagnostics = [];
  for (const evidence of evidenceSet) {
    const contractResult = classifyArchiveContract(evidence);
    if (contractResult.contract === ARCHIVE_CONTRACTS.INCONSISTENT) {
      diagnostics.push(Object.freeze({
        event: 'vcc-financial-op-archive-month-excluded',
        targetMonth: evidence.targetMonth,
        hasArchivedEvidence: evidence.runs.some((run) => run.status === 'archived')
          || evidence.archives.length > 0
          || evidence.datasets.some((dataset) => dataset.dataStatus === 'archived'),
        consistencyReasons: contractResult.structuralReasons
      }));
      continue;
    }
    months.push(archiveListItem(contractResult, evidence.targetMonth));
  }
  return Object.freeze({
    months: Object.freeze(months),
    diagnostics: Object.freeze(diagnostics)
  });
}

function loadUnarchiveGateEvidence(db, targetMonth, {
  taskGeneration,
  taskActive,
  trace = null
}) {
  const activeBatches = executeQuery(db, trace, 'unarchive-active-batches', `
    SELECT id FROM vcc_fin_op_import_batches
    WHERE status = 'importing'
    ORDER BY id
  `);
  const importRecords = executeQuery(db, trace, 'unarchive-import-gate', `
    SELECT id, source_type, status, resolution_status
    FROM vcc_fin_op_import_records
    WHERE target_month = ?
      AND (status = 'importing' OR resolution_status = 'unresolved')
    ORDER BY id
  `, [targetMonth]);
  const laterRows = executeQuery(db, trace, 'unarchive-later-dependencies', `
    SELECT 'run' AS evidence_kind, target_month, id AS item_id,
           status AS item_status, result_revision, updated_at, archived_at,
           NULL AS dataset_type
    FROM vcc_fin_op_runs
    WHERE target_month > ? AND status IN ('archived', 'calculated')
    UNION ALL
    SELECT 'archive', target_month, NULL, NULL, NULL, NULL, archived_at, NULL
    FROM vcc_fin_op_archives
    WHERE target_month > ?
    UNION ALL
    SELECT 'dataset', target_month, NULL, NULL, NULL, updated_at, NULL, dataset_type
    FROM vcc_fin_op_datasets
    WHERE target_month > ? AND data_status = 'archived'
    ORDER BY target_month, evidence_kind, item_id, dataset_type
  `, [targetMonth, targetMonth, targetMonth]);
  const laterByMonth = new Map();
  for (const row of laterRows) {
    const month = String(row.target_month);
    if (!laterByMonth.has(month)) {
      laterByMonth.set(month, {
        targetMonth: month,
        runs: [],
        archiveCount: 0,
        archivedDatasetTypes: []
      });
    }
    const item = laterByMonth.get(month);
    if (row.evidence_kind === 'run') {
      item.runs.push({
        id: Number(row.item_id),
        status: row.item_status,
        resultRevision: Number(row.result_revision),
        updatedAt: row.updated_at,
        archivedAt: row.archived_at
      });
    } else if (row.evidence_kind === 'archive') {
      item.archiveCount += 1;
    } else {
      item.archivedDatasetTypes.push(row.dataset_type);
    }
  }
  return Object.freeze({
    gateVersion: UNARCHIVE_GATE_VERSION,
    taskGeneration: Number(taskGeneration),
    taskActive: Boolean(taskActive),
    activeBatchIds: Object.freeze(activeBatches.map((row) => String(row.id))),
    importingRecordIds: Object.freeze(importRecords
      .filter((row) => row.status === 'importing')
      .map((row) => Number(row.id))),
    unresolvedRecords: Object.freeze(importRecords
      .filter((row) => row.resolution_status === 'unresolved')
      .map((row) => Object.freeze({
        id: Number(row.id),
        sourceType: row.source_type,
        status: row.status,
        resolutionStatus: row.resolution_status
      }))),
    laterDependencies: Object.freeze([...laterByMonth.values()].map((item) => Object.freeze({
      ...item,
      runs: Object.freeze(item.runs),
      archivedDatasetTypes: Object.freeze([...new Set(item.archivedDatasetTypes)].sort())
    })))
  });
}

function previewUnarchiveSnapshot(db, {
  targetMonth,
  taskGeneration = 0,
  taskActive = false,
  trace = null
}) {
  const month = normalizeMonth(targetMonth);
  const [archiveEvidence] = loadArchiveEvidenceSet(db, { targetMonth: month, trace });
  const archiveContract = classifyArchiveContract(archiveEvidence);
  const gateEvidence = loadUnarchiveGateEvidence(db, month, {
    taskGeneration,
    taskActive,
    trace
  });
  const gate = evaluateUnarchiveGate(archiveContract, gateEvidence);
  const token = buildOperationTokenV2({
    action: 'unarchive',
    targetMonth: month,
    scope: null,
    archiveEvidence,
    archiveContract,
    gateEvidence
  });
  const canReadArchive = archiveContract.contract !== ARCHIVE_CONTRACTS.INCONSISTENT;
  return Object.freeze({
    targetMonth: month,
    archiveContract: archiveContract.contract,
    structuralReasons: archiveContract.structuralReasons,
    runId: archiveContract.runId,
    archivedAt: archiveContract.archivedAt,
    resultRevision: archiveContract.resultRevision,
    subjects: archiveContract.subjects,
    dependentMonths: gate.dependentMonths,
    canEnumerate: canReadArchive,
    canExport: canReadArchive,
    canUnarchive: gate.canUnarchive,
    code: gate.code,
    message: gate.message,
    previewToken: token ? token.previewToken : null,
    taskGeneration: Number(taskGeneration)
  });
}

function listActiveMonthsSnapshot(db, { taskGeneration = 0, trace = null } = {}) {
  const rows = executeQuery(db, trace, 'active-months', ACTIVE_MONTHS_SQL);
  return Object.freeze({
    months: Object.freeze(rows.map((row) => String(row.target_month))),
    taskGeneration: Number(taskGeneration)
  });
}

function loadDeleteEvidenceV2(db, {
  targetMonth,
  taskGeneration = 0,
  trace = null
}) {
  const month = normalizeMonth(targetMonth);
  const datasets = executeQuery(db, trace, 'delete-datasets', `
    SELECT dataset_type, data_status, archived_run_id, revision
    FROM vcc_fin_op_datasets WHERE target_month = ?
    ORDER BY dataset_type
  `, [month]).map((row) => ({
    datasetType: row.dataset_type,
    dataStatus: row.data_status,
    archivedRunId: row.archived_run_id === null ? null : Number(row.archived_run_id),
    revision: Number(row.revision)
  }));
  const runs = executeQuery(db, trace, 'delete-runs', `
    SELECT id, status, result_revision, input_fingerprint, updated_at, archived_at
    FROM vcc_fin_op_runs WHERE target_month = ? ORDER BY id
  `, [month]).map((row) => ({
    id: Number(row.id),
    status: row.status,
    resultRevision: Number(row.result_revision),
    inputFingerprint: row.input_fingerprint,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }));
  const archives = executeQuery(db, trace, 'delete-archives', `
    SELECT subject, run_id, archived_at, balances_json
    FROM vcc_fin_op_archives WHERE target_month = ?
    ORDER BY subject
  `, [month]).map((row) => ({
    subject: row.subject,
    runId: Number(row.run_id),
    archivedAt: row.archived_at,
    balancesHash: sha256(row.balances_json)
  }));
  const openingRow = executeQuery(db, trace, 'delete-opening-count', `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_opening_balances WHERE target_month = ?
  `, [month], 'get');
  const effectiveRows = executeQuery(db, trace, 'delete-effective-counts', `
    SELECT source_type, COUNT(*) AS row_count
    FROM vcc_fin_op_effective_rows WHERE target_month = ?
    GROUP BY source_type ORDER BY source_type
  `, [month]);
  const systemRow = executeQuery(db, trace, 'delete-system-count', `
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_system_snapshots WHERE target_month = ?
  `, [month], 'get');
  const activeBatches = executeQuery(db, trace, 'delete-active-batches', `
    SELECT id FROM vcc_fin_op_import_batches
    WHERE status = 'importing' ORDER BY id
  `);
  const importRecords = executeQuery(db, trace, 'delete-import-gate', `
    SELECT id, source_type, status, resolution_status
    FROM vcc_fin_op_import_records
    WHERE target_month = ?
      AND (status = 'importing' OR resolution_status = 'unresolved')
    ORDER BY id
  `, [month]);
  const moduleState = executeQuery(db, trace, 'delete-module-state', `
    SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1
  `, [], 'get') || { first_month: null };
  const effectiveCounts = Object.fromEntries(SOURCE_TARGET_TYPES.map((type) => [type, 0]));
  for (const row of effectiveRows) effectiveCounts[row.source_type] = Number(row.row_count);
  effectiveCounts[SOURCE_TYPES.SYSTEM_OP] = Number(systemRow.row_count);
  return Object.freeze({
    evidenceVersion: 2,
    targetMonth: month,
    taskGeneration: Number(taskGeneration),
    datasets: Object.freeze(datasets),
    runs: Object.freeze(runs),
    archives: Object.freeze(archives),
    openingCount: Number(openingRow.row_count),
    effectiveCounts: Object.freeze(effectiveCounts),
    systemSnapshotCount: Number(systemRow.row_count),
    activeBatchIds: Object.freeze(activeBatches.map((row) => String(row.id))),
    importingRecordIds: Object.freeze(importRecords
      .filter((row) => row.status === 'importing')
      .map((row) => Number(row.id))),
    unresolvedRecords: Object.freeze(importRecords
      .filter((row) => row.resolution_status === 'unresolved')
      .map((row) => Object.freeze({
        id: Number(row.id),
        sourceType: row.source_type,
        status: row.status,
        resolutionStatus: row.resolution_status
      }))),
    firstMonth: moduleState.first_month
  });
}

function deletePreviewForTarget(evidence, targetType, { taskActive = false } = {}) {
  const dataset = evidence.datasets.find((item) => item.datasetType === targetType) || null;
  const calculatedRuns = evidence.runs.filter((run) => run.status === 'calculated');
  const archivedExists = evidence.runs.some((run) => run.status === 'archived')
    || evidence.archives.length > 0
    || evidence.datasets.some((item) => item.dataStatus === 'archived');
  const activeExists = taskActive
    || evidence.activeBatchIds.length > 0
    || evidence.importingRecordIds.length > 0;
  let preview;
  if (SOURCE_TARGET_TYPES.includes(targetType)) {
    const dataCount = Number(evidence.effectiveCounts[targetType]) || 0;
    let code = '';
    let message = '';
    if (archivedExists || (dataset && dataset.dataStatus === 'archived')) {
      code = 'archived-month';
      message = `${evidence.targetMonth} 已归档，禁止删除`;
    } else if (activeExists) {
      code = 'active-vcc-task';
      message = '当前仍有 VCC 财务OP任务或原表导入进行中，禁止删除';
    } else if (dataCount === 0) {
      code = 'no-data';
      message = '当前选择没有可删除的有效数据';
    }
    preview = {
      targetType,
      sourceType: targetType,
      targetLabel: SOURCE_LABELS[targetType],
      sourceLabel: SOURCE_LABELS[targetType],
      datasetRevision: dataset ? dataset.revision : null,
      dataCount,
      count: dataCount,
      calculatedRunCount: calculatedRuns.length,
      available: !code,
      deletable: !code,
      code,
      disabledReason: message,
      message
    };
  } else if (targetType === DELETE_TARGET_TYPES.OPENING) {
    const datasetsUnarchived = evidence.datasets.every((item) => (
      item.dataStatus !== 'archived' && item.archivedRunId === null
    ));
    let code = '';
    let message = '';
    if (evidence.targetMonth !== evidence.firstMonth) {
      code = 'not-first-month';
      message = evidence.firstMonth
        ? `仅首月 ${evidence.firstMonth} 可删除期初初始化数据。`
        : '尚未确定 VCC 财务OP首月，不能删除期初初始化数据。';
    } else if (evidence.openingCount === 0) {
      code = 'no-opening-data';
      message = '暂无首月期初初始化数据。';
    } else if (archivedExists) {
      code = 'opening-archived';
      message = '该月财务OP校验结果已归档，请先解归档后再删除首月期初初始化数据。';
    } else if (!datasetsUnarchived) {
      code = 'dataset-state-inconsistent';
      message = '首月现存数据集状态不一致，已阻止删除期初初始化数据。';
    } else if (activeExists) {
      code = 'active-vcc-task';
      message = '已有 VCC 财务OP任务正在运行，请完成后重试。';
    } else if (evidence.unresolvedRecords.length > 0) {
      code = 'unresolved-imports';
      message = '该月仍有未处理的导入异常，禁止删除首月期初初始化数据。';
    }
    preview = {
      targetType,
      targetLabel: DELETE_TARGET_LABELS[targetType],
      count: evidence.openingCount,
      calculatedRunCount: calculatedRuns.length,
      available: !code,
      deletable: !code,
      code,
      disabledReason: message,
      message
    };
  } else if (targetType === DELETE_TARGET_TYPES.RESULT) {
    let code = '';
    let message = '';
    if (archivedExists) {
      code = 'result-archived-delete-forbidden';
      message = '已归档结果不可删除，请先解归档。';
    } else if (activeExists) {
      code = 'active-vcc-task';
      message = '已有 VCC 财务OP任务正在运行，请完成后重试。';
    } else if (calculatedRuns.length === 0) {
      code = 'no-result-data';
      message = '当前月份没有可删除的未归档财务OP校验结果。';
    }
    preview = {
      targetType,
      targetLabel: DELETE_TARGET_LABELS[targetType],
      count: calculatedRuns.length,
      calculatedRunCount: calculatedRuns.length,
      runIds: calculatedRuns.map((run) => run.id),
      available: !code,
      deletable: !code,
      code,
      disabledReason: message,
      message
    };
  } else {
    throw operationError('invalid-delete-target', `不支持删除的目标表：${targetType || ''}`);
  }
  const token = buildDeleteTargetTokenV2(evidence, targetType);
  return Object.freeze({
    targetMonth: evidence.targetMonth,
    ...preview,
    previewToken: token.previewToken,
    taskGeneration: evidence.taskGeneration
  });
}

function listDeleteTargetsSnapshot(db, {
  targetMonth,
  taskGeneration = 0,
  taskActive = false,
  trace = null
}) {
  const evidence = loadDeleteEvidenceV2(db, { targetMonth, taskGeneration, trace });
  const targetTypes = [...SOURCE_TARGET_TYPES];
  if (evidence.firstMonth === evidence.targetMonth) targetTypes.push(DELETE_TARGET_TYPES.OPENING);
  if (evidence.runs.length > 0) targetTypes.push(DELETE_TARGET_TYPES.RESULT);
  return Object.freeze({
    targetMonth: evidence.targetMonth,
    taskGeneration: evidence.taskGeneration,
    targets: Object.freeze(targetTypes.map((targetType) => (
      deletePreviewForTarget(evidence, targetType, { taskActive })
    )))
  });
}

function previewDeleteTargetSnapshot(db, {
  targetMonth,
  targetType,
  sourceType,
  taskGeneration = 0,
  taskActive = false,
  trace = null
}) {
  const evidence = loadDeleteEvidenceV2(db, { targetMonth, taskGeneration, trace });
  return deletePreviewForTarget(evidence, String(targetType || sourceType || ''), { taskActive });
}

function normalizeRunId(runId) {
  const normalized = Number(runId);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw operationError('invalid-run-id', `财务OP run id 无效：${runId}`);
  }
  return normalized;
}

function loadResultMutationGateEvidence(db, targetMonth, {
  taskGeneration = 0,
  trace = null
} = {}) {
  const activeBatches = executeQuery(db, trace, 'result-write-active-batches', `
    SELECT id FROM vcc_fin_op_import_batches
    WHERE target_month = ? AND status = 'importing'
    ORDER BY id
  `, [targetMonth]);
  const importRecords = executeQuery(db, trace, 'result-write-import-gate', `
    SELECT id, source_type, status, resolution_status
    FROM vcc_fin_op_import_records
    WHERE target_month = ?
      AND (status = 'importing' OR resolution_status = 'unresolved')
    ORDER BY id
  `, [targetMonth]);
  const [year, month] = targetMonth.split('-').map(Number);
  const nextMonth = month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
  const nextOpeningRows = executeQuery(db, trace, 'result-write-next-opening', `
    SELECT subject FROM vcc_fin_op_opening_balances
    WHERE target_month = ?
    ORDER BY subject
  `, [nextMonth]);
  return Object.freeze({
    taskGeneration: Number(taskGeneration),
    activeBatchIds: Object.freeze(activeBatches.map((row) => String(row.id))),
    importingRecordIds: Object.freeze(importRecords
      .filter((row) => row.status === 'importing')
      .map((row) => Number(row.id))),
    unresolvedRecords: Object.freeze(importRecords
      .filter((row) => row.resolution_status === 'unresolved')
      .map((row) => Object.freeze({
        id: Number(row.id),
        sourceType: row.source_type,
        status: row.status,
        resolutionStatus: row.resolution_status
      }))),
    nextOpeningSubjects: Object.freeze(nextOpeningRows.map((row) => String(row.subject)))
  });
}

function loadResultMutationEvidence(db, {
  runId,
  taskGeneration = 0,
  trace = null
}) {
  const normalizedRunId = normalizeRunId(runId);
  const runTarget = executeQuery(db, trace, 'result-write-run-target', `
    SELECT target_month FROM vcc_fin_op_runs WHERE id = ?
  `, [normalizedRunId], 'get');
  if (!runTarget) throw operationError('result-not-found', `财务OP计算记录不存在：${normalizedRunId}`);
  const targetMonth = normalizeMonth(String(runTarget.target_month));
  const [archiveEvidence] = loadArchiveEvidenceSet(db, { targetMonth, trace });
  const gateEvidence = loadResultMutationGateEvidence(db, targetMonth, {
    taskGeneration,
    trace
  });
  const adjustmentToken = buildResultMutationTokenV2({
    action: 'add-adjustment',
    targetMonth,
    runId: normalizedRunId,
    archiveEvidence,
    gateEvidence
  });
  const archiveToken = buildResultMutationTokenV2({
    action: 'archive-result',
    targetMonth,
    runId: normalizedRunId,
    archiveEvidence,
    gateEvidence
  });
  if (!adjustmentToken || !archiveToken) {
    throw operationError(
      'result-evidence-invalid',
      '财务OP结果证据不完整，已禁止修改或归档。',
      { runId: normalizedRunId, targetMonth }
    );
  }
  return Object.freeze({
    runId: normalizedRunId,
    targetMonth,
    taskGeneration: Number(taskGeneration),
    archiveEvidence,
    gateEvidence,
    previewTokens: Object.freeze({
      adjustment: adjustmentToken.previewToken,
      archive: archiveToken.previewToken
    })
  });
}

function getRunResultSnapshot(db, options) {
  const evidence = loadResultMutationEvidence(db, options);
  const effective = getEffectiveRunResult(db, evidence.runId);
  if (!effective) {
    throw operationError('result-not-found', `财务OP计算记录不存在：${evidence.runId}`);
  }
  return Object.freeze({ ...evidence, effective });
}

module.exports = {
  ARCHIVE_CANDIDATE_SQL,
  ACTIVE_MONTHS_SQL,
  SOURCE_TARGET_TYPES,
  DELETE_TARGET_TYPES,
  DELETE_TARGET_LABELS,
  executeQuery,
  loadArchiveEvidenceSet,
  listArchiveMonthsSnapshot,
  loadUnarchiveGateEvidence,
  previewUnarchiveSnapshot,
  listActiveMonthsSnapshot,
  loadDeleteEvidenceV2,
  deletePreviewForTarget,
  listDeleteTargetsSnapshot,
  previewDeleteTargetSnapshot,
  loadResultMutationGateEvidence,
  loadResultMutationEvidence,
  getRunResultSnapshot
};
