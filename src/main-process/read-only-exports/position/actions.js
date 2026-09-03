'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { POSITION_DB_RELATIVE_PATH } = require('../../position-reconciliation/constants');
const {
  absolutePath,
  exactKeys,
  normalizeReadOnlyExportInput
} = require('../common/contract');
const { POSITION_READ_ONLY_ACTION_SET } = require('./policies');

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'POSITION_EXPORT_INPUT_INVALID';
  return error;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw inputError(`${label}必须为 SHA-256`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError(`${label}必须为正整数`);
  return value;
}

function normalizeSource(value) {
  exactKeys(value, ['kind', 'sideDatabasePath', 'templatePath', 'userDataDir'], 'Position source');
  if (value.kind !== 'sqlite') throw inputError('Position source kind 非法');
  const source = Object.freeze({
    kind: value.kind,
    sideDatabasePath: absolutePath(value.sideDatabasePath, 'sideDatabasePath'),
    templatePath: absolutePath(value.templatePath, 'templatePath'),
    userDataDir: absolutePath(value.userDataDir, 'userDataDir')
  });
  if (source.sideDatabasePath !== path.join(source.userDataDir, POSITION_DB_RELATIVE_PATH)) {
    throw inputError('Position side DB 路径与 userDataDir authority 不一致');
  }
  for (const filePath of [source.sideDatabasePath, source.templatePath]) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw inputError('Position source 必须为普通文件');
    }
  }
  return source;
}

function normalizeCheckpoint(value) {
  exactKeys(value, ['generation', 'identity', 'token'], 'Position checkpoint');
  if (typeof value.identity !== 'string' || !value.identity ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      typeof value.token !== 'string' || !value.token) {
    throw inputError('Position checkpoint 非法');
  }
  return Object.freeze({
    identity: value.identity,
    generation: value.generation,
    token: value.token
  });
}

function normalizeEvidence(value) {
  exactKeys(value, [
    'checkpoint', 'contractVersion', 'filterDigest', 'reportSetDigest',
    'runDigest', 'runId', 'sourceDigest', 'templateSha256',
    'templateSizeBytes', 'variant'
  ], 'Position stableRunEvidence');
  if (value.contractVersion !== 1 ||
      !['run', 'differences', 'filtered'].includes(value.variant) ||
      !Number.isSafeInteger(value.templateSizeBytes) || value.templateSizeBytes < 1) {
    throw inputError('Position stableRunEvidence 非法');
  }
  return Object.freeze({
    contractVersion: 1,
    variant: value.variant,
    runId: positiveInteger(value.runId, 'runId'),
    checkpoint: normalizeCheckpoint(value.checkpoint),
    runDigest: digest(value.runDigest, 'runDigest'),
    filterDigest: digest(value.filterDigest, 'filterDigest'),
    reportSetDigest: digest(value.reportSetDigest, 'reportSetDigest'),
    templateSha256: digest(value.templateSha256, 'templateSha256'),
    templateSizeBytes: value.templateSizeBytes,
    sourceDigest: digest(value.sourceDigest, 'sourceDigest')
  });
}

function normalizeTextArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw inputError(`${label}必须为字符串数组`);
  }
  return Object.freeze(value.slice());
}

function normalizeFilters(value) {
  exactKeys(value, ['channels', 'differenceStatuses', 'months', 'regions'], 'Position filters');
  return Object.freeze({
    channels: normalizeTextArray(value.channels, 'channels'),
    regions: normalizeTextArray(value.regions, 'regions'),
    months: normalizeTextArray(value.months, 'months'),
    differenceStatuses: normalizeTextArray(value.differenceStatuses, 'differenceStatuses')
  });
}

function normalizeReportFiles(value, variant) {
  if (!Array.isArray(value)) throw inputError('Position reportFiles 必须为数组');
  if (variant !== 'filtered' && value.length !== 0) {
    throw inputError('非过滤导出不能携带异常报告文件');
  }
  const keys = new Set();
  return Object.freeze(value.map((item) => {
    exactKeys(item, ['filePath', 'reportKey', 'sha256', 'sizeBytes'], 'Position report file');
    const reportKey = typeof item.reportKey === 'string' ? item.reportKey.trim() : '';
    const filePath = absolutePath(item.filePath, 'reportFiles.filePath');
    if (!reportKey || keys.has(reportKey) || !Number.isSafeInteger(item.sizeBytes) ||
        item.sizeBytes < 1) {
      throw inputError('Position report file identity 非法或重复');
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw inputError('Position report file 必须为普通文件');
    }
    keys.add(reportKey);
    return Object.freeze({
      reportKey,
      filePath,
      sha256: digest(item.sha256, 'reportFiles.sha256'),
      sizeBytes: item.sizeBytes
    });
  }));
}

function normalizeContext(value) {
  exactKeys(value, ['filters', 'kind', 'reportFiles', 'variant'], 'Position context');
  if (value.kind !== 'position-run-export' ||
      !['run', 'differences', 'filtered'].includes(value.variant)) {
    throw inputError('Position context variant 非法');
  }
  return Object.freeze({
    kind: value.kind,
    variant: value.variant,
    filters: normalizeFilters(value.filters),
    reportFiles: normalizeReportFiles(value.reportFiles, value.variant)
  });
}

function normalizePositionReadOnlyExportInput(value) {
  const normalized = normalizeReadOnlyExportInput(
    value,
    POSITION_READ_ONLY_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
  if (normalized.context.variant !== normalized.stableRunEvidence.variant) {
    throw inputError('Position context/evidence variant 不一致');
  }
  return normalized;
}

module.exports = {
  normalizeContext,
  normalizeEvidence,
  normalizeFilters,
  normalizePositionReadOnlyExportInput,
  normalizeReportFiles,
  normalizeSource
};
