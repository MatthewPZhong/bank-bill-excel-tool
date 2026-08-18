'use strict';

const TABLE = 'biz_op_recon_month_end_copy_intents';

function mapIntent(row) {
  if (!row) return null;
  return {
    sourceTaskRunId: row.source_task_run_id,
    dataDate: row.data_date,
    normalizedBu: row.normalized_bu,
    datasetId: row.dataset_id,
    datasetVersion: Number(row.dataset_version),
    producerTaskRunId: row.producer_task_run_id,
    targetMonth: row.target_month,
    createdAt: row.created_at
  };
}

function pendingError(dataDate, normalizedBu) {
  const error = new Error(`Biz OP ${dataDate} / ${normalizedBu} 的月末跨库复制尚未完成`);
  error.code = 'BIZ_OP_MONTH_END_COPY_PENDING';
  error.blocksArchiveStartup = true;
  return error;
}

function getByTaskRunId(db, sourceTaskRunId) {
  return mapIntent(db.prepare(`
    SELECT * FROM ${TABLE} WHERE source_task_run_id = ?
  `).get(sourceTaskRunId));
}

function list(db) {
  return db.prepare(`
    SELECT * FROM ${TABLE} ORDER BY created_at, source_task_run_id
  `).all().map(mapIntent);
}

function assertNoPending(db, dataDate, normalizedBu) {
  const row = db.prepare(`
    SELECT 1 FROM ${TABLE}
    WHERE data_date = ? AND normalized_bu = ?
  `).get(dataDate, normalizedBu);
  if (row) throw pendingError(dataDate, normalizedBu);
}

function create(db, intent) {
  db.prepare(`
    INSERT INTO ${TABLE} (
      source_task_run_id, data_date, normalized_bu, dataset_id,
      dataset_version, producer_task_run_id, target_month, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    intent.sourceTaskRunId,
    intent.dataDate,
    intent.normalizedBu,
    intent.datasetId,
    intent.datasetVersion,
    intent.producerTaskRunId,
    intent.targetMonth,
    new Date().toISOString()
  );
  return getByTaskRunId(db, intent.sourceTaskRunId);
}

function remove(db, sourceTaskRunId) {
  return Number(db.prepare(`
    DELETE FROM ${TABLE} WHERE source_task_run_id = ?
  `).run(sourceTaskRunId).changes || 0);
}

module.exports = {
  assertNoPending,
  create,
  getByTaskRunId,
  list,
  pendingError,
  remove
};
