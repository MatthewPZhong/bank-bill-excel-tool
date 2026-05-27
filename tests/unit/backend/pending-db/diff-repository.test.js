const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  createRun,
  updateRunStats,
  getRunById,
  listAllRuns,
  listRunsForMonthPair,
  getLatestRunForMonthPair,
  listDiffRows
} = require('../../../../src/backend/pending-db/diff-repository');
const { runMigrations } = require('../../../../src/backend/pending-db/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('createRun', () => {
  test('返回新 run id', () => {
    const id = createRun(db, {
      upperMonth: '2026-05',
      lowerMonth: '2026-04',
      ruleSnapshot: { matchFields: ['a'] }
    });
    assert.ok(id > 0);
  });

  test('ruleSnapshot 缺失 → 序列化为 {}', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04' });
    const r = getRunById(db, id);
    assert.deepEqual(r.ruleSnapshot, {});
  });
});

test.describe('updateRunStats', () => {
  test('更新 stat_new / missing / changed', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    updateRunStats(db, id, { statNew: 10, statMissing: 5, statChanged: 3 });
    const r = getRunById(db, id);
    assert.equal(r.statNew, 10);
    assert.equal(r.statMissing, 5);
    assert.equal(r.statChanged, 3);
  });

  test('非数字 → 0 兜底', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    updateRunStats(db, id, { statNew: 'abc', statMissing: null, statChanged: NaN });
    const r = getRunById(db, id);
    assert.equal(r.statNew, 0);
    assert.equal(r.statMissing, 0);
    assert.equal(r.statChanged, 0);
  });
});

test.describe('getRunById', () => {
  test('已存在 run → 返回对象', () => {
    const id = createRun(db, {
      upperMonth: '2026-05',
      lowerMonth: '2026-04',
      ruleSnapshot: { a: 1 }
    });
    const r = getRunById(db, id);
    assert.equal(r.id, id);
    assert.equal(r.upperMonth, '2026-05');
    assert.deepEqual(r.ruleSnapshot, { a: 1 });
  });

  test('不存在 → null', () => {
    assert.equal(getRunById(db, 9999), null);
  });

  test('ruleSnapshot 非 JSON → null（不抛错）', () => {
    db.prepare(`INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
                VALUES (?, ?, ?, ?, 0, 0, 0)`).run('2026-05', '2026-04', 'not-json', new Date().toISOString());
    const id = db.prepare(`SELECT id FROM diff_runs LIMIT 1`).get().id;
    const r = getRunById(db, id);
    assert.equal(r.ruleSnapshot, null);
  });
});

test.describe('listAllRuns / listRunsForMonthPair / getLatestRunForMonthPair', () => {
  test('listAllRuns 按 createdAt DESC 排', async () => {
    createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    await new Promise((r) => setTimeout(r, 5));
    createRun(db, { upperMonth: '2026-06', lowerMonth: '2026-05', ruleSnapshot: {} });
    const r = listAllRuns(db);
    assert.equal(r.length, 2);
    // 第二个晚 → 排前
    assert.equal(r[0].upperMonth, '2026-06');
  });

  test('listRunsForMonthPair 过滤指定月对', () => {
    createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    createRun(db, { upperMonth: '2026-06', lowerMonth: '2026-05', ruleSnapshot: {} });
    const r = listRunsForMonthPair(db, '2026-05', '2026-04');
    assert.equal(r.length, 1);
  });

  test('getLatestRunForMonthPair 返回最新一条', async () => {
    createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: { v: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    const id2 = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: { v: 2 } });
    const r = getLatestRunForMonthPair(db, '2026-05', '2026-04');
    assert.equal(r.id, id2);
  });

  test('getLatestRunForMonthPair 无 run → null', () => {
    assert.equal(getLatestRunForMonthPair(db, '2026-05', '2026-04'), null);
  });

  test('listAllRuns 空 → []', () => {
    assert.deepEqual(listAllRuns(db), []);
  });
});

test.describe('listDiffRows', () => {
  function insertDiffRow(runId, type, upperRowId = null, lowerRowId = null) {
    db.prepare(`INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id) VALUES (?, ?, ?, ?)`)
      .run(runId, type, upperRowId, lowerRowId);
  }

  test('返回该 run 全部 diff_rows', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    insertDiffRow(id, 'new', 1, null);
    insertDiffRow(id, 'missing', null, 2);
    insertDiffRow(id, 'changed', 3, 4);
    const r = listDiffRows(db, id);
    assert.equal(r.length, 3);
  });

  test('按 type 过滤', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    insertDiffRow(id, 'new', 1, null);
    insertDiffRow(id, 'missing', null, 2);
    const r = listDiffRows(db, id, 'new');
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'new');
  });

  test('upperRowId / lowerRowId 数字化', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    insertDiffRow(id, 'new', 10, null);
    const r = listDiffRows(db, id);
    assert.equal(r[0].upperRowId, 10);
    assert.equal(r[0].lowerRowId, null);
  });

  test('空 run → []', () => {
    const id = createRun(db, { upperMonth: '2026-05', lowerMonth: '2026-04', ruleSnapshot: {} });
    assert.deepEqual(listDiffRows(db, id), []);
  });
});
