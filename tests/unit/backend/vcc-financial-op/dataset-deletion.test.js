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
const { buildRunRowKey } = require('../../../../src/backend/vcc-financial-op/result-adjustments');
const {
  DELETE_SOURCE_DATASET_OPERATION,
  inspectDatasetDeletion,
  deleteDataset
} = require('../../../../src/backend/vcc-financial-op/dataset-deletion');

function openDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

test('旧审计表可重复迁移出删除快照列与删除记录表', (t) => {
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
    CREATE TABLE vcc_fin_op_system_snapshot_attempts (
      id INTEGER PRIMARY KEY,
      import_record_id INTEGER,
      disposition TEXT,
      existing_snapshot_id INTEGER
    );
  `);

  ensureVccFinancialOpTablesSupport(db);
  ensureVccFinancialOpTablesSupport(db);
  const importColumns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_import_rows)').all().map((row) => row.name)
  );
  const systemColumns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_system_snapshot_attempts)').all().map((row) => row.name)
  );
  for (const column of [
    'existing_raw_json_snapshot',
    'existing_subject_snapshot',
    'existing_source_file_snapshot',
    'existing_sheet_name_snapshot',
    'existing_source_row_snapshot',
    'existing_import_record_id_snapshot',
    'existing_imported_at_snapshot'
  ]) assert.equal(importColumns.has(column), true, `缺少明细审计迁移列 ${column}`);
  const recordColumns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_import_records)').all().map((row) => row.name)
  );
  const datasetColumns = new Set(
    db.prepare('PRAGMA table_info(vcc_fin_op_datasets)').all().map((row) => row.name)
  );
  assert.equal(recordColumns.has('dataset_deleted_at'), true);
  assert.equal(recordColumns.has('dataset_deletion_id'), true);
  assert.equal(datasetColumns.has('generated_at'), true);
  for (const column of [
    'comparison_attempt_id',
    'existing_balances_json_snapshot',
    'existing_raw_json_snapshot',
    'existing_source_file_snapshot',
    'existing_sheet_name_snapshot',
    'existing_source_row_snapshot',
    'existing_import_record_id_snapshot',
    'existing_imported_at_snapshot'
  ]) assert.equal(systemColumns.has(column), true, `缺少系统审计迁移列 ${column}`);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'vcc_fin_op_dataset_deletions'").get().n,
    1
  );
});

function createRecord(db, {
  batchId = 'batch-1',
  targetMonth = '2026-06',
  sourceType = SOURCE_TYPES.RECHARGE,
  status = 'success_with_skips'
} = {}) {
  repository.createImportBatch(db, { id: batchId, targetMonth, fileCount: 1 });
  const recordId = repository.createImportRecord(db, {
    batchId,
    targetMonth,
    sourceType,
    sourceFiles: [`${sourceType}.xlsx`]
  });
  repository.finishImportRecord(db, recordId, {
    status,
    rawCount: 2,
    insertedCount: 1,
    skippedCount: 1
  });
  repository.finishImportBatch(db, batchId, 'success');
  return recordId;
}

function insertEffective(db, recordId, {
  sourceType = SOURCE_TYPES.RECHARGE,
  targetMonth = '2026-06',
  key = 'ORDER-1',
  subject = 'PPHK'
} = {}) {
  return Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Sheet1', 2, ?, ?)
  `).run(
    sourceType,
    key,
    key,
    `hash-${key}`,
    targetMonth,
    subject,
    `${key}.xlsx`,
    JSON.stringify([key, subject]),
    recordId
  ).lastInsertRowid);
}

function insertCalculatedRun(db, targetMonth = '2026-06', {
  adjustmentAmount = null,
  adjustmentReason = '人工纠错调整'
} = {}) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision, input_fingerprint
    ) VALUES (?, 'calculated', '{"recharge_refund":1}', ?, ?)
  `).run(
    targetMonth,
    adjustmentAmount === null ? 0 : 1,
    `fixture-${targetMonth}`
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
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    insertBalance.run(runId, currency, periodAmount, calculatedBalance, calculatedBalance);
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, currency_mismatch, flow_amount, pending_amount
    ) VALUES (?, 'PPHK', 0, '0', '0')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, 'PPHK', 'USD', '0')
  `).run(runId);
  if (adjustmentAmount !== null) {
    const rowKey = buildRunRowKey({
      rowKind: 'movement',
      subject: 'PPHK',
      sourceType: SOURCE_TYPES.RECHARGE,
      categoryMajor: '充值',
      categoryMinor: '正常'
    });
    db.prepare(`
      INSERT INTO vcc_fin_op_run_adjustments (
        run_id, row_key, subject, source_type, category_major, category_minor,
        currency, adjustment_amount, reason, sequence,
        created_app_version, created_build_sha
      ) VALUES (?, ?, 'PPHK', ?, '充值', '正常', 'USD', ?, ?, 1,
                '3.1.8', 'fixture-build')
    `).run(runId, rowKey, SOURCE_TYPES.RECHARGE, adjustmentAmount, adjustmentReason);
  }
  return runId;
}

test('旧数据集生成时间优先从最近一次实际新增成功导入完成时间回填', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db, { status: 'success' });
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET finished_at = '2026-07-01 10:20:30', inserted_count = 1
    WHERE id = ?
  `).run(recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, generated_at, updated_at
    ) VALUES ('2026-06', ?, '2026-06-01 00:00:00', '2026-07-03 09:00:00')
  `).run(SOURCE_TYPES.RECHARGE);
  db.exec('ALTER TABLE vcc_fin_op_datasets DROP COLUMN generated_at');

  ensureVccFinancialOpTablesSupport(db);
  const dataset = db.prepare(`
    SELECT generated_at, updated_at
    FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).get(SOURCE_TYPES.RECHARGE);
  assert.equal(dataset.generated_at, '2026-07-01 10:20:30');
  assert.equal(dataset.updated_at, '2026-07-03 09:00:00');
});

test('按账期和目标原表删除有效数据，保留导入审计与人工期初并作废未归档结果', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  const effectiveId = insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      source_file, sheet_name, source_row, raw_json,
      disposition, existing_effective_id, validation_message
    ) VALUES (?, ?, '2026-06', 'ORDER-1', 'ORDER-1', 'hash-ORDER-1',
      'retry.xlsx', 'Sheet1', 2, '["ORDER-1","PPHK"]',
      'idempotent_skip', ?, '同键同内容')
  `).run(recordId, SOURCE_TYPES.RECHARGE, effectiveId);
  repository.addImportError(db, recordId, {
    errorCode: 'retained-audit',
    message: '保留的审计错误'
  });
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type, revision)
    VALUES ('2026-06', ?, 4)
  `).run(SOURCE_TYPES.RECHARGE);
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash, initialization_note
    ) VALUES ('2026-06', 'PPHK', '{}', 'opening-hash', '人工核对')
  `).run();
  const runId = insertCalculatedRun(db, '2026-06', {
    adjustmentAmount: '12.34',
    adjustmentReason: '人工纠错调整'
  });

  const otherRecordId = createRecord(db, {
    batchId: 'batch-other',
    sourceType: SOURCE_TYPES.FEE_FX,
    status: 'success'
  });
  insertEffective(db, otherRecordId, { sourceType: SOURCE_TYPES.FEE_FX, key: 'FEE-1' });
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.FEE_FX);

  const preview = inspectDatasetDeletion(db, '2026-06', SOURCE_TYPES.RECHARGE);
  assert.deepEqual({
    deletable: preview.deletable,
    dataCount: preview.dataCount,
    calculatedRunCount: preview.calculatedRunCount,
    datasetRevision: preview.datasetRevision
  }, {
    deletable: true,
    dataCount: 1,
    calculatedRunCount: 1,
    datasetRevision: 4
  });

  const result = deleteDataset({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    reason: '纠正来源数据后重新计算',
    appVersion: '3.1.8',
    buildSha: 'fixture-build'
  });
  assert.deepEqual(result, {
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceLabel: 'VCC充值清退明细',
    deletedDataCount: 1,
    invalidatedRunCount: 1,
    deletionId: 1,
    deletedImportRecordCount: 1,
    auditId: 1
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows
    WHERE target_month = '2026-06' AND source_type = ?
  `).get(SOURCE_TYPES.RECHARGE).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?').get(runId).n, 0);
  for (const tableName of [
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals'
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tableName} WHERE run_id = ?`).get(runId).n, 0);
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_datasets
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).get(SOURCE_TYPES.RECHARGE).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_opening_balances').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_records').get().n, 2);
  const deletedRecord = db.prepare(`
    SELECT status, dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records WHERE id = ?
  `).get(recordId);
  assert.equal(deletedRecord.status, 'success_with_skips');
  assert.ok(deletedRecord.dataset_deleted_at);
  assert.equal(deletedRecord.dataset_deletion_id, result.deletionId);
  const retainedRecord = db.prepare(`
    SELECT dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records WHERE id = ?
  `).get(otherRecordId);
  assert.equal(retainedRecord.dataset_deleted_at, null);
  assert.equal(retainedRecord.dataset_deletion_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors').get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows
    WHERE target_month = '2026-06' AND source_type = ?
  `).get(SOURCE_TYPES.FEE_FX).n, 1);
  const audit = db.prepare(`
    SELECT existing_effective_id, existing_raw_json_snapshot,
           existing_source_file_snapshot, existing_import_record_id_snapshot
    FROM vcc_fin_op_import_rows WHERE import_record_id = ?
  `).get(recordId);
  assert.equal(audit.existing_effective_id, null);
  assert.equal(audit.existing_raw_json_snapshot, '["ORDER-1","PPHK"]');
  assert.equal(audit.existing_source_file_snapshot, 'ORDER-1.xlsx');
  assert.equal(audit.existing_import_record_id_snapshot, recordId);
  assert.deepEqual({ ...db.prepare(`
    SELECT target_month, source_type, dataset_revision,
           deleted_data_count, invalidated_run_count
    FROM vcc_fin_op_dataset_deletions
  `).get() }, {
    target_month: '2026-06',
    source_type: SOURCE_TYPES.RECHARGE,
    dataset_revision: 4,
    deleted_data_count: 1,
    invalidated_run_count: 1
  });
  const operationAudit = db.prepare(`
    SELECT operation_type, status, preview_token, evidence_json, app_version, build_sha
    FROM vcc_fin_op_operation_audit WHERE id = ?
  `).get(result.auditId);
  assert.equal(operationAudit.operation_type, DELETE_SOURCE_DATASET_OPERATION);
  assert.equal(operationAudit.status, 'success');
  assert.match(operationAudit.preview_token, /^v1:[a-f0-9]{64}$/);
  assert.equal(operationAudit.app_version, '3.1.8');
  assert.equal(operationAudit.build_sha, 'fixture-build');
  const evidence = JSON.parse(operationAudit.evidence_json);
  assert.equal(evidence.action, DELETE_SOURCE_DATASET_OPERATION);
  assert.equal(evidence.targetMonth, '2026-06');
  assert.equal(evidence.sourceType, SOURCE_TYPES.RECHARGE);
  assert.equal(evidence.sourceLabel, 'VCC充值清退明细');
  assert.equal(evidence.datasetRevision, 4);
  assert.equal(evidence.reason, '纠正来源数据后重新计算');
  assert.deepEqual(evidence.runIds, [runId]);
  assert.equal(evidence.runs[0].baseRows[0].amount, '10');
  assert.equal(evidence.runs[0].adjustments[0].adjustmentAmount, '12.34');
  assert.equal(evidence.runs[0].adjustments[0].reason, '人工纠错调整');
  assert.equal(evidence.runs[0].adjustments[0].sequence, 1);
  assert.equal(evidence.runs[0].effectiveRows[0].effectiveAmount, '22.34');
  assert.equal(evidence.runs[0].balances.length, SUPPORTED_CURRENCIES.length);
  const usdBalance = evidence.runs[0].balances.find((row) => row.currency === 'USD');
  assert.equal(usdBalance.adjustmentAmount, '12.34');
  assert.equal(usdBalance.effectivePeriodAmount, '22.34');
  assert.equal(usdBalance.effectiveCalculatedBalance, '122.34');
  assert.equal(evidence.runs[0].pendingSummaryRows.length, 1);
  assert.equal(evidence.runs[0].pendingCurrencyTotals.length, 1);
});

test('删除系统财务OP时固化快照对比证据并保留系统导入尝试', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db, {
    batchId: 'system-batch',
    sourceType: SOURCE_TYPES.SYSTEM_OP
  });
  const snapshotId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('2026-06', 'PPHK', '{"USD":"100"}', 'system-hash',
      'system-original.xlsx', 'Validate', 3, '{"row":"original"}', ?)
  `).run(recordId).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, disposition, existing_snapshot_id
    ) VALUES (?, '2026-06', 'PPHK', '{"USD":"100"}', 'system-hash',
      'system-retry.xlsx', 'Validate', 3, '{"row":"retry"}', 'idempotent_skip', ?)
  `).run(recordId, snapshotId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.SYSTEM_OP);

  const result = deleteDataset({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.SYSTEM_OP
  });
  assert.equal(result.deletedDataCount, 1);
  assert.equal(result.deletedImportRecordCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 0);
  const attempt = db.prepare(`
    SELECT existing_snapshot_id, existing_balances_json_snapshot,
           existing_raw_json_snapshot, existing_source_file_snapshot,
           existing_import_record_id_snapshot
    FROM vcc_fin_op_system_snapshot_attempts
  `).get();
  assert.equal(attempt.existing_snapshot_id, null);
  assert.equal(attempt.existing_balances_json_snapshot, '{"USD":"100"}');
  assert.equal(attempt.existing_raw_json_snapshot, '{"row":"original"}');
  assert.equal(attempt.existing_source_file_snapshot, 'system-original.xlsx');
  assert.equal(attempt.existing_import_record_id_snapshot, recordId);
});

test('已归档账期和活动导入均失败关闭', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type, data_status)
    VALUES ('2026-06', ?, 'archived')
  `).run(SOURCE_TYPES.RECHARGE);

  const archived = inspectDatasetDeletion(db, '2026-06', SOURCE_TYPES.RECHARGE);
  assert.equal(archived.deletable, false);
  assert.equal(archived.code, 'archived-month');
  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    (error) => error.code === 'archived-month'
  );

  db.prepare(`
    UPDATE vcc_fin_op_datasets SET data_status = 'unprocessed'
    WHERE target_month = '2026-06' AND dataset_type = ?
  `).run(SOURCE_TYPES.RECHARGE);
  repository.createImportBatch(db, { id: 'active-batch', targetMonth: '2026-07', fileCount: 1 });
  const active = inspectDatasetDeletion(db, '2026-06', SOURCE_TYPES.RECHARGE);
  assert.equal(active.deletable, false);
  assert.equal(active.code, 'active-task');
  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    (error) => error.code === 'active-task'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
});

test('删除中任一步失败时审计、有效数据、结果和数据集全部回滚', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  const effectiveId = insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, source_file, sheet_name,
      source_row, raw_json, disposition, existing_effective_id
    ) VALUES (?, ?, '2026-06', 'retry.xlsx', 'Sheet1', 2, '[]', 'idempotent_skip', ?)
  `).run(recordId, SOURCE_TYPES.RECHARGE, effectiveId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const runId = insertCalculatedRun(db);
  db.exec(`
    CREATE TRIGGER fail_vcc_dataset_delete
    BEFORE DELETE ON vcc_fin_op_effective_rows
    BEGIN
      SELECT RAISE(ABORT, 'forced delete failure');
    END;
  `);

  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    /forced delete failure/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_dataset_deletions').get().n, 0);
  const operationAudits = db.prepare(`
    SELECT status, evidence_json
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ? ORDER BY id
  `).all(DELETE_SOURCE_DATASET_OPERATION);
  assert.deepEqual(operationAudits.map((row) => row.status), ['rolled_back']);
  const failureEvidence = JSON.parse(operationAudits[0].evidence_json);
  assert.equal(failureEvidence.failure.message.includes('forced delete failure'), true);
  assert.equal(failureEvidence.runs[0].run.runId, runId);
  assert.equal(failureEvidence.runs[0].adjustments.length, 0);
  const record = db.prepare(`
    SELECT dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records WHERE id = ?
  `).get(recordId);
  assert.equal(record.dataset_deleted_at, null);
  assert.equal(record.dataset_deletion_id, null);
  const audit = db.prepare(`
    SELECT existing_effective_id, existing_raw_json_snapshot
    FROM vcc_fin_op_import_rows
  `).get();
  assert.equal(audit.existing_effective_id, effectiveId);
  assert.equal(audit.existing_raw_json_snapshot, null);
});

test('结果证据损坏时原表、run、调整和数据集零删除并记录失败目标', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type, revision)
    VALUES ('2026-06', ?, 9)
  `).run(SOURCE_TYPES.RECHARGE);
  const runId = insertCalculatedRun(db, '2026-06', { adjustmentAmount: '12.34' });
  db.prepare(`
    DELETE FROM vcc_fin_op_run_balances
    WHERE run_id = ? AND currency = 'JPY'
  `).run(runId);

  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    (error) => error.code === 'run-balance-currencies-incomplete'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_run_adjustments WHERE run_id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_dataset_deletions').get().n, 0);
  const audit = db.prepare(`
    SELECT status, evidence_json
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ?
  `).get(DELETE_SOURCE_DATASET_OPERATION);
  assert.equal(audit.status, 'rolled_back');
  const evidence = JSON.parse(audit.evidence_json);
  assert.equal(evidence.action, DELETE_SOURCE_DATASET_OPERATION);
  assert.equal(evidence.targetMonth, '2026-06');
  assert.equal(evidence.sourceType, SOURCE_TYPES.RECHARGE);
  assert.equal(evidence.datasetRevision, 9);
  assert.deepEqual(evidence.runIds, [runId]);
  assert.deepEqual(evidence.runs, []);
  assert.equal(evidence.failure.code, 'run-balance-currencies-incomplete');
});

test('success 审计写入失败时业务事实不变且仅尽力记录 rolled_back', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const runId = insertCalculatedRun(db, '2026-06', { adjustmentAmount: '12.34' });
  db.exec(`
    CREATE TRIGGER fail_source_delete_success_audit
    BEFORE INSERT ON vcc_fin_op_operation_audit
    WHEN NEW.operation_type = 'delete-source-dataset' AND NEW.status = 'success'
    BEGIN SELECT RAISE(ABORT, 'forced source audit failure'); END;
  `);

  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    /forced source audit failure/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_run_adjustments WHERE run_id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_dataset_deletions').get().n, 0);
  const audits = db.prepare(`
    SELECT status, evidence_json
    FROM vcc_fin_op_operation_audit
    WHERE operation_type = ? ORDER BY id
  `).all(DELETE_SOURCE_DATASET_OPERATION);
  assert.deepEqual(audits.map((row) => row.status), ['rolled_back']);
  const evidence = JSON.parse(audits[0].evidence_json);
  assert.equal(evidence.failure.message.includes('forced source audit failure'), true);
  assert.equal(evidence.runs[0].adjustments[0].adjustmentAmount, '12.34');
});

test('删除范围严格校验月份和目标表，无有效数据时不可执行', (t) => {
  const db = openDb(t);
  assert.throws(
    () => inspectDatasetDeletion(db, '2026-13', SOURCE_TYPES.RECHARGE),
    (error) => error.code === 'invalid-month'
  );
  assert.throws(
    () => inspectDatasetDeletion(db, '2026-06', 'unknown'),
    (error) => error.code === 'invalid-source-type'
  );
  const empty = inspectDatasetDeletion(db, '2026-06', SOURCE_TYPES.RECHARGE);
  assert.equal(empty.deletable, false);
  assert.equal(empty.code, 'no-data');
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const emptyDataset = inspectDatasetDeletion(db, '2026-06', SOURCE_TYPES.RECHARGE);
  assert.equal(emptyDataset.deletable, false);
  assert.equal(emptyDataset.code, 'no-data');
});

test('DELETE 被触发器静默忽略时由提交前不变量校验回滚', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db);
  insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const runId = insertCalculatedRun(db);
  db.exec(`
    CREATE TRIGGER ignore_vcc_dataset_delete
    BEFORE DELETE ON vcc_fin_op_effective_rows
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);

  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    (error) => error.code === 'delete-invariant-failed'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_runs WHERE id = ?').get(runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_dataset_deletions').get().n, 0);
});

test('删除只标记成功类记录，失败记录保留；重导后新旧删除周期彼此独立', (t) => {
  const db = openDb(t);
  const firstRecordId = createRecord(db, {
    batchId: 'first-success',
    status: 'success'
  });
  insertEffective(db, firstRecordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  const failedRecordId = createRecord(db, {
    batchId: 'failed-attempt',
    status: 'failed_validation'
  });

  const firstDelete = deleteDataset({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(firstDelete.deletedImportRecordCount, 1);
  assert.ok(db.prepare(`
    SELECT dataset_deleted_at FROM vcc_fin_op_import_records WHERE id = ?
  `).get(firstRecordId).dataset_deleted_at);
  assert.equal(db.prepare(`
    SELECT status, dataset_deleted_at FROM vcc_fin_op_import_records WHERE id = ?
  `).get(failedRecordId).dataset_deleted_at, null);

  const secondRecordId = createRecord(db, {
    batchId: 'second-success',
    status: 'all_skipped'
  });
  insertEffective(db, secondRecordId, { key: 'ORDER-2' });
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type, revision)
    VALUES ('2026-06', ?, 2)
  `).run(SOURCE_TYPES.RECHARGE);
  const secondDelete = deleteDataset({
    db,
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE
  });
  assert.equal(secondDelete.deletedImportRecordCount, 1);
  assert.notEqual(secondDelete.deletionId, firstDelete.deletionId);
  assert.equal(db.prepare(`
    SELECT dataset_deletion_id FROM vcc_fin_op_import_records WHERE id = ?
  `).get(firstRecordId).dataset_deletion_id, firstDelete.deletionId);
  assert.equal(db.prepare(`
    SELECT dataset_deletion_id FROM vcc_fin_op_import_records WHERE id = ?
  `).get(secondRecordId).dataset_deletion_id, secondDelete.deletionId);
  assert.equal(db.prepare(`
    SELECT status, dataset_deleted_at FROM vcc_fin_op_import_records WHERE id = ?
  `).get(failedRecordId).status, 'failed_validation');
});

test('导入记录删除状态被静默忽略时有效数据与删除审计整体回滚', (t) => {
  const db = openDb(t);
  const recordId = createRecord(db, { status: 'success' });
  insertEffective(db, recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (target_month, dataset_type)
    VALUES ('2026-06', ?)
  `).run(SOURCE_TYPES.RECHARGE);
  db.exec(`
    CREATE TRIGGER ignore_vcc_import_record_delete_status
    BEFORE UPDATE OF dataset_deleted_at ON vcc_fin_op_import_records
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);

  assert.throws(
    () => deleteDataset({ db, targetMonth: '2026-06', sourceType: SOURCE_TYPES.RECHARGE }),
    (error) => error.code === 'delete-invariant-failed'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_effective_rows').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_datasets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_dataset_deletions').get().n, 0);
  const record = db.prepare(`
    SELECT dataset_deleted_at, dataset_deletion_id
    FROM vcc_fin_op_import_records WHERE id = ?
  `).get(recordId);
  assert.equal(record.dataset_deleted_at, null);
  assert.equal(record.dataset_deletion_id, null);
});
