const {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  SUPPORTED_EXTENSIONS,
  normalizeCell
} = require('./file-service/common');
const {
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadEnumValues,
  readRows,
  readRowsWithMetadata
} = require('./file-service/readers');
const {
  calculateEndingBalanceFromAmounts,
  hasEffectiveAmount,
  inferDateCellFormat,
  inferEndingBalance,
  loadCurrencyMappings: loadCurrencyMappingsFromMappings,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  resolveCurrencyValue,
  sanitizeAmountValue,
  splitSignedAmountValue,
  toExcelSerial
} = require('./file-service/normalizers');
const {
  writeBalanceWorkbook: writeBalanceWorkbookInternal,
  writeWorkbookRows: writeWorkbookRowsInternal
} = require('./file-service/writers');

function loadCurrencyMappings(filePath) {
  return loadCurrencyMappingsFromMappings(filePath, { readRows });
}

function buildMappedRows({
  inputFilePath,
  orderedTargetFields,
  mappingByField,
  accountMappingByBankId = {},
  currencyMappings = [],
  amountMappingRules = {},
  expectedSourceHeaders = [],
  selectedBigAccount = null
}) {
  const { rows, rowNumbers } = readRowsWithMetadata(inputFilePath, expectedSourceHeaders);
  const sourceHeaders = rows[0] || [];
  const sourceIndexByField = new Map();
  const issues = [];
  const rowMetas = [];
  const nameSourceField = normalizeCell(amountMappingRules.nameSourceField);
  const accountSourceField = normalizeCell(amountMappingRules.accountSourceField);
  const signedAmountSourceField = normalizeCell(amountMappingRules.signedAmountSourceField);
  const selectedMerchantId = normalizeCell(selectedBigAccount?.merchantId);
  const selectedCurrency = normalizeCell(selectedBigAccount?.currency);

  sourceHeaders.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (normalizedHeader && !sourceIndexByField.has(normalizedHeader)) {
      sourceIndexByField.set(normalizedHeader, index);
    }
  });
  const mappedRows = [orderedTargetFields.slice()];

  function normalizeMappingTokens(mappingValue) {
    if (Array.isArray(mappingValue)) {
      return mappingValue.map((value) => normalizeCell(value)).filter((value) => value !== '');
    }

    const normalizedValue = normalizeCell(mappingValue);
    return normalizedValue ? [normalizedValue] : [];
  }

  function resolveMappedPartsByTokens(mappingTokens, row) {
    return mappingTokens.map((token) => {
      if (token.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
        return token.slice(FIXED_FIELD_VALUE_PREFIX.length);
      }

      const sourceIndex = sourceIndexByField.get(token);
      return sourceIndex === undefined ? '' : row[sourceIndex];
    });
  }

  function resolveRawValueByMapping(mappingValue, row) {
    const mappingTokens = normalizeMappingTokens(mappingValue);

    if (!mappingTokens.length) {
      return '';
    }

    return resolveMappedPartsByTokens(mappingTokens, row)
      .filter((value) => normalizeCell(value) !== '')
      .join('');
  }

  function resolveDateRawValueByMapping(mappingValue, row) {
    const mappingTokens = normalizeMappingTokens(mappingValue);

    if (!mappingTokens.length) {
      return '';
    }

    return resolveMappedPartsByTokens(mappingTokens, row)
      .map((value) => normalizeCell(value))
      .filter((value) => value !== '')
      .join(' ');
  }

  rows.slice(1).forEach((row, rowIndex) => {
    const directCreditAmountRaw = resolveRawValueByMapping(mappingByField['Credit Amount'], row);
    const directDebitAmountRaw = resolveRawValueByMapping(mappingByField['Debit Amount'], row);
    const signedAmountValue = signedAmountSourceField
      ? splitSignedAmountValue(resolveRawValueByMapping(signedAmountSourceField, row))
      : null;
    const creditAmountValue = signedAmountValue
      ? signedAmountValue.creditAmount
      : sanitizeAmountValue(directCreditAmountRaw);
    const debitAmountValue = signedAmountValue
      ? signedAmountValue.debitAmount
      : sanitizeAmountValue(directDebitAmountRaw);
    const hasCreditAmount = signedAmountValue
      ? signedAmountValue.hasCreditAmount
      : hasEffectiveAmount(directCreditAmountRaw);
    const hasDebitAmount = signedAmountValue
      ? signedAmountValue.hasDebitAmount
      : hasEffectiveAmount(directDebitAmountRaw);

    rowMetas.push({
      sourceRowNumber: rowNumbers[rowIndex + 1] || rowIndex + 2
    });

    const mappedRow = orderedTargetFields.map((targetField) => {
      const mappingValue = mappingByField[targetField];
      const mappingTokens = normalizeMappingTokens(mappingValue);
      const primaryMappingValue = mappingTokens[0] || '';
      const sourceField = primaryMappingValue;
      const rawValue = resolveRawValueByMapping(mappingValue, row);

      if (targetField === 'Balance') {
        return sanitizeAmountValue(rawValue);
      }

      if (targetField === 'Credit Amount') {
        return creditAmountValue;
      }

      if (targetField === 'Debit Amount') {
        return debitAmountValue;
      }

      if (targetField === 'BillDate' || targetField === 'ValueDate') {
        return normalizeDateExportValue(resolveDateRawValueByMapping(mappingValue, row)).value;
      }

      if (nameSourceField && mappingValue === nameSourceField) {
        if (targetField === 'Drawee Name') {
          return hasCreditAmount && !hasDebitAmount ? rawValue ?? '' : '';
        }

        if (targetField === 'Payee Name') {
          return hasDebitAmount && !hasCreditAmount ? rawValue ?? '' : '';
        }
      }

      if (accountSourceField && mappingValue === accountSourceField) {
        if (targetField === 'Drawee CardNo') {
          return hasCreditAmount && !hasDebitAmount ? rawValue ?? '' : '';
        }

        if (targetField === 'Payee Cardno' || targetField === 'Payee CardNo') {
          return hasDebitAmount && !hasCreditAmount ? rawValue ?? '' : '';
        }
      }

      if (targetField === 'Currency') {
        if (selectedCurrency) {
          return selectedCurrency;
        }

        if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
          return primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
        }

        const currencyResult = resolveCurrencyValue(rawValue, currencyMappings);

        if (currencyResult.issue) {
          issues.push({
            ...currencyResult.issue,
            rowNumber: rowNumbers[rowIndex + 1] || rowIndex + 2,
            sourceField
          });
        }

        return currencyResult.value;
      }

      if (targetField === 'MerchantId') {
        if (selectedMerchantId) {
          return selectedMerchantId;
        }

        if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
          const fixedValue = primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
          return fixedValue === '__MULTI_BIG_ACCOUNT__' ? '' : fixedValue;
        }

        const originalValue = normalizeCell(rawValue);

        if (!originalValue) {
          return '';
        }

        return Object.prototype.hasOwnProperty.call(accountMappingByBankId, originalValue)
          ? String(accountMappingByBankId[originalValue])
          : rawValue;
      }

      if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
        return primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
      }

      return rawValue ?? '';
    });

    mappedRows.push(mappedRow);
  });

  mappedRows.issues = issues;
  mappedRows.rowMetas = rowMetas;
  return mappedRows;
}

function buildDetailExportRows(rows) {
  const sourceHeaderRow = Array.isArray(rows[0]) ? rows[0].slice() : [];
  const fieldIndexMap = new Map();
  const rowMetas = Array.isArray(rows.rowMetas) ? rows.rowMetas : [];
  const balanceIndex = sourceHeaderRow.findIndex((fieldName) => normalizeCell(fieldName) === 'Balance');
  const headerRow = balanceIndex < 0
    ? sourceHeaderRow.slice()
    : sourceHeaderRow.filter((_fieldName, index) => index !== balanceIndex);
  const exportRows = [headerRow];
  const sourceRows = [sourceHeaderRow.slice()];
  const skippedRows = [];
  const simultaneousRows = [];
  const sourceRowMetas = [];

  sourceHeaderRow.forEach((fieldName, index) => {
    const normalizedField = normalizeCell(fieldName);

    if (normalizedField && !fieldIndexMap.has(normalizedField)) {
      fieldIndexMap.set(normalizedField, index);
    }
  });

  const creditAmountIndex = fieldIndexMap.get('Credit Amount');
  const debitAmountIndex = fieldIndexMap.get('Debit Amount');

  rows.slice(1).forEach((row, index) => {
    const sourceRow = Array.isArray(row) ? row.slice() : [];
    const exportRow = sourceRow.slice();
    const creditAmountValue = creditAmountIndex === undefined ? '' : sourceRow[creditAmountIndex];
    const debitAmountValue = debitAmountIndex === undefined ? '' : sourceRow[debitAmountIndex];
    const creditAmountNumeric = parseNumericValue(creditAmountValue);
    const debitAmountNumeric = parseNumericValue(debitAmountValue);
    const isCreditAmountZeroOrBlank = normalizeCell(creditAmountValue) === '' || creditAmountNumeric === 0;
    const isDebitAmountZeroOrBlank = normalizeCell(debitAmountValue) === '' || debitAmountNumeric === 0;

    if (
      creditAmountIndex !== undefined &&
      debitAmountIndex !== undefined &&
      !isCreditAmountZeroOrBlank &&
      !isDebitAmountZeroOrBlank
    ) {
      simultaneousRows.push({
        sourceRowNumber: rowMetas[index]?.sourceRowNumber || index + 2,
        creditAmount: normalizeCell(creditAmountValue),
        debitAmount: normalizeCell(debitAmountValue)
      });
      return;
    }

    if (
      creditAmountIndex !== undefined &&
      debitAmountIndex !== undefined &&
      isCreditAmountZeroOrBlank &&
      isDebitAmountZeroOrBlank
    ) {
      skippedRows.push({
        sourceRowNumber: rowMetas[index]?.sourceRowNumber || index + 2,
        creditAmount: normalizeCell(creditAmountValue),
        debitAmount: normalizeCell(debitAmountValue)
      });
      return;
    }

    sourceRows.push(sourceRow);
    sourceRowMetas.push(rowMetas[index] || null);

    if (balanceIndex >= 0) {
      exportRow.splice(balanceIndex, 1);
    }

    exportRows.push(exportRow);
  });

  sourceRows.rowMetas = sourceRowMetas;
  exportRows.skippedRows = skippedRows;
  exportRows.simultaneousRows = simultaneousRows;
  exportRows.sourceRows = sourceRows;
  return exportRows;
}

function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON' }) {
  return writeWorkbookRowsInternal(
    { rows, outputFilePath, sheetName },
    { inferDateCellFormat, parseDateValue, parseNumericValue, toExcelSerial }
  );
}

function writeBalanceWorkbook({
  templateFilePath,
  records,
  templateFields = [],
  outputFilePath
}) {
  return writeBalanceWorkbookInternal(
    { templateFilePath, records, templateFields, outputFilePath },
    { inferDateCellFormat, parseDateValue, parseNumericValue, toExcelSerial }
  );
}

function transformFileToWorkbook({
  inputFilePath,
  mappingByField,
  merchantSourceFields = [],
  accountMappingByBankId = {},
  outputFilePath
}) {
  const orderedTargetFields = [];

  Object.entries(mappingByField).forEach(([sourceField, targetField]) => {
    if (!targetField) {
      return;
    }

    orderedTargetFields.push(targetField);
  });

  const normalizedMappingByField = Object.entries(mappingByField).reduce((accumulator, [sourceField, targetField]) => {
    if (!targetField) {
      return accumulator;
    }

    accumulator[targetField] = sourceField;
    return accumulator;
  }, {});

  if (!orderedTargetFields.includes('MerchantId') && merchantSourceFields.length) {
    orderedTargetFields.push('MerchantId');
  }

  const rows = buildMappedRows({
    inputFilePath,
    orderedTargetFields,
    mappingByField: normalizedMappingByField,
    accountMappingByBankId
  });

  return writeWorkbookRows({
    rows,
    outputFilePath
  });
}

module.exports = {
  calculateEndingBalanceFromAmounts,
  buildMappedRows,
  buildDetailExportRows,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  inferEndingBalance,
  SUPPORTED_EXTENSIONS,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  readRows,
  transformFileToWorkbook,
  writeBalanceWorkbook,
  writeWorkbookRows
};
