const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  countRowsInMonth,
  getMonthMeta,
  listMonths,
  upsertMonthMeta,
  deleteMonth,
  createRowInserter
} = require('../../../../src/backend/pending-db/month-repository');
const { runMigrations } = require('../../../../src/backend/pending-db/migrations');
const PENDING_COLUMNS = require('../../../../src/backend/pending-db/columns');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('countRowsInMonth', () => {
  test('空月 → 0', () => {
    assert.equal(countRowsInMonth(db, '2026-05'), 0);
  });

  test('插入 N 行后 → N', () => {
    const ins = createRowInserter(db);
    const cells = PENDING_COLUMNS.map((_, i) => `v${i}`);
    ins('2026-05', 'h1', cells);
    ins('2026-05', 'h2', cells.map((c) => c + '-2'));
    assert.equal(countRowsInMonth(db, '2026-05'), 2);
  });

  test('count 仅限指定月', () => {
    const ins = createRowInserter(db);
    const cells = PENDING_COLUMNS.map((_, i) => `v${i}`);
    ins('2026-05', 'h1', cells);
    ins('2026-04', 'h2', cells.map((c) => c + '-2'));
    assert.equal(countRowsInMonth(db, '2026-05'), 1);
  });
});

test.describe('upsertMonthMeta / getMonthMeta', () => {
  test('upsert 后 getMonthMeta', () => {
    upsertMonthMeta(db, {
      yearMonth: '2026-05',
      rowCount: 100,
      sourceFiles: ['a.xlsx', 'b.xlsx'],
      archivePath: '/path/to/archive'
    });
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.yearMonth, '2026-05');
    assert.equal(r.rowCount, 100);
    assert.deepEqual(r.sourceFiles, ['a.xlsx', 'b.xlsx']);
    assert.equal(r.archivePath, '/path/to/archive');
    assert.ok(r.importedAt);
  });

  test('未 upsert 的月 → null', () => {
    assert.equal(getMonthMeta(db, '2026-05'), null);
  });

  test('upsert 已有月 → 覆盖（ON CONFLICT）', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 100, sourceFiles: [] });
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 200, sourceFiles: ['x'] });
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.rowCount, 200);
    assert.deepEqual(r.sourceFiles, ['x']);
  });

  test('sourceFiles 非数组 → 空数组', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 0, sourceFiles: 'not array' });
    const r = getMonthMeta(db, '2026-05');
    assert.deepEqual(r.sourceFiles, []);
  });

  test('archivePath 缺失 → null', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 0, sourceFiles: [] });
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.archivePath, null);
  });

  test('rowCount 非数字 → 0', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 'abc', sourceFiles: [] });
    const r = getMonthMeta(db, '2026-05');
    assert.equal(r.rowCount, 0);
  });
});

test.describe('listMonths', () => {
  test('空 → []', () => {
    assert.deepEqual(listMonths(db), []);
  });

  test('多月按倒序排列', () => {
    upsertMonthMeta(db, { yearMonth: '2026-03', rowCount: 0, sourceFiles: [] });
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 0, sourceFiles: [] });
    upsertMonthMeta(db, { yearMonth: '2026-04', rowCount: 0, sourceFiles: [] });
    assert.deepEqual(listMonths(db), ['2026-05', '2026-04', '2026-03']);
  });
});

test.describe('deleteMonth', () => {
  test('删除月份 + 行数据', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 1, sourceFiles: [] });
    const ins = createRowInserter(db);
    ins('2026-05', 'h1', PENDING_COLUMNS.map((_, i) => `v${i}`));

    deleteMonth(db, '2026-05');
    assert.equal(getMonthMeta(db, '2026-05'), null);
    assert.equal(countRowsInMonth(db, '2026-05'), 0);
  });

  test('删除月份 + 引用 diff_runs / diff_rows', () => {
    upsertMonthMeta(db, { yearMonth: '2026-05', rowCount: 0, sourceFiles: [] });
    db.prepare(`INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
                VALUES (?, ?, '{}', ?, 0, 0, 0)`)
      .run('2026-05', '2026-04', new Date().toISOString());
    const runId = db.prepare(`SELECT id FROM diff_runs LIMIT 1`).get().id;
    db.prepare(`INSERT INTO diff_rows (run_id, type) VALUES (?, 'new')`).run(runId);

    deleteMonth(db, '2026-05');
    // 引用到的 diff_runs / diff_rows 应被清掉
    const runs = db.prepare('SELECT COUNT(*) AS n FROM diff_runs').get().n;
    const rows = db.prepare('SELECT COUNT(*) AS n FROM diff_rows').get().n;
    assert.equal(runs, 0, '资金红线：引用到该月的 diff_runs 必须清理');
    assert.equal(rows, 0, '资金红线：引用到该月的 diff_rows 必须清理');
  });
});

test.describe('createRowInserter', () => {
  test('插入 31 列 cells → 成功', () => {
    const ins = createRowInserter(db);
    const cells = PENDING_COLUMNS.map((_, i) => `v${i}`);
    ins('2026-05', 'h1', cells);
    assert.equal(countRowsInMonth(db, '2026-05'), 1);
  });

  test('cells 长度不对 → 抛错', () => {
    const ins = createRowInserter(db);
    assert.throws(() => ins('2026-05', 'h1', ['too', 'short']), /长度必须为 31/);
  });

  test('cells 非数组 → 抛错', () => {
    const ins = createRowInserter(db);
    assert.throws(() => ins('2026-05', 'h1', 'not array'), /长度必须为/);
  });

  test('UNIQUE row_hash + year_month 约束', () => {
    const ins = createRowInserter(db);
    const cells = PENDING_COLUMNS.map((_, i) => `v${i}`);
    ins('2026-05', 'h1', cells);
    assert.throws(() => ins('2026-05', 'h1', cells), /UNIQUE|already exists|constraint/i);
  });
});
