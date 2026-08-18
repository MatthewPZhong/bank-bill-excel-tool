// v2.1.11 T2 — migration 幂等 + 2 新表/索引存在性
//   覆盖：removed_pending_rows + pending_removal_matches 建表/索引；跑 2 次不报错；不动现有表。

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../../../src/backend/pending-db/migrations');

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function indexExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name);
  return !!row;
}

function triggerExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?").get(name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

let db;
test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
});
test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('migration — removed_pending_rows / pending_removal_matches', () => {
  test('单次 runMigrations 后 2 新表存在', () => {
    runMigrations(db);
    assert.ok(tableExists(db, 'removed_pending_rows'), 'removed_pending_rows 应存在');
    assert.ok(tableExists(db, 'pending_removal_matches'), 'pending_removal_matches 应存在');
  });

  test('removed_pending_rows 列齐全（raw_json + 6 索引列 + 元信息）', () => {
    runMigrations(db);
    const cols = columnNames(db, 'removed_pending_rows');
    for (const c of [
      'id', 'year_month', 'source_file', 'raw_json',
      'order_no', 'recon_id', '金额', 'channel', 'merchant_id', 'bank_ref',
      'created_at'
    ]) {
      assert.ok(cols.includes(c), `removed_pending_rows 应含列 ${c}`);
    }
  });

  test('pending_removal_matches 列齐全', () => {
    runMigrations(db);
    const cols = columnNames(db, 'pending_removal_matches');
    for (const c of ['id', 'run_id', 'diff_row_id', 'removed_row_id', 'match_field', 'created_at']) {
      assert.ok(cols.includes(c), `pending_removal_matches 应含列 ${c}`);
    }
  });

  test('索引存在', () => {
    runMigrations(db);
    assert.ok(indexExists(db, 'idx_removed_ym'));
    assert.ok(indexExists(db, 'idx_removed_order'));
    assert.ok(indexExists(db, 'idx_removed_recon'));
    assert.ok(indexExists(db, 'idx_prm_run'));
  });

  test('Archive lineage additive 列、removed head、receipt 唯一索引与 rollback triggers 存在', () => {
    runMigrations(db);
    for (const column of [
      'dataset_id', 'producer_task_run_id', 'dataset_version', 'archive_contract_version'
    ]) {
      assert.ok(columnNames(db, 'pending_months').includes(column));
    }
    for (const column of [
      'archive_contract_version', 'archive_task_run_id', 'archive_terminal_ack_at'
    ]) {
      assert.ok(columnNames(db, 'diff_runs').includes(column));
    }
    assert.ok(tableExists(db, 'pending_removed_months'));
    assert.ok(indexExists(db, 'idx_pending_months_dataset'));
    assert.ok(indexExists(db, 'idx_diff_runs_archive_task'));
    assert.ok(triggerExists(db, 'invalidate_pending_month_v1_on_legacy_update'));
    assert.ok(triggerExists(db, 'invalidate_pending_removed_head_on_insert'));
    assert.ok(triggerExists(db, 'invalidate_pending_removed_head_on_update'));
    assert.ok(triggerExists(db, 'invalidate_pending_removed_head_on_delete'));
  });

  test('幂等：连跑 2 次不报错，表/索引仍在', () => {
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db));
    assert.ok(tableExists(db, 'removed_pending_rows'));
    assert.ok(tableExists(db, 'pending_removal_matches'));
    assert.ok(indexExists(db, 'idx_removed_ym'));
    assert.ok(indexExists(db, 'idx_prm_run'));
  });

  test('幂等：第 2 次跑不清空已插入数据', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO removed_pending_rows (year_month, source_file, raw_json, order_no, recon_id, \`金额\`, channel, merchant_id, bank_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('2026-04', 'f.xlsx', '{}', 'O1', 'R1', '1.00', 'C1', 'M1', 'B1', new Date().toISOString());
    runMigrations(db);
    const n = db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows').get().n;
    assert.equal(n, 1);
  });

  test('不破坏现有表（pending_rows / diff_rows / diff_runs / rule / pending_months 仍建出）', () => {
    runMigrations(db);
    for (const t of ['rule', 'pending_months', 'pending_rows', 'diff_runs', 'diff_rows']) {
      assert.ok(tableExists(db, t), `${t} 应存在`);
    }
  });
});
