'use strict';

const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../backend/run-data-store');
const {
  normalizeRecoveryInspectionResult
} = require('../../background-execution/recovery-source');
const {
  getOperationReceipt,
  hasOperationReceiptTable,
  normalizeExactOperationReceipt,
  sameExactOperationReceipt
} = require('./operation-receipt-repository');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION;

function authorityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createPreFundMptReceiptAuthority(options) {
  if (!options || typeof options.userDataDir !== 'string' || !options.userDataDir ||
      typeof options.outcomeInspector !== 'function') {
    throw new TypeError('PreFund receipt authority依赖不完整');
  }
  const userDataDir = options.userDataDir;
  const outcomeInspector = options.outcomeInspector;

  function readAuthoritativeReceipt(source) {
    const evidence = source.boundedEvidence;
    let db;
    let receipt = null;
    let failure = null;
    try {
      const dbPath = runDataStore.sideDbPath(userDataDir, MODULE, evidence.monthKey);
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON');
      if (hasOperationReceiptTable(db)) {
        const stored = getOperationReceipt(db, source.actionKey, source.operationKey);
        receipt = stored ? normalizeExactOperationReceipt(stored) : null;
      }
    } catch (_error) {
      failure = authorityError(
        'PREFUND_RECEIPT_AUTHORITY_UNREADABLE',
        'PreFund authoritative receipt不可读取'
      );
    }
    if (db) {
      try { db.close(); } catch (_error) {
        failure = authorityError(
          'PREFUND_RECEIPT_AUTHORITY_UNREADABLE',
          'PreFund authoritative receipt读取句柄无法安全关闭'
        );
      }
    }
    if (failure) throw failure;
    return receipt;
  }

  async function verify(input) {
    let messageReceipt;
    try {
      messageReceipt = normalizeExactOperationReceipt(input && input.receipt);
    } catch (_error) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_SHAPE_INVALID',
        'Worker commit receipt字段或类型不符合PreFund exact合同'
      );
    }
    const source = input && input.source;
    if (!source || messageReceipt.actionKey !== source.actionKey ||
        messageReceipt.operationKey !== source.operationKey ||
        messageReceipt.producerTaskRunId !== source.taskRunId ||
        messageReceipt.fileIndex !== source.boundedEvidence.fileIndex ||
        messageReceipt.sourceFileName !== source.boundedEvidence.sourceFileName ||
        messageReceipt.sourceSha256 !== source.boundedEvidence.sourceSha256 ||
        messageReceipt.contentHash !== source.boundedEvidence.contentHash) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_MISMATCH',
        'Worker commit receipt与Critical Intent evidence不匹配'
      );
    }
    const authoritativeReceipt = readAuthoritativeReceipt(source);
    if (!authoritativeReceipt) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_AUTHORITY_MISSING',
        '模块Side DB缺少authoritative operation receipt'
      );
    }
    if (!sameExactOperationReceipt(messageReceipt, authoritativeReceipt)) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_AUTHORITY_CONFLICT',
        'Worker commit receipt与模块authoritative receipt冲突'
      );
    }
    let inspection;
    try {
      inspection = normalizeRecoveryInspectionResult(source, await outcomeInspector(source));
    } catch (_error) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_EVIDENCE_INVALID',
        '模块canonical Inspector未形成matching authoritative evidence'
      );
    }
    const inspected = inspection && inspection.boundedEvidence;
    if (!inspection || inspection.outcome !== 'committed' || !inspected ||
        inspected.receiptId !== authoritativeReceipt.id ||
        inspected.batchId !== authoritativeReceipt.batchId ||
        inspected.outcomeKind !== authoritativeReceipt.outcomeKind ||
        inspected.monthKey !== source.boundedEvidence.monthKey ||
        inspected.datasetVersionAfter !== authoritativeReceipt.datasetVersionAfter) {
      throw authorityError(
        'WORKER_DURABLE_RECEIPT_EVIDENCE_NOT_COMMITTED',
        '模块authoritative receipt与业务lineage无法唯一证明committed'
      );
    }
    return authoritativeReceipt;
  }

  return Object.freeze({ verify });
}

module.exports = {
  createPreFundMptReceiptAuthority
};
