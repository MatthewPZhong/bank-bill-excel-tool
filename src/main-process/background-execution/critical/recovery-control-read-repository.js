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
