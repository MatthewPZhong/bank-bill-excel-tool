'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeSourceSnapshot } = require('../../archive-center/source-snapshot');

const MPT_SPOOL_SCHEMA_VERSION = 1;
const MPT_SPOOL_MAX_FILE_INDEX = 999999;
const MPT_SPOOL_MAX_MANIFEST_BYTES = 64 * 1024;
const MPT_SPOOL_MAX_NDJSON_LINE_BYTES = 64 * 1024 * 1024;
const MPT_SPOOL_FILE_NAMES = Object.freeze({
  rowsPart: 'rows.ndjson.part',
  rowsReady: 'rows.ndjson.ready',
  issuesPart: 'issues.ndjson.part',
  issuesReady: 'issues.ndjson.ready',
  manifestPart: 'manifest.json.part',
  manifestReady: 'manifest.json.ready'
});

class MptSpoolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'MptSpoolError';
    this.code = code;
    this.details = details;
  }
}

function spoolError(code, message, details) {
  return new MptSpoolError(code, message, details);
}

function requiredText(value, label, maxLength = 2048) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', `${label}不能为空且长度不能超过${maxLength}`);
  }
  return text;
}

function normalizeJobId(value) {
  const jobId = requiredText(value, 'jobId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'jobId不能用于安全的任务私有目录');
  }
  return jobId;
}

function normalizeFileIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MPT_SPOOL_MAX_FILE_INDEX) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'fileIndex必须是0..999999安全整数');
  }
  return value;
}

function paddedFileIndex(fileIndex) {
  return String(normalizeFileIndex(fileIndex)).padStart(6, '0');
}

function deriveFileIdentity(parentOperationKey, fileIndex) {
  const parent = requiredText(parentOperationKey, 'parentOperationKey');
  const padded = paddedFileIndex(fileIndex);
  return Object.freeze({
    fileOperationKey: `${parent}/file/${padded}`,
    unitId: `file:${padded}`
  });
}

function normalizeTaskStagingDir(value) {
  const directory = path.normalize(requiredText(value, 'taskStagingDir', 4096));
  if (!path.isAbsolute(directory)) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'taskStagingDir必须是绝对路径');
  }
  return directory;
}

function mptSpoolPaths({ taskStagingDir, jobId, fileIndex }) {
  const staging = normalizeTaskStagingDir(taskStagingDir);
  const normalizedJobId = normalizeJobId(jobId);
  const padded = paddedFileIndex(fileIndex);
  const mptDir = path.join(staging, 'mpt');
  const jobDir = path.join(mptDir, normalizedJobId);
  const fileDir = path.join(jobDir, `file-${padded}`);
  const paths = { taskStagingDir: staging, mptDir, jobDir, fileDir };
  for (const [key, basename] of Object.entries(MPT_SPOOL_FILE_NAMES)) {
    paths[key] = path.join(fileDir, basename);
  }
  return Object.freeze(paths);
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'source必须是对象');
  }
  const filePath = path.normalize(requiredText(value.filePath, 'source.filePath', 4096));
  if (!path.isAbsolute(filePath)) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'source.filePath必须是绝对路径');
  }
  const sourceSnapshot = normalizeSourceSnapshot(value.sourceSnapshot);
  if (!sourceSnapshot) {
    throw spoolError('PREFUND_SPOOL_CONTRACT_INVALID', 'source.sourceSnapshot非法');
  }
  return Object.freeze({
    filePath,
    sourceSnapshot: Object.freeze({ ...sourceSnapshot })
  });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function buildHeaderIdentity(header) {
  return sha256Text(stableJson({
    sourceType: header.sourceType,
    sourceBatch: header.sourceBatch,
    sourceDate: header.sourceDate,
    sourceFileName: header.sourceFileName,
    sourceFileSequence: header.sourceFileSequence,
    declaredRowCount: header.declaredRowCount
  }));
}

module.exports = {
  MPT_SPOOL_FILE_NAMES,
  MPT_SPOOL_MAX_FILE_INDEX,
  MPT_SPOOL_MAX_MANIFEST_BYTES,
  MPT_SPOOL_MAX_NDJSON_LINE_BYTES,
  MPT_SPOOL_SCHEMA_VERSION,
  MptSpoolError,
  buildHeaderIdentity,
  deriveFileIdentity,
  mptSpoolPaths,
  normalizeFileIndex,
  normalizeJobId,
  normalizeSource,
  normalizeTaskStagingDir,
  spoolError,
  stableJson
};
