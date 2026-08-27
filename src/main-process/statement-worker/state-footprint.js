'use strict';

const { types: utilTypes } = require('node:util');

const {
  STATEMENT_RESOURCE_CONTRACT
} = require('./contracts');

const PAGE_BYTES = 4096;
const MIN_RESERVATION_BYTES = PAGE_BYTES;
const HEADROOM_NUMERATOR = 3;
const HEADROOM_DENOMINATOR = 2;
const OBJECT_OVERHEAD_BYTES = 48;
const ARRAY_OVERHEAD_BYTES = 32;
const MAP_ENTRY_OVERHEAD_BYTES = 40;
const SET_ENTRY_OVERHEAD_BYTES = 24;
const PROPERTY_SLOT_BYTES = 8;

class StatementStateFootprintError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StatementStateFootprintError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new StatementStateFootprintError(code, message, details);
}

function addChecked(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    fail('STATEMENT_FOOTPRINT_OVERFLOW', 'Statement footprint exceeds the safe integer range');
  }
  return result;
}

function stringBytes(value) {
  return addChecked(16, value.length * 2);
}

function assertDataDescriptor(value, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('STATEMENT_FOOTPRINT_ACCESSOR_FORBIDDEN', 'Statement state must not contain accessors', {
      path
    });
  }
  return descriptor;
}

function estimateStatementValueBytes(value, options = {}) {
  const seen = options.seen || new Set();
  const path = options.path || '/';
  if (value === null || value === undefined) return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('STATEMENT_FOOTPRINT_NUMBER_INVALID', 'Statement state numbers must be finite', { path });
    }
    return 8;
  }
  if (typeof value === 'string') return stringBytes(value);
  if (typeof value === 'bigint') return 16;
  if (typeof value === 'function' || typeof value === 'symbol') {
    fail('STATEMENT_FOOTPRINT_TYPE_FORBIDDEN', `Statement state contains unsupported ${typeof value}`, {
      path
    });
  }
  if (!value || typeof value !== 'object') return 16;
  if (utilTypes.isProxy(value)) {
    fail('STATEMENT_FOOTPRINT_PROXY_FORBIDDEN', 'Statement state must not contain Proxy objects', {
      path
    });
  }
  if (seen.has(value)) return 0;
  seen.add(value);

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return addChecked(OBJECT_OVERHEAD_BYTES, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return addChecked(OBJECT_OVERHEAD_BYTES, value.byteLength);
  }
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype) {
      fail('STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN', 'Statement Date values must not be subclassed', {
        path
      });
    }
    return OBJECT_OVERHEAD_BYTES;
  }
  if (value instanceof WeakMap || value instanceof WeakSet) {
    fail('STATEMENT_FOOTPRINT_WEAK_COLLECTION_FORBIDDEN', 'Statement state must not contain weak collections', {
      path
    });
  }
  if (value instanceof Set) {
    if (Object.getPrototypeOf(value) !== Set.prototype) {
      fail('STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN', 'Statement Set values must not be subclassed', {
        path
      });
    }
    let bytes = addChecked(OBJECT_OVERHEAD_BYTES, value.size * SET_ENTRY_OVERHEAD_BYTES);
    let index = 0;
    for (const item of value) {
      bytes = addChecked(bytes, estimateStatementValueBytes(item, {
        seen,
        path: `${path}/set/${index}`
      }));
      index += 1;
    }
    return bytes;
  }
  if (value instanceof Map) {
    if (Object.getPrototypeOf(value) !== Map.prototype) {
      fail('STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN', 'Statement Map values must not be subclassed', {
        path
      });
    }
    let bytes = addChecked(OBJECT_OVERHEAD_BYTES, value.size * MAP_ENTRY_OVERHEAD_BYTES);
    let index = 0;
    for (const [key, item] of value) {
      bytes = addChecked(bytes, estimateStatementValueBytes(key, {
        seen,
        path: `${path}/map/${index}/key`
      }));
      bytes = addChecked(bytes, estimateStatementValueBytes(item, {
        seen,
        path: `${path}/map/${index}/value`
      }));
      index += 1;
    }
    return bytes;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail('STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN', 'Statement arrays must use Array.prototype', {
        path
      });
    }
    let bytes = addChecked(ARRAY_OVERHEAD_BYTES, value.length * PROPERTY_SLOT_BYTES);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key === 'symbol') {
        fail('STATEMENT_FOOTPRINT_SYMBOL_KEY_FORBIDDEN', 'Statement arrays must not contain symbol keys', {
          path
        });
      }
      const descriptor = assertDataDescriptor(value, key, `${path}/${key}`);
      bytes = addChecked(bytes, stringBytes(key));
      bytes = addChecked(bytes, estimateStatementValueBytes(descriptor.value, {
        seen,
        path: `${path}/${key}`
      }));
    }
    return bytes;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN', 'Statement state must contain only supported plain objects', {
      path
    });
  }
  let bytes = OBJECT_OVERHEAD_BYTES;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      fail('STATEMENT_FOOTPRINT_SYMBOL_KEY_FORBIDDEN', 'Statement objects must not contain symbol keys', {
        path
      });
    }
    const descriptor = assertDataDescriptor(value, key, `${path}/${key}`);
    bytes = addChecked(bytes, PROPERTY_SLOT_BYTES);
    bytes = addChecked(bytes, stringBytes(key));
    bytes = addChecked(bytes, estimateStatementValueBytes(descriptor.value, {
      seen,
      path: `${path}/${key}`
    }));
  }
  return bytes;
}

function roundStatementReservationBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError('Statement reservation bytes must be a non-negative safe integer');
  }
  const normalized = Math.max(MIN_RESERVATION_BYTES, bytes);
  return Math.ceil(normalized / PAGE_BYTES) * PAGE_BYTES;
}

function withHeadroom(rawBytes) {
  const multiplied = rawBytes * HEADROOM_NUMERATOR;
  if (!Number.isSafeInteger(multiplied)) {
    fail('STATEMENT_FOOTPRINT_OVERFLOW', 'Statement footprint headroom exceeds the safe integer range');
  }
  return Math.ceil(multiplied / HEADROOM_DENOMINATOR);
}

function estimateStatementFootprint(value, options = {}) {
  const kind = options.kind || 'persistent-state';
  const defaultBudget = kind === 'persistent-state'
    ? STATEMENT_RESOURCE_CONTRACT.persistentStateBudgetBytes
    : kind === 'pending-interaction'
      ? STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes
      : null;
  if (defaultBudget === null) {
    throw new TypeError('Statement footprint kind must be persistent-state or pending-interaction');
  }
  const budgetBytes = options.budgetBytes === undefined ? defaultBudget : options.budgetBytes;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new TypeError('Statement footprint budget must be a positive safe integer');
  }
  const rawBytes = estimateStatementValueBytes(value);
  const estimatedBytes = roundStatementReservationBytes(withHeadroom(rawBytes));
  if (estimatedBytes > budgetBytes) {
    fail(
      kind === 'persistent-state'
        ? 'STATEMENT_STATE_BUDGET_EXCEEDED'
        : 'STATEMENT_PENDING_INTERACTION_BUDGET_EXCEEDED',
      `Statement ${kind} requires ${estimatedBytes} bytes, budget is ${budgetBytes}`,
      { kind, rawBytes, estimatedBytes, budgetBytes }
    );
  }
  return Object.freeze({
    kind,
    rawBytes,
    estimatedBytes,
    budgetBytes,
    headroomNumerator: HEADROOM_NUMERATOR,
    headroomDenominator: HEADROOM_DENOMINATOR,
    pageBytes: PAGE_BYTES
  });
}

function estimateStatementServiceStateFootprint(state, options = {}) {
  return estimateStatementFootprint(state, { ...options, kind: 'persistent-state' });
}

function estimateStatementPendingInteractionFootprint(context, options = {}) {
  return estimateStatementFootprint(context, { ...options, kind: 'pending-interaction' });
}

module.exports = {
  StatementStateFootprintError,
  estimateStatementFootprint,
  estimateStatementPendingInteractionFootprint,
  estimateStatementServiceStateFootprint,
  estimateStatementValueBytes,
  roundStatementReservationBytes
};
