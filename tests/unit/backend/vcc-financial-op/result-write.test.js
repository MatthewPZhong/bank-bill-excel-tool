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
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  VCC_MUTATION_OPERATIONS
} = require('../../../../src/backend/vcc-financial-op/mutation-policy');
const {
  loadResultMutationEvidence
} = require('../../../../src/backend/vcc-financial-op/read-snapshot');
const {
  executeResultMutationWithSafeAudit,
  isUnsafeAuditError
} = require('../../../../src/backend/vcc-financial-op/result-write');
const {
  LEGACY_FIXTURE_PATH,
  createCurrentRawEvidence
} = require('./_archive-evidence-fixture');

function createTempDb(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-write-test-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  if (legacy) fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dbPath;
}

function seedCurrentCalculated(dbPath) {
  const raw = createCurrentRawEvidence();
  const run = raw.runs[0];
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      id, target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, ?, 'calculated', ?, ?, ?, ?, ?, NULL)
  `).run(
    run.id,
    raw.targetMonth,
    JSON.stringify(run.inputRevisions),
    run.resultRevision,
    run.inputFingerprint,
    run.createdAt,
    run.updatedAt
  );
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'unprocessed', NULL, ?, ?, ?)
  `);
  for (const dataset of raw.datasets) {
    insertDataset.run(
      raw.targetMonth,
      dataset.datasetType,
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
      row.id,
      row.runId,
      row.subject,
      row.rowKind,
      row.sourceType,
      row.categoryMajor,
      row.categoryMinor,
      row.currency,
      row.amount
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
      id, run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence,
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
  db.close();
  return raw;
}

function preview(dbPath, runId, taskGeneration = 0) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON');
  try {
    db.exec('BEGIN DEFERRED');
    const evidence = loadResultMutationEvidence(db, { runId, taskGeneration });
    db.exec('COMMIT');
    return evidence;
  } finally {
    db.close();
  }
}

function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      adjustments: Number(db.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_run_adjustments').get().count),
      archives: Number(db.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_archives').get().count),
      successAudit: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit WHERE status = 'success'
      `).get().count),
      rollbackAudit: Number(db.prepare(`
        SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit WHERE status = 'rolled_back'
      `).get().count)
    };
  } finally {
    db.close();
  }
}

function adjustmentPayload(raw, evidence, overrides = {}) {
  return {
    runId: raw.runs[0].id,
    rowKey: raw.runAdjustments[0].rowKey,
    currency: 'USD',
    adjustmentAmount: '1',
    reason: 'C1 写保护测试',
    expectedResultRevision: raw.runs[0].resultRevision,
    expectedPreviewToken: evidence.previewTokens.adjustment,
    ...overrides
  };
}

function archivePayload(raw, evidence, overrides = {}) {
  return {
    runId: raw.runs[0].id,
    expectedResultRevision: raw.runs[0].resultRevision,
    expectedPreviewToken: evidence.previewTokens.archive,
    ...overrides
  };
}

function execute(dbPath, action, payload, options = {}) {
  return executeResultMutationWithSafeAudit({
    dbPath,
    action,
    payload,
    taskGeneration: 0,
    appVersion: '3.1.9',
    buildSha: 'c1-test',
    ...options
  });
}

test('adjustment locked plan 精确提交 2 个变化并保留 immutable success evidence', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const before = counts(dbPath);
  const result = execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    adjustmentPayload(raw, evidence)
  );
  const after = counts(dbPath);
  assert.equal(result.status, 'adjusted');
  assert.equal(result.resultRevision, 2);
  assert.equal(after.adjustments - before.adjustments, 1);
  assert.equal(after.archives, before.archives);
  assert.equal(after.successAudit, before.successAudit);
  assert.equal(after.rollbackAudit, before.rollbackAudit);
});

test('archive locked plan 精确提交 N+7，并保存 A 验证后的 effectiveCalculatedBalance', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const result = execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(raw, evidence)
  );
  assert.equal(result.status, 'archived');
  assert.deepEqual(result.subjects, ['PPHK']);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const archive = db.prepare(`
    SELECT balances_json FROM vcc_fin_op_archives
    WHERE target_month = ? AND subject = 'PPHK'
  `).get(raw.targetMonth);
  const balances = JSON.parse(archive.balances_json);
  assert.deepEqual(Object.keys(balances), SUPPORTED_CURRENCIES);
  assert.equal(balances.USD, '110');
  assert.equal(balances.EUR, '105');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_datasets
    WHERE target_month = ? AND data_status = 'archived' AND archived_run_id = ?
  `).get(raw.targetMonth, raw.runs[0].id).count, 5);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vcc_fin_op_operation_audit
    WHERE status = 'success' AND preview_token IS NULL
  `).get().count, 1);
  const auditEvidence = JSON.parse(db.prepare(`
    SELECT evidence_json FROM vcc_fin_op_operation_audit WHERE status = 'success'
  `).get().evidence_json);
  assert.equal(auditEvidence.expectedTotalChanges, 8);
  db.close();
});

test('成功写入按冻结契约公开五阶段 progress', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const phases = [];
  execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(raw, evidence),
    { onProgress: (progress) => phases.push(progress.phase) }
  );
  assert.deepEqual(phases, [
    'validating', 'preserving-audit', 'applying', 'verifying', 'committed'
  ]);
});

function prepareLegacyCalculated(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
  const run = db.prepare(`
    SELECT id, target_month, result_revision FROM vcc_fin_op_runs WHERE status = 'archived'
  `).get();
  db.prepare('DELETE FROM vcc_fin_op_archives WHERE target_month = ?').run(run.target_month);
  db.prepare(`
    UPDATE vcc_fin_op_runs
    SET status = 'calculated', archived_at = NULL, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(run.id);
  db.prepare(`
    UPDATE vcc_fin_op_datasets
    SET data_status = 'unprocessed', archived_run_id = NULL, updated_at = datetime('now', 'localtime')
    WHERE target_month = ?
  `).run(run.target_month);
  db.exec('COMMIT');
  db.close();
  return { runId: Number(run.id), resultRevision: Number(run.result_revision) };
}

test('legacy-four calculated 在 plan 前对 adjustment/archive 均返回 recalculation required 且零 DML', (t) => {
  for (const action of [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
  ]) {
    const dbPath = createTempDb(t, { legacy: true });
    const legacy = prepareLegacyCalculated(dbPath);
    const evidence = preview(dbPath, legacy.runId);
    const before = counts(dbPath);
    const payload = action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT
      ? {
        runId: legacy.runId,
        rowKey: evidence.archiveEvidence.runRows[0].rowKey,
        currency: 'USD',
        adjustmentAmount: '1',
        reason: 'legacy 不允许调整',
        expectedResultRevision: legacy.resultRevision,
        expectedPreviewToken: evidence.previewTokens.adjustment
      }
      : {
        runId: legacy.runId,
        expectedResultRevision: legacy.resultRevision,
        expectedPreviewToken: evidence.previewTokens.archive
      };
    assert.throws(() => execute(dbPath, action, payload), {
      code: 'result-recalculation-required'
    });
    assert.deepEqual(counts(dbPath), before);
  }
});

test('safe 业务失败只在原事务回滚后写 1 条受保护 rollback audit', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const before = counts(dbPath);
  assert.throws(() => execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(raw, evidence, { expectedResultRevision: 0 })
  ), { code: 'result-revision-changed' });
  const after = counts(dbPath);
  assert.equal(after.archives, before.archives);
  assert.equal(after.successAudit, before.successAudit);
  assert.equal(after.rollbackAudit - before.rollbackAudit, 1);
});

test('audit-only 失败不覆盖原业务错误，也不留下 fallback audit', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  let caught;
  try {
    execute(
      dbPath,
      VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
      archivePayload(raw, evidence, { expectedResultRevision: 0 }),
      {
        hooks: {
          audit: {
            beforeStep() {
              const error = new Error('audit-only injected failure');
              error.code = 'audit-only-injected';
              throw error;
            }
          }
        }
      }
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, 'result-revision-changed');
  assert.equal(caught.auditFailure.code, 'audit-only-injected');
  assert.equal(counts(dbPath).rollbackAudit, 0);
});

test('unsafe trigger policy 失败数据库零 failure audit', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TRIGGER unsafe_c1_trigger
    AFTER UPDATE ON vcc_fin_op_runs
    BEGIN
      UPDATE vcc_fin_op_module_state SET updated_at = updated_at WHERE singleton_id = 1;
    END
  `);
  db.close();
  assert.throws(() => execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(raw, evidence)
  ), { code: 'vcc-trigger-policy-violation' });
  assert.equal(counts(dbPath).rollbackAudit, 0);
  assert.equal(counts(dbPath).successAudit, 0);
});

test('node:sqlite ERR_SQLITE_ERROR 的不安全 primary errcode 均禁止 rollback audit', (t) => {
  for (const errcode of [10, 11, 13, 14, 26, 266]) {
    const nativeError = Object.assign(new Error(`native sqlite ${errcode}`), {
      code: 'ERR_SQLITE_ERROR',
      errcode
    });
    assert.equal(isUnsafeAuditError(nativeError), true, `errcode=${errcode}`);

    const dbPath = createTempDb(t);
    const raw = seedCurrentCalculated(dbPath);
    const evidence = preview(dbPath, raw.runs[0].id);
    const before = counts(dbPath);
    assert.throws(() => execute(
      dbPath,
      VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
      archivePayload(raw, evidence),
      {
        hooks: {
          business: {
            beforeStep() {
              throw nativeError;
            }
          }
        }
      }
    ), (error) => error === nativeError);
    assert.deepEqual(counts(dbPath), before, `errcode=${errcode} 不得留下业务或审计 DML`);
  }
  assert.equal(isUnsafeAuditError({
    code: 'wrapper',
    cause: { code: 'ERR_SQLITE_ERROR', errcode: 11 }
  }), true);
  assert.equal(isUnsafeAuditError({ code: 'ERR_SQLITE_ERROR', errcode: 19 }), false);
});

test('业务连接 createSession 不可信时返回 guard-unavailable 且数据库零 audit', (t) => {
  const dbPath = createTempDb(t);
  const raw = seedCurrentCalculated(dbPath);
  const evidence = preview(dbPath, raw.runs[0].id);
  const before = counts(dbPath);
  assert.throws(() => execute(
    dbPath,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(raw, evidence),
    {
      hooks: {
        business: {
          guardOptions: {
            createSession() {
              const error = new Error('createSession injected failure');
              error.code = 'SESSION_UNAVAILABLE';
              throw error;
            }
          }
        }
      }
    }
  ), { code: 'mutation-guard-unavailable' });
  assert.deepEqual(counts(dbPath), before);
});
