'use strict';

const BANK_ROW_CLASSIFICATION = Object.freeze({
  PARTICIPATING: 'participating',
  EMPTY_RECONCILIATION_ID: 'empty-reconciliation-id',
  ZERO_AMOUNT: 'zero-amount',
  INVALID_BOTH_NONZERO: 'invalid-both-nonzero'
});

const MAX_CANONICAL_DECIMAL_LENGTH = 100000;

class BankRowValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BankRowValidationError';
    this.code = details.code || 'pre-fund-bank-row-invalid';
    Object.assign(this, details);
  }
}

function trimCell(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function locationText(context = {}) {
  const fileName = trimCell(context.fileName || context.sourceFileName) || '未知文件';
  const excelRowNumber = context.excelRowNumber ?? context.sourceRowNumber;
  const rowText = Number.isInteger(Number(excelRowNumber))
    ? `Excel第${Number(excelRowNumber)}行`
    : 'Excel未知行';
  return `文件「${fileName}」${rowText}`;
}

function decimalError(value, options, reason) {
  const label = trimCell(options && options.label) || '十进制金额';
  const rendered = value === null || value === undefined ? String(value) : String(value);
  const at = options && options.context ? `（${locationText(options.context)}）` : '';
  return new BankRowValidationError(
    `${label}“${rendered}”不是有效十进制数${at}：${reason}`,
    {
      code: 'pre-fund-invalid-decimal',
      field: label,
      value,
      ...(options && options.context ? options.context : {})
    }
  );
}

function normalizeDecimalToken(value, options) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw decimalError(value, options, '不接受 NaN 或 Infinity');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    throw decimalError(value, options, `不支持 ${typeof value} 类型`);
  }

  const token = value.trim();
  if (token === '') return '';
  if (!token.includes(',')) return token;

  const grouped = /^[+-]?(?:\d{1,3}(?:,\d{3})+)(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
  if (!grouped.test(token)) {
    throw decimalError(value, options, '千分位逗号位置不合法');
  }
  return token.replace(/,/g, '');
}

/**
 * 把十进制文本规范为不含指数、前导零和无意义尾零的稳定字符串。
 * 全程只做字符串与 BigInt 指数运算，不使用 JS 浮点做数值比较。
 */
function canonicalizeDecimal(value, options = {}) {
  const token = normalizeDecimalToken(value, options);
  if (token === '') {
    if (options.allowEmpty) return '';
    if (options.emptyAsZero) return '0';
    throw decimalError(value, options, '值不能为空');
  }

  const match = token.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    throw decimalError(value, options, '格式应为普通十进制或十进制科学计数法');
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
    throw decimalError(value, options, '指数超出可处理范围');
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
      throw decimalError(value, options, '规范化结果过长');
    }
    canonical = `0.${'0'.repeat(Number(zeroCount))}${digits}`;
  } else if (point >= BigInt(digits.length)) {
    const zeroCount = point - BigInt(digits.length);
    if (zeroCount + BigInt(digits.length) > BigInt(MAX_CANONICAL_DECIMAL_LENGTH)) {
      throw decimalError(value, options, '规范化结果过长');
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

function resolveBankRowContext(row, context = {}) {
  const inputIndex = context.inputIndex;
  const inferredExcelRow = Number.isInteger(inputIndex)
    ? Number(context.startExcelRowNumber ?? 2) + inputIndex
    : undefined;
  return {
    fileName: trimCell(
      context.fileName
      || context.sourceFileName
      || row._sourceFileName
      || row.sourceFileName
      || row.fileName
    ) || '未知文件',
    excelRowNumber: context.excelRowNumber
      ?? context.sourceRowNumber
      ?? row._excelRowNumber
      ?? row.excelRowNumber
      ?? row.sourceRowNumber
      ?? inferredExcelRow,
    inputIndex
  };
}

function pickFirstValue(row, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      const value = row[field];
      if (value !== null && value !== undefined && trimCell(value) !== '') return value;
    }
  }
  return '';
}

function buildStableTraceId(fileName, excelRowNumber) {
  const safeFileName = trimCell(fileName) || '未知文件';
  const rowNumber = Number(excelRowNumber);
  const rowPart = Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : '未知行';
  return `${safeFileName}#${rowPart}`;
}

function classifyBankRow(row, context = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new BankRowValidationError('标准银行对账单行必须是对象', {
      code: 'pre-fund-bank-row-not-object'
    });
  }

  const resolvedContext = resolveBankRowContext(row, context);
  const credit = canonicalizeDecimal(row['Credit Amount'], {
    emptyAsZero: true,
    label: 'Credit Amount',
    context: resolvedContext
  });
  const debit = canonicalizeDecimal(row['Debit Amount'], {
    emptyAsZero: true,
    label: 'Debit Amount',
    context: resolvedContext
  });
  const creditNonzero = credit !== '0';
  const debitNonzero = debit !== '0';

  const base = {
    rawRow: row,
    sourceFileName: resolvedContext.fileName,
    excelRowNumber: resolvedContext.excelRowNumber,
    inputIndex: resolvedContext.inputIndex,
    creditAmountCanonical: credit,
    debitAmountCanonical: debit
  };

  if (creditNonzero && debitNonzero) {
    return {
      ...base,
      classification: BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO
    };
  }
  if (!creditNonzero && !debitNonzero) {
    return {
      ...base,
      classification: BANK_ROW_CLASSIFICATION.ZERO_AMOUNT
    };
  }

  const isCredit = creditNonzero;
  const reconciliationId = trimCell(row.ReconciliationId);
  const originBillId = trimCell(row.OriginBillId)
    || buildStableTraceId(resolvedContext.fileName, resolvedContext.excelRowNumber);
  const derived = {
    ...base,
    classification: reconciliationId === ''
      ? BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID
      : BANK_ROW_CLASSIFICATION.PARTICIPATING,
    reconciliationId,
    transactionType: isCredit ? 'CREDIT' : 'DEBIT',
    name: trimCell(pickFirstValue(
      row,
      isCredit ? ['Drawee', 'Drawee Name'] : ['Payee', 'Payee Name']
    )),
    cardNo: trimCell(pickFirstValue(
      row,
      isCredit
        ? ['Drawee Account', 'Drawee CardNo']
        : ['Payee Account', 'Payee CardNo']
    )),
    amount: absoluteDecimal(isCredit ? credit : debit),
    originBillId,
    channel: trimCell(row.Channel),
    currency: trimCell(row.Currency)
  };
  return derived;
}

function toInvalidBothNonzeroError(classifiedRow, stats) {
  const row = classifiedRow.rawRow || {};
  const context = {
    fileName: classifiedRow.sourceFileName,
    excelRowNumber: classifiedRow.excelRowNumber
  };
  return new BankRowValidationError(
    `标准银行对账单${locationText(context)}金额非法：Credit Amount=${String(row['Credit Amount'] ?? '')}，Debit Amount=${String(row['Debit Amount'] ?? '')}，两个金额均非零；请修正后重新运行。`,
    {
      code: 'pre-fund-bank-both-amounts-nonzero',
      classification: BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO,
      fileName: context.fileName,
      excelRowNumber: context.excelRowNumber,
      creditAmount: row['Credit Amount'],
      debitAmount: row['Debit Amount'],
      stats
    }
  );
}

function deriveBankRow(row, context = {}) {
  const classified = classifyBankRow(row, context);
  if (classified.classification === BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO) {
    throw toInvalidBothNonzeroError(classified);
  }
  return classified;
}

module.exports = {
  BANK_ROW_CLASSIFICATION,
  BankRowValidationError,
  canonicalizeDecimal,
  absoluteDecimal,
  trimCell,
  buildStableTraceId,
  classifyBankRow,
  deriveBankRow,
  toInvalidBothNonzeroError,
  resolveBankRowContext
};
