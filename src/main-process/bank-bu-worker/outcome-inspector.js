'use strict';

const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../backend/run-data-store');
const receiptRepository = require('./operation-receipt-repository');
const {
  captureMirrorPreimage,
  commitMirrorCas,
  postImageFromSide,
  samePostImage,
  samePreimage
} = require('./mirror-repository');

function readSideOperation(userDataDir, evidence) {
  const filePath = runDataStore.sideDbPath(
    userDataDir, runDataStore.MODULE_BANK_BU, evidence.yearMonth
  );
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (_error) {
    return null;
  }
  try {
    let receipt;
    try {
      receipt = receiptRepository.getOperationReceipt(db, 'bank-bu:run', evidence.operationKey);
    } catch (_error) {
      return Object.freeze({ conflict: true, reason: 'side-receipt-unreadable' });
    }
    if (!receipt) return null;
    const sideRun = db.prepare('SELECT * FROM bank_bu_recon_runs WHERE id = ?').get(receipt.sideRunId);
    if (!sideRun || receipt.producerTaskRunId !== evidence.producerTaskRunId ||
        receipt.yearMonth !== evidence.yearMonth ||
        receipt.inputEvidenceHash !== evidence.inputEvidenceHash ||
        sideRun.operation_key !== receipt.operationKey ||
        sideRun.producer_task_run_id !== receipt.producerTaskRunId ||
        sideRun.input_evidence_hash !== receipt.inputEvidenceHash) {
      return Object.freeze({ conflict: true, receipt, sideRun });
    }
    return Object.freeze({ conflict: false, receipt, sideRun });
  } finally {
    db.close();
  }
}

function inspectRunOutcome({ mainDb, userDataDir, criticalEvidence }) {
  let current;
  try {
    current = captureMirrorPreimage(mainDb, criticalEvidence.yearMonth);
  } catch (_error) {
    return Object.freeze({ outcome: 'unknown', reason: 'main-mirror-not-unique' });
  }
  const side = readSideOperation(userDataDir, criticalEvidence);
  if (side && side.conflict) return Object.freeze({ outcome: 'unknown', reason: 'side-identity-conflict' });
  const preMatches = samePreimage(current, criticalEvidence.preimage);
  if (!side) {
    return Object.freeze({
      outcome: preMatches ? 'not-committed' : 'unknown',
      reason: preMatches ? 'side-absent-main-preimage' : 'side-absent-main-changed'
    });
  }
  const postImage = postImageFromSide({
    yearMonth: criticalEvidence.yearMonth,
    sideRun: side.sideRun,
    receipt: side.receipt,
    relPath: runDataStore.sideDbRelPath(runDataStore.MODULE_BANK_BU, criticalEvidence.yearMonth)
  });
  if (samePostImage(current.expectedPreviousMirror, postImage)) {
    return Object.freeze({
      outcome: 'committed', reason: 'side-main-identity-match',
      postImage, mirror: current.expectedPreviousMirror
    });
  }
  if (preMatches) {
    return Object.freeze({ outcome: 'partially-committed', reason: 'side-committed-main-preimage', postImage });
  }
  return Object.freeze({ outcome: 'unknown', reason: 'main-identity-conflict', postImage });
}

function inspectImportOutcome({
  userDataDir, yearMonth, operationKey, producerTaskRunId, inputEvidenceHash
}) {
  const filePath = runDataStore.sideDbPath(userDataDir, runDataStore.MODULE_BANK_BU, yearMonth);
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (_error) {
    return Object.freeze({ outcome: 'not-committed', reason: 'side-database-absent' });
  }
  try {
    const receipt = receiptRepository.getOperationReceipt(db, 'bank-bu:import-month', operationKey);
    if (!receipt) return Object.freeze({ outcome: 'not-committed', reason: 'receipt-absent' });
    const dataset = db.prepare(
      'SELECT * FROM bank_bu_dataset_evidence WHERE year_month = ?'
    ).get(yearMonth);
    if (receipt.yearMonth !== yearMonth || receipt.producerTaskRunId !== producerTaskRunId ||
        receipt.inputEvidenceHash !== inputEvidenceHash || !dataset ||
        dataset.operation_key !== operationKey ||
        dataset.producer_task_run_id !== producerTaskRunId ||
        dataset.dataset_hash !== inputEvidenceHash) {
      return Object.freeze({ outcome: 'unknown', reason: 'import-receipt-identity-conflict' });
    }
    return Object.freeze({ outcome: 'committed', reason: 'import-receipt-committed', receipt });
  } catch (_error) {
    return Object.freeze({ outcome: 'unknown', reason: 'import-receipt-unreadable' });
  } finally {
    db.close();
  }
}

function completeMirrorFromCommittedSide({ mainDb, userDataDir, criticalEvidence }) {
  const inspected = inspectRunOutcome({ mainDb, userDataDir, criticalEvidence });
  if (inspected.outcome === 'committed') {
    return Object.freeze({ outcome: 'committed', replay: true, mirror: inspected.mirror });
  }
  if (inspected.outcome !== 'partially-committed') {
    return Object.freeze({ outcome: 'unknown', reason: inspected.reason });
  }
  try {
    const committed = commitMirrorCas(mainDb, criticalEvidence.preimage, inspected.postImage);
    return Object.freeze({ outcome: 'committed', replay: committed.replay, mirror: committed.mirror });
  } catch (error) {
    if (error && error.code === 'BANK_BU_MIRROR_CAS_CONFLICT') {
      return Object.freeze({ outcome: 'unknown', reason: 'mirror-cas-conflict' });
    }
    throw error;
  }
}

module.exports = {
  completeMirrorFromCommittedSide,
  inspectImportOutcome,
  inspectRunOutcome,
  readSideOperation
};
