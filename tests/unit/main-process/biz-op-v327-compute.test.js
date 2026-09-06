'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cases } = require('../../fixtures/biz-op-v327-acceptance-cases.json');
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
for (const fixture of cases) {
  test(`${fixture.caseId}：${fixture.title}，严格比较全部 19 列及原因`, () => {
    const result = calculate(fixture);
    assert.deepEqual(result.values, fixture.expected19Values);
    assert.deepEqual(result.reasonCodes, fixture.expectedReasonCodes);
    assert.equal(Boolean(result.isDifference), fixture.expectedInDifference);
    assert.equal(result.descriptionSourceRole, fixture.descriptionSourceRole === 'NONE' ? 'NONE' : `${fixture.descriptionSourceRole}_OP`);
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
