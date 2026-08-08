'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  previousYearMonth,
  nextYearMonth,
  initializeOpeningBalances,
  preflightCalculation,
  calculateMonth,
  archiveRun
} = require('../../../../src/backend/vcc-financial-op/calculator');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
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
    ) VALUES (?, ?, ?, ?, '2026-06', 'PPHK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'x.xlsx', 'sheet1', 2, '[]', ?)
  `).run(
    fields.sourceType,
    fields.key,
    fields.key,
    `hash-${fields.sourceType}-${fields.key}`,
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

function seedCompleteMonth(db, { includeOpening = true, unresolved = false } = {}) {
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
      INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
      VALUES ('2026-05', 'archived', '{}')
    `).run();
    const previousRunId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
      VALUES ('2026-05', 'PPHK', ?, ?)
    `).run(JSON.stringify(fixedBalances('100')), previousRunId);
  }

  if (unresolved) {
    const batchId = 'failed-batch';
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-06', fileCount: 1 });
    const failedId = repository.createImportRecord(db, {
      batchId, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE,
      sourceFiles: ['bad.xlsx']
    });
    repository.finishImportRecord(db, failedId, {
      status: 'failed_conflict', rawCount: 1, conflictCount: 1, errorMessage: '冲突'
    });
    repository.finishImportBatch(db, batchId, 'completed_with_errors', '冲突');
    return failedId;
  }
  return null;
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
  const result = calculateMonth({ db, targetMonth: '2026-06' });
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

  const blocked = calculateMonth({ db, targetMonth: '2026-06' });
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

  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
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
  assert.deepEqual(initialized.initializedSubjects, ['PPHK']);
  assert.equal(replay.status, 'all_skipped');
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

  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
  assert.equal(calculated.status, 'calculated');
  assert.equal(calculated.balances.find((row) => row.currency === 'USD').openingBalance, '100');
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

test('逐主体逐币种精确汇总四类发生额并计算系统差异', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const result = calculateMonth({ db, targetMonth: '2026-06' });
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

test('未处理失败导入阻断计算，人工处理后可重新运行', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const failedId = seedCompleteMonth(db, { unresolved: true });
  const blocked = calculateMonth({ db, targetMonth: '2026-06' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'unresolved-imports');
  assert.equal(blocked.unresolved[0].id, failedId);

  repository.resolveImportRecord(db, failedId, {
    note: '已核对既有有效行，无需覆盖',
    action: 'keep_current_effective_dataset'
  });
  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
  assert.equal(calculated.status, 'calculated');
});

test('未结束导入批次阻断计算和归档，即使尚未生成原表记录', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
  repository.createImportBatch(db, {
    id: 'active-batch', targetMonth: '2026-06', fileCount: 1
  });

  const blocked = calculateMonth({ db, targetMonth: '2026-06' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'active-imports');
  assert.equal(blocked.activeImports[0].id, 'active-batch');
  assert.throws(
    () => archiveRun({ db, runId: calculated.runId }),
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
  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET revision = revision + 1
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);
  assert.throws(
    () => archiveRun({ db, runId: calculated.runId }),
    /原表数据已变化/
  );
  assert.equal(db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(calculated.runId).status, 'calculated');
});

test('同账期重新计算原子替换未归档草稿', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  const first = calculateMonth({ db, targetMonth: '2026-06' });
  const second = calculateMonth({ db, targetMonth: '2026-06' });

  assert.equal(first.status, 'calculated');
  assert.equal(second.status, 'calculated');
  assert.notEqual(second.runId, first.runId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = ?').get('2026-06').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_run_balances WHERE run_id = ?').get(first.runId).n, 0);
});

test('确认归档原子写入当月期末余额并统一更新数据状态', (t) => {
  const db = createDb();
  t.after(() => db.close());
  seedCompleteMonth(db);
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET generated_at = '2026-07-01 08:30:00'
    WHERE target_month = '2026-06'
  `).run();
  const calculated = calculateMonth({ db, targetMonth: '2026-06' });
  const archived = archiveRun({ db, runId: calculated.runId });
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
  assert.throws(() => archiveRun({ db, runId: calculated.runId }), /已经归档/);
});

test('下月已人工初始化期初时禁止再补归档上月，避免双来源', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
    VALUES ('2026-05', 'calculated', '{}')
  `).run().lastInsertRowid);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '0', '0', '100', '100', '0')
  `);
  for (const currency of SUPPORTED_CURRENCIES) insertBalance.run(runId, currency);
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES ('2026-06', 'PPHK', ?, 'hash', '已初始化')
  `).run(JSON.stringify(fixedBalances('100')));

  assert.throws(() => archiveRun({ db, runId }), /已人工初始化期初余额/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_archives').get().n, 0);
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

  assert.throws(() => calculateMonth({ db, targetMonth: '2026-06' }), /15 位有效数字/);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE target_month = '2026-06'
  `).get().n, 0);
});
