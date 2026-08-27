'use strict';

const runDataStore = require('../../backend/run-data-store');
const { runReconciliation } = require('../bank-bu-recon-session');
const { normalizeOperationIdentity, requireMonth } = require('./identity');
const {
  commitRun, getCommittedRunByOperation, getDatasetEvidence, open
} = require('./side-database');

async function executeRun(input, context = {}) {
  const yearMonth = requireMonth(input && input.yearMonth);
  const operationIdentity = normalizeOperationIdentity(context.operationIdentity, 'bank-bu:run');
  if (!input || typeof input.userDataDir !== 'string') throw new TypeError('BankBU run缺少userDataDir');
  const db = open(input.userDataDir, yearMonth);
  try {
    const dataset = getDatasetEvidence(db, yearMonth);
    if (!dataset || Number(dataset.pending_count) < 1 || Number(dataset.bank_count) < 1) {
      const error = new Error('BankBU当前月份缺少完整dataset evidence');
      error.code = 'BANK_BU_DATASET_EVIDENCE_MISSING';
      throw error;
    }
    const replay = getCommittedRunByOperation(
      db, operationIdentity, yearMonth, dataset.dataset_hash
    );
    if (replay) {
      return Object.freeze({
        status: 'ok', operation: 'run', yearMonth, sideRunId: replay.receipt.sideRunId,
        inputEvidenceHash: dataset.dataset_hash,
        stats: Object.freeze({
          pendingTotal: Number(replay.row.pending_total),
          bankTotal: Number(replay.row.bank_total),
          matchedCount: Number(replay.row.matched_count),
          buDiffCount: Number(replay.row.bu_diff_count),
          pendingUnmatched: Number(replay.row.pending_unmatched),
          bankUnmatched: Number(replay.row.bank_unmatched),
          nmAnomalyCount: Number(replay.row.anomaly_count)
        }),
        replay: true,
        receipt: replay.receipt,
        sideDbRelPath: runDataStore.sideDbRelPath(runDataStore.MODULE_BANK_BU, yearMonth)
      });
    }
    const result = runReconciliation(db, yearMonth);
    if (typeof context.awaitCritical === 'function') {
      await context.awaitCritical(Object.freeze({
        operationKind: 'run', yearMonth, inputEvidenceHash: dataset.dataset_hash,
        expectedNewOperationKey: operationIdentity.operationKey,
        stats: result.stats
      }));
    }
    const committed = commitRun({
      db, yearMonth, result, operationIdentity, inputEvidenceHash: dataset.dataset_hash
    });
    return Object.freeze({
      status: 'ok', operation: 'run', yearMonth, sideRunId: committed.sideRunId,
      inputEvidenceHash: dataset.dataset_hash, stats: result.stats,
      replay: committed.replay, receipt: committed.receipt,
      sideDbRelPath: runDataStore.sideDbRelPath(runDataStore.MODULE_BANK_BU, yearMonth)
    });
  } finally {
    db.close();
  }
}

module.exports = { executeRun };
