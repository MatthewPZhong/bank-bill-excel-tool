const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsOoxmlEscape,
  createEscapeSameValueWarning,
  ensureRowId,
  evaluateCondition,
  isAmbiguousMappedAccount,
  isEmptyValue,
  isMappedAccountHit,
  isPrecisionAmbiguousBankAccount,
  makeModificationCollector,
  makeWarningCollector,
  mappedAccountAmbiguity,
  mayBeRoundedLongNumber,
  normalizeCellValue,
  numericReadAccountAmbiguous,
  numericReadCollisionIndexOf,
  precisionFingerprintsOf,
  precisionLostDigitsOf,
  resolveMappedAccount,
  parseNumber,
  valuesEqual
} = require('../../../../src/main-process/scenario-engines/engine-utils');

// ========================================================================
// normalizeCellValue / isEmptyValue
// ========================================================================

test.describe('normalizeCellValue', () => {
  test('null / undefined → 空串', () => {
    assert.equal(normalizeCellValue(null), '');
    assert.equal(normalizeCellValue(undefined), '');
  });

  test('字符串 trim', () => {
    assert.equal(normalizeCellValue('  abc  '), 'abc');
  });

  test('有限数字 → 字符串', () => {
    assert.equal(normalizeCellValue(0), '0');
    assert.equal(normalizeCellValue(123.45), '123.45');
    assert.equal(normalizeCellValue(-99), '-99');
  });

  test('NaN / Infinity → 空串', () => {
    assert.equal(normalizeCellValue(NaN), '');
    assert.equal(normalizeCellValue(Infinity), '');
    assert.equal(normalizeCellValue(-Infinity), '');
  });

  test('空字符串', () => {
    assert.equal(normalizeCellValue(''), '');
    assert.equal(normalizeCellValue('   '), '');
  });

  test('对象 → String() 调用 toString', () => {
    assert.equal(normalizeCellValue({}), '[object Object]');
  });
});

test.describe('isEmptyValue', () => {
  test('归一后空串 → true', () => {
    assert.equal(isEmptyValue(null), true);
    assert.equal(isEmptyValue(undefined), true);
    assert.equal(isEmptyValue(''), true);
    assert.equal(isEmptyValue('   '), true);
    assert.equal(isEmptyValue(NaN), true);
  });

  test('归一后非空 → false', () => {
    assert.equal(isEmptyValue('abc'), false);
    assert.equal(isEmptyValue(0), false); // 0 → '0' → 非空
    assert.equal(isEmptyValue(123), false);
  });
});

// ========================================================================
// parseNumber
// ========================================================================

test.describe('parseNumber', () => {
  test('null / undefined / 空 → null', () => {
    assert.equal(parseNumber(null), null);
    assert.equal(parseNumber(undefined), null);
    assert.equal(parseNumber(''), null);
  });

  test('数字直通', () => {
    assert.equal(parseNumber(100.5), 100.5);
    assert.equal(parseNumber(0), 0);
    assert.equal(parseNumber(-99), -99);
  });

  test('NaN / Infinity → null', () => {
    assert.equal(parseNumber(NaN), null);
    assert.equal(parseNumber(Infinity), null);
  });

  test('字符串数字 → 数字', () => {
    assert.equal(parseNumber('123.45'), 123.45);
    assert.equal(parseNumber('  -99  '), -99);
  });

  test('千分位字符串 → 数字', () => {
    assert.equal(parseNumber('1,234.56'), 1234.56);
    assert.equal(parseNumber('1,000,000'), 1000000);
  });

  test('非法字符串 → null', () => {
    assert.equal(parseNumber('abc'), null);
    assert.equal(parseNumber('1.2.3'), null);
  });

  test('仅空白字符串 → null', () => {
    assert.equal(parseNumber('   '), null);
  });
});

// ========================================================================
// evaluateCondition — 7 个操作符
// ========================================================================

test.describe('evaluateCondition', () => {
  test('condition 缺失 / 无 field → false', () => {
    assert.equal(evaluateCondition({ a: '1' }, null), false);
    assert.equal(evaluateCondition({ a: '1' }, {}), false);
    assert.equal(evaluateCondition({ a: '1' }, { op: '等于', value: '1' }), false);
  });

  test('"等于" 精确匹配', () => {
    assert.equal(evaluateCondition({ a: '收入' }, { field: 'a', op: '等于', value: '收入' }), true);
    assert.equal(evaluateCondition({ a: '收入' }, { field: 'a', op: '等于', value: '支出' }), false);
  });

  test('"不等于"', () => {
    assert.equal(evaluateCondition({ a: '收入' }, { field: 'a', op: '不等于', value: '支出' }), true);
    assert.equal(evaluateCondition({ a: '收入' }, { field: 'a', op: '不等于', value: '收入' }), false);
  });

  test('"包含"', () => {
    assert.equal(evaluateCondition({ a: '收入A' }, { field: 'a', op: '包含', value: '收入' }), true);
    assert.equal(evaluateCondition({ a: 'AAA' }, { field: 'a', op: '包含', value: '收入' }), false);
  });

  test('"包含" 期望空串 → false（保守）', () => {
    assert.equal(evaluateCondition({ a: 'abc' }, { field: 'a', op: '包含', value: '' }), false);
  });

  test('"不包含"', () => {
    assert.equal(evaluateCondition({ a: 'AAA' }, { field: 'a', op: '不包含', value: '收入' }), true);
    assert.equal(evaluateCondition({ a: '收入A' }, { field: 'a', op: '不包含', value: '收入' }), false);
  });

  test('"不包含" 期望空串 → true（任何串都不"包含"空）', () => {
    assert.equal(evaluateCondition({ a: 'abc' }, { field: 'a', op: '不包含', value: '' }), true);
  });

  test('"空值"', () => {
    assert.equal(evaluateCondition({ a: '' }, { field: 'a', op: '空值' }), true);
    assert.equal(evaluateCondition({ a: null }, { field: 'a', op: '空值' }), true);
    assert.equal(evaluateCondition({ a: 'X' }, { field: 'a', op: '空值' }), false);
  });

  test('"非空值"', () => {
    assert.equal(evaluateCondition({ a: 'X' }, { field: 'a', op: '非空值' }), true);
    assert.equal(evaluateCondition({ a: '' }, { field: 'a', op: '非空值' }), false);
  });

  test('"开头为"', () => {
    assert.equal(evaluateCondition({ a: '收入A' }, { field: 'a', op: '开头为', value: '收入' }), true);
    assert.equal(evaluateCondition({ a: 'A收入' }, { field: 'a', op: '开头为', value: '收入' }), false);
  });

  test('"开头为" 期望空串 → false', () => {
    assert.equal(evaluateCondition({ a: 'abc' }, { field: 'a', op: '开头为', value: '' }), false);
  });

  test('未知 op → false', () => {
    assert.equal(evaluateCondition({ a: 'abc' }, { field: 'a', op: '神秘', value: 'X' }), false);
  });

  test('condition.value null → 视为空串', () => {
    assert.equal(evaluateCondition({ a: '' }, { field: 'a', op: '等于', value: null }), true);
  });
});

// ========================================================================
// ensureRowId
// ========================================================================

test.describe('ensureRowId', () => {
  test('已有 _rowId → 返回原值', () => {
    const row = { _rowId: 'custom-id' };
    assert.equal(ensureRowId(row, 99), 'custom-id');
    assert.equal(row._rowId, 'custom-id');
  });

  test('无 _rowId → 生成 row_<idx>', () => {
    const row = {};
    assert.equal(ensureRowId(row, 5), 'row_5');
    assert.equal(row._rowId, 'row_5'); // 写回行内
  });

  test('_rowId = 0 视为有值（非 null/undefined）', () => {
    const row = { _rowId: 0 };
    assert.equal(ensureRowId(row, 99), 0);
  });

  test('_rowId = null → 重生成', () => {
    const row = { _rowId: null };
    assert.equal(ensureRowId(row, 5), 'row_5');
  });

  test('_rowId = undefined → 重生成', () => {
    const row = { _rowId: undefined };
    assert.equal(ensureRowId(row, 7), 'row_7');
  });
});

// ========================================================================
// valuesEqual — 数字 / 字符串两模式
// ========================================================================

test.describe('valuesEqual', () => {
  test('字符串模式：相同 → true', () => {
    assert.equal(valuesEqual('abc', 'abc'), true);
    assert.equal(valuesEqual('  abc  ', 'abc'), true); // trim
  });

  test('字符串模式：不同 → false', () => {
    assert.equal(valuesEqual('abc', 'abd'), false);
  });

  test('数字模式：数值相等 → true', () => {
    assert.equal(valuesEqual('100', 100, { numeric: true }), true);
    assert.equal(valuesEqual('1,000', 1000, { numeric: true }), true);
  });

  test('数字模式：数值不等 → false', () => {
    assert.equal(valuesEqual('100', 200, { numeric: true }), false);
  });

  test('数字模式：任一不可解析 → false', () => {
    assert.equal(valuesEqual('abc', 100, { numeric: true }), false);
    assert.equal(valuesEqual(null, 100, { numeric: true }), false);
  });

  test('数字模式：两侧都 null → false（防 "" === "" 误判）', () => {
    assert.equal(valuesEqual(null, null, { numeric: true }), false);
  });
});

// ========================================================================
// makeWarningCollector
// ========================================================================

test.describe('makeWarningCollector', () => {
  test('push 后 list 返回 warnings', () => {
    const collector = makeWarningCollector(42, 'S1');
    collector.push({ rowId: 'r1', code: 'X', message: 'msg' });
    const list = collector.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].scenarioId, 42);
    assert.equal(list[0].scenarioName, 'S1');
    assert.equal(list[0].rowId, 'r1');
  });

  test('空 collector → list 空数组', () => {
    const collector = makeWarningCollector(1, 'S1');
    assert.deepEqual(collector.list(), []);
  });

  test('多次 push 累计', () => {
    const collector = makeWarningCollector(1, 'S1');
    collector.push({ code: 'A' });
    collector.push({ code: 'B' });
    assert.equal(collector.list().length, 2);
  });
});

// ========================================================================
// makeModificationCollector
// ========================================================================

test.describe('makeModificationCollector', () => {
  test('record 记录修改 + 自动 lock', () => {
    const c = makeModificationCollector();
    c.record('r1', 'fieldA', 'old', 'new');
    assert.equal(c.listModifications().length, 1);
    assert.ok(c.listLockedRowIds().has('r1'));
  });

  test('lock 单独锁定（不记录修改）', () => {
    const c = makeModificationCollector();
    c.lock('r2');
    assert.equal(c.listModifications().length, 0);
    assert.ok(c.listLockedRowIds().has('r2'));
  });

  test('多次 record + lock', () => {
    const c = makeModificationCollector();
    c.record('r1', 'fA', 'o', 'n');
    c.lock('r2');
    c.record('r3', 'fB', 'o', 'n');
    assert.equal(c.listModifications().length, 2);
    assert.equal(c.listLockedRowIds().size, 3);
  });

  test('record 字段', () => {
    const c = makeModificationCollector();
    c.record('r1', 'col', 'old', 'new');
    const mods = c.listModifications();
    assert.deepEqual(mods[0], { rowId: 'r1', column: 'col', oldValue: 'old', newValue: 'new' });
  });
});

// v3.2.22（🔴 资金红线）：账户映射单一取值口径（调拨对账单派生 big_account 与 R5s2 网关 merchantid 共用）。
test.describe('resolveMappedAccount', () => {
  const map = new Map([['ACC-1', 'CLR-1'], ['123456', 'CLR-NUM'], ['ZERO', '0']]);

  test('命中 → 换成清结算系统银行账号；键按 normalizeCellValue 归一化（trim）', () => {
    assert.equal(resolveMappedAccount(map, 'ACC-1'), 'CLR-1');
    assert.equal(resolveMappedAccount(map, '  ACC-1 '), 'CLR-1');
  });

  test('数字账号按字符串口径命中（与 getMappingMap 写入键一致）', () => {
    assert.equal(resolveMappedAccount(map, 123456), 'CLR-NUM');
  });

  test('未命中 → 归一化后的原值', () => {
    assert.equal(resolveMappedAccount(map, ' OTHER '), 'OTHER');
  });

  test('空值 → 空串，不会命中任何映射', () => {
    assert.equal(resolveMappedAccount(map, ''), '');
    assert.equal(resolveMappedAccount(map, null), '');
    assert.equal(resolveMappedAccount(map, undefined), '');
  });

  test('映射值为假值但非空（"0"）也按命中替换（?? 只在键缺失时回退）', () => {
    assert.equal(resolveMappedAccount(map, 'ZERO'), '0');
  });

  test('非 Map（缺省 / 普通对象）→ 不映射，返回归一化原值', () => {
    assert.equal(resolveMappedAccount(undefined, ' ACC-1 '), 'ACC-1');
    assert.equal(resolveMappedAccount(null, 'ACC-1'), 'ACC-1');
    assert.equal(resolveMappedAccount({ 'ACC-1': 'CLR-1' }, 'ACC-1'), 'ACC-1');
  });
});

// v3.2.22（🔴 资金红线）：转义护栏。单工作表 .xlsx 流式导入不解 `_xHHHH_`，富文本各片段直接拼接（片段边界丢失），
//   落库字符串里的转义写法可能是控制字符、字面量或跨片段拼出来的，真实账户号无法确定；映射非空时一律 fail-closed 换成空串。
test.describe('resolveMappedAccount 转义护栏', () => {
  test('原样与解码后都命中但映射到不同账号 → 空串', () => {
    const map = new Map([['A_x0000_B', 'CLR-LIT'], ['A\u0000B', 'CLR-NUL']]);
    assert.equal(isAmbiguousMappedAccount(map, 'A_x0000_B'), true);
    assert.equal(resolveMappedAccount(map, 'A_x0000_B'), '');
    assert.equal(resolveMappedAccount(map, 'A\u0000B'), 'CLR-NUL', '已是控制字符的账号没有转义写法，照常映射');
  });

  test('只有解码后命中 / 只有原样命中 / 都不命中 → 都是空串', () => {
    assert.equal(resolveMappedAccount(new Map([['A\u0000B', 'CLR-NUL']]), 'A_x0000_B'), '');
    assert.equal(resolveMappedAccount(new Map([['A\u0000B', 'CLR-NUL']]), 'A_X0000_B'), '', '十六进制前缀大小写与 SheetJS 一致');
    assert.equal(resolveMappedAccount(new Map([['A_x0000_B', 'CLR-LIT']]), ' A_x0000_B '), '');
    assert.equal(resolveMappedAccount(new Map([['ACC', 'CLR']]), 'A_x005F_x0000_B'), '', '映射非空时转义原文也不参与匹配');
  });

  test('富文本片段拼接：原样与整串解码碰巧一致也不按映射换（逐段解码是另一个账号）', () => {
    // 片段 `MID_x00` + `41__x0042_` 逐段解码为 `MID_x0041_B`，流式导入落库为 `MID_x0041__x0042_`。
    const map = new Map([['MID_x0041__x0042_', 'MIDAB'], ['MIDAB', 'MIDAB']]);
    assert.equal(isAmbiguousMappedAccount(map, 'MID_x0041__x0042_'), true);
    assert.equal(resolveMappedAccount(map, 'MID_x0041__x0042_'), '');
    assert.equal(isMappedAccountHit(map, 'MID_x0041__x0042_'), false);
  });

  test('isMappedAccountHit：原账号是映射键（含同值映射），转义写法的账号不算命中', () => {
    assert.equal(isMappedAccountHit(new Map([['A\u0000B', 'A_x0000_B']]), 'A_x0000_B'), false, '只有解码后是映射键不再算命中');
    assert.equal(isMappedAccountHit(new Map([['CLR', 'CLR']]), ' CLR '), true, '同值映射按键命中');
    assert.equal(isMappedAccountHit(new Map([['A_x0000_B', 'C']]), 'A_x0000_B'), false, '转义写法的映射键也不算命中');
    assert.equal(isMappedAccountHit(new Map([['ACC', 'CLR']]), 'OTHER'), false);
    assert.equal(isMappedAccountHit(new Map(), 'ACC'), false);
    assert.equal(isMappedAccountHit(undefined, 'ACC'), false);
  });

  test('v3.2.22（🔴）舍入护栏：可能已被舍入的长数字正好是映射键 → 空串、不算命中；不是映射键或不是数值标准写法 → 照常', () => {
    // 链接表单元格 `<v>9007199254740993</v>` 按数值读入后落库成 '9007199254740992'。
    const map = new Map([['9007199254740992', 'CLR-B'], ['9007199254740991', 'CLR-SAFE'], ['1e+21', 'CLR-EXP']]);
    assert.equal(resolveMappedAccount(map, '9007199254740992'), '', '🔴 不按舍入值命中映射');
    assert.equal(resolveMappedAccount(map, 9007199254740993), '', '数值入参同口径（String 后即舍入写法）');
    assert.equal(isMappedAccountHit(map, '9007199254740992'), false);
    assert.equal(mappedAccountAmbiguity(map, '9007199254740992'), 'precision');
    assert.equal(mappedAccountAmbiguity(map, '1e+21'), 'precision', '指数写法同口径');
    assert.equal(resolveMappedAccount(map, '9007199254740991'), 'CLR-SAFE', '安全整数范围内照常命中');
    assert.equal(resolveMappedAccount(map, '18014398509481984'), '18014398509481984', '不是映射键：原值返回（与未映射行一致）');
    assert.equal(mappedAccountAmbiguity(map, '18014398509481984'), null);
    const textMap = new Map([['9007199254740993', 'CLR-TEXT'], ['6222020200112233445', 'CLR-CARD']]);
    assert.equal(resolveMappedAccount(textMap, '9007199254740993'), 'CLR-TEXT', '不是数值标准写法的长数字只能来自文本单元格，照常命中');
    assert.equal(resolveMappedAccount(textMap, '6222020200112233445'), 'CLR-CARD');
    assert.equal(resolveMappedAccount(textMap, '9007199254740992'), '', '🔴 舍入值按数值对得上文本映射键：不静默漏掉，判歧义');
    assert.equal(mappedAccountAmbiguity(textMap, '6222020200112233000'), 'precision', '19 位卡号按数值读入后的写法');
    assert.equal(mappedAccountAmbiguity(textMap, '6222020200112234000'), null, '按数值对不上任何映射键：原值返回');
    textMap.set('7777777777777777777', 'CLR-NEW');
    assert.equal(mappedAccountAmbiguity(textMap, '7777777777777778000'), 'precision', '映射键数变化后重新收集');
    const hexMap = new Map([['0x20000000000001', 'CLR-HEX']]);
    assert.equal(Number('0x20000000000001'), 9007199254740992);
    assert.equal(mappedAccountAmbiguity(hexMap, '9007199254740992'), null, '不是十进制写法的键不按数值比较');
    assert.equal(mappedAccountAmbiguity(new Map(), '9007199254740992'), null, '映射为空时不判');
    assert.equal(mappedAccountAmbiguity(map, 'A_x0000_B'), 'escape');
    assert.equal(mayBeRoundedLongNumber('9007199254740992'), true);
    assert.equal(mayBeRoundedLongNumber('-9007199254740992'), true);
    assert.equal(mayBeRoundedLongNumber('9007199254740991'), false);
    assert.equal(mayBeRoundedLongNumber('09007199254740992'), false, '前导零不是数值标准写法');
    assert.equal(mayBeRoundedLongNumber('1e21'), false);
    assert.equal(mayBeRoundedLongNumber(''), false);
    assert.equal(mayBeRoundedLongNumber(9007199254740992), false, '只判归一化后的文本');
  });

  test('containsOoxmlEscape：四位十六进制、前缀不分大小写', () => {
    assert.equal(containsOoxmlEscape('A_x00aF_'), true);
    assert.equal(containsOoxmlEscape('A_X0041_'), true);
    assert.equal(containsOoxmlEscape('A_x041_'), false);
    assert.equal(containsOoxmlEscape('A_x00G1_'), false);
    assert.equal(containsOoxmlEscape(null), false);
  });

  test('映射为空 / 非 Map / 不含转义写法 → 与改动前一致', () => {
    assert.equal(isAmbiguousMappedAccount(new Map(), 'A_x0000_B'), false);
    assert.equal(resolveMappedAccount(new Map(), 'A_x0000_B'), 'A_x0000_B');
    assert.equal(resolveMappedAccount(undefined, 'A_x0000_B'), 'A_x0000_B');
    assert.equal(isAmbiguousMappedAccount(new Map([['A', 'B']]), 'A_x00_B'), false, '不足四位十六进制不是转义写法');
    assert.equal(resolveMappedAccount(new Map([['ACC', 'CLR']]), 'ACC'), 'CLR');
  });
});

// v3.2.22（🔴 资金红线）：按数值存放的长账号可能已丢失精度——Excel 数值只存 15 位有效数字（第 16 位起置 0），
//   大于 9007199254740991 时 JS 读入还会舍入。
test.describe('精度护栏：Excel 15 位有效数字与 JS 舍入', () => {
  test('precisionLostDigitsOf：16 位及以上，且超出精确范围或第 16 位起全为 0', () => {
    assert.equal(precisionLostDigitsOf(1234567890123450), '1234567890123450', 'Excel 截断特征');
    assert.equal(precisionLostDigitsOf('1234567890123450'), '1234567890123450', '标准写法文本同口径');
    assert.equal(precisionLostDigitsOf(1234567890123456), null, '精确范围内、第 16 位非 0：没有丢失精度');
    assert.equal(precisionLostDigitsOf(123456789012345), null, '15 位：Excel 能精确存放');
    assert.equal(precisionLostDigitsOf(9007199254740993), '9007199254740992', '超出精确范围');
    assert.equal(precisionLostDigitsOf(-1234567890123450), '1234567890123450', '负数按绝对值');
    assert.equal(precisionLostDigitsOf(1e21), '1000000000000000000000', '指数写法按有效数字补 0');
    assert.equal(precisionLostDigitsOf('1e+21'), '1000000000000000000000');
    assert.equal(precisionLostDigitsOf('01234567890123450'), null, '前导 0 不是数值标准写法，只能来自文本单元格');
    assert.equal(precisionLostDigitsOf('1234567890123450.5'), null);
    assert.equal(precisionLostDigitsOf(''), null);
    assert.equal(precisionLostDigitsOf(Number.NaN), null);
    assert.equal(mayBeRoundedLongNumber('1234567890123450'), true);
    assert.equal(mayBeRoundedLongNumber('1234567890123456'), false);
  });

  test('mappedAccountAmbiguity：Excel 截断写法与映射键位数、前 15 位相同 → precision；第 16 位非 0 只按数值比较', () => {
    const map = new Map([['1234567890123456', 'CLR-A'], ['6222020200112233445', 'CLR-CARD']]);
    assert.equal(mappedAccountAmbiguity(map, '1234567890123450'), 'precision', '1234567890123456 被 Excel 存成 …450');
    assert.equal(resolveMappedAccount(map, '1234567890123450'), '');
    assert.equal(mappedAccountAmbiguity(map, '1234567890123456'), null, '原样即映射键：照常');
    assert.equal(resolveMappedAccount(map, '1234567890123456'), 'CLR-A');
    assert.equal(mappedAccountAmbiguity(map, '12345678901234500'), null, '位数不同');
    assert.equal(mappedAccountAmbiguity(map, '1234567890123460'), null, '前 15 位不同');
    assert.equal(mappedAccountAmbiguity(map, '6222020200112230000'), 'precision', '19 位卡号被 Excel 截断后的写法');
    assert.equal(mappedAccountAmbiguity(map, '6222020200112234000'), null, '第 16 位起有非 0：不是 Excel 截断，按数值也对不上');
    assert.equal(mappedAccountAmbiguity(new Map([['1234567890123450', 'CLR']]), '1234567890123450'), 'precision',
      '映射键本身是截断写法：无法确认真实账号是否同一个');
  });

  test('isPrecisionAmbiguousBankAccount：只判数值单元格，与指纹按数值或位数 + 前 15 位相同', () => {
    const fingerprints = precisionFingerprintsOf(['1234567890123456', 'CLR', '9007199254740992', '0x20000000000001', 'A1234567890123456']);
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123450, fingerprints), true);
    assert.equal(isPrecisionAmbiguousBankAccount(9007199254740993, fingerprints), true, 'JS 舍入后按数值相同');
    assert.equal(isPrecisionAmbiguousBankAccount('1234567890123450', fingerprints), false, '文本单元格原文可信');
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123456, fingerprints), false, '没有丢失精度');
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123460, fingerprints), false);
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123450, precisionFingerprintsOf([])), false);
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123450, null), false);
    assert.equal(precisionFingerprintsOf(['0x20000000000001', 'A1234567890123456']).values.size, 0, '非十进制写法不收');
    assert.equal(fingerprints.prefixes.has('16:123456789012345'), true);
    assert.equal(precisionFingerprintsOf(['-01234567890123456']).prefixes.has('-16:123456789012345'), true, '整数写法保留符号、去前导 0');
    assert.equal(precisionFingerprintsOf(['1.234567890123456e15']).prefixes.has('16:123456789012345'), true, '指数写法按原文有效数字');
    assert.equal(precisionFingerprintsOf(['1234567890123450']).prefixes.size, 0, '有效数字不超过 15 位：截断不改变数值，按同值判断');
  });

  test('截断键保留正负号：只配负数账号时，正数截断写法不受影响', () => {
    const map = new Map([['-1234567890123456', 'CLR']]);
    assert.equal(mappedAccountAmbiguity(map, '1234567890123450'), null);
    assert.equal(resolveMappedAccount(map, '1234567890123450'), '1234567890123450', '未命中映射：原值');
    assert.equal(mappedAccountAmbiguity(map, '-1234567890123450'), 'precision');
    assert.equal(isPrecisionAmbiguousBankAccount(1234567890123450, precisionFingerprintsOf(['-1234567890123456'])), false);
    assert.equal(isPrecisionAmbiguousBankAccount(-1234567890123450, precisionFingerprintsOf(['-1234567890123456'])), true);
  });

  test('小数写法同样按 15 位有效数字判断截断：`12345678901234.51` 按数值存放即为 `12345678901234.5`', () => {
    const map = new Map([['12345678901234.51', 'CLR-A'], ['12345678901234.5', 'CLR-B']]);
    assert.equal(mappedAccountAmbiguity(map, '12345678901234.5'), 'precision', '🔴 可能是截断后的 12345678901234.51');
    assert.equal(resolveMappedAccount(map, '12345678901234.5'), '');
    assert.equal(resolveMappedAccount(map, 12345678901234.5), '', '数值同口径');
    assert.equal(resolveMappedAccount(map, '12345678901234.51'), 'CLR-A', '16 位有效数字：没有经过截断');
    assert.equal(resolveMappedAccount(new Map([['12345678901234.5', 'CLR-B']]), '12345678901234.5'), 'CLR-B',
      '没有更长的小数账号：照常');
    assert.equal(mappedAccountAmbiguity(new Map([['0.1234567890123456', 'X']]), '0.123456789012345'), 'precision', '小于 1 的小数');
    assert.equal(mappedAccountAmbiguity(new Map([['12345678901234.0001', 'X']]), '12345678901234'), 'precision',
      '截断后成整数也对得上');
    assert.equal(mappedAccountAmbiguity(new Map([['12345678901234.51', 'X']]), '1234567890123.45'), null, '数量级不同');
    assert.deepEqual(numericReadCollisionIndexOf(['12345678901234.51', '12345678901234.5', 'CLR'])('12345678901234.5'),
      ['12345678901234.51'], '数值反查：同值且未丢失精度的不算');
  });

  test('前导 0：非标准写法账号收进 aliases，按数值读入的同值写法与之对得上', () => {
    const fingerprints = precisionFingerprintsOf(['00123', '0123', '1.50', 'CLR', '0x7B', '123']);
    assert.deepEqual(Array.from(fingerprints.aliases).sort((a, b) => a - b), [1.5, 123], '`00123`、`0123` → 123，`1.50` → 1.5');
    assert.equal(numericReadAccountAmbiguous('123', fingerprints), true, '标准写法文本：可能是丢了前导 0 的 `00123`');
    assert.equal(numericReadAccountAmbiguous(123, fingerprints), true, '数值同口径');
    assert.equal(numericReadAccountAmbiguous('1.5', fingerprints), true);
    assert.equal(numericReadAccountAmbiguous('00123', fingerprints), false, '非标准写法只能来自文本单元格，原文可信');
    assert.equal(numericReadAccountAmbiguous('124', fingerprints), false);
    assert.equal(numericReadAccountAmbiguous('', fingerprints), false);
    assert.equal(numericReadAccountAmbiguous(null, fingerprints), false);
    assert.equal(numericReadAccountAmbiguous(Number.NaN, fingerprints), false);
    assert.equal(numericReadAccountAmbiguous('123', precisionFingerprintsOf(['123'])), false, '只有标准写法的 `123`：没有歧义');
    assert.equal(numericReadAccountAmbiguous('123', null), false);
  });

  test('前导 0：映射里 `00123` 与 `123` 并存时，`123` 无法确定真实账号；`00123` 原文可信', () => {
    const map = new Map([['00123', 'CLR-A'], ['123', 'CLR-B']]);
    assert.equal(mappedAccountAmbiguity(map, '123'), 'precision');
    assert.equal(resolveMappedAccount(map, '123'), '', '🔴 不按丢了前导 0 的值命中 CLR-B');
    assert.equal(resolveMappedAccount(map, 123), '', '数值同口径');
    assert.equal(resolveMappedAccount(map, '00123'), 'CLR-A');
    assert.equal(isAmbiguousMappedAccount(map, '123'), true);
    assert.equal(isMappedAccountHit(map, '123'), false);
    assert.equal(resolveMappedAccount(new Map([['00123', 'CLR-A']]), '123'), '', '只有带前导 0 的键：`123` 也可能是它，不静默漏掉');
    assert.equal(resolveMappedAccount(new Map([['123', 'CLR-B']]), '123'), 'CLR-B', '只有标准写法键：照常');
    assert.equal(resolveMappedAccount(new Map([['123', 'CLR-B']]), '0123'), '0123', '文本写法未命中：原值');
  });

  test('numericReadCollisionIndexOf：与逐个账号判断 numericReadAccountAmbiguous 一致', () => {
    const accounts = ['00123', '123', '1234567890123456', '1234567890123450', '9007199254740992', '6222020200112233445', 'CLR', 'A_x0041_',
      '12345678901234.51', '-1234567890123456', '0.1234567890123456'];
    const collisions = numericReadCollisionIndexOf(accounts);
    const values = ['123', 123, '00123', 1234567890123450, '1234567890123450', 9007199254740993, '9007199254740992',
      '6222020200112233000', 6222020200112230000, '1234567890123456', 'CLR', '', null, 124,
      '12345678901234.5', 12345678901234.5, -1234567890123450, '-1234567890123450', 0.123456789012345];
    for (const value of values) {
      const expected = accounts.filter((account) => numericReadAccountAmbiguous(value, precisionFingerprintsOf([account])));
      assert.deepEqual(collisions(value).sort(), expected.sort(), String(value));
    }
    assert.deepEqual(numericReadCollisionIndexOf([])('123'), []);
  });

  test('createEscapeSameValueWarning：不写完整值，只写尾号、字符数与转义片段', () => {
    const warning = createEscapeSameValueWarning({
      rowId: 'r1', engine: 'c3', column: 'Narrative', value: '6222020200112233_x000D_445', source: 'C3 网关字段「Ref」'
    });
    assert.equal(warning.code, 'linked-value-escape-same-value-ambiguous');
    assert.match(warning.message, /^C3 网关字段「Ref」（尾号「_445」，共 26 个字符，含 Excel 转义写法：⟨U\+000D⟩）与银行行\(r1\)「Narrative」/);
    assert.ok(!warning.message.includes('62220202'), '🔴 不写完整值');
    const short = createEscapeSameValueWarning({ rowId: 'r2', engine: 'c3', column: 'N', value: 'A_x0041_', source: 'S' });
    assert.match(short.message, /^S（共 8 个字符，含 Excel 转义写法：⟨U\+0041⟩）/, '8 个字符及以下不写尾号');
    const many = createEscapeSameValueWarning({ rowId: 'r3', engine: 'c3', column: 'N', value: '_x0001__x0002__x0003__x0004__x0001_', source: 'S' });
    assert.match(many.message, /⟨U\+0001⟩、⟨U\+0002⟩、⟨U\+0003⟩）/, '片段去重、至多 3 个');
  });
});
