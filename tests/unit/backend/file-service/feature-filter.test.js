'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FileValidationError } = require('../../../../src/backend/file-service/common');
const {
  buildFeatureFilterToken,
  collectFeatureFilterIds,
  extractFeatureValue,
  getFeatureFilterRef,
  normalizeFeatureFilterList,
  normalizeFeatureFilterRule,
  parseFeatureFilterToken,
  resolveUsedFeatureFilters,
  splitFeatureTokens,
  upgradeLegacyFeatureFilter
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

// ==================== v3.2.18 多特征值 ====================

const BASE_RULE = { sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: '' };

function assertFeatureError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FileValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

test('特征值列表：已有 id 保留，新条目按最大数字 id 递增分配，改名不变 id', () => {
  const list = normalizeFeatureFilterList([
    { id: '3', name: ' 订单号 ', ...BASE_RULE },
    { name: '流水号', ...BASE_RULE, length: 6, letterPrefixCount: null }
  ], { headers: HEADERS, knownIds: new Set(['1', '3']) });
  assert.deepEqual(list.map((item) => [item.id, item.name]), [['3', '订单号'], ['4', '流水号']]);
  assert.equal(list[1].length, 6);
  assert.equal(list[1].letterPrefixCount, null);
  // 删除 id 1 后再新增，不复用比已有更小的 id
  assert.deepEqual(normalizeFeatureFilterList([{ name: '新', ...BASE_RULE }], { knownIds: new Set(['1', '2']) })
    .map((item) => item.id), ['3']);
});

test('特征值列表：名称必填、≤30 字、不可重复；已有 id 必须存在；条件错误带特征值名', () => {
  assertFeatureError(() => normalizeFeatureFilterList([{ name: ' ', ...BASE_RULE }]), /请输入特征值名/);
  assertFeatureError(() => normalizeFeatureFilterList([{ name: '长'.repeat(31), ...BASE_RULE }]), /超过 30 个字/);
  assert.equal(normalizeFeatureFilterList([{ name: '长'.repeat(30), ...BASE_RULE }])[0].name.length, 30);
  assertFeatureError(() => normalizeFeatureFilterList([
    { name: 'A', ...BASE_RULE }, { name: 'A', ...BASE_RULE }
  ]), /特征值名「A」已存在/);
  assertFeatureError(() => normalizeFeatureFilterList([{ id: '9', name: 'A', ...BASE_RULE }], { knownIds: new Set(['1']) }),
    /特征值「A」不存在或已被删除/);
  assertFeatureError(() => normalizeFeatureFilterList([{ name: '流水号', ...BASE_RULE, sourceField: '备注' }], { headers: HEADERS }),
    /特征值「流水号」：筛选字段不存在：备注/);
  assertFeatureError(() => normalizeFeatureFilterList(null), /特征值列表格式不正确/);
  assert.deepEqual(normalizeFeatureFilterList([]), []);
});

test('特征值列表：模板【更新】删掉共用的筛选字段后可逐个修复——条件未改的已有条目不按表头校验', () => {
  // 两个已保存特征值都引用已从表头删除的「备注」
  const saved = [
    { id: '1', name: '流水号', ...BASE_RULE, sourceField: '备注' },
    { id: '2', name: '订单号', ...BASE_RULE, sourceField: '备注' }
  ];
  const options = { headers: HEADERS, knownIds: new Set(['1', '2']), preserved: saved };
  // 只修特征值 1：特征值 2 原样提交，不因旧字段被拒
  assert.deepEqual(normalizeFeatureFilterList([{ ...saved[0], sourceField: '附言' }, saved[1]], options)
    .map((item) => [item.id, item.sourceField]), [['1', '附言'], ['2', '备注']]);
  // 只改名也不改变条件
  assert.equal(normalizeFeatureFilterList([{ ...saved[1], name: '订单编号' }], options)[0].name, '订单编号');
  // 改了条件、或新增的条目仍按表头校验
  assertFeatureError(() => normalizeFeatureFilterList([{ ...saved[1], length: 9 }], options), /特征值「订单号」：筛选字段不存在：备注/);
  assertFeatureError(() => normalizeFeatureFilterList([{ name: '新', ...BASE_RULE, sourceField: '备注' }], options),
    /特征值「新」：筛选字段不存在：备注/);
  // 不传 preserved 时照旧整表校验
  assertFeatureError(() => normalizeFeatureFilterList(saved, { headers: HEADERS }), /筛选字段不存在：备注/);
});

test('旧单套规则升级为「特征值1」（id 1）；数组原样复制；空值为空列表', () => {
  assert.deepEqual(upgradeLegacyFeatureFilter({ ...BASE_RULE }), [{ id: '1', name: '特征值1', ...BASE_RULE }]);
  const list = [{ id: '2', name: 'X', ...BASE_RULE }];
  const copied = upgradeLegacyFeatureFilter(list);
  assert.deepEqual(copied, list);
  assert.notEqual(copied[0], list[0]);
  assert.deepEqual(upgradeLegacyFeatureFilter(null), []);
  assert.deepEqual(upgradeLegacyFeatureFilter(''), []);
});

test('映射引用与 token：取 mappedFields[0]，token 往返，lookup 收集去重', () => {
  assert.equal(getFeatureFilterRef({ mappedFields: [' 2 ', '3'] }), '2');
  assert.equal(getFeatureFilterRef({ mappedFields: [] }), '');
  assert.equal(getFeatureFilterRef(null), '');
  const token = buildFeatureFilterToken('2');
  assert.equal(parseFeatureFilterToken(token), '2');
  assert.equal(parseFeatureFilterToken('附言'), null);
  assert.equal(parseFeatureFilterToken(['x']), null);
  assert.deepEqual(collectFeatureFilterIds({
    Remark: buildFeatureFilterToken('2'),
    Reference: buildFeatureFilterToken('1'),
    Name: buildFeatureFilterToken('2'),
    CardNo: ['附言', '金额'],
    BillDate: '交易日期'
  }), ['2', '1']);
});

test('按生效映射取用到的特征值：未选、不存在、条件无效均拒绝；同一特征值只取一次', () => {
  const list = [{ id: '1', name: '流水号', ...BASE_RULE }, { id: '2', name: '坏规则', sourceField: '附言', separator: 'space' }];
  const resolved = resolveUsedFeatureFilters(list, [
    { templateField: 'Remark', ref: '1' },
    { templateField: 'Reference', ref: '1' }
  ], { headers: HEADERS });
  assert.deepEqual(Object.keys(resolved), ['1']);
  assert.equal(resolved['1'].name, '流水号');
  assert.equal(resolved['1'].length, 10);
  assert.deepEqual(resolveUsedFeatureFilters(list, []), {});
  assertFeatureError(() => resolveUsedFeatureFilters(list, [{ templateField: 'Remark', ref: '' }]),
    /Remark 选择了「字段筛选特征值」，请选择特征值/);
  assertFeatureError(() => resolveUsedFeatureFilters(list, [{ templateField: 'Remark', ref: '9' }]),
    /Remark 选择的特征值不存在，请重新选择/);
  assertFeatureError(() => resolveUsedFeatureFilters(list, [{ templateField: 'Remark', ref: '2' }]),
    /特征值「坏规则」：特征长度、前几位英文、纯数字至少设置一项/);
  assertFeatureError(() => resolveUsedFeatureFilters(null, [{ templateField: 'Remark', ref: '1' }]),
    /选择的特征值不存在/);
});

// v3.2.21：特征值 id 是任意字符串（模板包可带入），与对象原型属性同名时也按自有属性解析；新 id 避开保留 id（含超出安全整数的数字）。
test('resolveUsedFeatureFilters：id 为 constructor / __proto__ 时照常解析', () => {
  const { resolveUsedFeatureFilters: resolve } = require('../../../../src/backend/file-service/feature-filter');
  const rule = { sourceField: '附言', separator: 'space', length: 6, letterPrefixCount: null, digitsOnly: true };
  const resolved = resolve(
    [{ id: 'constructor', name: '甲', ...rule }, { id: '__proto__', name: '乙', ...rule }],
    [{ templateField: 'Remark', ref: 'constructor' }, { templateField: 'Reference', ref: '__proto__' }]
  );
  assert.deepEqual(Object.keys(resolved), ['constructor', '__proto__']);
  assert.equal(resolved.constructor.name, '甲');
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(resolved, '__proto__').value.name, '乙');
});

test('normalizeFeatureFilterList：新特征值 id 避开 reservedIds（含超出安全整数的数字 id）', () => {
  const { normalizeFeatureFilterList: normalizeList } = require('../../../../src/backend/file-service/feature-filter');
  const rule = { sourceField: '附言', separator: 'space', length: 6, letterPrefixCount: null, digitsOnly: true };
  assert.deepEqual(normalizeList([{ id: '1', name: '甲', ...rule }, { name: '乙', ...rule }], { reservedIds: ['2'] }).map((item) => item.id), ['1', '3']);
  assert.deepEqual(normalizeList([{ name: '乙', ...rule }], { reservedIds: ['9007199254740992'] }).map((item) => item.id), ['9007199254740993']);
});
