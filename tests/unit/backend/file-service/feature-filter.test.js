'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FileValidationError } = require('../../../../src/backend/file-service/common');
const {
  extractFeatureValue,
  normalizeFeatureFilterRule,
  splitFeatureTokens
} = require('../../../../src/backend/file-service/feature-filter');

const HEADERS = ['交易日期', '附言', '金额'];

function rule(overrides = {}) {
  return normalizeFeatureFilterRule({
    sourceField: '附言',
    separator: 'space',
    length: null,
    letterPrefixCount: null,
    digitsOnly: false,
    sample: '',
    ...overrides
  }, { headers: HEADERS });
}

function assertRuleError(overrides, pattern) {
  assert.throws(() => rule(overrides), (error) => {
    assert.ok(error instanceof FileValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

test('五种分隔符与不拆分各自按口径拆段', () => {
  assert.deepEqual(splitFeatureTokens('转账  FT24123456　附言 X', 'space'), ['转账', 'FT24123456', '附言', 'X']);
  assert.deepEqual(splitFeatureTokens('A/ B /C', 'slash'), ['A', 'B', 'C']);
  assert.deepEqual(splitFeatureTokens('A,,B', 'comma'), ['A', 'B']);
  assert.deepEqual(splitFeatureTokens('PAY.FT24123456.REF', 'dot'), ['PAY', 'FT24123456', 'REF']);
  assert.deepEqual(splitFeatureTokens('A\\B', 'backslash'), ['A', 'B']);
  assert.deepEqual(splitFeatureTokens('  A B  ', ''), ['A B']);
  assert.deepEqual(splitFeatureTokens('', 'space'), []);
  assert.deepEqual(splitFeatureTokens(null, 'space'), []);
});

test('前 N 位英文 + 纯数字组合：其余位须全为数字，取第一个命中段', () => {
  const r = rule({ length: 10, letterPrefixCount: 2, digitsOnly: true });
  assert.equal(extractFeatureValue('付款 FT2412345X FT24123456 AB98765432', r), 'FT24123456');
  assert.equal(extractFeatureValue('ft24123456', r), 'ft24123456');
  assert.equal(extractFeatureValue('FT2412345', r), '');
});

test('单项条件：只设长度 / 只设前几位英文 / 只勾纯数字', () => {
  assert.equal(extractFeatureValue('AB 12345 XYZ12', rule({ length: 5 })), '12345');
  assert.equal(extractFeatureValue('12AB INV-009', rule({ letterPrefixCount: 3 })), 'INV-009');
  assert.equal(extractFeatureValue('NO.12 778899', rule({ digitsOnly: true })), '778899');
});

test('未设前几位英文时纯数字指整段；前几位英文只约束前 N 位', () => {
  assert.equal(extractFeatureValue('A1234 5678', rule({ digitsOnly: true, length: 4 })), '5678');
  assert.equal(extractFeatureValue('ABCDE234', rule({ letterPrefixCount: 4, length: 8, separator: '' })), 'ABCDE234');
  assert.equal(extractFeatureValue('ABCDE234', rule({ letterPrefixCount: 4, length: 8, digitsOnly: true, separator: '' })), '');
});

test('未命中、空单元格返回空串；数值单元格按文本处理', () => {
  const r = rule({ digitsOnly: true, length: 6 });
  assert.equal(extractFeatureValue('没有编号', r), '');
  assert.equal(extractFeatureValue('', r), '');
  assert.equal(extractFeatureValue(undefined, r), '');
  assert.equal(extractFeatureValue(123456, rule({ digitsOnly: true, length: 6, separator: '' })), '123456');
});

test('规则规范化：数字字符串转整数，前几位英文 0 视为不限，样例保留', () => {
  assert.deepEqual(rule({ length: '10', letterPrefixCount: '0', digitsOnly: true, sample: ' 1234567890 ' }), {
    sourceField: '附言',
    separator: 'space',
    length: 10,
    letterPrefixCount: null,
    digitsOnly: true,
    sample: '1234567890'
  });
});

test('规则校验：缺失、字段不存在、分隔符非法、无条件、数值越界', () => {
  assert.throws(() => normalizeFeatureFilterRule(null), /尚未设置筛选条件/);
  assertRuleError({ sourceField: '' }, /请选择筛选字段/);
  assertRuleError({ sourceField: '备注' }, /筛选字段不存在：备注/);
  assertRuleError({ separator: '-', length: 3 }, /不支持的分隔符/);
  assertRuleError({}, /至少设置一项/);
  assertRuleError({ length: 'abc' }, /特征长度须为整数/);
  assertRuleError({ length: 0 }, /特征长度须在/);
  assertRuleError({ length: 201 }, /特征长度须在/);
  assertRuleError({ length: 2, letterPrefixCount: 3 }, /前几位英文不能大于特征长度/);
  assertRuleError({ length: 2, letterPrefixCount: 2, digitsOnly: true }, /特征长度须大于前几位英文/);
});

test('样例须符合条件且不能含所选分隔符', () => {
  assertRuleError({ length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT2412345X' }, /不符合当前筛选条件/);
  assertRuleError({ length: 5, sample: 'AB CD' }, /不能包含所选分隔符/);
  assert.equal(rule({ length: 5, separator: '', sample: 'AB CD' }).sample, 'AB CD');
});

test('未传表头时不校验源字段存在', () => {
  const normalized = normalizeFeatureFilterRule({ sourceField: '任意列', separator: 'comma', digitsOnly: true });
  assert.equal(normalized.sourceField, '任意列');
});
