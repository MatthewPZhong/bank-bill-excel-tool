'use strict';

const crypto = require('node:crypto');
const {
  SOURCE_TYPES,
  PENDING_RAW_CONTRACT_V1,
  PENDING_RAW_CONTRACT_V2,
  PENDING_HEADERS,
  PENDING_V1_HEADERS
} = require('./definitions');

const HASH_VERSION = 2;
const PENDING_HASH_VERSION = 3;

function contentHash(sourceType, rawJson, assignedSubject) {
  const payload = sourceType === SOURCE_TYPES.CHANNEL
    ? JSON.stringify({ raw: rawJson, assignedSubject: String(assignedSubject == null ? '' : assignedSubject).trim() })
    : rawJson;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function pendingCanonicalValues(values, rawContractVersion) {
  const source = Array.isArray(values) ? values : [];
  const version = Number(rawContractVersion);
  if (version === PENDING_RAW_CONTRACT_V2 && source.length === PENDING_HEADERS.length) {
    return [...source];
  }
  if (version === PENDING_RAW_CONTRACT_V1 && source.length === PENDING_V1_HEADERS.length) {
    const byHeader = Object.fromEntries(PENDING_V1_HEADERS.map((header, index) => [header, source[index]]));
    return PENDING_HEADERS.map((header) => byHeader[header]);
  }
  throw new Error(
    `Pending 原始契约 v${version || 'unknown'} 字段数无效：${source.length}`
  );
}

function pendingContentHash(values, rawContractVersion) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(pendingCanonicalValues(values, rawContractVersion)), 'utf8')
    .digest('hex');
}

module.exports = {
  HASH_VERSION,
  PENDING_HASH_VERSION,
  contentHash,
  pendingCanonicalValues,
  pendingContentHash
};
