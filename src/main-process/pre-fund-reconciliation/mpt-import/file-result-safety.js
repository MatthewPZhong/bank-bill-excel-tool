'use strict';

const path = require('node:path');

const { financeSafeTextViolation } = require('../../background-execution/error-codec');

const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const ABSOLUTE_PATH_PATTERN = /(?:file:\/\/|(?:^|[\s：:=（(])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?!\/)[^/\s:]+(?:\/[^/\s]+)*))/i;

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
  return fileName && Buffer.byteLength(fileName) <= 1024 && !/[\\/]/.test(fileName) &&
    isSafeMptErrorText(fileName, { maxBytes: 1024 })
    ? fileName
    : 'unknown-file';
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
  isSafeMptDetailLines,
  isSafeMptErrorCode,
  isSafeMptErrorText,
  safeMptFileName,
  toSafeMptErrorFields
};
