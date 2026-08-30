'use strict';

const { readPendingGuanliFile, readBankFile } = require('../../backend/bank-bu-recon-import/reader');
const { buildImportEvidence, normalizeOperationIdentity, requireMonth, sha256File } = require('./identity');
const { importCommittedDataset } = require('./side-database');
const { normalizeDualImportDescriptor } = require('./spool-contract');
const { readBankBuSpoolPair, waitForBankBuSpoolsReady } = require('./spool-reader');

async function readSingleInputs(input) {
  if (typeof input.pendingPath !== 'string' || typeof input.bankPath !== 'string') {
    throw new TypeError('BankBU import input缺少路径');
  }
  const [pendingBefore, bankBefore] = await Promise.all([
    sha256File(input.pendingPath), sha256File(input.bankPath)
  ]);
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
  return Object.freeze({
    pendingRows: pending.rows,
    bankRows: bank.rows,
    pendingFileSha256: pendingAfter,
    bankFileSha256: bankAfter
  });
}

async function readDualInputs(input, yearMonth, signal) {
  const dual = normalizeDualImportDescriptor(input.dualParserImport);
  if (dual.spools[0].yearMonth !== yearMonth) {
    throw new TypeError('BankBU dual parser月份与import不一致');
  }
  // 两只Parser clean exit后的success outcome都存在，single Writer才读取spool。
  await waitForBankBuSpoolsReady(dual, { signal });
  const pair = await readBankBuSpoolPair(dual);
  return Object.freeze({
    pendingRows: pair.pending.rows,
    bankRows: pair.bank.rows,
    pendingFileSha256: pair.pending.manifest.source.sha256,
    bankFileSha256: pair.bank.manifest.source.sha256
  });
}

async function executeImportMonth(input, context = {}) {
  const yearMonth = requireMonth(input && input.yearMonth);
  const operationIdentity = normalizeOperationIdentity(
    context.operationIdentity, 'bank-bu:import-month'
  );
  if (!input || typeof input.userDataDir !== 'string') {
    throw new TypeError('BankBU import input缺少路径');
  }
  const prepared = input.dualParserImport
    ? await readDualInputs(input, yearMonth, context.signal)
    : await readSingleInputs(input);
  const evidence = buildImportEvidence({
    yearMonth,
    pendingFileSha256: prepared.pendingFileSha256,
    bankFileSha256: prepared.bankFileSha256,
    pendingRows: prepared.pendingRows,
    bankRows: prepared.bankRows
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
    pendingRows: prepared.pendingRows,
    bankRows: prepared.bankRows,
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
