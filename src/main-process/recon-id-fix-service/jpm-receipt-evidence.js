'use strict';

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');

const HASH = /^[a-f0-9]{64}$/;
const KEYS = Object.freeze([
  'changedRowCount',
  'idSequenceDigest',
  'postImageHash',
  'preImageHash',
  'receiptDigest',
  'rowCount'
].sort());

function exactKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === KEYS.join(',');
}

function normalizeBoundedJpmReceipt(value) {
  if (!exactKeys(value) || !HASH.test(value.receiptDigest || '') ||
      !HASH.test(value.preImageHash || '') || !HASH.test(value.postImageHash || '') ||
      !HASH.test(value.idSequenceDigest || '') ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 ||
      !Number.isSafeInteger(value.changedRowCount) || value.changedRowCount < 1 ||
      value.changedRowCount > value.rowCount || value.preImageHash === value.postImageHash) {
    const error = new TypeError('JPM bounded receipt evidence 非法');
    error.code = 'RECON_FIX_JPM_BOUNDED_RECEIPT_INVALID';
    throw error;
  }
  return Object.freeze({
    receiptDigest: value.receiptDigest,
    preImageHash: value.preImageHash,
    postImageHash: value.postImageHash,
    idSequenceDigest: value.idSequenceDigest,
    rowCount: value.rowCount,
    changedRowCount: value.changedRowCount
  });
}

function boundedJpmReceiptFromExact(receipt) {
  return normalizeBoundedJpmReceipt({
    receiptDigest: canonicalSha256(receipt),
    preImageHash: receipt.preImageHash,
    postImageHash: receipt.postImageHash,
    idSequenceDigest: receipt.idSequenceDigest,
    rowCount: receipt.rowCount,
    changedRowCount: receipt.changedRowCount
  });
}

function sameBoundedJpmReceipt(left, right) {
  const a = normalizeBoundedJpmReceipt(left);
  const b = normalizeBoundedJpmReceipt(right);
  return KEYS.every((key) => a[key] === b[key]);
}

module.exports = {
  boundedJpmReceiptFromExact,
  normalizeBoundedJpmReceipt,
  sameBoundedJpmReceipt
};
