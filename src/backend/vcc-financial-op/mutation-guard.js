'use strict';

const { DatabaseSync } = require('node:sqlite');
const {
  VCC_MUTATION_OPERATIONS,
  LARGE_TABLE_SCOPE_PROOF_TABLES,
  VCC_TABLE_POLICY_REGISTRY,
  APPROVED_VCC_TRIGGERS,
  MUTATION_SQL_STEP_REGISTRY
} = require('./mutation-policy');

const LARGE_TABLE_SCOPE_PROOF_SET = new Set(LARGE_TABLE_SCOPE_PROOF_TABLES);
const APPROVED_TRIGGER_SET = new Set(APPROVED_VCC_TRIGGERS);
const OPERATION_SET = new Set(Object.values(VCC_MUTATION_OPERATIONS));
let runtimeCapabilityEvidence = null;

function mutationGuardError(code, message, context = {}) {
  const error = new Error(message);
  error.code = code;
  error.context = context;
  return error;
}

function totalChanges(db) {
  const row = db.prepare('SELECT total_changes() AS total_changes').get();
  return Number(row.total_changes);
}

function changesetSize(session) {
  try {
    const changeset = session.changeset();
    return changeset && Number.isSafeInteger(changeset.byteLength)
      ? changeset.byteLength
      : 0;
  } catch (error) {
    throw mutationGuardError(
      'mutation-guard-unavailable',
      'SQLite session changeset 不可用，已禁止业务写入。',
      {
        causeCode: error && error.code ? String(error.code) : null,
        causeMessage: error && error.message ? error.message : String(error)
      }
    );
  }
}

function runRuntimeCapabilityProbe(Database = DatabaseSync) {
  const db = new Database(':memory:');
  let rollbackSession = null;
  let commitSession = null;
  try {
    if (typeof db.createSession !== 'function') {
      throw mutationGuardError(
        'mutation-guard-unavailable',
        '当前 SQLite runtime 不支持会话级写入保护。',
        { capability: 'createSession' }
      );
    }
    db.exec(`
      CREATE TABLE probe_protected (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE probe_allowed (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TRIGGER probe_allowed_insert
      AFTER INSERT ON probe_allowed
      BEGIN
        INSERT INTO probe_protected (value) VALUES (NEW.value);
      END;
    `);
    const emptySession = db.createSession({ table: 'probe_protected' });
    const emptyChangesetBytes = changesetSize(emptySession);
    emptySession.close();
    if (emptyChangesetBytes !== 0) {
      throw mutationGuardError(
        'mutation-guard-unavailable',
        'SQLite 空会话产生了非空 changeset。',
        { capability: 'empty-changeset', emptyChangesetBytes }
      );
    }

    db.exec('BEGIN IMMEDIATE');
    rollbackSession = db.createSession({ table: 'probe_protected' });
    const rollbackBaseline = totalChanges(db);
    const inserted = db.prepare('INSERT INTO probe_allowed (value) VALUES (?)').run('rollback');
    const rollbackDelta = totalChanges(db) - rollbackBaseline;
    const rollbackChangesetBytes = changesetSize(rollbackSession);
    db.exec('ROLLBACK');
    rollbackSession.close();
    rollbackSession = null;
    if (
      Number(inserted.changes) !== 1
      || rollbackDelta !== 2
      || rollbackChangesetBytes < 1
    ) {
      throw mutationGuardError(
        'mutation-guard-unavailable',
        'SQLite trigger/session/total_changes 能力不符合写保护合同。',
        {
          capability: 'trigger-observation',
          statementChanges: Number(inserted.changes),
          rollbackDelta,
          rollbackChangesetBytes
        }
      );
    }

    db.exec('BEGIN IMMEDIATE');
    commitSession = db.createSession({ table: 'probe_protected' });
    db.prepare('INSERT INTO probe_allowed (value) VALUES (?)').run('commit');
    const commitChangesetBytes = changesetSize(commitSession);
    db.exec('COMMIT');
    commitSession.close();
    commitSession = null;
    if (commitChangesetBytes < 1) {
      throw mutationGuardError(
        'mutation-guard-unavailable',
        'SQLite 提交后的 session changeset 不符合写保护合同。',
        { capability: 'commit-session-close', commitChangesetBytes }
      );
    }
    return Object.freeze({
      sqliteVersion: process.versions.sqlite || null,
      emptyChangesetBytes,
      rollbackChangesetBytes,
      commitChangesetBytes,
      triggerTotalChangesDelta: rollbackDelta
    });
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* close below */ }
    }
    if (rollbackSession) {
      try { rollbackSession.close(); } catch (_closeError) { /* preserve primary */ }
    }
    if (commitSession) {
      try { commitSession.close(); } catch (_closeError) { /* preserve primary */ }
    }
    if (error && error.code === 'mutation-guard-unavailable') throw error;
    throw mutationGuardError(
      'mutation-guard-unavailable',
      'SQLite mutation guard runtime probe 失败。',
      {
        causeCode: error && error.code ? String(error.code) : null,
        causeMessage: error && error.message ? error.message : String(error)
      }
    );
  } finally {
    db.close();
  }
}

function assertMutationRuntimeAvailable({ Database = DatabaseSync, force = false } = {}) {
  if (!force && runtimeCapabilityEvidence) return runtimeCapabilityEvidence;
  const evidence = runRuntimeCapabilityProbe(Database);
  if (Database === DatabaseSync) runtimeCapabilityEvidence = evidence;
  return evidence;
}

function tablePrimaryKey(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
}

function assertVccMutationSchema(db) {
  const actualTables = db.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'vcc_fin_op_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
  const expectedTables = Object.keys(VCC_TABLE_POLICY_REGISTRY).sort();
  const details = [];
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    const actual = new Set(actualTables);
    const expected = new Set(expectedTables);
    for (const tableName of expectedTables) {
      if (!actual.has(tableName)) details.push(`missing-table:${tableName}`);
    }
    for (const tableName of actualTables) {
      if (!expected.has(tableName)) details.push(`unknown-table:${tableName}`);
    }
  }
  for (const tableName of expectedTables) {
    if (!actualTables.includes(tableName)) continue;
    const expectedPrimaryKey = VCC_TABLE_POLICY_REGISTRY[tableName].primaryKey;
    if (JSON.stringify(tablePrimaryKey(db, tableName)) !== JSON.stringify(expectedPrimaryKey)) {
      details.push(`primary-key-mismatch:${tableName}`);
    }
  }
  if (details.length > 0) {
    throw mutationGuardError(
      'vcc-schema-not-ready',
      'VCC 财务OP数据库结构与写保护注册表不一致，请重启应用并联系支持。',
      { details }
    );
  }
  return Object.freeze({ ready: true, tableCount: expectedTables.length });
}

function vccTriggers(db) {
  return db.prepare(`
    SELECT name, tbl_name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
      AND (
        tbl_name LIKE 'vcc_fin_op_%'
        OR instr(lower(COALESCE(sql, '')), 'vcc_fin_op_') > 0
      )
    ORDER BY name
  `).all().map((row) => Object.freeze({
    name: String(row.name),
    tableName: String(row.tbl_name),
    sql: row.sql === null ? null : String(row.sql)
  }));
}

function assertVccTriggerPolicy(db) {
  const triggers = vccTriggers(db);
  const unknown = triggers.filter((trigger) => !APPROVED_TRIGGER_SET.has(trigger.name));
  if (unknown.length > 0) {
    throw mutationGuardError(
      'vcc-trigger-policy-violation',
      '数据库存在未批准的 VCC trigger，已禁止业务写入。',
      { triggers: unknown.map((trigger) => ({ name: trigger.name, tableName: trigger.tableName })) }
    );
  }
  return Object.freeze({ approved: true, triggerCount: triggers.length });
}

function assertPlanRegistered(plan) {
  if (!plan || !OPERATION_SET.has(plan.operation) || !Array.isArray(plan.steps)) {
    throw mutationGuardError('invalid-mutation-plan', 'MutationPlan 结构无效。');
  }
  let expectedTotalChanges = 0;
  for (const plannedStep of plan.steps) {
    const registered = MUTATION_SQL_STEP_REGISTRY[plannedStep.stepId];
    if (!registered) {
      throw mutationGuardError(
        'unregistered-mutation-step',
        `MutationPlan 包含未登记 step：${plannedStep.stepId || ''}`
      );
    }
    const tablePolicy = VCC_TABLE_POLICY_REGISTRY[registered.tableName];
    if (!tablePolicy || tablePolicy.operations[plan.operation] !== 'allowed') {
      throw mutationGuardError(
        'mutation-table-policy-violation',
        `${plan.operation} 不允许修改 ${registered.tableName}。`
      );
    }
    if (
      !Array.isArray(plannedStep.bindings)
      || !Number.isSafeInteger(plannedStep.expectedChanges)
      || plannedStep.expectedChanges < 0
    ) {
      throw mutationGuardError(
        'invalid-mutation-plan',
        `MutationPlan step ${plannedStep.stepId} 的绑定或预算无效。`
      );
    }
    if (LARGE_TABLE_SCOPE_PROOF_SET.has(registered.tableName)) {
      const proof = plannedStep.largeTableScopeProof;
      if (
        !registered.largeTableScopeId
        || !proof
        || typeof proof !== 'object'
        || Array.isArray(proof)
        || Object.keys(proof).sort().join(',') !== 'preCount,scopeId'
        || proof.scopeId !== registered.largeTableScopeId
        || !Number.isSafeInteger(proof.preCount)
        || proof.preCount < 0
        || proof.preCount !== plannedStep.expectedChanges
      ) {
        throw mutationGuardError(
          'mutation-table-policy-violation',
          `MutationPlan 大表 step ${plannedStep.stepId} 缺少精确 fixed scope proof。`,
          {
            operation: plan.operation,
            tableName: registered.tableName,
            expectedScopeId: registered.largeTableScopeId,
            actualScopeId: proof && proof.scopeId
          }
        );
      }
    } else if (registered.largeTableScopeId !== null) {
      throw mutationGuardError(
        'mutation-table-policy-violation',
        `小表 step ${plannedStep.stepId} 不得声明 large table scope。`
      );
    }
    expectedTotalChanges += plannedStep.expectedChanges;
  }
  if (expectedTotalChanges !== plan.expectedTotalChanges) {
    throw mutationGuardError(
      'invalid-mutation-plan',
      'MutationPlan 总预算与逐 step 预算不一致。',
      { expectedTotalChanges, plannedTotalChanges: plan.expectedTotalChanges }
    );
  }
}

function createProtectedSessions(db, operation, createSession = (tableName) => (
  db.createSession({ table: tableName })
)) {
  const sessions = [];
  try {
    for (const [tableName, tablePolicy] of Object.entries(VCC_TABLE_POLICY_REGISTRY)) {
      if (tablePolicy.operations[operation] !== 'protected') continue;
      if (LARGE_TABLE_SCOPE_PROOF_SET.has(tableName)) continue;
      sessions.push(Object.freeze({ tableName, session: createSession(tableName) }));
    }
  } catch (error) {
    const closeFailures = closeProtectedSessions(sessions);
    throw mutationGuardError(
      'mutation-guard-unavailable',
      'SQLite protected session 创建失败，已禁止业务写入。',
      {
        causeCode: error && error.code ? String(error.code) : null,
        causeMessage: error && error.message ? error.message : String(error),
        closeFailures
      }
    );
  }
  return sessions;
}

function closeProtectedSessions(sessions) {
  const failures = [];
  for (const entry of sessions || []) {
    try { entry.session.close(); } catch (error) {
      failures.push({
        tableName: entry.tableName,
        code: error && error.code ? String(error.code) : null,
        message: error && error.message ? error.message : String(error)
      });
    }
  }
  return failures;
}

function beginMutationGuard(db, plan, { createSession } = {}) {
  assertPlanRegistered(plan);
  assertVccTriggerPolicy(db);
  const baselineTotalChanges = totalChanges(db);
  const sessions = createProtectedSessions(db, plan.operation, createSession);
  return {
    plan,
    baselineTotalChanges,
    sessions,
    stepResults: [],
    closed: false
  };
}

function executeRegisteredMutationSteps(db, guard, hooks = {}) {
  const prepared = new Map();
  for (let index = 0; index < guard.plan.steps.length; index += 1) {
    const plannedStep = guard.plan.steps[index];
    const registered = MUTATION_SQL_STEP_REGISTRY[plannedStep.stepId];
    if (typeof hooks.beforeStep === 'function') hooks.beforeStep({ db, plannedStep, index });
    let statement = prepared.get(plannedStep.stepId);
    if (!statement) {
      statement = db.prepare(registered.sql);
      prepared.set(plannedStep.stepId, statement);
    }
    const result = statement.run(...plannedStep.bindings);
    const actualChanges = Number(result.changes);
    if (typeof hooks.afterStep === 'function') {
      hooks.afterStep({ db, plannedStep, index, result, actualChanges });
    }
    guard.stepResults.push(Object.freeze({
      stepId: plannedStep.stepId,
      tableName: registered.tableName,
      expectedChanges: plannedStep.expectedChanges,
      actualChanges,
      lastInsertRowid: result.lastInsertRowid === undefined
        ? null
        : Number(result.lastInsertRowid)
    }));
    if (actualChanges !== plannedStep.expectedChanges) {
      throw mutationGuardError(
        'mutation-budget-mismatch',
        `MutationPlan step ${plannedStep.stepId} 变化数不符合预算。`,
        { stepId: plannedStep.stepId, expectedChanges: plannedStep.expectedChanges, actualChanges }
      );
    }
  }
  return guard.stepResults;
}

function assertMutationGuardPostwrite(db, guard) {
  const actualTotalChanges = totalChanges(db) - guard.baselineTotalChanges;
  if (actualTotalChanges !== guard.plan.expectedTotalChanges) {
    throw mutationGuardError(
      'mutation-budget-mismatch',
      'MutationPlan 总变化数不符合固定预算。',
      {
        expectedTotalChanges: guard.plan.expectedTotalChanges,
        actualTotalChanges
      }
    );
  }
  for (const { tableName, session } of guard.sessions) {
    const byteLength = changesetSize(session);
    if (byteLength !== 0) {
      throw mutationGuardError(
        'mutation-protected-table-changed',
        `受保护表 ${tableName} 出现未批准变化。`,
        { tableName, changesetBytes: byteLength }
      );
    }
  }
  return Object.freeze({ actualTotalChanges });
}

function closeMutationGuard(guard) {
  if (!guard || guard.closed) return [];
  guard.closed = true;
  return closeProtectedSessions(guard.sessions);
}

module.exports = {
  mutationGuardError,
  totalChanges,
  changesetSize,
  runRuntimeCapabilityProbe,
  assertMutationRuntimeAvailable,
  assertVccMutationSchema,
  vccTriggers,
  assertVccTriggerPolicy,
  assertPlanRegistered,
  createProtectedSessions,
  closeProtectedSessions,
  beginMutationGuard,
  executeRegisteredMutationSteps,
  assertMutationGuardPostwrite,
  closeMutationGuard
};
