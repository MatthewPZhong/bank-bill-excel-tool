'use strict';

const RESOURCE_VECTOR_KEYS = Object.freeze([
  'cpuSlots',
  'workerThreadSlots',
  'utilityProcessSlots',
  'ioHeavySlots',
  'memoryBytes'
]);
const DYNAMIC_RESOURCE_VECTOR_KEYS = Object.freeze([
  'memoryBytes',
  'cpuSlots',
  'ioHeavySlots'
]);
const LEASE_KINDS = Object.freeze([
  'base',
  'persistent',
  'pending-interaction',
  'phase',
  'compound'
]);

class ResourceGovernorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ResourceGovernorError';
    this.code = code;
    this.details = details;
  }
}

function ownEnumerableKeys(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResourceGovernorError('RESOURCE_VECTOR_INVALID', `${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ResourceGovernorError('RESOURCE_VECTOR_INVALID', `${name} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new ResourceGovernorError('RESOURCE_VECTOR_INVALID', `${name} must not contain symbol keys`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new ResourceGovernorError('RESOURCE_VECTOR_INVALID', `${name}.${key} must be enumerable data`);
    }
  }
  return keys;
}

function assertExactKeys(actualKeys, expectedKeys, name) {
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => !actualKeys.includes(key))) {
    throw new ResourceGovernorError(
      'RESOURCE_VECTOR_INVALID',
      `${name} must contain exactly ${expectedKeys.join(', ')}`,
      Object.freeze({ actualKeys: Object.freeze([...actualKeys]), expectedKeys })
    );
  }
}

function validateComponent(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ResourceGovernorError(
      'RESOURCE_VECTOR_INVALID',
      `${path} must be a non-negative safe integer`,
      Object.freeze({ path, value })
    );
  }
  return value;
}

function freezeVector(vector) {
  return Object.freeze(Object.fromEntries(RESOURCE_VECTOR_KEYS.map((key) => [key, vector[key]])));
}

function validateResourceVector(value, name = 'resources') {
  const keys = ownEnumerableKeys(value, name);
  assertExactKeys(keys, RESOURCE_VECTOR_KEYS, name);
  return freezeVector(Object.fromEntries(
    RESOURCE_VECTOR_KEYS.map((key) => [key, validateComponent(value[key], `${name}.${key}`)])
  ));
}

function expandDynamicResourceVector(value, name = 'requested') {
  const keys = ownEnumerableKeys(value, name);
  assertExactKeys(keys, DYNAMIC_RESOURCE_VECTOR_KEYS, name);
  const dynamic = Object.fromEntries(
    DYNAMIC_RESOURCE_VECTOR_KEYS.map((key) => [key, validateComponent(value[key], `${name}.${key}`)])
  );
  return freezeVector({
    cpuSlots: dynamic.cpuSlots,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: dynamic.ioHeavySlots,
    memoryBytes: dynamic.memoryBytes
  });
}

function zeroResourceVector() {
  return freezeVector(Object.fromEntries(RESOURCE_VECTOR_KEYS.map((key) => [key, 0])));
}

function checkedAdd(left, right, name = 'resource total') {
  const output = {};
  for (const key of RESOURCE_VECTOR_KEYS) {
    const value = left[key] + right[key];
    if (!Number.isSafeInteger(value)) {
      throw new ResourceGovernorError(
        'RESOURCE_VECTOR_OVERFLOW',
        `${name}.${key} exceeds the safe integer range`,
        Object.freeze({ key, left: left[key], right: right[key] })
      );
    }
    output[key] = value;
  }
  return freezeVector(output);
}

function checkedSubtract(left, right, name = 'resource total') {
  const output = {};
  for (const key of RESOURCE_VECTOR_KEYS) {
    const value = left[key] - right[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ResourceGovernorError(
        'RESOURCE_VECTOR_UNDERFLOW',
        `${name}.${key} would become negative`,
        Object.freeze({ key, left: left[key], right: right[key] })
      );
    }
    output[key] = value;
  }
  return freezeVector(output);
}

function checkedMultiply(vector, count, name = 'resource total') {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ResourceGovernorError('RESOURCE_COUNT_INVALID', `${name} count must be a non-negative safe integer`);
  }
  const output = {};
  for (const key of RESOURCE_VECTOR_KEYS) {
    const value = vector[key] * count;
    if (!Number.isSafeInteger(value)) {
      throw new ResourceGovernorError(
        'RESOURCE_VECTOR_OVERFLOW',
        `${name}.${key} exceeds the safe integer range`,
        Object.freeze({ key, value: vector[key], count })
      );
    }
    output[key] = value;
  }
  return freezeVector(output);
}

function positiveDelta(next, current) {
  return freezeVector(Object.fromEntries(
    RESOURCE_VECTOR_KEYS.map((key) => [key, Math.max(0, next[key] - current[key])])
  ));
}

function componentMax(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) return zeroResourceVector();
  return freezeVector(Object.fromEntries(
    RESOURCE_VECTOR_KEYS.map((key) => [key, Math.max(...vectors.map((vector) => vector[key]))])
  ));
}

function fitsWithin(usage, budgets) {
  return RESOURCE_VECTOR_KEYS.every((key) => usage[key] <= budgets[key]);
}

function createResourceLease(record, release) {
  if (!LEASE_KINDS.includes(record.kind)) {
    throw new ResourceGovernorError('RESOURCE_LEASE_KIND_INVALID', `Unsupported resource kind: ${record.kind}`);
  }
  const lease = {
    get leaseId() { return record.leaseId; },
    get kind() { return record.kind; },
    get ownerKey() { return record.ownerKey; },
    get actionKey() { return record.actionKey; },
    get operationKey() { return record.operationKey; },
    get resources() { return record.resources; },
    get state() { return record.releasedAt === null ? 'granted' : 'released'; },
    get grantedAt() { return record.grantedAt; },
    get releasedAt() { return record.releasedAt; },
    get replacesReservationId() { return record.replacesReservationId || null; },
    get effectiveChildCount() { return record.effectiveChildCount === undefined ? null : record.effectiveChildCount; },
    get downgraded() { return record.downgraded === true; },
    get downgradeReason() { return record.downgradeReason || null; },
    get topology() { return record.topology || null; },
    release(reason = 'released') { return release(record.leaseId, reason); }
  };
  return Object.freeze(lease);
}

module.exports = {
  DYNAMIC_RESOURCE_VECTOR_KEYS,
  LEASE_KINDS,
  RESOURCE_VECTOR_KEYS,
  ResourceGovernorError,
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  componentMax,
  createResourceLease,
  expandDynamicResourceVector,
  fitsWithin,
  positiveDelta,
  validateResourceVector,
  zeroResourceVector
};
