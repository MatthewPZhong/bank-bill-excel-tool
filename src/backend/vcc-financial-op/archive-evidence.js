'use strict';

const { buildRunRowKey } = require('./result-adjustments');
const { validateEffectiveResultEvidence } = require('./result-evidence');

const ARCHIVE_EVIDENCE_VERSION = 2;

function compareNumber(left, right) {
  return Number(left) - Number(right);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function groupByRunId(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const runId = Number(row.runId);
    if (!grouped.has(runId)) grouped.set(runId, []);
    grouped.get(runId).push(row);
  }
  return grouped;
}

function deriveRunRowKey(row) {
  try {
    return buildRunRowKey(row);
  } catch (error) {
    if (error && error.code === 'invalid-run-row-metadata') return '';
    throw error;
  }
}

function buildArchiveEvidenceV2(rawEvidence) {
  const runs = [...rawEvidence.runs].sort((left, right) => compareNumber(left.id, right.id));
  const datasets = [...rawEvidence.datasets].sort((left, right) => (
    compareText(left.datasetType, right.datasetType)
  ));
  const archives = [...rawEvidence.archives].sort((left, right) => (
    compareText(left.subject, right.subject) || compareNumber(left.runId, right.runId)
  ));
  const runRows = rawEvidence.runRows.map((row) => Object.freeze({
    ...row,
    rowKey: deriveRunRowKey(row)
  })).sort((left, right) => (
    compareNumber(left.runId, right.runId) || compareNumber(left.id, right.id)
  ));
  const runAdjustments = [...rawEvidence.runAdjustments].sort((left, right) => (
    compareNumber(left.runId, right.runId)
    || compareNumber(left.sequence, right.sequence)
    || compareNumber(left.id, right.id)
  ));
  const storedRunBalances = [...rawEvidence.storedRunBalances].sort((left, right) => (
    compareNumber(left.runId, right.runId)
    || compareText(left.subject, right.subject)
    || compareText(left.currency, right.currency)
  ));
  const rowsByRun = groupByRunId(runRows);
  const adjustmentsByRun = groupByRunId(runAdjustments);
  const balancesByRun = groupByRunId(storedRunBalances);
  const resultValidations = runs.map((run) => validateEffectiveResultEvidence({
    run,
    runRows: rowsByRun.get(Number(run.id)) || [],
    runAdjustments: adjustmentsByRun.get(Number(run.id)) || [],
    storedRunBalances: balancesByRun.get(Number(run.id)) || []
  }));

  return Object.freeze({
    evidenceVersion: ARCHIVE_EVIDENCE_VERSION,
    targetMonth: String(rawEvidence.targetMonth),
    runs: Object.freeze(runs),
    datasets: Object.freeze(datasets),
    archives: Object.freeze(archives),
    runRows: Object.freeze(runRows),
    runAdjustments: Object.freeze(runAdjustments),
    storedRunBalances: Object.freeze(storedRunBalances),
    resultValidations: Object.freeze(resultValidations),
    pendingEffectiveFactCount: Number(rawEvidence.pendingEffectiveFactCount),
    pendingRunRowCount: Number(rawEvidence.pendingRunRowCount),
    pendingSummaryCount: Number(rawEvidence.pendingSummaryCount),
    pendingCurrencyTotalCount: Number(rawEvidence.pendingCurrencyTotalCount)
  });
}

module.exports = {
  ARCHIVE_EVIDENCE_VERSION,
  buildArchiveEvidenceV2
};
