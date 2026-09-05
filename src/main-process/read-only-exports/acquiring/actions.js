'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeSourceSnapshot } = require('../../archive-center/source-snapshot');
const {
  absolutePath,
  exactKeys,
  normalizeReadOnlyExportInput
} = require('../common/contract');
const {
  ACQUIRING_EXPORT_ACTIONS,
  ACQUIRING_EXPORT_ACTION_SET
} = require('./policies');

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'ACQUIRING_EXPORT_INPUT_INVALID';
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

function monthKey(value, label = 'monthKey') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    throw inputError(`${label}格式必须为 YYYY-MM`);
  }
  return value;
}

function regularFile(filePath, label) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw inputError(`${label}必须是普通单链接文件`);
  }
  return stat;
}

function normalizeCopySource(value) {
  exactKeys(value, [
    'byteSize', 'canonicalPath', 'contentSha256', 'filePath', 'kind', 'sourceSnapshot'
  ], 'Acquiring copy source');
  if (value.kind !== 'managed-file' || !Number.isSafeInteger(value.byteSize) ||
      value.byteSize < 1) {
    throw inputError('Acquiring copy source 非法');
  }
  const filePath = absolutePath(value.filePath, 'source.filePath');
  const canonicalPath = absolutePath(value.canonicalPath, 'source.canonicalPath');
  const snapshot = normalizeSourceSnapshot(value.sourceSnapshot);
  if (!snapshot) throw inputError('Acquiring copy source snapshot 非法');
  regularFile(filePath, 'Acquiring copy source');
  return Object.freeze({
    kind: value.kind,
    filePath,
    canonicalPath,
    byteSize: value.byteSize,
    contentSha256: digest(value.contentSha256, 'source.contentSha256'),
    sourceSnapshot: Object.freeze({ ...snapshot })
  });
}

function normalizeRegenerateSource(value) {
  exactKeys(value, ['databasePath', 'kind', 'sourceKind', 'userDataDir'], 'Acquiring regenerate source');
  if (value.kind !== 'acquiring-run-sqlite' || !['main', 'side'].includes(value.sourceKind)) {
    throw inputError('Acquiring regenerate source kind 非法');
  }
  const databasePath = absolutePath(value.databasePath, 'source.databasePath');
  const userDataDir = absolutePath(value.userDataDir, 'source.userDataDir');
  const relative = path.relative(userDataDir, databasePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw inputError('Acquiring regenerate DB 必须位于冻结 userDataDir 内');
  }
  regularFile(databasePath, 'Acquiring regenerate DB');
  return Object.freeze({
    kind: value.kind,
    sourceKind: value.sourceKind,
    databasePath,
    userDataDir
  });
}

function normalizeSource(value, actionKey) {
  return actionKey === ACQUIRING_EXPORT_ACTIONS.COPY
    ? normalizeCopySource(value)
    : normalizeRegenerateSource(value);
}

function normalizeCopyEvidence(value) {
  exactKeys(value, [
    'contractVersion', 'kind', 'monthKey', 'runEvidenceDigest', 'runId',
    'sourceDigest', 'sourceFileSha256', 'sourceFileSizeBytes', 'sourceSnapshot'
  ], 'Acquiring copy evidence');
  const snapshot = normalizeSourceSnapshot(value.sourceSnapshot);
  if (value.contractVersion !== 1 || value.kind !== 'copy-existing-diff' || !snapshot ||
      !Number.isSafeInteger(value.sourceFileSizeBytes) || value.sourceFileSizeBytes < 1) {
    throw inputError('Acquiring copy evidence 非法');
  }
  return Object.freeze({
    contractVersion: 1,
    kind: value.kind,
    monthKey: monthKey(value.monthKey),
    runId: positiveInteger(value.runId, 'runId'),
    runEvidenceDigest: digest(value.runEvidenceDigest, 'runEvidenceDigest'),
    sourceFileSha256: digest(value.sourceFileSha256, 'sourceFileSha256'),
    sourceFileSizeBytes: value.sourceFileSizeBytes,
    sourceSnapshot: Object.freeze({ ...snapshot }),
    sourceDigest: digest(value.sourceDigest, 'sourceDigest')
  });
}

function normalizeRegenerateEvidence(value) {
  exactKeys(value, [
    'contractVersion', 'kind', 'mirrorId', 'monthKey', 'progressDigest',
    'runDigest', 'runId', 'sourceDigest', 'sourceKind'
  ], 'Acquiring regenerate evidence');
  if (value.contractVersion !== 1 || value.kind !== 'regenerate-diff-workbook' ||
      !['main', 'side'].includes(value.sourceKind)) {
    throw inputError('Acquiring regenerate evidence 非法');
  }
  return Object.freeze({
    contractVersion: 1,
    kind: value.kind,
    sourceKind: value.sourceKind,
    monthKey: monthKey(value.monthKey),
    runId: positiveInteger(value.runId, 'runId'),
    mirrorId: positiveInteger(value.mirrorId, 'mirrorId'),
    runDigest: digest(value.runDigest, 'runDigest'),
    progressDigest: digest(value.progressDigest, 'progressDigest'),
    sourceDigest: digest(value.sourceDigest, 'sourceDigest')
  });
}

function normalizeEvidence(value, actionKey) {
  return actionKey === ACQUIRING_EXPORT_ACTIONS.COPY
    ? normalizeCopyEvidence(value)
    : normalizeRegenerateEvidence(value);
}

function normalizeContext(value, actionKey) {
  exactKeys(value, ['kind', 'monthKey', 'runId'], 'Acquiring export context');
  const expectedKind = actionKey === ACQUIRING_EXPORT_ACTIONS.COPY
    ? 'copy-existing-diff'
    : 'regenerate-diff-workbook';
  if (value.kind !== expectedKind) throw inputError('Acquiring action/context 分类不一致');
  return Object.freeze({
    kind: value.kind,
    monthKey: monthKey(value.monthKey),
    runId: positiveInteger(value.runId, 'runId')
  });
}

function normalizeAcquiringExportInput(value) {
  const normalized = normalizeReadOnlyExportInput(
    value,
    ACQUIRING_EXPORT_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
  if (normalized.context.kind !== normalized.stableRunEvidence.kind ||
      normalized.context.monthKey !== normalized.stableRunEvidence.monthKey ||
      normalized.context.runId !== normalized.stableRunEvidence.runId) {
    throw inputError('Acquiring context/evidence identity 不一致');
  }
  if (normalized.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY) {
    if (normalized.dbPathOrManagedSource.contentSha256 !==
          normalized.stableRunEvidence.sourceFileSha256 ||
        normalized.dbPathOrManagedSource.byteSize !==
          normalized.stableRunEvidence.sourceFileSizeBytes) {
      throw inputError('Acquiring copy source/evidence 不一致');
    }
  } else if (normalized.dbPathOrManagedSource.sourceKind !==
      normalized.stableRunEvidence.sourceKind) {
    throw inputError('Acquiring regenerate source/evidence 不一致');
  }
  return normalized;
}

module.exports = {
  normalizeAcquiringExportInput,
  normalizeContext,
  normalizeCopyEvidence,
  normalizeCopySource,
  normalizeRegenerateEvidence,
  normalizeRegenerateSource
};
