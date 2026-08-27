'use strict';

const { DatabaseSync } = require('node:sqlite');

const receiptRepository = require('../../backend/database/recon-fix-operation-receipt-repository');
const {
  normalizeBoundedJpmReceipt,
  sameBoundedJpmReceipt
} = require('./jpm-receipt-evidence');

function authorityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createReconFixJpmReceiptAuthority(options = {}) {
  if (typeof options.databasePath !== 'string' || !options.databasePath ||
      typeof options.outcomeInspector !== 'function') {
    throw new TypeError('ReconFix JPM receipt authority依赖不完整');
  }
  const databasePath = options.databasePath;
  const outcomeInspector = options.outcomeInspector;

  function find(actionKey, operationKey) {
    let db;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON');
      if (!receiptRepository.hasOperationReceiptTable(db)) return null;
      const receipt = receiptRepository.getOperationReceipt(db, actionKey, operationKey);
      return receipt ? receiptRepository.normalizeExactReceipt(receipt) : null;
    } finally {
      if (db) db.close();
    }
  }

  async function verify({ source, receipt }) {
    const claimed = normalizeBoundedJpmReceipt(receipt);
    const inspected = await outcomeInspector(source);
    if (!inspected || inspected.outcome !== 'committed') {
      throw authorityError(
        'RECON_FIX_JPM_RECEIPT_NOT_AUTHORITATIVE',
        'JPM commit:receipt 未通过 receipt-first Inspector'
      );
    }
    const expected = normalizeBoundedJpmReceipt({
      receiptDigest: inspected.boundedEvidence.receiptDigest,
      preImageHash: source.boundedEvidence.preImageHash,
      postImageHash: source.boundedEvidence.postImageHash,
      idSequenceDigest: source.boundedEvidence.idSequenceDigest,
      rowCount: source.boundedEvidence.rowCount,
      changedRowCount: source.boundedEvidence.changedRowCount
    });
    if (!sameBoundedJpmReceipt(claimed, expected)) {
      throw authorityError(
        'RECON_FIX_JPM_RECEIPT_IDENTITY_CONFLICT',
        'JPM commit:receipt 与 Inspector 同快照 authoritative evidence 不匹配'
      );
    }
    return Object.freeze({ bounded: claimed, inspection: inspected });
  }

  return Object.freeze({ find, verify });
}

module.exports = {
  createReconFixJpmReceiptAuthority
};
