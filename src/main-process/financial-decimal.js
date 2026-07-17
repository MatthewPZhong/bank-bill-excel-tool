'use strict';

const MAX_CANONICAL_DECIMAL_LENGTH = 100000;

class FinancialDecimalError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FinancialDecimalError';
    this.code = details.code || 'invalid-financial-decimal';
    Object.assign(this, details);
  }
}

function trimLabel(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function createDecimalError(value, options, reason) {
  if (options && typeof options.errorFactory === 'function') {
    return options.errorFactory(value, options, reason);
  }
  const label = trimLabel(options && options.label) || '十进制金额';
  return new FinancialDecimalError(
    `${label}“${String(value)}”不是有效十进制数：${reason}`,
    { field: label, value, reason }
  );
}

function normalizeDecimalToken(value, options) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createDecimalError(value, options, '不接受 NaN 或 Infinity');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    throw createDecimalError(value, options, `不支持 ${typeof value} 类型`);
  }

  const token = value.trim();
  if (token === '') return '';
  if (!token.includes(',')) return token;

  const grouped = /^[+-]?(?:\d{1,3}(?:,\d{3})+)(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
  if (!grouped.test(token)) {
    throw createDecimalError(value, options, '千分位逗号位置不合法');
  }
  return token.replace(/,/g, '');
}

function canonicalizeDecimal(value, options = {}) {
  const token = normalizeDecimalToken(value, options);
  if (token === '') {
    if (options.allowEmpty) return '';
    if (options.emptyAsZero) return '0';
    throw createDecimalError(value, options, '值不能为空');
  }

  const match = token.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    throw createDecimalError(value, options, '格式应为普通十进制或十进制科学计数法');
  }

  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2] || '';
  const fractionPart = match[2] !== undefined ? (match[3] || '') : (match[4] || '');
  let digits = `${integerPart}${fractionPart}`.replace(/^0+/, '');
  if (digits === '') return '0';

  let exponent;
  try {
    exponent = BigInt(match[5] || '0') - BigInt(fractionPart.length);
  } catch (_error) {
    throw createDecimalError(value, options, '指数超出可处理范围');
  }

  const trailingZeros = digits.match(/0+$/);
  if (trailingZeros) {
    const count = trailingZeros[0].length;
    digits = digits.slice(0, -count);
    exponent += BigInt(count);
  }

  const point = BigInt(digits.length) + exponent;
  let canonical;
  if (point <= 0n) {
    const zeroCount = -point;
    if (zeroCount + BigInt(digits.length) + 2n > BigInt(MAX_CANONICAL_DECIMAL_LENGTH)) {
      throw createDecimalError(value, options, '规范化结果过长');
    }
    canonical = `0.${'0'.repeat(Number(zeroCount))}${digits}`;
  } else if (point >= BigInt(digits.length)) {
    const zeroCount = point - BigInt(digits.length);
    if (zeroCount + BigInt(digits.length) > BigInt(MAX_CANONICAL_DECIMAL_LENGTH)) {
      throw createDecimalError(value, options, '规范化结果过长');
    }
    canonical = `${digits}${'0'.repeat(Number(zeroCount))}`;
  } else {
    const splitAt = Number(point);
    canonical = `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
  }

  return `${sign}${canonical}`;
}

function absoluteDecimal(value, options = {}) {
  const canonical = canonicalizeDecimal(value, options);
  return canonical.startsWith('-') ? canonical.slice(1) : canonical;
}

function canonicalDecimalParts(value, options = {}) {
  const canonical = canonicalizeDecimal(value, options);
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integerPart, fractionPart = ''] = unsigned.split('.');
  return { canonical, negative, integerPart, fractionPart };
}

function pairToScaledIntegers(left, right, options = {}) {
  const shared = { context: options.context, errorFactory: options.errorFactory };
  const leftParts = canonicalDecimalParts(left, {
    ...shared,
    label: options.leftLabel || '左侧金额'
  });
  const rightParts = canonicalDecimalParts(right, {
    ...shared,
    label: options.rightLabel || '右侧金额'
  });
  const scale = Math.max(leftParts.fractionPart.length, rightParts.fractionPart.length);
  const toScaledInteger = (parts) => {
    const digits = `${parts.integerPart}${parts.fractionPart.padEnd(scale, '0')}`;
    const integer = BigInt(digits || '0');
    return parts.negative ? -integer : integer;
  };
  return {
    left: toScaledInteger(leftParts),
    right: toScaledInteger(rightParts),
    scale
  };
}

function renderScaledInteger(value, scale, options = {}) {
  if (value === 0n) return '0';
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString();
  let rendered;
  if (scale === 0) {
    rendered = digits;
  } else {
    digits = digits.padStart(scale + 1, '0');
    rendered = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return canonicalizeDecimal(`${negative ? '-' : ''}${rendered}`, options);
}

function combineCanonicalDecimals(left, right, rightSign, options = {}) {
  const scaled = pairToScaledIntegers(left, right, options);
  return renderScaledInteger(scaled.left + (rightSign * scaled.right), scaled.scale, {
    context: options.context,
    errorFactory: options.errorFactory,
    label: options.label || '金额运算结果'
  });
}

function addCanonicalDecimals(left, right, options = {}) {
  return combineCanonicalDecimals(left, right, 1n, {
    ...options,
    label: options.label || '金额加总'
  });
}

function subtractCanonicalDecimals(left, right, options = {}) {
  return combineCanonicalDecimals(left, right, -1n, {
    ...options,
    label: options.label || '金额差'
  });
}

function compareCanonicalDecimals(left, right, options = {}) {
  const scaled = pairToScaledIntegers(left, right, options);
  if (scaled.left < scaled.right) return -1;
  if (scaled.left > scaled.right) return 1;
  return 0;
}

module.exports = {
  FinancialDecimalError,
  MAX_CANONICAL_DECIMAL_LENGTH,
  canonicalizeDecimal,
  absoluteDecimal,
  addCanonicalDecimals,
  subtractCanonicalDecimals,
  compareCanonicalDecimals
};
