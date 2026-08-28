'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeSourceSnapshot } = require('../archive-center/source-snapshot');
const { requireMonth } = require('./identity');

const BANK_BU_SPOOL_SCHEMA_VERSION = 1;
const BANK_BU_DUAL_IMPORT_CONTRACT_VERSION = 1;
const BANK_BU_SPOOL_MAX_MANIFEST_BYTES = 64 * 1024;
const BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
const BANK_BU_INPUT_ROLES = Object.freeze({ PENDING: 'pending', BANK: 'bank' });
const ROLE_SLOT = Object.freeze({ pending: 0, bank: 1 });
const BANK_BU_SPOOL_FILE_NAMES = Object.freeze({
  rowsPart: 'rows.ndjson.part',
  rowsReady: 'rows.ndjson.ready',
  manifestPart: 'manifest.json.part',
  manifestReady: 'manifest.json.ready',
  outcomePart: 'parser-outcome.json.part',
  outcomeReady: 'parser-outcome.json.ready'
});

class BankBuSpoolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BankBuSpoolError';
    this.code = code;
    this.details = details;
  }
}

function spoolError(code, message, details = null) {
  return new BankBuSpoolError(code, message, details);
}

function requiredText(value, label, maxLength = 2048) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      value.length > maxLength) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', `${label}非法`);
  }
  return value;
}

function normalizeJobId(value) {
  const jobId = requiredText(value, 'jobId', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'jobId必须符合Platform safeKey');
  }
  return jobId;
}

function normalizeRole(value) {
  if (!Object.values(BANK_BU_INPUT_ROLES).includes(value)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'BankBU spool role非法');
  }
  return value;
}

function normalizeTaskStagingDir(value) {
  const directory = path.normalize(requiredText(value, 'taskStagingDir', 4096));
  if (!path.isAbsolute(directory)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'taskStagingDir必须是绝对路径');
  }
  return directory;
}

function jobDirectoryToken(jobId) {
  return `job-${crypto.createHash('sha256').update(normalizeJobId(jobId), 'utf8').digest('hex')}`;
}

function bankBuSpoolPaths({ taskStagingDir, jobId, role }) {
  const staging = normalizeTaskStagingDir(taskStagingDir);
  const dualDir = path.join(staging, 'bank-bu-dual');
  const jobDir = path.join(dualDir, jobDirectoryToken(jobId));
  const roleDir = path.join(jobDir, `role-${normalizeRole(role)}`);
  const result = { taskStagingDir: staging, dualDir, jobDir, roleDir };
  for (const [key, basename] of Object.entries(BANK_BU_SPOOL_FILE_NAMES)) {
    result[key] = path.join(roleDir, basename);
  }
  return Object.freeze(result);
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'source必须是对象');
  }
  const filePath = path.normalize(requiredText(value.filePath, 'source.filePath', 4096));
  if (!path.isAbsolute(filePath)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'source.filePath必须是绝对路径');
  }
  return Object.freeze({ filePath });
}

function normalizeSpoolDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw spoolError('BANK_BU_SPOOL_CONTRACT_INVALID', 'spool descriptor必须是对象');
  }
  const role = normalizeRole(value.role);
  return Object.freeze({
    taskStagingDir: normalizeTaskStagingDir(value.taskStagingDir),
    jobId: normalizeJobId(value.jobId),
    operationKey: requiredText(value.operationKey, 'operationKey'),
    producerTaskRunId: requiredText(value.producerTaskRunId, 'producerTaskRunId'),
    yearMonth: requireMonth(value.yearMonth),
    role,
    slotIndex: ROLE_SLOT[role],
    source: normalizeSource(value.source)
  });
}

function normalizeDualImportDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.contractVersion !== BANK_BU_DUAL_IMPORT_CONTRACT_VERSION ||
      !Array.isArray(value.spools) || value.spools.length !== 2) {
    throw spoolError(
      'BANK_BU_DUAL_IMPORT_INVALID',
      'BankBU dual import必须是contractVersion=1且含两个role spool'
    );
  }
  const spools = value.spools.map(normalizeSpoolDescriptor)
    .sort((left, right) => left.slotIndex - right.slotIndex);
  if (spools[0].role !== BANK_BU_INPUT_ROLES.PENDING ||
      spools[1].role !== BANK_BU_INPUT_ROLES.BANK) {
    throw spoolError('BANK_BU_DUAL_IMPORT_INVALID', 'BankBU dual import角色必须精确为Pending和Bank');
  }
  const anchor = spools[0];
  for (const spool of spools.slice(1)) {
    if (spool.taskStagingDir !== anchor.taskStagingDir || spool.jobId !== anchor.jobId ||
        spool.operationKey !== anchor.operationKey ||
        spool.producerTaskRunId !== anchor.producerTaskRunId ||
        spool.yearMonth !== anchor.yearMonth ||
        spool.source.filePath === anchor.source.filePath) {
      throw spoolError('BANK_BU_DUAL_IMPORT_INVALID', 'BankBU两侧spool parent/source identity非法');
    }
  }
  return Object.freeze({
    contractVersion: BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
    spools: Object.freeze(spools)
  });
}

function normalizeManifestSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.fileName !== 'string' || !value.fileName ||
      path.basename(value.fileName) !== value.fileName ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw spoolError('BANK_BU_SPOOL_MANIFEST_INVALID', 'BankBU manifest source identity非法');
  }
  const snapshot = normalizeSourceSnapshot(value.snapshot);
  if (!snapshot) {
    throw spoolError('BANK_BU_SPOOL_MANIFEST_INVALID', 'BankBU manifest source snapshot非法');
  }
  return Object.freeze({
    fileName: value.fileName,
    snapshot: Object.freeze(snapshot),
    sha256: value.sha256
  });
}

module.exports = {
  BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
  BANK_BU_INPUT_ROLES,
  BANK_BU_SPOOL_FILE_NAMES,
  BANK_BU_SPOOL_MAX_MANIFEST_BYTES,
  BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES,
  BANK_BU_SPOOL_SCHEMA_VERSION,
  BankBuSpoolError,
  bankBuSpoolPaths,
  normalizeDualImportDescriptor,
  normalizeManifestSource,
  normalizeRole,
  normalizeSpoolDescriptor,
  spoolError
};
