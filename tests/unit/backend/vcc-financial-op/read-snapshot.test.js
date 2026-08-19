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
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  ARCHIVE_CONTRACTS
} = require('../../../../src/backend/vcc-financial-op/archive-contract');
const {
  SOURCE_TYPES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  assertVccSchemaReady,
  openVccReadDatabase
} = require('../../../../src/backend/vcc-financial-op/read-schema');
const {
  ACTIVE_MONTHS_SQL,
  listArchiveMonthsSnapshot,
  previewUnarchiveSnapshot,
  listActiveMonthsSnapshot,
  listDeleteTargetsSnapshot,
  previewDeleteTargetSnapshot
} = require('../../../../src/backend/vcc-financial-op/read-snapshot');
const {
  OPERATION_TOKEN_VERSION,
  buildOperationTokenV2
} = require('../../../../src/backend/vcc-financial-op/operation-token-v2');
const {
  buildArchiveEvidenceV2
} = require('../../../../src/backend/vcc-financial-op/archive-evidence');
const {
  classifyArchiveContract
} = require('../../../../src/backend/vcc-financial-op/archive-contract');
const {
  createCurrentRawEvidence
} = require('./_archive-evidence-fixture');

function createMigratedDb(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

function seedCurrentArchive(db) {
  const raw = createCurrentRawEvidence();
  const run = raw.runs[0];
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      id, target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.targetMonth,
    run.status,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const dataset of raw.datasets) {
    insertDataset.run(
      raw.targetMonth,
      dataset.datasetType,
      dataset.dataStatus,
      dataset.archivedRunId,
      dataset.revision,
      dataset.generatedAt,
      dataset.updatedAt
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
  const insertRunRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      id, run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of raw.runRows) {
    insertRunRow.run(
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
      balance.runId,
      balance.subject,
      balance.currency,
      balance.openingBalance,
      balance.periodAmount,
      balance.calculatedBalance,
      balance.systemBalance,
      balance.difference
    );
  }
  const insertAdjustment = db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      id, run_id, row_key, subject, source_type, category_major,
      category_minor, currency, adjustment_amount, reason, sequence,
      created_at, created_app_version, created_build_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const adjustment of raw.runAdjustments) {
    insertAdjustment.run(
      adjustment.id,
      adjustment.runId,
      adjustment.rowKey,
      adjustment.subject,
      adjustment.sourceType,
      adjustment.categoryMajor,
      adjustment.categoryMinor,
      adjustment.currency,
      adjustment.adjustmentAmount,
      adjustment.reason,
      adjustment.sequence,
      adjustment.createdAt,
      adjustment.createdAppVersion,
      adjustment.createdBuildSha
    );
  }
  return raw;
}

function monthAt(index) {
  const year = 2010 + Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return `${year}-${month}`;
}

test('B-01 schema-ready 只接受现有合同结构，readOnly 连接拒绝一个代表 DML', (t) => {
  const incomplete = new DatabaseSync(':memory:');
  incomplete.exec('CREATE TABLE vcc_fin_op_runs (id INTEGER PRIMARY KEY)');
  assert.throws(() => assertVccSchemaReady(incomplete), (error) => {
    assert.equal(error.code, 'vcc-schema-not-ready');
    assert.ok(error.detailLines.includes('missing-column:vcc_fin_op_runs.target_month'));
    assert.ok(error.detailLines.includes('missing-table:vcc_fin_op_datasets'));
    return true;
  });
  incomplete.close();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-read-schema-'));
  const dbPath = path.join(tempRoot, 'tool-data.sqlite');
  const db = createMigratedDb(dbPath);
  assert.deepEqual(assertVccSchemaReady(db), { ready: true });
  db.close();
  const readDb = openVccReadDatabase(dbPath);
  t.after(() => {
    readDb.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  assert.equal(readDb.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(readDb.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(readDb.prepare('PRAGMA busy_timeout').get().timeout, 30000);
  assert.throws(
    () => readDb.prepare("UPDATE vcc_fin_op_runs SET status = 'calculated'").run(),
    /read-only|readonly/i
  );
});

test('B-02 current archive 集合加载复用 A 合同，并生成稳定 token v2', () => {
  const db = createMigratedDb();
  const raw = seedCurrentArchive(db);
  const trace = [];
  const listed = listArchiveMonthsSnapshot(db, { trace: (entry) => trace.push(entry) });
  assert.equal(listed.months.length, 1);
  assert.equal(listed.months[0].archiveContract, ARCHIVE_CONTRACTS.CURRENT);
  assert.equal(listed.months[0].runId, raw.runs[0].id);
  assert.equal(trace.length, 10);
  assert.doesNotMatch(trace.map((entry) => entry.sql).join('\n'), /vcc_fin_op_import_rows|vcc_fin_op_opening_balances/i);

  const first = previewUnarchiveSnapshot(db, {
    targetMonth: raw.targetMonth,
    taskGeneration: 4,
    taskActive: false
  });
  const second = previewUnarchiveSnapshot(db, {
    targetMonth: raw.targetMonth,
    taskGeneration: 4,
    taskActive: false
  });
  assert.equal(first.archiveContract, ARCHIVE_CONTRACTS.CURRENT);
  assert.equal(first.previewToken, second.previewToken);
  assert.match(first.previewToken, /^v2:[0-9a-f]{64}$/);
  assert.equal(first.taskGeneration, 4);

  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at
    ) VALUES ('archive-read-active', '2026-08', 'importing', 1, '2026-08-01 00:00:00')
  `).run();
  assert.equal(
    listArchiveMonthsSnapshot(db).months[0].targetMonth,
    raw.targetMonth,
    'active/importing 只影响 gate，不隐藏归档月份'
  );
  assert.equal(previewUnarchiveSnapshot(db, {
    targetMonth: raw.targetMonth,
    taskGeneration: 4
  }).code, 'active-vcc-task');

  db.prepare(`
    UPDATE vcc_fin_op_archives SET balances_json = '{}'
    WHERE target_month = ? AND subject = 'PPHK'
  `).run(raw.targetMonth);
  const inconsistent = listArchiveMonthsSnapshot(db);
  assert.equal(inconsistent.months.length, 0);
  assert.equal(inconsistent.diagnostics.length, 1);
  assert.equal(inconsistent.diagnostics[0].event, 'vcc-financial-op-archive-month-excluded');
  assert.equal(inconsistent.diagnostics[0].targetMonth, raw.targetMonth);
  assert.equal(inconsistent.diagnostics[0].hasArchivedEvidence, true);
  assert.ok(inconsistent.diagnostics[0].consistencyReasons.length > 0);
  db.close();
});

test('B-02a 存量 CNH 归档随启动迁移为 CNY 后重新进入解归档列表', () => {
  const db = createMigratedDb();
  const raw = seedCurrentArchive(db);
  const archiveRow = db.prepare(`
    SELECT balances_json FROM vcc_fin_op_archives
    WHERE target_month = ? AND subject = 'PPHK'
  `).get(raw.targetMonth);
  const legacyBalances = JSON.parse(archiveRow.balances_json);
  legacyBalances.CNH = legacyBalances.CNY;
  delete legacyBalances.CNY;
  db.prepare(`
    UPDATE vcc_fin_op_archives SET balances_json = ?
    WHERE target_month = ? AND subject = 'PPHK'
  `).run(JSON.stringify(legacyBalances), raw.targetMonth);
  db.prepare(`
    UPDATE vcc_fin_op_run_balances SET currency = 'CNH'
    WHERE run_id = ? AND currency = 'CNY'
  `).run(raw.runs[0].id);
  db.prepare(`
    UPDATE vcc_fin_op_module_state SET currency_contract_version = 1
    WHERE singleton_id = 1
  `).run();

  const before = listArchiveMonthsSnapshot(db);
  assert.equal(before.months.length, 0, '旧 CNH 归档在 CNY 合同下必须先 fail-closed');
  assert.equal(before.diagnostics[0].targetMonth, raw.targetMonth);

  const migrated = ensureVccFinancialOpTablesSupport(db);
  assert.equal(migrated.currencyMigration.migrated, true);
  assert.equal(
    db.prepare(`
      SELECT currency FROM vcc_fin_op_run_balances
      WHERE run_id = ? AND subject = 'PPHK' AND currency = 'CNY'
    `).get(raw.runs[0].id).currency,
    'CNY'
  );
  assert.equal(
    Object.hasOwn(JSON.parse(db.prepare(`
      SELECT balances_json FROM vcc_fin_op_archives
      WHERE target_month = ? AND subject = 'PPHK'
    `).get(raw.targetMonth).balances_json), 'CNY'),
    true
  );

  const after = listArchiveMonthsSnapshot(db);
  assert.deepEqual(after.months.map((entry) => entry.targetMonth), [raw.targetMonth]);
  assert.equal(after.diagnostics.length, 0);
  const preview = previewUnarchiveSnapshot(db, {
    targetMonth: raw.targetMonth,
    taskGeneration: 0,
    taskActive: false
  });
  assert.equal(preview.canUnarchive, true);
  assert.equal(preview.archiveContract, ARCHIVE_CONTRACTS.CURRENT);
  db.close();
});

test('B-03 token canonical payload 对集合顺序稳定，generation 变化必改变 token', () => {
  const archiveEvidence = buildArchiveEvidenceV2(createCurrentRawEvidence());
  const archiveContract = classifyArchiveContract(archiveEvidence);
  const baseGate = {
    taskGeneration: 6,
    taskActive: false,
    activeBatchIds: ['batch-b', 'batch-a'],
    importingRecordIds: [9, 3],
    laterDependencies: []
  };
  const first = buildOperationTokenV2({
    action: 'unarchive',
    targetMonth: archiveEvidence.targetMonth,
    scope: null,
    archiveEvidence,
    archiveContract,
    gateEvidence: baseGate
  });
  const reordered = buildOperationTokenV2({
    action: 'unarchive',
    targetMonth: archiveEvidence.targetMonth,
    scope: null,
    archiveEvidence,
    archiveContract,
    gateEvidence: {
      ...baseGate,
      activeBatchIds: [...baseGate.activeBatchIds].reverse(),
      importingRecordIds: [...baseGate.importingRecordIds].reverse()
    }
  });
  const nextGeneration = buildOperationTokenV2({
    action: 'unarchive',
    targetMonth: archiveEvidence.targetMonth,
    scope: null,
    archiveEvidence,
    archiveContract,
    gateEvidence: { ...baseGate, taskGeneration: 7 }
  });
  assert.equal(OPERATION_TOKEN_VERSION, 2);
  assert.equal(first.previewToken, reordered.previewToken);
  assert.notEqual(first.previewToken, nextGeneration.previewToken);
  assert.equal(Object.hasOwn(first.canonicalPayload.gateEvidence, 'taskActive'), false);
  assert.equal(Object.hasOwn(first.canonicalPayload, 'opening'), false);
  assert.equal(Object.hasOwn(first.canonicalPayload, 'sourceFacts'), false);
});

test('B-04 archive 0/1/100 候选均固定十条 SQL，且不读取禁表', () => {
  const db = createMigratedDb();
  for (const expectedCandidates of [0, 1, 100]) {
    if (expectedCandidates === 1) {
      db.prepare(`
        INSERT INTO vcc_fin_op_datasets (
          target_month, dataset_type, data_status, generated_at, updated_at
        ) VALUES (?, ?, 'archived', '2026-08-01 00:00:00', '2026-08-01 00:00:00')
      `).run(monthAt(0), SOURCE_TYPES.RECHARGE);
    } else if (expectedCandidates === 100) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO vcc_fin_op_datasets (
          target_month, dataset_type, data_status, generated_at, updated_at
        ) VALUES (?, ?, 'archived', '2026-08-01 00:00:00', '2026-08-01 00:00:00')
      `);
      for (let index = 0; index < 100; index += 1) insert.run(monthAt(index), SOURCE_TYPES.RECHARGE);
    }
    const trace = [];
    const result = listArchiveMonthsSnapshot(db, { trace: (entry) => trace.push(entry) });
    assert.equal(result.months.length + result.diagnostics.length, expectedCandidates);
    assert.equal(trace.length, 10);
    const sql = trace.map((entry) => entry.sql).join('\n');
    assert.doesNotMatch(sql, /vcc_fin_op_import_rows|vcc_fin_op_opening_balances/i);
    if (expectedCandidates === 100) {
      const pendingSql = trace.find((entry) => entry.name === 'archive-pending-effective-facts').sql;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${pendingSql}`).all()
        .map((row) => String(row.detail)).join('\n');
      assert.match(
        plan,
        /SEARCH fact USING COVERING INDEX idx_vcc_fin_op_effective_month_source \(target_month=\? AND source_type=\?\)/i
      );
      assert.doesNotMatch(plan, /SCAN fact/i);
    }
  }
  db.close();
});

test('B-05 active months 保留 orphan/失败审计可见性，并使用既有 effective covering index', () => {
  const db = createMigratedDb();
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash,
      initialization_note, initialized_at
    ) VALUES ('2026-04', 'PPHK', '{}', 'opening-hash', '', '2026-08-01 00:00:00')
  `).run();
  repository.createImportBatch(db, {
    id: 'effective-batch', targetMonth: '2026-05', fileCount: 1
  });
  const effectiveRecordId = repository.createImportRecord(db, {
    batchId: 'effective-batch',
    targetMonth: '2026-05',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['x.xlsx']
  });
  repository.finishImportRecord(db, effectiveRecordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  repository.finishImportBatch(db, 'effective-batch', 'success');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, 'orphan', 'orphan', 'hash', '2026-05', 'PPHK', 'x.xlsx', 's', 1, '[]', ?)
  `).run(SOURCE_TYPES.RECHARGE, effectiveRecordId);
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at
    ) VALUES ('active-batch', '2026-06', 'importing', 1, '2026-08-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status, started_at
    ) VALUES ('active-batch', '2026-07', ?, '[]', 'failed_validation',
      '2026-08-01 00:00:00')
  `).run(SOURCE_TYPES.FEE_FX);
  const result = listActiveMonthsSnapshot(db, { taskGeneration: 8 });
  assert.deepEqual(result.months, ['2026-07', '2026-06', '2026-05', '2026-04']);
  assert.equal(result.taskGeneration, 8);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${ACTIVE_MONTHS_SQL}`).all()
    .map((row) => String(row.detail)).join('\n');
  assert.match(plan, /idx_vcc_fin_op_effective_month_source/i);
  db.close();
});

test('B-06 delete targets 单次九查询派生完整 preview，单目标刷新 token 完全相同', () => {
  const db = createMigratedDb();
  repository.createImportBatch(db, {
    id: 'delete-batch', targetMonth: '2026-06', fileCount: 1
  });
  const recordId = repository.createImportRecord(db, {
    batchId: 'delete-batch',
    targetMonth: '2026-06',
    sourceType: SOURCE_TYPES.RECHARGE,
    sourceFiles: ['x.xlsx']
  });
  repository.finishImportRecord(db, recordId, {
    status: 'success', rawCount: 1, insertedCount: 1
  });
  repository.finishImportBatch(db, 'delete-batch', 'success');
  db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, source_file, sheet_name, source_row, raw_json,
      import_record_id
    ) VALUES (?, 'delete', 'delete', 'hash', '2026-06', 'PPHK', 'x.xlsx', 's', 1, '[]', ?)
  `).run(SOURCE_TYPES.RECHARGE, recordId);
  const listTrace = [];
  const listed = listDeleteTargetsSnapshot(db, {
    targetMonth: '2026-06',
    taskGeneration: 11,
    trace: (entry) => listTrace.push(entry)
  });
  assert.equal(listTrace.length, 9);
  assert.equal(listed.targets.length, 5);
  const recharge = listed.targets.find((target) => target.targetType === SOURCE_TYPES.RECHARGE);
  assert.equal(recharge.dataCount, 1);
  assert.equal(recharge.deletable, true);
  assert.match(recharge.previewToken, /^v2:[0-9a-f]{64}$/);

  const refreshTrace = [];
  const refreshed = previewDeleteTargetSnapshot(db, {
    targetMonth: '2026-06',
    targetType: SOURCE_TYPES.RECHARGE,
    taskGeneration: 11,
    trace: (entry) => refreshTrace.push(entry)
  });
  assert.equal(refreshTrace.length, 9);
  assert.equal(refreshed.previewToken, recharge.previewToken);
  const effectivePlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT source_type, COUNT(*)
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ?
    GROUP BY source_type ORDER BY source_type
  `).all('2026-06').map((row) => String(row.detail)).join('\n');
  assert.match(effectivePlan, /COVERING INDEX idx_vcc_fin_op_effective_month_source/i);
  assert.doesNotMatch(effectivePlan, /USE TEMP B-TREE/i);
  db.close();
});
