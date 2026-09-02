'use strict';

const RECEIPTS_TABLE = 'recon_fix_adm_operation_receipts';
const ACTION_KEY = 'recon-fix:run-jpm';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECEIPT_INPUT_KEYS = Object.freeze([
  'actionKey',
  'changedRowCount',
  'idSequenceDigest',
  'operationKey',
  'postImageHash',
  'preImageHash',
  'producerTaskRunId',
  'rowCount',
  'scenarioId'
].sort());
const RECEIPT_KEYS = Object.freeze([
  ...RECEIPT_INPUT_KEYS,
  'committedAt'
].sort());

class ReconFixOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconFixOperationReceiptError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReconFixOperationReceiptError(code, message);
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('ReconFix operation receipt repository 需要 DatabaseSync');
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === 'string') || keys.length !== expected.length) {
    return false;
  }
  return keys.slice().sort().every((key, index) => key === expected[index]);
}

function requireText(value, label, maxBytes = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`ReconFix receipt ${label} 必须是有界非空文本`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`ReconFix receipt ${label} 必须是 lowercase SHA-256`);
  }
  return value;
}

function requireCount(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`ReconFix receipt ${label} 必须是 >= ${minimum} 的安全整数`);
  }
  return value;
}

function normalizeReceiptPayload(value) {
  if (!exactKeys(value, RECEIPT_INPUT_KEYS)) {
    throw new TypeError('ReconFix receipt payload 字段必须 exact');
  }
  if (value.actionKey !== ACTION_KEY) {
    throw new TypeError(`ReconFix receipt actionKey 必须是 ${ACTION_KEY}`);
  }
  const rowCount = requireCount(value.rowCount, 'rowCount');
  const changedRowCount = requireCount(value.changedRowCount, 'changedRowCount', 1);
  if (changedRowCount > rowCount) {
    throw new TypeError('ReconFix receipt changedRowCount 不能超过 rowCount');
  }
  const preImageHash = requireHash(value.preImageHash, 'preImageHash');
  const postImageHash = requireHash(value.postImageHash, 'postImageHash');
  if (preImageHash === postImageHash) {
    throw new TypeError('ReconFix noop 不得写 operation receipt');
  }
  return Object.freeze({
    actionKey: ACTION_KEY,
    operationKey: requireText(value.operationKey, 'operationKey'),
    producerTaskRunId: requireText(value.producerTaskRunId, 'producerTaskRunId'),
    scenarioId: requireText(value.scenarioId, 'scenarioId', 256),
    preImageHash,
    postImageHash,
    idSequenceDigest: requireHash(value.idSequenceDigest, 'idSequenceDigest'),
    rowCount,
    changedRowCount
  });
}

function mapReceipt(row) {
  if (!row) return null;
  return Object.freeze({
    actionKey: row.action_key,
    operationKey: row.operation_key,
    producerTaskRunId: row.producer_task_run_id,
    scenarioId: row.scenario_id,
    preImageHash: row.pre_image_hash,
    postImageHash: row.post_image_hash,
    idSequenceDigest: row.id_sequence_digest,
    rowCount: Number(row.row_count),
    changedRowCount: Number(row.changed_row_count),
    committedAt: row.committed_at
  });
}

function normalizeExactReceipt(value) {
  if (!exactKeys(value, RECEIPT_KEYS)) {
    throw new TypeError('ReconFix authoritative receipt 字段必须 exact');
  }
  const payload = normalizeReceiptPayload(Object.fromEntries(
    RECEIPT_INPUT_KEYS.map((key) => [key, value[key]])
  ));
  if (typeof value.committedAt !== 'string' || !COMMITTED_AT_PATTERN.test(value.committedAt)) {
    throw new TypeError('ReconFix authoritative receipt committedAt 非法');
  }
  return Object.freeze({ ...payload, committedAt: value.committedAt });
}

function sameReceiptPayload(receipt, payload) {
  return RECEIPT_INPUT_KEYS.every((key) => receipt[key] === payload[key]);
}

function sameExactReceipt(left, right) {
  return RECEIPT_KEYS.every((key) => left[key] === right[key]);
}

function getOperationReceipt(db, actionKey, operationKey) {
  assertDatabase(db);
  const normalizedActionKey = requireText(actionKey, 'actionKey');
  if (normalizedActionKey !== ACTION_KEY) {
    throw new TypeError(`ReconFix receipt actionKey 必须是 ${ACTION_KEY}`);
  }
  return mapReceipt(db.prepare(`
    SELECT
      action_key,
      operation_key,
      producer_task_run_id,
      scenario_id,
      pre_image_hash,
      post_image_hash,
      id_sequence_digest,
      row_count,
      changed_row_count,
      committed_at
    FROM ${RECEIPTS_TABLE}
    WHERE action_key = ? AND operation_key = ?
  `).get(ACTION_KEY, requireText(operationKey, 'operationKey')));
}

function hasOperationReceiptTable(db) {
  assertDatabase(db);
  return Boolean(db.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(RECEIPTS_TABLE));
}

function insertOperationReceipt(db, rawPayload) {
  assertDatabase(db);
  if (db.isTransaction !== true) {
    fail(
      'RECON_FIX_RECEIPT_TRANSACTION_REQUIRED',
      'ReconFix operation receipt 必须与 ADM mutation 在同一事务写入'
    );
  }
  const payload = normalizeReceiptPayload(rawPayload);
  const existing = getOperationReceipt(db, payload.actionKey, payload.operationKey);
  if (existing) {
    fail(
      sameReceiptPayload(existing, payload)
        ? 'RECON_FIX_RECEIPT_ALREADY_EXISTS'
        : 'RECON_FIX_RECEIPT_IDENTITY_CONFLICT',
      '同一 ReconFix operationKey 已存在 operation receipt，必须交由 E11-B Inspector 判定'
    );
  }
  try {
    db.prepare(`
      INSERT INTO ${RECEIPTS_TABLE} (
        action_key,
        operation_key,
        producer_task_run_id,
        scenario_id,
        pre_image_hash,
        post_image_hash,
        id_sequence_digest,
        row_count,
        changed_row_count,
        committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      payload.actionKey,
      payload.operationKey,
      payload.producerTaskRunId,
      payload.scenarioId,
      payload.preImageHash,
      payload.postImageHash,
      payload.idSequenceDigest,
      payload.rowCount,
      payload.changedRowCount
    );
  } catch (error) {
    let conflict = null;
    try {
      conflict = getOperationReceipt(db, payload.actionKey, payload.operationKey);
    } catch (_readError) {
      // 保留 INSERT 首错；损坏连接/表导致的回读错误不得覆盖原始失败。
    }
    if (conflict) {
      fail(
        sameReceiptPayload(conflict, payload)
          ? 'RECON_FIX_RECEIPT_ALREADY_EXISTS'
          : 'RECON_FIX_RECEIPT_IDENTITY_CONFLICT',
        'ReconFix operation receipt 唯一身份冲突'
      );
    }
    throw error;
  }
  const receipt = normalizeExactReceipt(getOperationReceipt(
    db,
    payload.actionKey,
    payload.operationKey
  ));
  if (!sameReceiptPayload(receipt, payload)) {
    fail('RECON_FIX_RECEIPT_IDENTITY_CONFLICT', 'ReconFix operation receipt 回读身份不一致');
  }
  return receipt;
}

module.exports = {
  ACTION_KEY,
  RECEIPTS_TABLE,
  ReconFixOperationReceiptError,
  getOperationReceipt,
  hasOperationReceiptTable,
  insertOperationReceipt,
  normalizeExactReceipt,
  normalizeReceiptPayload,
  sameExactReceipt,
  sameReceiptPayload
};
