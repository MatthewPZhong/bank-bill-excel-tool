'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pairsMatch, runC2Scenario } = require('../../../../src/main-process/scenario-engines/c2-offset-bill-mark');
const { runAllScenarios } = require('../../../../src/main-process/scenario-dispatcher');

const currencyField = { seq: 1, leftType: 1, leftField: 'Currency', op: '等于', rightType: 2, rightField: 'Currency' };
const reverseContainsField = { seq: 2, leftType: 2, leftField: 'CustomerRef', op: '包含', rightType: 1, rightField: 'CustomerRef' };

function makeRows(type1Ref, type2Ref) {
  return [
    { _rowId: 'type-1', Side: 'L', Currency: 'USD', CustomerRef: type1Ref, ReconciliationId: '' },
    { _rowId: 'type-2', Side: 'R', Currency: 'USD', CustomerRef: type2Ref, ReconciliationId: '' }
  ];
}

function makeScenario(reconFields = [currencyField, reverseContainsField]) {
  return {
    id: 229,
    name: '逐条对账字段方向',
    category: 'offset-bill-mark',
    priority: 10,
    enabled: true,
    config: {
      billTypes: [
        { seq: 1, field: 'Side', op: '等于', value: 'L' },
        { seq: 2, field: 'Side', op: '等于', value: 'R' }
      ],
      reconFields,
      markValue: { type: 2, field: 'ReconciliationId', value: 'MATCHED' }
    }
  };
}

function runPair(type1Ref, type2Ref, reconFields = [currencyField, reverseContainsField]) {
  const rows = makeRows(type1Ref, type2Ref);
  const result = runC2Scenario(makeScenario(reconFields), rows);
  return { rows, ...result, lockedRowIds: [...result.lockedRowIds].sort() };
}

function assertNotMatched(result) {
  assert.deepEqual(result.rows.map((row) => row.ReconciliationId), ['', '']);
  assert.deepEqual(result.modifications, []);
  assert.deepEqual(result.lockedRowIds, []);
  assert.deepEqual(result.warnings, []);
}

function assertMatched(result) {
  assert.deepEqual(result.rows.map((row) => row.ReconciliationId), ['', 'MATCHED']);
  assert.deepEqual(result.modifications, [{ rowId: 'type-2', column: 'ReconciliationId', oldValue: '', newValue: 'MATCHED' }]);
  assert.deepEqual(result.lockedRowIds, ['type-1', 'type-2']);
  assert.deepEqual(result.warnings, []);
}

test('同向包含对照：类型 1 包含类型 2 时仍赋值类型 2 并锁定双方', () => {
  const sameDirection = { ...reverseContainsField, leftType: 1, rightType: 2 };
  assertMatched(runPair('ABC123', '123', [currencyField, sameDirection]));
});

test('反向包含不成立：类型 2 的 123 不包含类型 1 的 ABC123，不赋值、不锁定', () => {
  assertNotMatched(runPair('ABC123', '123'));
});

test('反向包含成立：类型 2 的 ABC123 包含类型 1 的 123，正确赋值和锁定', () => {
  assertMatched(runPair('123', 'ABC123'));
});

test('相反方向的 AND 条件换序后，命中、赋值和锁定结果一致', () => {
  for (const [type1Ref, type2Ref, matches] of [['ABC123', '123', false], ['123', 'ABC123', true]]) {
    const original = runPair(type1Ref, type2Ref);
    const reordered = runPair(type1Ref, type2Ref, [reverseContainsField, currencyField]);
    assert.deepEqual(original, reordered);
    (matches ? assertMatched : assertNotMatched)(original);
  }
});

test('反向等于也按自身类型读取不同字段，缺省操作符保留金额数值比较', () => {
  for (const op of [undefined, '等于']) {
    const rows = makeRows('ABC123', '123');
    Object.assign(rows[0], { CreditAmount: '1,000.00', DebitAmount: 7 });
    Object.assign(rows[1], { CreditAmount: 9, DebitAmount: 1000 });
    const fields = [currencyField, {
      leftType: 2, leftField: 'DebitAmount', op, rightType: 1, rightField: 'CreditAmount'
    }];
    const result = runC2Scenario(makeScenario(fields), rows);
    assertMatched({ rows, ...result, lockedRowIds: [...result.lockedRowIds].sort() });
  }
});

test('配对内同一类型的条件两端读取同一行，不借用另一类型的字段', () => {
  const rows = makeRows('ABC123', '123');
  Object.assign(rows[0], { Prefix: 'ABC', Suffix: '123' });
  Object.assign(rows[1], { Prefix: 'Z', Suffix: '9' });
  assert.equal(pairsMatch(...rows, [currencyField, {
    leftType: 1, leftField: 'CustomerRef', op: '包含', rightType: 1, rightField: 'Suffix'
  }]), true);
  assert.equal(pairsMatch(...rows, [currencyField, {
    leftType: 2, leftField: 'CustomerRef', op: '包含', rightType: 2, rightField: 'Prefix'
  }]), false);
});

test('第一条两侧同类型时保留左右候选行，仍允许单行自身匹配', () => {
  const fields = [{ leftType: 1, leftField: 'CustomerRef', op: '包含', rightType: 1, rightField: 'CustomerRef' }];
  assert.equal(pairsMatch({ CustomerRef: '123' }, { CustomerRef: 'ABC123' }, fields), false);
  const rows = [makeRows('ABC123', '123')[0]];
  const scenario = makeScenario(fields);
  scenario.config.billTypes.pop();
  scenario.config.markValue.type = 1;
  const result = runC2Scenario(scenario, rows);
  assert.equal(rows[0].ReconciliationId, 'MATCHED');
  assert.deepEqual([...result.lockedRowIds], ['type-1']);
  assert.equal(result.modifications.length, 1);
});

test('行可归属多个类型时，字段仍绑定当前配对的类型角色', () => {
  const rows = makeRows('ABC123', '123');
  rows.forEach((row) => { row._c2Types = [1, 2]; });
  assert.equal(pairsMatch(...rows, [currencyField, reverseContainsField]), false);
  rows[1].CustomerRef = 'XABC123';
  assert.equal(pairsMatch(...rows, [currencyField, reverseContainsField]), true);
});

test('引用配对之外的类型时不从现有候选借值，不误赋值或锁定', () => {
  for (const direction of [{ leftType: 3, rightType: 2 }, { leftType: 1, rightType: 3 }]) {
    const rows = makeRows('ABC123', '123');
    const scenario = makeScenario([currencyField, { ...reverseContainsField, ...direction }]);
    scenario.config.billTypes.push({ seq: 3, field: 'Side', op: '等于', value: 'T' });
    rows.push({ _rowId: 'type-3', Side: 'T', Currency: 'USD', CustomerRef: 'ABC123', ReconciliationId: '' });
    const result = runC2Scenario(scenario, rows);
    assert.deepEqual(rows.map((row) => row.ReconciliationId), ['', '', '']);
    assert.deepEqual(result.modifications, []);
    assert.equal(result.lockedRowIds.size, 0);
  }
});

test('反向条件未命中后，两行仍可被后续场景处理，命中归属和行数守恒', () => {
  const rows = makeRows('ABC123', '123');
  const first = makeScenario();
  const fallback = makeScenario([currencyField]);
  fallback.id = 230;
  fallback.name = '后续场景';
  fallback.priority = 1;
  fallback.config.markValue.value = 'FALLBACK';
  const result = runAllScenarios(rows, [], [first, fallback]);
  assert.deepEqual(rows.map((row) => row.ReconciliationId), ['', 'FALLBACK']);
  assert.deepEqual(result.modifiedRows.map((row) => row._hitScenarioId), [230, 230]);
  assert.deepEqual(result.modifications.map((mod) => [mod.rowId, mod.scenarioId]), [['type-2', 230]]);
  assert.equal(result.modifiedRows.length + result.unmatchedRows.length, rows.length);
  assert.equal(result.stats.scenarioHitCount, 1);
  assert.deepEqual(result.errorReport, []);
});
