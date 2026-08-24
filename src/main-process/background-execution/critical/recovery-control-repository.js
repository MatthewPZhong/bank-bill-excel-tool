'use strict';

const {
  canonicalJsonSnapshot,
  canonicalizeJson
} = require('../canonical-json-v1');
const {
  assertC1Transition,
  observationRequestKey,
  observationScopeKey,
  requestEvidence,
  transitionEventType,
  transitionRequestKey,
  validateObservationRequest,
  validateResult,
  validateTransitionRequest
} = require('../recovery-control-contract');
const {
  RecoveryControlError
} = require('./recovery-request-owner-repository');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../backend/database/background-execution-schema');

const FORBIDDEN_METADATA_PATCH_KEYS = new Set([
  'actionKey',
  'expectedTaskKey',
  'operationKey',
  'taskKey',
  'taskRunId',
  'status',
  'recoveryAttemptId'
]);

function fail(code, message, details = null) {
  throw new RecoveryControlError(code, message, details);
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('RecoveryControlRepository 需要 DatabaseSync');
  }
}

function ownerForRequest(db, requestKey) {
  return db.prepare(`
    SELECT request_key, writer, event_id, request_hash, request_jcs,
           status, created_at, committed_at
    FROM background_execution_recovery_request_owners
    WHERE request_key = ?
  `).get(requestKey) || null;
}

function verifyOwner(db, requestKey, writer, request) {
  const owner = ownerForRequest(db, requestKey);
  if (!owner) {
    fail('RECOVERY_REQUEST_OWNER_NOT_FOUND', 'recovery request 必须先由 Main-internal owner repository reserve');
  }
  const evidence = requestEvidence(writer, request);
  if (owner.writer !== writer
      || owner.event_id !== request.event.eventId
      || owner.created_at !== request.event.createdAt
      || owner.request_hash !== evidence.requestHash
      || owner.request_jcs !== evidence.requestJcs) {
    fail('RECOVERY_REQUEST_KEY_CONFLICT', 'request owner 与 exact request 不一致', { requestKey });
  }
  return { owner, evidence };
}

function parseMetadata(raw) {
  let value;
  try {
    value = JSON.parse(raw || '{}');
  } catch (_error) {
    fail('RECOVERY_TASK_METADATA_INVALID', 'TaskRun metadata_json 不是合法 JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RECOVERY_TASK_METADATA_INVALID', 'TaskRun metadata_json 不是 JSON object');
  }
  return canonicalJsonSnapshot(value);
}

function mergeMetadata(current, patch, additions = {}) {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_METADATA_PATCH_KEYS.has(key)) {
      fail('RECOVERY_METADATA_PATCH_IDENTITY_FORBIDDEN', `metadataPatch 不得覆盖控制字段：${key}`);
    }
  }
  return canonicalizeJson({ ...current, ...patch, ...additions });
}

function timestampOf(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('RecoveryControl now() 必须返回有效日期');
  return date.toISOString();
}

function assertOne(result, code, message) {
  if (!result || Number(result.changes) !== 1) fail(code, message);
}

function taskRow(db, transition) {
  const row = db.prepare(`
    SELECT task_run_id, task_key, operation_key, status,
           failure_code, failure_message, metadata_json,
           started_at, finished_at
    FROM archive_task_runs
    WHERE task_run_id = ?
      AND task_key = ?
      AND operation_key = ?
  `).get(
    transition.taskRunId,
    transition.expectedTaskKey,
    transition.operationKey
  );
  if (!row) {
    fail('RECOVERY_TASK_IDENTITY_CONFLICT', 'TaskRun canonical/legacy/operation identity 不匹配');
  }
  return row;
}

function applyTaskTransition(db, transition, timestamp) {
  const current = taskRow(db, transition);
  const metadata = parseMetadata(current.metadata_json);
  let nextState;
  let nextFailureCode;
  let nextFailureMessage;
  let nextMetadataJson;
  let startedAt = current.started_at;
  let finishedAt;

  if (transition.command === 'mark-interrupted') {
    if (current.status !== transition.expectedState) {
      fail('RECOVERY_TASK_STATE_CONFLICT', 'TaskRun mark-interrupted expectedState 不匹配');
    }
    if (metadata.recoveryAttemptId !== undefined && metadata.recoveryAttemptId !== null) {
      fail(
        'RECOVERY_TASK_ATTEMPT_CONFLICT',
        'active recovery 必须使用 interrupt-recovery，不能由 mark-interrupted 绕过'
      );
    }
    nextState = 'interrupted';
    nextFailureCode = transition.failureCode;
    nextFailureMessage = transition.failureMessage;
    nextMetadataJson = mergeMetadata(metadata, transition.metadataPatch);
    finishedAt = timestamp;
  } else if (transition.command === 'begin-recovery') {
    if (current.status !== 'interrupted'
        || (metadata.recoveryAttemptId !== undefined && metadata.recoveryAttemptId !== null)) {
      fail('RECOVERY_TASK_STATE_CONFLICT', 'TaskRun 只能从无 active attempt 的 interrupted 开始恢复');
    }
    nextState = 'running';
    nextFailureCode = current.failure_code;
    nextFailureMessage = current.failure_message;
    nextMetadataJson = mergeMetadata(metadata, transition.metadataPatch, {
      recoveryMode: true,
      recoveryAttemptId: transition.recoveryAttemptId
    });
    startedAt = timestamp;
    finishedAt = null;
  } else {
    if (current.status !== 'running'
        || metadata.recoveryMode !== true
        || metadata.recoveryAttemptId !== transition.recoveryAttemptId) {
      fail('RECOVERY_TASK_ATTEMPT_CONFLICT', 'TaskRun recovery completion 与 active attempt 不匹配');
    }
    nextState = transition.command === 'complete-recovery-success'
      ? 'succeeded'
      : transition.command === 'complete-recovery-failure'
        ? 'failed'
        : 'interrupted';
    nextFailureCode = nextState === 'succeeded' ? null : transition.failureCode;
    nextFailureMessage = nextState === 'succeeded' ? null : transition.failureMessage;
    nextMetadataJson = mergeMetadata(
      metadata,
      transition.metadataPatch,
      transition.command === 'interrupt-recovery'
        ? { recoveryMode: false, recoveryAttemptId: null }
        : {}
    );
    finishedAt = timestamp;
  }

  let result;
  if (transition.command === 'begin-recovery') {
    result = db.prepare(`
      UPDATE archive_task_runs
      SET status = 'running',
          failure_code = ?, failure_message = ?, metadata_json = ?,
          started_at = ?, finished_at = NULL, updated_at = ?
      WHERE task_run_id = ?
        AND task_key = ?
        AND operation_key = ?
        AND status = 'interrupted'
        AND json_extract(metadata_json, '$.recoveryAttemptId') IS NULL
    `).run(
      nextFailureCode,
      nextFailureMessage,
      nextMetadataJson,
      startedAt,
      timestamp,
      transition.taskRunId,
      transition.expectedTaskKey,
      transition.operationKey
    );
  } else if (transition.command === 'mark-interrupted') {
    result = db.prepare(`
      UPDATE archive_task_runs
      SET status = ?, failure_code = ?, failure_message = ?, metadata_json = ?,
          started_at = ?, finished_at = ?, updated_at = ?
      WHERE task_run_id = ?
        AND task_key = ?
        AND operation_key = ?
        AND status = ?
        AND json_extract(metadata_json, '$.recoveryAttemptId') IS NULL
        AND COALESCE(json_extract(metadata_json, '$.recoveryMode'), 0) <> 1
    `).run(
      nextState,
      nextFailureCode,
      nextFailureMessage,
      nextMetadataJson,
      startedAt,
      finishedAt,
      timestamp,
      transition.taskRunId,
      transition.expectedTaskKey,
      transition.operationKey,
      transition.expectedState
    );
  } else {
    result = db.prepare(`
      UPDATE archive_task_runs
      SET status = ?, failure_code = ?, failure_message = ?, metadata_json = ?,
          started_at = ?, finished_at = ?, updated_at = ?
      WHERE task_run_id = ?
        AND task_key = ?
        AND operation_key = ?
        AND status = ?
        AND (
          ? IS NULL
          OR json_extract(metadata_json, '$.recoveryAttemptId') = ?
        )
    `).run(
      nextState,
      nextFailureCode,
      nextFailureMessage,
      nextMetadataJson,
      startedAt,
      finishedAt,
      timestamp,
      transition.taskRunId,
      transition.expectedTaskKey,
      transition.operationKey,
      transition.expectedState,
      transition.recoveryAttemptId,
      transition.recoveryAttemptId
    );
  }
  assertOne(result, 'RECOVERY_TASK_CAS_CONFLICT', 'TaskRun CAS changes() 必须等于 1');
  return Object.freeze({
    actionKey: transition.actionKey,
    operationKey: transition.operationKey,
    taskRunId: transition.taskRunId,
    sourceKind: transition.sourceKind,
    sourceRef: transition.sourceRef,
    batchId: null,
    intentId: null,
    holdId: null,
    recoveryAttemptId: transition.recoveryAttemptId || null,
    previousState: current.status,
    nextState
  });
}

function batchIdentityRow(db, transition) {
  const rows = db.prepare(`
    SELECT batch.id, batch.task_run_id, batch.task_key, batch.operation_key,
           batch.task_status, task.status, task.metadata_json
    FROM archive_batches AS batch
    JOIN archive_task_runs AS task
      ON task.task_run_id = batch.task_run_id
     AND task.task_key = batch.task_key
     AND task.operation_key = batch.operation_key
    WHERE batch.id = ?
      AND batch.task_run_id = ?
      AND batch.task_key = ?
      AND batch.operation_key = ?
      AND task.task_run_id = ?
      AND task.task_key = ?
      AND task.operation_key = ?
  `).all(
    transition.batchId,
    transition.taskRunId,
    transition.expectedTaskKey,
    transition.operationKey,
    transition.taskRunId,
    transition.expectedTaskKey,
    transition.operationKey
  );
  if (rows.length !== 1) {
    fail('RECOVERY_BATCH_IDENTITY_CONFLICT', 'Batch/Task physical identity join 必须恰为一行');
  }
  return rows[0];
}

function applyBatchTransition(db, transition, timestamp) {
  const identity = batchIdentityRow(db, transition);
  let previousState;
  let nextState;
  if (transition.command === 'mark-interrupted') {
    previousState = identity.task_status;
    nextState = 'interrupted';
    assertOne(db.prepare(`
      UPDATE archive_batches
      SET task_status = 'failed', failure_code = ?, failure_message = ?,
          finished_at = ?, updated_at = ?
      WHERE id = ?
        AND task_run_id = ?
        AND task_key = ?
        AND operation_key = ?
        AND task_status IN ('reserved', 'running')
    `).run(
      transition.failureCode,
      transition.failureMessage,
      timestamp,
      timestamp,
      transition.batchId,
      transition.taskRunId,
      transition.expectedTaskKey,
      transition.operationKey
    ), 'RECOVERY_BATCH_CAS_CONFLICT', 'Batch compatibility CAS changes() 必须等于 1');
    assertOne(db.prepare(`
      INSERT INTO background_execution_batch_recovery_states (
        batch_id, task_run_id, state, final_outcome, recovery_attempt_id,
        source_kind, source_ref, created_at, updated_at, resolved_at
      ) VALUES (?, ?, 'interrupted', NULL, NULL, ?, ?, ?, ?, NULL)
    `).run(
      transition.batchId,
      transition.taskRunId,
      transition.sourceKind,
      transition.sourceRef,
      timestamp,
      timestamp
    ), 'RECOVERY_BATCH_OVERLAY_CAS_CONFLICT', 'Batch overlay INSERT changes() 必须等于 1');
  } else if (transition.command === 'begin-recovery') {
    previousState = 'interrupted';
    nextState = 'recovering';
    assertOne(db.prepare(`
      UPDATE background_execution_batch_recovery_states AS overlay
      SET state = 'recovering', recovery_attempt_id = ?, updated_at = ?
      WHERE overlay.batch_id = ?
        AND overlay.task_run_id = ?
        AND overlay.state = 'interrupted'
        AND overlay.final_outcome IS NULL
        AND overlay.recovery_attempt_id IS NULL
        AND overlay.source_kind = ?
        AND overlay.source_ref = ?
    `).run(
      transition.recoveryAttemptId,
      timestamp,
      transition.batchId,
      transition.taskRunId,
      transition.sourceKind,
      transition.sourceRef
    ), 'RECOVERY_BATCH_OVERLAY_CAS_CONFLICT', 'Batch overlay recovery CAS changes() 必须等于 1');
  } else {
    previousState = 'recovering';
    nextState = 'resolved';
    const finalOutcome = transition.command === 'resolve-success' ? 'succeeded' : 'failed';
    assertOne(db.prepare(`
      UPDATE background_execution_batch_recovery_states AS overlay
      SET state = 'resolved', final_outcome = ?, updated_at = ?, resolved_at = ?
      WHERE overlay.batch_id = ?
        AND overlay.task_run_id = ?
        AND overlay.state = 'recovering'
        AND overlay.final_outcome IS NULL
        AND overlay.recovery_attempt_id = ?
        AND overlay.source_kind = ?
        AND overlay.source_ref = ?
    `).run(
      finalOutcome,
      timestamp,
      timestamp,
      transition.batchId,
      transition.taskRunId,
      transition.recoveryAttemptId,
      transition.sourceKind,
      transition.sourceRef
    ), 'RECOVERY_BATCH_OVERLAY_CAS_CONFLICT', 'Batch overlay resolution CAS changes() 必须等于 1');
  }
  return Object.freeze({
    actionKey: transition.actionKey,
    operationKey: transition.operationKey,
    taskRunId: transition.taskRunId,
    sourceKind: transition.sourceKind,
    sourceRef: transition.sourceRef,
    batchId: transition.batchId,
    intentId: null,
    holdId: null,
    recoveryAttemptId: transition.recoveryAttemptId || null,
    previousState,
    nextState
  });
}

function insertEvent(db, value) {
  assertOne(db.prepare(`
    INSERT INTO background_execution_recovery_events (
      request_key, writer, event_id, request_hash,
      action_key, operation_key, task_run_id,
      source_kind, source_ref, batch_id, intent_id, hold_id,
      recovery_attempt_id, observation_scope_key, observation_attempt_id,
      event_type, previous_state, next_state, safe_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.requestKey,
    value.writer,
    value.eventId,
    value.requestHash,
    value.actionKey,
    value.operationKey,
    value.taskRunId,
    value.sourceKind,
    value.sourceRef,
    value.batchId,
    value.intentId,
    value.holdId,
    value.recoveryAttemptId,
    value.observationScopeKey,
    value.observationAttemptId,
    value.eventType,
    value.previousState,
    value.nextState,
    canonicalizeJson(value.safePayload, { maxBytes: 16384 }),
    value.createdAt
  ), 'RECOVERY_EVENT_WRITE_CONFLICT', 'recovery event INSERT changes() 必须等于 1');
}

function commitOwner(db, owner, timestamp) {
  assertOne(db.prepare(`
    UPDATE background_execution_recovery_request_owners
    SET status = 'committed', committed_at = ?
    WHERE request_key = ?
      AND writer = ?
      AND event_id = ?
      AND request_hash = ?
      AND created_at = ?
      AND status = 'prepared'
  `).run(
    timestamp,
    owner.request_key,
    owner.writer,
    owner.event_id,
    owner.request_hash,
    owner.created_at
  ), 'RECOVERY_REQUEST_OWNER_COMMIT_CONFLICT', 'request owner commit changes() 必须等于 1');
}

function immutableResult(db, owner, writer) {
  const row = db.prepare(`
    SELECT 1 AS contractVersion,
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
    WHERE event.request_key = ?
      AND event.event_id = ?
      AND event.request_hash = ?
  `).get(owner.request_key, owner.event_id, owner.request_hash);
  if (!row) fail('RECOVERY_COMMITTED_EVENT_MISSING', 'committed request owner 缺少 immutable event');
  try {
    row.safePayload = JSON.parse(row.safePayload);
  } catch (_error) {
    fail('RECOVERY_EVENT_PAYLOAD_INVALID', 'persisted safe_payload_json 非法');
  }
  row.batchId = row.batchId == null ? null : Number(row.batchId);
  row.observationAttemptId = row.observationAttemptId == null
    ? null
    : Number(row.observationAttemptId);
  return validateResult(row, writer);
}

function transitionWithEvent(db, input, now) {
  const request = validateTransitionRequest(input);
  const transition = assertC1Transition(request.transition);
  const requestKey = transitionRequestKey(transition);
  const { owner, evidence } = verifyOwner(
    db,
    requestKey,
    'transitionWithRecoveryEvent',
    request
  );
  if (owner.status === 'committed') {
    return immutableResult(db, owner, 'transitionWithRecoveryEvent');
  }
  if (db.prepare(`SELECT 1 FROM background_execution_recovery_events WHERE request_key = ?`).get(requestKey)) {
    fail('RECOVERY_PREPARED_OWNER_EVENT_CONFLICT', 'prepared owner 已存在 event，拒绝猜测修复');
  }

  const lineage = transition.entityKind === 'task-run'
    ? applyTaskTransition(db, transition, request.event.createdAt)
    : applyBatchTransition(db, transition, request.event.createdAt);
  insertEvent(db, {
    requestKey,
    writer: 'transitionWithRecoveryEvent',
    eventId: request.event.eventId,
    requestHash: evidence.requestHash,
    ...lineage,
    observationScopeKey: null,
    observationAttemptId: null,
    eventType: transitionEventType(transition),
    safePayload: request.event.safePayload,
    createdAt: request.event.createdAt
  });
  commitOwner(db, owner, timestampOf(now));
  return immutableResult(db, { ...owner, request_hash: evidence.requestHash }, 'transitionWithRecoveryEvent');
}

function appendObservation(db, eventInput, now) {
  const request = validateObservationRequest({ event: eventInput });
  const event = request.event;
  const requestKey = observationRequestKey(event);
  const scopeKey = observationScopeKey(event);
  const { owner, evidence } = verifyOwner(db, requestKey, 'appendObservationEvent', request);
  if (owner.status === 'committed') {
    return immutableResult(db, owner, 'appendObservationEvent');
  }
  if (db.prepare(`SELECT 1 FROM background_execution_recovery_events WHERE request_key = ?`).get(requestKey)) {
    fail('RECOVERY_PREPARED_OWNER_EVENT_CONFLICT', 'prepared observation owner 已存在 event');
  }
  const attempt = db.prepare(`
    SELECT request_key, status
    FROM background_execution_recovery_observation_attempts
    WHERE observation_scope_key = ? AND observation_attempt_id = ?
  `).get(scopeKey, event.observationAttemptId);
  if (!attempt || attempt.status !== 'prepared' || attempt.request_key !== requestKey) {
    fail('RECOVERY_OBSERVATION_ATTEMPT_CONFLICT', 'observation attempt 未 prepared/bind 到当前 request');
  }

  insertEvent(db, {
    requestKey,
    writer: 'appendObservationEvent',
    eventId: event.eventId,
    requestHash: evidence.requestHash,
    actionKey: event.actionKey,
    operationKey: event.operationKey,
    taskRunId: event.taskRunId,
    sourceKind: event.sourceKind,
    sourceRef: event.sourceRef,
    batchId: event.batchId ?? null,
    intentId: event.intentId ?? null,
    holdId: event.holdId ?? null,
    recoveryAttemptId: event.recoveryAttemptId ?? null,
    observationScopeKey: scopeKey,
    observationAttemptId: event.observationAttemptId,
    eventType: event.eventType,
    previousState: null,
    nextState: null,
    safePayload: event.safePayload,
    createdAt: event.createdAt
  });
  const committedAt = timestampOf(now);
  commitOwner(db, owner, committedAt);
  assertOne(db.prepare(`
    UPDATE background_execution_recovery_observation_attempts
    SET status = 'committed', committed_at = ?
    WHERE observation_scope_key = ?
      AND observation_attempt_id = ?
      AND request_key = ?
      AND status = 'prepared'
  `).run(committedAt, scopeKey, event.observationAttemptId, requestKey),
  'RECOVERY_OBSERVATION_ATTEMPT_COMMIT_CONFLICT',
  'observation attempt commit changes() 必须等于 1');
  return immutableResult(db, { ...owner, request_hash: evidence.requestHash }, 'appendObservationEvent');
}

function createRecoveryControlRepository(db, options = {}) {
  assertDatabase(db);
  const now = options.now || (() => new Date());
  if (typeof now !== 'function') throw new TypeError('RecoveryControl now 必须是函数');
  ensureBackgroundExecutionRecoveryControlSchema(db);
  let active = false;
  return Object.freeze({
    runInControlTransaction(work) {
      if (typeof work !== 'function') throw new TypeError('control transaction work 必须是函数');
      if (active || db.isTransaction === true) {
        fail('RECOVERY_CONTROL_TRANSACTION_NESTED', 'RecoveryControl transaction 不允许嵌套');
      }
      db.exec('BEGIN IMMEDIATE');
      active = true;
      let txActive = true;
      let firstScopedError = null;
      const invokeScopedWriter = (writer) => {
        if (!txActive) fail('RECOVERY_CONTROL_TRANSACTION_CLOSED', 'control transaction 已关闭');
        if (firstScopedError !== null) {
          fail(
            'RECOVERY_CONTROL_TRANSACTION_POISONED',
            'control transaction 已因先前 scoped writer 失败而中毒'
          );
        }
        try {
          return writer();
        } catch (error) {
          firstScopedError = error;
          throw error;
        }
      };
      const tx = Object.freeze({
        transitionWithRecoveryEvent(input) {
          return invokeScopedWriter(() => transitionWithEvent(db, input, now));
        },
        appendObservationEvent(event) {
          return invokeScopedWriter(() => appendObservation(db, event, now));
        }
      });
      try {
        const result = work(tx);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          fail('RECOVERY_CONTROL_ASYNC_TRANSACTION_FORBIDDEN', 'control transaction callback 不得返回 Promise');
        }
        if (firstScopedError !== null) throw firstScopedError;
        txActive = false;
        db.exec('COMMIT');
        return result;
      } catch (error) {
        const originalError = firstScopedError || error;
        txActive = false;
        try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 保留原错误。 */ }
        throw originalError;
      } finally {
        active = false;
      }
    }
  });
}

module.exports = {
  createRecoveryControlRepository
};
