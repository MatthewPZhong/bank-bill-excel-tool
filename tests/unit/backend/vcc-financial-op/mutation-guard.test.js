'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_MUTATION_OPERATIONS,
  LARGE_TABLE_SCOPE_PROOF_TABLES,
  VCC_TABLE_POLICY_REGISTRY,
  MUTATION_SQL_STEP_REGISTRY
} = require('../../../../src/backend/vcc-financial-op/mutation-policy');
const {
  runRuntimeCapabilityProbe,
  assertVccMutationSchema,
  assertVccTriggerPolicy,
  assertPlanRegistered,
  beginMutationGuard,
  executeRegisteredMutationSteps,
  assertMutationGuardPostwrite,
  closeMutationGuard
} = require('../../../../src/backend/vcc-financial-op/mutation-guard');

function createDb(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => db.close());
  return db;
}

function adjustmentPlan() {
  return {
    operation: VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    targetMonth: '2026-06',
    runId: 1,
    expectedTotalChanges: 2,
    steps: [{
      stepId: 'adjustment.insert',
      expectedChanges: 1,
      bindings: [
        1,
        `v1:${'a'.repeat(64)}`,
        'PPHK',
        'recharge_refund',
        '充值退款',
        '',
        'USD',
        '1',
        '测试调整',
        1,
        '2026-08-11 12:00:00',
        '3.1.9',
        'build'
      ]
    }, {
      stepId: 'adjustment.bump-run',
      expectedChanges: 1,
      bindings: ['2026-08-11 12:00:00', 1, 0]
    }]
  };
}

function seedRun(db) {
  db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      id, target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (1, '2026-06', 'calculated', '{}', 0, ?,
              '2026-08-11 11:00:00', '2026-08-11 11:00:00', NULL)
  `).run('b'.repeat(64));
}

test('mutation runtime probe 验证 session、trigger、total_changes 与关闭合同', () => {
  const evidence = runRuntimeCapabilityProbe();
  assert.equal(evidence.emptyChangesetBytes, 0);
  assert.ok(evidence.rollbackChangesetBytes > 0);
  assert.ok(evidence.commitChangesetBytes > 0);
  assert.equal(evidence.triggerTotalChangesDelta, 2);
});

test('table policy 与 migrated schema exact-match，四张大表不创建 session', (t) => {
  const db = createDb(t);
  assert.equal(Object.keys(VCC_TABLE_POLICY_REGISTRY).length, 19);
  assert.deepEqual(
    Object.entries(VCC_TABLE_POLICY_REGISTRY)
      .filter(([, policy]) => policy.protection === 'large-table-scope-proof')
      .map(([tableName]) => tableName)
      .sort(),
    [...LARGE_TABLE_SCOPE_PROOF_TABLES].sort()
  );
  assert.deepEqual(assertVccMutationSchema(db), { ready: true, tableCount: 19 });

  const sessionTables = [];
  db.exec('BEGIN IMMEDIATE');
  const guard = beginMutationGuard(db, adjustmentPlan(), {
    createSession(tableName) {
      sessionTables.push(tableName);
      return db.createSession({ table: tableName });
    }
  });
  db.exec('ROLLBACK');
  closeMutationGuard(guard);
  assert.equal(sessionTables.length, 13);
  for (const tableName of LARGE_TABLE_SCOPE_PROOF_TABLES) {
    assert.equal(sessionTables.includes(tableName), false);
  }
});

test('未知 VCC 表与 trigger 均在业务写入前失败关闭', (t) => {
  const cases = [{
    code: 'vcc-schema-not-ready',
    mutate(db) {
      db.exec('CREATE TABLE vcc_fin_op_unknown (id INTEGER PRIMARY KEY)');
    },
    assertFailure: assertVccMutationSchema
  }, {
    code: 'vcc-trigger-policy-violation',
    mutate(db) {
      db.exec(`
        CREATE TRIGGER unexpected_vcc_trigger
        AFTER UPDATE ON vcc_fin_op_runs
        BEGIN
          UPDATE vcc_fin_op_module_state SET updated_at = updated_at WHERE singleton_id = 1;
        END
      `);
    },
    assertFailure: assertVccTriggerPolicy
  }];
  for (const item of cases) {
    const db = createDb(t);
    item.mutate(db);
    assert.throws(() => item.assertFailure(db), { code: item.code });
  }
});

test('registry 保持 C1 adjustment 预算为 2 且 C1 operation 零大表 step', (t) => {
  const db = createDb(t);
  seedRun(db);
  const plan = adjustmentPlan();
  assert.doesNotThrow(() => assertPlanRegistered(plan));
  assert.deepEqual(
    new Set(Object.values(MUTATION_SQL_STEP_REGISTRY).map((step) => step.tableName)),
    new Set([
      'vcc_fin_op_archives',
      'vcc_fin_op_dataset_deletions',
      'vcc_fin_op_datasets',
      'vcc_fin_op_effective_rows',
      'vcc_fin_op_import_records',
      'vcc_fin_op_import_rows',
      'vcc_fin_op_opening_balances',
      'vcc_fin_op_operation_audit',
      'vcc_fin_op_pending_currency_totals',
      'vcc_fin_op_pending_summary_rows',
      'vcc_fin_op_run_adjustments',
      'vcc_fin_op_run_balances',
      'vcc_fin_op_run_rows',
      'vcc_fin_op_runs',
      'vcc_fin_op_system_snapshot_attempts',
      'vcc_fin_op_system_snapshots'
    ])
  );
  for (const operation of [
    VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
  ]) {
    assert.equal(Object.values(MUTATION_SQL_STEP_REGISTRY).some((entry) => (
      LARGE_TABLE_SCOPE_PROOF_TABLES.includes(entry.tableName)
      && VCC_TABLE_POLICY_REGISTRY[entry.tableName].operations[operation] === 'allowed'
    )), false);
  }

  db.exec('BEGIN IMMEDIATE');
  const guard = beginMutationGuard(db, plan);
  executeRegisteredMutationSteps(db, guard);
  assert.deepEqual(assertMutationGuardPostwrite(db, guard), { actualTotalChanges: 2 });
  db.exec('COMMIT');
  assert.deepEqual(closeMutationGuard(guard), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_run_adjustments').get().count, 1);
  assert.equal(db.prepare('SELECT result_revision FROM vcc_fin_op_runs WHERE id = 1').get().result_revision, 1);
});

test('未登记 step、大表 fixed scope 不匹配与额外 protected 写入分别失败关闭', (t) => {
  const db = createDb(t);
  seedRun(db);
  assert.throws(() => assertPlanRegistered({
    ...adjustmentPlan(),
    steps: [{ stepId: 'unknown.step', bindings: [], expectedChanges: 0 }],
    expectedTotalChanges: 0
  }), { code: 'unregistered-mutation-step' });

  const largePlan = {
    operation: VCC_MUTATION_OPERATIONS.DELETE_DATA_TARGET,
    targetMonth: '2026-06',
    runId: null,
    steps: [{
      stepId: 'delete.detail-effective',
      bindings: ['2026-06', 'recharge_refund'],
      expectedChanges: 0
    }],
    expectedTotalChanges: 0
  };
  assert.throws(() => assertPlanRegistered(largePlan), {
    code: 'mutation-table-policy-violation'
  });
  assert.doesNotThrow(() => assertPlanRegistered({
    ...largePlan,
    steps: [{
      ...largePlan.steps[0],
      largeTableScopeProof: { scopeId: 'detail-month-source', preCount: 0 }
    }]
  }));

  db.exec('BEGIN IMMEDIATE');
  const guard = beginMutationGuard(db, adjustmentPlan());
  executeRegisteredMutationSteps(db, guard, {
    afterStep({ index }) {
      if (index === 0) {
        db.prepare(`
          UPDATE vcc_fin_op_module_state
          SET updated_at = '2026-08-11 12:00:00'
          WHERE singleton_id = 1
        `).run();
      }
    }
  });
  assert.throws(() => assertMutationGuardPostwrite(db, guard), {
    code: 'mutation-budget-mismatch'
  });
  db.exec('ROLLBACK');
  closeMutationGuard(guard);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vcc_fin_op_run_adjustments').get().count, 0);
  assert.equal(db.prepare('SELECT result_revision FROM vcc_fin_op_runs WHERE id = 1').get().result_revision, 0);
});

test('每个 registered SQL step 的 .changes mismatch 均立即回滚', (t) => {
  const datasetTypes = [
    'recharge_refund',
    'fee_fx',
    'channel',
    'pending_archive_removal',
    'system_op'
  ];
  const cases = [{
    operation: VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    stepId: 'adjustment.insert',
    bindings: adjustmentPlan().steps[0].bindings
  }, {
    operation: VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
    stepId: 'adjustment.bump-run',
    bindings: ['2026-08-11 12:00:00', 1, 0]
  }, {
    operation: VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    stepId: 'archive.audit-success',
    bindings: ['2026-06', 'archive_result', 1, '{}', '3.1.9', 'build', '2026-08-11 12:00:00']
  }, {
    operation: VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    stepId: 'archive.insert-subjects',
    bindings: ['2026-06', 'PPHK', '{}', 1, '2026-08-11 12:00:00']
  }, {
    operation: VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    stepId: 'archive.mark-run',
    bindings: ['2026-08-11 12:00:00', '2026-08-11 12:00:00', 1, 0]
  }, {
    operation: VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    stepId: 'archive.mark-datasets',
    bindings: [1, '2026-08-11 12:00:00', '2026-06', ...datasetTypes]
  }, {
    operation: VCC_MUTATION_OPERATIONS.ROLLBACK_AUDIT,
    stepId: 'audit.rollback',
    bindings: [
      '2026-06', 'archive_result', 1, null, '{}', '已回滚',
      '3.1.9', 'build', '2026-08-11 12:00:00'
    ]
  }];
  for (const item of cases) {
    const db = createDb(t);
    seedRun(db);
    const insertDataset = db.prepare(`
      INSERT INTO vcc_fin_op_datasets (
        target_month, dataset_type, data_status, archived_run_id,
        revision, generated_at, updated_at
      ) VALUES ('2026-06', ?, 'unprocessed', NULL, 1,
                '2026-08-11 11:00:00', '2026-08-11 11:00:00')
    `);
    for (const datasetType of datasetTypes) insertDataset.run(datasetType);
    const plan = {
      operation: item.operation,
      targetMonth: '2026-06',
      runId: 1,
      expectedTotalChanges: 0,
      steps: [{ stepId: item.stepId, expectedChanges: 0, bindings: item.bindings }]
    };
    db.exec('BEGIN IMMEDIATE');
    const guard = beginMutationGuard(db, plan);
    assert.throws(() => executeRegisteredMutationSteps(db, guard), {
      code: 'mutation-budget-mismatch'
    }, item.stepId);
    db.exec('ROLLBACK');
    closeMutationGuard(guard);
  }
});
