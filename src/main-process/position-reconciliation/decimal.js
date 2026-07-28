'use strict';

const {
  canonicalizeDecimal,
  absoluteDecimal,
  addCanonicalDecimals,
  compareCanonicalDecimals
} = require('../financial-decimal');

function amountFailure(code, message, field, value) {
  return {
    ok: false,
    code,
    message,
    field,
    value
  };
}

function canonicalAmount(value, field, options = {}) {
  try {
    return {
      ok: true,
      value: canonicalizeDecimal(value, {
        label: field,
        ...options
      })
    };
  } catch (_error) {
    return amountFailure('invalid-amount', `${field}为空或不是合法金额`, field, value);
  }
}

function absoluteAmount(value, field) {
  try {
    return {
      ok: true,
      value: absoluteDecimal(value, { label: field })
    };
  } catch (_error) {
    return amountFailure('invalid-amount', `${field}为空或不是合法金额`, field, value);
  }
}

/**
 * 使用十进制文本执行四舍五入并转为分，避免 Number 浮点误差。
 * 负数采用绝对值四舍五入后恢复符号；资金匹配调用方通常会先拒绝负合计。
 */
function canonicalToCents(value, field = '金额') {
  const parsed = canonicalAmount(value, field);
  if (!parsed.ok) return parsed;

  const negative = parsed.value.startsWith('-');
  const unsigned = negative ? parsed.value.slice(1) : parsed.value;
  const [integerPart, fractionPart = ''] = unsigned.split('.');
  const keptFraction = fractionPart.padEnd(2, '0').slice(0, 2);
  const discardedFraction = fractionPart.slice(2);
  let cents = BigInt(integerPart) * 100n + BigInt(keptFraction || '0');
  if (discardedFraction !== '' && discardedFraction[0] >= '5') cents += 1n;

  return {
    ok: true,
    canonical: parsed.value,
    cents: negative ? -cents : cents
  };
}

function validateDirection(bankRow, direction) {
  const mainField = direction === 'credit' ? 'Credit Amount' : 'Debit Amount';
  const oppositeField = direction === 'credit' ? 'Debit Amount' : 'Credit Amount';
  const main = absoluteAmount(bankRow && bankRow[mainField], mainField);
  if (!main.ok) return main;
  if (main.value === '0') {
    return amountFailure('zero-main-amount', `${mainField}必须为非0金额`, mainField, bankRow && bankRow[mainField]);
  }

  if (direction !== 'test-debit') {
    const opposite = canonicalAmount(bankRow && bankRow[oppositeField], oppositeField, { emptyAsZero: true });
    if (!opposite.ok) return opposite;
    if (opposite.value !== '0') {
      return amountFailure(
        'opposite-amount-not-zero',
        `${oppositeField}必须为空或为0`,
        oppositeField,
        bankRow && bankRow[oppositeField]
      );
    }
  }

  return {
    ok: true,
    mainField,
    oppositeField: direction === 'test-debit' ? null : oppositeField,
    amount: main.value
  };
}

function positionBankAmountWithExtraFee(bankRow, direction) {
  const directionResult = validateDirection(bankRow, direction);
  if (!directionResult.ok) return directionResult;

  const fee = canonicalAmount(bankRow && bankRow['Extra Fee'], 'Extra Fee', { emptyAsZero: true });
  if (!fee.ok) return fee;

  let total;
  try {
    total = addCanonicalDecimals(directionResult.amount, fee.value, {
      leftLabel: directionResult.mainField,
      rightLabel: 'Extra Fee',
      label: '银行方向金额与手续费合计'
    });
  } catch (_error) {
    return amountFailure(
      'amount-total-invalid',
      '银行方向金额与手续费无法加总',
      'Extra Fee',
      bankRow && bankRow['Extra Fee']
    );
  }

  if (compareCanonicalDecimals(total, '0') < 0) {
    return amountFailure(
      'negative-total',
      '银行方向金额与手续费合计不能为负数',
      'Extra Fee',
      bankRow && bankRow['Extra Fee']
    );
  }

  const cents = canonicalToCents(total, '银行方向金额与手续费合计');
  return {
    ...cents,
    total,
    mainAmount: directionResult.amount,
    extraFee: fee.value,
    mainField: directionResult.mainField
  };
}

function sourceAmountToCents(value, field = 'Amount') {
  const amount = absoluteAmount(value, field);
  if (!amount.ok) return amount;
  if (amount.value === '0') {
    return amountFailure('zero-source-amount', `${field}必须为非0金额`, field, value);
  }
  return canonicalToCents(amount.value, field);
}

module.exports = {
  canonicalAmount,
  absoluteAmount,
  canonicalToCents,
  validateDirection,
  positionBankAmountWithExtraFee,
  sourceAmountToCents
};
