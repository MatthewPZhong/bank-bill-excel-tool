'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { pairsMatch, runC2Scenario } = require('../../../../src/main-process/scenario-engines/c2-offset-bill-mark');
const repo = require('../../../../src/backend/database/scenarios-repository');
const { serializeScenarioBundle, parseScenarioBundle } = require('../../../../src/backend/scenarios-bundle-io');

function config(op = '包含') {
  return {
    billTypes: [
      { seq: 1, field: 'Side', op: '等于', value: 'L' },
      { seq: 2, field: 'Side', op: '等于', value: 'R' }
    ],
    reconFields: [{ seq: 1, leftType: 1, leftField: 'Ref', op, rightType: 2, rightField: 'Ref' }],
    markValue: { type: 2, field: 'FundType', value: '已匹配' }
  };
}

test('包含：左向右、trim、大小写、空值与 0，金额名也按字面子串', () => {
  const cases = [
    [' ABC123 ', '123', true], ['123', 'ABC123', false],
    ['ABC123', 'ABC123', true], ['ABC123', 'abc', false],
    ['ABC123', '', false], ['', '', false], [null, 'A', false],
    ['ABC123', undefined, false], [' ', ' ', false],
    [100, 0, true], [0, 0, true], ['1,000', '1000', false],
    ['ABC123', '.*', false], ['001', '01', true]
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(pairsMatch({ Amount: left }, { Amount: right }, [
      { leftField: 'Amount', op: '包含', rightField: 'Amount' }
    ]), expected, `${left} 包含 ${right}`);
  }
});

test('等于兼容金额数值、普通字符串和缺省 op；混用仍需 AND', () => {
  const fields = [
    { leftField: 'Ref', rightField: 'Ref', op: '包含' },
    { leftField: 'Amount', rightField: 'Amount', op: '等于' }
  ];
  assert.equal(pairsMatch({ Ref: 'ABC123', Amount: '1,000.00' }, { Ref: '123', Amount: 1000 }, fields), true);
  assert.equal(pairsMatch({ Ref: 'ABC123', Amount: 1001 }, { Ref: '123', Amount: 1000 }, fields), false);
  assert.equal(pairsMatch({ Ref: '001' }, { Ref: '1' }, [{ leftField: 'Ref', rightField: 'Ref' }]), false);
  assert.equal(pairsMatch({ Ref: '' }, { Ref: '' }, [{ leftField: 'Ref', rightField: 'Ref' }]), true);
});

test('包含唯一配对保留双方锁定和仅实际修改记录；多候选继续告警跳过', () => {
  const run = (rows) => runC2Scenario({ id: 1, name: '包含赋值', config: config() }, rows);
  const rows = [{ _rowId: 'l', Side: 'L', Ref: 'ABC123' }, { _rowId: 'r', Side: 'R', Ref: '123' }];
  const result = run(rows);
  assert.equal(rows[1].FundType, '已匹配');
  assert.deepEqual([...result.lockedRowIds].sort(), ['l', 'r']);
  assert.equal(result.modifications.length, 1);
  assert.equal(result.modifications[0].rowId, 'r');
  const manyRight = run([
    { Side: 'L', Ref: 'ABC123' }, { Side: 'R', Ref: '123' }, { Side: 'R', Ref: 'ABC' }
  ]);
  assert.equal(manyRight.modifications.length, 0);
  assert.ok(manyRight.warnings.some((w) => w.code === 'one-to-many'));
  const manyLeft = run([
    { Side: 'L', Ref: 'ABC123' }, { Side: 'L', Ref: 'XYZ123' }, { Side: 'R', Ref: '123' }
  ]);
  assert.equal(manyLeft.modifications.length, 0);
  assert.ok(manyLeft.warnings.some((w) => w.code === 'many-to-one'));
});

test('显式非法 op 在分类前拒绝，不能产生锁定或赋值', () => {
  for (const op of ['', null, '不等于', 'contains', 0]) {
    const rows = [{ Side: 'L', Ref: 'A' }, { Side: 'R', Ref: 'A' }];
    const before = structuredClone(rows);
    const result = runC2Scenario({ id: 1, name: '非法操作符', config: config(op) }, rows);
    assert.deepEqual(rows, before);
    assert.equal(result.lockedRowIds.size, 0);
    assert.deepEqual(result.modifications, []);
    assert.ok(result.warnings.some((w) => w.code === 'invalid-config'));
  }
});

test('C2 仓储补缺省幂等、CRUD 拒绝非法 op；bundle 往返保留包含', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE scenarios (
    id INTEGER PRIMARY KEY, category TEXT, name TEXT, priority INTEGER, enabled INTEGER,
    config_json TEXT, is_builtin INTEGER, channel_id INTEGER, created_at TEXT, updated_at TEXT
  )`);
  const legacy = config();
  delete legacy.reconFields[0].op;
  const normalized = repo.normalizeC2Config(legacy);
  assert.equal(normalized.reconFields[0].op, '等于');
  assert.deepEqual(repo.normalizeC2Config(normalized), normalized);
  assert.equal(legacy.reconFields[0].op, undefined);
  const payload = { category: 'offset-bill-mark', name: '包含', priority: 1, enabled: true, channelId: 1, config: config() };
  const { id } = repo.createScenario(db, payload);
  assert.equal(repo.getScenario(db, id).config.reconFields[0].op, '包含');
  for (const op of ['', null, '不等于']) {
    assert.throws(() => repo.createScenario(db, { ...payload, name: '非法', config: config(op) }), /操作符/);
    assert.throws(() => repo.updateScenario(db, id, { config: config(op) }), /操作符/);
  }
  assert.equal(repo.getScenario(db, id).config.reconFields[0].op, '包含');
  const bundle = parseScenarioBundle(serializeScenarioBundle(
    [{ id: 1, name: '测试银行', ownerLocation: '上海', isBuiltin: 0 }],
    new Map([[1, [repo.getScenario(db, id)]]]), '3.2.6'
  ));
  assert.equal(bundle.channels[0].scenarios[0].configJson.reconFields[0].op, '包含');
  repo.updateScenario(db, id, { config: legacy });
  assert.equal(repo.getScenario(db, id).config.reconFields[0].op, '等于');
});
