'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ResourceGovernorError,
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  expandDynamicResourceVector,
  validateResourceVector,
  zeroResourceVector
} = require('../../../../src/main-process/background-execution/resource-lease');

function vector(overrides = {}) {
  return {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0,
    ...overrides
  };
}

test('resource vectors require exactly five non-negative safe integer dimensions', () => {
  assert.deepEqual(validateResourceVector(vector({ cpuSlots: 2, memoryBytes: 1024 })),
    vector({ cpuSlots: 2, memoryBytes: 1024 }));

  for (const invalid of [
    { ...vector(), unexpected: 0 },
    { cpuSlots: 0 },
    vector({ cpuSlots: -1 }),
    vector({ cpuSlots: 0.5 }),
    vector({ memoryBytes: Number.MAX_SAFE_INTEGER + 1 })
  ]) {
    assert.throws(
      () => validateResourceVector(invalid),
      (error) => error instanceof ResourceGovernorError && error.code === 'RESOURCE_VECTOR_INVALID'
    );
  }
});

test('worker dynamic request expands its three dimensions with both carrier slots set to zero', () => {
  assert.deepEqual(expandDynamicResourceVector({
    memoryBytes: 4096,
    cpuSlots: 2,
    ioHeavySlots: 1
  }), vector({ memoryBytes: 4096, cpuSlots: 2, ioHeavySlots: 1 }));

  assert.throws(
    () => expandDynamicResourceVector({ memoryBytes: 1, cpuSlots: 1, ioHeavySlots: 0, workerThreadSlots: 1 }),
    (error) => error.code === 'RESOURCE_VECTOR_INVALID'
  );
});

test('resource arithmetic rejects overflow and underflow instead of losing accounting precision', () => {
  const maximum = vector({ memoryBytes: Number.MAX_SAFE_INTEGER });
  assert.throws(
    () => checkedAdd(maximum, vector({ memoryBytes: 1 })),
    (error) => error.code === 'RESOURCE_VECTOR_OVERFLOW'
  );
  assert.throws(
    () => checkedMultiply(maximum, 2),
    (error) => error.code === 'RESOURCE_VECTOR_OVERFLOW'
  );
  assert.throws(
    () => checkedSubtract(zeroResourceVector(), vector({ cpuSlots: 1 })),
    (error) => error.code === 'RESOURCE_VECTOR_UNDERFLOW'
  );
});
