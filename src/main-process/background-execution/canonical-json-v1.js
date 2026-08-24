'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { assertJsonSafe } = require('./protocol-validator');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

class CanonicalJsonError extends Error {
  constructor(code, message, path = '/') {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = '/') {
  throw new CanonicalJsonError(code, message, path);
}

function pointer(path, key) {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function assertUnicodeScalarString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('CANONICAL_JSON_INVALID_SURROGATE', '字符串包含未配对的高位代理项', path);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('CANONICAL_JSON_INVALID_SURROGATE', '字符串包含未配对的低位代理项', path);
    }
  }
}

function assertCanonicalValue(value, path = '', ancestors = new Set()) {
  try {
    assertJsonSafe(value, path);
  } catch (_error) {
    fail('CANONICAL_JSON_VALUE_INVALID', '值不是安全的 plain JSON', path || '/');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path || '/');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_NUMBER_INVALID', '数字必须有限', path || '/');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('CANONICAL_JSON_INTEGER_UNSAFE', '整数超出 JavaScript 安全整数范围', path || '/');
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    fail('CANONICAL_JSON_VALUE_INVALID', '值不是 JSON 类型', path || '/');
  }
  if (ancestors.has(value)) fail('CANONICAL_JSON_CYCLE', '值包含循环引用', path || '/');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assertCanonicalValue(value[index], `${path}/${index}`, ancestors);
      }
      return;
    }
    for (const key of Object.keys(value)) {
      assertUnicodeScalarString(key, pointer(path, key));
      assertCanonicalValue(value[key], pointer(path, key), ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeCanonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${serializeCanonical(value[key])}`
  )).join(',')}}`;
}

function canonicalizeJson(value, options = {}) {
  assertCanonicalValue(value);
  const jcs = serializeCanonical(value);
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError('maxBytes 必须是正安全整数');
    }
    const actualBytes = Buffer.byteLength(jcs, 'utf8');
    if (actualBytes > maxBytes) {
      fail('CANONICAL_JSON_TOO_LARGE', `canonical JSON 超过 ${maxBytes} UTF-8 bytes`);
    }
  }
  return jcs;
}

function canonicalSha256(value, options = {}) {
  const jcs = canonicalizeJson(value, options);
  return createHash('sha256').update(jcs, 'utf8').digest('hex');
}

function canonicalJsonSnapshot(value, options = {}) {
  const jcs = canonicalizeJson(value, options);
  const snapshot = JSON.parse(jcs);
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(snapshot);
}

function decodeRawJson(raw, maxBytes) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    fail('CANONICAL_JSON_RAW_TYPE_INVALID', 'raw JSON 必须是 string 或 Buffer');
  }
  if (Buffer.byteLength(raw) > maxBytes) {
    fail('CANONICAL_JSON_RAW_TOO_LARGE', `raw JSON 超过 ${maxBytes} UTF-8 bytes`);
  }
  if (typeof raw === 'string') return raw;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (_error) {
    fail('CANONICAL_JSON_INVALID_UTF8', 'raw JSON 不是合法 UTF-8');
  }
}

function scanStrictJson(text) {
  let index = 0;
  const whitespace = /[\u0009\u000a\u000d\u0020]/;
  const skip = () => { while (whitespace.test(text[index] || '')) index += 1; };
  const syntax = () => fail('CANONICAL_JSON_INVALID_JSON', `JSON 语法错误（offset ${index}）`);

  function stringToken() {
    const start = index;
    if (text[index] !== '"') syntax();
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        try {
          const value = JSON.parse(text.slice(start, index));
          assertUnicodeScalarString(value, '/');
          return value;
        } catch (error) {
          if (error instanceof CanonicalJsonError) throw error;
          syntax();
        }
      }
      if (char === '\\') {
        index += 1;
        const escaped = text[index];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) syntax();
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped || '')) syntax();
        index += 1;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) syntax();
      index += 1;
    }
    syntax();
  }

  function numberToken() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) syntax();
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_NUMBER_INVALID', 'raw JSON 数字必须有限');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('CANONICAL_JSON_INTEGER_UNSAFE', 'raw JSON 整数超出安全范围');
    }
  }

  function value() {
    skip();
    const char = text[index];
    if (char === '"') { stringToken(); return; }
    if (char === '{') { object(); return; }
    if (char === '[') { array(); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    numberToken();
  }

  function object() {
    index += 1;
    skip();
    const keys = new Set();
    if (text[index] === '}') { index += 1; return; }
    while (index < text.length) {
      skip();
      const key = stringToken();
      if (keys.has(key)) fail('CANONICAL_JSON_DUPLICATE_KEY', `raw JSON 含重复 key：${key}`);
      keys.add(key);
      skip();
      if (text[index] !== ':') syntax();
      index += 1;
      value();
      skip();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') syntax();
      index += 1;
    }
    syntax();
  }

  function array() {
    index += 1;
    skip();
    if (text[index] === ']') { index += 1; return; }
    while (index < text.length) {
      value();
      skip();
      if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') syntax();
      index += 1;
    }
    syntax();
  }

  value();
  skip();
  if (index !== text.length) syntax();
}

function parseStrictJson(raw, options = {}) {
  const maxBytes = options.maxBytes === undefined ? 262144 : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes 必须是正安全整数');
  }
  const text = decodeRawJson(raw, maxBytes);
  scanStrictJson(text);
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    fail('CANONICAL_JSON_INVALID_JSON', 'raw JSON 不是合法 JSON');
  }
  assertCanonicalValue(value);
  return canonicalJsonSnapshot(value);
}

module.exports = {
  CanonicalJsonError,
  canonicalJsonSnapshot,
  canonicalSha256,
  canonicalizeJson,
  parseStrictJson
};
