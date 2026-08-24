'use strict';

const { createHash } = require('node:crypto');
const recoveryControlSchema = require('./schemas/platform-recovery-control-v1.schema.json');
const { createSchemaValidator, SchemaValidationError } = require('./schema-validator');
const {
  canonicalJsonSnapshot,
  canonicalSha256,
  canonicalizeJson,
  parseStrictJson
} = require('./canonical-json-v1');

const BOUNDED_JSON_MAX_BYTES = 16384;
const RECOVERY_REQUEST_MAX_BYTES = 262144;
const REQUEST_KEY_PREFIX = 'recovery-control:v1:';
const OBSERVATION_SCOPE_PREFIX = 'observation-attempt:v1:';

const TRANSITION_EVENT_TYPES = Object.freeze({
  'task-run.mark-interrupted': 'interrupted-recorded',
  'task-run.begin-recovery': 'recovery-started',
  'task-run.complete-recovery-success': 'recovery-succeeded',
  'task-run.complete-recovery-failure': 'recovery-failed',
  'task-run.interrupt-recovery': 'recovery-interrupted',
  'batch-overlay.mark-interrupted': 'batch-overlay-transitioned',
  'batch-overlay.begin-recovery': 'batch-overlay-transitioned',
  'batch-overlay.resolve-success': 'batch-overlay-transitioned',
  'batch-overlay.resolve-failure': 'batch-overlay-transitioned',
  'critical-intent.create-prepared': 'critical-intent-transitioned',
  'critical-intent.mark-acked': 'critical-intent-transitioned',
  'critical-intent.mark-committed': 'critical-intent-transitioned',
  'critical-intent.mark-recovered': 'critical-intent-transitioned',
  'critical-intent.close': 'critical-intent-transitioned',
  'recovery-hold.create-or-get': 'hold-created',
  'recovery-hold.resolve': 'hold-resolved'
});

const OBSERVATION_EVENT_TYPES = new Set([
  'inspection-completed',
  'inspection-failed-transient',
  'settlement-resumed',
  'settlement-failed-transient'
]);

class RecoveryControlValidationError extends Error {
  constructor(code, message, path = '/', details = null) {
    super(message);
    this.name = 'RecoveryControlValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function validatorFor(definition) {
  return createSchemaValidator({
    $schema: recoveryControlSchema.$schema,
    $defs: recoveryControlSchema.$defs,
    $ref: `#/$defs/${definition}`
  }, { schemaName: definition });
}

const validators = Object.freeze({
  transition: validatorFor('RecoveryControlTransitionV1'),
  transitionRequest: validatorFor('RecoveryTransitionRequestV1'),
  observationRequest: validatorFor('RecoveryObservationRequestV1'),
  transitionResult: validatorFor('RecoveryControlTransitionResultV1'),
  observationResult: validatorFor('RecoveryObservationEventResultV1')
});

function validateWith(validator, value, code) {
  try {
    validator.assertValid(value, code);
    return value;
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new RecoveryControlValidationError(code, error.message, error.path, error.errors);
    }
    throw error;
  }
}

function bounded(value, path) {
  try {
    canonicalizeJson(value, { maxBytes: BOUNDED_JSON_MAX_BYTES });
  } catch (error) {
    throw new RecoveryControlValidationError(
      error && error.code || 'RECOVERY_BOUNDED_JSON_INVALID',
      `${path} 必须是至多 ${BOUNDED_JSON_MAX_BYTES} UTF-8 bytes 的 canonical plain JSON object`,
      path
    );
  }
}

function validateBoundedFields(request) {
  if (request.event) bounded(request.event.safePayload, '/event/safePayload');
  const transition = request.transition;
  if (!transition) return;
  for (const field of ['metadataPatch', 'patch', 'receiptRef', 'inspection', 'result', 'evidence']) {
    if (Object.prototype.hasOwnProperty.call(transition, field)) {
      bounded(transition[field], `/transition/${field}`);
    }
  }
  if (transition.input) {
    for (const field of ['boundedEvidence', 'safeSummary']) {
      if (Object.prototype.hasOwnProperty.call(transition.input, field)) {
        bounded(transition.input[field], `/transition/input/${field}`);
      }
    }
  }
}

function validateTransitionSemantics(transition) {
  if (transition.entityKind === 'critical-intent' && transition.command === 'mark-recovered'
      && transition.inspection.outcome === 'committed') {
    throw new RecoveryControlValidationError(
      'RECOVERY_INTENT_COMMITTED_CANNOT_RECOVER',
      'committed inspection 只能走 committed → closed，不得 mark-recovered',
      '/inspection/outcome'
    );
  }
  if (transition.entityKind === 'recovery-hold' && transition.command === 'create-or-get') {
    const input = transition.input;
    const requiresIntent = input.sourceKind === 'critical-intent'
      || input.sourceKind === 'target-post-image';
    if ((requiresIntent && input.intentId === null) || (!requiresIntent && input.intentId !== null)) {
      throw new RecoveryControlValidationError(
        'RECOVERY_HOLD_SOURCE_INTENT_MISMATCH',
        'Recovery Hold sourceKind/intentId 组合非法',
        '/input/intentId'
      );
    }
  }
  return transition;
}

function validateTransition(transition) {
  const owned = canonicalJsonSnapshot(transition);
  validateWith(validators.transition, owned, 'RECOVERY_TRANSITION_INVALID');
  return validateTransitionSemantics(owned);
}

function validateTransitionRequest(request) {
  const owned = canonicalJsonSnapshot(request);
  validateWith(validators.transitionRequest, owned, 'RECOVERY_TRANSITION_REQUEST_INVALID');
  validateBoundedFields(owned);
  validateTransitionSemantics(owned.transition);
  return owned;
}

function validateObservationRequest(request) {
  const owned = canonicalJsonSnapshot(request);
  validateWith(validators.observationRequest, owned, 'RECOVERY_OBSERVATION_REQUEST_INVALID');
  validateBoundedFields(owned);
  return owned;
}

function parseTransitionRequest(raw) {
  return validateTransitionRequest(parseStrictJson(raw, { maxBytes: RECOVERY_REQUEST_MAX_BYTES }));
}

function parseObservationRequest(raw) {
  return validateObservationRequest(parseStrictJson(raw, { maxBytes: RECOVERY_REQUEST_MAX_BYTES }));
}

function assertImplementedTransition(transition) {
  const key = `${transition.entityKind}.${transition.command}`;
  if (!Object.prototype.hasOwnProperty.call(TRANSITION_EVENT_TYPES, key)) {
    throw new RecoveryControlValidationError(
      'RECOVERY_CONTROL_BRANCH_NOT_IMPLEMENTED',
      `RecoveryControl v1 branch 未实现：${key}`,
      '/transition/entityKind'
    );
  }
  return transition;
}

// C1 的历史导出名保持兼容；C2 后它代表完整 v1 transition union。
const assertC1Transition = assertImplementedTransition;

function transitionEventType(transition) {
  const value = TRANSITION_EVENT_TYPES[`${transition.entityKind}.${transition.command}`];
  if (!value) {
    throw new RecoveryControlValidationError(
      'RECOVERY_TRANSITION_EVENT_TYPE_UNKNOWN',
      'transition 无 canonical recovery event type',
      '/transition/command'
    );
  }
  return value;
}

function transitionIdentityTuple(transition) {
  const base = [
    transition.actionKey,
    transition.expectedTaskKey,
    transition.operationKey
  ];
  if (transition.entityKind === 'task-run') {
    const values = [...base, transition.taskRunId, transition.sourceKind, transition.sourceRef];
    if (transition.command !== 'mark-interrupted') values.push(transition.recoveryAttemptId);
    return [`recovery-control/v1/transition/task-run/${transition.command}`, ...values];
  }
  if (transition.entityKind === 'batch-overlay') {
    const values = [
      ...base,
      transition.batchId,
      transition.taskRunId,
      transition.sourceKind,
      transition.sourceRef
    ];
    if (transition.command !== 'mark-interrupted') values.push(transition.recoveryAttemptId);
    return [`recovery-control/v1/transition/batch-overlay/${transition.command}`, ...values];
  }
  if (transition.entityKind === 'critical-intent') {
    const intentId = transition.command === 'create-prepared'
      ? transition.input.intentId
      : transition.intentId;
    return [`recovery-control/v1/transition/critical-intent/${transition.command}`, intentId];
  }
  if (transition.entityKind === 'recovery-hold') {
    if (transition.command === 'create-or-get') {
      return [
        'recovery-control/v1/transition/recovery-hold/create-or-get',
        transition.input.sourceKind,
        transition.input.sourceRef
      ];
    }
    return ['recovery-control/v1/transition/recovery-hold/resolve', transition.holdId];
  }
  throw new RecoveryControlValidationError(
    'RECOVERY_CONTROL_BRANCH_NOT_IMPLEMENTED',
    'RecoveryControl v1 transition branch 未实现'
  );
}

function transitionRequestKey(transition) {
  const owned = assertC1Transition(validateTransition(transition));
  return REQUEST_KEY_PREFIX + canonicalSha256(transitionIdentityTuple(owned));
}

function nullable(value) {
  return value === undefined ? null : value;
}

function observationIdentityTuple(event) {
  return [
    `recovery-control/v1/observation/${event.eventType}`,
    event.actionKey,
    event.operationKey,
    event.taskRunId,
    event.sourceKind,
    event.sourceRef,
    event.observationAttemptId,
    nullable(event.batchId),
    nullable(event.intentId),
    nullable(event.holdId),
    nullable(event.recoveryAttemptId)
  ];
}

function observationRequestKey(event) {
  if (!OBSERVATION_EVENT_TYPES.has(event && event.eventType)) {
    throw new RecoveryControlValidationError(
      'RECOVERY_OBSERVATION_EVENT_TYPE_INVALID',
      'observation eventType 不属于 v1 observation domain',
      '/event/eventType'
    );
  }
  return REQUEST_KEY_PREFIX + canonicalSha256(observationIdentityTuple(event));
}

function observationScopeTuple(scope) {
  return [
    'recovery-control/v1/observation-attempt-scope',
    scope.eventType,
    scope.actionKey,
    scope.operationKey,
    scope.taskRunId,
    scope.sourceKind,
    scope.sourceRef,
    nullable(scope.batchId),
    nullable(scope.intentId),
    nullable(scope.holdId),
    nullable(scope.recoveryAttemptId)
  ];
}

function observationScopeKey(scope) {
  const draft = {
    eventId: 'scope-validation',
    eventType: scope.eventType,
    observationAttemptId: 1,
    actionKey: scope.actionKey,
    operationKey: scope.operationKey,
    taskRunId: scope.taskRunId,
    sourceKind: scope.sourceKind,
    sourceRef: scope.sourceRef,
    batchId: nullable(scope.batchId),
    intentId: nullable(scope.intentId),
    holdId: nullable(scope.holdId),
    recoveryAttemptId: nullable(scope.recoveryAttemptId),
    createdAt: '2000-01-01T00:00:00.000Z',
    safePayload: {}
  };
  validateObservationRequest({ event: draft });
  return OBSERVATION_SCOPE_PREFIX + canonicalSha256(observationScopeTuple(scope));
}

function requestEnvelope(writer, request) {
  if (writer === 'transitionWithRecoveryEvent') {
    return Object.freeze({ contractVersion: 1, writer, input: request });
  }
  if (writer === 'appendObservationEvent') {
    return Object.freeze({ contractVersion: 1, writer, input: request });
  }
  throw new TypeError('RecoveryControl writer 非法');
}

function requestEvidence(writer, request) {
  const envelope = requestEnvelope(writer, request);
  const requestJcs = canonicalizeJson(envelope, { maxBytes: RECOVERY_REQUEST_MAX_BYTES });
  return Object.freeze({
    envelope,
    requestJcs,
    requestHash: createHash('sha256').update(requestJcs, 'utf8').digest('hex')
  });
}

function validateResult(result, writer) {
  const owned = canonicalJsonSnapshot(result);
  validateWith(
    writer === 'transitionWithRecoveryEvent'
      ? validators.transitionResult
      : validators.observationResult,
    owned,
    'RECOVERY_CONTROL_RESULT_INVALID'
  );
  bounded(owned.safePayload, '/safePayload');
  return owned;
}

module.exports = {
  BOUNDED_JSON_MAX_BYTES,
  OBSERVATION_EVENT_TYPES,
  RECOVERY_REQUEST_MAX_BYTES,
  TRANSITION_EVENT_TYPES,
  RecoveryControlValidationError,
  assertC1Transition,
  assertImplementedTransition,
  observationRequestKey,
  observationScopeKey,
  parseObservationRequest,
  parseTransitionRequest,
  recoveryControlSchema,
  requestEvidence,
  transitionEventType,
  transitionRequestKey,
  validateObservationRequest,
  validateResult,
  validateTransition,
  validateTransitionRequest
};
