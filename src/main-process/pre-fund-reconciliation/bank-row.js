'use strict';

const financialDecimal = require('../financial-decimal');

const BANK_ROW_CLASSIFICATION = Object.freeze({
  PARTICIPATING: 'participating',
  EMPTY_RECONCILIATION_ID: 'empty-reconciliation-id',
  ZERO_AMOUNT: 'zero-amount',
  INVALID_BOTH_NONZERO: 'invalid-both-nonzero'
});

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

function canonicalizeDecimal(value, options = {}) {
  return financialDecimal.canonicalizeDecimal(value, { ...options, errorFactory: decimalError });
}

function absoluteDecimal(value, options = {}) {
  return financialDecimal.absoluteDecimal(value, { ...options, errorFactory: decimalError });
}

function addCanonicalDecimals(left, right, options = {}) {
  return financialDecimal.addCanonicalDecimals(left, right, {
    ...options,
    errorFactory: decimalError
  });
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
  const extraFee = canonicalizeDecimal(row['Extra Fee'], {
    emptyAsZero: true,
    label: 'Extra Fee',
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
    debitAmountCanonical: debit,
    extraFeeCanonical: extraFee
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
  const directionAmount = absoluteDecimal(isCredit ? credit : debit);
  const matchingAmount = addCanonicalDecimals(directionAmount, extraFee, {
    leftLabel: isCredit ? 'Credit Amount' : 'Debit Amount',
    rightLabel: 'Extra Fee',
    label: '银行对账金额',
    context: resolvedContext
  });
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
    amount: directionAmount,
    directionAmount,
    matchingAmount,
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
  addCanonicalDecimals,
  trimCell,
  buildStableTraceId,
  classifyBankRow,
  deriveBankRow,
  toInvalidBothNonzeroError,
  resolveBankRowContext
};
