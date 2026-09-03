'use strict';

const { types: utilTypes } = require('node:util');

const SAFE_ERROR_KEYS = Object.freeze(['code', 'message', 'stage', 'detailLines']);
const DEFAULT_SAFE_ERROR_MAX_BYTES = 65536;
const DEFAULT_SAFE_ERROR_MAX_ITEMS = 100;
const REDACTED_TEXT = '[redacted by finance-safe-v1]';

const PRIVATE_KEY_PATTERNS = Object.freeze([
  /^(?:full)?account(?:number|no)?$/i,
  /^bankaccount(?:number|no)?$/i,
  /^order(?:id|number|no)$/i,
  /^recon(?:id|number|no)$/i,
  /^(?:raw|source)(?:row|rows)$/i,
  /^(?:amount|credit|debit)(?:detail|details|items|rows)?$/i,
  /^(?:user|home)(?:path|dir|directory)$/i
]);
const PRIVATE_RAW_KEY_PATTERN = /(?:完整)?(?:账号|账户)|订单号|对账(?:ID|编号)|原始(?:行|数据行)|金额明细|用户(?:路径|目录)/i;
const PRIVATE_VALUE_LABEL_PATTERN = /(?:\b(?:fullaccount(?:number|no)?|bankaccount(?:number|no)?|account(?:number|no)|order(?:id|number|no)|recon(?:id|number|no)|(?:raw|source)(?:row|rows)|(?:amount|credit|debit)(?:detail|details|items|rows)|(?:user|home)(?:path|dir|directory))\b|(?:完整)?(?:账号|账户)|订单号|对账(?:ID|编号)|原始(?:行|数据行)|金额明细|用户(?:路径|目录))\s*(?:=|:|：)\s*\S+/iu;
const USER_PATH_PATTERN =
  /(?:^|[^A-Za-z0-9/\\])(?:file:(?:\/\/)?)?(?:[\\/]+(?:Users|home)[\\/]+|[A-Za-z]:[\\/]+Users[\\/]+)/i;
const LOCAL_FILE_URL_HOST_PATTERN = /file:\/\/localhost(?=[\\/])/gi;
const FULL_ACCOUNT_PATTERN = /(?:^|\D)\d(?:[ -]?\d){11,31}(?:\D|$)/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_DIGEST_FIELDS = new Set([
  'sha256',
  'sourceSha256',
  'contentHash',
  'expectedContentHash',
  'evidenceHash',
  'outputPlanHash'
]);
const FILE_PLAN_ARTIFACT_KEY_PATTERN = /^(?:input|output)-[a-f0-9]{64}$/;
const FILE_PLAN_ARTIFACT_KEY_FIELDS = new Set(['artifactKey', 'outputArtifactKey']);

class SafeErrorValidationError extends Error {
  constructor(code, message, path = '/') {
    super(message);
    this.name = 'SafeErrorValidationError';
    this.code = code;
    this.path = path;
  }
}

function utf8Size(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function truncateUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function normalizedPrivacyKey(key) {
  return String(key).replace(/[^A-Za-z0-9]/g, '');
}

function financeSafeTextViolation(value, role = 'value') {
  if (typeof value !== 'string') return null;
  if (role === 'key') {
    const normalized = normalizedPrivacyKey(value);
    if (PRIVATE_RAW_KEY_PATTERN.test(value) || PRIVATE_KEY_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return 'private-field';
    }
  }
  const pathCandidate = value.replace(LOCAL_FILE_URL_HOST_PATTERN, '');
  if (USER_PATH_PATTERN.test(pathCandidate)) return 'user-directory';
  if (FULL_ACCOUNT_PATTERN.test(value)) return 'full-account';
  if (PRIVATE_VALUE_LABEL_PATTERN.test(value)) return 'private-field-value';
  return null;
}

function privacyViolation(value, path = '', options = {}, parent = null, key = null) {
  if (typeof value === 'string') {
    if (typeof options.allowValue === 'function') {
      try {
        if (options.allowValue(Object.freeze({ value, path: path || '/', parent, key })) === true) {
          return null;
        }
      } catch (_error) { /* domain delegate异常时继续走通用fail-closed判断。 */ }
    }
    const kind = financeSafeTextViolation(value);
    return kind ? { path: path || '/', kind } : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (utilTypes.isProxy(value)) return { path: path || '/', kind: 'unsafe-container' };
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && lengthDescriptor.value;
    for (let index = 0; Number.isInteger(length) && index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return { path: `${path}/${index}`, kind: 'unsafe-container' };
      }
      const violation = privacyViolation(
        descriptor.value,
        `${path}/${index}`,
        options,
        value,
        String(index)
      );
      if (violation) return violation;
    }
    return null;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return { path: path || '/', kind: 'unsafe-container' };
    const childPath = `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const keyViolation = financeSafeTextViolation(key, 'key');
    if (keyViolation) return { path: childPath, kind: keyViolation };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { path: childPath, kind: 'unsafe-container' };
    }
    const fieldValue = descriptor.value;
    const isSha256Digest = SHA256_DIGEST_FIELDS.has(key)
      && typeof fieldValue === 'string'
      && SHA256_PATTERN.test(fieldValue);
    const isFilePlanArtifactKey = FILE_PLAN_ARTIFACT_KEY_FIELDS.has(key)
      && typeof fieldValue === 'string'
      && FILE_PLAN_ARTIFACT_KEY_PATTERN.test(fieldValue);
    if (isSha256Digest || isFilePlanArtifactKey) {
      continue;
    }
    const violation = privacyViolation(fieldValue, childPath, options, value, key);
    if (violation) return violation;
  }
  return null;
}

function assertFinanceSafeValue(value, privacyProfile = 'finance-safe-v1', path = '', options = {}) {
  if (privacyProfile !== 'finance-safe-v1') {
    throw new SafeErrorValidationError(
      'PRIVACY_PROFILE_UNSUPPORTED',
      `Unsupported privacy profile: ${privacyProfile}`,
      path || '/'
    );
  }
  const violation = privacyViolation(value, path, options);
  if (violation) {
    throw new SafeErrorValidationError(
      'PRIVACY_VALUE_FORBIDDEN',
      `finance-safe-v1 rejected ${violation.kind}`,
      violation.path
    );
  }
  return value;
}

function sanitizeText(value, fallback) {
  const text = typeof value === 'string' && value.length ? value : fallback;
  return financeSafeTextViolation(text) ? REDACTED_TEXT : text;
}

function sanitizeFinanceSafeValue(value, role = 'value', ancestors = new Set()) {
  if (typeof value === 'string') return financeSafeTextViolation(value, role) ? REDACTED_TEXT : value;
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value !== 'object' || utilTypes.isProxy(value) || ancestors.has(value)) return REDACTED_TEXT;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor && lengthDescriptor.value;
      if (!Number.isInteger(length) || length < 0) return REDACTED_TEXT;
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return REDACTED_TEXT;
        result.push(sanitizeFinanceSafeValue(descriptor.value, 'value', ancestors));
      }
      return Object.freeze(result);
    }
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return REDACTED_TEXT;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return REDACTED_TEXT;
      result[key] = financeSafeTextViolation(key, 'key')
        ? REDACTED_TEXT
        : sanitizeFinanceSafeValue(descriptor.value, 'value', ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function errorData(value, key) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return undefined;
  let current = value;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function exactSafeErrorObject(value) {
  if (utilTypes.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SafeErrorValidationError('SAFE_ERROR_TYPE_INVALID', 'SafeErrorV1 must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== SAFE_ERROR_KEYS.length || SAFE_ERROR_KEYS.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== 'string')) {
    throw new SafeErrorValidationError(
      'SAFE_ERROR_KEYS_INVALID',
      `SafeErrorV1 must contain exactly ${SAFE_ERROR_KEYS.join(', ')}`
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new SafeErrorValidationError(
        'SAFE_ERROR_KEYS_INVALID',
        'SafeErrorV1 fields must be enumerable own data properties',
        `/${key}`
      );
    }
  }
}

function safeErrorDetailLines(value) {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new SafeErrorValidationError(
      'SAFE_ERROR_DETAIL_LINES_INVALID',
      'SafeErrorV1 detailLines must be a plain array of strings',
      '/detailLines'
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new SafeErrorValidationError(
      'SAFE_ERROR_DETAIL_LINES_INVALID',
      'SafeErrorV1 detailLines has an invalid length',
      '/detailLines'
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      throw new SafeErrorValidationError(
        'SAFE_ERROR_DETAIL_LINES_INVALID',
        'SafeErrorV1 detailLines must contain only array indexes',
        '/detailLines'
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new SafeErrorValidationError(
        'SAFE_ERROR_DETAIL_LINES_INVALID',
        'SafeErrorV1 detailLines entries must be enumerable own data properties',
        `/detailLines/${key}`
      );
    }
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true || typeof descriptor.value !== 'string') {
      throw new SafeErrorValidationError(
        'SAFE_ERROR_DETAIL_LINES_INVALID',
        'SafeErrorV1 detailLines must be a dense array of strings',
        `/detailLines/${index}`
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

function validateSafeErrorV1(value, options = {}) {
  exactSafeErrorObject(value);
  for (const field of ['code', 'message', 'stage']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new SafeErrorValidationError(
        'SAFE_ERROR_STRING_INVALID',
        `SafeErrorV1 ${field} must be a non-empty string`,
        `/${field}`
      );
    }
  }
  const detailLines = safeErrorDetailLines(value.detailLines);
  const maxErrorItems = Number.isInteger(options.maxErrorItems) && options.maxErrorItems >= 0
    ? options.maxErrorItems
    : DEFAULT_SAFE_ERROR_MAX_ITEMS;
  if (detailLines.length > maxErrorItems) {
    throw new SafeErrorValidationError(
      'SAFE_ERROR_ITEMS_EXCEEDED',
      `SafeErrorV1 detailLines exceeds maxErrorItems=${maxErrorItems}`,
      '/detailLines'
    );
  }
  assertFinanceSafeValue(value, options.privacyProfile || 'finance-safe-v1');
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_SAFE_ERROR_MAX_BYTES;
  const actualBytes = utf8Size(value);
  if (actualBytes > maxBytes) {
    throw new SafeErrorValidationError(
      'SAFE_ERROR_TOO_LARGE',
      `SafeErrorV1 exceeds ${maxBytes} UTF-8 bytes`,
      '/'
    );
  }
  return value;
}

function toProtocolError(error, fallbackCode = 'BACKGROUND_EXECUTION_ERROR', options = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const maxErrorItems = Number.isInteger(options.maxErrorItems) && options.maxErrorItems >= 0
    ? options.maxErrorItems
    : DEFAULT_SAFE_ERROR_MAX_ITEMS;
  const sourceDetailLines = errorData(source, 'detailLines');
  let ownedDetailLines = [];
  try {
    ownedDetailLines = safeErrorDetailLines(sourceDetailLines);
  } catch (_error) {}
  const detailLines = ownedDetailLines
    .slice(0, maxErrorItems)
    .map((line) => sanitizeText(line, REDACTED_TEXT));
  const value = {
    code: truncateUtf8(sanitizeText(errorData(source, 'code'), fallbackCode), 128) || fallbackCode,
    message: truncateUtf8(sanitizeText(errorData(source, 'message'), 'background execution failed'), 4096) ||
      'background execution failed',
    stage: truncateUtf8(sanitizeText(errorData(source, 'stage'), options.stage || 'execute'), 128) || 'execute',
    detailLines: detailLines.map((line) => truncateUtf8(line, 2048))
  };
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_SAFE_ERROR_MAX_BYTES;
  while (value.detailLines.length && utf8Size(value) > maxBytes) value.detailLines.pop();
  if (utf8Size(value) > maxBytes) value.message = REDACTED_TEXT;
  if (utf8Size(value) > maxBytes) value.stage = 'execute';
  if (utf8Size(value) > maxBytes) value.code = fallbackCode;
  return Object.freeze({
    code: value.code,
    message: value.message,
    stage: value.stage,
    detailLines: Object.freeze(value.detailLines)
  });
}

function fromProtocolError(value) {
  validateSafeErrorV1(value);
  const error = new Error(value.message);
  error.code = value.code;
  error.stage = value.stage;
  error.detailLines = value.detailLines.slice();
  return error;
}

module.exports = {
  DEFAULT_SAFE_ERROR_MAX_BYTES,
  DEFAULT_SAFE_ERROR_MAX_ITEMS,
  REDACTED_TEXT,
  SAFE_ERROR_KEYS,
  SafeErrorValidationError,
  assertFinanceSafeValue,
  financeSafeTextViolation,
  fromProtocolError,
  privacyViolation,
  sanitizeFinanceSafeValue,
  toProtocolError,
  validateSafeErrorV1
};
