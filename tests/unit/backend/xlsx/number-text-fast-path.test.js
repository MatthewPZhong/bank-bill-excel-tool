'use strict';

// number-date / excel-text 的提速改写（手写十进制解析、去正则的规范比较、DBL_DIG 往返捷径、
// 格式分类缓存、无需转义时直接返回）必须与改写前的实现逐值一致。这里内嵌 v3.2.15 的原实现作对照。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const numberDate = require(path.join(ROOT, 'src/backend/xlsx/number-date'));
const excelText = require(path.join(ROOT, 'src/backend/xlsx/excel-text'));

const MAX_CANONICAL = numberDate.TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS;
const MAX_NUMFMT = numberDate.TOOLBOX_MAX_GENERATED_NUMFMT_CHARS;

// ---- v3.2.15 原实现（对照用） ----
function referenceExponent(rawExponent, maxMagnitude) {
  if (!rawExponent) return { value: 0, tooLarge: false };
  const lexical = String(rawExponent);
  const negative = lexical.startsWith('-');
  const digits = (/^[+-]/.test(lexical) ? lexical.slice(1) : lexical).replace(/^0+/, '') || '0';
  let magnitude = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(index) - 48;
    if (magnitude > Math.floor((maxMagnitude - digit) / 10)) return { value: null, tooLarge: true };
    magnitude = magnitude * 10 + digit;
  }
  return { value: negative && magnitude !== 0 ? -magnitude : magnitude, tooLarge: false };
}

function referenceParse(input) {
  const source = String(input == null ? '' : input);
  if (source.length > MAX_CANONICAL) return { status: 'canonical-limit' };
  const lexical = source.trim();
  const match = lexical.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return { status: 'invalid' };
  const negative = match[1] === '-';
  const integerPart = match[2] === undefined ? '' : match[2];
  const fractionPart = match[2] === undefined ? match[4] : (match[3] || '');
  const coefficientRaw = (integerPart || '0') + fractionPart;
  const firstNonZero = coefficientRaw.search(/[1-9]/);
  const coefficientDigits = firstNonZero < 0 ? '0' : coefficientRaw.slice(firstNonZero);
  const exponentResult = referenceExponent(match[5], MAX_CANONICAL + fractionPart.length + coefficientDigits.length + 2);
  if (exponentResult.tooLarge) return { status: 'canonical-limit' };
  const decimalPower = exponentResult.value - fractionPart.length;
  const decimalPosition = coefficientDigits.length + decimalPower;
  const unsignedLength = decimalPosition <= 0
    ? 2 + (-decimalPosition) + coefficientDigits.length
    : (decimalPosition >= coefficientDigits.length ? decimalPosition : coefficientDigits.length + 1);
  if ((negative ? 1 : 0) + unsignedLength > MAX_CANONICAL) return { status: 'canonical-limit' };
  let unsigned;
  if (decimalPosition <= 0) unsigned = `0.${'0'.repeat(-decimalPosition)}${coefficientDigits}`;
  else if (decimalPosition >= coefficientDigits.length) unsigned = coefficientDigits + '0'.repeat(decimalPosition - coefficientDigits.length);
  else unsigned = `${coefficientDigits.slice(0, decimalPosition)}.${coefficientDigits.slice(decimalPosition)}`;
  const dot = unsigned.indexOf('.');
  return {
    status: 'parsed',
    value: {
      lexical,
      canonical: `${negative ? '-' : ''}${unsigned}`,
      negative,
      coefficientDigits,
      decimalPower,
      scale: dot < 0 ? 0 : unsigned.length - dot - 1,
      significantDigits: firstNonZero < 0 ? 1 : coefficientDigits.length,
      integerDigits: (dot < 0 ? unsigned : unsigned.slice(0, dot)).replace(/^0+/, '').length,
      isZero: firstNonZero < 0
    }
  };
}

function referenceComparable(input) {
  const parsed = typeof input === 'object' && input && input.canonical ? input : (referenceParse(input).value || null);
  if (!parsed) return null;
  let value = parsed.canonical;
  const negative = value.startsWith('-');
  if (negative) value = value.slice(1);
  if (value.includes('.')) value = value.replace(/0+$/, '').replace(/\.$/, '');
  value = value.replace(/^0+(?=\d)/, '');
  if (value === '' || /^0(?:\.0*)?$/.test(value)) return '0';
  return `${negative ? '-' : ''}${value}`;
}

function referenceClassify(raw, sourceNumFmt = 'General') {
  const result = referenceParse(raw);
  if (result.status === 'canonical-limit') return 'THROW';
  if (result.status !== 'parsed') {
    return { outputType: 'text', outputValue: String(raw == null ? '' : raw), numFmt: '@', canonical: null, reason: 'invalid-decimal' };
  }
  const parsed = result.value;
  let plainFormat = '0';
  if (parsed.scale > 0) {
    const effectiveScale = parsed.canonical.slice(parsed.canonical.indexOf('.') + 1).replace(/0+$/, '').length;
    if (effectiveScale > 0) plainFormat = `0.${'#'.repeat(effectiveScale)}`;
  }
  const safetyLength = parsed.scale <= 0 ? 1 : parsed.scale + 2;
  const numeric = Number(parsed.canonical);
  const roundTrip = Number.isFinite(numeric) ? referenceParse(String(numeric)).value || null : null;
  const roundTripEqual = roundTrip !== null && referenceComparable(roundTrip) === referenceComparable(parsed);
  const safe = parsed.significantDigits <= 15 && parsed.integerDigits <= 15 && Number.isFinite(numeric) &&
    (!parsed.isZero ? numeric !== 0 : true) && roundTripEqual && safetyLength <= MAX_NUMFMT;
  if (!safe) {
    return {
      outputType: 'text',
      outputValue: parsed.canonical,
      numFmt: '@',
      canonical: parsed.canonical,
      reason: parsed.significantDigits > 15 ? 'precision'
        : parsed.integerDigits > 15 ? 'integer-digits'
          : safetyLength > MAX_NUMFMT ? 'format-length' : 'number-range-or-roundtrip'
    };
  }
  const format = String(sourceNumFmt == null ? 'General' : sourceNumFmt);
  const requiresOverride = format.toLowerCase() === 'general' || numberDate.classifyExcelNumberFormat(format).isScientific;
  return { outputType: 'number', outputValue: numeric, numFmt: requiresOverride ? plainFormat : null, canonical: parsed.canonical, reason: null };
}

function referenceDecode(value) {
  const decoded = String(value == null ? '' : value).replace(/_[xX]([0-9A-Fa-f]{4})_/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decoded;
}

// ---- 样本 ----
function createRandom(seed) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return { random, int: (n) => Math.floor(random() * n), pick: (items) => items[Math.floor(random() * items.length)] };
}

function sampleDecimal(r) {
  if (r.random() < 0.6) {
    let digits = String(1 + r.int(9));
    for (let i = 1, n = 1 + r.int(18); i < n; i += 1) digits += String(r.int(10));
    const point = r.int(digits.length + 24) - 22;
    let out;
    if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
    else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
    if (r.random() < 0.2) out += '0'.repeat(r.int(4));
    if (r.random() < 0.3) out = `${r.pick(['-', '+'])}${out}`;
    return out;
  }
  return r.pick([
    '', ' 1 ', '00012', '-0', '+0', '0.000', '.5', '5.', '1e3', '1E-7', '1e309', '-1e-400', '9'.repeat(40),
    '1.2.3', '--1', '١', 'abc', null, undefined, 12.5, String(Number.MAX_VALUE), '1e+21', '0.1e1', `${'1'.repeat(16)}`
  ]);
}

test('十进制解析、规范比较、数值输出分类与 v3.2.15 原实现逐值一致', () => {
  const r = createRandom(20261110);
  const formats = ['General', 'general', '0.00', '0.00E+00', 'yyyy-mm-dd', '@', null, ''];
  for (let iteration = 0; iteration < 20000; iteration += 1) {
    const value = sampleDecimal(r);
    const expected = referenceParse(value);
    const actual = numberDate.parseDecimalLexical(value);
    assert.deepEqual(actual, expected.status === 'parsed' ? expected.value : null, `parse ${JSON.stringify(value)}`);
    assert.equal(numberDate.decimalComparable(value), referenceComparable(value), `comparable ${JSON.stringify(value)}`);
    const format = r.pick(formats);
    const expectedClass = referenceClassify(value, format);
    if (expectedClass === 'THROW') {
      assert.throws(() => numberDate.classifyNumericOutput(value, format), numberDate.ToolboxDecimalCanonicalLimitError);
      assert.equal(numberDate.classifyNumericLexical(value, format), null);
    } else {
      assert.deepEqual({ ...numberDate.classifyNumericOutput(value, format) }, expectedClass, `classify ${JSON.stringify(value)}`);
      assert.deepEqual(numberDate.classifyNumericLexical(value, format) && { ...numberDate.classifyNumericLexical(value, format) },
        expected.status === 'parsed' ? expectedClass : null, `lexical ${JSON.stringify(value)}`);
    }
  }
});

test('数字格式分类缓存返回同一冻结结果，且与首次计算一致', () => {
  for (const format of ['General', 'yyyy-mm-dd hh:mm:ss', '[h]:mm', '0.00E+00', '"m"0', null, undefined, '']) {
    const first = numberDate.classifyExcelNumberFormat(format);
    assert.ok(Object.isFrozen(first));
    assert.equal(numberDate.classifyExcelNumberFormat(format), first);
  }
  assert.equal(numberDate.classifyExcelNumberFormat('yyyy').kind, 'date');
  assert.equal(numberDate.classifyExcelNumberFormat('mm:ss').kind, 'time');
});

test('ST_Xstring 解码 / 编码的直通快路径与逐字符结果一致', () => {
  const r = createRandom(7);
  const pieces = ['a', '中', '_', '_x000D_', '_X00ab_', '_x00', '\u0001', '\u000b', '\t', '\n', '\u007f', '😀', ' ', 'x'];
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const text = Array.from({ length: r.int(10) }, () => r.pick(pieces)).join('');
    assert.equal(excelText.decodeExcelStXstring(text), referenceDecode(text));
    const encoded = excelText.encodeExcelStXstring(text);
    assert.equal(excelText.decodeExcelStXstring(encoded), text);
    if (!/[_\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f]/.test(text)) assert.equal(encoded, text);
  }
  assert.throws(() => excelText.decodeExcelStXstring('_xD800_'), excelText.ToolboxExcelTextError);
  assert.throws(() => excelText.encodeExcelStXstring('a\uDC00'), excelText.ToolboxExcelTextError);
});
