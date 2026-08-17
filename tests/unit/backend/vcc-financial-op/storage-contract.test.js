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
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_STORAGE_CONTRACT_VERSION,
  ensureVccStorageSideTables,
  createSlimEffectiveRowsTable,
  getVccStorageContractVersion,
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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
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

  const legacyRepository = loadV319Module('src/backend/vcc-financial-op-db/repository.js');
  const legacySystemImporter = loadV319SystemImporter(legacyRepository);
  const legacyDb = new DatabaseSync(dbPath);
  t.after(() => legacyDb.close());
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
