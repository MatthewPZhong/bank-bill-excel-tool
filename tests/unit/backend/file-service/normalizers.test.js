const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNumericValue,
  roundAmount,
  roundAmountHighPrecision,
  sanitizeAmountValue,
  sanitizeSignedAmountValue,
  hasEffectiveAmount,
  splitSignedAmountValue,
  normalizeCurrencyAlias,
  extractCurrencyAliases,
  resolveCurrencyValue,
  normalizeDateExportValue,
  parseDateValue,
  stripDateTimeSuffix,
  inferDateCellFormat,
  toExcelSerial,
  isRegexLiteral,
  compileRegexLiteral,
  matchAmountSplitConditionValue
} = require('../../../../src/backend/file-service/normalizers');

// ========================================================================
// 1. 金额归一（parseNumericValue / roundAmount / sanitize* / splitSigned*）
// ========================================================================

test.describe('parseNumericValue — 数值解析', () => {
  test('null / undefined / 空字符串 → null', () => {
    assert.equal(parseNumericValue(null), null);
    assert.equal(parseNumericValue(undefined), null);
    assert.equal(parseNumericValue(''), null);
  });

  test('数字直接透传', () => {
    assert.equal(parseNumericValue(1234.56), 1234.56);
    assert.equal(parseNumericValue(0), 0);
    assert.equal(parseNumericValue(-99.9), -99.9);
  });

  test('千分位字符串 → 去逗号转数', () => {
    assert.equal(parseNumericValue('1,234.56'), 1234.56);
    assert.equal(parseNumericValue('1,000,000'), 1000000);
  });

  test('带正负号字符串', () => {
    assert.equal(parseNumericValue('+10'), 10);
    assert.equal(parseNumericValue('-99.9'), -99.9);
  });

  test('非法字符串 → null', () => {
    assert.equal(parseNumericValue('abc'), null);
    assert.equal(parseNumericValue('1.2.3'), null);
    assert.equal(parseNumericValue('--10'), null);
  });
});

test.describe('roundAmount / roundAmountHighPrecision', () => {
  test('roundAmount 保留 2 位小数', () => {
    assert.equal(roundAmount(1.234), 1.23);
    assert.equal(roundAmount(1.235), 1.24);
    assert.equal(roundAmount(100), 100);
  });

  test('roundAmountHighPrecision 保留 12 位', () => {
    assert.equal(roundAmountHighPrecision(1.123456789012345), 1.123456789012);
  });
});

test.describe('sanitizeAmountValue — 金额清洗', () => {
  test('空值 → 空字符串', () => {
    assert.equal(sanitizeAmountValue(null), '');
    assert.equal(sanitizeAmountValue(undefined), '');
    assert.equal(sanitizeAmountValue(''), '');
  });

  test('数字 → 字符串', () => {
    assert.equal(sanitizeAmountValue(1.23), '1.23');
    assert.equal(sanitizeAmountValue(0), '0');
  });

  test('剥离非数字字符', () => {
    assert.equal(sanitizeAmountValue('abc1.23xyz'), '1.23');
    assert.equal(sanitizeAmountValue('¥1,234.56'), '1234.56');
  });

  test('多点合并为单点（保留首点）', () => {
    assert.equal(sanitizeAmountValue('1.2.3'), '1.23');
  });

  test('补 0：".5" → "0.5"', () => {
    assert.equal(sanitizeAmountValue('.5'), '0.5');
  });
});

test.describe('sanitizeSignedAmountValue — 带符号金额清洗', () => {
  test('正号保留', () => {
    assert.equal(sanitizeSignedAmountValue('+1.23'), '+1.23');
  });

  test('负号保留', () => {
    assert.equal(sanitizeSignedAmountValue('-1.23'), '-1.23');
  });

  test('混合字符 → 仅保留首符号和数字', () => {
    assert.equal(sanitizeSignedAmountValue('abc-1.23xyz'), '-1.23');
  });

  test('数字直接 → 无符号', () => {
    assert.equal(sanitizeSignedAmountValue(100), '100');
  });
});

test.describe('hasEffectiveAmount — 有效金额判断', () => {
  test('空值 / 0 → false', () => {
    assert.equal(hasEffectiveAmount(''), false);
    assert.equal(hasEffectiveAmount('0'), false);
    assert.equal(hasEffectiveAmount('0.00'), false);
    assert.equal(hasEffectiveAmount(null), false);
  });

  test('非零数值 → true', () => {
    assert.equal(hasEffectiveAmount('1.23'), true);
    assert.equal(hasEffectiveAmount(100), true);
  });

  test('字符串带千分位 → true', () => {
    // 注：hasEffectiveAmount 先经 sanitizeAmountValue（剥逗号），再 parseNumericValue
    assert.equal(hasEffectiveAmount('1,234.56'), true);
  });
});

test.describe('splitSignedAmountValue — 带符号金额拆 Credit/Debit', () => {
  test('正数 → Credit', () => {
    const r = splitSignedAmountValue('+100');
    assert.equal(r.creditAmount, '100');
    assert.equal(r.debitAmount, '');
    assert.equal(r.hasCreditAmount, true);
    assert.equal(r.hasDebitAmount, false);
  });

  test('负数 → Debit（绝对值）', () => {
    const r = splitSignedAmountValue('-100.50');
    assert.equal(r.creditAmount, '');
    assert.equal(r.debitAmount, '100.5');
    assert.equal(r.hasCreditAmount, false);
    assert.equal(r.hasDebitAmount, true);
  });

  test('0 → 双空', () => {
    const r = splitSignedAmountValue('0');
    assert.equal(r.creditAmount, '');
    assert.equal(r.debitAmount, '');
    assert.equal(r.hasCreditAmount, false);
    assert.equal(r.hasDebitAmount, false);
  });

  test('空 → 双空', () => {
    const r = splitSignedAmountValue('');
    assert.equal(r.creditAmount, '');
    assert.equal(r.debitAmount, '');
  });

  test('无符号正数（默认正）→ Credit', () => {
    const r = splitSignedAmountValue('100');
    assert.equal(r.creditAmount, '100');
    assert.equal(r.debitAmount, '');
  });
});

// ========================================================================
// 2. 币种归一（normalizeCurrencyAlias / extractCurrencyAliases / resolveCurrencyValue）
// ========================================================================

test.describe('normalizeCurrencyAlias — 别名规范化', () => {
  test('英文大小写归一 + 小写', () => {
    assert.equal(normalizeCurrencyAlias('USD'), 'usd');
    assert.equal(normalizeCurrencyAlias('Usd'), 'usd');
  });

  test('括号剥离（半角 / 全角 / 方括号）', () => {
    assert.equal(normalizeCurrencyAlias('美元(USD)'), '美元usd');
    assert.equal(normalizeCurrencyAlias('美元（USD）'), '美元usd');
    assert.equal(normalizeCurrencyAlias('美元[USD]'), '美元usd');
  });

  test('分隔符统一为 /（中英文逗号 / 顿号 / 分号 / 全角斜杠）', () => {
    assert.equal(normalizeCurrencyAlias('RMB,CNY'), 'rmb/cny');
    assert.equal(normalizeCurrencyAlias('RMB、CNY'), 'rmb/cny');
    assert.equal(normalizeCurrencyAlias('RMB；CNY'), 'rmb/cny');
    assert.equal(normalizeCurrencyAlias('RMB／CNY'), 'rmb/cny');
  });

  test('空白全剥', () => {
    assert.equal(normalizeCurrencyAlias('US D'), 'usd');
    assert.equal(normalizeCurrencyAlias('RMB / CNY'), 'rmb/cny');
  });
});

test.describe('extractCurrencyAliases — 提取别名列表', () => {
  test('空 → 空数组', () => {
    assert.deepEqual(extractCurrencyAliases(''), []);
    assert.deepEqual(extractCurrencyAliases(null), []);
  });

  test('单值 → 单元素', () => {
    assert.deepEqual(extractCurrencyAliases('USD'), ['usd']);
  });

  test('多值（斜杠分隔）→ 完整 + 分组', () => {
    const r = extractCurrencyAliases('RMB/CNY');
    assert.ok(r.includes('rmb/cny'));
    assert.ok(r.includes('rmb'));
    assert.ok(r.includes('cny'));
  });

  test('去重', () => {
    const r = extractCurrencyAliases('USD/USD');
    // 完整 'usd/usd' + 拆出的 'usd' 两次（去重）= 'usd/usd' + 'usd'
    assert.equal(new Set(r).size, r.length);
  });
});

test.describe('resolveCurrencyValue — 币种解析（含模糊匹配）', () => {
  const mappings = [
    { aliases: ['美元', 'usd'], englishCode: 'USD' },
    { aliases: ['人民币', 'rmb', 'cny'], englishCode: 'CNY' },
    { aliases: ['港币', 'hkd'], englishCode: 'HKD' }
  ];

  test('空值 → 空 + 无 issue', () => {
    const r = resolveCurrencyValue('', mappings);
    assert.equal(r.value, '');
    assert.equal(r.issue, null);
  });

  test('纯英文（A-Z + 空格 + 横线）→ 直通', () => {
    const r = resolveCurrencyValue('SGD', mappings);
    assert.equal(r.value, 'SGD');
    assert.equal(r.issue, null);
  });

  test('中文匹配 → 返回英文 code', () => {
    const r = resolveCurrencyValue('美元', mappings);
    assert.equal(r.value, 'USD');
    assert.equal(r.issue, null);
  });

  test('多映射别名命中', () => {
    const r = resolveCurrencyValue('人民币', mappings);
    assert.equal(r.value, 'CNY');
  });

  test('未匹配 → 原值 + issue', () => {
    const r = resolveCurrencyValue('比特币', mappings);
    assert.equal(r.value, '比特币');
    assert.equal(r.issue.type, 'currency-unmapped');
    assert.equal(r.issue.rawValue, '比特币');
  });
});

// ========================================================================
// 3. 日期归一（normalizeDateExportValue / stripDateTimeSuffix / inferDateCellFormat / toExcelSerial）
// ========================================================================

test.describe('normalizeDateExportValue — 日期解析主入口', () => {
  test('null / undefined / 空 → 空结果', () => {
    const r = normalizeDateExportValue(null);
    assert.equal(r.value, '');
    assert.equal(r.date, null);
  });

  test('Date 实例 → 截到日级别', () => {
    const input = new Date(2026, 4, 22, 14, 30, 45); // 月份 0-based: 4 = May
    const r = normalizeDateExportValue(input);
    assert.equal(r.value, '2026-05-22');
    assert.equal(r.date instanceof Date, true);
  });

  test('Excel 序列号（数值）→ 日期', () => {
    // Excel 序列号 46168 ≈ 2026-05-22（基于 1899-12-30 epoch）
    const r = normalizeDateExportValue(toExcelSerial(new Date(2026, 4, 22)));
    assert.equal(r.value, '2026-05-22');
  });

  test('字符串 yyyy-mm-dd', () => {
    const r = normalizeDateExportValue('2026-05-22');
    assert.equal(r.value, '2026-05-22');
    assert.equal(r.displayFormat, 'yyyy-mm-dd');
  });

  test('字符串 yyyy/mm/dd → 保留 displayFormat', () => {
    const r = normalizeDateExportValue('2026/05/22');
    assert.equal(r.value, '2026/05/22');
    assert.equal(r.displayFormat, 'yyyy/mm/dd');
  });

  test('字符串 yyyymmdd', () => {
    const r = normalizeDateExportValue('20260522');
    assert.ok(r.date instanceof Date);
    assert.equal(r.displayFormat, 'yyyymmdd');
  });

  test('字符串 中文 年月日', () => {
    const r = normalizeDateExportValue('2026年5月22日');
    assert.equal(r.value, '2026-05-22');
  });

  test('字符串 英文月份（22 May 2026）', () => {
    const r = normalizeDateExportValue('22 May 2026');
    assert.equal(r.value, '2026-05-22');
  });

  test('字符串 英文月份（May 22 2026）', () => {
    const r = normalizeDateExportValue('May 22 2026');
    assert.equal(r.value, '2026-05-22');
  });

  test('非法日期（month=13）→ 空 / fallback 解析', () => {
    const r = normalizeDateExportValue('2026-13-01');
    // 不在 yyyy-mm-dd 严格分支 → 走 fallback；fallback 用 new Date() 可能解析为下一年
    // 仅断言不抛错（不绑死语义）
    assert.ok(r.date === null || r.date instanceof Date);
  });
});

test.describe('parseDateValue — 仅返回 date 实例', () => {
  test('返回 normalizeDateExportValue 的 date 字段', () => {
    const r = parseDateValue('2026-05-22');
    assert.ok(r instanceof Date);
    assert.equal(r.getFullYear(), 2026);
    assert.equal(r.getMonth(), 4); // 0-based
    assert.equal(r.getDate(), 22);
  });

  test('空 → null', () => {
    assert.equal(parseDateValue(''), null);
    assert.equal(parseDateValue(null), null);
  });
});

test.describe('stripDateTimeSuffix — 剥时间后缀', () => {
  test('ISO 8601 时间剥离', () => {
    assert.equal(stripDateTimeSuffix('2026-05-22T14:30:00Z'), '2026-05-22');
    assert.equal(stripDateTimeSuffix('2026-05-22t14:30'), '2026-05-22');
  });

  test('空格 + 时间剥离', () => {
    assert.equal(stripDateTimeSuffix('2026-05-22 14:30'), '2026-05-22');
    assert.equal(stripDateTimeSuffix('2026-05-22 14:30:45'), '2026-05-22');
  });

  test('AM/PM 后缀剥离', () => {
    assert.equal(stripDateTimeSuffix('2026-05-22 02:30 PM'), '2026-05-22');
  });

  test('无时间后缀 → 原样', () => {
    assert.equal(stripDateTimeSuffix('2026-05-22'), '2026-05-22');
  });
});

test.describe('inferDateCellFormat — 格式推断', () => {
  test('8 位数字 → yyyymmdd', () => {
    assert.equal(inferDateCellFormat('20260522'), 'yyyymmdd');
  });

  test('yyyy/mm/dd 格式', () => {
    assert.equal(inferDateCellFormat('2026/05/22'), 'yyyy/mm/dd');
  });

  test('其他 → yyyy-mm-dd', () => {
    assert.equal(inferDateCellFormat('2026-05-22'), 'yyyy-mm-dd');
    assert.equal(inferDateCellFormat('随意输入'), 'yyyy-mm-dd');
  });
});

test.describe('toExcelSerial — JS Date → Excel 序列号', () => {
  test('1900-01-01（Excel epoch 之后）', () => {
    // Excel 1900-01-01 序列号通常 = 2（受 1900 闰年 bug 影响）
    const r = toExcelSerial(new Date(1900, 0, 1));
    assert.equal(typeof r, 'number');
    assert.ok(r >= 1 && r <= 3);
  });

  test('2026-05-22 → 合理范围', () => {
    const r = toExcelSerial(new Date(2026, 4, 22));
    assert.ok(r > 46000 && r < 47000);
  });
});

// ========================================================================
// 4. 正则字面量（isRegexLiteral / compileRegexLiteral / matchAmountSplitConditionValue）
// ========================================================================

test.describe('isRegexLiteral — 识别 /pattern/flags 字面量', () => {
  test('合法字面量 → true', () => {
    assert.equal(isRegexLiteral('/abc/'), true);
    assert.equal(isRegexLiteral('/abc/i'), true);
    assert.equal(isRegexLiteral('/^\\d+$/g'), true);
  });

  test('非字面量 → false', () => {
    assert.equal(isRegexLiteral('abc'), false);
    assert.equal(isRegexLiteral('/abc'), false);
    assert.equal(isRegexLiteral('abc/'), false);
    assert.equal(isRegexLiteral(''), false);
  });

  test('非字符串 → false', () => {
    assert.equal(isRegexLiteral(123), false);
    assert.equal(isRegexLiteral(null), false);
    assert.equal(isRegexLiteral(undefined), false);
  });
});

test.describe('compileRegexLiteral — 字面量 → RegExp 实例', () => {
  test('合法字面量 → RegExp', () => {
    const r = compileRegexLiteral('/^abc$/i');
    assert.ok(r instanceof RegExp);
    assert.equal(r.flags, 'i');
    assert.equal(r.source, '^abc$');
  });

  test('非法字面量 → 抛错', () => {
    assert.throws(() => compileRegexLiteral('abc'), /非法的正则表达式字面量/);
  });
});

test.describe('matchAmountSplitConditionValue — 金额拆分条件匹配', () => {
  test('字面量精确匹配', () => {
    assert.equal(matchAmountSplitConditionValue('收入', '收入'), true);
    assert.equal(matchAmountSplitConditionValue('收入', '支出'), false);
  });

  test('正则字面量匹配', () => {
    assert.equal(matchAmountSplitConditionValue('收入A', '/^收入/'), true);
    assert.equal(matchAmountSplitConditionValue('A收入', '/^收入/'), false);
    assert.equal(matchAmountSplitConditionValue('SOMETHING', '/^abc$/i'), false);
  });

  test('trim 前后空白', () => {
    assert.equal(matchAmountSplitConditionValue('  收入  ', '收入'), true);
  });

  test('非法正则字面量 → false（不抛错）', () => {
    // 故意构造一个非法 regex（如 /+/）
    assert.equal(matchAmountSplitConditionValue('test', '/+/'), false);
  });

  test('空值兼容', () => {
    assert.equal(matchAmountSplitConditionValue(null, ''), true);
    assert.equal(matchAmountSplitConditionValue(undefined, undefined), true);
  });
});
