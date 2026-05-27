const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureRowId,
  evaluateCondition,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
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
