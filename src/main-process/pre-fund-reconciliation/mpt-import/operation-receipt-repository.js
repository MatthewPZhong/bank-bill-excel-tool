'use strict';

const RECEIPTS_TABLE = 'pre_fund_operation_receipts';
const ACTION_KEYS = Object.freeze([
  'pre-fund:mpt-import',
  'pre-fund:mpt-repair-import'
]);
const OUTCOME_KINDS = Object.freeze([
  'inserted',
  'replaced',
  'noop-existing-batch'
]);
const ACTION_KEY_SET = new Set(ACTION_KEYS);
const OUTCOME_KIND_SET = new Set(OUTCOME_KINDS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EXACT_RECEIPT_KEYS = Object.freeze([
  'actionKey',
  'batchId',
  'committedAt',
  'contentHash',
  'datasetId',
  'datasetVersionAfter',
  'datasetVersionBefore',
  'fileIndex',
  'id',
  'operationKey',
  'outcomeKind',
  'producerTaskRunId',
  'sourceFileName',
  'sourceSha256'
].sort());

function receiptError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('PreFund operation receipt repository需要DatabaseSync');
  }
}

function requireText(value, label) {
  const text = value == null ? '' : String(value).trim();
  if (!text) throw new TypeError(`PreFund receipt ${label}不能为空`);
  return text;
}

function optionalText(value, label) {
  if (value == null) return null;
  return requireText(value, label);
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`PreFund receipt ${label}必须是>=${minimum}的安全整数`);
  }
  return value;
}

function optionalVersion(value, label) {
  return value == null ? null : requireSafeInteger(value, label);
}

function requireSha256(value, label) {
  const hash = requireText(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new TypeError(`PreFund receipt ${label}必须是SHA-256`);
  }
  return hash;
}

function normalizeReceiptPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('PreFund receipt payload必须是对象');
  }
  const actionKey = requireText(payload.actionKey, 'actionKey');
  if (!ACTION_KEY_SET.has(actionKey)) {
    throw new TypeError(`PreFund receipt actionKey不受支持：${actionKey}`);
  }
  const outcomeKind = requireText(payload.outcomeKind, 'outcomeKind');
  if (!OUTCOME_KIND_SET.has(outcomeKind)) {
    throw new TypeError(`PreFund receipt outcomeKind不受支持：${outcomeKind}`);
  }
  return Object.freeze({
    actionKey,
    operationKey: requireText(payload.operationKey, 'operationKey'),
    producerTaskRunId: requireText(payload.producerTaskRunId, 'producerTaskRunId'),
    fileIndex: requireSafeInteger(payload.fileIndex, 'fileIndex'),
    outcomeKind,
    batchId: requireSafeInteger(payload.batchId, 'batchId', 1),
    datasetId: optionalText(payload.datasetId, 'datasetId'),
    datasetVersionBefore: optionalVersion(payload.datasetVersionBefore, 'datasetVersionBefore'),
    datasetVersionAfter: optionalVersion(payload.datasetVersionAfter, 'datasetVersionAfter'),
    sourceFileName: requireText(payload.sourceFileName, 'sourceFileName'),
    sourceSha256: requireSha256(payload.sourceSha256, 'sourceSha256'),
    contentHash: requireSha256(payload.contentHash, 'contentHash')
  });
}

function mapReceipt(row) {
  if (!row) return null;
  return Object.freeze({
    id: Number(row.id),
    actionKey: row.action_key,
    operationKey: row.operation_key,
    producerTaskRunId: row.producer_task_run_id,
    fileIndex: Number(row.file_index),
    outcomeKind: row.outcome_kind,
    batchId: Number(row.batch_id),
    datasetId: row.dataset_id,
    datasetVersionBefore: row.dataset_version_before == null
      ? null
      : Number(row.dataset_version_before),
    datasetVersionAfter: row.dataset_version_after == null
      ? null
      : Number(row.dataset_version_after),
    sourceFileName: row.source_file_name,
    sourceSha256: row.source_sha256,
    contentHash: row.content_hash,
    committedAt: row.committed_at
  });
}

function normalizeExactOperationReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXACT_RECEIPT_KEYS)) {
    throw new TypeError('PreFund authoritative receipt字段必须exact');
  }
  const payload = normalizeReceiptPayload(value);
  const textFields = [
    'actionKey', 'operationKey', 'producerTaskRunId', 'outcomeKind',
    'sourceFileName', 'sourceSha256', 'contentHash'
  ];
  if (textFields.some((key) => typeof value[key] !== 'string' || value[key] !== payload[key]) ||
      !Number.isSafeInteger(value.id) || value.id < 1 ||
      !Number.isSafeInteger(value.fileIndex) || value.fileIndex !== payload.fileIndex ||
      !Number.isSafeInteger(value.batchId) || value.batchId !== payload.batchId ||
      value.datasetId !== payload.datasetId ||
      value.datasetVersionBefore !== payload.datasetVersionBefore ||
      value.datasetVersionAfter !== payload.datasetVersionAfter ||
      typeof value.committedAt !== 'string' || !COMMITTED_AT_PATTERN.test(value.committedAt)) {
    throw new TypeError('PreFund authoritative receipt类型或值非法');
  }
  const versionShapeValid = payload.datasetId !== null && (
    (payload.outcomeKind === 'inserted' && payload.datasetVersionBefore === null &&
      payload.datasetVersionAfter === 1) ||
    (payload.outcomeKind === 'replaced' && Number.isSafeInteger(payload.datasetVersionBefore) &&
      payload.datasetVersionBefore >= 1 &&
      payload.datasetVersionAfter === payload.datasetVersionBefore + 1) ||
    (payload.outcomeKind === 'noop-existing-batch' &&
      Number.isSafeInteger(payload.datasetVersionBefore) && payload.datasetVersionBefore >= 1 &&
      payload.datasetVersionAfter === payload.datasetVersionBefore)
  );
  if (!versionShapeValid) {
    throw new TypeError('PreFund authoritative receipt outcome/version identity非法');
  }
  return Object.freeze({ id: value.id, ...payload, committedAt: value.committedAt });
}

function sameExactOperationReceipt(left, right) {
  return EXACT_RECEIPT_KEYS.every((key) => left[key] === right[key]);
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
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(RECEIPTS_TABLE));
}

function hasAnyOperationReceipts(db) {
  if (!hasOperationReceiptTable(db)) return false;
  return Boolean(db.prepare(`SELECT 1 AS found FROM ${RECEIPTS_TABLE} LIMIT 1`).get());
}

function sameReceiptPayload(receipt, payload) {
  return receipt.actionKey === payload.actionKey
    && receipt.operationKey === payload.operationKey
    && receipt.producerTaskRunId === payload.producerTaskRunId
    && receipt.fileIndex === payload.fileIndex
    && receipt.outcomeKind === payload.outcomeKind
    && receipt.batchId === payload.batchId
    && receipt.datasetId === payload.datasetId
    && receipt.datasetVersionBefore === payload.datasetVersionBefore
    && receipt.datasetVersionAfter === payload.datasetVersionAfter
    && receipt.sourceFileName === payload.sourceFileName
    && receipt.sourceSha256 === payload.sourceSha256
    && receipt.contentHash === payload.contentHash;
}

function insertOperationReceipt(db, rawPayload) {
  assertDatabase(db);
  if (db.isTransaction !== true) {
    throw receiptError(
      'PREFUND_RECEIPT_TRANSACTION_REQUIRED',
      'PreFund operation receipt必须在业务mutation同一事务内写入'
    );
  }
  const payload = normalizeReceiptPayload(rawPayload);
  const inserted = db.prepare(`
    INSERT INTO ${RECEIPTS_TABLE} (
      action_key, operation_key, producer_task_run_id, file_index, outcome_kind,
      batch_id, dataset_id, dataset_version_before, dataset_version_after,
      source_file_name, source_sha256, content_hash, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(action_key, operation_key) DO NOTHING
  `).run(
    payload.actionKey,
    payload.operationKey,
    payload.producerTaskRunId,
    payload.fileIndex,
    payload.outcomeKind,
    payload.batchId,
    payload.datasetId,
    payload.datasetVersionBefore,
    payload.datasetVersionAfter,
    payload.sourceFileName,
    payload.sourceSha256,
    payload.contentHash
  );
  const receipt = getOperationReceipt(db, payload.actionKey, payload.operationKey);
  if (!receipt || !sameReceiptPayload(receipt, payload)) {
    throw receiptError(
      'PREFUND_RECEIPT_IDENTITY_CONFLICT',
      '同一PreFund fileOperationKey已存在不同operation receipt'
    );
  }
  return Object.freeze({ created: Number(inserted.changes) === 1, receipt });
}

module.exports = {
  ACTION_KEYS,
  OUTCOME_KINDS,
  RECEIPTS_TABLE,
  getOperationReceipt,
  hasAnyOperationReceipts,
  hasOperationReceiptTable,
  insertOperationReceipt,
  normalizeExactOperationReceipt,
  normalizeReceiptPayload,
  sameExactOperationReceipt
};
