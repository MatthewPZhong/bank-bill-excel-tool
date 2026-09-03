'use strict';

const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const { freezeWorkerOperationContext } = require('../archive-center/worker-operation-context');
const { TextDecoder, types: utilTypes } = require('node:util');
const {
  SafeErrorValidationError,
  assertFinanceSafeValue,
  validateSafeErrorV1
} = require('./error-codec');
const protocolSchema = require('./schemas/platform-protocol-v1.schema.json');
const {
  SchemaValidationError,
  createSchemaValidator
} = require('./schema-validator');

const PLATFORM_PROTOCOL_MAX_BYTES = 262144;
const protocolSchemaValidator = createSchemaValidator(protocolSchema, {
  schemaName: 'Background Execution Protocol v1'
});

class ProtocolValidationError extends Error {
  constructor(code, message, path = '/', details = null) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function jsonValueError(message, path) {
  throw new ProtocolValidationError('PROTOCOL_NOT_JSON_SAFE', message, path || '/');
}

function appendJsonPath(path, key) {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function assertJsonSafe(value, path = '', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) jsonValueError('JSON number must be finite', path);
    return;
  }
  if (['undefined', 'bigint', 'function', 'symbol'].includes(typeof value)) {
    jsonValueError(`Unsupported JSON value type: ${typeof value}`, path);
  }
  if (typeof value !== 'object') return;
  if (utilTypes.isProxy(value)) jsonValueError('JSON values must not be Proxy objects', path);
  if (ancestors.has(value)) jsonValueError('Envelope contains a circular reference', path);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray && prototype !== Array.prototype) {
    jsonValueError('JSON arrays must use Array.prototype', path);
  }
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    jsonValueError('Envelope values must be plain JSON objects', path);
  }
  ancestors.add(value);
  try {
    if (isArray) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') jsonValueError('JSON arrays must not contain symbol keys', path);
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
          jsonValueError('JSON arrays must not contain non-index own keys', appendJsonPath(path, key));
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          jsonValueError('JSON arrays must not contain accessor properties', appendJsonPath(path, key));
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          jsonValueError('JSON arrays must not contain sparse entries', `${path}/${index}`);
        }
        assertJsonSafe(descriptor.value, `${path}/${index}`, ancestors);
      }
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') jsonValueError('JSON objects must not contain symbol keys', path);
        const propertyPath = appendJsonPath(path, key);
        if (key === 'toJSON') jsonValueError('JSON objects must not define an own toJSON property', propertyPath);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          jsonValueError('JSON objects must not contain accessor properties', propertyPath);
        }
        if (descriptor.enumerable !== true) {
          jsonValueError('JSON objects must not contain non-enumerable own keys', propertyPath);
        }
        assertJsonSafe(descriptor.value, propertyPath, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function compactJson(value) {
  assertJsonSafe(value);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ProtocolValidationError('PROTOCOL_NOT_JSON_SAFE', error.message, '/');
  }
  if (serialized === undefined) {
    throw new ProtocolValidationError('PROTOCOL_NOT_JSON_SAFE', 'Envelope is not JSON serializable', '/');
  }
  return serialized;
}

function deepFreezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeJson(child);
  }
  return value;
}

function canonicalJsonSnapshot(value) {
  return deepFreezeJson(JSON.parse(compactJson(value)));
}

function utf8Size(value) {
  const serialized = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : compactJson(value);
  return Buffer.byteLength(serialized);
}

function dataPropertyDescriptor(value, key) {
  let current = value;
  while (current && current !== Object.prototype) {
    if (utilTypes.isProxy(current)) return {};
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function ownEnumerableDataValue(value, key) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  return descriptor.value === null || descriptor.value === undefined ? null : descriptor.value;
}

function policyForAction(policyRegistry, actionKey) {
  if (typeof actionKey !== 'string' || actionKey.length === 0 || !policyRegistry ||
      (typeof policyRegistry !== 'object' && typeof policyRegistry !== 'function') ||
      utilTypes.isProxy(policyRegistry)) {
    return null;
  }
  if (policyRegistry instanceof Map) {
    if (Object.prototype.hasOwnProperty.call(policyRegistry, 'get') ||
        Object.prototype.hasOwnProperty.call(policyRegistry, 'has')) return null;
    return Map.prototype.has.call(policyRegistry, actionKey)
      ? (Map.prototype.get.call(policyRegistry, actionKey) || null)
      : null;
  }
  const getDescriptor = dataPropertyDescriptor(policyRegistry, 'get');
  if (getDescriptor) {
    if (!Object.prototype.hasOwnProperty.call(getDescriptor, 'value') ||
        typeof getDescriptor.value !== 'function') return null;
    return getDescriptor.value.call(policyRegistry, actionKey) || null;
  }
  const prototype = Object.getPrototypeOf(policyRegistry);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actionsDescriptor = Object.getOwnPropertyDescriptor(policyRegistry, 'actions');
  if (actionsDescriptor) {
    if (actionsDescriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(actionsDescriptor, 'value')) return null;
    const actions = actionsDescriptor.value;
    if (!actions || typeof actions !== 'object' || Array.isArray(actions) || utilTypes.isProxy(actions) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(actions))) return null;
    return ownEnumerableDataValue(actions, actionKey);
  }
  return ownEnumerableDataValue(policyRegistry, actionKey);
}

function actionKeyForEnvelope(envelope) {
  if (envelope.channel === 'job') {
    return envelope.actionKey;
  }
  return envelope.jobRef && envelope.jobRef.actionKey;
}

function byteLimitForEnvelope(envelope, policy) {
  const field = envelope.direction === 'command' ? 'commandMaxBytes' : 'eventMaxBytes';
  const limit = policy && policy.protocolLimits && policy.protocolLimits[field];
  return Number.isInteger(limit) && limit >= 0
    ? Math.min(limit, PLATFORM_PROTOCOL_MAX_BYTES)
    : PLATFORM_PROTOCOL_MAX_BYTES;
}

function tightenByteLimit(baseLimit, requestedLimit) {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) return baseLimit;
  return Math.min(baseLimit, requestedLimit);
}

function validateContext(envelope, policy) {
  if (envelope.channel !== 'job') {
    return;
  }
  const context = envelope.context;
  try {
    if (context.kind === 'operation') {
      freezeWorkerOperationContext(context.value, { required: true });
    } else if (context.kind === 'file-batch') {
      freezeWorkerBatchContext(context.value, { required: true });
    } else if (context.kind !== 'none') {
      throw new TypeError(`unsupported context kind: ${context.kind}`);
    }
  } catch (error) {
    throw new ProtocolValidationError('PROTOCOL_CONTEXT_INVALID', error.message, '/context/value');
  }

  if (context.value.operationKey !== undefined && context.value.operationKey !== envelope.operationKey) {
    throw new ProtocolValidationError(
      'PROTOCOL_OPERATION_KEY_MISMATCH',
      'context.operationKey must equal envelope.operationKey',
      '/context/value/operationKey'
    );
  }
  const expectedKind = policy && policy.context && policy.context.kind;
  if (expectedKind && context.kind !== expectedKind) {
    throw new ProtocolValidationError(
      'PROTOCOL_CONTEXT_KIND_MISMATCH',
      `Context kind ${context.kind} does not match policy kind ${expectedKind}`,
      '/context/kind'
    );
  }
}

function plainBody(value, operation, wrapper) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ProtocolValidationError(
      'PROTOCOL_OPERATION_BODY_INVALID',
      `${operation} ${wrapper} body must be a plain object`,
      `/payload/${wrapper}`
    );
  }
  return value;
}

function validatePrivacy(value, policy, path, allowValue = null) {
  const privacyProfile = policy && policy.metrics && policy.metrics.privacyProfile;
  if (!privacyProfile) return;
  try {
    assertFinanceSafeValue(value, privacyProfile, path, { allowValue });
  } catch (error) {
    if (error instanceof SafeErrorValidationError) {
      throw new ProtocolValidationError(
        'PROTOCOL_PRIVACY_VIOLATION',
        error.message,
        error.path || path
      );
    }
    throw error;
  }
}

function validateOperationBody(envelope, policy, envelopeLimit, allowValue = null) {
  if (envelope.channel !== 'job') return;
  const operation = envelope.operation;
  if (operation === 'job:progress' || operation === 'unit:progress') {
    const progress = plainBody(envelope.payload.progress, operation, 'progress');
    validatePrivacy(progress, policy, '/payload/progress', allowValue);
    return;
  }
  if (operation === 'job:error' || operation === 'unit:error') {
    try {
      validateSafeErrorV1(envelope.payload.error, {
        maxBytes: envelopeLimit,
        maxErrorItems: policy && policy.result && policy.result.maxErrorItems,
        privacyProfile: policy && policy.metrics && policy.metrics.privacyProfile
      });
    } catch (error) {
      if (error instanceof SafeErrorValidationError) {
        throw new ProtocolValidationError(
          error.code === 'PRIVACY_VALUE_FORBIDDEN'
            ? 'PROTOCOL_PRIVACY_VIOLATION'
            : 'PROTOCOL_SAFE_ERROR_INVALID',
          error.message,
          `/payload/error${error.path === '/' ? '' : error.path}`
        );
      }
      throw error;
    }
    return;
  }
  if (operation === 'cancel:ack') {
    const cancellation = plainBody(envelope.payload.cancellation, operation, 'cancellation');
    const keys = Object.keys(cancellation);
    if (keys.length !== 1 || keys[0] !== 'scope' || cancellation.scope !== 'job') {
      throw new ProtocolValidationError(
        'PROTOCOL_CANCELLATION_ACK_INVALID',
        'cancel:ack cancellation must equal { scope: "job" }',
        '/payload/cancellation'
      );
    }
    return;
  }
  if (operation === 'job:cancel' || operation === 'unit:cancel') {
    validatePrivacy(
      plainBody(envelope.payload.cancel, operation, 'cancel'),
      policy,
      '/payload/cancel',
      allowValue
    );
    return;
  }
  if (operation === 'job:done' || operation === 'unit:done') {
    const result = plainBody(envelope.payload.result, operation, 'result');
    if (policy && policy.result && utf8Size(result) > policy.result.maxBytes) {
      throw new ProtocolValidationError(
        'PROTOCOL_RESULT_TOO_LARGE',
        `Execution result exceeds ${policy.result.maxBytes} UTF-8 bytes`,
        '/payload/result'
      );
    }
    validatePrivacy(result, policy, '/payload/result', allowValue);
    return;
  }
  if (operation === 'commit:receipt') {
    validatePrivacy(
      plainBody(envelope.payload.receipt, operation, 'receipt'),
      policy,
      '/payload/receipt',
      allowValue
    );
    return;
  }
  if (operation === 'critical:ready' || operation === 'critical:ack' || operation === 'critical:reject') {
    validatePrivacy(
      plainBody(envelope.payload.critical, operation, 'critical'),
      policy,
      '/payload/critical',
      allowValue
    );
  }
}

function financeSafeValueDelegate(policyRegistry, actionKey) {
  if (!policyRegistry || typeof policyRegistry.getBinding !== 'function' || !actionKey) return null;
  let binding;
  try { binding = policyRegistry.getBinding(actionKey, 'result.validatorKey'); } catch (_error) {
    return null;
  }
  return binding && typeof binding.allowFinanceSafeValue === 'function'
    ? binding.allowFinanceSafeValue
    : null;
}

function validateEnvelope(envelope, options = {}) {
  const ownedEnvelope = canonicalJsonSnapshot(envelope);
  let schemaResult;
  try {
    schemaResult = protocolSchemaValidator.validate(ownedEnvelope);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new ProtocolValidationError('PROTOCOL_SCHEMA_INVALID', error.message, error.path, error.errors);
    }
    throw error;
  }
  if (!schemaResult.valid) {
    const first = schemaResult.errors[0];
    throw new ProtocolValidationError(
      'PROTOCOL_SCHEMA_INVALID',
      `Protocol schema validation failed at ${first.path}: ${first.message}`,
      first.path,
      schemaResult.errors
    );
  }

  const actionKey = actionKeyForEnvelope(ownedEnvelope);
  const policy = policyForAction(options.policyRegistry, actionKey);
  if (options.policyRegistry && actionKey && !policy) {
    throw new ProtocolValidationError('PROTOCOL_UNKNOWN_ACTION', `No policy is registered for ${actionKey}`, '/actionKey');
  }
  const limit = tightenByteLimit(byteLimitForEnvelope(ownedEnvelope, policy), options.maxBytes);
  const actualBytes = utf8Size(ownedEnvelope);
  if (actualBytes > limit) {
    throw new ProtocolValidationError(
      'PROTOCOL_MESSAGE_TOO_LARGE',
      `UTF-8 JSON envelope exceeds ${ownedEnvelope.direction} ceiling ${limit}`,
      '/',
      { actualBytes, limit }
    );
  }

  validateContext(ownedEnvelope, policy);
  validateOperationBody(
    ownedEnvelope,
    policy,
    limit,
    financeSafeValueDelegate(options.policyRegistry, actionKey)
  );
  return ownedEnvelope;
}

const JOB_ROUTE_FIELDS = Object.freeze([
  'actionKey',
  'operationKey',
  'jobId',
  'workerInstanceId',
  'serviceGeneration',
  'direction'
]);
const SERVICE_ROUTE_FIELDS = Object.freeze([
  'serviceKey',
  'workerInstanceId',
  'serviceGeneration',
  'direction'
]);

function assertExpectedRoute(expectedRoute, routeName, fields) {
  const routePath = `/expected${routeName[0].toUpperCase()}${routeName.slice(1)}Route`;
  try {
    assertJsonSafe(expectedRoute, routePath);
  } catch (error) {
    throw new ProtocolValidationError(
      `PROTOCOL_EXPECTED_${routeName.toUpperCase()}_ROUTE_INVALID`,
      error.message,
      error.path || routePath
    );
  }
  if (!expectedRoute || typeof expectedRoute !== 'object' || Array.isArray(expectedRoute) ||
      Object.getPrototypeOf(expectedRoute) !== Object.prototype) {
    throw new ProtocolValidationError(
      `PROTOCOL_EXPECTED_${routeName.toUpperCase()}_ROUTE_INVALID`,
      `Expected ${routeName} route must be a plain object`,
      routePath
    );
  }
  const actualKeys = Reflect.ownKeys(expectedRoute);
  const invalidKey = actualKeys.find((key) => typeof key !== 'string' || !fields.includes(key));
  if (invalidKey !== undefined || actualKeys.length !== fields.length) {
    throw new ProtocolValidationError(
      `PROTOCOL_EXPECTED_${routeName.toUpperCase()}_ROUTE_INVALID`,
      `Expected ${routeName} route must contain exactly ${fields.join(', ')}`,
      routePath
    );
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(expectedRoute, field) || expectedRoute[field] === undefined) {
      throw new ProtocolValidationError(
        `PROTOCOL_EXPECTED_${routeName.toUpperCase()}_ROUTE_INVALID`,
        `Expected ${routeName} route requires ${field}`,
        `${routePath}/${field}`
      );
    }
  }
}

function validateExpectedRoute(envelope, expectedRoute, routeName, fields) {
  assertExpectedRoute(expectedRoute, routeName, fields);
  for (const field of fields) {
    if (envelope[field] !== expectedRoute[field]) {
      throw new ProtocolValidationError(
        'PROTOCOL_ROUTE_MISMATCH',
        `Envelope ${field} does not match the expected ${routeName} route`,
        `/${field}`
      );
    }
  }
}

function validateJobEnvelope(envelope, expectedJobRoute, options = {}) {
  const ownedEnvelope = validateEnvelope(envelope, options);
  if (ownedEnvelope.channel !== 'job') {
    throw new ProtocolValidationError('PROTOCOL_CHANNEL_INVALID', 'Expected a job envelope', '/channel');
  }
  validateExpectedRoute(ownedEnvelope, expectedJobRoute, 'job', JOB_ROUTE_FIELDS);
  return ownedEnvelope;
}

function validateServiceControlEnvelope(envelope, expectedServiceRoute, options = {}) {
  const ownedEnvelope = validateEnvelope(envelope, options);
  if (ownedEnvelope.channel !== 'service-control') {
    throw new ProtocolValidationError('PROTOCOL_CHANNEL_INVALID', 'Expected a service-control envelope', '/channel');
  }
  validateExpectedRoute(ownedEnvelope, expectedServiceRoute, 'service', SERVICE_ROUTE_FIELDS);
  return ownedEnvelope;
}

function parseAndValidateEnvelope(serialized, options = {}) {
  if (typeof serialized !== 'string' && !Buffer.isBuffer(serialized)) {
    throw new ProtocolValidationError('PROTOCOL_SERIALIZED_TYPE_INVALID', 'Serialized envelope must be a string or Buffer', '/');
  }
  const actualBytes = Buffer.byteLength(serialized);
  const parseLimit = tightenByteLimit(PLATFORM_PROTOCOL_MAX_BYTES, options.maxBytes);
  if (actualBytes > parseLimit) {
    throw new ProtocolValidationError(
      'PROTOCOL_MESSAGE_TOO_LARGE',
      `Serialized UTF-8 envelope exceeds parse ceiling ${parseLimit}`,
      '/',
      { actualBytes, limit: parseLimit }
    );
  }

  let envelope;
  try {
    let jsonText = serialized;
    if (Buffer.isBuffer(serialized)) {
      try {
        jsonText = new TextDecoder('utf-8', { fatal: true }).decode(serialized);
      } catch (_error) {
        throw new ProtocolValidationError(
          'PROTOCOL_INVALID_UTF8',
          'Serialized envelope Buffer is not valid UTF-8',
          '/'
        );
      }
    }
    envelope = JSON.parse(jsonText);
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError('PROTOCOL_INVALID_JSON', 'Serialized envelope is not valid JSON', '/');
  }
  return validateEnvelope(envelope, options);
}

module.exports = {
  PLATFORM_PROTOCOL_MAX_BYTES,
  ProtocolValidationError,
  assertJsonSafe,
  byteLimitForEnvelope,
  canonicalJsonSnapshot,
  compactJson,
  parseAndValidateEnvelope,
  policyForAction,
  protocolSchema,
  protocolSchemaValidator,
  tightenByteLimit,
  utf8Size,
  validateEnvelope,
  validateJobEnvelope,
  validateServiceControlEnvelope
};
