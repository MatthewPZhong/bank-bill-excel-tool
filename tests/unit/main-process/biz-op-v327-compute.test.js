'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cases } = require('../../fixtures/biz-op-v327-acceptance-cases.json');
const { cases: netFlowCases } = require('../../fixtures/biz-op-v327-net-flow-expected.json');
const { createGroup, observe, observeDescription, finishGroup, compareKeys } = require('../../../src/main-process/biz-op-v327/compute-group');
const { intervalInputs } = require('../../../src/main-process/biz-op-v327/compute-inputs');

function calculate(fixture) {
  const group = createGroup(fixture.businessKey);
  const key = { key_bu: fixture.businessKey[0], key_account: fixture.businessKey[1], key_currency: fixture.businessKey[2] };
  for (const [role, rows] of [['START_OP', fixture.startOpRows], ['END_OP', fixture.endOpRows]]) {
    for (const row of rows) observe(group, { ...key, role, balance_or_amount: row.balance, bu_display: 'BU-A' });
  }
  for (const row of fixture.flowRows.filter((value) => value.date > fixture.startDate && value.date <= fixture.endDate)) {
    observe(group, { ...key, role: 'FLOW', balance_or_amount: row.amount, direction: row.direction, bu_display: 'BU-A' });
  }
  for (const [field, sourceField] of [['entity', 'entity'], ['customer_no', 'customer'], ['account_type', 'accountType']]) {
    const values = new Map();
    for (const [role, rows] of [['in_start', fixture.startOpRows], ['in_end', fixture.endOpRows]]) {
      for (const row of rows) {
        const value = String(row[sourceField] ?? '').trim() || null;
        const entry = values.get(value) || { ...key, field_key: field, null_flag: value === null ? 1 : 0,
          normalized_value: value || '', in_start: 0, in_end: 0 };
        entry[role] = 1; values.set(value, entry);
      }
    }
    for (const value of values.values()) observeDescription(group, value);
  }
  return finishGroup(group, { ...fixture, rowOrdinal: 1, locator: fixture.caseId });
}
test('新净发生额预期完整覆盖旧批准样例，只有第 13 列允许变化', () => {
  assert.deepEqual(netFlowCases.map(({ caseId }) => caseId), cases.map(({ caseId }) => caseId));
  for (const fixture of cases) {
    const expected = netFlowCases.find(({ caseId }) => caseId === fixture.caseId).expected19Values;
    assert.equal(expected.length, 19);
    assert.deepEqual(expected.filter((_, index) => index !== 12), fixture.expected19Values.filter((_, index) => index !== 12));
  }
});
for (const fixture of cases) {
  test(`${fixture.caseId}：${fixture.title}，严格比较新 19 列并保持旧反推值、差额、结论及原因`, () => {
    const result = calculate(fixture);
    const expected = netFlowCases.find(({ caseId }) => caseId === fixture.caseId).expected19Values;
    assert.deepEqual(result.values, expected);
    assert.deepEqual(result.values.filter((_, index) => index !== 12), fixture.expected19Values.filter((_, index) => index !== 12));
    assert.deepEqual(result.reasonCodes, fixture.expectedReasonCodes);
    assert.equal(Boolean(result.isDifference), fixture.expectedInDifference);
    assert.equal(result.descriptionSourceRole, fixture.descriptionSourceRole === 'NONE' ? 'NONE' : `${fixture.descriptionSourceRole}_OP`);
  });
}
const exactAmountCases = [
  { title: '正数出账减少余额', start: '1000', end: '900', rows: [['出', '100']], expected: ['0', '100', '-100', '1000', '0'] },
  { title: '负数出账冲正增加余额', start: '1000', end: '1020', rows: [['出', '-20']], expected: ['0', '-20', '20', '1000', '0'] },
  { title: '同方向正负冲正和入出混合保留原符号', start: '1000', end: '1075',
    rows: [['入', '200'], ['入', '-35'], ['出', '100'], ['出', '-10']], expected: ['165', '90', '75', '1000', '0'] },
  { title: '入出合计均为负数且净流出', start: '-100', end: '-125',
    rows: [['入', '-30'], ['出', '-5']], expected: ['-30', '-5', '-25', '-100', '0'] },
  { title: '正负流水抵消与负零规范化', start: '-0.00', end: '0',
    rows: [['入', '0.1'], ['入', '-0.10'], ['出', '-0.00'], ['出', '0']], expected: ['0', '0', '0', '0', '0'] },
  { title: '超过安全整数范围的金额保持精确', start: '9007199254740993123456', end: '9007199254740993123457',
    rows: [['入', '9007199254740993'], ['出', '9007199254740992']],
    expected: ['9007199254740993', '9007199254740992', '1', '9007199254740993123456', '0'] },
  { title: '十八位小数的入出合计不经过浮点数', start: '0.123456789012345678', end: '0.123456789012345679',
    rows: [['入', '0.100000000000000001'], ['出', '0.1']],
    expected: ['0.100000000000000001', '0.1', '0.000000000000000001', '0.123456789012345678', '0'] },
  { title: '大整数与十八位小数混合且保留微小核对差额', start: '9007199254740993.123456789012345678', end: '9007199254740993.42345678901234568',
    rows: [['入', '0.5'], ['出', '0.199999999999999999']],
    expected: ['0.5', '0.199999999999999999', '0.300000000000000001', '9007199254740993.123456789012345679', '-0.000000000000000001'] }
];
for (const fixture of exactAmountCases) {
  test(`净发生额精确金额：${fixture.title}`, () => {
    const base = cases[0];
    const result = calculate({ ...base,
      startOpRows: [{ ...base.startOpRows[0], balance: fixture.start }],
      endOpRows: [{ ...base.endOpRows[0], balance: fixture.end }],
      flowRows: fixture.rows.map(([direction, amount]) => ({ date: base.endDate, direction, amount }))
    });
    // 预期为独立固定金额，禁止从生产加减函数或旧净额动态派生。
    assert.deepEqual(result.values.slice(10, 15), fixture.expected);
    assert.equal(result.values[17], '金额相等');
    assert.equal(result.values[18], null);
    assert.deepEqual(result.reasonCodes, []);
    assert.equal(result.isDifference, 0);
  });
}
test('日期清单跨年跨闰日严格逐日，非法日期和同日起止拒绝', () => {
  assert.deepEqual(intervalInputs('2026-12-31', '2027-01-02').map(({ dataDate }) => dataDate), ['2026-12-31', '2027-01-02', '2027-01-01', '2027-01-02']);
  assert.equal(intervalInputs('2028-02-28', '2028-03-01').at(-2).dataDate, '2028-02-29');
  for (const [start, end] of [['2026-02-30', '2026-03-02'], ['2026-01-01', '2026-01-01'], ['2026-2-01', '2026-03-01']]) {
    assert.throws(() => intervalInputs(start, end), { code: 'BIZOP_INTERVAL_INVALID' });
  }
});
test('规范键使用 UTF-8 BINARY，而非 UTF-16/locale/无转义拼接；描述比较完整集合', () => {
  assert.ok(compareKeys(['b', '\uE000', 'USD'], ['b', '😀', 'USD']) < 0);
  assert.notEqual(compareKeys(['a|b', 'c', 'USD'], ['a', 'b|c', 'USD']), 0);
  const base = cases[0];
  const fixture = { ...base, startOpRows: [base.startOpRows[0], { ...base.startOpRows[0], entity: '主体B' }],
    endOpRows: [{ ...base.endOpRows[0], entity: '主体B' }, base.endOpRows[0]] };
  let result = calculate(fixture);
  assert.equal(result.values[1], null); assert.equal(result.reasonCodes.includes('DESCRIPTION_CHANGED'), false);
  fixture.endOpRows.push({ ...base.endOpRows[0], entity: '主体C' });
  result = calculate(fixture); assert.equal(result.reasonCodes.includes('DESCRIPTION_CHANGED'), true);
  const sameValue = calculate({ ...base, startOpRows: [{ ...base.startOpRows[0], balance: '1000.00' }, base.startOpRows[0]] });
  assert.equal(sameValue.reasonCodes.includes('START_BALANCE_CONFLICT'), false);
  const different = calculate({ ...base, startOpRows: [{ ...base.startOpRows[0], balance: '1000.01' }, base.startOpRows[0]] });
  assert.equal(different.reasonCodes.includes('START_BALANCE_CONFLICT'), true);
});

module.exports = { calculate };
