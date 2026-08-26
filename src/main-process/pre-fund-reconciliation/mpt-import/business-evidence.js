'use strict';

function readBatchActualCounts(db, batchId) {
  return Object.freeze({
    valid: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM pre_fund_reconciliation_gateway_rows
      WHERE batch_id = ?
    `).get(batchId).count),
    excluded: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM pre_fund_reconciliation_gateway_excluded_rows
      WHERE batch_id = ?
    `).get(batchId).count)
  });
}

function batchMatchesReceiptEvidence(batch, receipt, evidence, actualCounts) {
  if (!batch || Number(batch.id) !== receipt.batchId ||
      batch.source_type !== evidence.sourceType || batch.source_batch !== evidence.sourceBatch ||
      batch.source_date !== evidence.sourceDate ||
      batch.source_file_sequence !== evidence.sourceFileSequence ||
      batch.source_file_name !== receipt.sourceFileName || batch.content_hash !== receipt.contentHash ||
      (batch.dataset_id || null) !== receipt.datasetId ||
      Number(batch.dataset_version) !== receipt.datasetVersionAfter ||
      Number(batch.row_count) !== evidence.counts.valid ||
      Number(batch.excluded_row_count) !== evidence.counts.excluded ||
      Number(batch.declared_row_count) !== evidence.counts.parsed ||
      actualCounts.valid !== evidence.counts.valid ||
      actualCounts.excluded !== evidence.counts.excluded) return false;
  if (receipt.outcomeKind === 'inserted') {
    return receipt.datasetVersionBefore === null && receipt.datasetVersionAfter === 1 &&
      receipt.datasetId === evidence.datasetId &&
      (batch.producer_task_run_id || null) === receipt.producerTaskRunId;
  }
  if (receipt.outcomeKind === 'replaced') {
    return Number.isSafeInteger(receipt.datasetVersionBefore) &&
      receipt.datasetVersionAfter === receipt.datasetVersionBefore + 1 &&
      receipt.datasetId === evidence.datasetId &&
      (batch.producer_task_run_id || null) === receipt.producerTaskRunId;
  }
  return receipt.outcomeKind === 'noop-existing-batch' &&
    receipt.datasetVersionBefore === receipt.datasetVersionAfter;
}

module.exports = {
  batchMatchesReceiptEvidence,
  readBatchActualCounts
};
