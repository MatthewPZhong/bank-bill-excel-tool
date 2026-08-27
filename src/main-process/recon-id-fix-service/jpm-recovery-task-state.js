'use strict';

const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

function persistedStateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createReconFixJpmRecoveryTaskStateReader(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('ReconFix JPM recovery Task state reader 需要 DatabaseSync');
  }
  return function readReconFixJpmRecoveryTaskState(source) {
    if (!source || source.actionKey !== RECON_FIX_RUN_JPM_ACTION) return null;
    if (typeof source.taskRunId !== 'string' || !source.taskRunId) {
      throw new TypeError('ReconFix JPM recovery source taskRunId 不能为空');
    }
    const row = db.prepare(`
      SELECT task_run_id, task_key, operation_key, status, metadata_json
      FROM archive_task_runs
      WHERE task_run_id = ?
    `).get(source.taskRunId);
    if (!row) return null;
    let metadata;
    try {
      metadata = JSON.parse(row.metadata_json || '{}');
    } catch (_error) {
      throw persistedStateError(
        'RECON_FIX_JPM_RECOVERY_TASK_METADATA_INVALID',
        'JPM recovery 持久 Task metadata 非法'
      );
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw persistedStateError(
        'RECON_FIX_JPM_RECOVERY_TASK_METADATA_INVALID',
        'JPM recovery 持久 Task metadata 必须是 object'
      );
    }
    return canonicalJsonSnapshot({
      taskRunId: row.task_run_id,
      taskKey: row.task_key,
      operationKey: row.operation_key,
      status: row.status,
      recoveryMode: metadata.recoveryMode === true,
      recoveryAttemptId: metadata.recoveryAttemptId ?? null
    });
  };
}

module.exports = {
  createReconFixJpmRecoveryTaskStateReader
};
