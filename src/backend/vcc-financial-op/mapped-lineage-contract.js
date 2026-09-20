'use strict';

const { SOURCE_TYPES } = require('./definitions');
const {
  HASH_VERSION,
  PENDING_HASH_VERSION,
  contentHash,
  pendingContentHash
} = require('./content-hash-contract');

const LEGACY_DETAIL_HASH_VERSION = 1;
const LEGACY_PENDING_HASH_VERSION = 2;

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mappedContentHashForStoredVersion(expected, mapped) {
  const storedVersion = Number(expected.hash_version);
  if (expected.source_type === SOURCE_TYPES.PENDING) {
    if (storedVersion === PENDING_HASH_VERSION) return mapped.contentHash;
    if (storedVersion === LEGACY_PENDING_HASH_VERSION) {
      return pendingContentHash(mapped.values, mapped.rawContractVersion);
    }
  } else {
    if (storedVersion === HASH_VERSION) return mapped.contentHash;
    if (storedVersion === LEGACY_DETAIL_HASH_VERSION) {
      return contentHash(
        expected.source_type,
        JSON.stringify(mapped.values),
        expected.subject
      );
    }
  }
  throw exportError(
    'archive-row-integrity-failure',
    `导入记录 ${expected.import_record_id} 原表第 ${expected.source_row} 行使用未知内容哈希版本 ${expected.hash_version}`
  );
}

function assertMappedLineage(expected, mapped) {
  const reconstructedContentHash = mapped.disposition
    ? null
    : mappedContentHashForStoredVersion(expected, mapped);
  if (mapped.disposition
      || mapped.idempotencyKey !== expected.idempotency_key
      || reconstructedContentHash !== expected.content_hash) {
    throw exportError(
      'archive-row-integrity-failure',
      `导入记录 ${expected.import_record_id} 原表第 ${expected.source_row} 行与当前有效数据的幂等键或内容哈希不一致`
    );
  }
}

module.exports = {
  assertMappedLineage,
  mappedContentHashForStoredVersion
};
