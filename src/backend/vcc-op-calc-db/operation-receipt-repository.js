'use strict';

const RECEIPTS_TABLE = 'vcc_op_operation_receipts';

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('VCC saveRun receipt repository 需要 DatabaseSync');
  }
}

function listOperationReceipts(db, actionKey, operationKey) {
  assertDatabase(db);
  return db.prepare(`
    SELECT
      id,
      action_key AS actionKey,
      operation_key AS operationKey,
      producer_task_run_id AS producerTaskRunId,
      run_id AS runId,
      year_month AS yearMonth,
      compute_snapshot_hash AS computeSnapshotHash,
      input_file_count AS inputFileCount,
      committed_at AS committedAt
    FROM ${RECEIPTS_TABLE}
    WHERE action_key = ? AND operation_key = ?
    ORDER BY id ASC
  `).all(actionKey, operationKey);
}

function listRunReceipts(db, runId) {
  assertDatabase(db);
  return db.prepare(`
    SELECT
      id,
      action_key AS actionKey,
      operation_key AS operationKey,
      producer_task_run_id AS producerTaskRunId,
      run_id AS runId,
      year_month AS yearMonth,
      compute_snapshot_hash AS computeSnapshotHash,
      input_file_count AS inputFileCount,
      committed_at AS committedAt
    FROM ${RECEIPTS_TABLE}
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId);
}

function insertOperationReceipt(db, payload) {
  assertDatabase(db);
  const result = db.prepare(`
    INSERT INTO ${RECEIPTS_TABLE} (
      action_key,
      operation_key,
      producer_task_run_id,
      run_id,
      year_month,
      compute_snapshot_hash,
      input_file_count,
      committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(
    payload.actionKey,
    payload.operationKey,
    payload.producerTaskRunId,
    payload.runId,
    payload.yearMonth,
    payload.computeSnapshotHash,
    payload.inputFileCount
  );
  return Number(result.lastInsertRowid);
}

module.exports = {
  RECEIPTS_TABLE,
  insertOperationReceipt,
  listOperationReceipts,
  listRunReceipts
};
