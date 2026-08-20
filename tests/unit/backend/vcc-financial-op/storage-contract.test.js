'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { AppDatabase } = require('../../../../src/backend/database');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_STORAGE_CONTRACT_VERSION,
  ensureVccStorageSideTables,
  createSlimEffectiveRowsTable,
  getVccStorageContractVersion,
  inspectVccStorageData,
  registerVccStorageWriteCapability,
  setVccStorageContractVersion
} = require('../../../../src/backend/vcc-financial-op-db/storage-contract');
const {
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS
} = require('../../../../src/backend/vcc-financial-op/definitions');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadV319Module(relativePath) {
  const source = childProcess.execFileSync(
    'git',
    ['show', `v3.1.9:${relativePath}`],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const filename = path.join(REPO_ROOT, relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

function loadV319SystemImporter(legacyRepository) {
  const repositoryFilename = path.join(
    REPO_ROOT,
    'src/backend/vcc-financial-op-db/repository.js'
  );
  const previous = require.cache[repositoryFilename];
  const injected = new Module(repositoryFilename, module);
  injected.filename = repositoryFilename;
  injected.exports = legacyRepository;
  require.cache[repositoryFilename] = injected;
  try {
    return loadV319Module('src/backend/vcc-financial-op/system-op-importer.js');
  } finally {
    if (previous) require.cache[repositoryFilename] = previous;
    else delete require.cache[repositoryFilename];
  }
}

function writeSystemOpFixture(filePath) {
  const rows = SUPPORTED_CURRENCIES.map((currency, index) => {
    const values = {
      账单日期: '2026-08-31',
      主体: 'PPHK',
      业务部门: 'VCC',
      币种: currency,
      OP发生额: 0,
      '发生额（入）': 0,
      '发生额（出）': 0,
      本期移除Pending金额: 0,
      调账金额: 0,
      OP期末余额: 0,
      pending余额: 0,
      费用项: 0,
      财务余额: index + 1,
      主体变动发生额: 0,
      财务主体余额: index + 1,
      创建时间: '2026-09-01 09:00:00'
    };
    return SYSTEM_OP_HEADERS.map((header) => values[header] ?? '');
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[...SYSTEM_OP_HEADERS], ...rows]),
    'System'
  );
  XLSX.writeFile(workbook, filePath);
}

function columns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

test('v2 side tables 把永久异常、临时 staging、fallback 与输入来源分离', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    ensureVccFinancialOpTablesSupport(db);
    ensureVccStorageSideTables(db);
    ensureVccStorageSideTables(db);

    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name));
    for (const tableName of [
      'vcc_fin_op_import_sources',
      'vcc_fin_op_import_staging_rows',
      'vcc_fin_op_import_anomalies',
      'vcc_fin_op_effective_raw_fallback'
    ]) assert.equal(tables.has(tableName), true, tableName);

    const recordColumns = columns(db, 'vcc_fin_op_import_records');
    assert.equal(recordColumns.has('anomaly_count'), true);
    assert.equal(recordColumns.has('archive_state'), true);

    const anomalyColumns = columns(db, 'vcc_fin_op_import_anomalies');
    assert.equal(anomalyColumns.has('raw_json'), false);
    assert.equal(anomalyColumns.has('incoming_content_hash'), true);
    assert.equal(anomalyColumns.has('diff_fields_json'), true);

    const stagingColumns = columns(db, 'vcc_fin_op_import_staging_rows');
    assert.equal(stagingColumns.has('raw_json'), true);
    assert.equal(stagingColumns.has('disposition'), true);
    const fallbackColumns = columns(db, 'vcc_fin_op_effective_raw_fallback');
    assert.equal(fallbackColumns.has('raw_json'), true);
  } finally {
    db.close();
  }
});

test('slim effective schema 不再永久保存 raw_json、原始键或重复文件路径', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE vcc_fin_op_import_records (id INTEGER PRIMARY KEY);
      CREATE TABLE vcc_fin_op_import_sources (id INTEGER PRIMARY KEY);
    `);
    createSlimEffectiveRowsTable(db, 'vcc_fin_op_effective_rows_v2');
    const effectiveColumns = columns(db, 'vcc_fin_op_effective_rows_v2');
    for (const removed of ['raw_json', 'idempotency_key_raw', 'source_file']) {
      assert.equal(effectiveColumns.has(removed), false, removed);
    }
    for (const retained of [
      'id', 'source_type', 'idempotency_key', 'content_hash', 'hash_version',
      'raw_contract_version', 'target_month', 'subject', 'stat_currency',
      'signed_amount', 'import_record_id', 'import_source_id', 'sheet_name',
      'source_row', 'first_imported_at'
    ]) assert.equal(effectiveColumns.has(retained), true, retained);
  } finally {
    db.close();
  }
});

test('storage contract marker 仅显式写入并拒绝未来版本', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    assert.equal(getVccStorageContractVersion(db), 1);
    setVccStorageContractVersion(db, VCC_STORAGE_CONTRACT_VERSION);
    assert.equal(getVccStorageContractVersion(db), 2);
    db.prepare(`
      UPDATE app_settings SET setting_value = '3'
      WHERE setting_key = 'vcc_storage_contract_version'
    `).run();
    assert.throws(() => getVccStorageContractVersion(db), /高于当前程序/);
  } finally {
    db.close();
  }
});

test('正式启动把 fresh/empty v1 原子升级为空 v2 并保持二次幂等', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const first = ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    assert.equal(first.storageContractMigration.upgraded, true);
    assert.equal(getVccStorageContractVersion(db), VCC_STORAGE_CONTRACT_VERSION);
    assert.equal(inspectVccStorageData(db).empty, true);
    const effectiveColumns = columns(db, 'vcc_fin_op_effective_rows');
    for (const removed of ['raw_json', 'idempotency_key_raw', 'source_file']) {
      assert.equal(effectiveColumns.has(removed), false, removed);
    }
    const vccTableCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name GLOB 'vcc_fin_op_*'
    `).get().count);
    const guardCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'vcc_storage_contract_v2_guard_%'
    `).get().count);
    assert.equal(guardCount, vccTableCount * 3);

    const second = ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    assert.equal(second.storageContractMigration.upgraded, false);
    assert.equal(second.storageContractMigration.fromVersion, VCC_STORAGE_CONTRACT_VERSION);
  } finally {
    db.close();
  }
});

test('已有结构但业务行为空的 v1 升级时保留 effective 自增高水位', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    ensureVccFinancialOpTablesSupport(db);
    db.prepare(`
      INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
      VALUES ('sequence-fixture', '2026-08', 1)
    `).run();
    const recordId = Number(db.prepare(`
      INSERT INTO vcc_fin_op_import_records (
        batch_id, target_month, source_type, source_files_json
      ) VALUES ('sequence-fixture', '2026-08', 'recharge_refund', '["source.xlsx"]')
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO vcc_fin_op_effective_rows (
        source_type, idempotency_key_raw, idempotency_key, content_hash,
        target_month, subject, source_file, sheet_name, source_row, raw_json,
        import_record_id
      ) VALUES (
        'recharge_refund', 'raw', 'key', ?, '2026-08', 'PPHK',
        'source.xlsx', 'Sheet1', 2, '{}', ?
      )
    `).run('a'.repeat(64), recordId);
    db.exec(`
      DELETE FROM vcc_fin_op_effective_rows;
      DELETE FROM vcc_fin_op_import_records;
      DELETE FROM vcc_fin_op_import_batches;
    `);
    const beforeSequence = Number(db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'vcc_fin_op_effective_rows'
    `).get().seq);

    const result = ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    assert.equal(result.storageContractMigration.upgraded, true);
    assert.equal(Number(db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'vcc_fin_op_effective_rows'
    `).get().seq), beforeSequence);
  } finally {
    db.close();
  }
});

test('非空 v1 在首笔兼容迁移前 fail-closed 且不写 marker', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    ensureVccFinancialOpTablesSupport(db);
    db.prepare(`
      INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
      VALUES ('must-survive', '2026-08', 0)
    `).run();
    const beforeSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vcc_fin_op_effective_rows'
    `).get().sql;

    assert.throws(
      () => ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true }),
      (error) => error && error.code === 'vcc-storage-v1-data-present'
        && error.nonEmptyTables.some((entry) => entry.tableName === 'vcc_fin_op_import_batches')
    );
    assert.equal(getVccStorageContractVersion(db), 1);
    assert.equal(db.prepare(`
      SELECT id FROM vcc_fin_op_import_batches WHERE id = 'must-survive'
    `).get().id, 'must-survive');
    assert.equal(db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vcc_fin_op_effective_rows'
    `).get().sql, beforeSql);
  } finally {
    db.close();
  }
});

test('AppDatabase 正式启动接入非空 v1 门禁并保留原业务行', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-nonempty-v1-startup-'));
  const dbPath = path.join(directory, 'tool-data.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureVccFinancialOpTablesSupport(seed);
  seed.prepare(`
    INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
    VALUES ('startup-must-survive', '2026-08', 0)
  `).run();
  seed.close();
  seed = null;

  const appDb = new AppDatabase(dbPath);
  try {
    assert.throws(
      () => appDb.init(),
      (error) => error && error.code === 'vcc-storage-v1-data-present'
    );
  } finally {
    appDb.close();
  }
  const reopened = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(getVccStorageContractVersion(reopened), 1);
    assert.equal(reopened.prepare(`
      SELECT id FROM vcc_fin_op_import_batches WHERE id = 'startup-must-survive'
    `).get().id, 'startup-must-survive');
  } finally {
    reopened.close();
  }
});

test('非空 first_month 也属于 v1 业务状态并阻止自动升级', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    ensureVccFinancialOpTablesSupport(db);
    db.prepare(`
      UPDATE vcc_fin_op_module_state SET first_month = '2026-08' WHERE singleton_id = 1
    `).run();
    assert.throws(
      () => ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true }),
      (error) => error && error.code === 'vcc-storage-v1-data-present'
        && error.moduleStateFirstMonth === '2026-08'
    );
    assert.equal(getVccStorageContractVersion(db), 1);
  } finally {
    db.close();
  }
});

test('空 v1 升级末端校验失败时回滚 slim schema、marker 和 guards', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    ensureVccFinancialOpTablesSupport(db);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE unrelated_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE unrelated_child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES unrelated_parent(id)
      );
      INSERT INTO unrelated_child (id, parent_id) VALUES (1, 999);
      PRAGMA foreign_keys = ON;
    `);

    assert.throws(
      () => ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true }),
      (error) => error && error.code === 'vcc-storage-empty-upgrade-foreign-key-failed'
    );
    assert.equal(getVccStorageContractVersion(db), 1);
    assert.equal(columns(db, 'vcc_fin_op_effective_rows').has('raw_json'), true);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'vcc_storage_contract_v2_guard_%'
    `).get().count), 0);
  } finally {
    db.close();
  }
});

test('v1 历史终态记录没有 source 时标记 unavailable，不冒充待存档', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    ensureVccFinancialOpTablesSupport(db);
    db.prepare(`
      INSERT INTO vcc_fin_op_import_batches (
        id, target_month, status, file_count, started_at, finished_at
      ) VALUES ('legacy-batch', '2026-07', 'success', 1,
                '2026-08-01 10:00:00', '2026-08-01 10:01:00')
    `).run();
    const recordId = Number(db.prepare(`
      INSERT INTO vcc_fin_op_import_records (
        batch_id, target_month, source_type, source_files_json, status,
        raw_count, inserted_count, started_at, finished_at
      ) VALUES ('legacy-batch', '2026-07', 'recharge_refund', '["legacy.xlsx"]',
                'success', 1, 1, '2026-08-01 10:00:00', '2026-08-01 10:01:00')
    `).run().lastInsertRowid);
    assert.equal(db.prepare(`
      SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
    `).get(recordId).archive_state, 'pending');

    ensureVccStorageSideTables(db);
    assert.equal(db.prepare(`
      SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
    `).get(recordId).archive_state, 'unavailable');
  } finally {
    db.close();
  }
});

test('contract-v2 连接能力触发器允许新版连接并阻止 v3.1.9 真实 repository 降级写', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-contract-v2-guard-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  let db = new DatabaseSync(dbPath);
  let legacyDb = null;
  t.after(() => {
    if (legacyDb) legacyDb.close();
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureVccFinancialOpTablesSupport(db);
  setVccStorageContractVersion(db, VCC_STORAGE_CONTRACT_VERSION);
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (id, target_month, file_count)
    VALUES ('new-capability', '2026-08', 0)
  `).run());
  const systemRecordId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json
    ) VALUES ('new-capability', '2026-08', 'system_op', '["system.xlsx"]')
  `).run().lastInsertRowid);
  const systemPath = path.join(dir, 'system.xlsx');
  writeSystemOpFixture(systemPath);
  db.close();
  db = null;

  const legacyRepository = loadV319Module('src/backend/vcc-financial-op-db/repository.js');
  const legacySystemImporter = loadV319SystemImporter(legacyRepository);
  legacyDb = new DatabaseSync(dbPath);
  for (const scenario of [
    {
      name: '空数据集批次',
      mutate: () => legacyRepository.createImportBatch(legacyDb, {
        id: 'legacy-empty', targetMonth: '2026-08', fileCount: 0
      })
    },
    {
      name: '无 Pending 的明细 record',
      mutate: () => legacyRepository.createImportRecord(legacyDb, {
        batchId: 'new-capability',
        targetMonth: '2026-08',
        sourceType: 'recharge_refund',
        sourceFiles: ['detail.xlsx']
      })
    },
    {
      name: 'Pending record',
      mutate: () => legacyRepository.createImportRecord(legacyDb, {
        batchId: 'new-capability',
        targetMonth: '2026-08',
        sourceType: 'pending_archive_removal',
        sourceFiles: ['pending.xlsx']
      })
    }
  ]) {
    assert.throws(
      scenario.mutate,
      /no such function: vcc_storage_write_capability_v2/,
      scenario.name
    );
  }

  assert.throws(() => legacySystemImporter.importSystemOpGroup({
    db: legacyDb,
    batchId: 'new-capability',
    targetMonth: '2026-08',
    files: [{ filePath: systemPath, sheetName: 'System' }],
    recordId: systemRecordId
  }), /no such function: vcc_storage_write_capability_v2/);

  registerVccStorageWriteCapability(legacyDb);
  assert.doesNotThrow(() => legacyRepository.createImportBatch(legacyDb, {
    id: 'new-explicit-worker', targetMonth: '2026-08', fileCount: 0
  }));
});

test('system snapshot import_source_id 补列后建立部分索引且迁移幂等', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  ensureVccFinancialOpTablesSupport(db);
  ensureVccFinancialOpTablesSupport(db);
  const columns = db.prepare('PRAGMA table_info(vcc_fin_op_system_snapshots)').all();
  assert.ok(columns.some((column) => column.name === 'import_source_id'));
  const index = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_vcc_fin_op_system_snapshots_import_source'
  `).get();
  assert.match(index.sql, /\(import_source_id, id\)/);
  assert.match(index.sql, /WHERE import_source_id IS NOT NULL/);
});
