'use strict';

const { randomUUID } = require('node:crypto');
const {
  canonicalJsonSnapshot,
  parseStrictJson
} = require('../canonical-json-v1');
const {
  RECOVERY_REQUEST_MAX_BYTES,
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

function preparedExactRequest(db, requestKey, writer, validateRequest, requestKeyFor) {
  if (typeof requestKey !== 'string' || !/^recovery-control:v1:[a-f0-9]{64}$/.test(requestKey)) {
    throw new TypeError('prepared requestKey 非法');
  }
  const existing = ownerRow(db, requestKey);
  if (!existing || existing.status !== 'prepared') return null;
  if (existing.writer !== writer) {
    fail(
      'RECOVERY_REQUEST_KEY_CONFLICT',
      'prepared requestKey 已绑定到不同 writer',
      { requestKey }
    );
  }

  let envelope;
  try {
    envelope = exactObject(
      parseStrictJson(existing.request_jcs, { maxBytes: RECOVERY_REQUEST_MAX_BYTES }),
      ['contractVersion', 'writer', 'input'],
      'prepared transition request envelope'
    );
  } catch (_error) {
    fail(
      'RECOVERY_PREPARED_OWNER_INVALID',
      'prepared transition owner 的 persisted exact request 非法',
      { requestKey }
    );
  }
  if (envelope.contractVersion !== 1 || envelope.writer !== writer) {
    fail(
      'RECOVERY_PREPARED_OWNER_INVALID',
      'prepared owner envelope identity 非法',
      { requestKey }
    );
  }

  let request;
  try {
    request = validateRequest(envelope.input);
  } catch (_error) {
    fail(
      'RECOVERY_PREPARED_OWNER_INVALID',
      'prepared owner request schema 非法',
      { requestKey }
    );
  }
  const computedRequestKey = requestKeyFor(request);
  const evidence = requestEvidence(writer, request);
  if (computedRequestKey !== requestKey
      || existing.event_id !== request.event.eventId
      || existing.created_at !== request.event.createdAt
      || existing.request_hash !== evidence.requestHash
      || existing.request_jcs !== evidence.requestJcs) {
    fail(
      'RECOVERY_REQUEST_KEY_CONFLICT',
      'prepared owner 与 persisted exact request 不一致',
      { requestKey }
    );
  }
  return request;
}

function preparedTransitionRequest(db, requestKey) {
  const request = preparedExactRequest(
    db,
    requestKey,
    'transitionWithRecoveryEvent',
    validateTransitionRequest,
    (value) => transitionRequestKey(value.transition)
  );
  return request
    ? Object.freeze({ transition: request.transition, event: request.event })
    : null;
}

function preparedObservationRequest(db, requestKey) {
  const request = preparedExactRequest(
    db,
    requestKey,
    'appendObservationEvent',
    validateObservationRequest,
    (value) => observationRequestKey(value.event)
  );
  return request ? request.event : null;
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

function observationAnchorReservation(db, input, now, createEventId) {
  const owned = exactObject(
    input,
    ['observationScopeKey', 'scope', 'safePayload'],
    'reserveObservationAnchor input'
  );
  const scope = normalizeScope(owned.scope);
  const scopeKey = observationScopeKey(scope);
  if (owned.observationScopeKey !== scopeKey) {
    fail('RECOVERY_OBSERVATION_SCOPE_MISMATCH', 'observation anchor scopeKey 不匹配');
  }
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
        'observation anchor scope 已有 prepared attempt，必须先 resume/commit'
      );
    }
    const row = db.prepare(`
      SELECT COALESCE(MAX(observation_attempt_id), 0) AS max_attempt
      FROM background_execution_recovery_observation_attempts
      WHERE observation_scope_key = ?
    `).get(scopeKey);
    const observationAttemptId = Number(row.max_attempt) + 1;
    if (!Number.isSafeInteger(observationAttemptId) || observationAttemptId < 1) {
      fail('RECOVERY_OBSERVATION_ATTEMPT_EXHAUSTED', 'observation attempt ordinal 已耗尽');
    }
    const createdAt = timestampOf(now);
    const request = validateObservationRequest({
      event: {
        ...scope,
        observationAttemptId,
        eventId: createEventId(),
        createdAt,
        safePayload: owned.safePayload
      }
    });
    const requestKey = observationRequestKey(request.event);
    const evidence = requestEvidence('appendObservationEvent', request);
    const insertedAttempt = db.prepare(`
      INSERT INTO background_execution_recovery_observation_attempts (
        observation_scope_key, observation_attempt_id, event_type,
        action_key, operation_key, task_run_id, source_kind, source_ref,
        batch_id, intent_id, hold_id, recovery_attempt_id,
        request_key, status, prepared_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL)
    `).run(
      scopeKey,
      observationAttemptId,
      scope.eventType,
      scope.actionKey,
      scope.operationKey,
      scope.taskRunId,
      scope.sourceKind,
      scope.sourceRef,
      scope.batchId,
      scope.intentId,
      scope.holdId,
      scope.recoveryAttemptId,
      requestKey,
      createdAt
    );
    if (Number(insertedAttempt.changes) !== 1) {
      fail('RECOVERY_OBSERVATION_ATTEMPT_WRITE_CONFLICT', 'observation anchor attempt INSERT 必须等于 1');
    }
    insertOwner(db, {
      requestKey,
      writer: 'appendObservationEvent',
      eventId: request.event.eventId,
      createdAt,
      ...evidence
    });
    return request.event;
  });
}

const INSPECTION_UNAVAILABLE_SOURCE_KEYS = Object.freeze([
  'actionKey',
  'operationKey',
  'taskRunId',
  'sourceKind',
  'sourceRef',
  'intentId'
]);

function normalizeInspectionUnavailableSource(value) {
  const source = exactObject(
    value,
    INSPECTION_UNAVAILABLE_SOURCE_KEYS,
    'inspection unavailable source'
  );
  for (const key of ['actionKey', 'operationKey', 'taskRunId', 'sourceKind', 'sourceRef']) {
    if (typeof source[key] !== 'string' || !source[key]) {
      throw new TypeError(`inspection unavailable source.${key} 不能为空`);
    }
  }
  if (source.intentId !== null && (typeof source.intentId !== 'string' || !source.intentId)) {
    throw new TypeError('inspection unavailable source.intentId 非法');
  }
  return source;
}

function preparedInspectionUnavailableState(db, input) {
  const owned = exactObject(
    input,
    ['observationScopeKey', 'source'],
    'inspectPreparedInspectionUnavailableState input'
  );
  const source = normalizeInspectionUnavailableSource(owned.source);
  if (typeof owned.observationScopeKey !== 'string' ||
      !owned.observationScopeKey.startsWith('observation-attempt:v1:')) {
    throw new TypeError('inspection unavailable observationScopeKey 非法');
  }
  const attempts = db.prepare(`
    SELECT observation_attempt_id, request_key
    FROM background_execution_recovery_observation_attempts
    WHERE observation_scope_key = ? AND status = 'prepared'
    ORDER BY observation_attempt_id
  `).all(owned.observationScopeKey);
  if (attempts.length > 1) {
    fail('RECOVERY_OBSERVATION_ATTEMPT_AMBIGUOUS', 'threshold scope 存在多个 prepared attempt');
  }
  const taskOwnerCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM background_execution_recovery_request_owners
    WHERE status = 'prepared'
      AND writer = 'transitionWithRecoveryEvent'
      AND json_extract(request_jcs, '$.input.transition.entityKind') = 'task-run'
      AND json_extract(request_jcs, '$.input.transition.command') = 'mark-interrupted'
      AND json_extract(request_jcs, '$.input.transition.actionKey') = ?
      AND json_extract(request_jcs, '$.input.transition.operationKey') = ?
      AND json_extract(request_jcs, '$.input.transition.taskRunId') = ?
      AND json_extract(request_jcs, '$.input.transition.sourceKind') = ?
      AND json_extract(request_jcs, '$.input.transition.sourceRef') = ?
      AND json_extract(request_jcs, '$.input.transition.failureCode') = 'INSPECTOR_UNAVAILABLE'
  `).get(
    source.actionKey,
    source.operationKey,
    source.taskRunId,
    source.sourceKind,
    source.sourceRef
  ).count);
  const holdOwnerCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM background_execution_recovery_request_owners
    WHERE status = 'prepared'
      AND writer = 'transitionWithRecoveryEvent'
      AND json_extract(request_jcs, '$.input.transition.entityKind') = 'recovery-hold'
      AND json_extract(request_jcs, '$.input.transition.command') = 'create-or-get'
      AND json_extract(request_jcs, '$.input.transition.input.actionKey') = ?
      AND json_extract(request_jcs, '$.input.transition.input.operationKey') = ?
      AND json_extract(request_jcs, '$.input.transition.input.taskRunId') = ?
      AND json_extract(request_jcs, '$.input.transition.input.sourceKind') = ?
      AND json_extract(request_jcs, '$.input.transition.input.sourceRef') = ?
      AND json_extract(request_jcs, '$.input.transition.input.reasonCode') = 'INSPECTOR_UNAVAILABLE'
  `).get(
    source.actionKey,
    source.operationKey,
    source.taskRunId,
    source.sourceKind,
    source.sourceRef
  ).count);
  if (taskOwnerCount > 1 || holdOwnerCount > 1) {
    fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID', 'threshold prepared transition owner 不唯一');
  }
  const attempt = attempts[0] || null;
  const state = attempt && attempt.request_key
    ? 'anchored'
    : taskOwnerCount > 0 || holdOwnerCount > 0 || attempt
      ? 'legacy-gap'
      : 'none';
  return Object.freeze({
    state,
    taskOwnerCount,
    holdOwnerCount,
    unboundAttemptCount: attempt && !attempt.request_key ? 1 : 0
  });
}

function exactTransitionDraft(value, label) {
  const draft = exactObject(value, ['requestKey', 'transition', 'safePayload'], label);
  const transition = assertC1Transition(validateTransition(draft.transition));
  if (draft.requestKey !== transitionRequestKey(transition)) {
    fail('RECOVERY_REQUEST_KEY_MISMATCH', `${label} requestKey 不匹配`);
  }
  return Object.freeze({
    requestKey: draft.requestKey,
    transition,
    safePayload: draft.safePayload
  });
}

function assertPreparedMatchesDraft(prepared, draft, label) {
  if (!prepared) {
    fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INCOMPLETE', `${label} prepared owner 缺失`);
  }
  const expected = validateTransitionRequest({
    transition: draft.transition,
    event: {
      eventId: prepared.event.eventId,
      createdAt: prepared.event.createdAt,
      safePayload: draft.safePayload
    }
  });
  if (requestEvidence('transitionWithRecoveryEvent', expected).requestJcs !==
      requestEvidence('transitionWithRecoveryEvent', prepared).requestJcs) {
    fail('RECOVERY_REQUEST_KEY_CONFLICT', `${label} prepared owner body 不兼容`);
  }
}

function cleanupPreparedInspectionUnavailableLegacyGap(db, input) {
  const owned = exactObject(
    input,
    ['holdRequest', 'observationScopeKey', 'source', 'taskRequest'],
    'cleanupPreparedInspectionUnavailableLegacyGap input'
  );
  const source = normalizeInspectionUnavailableSource(owned.source);
  const taskRequest = owned.taskRequest === null
    ? null
    : exactTransitionDraft(owned.taskRequest, 'legacy threshold Task request');
  const holdRequest = owned.holdRequest === null
    ? null
    : exactTransitionDraft(owned.holdRequest, 'legacy threshold Hold request');
  return runImmediate(db, () => {
    const state = preparedInspectionUnavailableState(db, {
      observationScopeKey: owned.observationScopeKey,
      source
    });
    if (state.state !== 'legacy-gap') return state;
    const taskPrepared = taskRequest
      ? preparedTransitionRequest(db, taskRequest.requestKey)
      : null;
    const holdPrepared = holdRequest
      ? preparedTransitionRequest(db, holdRequest.requestKey)
      : null;
    if (state.taskOwnerCount === 1) {
      if (!taskRequest) {
        fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INCOMPLETE', 'legacy threshold Task plan 缺失');
      }
      assertPreparedMatchesDraft(taskPrepared, taskRequest, 'legacy threshold Task');
    }
    if (state.holdOwnerCount === 1) {
      if (!holdRequest) {
        fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INCOMPLETE', 'legacy threshold Hold plan 缺失');
      }
      assertPreparedMatchesDraft(holdPrepared, holdRequest, 'legacy threshold Hold');
    }
    if (holdRequest && !taskPrepared) {
      fail(
        'RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID',
        '新建 Hold 前的 legacy threshold gap 缺少先前 Task owner'
      );
    }
    if (holdRequest && state.unboundAttemptCount === 1 && !holdPrepared) {
      fail(
        'RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID',
        'unbound threshold attempt 缺少先前 Hold owner'
      );
    }
    let deletedOwnerCount = 0;
    if (taskPrepared) {
      const deletedTask = db.prepare(`
        DELETE FROM background_execution_recovery_request_owners
        WHERE request_key = ? AND status = 'prepared'
      `).run(taskRequest.requestKey);
      if (Number(deletedTask.changes) !== 1) {
        fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID', 'legacy threshold Task owner cleanup 失败');
      }
      deletedOwnerCount += 1;
    }
    if (holdPrepared) {
      const deletedHold = db.prepare(`
        DELETE FROM background_execution_recovery_request_owners
        WHERE request_key = ? AND status = 'prepared'
      `).run(holdRequest.requestKey);
      if (Number(deletedHold.changes) !== 1) {
        fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID', 'legacy threshold Hold owner cleanup 失败');
      }
      deletedOwnerCount += 1;
    }
    let deletedAttemptCount = 0;
    if (state.unboundAttemptCount === 1) {
      const deletedAttempt = db.prepare(`
        DELETE FROM background_execution_recovery_observation_attempts
        WHERE observation_scope_key = ?
          AND status = 'prepared'
          AND request_key IS NULL
      `).run(owned.observationScopeKey);
      if (Number(deletedAttempt.changes) !== 1) {
        fail('RECOVERY_PREPARED_THRESHOLD_BUNDLE_INVALID', 'legacy unbound attempt cleanup 失败');
      }
      deletedAttemptCount = 1;
    }
    return Object.freeze({
      state: 'cleaned',
      deletedOwnerCount,
      deletedAttemptCount
    });
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
    cleanupPreparedInspectionUnavailableLegacyGap(input) {
      return cleanupPreparedInspectionUnavailableLegacyGap(db, input);
    },
    inspectPreparedInspectionUnavailableState(input) {
      return preparedInspectionUnavailableState(db, input);
    },
    reserveObservationAnchor(input) {
      return observationAnchorReservation(db, input, now, createEventId);
    },
    resumePreparedObservationRequest(requestKey) {
      return preparedObservationRequest(db, requestKey);
    },
    resumePreparedTransitionRequest(requestKey) {
      return preparedTransitionRequest(db, requestKey);
    },
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
