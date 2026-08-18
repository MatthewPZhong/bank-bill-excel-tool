const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  countRowsInMonth,
  getMonthMeta,
  listMonths,
  upsertMonthMetaLegacy: upsertMonthMeta,
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

  // v2.1.11 Codex PR #55 Finding 1（🔴 对账数据污染红线）：
  //   覆盖导入某月 → 该月 removed_pending_rows + 关联 pending_removal_matches 必须一并清，
  //   否则旧归档残留 → reconcile handler countByMonth>0 自动复用旧归档给新 missing 标错状态。
  test('Finding 1：覆盖导入清该月 removed_pending_rows + 关联 pending_removal_matches', () => {
    const ym = '2026-05';
    const now = new Date().toISOString();

    // 该月：pending 行 + diff_run + diff_row + removed 行 + removal_match（全链路）
    upsertMonthMeta(db, { yearMonth: ym, rowCount: 1, sourceFiles: [] });
    const ins = createRowInserter(db);
    ins(ym, 'h1', PENDING_COLUMNS.map((_, i) => `v${i}`));

    db.prepare(`INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
                VALUES (?, ?, '{}', ?, 0, 1, 0)`)
      .run(ym, '2026-04', now);
    const runId = db.prepare('SELECT id FROM diff_runs LIMIT 1').get().id;
    const diffRowId = db.prepare(`INSERT INTO diff_rows (run_id, type, upper_row_id) VALUES (?, 'missing', 1)`)
      .run(runId).lastInsertRowid;

    const removedRowId = db.prepare(
      `INSERT INTO removed_pending_rows (year_month, source_file, raw_json, order_no, created_at)
       VALUES (?, ?, '{}', ?, ?)`
    ).run(ym, '移除归档.xlsx', 'O2', now).lastInsertRowid;

    db.prepare(
      `INSERT INTO pending_removal_matches (run_id, diff_row_id, removed_row_id, match_field, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(runId, Number(diffRowId), Number(removedRowId), 'order_no', now);

    // 前置校验：链路确实建立
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows WHERE year_month = ?').get(ym).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?').get(runId).n, 1);

    deleteMonth(db, ym);

    // 移除归档 + 核对匹配清空（Finding 1 修复点）
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows WHERE year_month = ?').get(ym).n, 0,
      'Finding 1 红线：覆盖导入该月 removed_pending_rows 必须清空（否则旧归档复用污染对账）'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches').get().n, 0,
      'Finding 1 红线：关联 pending_removal_matches 必须清空（避免 run 删后留孤儿）'
    );
    // 回归：现有 pending_rows / diff_rows / diff_runs / pending_months 仍清空
    assert.equal(countRowsInMonth(db, ym), 0, '回归：pending_rows 清空');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diff_rows').get().n, 0, '回归：diff_rows 清空');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diff_runs').get().n, 0, '回归：diff_runs 清空');
    assert.equal(getMonthMeta(db, ym), null, '回归：pending_months 清空');
  });

  test('Finding 1：删除顺序正确（先删 matches 再删 diff_runs，无孤儿残留）', () => {
    // 仅 removal_match 关联到 diff_run，但无对应 diff_row（构造「matches 必须先于 diff_runs 删」的纯净场景）
    const ym = '2026-06';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
                VALUES (?, ?, '{}', ?, 0, 0, 0)`)
      .run(ym, '2026-05', now);
    const runId = db.prepare('SELECT id FROM diff_runs LIMIT 1').get().id;
    db.prepare(
      `INSERT INTO pending_removal_matches (run_id, diff_row_id, removed_row_id, match_field, created_at)
       VALUES (?, 999, 888, 'order_no', ?)`
    ).run(runId, now);

    deleteMonth(db, ym);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches').get().n, 0,
      'Finding 1：run 删除前先按 run_id 子查询删 matches，不留孤儿'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diff_runs').get().n, 0, 'diff_runs 已清');
  });

  test('Finding 1：覆盖导入某月不影响其它月的 removed / matches', () => {
    const target = '2026-05';
    const other = '2026-04';
    const now = new Date().toISOString();

    // other 月：完整一条 removed + run + match，不应被 deleteMonth(target) 触及
    upsertMonthMeta(db, { yearMonth: other, rowCount: 0, sourceFiles: [] });
    db.prepare(`INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
                VALUES (?, ?, '{}', ?, 0, 0, 0)`)
      .run(other, '2026-03', now);
    const otherRunId = db.prepare('SELECT id FROM diff_runs LIMIT 1').get().id;
    db.prepare(
      `INSERT INTO removed_pending_rows (year_month, source_file, raw_json, order_no, created_at)
       VALUES (?, ?, '{}', ?, ?)`
    ).run(other, 'f.xlsx', 'X1', now);
    db.prepare(
      `INSERT INTO pending_removal_matches (run_id, diff_row_id, removed_row_id, match_field, created_at)
       VALUES (?, 1, 1, 'order_no', ?)`
    ).run(otherRunId, now);

    // target 月也放一条 removed（仅证明 target 被清、other 不动）
    db.prepare(
      `INSERT INTO removed_pending_rows (year_month, source_file, raw_json, order_no, created_at)
       VALUES (?, ?, '{}', ?, ?)`
    ).run(target, 'g.xlsx', 'Y1', now);

    deleteMonth(db, target);

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows WHERE year_month = ?').get(other).n, 1,
      '隔离：其它月 removed_pending_rows 不受影响'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?').get(otherRunId).n, 1,
      '隔离：其它月 pending_removal_matches 不受影响'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows WHERE year_month = ?').get(target).n, 0,
      'target 月 removed_pending_rows 已清'
    );
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
