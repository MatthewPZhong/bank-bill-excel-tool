'use strict';

const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../backend/run-data-store');
const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const {
  normalizeRecoverySource
} = require('../../background-execution/recovery-source');
const {
  getOperationReceipt,
  hasOperationReceiptTable
} = require('./operation-receipt-repository');
const {
  batchMatchesReceiptEvidence,
  readBatchActualCounts
} = require('./business-evidence');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION;

function inspection(source, outcome, boundedEvidence) {
  return Object.freeze({
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome,
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(boundedEvidence),
    boundedEvidence
  });
}

function matchingBusinessRows(db, evidence) {
  return db.prepare(`
    SELECT * FROM pre_fund_reconciliation_gateway_batches
    WHERE source_type = ? AND source_batch = ?
  `).all(evidence.sourceType, evidence.sourceBatch);
}

function receiptMatchesEvidence(receipt, source, evidence) {
  return receipt.actionKey === source.actionKey &&
    receipt.operationKey === source.operationKey &&
    receipt.producerTaskRunId === source.taskRunId &&
    receipt.fileIndex === evidence.fileIndex &&
    receipt.sourceFileName === evidence.sourceFileName &&
    receipt.sourceSha256 === evidence.sourceSha256 &&
    receipt.contentHash === evidence.contentHash;
}

function createPreFundMptOutcomeInspector(options) {
  if (!options || typeof options.userDataDir !== 'string') {
    throw new TypeError('PreFund MPT Inspector需要userDataDir');
  }
  const userDataDir = options.userDataDir;
  return async function inspectPreFundMpt(rawSource) {
    const source = normalizeRecoverySource(rawSource);
    const evidence = source.boundedEvidence;
    const receiptMatches = [];
    const operationMutationMatches = [];
    for (const file of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
      const db = new DatabaseSync(file.path, { readOnly: true });
      try {
        db.exec('PRAGMA query_only = ON');
        if (hasOperationReceiptTable(db)) {
          const receipt = getOperationReceipt(db, source.actionKey, source.operationKey);
          if (receipt) receiptMatches.push({ monthKey: file.monthKey, receipt });
        }
        for (const batch of matchingBusinessRows(db, evidence)) {
          if ((batch.producer_task_run_id || null) === source.taskRunId &&
              (batch.dataset_id || null) === evidence.datasetId &&
              batch.source_date === evidence.sourceDate &&
              batch.source_file_sequence === evidence.sourceFileSequence &&
              batch.source_file_name === evidence.sourceFileName &&
              batch.content_hash === evidence.contentHash) {
            operationMutationMatches.push({ monthKey: file.monthKey, batch });
          }
        }
      } finally {
        db.close();
      }
    }

    if (receiptMatches.length === 0) {
      return inspection(source, operationMutationMatches.length === 0 ? 'not-committed' : 'unknown', {
        disposition: operationMutationMatches.length === 0
          ? 'receipt-and-operation-mutation-absent'
          : 'mutation-without-receipt',
        receiptCount: 0,
        businessMatchCount: operationMutationMatches.length
      });
    }
    if (receiptMatches.length !== 1) {
      return inspection(source, 'unknown', {
        disposition: 'receipt-not-unique',
        receiptCount: receiptMatches.length,
        businessMatchCount: operationMutationMatches.length
      });
    }
    const located = receiptMatches[0];
    let batch = null;
    let actualCounts = { valid: -1, excluded: -1 };
    const locatedPath = runDataStore.sideDbPath(userDataDir, MODULE, located.monthKey);
    const locatedDb = new DatabaseSync(locatedPath, { readOnly: true });
    try {
      locatedDb.exec('PRAGMA query_only = ON');
      batch = locatedDb.prepare(`
        SELECT * FROM pre_fund_reconciliation_gateway_batches WHERE id = ?
      `).get(located.receipt.batchId) || null;
      if (batch) {
        actualCounts = readBatchActualCounts(locatedDb, batch.id);
      }
    } finally {
      locatedDb.close();
    }
    const outcomeKind = located.receipt.outcomeKind;
    const operationMutationExact = outcomeKind === 'noop-existing-batch'
      ? operationMutationMatches.length === 0
      : (['inserted', 'replaced'].includes(outcomeKind) &&
        operationMutationMatches.length === 1 &&
        operationMutationMatches[0].monthKey === located.monthKey &&
        Number(operationMutationMatches[0].batch.id) === located.receipt.batchId);
    const exact = located.monthKey === evidence.monthKey &&
      receiptMatchesEvidence(located.receipt, source, evidence) &&
      batchMatchesReceiptEvidence(batch, located.receipt, evidence, actualCounts) &&
      operationMutationExact;
    return inspection(source, exact ? 'committed' : 'unknown', {
      disposition: exact ? 'receipt-and-business-lineage-exact' : 'receipt-business-lineage-conflict',
      receiptCount: 1,
      businessMatchCount: operationMutationMatches.length,
      receiptId: located.receipt.id,
      batchId: located.receipt.batchId,
      outcomeKind: located.receipt.outcomeKind,
      monthKey: located.monthKey,
      datasetVersionAfter: located.receipt.datasetVersionAfter
    });
  };
}

module.exports = {
  createPreFundMptOutcomeInspector
};
