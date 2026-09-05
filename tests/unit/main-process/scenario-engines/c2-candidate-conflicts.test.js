'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runC2Scenario } = require('../../../../src/main-process/scenario-engines/c2-offset-bill-mark');
const { runAllScenarios } = require('../../../../src/main-process/scenario-dispatcher');

const containsField = { leftType: 1, leftField: 'CustomerRef', op: '包含', rightType: 2, rightField: 'CustomerRef' };
const currencyField = { leftType: 1, leftField: 'Currency', op: '等于', rightType: 2, rightField: 'Currency' };

function makeScenario(reconFields = [containsField]) {
  return {
    id: 229,
    name: '包含交叉候选',
    category: 'offset-bill-mark',
    enabled: true,
    priority: 10,
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

function row(id, ref) {
  return { _rowId: id, Side: id[0], Currency: 'USD', CustomerRef: ref, ReconciliationId: '' };
}

function overlappingRows() {
  return [row('L1', 'ABC123'), row('L2', 'XYZ123'), row('R1', '123'), row('R2', 'ABC')];
}

function assertUnchanged(result, rows, before) {
  assert.deepEqual(result.modifications, []);
  assert.deepEqual([...result.lockedRowIds], []);
  assert.deepEqual(rows, before);
}

test('交叉候选完整计数：一对多左行仍构成右行的多对一，不赋值、不锁定', () => {
  const rows = overlappingRows();
  const before = structuredClone(rows);
  const result = runC2Scenario(makeScenario(), rows);
  assertUnchanged(result, rows, before);
  assert.deepEqual(result.warnings.map((warning) => [warning.rowId, warning.code]), [
    ['L1', 'one-to-many'], ['R1', 'many-to-one']
  ]);
  assert.deepEqual(result.warnings[0].matchedRowIds, ['R1', 'R2']);
});

test('交叉候选下反向 AND 条件换序，不改变赋值与锁定对象', () => {
  const initial = [row('L1', '123'), row('L2', 'ABC'), row('R1', 'XYZ123'), row('R2', 'ABC123')];
  const reverseContains = { ...containsField, leftType: 2, rightType: 1 };
  const outcomes = [
    [currencyField, reverseContains], [reverseContains, currencyField]
  ].map((fields) => {
    const rows = structuredClone(initial);
    const result = runC2Scenario(makeScenario(fields), rows);
    return { rows, modifications: result.modifications, lockedRowIds: [...result.lockedRowIds].sort() };
  });
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0], { rows: initial, modifications: [], lockedRowIds: [] });
});

test('交叉歧义不妨碍独立合法配对，只修改并锁定独立配对的行', () => {
  const rows = [...overlappingRows(), row('L3', 'SAFE-XYZ789'), row('R3', 'XYZ789')];
  const before = structuredClone(rows);
  const result = runC2Scenario(makeScenario(), rows);
  assert.deepEqual(result.modifications, [{ rowId: 'R3', column: 'ReconciliationId', oldValue: '', newValue: 'MATCHED' }]);
  assert.deepEqual([...result.lockedRowIds].sort(), ['L3', 'R3']);
  assert.deepEqual(rows.slice(0, 4), before.slice(0, 4));
  assert.equal(rows[5].ReconciliationId, 'MATCHED');
  assert.deepEqual(result.warnings.map((warning) => [warning.rowId, warning.code]), [
    ['L1', 'one-to-many'], ['R1', 'many-to-one']
  ]);
});

test('独立合法配对赋值同值时仍锁定双方，交叉歧义仍不锁定', () => {
  const rows = [...overlappingRows(), row('L3', 'SAFE-XYZ789'), row('R3', 'XYZ789')];
  rows[5].ReconciliationId = 'MATCHED';
  const before = structuredClone(rows);
  const result = runC2Scenario(makeScenario(), rows);
  assert.deepEqual(result.modifications, []);
  assert.deepEqual([...result.lockedRowIds].sort(), ['L3', 'R3']);
  assert.deepEqual(rows, before);
  assert.equal(result.warnings.length, 2);
});

test('交叉歧义保留后续场景处理资格，命中归属、异常来源和行数可追溯', () => {
  const rows = [...overlappingRows(), row('L3', 'SAFE-XYZ789'), row('R3', 'XYZ789')];
  const first = makeScenario();
  const fallback = makeScenario([]);
  fallback.id = 230;
  fallback.name = '后续赋值';
  fallback.priority = 1;
  fallback.config.markValue.value = 'FALLBACK';
  const result = runAllScenarios(rows, [], [first, fallback]);
  assert.deepEqual(result.modifiedRows.map((item) => [item._rowId, item._hitScenarioId]).sort(), [
    ['L3', 229], ['R1', 230], ['R2', 230], ['R3', 229]
  ]);
  assert.deepEqual(result.unmatchedRows.map((item) => item._rowId).sort(), ['L1', 'L2']);
  assert.deepEqual(result.modifications.map((item) => [item.rowId, item.newValue]).sort(), [
    ['R1', 'FALLBACK'], ['R2', 'FALLBACK'], ['R3', 'MATCHED']
  ]);
  assert.deepEqual(result.errorReport.map((warning) => [warning.scenarioId, warning.rowId, warning.code]), [
    [229, 'L1', 'one-to-many'], [229, 'R1', 'many-to-one']
  ]);
  assert.equal(result.modifiedRows.length + result.unmatchedRows.length, rows.length);
});

test('3×3 全部 512 种候选关系：只执行无共享端点的配对，条件和输入行换序、左右赋值均一致', () => {
  const reverseCurrency = { ...currencyField, leftType: 2, rightType: 1 };
  for (let mask = 0; mask < 512; mask += 1) {
    // 用互不包含的 token 表达每条边，期望来自候选图本身，不调用匹配实现。
    const edges = [];
    for (let left = 0; left < 3; left += 1) {
      for (let right = 0; right < 3; right += 1) {
        if (mask & (1 << (left * 3 + right))) edges.push([left, right]);
      }
    }
    const isolated = edges.filter(([left, right]) => edges.every(([otherLeft, otherRight]) =>
      (left === otherLeft && right === otherRight) || (left !== otherLeft && right !== otherRight)));
    const expectedLocked = isolated.flatMap(([left, right]) => [`L${left}`, `R${right}`]).sort();
    const initial = [0, 1, 2].map((left) => row(`L${left}`, edges
      .filter(([candidate]) => candidate === left).map(([, right]) => `@r${right}@`).join(' ')))
      .concat([0, 1, 2].map((right) => row(`R${right}`, `@r${right}@`)));
    for (const fields of [[containsField, reverseCurrency], [reverseCurrency, containsField]]) {
      for (const reverseRows of [false, true]) {
        for (const targetType of [1, 2]) {
          const label = `候选图 ${mask}，起始类型 ${fields[0].leftType}，倒序 ${reverseRows}，赋值类型 ${targetType}`;
          const rows = structuredClone(reverseRows ? [...initial].reverse() : initial);
          const scenario = makeScenario(fields);
          scenario.config.markValue.type = targetType;
          const result = runC2Scenario(scenario, rows);
          const expectedModified = isolated.map(([left, right]) => targetType === 1 ? `L${left}` : `R${right}`).sort();
          assert.deepEqual([...result.lockedRowIds].sort(), expectedLocked, label);
          assert.deepEqual(result.modifications.map((mod) => mod.rowId).sort(), expectedModified, label);
          assert.deepEqual(rows, (reverseRows ? [...initial].reverse() : initial).map((item) => ({
            ...item, ReconciliationId: expectedModified.includes(item._rowId) ? 'MATCHED' : ''
          })), label);
          const expectedWarnings = [];
          for (const index of [0, 1, 2]) {
            if (edges.filter(([left]) => left === index).length > 1) {
              expectedWarnings.push([`L${index}`, fields[0].leftType === 1 ? 'one-to-many' : 'many-to-one']);
            }
            if (edges.filter(([, right]) => right === index).length > 1) {
              expectedWarnings.push([`R${index}`, fields[0].leftType === 2 ? 'one-to-many' : 'many-to-one']);
            }
          }
          assert.deepEqual(result.warnings.map((warning) => [warning.rowId, warning.code]).sort(), expectedWarnings.sort(), label);
        }
      }
    }
  }
});
