'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS,
  TOOLBOX_MAX_GENERATED_NUMFMT_CHARS,
  addIntegerToDecimal,
  classifyExcelNumberFormat,
  classifyNumericOutput,
  decimalComparable,
  getBuiltinNumberFormat,
  gregorianTupleToExcelSerial,
  parseDecimalLexical,
  parseOoxmlWallClock,
  serial1904To1900
} = require('../../src/backend/toolbox-format/number-date');

test.describe('toolbox-format number-date', () => {
  test('locale-dependent built-in 日期/时间格式展开为明确中文格式，未知 id 不降级 General', () => {
    const format56 = getBuiltinNumberFormat(56);
    assert.match(format56, /h/);
    assert.equal(classifyExcelNumberFormat(format56).isDateLike, true);
    assert.equal(getBuiltinNumberFormat(23), null);
  });

  test('科学词法转 canonical plain decimal，保留符号和有效小数位', () => {
    assert.equal(parseDecimalLexical('+001.2300e2').canonical, '123.00');
    assert.equal(parseDecimalLexical('-1e-3').canonical, '-0.001');
    assert.equal(parseDecimalLexical('-0.00').canonical, '-0.00');
    assert.equal(parseDecimalLexical('.5').canonical, '0.5');
    assert.equal(parseDecimalLexical('1e20').canonical, '100000000000000000000');
    assert.equal(decimalComparable('001.2300'), '1.23');
    assert.equal(decimalComparable('-0.00'), '0');
    assert.equal(parseDecimalLexical('abc'), null);
  });

  test('仅 Excel 15 位安全数写 number，其余写 canonical text + @', () => {
    const safe = classifyNumericOutput('123456789012345', 'General');
    assert.equal(safe.outputType, 'number');
    assert.equal(safe.outputValue, 123456789012345);
    assert.equal(safe.numFmt, '0');

    const precision = classifyNumericOutput('1234567890123456', 'General');
    assert.equal(precision.outputType, 'text');
    assert.equal(precision.outputValue, '1234567890123456');
    assert.equal(precision.numFmt, '@');
    assert.equal(precision.reason, 'precision');

    const tiny = classifyNumericOutput('1e-300', 'General');
    assert.equal(tiny.outputType, 'text');
    assert.equal(tiny.reason, 'format-length');
    assert.ok(tiny.canonical.length > TOOLBOX_MAX_GENERATED_NUMFMT_CHARS);

    const scientificFormat = classifyNumericOutput('12.5', '0.00E+00');
    assert.equal(scientificFormat.outputType, 'number');
    assert.equal(scientificFormat.numFmt, '0.#');

    const semanticFormat = classifyNumericOutput('12', '000000');
    assert.equal(semanticFormat.outputType, 'number');
    assert.equal(semanticFormat.numFmt, null);
  });

  test('canonical plain decimal 受 Excel 单元格文本上限约束，极端指数快速 fail-closed', () => {
    assert.equal(TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS, 32767);

    const boundary = parseDecimalLexical('1e-32765');
    assert.equal(boundary.canonical.length, TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS);
    assert.equal(parseDecimalLexical('1e-32766'), null);
    assert.equal(
      parseDecimalLexical('1e32766').canonical.length,
      TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS
    );
    assert.equal(parseDecimalLexical('1e32767'), null);

    const startedAt = performance.now();
    for (const lexical of ['1e-1000000', '1e1000000']) {
      assert.throws(
        () => classifyNumericOutput(lexical, 'General'),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_DECIMAL_CANONICAL_TOO_LONG');
          assert.equal(error.maxCanonicalChars, TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS);
          return true;
        }
      );
    }
    assert.ok(
      performance.now() - startedAt < 1000,
      '短词法的极端指数应在 1 秒内快速拒绝，不能先展开百万字符'
    );

    for (const lexical of ['1e-300', '1e308']) {
      const classified = classifyNumericOutput(lexical, 'General');
      assert.equal(classified.outputType, 'text');
      assert.ok(classified.canonical.length < TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS);
    }
  });

  test('日期格式分类跳过引号、转义、颜色和条件，识别 elapsed time', () => {
    assert.equal(classifyExcelNumberFormat('mm-dd-yy').kind, 'date');
    for (const monthOnly of ['m', 'mm', 'mmm', 'mmmm']) {
      assert.equal(classifyExcelNumberFormat(monthOnly).kind, 'date', `${monthOnly} 是月份`);
    }
    assert.equal(classifyExcelNumberFormat('m/d/yy h:mm').kind, 'datetime');
    assert.equal(classifyExcelNumberFormat('h:mm').kind, 'time');
    assert.equal(classifyExcelNumberFormat('mm:ss').kind, 'time');
    assert.equal(classifyExcelNumberFormat('[h]:mm').kind, 'time');
    assert.equal(classifyExcelNumberFormat('[Red][>=100]0.00').kind, 'number');
    assert.equal(classifyExcelNumberFormat('"yyyy" 0').kind, 'number');
    assert.equal(classifyExcelNumberFormat('0.00E+00').isScientific, true);
  });

  test('1904 serial 用十进制定点加 1462，不经过浮点', () => {
    assert.equal(serial1904To1900('0'), '1462');
    assert.equal(serial1904To1900('45292.5000000000'), '46754.5000000000');
    assert.equal(addIntegerToDecimal('-0.5', 1462), '1461.5');
  });

  test('OOXML t=d 按 wall-clock 转 1900 serial，忽略 Z/offset 且不使用本地时区', () => {
    assert.equal(gregorianTupleToExcelSerial('1900-01-01T00:00:00Z'), '1');
    assert.equal(gregorianTupleToExcelSerial('1900-02-28T00:00:00-05:00'), '59');
    assert.equal(gregorianTupleToExcelSerial('1900-03-01T12:00:00+08:00'), '61.5');
    assert.equal(
      gregorianTupleToExcelSerial('2026-07-29T08:30:00Z'),
      gregorianTupleToExcelSerial('2026-07-29T08:30:00-04:00')
    );
    assert.equal(parseOoxmlWallClock('1900-02-29T00:00:00'), null);
    assert.equal(parseOoxmlWallClock('1899-12-31'), null);
    assert.equal(parseOoxmlWallClock('10000-01-01'), null);
  });
});
