'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { fsyncDirectory } = require('../../background-execution/durable-file');
const { deriveFileIdentity, mptSpoolPaths, spoolError } = require('./spool-contract');
const { assertDirectoryDurable, ensureMptSpoolDirectory } = require('./spool-writer');
const {
  isSafeMptErrorCode,
  isSafeMptErrorText,
  safeMptFileName,
  toSafeMptErrorFields
} = require('./file-result-safety');

const MAX_BYTES = 128 * 1024;
const MAX_DETAIL_LINES = 1000;
const MAX_DETAIL_LINE_BYTES = 2048;
const BASE_FAILURE_KEYS = Object.freeze(['code', 'detailLines', 'fileName', 'message', 'status']);
const CLEANUP_FAILURE_KEYS = Object.freeze([
  ...BASE_FAILURE_KEYS, 'causeCode', 'cleanupRequired', 'cleanupScope'
].sort());

function boundedText(value, label, maxBytes, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value) > maxBytes) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', `Parser error ${label}非法`);
  }
  return value;
}

function exactFileResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'failed') {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser error outcome缺少fileResult');
  }
  const cleanup = value.cleanupRequired === true;
  const expectedKeys = cleanup ? CLEANUP_FAILURE_KEYS : BASE_FAILURE_KEYS;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
      !Array.isArray(value.detailLines) || value.detailLines.length > MAX_DETAIL_LINES ||
      value.detailLines.some((line) => typeof line !== 'string' ||
        Buffer.byteLength(line) > MAX_DETAIL_LINE_BYTES) ||
      (cleanup && (value.cleanupScope !== 'current-file-spool' ||
        (value.causeCode !== null && !isSafeMptErrorCode(value.causeCode))))) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser error fileResult字段非法');
  }
  const fileName = boundedText(value.fileName, 'fileName', 1024);
  if (fileName !== path.basename(fileName) || /[\\/]/.test(fileName)) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser error fileName不得包含路径');
  }
  const code = boundedText(value.code, 'code', 256);
  const message = boundedText(value.message, 'message', 8192);
  if (!isSafeMptErrorCode(code) ||
      !isSafeMptErrorText(message) ||
      value.detailLines.some((line) => !isSafeMptErrorText(line, {
        maxBytes: MAX_DETAIL_LINE_BYTES,
        allowEmpty: true
      }))) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser error不得包含用户路径');
  }
  return Object.freeze({
    status: 'failed',
    fileName,
    code,
    message,
    detailLines: Object.freeze(value.detailLines.slice()),
    ...(cleanup ? {
      cleanupRequired: true,
      cleanupScope: 'current-file-spool',
      causeCode: value.causeCode
    } : {})
  });
}

function toSafeParserFileResult(filePath, error) {
  const fileName = safeMptFileName(filePath);
  const safeError = toSafeMptErrorFields(error, {
    fallbackCode: 'PREFUND_PARSER_WORKER_FAILED',
    fallbackMessage: 'MPT parser worker处理当前文件失败',
    maxDetailLines: MAX_DETAIL_LINES
  });
  const cleanup = error && error.cleanupRequired === true &&
    error.cleanupScope === 'current-file-spool';
  return exactFileResult({
    status: 'failed',
    fileName,
    ...safeError,
    ...(cleanup ? {
      cleanupRequired: true,
      cleanupScope: 'current-file-spool',
      causeCode: isSafeMptErrorCode(error.causeCode)
        ? error.causeCode
        : null
    } : {})
  });
}

function exactOutcome(input, outcome) {
  const identity = deriveFileIdentity(input.parentOperationKey, input.fileIndex);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) ||
      !['spool', 'parser-error'].includes(outcome.kind)) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser outcome非法');
  }
  const fileResult = outcome.kind === 'parser-error' ? exactFileResult(outcome.fileResult) : null;
  return Object.freeze({
    schemaVersion: 1,
    jobId: input.jobId,
    fileIndex: input.fileIndex,
    ...identity,
    outcome: outcome.kind === 'spool'
      ? Object.freeze({ kind: 'spool' })
      : Object.freeze({ kind: 'parser-error', fileResult })
  });
}

function writeParserOutcome(input, outcome) {
  const paths = ensureMptSpoolDirectory(input);
  const sealed = exactOutcome(input, outcome);
  const bytes = Buffer.from(`${JSON.stringify(sealed)}\n`, 'utf8');
  if (bytes.length > MAX_BYTES) throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser outcome过大');
  const fd = fs.openSync(paths.parserOutcomePart, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(paths.parserOutcomePart, paths.parserOutcomeReady);
  assertDirectoryDurable(fsyncDirectory(paths.fileDir));
  return sealed;
}

function readParserOutcome(input) {
  const paths = mptSpoolPaths(input);
  let stat;
  try {
    stat = fs.lstatSync(paths.parserOutcomeReady, { bigint: true });
  } catch (_error) {
    throw spoolError('PREFUND_PARSER_OUTCOME_MISSING', 'Parser outcome未发布');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.size) > MAX_BYTES) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser outcome必须是bounded regular file');
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(paths.parserOutcomeReady, 'utf8')); } catch (_error) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser outcome JSON非法');
  }
  const expected = exactOutcome(input, parsed && parsed.outcome);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw spoolError('PREFUND_PARSER_OUTCOME_INVALID', 'Parser outcome identity或字段不匹配');
  }
  return expected.outcome;
}

module.exports = {
  readParserOutcome,
  toSafeParserFileResult,
  writeParserOutcome
};
