const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { RULE_GLOBAL_ID, getRule, upsertRule } = require('../../../../src/backend/pending-db/rule-repository');
const { runMigrations } = require('../../../../src/backend/pending-db/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('常量', () => {
  test('RULE_GLOBAL_ID = __GLOBAL__', () => {
    assert.equal(RULE_GLOBAL_ID, '__GLOBAL__');
  });
});

test.describe('getRule', () => {
  test('空 DB → null', () => {
    assert.equal(getRule(db), null);
  });

  test('upsert 后能 get', () => {
    upsertRule(db, { matchFields: ['recon_id'], compareFields: ['财务BU'] });
    const r = getRule(db);
    assert.deepEqual(r.matchFields, ['recon_id']);
    assert.deepEqual(r.compareFields, ['财务BU']);
    assert.ok(r.updatedAt);
  });
});

test.describe('upsertRule', () => {
  test('INSERT 新规则', () => {
    upsertRule(db, { matchFields: ['a'], compareFields: ['b'] });
    const r = getRule(db);
    assert.deepEqual(r.matchFields, ['a']);
  });

  test('UPDATE 已有规则（id 固定 __GLOBAL__）', () => {
    upsertRule(db, { matchFields: ['a'], compareFields: ['b'] });
    upsertRule(db, { matchFields: ['c'], compareFields: ['d'] });
    const r = getRule(db);
    assert.deepEqual(r.matchFields, ['c']);
    assert.deepEqual(r.compareFields, ['d']);
  });

  test('过滤非字符串 / 空串', () => {
    upsertRule(db, {
      matchFields: ['a', '', null, 123, 'b'],
      compareFields: ['x']
    });
    const r = getRule(db);
    assert.deepEqual(r.matchFields, ['a', 'b']);
  });

  test('payload 缺字段 → 空数组', () => {
    upsertRule(db, {});
    const r = getRule(db);
    assert.deepEqual(r.matchFields, []);
    assert.deepEqual(r.compareFields, []);
  });

  test('payload 缺省 → 空数组', () => {
    upsertRule(db);
    const r = getRule(db);
    assert.deepEqual(r.matchFields, []);
  });

  test('matchFields 非数组 → 当空数组', () => {
    upsertRule(db, { matchFields: 'not array', compareFields: ['x'] });
    const r = getRule(db);
    assert.deepEqual(r.matchFields, []);
  });

  test('返回值 = 实际落库值', () => {
    const r = upsertRule(db, { matchFields: ['a'], compareFields: ['b'] });
    assert.deepEqual(r.matchFields, ['a']);
    assert.deepEqual(r.compareFields, ['b']);
    assert.ok(r.updatedAt);
  });
});

test.describe('parseJsonArray 兜底（DB 内非法 JSON）', () => {
  test('match_fields 非法 JSON → 空数组', () => {
    // 直接写入非法 JSON
    db.prepare(`INSERT INTO rule (id, match_fields, compare_fields, updated_at) VALUES (?, ?, ?, ?)`)
      .run(RULE_GLOBAL_ID, 'not-json', '[]', new Date().toISOString());
    const r = getRule(db);
    assert.deepEqual(r.matchFields, []);
  });

  test('match_fields 是 object → 空数组（非 array）', () => {
    db.prepare(`UPDATE rule SET match_fields = ? WHERE id = ?`).run(JSON.stringify({}), RULE_GLOBAL_ID);
    db.prepare(`INSERT OR IGNORE INTO rule (id, match_fields, compare_fields, updated_at) VALUES (?, ?, ?, ?)`)
      .run(RULE_GLOBAL_ID, JSON.stringify({ a: 1 }), '[]', new Date().toISOString());
    const r = getRule(db);
    if (r) assert.deepEqual(r.matchFields, []);
  });
});
