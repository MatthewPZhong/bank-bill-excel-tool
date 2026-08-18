'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpStateModelSupport,
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  VCC_STORAGE_CONTRACT_VERSION,
  createSlimEffectiveRowsTable,
  setVccStorageContractVersion
} = require('../../../../src/backend/vcc-financial-op-db/storage-contract');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  previousYearMonth,
  nextYearMonth,
  initializeOpeningBalances,
  preflightCalculation,
  aggregateEffectiveRows,
  calculateMonth,
  archiveRun,
  loadOpeningBalances
} = require('../../../../src/backend/vcc-financial-op/calculator');
const {
  buildRunRowKey,
  addRunAdjustment
} = require('../../../../src/backend/vcc-financial-op/result-adjustments');

const RECHARGE_RESULT_ROW = Object.freeze({
  rowKind: 'movement',
  subject: 'PPHK',
  sourceType: SOURCE_TYPES.RECHARGE,
  categoryMajor: '充值',
  categoryMinor: 'OPS'
});

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

function replaceEffectiveRowsWithSlimSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  createSlimEffectiveRowsTable(db, 'vcc_fin_op_effective_rows_v2_test');
  db.exec(`
    INSERT INTO vcc_fin_op_effective_rows_v2_test (
      id, source_type, idempotency_key, content_hash, hash_version,
      raw_contract_version, legacy_content_hash, target_month, subject,
      stat_currency, signed_amount, business_department, counterparty_department,
      business_sub_type, channel_name, mid, recon_type, pending_currency,
      pending_amount, flow_currency, flow_amount, currency_mismatch,
      import_record_id, import_source_id, sheet_name, source_row, first_imported_at
    )
    SELECT
      id, source_type, idempotency_key, content_hash, hash_version,
      raw_contract_version, legacy_content_hash, target_month, subject,
      stat_currency, signed_amount, business_department, counterparty_department,
      business_sub_type, channel_name, mid, recon_type, pending_currency,
      pending_amount, flow_currency, flow_amount, currency_mismatch,
      import_record_id, import_source_id, sheet_name, source_row, first_imported_at
    FROM vcc_fin_op_effective_rows;
    PRAGMA foreign_keys = OFF;
    DROP TABLE vcc_fin_op_effective_rows;
    ALTER TABLE vcc_fin_op_effective_rows_v2_test RENAME TO vcc_fin_op_effective_rows;
  `);
  setVccStorageContractVersion(db, VCC_STORAGE_CONTRACT_VERSION);
  ensureVccFinancialOpTablesSupport(db);
  db.exec('PRAGMA foreign_keys = ON');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function fixedBalances(value = '100') {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, value]));
}

function seedRecord(db, sourceType, recordIdSuffix = sourceType) {
  const batchId = `batch-${recordIdSuffix}`;
  repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth: '2026-06',
    sourceType,
    sourceFiles: [`${sourceType}.xlsx`]
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  repository.finishImportBatch(db, batchId, 'success');
  return recordId;
}

function seedDataset(db, sourceType, revision = 1) {
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type, data_status, revision)
    VALUES ('2026-06', ?, 'unprocessed', ?)
  `).run(sourceType, revision);
}

function insertEffective(db, fields) {
  const recordId = fields.importRecordId || seedRecord(db, fields.sourceType, fields.key);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      business_sub_type, counterparty_department, channel_name, mid,
      recon_type, pending_currency, pending_amount, flow_currency, flow_amount,
      currency_mismatch, source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, '2026-06', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'x.xlsx', 'sheet1', 2, '[]', ?)
  `).run(
    fields.sourceType,
    fields.key,
    fields.key,
    `hash-${fields.sourceType}-${fields.key}`,
    fields.subject || 'PPHK',
    fields.currency || null,
    fields.amount || null,
    fields.businessSubType || '',
    fields.counterpartyDepartment || '',
    fields.channelName || '',
    fields.mid || '',
    fields.reconType || null,
    fields.pendingCurrency || null,
    fields.pendingAmount || null,
    fields.flowCurrency || null,
    fields.flowAmount || null,
    fields.currencyMismatch ?? null,
    recordId
  );
}

function insertSystemSnapshot(db, { subject, balances = fixedBalances('100'), key = subject }) {
  const recordId = seedRecord(db, SOURCE_TYPES.SYSTEM_OP, `system-${key}`);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', ?, ?, ?, ?, 'Validate', 3, '{}', ?)
  `).run(
    subject,
    JSON.stringify(balances),
    `system-hash-${key}`,
    `system-${key}.xlsx`,
    recordId
  );
}

function seedCompleteMonth(db, { includeOpening = true, legacyUnresolved = false } = {}) {
  for (const sourceType of [
    SOURCE_TYPES.RECHARGE,
    SOURCE_TYPES.FEE_FX,
    SOURCE_TYPES.CHANNEL,
    SOURCE_TYPES.PENDING,
    SOURCE_TYPES.SYSTEM_OP
  ]) seedDataset(db, sourceType);

  insertEffective(db, {
    sourceType: SOURCE_TYPES.RECHARGE, key: 'r1', currency: 'USD', amount: '10',
    businessSubType: '充值', counterpartyDepartment: 'OPS'
  });
  insertEffective(db, {
    sourceType: SOURCE_TYPES.FEE_FX, key: 'f1', currency: 'USD', amount: '-2',
    businessSubType: '手续费'
  });
  insertEffective(db, {
    sourceType: SOURCE_TYPES.CHANNEL, key: 'c1', currency: 'EUR', amount: '3',
    channelName: 'CITI', mid: 'MID-1'
  });
  insertEffective(db, {
    sourceType: SOURCE_TYPES.PENDING, key: 'p1', reconType: 'VCC_clearing_credit',
    pendingCurrency: 'USD', pendingAmount: '-5', flowCurrency: 'EUR', flowAmount: '5',
    currencyMismatch: 1, channelName: 'CITI'
  });

  const systemRecordId = seedRecord(db, SOURCE_TYPES.SYSTEM_OP, 'system');
  const systemBalances = fixedBalances('100');
  systemBalances.USD = '104';
  systemBalances.EUR = '106';
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK', ?, 'system-hash', 'system.xlsx', 'Validate', 3, '{}', ?)
  `).run(JSON.stringify(systemBalances), systemRecordId);

  if (includeOpening) {
    db.prepare(`
      UPDATE vcc_fin_op_module_state
      SET first_month = '2026-05', updated_at = datetime('now', 'localtime')
      WHERE singleton_id = 1
    `).run();
    db.prepare(`
      INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
      VALUES ('2026-05', 'archived', '{}')
    `).run();
    const previousRunId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
      VALUES ('2026-05', 'PPHK', ?, ?)
    `).run(JSON.stringify(fixedBalances('100')), previousRunId);
  }

  if (legacyUnresolved) {
    const batchId = 'failed-batch';
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
    const failedId = repository.createImportRecord(db, {
      batchId, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE,
      sourceFiles: ['bad.xlsx']
    });
    repository.finishImportRecord(db, failedId, {
      status: 'failed_conflict', rawCount: 1, conflictCount: 1, errorMessage: '冲突'
    });
    db.prepare(`
      UPDATE vcc_fin_op_import_records SET resolution_status = 'unresolved' WHERE id = ?
    `).run(failedId);
    repository.finishImportBatch(db, batchId, 'completed_with_errors', '冲突');
    return failedId;
  }
  return null;
}

function calculateCurrent(db, targetMonth = '2026-06', options = {}) {
  const preflight = preflightCalculation(db, targetMonth);
  return calculateMonth({
    ...options,
    db,
    targetMonth,
    expectedInputFingerprint: preflight.inputFingerprint
  });
}

test('previousYearMonth 正确跨年', () => {
  assert.equal(previousYearMonth('2026-01'), '2025-12');
  assert.equal(previousYearMonth('2026-06'), '2026-05');
  assert.equal(nextYearMonth('2026-12'), '2027-01');
});

test('缺少上月归档时明确阻断且不默认补零', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const result = calculateCurrent(db);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'missing-opening-balance');
  assert.deepEqual(result.missingOpeningSubjects, ['PPHK']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = ?').get('2026-06').n, 0);
});

test('运行前预检要求四类明细和系统财务OP全部存在且逐表返回结构化状态', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  db.prepare(`
    DELETE FROM vcc_fin_op_effective_rows
    WHERE source_type = ?
  `).run(SOURCE_TYPES.PENDING);

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'missing-datasets');
  assert.deepEqual(preflight.missing, ['VCC_移除归档Pending账单_校验表']);
  assert.equal(preflight.datasets.length, 5);
  const pending = preflight.datasets.find((row) => row.sourceType === SOURCE_TYPES.PENDING);
  assert.deepEqual(pending, {
    sourceType: SOURCE_TYPES.PENDING,
    label: 'VCC_移除归档Pending账单_校验表',
    datasetExists: true,
    rowCount: 0,
    dataStatus: 'unprocessed',
    revision: 1,
    complete: false,
    reason: '没有有效数据'
  });
});

test('缺表与缺上月归档并存时主 code 保持缺表且一次展示全部门禁', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  db.prepare(`
    UPDATE vcc_fin_op_module_state SET first_month = '2026-05'
    WHERE singleton_id = 1
  `).run();
  db.prepare(`
    DELETE FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.PENDING);

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.code, 'missing-datasets');
  assert.deepEqual(preflight.issues.map((issue) => issue.code), [
    'missing-dataset',
    'missing-previous-archive'
  ]);
  assert.equal(preflight.message, preflight.issues.map((issue) => issue.message).join('\n'));
  assert.equal(preflight.openingState.code, 'missing-previous-archive');
  assert.deepEqual(preflight.missing, ['VCC_移除归档Pending账单_校验表']);
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '不得绕过缺表门禁'
  }), (error) => {
    assert.equal(error.code, 'missing-datasets');
    assert.deepEqual(error.preflight.issues.map((issue) => issue.code), [
      'missing-dataset',
      'missing-previous-archive'
    ]);
    return true;
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('运行前预检返回空表和损坏系统快照，旧 unresolved 失败记录只保留审计', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const failedId = seedCompleteMonth(db, { legacyUnresolved: true });
  db.prepare(`
    DELETE FROM vcc_fin_op_effective_rows
    WHERE source_type = ?
  `).run(SOURCE_TYPES.PENDING);
  const invalidBalances = fixedBalances('100');
  delete invalidBalances.USD;
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshots
    SET balances_json = ?
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).run(JSON.stringify(invalidBalances));

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'missing-datasets');
  assert.deepEqual(preflight.missing, ['VCC_移除归档Pending账单_校验表']);
  assert.deepEqual(preflight.issues.map((issue) => issue.code), [
    'empty-dataset',
    'invalid-system-snapshot'
  ]);
  assert.match(preflight.issues[1].message, /PPHK/);
  assert.match(preflight.issues[1].message, /USD/);
  assert.equal(preflight.issues.some((issue) => issue.recordIds?.includes(failedId)), false);
  assert.equal(preflight.message, preflight.issues.map((issue) => issue.message).join('\n'));
});

test('非法系统快照与首月待初始化并存时先阻断且不写入期初', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const invalidBalances = fixedBalances('100');
  delete invalidBalances.USD;
  db.prepare(`
    UPDATE vcc_fin_op_system_snapshots
    SET balances_json = ?
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).run(JSON.stringify(invalidBalances));

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'invalid-system-snapshots');
  assert.deepEqual(preflight.missing, []);
  assert.deepEqual(preflight.issues.map((issue) => issue.code), [
    'invalid-system-snapshot'
  ]);
  assert.equal(preflight.message, preflight.issues[0].message);
  assert.equal(preflight.openingState.status, 'first-month-initialization-required');
  assert.deepEqual(preflight.openingState.missingOpeningSubjects, ['PPHK']);

  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '不得绕过损坏快照门禁'
  }), (error) => {
    assert.equal(error.code, 'invalid-system-snapshots');
    assert.equal(error.preflight.openingState.status, 'first-month-initialization-required');
    return true;
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances WHERE target_month = '2026-06'
  `).get().n, 0);
  assert.equal(db.prepare(`
    SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1
  `).get().first_month, null);
});

test('迁移诊断与缺表并存时诊断保持最高优先且 issues 不重复', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES (?, ?, ?, ?, '历史异常期初')
  `);
  insert.run('2026-04', 'LEGACY-A', JSON.stringify(fixedBalances('1')), 'hash-a');
  insert.run('2026-05', 'LEGACY-B', JSON.stringify(fixedBalances('2')), 'hash-b');
  const migration = ensureVccFinancialOpStateModelSupport(db);
  assert.equal(migration.code, 'vcc-first-month-migration-blocked');
  db.prepare(`
    DELETE FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.PENDING);

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'vcc-first-month-migration-blocked');
  assert.deepEqual(preflight.issues.map((issue) => issue.code), [
    'vcc-first-month-migration-blocked',
    'missing-dataset'
  ]);
  assert.equal(preflight.message, preflight.issues.map((issue) => issue.message).join('\n'));
  assert.equal(preflight.openingState.status, 'blocked');
  assert.equal(preflight.openingState.reason, 'multiple-opening-months');

  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '不得绕过迁移诊断与缺表门禁'
  }), (error) => {
    assert.equal(error.code, 'vcc-first-month-migration-blocked');
    assert.deepEqual(error.preflight.issues.map((issue) => issue.code), [
      'vcc-first-month-migration-blocked',
      'missing-dataset'
    ]);
    return true;
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('calculateMonth 缺少或伪造 fingerprint 时在事务和写结果前失败关闭', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);

  for (const expectedInputFingerprint of [undefined, '', '0'.repeat(63), 'A'.repeat(64)]) {
    const result = calculateMonth({
      db,
      targetMonth: '2026-06',
      expectedInputFingerprint
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'preflight-required');
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('worker 二次预检以输入 fingerprint 阻断预检后的数据变化', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const preview = preflightCalculation(db, '2026-06');
  assert.equal(preview.ok, true);
  db.prepare(`
    UPDATE vcc_fin_op_datasets
    SET revision = revision + 1
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.PENDING);

  const result = calculateMonth({
    db,
    targetMonth: '2026-06',
    expectedInputFingerprint: preview.inputFingerprint
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'state-changed');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('上月归档主体即使本月无发生额也必须延续并校验系统财务OP', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const previousRunId = db.prepare(`
    SELECT id FROM vcc_fin_op_runs WHERE target_month = '2026-05'
  `).get().id;
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
    VALUES ('2026-05', 'PPHK-NO-MOVEMENT', ?, ?)
  `).run(JSON.stringify(fixedBalances('50')), previousRunId);

  const blocked = calculateCurrent(db);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'missing-system-subject');
  assert.deepEqual(blocked.missingSystemSubjects, ['PPHK-NO-MOVEMENT']);

  const systemRecordId = seedRecord(db, SOURCE_TYPES.SYSTEM_OP, 'system-no-movement');
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK-NO-MOVEMENT', ?, 'system-no-movement-hash',
              'system-extra.xlsx', 'Validate', 3, '{}', ?)
  `).run(JSON.stringify(fixedBalances('50')), systemRecordId);

  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'calculated');
  assert.ok(calculated.subjects.includes('PPHK-NO-MOVEMENT'));
  const extraUsd = calculated.balances.find((row) => (
    row.subject === 'PPHK-NO-MOVEMENT' && row.currency === 'USD'
  ));
  assert.equal(extraUsd.periodAmount, '0');
  assert.equal(extraUsd.calculatedBalance, '50');
  assert.equal(extraUsd.difference, '0');
});

test('首月期初逐主体九币种一次性初始化，同值重试跳过且异值禁止改写', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const entry = { subject: 'PPHK', balances: fixedBalances('100') };

  const initialized = initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [entry],
    note: '已与账务期初表逐币种核对'
  });
  const replay = initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [entry],
    note: '网络重试'
  });
  assert.equal(initialized.status, 'initialized');
  assert.equal(initialized.firstMonth, '2026-06');
  assert.deepEqual(initialized.initializedSubjects, ['PPHK']);
  assert.equal(replay.status, 'all_skipped');
  assert.equal(
    db.prepare(`SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1`).get()
      .first_month,
    '2026-06'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances').get().n, 1);
  assert.equal(
    db.prepare('SELECT initialization_note FROM vcc_fin_op_opening_balances').get().initialization_note,
    '已与账务期初表逐币种核对'
  );

  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: { ...fixedBalances('100'), USD: '101' } }],
    note: '试图改写'
  }), /已经初始化，禁止改写/);
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'UNKNOWN', balances: fixedBalances('100') }],
    note: '试图新增未知主体'
  }), /UNKNOWN 不属于 2026-06 的有效原表主体/);

  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'calculated');
  assert.equal(calculated.balances.find((row) => row.currency === 'USD').openingBalance, '100');
});

test('首月已初始化主体不要求重复提交，新增主体可单独初始化', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: 'PPHK 首月期初已核对'
  });
  const oldBefore = db.prepare(`
    SELECT balances_json, content_hash, initialization_note
    FROM vcc_fin_op_opening_balances
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).get();

  insertEffective(db, {
    sourceType: SOURCE_TYPES.RECHARGE,
    key: 'new-subject-recharge',
    subject: 'NEW',
    currency: 'USD',
    amount: '1',
    businessSubType: '充值',
    counterpartyDepartment: 'OPS'
  });
  insertSystemSnapshot(db, {
    subject: 'NEW',
    balances: fixedBalances('200'),
    key: 'new-subject'
  });

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, true);
  assert.equal(preflight.openingState.status, 'first-month-initialization-required');
  assert.deepEqual(preflight.openingState.missingOpeningSubjects, ['NEW']);
  const calculation = calculateCurrent(db);
  assert.equal(calculation.status, 'blocked');
  assert.equal(calculation.code, 'missing-opening-balance');
  assert.deepEqual(calculation.missingOpeningSubjects, ['NEW']);

  const initialized = initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'NEW', balances: fixedBalances('200') }],
    note: 'NEW 首月期初已核对'
  });
  assert.equal(initialized.status, 'initialized');
  assert.equal(initialized.firstMonth, '2026-06');
  assert.deepEqual(initialized.initializedSubjects, ['NEW']);
  assert.deepEqual(initialized.skippedSubjects, []);
  assert.deepEqual(
    db.prepare(`
      SELECT balances_json, content_hash, initialization_note
      FROM vcc_fin_op_opening_balances
      WHERE target_month = '2026-06' AND subject = 'PPHK'
    `).get(),
    oldBefore
  );
  assert.deepEqual(
    JSON.parse(db.prepare(`
      SELECT balances_json FROM vcc_fin_op_opening_balances
      WHERE target_month = '2026-06' AND subject = 'NEW'
    `).get().balances_json),
    fixedBalances('200')
  );
  assert.equal(
    db.prepare(`SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1`).get()
      .first_month,
    '2026-06'
  );
  assert.equal(preflightCalculation(db, '2026-06').openingState.status, 'ready');
});

test('新增主体仍必须全部提交，漏交真正缺失主体时整次回滚', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: 'PPHK 首月期初已核对'
  });
  for (const subject of ['NEW', 'NEW2']) {
    insertEffective(db, {
      sourceType: SOURCE_TYPES.RECHARGE,
      key: `${subject}-recharge`,
      subject,
      currency: 'USD',
      amount: '1',
      businessSubType: '充值',
      counterpartyDepartment: 'OPS'
    });
    insertSystemSnapshot(db, { subject, balances: fixedBalances('200'), key: subject });
  }

  assert.deepEqual(
    preflightCalculation(db, '2026-06').openingState.missingOpeningSubjects,
    ['NEW', 'NEW2']
  );
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'NEW', balances: fixedBalances('200') }],
    note: '故意漏交 NEW2'
  }), /以下主体仍缺少期初财务OP：NEW2/);
  assert.deepEqual(
    db.prepare(`
      SELECT subject FROM vcc_fin_op_opening_balances
      WHERE target_month = '2026-06' ORDER BY subject
    `).all().map((row) => row.subject),
    ['PPHK']
  );
  assert.equal(
    db.prepare(`SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1`).get()
      .first_month,
    '2026-06'
  );
});

test('期初初始化拒绝缺币种、超两位小数和不属于当前账期的主体', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const missingCurrency = fixedBalances('100');
  delete missingCurrency.USD;
  assert.throws(() => initializeOpeningBalances({
    db, targetMonth: '2026-06', entries: [{ subject: 'PPHK', balances: missingCurrency }], note: '核对'
  }), /缺少 USD/);
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: { ...fixedBalances('100'), USD: '1.234' } }],
    note: '核对'
  }), /最多支持 2 位小数/);
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'UNKNOWN', balances: fixedBalances('100') }],
    note: '核对'
  }), /仍缺少期初财务OP|不属于/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances').get().n, 0);
});

test('首月期初写入与 first_month 同事务，claim 失败时两者全部回滚', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  db.exec(`
    CREATE TRIGGER force_first_month_claim_failure
    BEFORE UPDATE OF first_month ON vcc_fin_op_module_state
    BEGIN
      SELECT RAISE(ABORT, 'forced first-month claim failure');
    END;
  `);

  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '原子性回滚测试'
  }), /forced first-month claim failure/);
  assert.equal(
    db.prepare(`SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1`).get()
      .first_month,
    null
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances`).get().n,
    0
  );
});

test('非首月缺少上月归档时预检、计算和人工期初均结构化阻断', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  db.prepare(`
    UPDATE vcc_fin_op_module_state
    SET first_month = '2026-05', updated_at = datetime('now', 'localtime')
    WHERE singleton_id = 1
  `).run();

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'missing-previous-archive');
  assert.deepEqual(preflight.openingState.missingArchiveSubjects, ['PPHK']);
  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'blocked');
  assert.equal(calculated.code, 'missing-previous-archive');
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '试图跨月补期初'
  }), (error) => {
    assert.equal(error.code, 'missing-previous-archive');
    return true;
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances`).get().n, 0);
});

test('目标账期早于 first_month 时 fail-closed', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  db.prepare(`
    UPDATE vcc_fin_op_module_state SET first_month = '2026-07'
    WHERE singleton_id = 1
  `).run();

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'target-before-first-month');
  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'blocked');
  assert.equal(calculated.code, 'target-before-first-month');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_runs`).get().n, 0);
});

test('首月迁移诊断不阻断建库，但阻断预检、计算和期初初始化', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db, { includeOpening: false });
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES (?, ?, ?, ?, '历史异常期初')
  `);
  insert.run('2026-04', 'LEGACY-A', JSON.stringify(fixedBalances('1')), 'hash-a');
  insert.run('2026-05', 'LEGACY-B', JSON.stringify(fixedBalances('2')), 'hash-b');
  const migration = ensureVccFinancialOpStateModelSupport(db);
  assert.equal(migration.code, 'vcc-first-month-migration-blocked');

  const preflight = preflightCalculation(db, '2026-06');
  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, 'vcc-first-month-migration-blocked');
  assert.equal(preflight.openingState.reason, 'multiple-opening-months');
  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'blocked');
  assert.equal(calculated.code, 'vcc-first-month-migration-blocked');
  assert.throws(() => initializeOpeningBalances({
    db,
    targetMonth: '2026-06',
    entries: [{ subject: 'PPHK', balances: fixedBalances('100') }],
    note: '迁移诊断门禁测试'
  }), (error) => {
    assert.equal(error.code, 'vcc-first-month-migration-blocked');
    return true;
  });
});

test('逐主体逐币种精确汇总四类发生额并计算系统差异', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const result = calculateCurrent(db);
  assert.equal(result.status, 'calculated');
  const byCurrency = Object.fromEntries(result.balances.map((row) => [row.currency, row]));

  assert.equal(byCurrency.USD.periodAmount, '3');
  assert.equal(byCurrency.USD.calculatedBalance, '103');
  assert.equal(byCurrency.USD.systemBalance, '104');
  assert.equal(byCurrency.USD.difference, '1');
  assert.equal(byCurrency.EUR.periodAmount, '8');
  assert.equal(byCurrency.EUR.calculatedBalance, '108');
  assert.equal(byCurrency.EUR.systemBalance, '106');
  assert.equal(byCurrency.EUR.difference, '-2');

  const storedRun = db.prepare(`
    SELECT result_revision, input_fingerprint, updated_at
    FROM vcc_fin_op_runs WHERE id = ?
  `).get(result.runId);
  assert.equal(storedRun.result_revision, 0);
  assert.equal(storedRun.input_fingerprint, result.inputFingerprint);
  assert.match(storedRun.input_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(storedRun.updated_at, /^\d{4}-\d{2}-\d{2} /);

  const pending = db.prepare(`
    SELECT * FROM vcc_fin_op_pending_summary_rows WHERE run_id = ?
  `).get(result.runId);
  assert.equal(pending.flow_amount, '5');
  assert.equal(pending.pending_amount, '-5');
  assert.equal(pending.currency_mismatch, 1);
  const pendingTotals = db.prepare(`
    SELECT currency, amount FROM vcc_fin_op_pending_currency_totals
    WHERE run_id = ? ORDER BY currency
  `).all(result.runId);
  assert.deepEqual(
    pendingTotals.map((row) => [row.currency, row.amount]),
    [['EUR', '5'], ['USD', '-5']]
  );
});

test('storage contract v2 slim effective 保持计算、九币种余额与归档语义', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  replaceEffectiveRowsWithSlimSchema(db);

  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'calculated');
  const byCurrency = Object.fromEntries(calculated.balances.map((row) => [row.currency, row]));
  assert.equal(byCurrency.USD.calculatedBalance, '103');
  assert.equal(byCurrency.CNY.calculatedBalance, '100');
  assert.equal(byCurrency.EUR.calculatedBalance, '108');

  const archived = archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 0
  });
  assert.equal(archived.status, 'archived');
  assert.equal(JSON.parse(db.prepare(`
    SELECT balances_json FROM vcc_fin_op_archives
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).get().balances_json).USD, '103');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND data_status = 'archived'
  `).get().n, 5);
});

test('历史有效明细的 CNH 只读归一为 CNY 且不改原始事实', (t) => {
  const db = createDb();
  t.after(() => db.close());
  insertEffective(db, {
    sourceType: SOURCE_TYPES.RECHARGE,
    key: 'legacy-cnh-movement',
    currency: 'CNH',
    amount: '10',
    businessSubType: '充值',
    counterpartyDepartment: 'OPS'
  });
  insertEffective(db, {
    sourceType: SOURCE_TYPES.PENDING,
    key: 'legacy-cnh-pending',
    reconType: 'VCC_clearing_credit',
    pendingCurrency: 'CNH',
    pendingAmount: '-2',
    flowCurrency: 'CNH',
    flowAmount: '5',
    currencyMismatch: 0,
    channelName: 'LEGACY'
  });

  const aggregate = aggregateEffectiveRows(db, '2026-06');
  const movement = [...aggregate.movementGroups.values()];
  const pending = [...aggregate.pendingGroups.values()];

  assert.equal(movement.length, 1);
  assert.equal(movement[0].currency, 'CNY');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].flowCurrency, 'CNY');
  assert.equal(pending[0].pendingCurrency, 'CNY');
  assert.equal(
    aggregate.pendingCurrencyTotals.get(JSON.stringify(['PPHK', 'CNY'])).value(),
    '3'
  );
  assert.equal(aggregate.periodTotals.get(JSON.stringify(['PPHK', 'CNY'])).value(), '13');
  assert.deepEqual(
    { ...db.prepare(`
      SELECT stat_currency, pending_currency, flow_currency
      FROM vcc_fin_op_effective_rows ORDER BY id
    `).all()[0] },
    { stat_currency: 'CNH', pending_currency: null, flow_currency: null }
  );
});

test('旧 unresolved 失败导入不再阻断计算且无需人工处理', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const failedId = seedCompleteMonth(db, { legacyUnresolved: true });
  const calculated = calculateCurrent(db);
  assert.equal(calculated.status, 'calculated');
  assert.equal(repository.getImportRecord(db, failedId).resolution_status, 'unresolved');
});

test('未结束导入批次阻断计算和归档，即使尚未生成原表记录', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  repository.createImportBatch(db, {
    id: 'active-batch', targetMonth: '2026-06', fileCount: 1
  });

  const blocked = calculateCurrent(db);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'active-imports');
  assert.equal(blocked.activeImports[0].id, 'active-batch');
  assert.throws(
    () => archiveRun({ db, runId: calculated.runId, expectedResultRevision: 0 }),
    /仍有原表正在导入/
  );
  assert.equal(
    db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(calculated.runId).status,
    'calculated'
  );
});

test('归档绑定计算时的数据版本，原表变化后拒绝旧结果归档', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET revision = revision + 1
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);
  assert.throws(
    () => archiveRun({ db, runId: calculated.runId, expectedResultRevision: 0 }),
    /原表数据已变化/
  );
  assert.equal(db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(calculated.runId).status, 'calculated');
});

test('同账期重新计算原子替换未归档草稿', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db);
  const second = calculateCurrent(db);

  assert.equal(first.status, 'calculated');
  assert.equal(second.status, 'calculated');
  assert.notEqual(second.runId, first.runId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = ?').get('2026-06').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_run_balances WHERE run_id = ?').get(first.runId).n, 0);
});

test('重算替换审计保留旧 adjustment、Pending、effective 与 fingerprint 全量证据', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db, '2026-06', {
    appVersion: '3.1.8',
    buildSha: 'first-build'
  });
  addRunAdjustment({
    db,
    runId: first.runId,
    rowKey: buildRunRowKey(RECHARGE_RESULT_ROW),
    currency: 'USD',
    adjustmentAmount: '1.25',
    reason: '重算前调整证据',
    expectedResultRevision: 0,
    appVersion: '3.1.8',
    buildSha: 'adjust-build'
  });

  const second = calculateCurrent(db, '2026-06', {
    appVersion: '3.1.8',
    buildSha: 'replace-build'
  });

  assert.deepEqual(second.replacedRunIds, [first.runId]);
  assert.notEqual(second.runId, first.runId);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_run_adjustments WHERE run_id = ?
  `).get(first.runId).n, 0);
  const audit = db.prepare(`
    SELECT * FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result'
  `).get();
  assert.equal(audit.status, 'success');
  assert.equal(audit.run_id, first.runId);
  assert.equal(audit.app_version, '3.1.8');
  assert.equal(audit.build_sha, 'replace-build');
  const evidence = JSON.parse(audit.evidence_json);
  assert.deepEqual(evidence.replacedRunIds, [first.runId]);
  assert.equal(evidence.replacementRunId, second.runId);
  assert.equal(evidence.replacementInput.inputFingerprint, first.inputFingerprint);
  assert.equal(evidence.replacedRuns.length, 1);
  const oldRun = evidence.replacedRuns[0];
  assert.equal(oldRun.run.runId, first.runId);
  assert.equal(oldRun.run.resultRevision, 1);
  assert.equal(oldRun.run.inputFingerprint, first.inputFingerprint);
  assert.equal(oldRun.adjustments.length, 1);
  assert.equal(oldRun.adjustments[0].adjustmentAmount, '1.25');
  assert.equal(oldRun.pendingSummaryRows.length, 1);
  assert.deepEqual(
    oldRun.pendingCurrencyTotals.map((row) => [row.currency, row.amount]),
    [['EUR', '5'], ['USD', '-5']]
  );
  assert.equal(
    oldRun.balances.find((row) => row.subject === 'PPHK' && row.currency === 'USD')
      .effectiveCalculatedBalance,
    '104.25'
  );
  assert.equal(oldRun.effectiveRows.some((row) => row.adjustmentAmount === '1.25'), true);
});

test('重算替换注入失败时恢复旧 run 全部子表，并单独记录 rolled_back 审计', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db);
  addRunAdjustment({
    db,
    runId: first.runId,
    rowKey: buildRunRowKey(RECHARGE_RESULT_ROW),
    currency: 'USD',
    adjustmentAmount: '-2',
    reason: '必须保留的旧调整',
    expectedResultRevision: 0
  });
  const childCountsBefore = Object.fromEntries([
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals',
    'vcc_fin_op_run_adjustments'
  ].map((table) => [table, db.prepare(`
    SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?
  `).get(first.runId).n]));
  db.exec(`
    CREATE TRIGGER fail_replacement_run_insert
    BEFORE INSERT ON vcc_fin_op_runs
    WHEN NEW.target_month = '2026-06' AND NEW.status = 'calculated'
    BEGIN
      SELECT RAISE(ABORT, 'replacement-write-fault');
    END;
  `);

  assert.throws(
    () => calculateCurrent(db, '2026-06', { appVersion: '3.1.8' }),
    /replacement-write-fault/
  );

  assert.deepEqual(db.prepare(`
    SELECT id, status, result_revision FROM vcc_fin_op_runs
    WHERE target_month = '2026-06'
  `).all().map((row) => ({ ...row })), [{
    id: first.runId,
    status: 'calculated',
    result_revision: 1
  }]);
  for (const [table, count] of Object.entries(childCountsBefore)) {
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?
    `).get(first.runId).n, count, `${table} 应随旧 run 一起恢复`);
  }
  const audits = db.prepare(`
    SELECT status, run_id, evidence_json, error_message
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result'
    ORDER BY id
  `).all();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'rolled_back');
  assert.equal(audits[0].run_id, first.runId);
  assert.match(audits[0].error_message, /replacement-write-fault/);
  const evidence = JSON.parse(audits[0].evidence_json);
  assert.equal(evidence.replacedRuns[0].adjustments[0].reason, '必须保留的旧调整');
  assert.equal(evidence.replacedRuns[0].pendingSummaryRows.length, 1);
  assert.equal(evidence.failure.message, 'replacement-write-fault');
});

test('重算 success audit 被 AFTER INSERT 删除时不返回假成功且旧资金事实完整回滚', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db);
  addRunAdjustment({
    db,
    runId: first.runId,
    rowKey: buildRunRowKey(RECHARGE_RESULT_ROW),
    currency: 'USD',
    adjustmentAmount: '1',
    reason: '必须随旧 run 回滚恢复',
    expectedResultRevision: 0
  });
  const oldChildCounts = Object.fromEntries([
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals',
    'vcc_fin_op_run_adjustments'
  ].map((table) => [table, db.prepare(`
    SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?
  `).get(first.runId).n]));
  db.exec(`
    CREATE TRIGGER delete_replacement_success_audit
    AFTER INSERT ON vcc_fin_op_operation_audit
    WHEN NEW.operation_type = 'replace_calculated_result' AND NEW.status = 'success'
    BEGIN
      DELETE FROM vcc_fin_op_operation_audit WHERE id = NEW.id;
    END;
  `);

  assert.throws(() => calculateCurrent(db), (error) => {
    assert.equal(error.code, 'replace-calculated-result-invariant-failed');
    assert.equal(error.context.actual, null);
    assert.equal(error.context.newAuditCount, 0);
    return true;
  });
  assert.deepEqual(db.prepare(`
    SELECT id, status, result_revision FROM vcc_fin_op_runs
    WHERE target_month = '2026-06'
  `).all().map((row) => ({ ...row })), [{
    id: first.runId,
    status: 'calculated',
    result_revision: 1
  }]);
  for (const [table, count] of Object.entries(oldChildCounts)) {
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?
    `).get(first.runId).n, count, `${table} 必须恢复`);
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result' AND status = 'success'
  `).get().n, 0);
  const rollbackAudit = db.prepare(`
    SELECT status, evidence_json, error_message
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result'
  `).get();
  assert.equal(rollbackAudit.status, 'rolled_back');
  assert.match(rollbackAudit.error_message, /成功审计提交前校验失败/);
  assert.equal(JSON.parse(rollbackAudit.evidence_json).replacedRunIds[0], first.runId);
});

test('旧结果证据采集失败时零删除并记录可诊断的 rolled_back 替换审计', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db);
  db.prepare(`
    DELETE FROM vcc_fin_op_run_balances
    WHERE run_id = ? AND subject = 'PPHK' AND currency = 'AUD'
  `).run(first.runId);

  assert.throws(
    () => calculateCurrent(db, '2026-06', {
      appVersion: '3.1.8',
      buildSha: 'collection-failure-build'
    }),
    (error) => {
      assert.equal(error.code, 'run-balance-currencies-incomplete');
      return true;
    }
  );

  assert.deepEqual(db.prepare(`
    SELECT id, status FROM vcc_fin_op_runs WHERE target_month = '2026-06'
  `).all().map((row) => ({ ...row })), [{ id: first.runId, status: 'calculated' }]);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_run_rows WHERE run_id = ?
  `).get(first.runId).n > 0, true);
  const audit = db.prepare(`
    SELECT status, run_id, evidence_json, error_message, app_version, build_sha
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result'
  `).get();
  assert.equal(audit.status, 'rolled_back');
  assert.equal(audit.run_id, first.runId);
  assert.equal(audit.app_version, '3.1.8');
  assert.equal(audit.build_sha, 'collection-failure-build');
  assert.match(audit.error_message, /缺少余额币种：AUD/);
  const evidence = JSON.parse(audit.evidence_json);
  assert.deepEqual(evidence.replacedRunIds, [first.runId]);
  assert.deepEqual(evidence.replacedRuns, []);
  assert.equal(evidence.evidenceCollectionFailure.failedRunId, first.runId);
  assert.deepEqual(evidence.evidenceCollectionFailure.collectedRunIds, []);
  assert.equal(evidence.evidenceCollectionFailure.code, 'run-balance-currencies-incomplete');
  assert.equal(evidence.failure.code, 'run-balance-currencies-incomplete');
});

test('重算失败审计写入也失败时不掩盖主异常', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateCurrent(db);
  db.exec(`
    CREATE TRIGGER fail_replacement_run_insert_with_audit
    BEFORE INSERT ON vcc_fin_op_runs
    WHEN NEW.target_month = '2026-06' AND NEW.status = 'calculated'
    BEGIN
      SELECT RAISE(ABORT, 'replacement-primary-fault');
    END;
    CREATE TRIGGER fail_replacement_rollback_audit
    BEFORE INSERT ON vcc_fin_op_operation_audit
    WHEN NEW.operation_type = 'replace_calculated_result' AND NEW.status = 'rolled_back'
    BEGIN
      SELECT RAISE(ABORT, 'replacement-audit-fault');
    END;
  `);

  assert.throws(() => calculateCurrent(db), (error) => {
    assert.equal(error.message, 'replacement-primary-fault');
    assert.equal(error.auditFailure.message, 'replacement-audit-fault');
    return true;
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?
  `).get(first.runId).n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'replace_calculated_result'
  `).get().n, 0);
});

test('确认归档原子写入当月期末余额并统一更新数据状态', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET generated_at = '2026-07-01 08:30:00'
    WHERE target_month = '2026-06'
  `).run();
  const calculated = calculateCurrent(db);
  const archived = archiveRun({ db, runId: calculated.runId, expectedResultRevision: 0 });
  assert.equal(archived.status, 'archived');
  const stored = db.prepare(`
    SELECT balances_json FROM vcc_fin_op_archives
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).get();
  assert.equal(JSON.parse(stored.balances_json).USD, '103');
  assert.equal(JSON.parse(stored.balances_json).EUR, '108');
  const statuses = db.prepare(`
    SELECT DISTINCT data_status, generated_at
    FROM vcc_fin_op_datasets WHERE target_month = '2026-06'
  `).all();
  assert.deepEqual(statuses.map((row) => row.data_status), ['archived']);
  assert.deepEqual(statuses.map((row) => row.generated_at), ['2026-07-01 08:30:00']);
  assert.throws(
    () => archiveRun({ db, runId: calculated.runId, expectedResultRevision: 0 }),
    /已经归档/
  );
});

test('归档强制 revision 门禁，缺失或过期时保留生效结果等待重新核对', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);

  for (const expectedResultRevision of [undefined, 1]) {
    assert.throws(() => archiveRun({
      db,
      runId: calculated.runId,
      expectedResultRevision
    }), (error) => {
      assert.equal(error.code, 'result-revision-changed');
      assert.equal(error.message, '结果已发生变化，请重新核对后归档。');
      return true;
    });
  }
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_runs WHERE id = ?
  `).get(calculated.runId).status, 'calculated');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('归档拒绝缺失或旧输入 fingerprint，且不存在 run 不污染审计月份', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  db.prepare(`UPDATE vcc_fin_op_runs SET input_fingerprint = NULL WHERE id = ?`)
    .run(calculated.runId);
  assert.throws(() => archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 0
  }), (error) => {
    assert.equal(error.code, 'result-input-fingerprint-missing');
    return true;
  });

  db.prepare(`UPDATE vcc_fin_op_runs SET input_fingerprint = ? WHERE id = ?`)
    .run('0'.repeat(64), calculated.runId);
  assert.throws(() => archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 0
  }), (error) => {
    assert.equal(error.code, 'result-input-changed');
    return true;
  });
  const auditCountBeforeMissingRun = db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit
  `).get().n;
  assert.throws(
    () => archiveRun({ db, runId: 999999, expectedResultRevision: 0 }),
    /不存在/
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit
  `).get().n, auditCountBeforeMissingRun);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'archive_result' AND target_month = ''
  `).get().n, 0);
});

test('归档写入人工调整后的九币种余额，并成为下月唯一期初来源', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  addRunAdjustment({
    db,
    runId: calculated.runId,
    rowKey: buildRunRowKey(RECHARGE_RESULT_ROW),
    currency: 'USD',
    adjustmentAmount: '1.25',
    reason: '按银行回单调整',
    expectedResultRevision: 0,
    appVersion: '3.1.8',
    buildSha: 'adjust-build'
  });
  db.prepare(`UPDATE vcc_fin_op_runs SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`)
    .run(calculated.runId);

  const archived = archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 1,
    appVersion: '3.1.8',
    buildSha: 'archive-build'
  });

  assert.equal(archived.resultRevision, 1);
  const archiveRow = db.prepare(`
    SELECT balances_json FROM vcc_fin_op_archives
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).get();
  const archivedBalances = JSON.parse(archiveRow.balances_json);
  assert.deepEqual(Object.keys(archivedBalances), SUPPORTED_CURRENCIES);
  assert.equal(archivedBalances.USD, '104.25');
  assert.equal(archivedBalances.EUR, '108');
  const nextOpening = loadOpeningBalances(db, '2026-07');
  assert.equal(nextOpening.sources.get('PPHK'), 'previous_archive');
  assert.equal(nextOpening.balances.get('PPHK').USD, '104.25');
  const storedRun = db.prepare(`
    SELECT status, result_revision, updated_at FROM vcc_fin_op_runs WHERE id = ?
  `).get(calculated.runId);
  assert.deepEqual(
    { status: storedRun.status, resultRevision: storedRun.result_revision },
    { status: 'archived', resultRevision: 1 }
  );
  assert.notEqual(storedRun.updated_at, '2000-01-01 00:00:00');
  const audit = db.prepare(`
    SELECT status, evidence_json, app_version, build_sha
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'archive_result' AND run_id = ?
  `).get(calculated.runId);
  assert.equal(audit.status, 'success');
  assert.equal(audit.app_version, '3.1.8');
  assert.equal(audit.build_sha, 'archive-build');
  const evidence = JSON.parse(audit.evidence_json);
  assert.equal(evidence.effectiveRun.run.resultRevision, 1);
  assert.equal(evidence.effectiveRun.adjustments[0].adjustmentAmount, '1.25');
  assert.equal(
    evidence.effectiveRun.balances.find((row) => row.currency === 'USD')
      .effectiveCalculatedBalance,
    '104.25'
  );
});

test('归档提交后断言发现快照损坏时，九币种快照、run 和五类数据集全部回滚', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  db.exec(`
    CREATE TRIGGER corrupt_archive_snapshot
    AFTER INSERT ON vcc_fin_op_archives
    WHEN NEW.target_month = '2026-06'
    BEGIN
      UPDATE vcc_fin_op_archives
      SET balances_json = '{"USD":"999"}'
      WHERE target_month = NEW.target_month AND subject = NEW.subject;
    END;
  `);

  assert.throws(() => archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 0
  }), (error) => {
    assert.equal(error.code, 'archive-write-invariant-failed');
    return true;
  });
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_runs WHERE id = ?
  `).get(calculated.runId).status, 'calculated');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-06'
  `).get().n, 0);
  assert.deepEqual(db.prepare(`
    SELECT data_status, archived_run_id FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' ORDER BY dataset_type
  `).all().map((row) => ({ ...row })), Array.from({ length: 5 }, () => ({
    data_status: 'unprocessed',
    archived_run_id: null
  })));
  const audit = db.prepare(`
    SELECT status, error_message FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'archive_result'
  `).get();
  assert.equal(audit.status, 'rolled_back');
  assert.match(audit.error_message, /提交前状态断言失败/);
});

test('归档 AFTER INSERT 篡改既有 adjustment 与基础事实时全表指纹回滚且失败可审计', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  const adjusted = addRunAdjustment({
    db,
    runId: calculated.runId,
    rowKey: buildRunRowKey(RECHARGE_RESULT_ROW),
    currency: 'USD',
    adjustmentAmount: '1',
    reason: '归档前既有调整',
    expectedResultRevision: 0
  });
  const adjustmentId = adjusted.adjustment.id;
  const baseRow = db.prepare(`
    SELECT id, amount FROM vcc_fin_op_run_rows
    WHERE run_id = ? AND source_type = ? AND currency = 'USD'
  `).get(calculated.runId, SOURCE_TYPES.RECHARGE);
  db.exec(`
    CREATE TRIGGER corrupt_archive_preserved_facts
    AFTER INSERT ON vcc_fin_op_archives
    WHEN NEW.target_month = '2026-06'
    BEGIN
      UPDATE vcc_fin_op_run_adjustments SET sequence = 88 WHERE id = ${adjustmentId};
      UPDATE vcc_fin_op_run_rows SET amount = '998' WHERE id = ${baseRow.id};
    END;
  `);

  assert.throws(() => archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 1
  }), (error) => {
    assert.equal(error.code, 'archive-write-invariant-failed');
    assert.equal(error.context.preservedStateBefore.operation, 'archive-result');
    assert.equal(error.context.preservedStateAfter.operation, 'archive-result');
    return true;
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT status, result_revision FROM vcc_fin_op_runs WHERE id = ?
  `).get(calculated.runId) }, { status: 'calculated', result_revision: 1 });
  assert.deepEqual({ ...db.prepare(`
    SELECT sequence FROM vcc_fin_op_run_adjustments WHERE id = ?
  `).get(adjustmentId) }, { sequence: 1 });
  assert.deepEqual({ ...db.prepare(`
    SELECT amount FROM vcc_fin_op_run_rows WHERE id = ?
  `).get(baseRow.id) }, { amount: baseRow.amount });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-06'
  `).get().n, 0);
  const audit = db.prepare(`
    SELECT status, evidence_json, error_message
    FROM vcc_fin_op_operation_audit WHERE operation_type = 'archive_result'
  `).get();
  assert.equal(audit.status, 'rolled_back');
  assert.match(audit.error_message, /既有资金事实/);
  assert.equal(JSON.parse(audit.evidence_json).runId, calculated.runId);
});

test('归档 success audit 被 AFTER INSERT 篡改时不返回假成功且归档资金事实回滚', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  db.exec(`
    CREATE TRIGGER corrupt_archive_success_audit
    AFTER INSERT ON vcc_fin_op_operation_audit
    WHEN NEW.operation_type = 'archive_result' AND NEW.status = 'success'
    BEGIN
      UPDATE vcc_fin_op_operation_audit
      SET evidence_json = '{}', app_version = 'forged-version', build_sha = 'forged-sha'
      WHERE id = NEW.id;
    END;
  `);

  assert.throws(() => archiveRun({
    db,
    runId: calculated.runId,
    expectedResultRevision: 0,
    appVersion: '3.1.8',
    buildSha: 'trusted-sha'
  }), (error) => {
    assert.equal(error.code, 'archive-write-invariant-failed');
    assert.notEqual(error.context.expected.evidenceHash, error.context.actual.evidenceHash);
    assert.equal(error.context.actual.appVersion, 'forged-version');
    return true;
  });
  assert.equal(db.prepare(`
    SELECT status FROM vcc_fin_op_runs WHERE id = ?
  `).get(calculated.runId).status, 'calculated');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-06'
  `).get().n, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND data_status = 'archived'
  `).get().n, 0);
  const audits = db.prepare(`
    SELECT status, app_version, build_sha, error_message
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'archive_result' ORDER BY id
  `).all();
  assert.deepEqual(audits.map((row) => row.status), ['rolled_back']);
  assert.equal(audits[0].app_version, '3.1.8');
  assert.equal(audits[0].build_sha, 'trusted-sha');
  assert.match(audits[0].error_message, /成功审计提交前校验失败/);
});

test('下月出现人工期初时归档预检 fail-closed，避免双来源', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateCurrent(db);
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES ('2026-07', 'PPHK', ?, 'hash', '已初始化')
  `).run(JSON.stringify(fixedBalances('100')));

  assert.throws(
    () => archiveRun({
      db,
      runId: calculated.runId,
      expectedResultRevision: 0
    }),
    /首月状态.*与期初初始化月份.*冲突/
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-06'
  `).get().n, 0);
});

test('聚合后超过 Excel 有效数字上限时在生成可归档结果前阻断', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  db.prepare(`
    UPDATE vcc_fin_op_effective_rows
    SET signed_amount = '999999999999999'
    WHERE source_type = ?
  `).run(SOURCE_TYPES.RECHARGE);

  assert.throws(() => calculateCurrent(db), /15 位有效数字/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = '2026-06'
  `).get().n, 0);
});
