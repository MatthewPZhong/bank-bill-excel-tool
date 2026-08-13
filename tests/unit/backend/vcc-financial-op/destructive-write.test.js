'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_MUTATION_OPERATIONS
} = require('../../../../src/backend/vcc-financial-op/mutation-policy');
const {
  previewUnarchiveSnapshot,
  previewDeleteTargetSnapshot,
  DELETE_TARGET_TYPES
} = require('../../../../src/backend/vcc-financial-op/read-snapshot');
const {
  executeDestructiveMutationWithSafeAudit
} = require('../../../../src/backend/vcc-financial-op/destructive-write');
const {
  LEGACY_FIXTURE_PATH,
  createCurrentRawEvidence
} = require('./_archive-evidence-fixture');

function createTempDb(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-destructive-write-test-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  if (legacy) fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dbPath;
}

function seedCurrentArchived(dbPath) {
  const raw = createCurrentRawEvidence();
  const run = raw.runs[0];
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      id, target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, ?, 'archived', ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    raw.targetMonth,
    JSON.stringify(run.inputRevisions),
    run.resultRevision,
    run.inputFingerprint,
    run.createdAt,
    run.updatedAt,
    run.archivedAt
  );
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, ?, ?, ?)
  `);
  for (const dataset of raw.datasets) {
    insertDataset.run(
      raw.targetMonth,
      dataset.datasetType,
      run.id,
      dataset.revision,
      dataset.generatedAt,
      dataset.updatedAt
    );
  }
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      id, run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of raw.runRows) {
    insertRow.run(
      row.id, row.runId, row.subject, row.rowKind, row.sourceType,
      row.categoryMajor, row.categoryMinor, row.currency, row.amount
    );
  }
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const balance of raw.storedRunBalances) {
    insertBalance.run(
      balance.runId, balance.subject, balance.currency, balance.openingBalance,
      balance.periodAmount, balance.calculatedBalance, balance.systemBalance, balance.difference
    );
  }
  const insertAdjustment = db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      id, run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence,
      created_at, created_app_version, created_build_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const adjustment of raw.runAdjustments) {
    insertAdjustment.run(
      adjustment.id, adjustment.runId, adjustment.rowKey, adjustment.subject,
      adjustment.sourceType, adjustment.categoryMajor, adjustment.categoryMinor,
      adjustment.currency, adjustment.adjustmentAmount, adjustment.reason,
      adjustment.sequence, adjustment.createdAt,
      adjustment.createdAppVersion, adjustment.createdBuildSha
    );
  }
  const insertArchive = db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const archive of raw.archives) {
    insertArchive.run(
      raw.targetMonth,
      archive.subject,
      JSON.stringify(archive.balances),
      archive.runId,
      archive.archivedAt
    );
  }
  db.close();
  return raw;
}

function preview(dbPath, targetMonth, taskGeneration = 0) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; BEGIN DEFERRED');
  try {
    const result = previewUnarchiveSnapshot(db, { targetMonth, taskGeneration });
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

function execute(dbPath, targetMonth, snapshot, onProgress = null) {
  return executeDestructiveMutationWithSafeAudit({
    dbPath,
    action: VCC_MUTATION_OPERATIONS.UNARCHIVE_MONTH,
    payload: {
      targetMonth,
      expectedPreviewToken: snapshot.previewToken
    },
    taskGeneration: snapshot.taskGeneration,
    appVersion: '3.1.9',
    buildSha: 'c2-test',
    onProgress
  });
}

function executeDelete(dbPath, snapshot) {
  return executeDestructiveMutationWithSafeAudit({
    dbPath,
    action: VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    payload: {
      targetMonth: snapshot.targetMonth,
      targetType: snapshot.targetType,
      expectedPreviewToken: snapshot.previewToken,
      reason: 'C2 删除测试'
    },
    taskGeneration: snapshot.taskGeneration,
    appVersion: '3.1.9',
    buildSha: 'c2-test'
  });
}

function seedCalculatedRunWithChildren(db, targetMonth) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at
    ) VALUES (?, 'calculated', '{}', 1, ?, '2026-08-11 10:00:00', '2026-08-11 10:00:00')
  `).run(targetMonth, 'a'.repeat(64)).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence
    ) VALUES (?, ?, 'PPHK', 'recharge_refund', '充值', '', 'USD', '1', '测试', 1)
  `).run(runId, `v1:${'b'.repeat(64)}`);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type, category_major, category_minor,
      currency, amount
    ) VALUES (?, 'PPHK', 'movement', 'recharge_refund', '充值', '', 'USD', '1')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', 'USD', '1', '1', '2', '2', '0')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, 'PPHK', 'CITI', 0, 'USD', 'USD', 'normal', '1', '1')
  `).run(runId);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, 'PPHK', 'USD', '1')
  `).run(runId);
  return runId;
}

function deletePreview(dbPath, targetMonth, targetType) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; BEGIN DEFERRED');
  try {
    const result = previewDeleteTargetSnapshot(db, {
      targetMonth,
      targetType,
      taskGeneration: 0
    });
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

function seedSuccessfulImportRecord(db, targetMonth, sourceType) {
  const batchId = `batch-${targetMonth}-${sourceType}`;
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at, finished_at
    ) VALUES (?, ?, 'success', 1, '2026-08-11 08:00:00', '2026-08-11 08:05:00')
  `).run(batchId, targetMonth);
  return Number(db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, started_at, finished_at
    ) VALUES (?, ?, ?, '[]', 'success', 1, 1,
              '2026-08-11 08:00:00', '2026-08-11 08:05:00')
  `).run(batchId, targetMonth, sourceType).lastInsertRowid);
}

function seedDataset(db, targetMonth, sourceType, revision = 3) {
  db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'unprocessed', NULL, ?, '2026-08-11 08:05:00', '2026-08-11 08:05:00')
  `).run(targetMonth, sourceType, revision);
}

function unarchiveState(dbPath, targetMonth) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const run = db.prepare(`
      SELECT id, status, result_revision, input_fingerprint, archived_at
      FROM vcc_fin_op_runs WHERE target_month = ?
    `).get(targetMonth);
    const datasets = db.prepare(`
      SELECT dataset_type, data_status, archived_run_id, revision
      FROM vcc_fin_op_datasets WHERE target_month = ? ORDER BY dataset_type
    `).all(targetMonth);
    const archiveCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_archives WHERE target_month = ?
    `).get(targetMonth).count);
    const pendingFactCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = 'pending_archive_removal'
    `).get(targetMonth).count);
    const audit = db.prepare(`
      SELECT status, preview_token, evidence_json, app_version, build_sha
      FROM vcc_fin_op_operation_audit
      WHERE target_month = ? AND operation_type = 'unarchive'
      ORDER BY id DESC LIMIT 1
    `).get(targetMonth);
    return { run, datasets, archiveCount, pendingFactCount, audit };
  } finally {
    db.close();
  }
}

test('current v2 preview 在锁内重算后按 N+7 解归档', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentArchived(dbPath);
  const snapshot = preview(dbPath, raw.targetMonth);
  assert.equal(snapshot.archiveContract, 'current-five-dataset');
  assert.equal(snapshot.canUnarchive, true);
  const phases = [];
  const result = execute(
    dbPath,
    raw.targetMonth,
    snapshot,
    (progress) => phases.push(progress.phase)
  );
  const state = unarchiveState(dbPath, raw.targetMonth);
  assert.deepEqual(phases, [
    'validating', 'preserving-audit', 'applying', 'verifying', 'committed'
  ]);
  assert.equal(result.status, 'unarchived');
  assert.equal(result.archiveContract, 'current-five-dataset');
  assert.equal(state.run.status, 'calculated');
  assert.equal(state.run.archived_at, null);
  assert.equal(state.run.result_revision, raw.runs[0].resultRevision);
  assert.equal(state.run.input_fingerprint, raw.runs[0].inputFingerprint);
  assert.equal(state.archiveCount, 0);
  assert.equal(state.datasets.length, 5);
  assert.ok(state.datasets.every((row) => (
    row.data_status === 'unprocessed' && row.archived_run_id === null
  )));
  assert.equal(state.audit.status, 'success');
  assert.equal(state.audit.preview_token, snapshot.previewToken);
  assert.equal(state.audit.app_version, '3.1.9');
  assert.equal(state.audit.build_sha, 'c2-test');
  assert.equal(JSON.parse(state.audit.evidence_json).expectedTotalChanges, 8);
});

test('真实 v3.1.7 fixture 由同一生产写入口按 N+6 解归档且不创建 Pending', (t) => {
  const dbPath = createTempDb(t, { legacy: true });
  const snapshot = preview(dbPath, '2026-06');
  assert.equal(snapshot.archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(snapshot.canUnarchive, true);
  const result = execute(dbPath, '2026-06', snapshot);
  const state = unarchiveState(dbPath, '2026-06');
  assert.equal(result.status, 'unarchived');
  assert.equal(result.archiveContract, 'legacy-v3.1.7-four-dataset');
  assert.equal(state.run.status, 'calculated');
  assert.equal(state.run.result_revision, 0);
  assert.equal(state.run.input_fingerprint, null);
  assert.equal(state.datasets.length, 4);
  assert.equal(state.datasets.some((row) => row.dataset_type === 'pending_archive_removal'), false);
  assert.equal(state.pendingFactCount, 0);
  assert.equal(state.archiveCount, 0);
  assert.equal(JSON.parse(state.audit.evidence_json).expectedTotalChanges, 7);
  assert.equal(JSON.parse(state.audit.evidence_json).minimumSafeAppVersion, '3.1.9');
});

test('result delete 显式删除五张 child 后按 1+R+ΣC 删除 runs', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const runId = seedCalculatedRunWithChildren(db, '2026-07');
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.RESULT);
  assert.equal(snapshot.deletable, true);
  const result = executeDelete(dbPath, snapshot);
  assert.deepEqual(result.deletedRunIds, [runId]);
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  for (const tableName of [
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals',
    'vcc_fin_op_runs'
  ]) {
    assert.equal(verify.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count, 0);
  }
  const audit = verify.prepare(`
    SELECT evidence_json FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete_unarchived_result' AND status = 'success'
  `).get();
  assert.equal(JSON.parse(audit.evidence_json).expectedTotalChanges, 7);
  assert.deepEqual(JSON.parse(audit.evidence_json).symbols, {
    R: 1, C_adj: 1, C_row: 1, C_bal: 1, C_ps: 1, C_pc: 1, O: 0
  });
  verify.close();
});

test('opening delete 复用五 child 显式预算并保持 module first_month 只读', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  seedCalculatedRunWithChildren(db, '2026-07');
  db.prepare(`
    UPDATE vcc_fin_op_module_state
    SET first_month = '2026-07', updated_at = '2026-08-11 09:00:00'
    WHERE singleton_id = 1
  `).run();
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash,
      initialization_note, initialized_at
    ) VALUES ('2026-07', 'PPHK', '{}', 'opening-hash', '人工核对', '2026-08-11 09:00:00')
  `).run();
  const moduleBefore = db.prepare('SELECT * FROM vcc_fin_op_module_state').get();
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.OPENING);
  assert.equal(snapshot.deletable, true);
  const result = executeDelete(dbPath, snapshot);
  assert.equal(result.deletedOpeningCount, 1);
  assert.equal(result.deletedRunCount, 1);
  assert.equal(result.firstMonth, '2026-07');
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_opening_balances').get().count, 0);
  assert.deepEqual(verify.prepare('SELECT * FROM vcc_fin_op_module_state').get(), moduleBefore);
  const audit = verify.prepare(`
    SELECT evidence_json FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete_opening_initialization' AND status = 'success'
  `).get();
  assert.equal(JSON.parse(audit.evidence_json).expectedTotalChanges, 8);
  verify.close();
});

test('opening delete 对多期初月与 first-month 冲突均在首写前阻断且零 rollback audit', (t) => {
  const scenarios = [{
    reason: 'multiple-opening-months',
    openingMonths: ['2026-07', '2026-08']
  }, {
    reason: 'first-month-opening-conflict',
    openingMonths: ['2026-08']
  }];
  for (const scenario of scenarios) {
    const dbPath = createTempDb(t);
    const db = new DatabaseSync(dbPath);
    db.prepare(`
      UPDATE vcc_fin_op_module_state SET first_month = '2026-07'
      WHERE singleton_id = 1
    `).run();
    const insertOpening = db.prepare(`
      INSERT INTO vcc_fin_op_opening_balances (
        target_month, subject, balances_json, content_hash,
        initialization_note, initialized_at
      ) VALUES (?, 'PPHK', '{}', ?, '人工核对', '2026-08-11 09:00:00')
    `);
    for (const month of scenario.openingMonths) insertOpening.run(month, `hash-${month}`);
    const before = {
      openings: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_opening_balances
      `).get().count),
      audits: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
      `).get().count)
    };
    db.close();

    const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.OPENING);
    assert.equal(snapshot.deletable, false);
    assert.equal(snapshot.code, 'vcc-first-month-migration-blocked');
    assert.match(snapshot.message, new RegExp(scenario.reason === 'multiple-opening-months'
      ? '多个首月期初初始化月份'
      : '首月状态.*冲突'));
    assert.throws(() => executeDelete(dbPath, snapshot), {
      code: 'vcc-first-month-migration-blocked'
    });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(verify.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_opening_balances
    `).get().count, before.openings);
    assert.equal(verify.prepare(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    `).get().count, before.audits);
    verify.close();
  }
});

test('detail source delete 在清 FK 前物化 Q 行并按 2+R+ΣC+2Q+E+D+M 删除 orphan facts', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  seedCalculatedRunWithChildren(db, '2026-07');
  const recordId = seedSuccessfulImportRecord(db, '2026-07', 'recharge_refund');
  const effectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      raw_contract_version, target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id, first_imported_at
    ) VALUES ('recharge_refund', 'raw-key', 'key', 'hash', 1,
              '2026-07', 'PPHK', 'USD', '10', 'detail.xlsx', 'Sheet1', 2,
              '["raw"]', ?, '2026-08-11 08:05:00')
  `).run(recordId).lastInsertRowid);
  const auditRowId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month, idempotency_key_raw,
      idempotency_key, content_hash, raw_contract_version, subject,
      stat_currency, signed_amount, source_file, sheet_name, source_row,
      raw_json, disposition, existing_effective_id
    ) VALUES (?, 'recharge_refund', '2026-07', 'raw-key', 'key', 'hash', 1,
              'PPHK', 'USD', '10', 'detail-copy.xlsx', 'Sheet1', 3,
              '["copy"]', 'idempotent_skip', ?)
  `).run(recordId, effectiveId).lastInsertRowid);
  const nonTargetRecordId = seedSuccessfulImportRecord(db, '2026-08', 'recharge_refund');
  const nonTargetEffectiveId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      raw_contract_version, target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id, first_imported_at
    ) VALUES ('recharge_refund', 'other-raw-key', 'other-key', 'other-hash', 1,
              '2026-08', 'PPHK', 'USD', '20', 'other-detail.xlsx', 'Sheet1', 4,
              '["other"]', ?, '2026-08-11 08:06:00')
  `).run(nonTargetRecordId).lastInsertRowid);
  db.close();

  const snapshot = deletePreview(dbPath, '2026-07', 'recharge_refund');
  assert.equal(snapshot.deletable, true);
  assert.equal(snapshot.datasetRevision, null, 'D=0 orphan fact 不伪造 dataset');
  const result = executeDelete(dbPath, snapshot);
  assert.equal(result.deletedDataCount, 1);
  assert.equal(result.invalidatedRunCount, 1);
  assert.equal(result.deletedImportRecordCount, 1);

  const verify = new DatabaseSync(dbPath, { readOnly: true });
  const auditRow = verify.prepare(`
    SELECT existing_effective_id, existing_raw_json_snapshot,
           existing_raw_contract_version_snapshot, existing_subject_snapshot,
           existing_source_file_snapshot, existing_sheet_name_snapshot,
           existing_source_row_snapshot, existing_import_record_id_snapshot,
           existing_imported_at_snapshot
    FROM vcc_fin_op_import_rows WHERE id = ?
  `).get(auditRowId);
  assert.deepEqual({ ...auditRow }, {
    existing_effective_id: null,
    existing_raw_json_snapshot: '["raw"]',
    existing_raw_contract_version_snapshot: 1,
    existing_subject_snapshot: 'PPHK',
    existing_source_file_snapshot: 'detail.xlsx',
    existing_sheet_name_snapshot: 'Sheet1',
    existing_source_row_snapshot: 2,
    existing_import_record_id_snapshot: recordId,
    existing_imported_at_snapshot: '2026-08-11 08:05:00'
  });
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows
    WHERE target_month = '2026-07' AND source_type = 'recharge_refund'
  `).get().count, 0);
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows WHERE id = ?
  `).get(nonTargetEffectiveId).count, 1, '大表固定 scope 不得误删非目标月事实');
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_datasets').get().count, 0);
  const deletion = verify.prepare('SELECT * FROM vcc_fin_op_dataset_deletions').get();
  assert.equal(deletion.dataset_revision, null);
  assert.equal(deletion.deleted_data_count, 1);
  assert.equal(deletion.invalidated_run_count, 1);
  const audit = verify.prepare(`
    SELECT evidence_json FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete-source-dataset' AND status = 'success'
  `).get();
  assert.equal(JSON.parse(audit.evidence_json).orphanDataset, true);
  assert.equal(JSON.parse(audit.evidence_json).expectedTotalChanges, 12);
  verify.close();
});

test('system source delete 先补 B 再物化/清除 A，按固定公式保留唯一 accepted audit', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  seedCalculatedRunWithChildren(db, '2026-07');
  const recordId = seedSuccessfulImportRecord(db, '2026-07', 'system_op');
  seedDataset(db, '2026-07', 'system_op', 4);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json,
      import_record_id, imported_at
    ) VALUES ('2026-07', 'PPHK', '{"USD":"10"}', 'system-hash',
              'system.xlsx', 'Validate', 2, '{"raw":1}', ?, '2026-08-11 08:05:00')
  `).run(recordId);
  db.close();

  const snapshot = deletePreview(dbPath, '2026-07', 'system_op');
  assert.equal(snapshot.deletable, true);
  const result = executeDelete(dbPath, snapshot);
  assert.equal(result.deletedDataCount, 1);
  assert.equal(result.invalidatedRunCount, 1);
  assert.equal(result.deletedImportRecordCount, 1);

  const verify = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_system_snapshots').get().count, 0);
  const attempt = verify.prepare(`
    SELECT disposition, existing_snapshot_id, comparison_attempt_id,
           existing_balances_json_snapshot, existing_raw_json_snapshot,
           existing_source_file_snapshot, existing_sheet_name_snapshot,
           existing_source_row_snapshot, existing_import_record_id_snapshot,
           existing_imported_at_snapshot, message
    FROM vcc_fin_op_system_snapshot_attempts
  `).get();
  assert.deepEqual({ ...attempt }, {
    disposition: 'accepted',
    existing_snapshot_id: null,
    comparison_attempt_id: null,
    existing_balances_json_snapshot: '{"USD":"10"}',
    existing_raw_json_snapshot: '{"raw":1}',
    existing_source_file_snapshot: 'system.xlsx',
    existing_sheet_name_snapshot: 'Validate',
    existing_source_row_snapshot: 2,
    existing_import_record_id_snapshot: recordId,
    existing_imported_at_snapshot: '2026-08-11 08:05:00',
    message: '历史快照删除前补录首次成功导入审计'
  });
  const audit = verify.prepare(`
    SELECT evidence_json FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete-source-dataset' AND status = 'success'
  `).get();
  assert.deepEqual(JSON.parse(audit.evidence_json).symbols, {
    R: 1, C_adj: 1, C_row: 1, C_bal: 1, C_ps: 1, C_pc: 1,
    B: 1, A: 1, S: 1, D: 1, M: 1
  });
  assert.equal(JSON.parse(audit.evidence_json).expectedTotalChanges, 14);
  verify.close();
});

test('source delete 在 M=0 时整事务回滚并只写一条受保护 failure audit', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const recordId = seedSuccessfulImportRecord(db, '2026-07', 'recharge_refund');
  db.prepare(`
    UPDATE vcc_fin_op_import_records
    SET status = 'failed_validation', inserted_count = 0
    WHERE id = ?
  `).run(recordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES ('recharge_refund', 'raw-key', 'key', 'hash',
              '2026-07', 'PPHK', 'USD', '10', 'detail.xlsx', 'Sheet1', 2, '[]', ?)
  `).run(recordId);
  seedDataset(db, '2026-07', 'recharge_refund');
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', 'recharge_refund');
  assert.throws(() => executeDelete(dbPath, snapshot), { code: 'delete-invariant-failed' });
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows').get().count, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_datasets').get().count, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_dataset_deletions').get().count, 0);
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE status = 'rolled_back' AND operation_type = 'delete-source-dataset'
  `).get().count, 1);
  verify.close();
});

test('preview 后真实 run evidence 改变返回 state-changed，业务不删且 failure audit 可追溯', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const runId = seedCalculatedRunWithChildren(db, '2026-07');
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.RESULT);
  const mutate = new DatabaseSync(dbPath);
  mutate.prepare(`UPDATE vcc_fin_op_runs SET updated_at = '2026-08-11 11:00:00' WHERE id = ?`).run(runId);
  mutate.close();
  assert.throws(() => executeDelete(dbPath, snapshot), { code: 'state-changed' });
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_runs').get().count, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_run_rows').get().count, 1);
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE status = 'success'
  `).get().count, 0);
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE status = 'rolled_back' AND operation_type = 'delete_unarchived_result'
  `).get().count, 1);
  verify.close();
});

test('单一中途 fault 回滚已删五 child 与事务内 success audit', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const runId = seedCalculatedRunWithChildren(db, '2026-07');
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.RESULT);
  assert.throws(() => executeDestructiveMutationWithSafeAudit({
    dbPath,
    action: VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    payload: {
      targetMonth: snapshot.targetMonth,
      targetType: snapshot.targetType,
      expectedPreviewToken: snapshot.previewToken,
      reason: '中途故障回滚测试'
    },
    taskGeneration: snapshot.taskGeneration,
    appVersion: '3.1.9',
    buildSha: 'c2-test',
    hooks: {
      business: {
        beforeStep({ plannedStep }) {
          if (plannedStep.stepId !== 'delete.runs') return;
          const error = new Error('injected-mid-step-delete-fault');
          error.code = 'injected-delete-fault';
          throw error;
        }
      }
    }
  }), { code: 'injected-delete-fault' });

  const verify = new DatabaseSync(dbPath, { readOnly: true });
  for (const tableName of [
    'vcc_fin_op_run_adjustments',
    'vcc_fin_op_run_rows',
    'vcc_fin_op_run_balances',
    'vcc_fin_op_pending_summary_rows',
    'vcc_fin_op_pending_currency_totals',
    'vcc_fin_op_runs'
  ]) {
    assert.equal(
      verify.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${
        tableName === 'vcc_fin_op_runs' ? 'id' : 'run_id'
      } = ?`).get(runId).count,
      1,
      `${tableName} 必须随事务完整回滚`
    );
  }
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete_unarchived_result' AND status = 'success'
  `).get().count, 0);
  assert.equal(verify.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE operation_type = 'delete_unarchived_result' AND status = 'rolled_back'
  `).get().count, 1);
  verify.close();
});

test('未知 VCC trigger 在首写前阻断 delete 且数据库零 failure audit', (t) => {
  const dbPath = createTempDb(t);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  seedCalculatedRunWithChildren(db, '2026-07');
  db.close();
  const snapshot = deletePreview(dbPath, '2026-07', DELETE_TARGET_TYPES.RESULT);
  const mutate = new DatabaseSync(dbPath);
  mutate.exec(`
    CREATE TRIGGER unsafe_c2_trigger
    AFTER DELETE ON vcc_fin_op_runs
    BEGIN
      UPDATE vcc_fin_op_module_state SET updated_at = updated_at WHERE singleton_id = 1;
    END
  `);
  mutate.close();
  assert.throws(() => executeDelete(dbPath, snapshot), { code: 'vcc-trigger-policy-violation' });
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_runs').get().count, 1);
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit').get().count, 0);
  verify.close();
});
