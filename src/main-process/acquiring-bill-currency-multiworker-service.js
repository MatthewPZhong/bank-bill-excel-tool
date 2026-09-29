'use strict';

// 收单多 worker 应用编排。仅 Main/session 装配 repository 与 executor；SQL 不来自 IPC。
// executor 确认本组真实退出并清理精确 part 后，才允许失败清理和 session 结算。
function createAcquiringMultiworkerService({ runRepository, executeWriteSplitChunks }) {
  async function insertDiffRows(db, {
    runId, monthKey, chunkSize, dbPath, workerCount, tempDir, batchContext,
    onChunkDone = null, cancelToken = null,
  } = {}) {
    if (!runId || typeof runId !== 'number') {
      throw new Error('insertDiffRowsByJoinMultiWorker: runId 必填且为 number');
    }
    if (!monthKey) {
      throw new Error('insertDiffRowsByJoinMultiWorker: monthKey 必填');
    }
    const cs = Number(chunkSize);
    if (!Number.isInteger(cs) || cs < 1) {
      throw new Error(`insertDiffRowsByJoinMultiWorker: chunkSize 必须为正整数，收到：${JSON.stringify(chunkSize)}`);
    }
    if (!dbPath || typeof dbPath !== 'string') {
      throw new Error('insertDiffRowsByJoinMultiWorker: dbPath 必填（worker 各自 open 只读 connection）');
    }
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new Error(`insertDiffRowsByJoinMultiWorker: workerCount 必须 ≥1 整数，收到：${JSON.stringify(workerCount)}`);
    }
    if (!tempDir || typeof tempDir !== 'string') {
      throw new Error('insertDiffRowsByJoinMultiWorker: tempDir 必填');
    }


    const plan = runRepository.buildMultiworkerPlan(db, { runId, monthKey, chunkSize: cs });
    const { totalBillRows, totalChunks } = plan;
    if (totalChunks === 0) {
      return { totalChunks: 0, totalProcessedBillRows: 0, totalInsertedDiffRows: 0, lastCompletedChunkIndex: -1 };
    }
    let result;
    try {
      result = await executeWriteSplitChunks({
        db, dbPath, workerCount, tempDir, batchContext, cancelToken,
        chunks: plan.chunks,
        selectSql: plan.selectSql,
        partColumns: plan.partColumns,
        targetTable: plan.targetTable,
        targetColumns: plan.targetColumns,
        prefixValues: plan.prefixValues,
        onProgress: (ev) => {
          // reader 完成只转发进度；不写持久化 chunk_progress，也不表示该 chunk 已提交。
          if (typeof onChunkDone === 'function') {
            try {
              onChunkDone({
                chunkIndex: ev.chunkIndex,
                totalChunks: ev.totalChunks,
                processedRows: Math.min(cs, totalBillRows - ev.chunkIndex * cs),
                insertedDiffRows: ev.rowCount,
                elapsedMs: 0,
              });
            } catch (_error) { /* 保留原进度回调异常吞吐方式 */ }
          }
        },
      });
    } catch (error) {
      // merge 按 chunk 提交，可能已有残留；清理失败仍保留原执行错误，由 session 标 partial。
      try { runRepository.cleanupFailedMultiworkerRun(db, { runId }); }
      catch (_cleanupError) { /* 原始执行错误优先 */ }
      throw error;
    }
    return {
      totalChunks,
      totalProcessedBillRows: totalBillRows,
      totalInsertedDiffRows: result.insertedRows,
      lastCompletedChunkIndex: totalChunks - 1,
    };
  }
  return { insertDiffRows };
}

module.exports = { createAcquiringMultiworkerService };
