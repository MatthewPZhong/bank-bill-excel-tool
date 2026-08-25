'use strict';

const path = require('node:path');

const { financeSafeTextViolation } = require('../../background-execution/error-codec');
const { MPT_SCHEMAS, isMptSourceBatch, parseMptFileName } = require('../mpt-schema');
const { isPreFundMptConflictScopeKey } = require('./conflict-scope');

const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const ABSOLUTE_PATH_PATTERN = /(?:file:\/\/|(?:^|[\s：:=（(])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?!\/)[^/\s:]+(?:\/[^/\s]+)*))/i;
const PREFUND_INTENT_ID_PATTERN = /^prefund-intent-[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREFUND_FILE_OPERATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/file\/[0-9]{6}$/;

function isSafeMptErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODE_PATTERN.test(value);
}

function isSafeMptErrorText(value, { maxBytes = 8192, allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value) <= maxBytes &&
    !ABSOLUTE_PATH_PATTERN.test(value) && !financeSafeTextViolation(value);
}

function safeMptFileName(value) {
  const fileName = typeof value === 'string' ? path.basename(value) : '';
  let canonicalMptFileName = false;
  if (fileName && Buffer.byteLength(fileName) <= 1024 && !/[\\/]/.test(fileName)) {
    try {
      canonicalMptFileName = parseMptFileName(fileName).sourceFileName === fileName;
    } catch (_error) { /* 非MPT文件名继续走通用finance-safe判断。 */ }
  }
  return fileName && Buffer.byteLength(fileName) <= 1024 && !/[\\/]/.test(fileName) &&
    (canonicalMptFileName || isSafeMptErrorText(fileName, { maxBytes: 1024 }))
    ? fileName
    : 'unknown-file';
}

function allowMptFinanceSafeValue({ value, key, parent }) {
  if (typeof value !== 'string') return false;
  if (key === 'intentId') return PREFUND_INTENT_ID_PATTERN.test(value);
  if (key === 'conflictScopeKey') return isPreFundMptConflictScopeKey(value);
  if (key === 'sourceRef') {
    return /^critical-intent:prefund-intent-[a-f0-9]{64}$/.test(value);
  }
  if (key === 'datasetId' || key === 'producerTaskRunId') return UUID_V4_PATTERN.test(value);
  if (key === 'fileOperationKey' || key === 'operationKey') {
    if (!PREFUND_FILE_OPERATION_PATTERN.test(value)) return false;
    if (!parent || !Number.isSafeInteger(parent.fileIndex)) return true;
    return value.endsWith(`/file/${String(parent.fileIndex).padStart(6, '0')}`);
  }
  if (key === 'fileName' || key === 'sourceFileName') {
    return safeMptFileName(value) === value;
  }
  if (key === 'sourceBatch' && parent && typeof parent === 'object' && !Array.isArray(parent) &&
      typeof parent.sourceType === 'string' &&
      isMptSourceBatch(parent.sourceType, value)) {
    if (parent.sourceDate === undefined) return true;
    if (typeof parent.sourceDate !== 'string') return false;
    const batchPrefix = MPT_SCHEMAS[parent.sourceType].batchPrefix;
    const batchDate = value.slice(batchPrefix.length, batchPrefix.length + 8);
    return batchDate === parent.sourceDate.replace(/-/g, '');
  }
  if (key !== 'sourceFileSequence' || !/^[0-9]+$/.test(value) ||
      !parent || typeof parent !== 'object' || Array.isArray(parent) ||
      typeof parent.sourceFileName !== 'string') return false;
  try {
    const parsed = parseMptFileName(parent.sourceFileName);
    return parsed.sourceFileSequence === value &&
      (parent.sourceType === undefined || parsed.sourceType === parent.sourceType) &&
      (parent.sourceDate === undefined || parsed.sourceDate === parent.sourceDate);
  } catch (_error) {
    return false;
  }
}

function safeDetailLines(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return value.filter((line) =>
    isSafeMptErrorText(line, { maxBytes: 2048, allowEmpty: true })).slice(0, maxItems);
}

function toSafeMptErrorFields(error, options = {}) {
  const fallbackCode = isSafeMptErrorCode(options.fallbackCode)
    ? options.fallbackCode
    : 'PREFUND_MPT_FILE_FAILED';
  const fallbackMessage = isSafeMptErrorText(options.fallbackMessage)
    ? options.fallbackMessage
    : 'PreFund MPT处理当前文件失败';
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const rawMessage = error && typeof error.message === 'string' ? error.message : '';
  const maxDetailLines = Number.isSafeInteger(options.maxDetailLines) && options.maxDetailLines >= 0
    ? options.maxDetailLines
    : 100;
  return Object.freeze({
    code: isSafeMptErrorCode(rawCode) ? rawCode : fallbackCode,
    message: isSafeMptErrorText(rawMessage) ? rawMessage : fallbackMessage,
    detailLines: Object.freeze(safeDetailLines(error && error.detailLines, maxDetailLines))
  });
}

function isSafeMptDetailLines(value, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) ||
        !isSafeMptErrorText(value[index], { maxBytes: 2048, allowEmpty: true })) return false;
  }
  return true;
}

module.exports = {
  allowMptFinanceSafeValue,
  isSafeMptDetailLines,
  isSafeMptErrorCode,
  isSafeMptErrorText,
  safeMptFileName,
  toSafeMptErrorFields
};
