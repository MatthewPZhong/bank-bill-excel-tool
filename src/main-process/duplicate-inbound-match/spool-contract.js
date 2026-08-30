'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeSourceSnapshot } = require('../archive-center/source-snapshot');

const DUPLICATE_SPOOL_SCHEMA_VERSION = 1;
const DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION = 1;
const DUPLICATE_SPOOL_MAX_MANIFEST_BYTES = 64 * 1024;
const DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
const DUPLICATE_INPUT_ROLES = Object.freeze({ BANK: 'bank', DOCUMENT: 'document' });
const DUPLICATE_SPOOL_FILE_NAMES = Object.freeze({
  rowsPart: 'rows.ndjson.part',
  rowsReady: 'rows.ndjson.ready',
  manifestPart: 'manifest.json.part',
  manifestReady: 'manifest.json.ready',
  outcomePart: 'parser-outcome.json.part',
  outcomeReady: 'parser-outcome.json.ready'
});

class DuplicateSpoolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DuplicateSpoolError';
    this.code = code;
    this.details = details;
  }
}

function spoolError(code, message, details = null) {
  return new DuplicateSpoolError(code, message, details);
}

function requiredText(value, label, maxLength = 2048) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      value.length > maxLength) {
    throw spoolError(
      'DUPLICATE_SPOOL_CONTRACT_INVALID',
      `${label}不能为空、不能包含首尾空白且长度不能超过${maxLength}`
    );
  }
  return value;
}

function normalizeJobId(value) {
  const jobId = requiredText(value, 'jobId', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'jobId必须符合Platform safeKey');
  }
  return jobId;
}

function normalizeSlotIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'slotIndex必须是0或1');
  }
  return value;
}

function deriveSlotIdentity(slotIndex) {
  const slot = normalizeSlotIndex(slotIndex);
  return Object.freeze({ slotIndex: slot, unitId: `slot:${slot}` });
}

function normalizeTaskStagingDir(value) {
  const directory = path.normalize(requiredText(value, 'taskStagingDir', 4096));
  if (!path.isAbsolute(directory)) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'taskStagingDir必须是绝对路径');
  }
  return directory;
}

function jobDirectoryToken(jobId) {
  return `job-${crypto.createHash('sha256').update(normalizeJobId(jobId), 'utf8').digest('hex')}`;
}

function duplicateSpoolPaths({ taskStagingDir, jobId, slotIndex }) {
  const staging = normalizeTaskStagingDir(taskStagingDir);
  const pairedDir = path.join(staging, 'duplicate-paired');
  const jobDir = path.join(pairedDir, jobDirectoryToken(jobId));
  const slotDir = path.join(jobDir, `slot-${normalizeSlotIndex(slotIndex)}`);
  const result = { taskStagingDir: staging, pairedDir, jobDir, slotDir };
  for (const [key, basename] of Object.entries(DUPLICATE_SPOOL_FILE_NAMES)) {
    result[key] = path.join(slotDir, basename);
  }
  return Object.freeze(result);
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'source必须是对象');
  }
  const filePath = path.normalize(requiredText(value.filePath, 'source.filePath', 4096));
  if (!path.isAbsolute(filePath)) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'source.filePath必须是绝对路径');
  }
  return Object.freeze({ filePath });
}

function normalizeSpoolDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'spool descriptor必须是对象');
  }
  const identity = deriveSlotIdentity(value.slotIndex);
  if (value.unitId !== identity.unitId) {
    throw spoolError('DUPLICATE_SPOOL_CONTRACT_INVALID', 'spool unitId与slotIndex不匹配');
  }
  return Object.freeze({
    taskStagingDir: normalizeTaskStagingDir(value.taskStagingDir),
    jobId: normalizeJobId(value.jobId),
    operationKey: requiredText(value.operationKey, 'operationKey'),
    producerTaskRunId: requiredText(value.producerTaskRunId, 'producerTaskRunId'),
    ...identity,
    source: normalizeSource(value.source)
  });
}

function normalizePairedImportDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION ||
      !Array.isArray(value.spools) || value.spools.length !== 2) {
    throw spoolError(
      'DUPLICATE_PAIRED_IMPORT_INVALID',
      'pairedImport必须是contractVersion=1且含两个独立spool'
    );
  }
  const spools = value.spools.map(normalizeSpoolDescriptor)
    .sort((left, right) => left.slotIndex - right.slotIndex);
  if (spools[0].slotIndex !== 0 || spools[1].slotIndex !== 1) {
    throw spoolError('DUPLICATE_PAIRED_IMPORT_INVALID', 'pairedImport slot必须精确为0和1');
  }
  const anchor = spools[0];
  for (const spool of spools.slice(1)) {
    if (spool.taskStagingDir !== anchor.taskStagingDir || spool.jobId !== anchor.jobId ||
        spool.operationKey !== anchor.operationKey ||
        spool.producerTaskRunId !== anchor.producerTaskRunId) {
      throw spoolError('DUPLICATE_PAIRED_IMPORT_INVALID', '两侧spool parent identity必须完全一致');
    }
  }
  return Object.freeze({
    contractVersion: DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
    spools: Object.freeze(spools)
  });
}

function normalizeManifestSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.fileName !== 'string' || !value.fileName ||
      path.basename(value.fileName) !== value.fileName ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'manifest source identity非法');
  }
  const snapshot = normalizeSourceSnapshot(value.snapshot);
  if (!snapshot) {
    throw spoolError('DUPLICATE_SPOOL_MANIFEST_INVALID', 'manifest source snapshot非法');
  }
  return Object.freeze({ fileName: value.fileName, snapshot: Object.freeze(snapshot), sha256: value.sha256 });
}

module.exports = {
  DUPLICATE_INPUT_ROLES,
  DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
  DUPLICATE_SPOOL_FILE_NAMES,
  DUPLICATE_SPOOL_MAX_MANIFEST_BYTES,
  DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES,
  DUPLICATE_SPOOL_SCHEMA_VERSION,
  DuplicateSpoolError,
  deriveSlotIdentity,
  duplicateSpoolPaths,
  jobDirectoryToken,
  normalizeJobId,
  normalizeManifestSource,
  normalizePairedImportDescriptor,
  normalizeSlotIndex,
  normalizeSource,
  normalizeSpoolDescriptor,
  normalizeTaskStagingDir,
  requiredText,
  spoolError
};
