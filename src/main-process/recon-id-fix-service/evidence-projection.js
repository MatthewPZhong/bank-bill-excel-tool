'use strict';

const { createHash } = require('node:crypto');

const RECON_FIX_EVIDENCE_MAX_BYTES = 268435456;
const UNSAFE_INTEGER_KIND = 'recon-fix:unsafe-integer:v1';

// Legacy ReconFix accepts finite JavaScript numbers beyond MAX_SAFE_INTEGER.
// Keep those business values untouched and tag only the hash projection so the
// strict canonicalizer can distinguish a numeric value from the same text.
function reconFixEvidenceProjection(value) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return {
      kind: UNSAFE_INTEGER_KIND,
      decimal: String(value)
    };
  }
  if (Array.isArray(value)) return value.map(reconFixEvidenceProjection);
  if (value && typeof value === 'object') {
    const projected = {};
    for (const key of Object.keys(value)) {
      projected[key] = reconFixEvidenceProjection(value[key]);
    }
    return projected;
  }
  return value;
}

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        evidenceError('CANONICAL_JSON_INVALID_SURROGATE', 'evidence 字符串包含未配对的高位代理项');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      evidenceError('CANONICAL_JSON_INVALID_SURROGATE', 'evidence 字符串包含未配对的低位代理项');
    }
  }
}

// 与 canonicalSha256(reconFixEvidenceProjection(value)) byte-for-byte 等价，
// 但逐 token 更新 hash，避免大 session 同时保留 projected tree + 完整 JCS 字符串。
function hashEvidenceProjection(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes 必须是正安全整数');
  }
  const hash = createHash('sha256');
  const ancestors = new Set();
  let bytes = 0;
  const update = (text) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      evidenceError('CANONICAL_JSON_TOO_LARGE', `canonical JSON 超过 ${maxBytes} UTF-8 bytes`);
    }
    hash.update(text, 'utf8');
  };
  const writeString = (text) => {
    assertUnicodeScalarString(text);
    update(JSON.stringify(text));
  };
  const write = (item) => {
    if (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item)) {
      update('{"decimal":');
      writeString(String(item));
      update(',"kind":');
      writeString(UNSAFE_INTEGER_KIND);
      update('}');
      return;
    }
    if (item === null || typeof item === 'boolean') {
      update(JSON.stringify(item));
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        evidenceError('CANONICAL_JSON_NUMBER_INVALID', 'evidence 数字必须有限');
      }
      update(JSON.stringify(item));
      return;
    }
    if (typeof item === 'string') {
      writeString(item);
      return;
    }
    if (!item || typeof item !== 'object') {
      evidenceError('CANONICAL_JSON_VALUE_INVALID', 'evidence 值不是 JSON 类型');
    }
    if (ancestors.has(item)) evidenceError('CANONICAL_JSON_CYCLE', 'evidence 值包含循环引用');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        update('[');
        for (let index = 0; index < item.length; index += 1) {
          if (index > 0) update(',');
          write(item[index]);
        }
        update(']');
        return;
      }
      update('{');
      const keys = Object.keys(item).sort();
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) update(',');
        writeString(keys[index]);
        update(':');
        write(item[keys[index]]);
      }
      update('}');
    } finally {
      ancestors.delete(item);
    }
  };
  write(value);
  return hash.digest('hex');
}

function reconFixEvidenceSha256(value, options = {}) {
  return hashEvidenceProjection(
    value,
    options.maxBytes === undefined ? RECON_FIX_EVIDENCE_MAX_BYTES : options.maxBytes
  );
}

module.exports = {
  RECON_FIX_EVIDENCE_MAX_BYTES,
  reconFixEvidenceProjection,
  reconFixEvidenceSha256
};
