'use strict';

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');

function pendingSourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRunIds(runIds) {
  if (!Array.isArray(runIds) || runIds.length < 1 ||
      runIds.some((runId) => !Number.isSafeInteger(runId) || runId < 1) ||
      new Set(runIds).size !== runIds.length) {
    throw pendingSourceError('PENDING_EXPORT_RUN_SET_INVALID', 'Pending export runIds 非法');
  }
  return runIds.slice();
}

function monthHeadForRun(db, yearMonth, runId) {
  const head = db.prepare(`
    SELECT year_month, row_count, dataset_id, producer_task_run_id,
           dataset_version, archive_contract_version
    FROM pending_months WHERE year_month = ?
  `).get(yearMonth);
  if (!head || !head.dataset_id) {
    throw pendingSourceError(
      'PENDING_EXPORT_RUN_NOT_STABLE',
      `Pending run #${runId} 的月份 ${yearMonth} 缺少稳定 dataset head`
    );
  }
  return Object.freeze({ ...head });
}

function revisionForRun(db, runId) {
  const run = db.prepare(`
    SELECT id, upper_month, lower_month, rule_snapshot, created_at,
           stat_new, stat_missing, stat_changed, archive_contract_version,
           archive_task_run_id, archive_terminal_ack_at
    FROM diff_runs WHERE id = ?
  `).get(runId);
  if (!run) throw pendingSourceError('PENDING_EXPORT_RUN_NOT_FOUND', `Pending run #${runId} 不存在`);
  const contractVersion = Number(run.archive_contract_version) || 0;
  if (![0, 1].includes(contractVersion) ||
      (contractVersion === 1 && (!run.archive_task_run_id || !run.archive_terminal_ack_at))) {
    throw pendingSourceError(
      'PENDING_EXPORT_RUN_NOT_STABLE',
      `Pending run #${runId} 尚未形成可导出的稳定终态`
    );
  }
  const monthHeads = [run.upper_month, run.lower_month]
    .filter((month, index, values) => month && values.indexOf(month) === index)
    .map((month) => monthHeadForRun(db, month, runId));
  const removedHead = db.prepare(`
    SELECT year_month, dataset_id, producer_task_run_id,
           dataset_version, archive_contract_version, updated_at
    FROM pending_removed_months WHERE year_month = ?
  `).get(run.upper_month) || null;
  const hasRemovedRows = Boolean(db.prepare(`
    SELECT 1 FROM removed_pending_rows WHERE year_month = ? LIMIT 1
  `).get(run.upper_month));
  if (hasRemovedRows && (!removedHead || !removedHead.dataset_id)) {
    throw pendingSourceError(
      'PENDING_EXPORT_RUN_NOT_STABLE',
      `Pending run #${runId} 的移除数据缺少稳定 dataset head`
    );
  }
  return Object.freeze({
    run: Object.freeze({ ...run }),
    monthHeads: Object.freeze(monthHeads),
    removedHead: removedHead && removedHead.dataset_id
      ? Object.freeze({ ...removedHead })
      : null
  });
}

function readPendingRunSourceSnapshot(db, rawRunIds) {
  const runIds = normalizeRunIds(rawRunIds);
  const revisions = runIds.map((runId) => revisionForRun(db, runId));
  return Object.freeze({
    contractVersion: 1,
    runIds: Object.freeze(runIds),
    sourceDigest: canonicalSha256(Object.freeze({
      contractVersion: 1,
      runIds: Object.freeze(runIds),
      revisions: Object.freeze(revisions)
    }))
  });
}

function withReadSnapshot(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

function freezePendingRunEvidence(db, runIds) {
  return withReadSnapshot(db, () => readPendingRunSourceSnapshot(db, runIds));
}

function assertPendingRunEvidence(db, expected) {
  if (!expected || expected.contractVersion !== 1 || !Array.isArray(expected.runIds) ||
      typeof expected.sourceDigest !== 'string') {
    throw pendingSourceError('PENDING_EXPORT_EVIDENCE_INVALID', 'Pending stable run evidence 非法');
  }
  const current = readPendingRunSourceSnapshot(db, expected.runIds);
  if (current.sourceDigest !== expected.sourceDigest) {
    throw pendingSourceError('PENDING_EXPORT_SOURCE_STALE', 'Pending export 来源已变化，请重新导出');
  }
  return current;
}

module.exports = {
  assertPendingRunEvidence,
  freezePendingRunEvidence,
  normalizeRunIds,
  revisionForRun,
  readPendingRunSourceSnapshot,
  withReadSnapshot
};
