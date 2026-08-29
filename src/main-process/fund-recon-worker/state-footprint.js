'use strict';

const {
  FUND_RECON_STATE_BUDGET_BYTES
} = require('./policies');

const MIN_RESERVATION_BYTES = 4096;
const OBJECT_OVERHEAD_BYTES = 48;
const ARRAY_OVERHEAD_BYTES = 32;
const MAP_ENTRY_OVERHEAD_BYTES = 40;
const SET_ENTRY_OVERHEAD_BYTES = 24;

class FundReconStateFootprintError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FundReconStateFootprintError';
    this.code = code;
    this.details = details;
  }
}

function estimateValueBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'string') return 16 + Buffer.byteLength(value, 'utf8') * 2;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 0;
  seen.add(value);

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return OBJECT_OVERHEAD_BYTES + value.byteLength;
  }
  if (value instanceof ArrayBuffer) return OBJECT_OVERHEAD_BYTES + value.byteLength;
  if (value instanceof Date) return OBJECT_OVERHEAD_BYTES;
  if (value instanceof Set) {
    let bytes = OBJECT_OVERHEAD_BYTES + value.size * SET_ENTRY_OVERHEAD_BYTES;
    for (const item of value) bytes += estimateValueBytes(item, seen);
    return bytes;
  }
  if (value instanceof Map) {
    let bytes = OBJECT_OVERHEAD_BYTES + value.size * MAP_ENTRY_OVERHEAD_BYTES;
    for (const [key, item] of value) {
      bytes += estimateValueBytes(key, seen) + estimateValueBytes(item, seen);
    }
    return bytes;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (bytes, item) => bytes + estimateValueBytes(item, seen),
      ARRAY_OVERHEAD_BYTES + value.length * 8
    );
  }
  let bytes = OBJECT_OVERHEAD_BYTES;
  for (const [key, item] of Object.entries(value)) {
    bytes += estimateValueBytes(key, seen) + estimateValueBytes(item, seen);
  }
  return bytes;
}

function roundReservationBytes(bytes) {
  const normalized = Math.max(MIN_RESERVATION_BYTES, Math.ceil(bytes));
  const page = 4096;
  return Math.ceil(normalized / page) * page;
}

function estimateFundReconStateFootprint(state, options = {}) {
  const budgetBytes = options.budgetBytes === undefined
    ? FUND_RECON_STATE_BUDGET_BYTES
    : options.budgetBytes;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new TypeError('FundRecon state budget must be a positive safe integer');
  }
  // JSON/object graph estimation intentionally adds 35% headroom for V8 object metadata,
  // structured-clone work buffers and Set/Map implementation variance.
  const estimatedBytes = roundReservationBytes(estimateValueBytes(state) * 1.35);
  if (estimatedBytes > budgetBytes) {
    throw new FundReconStateFootprintError(
      'FUND_RECON_STATE_BUDGET_EXCEEDED',
      `FundRecon state requires ${estimatedBytes} bytes, budget is ${budgetBytes}`,
      { estimatedBytes, budgetBytes }
    );
  }
  return Object.freeze({ estimatedBytes, budgetBytes });
}

module.exports = {
  FundReconStateFootprintError,
  estimateFundReconStateFootprint,
  estimateValueBytes,
  roundReservationBytes
};
