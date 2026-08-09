'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AppDatabase } = require('../../../../src/backend/database');
const {
  FIRST_MONTH_DIAGNOSTIC_OPERATION,
  ensureVccFinancialOpStateModelSupport,
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');

function createDb(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function createLegacyStateDb(t) {
  const db = createDb(t);
  db.exec(`
    CREATE TABLE vcc_fin_op_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'calculated',
      input_revisions_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      archived_at TEXT
    );
    CREATE TABLE vcc_fin_op_opening_balances (
      target_month TEXT NOT NULL,
      subject TEXT NOT NULL,
      balances_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      initialization_note TEXT NOT NULL,
      initialized_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (target_month, subject)
    );
  `);
  return db;
}

function insertOpening(db, targetMonth, subject = 'PPHK') {
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES (?, ?, '{}', 'hash', '历史期初')
  `).run(targetMonth, subject);
}

function auditCount(db) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ?
  `).get(FIRST_MONTH_DIAGNOSTIC_OPERATION).row_count) || 0;
}

test('PR2 schema 首次建库与重复迁移均幂等', (t) => {
  const db = createDb(t);
  const first = ensureVccFinancialOpTablesSupport(db);
  const second = ensureVccFinancialOpTablesSupport(db);

  assert.equal(first.firstMonthDiagnostic.blocked, false);
  assert.equal(second.firstMonthDiagnostic.blocked, false);
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name));
  assert.equal(tables.has('vcc_fin_op_module_state'), true);
  assert.equal(tables.has('vcc_fin_op_run_adjustments'), true);
  assert.equal(tables.has('vcc_fin_op_operation_audit'), true);
  const runColumns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_runs)').all().map((row) => row.name)
  );
  assert.equal(runColumns.has('result_revision'), true);
  assert.equal(runColumns.has('updated_at'), true);
  assert.equal(runColumns.has('input_fingerprint'), true);
  assert.deepEqual(
    { ...db.prepare('SELECT singleton_id, first_month FROM vcc_fin_op_module_state').get() },
    { singleton_id: 1, first_month: null }
  );
  assert.equal(auditCount(db), 0);
});

test('存量单一期初月份回填 first_month 且运行列兼容旧表', (t) => {
  const db = createLegacyStateDb(t);
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      id, target_month, status, input_revisions_json, created_at, archived_at
    ) VALUES (1, '2026-05', 'archived', '{}', '2026-06-01 08:00:00', '2026-06-02 09:00:00')
  `).run();
  insertOpening(db, '2026-05');

  const diagnostic = ensureVccFinancialOpStateModelSupport(db);

  assert.equal(diagnostic.blocked, false);
  assert.equal(
    db.prepare('SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1').get().first_month,
    '2026-05'
  );
  assert.deepEqual(
    { ...db.prepare(`
      SELECT result_revision, updated_at, input_fingerprint
      FROM vcc_fin_op_runs WHERE id = 1
    `).get() },
    { result_revision: 0, updated_at: '2026-06-02 09:00:00', input_fingerprint: null }
  );
});

test('存量多个期初月份不改资金数据、不阻断启动，并持久化幂等诊断', (t) => {
  const db = createLegacyStateDb(t);
  insertOpening(db, '2026-04', 'PPHK');
  insertOpening(db, '2026-05', 'Airwallex');
  const before = db.prepare(`
    SELECT * FROM vcc_fin_op_opening_balances ORDER BY target_month, subject
  `).all().map((row) => ({ ...row }));

  const first = ensureVccFinancialOpStateModelSupport(db);
  const second = ensureVccFinancialOpStateModelSupport(db);

  assert.equal(first.code, 'vcc-first-month-migration-blocked');
  assert.equal(first.reason, 'multiple-opening-months');
  assert.deepEqual(first.openingMonths, ['2026-04', '2026-05']);
  assert.deepEqual(second.openingMonths, first.openingMonths);
  assert.equal(
    db.prepare('SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1').get().first_month,
    null
  );
  assert.deepEqual(
    db.prepare(`SELECT * FROM vcc_fin_op_opening_balances ORDER BY target_month, subject`).all()
      .map((row) => ({ ...row })),
    before
  );
  assert.equal(auditCount(db), 1);
});

test('多期初月份诊断不阻断 AppDatabase.init，启动后保留诊断供 VCC 门禁读取', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-pr2-app-init-'));
  const dbPath = path.join(tempDir, 'tool-data.sqlite');
  let appDb = new AppDatabase(dbPath);
  appDb.init();
  insertOpening(appDb.db, '2026-04', 'PPHK');
  insertOpening(appDb.db, '2026-05', 'Airwallex');
  appDb.close();

  appDb = new AppDatabase(dbPath);
  t.after(() => {
    appDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  assert.doesNotThrow(() => appDb.init());
  assert.equal(
    appDb.db.prepare(`
      SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1
    `).get().first_month,
    null
  );
  assert.equal(auditCount(appDb.db), 1);
});

test('既有 first_month 与期初月份冲突时保持原值并阻断运行', (t) => {
  const db = createLegacyStateDb(t);
  ensureVccFinancialOpStateModelSupport(db);
  db.prepare(`UPDATE vcc_fin_op_module_state SET first_month = '2026-04' WHERE singleton_id = 1`).run();
  insertOpening(db, '2026-05');

  const diagnostic = ensureVccFinancialOpStateModelSupport(db);

  assert.equal(diagnostic.code, 'vcc-first-month-migration-blocked');
  assert.equal(diagnostic.reason, 'first-month-opening-conflict');
  assert.equal(
    db.prepare('SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1').get().first_month,
    '2026-04'
  );
  assert.equal(auditCount(db), 1);
});

test('畸形 opening 月份不回填 first_month 且重复迁移诊断幂等', (t) => {
  const db = createLegacyStateDb(t);
  insertOpening(db, ' 2026-05 ');

  const first = ensureVccFinancialOpStateModelSupport(db);
  const second = ensureVccFinancialOpStateModelSupport(db);

  assert.equal(first.code, 'vcc-first-month-migration-blocked');
  assert.equal(first.reason, 'invalid-month-format');
  assert.deepEqual(first.invalidOpeningMonths, [' 2026-05 ']);
  assert.equal(second.code, first.code);
  assert.equal(
    db.prepare('SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1').get().first_month,
    null
  );
  assert.equal(auditCount(db), 1);
});

test('畸形 first_month 不会被合法期初月份覆盖', (t) => {
  const db = createLegacyStateDb(t);
  ensureVccFinancialOpStateModelSupport(db);
  db.prepare(`UPDATE vcc_fin_op_module_state SET first_month = '' WHERE singleton_id = 1`).run();
  insertOpening(db, '2026-05');

  const diagnostic = ensureVccFinancialOpStateModelSupport(db);

  assert.equal(diagnostic.code, 'vcc-first-month-migration-blocked');
  assert.equal(diagnostic.reason, 'invalid-month-format');
  assert.equal(diagnostic.invalidFirstMonth, true);
  assert.equal(
    db.prepare('SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1').get().first_month,
    ''
  );
  assert.equal(auditCount(db), 1);
});

test('调整账本约束坐标与序号唯一且随 run 级联删除', (t) => {
  const db = createDb(t);
  ensureVccFinancialOpTablesSupport(db);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, input_revisions_json)
    VALUES ('2026-05', '{}')
  `).run().lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence
    ) VALUES (?, ?, 'PPHK', 'recharge_refund', '入金', '', 'USD', '1.23', '测试', ?)
  `);
  insert.run(runId, 'v1:key-a', 1);
  assert.throws(() => insert.run(runId, 'v1:key-b', 1), /UNIQUE/);
  assert.throws(() => insert.run(runId, 'v1:key-a', 2), /UNIQUE/);

  db.prepare('DELETE FROM vcc_fin_op_runs WHERE id = ?').run(runId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_adjustments').get().row_count,
    0
  );
});
