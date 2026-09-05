'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  absolutePath,
  exactKeys,
  normalizeReadOnlyExportInput
} = require('../common/contract');
const {
  PRE_FUND_READ_ONLY_ACTIONS,
  PRE_FUND_READ_ONLY_ACTION_SET
} = require('./policies');

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'PRE_FUND_EXPORT_INPUT_INVALID';
  return error;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError(`${label}必须为正整数`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw inputError(`${label}必须为 SHA-256`);
  }
  return value;
}

function normalizeSource(value) {
  exactKeys(
    value,
    ['kind', 'mainDatabasePath', 'sideDatabasePath', 'templatePath', 'userDataDir'],
    'PreFund sqlite source'
  );
  if (value.kind !== 'sqlite') throw inputError('PreFund sqlite source kind 非法');
  const source = Object.freeze({
    kind: value.kind,
    mainDatabasePath: absolutePath(value.mainDatabasePath, 'mainDatabasePath'),
    sideDatabasePath: absolutePath(value.sideDatabasePath, 'sideDatabasePath'),
    templatePath: absolutePath(value.templatePath, 'templatePath'),
    userDataDir: absolutePath(value.userDataDir, 'userDataDir')
  });
  for (const filePath of [
    source.mainDatabasePath,
    source.sideDatabasePath,
    source.templatePath
  ]) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw inputError('PreFund source 必须为普通文件');
    }
  }
  if (path.resolve(path.dirname(source.mainDatabasePath)) !== path.resolve(source.userDataDir)) {
    throw inputError('PreFund main DB 必须直属 userDataDir');
  }
  return source;
}

function normalizeEvidence(value) {
  exactKeys(value, [
    'archiveTaskRunId', 'channelSetDigest', 'contractVersion', 'mirrorRunId',
    'monthKey', 'sideRunId', 'sourceDigest', 'templateSha256', 'templateSizeBytes'
  ], 'PreFund stableRunEvidence');
  if (value.contractVersion !== 1 ||
      typeof value.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(value.monthKey) ||
      !Number.isSafeInteger(value.templateSizeBytes) || value.templateSizeBytes < 1 ||
      (value.archiveTaskRunId !== null &&
        (typeof value.archiveTaskRunId !== 'string' || !value.archiveTaskRunId))) {
    throw inputError('PreFund stableRunEvidence 非法');
  }
  return Object.freeze({
    contractVersion: 1,
    mirrorRunId: positiveInteger(value.mirrorRunId, 'mirrorRunId'),
    monthKey: value.monthKey,
    sideRunId: positiveInteger(value.sideRunId, 'sideRunId'),
    archiveTaskRunId: value.archiveTaskRunId,
    channelSetDigest: digest(value.channelSetDigest, 'channelSetDigest'),
    templateSha256: digest(value.templateSha256, 'templateSha256'),
    templateSizeBytes: value.templateSizeBytes,
    sourceDigest: digest(value.sourceDigest, 'sourceDigest')
  });
}

function normalizeContext(value, actionKey) {
  exactKeys(value, ['channel', 'channelDigest', 'hasDuplicateRecords', 'kind'], 'PreFund context');
  if (value.kind !== 'pre-fund-channel' || typeof value.channel !== 'string' || !value.channel ||
      typeof value.hasDuplicateRecords !== 'boolean' ||
      value.hasDuplicateRecords !== (actionKey === PRE_FUND_READ_ONLY_ACTIONS.AUDIT)) {
    throw inputError('PreFund context/action 分类不一致');
  }
  return Object.freeze({
    kind: value.kind,
    channel: value.channel,
    channelDigest: digest(value.channelDigest, 'channelDigest'),
    hasDuplicateRecords: value.hasDuplicateRecords
  });
}

function normalizePreFundReadOnlyExportInput(value) {
  const normalized = normalizeReadOnlyExportInput(
    value,
    PRE_FUND_READ_ONLY_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
  return normalized;
}

module.exports = {
  normalizeContext,
  normalizeEvidence,
  normalizePreFundReadOnlyExportInput,
  normalizeSource
};
