const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const FIXED_FIELD_VALUE_PREFIX = '__FIXED__:';

class FileValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.detailLines = Array.isArray(options.detailLines) ? options.detailLines.slice() : [];
    this.context = options.context && typeof options.context === 'object' ? { ...options.context } : {};
  }
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function isRowMeaningful(row) {
  return Array.isArray(row) && row.some((cell) => normalizeCell(cell) !== '');
}

function trimTrailingEmptyCells(row) {
  if (!Array.isArray(row)) {
    return [];
  }

  const lastMeaningfulIndex = row.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    return [];
  }

  return row.slice(0, lastMeaningfulIndex + 1);
}

function ensureSupportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new FileValidationError('FILE_TYPE', '文件类型错误，请重新导入');
  }
}

function readWorkbookRows(filePath, { blankrows = false } = {}) {
  ensureSupportedFile(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  try {
    const workbook = XLSX.readFile(filePath, {
      cellDates: false,
      dense: true,
      raw: false
    });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
    }

    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows,
      defval: ''
    });
  } catch (error) {
    if (error instanceof FileValidationError) {
      throw error;
    }

    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }
}

function readRows(filePath) {
  const rows = readWorkbookRows(filePath, { blankrows: false });

  if (!Array.isArray(rows) || rows.length === 0 || !rows.some(isRowMeaningful)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return rows;
}

function readRowsWithMetadata(filePath, expectedHeaders = []) {
  const rawRows = readWorkbookRows(filePath, { blankrows: true });
  const normalizedExpectedHeaders = Array.isArray(expectedHeaders)
    ? expectedHeaders.map((header) => normalizeCell(header)).filter((header) => header !== '')
    : [];
  const meaningfulRows = rawRows
    .map((row, index) => ({
      rowNumber: index + 1,
      cells: trimTrailingEmptyCells(Array.isArray(row) ? row : [])
    }))
    .filter((row) => isRowMeaningful(row.cells));

  if (!meaningfulRows.length) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  if (!normalizedExpectedHeaders.length) {
    return {
      rows: meaningfulRows.map((row) => row.cells),
      rowNumbers: meaningfulRows.map((row) => row.rowNumber)
    };
  }

  const expectedHeaderCount = normalizedExpectedHeaders.length;
  let matchedRowIndex = -1;
  let matchedColumnIndex = -1;

  meaningfulRows.some((row, rowIndex) => {
    const maximumStartIndex = row.cells.length - expectedHeaderCount;

    for (let startIndex = 0; startIndex <= maximumStartIndex; startIndex += 1) {
      const candidateHeaders = row.cells
        .slice(startIndex, startIndex + expectedHeaderCount)
        .map((cell) => normalizeCell(cell));

      if (candidateHeaders.every((cell, index) => cell === normalizedExpectedHeaders[index])) {
        matchedRowIndex = rowIndex;
        matchedColumnIndex = startIndex;
        return true;
      }
    }

    return false;
  });

  if (matchedRowIndex < 0 || matchedColumnIndex < 0) {
    throw new FileValidationError(
      'FILE_READ',
      '当前导入文件未匹配到所选模板的表头，请确认模板或原始网银账单是否正确'
    );
  }

  const rows = [];
  const rowNumbers = [];

  meaningfulRows.slice(matchedRowIndex).forEach((row, index) => {
    const normalizedCells = row.cells.slice(matchedColumnIndex, matchedColumnIndex + expectedHeaderCount);

    while (normalizedCells.length < expectedHeaderCount) {
      normalizedCells.push('');
    }

    if (index > 0 && !isRowMeaningful(normalizedCells)) {
      return;
    }

    rows.push(normalizedCells);
    rowNumbers.push(row.rowNumber);
  });

  return {
    rows,
    rowNumbers
  };
}

function extractHeaders(filePath) {
  const rows = readRows(filePath);
  const headerRow = rows[0];

  if (!isRowMeaningful(headerRow)) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  const lastMeaningfulIndex = headerRow.reduce((index, cell, currentIndex) => {
    return normalizeCell(cell) !== '' ? currentIndex : index;
  }, -1);

  if (lastMeaningfulIndex < 0) {
    throw new FileValidationError('FILE_READ', '文件为空或不可读，请重新导入');
  }

  return headerRow.slice(0, lastMeaningfulIndex + 1).map((cell) => normalizeCell(cell));
}

function loadEnumValues(enumFilePath) {
  const rows = readRows(enumFilePath);
  const firstRow = rows[0] || [];
  const shouldSkipFirstRow =
    firstRow.filter((cell) => normalizeCell(cell) !== '').length === 1 &&
    ['common字段', '映射字段', '枚举值'].includes(normalizeCell(firstRow[0]).toLowerCase());
  const values = [];
  const seen = new Set();

  rows.forEach((row, rowIndex) => {
    if (rowIndex === 0 && shouldSkipFirstRow) {
      return;
    }

    const value = normalizeCell(row[0]);

    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    values.push(value);
  });

  return values;
}

function extractEnumValuesFromImportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (extension !== '.xlsx' || !fileName.includes('枚举')) {
    throw new FileValidationError('FILE_TYPE', '请导入文件名带有“枚举”的xlsx文件');
  }

  const values = loadEnumValues(filePath);

  if (!values.length) {
    throw new FileValidationError('FILE_READ', '枚举表为空或不可读，请重新导入');
  }

  return values;
}

function parseNumericValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = normalizeCell(value).replaceAll(',', '');

  if (!normalized) {
    return null;
  }

  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

function roundAmount(value) {
  return Number(Number(value).toFixed(2));
}

function inferEndingBalance({ previousEndBalance, entries, dateLabel }) {
  const uniqueBalances = Array.from(
    new Set(
      entries
        .filter((entry) => entry.balanceValue !== null)
        .map((entry) => roundAmount(entry.balanceValue))
    )
  );

  if (uniqueBalances.length === 0) {
    throw new FileValidationError('FILE_READ', `${dateLabel} 未找到期末余额`);
  }

  if (uniqueBalances.length === 1) {
    return uniqueBalances[0];
  }

  if (previousEndBalance === null) {
    throw new FileValidationError('FILE_READ', `${dateLabel} 存在多个期末余额，且无法推导首日余额`);
  }

  const creditAmountSum = entries.reduce((sum, entry) => sum + entry.creditAmount, 0);
  const debitAmountSum = entries.reduce((sum, entry) => sum + entry.debitAmount, 0);
  const subtractDebitAmount = roundAmount(previousEndBalance + creditAmountSum - debitAmountSum);
  const addDebitAmount = roundAmount(previousEndBalance + creditAmountSum + debitAmountSum);
  const subtractMatch = uniqueBalances.find((balance) => Math.abs(balance - subtractDebitAmount) < 0.005);

  if (subtractMatch !== undefined) {
    return subtractMatch;
  }

  const addMatch = uniqueBalances.find((balance) => Math.abs(balance - addDebitAmount) < 0.005);

  if (addMatch !== undefined) {
    return addMatch;
  }

  throw new FileValidationError('FILE_READ', `${dateLabel} 的期末余额无法根据收支金额推导`);
}

function calculateEndingBalanceFromAmounts({ previousEndBalance, entries }) {
  const creditAmountSum = entries.reduce((sum, entry) => sum + entry.creditAmount, 0);
  const debitAmountSum = entries.reduce((sum, entry) => sum + entry.debitAmount, 0);
  return roundAmount(previousEndBalance + creditAmountSum - debitAmountSum);
}

function sanitizeAmountValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  const normalized = String(value).replace(/[^0-9.]/g, '');

  if (!normalized) {
    return '';
  }

  const firstDotIndex = normalized.indexOf('.');
  const sanitized = firstDotIndex < 0
    ? normalized
    : `${normalized.slice(0, firstDotIndex + 1)}${normalized.slice(firstDotIndex + 1).replace(/\./g, '')}`;

  if (!sanitized || sanitized === '.') {
    return '';
  }

  return sanitized.startsWith('.') ? `0${sanitized}` : sanitized;
}

function hasEffectiveAmount(rawValue) {
  const sanitized = sanitizeAmountValue(rawValue);

  if (!sanitized) {
    return false;
  }

  const numericValue = parseNumericValue(sanitized);
  return numericValue !== null && numericValue !== 0;
}

function normalizeCurrencyAlias(value) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/[（）()【】\[\]]/g, '')
    .replace(/[、，,;；]/g, '/')
    .replace(/\s+/g, '')
    .replace(/／/g, '/');
}

function extractCurrencyAliases(value) {
  const normalizedValue = normalizeCell(value);

  if (!normalizedValue) {
    return [];
  }

  const compactValue = normalizeCurrencyAlias(normalizedValue);
  const splitValues = normalizedValue
    .replace(/[、，,;；]/g, '/')
    .replace(/／/g, '/')
    .split('/')
    .map((item) => normalizeCurrencyAlias(item))
    .filter((item) => item !== '');

  return Array.from(new Set([compactValue, ...splitValues].filter((item) => item !== '')));
}

function loadCurrencyMappings(filePath) {
  const rows = readRows(filePath);
  const mappings = [];

  rows.slice(1).forEach((row, index) => {
    const simpleChinese = normalizeCell(row[0]);
    const traditionalChinese = normalizeCell(row[1]);
    const englishCode = normalizeCell(row[2]);

    if (!simpleChinese && !traditionalChinese && !englishCode) {
      return;
    }

    if (!englishCode) {
      throw new FileValidationError('FILE_READ', `币种映射表第${index + 2}行缺少英文简称`);
    }

    const aliases = Array.from(
      new Set([
        ...extractCurrencyAliases(simpleChinese),
        ...extractCurrencyAliases(traditionalChinese)
      ])
    );

    if (!aliases.length) {
      throw new FileValidationError('FILE_READ', `币种映射表第${index + 2}行缺少可匹配的币种名称`);
    }

    mappings.push({
      aliases,
      englishCode
    });
  });

  if (!mappings.length) {
    throw new FileValidationError('FILE_READ', '币种映射表为空或不可读，请重新确认');
  }

  return mappings;
}

function resolveCurrencyValue(rawValue, currencyMappings = []) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue) {
    return {
      value: '',
      issue: null
    };
  }

  if (/^[A-Za-z][A-Za-z\s-]*$/.test(normalizedValue)) {
    return {
      value: normalizedValue,
      issue: null
    };
  }

  const normalizedAlias = normalizeCurrencyAlias(normalizedValue);
  const exactMatches = currencyMappings.filter((mapping) => mapping.aliases.includes(normalizedAlias));
  const fuzzyMatches = exactMatches.length
    ? exactMatches
    : currencyMappings.filter((mapping) => {
        return mapping.aliases.some((alias) => alias.includes(normalizedAlias) || normalizedAlias.includes(alias));
      });
  const matchedCodes = Array.from(new Set(fuzzyMatches.map((mapping) => mapping.englishCode)));

  if (matchedCodes.length === 1) {
    return {
      value: matchedCodes[0],
      issue: null
    };
  }

  return {
    value: rawValue ?? '',
    issue: {
      type: 'currency-unmapped',
      rawValue: normalizedValue,
      matchedCodes
    }
  };
}

function sanitizeSignedAmountValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  const normalized = String(value).replace(/[^0-9.+-]/g, '');

  if (!normalized) {
    return '';
  }

  const signMatch = normalized.match(/^[+-]/);
  const sign = signMatch ? signMatch[0] : '';
  const unsignedValue = normalized.replace(/^[+-]/, '').replace(/[+-]/g, '');
  const firstDotIndex = unsignedValue.indexOf('.');
  const sanitizedNumber = firstDotIndex < 0
    ? unsignedValue
    : `${unsignedValue.slice(0, firstDotIndex + 1)}${unsignedValue.slice(firstDotIndex + 1).replace(/\./g, '')}`;

  if (!sanitizedNumber || sanitizedNumber === '.') {
    return '';
  }

  const normalizedNumber = sanitizedNumber.startsWith('.') ? `0${sanitizedNumber}` : sanitizedNumber;
  return `${sign}${normalizedNumber}`;
}

function splitSignedAmountValue(rawValue) {
  const sanitizedValue = sanitizeSignedAmountValue(rawValue);

  if (!sanitizedValue) {
    return {
      creditAmount: '',
      debitAmount: '',
      hasCreditAmount: false,
      hasDebitAmount: false
    };
  }

  const numericValue = parseNumericValue(sanitizedValue);

  if (numericValue === null || numericValue === 0) {
    return {
      creditAmount: '',
      debitAmount: '',
      hasCreditAmount: false,
      hasDebitAmount: false
    };
  }

  if (numericValue < 0) {
    const normalizedValue = String(Math.abs(numericValue));
    return {
      creditAmount: '',
      debitAmount: normalizedValue,
      hasCreditAmount: false,
      hasDebitAmount: true
    };
  }

  return {
    creditAmount: String(numericValue),
    debitAmount: '',
    hasCreditAmount: true,
    hasDebitAmount: false
  };
}

function buildDateObject(year, month, day) {
  const normalizedYear = Number(year);
  const normalizedMonth = Number(month);
  const normalizedDay = Number(day);

  if (!Number.isInteger(normalizedYear) || !Number.isInteger(normalizedMonth) || !Number.isInteger(normalizedDay)) {
    return null;
  }

  const date = new Date(normalizedYear, normalizedMonth - 1, normalizedDay);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== normalizedYear ||
    date.getMonth() !== normalizedMonth - 1 ||
    date.getDate() !== normalizedDay
  ) {
    return null;
  }

  return date;
}

function stripDateTimeSuffix(rawValue) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue) {
    return '';
  }

  const withoutIsoTime = normalizedValue.replace(/[Tt]\d{1,2}:\d{1,2}(:\d{1,2})?.*$/, '');
  return withoutIsoTime.split(/\s+/)[0] || withoutIsoTime;
}

function buildNormalizedDateResult(date, displayFormat = 'yyyy-mm-dd', value = '') {
  return {
    value,
    date,
    displayFormat
  };
}

function normalizeDateExportValue(value) {
  if (value === null || value === undefined || value === '') {
    return buildNormalizedDateResult(null, 'yyyy-mm-dd', '');
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    );
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);

    if (!parsed) {
      return buildNormalizedDateResult(null, 'yyyy-mm-dd', '');
    }

    const date = buildDateObject(parsed.y, parsed.m, parsed.d);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  const candidateValue = stripDateTimeSuffix(value);

  if (!candidateValue) {
    return buildNormalizedDateResult(null, 'yyyy-mm-dd', '');
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(candidateValue)) {
    const date = buildDateObject(
      candidateValue.slice(0, 4),
      candidateValue.slice(5, 7),
      candidateValue.slice(8, 10)
    );
    return buildNormalizedDateResult(date, 'yyyy-mm-dd', date ? candidateValue : '');
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(candidateValue)) {
    const date = buildDateObject(
      candidateValue.slice(0, 4),
      candidateValue.slice(5, 7),
      candidateValue.slice(8, 10)
    );
    return buildNormalizedDateResult(date, 'yyyy/mm/dd', date ? candidateValue : '');
  }

  if (/^\d{8}$/.test(candidateValue)) {
    const yearFirstDate = buildDateObject(
      candidateValue.slice(0, 4),
      candidateValue.slice(4, 6),
      candidateValue.slice(6, 8)
    );

    if (yearFirstDate) {
      return buildNormalizedDateResult(yearFirstDate, 'yyyymmdd', candidateValue);
    }

    const dayFirstDate = buildDateObject(
      candidateValue.slice(4, 8),
      candidateValue.slice(2, 4),
      candidateValue.slice(0, 2)
    );

    return buildNormalizedDateResult(
      dayFirstDate,
      'yyyy-mm-dd',
      dayFirstDate
        ? `${dayFirstDate.getFullYear()}-${String(dayFirstDate.getMonth() + 1).padStart(2, '0')}-${String(dayFirstDate.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  const normalizedValue = candidateValue
    .replaceAll('年', '-')
    .replaceAll('月', '-')
    .replaceAll('日', '')
    .replaceAll('/', '-')
    .replaceAll('.', '-');
  let matchedParts = normalizedValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (matchedParts) {
    const date = buildDateObject(matchedParts[1], matchedParts[2], matchedParts[3]);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  matchedParts = normalizedValue.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);

  if (matchedParts) {
    const date = buildDateObject(matchedParts[3], matchedParts[2], matchedParts[1]);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  matchedParts = normalizedValue.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);

  if (matchedParts) {
    const fullYear = `20${matchedParts[3]}`;
    const date = buildDateObject(fullYear, matchedParts[2], matchedParts[1]);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  if (/^\d{6}$/.test(normalizedValue)) {
    const fullYear = `20${normalizedValue.slice(0, 2)}`;
    const date = buildDateObject(fullYear, normalizedValue.slice(2, 4), normalizedValue.slice(4, 6));
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : ''
    );
  }

  const fallback = new Date(candidateValue);

  if (!Number.isNaN(fallback.getTime())) {
    const date = new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    );
  }

  return buildNormalizedDateResult(null, 'yyyy-mm-dd', '');
}

function parseDateValue(value) {
  return normalizeDateExportValue(value).date;
}

function toExcelSerial(date) {
  const utcValue = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const excelEpoch = Date.UTC(1899, 11, 30);
  return (utcValue - excelEpoch) / 86400000;
}

function inferDateCellFormat(value) {
  const normalizedValue = normalizeCell(value);

  if (/^\d{8}$/.test(normalizedValue)) {
    return 'yyyymmdd';
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(normalizedValue)) {
    return 'yyyy/mm/dd';
  }

  return 'yyyy-mm-dd';
}

function applyExportFieldFormats(worksheet, rows) {
  const headerRow = rows[0] || [];
  const fieldIndexMap = new Map();

  headerRow.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (!fieldIndexMap.has(normalizedHeader)) {
      fieldIndexMap.set(normalizedHeader, []);
    }

    fieldIndexMap.get(normalizedHeader).push(index);
  });

  const numericFields = ['Balance', 'Credit Amount', 'Debit Amount'];
  const dateFields = ['BillDate', 'ValueDate'];
  const textFields = ['MerchantId', 'Channel', 'Currency'];

  rows.slice(1).forEach((row, rowIndex) => {
    const sheetRowIndex = rowIndex + 1;

    numericFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const numericValue = parseNumericValue(row[columnIndex]);

        if (numericValue === null) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: numericValue,
          z: '0.00'
        };
      });
    });

    dateFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const dateValue = parseDateValue(row[columnIndex]);

        if (!dateValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: toExcelSerial(dateValue),
          z: inferDateCellFormat(row[columnIndex])
        };
      });
    });

    textFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const textValue = row[columnIndex];

        if (textValue === null || textValue === undefined || textValue === '') {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 's',
          v: String(textValue),
          z: '@'
        };
      });
    });
  });
}

function applyBalanceFieldFormats(worksheet, headerFields, rows) {
  const fieldIndexMap = new Map();

  headerFields.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (!fieldIndexMap.has(normalizedHeader)) {
      fieldIndexMap.set(normalizedHeader, []);
    }

    fieldIndexMap.get(normalizedHeader).push(index);
  });

  const numericFields = ['期初余额', '期初可用余额', '期末余额', '期末可用余额'];
  const dateFields = ['账单日期'];
  const textFields = ['银行名称', '所在地', '币种', '银行账号'];

  rows.forEach((row, rowIndex) => {
    const sheetRowIndex = rowIndex + 1;

    numericFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const numericValue = parseNumericValue(row[columnIndex]);

        if (numericValue === null) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: numericValue,
          z: '0.00'
        };
      });
    });

    dateFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const dateValue = parseDateValue(row[columnIndex]);

        if (!dateValue) {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 'n',
          v: toExcelSerial(dateValue),
          z: inferDateCellFormat(row[columnIndex])
        };
      });
    });

    textFields.forEach((fieldName) => {
      (fieldIndexMap.get(fieldName) || []).forEach((columnIndex) => {
        const textValue = row[columnIndex];

        if (textValue === null || textValue === undefined || textValue === '') {
          return;
        }

        const cellAddress = XLSX.utils.encode_cell({ c: columnIndex, r: sheetRowIndex });
        worksheet[cellAddress] = {
          t: 's',
          v: String(textValue),
          z: '@'
        };
      });
    });
  });
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

  function resolveRawValueByMapping(mappingValue, row) {
    const normalizedMappingValue = normalizeCell(mappingValue);

    if (!normalizedMappingValue) {
      return '';
    }

    if (normalizedMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
      return normalizedMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
    }

    const sourceIndex = sourceIndexByField.get(normalizedMappingValue);
    return sourceIndex === undefined ? '' : row[sourceIndex];
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
      const mappingValue = normalizeCell(mappingByField[targetField]);
      const isFixedValue = mappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX);

      if (isFixedValue) {
        return mappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
      }

      const sourceField = mappingValue;
      const sourceIndex = sourceIndexByField.get(sourceField);
      const rawValue = sourceIndex === undefined ? '' : row[sourceIndex];

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
        return normalizeDateExportValue(rawValue).value;
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

        const originalValue = normalizeCell(rawValue);

        if (!originalValue) {
          return '';
        }

        return Object.prototype.hasOwnProperty.call(accountMappingByBankId, originalValue)
          ? String(accountMappingByBankId[originalValue])
          : rawValue;
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
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  applyExportFieldFormats(worksheet, rows);

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  XLSX.writeFile(workbook, outputFilePath);

  return outputFilePath;
}

function writeBalanceWorkbook({
  templateFilePath,
  records,
  templateFields = [],
  outputFilePath
}) {
  const workbook = XLSX.readFile(templateFilePath, {
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new FileValidationError('FILE_READ', '余额账单模板不可读，请重新确认');
  }

  const worksheet = workbook.Sheets[sheetName];
  const fallbackRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    blankrows: false,
    defval: ''
  });
  const headerFields = templateFields.length
    ? templateFields
    : (fallbackRows[0] || []).map((value) => normalizeCell(value)).filter((value) => value !== '');

  if (!headerFields.length) {
    throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
  }

  const columnCount = headerFields.length;
  const existingRange = worksheet['!ref']
    ? XLSX.utils.decode_range(worksheet['!ref'])
    : {
        s: { c: 0, r: 0 },
        e: { c: columnCount - 1, r: 0 }
      };

  for (let rowIndex = 1; rowIndex <= existingRange.e.r; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < Math.max(existingRange.e.c + 1, columnCount); columnIndex += 1) {
      delete worksheet[XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex })];
    }
  }

  const normalizedRecords = records.map((row) => {
    const normalizedRow = Array.isArray(row) ? row.slice(0, columnCount) : [];

    while (normalizedRow.length < columnCount) {
      normalizedRow.push('');
    }

    return normalizedRow;
  });

  XLSX.utils.sheet_add_aoa(worksheet, normalizedRecords, { origin: 'A2' });
  applyBalanceFieldFormats(worksheet, headerFields, normalizedRecords);
  worksheet['!ref'] = `A1:${XLSX.utils.encode_col(columnCount - 1)}${Math.max(normalizedRecords.length + 1, 2)}`;

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  XLSX.writeFile(workbook, outputFilePath);
  return outputFilePath;
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
