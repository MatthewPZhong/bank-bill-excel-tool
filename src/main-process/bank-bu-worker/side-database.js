'use strict';

const runDataStore = require('../../backend/run-data-store');
const monthRepository = require('../../backend/bank-bu-recon-db/month-repository');
const runRepository = require('../../backend/bank-bu-recon-db/run-repository');
const receiptRepository = require('./operation-receipt-repository');
const { normalizeOperationIdentity, validateImportEvidence } = require('./identity');

function rollbackQuietly(db) {
  try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (_error) { /* 原错误优先 */ }
}

function open(userDataDir, yearMonth) {
  return runDataStore.openSideDb(userDataDir, runDataStore.MODULE_BANK_BU, yearMonth);
}

function assertImportReplayCurrent(db, receipt, operationIdentity, yearMonth, datasetHash) {
  const dataset = getDatasetEvidence(db, yearMonth);
  if (receipt.producerTaskRunId !== operationIdentity.producerTaskRunId ||
      receipt.yearMonth !== yearMonth || receipt.inputEvidenceHash !== datasetHash ||
      !dataset || dataset.operation_key !== operationIdentity.operationKey ||
      dataset.producer_task_run_id !== operationIdentity.producerTaskRunId ||
      dataset.dataset_hash !== datasetHash) {
    const error = new Error('同一BankBU import operation已被不同当前dataset identity覆盖');
    error.code = 'BANK_BU_IMPORT_IDENTITY_CONFLICT';
    throw error;
  }
}

function importCommittedDataset(options) {
  const { userDataDir, yearMonth, pendingRows, bankRows } = options;
  const evidence = validateImportEvidence(options.evidence, { yearMonth, pendingRows, bankRows });
  const operationIdentity = normalizeOperationIdentity(
    options.operationIdentity, 'bank-bu:import-month'
  );
  const db = open(userDataDir, yearMonth);
  try {
    const replay = receiptRepository.getOperationReceipt(
      db, operationIdentity.actionKey, operationIdentity.operationKey
    );
    if (replay) {
      assertImportReplayCurrent(
        db, replay, operationIdentity, yearMonth, evidence.datasetHash
      );
      return Object.freeze({
        replay: true,
        pendingCount: evidence.pending.rowCount,
        bankCount: evidence.bank.rowCount,
        receipt: replay,
        datasetHash: evidence.datasetHash
      });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedReplay = receiptRepository.getOperationReceipt(
        db, operationIdentity.actionKey, operationIdentity.operationKey
      );
      if (lockedReplay) {
        assertImportReplayCurrent(
          db, lockedReplay, operationIdentity, yearMonth, evidence.datasetHash
        );
        db.exec('COMMIT');
        return Object.freeze({
          replay: true,
          pendingCount: evidence.pending.rowCount,
          bankCount: evidence.bank.rowCount,
          receipt: lockedReplay,
          datasetHash: evidence.datasetHash
        });
      }
      db.prepare(`DELETE FROM ${monthRepository.PENDING_TABLE} WHERE year_month = ?`).run(yearMonth);
      db.prepare(`DELETE FROM ${monthRepository.BANK_TABLE} WHERE year_month = ?`).run(yearMonth);
      db.prepare(`DELETE FROM ${monthRepository.RUNS_TABLE} WHERE year_month = ?`).run(yearMonth);
      db.prepare('DELETE FROM bank_bu_dataset_evidence WHERE year_month = ?').run(yearMonth);
      const pendingCount = monthRepository.insertPendingRowsInTxn(db, yearMonth, pendingRows);
      const bankCount = monthRepository.insertBankRowsInTxn(db, yearMonth, bankRows);
      db.prepare(`
        INSERT INTO bank_bu_dataset_evidence (
          year_month, pending_count, bank_count, pending_evidence_hash,
          bank_evidence_hash, dataset_hash, operation_key, producer_task_run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        yearMonth, pendingCount, bankCount, evidence.pendingEvidenceHash,
        evidence.bankEvidenceHash, evidence.datasetHash,
        operationIdentity.operationKey, operationIdentity.producerTaskRunId
      );
      const receipt = receiptRepository.insertOperationReceipt(db, {
        ...operationIdentity,
        operationKind: 'import',
        yearMonth,
        sideRunId: null,
        inputEvidenceHash: evidence.datasetHash
      }).receipt;
      db.exec('COMMIT');
      return Object.freeze({
        replay: false, pendingCount, bankCount, receipt, datasetHash: evidence.datasetHash
      });
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

function getDatasetEvidence(db, yearMonth) {
  return db.prepare('SELECT * FROM bank_bu_dataset_evidence WHERE year_month = ?').get(yearMonth) || null;
}

function getCommittedRunByOperation(db, operationIdentity, yearMonth, inputEvidenceHash) {
  const receipt = receiptRepository.getOperationReceipt(
    db, operationIdentity.actionKey, operationIdentity.operationKey
  );
  if (!receipt) return null;
  if (receipt.producerTaskRunId !== operationIdentity.producerTaskRunId ||
      receipt.yearMonth !== yearMonth || receipt.inputEvidenceHash !== inputEvidenceHash) {
    const error = new Error('同一BankBU run operationKey已存在不同identity');
    error.code = 'BANK_BU_RUN_IDENTITY_CONFLICT';
    throw error;
  }
  const row = db.prepare('SELECT * FROM bank_bu_recon_runs WHERE id = ?').get(receipt.sideRunId);
  if (!row || row.operation_key !== operationIdentity.operationKey ||
      row.producer_task_run_id !== operationIdentity.producerTaskRunId ||
      row.input_evidence_hash !== inputEvidenceHash) {
    const error = new Error('BankBU run receipt缺少matching side run');
    error.code = 'BANK_BU_SIDE_RUN_MISSING';
    throw error;
  }
  return Object.freeze({ receipt, row });
}

function commitRun(options) {
  const { db, yearMonth, result, operationIdentity, inputEvidenceHash } = options;
  const replay = getCommittedRunByOperation(db, operationIdentity, yearMonth, inputEvidenceHash);
  if (replay) {
    return Object.freeze({
      replay: true, sideRunId: replay.receipt.sideRunId,
      receipt: replay.receipt, row: replay.row
    });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const lockedReplay = getCommittedRunByOperation(
      db, operationIdentity, yearMonth, inputEvidenceHash
    );
    if (lockedReplay) {
      db.exec('COMMIT');
      return Object.freeze({
        replay: true, sideRunId: lockedReplay.receipt.sideRunId,
        receipt: lockedReplay.receipt, row: lockedReplay.row
      });
    }
    const sideRunId = runRepository.insertManagedRun(db, {
      yearMonth,
      status: 'success',
      pendingTotal: result.stats.pendingTotal,
      bankTotal: result.stats.bankTotal,
      matchedCount: result.stats.matchedCount,
      buDiffCount: result.stats.buDiffCount,
      pendingUnmatched: result.stats.pendingUnmatched,
      bankUnmatched: result.stats.bankUnmatched,
      anomalyCount: result.stats.nmAnomalyCount,
      operationKey: operationIdentity.operationKey,
      producerTaskRunId: operationIdentity.producerTaskRunId,
      inputEvidenceHash
    });
    const receipt = receiptRepository.insertOperationReceipt(db, {
      ...operationIdentity,
      operationKind: 'run',
      yearMonth,
      sideRunId,
      inputEvidenceHash
    }).receipt;
    db.exec('COMMIT');
    return Object.freeze({
      replay: false,
      sideRunId,
      receipt,
      row: db.prepare('SELECT * FROM bank_bu_recon_runs WHERE id = ?').get(sideRunId)
    });
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

module.exports = {
  commitRun,
  getDatasetEvidence,
  getCommittedRunByOperation,
  importCommittedDataset,
  open
};
