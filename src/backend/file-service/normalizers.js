const XLSX = require('xlsx');
const { FileValidationError, normalizeCell } = require('./common');

const ENGLISH_MONTH_INDEX = new Map([
  ['jan', 1],
  ['feb', 2],
  ['mar', 3],
  ['apr', 4],
  ['may', 5],
  ['jun', 6],
  ['jul', 7],
  ['aug', 8],
  ['sep', 9],
  ['oct', 10],
  ['nov', 11],
  ['dec', 12]
]);

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

function loadCurrencyMappings(filePath, { readRows }) {
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
      englishCode,
      simpleChinese,
      traditionalChinese,
      displayName: simpleChinese || traditionalChinese || ''
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

function formatIsoDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function resolveEnglishMonthIndex(value) {
  const normalizedValue = normalizeCell(value)
    .toLowerCase()
    .replace(/\./g, '');

  if (!normalizedValue) {
    return null;
  }

  return ENGLISH_MONTH_INDEX.get(normalizedValue.slice(0, 3)) || null;
}

function parseEnglishMonthDateCandidate(value) {
  const normalizedValue = normalizeCell(value)
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/[A-Za-z]{3,}/.test(normalizedValue)) {
    return null;
  }

  const patterns = [
    {
      regex: /^(\d{4})[\s-]+(\d{1,2})-([A-Za-z]{3,})$/,
      resolve: (parts) => ({ year: parts[1], day: parts[2], monthName: parts[3] })
    },
    {
      regex: /^(\d{1,2})-([A-Za-z]{3,})[\s-]+(\d{4})$/,
      resolve: (parts) => ({ year: parts[3], day: parts[1], monthName: parts[2] })
    },
    {
      regex: /^(\d{4})[\s-]+([A-Za-z]{3,})-(\d{1,2})$/,
      resolve: (parts) => ({ year: parts[1], day: parts[3], monthName: parts[2] })
    },
    {
      regex: /^([A-Za-z]{3,})-(\d{1,2})[\s-]+(\d{4})$/,
      resolve: (parts) => ({ year: parts[3], day: parts[2], monthName: parts[1] })
    }
  ];

  for (const pattern of patterns) {
    const matchedParts = normalizedValue.match(pattern.regex);

    if (!matchedParts) {
      continue;
    }

    const { year, day, monthName } = pattern.resolve(matchedParts);
    const monthIndex = resolveEnglishMonthIndex(monthName);

    if (!monthIndex) {
      continue;
    }

    const date = buildDateObject(year, monthIndex, day);

    if (date) {
      return buildNormalizedDateResult(date, 'yyyy-mm-dd', formatIsoDateValue(date));
    }
  }

  return null;
}

function stripDateTimeSuffix(rawValue) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue) {
    return '';
  }

  const withoutIsoTime = normalizedValue.replace(/[Tt]\d{1,2}:\d{1,2}(:\d{1,2})?.*$/, '');
  const withoutDashHourMinute = withoutIsoTime.replace(
    /^(\d{4}-\d{1,2}-\d{1,2})-\d{1,2}:\d{1,2}$/,
    '$1'
  );
  const withoutTrailingTime = withoutDashHourMinute.replace(/\s+\d{1,2}:\d{1,2}(:\d{1,2})?.*$/, '');
  return withoutTrailingTime || withoutDashHourMinute;
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
      date ? formatIsoDateValue(date) : ''
    );
  }

  const candidateValue = stripDateTimeSuffix(value);

  if (!candidateValue) {
    return buildNormalizedDateResult(null, 'yyyy-mm-dd', '');
  }

  const englishMonthDateResult = parseEnglishMonthDateCandidate(candidateValue);

  if (englishMonthDateResult) {
    return englishMonthDateResult;
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
      dayFirstDate ? formatIsoDateValue(dayFirstDate) : ''
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
      date ? formatIsoDateValue(date) : ''
    );
  }

  matchedParts = normalizedValue.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);

  if (matchedParts) {
    const date = buildDateObject(matchedParts[3], matchedParts[2], matchedParts[1]);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date ? formatIsoDateValue(date) : ''
    );
  }

  matchedParts = normalizedValue.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);

  if (matchedParts) {
    const fullYear = `20${matchedParts[3]}`;
    const date = buildDateObject(fullYear, matchedParts[2], matchedParts[1]);
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date ? formatIsoDateValue(date) : ''
    );
  }

  if (/^\d{6}$/.test(normalizedValue)) {
    const fullYear = `20${normalizedValue.slice(0, 2)}`;
    const date = buildDateObject(fullYear, normalizedValue.slice(2, 4), normalizedValue.slice(4, 6));
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      date ? formatIsoDateValue(date) : ''
    );
  }

  const isFallbackCandidate =
    /[年月日]/.test(candidateValue) ||
    /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(candidateValue);

  const fallback = isFallbackCandidate ? new Date(candidateValue) : new Date('invalid');

  if (!Number.isNaN(fallback.getTime())) {
    const date = new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
    return buildNormalizedDateResult(
      date,
      'yyyy-mm-dd',
      formatIsoDateValue(date)
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

module.exports = {
  buildNormalizedDateResult,
  calculateEndingBalanceFromAmounts,
  extractCurrencyAliases,
  hasEffectiveAmount,
  inferDateCellFormat,
  inferEndingBalance,
  loadCurrencyMappings,
  normalizeCurrencyAlias,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  resolveCurrencyValue,
  roundAmount,
  sanitizeAmountValue,
  sanitizeSignedAmountValue,
  splitSignedAmountValue,
  stripDateTimeSuffix,
  toExcelSerial
};
