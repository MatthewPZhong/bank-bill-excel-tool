'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('../../backend/bank-bu-recon-db/columns');

const ABSENT_MIRROR_DIGEST = canonicalSha256({ state: 'absent', version: 1 });
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError('BankBU yearMonth必须为YYYY-MM');
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`BankBU ${label}必须是无首尾空格的非空字符串`);
  }
  return value;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalRows(rows, columns) {
  if (!Array.isArray(rows)) throw new TypeError('BankBU rows必须是数组');
  return rows.map((row) => {
    if (!Number.isSafeInteger(row && row._rowIndex) || row._rowIndex < 1) {
      throw new TypeError('BankBU source row index必须是正安全整数');
    }
    return {
      rowIndex: row._rowIndex,
      values: columns.map((column) => String(row[column] != null ? row[column] : ''))
    };
  });
}

function buildRoleEvidence(role, fileSha256, rows, columns) {
  if (!SHA256_PATTERN.test(fileSha256 || '')) throw new TypeError('BankBU文件SHA-256非法');
  const canonical = canonicalRows(rows, columns);
  return Object.freeze({
    role,
    fileSha256,
    rowCount: canonical.length,
    rowsHash: canonicalSha256(canonical)
  });
}

function validateImportEvidence(evidence, { yearMonth, pendingRows, bankRows }) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('BankBU import evidence非法');
  const expected = buildImportEvidence({
    yearMonth,
    pendingFileSha256: evidence.pending && evidence.pending.fileSha256,
    bankFileSha256: evidence.bank && evidence.bank.fileSha256,
    pendingRows,
    bankRows
  });
  const fields = ['pendingEvidenceHash', 'bankEvidenceHash', 'datasetHash'];
  if (evidence.version !== expected.version || evidence.yearMonth !== expected.yearMonth ||
      fields.some((field) => evidence[field] !== expected[field]) ||
      evidence.pending.rowCount !== expected.pending.rowCount ||
      evidence.pending.rowsHash !== expected.pending.rowsHash ||
      evidence.bank.rowCount !== expected.bank.rowCount ||
      evidence.bank.rowsHash !== expected.bank.rowsHash) {
    throw new TypeError('BankBU import evidence与source rows不一致');
  }
  return expected;
}

function buildImportEvidence({ yearMonth, pendingFileSha256, bankFileSha256, pendingRows, bankRows }) {
  const pending = buildRoleEvidence(
    'pending', pendingFileSha256, pendingRows, PENDING_GUANLI_DB_COLUMNS
  );
  const bank = buildRoleEvidence('bank', bankFileSha256, bankRows, BANK_DB_COLUMNS);
  const evidence = Object.freeze({ version: 1, yearMonth: requireMonth(yearMonth), pending, bank });
  return Object.freeze({
    ...evidence,
    pendingEvidenceHash: canonicalSha256(pending),
    bankEvidenceHash: canonicalSha256(bank),
    datasetHash: canonicalSha256(evidence)
  });
}

function normalizeOperationIdentity(value, actionKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('BankBU operation identity必须是plain object');
  }
  if (value.actionKey !== actionKey) throw new TypeError('BankBU actionKey identity不匹配');
  return Object.freeze({
    actionKey,
    operationKey: requireText(value.operationKey, 'operationKey'),
    producerTaskRunId: requireText(value.producerTaskRunId, 'producerTaskRunId')
  });
}

module.exports = {
  ABSENT_MIRROR_DIGEST,
  buildImportEvidence,
  canonicalRows,
  normalizeOperationIdentity,
  requireMonth,
  sha256File,
  validateImportEvidence
};
