'use strict';

// 工具箱格式保真的十进制/日期纯函数。
//
// 这里刻意不使用 JS Date 承载 Excel 日期，也不在完成精度分类前把数字词法交给 Number。
// 所有函数均为纯 Node、无 Electron/ExcelJS 依赖，可安全在 worker_threads 内复用。

// 精度降级会把 canonical decimal 作为文本写回单元格；Excel/XLSX 单元格文本最多
// 保留 32,767 个字符。超过该长度既无法满足输出保真契约，也不能继续展开为大字符串。
const TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS = 32767;
const TOOLBOX_MAX_GENERATED_NUMFMT_CHARS = 240;
const DECIMAL_PARSE_INVALID = Object.freeze({ status: 'invalid' });

class ToolboxDecimalCanonicalLimitError extends RangeError {
  constructor(details = {}) {
    super(
      `十进制 canonical 文本超过 Excel 单元格 ${TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS} 字符上限`
    );
    this.name = 'ToolboxDecimalCanonicalLimitError';
    this.code = 'TOOLBOX_DECIMAL_CANONICAL_TOO_LONG';
    this.maxCanonicalChars = TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS;
    this.estimatedCanonicalLength = Number.isSafeInteger(details.estimatedCanonicalLength)
      ? details.estimatedCanonicalLength
      : null;
    this.inputLength = Number.isSafeInteger(details.inputLength) ? details.inputLength : null;
  }
}

// Excel/OOXML built-in number formats。
//
// 27..36 / 50..58 是 locale-dependent built-in。应用面向中文财务场景，统一展开为
// ExcelJS 同版本的 zh-CN 显示格式，避免把日期/时间静默降为 General 后输出裸序列号。
// 未列出的 id 由调用层 fail-closed；绝不能默认为 General。
const BUILTIN_NUMBER_FORMATS = Object.freeze({
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '$#,##0_);($#,##0)',
  6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)',
  8: '$#,##0.00_);[Red]($#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  27: 'yyyy"年"m"月"',
  28: 'm"月"d"日"',
  29: 'm"月"d"日"',
  30: 'm-d-yy',
  31: 'yyyy"年"m"月"d"日"',
  32: 'h"时"mm"分"',
  33: 'h"时"mm"分"ss"秒"',
  34: '上午/下午 h"时"mm"分"',
  35: '上午/下午 h"时"mm"分"ss"秒"',
  36: 'yyyy"年"m"月"',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
  50: 'yyyy"年"m"月"',
  51: 'm"月"d"日"',
  52: 'yyyy"年"m"月"',
  53: 'm"月"d"日"',
  54: 'm"月"d"日"',
  55: '上午/下午 h"时"mm"分"',
  56: '上午/下午 h"时"mm"分"ss"秒"',
  57: 'yyyy"年"m"月"',
  58: 'm"月"d"日"',
  59: 't0',
  60: 't0.00',
  61: 't#,##0',
  62: 't#,##0.00',
  67: 't0%',
  68: 't0.00%',
  69: 't# ?/?',
  70: 't# ??/??',
  81: 'd/m/bb'
});

const BUILTIN_FORMAT_CODES = new Set(Object.values(BUILTIN_NUMBER_FORMATS));

function getBuiltinNumberFormat(numFmtId) {
  const id = Number.parseInt(numFmtId, 10);
  return Object.prototype.hasOwnProperty.call(BUILTIN_NUMBER_FORMATS, id)
    ? BUILTIN_NUMBER_FORMATS[id]
    : null;
}

function isBuiltinNumberFormat(code) {
  return BUILTIN_FORMAT_CODES.has(String(code == null ? 'General' : code));
}

function decimalCanonicalLimit(inputLength, estimatedCanonicalLength = null) {
  return {
    status: 'canonical-limit',
    inputLength,
    estimatedCanonicalLength
  };
}

function parseBoundedExponent(rawExponent, maxMagnitude) {
  if (!rawExponent) return { value: 0, tooLarge: false };
  const lexical = String(rawExponent);
  const negative = lexical.startsWith('-');
  const digitsWithZeros = /^[+-]/.test(lexical) ? lexical.slice(1) : lexical;
  const digits = digitsWithZeros.replace(/^0+/, '') || '0';
  let magnitude = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(index) - 48;
    if (magnitude > Math.floor((maxMagnitude - digit) / 10)) {
      return { value: null, tooLarge: true };
    }
    magnitude = magnitude * 10 + digit;
  }
  return {
    value: negative && magnitude !== 0 ? -magnitude : magnitude,
    tooLarge: false
  };
}

function parseDecimalLexicalInternal(input) {
  const source = String(input == null ? '' : input);
  if (source.length > TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS) {
    return decimalCanonicalLimit(source.length);
  }
  const lexical = source.trim();
  const match = lexical.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return DECIMAL_PARSE_INVALID;

  const negative = match[1] === '-';
  const integerPart = match[2] === undefined ? '' : match[2];
  const fractionPart = match[2] === undefined ? match[4] : (match[3] || '');
  const coefficientRaw = (integerPart || '0') + fractionPart;
  const firstNonZero = coefficientRaw.search(/[1-9]/);
  const coefficientDigits = firstNonZero < 0 ? '0' : coefficientRaw.slice(firstNonZero);
  const exponentResult = parseBoundedExponent(
    match[5],
    TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS +
      fractionPart.length +
      coefficientDigits.length +
      2
  );
  if (exponentResult.tooLarge) {
    return decimalCanonicalLimit(source.length);
  }
  const exponent = exponentResult.value;
  const decimalPower = exponent - fractionPart.length;
  const decimalPosition = coefficientDigits.length + decimalPower;
  const unsignedCanonicalLength = decimalPosition <= 0
    ? 2 + (-decimalPosition) + coefficientDigits.length
    : (decimalPosition >= coefficientDigits.length
      ? decimalPosition
      : coefficientDigits.length + 1);
  const canonicalLength = (negative ? 1 : 0) + unsignedCanonicalLength;
  if (canonicalLength > TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS) {
    return decimalCanonicalLimit(source.length, canonicalLength);
  }

  let unsignedCanonical;
  if (decimalPosition <= 0) {
    unsignedCanonical = `0.${'0'.repeat(-decimalPosition)}${coefficientDigits}`;
  } else if (decimalPosition >= coefficientDigits.length) {
    unsignedCanonical = coefficientDigits + '0'.repeat(decimalPosition - coefficientDigits.length);
  } else {
    unsignedCanonical = `${coefficientDigits.slice(0, decimalPosition)}.${coefficientDigits.slice(decimalPosition)}`;
  }

  const canonical = `${negative ? '-' : ''}${unsignedCanonical}`;
  const dot = unsignedCanonical.indexOf('.');
  const scale = dot < 0 ? 0 : unsignedCanonical.length - dot - 1;
  const unsignedInteger = dot < 0 ? unsignedCanonical : unsignedCanonical.slice(0, dot);
  const nonZeroInteger = unsignedInteger.replace(/^0+/, '');
  const significantDigits = firstNonZero < 0 ? 1 : coefficientDigits.length;

  return {
    status: 'parsed',
    value: Object.freeze({
      lexical,
      canonical,
      negative,
      coefficientDigits,
      decimalPower,
      scale,
      significantDigits,
      integerDigits: nonZeroInteger.length,
      isZero: firstNonZero < 0
    })
  };
}

function parseDecimalLexical(input) {
  const result = parseDecimalLexicalInternal(input);
  return result.status === 'parsed' ? result.value : null;
}

function decimalComparable(input) {
  const parsed = typeof input === 'object' && input && input.canonical
    ? input
    : parseDecimalLexical(input);
  if (!parsed) return null;
  let value = parsed.canonical;
  const negative = value.startsWith('-');
  if (negative) value = value.slice(1);
  if (value.includes('.')) {
    value = value.replace(/0+$/, '').replace(/\.$/, '');
  }
  value = value.replace(/^0+(?=\d)/, '');
  if (value === '' || /^0(?:\.0*)?$/.test(value)) return '0';
  return `${negative ? '-' : ''}${value}`;
}

function formatScaledInteger(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return `${negative ? '-' : ''}${digits}`;
}

function addIntegerToDecimal(input, integerDelta) {
  const parsed = parseDecimalLexical(input);
  if (!parsed || !Number.isSafeInteger(integerDelta)) return null;
  const unsigned = parsed.canonical.startsWith('-') ? parsed.canonical.slice(1) : parsed.canonical;
  const digits = unsigned.replace('.', '');
  let coefficient = BigInt(digits || '0');
  if (parsed.negative) coefficient = -coefficient;
  const scaleFactor = 10n ** BigInt(parsed.scale);
  const result = coefficient + BigInt(integerDelta) * scaleFactor;
  return formatScaledInteger(result, parsed.scale);
}

function serial1904To1900(rawSerialDecimal) {
  return addIntegerToDecimal(rawSerialDecimal, 1462);
}

function stripFormatLiterals(formatCode) {
  const source = String(formatCode == null ? '' : formatCode);
  let visible = '';
  let elapsed = false;
  let scientific = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '\\' || ch === '_' || ch === '*') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = source.indexOf(']', i + 1);
      if (end < 0) break;
      const body = source.slice(i + 1, end).trim();
      if (/^[hms]+$/i.test(body)) {
        visible += `[${body.toLowerCase()}]`;
        elapsed = true;
      }
      i = end;
      continue;
    }
    visible += ch;
  }

  scientific = /(?:[0#?])e[+-]?(?:[0#?])/i.test(visible);
  return { visible: visible.toLowerCase(), elapsed, scientific };
}

function classifyMinuteMonthTokens(code) {
  let hasMinute = false;
  let hasMonth = false;
  const source = String(code || '').toLowerCase();
  for (const run of source.matchAll(/m+/g)) {
    const token = run[0];
    const start = run.index;
    const end = start + token.length;
    if (source[start - 1] === '[' && source[end] === ']') {
      hasMinute = true;
      continue;
    }
    if (token.length >= 3) {
      hasMonth = true;
      continue;
    }
    const before = source.slice(0, start).match(/([a-z]+)[^a-z]*$/);
    const after = source.slice(end).match(/^[^a-z]*([a-z]+)/);
    const immediatelyAfterHour = !!(before && /^h{1,2}$/.test(before[1]));
    const immediatelyBeforeSecond = !!(after && /^s{1,2}$/.test(after[1]));
    if (immediatelyAfterHour || immediatelyBeforeSecond) hasMinute = true;
    else hasMonth = true;
  }
  return { hasMinute, hasMonth };
}

function classifyExcelNumberFormat(formatCode) {
  const stripped = stripFormatLiterals(formatCode);
  const code = stripped.visible;
  const hasAmPm = /am\/pm|a\/p/.test(code);
  const hasYear = /y/.test(code);
  const hasDay = /d/.test(code);
  const hasHour = /h/.test(code) || /\[h+\]/.test(code);
  const hasSecond = /s/.test(code) || /\[s+\]/.test(code);
  const { hasMinute, hasMonth } = classifyMinuteMonthTokens(code);
  const datePart = hasYear || hasDay || hasMonth;
  // Excel 规则：m/mm 仅在紧随 h/hh 或紧邻 s/ss 时为“分钟”，否则为“月份”；
  // mmm/mmmm 始终是月份。
  const timePart = hasHour || hasSecond || hasAmPm || stripped.elapsed || hasMinute;

  let kind = 'number';
  if (datePart && timePart) kind = 'datetime';
  else if (datePart) kind = 'date';
  else if (timePart) kind = 'time';

  return Object.freeze({
    kind,
    isDateLike: kind !== 'number',
    isElapsedTime: stripped.elapsed,
    isScientific: stripped.scientific
  });
}

function isScientificNumberFormat(formatCode) {
  return classifyExcelNumberFormat(formatCode).isScientific;
}

function generatedPlainNumberFormat(parsed) {
  if (!parsed || parsed.scale <= 0) return '0';
  return `0.${'#'.repeat(parsed.scale)}`;
}

function classifyNumericOutput(rawLexicalValue, sourceNumFmt = 'General') {
  const parseResult = parseDecimalLexicalInternal(rawLexicalValue);
  if (parseResult.status === 'canonical-limit') {
    throw new ToolboxDecimalCanonicalLimitError(parseResult);
  }
  if (parseResult.status !== 'parsed') {
    return Object.freeze({
      outputType: 'text',
      outputValue: String(rawLexicalValue == null ? '' : rawLexicalValue),
      numFmt: '@',
      canonical: null,
      reason: 'invalid-decimal'
    });
  }
  const parsed = parseResult.value;

  const plainFormat = generatedPlainNumberFormat(parsed);
  const numeric = Number(parsed.canonical);
  const numericRoundTrip = Number.isFinite(numeric)
    ? parseDecimalLexical(String(numeric))
    : null;
  const roundTripEqual = numericRoundTrip !== null &&
    decimalComparable(numericRoundTrip) === decimalComparable(parsed);
  const safe = parsed.significantDigits <= 15 &&
    parsed.integerDigits <= 15 &&
    Number.isFinite(numeric) &&
    (!parsed.isZero ? numeric !== 0 : true) &&
    roundTripEqual &&
    plainFormat.length <= TOOLBOX_MAX_GENERATED_NUMFMT_CHARS;

  if (!safe) {
    return Object.freeze({
      outputType: 'text',
      outputValue: parsed.canonical,
      numFmt: '@',
      canonical: parsed.canonical,
      reason: parsed.significantDigits > 15
        ? 'precision'
        : parsed.integerDigits > 15
          ? 'integer-digits'
          : plainFormat.length > TOOLBOX_MAX_GENERATED_NUMFMT_CHARS
            ? 'format-length'
            : 'number-range-or-roundtrip'
    });
  }

  const normalizedSourceFormat = String(sourceNumFmt == null ? 'General' : sourceNumFmt);
  const sourceClass = classifyExcelNumberFormat(normalizedSourceFormat);
  const requiresOverride = normalizedSourceFormat.toLowerCase() === 'general' || sourceClass.isScientific;
  return Object.freeze({
    outputType: 'number',
    outputValue: numeric,
    numFmt: requiresOverride ? plainFormat : null,
    canonical: parsed.canonical,
    reason: null
  });
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] || 0;
}

function daysBeforeYear(year) {
  const y = year - 1;
  return 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

function daysBeforeMonth(year, month) {
  const cumulative = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cumulative[month] + (month > 2 && isLeapYear(year) ? 1 : 0);
}

function parseOoxmlWallClock(input) {
  const lexical = String(input == null ? '' : input).trim();
  const match = lexical.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,18}))?)?)?(?:Z|[+-]\d{2}:\d{2})?$/
  );
  if (!match) return null;

  const tuple = {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
    hour: Number.parseInt(match[4] || '0', 10),
    minute: Number.parseInt(match[5] || '0', 10),
    second: Number.parseInt(match[6] || '0', 10),
    fractionalSecond: match[7] || '',
    lexical
  };
  if (tuple.year < 1900 || tuple.year > 9999 ||
      tuple.month < 1 || tuple.month > 12 ||
      tuple.day < 1 || tuple.day > daysInMonth(tuple.year, tuple.month) ||
      tuple.hour < 0 || tuple.hour > 23 ||
      tuple.minute < 0 || tuple.minute > 59 ||
      tuple.second < 0 || tuple.second > 59) {
    return null;
  }
  return Object.freeze(tuple);
}

function fractionOfDayDecimal(tuple, precision = 15) {
  const fractionDigits = tuple.fractionalSecond || '';
  const fractionScale = 10n ** BigInt(fractionDigits.length);
  const wholeSeconds = BigInt(tuple.hour * 3600 + tuple.minute * 60 + tuple.second);
  const numerator = wholeSeconds * fractionScale + BigInt(fractionDigits || '0');
  const denominator = 86400n * fractionScale;
  if (numerator === 0n) return '';

  const targetScale = 10n ** BigInt(precision);
  let scaled = numerator * targetScale;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  if (quotient >= targetScale) return '.999999999999999';
  return `.${quotient.toString().padStart(precision, '0').replace(/0+$/, '')}`;
}

function gregorianTupleToExcelSerial(tupleOrLexical) {
  const tuple = typeof tupleOrLexical === 'string'
    ? parseOoxmlWallClock(tupleOrLexical)
    : tupleOrLexical;
  if (!tuple) return null;

  const ordinal = daysBeforeYear(tuple.year) + daysBeforeMonth(tuple.year, tuple.month) + tuple.day;
  const baseOrdinal = daysBeforeYear(1900) + daysBeforeMonth(1900, 1) + 1;
  let serial = ordinal - baseOrdinal + 1;
  if (tuple.year > 1900 || tuple.month > 2) serial += 1; // Excel 1900 兼容：保留虚构的 1900-02-29（serial 60）。
  const fraction = fractionOfDayDecimal(tuple);
  return `${serial}${fraction}`;
}

module.exports = {
  BUILTIN_NUMBER_FORMATS,
  TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS,
  TOOLBOX_MAX_GENERATED_NUMFMT_CHARS,
  ToolboxDecimalCanonicalLimitError,
  addIntegerToDecimal,
  classifyExcelNumberFormat,
  classifyMinuteMonthTokens,
  classifyNumericOutput,
  decimalComparable,
  generatedPlainNumberFormat,
  getBuiltinNumberFormat,
  gregorianTupleToExcelSerial,
  isBuiltinNumberFormat,
  isLeapYear,
  isScientificNumberFormat,
  parseDecimalLexical,
  parseOoxmlWallClock,
  serial1904To1900,
  stripFormatLiterals
};
