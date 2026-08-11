// VCC 财务OP校验破坏性状态链集成验证（真实文件 SQLite + 真实 worker）
//
// 覆盖：
//   1. M1 非尾月解归档阻断并返回 M2 依赖；
//   2. M2 解归档成功且 M1 保持归档，随后删除 M2 全部未归档结果；
//   3. M1 解归档后删除首月期初，first_month 永久事实与源数据/导入审计计数守恒；
//   4. preview token 过期时零业务删除并写 rolled_back 审计；
//   5. 删除来源原表前物化有效事实审计血缘，并通过真实 worker 透传版本与原因。
//
// 用法：node scripts/integration/vcc-financial-op-destructive-state-chain.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../src/backend/vcc-financial-op-db/migrations');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  PENDING_HEADERS
} = require('../../src/backend/vcc-financial-op/definitions');
const {
  REQUIRED_DATASET_TYPES
} = require('../../src/backend/vcc-financial-op/calculator');
const {
  buildRunRowKey
} = require('../../src/backend/vcc-financial-op/result-adjustments');
const {
  createVccFinancialOpService
} = require('../../src/main-process/vcc-financial-op-service');

const M1 = '2026-05';
const M2 = '2026-06';
const DETAIL_TYPES = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING
]);

let passed = 0;
let failed = 0;
const failures = [];
let lifecycleBatchSequence = 0;

function createBatchContext(taskKey) {
  lifecycleBatchSequence += 1;
  return Object.freeze({
    batchId: lifecycleBatchSequence,
    batchNumber: `integration-${lifecycleBatchSequence}`,
    taskRunId: `integration-task-${lifecycleBatchSequence}`,
    taskKey,
    moduleId: 'vcc-financial-op',
    parentRunId: `integration-parent-${lifecycleBatchSequence}`,
    operationKey: `${taskKey}:integration-${lifecycleBatchSequence}`
  });
}

function printable(value) {
  try { return JSON.stringify(value); } catch (_error) { return String(value); }
}

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(
    Object.is(actual, expected),
    label,
    `expected=${printable(expected)} actual=${printable(actual)}`
  );
}

function assertDeepEq(actual, expected, label) {
  const actualJson = printable(actual);
  const expectedJson = printable(expected);
  assertTrue(actualJson === expectedJson, label, `expected=${expectedJson} actual=${actualJson}`);
}

async function expectCode(action, expectedCode, label) {
  try {
    await action();
    assertTrue(false, label, `expected error code ${expectedCode}`);
    return null;
  } catch (error) {
    assertEq(error && error.code, expectedCode, label);
    return error;
  }
}

function balances(base = '100', usd = base) {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [
    currency,
    currency === 'USD' ? usd : base
  ]));
}

function seedSourceFacts(db, targetMonth) {
  const batchId = `integration-${targetMonth}`;
  db.prepare(`
    INSERT INTO vcc_fin_op_import_batches (
      id, target_month, status, file_count, started_at, finished_at
    ) VALUES (?, ?, 'success', 5, '2026-08-01 08:00:00', '2026-08-01 08:05:00')
  `).run(batchId, targetMonth);

  const insertRecord = db.prepare(`
    INSERT INTO vcc_fin_op_import_records (
      batch_id, target_month, source_type, source_files_json, status,
      raw_count, inserted_count, started_at, finished_at
    ) VALUES (?, ?, ?, ?, 'success', 1, 1,
              '2026-08-01 08:00:00', '2026-08-01 08:05:00')
  `);
  const insertEffective = db.prepare(`
    INSERT INTO vcc_fin_op_effective_rows (
      source_type, idempotency_key_raw, idempotency_key, content_hash,
      target_month, subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, ?, ?, ?, ?, 'PPHK', 'USD', '10', ?, 'Sheet1', 2, ?, ?)
  `);
  const insertImportRow = db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, disposition
    ) VALUES (?, ?, ?, ?, ?, ?, 'PPHK', 'USD', '10', ?, 'Sheet1', 2, ?, 'accepted')
  `);
  const insertDuplicateAuditRow = db.prepare(`
    INSERT INTO vcc_fin_op_import_rows (
      import_record_id, source_type, target_month,
      idempotency_key_raw, idempotency_key, content_hash,
      subject, stat_currency, signed_amount,
      source_file, sheet_name, source_row, raw_json, disposition,
      existing_effective_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'PPHK', 'USD', '10', ?, 'Sheet1', 3, ?,
              'idempotent_skip', ?)
  `);

  for (const sourceType of DETAIL_TYPES) {
    const fileName = `${targetMonth}-${sourceType}.xlsx`;
    const key = `${targetMonth}-${sourceType}-1`;
    const rawJson = sourceType === SOURCE_TYPES.PENDING
      ? JSON.stringify(PENDING_HEADERS.map(() => ''))
      : '[]';
    const recordId = Number(insertRecord.run(
      batchId,
      targetMonth,
      sourceType,
      JSON.stringify([fileName])
    ).lastInsertRowid);
    const effectiveId = Number(insertEffective.run(
      sourceType,
      key,
      key,
      `hash-${key}`,
      targetMonth,
      fileName,
      rawJson,
      recordId
    ).lastInsertRowid);
    insertImportRow.run(
      recordId,
      sourceType,
      targetMonth,
      key,
      key,
      `hash-${key}`,
      fileName,
      rawJson
    );
    insertDuplicateAuditRow.run(
      recordId,
      sourceType,
      targetMonth,
      key,
      key,
      `hash-${key}`,
      `duplicate-${fileName}`,
      rawJson,
      effectiveId
    );
  }

  const systemFile = `${targetMonth}-system-op.xlsx`;
  const systemRecordId = Number(insertRecord.run(
    batchId,
    targetMonth,
    SOURCE_TYPES.SYSTEM_OP,
    JSON.stringify([systemFile])
  ).lastInsertRowid);
  const systemBalances = JSON.stringify(balances('110'));
  const snapshotId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshots (
      target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, import_record_id
    ) VALUES (?, 'PPHK', ?, ?, ?, 'Validate', 3, '{}', ?)
  `).run(
    targetMonth,
    systemBalances,
    `system-hash-${targetMonth}`,
    systemFile,
    systemRecordId
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_system_snapshot_attempts (
      import_record_id, target_month, subject, balances_json, content_hash,
      source_file, sheet_name, source_row, raw_json, disposition, existing_snapshot_id
    ) VALUES (?, ?, 'PPHK', ?, ?, ?, 'Validate', 3, '{}', 'accepted', ?)
  `).run(
    systemRecordId,
    targetMonth,
    systemBalances,
    `system-hash-${targetMonth}`,
    systemFile,
    snapshotId
  );
}

function seedDatasets(db, targetMonth, status, runId = null) {
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-01 08:05:00', '2026-08-01 09:00:00')
  `);
  REQUIRED_DATASET_TYPES.forEach((sourceType, index) => {
    insert.run(targetMonth, sourceType, status, runId, index + 1);
  });
}

function seedRun(db, targetMonth, status = 'calculated', { adjustmentAmount = null } = {}) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-01 08:30:00',
              '2026-08-01 09:00:00', ?)
  `).run(
    targetMonth,
    status,
    JSON.stringify(Object.fromEntries(
      REQUIRED_DATASET_TYPES.map((sourceType, index) => [sourceType, index + 1])
    )),
    adjustmentAmount === null ? 0 : 1,
    'a'.repeat(64),
    status === 'archived' ? '2026-08-01 09:30:00' : null
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, 'PPHK', 'movement', ?, '充值', '集成测试', 'USD', '10')
  `).run(runId, SOURCE_TYPES.RECHARGE);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, '100', ?, ?, ?, '0')
  `);
  const archivedBalances = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    insertBalance.run(runId, currency, periodAmount, calculatedBalance, calculatedBalance);
    archivedBalances[currency] = calculatedBalance;
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
  if (adjustmentAmount !== null) {
    db.prepare(`
      INSERT INTO vcc_fin_op_run_adjustments (
        run_id, row_key, subject, source_type, category_major, category_minor,
        currency, adjustment_amount, reason, sequence,
        created_app_version, created_build_sha
      ) VALUES (?, ?, 'PPHK', ?, '充值', '集成测试', 'USD', ?, '人工纠错调整', 1,
                '3.1.8', 'integration-fixture-sha')
    `).run(
      runId,
      buildRunRowKey({
        rowKind: 'movement',
        subject: 'PPHK',
        sourceType: SOURCE_TYPES.RECHARGE,
        categoryMajor: '充值',
        categoryMinor: '集成测试'
      }),
      SOURCE_TYPES.RECHARGE,
      adjustmentAmount
    );
  }
  if (status === 'archived') {
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (
        target_month, subject, balances_json, run_id, archived_at
      ) VALUES (?, 'PPHK', ?, ?, '2026-08-01 09:30:00')
    `).run(targetMonth, JSON.stringify(archivedBalances), runId);
  }
  return runId;
}

function seedOpening(db, targetMonth) {
  db.prepare(`
    UPDATE vcc_fin_op_module_state
    SET first_month = ?, updated_at = '2026-08-01 08:10:00'
    WHERE singleton_id = 1
  `).run(targetMonth);
  db.prepare(`
    INSERT INTO vcc_fin_op_opening_balances (
      target_month, subject, balances_json, content_hash,
      initialization_note, initialized_at
    ) VALUES (?, 'PPHK', ?, ?, '集成测试逐币种核对', '2026-08-01 08:15:00')
  `).run(targetMonth, JSON.stringify(balances('100')), `opening-${targetMonth}`);
}

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params).row_count) || 0;
}

function sourceFactCounts(db, targetMonth) {
  return {
    effectiveRows: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_effective_rows WHERE target_month = ?
    `, targetMonth),
    systemSnapshots: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshots WHERE target_month = ?
    `, targetMonth),
    importBatches: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_batches WHERE target_month = ?
    `, targetMonth),
    importRecords: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_records WHERE target_month = ?
    `, targetMonth),
    importRows: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_import_rows WHERE target_month = ?
    `, targetMonth),
    systemAttempts: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshot_attempts WHERE target_month = ?
    `, targetMonth),
    datasets: count(db, `
      SELECT COUNT(*) AS row_count FROM vcc_fin_op_datasets WHERE target_month = ?
    `, targetMonth),
    datasetRevisions: db.prepare(`
      SELECT dataset_type, revision
      FROM vcc_fin_op_datasets WHERE target_month = ? ORDER BY dataset_type
    `).all(targetMonth).map((row) => [row.dataset_type, Number(row.revision)])
  };
}

function operationAudits(db, targetMonth, operationType) {
  return db.prepare(`
    SELECT status, evidence_json, error_message, app_version, build_sha
    FROM vcc_fin_op_operation_audit
    WHERE target_month = ? AND operation_type = ?
    ORDER BY id
  `).all(targetMonth, operationType);
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-destructive-chain-'));
  const dbPath = path.join(tempDir, 'tool-data.sqlite');
  let db = null;
  let service = null;
  console.log('==== VCC 财务OP破坏性状态链集成验证 ====');
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 30000;
    `);
    ensureVccFinancialOpTablesSupport(db);

    seedSourceFacts(db, M1);
    seedSourceFacts(db, M2);
    seedOpening(db, M1);
    const m1RunId = seedRun(db, M1, 'archived');
    const m2RunId = seedRun(db, M2, 'archived');
    seedDatasets(db, M1, 'archived', m1RunId);
    seedDatasets(db, M2, 'archived', m2RunId);
    // 直接 SQL fixture 在 Service 建立前完成 schema 准备；
    // C2 dedicated write worker 不执行 migration。
    ensureVccFinancialOpTablesSupport(db);
    const m1SourceBefore = sourceFactCounts(db, M1);
    const m2SourceBefore = sourceFactCounts(db, M2);

    service = createVccFinancialOpService({
      database: { db, dbPath },
      assetsDir: '',
      appVersion: '3.1.9',
      buildSha: 'integration-fixture-sha'
    });

    const archivedMonths = await service.listArchivedResultMonths();
    assertDeepEq(
      archivedMonths.map((row) => row.targetMonth),
      [M2, M1],
      '归档枚举仅返回一致月份并按最新优先'
    );

    const m1Blocked = await service.previewUnarchive({ targetMonth: M1 });
    assertEq(m1Blocked.code, 'unarchive-not-tail', 'M1 preview 因 M2 依赖阻断');
    assertDeepEq(m1Blocked.dependentMonths, [M2], 'M1 preview 明确返回依赖月份 M2');
    const m1BlockedError = await expectCode(
      () => service.unarchiveMonth({
        targetMonth: M1,
        expectedPreviewToken: m1Blocked.previewToken,
        taskGeneration: m1Blocked.taskGeneration
      }, undefined, createBatchContext('vccFinancialOp:run:unarchive')),
      'unarchive-not-tail',
      'M1 worker 二次门禁继续阻断非尾月'
    );
    assertDeepEq(m1BlockedError && m1BlockedError.dependentMonths, [M2], 'worker 错误保留依赖月份');
    assertEq(
      db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(m1RunId).status,
      'archived',
      'M1 阻断后 run 保持 archived'
    );
    assertEq(
      operationAudits(db, M1, 'unarchive').filter((row) => row.status === 'rolled_back').length,
      1,
      'M1 非尾阻断写入 rolled_back 审计'
    );

    const m2Preview = await service.previewUnarchive({ targetMonth: M2 });
    assertEq(m2Preview.canUnarchive, true, 'M2 是尾月可解归档');
    const m2Unarchived = await service.unarchiveMonth({
      targetMonth: M2,
      expectedPreviewToken: m2Preview.previewToken,
      taskGeneration: m2Preview.taskGeneration
    }, undefined, createBatchContext('vccFinancialOp:run:unarchive'));
    assertEq(m2Unarchived.status, 'unarchived', 'M2 真实 worker 解归档成功');
    assertEq(
      db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(m2RunId).status,
      'calculated',
      'M2 run 恢复 calculated'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_archives WHERE target_month = ?`, M2),
      0,
      'M2 归档快照全部删除'
    );
    assertEq(
      count(db, `
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_datasets
        WHERE target_month = ? AND data_status = 'unprocessed' AND archived_run_id IS NULL
      `, M2),
      5,
      'M2 五类数据集全部恢复未处理'
    );
    assertEq(
      db.prepare('SELECT status FROM vcc_fin_op_runs WHERE id = ?').get(m1RunId).status,
      'archived',
      '解归档 M2 时 M1 仍保持 archived'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_archives WHERE target_month = ?`, M1),
      1,
      '解归档 M2 时 M1 归档快照保持完整'
    );

    const m2DeletePreview = await service.previewDataTargetDeletion({
      targetMonth: M2,
      targetType: 'result'
    });
    assertEq(m2DeletePreview.calculatedRunCount, 1, 'M2 删除预览包含一份未归档结果');
    const m2Deleted = await service.deleteDataTarget({
      targetMonth: M2,
      targetType: 'result',
      expectedPreviewToken: m2DeletePreview.previewToken,
      taskGeneration: m2DeletePreview.taskGeneration,
      reason: '集成链删除 M2 未归档结果'
    }, undefined, createBatchContext('vccFinancialOp:data-manager:delete'));
    assertEq(m2Deleted.deletedRunCount, 1, 'M2 删除全部未归档结果');
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs WHERE target_month = ?`, M2),
      0,
      'M2 run 已清空'
    );
    assertEq(
      count(db, `
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_rows WHERE run_id = ?
      `, m2RunId),
      0,
      'M2 run 子行同步删除'
    );
    assertDeepEq(sourceFactCounts(db, M2), m2SourceBefore, 'M2 结果删除前后源事实和数据集计数守恒');

    const m1Preview = await service.previewUnarchive({ targetMonth: M1 });
    assertEq(m1Preview.canUnarchive, true, '删除 M2 结果后 M1 成为尾月');
    const m1Unarchived = await service.unarchiveMonth({
      targetMonth: M1,
      expectedPreviewToken: m1Preview.previewToken,
      taskGeneration: m1Preview.taskGeneration
    }, undefined, createBatchContext('vccFinancialOp:run:unarchive'));
    assertEq(m1Unarchived.status, 'unarchived', 'M1 解归档成功');
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_archives WHERE target_month = ?`, M1),
      0,
      'M1 归档快照全部删除'
    );

    const openingPreview = await service.previewDataTargetDeletion({
      targetMonth: M1,
      targetType: 'opening_initialization'
    });
    assertEq(openingPreview.deletable, true, '解归档后 M1 期初允许删除');
    assertEq(openingPreview.calculatedRunCount, 1, 'M1 期初删除预览包含关联结果');
    const openingDeleted = await service.deleteDataTarget({
      targetMonth: M1,
      targetType: 'opening_initialization',
      expectedPreviewToken: openingPreview.previewToken,
      taskGeneration: openingPreview.taskGeneration,
      reason: '集成链删除 M1 首月期初'
    }, undefined, createBatchContext('vccFinancialOp:data-manager:delete'));
    assertEq(openingDeleted.deletedOpeningCount, 1, 'M1 全部主体期初整体删除');
    assertEq(openingDeleted.deletedRunCount, 1, 'M1 未归档结果随期初删除');
    assertEq(
      db.prepare(`
        SELECT first_month FROM vcc_fin_op_module_state WHERE singleton_id = 1
      `).get().first_month,
      M1,
      '删除期初后 first_month 永久事实保持 M1'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_opening_balances WHERE target_month = ?`, M1),
      0,
      'M1 期初事实已清空'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs WHERE target_month = ?`, M1),
      0,
      'M1 结果已清空'
    );
    assertDeepEq(sourceFactCounts(db, M1), m1SourceBefore, 'M1 删除期初前后源事实和数据集计数守恒');

    const m1UnarchiveAudits = operationAudits(db, M1, 'unarchive');
    assertDeepEq(
      m1UnarchiveAudits.map((row) => row.status),
      ['rolled_back', 'success'],
      'M1 解归档审计完整记录阻断与成功'
    );
    const m1OpeningAudits = operationAudits(db, M1, 'delete_opening_initialization');
    assertEq(m1OpeningAudits.length, 1, 'M1 期初删除仅留一条成功审计');
    assertEq(m1OpeningAudits[0].status, 'success', 'M1 期初删除审计状态 success');
    assertEq(m1OpeningAudits[0].app_version, '3.1.9', '成功审计记录应用版本');
    assertEq(m1OpeningAudits[0].build_sha, 'integration-fixture-sha', '成功审计记录 build SHA');
    const openingEvidence = JSON.parse(m1OpeningAudits[0].evidence_json);
    assertEq(openingEvidence.symbols.O, 1, '期初删除审计锁定 O=1');
    assertEq(openingEvidence.symbols.R, 1, '期初删除审计锁定 R=1');
    assertEq(openingEvidence.expectedTotalChanges, 15, '期初删除审计锁定 1+R+ΣC+O 预算');

    const staleMonth = '2026-07';
    const staleRunId = seedRun(db, staleMonth, 'calculated');
    seedDatasets(db, staleMonth, 'unprocessed');
    const stalePreview = await service.previewDataTargetDeletion({
      targetMonth: staleMonth,
      targetType: 'result'
    });
    db.prepare(`
      UPDATE vcc_fin_op_runs SET updated_at = '2026-08-02 00:00:00' WHERE id = ?
    `).run(staleRunId);
    const staleError = await expectCode(
      () => service.deleteDataTarget({
        targetMonth: staleMonth,
        targetType: 'result',
        expectedPreviewToken: stalePreview.previewToken,
        taskGeneration: stalePreview.taskGeneration
      }, undefined, createBatchContext('vccFinancialOp:data-manager:delete')),
      'state-changed',
      'token 变化后 worker 二次门禁拒绝结果删除'
    );
    assertTrue(
      Boolean(staleError && staleError.context && staleError.context.expectedPreviewToken),
      'stale 错误跨 worker 保留 token context'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs WHERE id = ?`, staleRunId),
      1,
      'stale token 拒绝后 run 零删除'
    );
    const staleAudits = operationAudits(db, staleMonth, 'delete_unarchived_result');
    assertEq(staleAudits.length, 1, 'stale token 写一条失败审计');
    assertEq(staleAudits[0].status, 'rolled_back', 'stale token 审计状态 rolled_back');
    assertEq(JSON.parse(staleAudits[0].evidence_json).failure.code, 'state-changed', 'stale 审计记录结构化失败码');

    const sourceDeleteMonth = '2026-09';
    seedSourceFacts(db, sourceDeleteMonth);
    seedDatasets(db, sourceDeleteMonth, 'unprocessed');
    const sourceRunId = seedRun(db, sourceDeleteMonth, 'calculated', {
      adjustmentAmount: '12.34'
    });
    db.prepare(`
      DELETE FROM vcc_fin_op_system_snapshot_attempts
      WHERE target_month = ? AND disposition = 'accepted'
    `).run(sourceDeleteMonth);
    const sourcePreview = await service.previewDataTargetDeletion({
      targetMonth: sourceDeleteMonth,
      targetType: SOURCE_TYPES.RECHARGE
    });
    assertEq(sourcePreview.deletable, true, '来源原表删除预览可执行');
    const sourceDeleted = await service.deleteDataTarget({
      targetMonth: sourceDeleteMonth,
      targetType: SOURCE_TYPES.RECHARGE,
      expectedPreviewToken: sourcePreview.previewToken,
      taskGeneration: sourcePreview.taskGeneration,
      reason: '集成链纠正来源数据'
    }, undefined, createBatchContext('vccFinancialOp:data-manager:delete'));
    assertEq(sourceDeleted.invalidatedRunCount, 1, '来源删除同步作废 calculated run');
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_runs WHERE id = ?`, sourceRunId),
      0,
      '来源删除后 run 已清空'
    );
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_run_adjustments WHERE run_id = ?`, sourceRunId),
      0,
      '来源删除后调整账本已清空'
    );
    assertEq(
      count(db, `
        SELECT COUNT(*) AS row_count FROM vcc_fin_op_effective_rows
        WHERE target_month = ? AND source_type = ?
      `, sourceDeleteMonth, SOURCE_TYPES.RECHARGE),
      0,
      '来源删除后目标原表已清空'
    );
    const sourceAudits = operationAudits(db, sourceDeleteMonth, 'delete-source-dataset');
    assertDeepEq(sourceAudits.map((row) => row.status), ['success'], '来源删除只保留 success 审计');
    assertEq(sourceAudits[0].app_version, '3.1.9', '来源删除审计记录应用版本');
    assertEq(sourceAudits[0].build_sha, 'integration-fixture-sha', '来源删除审计记录 build SHA');
    const sourceEvidence = JSON.parse(sourceAudits[0].evidence_json);
    assertEq(sourceEvidence.reason, '集成链纠正来源数据', '来源删除审计保留用户原因');
    assertEq(sourceEvidence.symbols.Q, 1, '来源删除审计锁定一条待物化血缘');
    assertEq(sourceEvidence.symbols.E, 1, '来源删除审计锁定一条有效事实');
    assertEq(sourceEvidence.symbols.M, 1, '来源删除审计锁定一条成功导入记录');
    const materializedAudit = db.prepare(`
      SELECT existing_effective_id, existing_raw_json_snapshot,
             existing_subject_snapshot, existing_source_file_snapshot,
             existing_import_record_id_snapshot
      FROM vcc_fin_op_import_rows
      WHERE target_month = ? AND source_type = ? AND disposition = 'idempotent_skip'
    `).get(sourceDeleteMonth, SOURCE_TYPES.RECHARGE);
    assertEq(materializedAudit.existing_effective_id, null, '物化后有效事实 FK 已清除');
    assertEq(materializedAudit.existing_raw_json_snapshot, '[]', '物化后保留原始事实');
    assertEq(materializedAudit.existing_subject_snapshot, 'PPHK', '物化后保留主体');
    assertEq(materializedAudit.existing_source_file_snapshot, `${sourceDeleteMonth}-${SOURCE_TYPES.RECHARGE}.xlsx`, '物化后保留来源文件');
    assertTrue(Number.isSafeInteger(Number(materializedAudit.existing_import_record_id_snapshot)), '物化后保留导入记录血缘');

    const systemPreview = await service.previewDataTargetDeletion({
      targetMonth: sourceDeleteMonth,
      targetType: SOURCE_TYPES.SYSTEM_OP
    });
    assertEq(systemPreview.deletable, true, '系统原表删除 production preview 可执行');
    const systemDeleted = await service.deleteDataTarget({
      targetMonth: sourceDeleteMonth,
      targetType: SOURCE_TYPES.SYSTEM_OP,
      expectedPreviewToken: systemPreview.previewToken,
      taskGeneration: systemPreview.taskGeneration,
      reason: '集成链纠正系统原表'
    }, undefined, createBatchContext('vccFinancialOp:data-manager:delete'));
    assertEq(systemDeleted.deletedDataCount, 1, '系统原表通过 dedicated worker 删除一条 snapshot');
    const acceptedAttempts = db.prepare(`
      SELECT disposition, existing_snapshot_id,
             existing_balances_json_snapshot, existing_raw_json_snapshot,
             existing_source_file_snapshot, existing_sheet_name_snapshot,
             existing_source_row_snapshot, existing_import_record_id_snapshot
      FROM vcc_fin_op_system_snapshot_attempts
      WHERE target_month = ? AND disposition = 'accepted'
      ORDER BY id
    `).all(sourceDeleteMonth);
    assertEq(acceptedAttempts.length, 1, '缺失 accepted 时精确补录 B=1 且最终唯一');
    assertEq(acceptedAttempts[0].existing_snapshot_id, null, '系统审计物化后清除 snapshot FK');
    assertEq(acceptedAttempts[0].existing_balances_json_snapshot, JSON.stringify(balances('110')), '系统审计物化九币种余额');
    assertEq(acceptedAttempts[0].existing_raw_json_snapshot, '{}', '系统审计物化原始事实');
    assertEq(acceptedAttempts[0].existing_source_file_snapshot, `${sourceDeleteMonth}-system-op.xlsx`, '系统审计物化来源文件');
    assertEq(acceptedAttempts[0].existing_sheet_name_snapshot, 'Validate', '系统审计物化 sheet');
    assertEq(acceptedAttempts[0].existing_source_row_snapshot, 3, '系统审计物化来源行');
    assertTrue(Number.isSafeInteger(Number(acceptedAttempts[0].existing_import_record_id_snapshot)), '系统审计物化导入记录血缘');
    assertEq(
      count(db, `SELECT COUNT(*) AS row_count FROM vcc_fin_op_system_snapshots WHERE target_month = ?`, sourceDeleteMonth),
      0,
      '系统 snapshot 物化后精确删除'
    );
    const systemAudits = operationAudits(db, sourceDeleteMonth, 'delete-source-dataset');
    const systemEvidence = JSON.parse(systemAudits[systemAudits.length - 1].evidence_json);
    assertEq(systemEvidence.targetType, SOURCE_TYPES.SYSTEM_OP, '最后一条 source audit 对应系统原表');
    assertEq(systemEvidence.symbols.B, 1, '系统原表审计锁定 B=1');
    assertEq(systemEvidence.symbols.A, 1, '系统原表审计锁定 A=1');
    assertEq(systemEvidence.symbols.S, 1, '系统原表审计锁定 S=1');
    assertEq(systemEvidence.symbols.M, 1, '系统原表审计锁定 M=1');
  } finally {
    if (service) {
      try { await service.terminate(); } catch (_error) { /* cleanup */ }
    }
    if (db) {
      try { db.close(); } catch (_error) { /* cleanup */ }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((failure) => {
      console.error(`  - ${failure.label}${failure.detail ? `: ${failure.detail}` : ''}`);
    });
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
