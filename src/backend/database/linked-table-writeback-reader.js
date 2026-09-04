'use strict';

const { FIELD_MAP } = require('../../constants/adm-bank-deposit-fields');
const {
  canonicalSha256,
  parseStrictJson
} = require('../../main-process/background-execution/canonical-json-v1');
const {
  assertJsonSafe
} = require('../../main-process/background-execution/protocol-validator');
const {
  RECON_FIX_EVIDENCE_MAX_BYTES,
  reconFixEvidenceSha256
} = require('../../main-process/recon-id-fix-service/evidence-projection');

const ADM_TABLE = 'linked_adm_bank_deposit';
const ADM_WRITEBACK_SELECT_SQL = `
  SELECT id, raw_json AS rawJsonText
  FROM ${ADM_TABLE}
  ORDER BY id ASC
`;
const ADM_IMAGE_CONTRACT_VERSION = 1;
const MAX_REDACTED_ID_SAMPLES = 5;

class AdmWritebackReaderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AdmWritebackReaderError';
    this.code = code;
    this.corruptedRowCount = Number.isSafeInteger(options.corruptedRowCount)
      ? options.corruptedRowCount
      : 0;
    this.redactedIdSamples = Object.freeze(
      Array.isArray(options.redactedIdSamples)
        ? options.redactedIdSamples.slice(0, MAX_REDACTED_ID_SAMPLES)
        : []
    );
  }
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('JPM ADM writeback reader 需要 DatabaseSync');
  }
}

function redactedIdToken(value) {
  return `adm-id:${canonicalSha256({
    contractVersion: ADM_IMAGE_CONTRACT_VERSION,
    scope: 'recon-fix-adm-row-id-redaction',
    value: String(value)
  }).slice(0, 12)}`;
}

function readerError(code, message, ids) {
  const values = Array.isArray(ids) ? ids : [];
  return new AdmWritebackReaderError(code, message, {
    corruptedRowCount: values.length,
    redactedIdSamples: values
      .slice(0, MAX_REDACTED_ID_SAMPLES)
      .map(redactedIdToken)
  });
}

function parseAdmRawJsonText(rawJsonText, idForEvidence) {
  if (typeof rawJsonText !== 'string') {
    throw readerError(
      'ADM_RAW_JSON_CORRUPTED',
      'ADM raw_json 不是文本，已阻止 JPM 资金写回',
      [idForEvidence]
    );
  }
  let parsed;
  try {
    // 使用平台 duplicate-aware raw parser；坏语法、重复 key、unsafe integer、
    // invalid surrogate 均视为损坏，不能像 legacy reader 一样静默取最后值。
    parsed = structuredClone(parseStrictJson(rawJsonText, {
      maxBytes: RECON_FIX_EVIDENCE_MAX_BYTES
    }));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('ADM raw_json 顶层必须是对象');
    }
  } catch (_error) {
    throw readerError(
      'ADM_RAW_JSON_CORRUPTED',
      'ADM raw_json 损坏，已阻止 JPM 资金写回',
      [idForEvidence]
    );
  }
  return parsed;
}

function assertStrictAscendingIds(ids) {
  let previous = null;
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw readerError(
        'ADM_ROW_ID_INVALID',
        'ADM row id 不是正安全整数，已阻止 JPM 资金写回',
        [id]
      );
    }
    if (previous !== null && id <= previous) {
      throw readerError(
        'ADM_ROW_ID_ORDER_INVALID',
        'ADM row id 顺序不是严格递增，已阻止 JPM 资金写回',
        [previous, id]
      );
    }
    previous = id;
  }
}

function admIdSequenceDigest(idsInput) {
  if (!Array.isArray(idsInput)) throw new TypeError('ADM id sequence 必须是数组');
  const ids = idsInput.map((id) => Number(id));
  assertStrictAscendingIds(ids);
  return canonicalSha256({
    contractVersion: ADM_IMAGE_CONTRACT_VERSION,
    scope: 'recon-fix-adm-id-sequence',
    ids
  });
}

function normalizeImageRows(rowsInput) {
  if (!Array.isArray(rowsInput)) throw new TypeError('ADM image rows 必须是数组');
  const ids = [];
  const rows = rowsInput.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('ADM image row 必须是对象');
    }
    const id = Number(row.id);
    ids.push(id);
    assertJsonSafe(row.parsed);
    if (!row.parsed || typeof row.parsed !== 'object' || Array.isArray(row.parsed)) {
      throw new TypeError('ADM image row.parsed 必须是对象');
    }
    return { id, parsed: row.parsed };
  });
  assertStrictAscendingIds(ids);
  return rows;
}

function admImageHash(rowsInput) {
  const rows = normalizeImageRows(rowsInput);
  return reconFixEvidenceSha256({
    contractVersion: ADM_IMAGE_CONTRACT_VERSION,
    scope: 'recon-fix-adm-image',
    rows
  });
}

function matchFlags(parsed) {
  const value = (key) => Object.prototype.hasOwnProperty.call(parsed, key)
    ? parsed[key]
    : null;
  return Object.freeze({
    reconciliationId: value(FIELD_MAP.admReconFundId),
    channelMatched: value(FIELD_MAP.admChannelMatched),
    gatewayMatched: value(FIELD_MAP.admGatewayMatched)
  });
}

function readAdmRowsForWriteback(db) {
  assertDatabase(db);
  const rawRows = db.prepare(ADM_WRITEBACK_SELECT_SQL).all();
  const invalidIds = [];
  const rows = [];

  for (const rawRow of rawRows) {
    const id = Number(rawRow.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw readerError(
        'ADM_ROW_ID_INVALID',
        'ADM row id 不是正安全整数，已阻止 JPM 资金写回',
        [rawRow.id]
      );
    }
    let parsed;
    try {
      parsed = parseAdmRawJsonText(rawRow.rawJsonText, id);
    } catch (error) {
      if (error && error.code === 'ADM_RAW_JSON_CORRUPTED') {
        invalidIds.push(id);
        continue;
      }
      throw error;
    }
    rows.push(Object.freeze({
      id,
      rawJsonText: rawRow.rawJsonText,
      parsed,
      currentMatchFlags: matchFlags(parsed)
    }));
  }

  if (invalidIds.length > 0) {
    throw readerError(
      'ADM_RAW_JSON_CORRUPTED',
      `ADM raw_json 有 ${invalidIds.length} 行损坏，已阻止 JPM 资金写回`,
      invalidIds
    );
  }

  const ids = rows.map((row) => row.id);
  assertStrictAscendingIds(ids);
  return Object.freeze({
    rows: Object.freeze(rows),
    rowCount: rows.length,
    idSequenceDigest: admIdSequenceDigest(ids),
    imageHash: admImageHash(rows)
  });
}

module.exports = {
  ADM_IMAGE_CONTRACT_VERSION,
  ADM_TABLE,
  ADM_WRITEBACK_SELECT_SQL,
  AdmWritebackReaderError,
  MAX_REDACTED_ID_SAMPLES,
  admIdSequenceDigest,
  admImageHash,
  parseAdmRawJsonText,
  readAdmRowsForWriteback,
  redactedIdToken
};
