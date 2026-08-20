'use strict';

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  PENDING_HEADERS,
  PENDING_V1_HEADERS
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  mapDetailRow,
  mappedRowToInsertParams
} = require('../../../../src/backend/vcc-financial-op/row-mapper');
const {
  classifyAndPromote
} = require('../../../../src/backend/vcc-financial-op/detail-importer');

function createDb(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => db.close());
  return db;
}

function pendingFields(overrides = {}) {
  return {
    平账账期: '2026-06',
    主体: 'PPHK',
    对账类型: 'VCC_clearing_debit',
    PendingBizId: 'PENDING-1',
    金额: '10.00',
    币种: 'USD',
    流水_币种: 'USD',
    流水_对账金额: '10.00',
    ...overrides
  };
}

function values(headers, fields) {
  return headers.map((header) => Object.hasOwn(fields, header) ? fields[header] : '');
}

function frozenPendingV2Hash(rawValues, rawContractVersion) {
  let canonicalValues;
  if (Number(rawContractVersion) === 1) {
    const byHeader = Object.fromEntries(
      PENDING_V1_HEADERS.map((header, index) => [header, rawValues[index]])
    );
    canonicalValues = PENDING_HEADERS.map((header) => byHeader[header]);
  } else if (Number(rawContractVersion) === 2) {
    canonicalValues = [...rawValues];
  } else {
    throw new Error(`测试不支持的历史 Pending raw contract：${rawContractVersion}`);
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalValues), 'utf8')
    .digest('hex');
}

function seedRecord(db, batchId = 'legacy-batch') {
  repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
  return repository.createImportRecord(db, {
    batchId,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.PENDING,
    sourceFiles: [`${batchId}.xlsx`]
  });
}

test('历史 48 列 Pending 保留 raw_json，迁为 v2 hash 后可被 46 列精确重放', (t) => {
  const db = createDb(t);
  const legacyFields = pendingFields({ 是否错币: '人工旧值', 金额差: '999.99' });
  const legacyValues = values(PENDING_V1_HEADERS, legacyFields);
  const legacyRawJson = JSON.stringify(legacyValues);
  const legacyHash = crypto.createHash('sha256').update(legacyRawJson).digest('hex');
  const recordId = seedRecord(db);
  repository.finishImportRecord(db, recordId, { status: 'success', rawCount: 1, insertedCount: 1 });
  repository.finishImportBatch(db, 'legacy-batch', 'success');
  const effectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
      target_month, subject, pending_currency, pending_amount, flow_currency, flow_amount,
      currency_mismatch, source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, 'PENDING-1', 'PENDING-1', ?, 1, '2026-06', 'PPHK',
      'USD', '10', 'USD', '-10', 0, 'legacy.xlsx', 'Pending', 2, ?, ?)
  `).run(SOURCE_TYPES.PENDING, legacyHash, legacyRawJson, recordId).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, idempotency_key_raw, idempotency_key,
      content_hash, hash_version, subject, source_file, sheet_name, source_row, raw_json,
      disposition, existing_effective_id
    ) VALUES (?, ?, '2026-06', 'PENDING-1', 'PENDING-1', ?, 1, 'PPHK',
      'retry-old.xlsx', 'Pending', 2, ?, 'idempotent_skip', ?)
  `).run(recordId, SOURCE_TYPES.PENDING, legacyHash, legacyRawJson, effectiveId);

  ensureVccFinancialOpTablesSupport(db);
  const migrated = db.prepare(`
    SELECT content_hash, legacy_content_hash, hash_version, raw_contract_version, raw_json
    FROM vcc_fin_op_effective_rows WHERE id = ?
  `).get(effectiveId);
  const expectedV2Hash = frozenPendingV2Hash(legacyValues, 1);
  assert.equal(migrated.content_hash, expectedV2Hash);
  assert.equal(migrated.legacy_content_hash, legacyHash);
  assert.equal(migrated.hash_version, 2);
  assert.equal(migrated.raw_contract_version, 1);
  assert.equal(migrated.raw_json, legacyRawJson);
  const migratedAudit = db.prepare(`
    SELECT content_hash, hash_version, raw_contract_version
    FROM vcc_fin_op_import_rows WHERE import_record_id = ?
  `).get(recordId);
  assert.deepEqual({ ...migratedAudit }, {
    content_hash: expectedV2Hash,
    hash_version: 2,
    raw_contract_version: 1
  });

  const replayRecordId = seedRecord(db, 'replay-batch');
  const replaySourceId = repository.createImportSource(db, replayRecordId, {
    sourceOrdinal: 1,
    fileName: 'new-46.xlsx',
    sha256: 'b'.repeat(64),
    sizeBytes: 1
  });
  const mapped = mapDetailRow({
    sourceType: SOURCE_TYPES.PENDING,
    values: values(PENDING_HEADERS, pendingFields()),
    targetMonth: '2026-06',
    sourceFile: 'new-46.xlsx',
    sheetName: 'Pending',
    sourceRow: 2,
    keyCellType: 's'
  });
  assert.equal(mapped.hashVersion, 3);
  const replayParams = mappedRowToInsertParams(replayRecordId, mapped);
  db.prepare(repository.STAGING_ROW_INSERT_SQL)
    .run(replayParams[0], replaySourceId, ...replayParams.slice(1));
  const replay = classifyAndPromote(
    db,
    replayRecordId,
    '2026-06',
    SOURCE_TYPES.PENDING
  );
  assert.equal(replay.status, 'all_skipped');
  assert.equal(replay.skippedCount, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows
    WHERE source_type = ? AND idempotency_key = 'PENDING-1'
  `).get(SOURCE_TYPES.PENDING).n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_staging_rows
  `).get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ?
  `).get(replayRecordId).n, 0);
});

test('已有 Pending v2 行再次启动时 hash、版本和 raw audit 保持不变', (t) => {
  const db = createDb(t);
  const recordId = seedRecord(db, 'frozen-v2');
  const rawValues = values(PENDING_HEADERS, pendingFields({ PendingBizId: 'V2-FROZEN' }));
  const rawJson = JSON.stringify(rawValues);
  const frozenHash = frozenPendingV2Hash(rawValues, 2);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash, hash_version,
      raw_contract_version, target_month, subject, pending_currency, pending_amount,
      flow_currency, flow_amount, currency_mismatch, source_file, sheet_name, source_row,
      raw_json, import_record_id
    ) VALUES (?, 'V2-FROZEN', 'V2-FROZEN', ?, 2, 2, '2026-06',
      'PPHK', 'USD', '10', 'USD', '-10', 0, 'frozen-v2.xlsx', 'Pending', 2, ?, ?)
  `).run(SOURCE_TYPES.PENDING, frozenHash, rawJson, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, idempotency_key_raw, idempotency_key,
      content_hash, hash_version, raw_contract_version, subject, source_file, sheet_name,
      source_row, raw_json, disposition
    ) VALUES (?, ?, '2026-06', 'V2-FROZEN', 'V2-FROZEN', ?,
      2, 2, 'PPHK', 'frozen-v2.xlsx', 'Pending', 2, ?, 'accepted')
  `).run(recordId, SOURCE_TYPES.PENDING, frozenHash, rawJson);

  ensureVccFinancialOpTablesSupport(db);
  ensureVccFinancialOpTablesSupport(db);

  assert.deepEqual({ ...db.prepare(`
    SELECT content_hash, hash_version, raw_contract_version, raw_json
    FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'V2-FROZEN'
  `).get() }, {
    content_hash: frozenHash,
    hash_version: 2,
    raw_contract_version: 2,
    raw_json: rawJson
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT content_hash, hash_version, raw_contract_version, raw_json
    FROM vcc_fin_op_import_rows WHERE idempotency_key = 'V2-FROZEN'
  `).get() }, {
    content_hash: frozenHash,
    hash_version: 2,
    raw_contract_version: 2,
    raw_json: rawJson
  });
});

test('3.1.12 新导入 Pending CNH 写 hash v3，后续启动不降级或重算', (t) => {
  const db = createDb(t);
  const recordId = seedRecord(db, 'new-v3-cnh');
  const sourceId = repository.createImportSource(db, recordId, {
    sourceOrdinal: 1,
    fileName: 'new-v3-cnh.xlsx',
    sha256: 'c'.repeat(64),
    sizeBytes: 1
  });
  const mapped = mapDetailRow({
    sourceType: SOURCE_TYPES.PENDING,
    values: values(PENDING_HEADERS, pendingFields({
      PendingBizId: 'NEW-V3-CNH',
      币种: 'CNH',
      流水_币种: 'CNY'
    })),
    targetMonth: '2026-06',
    sourceFile: 'new-v3-cnh.xlsx',
    sheetName: 'Pending',
    sourceRow: 2,
    keyCellType: 's'
  });
  const params = mappedRowToInsertParams(recordId, mapped);
  db.prepare(repository.STAGING_ROW_INSERT_SQL).run(params[0], sourceId, ...params.slice(1));
  const imported = classifyAndPromote(db, recordId, '2026-06', SOURCE_TYPES.PENDING);
  assert.equal(imported.insertedCount, 1);
  const before = db.prepare(`
    SELECT content_hash, hash_version, pending_currency, flow_currency, raw_json
    FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'NEW-V3-CNH'
  `).get();
  assert.equal(before.hash_version, 3);
  assert.deepEqual([before.pending_currency, before.flow_currency], ['CNY', 'CNY']);
  assert.equal(JSON.parse(before.raw_json)[PENDING_HEADERS.indexOf('币种')], 'CNH');

  ensureVccFinancialOpTablesSupport(db);

  assert.deepEqual({ ...db.prepare(`
    SELECT content_hash, hash_version, pending_currency, flow_currency, raw_json
    FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'NEW-V3-CNH'
  `).get() }, { ...before });
});

test('未知 Pending raw_json 列数阻断迁移且不修改历史 hash', (t) => {
  const db = createDb(t);
  const recordId = seedRecord(db, 'invalid-shape');
  const originalHash = 'legacy-invalid-hash';
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, 'BAD-1', 'BAD-1', ?, '2026-06', 'PPHK',
      'bad.xlsx', 'Pending', 2, '["only-one"]', ?)
  `).run(SOURCE_TYPES.PENDING, originalHash, recordId);

  assert.throws(
    () => ensureVccFinancialOpTablesSupport(db),
    (error) => {
      assert.equal(error.code, 'pending-contract-migration-blocked');
      assert.match(error.message, /既不是历史 48 列也不是最新 46 列/);
      return true;
    }
  );
  const stored = db.prepare(`
    SELECT content_hash, hash_version, raw_contract_version, legacy_content_hash
    FROM vcc_fin_op_effective_rows WHERE idempotency_key = 'BAD-1'
  `).get();
  assert.deepEqual({ ...stored }, {
    content_hash: originalHash,
    hash_version: 1,
    raw_contract_version: 1,
    legacy_content_hash: null
  });
});

test('极老审计表存在 Pending 行但没有 raw_json 时失败关闭', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE vcc_fin_op_import_rows (
      id INTEGER PRIMARY KEY,
      import_record_id INTEGER,
      source_type TEXT,
      idempotency_key TEXT,
      content_hash TEXT,
      disposition TEXT,
      existing_effective_id INTEGER,
      comparison_import_row_id INTEGER
    );
    INSERT INTO vcc_fin_op_import_rows (
      id, source_type, idempotency_key, content_hash, disposition
    ) VALUES (1, 'pending_archive_removal', 'LEGACY-1', 'legacy-hash', 'accepted');
  `);

  assert.throws(
    () => ensureVccFinancialOpTablesSupport(db),
    (error) => {
      assert.equal(error.code, 'pending-contract-migration-blocked');
      assert.match(error.message, /存在 1 条 Pending 记录/);
      assert.match(error.message, /raw_json/);
      return true;
    }
  );
  const columns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_import_rows)').all().map((row) => row.name)
  );
  assert.equal(columns.has('raw_contract_version'), false);
  assert.equal(
    db.prepare('SELECT content_hash FROM vcc_fin_op_import_rows WHERE id = 1').get().content_hash,
    'legacy-hash'
  );
});
