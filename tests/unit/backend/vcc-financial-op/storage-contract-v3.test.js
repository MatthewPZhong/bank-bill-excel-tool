'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  assertVccStorageContract, getVccStorageContractVersion, registerVccStorageWriteCapability
} = require('../../../../src/backend/vcc-financial-op-db/storage-contract');
const { upgradeVccStorageFile } = require('../../../../src/backend/vcc-financial-op-db/storage-upgrade');

const root = path.resolve(__dirname, '../../../..');
const legacyPath = path.join(root, 'src/backend/vcc-financial-op-db/storage-contract.js');
const baselineModule = new Module(legacyPath, module);
baselineModule.filename = legacyPath;
baselineModule.paths = Module._nodeModulePaths(path.dirname(legacyPath));
baselineModule._compile(execFileSync('git', [
  'show', '2ba9ef14fe972363b604955636cff0c9ac53700f:src/backend/vcc-financial-op-db/storage-contract.js'
], { cwd: root, encoding: 'utf8' }), legacyPath);
const legacy = baselineModule.exports;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-contract-v3-'));
  const file = path.join(directory, 'test.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT NOT NULL);
  `);
  ensureVccFinancialOpTablesSupport(db);
  legacy.upgradeEmptyVccStorageContract(db);
  db.exec(`INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count) VALUES ('batch', '2026-08', 1);
    INSERT INTO vcc_fin_op_import_records (id, batch_id, target_month, source_type, source_files_json)
      VALUES (101, 'batch', '2026-08', 'recharge_refund', '["shared.xlsx"]'),
             (102, 'batch', '2026-08', 'fee_fx', '["shared.xlsx"]');
    INSERT INTO vcc_fin_op_import_sources (id, import_record_id, source_ordinal, source_file_name,
      source_sha256, source_size_bytes, archive_artifact_id, archive_state, bound_at)
      VALUES (201, 101, 1, 'shared.xlsx', '${'a'.repeat(64)}', 123, 901, 'ready', '2026-09-18');
    INSERT INTO vcc_fin_op_effective_rows (id, source_type, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount, import_record_id, import_source_id,
      sheet_name, source_row)
      VALUES (301, 'recharge_refund', 'key', '${'b'.repeat(64)}', '2026-08', '甲', 'USD',
        '1234567890123456.123456789', 101, 201, '原始明细', 7);
  `);
  db.close();
  return file;
}

function contents(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'vcc_fin_op_*' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}

test('真实 v2 增量迁移保留全部业务行、来源 ID 与精度，支持共享原件且阻止旧连接写入', (t) => {
  const file = fixture(t);
  const oldWriter = new DatabaseSync(file);
  legacy.registerVccStorageWriteCapability(oldWriter);
  t.after(() => oldWriter.close());
  const before = contents(oldWriter);
  assertVccStorageContract(oldWriter, 2);
  assert.deepEqual(upgradeVccStorageFile(file), { upgraded: true, fromVersion: 2, toVersion: 3 });
  assert.deepEqual(contents(oldWriter), before);
  assert.throws(() => oldWriter.exec("UPDATE vcc_fin_op_import_batches SET file_count = 2 WHERE id = 'batch'"),
    /no such function: vcc_storage_write_capability_v3/);

  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  registerVccStorageWriteCapability(writer);
  assertVccStorageContract(writer);
  assert.equal(writer.prepare("SELECT count(*) AS n FROM pragma_function_list WHERE name = 'vcc_storage_write_capability_v2'").get().n, 0);
  writer.exec(`INSERT INTO vcc_fin_op_import_sources (import_record_id, source_ordinal, source_file_name,
    source_sha256, source_size_bytes, archive_artifact_id)
    VALUES (102, 1, 'shared.xlsx', '${'a'.repeat(64)}', 123, 901)`);
  assert.throws(() => writer.exec(`INSERT INTO vcc_fin_op_import_sources (import_record_id, source_ordinal,
    source_file_name, source_sha256, source_size_bytes, archive_artifact_id)
    VALUES (102, 2, 'shared.xlsx', '${'a'.repeat(64)}', 123, 901)`), /UNIQUE constraint failed/);
  assert.deepEqual(upgradeVccStorageFile(file), { upgraded: false, fromVersion: 3, toVersion: 3 });
});

test('v3 迁移各持久断点均完整回滚，关闭连接后可以安全重试', (t) => {
  for (const phase of ['after-indexes', 'after-guards', 'after-marker', 'before-commit']) {
    const file = fixture(t);
    let db = new DatabaseSync(file, { readOnly: true });
    const before = contents(db);
    db.close();
    assert.throws(() => upgradeVccStorageFile(file, {
      faultInjector: (at) => { if (at === phase) throw new Error(phase); }
    }), (error) => error.message === phase && error.persistedContractVersion === 2 && !error.migrationCommitted);
    db = new DatabaseSync(file, { readOnly: true });
    assertVccStorageContract(db, 2);
    assert.deepEqual(contents(db), before);
    db.close();
    assert.equal(upgradeVccStorageFile(file).toVersion, 3);
  }
});

test('提交后故障报告持久 v3，后续新连接校验不能伪称回滚', (t) => {
  const file = fixture(t);
  assert.throws(() => upgradeVccStorageFile(file, {
    faultInjector: (phase) => { if (phase === 'after-commit') throw new Error('重新初始化失败'); }
  }), (error) => error.migrationCommitted === true && error.persistedContractVersion === 3);
  assert.equal(upgradeVccStorageFile(file).upgraded, false);
});

test('坏 guard、错误索引及未来 marker 在迁移首写前拒绝', (t) => {
  for (const mutation of [
    'DROP TRIGGER vcc_storage_contract_v2_guard_vcc_fin_op_runs_insert',
    `DROP INDEX idx_vcc_fin_op_import_sources_artifact;
     CREATE INDEX idx_vcc_fin_op_import_sources_artifact ON vcc_fin_op_import_sources(archive_artifact_id)`,
    "UPDATE app_settings SET setting_value = '4' WHERE setting_key = 'vcc_storage_contract_version'"
  ]) {
    const file = fixture(t);
    const db = new DatabaseSync(file);
    db.exec(mutation);
    const before = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
    assert.throws(() => upgradeVccStorageFile(file));
    assert.deepEqual(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(), before);
    db.close();
  }
});

test('generic 初始化拒绝未迁移 v2；v3 缺 guard 时不能靠 IF NOT EXISTS 自动修补', (t) => {
  const file = fixture(t);
  let db = new DatabaseSync(file);
  assert.throws(() => ensureVccFinancialOpTablesSupport(db), { code: 'vcc-storage-upgrade-required' });
  assert.equal(getVccStorageContractVersion(db), 2);
  db.close();
  upgradeVccStorageFile(file);
  db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec('DROP TRIGGER vcc_storage_contract_v3_guard_vcc_fin_op_runs_insert');
  assert.throws(() => ensureVccFinancialOpTablesSupport(db), { code: 'vcc-storage-contract-mismatch' });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vcc_storage_contract_v3_guard_vcc_fin_op_runs_insert'").get(), undefined);
});
