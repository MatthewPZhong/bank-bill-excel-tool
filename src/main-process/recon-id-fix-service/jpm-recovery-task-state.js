'use strict';

const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { deriveReconFixJpmConflictScopeKey } = require('./jpm-conflict-scope');
const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

const RECON_FIX_RUN_TASK_KEY = 'recon-id-fix:run';
const RECON_FIX_MODULE_ID = 'recon-fix';
const WORKER_CRITICAL_COORDINATION_KIND = 'worker-critical';

function persistedStateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createReconFixJpmRecoveryTaskStateReader(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('ReconFix JPM recovery Task state reader 需要 DatabaseSync');
  }
  return function readReconFixJpmRecoveryTaskState(source) {
    if (!source) return null;
    if (typeof source.taskRunId !== 'string' || !source.taskRunId) {
      if (source.actionKey !== RECON_FIX_RUN_JPM_ACTION) return null;
      throw new TypeError('ReconFix JPM recovery source taskRunId 不能为空');
    }
    const row = db.prepare(`
      SELECT task_run_id, module_id, task_key, operation_key,
             status, failure_code, metadata_json
      FROM archive_task_runs
      WHERE task_run_id = ?
    `).get(source.taskRunId);
    if (!row) return null;
    if (source.actionKey !== RECON_FIX_RUN_JPM_ACTION && row.module_id !== RECON_FIX_MODULE_ID) {
      return null;
    }
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
      moduleId: row.module_id,
      taskKey: row.task_key,
      operationKey: row.operation_key,
      retainedCommittedResultLostIdentity: {
        actionKey: RECON_FIX_RUN_JPM_ACTION,
        moduleId: RECON_FIX_MODULE_ID,
        taskKey: RECON_FIX_RUN_TASK_KEY,
        coordinationKind: WORKER_CRITICAL_COORDINATION_KIND,
        conflictScopeKey: deriveReconFixJpmConflictScopeKey()
      },
      status: row.status,
      failureCode: row.failure_code || null,
      recoveryHold: metadata.recoveryHold === true,
      recoveryMode: metadata.recoveryMode === true,
      recoveryAttemptId: metadata.recoveryAttemptId ?? null
    });
  };
}

module.exports = {
  createReconFixJpmRecoveryTaskStateReader
};
