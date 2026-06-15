// v3.0.5 PR-3（Part B Phase 1）— runs.side_db_rel_path 列 migration 幂等单测
//   覆盖：首次加列 / 重复调用 no-op（幂等）/ 老 runs 行 side_db_rel_path 默认 NULL（双源过渡）

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureAcquiringBillCurrencyTablesSupport,
  ensureAcquiringBillCurrencyRunsSideDbPath,
  hasColumn,
} = require('../../../../src/backend/database/migrations');

let db;
test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureAcquiringBillCurrencyTablesSupport(db);
});
test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test('首次调用加 side_db_rel_path 列', () => {
  assert.equal(hasColumn(db, 'acquiring_bill_currency_runs', 'side_db_rel_path'), false, '前置：列不存在');
  ensureAcquiringBillCurrencyRunsSideDbPath(db);
  assert.equal(hasColumn(db, 'acquiring_bill_currency_runs', 'side_db_rel_path'), true, '列已加');
});

test('重复调用幂等 no-op（不抛错、列不重复）', () => {
  ensureAcquiringBillCurrencyRunsSideDbPath(db);
  // 第二次调用不应抛 "duplicate column" 错
  assert.doesNotThrow(() => ensureAcquiringBillCurrencyRunsSideDbPath(db));
  const cols = db.prepare("PRAGMA table_info(acquiring_bill_currency_runs)").all();
  const sideCols = cols.filter((c) => c.name === 'side_db_rel_path');
  assert.equal(sideCols.length, 1, 'side_db_rel_path 列唯一');
});

test('老 runs 行加列后 side_db_rel_path 默认 NULL（双源：NULL=历史主库 run）', () => {
  // 先插一条「老」run 行（迁移前）
  db.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES ('2026-01',10,8,2,0,'success')`).run();
  ensureAcquiringBillCurrencyRunsSideDbPath(db);
  const row = db.prepare("SELECT side_db_rel_path FROM acquiring_bill_currency_runs WHERE month_key='2026-01'").get();
  assert.equal(row.side_db_rel_path, null, '老 run 行 side_db_rel_path=NULL（双源过渡，读主库旧表）');
});

test('新 run 行可写入 side_db_rel_path（侧库 run 标识）', () => {
  ensureAcquiringBillCurrencyRunsSideDbPath(db);
  db.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status, side_db_rel_path) VALUES ('2026-03',5,3,2,0,'success',?)`)
    .run('run-data/acquiring-bill-currency/month-2026-03.sqlite');
  const row = db.prepare("SELECT side_db_rel_path FROM acquiring_bill_currency_runs WHERE month_key='2026-03'").get();
  assert.equal(row.side_db_rel_path, 'run-data/acquiring-bill-currency/month-2026-03.sqlite');
});
