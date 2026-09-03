'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  absolutePath,
  exactKeys,
  nonEmptyText,
  normalizeReadOnlyExportInput,
  plainObject
} = require('../common/contract');
const {
  validateTaskOwnedStagingPath
} = require('../../statement-worker/staging-ownership');
const {
  PENDING_READ_ONLY_ACTIONS,
  PENDING_READ_ONLY_ACTION_SET
} = require('./policies');

function sourceError(message) {
  const error = new TypeError(message);
  error.code = 'PENDING_EXPORT_INPUT_INVALID';
  return error;
}

function normalizeSource(value, actionKey) {
  if (actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS) {
    exactKeys(value, ['byteSize', 'filePath', 'kind', 'sha256', 'stagingRoot'], 'managed source');
    if (value.kind !== 'managed-json' || !Number.isSafeInteger(value.byteSize) || value.byteSize < 2 ||
        typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw sourceError('Pending managed error source evidence 非法');
    }
    const stagingRoot = absolutePath(value.stagingRoot, 'managed source stagingRoot');
    const filePath = absolutePath(value.filePath, 'managed source filePath');
    validateTaskOwnedStagingPath({ stagingRoot, candidatePath: filePath, finalState: 'file' });
    return Object.freeze({
      kind: value.kind,
      stagingRoot,
      filePath,
      byteSize: value.byteSize,
      sha256: value.sha256
    });
  }
  exactKeys(value, ['databasePath', 'kind'], 'Pending sqlite source');
  if (value.kind !== 'sqlite') throw sourceError('Pending sqlite source kind 非法');
  return Object.freeze({ kind: value.kind, databasePath: absolutePath(value.databasePath, 'databasePath') });
}

function normalizeEvidence(value, actionKey) {
  exactKeys(value, ['contractVersion', 'runIds', 'sourceDigest'], 'stableRunEvidence');
  if (value.contractVersion !== 1 || typeof value.sourceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !Array.isArray(value.runIds)) {
    throw sourceError('Pending stableRunEvidence 非法');
  }
  const runIds = value.runIds.map((runId) => {
    if (!Number.isSafeInteger(runId) || runId < 1) throw sourceError('Pending evidence runId 非法');
    return runId;
  });
  if (new Set(runIds).size !== runIds.length ||
      (actionKey === PENDING_READ_ONLY_ACTIONS.DIFF && runIds.length !== 1) ||
      (actionKey === PENDING_READ_ONLY_ACTIONS.SUMMARY && runIds.length < 1) ||
      (actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS && runIds.length !== 0)) {
    throw sourceError('Pending evidence run set 与 action 不一致');
  }
  return Object.freeze({
    contractVersion: 1,
    runIds: Object.freeze(runIds),
    sourceDigest: value.sourceDigest
  });
}

function normalizeContext(value, actionKey) {
  plainObject(value, 'context');
  if (actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS) {
    exactKeys(value, ['errorCount', 'kind'], 'Pending error context');
    if (value.kind !== 'pending-errors' || !Number.isSafeInteger(value.errorCount) || value.errorCount < 0) {
      throw sourceError('Pending error context 非法');
    }
    return Object.freeze({ kind: value.kind, errorCount: value.errorCount });
  }
  exactKeys(value, ['kind', 'runIds'], 'Pending run context');
  const expectedKind = actionKey === PENDING_READ_ONLY_ACTIONS.DIFF
    ? 'pending-diff'
    : 'pending-summary';
  if (value.kind !== expectedKind || !Array.isArray(value.runIds) ||
      value.runIds.some((runId) => !Number.isSafeInteger(runId) || runId < 1)) {
    throw sourceError('Pending run context 非法');
  }
  return Object.freeze({ kind: value.kind, runIds: Object.freeze(value.runIds.slice()) });
}

function normalizePendingReadOnlyExportInput(value) {
  const normalized = normalizeReadOnlyExportInput(
    value,
    PENDING_READ_ONLY_ACTION_SET,
    normalizeSource,
    normalizeEvidence,
    normalizeContext
  );
  if (JSON.stringify(normalized.context.runIds || []) !==
      JSON.stringify(normalized.stableRunEvidence.runIds)) {
    throw sourceError('Pending context/evidence run order 不一致');
  }
  if (normalized.dbPathOrManagedSource.kind === 'managed-json' &&
      path.resolve(normalized.dbPathOrManagedSource.filePath) ===
        path.resolve(normalized.generationPlan.generationPath)) {
    throw sourceError('Pending managed source 不能与 generation artifact 重合');
  }
  return normalized;
}

function assertManagedSourceStillRegular(source) {
  const stat = fs.lstatSync(source.filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.nlink) !== 1 ||
      Number(stat.size) !== source.byteSize) {
    throw sourceError('Pending managed error source 身份已变化');
  }
}

module.exports = {
  assertManagedSourceStillRegular,
  normalizePendingReadOnlyExportInput,
  normalizeSource,
  normalizeEvidence,
  normalizeContext,
  nonEmptyText
};
