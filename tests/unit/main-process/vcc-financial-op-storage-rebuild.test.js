'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  ensureVccStorageSideTables,
  registerVccStorageWriteCapability
} = require('../../../src/backend/vcc-financial-op-db/storage-contract');
const {
  atomicSwitchVccStorage,
  buildVccStorageCandidate,
  createMigrationJournal,
  readJournal,
  recoverVccStorageMigration,
  storageContractVersion,
  updateJournal
} = require('../../../src/main-process/vcc-financial-op-storage-rebuild');
const {
  runMigrationWorker
} = require('../../../src/main-process/vcc-financial-op-storage-migration');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-storage-rebuild-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createLegacyDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  ensureVccFinancialOpTablesSupport(db);
  ensureVccStorageSideTables(db);
  createArchiveRepository(db).ensureSchema();
  db.exec(`
    CREATE TABLE non_vcc_business_fixture (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO non_vcc_business_fixture (id, payload)
    VALUES (1, 'must-survive'), (2, 'also-survives');
  `);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at, finished_at
    ) VALUES ('batch-1', '2026-07', 'completed_with_errors', 1, '2026-08-01 10:00:00', '2026-08-01 10:01:00')
  `).run();
  const record = db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, skipped_count, invalid_key_count,
      conflict_count, format_error_count, rolled_back_count,
      started_at, finished_at, resolution_status
    ) VALUES (
      'batch-1', '2026-07', 'recharge_refund', '["source.xlsx"]', 'success_with_skips',
      3, 1, 1, 1, 0, 0, 0,
      '2026-08-01 10:00:00', '2026-08-01 10:01:00', 'unresolved'
    )
  `).run();
  const recordId = Number(record.lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      hash_version, raw_contract_version, target_month, subject, stat_currency,
      signed_amount, source_file, sheet_name, source_row, raw_json,
      import_record_id, first_imported_at
    ) VALUES (
      'recharge_refund', ' raw-key ', 'raw-key', ?, 1, 1,
      '2026-07', 'PPHK', 'USD', '10.25', 'source.xlsx', 'sheet1', 2,
      '{"订单号":"raw-key","我方到账金额":"10.25"}', ?, '2026-08-01 10:00:30'
    )
  `).run('a'.repeat(64), recordId);
  const insertLegacyRow = db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, idempotency_key_raw,
      idempotency_key, content_hash, source_file, sheet_name, source_row,
      raw_json, disposition, validation_field, validation_message, diff_fields_json
    ) VALUES (?, 'recharge_refund', '2026-07', ?, ?, ?, 'source.xlsx', 'sheet1', ?, ?, ?, ?, ?, '[]')
  `);
  insertLegacyRow.run(
    recordId, ' bad ', 'bad', 'b'.repeat(64), 3, '{"订单号":""}',
    'invalid_key', '订单号', '幂等键为空'
  );
  insertLegacyRow.run(
    recordId, ' raw-key ', 'raw-key', 'a'.repeat(64), 4,
    '{"订单号":"raw-key","我方到账金额":"10.25"}',
    'idempotent_skip', null, null
  );
  db.close();
  return { recordId };
}

function seedExactHistoricalArchive(filePath, recordId) {
  const db = new DatabaseSync(filePath);
  const repository = createArchiveRepository(db, {
    now: () => new Date('2026-08-16T10:00:00.000Z')
  });
  repository.ensureSchema();
  const parentRunId = 'historical-vcc-import-parent';
  const reserved = repository.reserveTaskBatch({
    moduleId: 'vcc-financial-op',
    moduleCode: 'VCCFINOP',
    moduleName: 'VCC财务OP校验',
    operationKey: 'historical-vcc-import-operation',
    taskKey: 'vccFinancialOp:import:apply',
    taskRunId: 'historical-vcc-import-task',
    parentRunId
  });
  repository.bindFlowAnchor({
    moduleId: 'vcc-financial-op',
    identityType: 'vcc-financial-op-import-record',
    identityValue: String(recordId),
    parentRunId,
    sourceBatchId: reserved.batch.id
  });
  const artifact = repository.addArtifact(reserved.batch.id, {
    artifactKey: 'input:source.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'vccFinancialOp:import:apply',
    originalName: 'source.xlsx',
    sourcePath: '/historical/source.xlsx'
  });
  repository.startArtifactAttempt(artifact.id);
  repository.completeArtifact(artifact.id, {
    sha256: 'c'.repeat(64),
    sizeBytes: 456,
    relativePath: `blobs/sha256/cc/${'c'.repeat(64)}`
  });
  db.close();
  return { artifactId: artifact.id };
}

test('copy-on-write 重建移除逐行 raw，只迁移真正异常且保持计数与结果身份', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId } = createLegacyDatabase(sourcePath);
  const progress = [];

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4,
    onProgress: (event) => progress.push(event.phase)
  });

  assert.equal(result.noChange, false);
  assert.equal(result.effectiveCount, 1);
  assert.equal(result.migratedAnomalies, 1);
  assert.equal(progress.includes('checkpoint'), true);
  assert.equal(progress.includes('verified'), true);

  const oldDb = new DatabaseSync(sourcePath, { readOnly: true });
  const nextDb = new DatabaseSync(targetPath, { readOnly: true });
  try {
    assert.equal(storageContractVersion(oldDb), 1);
    assert.equal(storageContractVersion(nextDb), 2);
    const columns = new Set(nextDb.prepare(
      'PRAGMA table_info(vcc_fin_op_effective_rows)'
    ).all().map((row) => row.name));
    for (const removed of ['raw_json', 'idempotency_key_raw', 'source_file']) {
      assert.equal(columns.has(removed), false, removed);
    }
    assert.deepEqual({ ...nextDb.prepare(`
      SELECT id, idempotency_key, content_hash, target_month, subject,
             stat_currency, signed_amount, import_record_id, sheet_name, source_row
      FROM vcc_fin_op_effective_rows
    `).get() }, {
      id: 1,
      idempotency_key: 'raw-key',
      content_hash: 'a'.repeat(64),
      target_month: '2026-07',
      subject: 'PPHK',
      stat_currency: 'USD',
      signed_amount: '10.25',
      import_record_id: recordId,
      sheet_name: 'sheet1',
      source_row: 2
    });
    assert.equal(nextDb.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_import_rows').get().count, 0);
    assert.equal(nextDb.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_import_staging_rows').get().count, 0);
    assert.deepEqual(nextDb.prepare(`
      SELECT id, payload FROM non_vcc_business_fixture ORDER BY id
    `).all().map((row) => ({ ...row })), [
      { id: 1, payload: 'must-survive' },
      { id: 2, payload: 'also-survives' }
    ]);
    assert.deepEqual({ ...nextDb.prepare(`
      SELECT category, source_file_name, source_row, abnormal_fields_json, description
      FROM vcc_fin_op_import_anomalies
    `).get() }, {
      category: 'invalid_key',
      source_file_name: 'source.xlsx',
      source_row: 3,
      abnormal_fields_json: '["订单号"]',
      description: '幂等键为空'
    });
    const record = { ...nextDb.prepare(`
      SELECT raw_count, inserted_count, skipped_count, invalid_key_count,
             conflict_count, format_error_count, rolled_back_count,
             anomaly_count, archive_state
      FROM vcc_fin_op_import_records WHERE id = ?
    `).get(recordId) };
    assert.deepEqual(record, {
      raw_count: 3,
      inserted_count: 1,
      skipped_count: 1,
      invalid_key_count: 1,
      conflict_count: 0,
      format_error_count: 0,
      rolled_back_count: 0,
      anomaly_count: 1,
      archive_state: 'unavailable'
    });
  } finally {
    oldDb.close();
    nextDb.close();
  }
  const reopened = new DatabaseSync(targetPath);
  try {
    assert.doesNotThrow(() => ensureVccFinancialOpTablesSupport(reopened));
    assert.equal(storageContractVersion(reopened), 2);
  } finally {
    reopened.close();
  }
});

test('旧版 rolled_back 文件级错误每个导入记录只迁移一条失败事件', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId } = createLegacyDatabase(sourcePath);
  const sourceDb = new DatabaseSync(sourcePath);
  const insertError = sourceDb.prepare(`
    INSERT INTO vcc_fin_op_import_errors (
      import_record_id, source_file, sheet_name, source_row,
      field_name, error_code, message, created_at
    ) VALUES (?, 'source.xlsx', NULL, NULL, NULL, ?, ?, ?)
  `);
  insertError.run(recordId, 'worker-failed', '首次文件级失败', '2026-08-01 10:01:01');
  insertError.run(recordId, 'worker-failed-again', '重复文件级失败', '2026-08-01 10:01:02');
  sourceDb.close();

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  });
  assert.equal(result.migratedLegacyErrors, 1);
  const targetDb = new DatabaseSync(targetPath, { readOnly: true });
  try {
    assert.deepEqual(targetDb.prepare(`
      SELECT category, description
      FROM vcc_fin_op_import_anomalies
      WHERE import_record_id = ? AND category = 'file_failure'
      ORDER BY id
    `).all(recordId).map((row) => ({ ...row })), [
      { category: 'file_failure', description: '首次文件级失败' }
    ]);
  } finally {
    targetDb.close();
  }
});

test('checkpoint、空间或复制故障发生在切换前时旧库保持 v1 且候选被清理', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  createLegacyDatabase(sourcePath);
  assert.throws(() => buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1
  }), (error) => error.code === 'vcc-storage-space-insufficient');
  assert.equal(fs.existsSync(targetPath), false);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 1); } finally { db.close(); }

  assert.throws(() => buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4,
    faultInjector: (checkpoint) => {
      if (checkpoint === 'after-table-copy') throw Object.assign(new Error('copy fault'), { code: 'injected' });
    }
  }), /copy fault/);
  assert.equal(fs.existsSync(targetPath), false);
});

test('候选库与切换前新旧主文件必须显式 fsync 后才允许 rename', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const backupPath = path.join(directory, 'tool-data.sqlite.vcc-v1-backup');
  const journalPath = path.join(directory, 'run-data', 'vcc-storage-migration.json');
  createLegacyDatabase(sourcePath);

  const openedPaths = new Map();
  const openedFlags = [];
  const fsyncedPaths = [];
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (filePath, ...args) => {
          const fd = target.openSync(filePath, ...args);
          const resolvedPath = path.resolve(String(filePath));
          openedPaths.set(fd, resolvedPath);
          openedFlags.push({ filePath: resolvedPath, flags: args[0] });
          return fd;
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          fsyncedPaths.push(openedPaths.get(fd) || 'unknown');
          return target.fsyncSync(fd);
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          openedPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      return Reflect.get(target, property);
    }
  });

  buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4,
    fsImpl
  });
  assert.equal(fsyncedPaths.includes(path.resolve(targetPath)), true);
  assert.ok(openedFlags.some((entry) => (
    entry.filePath === path.resolve(targetPath) && entry.flags === 'r+'
  )));

  fsyncedPaths.length = 0;
  openedFlags.length = 0;
  const journal = createMigrationJournal({
    sourcePath,
    targetPath,
    backupPath,
    migrationId: 'fsync-before-switch'
  });
  atomicSwitchVccStorage({ journalPath, journal, fsImpl });
  assert.equal(fsyncedPaths.includes(path.resolve(sourcePath)), true);
  assert.equal(fsyncedPaths.includes(path.resolve(targetPath)), true);
  for (const databasePath of [sourcePath, targetPath]) {
    assert.ok(openedFlags.some((entry) => (
      entry.filePath === path.resolve(databasePath) && entry.flags === 'r+'
    )));
  }
});

test('候选冻结复验完成后仍持有源 BEGIN IMMEDIATE，ack 前并发 mutation 被拒绝', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  createLegacyDatabase(sourcePath);
  let holdObserved = false;

  buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4,
    holdSourceLockUntilAck(candidate) {
      holdObserved = true;
      assert.equal(candidate.noChange, false);
      const writer = new DatabaseSync(sourcePath);
      try {
        assert.throws(() => writer.prepare(`
          UPDATE app_settings SET setting_value = 'late-write'
          WHERE setting_key = 'vcc_storage_contract_version'
        `).run(), (error) => error && error.code === 'ERR_SQLITE_ERROR'
          && /locked|busy/i.test(error.message));
      } finally {
        writer.close();
      }
    }
  });

  assert.equal(holdObserved, true);
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.prepare(`
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('post-ack-write', 'preserved')
    `).run();
    assert.equal(writer.prepare(`
      SELECT setting_value FROM app_settings WHERE setting_key = 'post-ack-write'
    `).get().setting_value, 'preserved');
  } finally {
    writer.close();
  }
});

test('真实 worker ready/ack 协议在 coordinator ack 前保持源写锁', async (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  createLegacyDatabase(sourcePath);
  let readyObserved = false;

  const result = await runMigrationWorker({
    sourcePath,
    targetPath,
    onReady(candidate) {
      readyObserved = true;
      assert.equal(candidate.noChange, false);
      const writer = new DatabaseSync(sourcePath);
      try {
        assert.throws(() => writer.prepare(`
          UPDATE app_settings SET setting_value = 'worker-late-write'
          WHERE setting_key = 'vcc_storage_contract_version'
        `).run(), (error) => error && error.code === 'ERR_SQLITE_ERROR'
          && /locked|busy/i.test(error.message));
      } finally {
        writer.close();
      }
    }
  });

  assert.equal(readyObserved, true);
  assert.equal(result.noChange, false);
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.prepare(`
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('worker-post-ack-write', 'preserved')
    `).run();
    assert.equal(writer.prepare(`
      SELECT setting_value FROM app_settings WHERE setting_key = 'worker-post-ack-write'
    `).get().setting_value, 'preserved');
  } finally {
    writer.close();
  }
});

test('import record 六类计数公式不守恒时拒绝候选库且旧库不变', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId } = createLegacyDatabase(sourcePath);
  const db = new DatabaseSync(sourcePath);
  db.prepare(`
    UPDATE vcc_fin_op_import_records SET raw_count = 4 WHERE id = ?
  `).run(recordId);
  db.close();

  assert.throws(() => buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  }), (error) => error.code === 'vcc-storage-import-counter-formula-mismatch');
  assert.equal(fs.existsSync(targetPath), false);
  const reopened = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    assert.equal(storageContractVersion(reopened), 1);
    assert.equal(reopened.prepare(`
      SELECT raw_count FROM vcc_fin_op_import_records WHERE id = ?
    `).get(recordId).raw_count, 4);
  } finally {
    reopened.close();
  }
});

test('copy-on-write 保留已删除记录留下的 AUTOINCREMENT 高水位', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  createLegacyDatabase(sourcePath);
  const sourceDb = new DatabaseSync(sourcePath);
  sourceDb.prepare(`
    UPDATE sqlite_sequence SET seq = 900
    WHERE name = 'vcc_fin_op_effective_rows'
  `).run();
  sourceDb.prepare(`
    UPDATE sqlite_sequence SET seq = 700
    WHERE name = 'vcc_fin_op_import_records'
  `).run();
  sourceDb.close();

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  });
  assert.equal(result.preservedSequenceCount > 0, true);

  const targetDb = new DatabaseSync(targetPath);
  try {
    registerVccStorageWriteCapability(targetDb);
    assert.equal(targetDb.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'vcc_fin_op_effective_rows'
    `).get().seq, 900);
    assert.equal(targetDb.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'vcc_fin_op_import_records'
    `).get().seq, 700);
    targetDb.prepare(`
      INSERT INTO vcc_fin_op_import_batches (
        id, target_month, status, file_count, started_at, finished_at
      ) VALUES ('batch-2', '2026-08', 'failed', 0,
                '2026-08-17 10:00:00', '2026-08-17 10:00:01')
    `).run();
    const inserted = targetDb.prepare(`
      INSERT INTO vcc_fin_op_import_records (
        batch_id, target_month, source_type, source_files_json, status,
        started_at, resolution_status
      ) VALUES ('batch-2', '2026-08', 'fee_fx', '[]', 'failed_validation',
                '2026-08-17 10:00:00', 'unresolved')
    `).run();
    assert.equal(Number(inserted.lastInsertRowid), 701);
  } finally {
    targetDb.close();
  }
});

test('历史来源仅在 flow identity、文件名、artifact、SHA 和大小唯一时绑定并建立 hold', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId } = createLegacyDatabase(sourcePath);
  const { artifactId } = seedExactHistoricalArchive(sourcePath, recordId);

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  });
  assert.deepEqual(result.historicalLineage, {
    boundSources: 1,
    boundRecords: 1,
    unavailableRecords: 0
  });
  const db = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const source = { ...db.prepare(`
      SELECT id, source_file_name, source_sha256, source_size_bytes,
             archive_artifact_id, archive_state
      FROM vcc_fin_op_import_sources WHERE import_record_id = ?
    `).get(recordId) };
    assert.equal(source.source_file_name, 'source.xlsx');
    assert.equal(source.source_sha256, 'c'.repeat(64));
    assert.equal(source.source_size_bytes, 456);
    assert.equal(source.archive_artifact_id, artifactId);
    assert.equal(source.archive_state, 'ready');
    assert.equal(db.prepare(`
      SELECT import_source_id FROM vcc_fin_op_effective_rows WHERE import_record_id = ?
    `).get(recordId).import_source_id, source.id);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM archive_artifact_holds
      WHERE artifact_id = ? AND owner_module = 'vcc-financial-op'
        AND owner_type = 'vcc-import-source' AND owner_id = ?
    `).get(artifactId, String(source.id)).count, 1);
  } finally {
    db.close();
  }
});

test('历史来源存在同名多候选 artifact 时不猜测绑定且不建立 hold', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId } = createLegacyDatabase(sourcePath);
  seedExactHistoricalArchive(sourcePath, recordId);

  const db = new DatabaseSync(sourcePath);
  const repository = createArchiveRepository(db, {
    now: () => new Date('2026-08-16T10:02:00.000Z')
  });
  repository.ensureSchema();
  const batchId = Number(db.prepare(`
    SELECT source_batch_id FROM archive_flow_anchors
    WHERE module_id = 'vcc-financial-op'
      AND identity_type = 'vcc-financial-op-import-record'
      AND identity_value = ?
  `).get(String(recordId)).source_batch_id);
  const duplicate = repository.addArtifact(batchId, {
    artifactKey: 'input:source.xlsx:duplicate',
    direction: 'input',
    role: 'input',
    sourceOperation: 'vccFinancialOp:import:apply',
    originalName: 'source.xlsx',
    sourcePath: '/historical/duplicate/source.xlsx'
  });
  repository.startArtifactAttempt(duplicate.id);
  repository.completeArtifact(duplicate.id, {
    sha256: 'd'.repeat(64),
    sizeBytes: 789,
    relativePath: `blobs/sha256/dd/${'d'.repeat(64)}`
  });
  db.close();

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  });
  assert.deepEqual(result.historicalLineage, {
    boundSources: 0,
    boundRecords: 0,
    unavailableRecords: 1
  });
  const nextDb = new DatabaseSync(targetPath, { readOnly: true });
  try {
    assert.equal(nextDb.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_import_sources WHERE import_record_id = ?
    `).get(recordId).count, 0);
    assert.equal(nextDb.prepare(`
      SELECT import_source_id FROM vcc_fin_op_effective_rows WHERE import_record_id = ?
    `).get(recordId).import_source_id, null);
    assert.equal(nextDb.prepare(`
      SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
    `).get(recordId).archive_state, 'unavailable');
    assert.equal(nextDb.prepare(`
      SELECT COUNT(*) AS count FROM archive_artifact_holds
      WHERE owner_module = 'vcc-financial-op' AND owner_type = 'vcc-import-source'
    `).get().count, 0);
  } finally {
    nextDb.close();
  }
});

test('显式重建保留升级后未归档 fallback，并为已验证 artifact 清 fallback 与建立 hold', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const { recordId: pendingRecordId } = createLegacyDatabase(sourcePath);
  const db = new DatabaseSync(sourcePath);
  const pendingSource = db.prepare(`
    INSERT INTO vcc_fin_op_import_sources (
      import_record_id, source_ordinal, source_file_name,
      source_sha256, source_size_bytes, archive_state
    ) VALUES (?, 1, 'source.xlsx', ?, 123, 'pending')
  `).run(pendingRecordId, 'e'.repeat(64));
  const pendingSourceId = Number(pendingSource.lastInsertRowid);
  db.prepare(`
    UPDATE vcc_fin_op_effective_rows SET import_source_id = ? WHERE id = 1
  `).run(pendingSourceId);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_raw_fallback (
      effective_row_id, import_source_id, raw_contract_version, raw_json
    ) VALUES (1, ?, 1, '{"订单号":"raw-key","我方到账金额":"10.25"}')
  `).run(pendingSourceId);

  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at, finished_at
    ) VALUES ('batch-ready', '2026-07', 'success', 1,
              '2026-08-02 10:00:00', '2026-08-02 10:01:00')
  `).run();
  const readyRecord = db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, started_at, finished_at, resolution_status
    ) VALUES (
      'batch-ready', '2026-07', 'fee_fx', '["ready.xlsx"]', 'success',
      1, 1, '2026-08-02 10:00:00', '2026-08-02 10:01:00', 'not_applicable'
    )
  `).run();
  const readyRecordId = Number(readyRecord.lastInsertRowid);
  const archiveRepository = createArchiveRepository(db, {
    now: () => new Date('2026-08-02T10:02:00.000Z')
  });
  const reserved = archiveRepository.reserveTaskBatch({
    moduleId: 'vcc-financial-op',
    moduleCode: 'VCCFINOP',
    moduleName: 'VCC财务OP校验',
    operationKey: 'ready-import-operation',
    taskKey: 'vccFinancialOp:import:apply',
    taskRunId: 'ready-import-task',
    parentRunId: 'ready-import-parent'
  });
  const artifact = archiveRepository.addArtifact(reserved.batch.id, {
    artifactKey: 'input:ready.xlsx',
    direction: 'input',
    role: 'input',
    sourceOperation: 'vccFinancialOp:import:apply',
    originalName: 'ready.xlsx',
    sourcePath: '/current/ready.xlsx'
  });
  archiveRepository.startArtifactAttempt(artifact.id);
  archiveRepository.completeArtifact(artifact.id, {
    sha256: 'f'.repeat(64),
    sizeBytes: 456,
    relativePath: `blobs/sha256/ff/${'f'.repeat(64)}`
  });
  const readySource = db.prepare(`
    INSERT INTO vcc_fin_op_import_sources (
      import_record_id, source_ordinal, source_file_name,
      source_sha256, source_size_bytes, archive_artifact_id,
      archive_state, bound_at
    ) VALUES (?, 1, 'ready.xlsx', ?, 456, ?, 'ready', '2026-08-02 10:02:00')
  `).run(readyRecordId, 'f'.repeat(64), artifact.id);
  const readySourceId = Number(readySource.lastInsertRowid);
  const readyEffective = db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      hash_version, raw_contract_version, target_month, subject, stat_currency,
      signed_amount, source_file, sheet_name, source_row, raw_json,
      import_record_id, import_source_id, first_imported_at
    ) VALUES (
      'fee_fx', 'ready-key', 'ready-key', ?, 1, 1,
      '2026-07', 'PPHK', 'CNY', '20.50', 'ready.xlsx', 'sheet1', 3,
      '{"唯一键":"ready-key","净额":"20.50"}', ?, ?, '2026-08-02 10:00:30'
    )
  `).run('1'.repeat(64), readyRecordId, readySourceId);
  const readyEffectiveId = Number(readyEffective.lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_raw_fallback (
      effective_row_id, import_source_id, raw_contract_version, raw_json
    ) VALUES (?, ?, 1, '{"唯一键":"ready-key","净额":"20.50"}')
  `).run(readyEffectiveId, readySourceId);
  db.close();

  const result = buildVccStorageCandidate({
    sourcePath,
    targetPath,
    availableBytes: 1024 ** 4
  });
  assert.equal(result.removedReadyFallbacks, 1);

  const nextDb = new DatabaseSync(targetPath, { readOnly: true });
  try {
    assert.deepEqual({ ...nextDb.prepare(`
      SELECT import_source_id, raw_json
      FROM vcc_fin_op_effective_raw_fallback
      WHERE effective_row_id = 1
    `).get() }, {
      import_source_id: pendingSourceId,
      raw_json: '{"订单号":"raw-key","我方到账金额":"10.25"}'
    });
    assert.equal(nextDb.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_effective_raw_fallback
      WHERE effective_row_id = ?
    `).get(readyEffectiveId).count, 0);
    assert.equal(nextDb.prepare(`
      SELECT COUNT(*) AS count FROM archive_artifact_holds
      WHERE artifact_id = ? AND owner_module = 'vcc-financial-op'
        AND owner_type = 'vcc-import-source' AND owner_id = ?
    `).get(artifact.id, String(readySourceId)).count, 1);
    assert.equal(nextDb.prepare(`
      SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
    `).get(pendingRecordId).archive_state, 'pending');
    assert.equal(nextDb.prepare(`
      SELECT archive_state FROM vcc_fin_op_import_records WHERE id = ?
    `).get(readyRecordId).archive_state, 'ready');
  } finally {
    nextDb.close();
  }
});

test('原子切换先只读复验，再按用户选择保留旧库；pre-switch journal 可幂等回滚', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.sqlite.vcc-next');
  const backupPath = path.join(directory, 'tool-data.sqlite.vcc-v1-backup');
  const journalPath = path.join(directory, 'run-data', 'vcc-storage-migration.json');
  createLegacyDatabase(sourcePath);
  buildVccStorageCandidate({ sourcePath, targetPath, availableBytes: 1024 ** 4 });
  const journal = createMigrationJournal({
    sourcePath,
    targetPath,
    backupPath,
    deleteOldDatabase: false,
    migrationId: 'migration-1'
  });
  const switched = atomicSwitchVccStorage({ journalPath, journal });
  assert.equal(switched.status, 'success');
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.existsSync(journalPath), false);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 2); } finally { db.close(); }

  const secondSource = path.join(directory, 'second.sqlite');
  const secondTarget = path.join(directory, 'second.next.sqlite');
  const secondBackup = path.join(directory, 'second.backup.sqlite');
  const secondJournalPath = path.join(directory, 'run-data', 'second.json');
  createLegacyDatabase(secondSource);
  fs.copyFileSync(secondSource, secondTarget);
  const preSwitch = createMigrationJournal({
    sourcePath: secondSource,
    targetPath: secondTarget,
    backupPath: secondBackup,
    migrationId: 'migration-2'
  });
  fs.mkdirSync(path.dirname(secondJournalPath), { recursive: true });
  fs.writeFileSync(secondJournalPath, JSON.stringify(preSwitch));
  assert.deepEqual(recoverVccStorageMigration({ journalPath: secondJournalPath }), {
    status: 'rolled-back',
    sourcePath: secondSource
  });
  assert.equal(fs.existsSync(secondTarget), false);
  assert.equal(fs.existsSync(secondJournalPath), false);
});

test('switching 与 switched 崩溃窗口均按 journal 唯一恢复，重开失败则恢复旧库', (t) => {
  const directory = tempDir(t);

  const beforeRenameSource = path.join(directory, 'before-rename.sqlite');
  const beforeRenameTarget = path.join(directory, 'before-rename.next.sqlite');
  const beforeRenameBackup = path.join(directory, 'before-rename.backup.sqlite');
  const beforeRenameJournalPath = path.join(directory, 'run-data', 'before-rename.json');
  createLegacyDatabase(beforeRenameSource);
  buildVccStorageCandidate({
    sourcePath: beforeRenameSource,
    targetPath: beforeRenameTarget,
    availableBytes: 1024 ** 4
  });
  const beforeRenameJournal = createMigrationJournal({
    sourcePath: beforeRenameSource,
    targetPath: beforeRenameTarget,
    backupPath: beforeRenameBackup,
    migrationId: 'before-rename-crash'
  });
  assert.throws(() => atomicSwitchVccStorage({
    journalPath: beforeRenameJournalPath,
    journal: beforeRenameJournal,
    faultInjector(checkpoint) {
      if (checkpoint === 'before-source-rename') throw new Error('before rename crash');
    }
  }), /before rename crash/);
  assert.equal(fs.existsSync(beforeRenameSource), true);
  assert.equal(fs.existsSync(beforeRenameTarget), true);
  fs.rmSync(beforeRenameTarget);
  assert.deepEqual(recoverVccStorageMigration({ journalPath: beforeRenameJournalPath }), {
    status: 'rolled-back',
    sourcePath: beforeRenameSource
  });
  assert.equal(fs.existsSync(beforeRenameTarget), false);

  const switchingSource = path.join(directory, 'switching.sqlite');
  const switchingTarget = path.join(directory, 'switching.next.sqlite');
  const switchingBackup = path.join(directory, 'switching.backup.sqlite');
  const switchingJournalPath = path.join(directory, 'run-data', 'switching.json');
  createLegacyDatabase(switchingSource);
  buildVccStorageCandidate({
    sourcePath: switchingSource,
    targetPath: switchingTarget,
    availableBytes: 1024 ** 4
  });
  let journal = createMigrationJournal({
    sourcePath: switchingSource,
    targetPath: switchingTarget,
    backupPath: switchingBackup,
    migrationId: 'switching-crash'
  });
  journal = updateJournal(switchingJournalPath, journal, 'switching');
  fs.renameSync(switchingSource, switchingBackup);
  assert.deepEqual(recoverVccStorageMigration({ journalPath: switchingJournalPath }), {
    status: 'completed',
    sourcePath: switchingSource
  });
  let db = new DatabaseSync(switchingSource, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 2); } finally { db.close(); }
  assert.equal(fs.existsSync(switchingBackup), true);

  const switchedSource = path.join(directory, 'switched.sqlite');
  const switchedTarget = path.join(directory, 'switched.next.sqlite');
  const switchedBackup = path.join(directory, 'switched.backup.sqlite');
  const switchedJournalPath = path.join(directory, 'run-data', 'switched.json');
  createLegacyDatabase(switchedSource);
  buildVccStorageCandidate({
    sourcePath: switchedSource,
    targetPath: switchedTarget,
    availableBytes: 1024 ** 4
  });
  let switchedJournal = createMigrationJournal({
    sourcePath: switchedSource,
    targetPath: switchedTarget,
    backupPath: switchedBackup,
    deleteOldDatabase: true,
    migrationId: 'switched-crash'
  });
  switchedJournal = updateJournal(switchedJournalPath, switchedJournal, 'switching');
  fs.renameSync(switchedSource, switchedBackup);
  fs.renameSync(switchedTarget, switchedSource);
  updateJournal(switchedJournalPath, switchedJournal, 'switched');
  assert.deepEqual(recoverVccStorageMigration({ journalPath: switchedJournalPath }), {
    status: 'completed',
    sourcePath: switchedSource
  });
  assert.equal(fs.existsSync(switchedBackup), false);

  const cleanupSource = path.join(directory, 'cleanup.sqlite');
  const cleanupTarget = path.join(directory, 'cleanup.next.sqlite');
  const cleanupBackup = path.join(directory, 'cleanup.backup.sqlite');
  const cleanupJournalPath = path.join(directory, 'run-data', 'cleanup.json');
  createLegacyDatabase(cleanupSource);
  buildVccStorageCandidate({
    sourcePath: cleanupSource,
    targetPath: cleanupTarget,
    availableBytes: 1024 ** 4
  });
  const cleanupJournal = createMigrationJournal({
    sourcePath: cleanupSource,
    targetPath: cleanupTarget,
    backupPath: cleanupBackup,
    deleteOldDatabase: true,
    migrationId: 'post-switch-cleanup-failure'
  });
  assert.throws(() => atomicSwitchVccStorage({
    journalPath: cleanupJournalPath,
    journal: cleanupJournal,
    faultInjector(checkpoint) {
      if (checkpoint === 'after-backup-delete') throw new Error('journal cleanup crash');
    }
  }), (error) => error.code === 'vcc-storage-post-switch-cleanup-failed');
  db = new DatabaseSync(cleanupSource, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 2); } finally { db.close(); }
  assert.equal(fs.existsSync(cleanupBackup), false);
  assert.equal(fs.existsSync(cleanupJournalPath), true);
  assert.deepEqual(recoverVccStorageMigration({ journalPath: cleanupJournalPath }), {
    status: 'completed',
    sourcePath: cleanupSource
  });
  assert.equal(fs.existsSync(cleanupJournalPath), false);

  const rollbackSource = path.join(directory, 'rollback.sqlite');
  const rollbackTarget = path.join(directory, 'rollback.next.sqlite');
  const rollbackBackup = path.join(directory, 'rollback.backup.sqlite');
  const rollbackJournalPath = path.join(directory, 'run-data', 'rollback.json');
  createLegacyDatabase(rollbackSource);
  buildVccStorageCandidate({
    sourcePath: rollbackSource,
    targetPath: rollbackTarget,
    availableBytes: 1024 ** 4
  });
  const rollbackJournal = createMigrationJournal({
    sourcePath: rollbackSource,
    targetPath: rollbackTarget,
    backupPath: rollbackBackup,
    migrationId: 'reopen-failure'
  });
  assert.throws(() => atomicSwitchVccStorage({
    journalPath: rollbackJournalPath,
    journal: rollbackJournal,
    faultInjector(checkpoint) {
      if (checkpoint === 'after-target-rename') {
        const candidate = new DatabaseSync(rollbackSource);
        candidate.prepare(`
          DELETE FROM app_settings WHERE setting_key = 'vcc_storage_contract_version'
        `).run();
        candidate.close();
      }
    }
  }), (error) => error.code === 'vcc-storage-reopen-contract-mismatch');
  db = new DatabaseSync(rollbackSource, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 1); } finally { db.close(); }
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(
    `${path.basename(rollbackTarget)}.failed-`
  )), false);
  assert.deepEqual(recoverVccStorageMigration({ journalPath: rollbackJournalPath }), {
    status: 'rolled-back',
    sourcePath: rollbackSource
  });
});

test('重开失败后先持久化回滚路径，候选移动后崩溃仍能恢复完整旧库', (t) => {
  const directory = tempDir(t);
  const sourcePath = path.join(directory, 'rollback-crash.sqlite');
  const targetPath = path.join(directory, 'rollback-crash.next.sqlite');
  const backupPath = path.join(directory, 'rollback-crash.backup.sqlite');
  const journalPath = path.join(directory, 'run-data', 'rollback-crash.json');
  createLegacyDatabase(sourcePath);
  buildVccStorageCandidate({ sourcePath, targetPath, availableBytes: 1024 ** 4 });
  const journal = createMigrationJournal({
    sourcePath,
    targetPath,
    backupPath,
    migrationId: 'rollback-candidate-move-crash'
  });

  assert.throws(() => atomicSwitchVccStorage({
    journalPath,
    journal,
    faultInjector(checkpoint) {
      if (checkpoint === 'after-target-rename') {
        const candidate = new DatabaseSync(sourcePath);
        candidate.prepare(`
          DELETE FROM app_settings WHERE setting_key = 'vcc_storage_contract_version'
        `).run();
        candidate.close();
      }
      if (checkpoint === 'after-failed-candidate-rename') {
        throw new Error('crash after failed candidate rename');
      }
    }
  }), (error) => error.code === 'vcc-storage-switch-recovery-failed');

  const pending = readJournal(journalPath);
  assert.equal(pending.phase, 'rolling-back');
  assert.match(path.basename(pending.failedCandidatePath), /^rollback-crash\.next\.sqlite\.failed-\d+$/);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.existsSync(pending.failedCandidatePath), true);

  assert.deepEqual(recoverVccStorageMigration({ journalPath }), {
    status: 'rolled-back',
    sourcePath
  });
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try { assert.equal(storageContractVersion(db), 1); } finally { db.close(); }
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(fs.existsSync(pending.failedCandidatePath), false);
  assert.equal(fs.existsSync(journalPath), false);
});

test('recovery 删除备份后先 fsync DB 目录，删除 journal 后 fsync journal 目录，done 可幂等补删', (t) => {
  const directory = tempDir(t);
  const journalDirectory = path.join(directory, 'run-data');
  const sourcePath = path.join(directory, 'tool-data.sqlite');
  const targetPath = path.join(directory, 'tool-data.next.sqlite');
  const backupPath = path.join(directory, 'tool-data.backup.sqlite');
  const journalPath = path.join(journalDirectory, 'migration.json');
  createLegacyDatabase(sourcePath);
  buildVccStorageCandidate({ sourcePath, targetPath, availableBytes: 1024 ** 4 });
  let journal = createMigrationJournal({
    sourcePath,
    targetPath,
    backupPath,
    deleteOldDatabase: true,
    migrationId: 'recovery-fsync-order'
  });
  journal = updateJournal(journalPath, journal, 'switching');
  fs.renameSync(sourcePath, backupPath);
  fs.renameSync(targetPath, sourcePath);
  journal = updateJournal(journalPath, journal, 'reopen-verified');
  fs.writeFileSync(`${backupPath}-wal`, 'wal');
  fs.writeFileSync(`${backupPath}-shm`, 'shm');

  const openedPaths = new Map();
  const events = [];
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (filePath, ...args) => {
          const fd = target.openSync(filePath, ...args);
          openedPaths.set(fd, path.resolve(String(filePath)));
          return fd;
        };
      }
      if (property === 'fsyncSync') {
        return (fd) => {
          events.push(`fsync:${openedPaths.get(fd) || 'unknown'}`);
          return target.fsyncSync(fd);
        };
      }
      if (property === 'closeSync') {
        return (fd) => {
          openedPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === 'unlinkSync') {
        return (filePath) => {
          events.push(`unlink:${path.resolve(String(filePath))}`);
          return target.unlinkSync(filePath);
        };
      }
      return Reflect.get(target, property);
    }
  });

  assert.throws(() => recoverVccStorageMigration({
    journalPath,
    fsImpl,
    faultInjector(checkpoint) {
      if (checkpoint === 'after-recovery-backup-delete') throw new Error('second crash');
    }
  }), /second crash/);
  const backupUnlink = events.indexOf(`unlink:${path.resolve(backupPath)}`);
  const databaseDirFsync = events.indexOf(`fsync:${path.resolve(directory)}`);
  assert.ok(backupUnlink >= 0 && databaseDirFsync > backupUnlink);
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(readJournal(journalPath).phase, 'reopen-verified');

  events.length = 0;
  assert.deepEqual(recoverVccStorageMigration({ journalPath, fsImpl }), {
    status: 'completed',
    sourcePath
  });
  const journalUnlink = events.indexOf(`unlink:${path.resolve(journalPath)}`);
  const journalDirFsync = events.findIndex((event, index) => (
    index > journalUnlink && event === `fsync:${path.resolve(journalDirectory)}`
  ));
  assert.ok(journalUnlink >= 0 && journalDirFsync > journalUnlink);

  const doneBackupPath = path.join(directory, 'done.backup.sqlite');
  const doneJournalPath = path.join(journalDirectory, 'done.json');
  fs.copyFileSync(sourcePath, doneBackupPath);
  fs.writeFileSync(`${doneBackupPath}-wal`, 'wal');
  fs.writeFileSync(`${doneBackupPath}-shm`, 'shm');
  let doneJournal = createMigrationJournal({
    sourcePath,
    targetPath: path.join(directory, 'unused.next.sqlite'),
    backupPath: doneBackupPath,
    deleteOldDatabase: true,
    migrationId: 'done-idempotent-delete'
  });
  doneJournal = updateJournal(doneJournalPath, doneJournal, 'done');
  assert.deepEqual(recoverVccStorageMigration({ journalPath: doneJournalPath }), {
    status: 'completed',
    sourcePath
  });
  assert.equal(fs.existsSync(doneBackupPath), false);
  assert.equal(fs.existsSync(`${doneBackupPath}-wal`), false);
  assert.equal(fs.existsSync(`${doneBackupPath}-shm`), false);
  assert.equal(fs.existsSync(doneJournalPath), false);
});
