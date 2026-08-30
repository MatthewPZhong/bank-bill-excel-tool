'use strict';

const { FIELD_MAP } = require('../../constants/adm-bank-deposit-fields');
const {
  admIdSequenceDigest,
  admImageHash,
  parseAdmRawJsonText
} = require('../../backend/database/linked-table-writeback-reader');
const {
  assertJsonSafe,
  canonicalJsonSnapshot,
  compactJson
} = require('../background-execution/protocol-validator');
const {
  reconFixEvidenceSha256
} = require('./evidence-projection');

const RECON_FIX_JPM_ACTION = 'recon-fix:run-jpm';
const JPM_WRITEBACK_PLAN_CONTRACT_VERSION = 1;
const JPM_BOUNDED_SUMMARY_MAX_BYTES = 16384;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WRITEBACK_FIELDS = Object.freeze([
  FIELD_MAP.admReconFundId,
  FIELD_MAP.admChannelMatched,
  FIELD_MAP.admGatewayMatched
]);
const WRITEBACK_FIELD_SET = new Set(WRITEBACK_FIELDS);
const VALID_PLANS = new WeakSet();

class ReconFixJpmWritebackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconFixJpmWritebackError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReconFixJpmWritebackError(code, message);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === 'string') || keys.length !== expected.length) {
    return false;
  }
  const sortedExpected = [...expected].sort();
  return keys.slice().sort().every((key, index) => key === sortedExpected[index]);
}

function requireExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', `${label} 字段必须 exact`);
  }
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', `${label} 必须是 lowercase SHA-256`);
  }
  return value;
}

function requireText(value, label, maxBytes = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', `${label} 必须是有界非空文本`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', `${label} 必须是非负安全整数`);
  }
  return value;
}

function normalizeBoundedSummary(value) {
  requireExactKeys(value, [
    'fixedRowCount',
    'resultDigest',
    'runKind',
    'unmatchedRowCount',
    'warningCount'
  ], 'boundedSummary');
  if (value.runKind !== 'jpm') {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', 'boundedSummary.runKind 必须是 jpm');
  }
  requireCount(value.fixedRowCount, 'boundedSummary.fixedRowCount');
  requireCount(value.warningCount, 'boundedSummary.warningCount');
  requireCount(value.unmatchedRowCount, 'boundedSummary.unmatchedRowCount');
  requireHash(value.resultDigest, 'boundedSummary.resultDigest');
  assertJsonSafe(value);
  if (Buffer.byteLength(compactJson(value), 'utf8') > JPM_BOUNDED_SUMMARY_MAX_BYTES) {
    fail('RECON_FIX_JPM_PLAN_INPUT_INVALID', 'boundedSummary 超出字节上限');
  }
  return canonicalJsonSnapshot(value);
}

function normalizedSource(sourceEvidence) {
  requireExactKeys(sourceEvidence, [
    'idSequenceDigest',
    'imageHash',
    'rowCount',
    'rows'
  ], 'sourceEvidence');
  if (!Array.isArray(sourceEvidence.rows) ||
      requireCount(sourceEvidence.rowCount, 'sourceEvidence.rowCount') !== sourceEvidence.rows.length) {
    fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence rowCount 与 rows 不一致');
  }
  const sourceIds = [];
  const preRows = [];
  const identityToId = new Map();
  for (const row of sourceEvidence.rows) {
    requireExactKeys(row, [
      'currentMatchFlags',
      'id',
      'parsed',
      'rawJsonText'
    ], 'sourceEvidence row');
    if (!Number.isSafeInteger(row.id) || row.id < 1) {
      fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence row id 非法');
    }
    if (!row.parsed || typeof row.parsed !== 'object' || Array.isArray(row.parsed) ||
        identityToId.has(row.parsed)) {
      fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence parsed identity 非法或重复');
    }
    const pre = canonicalJsonSnapshot(parseAdmRawJsonText(row.rawJsonText, row.id));
    sourceIds.push(row.id);
    preRows.push(Object.freeze({ id: row.id, parsed: pre }));
    identityToId.set(row.parsed, row.id);
  }
  let actualIdDigest;
  try {
    actualIdDigest = admIdSequenceDigest(sourceIds);
  } catch (_error) {
    fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence id 顺序非法');
  }
  if (actualIdDigest !== requireHash(sourceEvidence.idSequenceDigest, 'sourceEvidence.idSequenceDigest')) {
    fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence idSequenceDigest 不匹配');
  }
  const preImageHash = admImageHash(preRows);
  if (preImageHash !== requireHash(sourceEvidence.imageHash, 'sourceEvidence.imageHash')) {
    fail('RECON_FIX_JPM_SOURCE_INVALID', 'sourceEvidence imageHash 不匹配 raw_json preimage');
  }
  return Object.freeze({
    sourceIds: Object.freeze(sourceIds),
    preRows: Object.freeze(preRows),
    identityToId,
    preImageHash,
    idSequenceDigest: actualIdDigest,
    rowCount: preRows.length
  });
}

function withoutWritebackFields(row) {
  const value = {};
  for (const key of Object.keys(row)) {
    if (!WRITEBACK_FIELD_SET.has(key)) value[key] = row[key];
  }
  return value;
}

function rowHash(id, parsed) {
  return admImageHash([{ id, parsed }]);
}

function assertWritebackPostShape(row) {
  if (typeof row[FIELD_MAP.admReconFundId] !== 'string' ||
      ![0, 1].includes(row[FIELD_MAP.admChannelMatched]) ||
      ![0, 1].includes(row[FIELD_MAP.admGatewayMatched])) {
    fail(
      'RECON_FIX_JPM_WRITEBACK_VALUE_INVALID',
      'JPM ADM writeback 字段必须是字符串资金对账ID与 0/1 数值标志'
    );
  }
}

function buildJpmWritebackPlan(input) {
  requireExactKeys(input, [
    'admUpdates',
    'boundedSummary',
    'operationKey',
    'resultHandle',
    'sourceEvidence'
  ], 'JPM writeback plan input');
  const operationKey = requireText(input.operationKey, 'operationKey');
  const resultHandle = requireHash(input.resultHandle, 'resultHandle');
  const boundedSummary = normalizeBoundedSummary(input.boundedSummary);
  const source = normalizedSource(input.sourceEvidence);
  if (!Array.isArray(input.admUpdates) || input.admUpdates.length !== source.rowCount) {
    fail('RECON_FIX_JPM_ROW_COUNT_CHANGED', 'JPM engine ADM 行数发生变化');
  }

  const seenIds = new Set();
  const candidateIds = [];
  for (const candidate of input.admUpdates) {
    const id = source.identityToId.get(candidate);
    if (!id || seenIds.has(id)) {
      fail(
        'RECON_FIX_JPM_ROW_IDENTITY_CHANGED',
        'JPM engine 返回外来、缺失或重复的 ADM row identity'
      );
    }
    seenIds.add(id);
    candidateIds.push(id);
  }
  let candidateDigest;
  try {
    candidateDigest = admIdSequenceDigest(candidateIds);
  } catch (_error) {
    fail('RECON_FIX_JPM_ID_SEQUENCE_CHANGED', 'JPM engine 改变了 ADM id 顺序');
  }
  if (candidateDigest !== source.idSequenceDigest) {
    fail('RECON_FIX_JPM_ID_SEQUENCE_CHANGED', 'JPM engine 改变了 ADM id 序列');
  }

  const preById = new Map(source.preRows.map((row) => [row.id, row.parsed]));
  const changedRows = [];
  const postRows = [];
  for (const candidate of input.admUpdates) {
    const id = source.identityToId.get(candidate);
    const expectedPre = preById.get(id);
    assertJsonSafe(candidate);
    const expectedPost = canonicalJsonSnapshot(candidate);
    if (reconFixEvidenceSha256(withoutWritebackFields(expectedPre)) !==
        reconFixEvidenceSha256(withoutWritebackFields(expectedPost))) {
      fail(
        'RECON_FIX_JPM_FIELD_SCOPE_VIOLATION',
        'JPM engine 改变了 ADM 非 writeback 字段'
      );
    }
    const expectedPreHash = rowHash(id, expectedPre);
    const expectedPostHash = rowHash(id, expectedPost);
    if (expectedPreHash !== expectedPostHash) {
      assertWritebackPostShape(expectedPost);
      changedRows.push(Object.freeze({
        id,
        expectedPre,
        expectedPost,
        expectedPreHash,
        expectedPostHash
      }));
    }
    postRows.push(Object.freeze({ id, parsed: expectedPost }));
  }

  const expectedPostImageHash = admImageHash(postRows);
  const outcome = changedRows.length === 0 || source.preImageHash === expectedPostImageHash
    ? 'noop'
    : 'mutation-required';
  if (outcome === 'noop' && changedRows.length !== 0) {
    fail('RECON_FIX_JPM_NOOP_INCONSISTENT', 'JPM noop changedRows 与 image hash 不一致');
  }

  const plan = Object.freeze({
    contractVersion: JPM_WRITEBACK_PLAN_CONTRACT_VERSION,
    actionKey: RECON_FIX_JPM_ACTION,
    operationKey,
    outcome,
    sourceEvidence: Object.freeze({
      rowCount: source.rowCount,
      idSequenceDigest: source.idSequenceDigest,
      imageHash: source.preImageHash
    }),
    preImageHash: source.preImageHash,
    expectedPostImageHash,
    idSequenceDigest: source.idSequenceDigest,
    rowCount: source.rowCount,
    changedRowCount: changedRows.length,
    changedRows: Object.freeze(changedRows),
    resultHandle,
    boundedSummary
  });
  VALID_PLANS.add(plan);
  return plan;
}

function assertJpmWritebackPlan(plan) {
  if (!plan || !VALID_PLANS.has(plan)) {
    fail('RECON_FIX_JPM_PLAN_INVALID', 'JPM writeback plan 不是本进程构造的可信 plan');
  }
  return plan;
}

function buildJpmNoopResult(planInput) {
  const plan = assertJpmWritebackPlan(planInput);
  if (plan.outcome !== 'noop') {
    fail('RECON_FIX_JPM_NOOP_REQUIRED', '只有 exact noop plan 可构造 noop result');
  }
  return Object.freeze({
    resultKind: 'noop',
    resultHandle: plan.resultHandle,
    boundedSummary: plan.boundedSummary
  });
}

module.exports = {
  JPM_BOUNDED_SUMMARY_MAX_BYTES,
  JPM_WRITEBACK_PLAN_CONTRACT_VERSION,
  RECON_FIX_JPM_ACTION,
  ReconFixJpmWritebackError,
  WRITEBACK_FIELDS,
  assertJpmWritebackPlan,
  buildJpmNoopResult,
  buildJpmWritebackPlan
};
