'use strict';

const { DatabaseSync } = require('node:sqlite');

const {
  readAdmRowsForWriteback
} = require('../../backend/database/linked-table-writeback-reader');
const receiptRepository = require('../../backend/database/recon-fix-operation-receipt-repository');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { normalizeRecoverySource } = require('../background-execution/recovery-source');
const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'boundedSummary',
  'changedRowCount',
  'idSequenceDigest',
  'postImageHash',
  'preImageHash',
  'resultHandle',
  'rowCount',
  'scenarioId'
].sort());

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.join(',');
}

function normalizeJpmIntentEvidence(value) {
  const summary = value && value.boundedSummary;
  if (!exactKeys(value, EVIDENCE_KEYS) || typeof value.scenarioId !== 'string' ||
      !value.scenarioId || value.scenarioId.trim() !== value.scenarioId ||
      Buffer.byteLength(value.scenarioId, 'utf8') > 256 ||
      !HASH.test(value.preImageHash || '') ||
      !HASH.test(value.postImageHash || '') || !HASH.test(value.idSequenceDigest || '') ||
      !HASH.test(value.resultHandle || '') || value.preImageHash === value.postImageHash ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 ||
      !Number.isSafeInteger(value.changedRowCount) || value.changedRowCount < 1 ||
      value.changedRowCount > value.rowCount ||
      !exactKeys(summary, [
        'fixedRowCount', 'resultDigest', 'runKind', 'unmatchedRowCount', 'warningCount'
      ].sort()) || summary.runKind !== 'jpm' || !HASH.test(summary.resultDigest || '') ||
      ![summary.fixedRowCount, summary.warningCount, summary.unmatchedRowCount]
        .every((count) => Number.isSafeInteger(count) && count >= 0)) {
    const error = new TypeError('JPM Critical Intent bounded evidence 非法');
    error.code = 'RECON_FIX_JPM_INTENT_EVIDENCE_INVALID';
    throw error;
  }
  return Object.freeze({
    scenarioId: value.scenarioId,
    preImageHash: value.preImageHash,
    postImageHash: value.postImageHash,
    idSequenceDigest: value.idSequenceDigest,
    rowCount: value.rowCount,
    changedRowCount: value.changedRowCount,
    resultHandle: value.resultHandle,
    boundedSummary: Object.freeze({ ...summary })
  });
}

function inspection(source, outcome, boundedEvidence) {
  return Object.freeze({
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome,
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(boundedEvidence),
    boundedEvidence
  });
}

function receiptMatchesSource(receipt, source, evidence) {
  return receipt.actionKey === source.actionKey &&
    receipt.operationKey === source.operationKey &&
    receipt.producerTaskRunId === source.taskRunId &&
    receipt.scenarioId === evidence.scenarioId &&
    receipt.preImageHash === evidence.preImageHash &&
    receipt.postImageHash === evidence.postImageHash &&
    receipt.idSequenceDigest === evidence.idSequenceDigest &&
    receipt.rowCount === evidence.rowCount &&
    receipt.changedRowCount === evidence.changedRowCount;
}

function currentMatches(current, evidence, imageHash) {
  return current.rowCount === evidence.rowCount &&
    current.idSequenceDigest === evidence.idSequenceDigest &&
    current.imageHash === imageHash;
}

function createReconFixJpmOutcomeInspector(options = {}) {
  if (typeof options.databasePath !== 'string' || !options.databasePath) {
    throw new TypeError('ReconFix JPM Inspector需要databasePath');
  }
  const databasePath = options.databasePath;
  return async function inspectReconFixJpm(rawSource) {
    const source = normalizeRecoverySource(rawSource);
    if (source.actionKey !== RECON_FIX_RUN_JPM_ACTION) {
      throw Object.assign(new TypeError('ReconFix JPM Inspector actionKey 不匹配'), {
        code: 'RECON_FIX_JPM_INSPECTOR_ACTION_MISMATCH'
      });
    }
    const evidence = normalizeJpmIntentEvidence(source.boundedEvidence);
    let db;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON');
      // Receipt and ADM image must be observed from one read transaction.  In
      // WAL mode this pins a single snapshot without changing the DB family.
      db.exec('BEGIN');
      if (!receiptRepository.hasOperationReceiptTable(db)) {
        return inspection(source, 'unknown', {
          disposition: 'receipt-table-missing',
          receiptCount: 0,
          currentReadable: false
        });
      }

      let receipt = receiptRepository.getOperationReceipt(
        db,
        source.actionKey,
        source.operationKey
      );
      if (receipt) {
        try {
          receipt = receiptRepository.normalizeExactReceipt(receipt);
        } catch (error) {
          return inspection(source, 'unknown', {
            disposition: 'receipt-invalid',
            receiptCount: 1,
            errorCode: error && error.code || 'RECEIPT_INVALID',
            currentReadable: false
          });
        }
      }

      let current;
      try {
        current = readAdmRowsForWriteback(db);
      } catch (error) {
        return inspection(source, 'unknown', {
          disposition: 'adm-image-unreadable',
          receiptCount: receipt ? 1 : 0,
          ...(receipt ? { receiptDigest: canonicalSha256(receipt) } : {}),
          errorCode: error && error.code || 'ADM_IMAGE_UNREADABLE',
          corruptedRowCount: Number.isSafeInteger(error && error.corruptedRowCount)
            ? error.corruptedRowCount
            : 0,
          redactedIdSamples: Array.isArray(error && error.redactedIdSamples)
            ? error.redactedIdSamples
            : []
        });
      }

      if (receipt) {
        const exact = receiptMatchesSource(receipt, source, evidence) &&
          currentMatches(current, evidence, evidence.postImageHash);
        return inspection(source, exact ? 'committed' : 'unknown', {
          disposition: exact
            ? 'unique-receipt-and-current-post-exact'
            : 'receipt-or-current-post-conflict',
          receiptCount: 1,
          receiptDigest: canonicalSha256(receipt),
          currentRowCount: current.rowCount,
          currentIdSequenceDigest: current.idSequenceDigest,
          currentImageHash: current.imageHash
        });
      }

      const matchesPre = currentMatches(current, evidence, evidence.preImageHash);
      const matchesPost = currentMatches(current, evidence, evidence.postImageHash);
      return inspection(source, matchesPre ? 'not-committed' : 'unknown', {
        disposition: matchesPre
          ? 'receipt-absent-current-pre-exact'
          : (matchesPost
              ? 'receipt-absent-current-post'
              : 'receipt-absent-current-neither-pre-nor-post'),
        receiptCount: 0,
        currentRowCount: current.rowCount,
        currentIdSequenceDigest: current.idSequenceDigest,
        currentImageHash: current.imageHash
      });
    } finally {
      if (db) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
      }
    }
  };
}

module.exports = {
  createReconFixJpmOutcomeInspector,
  normalizeJpmIntentEvidence,
  receiptMatchesSource
};
