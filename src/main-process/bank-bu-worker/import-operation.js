'use strict';

const { readPendingGuanliFile, readBankFile } = require('../../backend/bank-bu-recon-import/reader');
const { buildImportEvidence, normalizeOperationIdentity, requireMonth, sha256File } = require('./identity');
const { importCommittedDataset } = require('./side-database');

async function executeImportMonth(input, context = {}) {
  const yearMonth = requireMonth(input && input.yearMonth);
  const operationIdentity = normalizeOperationIdentity(
    context.operationIdentity, 'bank-bu:import-month'
  );
  if (!input || typeof input.userDataDir !== 'string' ||
      typeof input.pendingPath !== 'string' || typeof input.bankPath !== 'string') {
    throw new TypeError('BankBU import input缺少路径');
  }
  const [pendingBefore, bankBefore] = await Promise.all([
    sha256File(input.pendingPath), sha256File(input.bankPath)
  ]);
  // E08-A固定single：reader顺序是Pending→Bank；任何reader失败都发生在side事务之前。
  const pending = readPendingGuanliFile(input.pendingPath);
  const bank = readBankFile(input.bankPath);
  const [pendingAfter, bankAfter] = await Promise.all([
    sha256File(input.pendingPath), sha256File(input.bankPath)
  ]);
  if (pendingBefore !== pendingAfter || bankBefore !== bankAfter) {
    const error = new Error('BankBU源文件在读取期间发生变化');
    error.code = 'BANK_BU_SOURCE_CHANGED';
    throw error;
  }
  const evidence = buildImportEvidence({
    yearMonth,
    pendingFileSha256: pendingAfter,
    bankFileSha256: bankAfter,
    pendingRows: pending.rows,
    bankRows: bank.rows
  });
  if (typeof context.awaitCritical === 'function') {
    await context.awaitCritical(Object.freeze({
      operationKind: 'import', yearMonth, inputEvidenceHash: evidence.datasetHash,
      pendingCount: evidence.pending.rowCount, bankCount: evidence.bank.rowCount
    }));
  }
  const committed = importCommittedDataset({
    userDataDir: input.userDataDir,
    yearMonth,
    pendingRows: pending.rows,
    bankRows: bank.rows,
    evidence,
    operationIdentity
  });
  return Object.freeze({
    status: 'ok', operation: 'import-month', yearMonth,
    pendingCount: committed.pendingCount, bankCount: committed.bankCount,
    inputEvidenceHash: committed.datasetHash, replay: committed.replay,
    receipt: committed.receipt
  });
}

module.exports = { executeImportMonth };
