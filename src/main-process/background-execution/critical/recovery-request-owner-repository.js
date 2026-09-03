'use strict';

const { randomUUID } = require('node:crypto');
const {
  canonicalJsonSnapshot
} = require('../canonical-json-v1');
const {
  assertC1Transition,
  observationRequestKey,
  observationScopeKey,
  requestEvidence,
  transitionRequestKey,
  validateObservationRequest,
  validateTransition,
  validateTransitionRequest
} = require('../recovery-control-contract');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../backend/database/background-execution-schema');

class RecoveryControlError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RecoveryControlError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new RecoveryControlError(code, message, details);
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('RecoveryControl request owner 需要 DatabaseSync');
  }
}

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是 plain object`);
  }
  const snapshot = canonicalJsonSnapshot(value);
  const keys = Object.keys(snapshot).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} exact keys 不匹配`);
  }
  return snapshot;
}

function timestampOf(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now() 必须返回有效日期');
  return date.toISOString();
}

function runImmediate(db, work) {
  if (db.isTransaction === true) {
    fail(
      'RECOVERY_OWNER_TRANSACTION_SCOPE_INVALID',
      'request owner/observation attempt 短事务不能嵌套在 control transaction 内'
    );
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 保留原错误。 */ }
    throw error;
  }
}

function ownerRow(db, requestKey) {
  return db.prepare(`
    SELECT request_key, writer, event_id, request_hash, request_jcs,
           status, created_at, committed_at
    FROM background_execution_recovery_request_owners
    WHERE request_key = ?
  `).get(requestKey) || null;
}

function verifyExistingOwner(row, expected) {
  if (row.writer !== expected.writer
      || row.event_id !== expected.eventId
      || row.created_at !== expected.createdAt
      || row.request_hash !== expected.requestHash
      || row.request_jcs !== expected.requestJcs) {
    fail(
      'RECOVERY_REQUEST_KEY_CONFLICT',
      'requestKey 已绑定到不同 exact recovery request',
      { requestKey: row.request_key }
    );
  }
}

function insertOwner(db, value) {
  try {
    const inserted = db.prepare(`
      INSERT INTO background_execution_recovery_request_owners (
        request_key, writer, event_id, request_hash, request_jcs,
        status, created_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, NULL)
    `).run(
      value.requestKey,
      value.writer,
      value.eventId,
      value.requestHash,
      value.requestJcs,
      value.createdAt
    );
    if (Number(inserted.changes) !== 1) {
      fail('RECOVERY_REQUEST_OWNER_WRITE_CONFLICT', 'request owner INSERT changes() 必须等于 1');
    }
  } catch (error) {
    if (error instanceof RecoveryControlError) throw error;
    const occupied = db.prepare(`
      SELECT request_key, request_hash
      FROM background_execution_recovery_request_owners
      WHERE event_id = ?
    `).get(value.eventId);
    if (occupied) {
      fail('RECOVERY_EVENT_ID_CONFLICT', 'eventId 已绑定到不同 recovery request');
    }
    throw error;
  }
}

function transitionReservation(db, input, now, createEventId) {
  const owned = exactObject(input, ['requestKey', 'transition', 'safePayload'], 'reserveTransitionRequest input');
  const transition = assertC1Transition(validateTransition(owned.transition));
  const computedRequestKey = transitionRequestKey(transition);
  if (owned.requestKey !== computedRequestKey) {
    fail('RECOVERY_REQUEST_KEY_MISMATCH', 'transition requestKey 与 durable identity tuple 不一致');
  }

  return runImmediate(db, () => {
    const existing = ownerRow(db, computedRequestKey);
    const eventId = existing ? existing.event_id : createEventId();
    const createdAt = existing ? existing.created_at : timestampOf(now);
    const request = validateTransitionRequest({
      transition,
      event: { eventId, createdAt, safePayload: owned.safePayload }
    });
    const evidence = requestEvidence('transitionWithRecoveryEvent', request);
    const expected = {
      requestKey: computedRequestKey,
      writer: 'transitionWithRecoveryEvent',
      eventId,
      createdAt,
      ...evidence
    };
    if (existing) {
      verifyExistingOwner(existing, expected);
    } else {
      insertOwner(db, expected);
    }
    return Object.freeze({ transition: request.transition, event: request.event });
  });
}

const OBSERVATION_DRAFT_REQUIRED = Object.freeze([
  'eventType',
  'observationAttemptId',
  'actionKey',
  'operationKey',
  'taskRunId',
  'sourceKind',
  'sourceRef',
  'safePayload'
]);
const OBSERVATION_DRAFT_OPTIONAL = Object.freeze([
  'batchId',
  'intentId',
  'holdId',
  'recoveryAttemptId'
]);

function exactObjectWithOptional(value, requiredKeys, optionalKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是 plain object`);
  }
  const snapshot = canonicalJsonSnapshot(value);
  const keys = Object.keys(snapshot);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(snapshot, key))
      || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} exact keys 不匹配`);
  }
  return snapshot;
}

function attemptMatchesEvent(attempt, event, scopeKey) {
  return attempt
    && attempt.observation_scope_key === scopeKey
    && Number(attempt.observation_attempt_id) === event.observationAttemptId
    && attempt.event_type === event.eventType
    && attempt.action_key === event.actionKey
    && attempt.operation_key === event.operationKey
    && attempt.task_run_id === event.taskRunId
    && attempt.source_kind === event.sourceKind
    && attempt.source_ref === event.sourceRef
    && (attempt.batch_id == null ? null : Number(attempt.batch_id)) === event.batchId
    && attempt.intent_id === event.intentId
    && attempt.hold_id === event.holdId
    && attempt.recovery_attempt_id === event.recoveryAttemptId;
}

function observationReservation(db, input, now, createEventId) {
  const owned = exactObject(
    input,
    ['requestKey', 'observationScopeKey', 'event'],
    'reserveObservationRequest input'
  );
  const draft = exactObjectWithOptional(
    owned.event,
    OBSERVATION_DRAFT_REQUIRED,
    OBSERVATION_DRAFT_OPTIONAL,
    'observation event draft'
  );
  const normalizedDraft = {
    ...draft,
    batchId: draft.batchId ?? null,
    intentId: draft.intentId ?? null,
    holdId: draft.holdId ?? null,
    recoveryAttemptId: draft.recoveryAttemptId ?? null
  };
  const computedRequestKey = observationRequestKey(normalizedDraft);
  if (owned.requestKey !== computedRequestKey) {
    fail('RECOVERY_REQUEST_KEY_MISMATCH', 'observation requestKey 与 durable attempt tuple 不一致');
  }
  const computedScopeKey = observationScopeKey(normalizedDraft);
  if (owned.observationScopeKey !== computedScopeKey) {
    fail('RECOVERY_OBSERVATION_SCOPE_MISMATCH', 'observationScopeKey 与 durable scope 不一致');
  }

  return runImmediate(db, () => {
    const attempt = db.prepare(`
      SELECT * FROM background_execution_recovery_observation_attempts
      WHERE observation_scope_key = ? AND observation_attempt_id = ?
    `).get(computedScopeKey, normalizedDraft.observationAttemptId);
    if (!attemptMatchesEvent(attempt, normalizedDraft, computedScopeKey)) {
      fail('RECOVERY_OBSERVATION_ATTEMPT_CONFLICT', 'observation attempt 与 event identity 不一致');
    }
    if (attempt.status !== 'prepared') {
      const existing = ownerRow(db, computedRequestKey);
      if (!existing || attempt.request_key !== computedRequestKey) {
        fail('RECOVERY_OBSERVATION_ATTEMPT_CONFLICT', 'committed observation attempt 缺少匹配 owner');
      }
    }

    const existing = ownerRow(db, computedRequestKey);
    const eventId = existing ? existing.event_id : createEventId();
    const createdAt = existing ? existing.created_at : timestampOf(now);
    const request = validateObservationRequest({
      event: { ...draft, eventId, createdAt }
    });
    const evidence = requestEvidence('appendObservationEvent', request);
    const expected = {
      requestKey: computedRequestKey,
      writer: 'appendObservationEvent',
      eventId,
      createdAt,
      ...evidence
    };
    if (existing) verifyExistingOwner(existing, expected);
    else insertOwner(db, expected);

    const bound = db.prepare(`
      UPDATE background_execution_recovery_observation_attempts
      SET request_key = ?
      WHERE observation_scope_key = ?
        AND observation_attempt_id = ?
        AND status = 'prepared'
        AND (request_key IS NULL OR request_key = ?)
    `).run(
      computedRequestKey,
      computedScopeKey,
      normalizedDraft.observationAttemptId,
      computedRequestKey
    );
    if (Number(bound.changes) !== 1 && attempt.status === 'prepared') {
      fail('RECOVERY_OBSERVATION_ATTEMPT_BIND_CONFLICT', 'observation attempt bind changes() 必须等于 1');
    }
    return request.event;
  });
}

const OBSERVATION_SCOPE_KEYS = Object.freeze([
  'eventType',
  'actionKey',
  'operationKey',
  'taskRunId',
  'sourceKind',
  'sourceRef',
  'batchId',
  'intentId',
  'holdId',
  'recoveryAttemptId'
]);

function normalizeScope(value) {
  const owned = exactObject(value, OBSERVATION_SCOPE_KEYS, 'observation attempt scope');
  return Object.freeze({
    ...owned,
    batchId: owned.batchId ?? null,
    intentId: owned.intentId ?? null,
    holdId: owned.holdId ?? null,
    recoveryAttemptId: owned.recoveryAttemptId ?? null
  });
}

function createRecoveryObservationAttemptRepository(db, options = {}) {
  assertDatabase(db);
  const now = options.now || (() => new Date());
  ensureBackgroundExecutionRecoveryControlSchema(db);
  return Object.freeze({
    allocateNextObservationAttempt(scope) {
      const normalized = normalizeScope(scope);
      const scopeKey = observationScopeKey(normalized);
      return runImmediate(db, () => {
        const pending = db.prepare(`
          SELECT observation_attempt_id
          FROM background_execution_recovery_observation_attempts
          WHERE observation_scope_key = ? AND status = 'prepared'
          ORDER BY observation_attempt_id
        `).all(scopeKey);
        if (pending.length > 0) {
          fail(
            'RECOVERY_OBSERVATION_ATTEMPT_PENDING',
            '同一 scope 已有 prepared observation attempt，必须先 resume/commit'
          );
        }
        const row = db.prepare(`
          SELECT COALESCE(MAX(observation_attempt_id), 0) AS max_attempt
          FROM background_execution_recovery_observation_attempts
          WHERE observation_scope_key = ?
        `).get(scopeKey);
        const attemptId = Number(row.max_attempt) + 1;
        if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
          fail('RECOVERY_OBSERVATION_ATTEMPT_EXHAUSTED', 'observation attempt ordinal 已耗尽');
        }
        const preparedAt = timestampOf(now);
        const inserted = db.prepare(`
          INSERT INTO background_execution_recovery_observation_attempts (
            observation_scope_key, observation_attempt_id, event_type,
            action_key, operation_key, task_run_id, source_kind, source_ref,
            batch_id, intent_id, hold_id, recovery_attempt_id,
            request_key, status, prepared_at, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL)
        `).run(
          scopeKey,
          attemptId,
          normalized.eventType,
          normalized.actionKey,
          normalized.operationKey,
          normalized.taskRunId,
          normalized.sourceKind,
          normalized.sourceRef,
          normalized.batchId,
          normalized.intentId,
          normalized.holdId,
          normalized.recoveryAttemptId,
          preparedAt
        );
        if (Number(inserted.changes) !== 1) {
          fail('RECOVERY_OBSERVATION_ATTEMPT_WRITE_CONFLICT', 'observation attempt INSERT changes() 必须等于 1');
        }
        return Object.freeze({
          observationScopeKey: scopeKey,
          observationAttemptId: attemptId,
          status: 'prepared'
        });
      });
    },

    resumePreparedObservationAttempt(scopeKey) {
      if (typeof scopeKey !== 'string' || !scopeKey.startsWith('observation-attempt:v1:')) {
        throw new TypeError('observationScopeKey 非法');
      }
      const rows = db.prepare(`
        SELECT observation_attempt_id
        FROM background_execution_recovery_observation_attempts
        WHERE observation_scope_key = ? AND status = 'prepared'
        ORDER BY observation_attempt_id
      `).all(scopeKey);
      if (rows.length > 1) {
        fail('RECOVERY_OBSERVATION_ATTEMPT_AMBIGUOUS', '同一 scope 存在多个 prepared attempt');
      }
      if (rows.length === 0) return null;
      return Object.freeze({
        observationScopeKey: scopeKey,
        observationAttemptId: Number(rows[0].observation_attempt_id),
        status: 'prepared'
      });
    }
  });
}

function createRecoveryRequestOwnerRepository(db, options = {}) {
  assertDatabase(db);
  const now = options.now || (() => new Date());
  const createEventId = options.createEventId || randomUUID;
  if (typeof now !== 'function' || typeof createEventId !== 'function') {
    throw new TypeError('Recovery request owner now/createEventId 必须是函数');
  }
  ensureBackgroundExecutionRecoveryControlSchema(db);
  return Object.freeze({
    reserveTransitionRequest(input) {
      return transitionReservation(db, input, now, createEventId);
    },
    reserveObservationRequest(input) {
      return observationReservation(db, input, now, createEventId);
    }
  });
}

module.exports = {
  RecoveryControlError,
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
};
