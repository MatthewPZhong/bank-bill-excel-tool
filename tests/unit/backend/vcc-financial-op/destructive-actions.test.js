'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const { REQUIRED_DATASET_TYPES } = require('../../../../src/backend/vcc-financial-op/calculator');
const { buildRunRowKey } = require('../../../../src/backend/vcc-financial-op/result-adjustments');
const {
  listArchivedResultMonths,
  previewUnarchive,
  unarchiveMonth
} = require('../../../../src/backend/vcc-financial-op/unarchive');
const {
  DELETE_TARGET_TYPES,
  previewDataTargetDeletion,
  deleteOpeningInitialization,
  deleteUnarchivedResult
} = require('../../../../src/backend/vcc-financial-op/data-target-deletion');
const {
  serializeError,
  deserializeError
} = require('../../../../src/main-process/serialize-error');
const {
  vccFinancialOpErrorResult
} = require('../../../../src/main-process/vcc-financial-op-ipc');

const MOVEMENT_ROW = Object.freeze({
  rowKind: 'movement',
  subject: 'PPHK',
  sourceType: SOURCE_TYPES.RECHARGE,
  categoryMajor: '充值',
  categoryMinor: '正常'
});

function createDb(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => db.close());
  return db;
}

function canonicalBalances(base = '100', usd = base) {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
    currency,
    currency === 'USD' ? usd : base
  ]));
}

function seedDatasets(db, month, status, runId = null) {
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id, revision,
      generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-01 10:00:00', '2026-08-01 10:00:00')
  `);
  REQUIRED_DATASET_TYPES.forEach((type, index) => {
    insert.run(month, type, status, runId, index + 1);
  });
}

function seedRun(db, {
  month = '2026-06',
  status = 'calculated',
  adjustment = false,
  archivedAt = '2026-08-01 11:00:00'
} = {}) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, ?, '{"fixture":1}', ?, ?, '2026-08-01 09:00:00',
              '2026-08-01 10:00:00', ?)
  `).run(
    month,
    status,
    adjustment ? 1 : 0,
    `fingerprint-${month}-${status}`,
    status === 'archived' ? archivedAt : null
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', '正常', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, '0')
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const period = currency === 'USD' ? '10' : '0';
    const calculated = currency === 'USD' ? '110' : '100';
    insertBalance.run(runId, currency, period, calculated, calculated);
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, 'PPHK', 'CITI', 0, 'USD', 'USD', 'normal', '1', '1')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, 'PPHK', 'USD', '0')
  `).run(runId);
  if (adjustment) {
    db.prepare(`
      INSERT INTO vcc_fin_op_run_adjustments (
        run_id, row_key, subject, source_type, category_major, category_minor,
        currency, adjustment_amount, reason, sequence,
        created_app_version, created_build_sha
      ) VALUES (?, ?, 'PPHK', ?, '充值', '正常', 'JPY', '5', '人工核对', 1,
                '3.1.8', 'fixture-sha')
    `).run(runId, buildRunRowKey(MOVEMENT_ROW), SOURCE_TYPES.RECHARGE);
  }
  return runId;
}

function seedArchive(db, month, runId, overrides = {}) {
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES (?, 'PPHK', ?, ?, '2026-08-01 11:00:00')
  `).run(month, JSON.stringify({
    ...canonicalBalances('100', '110'),
    ...overrides
  }), runId);
}

function seedOpening(db, month = '2026-06') {
  const balances = JSON.stringify(canonicalBalances('100'));
  db.prepare(`
    UPDATE vcc_fin_op_module_state
    SET first_month = ?, updated_at = '2026-08-01 09:00:00'
    WHERE singleton_id = 1
  `).run(month);
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash,
      initialization_note, initialized_at
    ) VALUES (?, 'PPHK', ?, 'opening-hash', '与账务底稿逐币种核对',
              '2026-08-01 09:30:00')
  `).run(month, balances);
}

function seedSourceFacts(db, month = '2026-06') {
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, finished_at
    ) VALUES ('fixture-batch', ?, 'success', 1, '2026-08-01 08:00:00')
  `).run(month);
  const recordId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, finished_at
    ) VALUES ('fixture-batch', ?, ?, '["fixture.xlsx"]', 'success', 1, 1,
              '2026-08-01 08:00:00')
  `).run(month, SOURCE_TYPES.RECHARGE).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, 'ROW-1', 'ROW-1', 'row-hash', ?, 'PPHK', 'USD', '10',
              'fixture.xlsx', 'Sheet1', 2, '[]', ?)
  `).run(SOURCE_TYPES.RECHARGE, month, recordId);
}

function auditRows(db, operationType) {
  return db.prepare(`
    SELECT status, evidence_json, error_message
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ?
    ORDER BY id
  `).all(operationType);
}

test('归档月份枚举只返回 run/archive/九币种主体/五数据集完全一致的月份', (t) => {
  const db = createDb(t);
  const goodRun = seedRun(db, { month: '2026-06', status: 'archived' });
  seedArchive(db, '2026-06', goodRun);
  seedDatasets(db, '2026-06', 'archived', goodRun);

  const badRun = seedRun(db, { month: '2026-05', status: 'archived' });
  seedArchive(db, '2026-05', badRun);
  seedDatasets(db, '2026-05', 'archived', badRun);
  db.prepare(`DELETE FROM vcc_fin_op_datasets WHERE target_month = '2026-05' AND dataset_type = ?`)
    .run(SOURCE_TYPES.PENDING);

  assert.deepEqual(listArchivedResultMonths(db).map((item) => item.targetMonth), ['2026-06']);
  const badPreview = previewUnarchive(db, '2026-05', { taskGeneration: 4 });
  assert.equal(badPreview.canUnarchive, false);
  assert.equal(badPreview.code, 'archive-state-inconsistent');
  assert.match(badPreview.previewToken, /^v1:[a-f0-9]{64}$/);
});

test('归档余额必须逐主体逐币种等于含调整后的生效结果', (t) => {
  const db = createDb(t);
  const runId = seedRun(db, { status: 'archived', adjustment: true });
  seedArchive(db, '2026-06', runId);
  seedDatasets(db, '2026-06', 'archived', runId);

  const inconsistent = previewUnarchive(db, '2026-06');
  assert.equal(inconsistent.code, 'archive-state-inconsistent');
  assert.ok(inconsistent.consistencyReasons.includes('archive-balance-mismatch:PPHK/JPY'));
  assert.deepEqual(listArchivedResultMonths(db), []);

  db.prepare(`
    UPDATE vcc_fin_op_archives SET balances_json = ?
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).run(JSON.stringify({ ...canonicalBalances('100', '110'), JPY: '105' }));
  const consistent = previewUnarchive(db, '2026-06');
  assert.equal(consistent.canUnarchive, true);

  db.prepare(`
    UPDATE vcc_fin_op_archives SET balances_json = ?
    WHERE target_month = '2026-06' AND subject = 'PPHK'
  `).run(JSON.stringify({ ...canonicalBalances('100', '110'), JPY: '105', BTC: '1' }));
  const extraCurrency = previewUnarchive(db, '2026-06');
  assert.equal(extraCurrency.code, 'archive-state-inconsistent');
  assert.ok(extraCurrency.consistencyReasons.includes('archive-balance-currencies:PPHK'));
});

test('解归档保守阻断所有后续 archived/calculated 月且绝不级联', (t) => {
  const db = createDb(t);
  const m1 = seedRun(db, { month: '2026-04', status: 'archived' });
  seedArchive(db, '2026-04', m1);
  seedDatasets(db, '2026-04', 'archived', m1);
  const m2 = seedRun(db, { month: '2026-05', status: 'archived' });
  seedArchive(db, '2026-05', m2);
  seedDatasets(db, '2026-05', 'archived', m2);
  seedRun(db, { month: '2026-06', status: 'calculated' });
  seedDatasets(db, '2026-06', 'unprocessed');

  const preview = previewUnarchive(db, '2026-04', { taskGeneration: 2 });
  assert.equal(preview.code, 'unarchive-not-tail');
  assert.deepEqual(preview.dependentMonths, ['2026-05', '2026-06']);
  assert.throws(() => unarchiveMonth({
    db,
    targetMonth: '2026-04',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 2
  }), (error) => error.code === 'unarchive-not-tail');
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(m1).status, 'archived');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives`).get().n, 2);
});

test('后月孤立 archive 即使缺失 run 也作为依赖稳定阻断且不改资金状态', (t) => {
  const db = createDb(t);
  const currentRunId = seedRun(db, { month: '2026-04', status: 'archived' });
  seedArchive(db, '2026-04', currentRunId);
  seedDatasets(db, '2026-04', 'archived', currentRunId);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES ('2026-06', 'ORPHAN', ?, 999999, '2026-08-01 11:00:00')
  `).run(JSON.stringify(canonicalBalances('999')));
  db.exec('PRAGMA foreign_keys = ON');

  const firstPreview = previewUnarchive(db, '2026-04', { taskGeneration: 2 });
  const secondPreview = previewUnarchive(db, '2026-04', { taskGeneration: 2 });
  assert.equal(firstPreview.code, 'unarchive-not-tail');
  assert.deepEqual(firstPreview.dependentMonths, ['2026-06']);
  assert.deepEqual(secondPreview.dependentMonths, firstPreview.dependentMonths);
  assert.equal(secondPreview.previewToken, firstPreview.previewToken);
  assert.throws(() => unarchiveMonth({
    db,
    targetMonth: '2026-04',
    expectedPreviewToken: firstPreview.previewToken,
    taskGeneration: 2
  }), (error) => error.code === 'unarchive-not-tail');
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(currentRunId).status, 'archived');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives`).get().n, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_datasets WHERE target_month = '2026-04' AND data_status = 'archived'`).get().n, 5);
});

test('后月孤立 archived dataset 即使缺失 run 也排序去重阻断且不改资金状态', (t) => {
  const db = createDb(t);
  const currentRunId = seedRun(db, { month: '2026-04', status: 'archived' });
  seedArchive(db, '2026-04', currentRunId);
  seedDatasets(db, '2026-04', 'archived', currentRunId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id, revision,
      generated_at, updated_at
    ) VALUES ('2026-07', ?, 'archived', 999999, 1,
              '2026-08-01 10:00:00', '2026-08-01 10:00:00')
  `).run(SOURCE_TYPES.RECHARGE);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id, revision,
      generated_at, updated_at
    ) VALUES ('2026-07', ?, 'archived', 999999, 1,
              '2026-08-01 10:00:00', '2026-08-01 10:00:00')
  `).run(SOURCE_TYPES.FEE_FX);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id, revision,
      generated_at, updated_at
    ) VALUES ('2026-05', ?, 'archived', 888888, 1,
              '2026-08-01 10:00:00', '2026-08-01 10:00:00')
  `).run(SOURCE_TYPES.CHANNEL);

  const firstPreview = previewUnarchive(db, '2026-04', { taskGeneration: 3 });
  const secondPreview = previewUnarchive(db, '2026-04', { taskGeneration: 3 });
  assert.equal(firstPreview.code, 'unarchive-not-tail');
  assert.deepEqual(firstPreview.dependentMonths, ['2026-05', '2026-07']);
  assert.deepEqual(secondPreview.dependentMonths, firstPreview.dependentMonths);
  assert.equal(secondPreview.previewToken, firstPreview.previewToken);
  assert.throws(() => unarchiveMonth({
    db,
    targetMonth: '2026-04',
    expectedPreviewToken: firstPreview.previewToken,
    taskGeneration: 3
  }), (error) => error.code === 'unarchive-not-tail');
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(currentRunId).status, 'archived');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives WHERE target_month = '2026-04'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_datasets WHERE data_status = 'archived'`).get().n, 8);
});

test('尾月解归档原子成功并保留基础结果、Pending 与调整证据', (t) => {
  const db = createDb(t);
  const runId = seedRun(db, { status: 'archived', adjustment: true });
  seedArchive(db, '2026-06', runId, { JPY: '105' });
  seedDatasets(db, '2026-06', 'archived', runId);
  const preview = previewUnarchive(db, '2026-06', { taskGeneration: 7 });
  assert.equal(preview.canUnarchive, true);

  const result = unarchiveMonth({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 7,
    appVersion: '3.1.8',
    buildSha: 'fixture-sha'
  });
  assert.equal(result.status, 'unarchived');
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(runId).status, 'calculated');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_run_rows WHERE run_id = ?`).get(runId).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_run_adjustments WHERE run_id = ?`).get(runId).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_pending_summary_rows WHERE run_id = ?`).get(runId).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_datasets WHERE data_status = 'unprocessed'`).get().n, 5);
  const audits = auditRows(db, 'unarchive');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'success');
  const evidence = JSON.parse(audits[0].evidence_json);
  assert.equal(evidence.runEvidence.adjustments.length, 1);
  assert.equal(evidence.before.archives[0].balancesJson.includes('USD'), true);
});

test('解归档提交时重算 token；stale 和事务故障均零业务写并留 rolled_back 审计', (t) => {
  const db = createDb(t);
  const runId = seedRun(db, { status: 'archived' });
  seedArchive(db, '2026-06', runId);
  seedDatasets(db, '2026-06', 'archived', runId);
  const stale = previewUnarchive(db, '2026-06', { taskGeneration: 1 });
  db.prepare(`UPDATE vcc_fin_op_runs SET updated_at = '2026-08-02 00:00:00' WHERE id = ?`).run(runId);
  assert.throws(() => unarchiveMonth({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: stale.previewToken,
    taskGeneration: 1
  }), (error) => {
    assert.equal(error.code, 'state-changed');
    assert.equal(error.message, '数据状态已变化，请刷新并重新确认。');
    return true;
  });
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(runId).status, 'archived');

  const fresh = previewUnarchive(db, '2026-06', { taskGeneration: 1 });
  db.exec(`
    CREATE TRIGGER fail_unarchive_delete
    BEFORE DELETE ON vcc_fin_op_archives
    BEGIN SELECT RAISE(ABORT, 'fixture-unarchive-failure'); END;
  `);
  assert.throws(() => unarchiveMonth({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: fresh.previewToken,
    taskGeneration: 1
  }), /fixture-unarchive-failure/);
  assert.equal(db.prepare(`SELECT status FROM vcc_fin_op_runs WHERE id = ?`).get(runId).status, 'archived');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives`).get().n, 1);
  assert.deepEqual(auditRows(db, 'unarchive').map((row) => row.status), ['rolled_back', 'rolled_back']);
});

test('失败审计写入异常仅附加到主错误并可跨 worker 边界观测', (t) => {
  const db = createDb(t);
  const runId = seedRun(db, { status: 'archived' });
  seedArchive(db, '2026-06', runId);
  seedDatasets(db, '2026-06', 'archived', runId);
  const preview = previewUnarchive(db, '2026-06', { taskGeneration: 9 });
  db.exec(`
    CREATE TRIGGER fail_unarchive_for_audit_observability
    BEFORE DELETE ON vcc_fin_op_archives
    BEGIN SELECT RAISE(ABORT, 'fixture-primary-failure'); END;
    CREATE TRIGGER fail_rolled_back_audit_only
    BEFORE INSERT ON vcc_fin_op_operation_audit
    WHEN NEW.status = 'rolled_back'
    BEGIN SELECT RAISE(ABORT, 'fixture-audit-failure'); END;
  `);

  let thrown = null;
  try {
    unarchiveMonth({
      db,
      targetMonth: '2026-06',
      expectedPreviewToken: preview.previewToken,
      taskGeneration: 9
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.match(thrown.message, /fixture-primary-failure/);
  assert.match(thrown.auditFailure.message, /fixture-audit-failure/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_archives`).get().n, 1);

  const restored = deserializeError(serializeError(thrown));
  const result = vccFinancialOpErrorResult(restored);
  assert.equal(result.code, thrown.code || null, '主错误 code 不被审计错误覆盖');
  assert.equal(result.message, thrown.message, '主错误 message 不被审计错误覆盖');
  assert.deepEqual(result.context.auditFailure, restored.auditFailure);

  db.exec('DROP TRIGGER fail_rolled_back_audit_only');
  db.exec('DROP TRIGGER fail_unarchive_for_audit_observability');
  db.prepare(`
    INSERT INTO vcc_fin_op_operation_audit (
      target_month, operation_type, status, evidence_json
    ) VALUES ('2026-06', 'fixture', 'success', '{}')
  `).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_operation_audit`).get().n, 1,
    '故障注入不破坏正常审计表写入');
});

test('删除首月期初整体删除全部期初和 calculated 结果，first_month 与源事实不漂移', (t) => {
  const db = createDb(t);
  seedOpening(db);
  seedSourceFacts(db);
  seedDatasets(db, '2026-06', 'unprocessed');
  const runId = seedRun(db, { adjustment: true });
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.OPENING
  }, { taskGeneration: 5 });
  assert.equal(preview.deletable, true);
  const result = deleteOpeningInitialization({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 5,
    appVersion: '3.1.8',
    buildSha: 'fixture-sha'
  });
  assert.equal(result.deletedOpeningCount, 1);
  assert.equal(result.deletedRunCount, 1);
  assert.equal(result.firstMonth, '2026-06');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_import_records`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_run_adjustments WHERE run_id = ?`).get(runId).n, 0);
  const evidence = JSON.parse(auditRows(db, 'delete_opening_initialization')[0].evidence_json);
  assert.equal(evidence.openings[0].initializationNote, '与账务底稿逐币种核对');
  assert.equal(evidence.runs[0].adjustments.length, 1);
});

test('首月缺少一个已被用户删除的数据集时仍允许删除期初', (t) => {
  const db = createDb(t);
  seedOpening(db);
  seedDatasets(db, '2026-06', 'unprocessed');
  db.prepare(`
    DELETE FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.PENDING);
  seedRun(db);

  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.OPENING
  }, { taskGeneration: 6 });
  assert.equal(preview.deletable, true);
  const result = deleteOpeningInitialization({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 6
  });
  assert.equal(result.deletedOpeningCount, 1);
  assert.equal(result.deletedRunCount, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_datasets`).get().n, 4);
});

test('首月已归档禁止删期初；事务故障回滚期初/结果并保留失败审计', (t) => {
  const db = createDb(t);
  seedOpening(db);
  const runId = seedRun(db, { status: 'archived' });
  seedArchive(db, '2026-06', runId);
  seedDatasets(db, '2026-06', 'archived', runId);
  const blocked = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.OPENING
  }, { taskGeneration: 0 });
  assert.equal(blocked.code, 'opening-archived');

  db.prepare(`DELETE FROM vcc_fin_op_archives WHERE target_month = '2026-06'`).run();
  db.prepare(`DELETE FROM vcc_fin_op_runs WHERE id = ?`).run(runId);
  db.prepare(`
    UPDATE vcc_fin_op_datasets
    SET data_status = 'unprocessed', archived_run_id = NULL
    WHERE target_month = '2026-06'
  `).run();
  seedRun(db);
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.OPENING
  }, { taskGeneration: 0 });
  db.exec(`
    CREATE TRIGGER fail_opening_delete
    BEFORE DELETE ON vcc_fin_op_opening_balances
    BEGIN SELECT RAISE(ABORT, 'fixture-opening-failure'); END;
  `);
  assert.throws(() => deleteOpeningInitialization({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 0
  }), /fixture-opening-failure/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE status = 'calculated'`).get().n, 1);
  assert.equal(auditRows(db, 'delete_opening_initialization')[0].status, 'rolled_back');
});

test('删除结果一次清空同月全部 calculated run/children/adjustments并保持源事实', (t) => {
  const db = createDb(t);
  seedOpening(db);
  seedSourceFacts(db);
  seedDatasets(db, '2026-06', 'unprocessed');
  const run1 = seedRun(db, { adjustment: true });
  const run2 = seedRun(db);
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.RESULT
  }, { taskGeneration: 8 });
  assert.equal(preview.count, 2);
  const result = deleteUnarchivedResult({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 8,
    reason: '错误调整后重跑'
  });
  assert.deepEqual(result.deletedRunIds, [run1, run2]);
  for (const table of [
    'vcc_fin_op_runs', 'vcc_fin_op_run_rows', 'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows', 'vcc_fin_op_pending_currency_totals',
    'vcc_fin_op_run_adjustments'
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances`).get().n, 1);
  const evidence = JSON.parse(auditRows(db, 'delete_unarchived_result')[0].evidence_json);
  assert.equal(evidence.reason, '错误调整后重跑');
  assert.equal(evidence.runs.length, 2);
  assert.equal(evidence.runs[0].run.inputFingerprint.startsWith('fingerprint-'), true);
});

test('已归档结果禁止删除；结果删除故障回滚所有 run 并留失败审计', (t) => {
  const db = createDb(t);
  const archivedRun = seedRun(db, { status: 'archived' });
  seedArchive(db, '2026-06', archivedRun);
  seedDatasets(db, '2026-06', 'archived', archivedRun);
  const blocked = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.RESULT
  });
  assert.equal(blocked.code, 'result-archived-delete-forbidden');

  db.prepare(`DELETE FROM vcc_fin_op_archives`).run();
  db.prepare(`DELETE FROM vcc_fin_op_runs WHERE id = ?`).run(archivedRun);
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET data_status = 'unprocessed', archived_run_id = NULL
  `).run();
  const runId = seedRun(db);
  const preview = previewDataTargetDeletion(db, {
    targetMonth: '2026-06', targetType: DELETE_TARGET_TYPES.RESULT
  }, { taskGeneration: 3 });
  db.exec(`
    CREATE TRIGGER fail_result_delete
    BEFORE DELETE ON vcc_fin_op_run_rows
    BEGIN SELECT RAISE(ABORT, 'fixture-result-failure'); END;
  `);
  assert.throws(() => deleteUnarchivedResult({
    db,
    targetMonth: '2026-06',
    expectedPreviewToken: preview.previewToken,
    taskGeneration: 3
  }), /fixture-result-failure/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?`).get(runId).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vcc_fin_op_run_rows WHERE run_id = ?`).get(runId).n, 1);
  assert.equal(auditRows(db, 'delete_unarchived_result')[0].status, 'rolled_back');
});
