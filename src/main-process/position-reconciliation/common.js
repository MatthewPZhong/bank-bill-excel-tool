'use strict';

const crypto = require('node:crypto');
const { normalizeDateExportValue } = require('../../backend/file-service/normalizers');

class PositionReconciliationError extends Error {
  constructor(code, message, detailLines = []) {
    super(message);
    this.name = 'PositionReconciliationError';
    this.code = code;
    this.detailLines = Array.isArray(detailLines) ? detailLines : [];
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function isBlankRow(row, headers) {
  return headers.every((header) => text(row && row[header]) === '');
}

function normalizeDate(value) {
  const normalized = normalizeDateExportValue(value);
  if (!normalized || !normalized.date || Number.isNaN(normalized.date.getTime())) return '';
  const date = normalized.date;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthOf(value) {
  const iso = normalizeDate(value);
  return iso ? iso.slice(0, 7) : '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString());
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function canonicalDecimal(value) {
  const raw = text(value);
  if (raw === '') return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2];
  const fracPart = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  let scale = fracPart.length - exponent;
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  if (digits === '') digits = '0';
  let units = BigInt(digits) * sign;
  if (units === 0n) units = 0n;
  return { units, scale };
}

function alignDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.units * (10n ** BigInt(scale - left.scale)),
    right: right.units * (10n ** BigInt(scale - right.scale)),
    scale
  };
}

function addDecimals(left, right) {
  if (!left || !right) return null;
  const aligned = alignDecimal(left, right);
  return { units: aligned.left + aligned.right, scale: aligned.scale };
}

function absDecimal(value) {
  if (!value) return null;
  return { units: value.units < 0n ? -value.units : value.units, scale: value.scale };
}

function decimalIsZero(value) {
  return Boolean(value) && value.units === 0n;
}

function decimalIsNegative(value) {
  return Boolean(value) && value.units < 0n;
}

function decimalToCents(value) {
  if (!value) return null;
  if (value.scale <= 2) return value.units * (10n ** BigInt(2 - value.scale));
  const divisor = 10n ** BigInt(value.scale - 2);
  const quotient = value.units / divisor;
  const remainder = value.units % divisor;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const roundUp = absRemainder * 2n >= divisor;
  return quotient + (roundUp ? (value.units < 0n ? -1n : 1n) : 0n);
}

function decimalEqualToCent(left, right) {
  return decimalToCents(left) === decimalToCents(right);
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_rollbackError) {
      // Preserve the original error.
    }
    throw error;
  }
}

module.exports = {
  PositionReconciliationError,
  text,
  isBlankRow,
  normalizeDate,
  monthOf,
  stableJson,
  stableHash,
  canonicalDecimal,
  addDecimals,
  absDecimal,
  decimalIsZero,
  decimalIsNegative,
  decimalToCents,
  decimalEqualToCent,
  transaction
};
