'use strict';

const { types: utilTypes } = require('node:util');

const RECEIPTS_TABLE = 'bank_bu_operation_receipts';
const ACTION_KINDS = Object.freeze({
  'bank-bu:import-month': 'import',
  'bank-bu:run': 'run'
});
const ACTION_KEYS = Object.freeze(Object.keys(ACTION_KINDS));
const OPERATION_KINDS = Object.freeze(Object.values(ACTION_KINDS));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
const COMMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EXACT_RECEIPT_KEYS = Object.freeze([
  'actionKey',
  'committedAt',
  'inputEvidenceHash',
  'operationKey',
  'operationKind',
  'producerTaskRunId',
  'sideRunId',
  'yearMonth'
].sort());

function receiptError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('BankBU operation receipt repository需要DatabaseSync');
  }
}

function ownDataKeys(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label}必须是plain non-Proxy对象`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label}不能包含symbol字段`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${label}.${key}必须是enumerable own data property`);
    }
  }
  return keys;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`BankBU receipt ${label}必须是无首尾空格的非空字符串`);
  }
  return value;
}

function requireSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`BankBU receipt ${label}必须是正安全整数`);
  }
  return value;
}

function requireSha256(value, label) {
  const hash = requireText(value, label);
  if (!SHA256_PATTERN.test(hash)) {
    throw new TypeError(`BankBU receipt ${label}必须是SHA-256`);
  }
  return hash;
}

function normalizeReceiptPayload(payload) {
  ownDataKeys(payload, 'BankBU receipt payload');
  const actionKey = requireText(payload.actionKey, 'actionKey');
  const operationKind = requireText(payload.operationKind, 'operationKind');
  if (ACTION_KINDS[actionKey] !== operationKind) {
    throw new TypeError(`BankBU receipt action/operationKind不匹配：${actionKey}/${operationKind}`);
  }
  const yearMonth = requireText(payload.yearMonth, 'yearMonth');
  if (!MONTH_KEY_PATTERN.test(yearMonth)) {
    throw new TypeError('BankBU receipt yearMonth必须为YYYY-MM');
  }
  const sideRunId = payload.sideRunId == null ? null : requireSafeId(payload.sideRunId, 'sideRunId');
  if ((operationKind === 'import' && sideRunId !== null) ||
      (operationKind === 'run' && sideRunId === null)) {
    throw new TypeError(`BankBU receipt sideRunId与${operationKind}不匹配`);
  }
  return Object.freeze({
    actionKey,
    operationKey: requireText(payload.operationKey, 'operationKey'),
    producerTaskRunId: requireText(payload.producerTaskRunId, 'producerTaskRunId'),
    operationKind,
    yearMonth,
    sideRunId,
    inputEvidenceHash: requireSha256(payload.inputEvidenceHash, 'inputEvidenceHash')
  });
}

function mapReceipt(row) {
  if (!row) return null;
  return Object.freeze({
    actionKey: row.action_key,
    operationKey: row.operation_key,
    producerTaskRunId: row.producer_task_run_id,
    operationKind: row.operation_kind,
    yearMonth: row.year_month,
    sideRunId: row.side_run_id == null ? null : Number(row.side_run_id),
    inputEvidenceHash: row.input_evidence_hash,
    committedAt: row.committed_at
  });
}

function normalizeExactOperationReceipt(value) {
  const actualKeys = ownDataKeys(value, 'BankBU authoritative receipt').sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(EXACT_RECEIPT_KEYS)) {
    throw new TypeError('BankBU authoritative receipt字段必须exact');
  }
  const payload = normalizeReceiptPayload(value);
  if (Object.keys(payload).some((key) => value[key] !== payload[key]) ||
      typeof value.committedAt !== 'string' || !COMMITTED_AT_PATTERN.test(value.committedAt)) {
    throw new TypeError('BankBU authoritative receipt类型或值非法');
  }
  return Object.freeze({ ...payload, committedAt: value.committedAt });
}

function sameReceiptPayload(receipt, payload) {
  return Object.keys(payload).every((key) => receipt[key] === payload[key]);
}

function getOperationReceipt(db, actionKey, operationKey) {
  assertDatabase(db);
  return mapReceipt(db.prepare(`
    SELECT * FROM ${RECEIPTS_TABLE}
    WHERE action_key = ? AND operation_key = ?
  `).get(requireText(actionKey, 'actionKey'), requireText(operationKey, 'operationKey')));
}

function hasOperationReceiptTable(db) {
  assertDatabase(db);
  return Boolean(db.prepare(`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(RECEIPTS_TABLE));
}

function insertOperationReceipt(db, rawPayload) {
  assertDatabase(db);
  if (db.isTransaction !== true) {
    throw receiptError(
      'BANK_BU_RECEIPT_TRANSACTION_REQUIRED',
      'BankBU operation receipt必须与side mutation在同一事务写入'
    );
  }
  const payload = normalizeReceiptPayload(rawPayload);
  const inserted = db.prepare(`
    INSERT INTO ${RECEIPTS_TABLE} (
      action_key, operation_key, producer_task_run_id, operation_kind,
      year_month, side_run_id, input_evidence_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(action_key, operation_key) DO NOTHING
  `).run(
    payload.actionKey,
    payload.operationKey,
    payload.producerTaskRunId,
    payload.operationKind,
    payload.yearMonth,
    payload.sideRunId,
    payload.inputEvidenceHash
  );
  const receipt = getOperationReceipt(db, payload.actionKey, payload.operationKey);
  if (!receipt || !sameReceiptPayload(receipt, payload)) {
    throw receiptError(
      'BANK_BU_RECEIPT_IDENTITY_CONFLICT',
      '同一BankBU operationKey已存在不同side receipt'
    );
  }
  return Object.freeze({ created: Number(inserted.changes) === 1, receipt });
}

module.exports = {
  ACTION_KEYS,
  OPERATION_KINDS,
  RECEIPTS_TABLE,
  getOperationReceipt,
  hasOperationReceiptTable,
  insertOperationReceipt,
  normalizeExactOperationReceipt,
  normalizeReceiptPayload
};
