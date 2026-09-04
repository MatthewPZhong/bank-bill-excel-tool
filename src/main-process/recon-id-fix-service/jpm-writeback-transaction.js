'use strict';

const {
  ADM_TABLE,
  admImageHash,
  readAdmRowsForWriteback
} = require('../../backend/database/linked-table-writeback-reader');
const receiptRepository = require('../../backend/database/recon-fix-operation-receipt-repository');
const {
  ReconFixJpmWritebackError,
  assertJpmWritebackPlan
} = require('./jpm-writeback-plan');

function fail(code, message) {
  throw new ReconFixJpmWritebackError(code, message);
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('JPM ADM writeback transaction 需要 DatabaseSync');
  }
}

function requireText(value, label, maxBytes = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('RECON_FIX_JPM_RECEIPT_IDENTITY_INVALID', `${label} 必须是有界非空文本`);
  }
  return value;
}

function invokeFault(injectFault, stage, plan) {
  if (typeof injectFault !== 'function') return;
  injectFault(stage, Object.freeze({
    rowCount: plan.rowCount,
    changedRowCount: plan.changedRowCount,
    idSequenceDigest: plan.idSequenceDigest,
    preImageHash: plan.preImageHash,
    postImageHash: plan.expectedPostImageHash
  }));
}

function rollbackOpenTransaction(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* 原错误优先 */ }
}

function assertCurrentSource(current, plan) {
  if (current.rowCount !== plan.rowCount) {
    fail('RECON_FIX_JPM_ROW_COUNT_CHANGED', 'ADM rowCount 在写回前发生变化');
  }
  if (current.idSequenceDigest !== plan.idSequenceDigest) {
    fail('RECON_FIX_JPM_ID_SEQUENCE_CHANGED', 'ADM id/order 在写回前发生变化');
  }
  if (current.imageHash !== plan.preImageHash) {
    fail('RECON_FIX_JPM_PREIMAGE_CHANGED', 'ADM preimage 在写回前发生变化');
  }
}

function assertCommittedPostImage(current, plan) {
  if (current.rowCount !== plan.rowCount) {
    fail('RECON_FIX_JPM_POSTIMAGE_ROW_COUNT_CHANGED', 'ADM rowCount 在事务更新后发生变化');
  }
  if (current.idSequenceDigest !== plan.idSequenceDigest) {
    fail('RECON_FIX_JPM_POSTIMAGE_ID_SEQUENCE_CHANGED', 'ADM id/order 在事务更新后发生变化');
  }
  if (current.imageHash !== plan.expectedPostImageHash) {
    fail('RECON_FIX_JPM_POSTIMAGE_MISMATCH', 'ADM postimage 与 writeback plan 不一致');
  }
}

function commitJpmAdmMutationWithReceipt(options = {}) {
  const plan = assertJpmWritebackPlan(options.plan);
  // 该拒绝必须早于任何 DB/critical 依赖：future coordinator 只能在 critical 前消费 noop。
  if (plan.outcome !== 'mutation-required' || plan.changedRowCount < 1) {
    fail(
      'RECON_FIX_JPM_NOOP_TRANSACTION_FORBIDDEN',
      'exact noop 不得进入 ADM transaction 或写 operation receipt'
    );
  }
  const db = options.db;
  assertDatabase(db);
  if (db.isTransaction === true) {
    fail('RECON_FIX_JPM_TRANSACTION_ALREADY_OPEN', 'JPM ADM writeback 必须独占 BEGIN IMMEDIATE');
  }
  const producerTaskRunId = requireText(options.producerTaskRunId, 'producerTaskRunId');
  const scenarioId = requireText(options.scenarioId, 'scenarioId', 256);
  let transactionOpen = false;
  let receipt = null;

  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    invokeFault(options.injectFault, 'after-begin', plan);

    const current = readAdmRowsForWriteback(db);
    assertCurrentSource(current, plan);
    if (receiptRepository.getOperationReceipt(db, plan.actionKey, plan.operationKey)) {
      fail(
        'RECON_FIX_RECEIPT_ALREADY_EXISTS',
        '同一 ReconFix operationKey 已有 receipt，必须交由 E11-B Inspector 判定'
      );
    }
    invokeFault(options.injectFault, 'after-source-revalidation', plan);

    const currentById = new Map(current.rows.map((row) => [row.id, row]));
    const update = db.prepare(`UPDATE ${ADM_TABLE} SET raw_json = ? WHERE id = ?`);
    for (const changed of plan.changedRows) {
      const currentRow = currentById.get(changed.id);
      if (!currentRow || admImageHash([{ id: changed.id, parsed: currentRow.parsed }]) !==
          changed.expectedPreHash) {
        fail('RECON_FIX_JPM_CHANGED_ROW_PREIMAGE_MISMATCH', 'ADM changed row preimage 不匹配 exact id');
      }
      const result = update.run(JSON.stringify(changed.expectedPost), changed.id);
      if (Number(result.changes) !== 1) {
        fail('RECON_FIX_JPM_EXACT_ID_UPDATE_FAILED', 'ADM exact id update 未命中唯一一行');
      }
    }
    invokeFault(options.injectFault, 'after-updates', plan);

    const postImage = readAdmRowsForWriteback(db);
    assertCommittedPostImage(postImage, plan);
    invokeFault(options.injectFault, 'after-postimage-revalidation', plan);
    invokeFault(options.injectFault, 'before-receipt-insert', plan);

    receipt = receiptRepository.insertOperationReceipt(db, {
      actionKey: plan.actionKey,
      operationKey: plan.operationKey,
      producerTaskRunId,
      scenarioId,
      preImageHash: plan.preImageHash,
      postImageHash: plan.expectedPostImageHash,
      idSequenceDigest: plan.idSequenceDigest,
      rowCount: plan.rowCount,
      changedRowCount: plan.changedRowCount
    });
    invokeFault(options.injectFault, 'after-receipt-insert', plan);
    invokeFault(options.injectFault, 'before-commit', plan);

    // receipt INSERT trigger 或 fault seam 仍可能在 COMMIT 前改写 ADM/receipt；
    // 最后一条可执行 seam 后再做一次权威回读，随后不执行任何用户代码。
    assertCommittedPostImage(readAdmRowsForWriteback(db), plan);
    const finalReceipt = receiptRepository.getOperationReceipt(
      db,
      plan.actionKey,
      plan.operationKey
    );
    if (!finalReceipt || !receiptRepository.sameExactReceipt(
      receiptRepository.normalizeExactReceipt(finalReceipt),
      receipt
    )) {
      fail('RECON_FIX_RECEIPT_IDENTITY_CONFLICT', 'ReconFix receipt 在 COMMIT 前发生变化');
    }
    receipt = receiptRepository.normalizeExactReceipt(finalReceipt);
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) rollbackOpenTransaction(db);
    throw error;
  }

  return receipt;
}

module.exports = {
  commitJpmAdmMutationWithReceipt
};
