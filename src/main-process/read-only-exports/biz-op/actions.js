'use strict';

const {
  absolutePath,
  exactKeys,
  nonEmptyText,
  normalizeReadOnlyExportInput,
  plainObject
} = require('../common/contract');
const {
  BIZ_OP_READ_ONLY_ACTIONS,
  BIZ_OP_READ_ONLY_ACTION_SET
} = require('./policies');

function inputError(message) {
  const error = new TypeError(message);
  error.code = 'BIZ_OP_EXPORT_INPUT_INVALID';
  return error;
}

function normalizeSource(value) {
  exactKeys(value, ['kind', 'mainDatabasePath', 'userDataDir'], 'BizOP sqlite source');
  if (value.kind !== 'biz-op-sqlite') {
    throw inputError('BizOP sqlite source kind 非法');
  }
  return Object.freeze({
    kind: value.kind,
    mainDatabasePath: absolutePath(value.mainDatabasePath, 'mainDatabasePath'),
    userDataDir: absolutePath(value.userDataDir, 'userDataDir')
  });
}

function normalizeEvidence(value, actionKey) {
  exactKeys(
    value,
    ['contractVersion', 'runCount', 'selectionDigest', 'sourceDigest'],
    'BizOP stableRunEvidence'
  );
  if (value.contractVersion !== 1 || !Number.isSafeInteger(value.runCount) || value.runCount < 0 ||
      !/^[a-f0-9]{64}$/.test(value.selectionDigest) ||
      !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
      (actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY && value.runCount !== 1)) {
    throw inputError('BizOP stableRunEvidence 非法');
  }
  return Object.freeze({
    contractVersion: 1,
    runCount: value.runCount,
    selectionDigest: value.selectionDigest,
    sourceDigest: value.sourceDigest
  });
}

function isoDate(value, label) {
  const text = nonEmptyText(value, label);
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== text) {
    throw inputError(`${label}必须是有效 ISO 日期`);
  }
  return text;
}

function normalizeContext(value, actionKey) {
  plainObject(value, 'BizOP context');
  if (actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY) {
    exactKeys(value, ['kind', 'mirrorRunId'], 'BizOP day context');
    if (value.kind !== 'biz-op-day' || !Number.isSafeInteger(value.mirrorRunId) ||
        value.mirrorRunId < 1) {
      throw inputError('BizOP day context 非法');
    }
    return Object.freeze({ kind: value.kind, mirrorRunId: value.mirrorRunId });
  }
  exactKeys(value, ['buName', 'endDate', 'kind', 'startDate'], 'BizOP range context');
  const startDate = isoDate(value.startDate, 'startDate');
  const endDate = isoDate(value.endDate, 'endDate');
  if (value.kind !== 'biz-op-range' || startDate > endDate) {
    throw inputError('BizOP range context 非法');
  }
  return Object.freeze({
    kind: value.kind,
    buName: nonEmptyText(value.buName, 'buName'),
    startDate,
    endDate
  });
}

function normalizeBizOpReadOnlyExportInput(value) {
  return normalizeReadOnlyExportInput(
    value,
    BIZ_OP_READ_ONLY_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
}

module.exports = {
  isoDate,
  normalizeBizOpReadOnlyExportInput,
  normalizeContext,
  normalizeEvidence,
  normalizeSource
};
