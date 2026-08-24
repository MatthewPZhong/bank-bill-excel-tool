'use strict';

const { canonicalJsonSnapshot } = require('../canonical-json-v1');
const { validateResult } = require('../recovery-control-contract');

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('RecoveryControlReadRepository 需要 DatabaseSync');
  }
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} 必须是正安全整数`);
  }
  return number;
}

function projectionFromRow(row) {
  let safePayload;
  try {
    safePayload = JSON.parse(row.safePayload);
  } catch (_error) {
    const error = new Error('persisted recovery event safe_payload_json 非法');
    error.code = 'RECOVERY_EVENT_PAYLOAD_INVALID';
    throw error;
  }
  const projection = {
    contractVersion: 1,
    requestKey: row.requestKey,
    writer: row.writer,
    eventId: row.eventId,
    requestHash: row.requestHash,
    actionKey: row.actionKey,
    operationKey: row.operationKey,
    taskRunId: row.taskRunId,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    batchId: row.batchId == null ? null : Number(row.batchId),
    intentId: row.intentId,
    holdId: row.holdId,
    recoveryAttemptId: row.recoveryAttemptId,
    observationAttemptId: row.observationAttemptId == null
      ? null
      : Number(row.observationAttemptId),
    eventType: row.eventType,
    previousState: row.previousState,
    nextState: row.nextState,
    safePayload,
    createdAt: row.createdAt
  };
  return validateResult(projection, row.writer);
}

function parsePersistedObject(raw, label) {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return canonicalJsonSnapshot(value);
  } catch (_error) {
    const error = new Error(`persisted ${label} 非法`);
    error.code = 'RECOVERY_CONTROL_PERSISTED_JSON_INVALID';
    throw error;
  }
}

function criticalIntentFromRow(row) {
  if (!row) return null;
  return canonicalJsonSnapshot({
    contractVersion: Number(row.contract_version),
    intentId: row.intent_id,
    actionKey: row.action_key,
    operationKey: row.operation_key,
    taskRunId: row.task_run_id,
    jobId: row.job_id,
    coordinationKind: row.coordination_kind,
    state: row.state,
    conflictScopeKey: row.conflict_scope_key,
    inspectorKey: row.inspector_key,
    evidenceVersion: Number(row.evidence_version),
    boundedEvidence: parsePersistedObject(row.evidence_json, 'intent evidence_json'),
    evidenceHash: row.evidence_sha256,
    receiptRef: parsePersistedObject(row.receipt_ref_json, 'intent receipt_ref_json'),
    result: parsePersistedObject(row.result_json, 'intent result_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    retentionUntil: row.retention_until
  });
}

function recoveryHoldFromRow(row) {
  if (!row) return null;
  return canonicalJsonSnapshot({
    holdId: row.hold_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    intentId: row.intent_id,
    actionKey: row.action_key,
    operationKey: row.operation_key,
    taskRunId: row.task_run_id,
    conflictScopeKey: row.conflict_scope_key,
    reasonCode: row.reason_code,
    status: row.status,
    resolution: row.resolution,
    safeSummary: parsePersistedObject(row.safe_summary_json, 'hold safe_summary_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at
  });
}

const INTENT_SELECT = `
  SELECT contract_version, intent_id, action_key, operation_key, task_run_id,
         job_id, coordination_kind, state, conflict_scope_key, inspector_key,
         evidence_version, evidence_json, evidence_sha256, receipt_ref_json,
         result_json, created_at, updated_at, closed_at, retention_until
  FROM background_execution_critical_intents
`;

const HOLD_SELECT = `
  SELECT hold_id, source_kind, source_ref, intent_id, action_key,
         operation_key, task_run_id, conflict_scope_key, reason_code,
         status, resolution, safe_summary_json,
         created_at, updated_at, resolved_at
  FROM background_execution_recovery_holds
`;

const EVENT_PROJECTION_SELECT = `
  SELECT event.id AS sequenceId,
         event.request_key AS requestKey,
         event.writer AS writer,
         event.event_id AS eventId,
         event.request_hash AS requestHash,
         event.action_key AS actionKey,
         event.operation_key AS operationKey,
         event.task_run_id AS taskRunId,
         event.source_kind AS sourceKind,
         event.source_ref AS sourceRef,
         event.batch_id AS batchId,
         event.intent_id AS intentId,
         event.hold_id AS holdId,
         event.recovery_attempt_id AS recoveryAttemptId,
         event.observation_attempt_id AS observationAttemptId,
         event.event_type AS eventType,
         event.previous_state AS previousState,
         event.next_state AS nextState,
         event.safe_payload_json AS safePayload,
         event.created_at AS createdAt
  FROM background_execution_recovery_events AS event
`;

function createRecoveryControlReadRepository(db) {
  assertDatabase(db);
  return Object.freeze({
    getCriticalIntentById(intentId) {
      if (typeof intentId !== 'string' || intentId.length === 0) {
        throw new TypeError('intentId 不能为空');
      }
      return criticalIntentFromRow(db.prepare(`
        ${INTENT_SELECT} WHERE intent_id = ?
      `).get(intentId));
    },

    getCriticalIntentByOperation(actionKey, operationKey, taskRunId) {
      for (const [value, label] of [[actionKey, 'actionKey'], [operationKey, 'operationKey'], [taskRunId, 'taskRunId']]) {
        if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} 不能为空`);
      }
      return criticalIntentFromRow(db.prepare(`
        ${INTENT_SELECT}
        WHERE action_key = ? AND operation_key = ? AND task_run_id = ?
      `).get(actionKey, operationKey, taskRunId));
    },

    listOpenCriticalIntents() {
      return db.prepare(`
        ${INTENT_SELECT}
        WHERE state <> 'closed'
        ORDER BY id
      `).all().map(criticalIntentFromRow);
    },

    listCriticalIntentsByScope(conflictScopeKey) {
      if (typeof conflictScopeKey !== 'string' || conflictScopeKey.length === 0) {
        throw new TypeError('conflictScopeKey 不能为空');
      }
      return db.prepare(`
        ${INTENT_SELECT}
        WHERE conflict_scope_key = ?
        ORDER BY id
      `).all(conflictScopeKey).map(criticalIntentFromRow);
    },

    getRecoveryHoldBySource(sourceKind, sourceRef) {
      if (typeof sourceKind !== 'string' || sourceKind.length === 0
          || typeof sourceRef !== 'string' || sourceRef.length === 0) {
        throw new TypeError('sourceKind/sourceRef 不能为空');
      }
      return recoveryHoldFromRow(db.prepare(`
        ${HOLD_SELECT} WHERE source_kind = ? AND source_ref = ?
      `).get(sourceKind, sourceRef));
    },

    getActiveRecoveryHoldByScope(conflictScopeKey) {
      if (typeof conflictScopeKey !== 'string' || conflictScopeKey.length === 0) {
        throw new TypeError('conflictScopeKey 不能为空');
      }
      return recoveryHoldFromRow(db.prepare(`
        ${HOLD_SELECT}
        WHERE conflict_scope_key = ? AND status = 'active'
      `).get(conflictScopeKey));
    },

    listActiveRecoveryHolds() {
      return db.prepare(`
        ${HOLD_SELECT}
        WHERE status = 'active'
        ORDER BY id
      `).all().map(recoveryHoldFromRow);
    },

    getEffectiveBatchStatus(batchId, taskRunId) {
      const id = positiveSafeInteger(batchId, 'batchId');
      if (typeof taskRunId !== 'string' || taskRunId.length === 0) {
        throw new TypeError('taskRunId 不能为空');
      }
      const row = db.prepare(`
        SELECT batch.task_status AS base_status,
               overlay.state AS overlay_state,
               overlay.final_outcome AS final_outcome
        FROM archive_batches AS batch
        LEFT JOIN background_execution_batch_recovery_states AS overlay
          ON overlay.batch_id = batch.id
         AND overlay.task_run_id = batch.task_run_id
        WHERE batch.id = ? AND batch.task_run_id = ?
      `).get(id, taskRunId);
      if (!row) return null;
      if (row.overlay_state === 'interrupted') return 'interrupted';
      if (row.overlay_state === 'recovering') return 'recovering';
      if (row.overlay_state === 'resolved') return row.final_outcome;
      return row.base_status;
    },

    listRecoveryEvents(taskRunId, cursor = 0, limit = 100) {
      if (typeof taskRunId !== 'string' || taskRunId.length === 0) {
        throw new TypeError('taskRunId 不能为空');
      }
      const after = Number(cursor);
      const count = Number(limit);
      if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('cursor 必须是非负安全整数');
      if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
        throw new TypeError('limit 必须是 1..500');
      }
      return db.prepare(`
        ${EVENT_PROJECTION_SELECT}
        WHERE event.task_run_id = ? AND event.id > ?
        ORDER BY event.id
        LIMIT ?
      `).all(taskRunId, after, count).map((row) => canonicalJsonSnapshot({
        sequenceId: Number(row.sequenceId),
        ...projectionFromRow(row)
      }));
    }
  });
}

module.exports = {
  createRecoveryControlReadRepository
};
