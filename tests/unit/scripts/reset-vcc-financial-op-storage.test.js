'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  getVccStorageContractVersion
} = require('../../../src/backend/vcc-financial-op-db/storage-contract');
const {
  CONFIRMATION,
  resolveOptions,
  runReset
} = require('../../../scripts/reset-vcc-financial-op-storage');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-current-reset-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createV1Fixture(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureVccFinancialOpTablesSupport(db);
  db.exec(`
    CREATE TABLE unrelated_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO unrelated_fixture (id, payload) VALUES (1, 'preserve-me');
    INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
    VALUES ('remove-me', '2026-08', 0);
  `);
  db.close();
}

test('一次性 reset CLI 要求绝对 source 与精确确认口令', () => {
  assert.throws(
    () => resolveOptions(['--source', 'tool-data.sqlite', '--confirm', CONFIRMATION]),
    /绝对路径/
  );
  assert.throws(
    () => resolveOptions(['--source', '/tmp/tool-data.sqlite', '--confirm', 'YES']),
    /必须显式传入/
  );
});

test('一次性 reset CLI 保留旧库备份并把活动库切为空 v2', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.next');
  const backupPath = path.join(directory, 'tool-data.sqlite.backup');
  const journalPath = path.join(directory, 'run-data', 'storage-migration.json');
  const reportPath = path.join(directory, 'tool-data.sqlite.reset-report.json');
  createV1Fixture(sourcePath);
  const options = resolveOptions([
    '--source', sourcePath,
    '--target', targetPath,
    '--backup', backupPath,
    '--journal', journalPath,
    '--report', reportPath,
    '--confirm', CONFIRMATION
  ], new Date('2026-08-17T00:00:00.000Z'));

  const result = runReset(options);
  assert.equal(result.status, 'success');
  assert.equal(result.oldDatabaseDeleted, false);
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(result.reportPath, reportPath);
  assert.equal(fs.existsSync(reportPath), true);

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.operation, 'current-machine-vcc-v1-reset');
  assert.equal(report.before.contractVersion, 1);
  assert.equal(report.after.contractVersion, 2);
  assert.equal(report.verification.nonVccTablesExactlyPreserved, true);
  assert.equal(report.verification.archiveCenterRowCountsPreserved, true);
  assert.equal(report.verification.vccTablesEmpty, true);
  assert.equal(report.verification.vccSequenceHighWatermarksPreserved, true);
  assert.equal(report.verification.oldDatabaseRetained, true);
  assert.equal(report.before.vccTableRowCounts.some(
    (entry) => entry.tableName === 'vcc_fin_op_import_batches' && entry.rowCount === 1
  ), true);
  assert.equal(report.after.vccTableRowCounts.every((entry) => entry.rowCount === 0), true);

  const active = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    assert.equal(getVccStorageContractVersion(active), 2);
    assert.deepEqual({ ...active.prepare('SELECT * FROM unrelated_fixture').get() }, {
      id: 1,
      payload: 'preserve-me'
    });
    for (const row of active.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name GLOB 'vcc_fin_op_*'
    `).all()) {
      const tableName = String(row.name).replaceAll('"', '""');
      assert.equal(Number(active.prepare(
        `SELECT COUNT(*) AS count FROM "${tableName}"`
      ).get().count), 0, row.name);
    }
  } finally {
    active.close();
  }

  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(getVccStorageContractVersion(backup), 1);
    assert.equal(backup.prepare(`
      SELECT id FROM vcc_fin_op_import_batches WHERE id = 'remove-me'
    `).get().id, 'remove-me');
  } finally {
    backup.close();
  }
});
