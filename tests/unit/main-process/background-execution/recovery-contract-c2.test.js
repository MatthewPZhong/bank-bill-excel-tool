'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureArchiveMetadataSupport
} = require('../../../../src/backend/database/archive-repository');
const {
  canonicalSha256
} = require('../../../../src/main-process/background-execution/canonical-json-v1');
const {
  createCanaryPostImageInspector,
  createCanaryReceiptInspector,
  createCanarySettlementProvider,
  ensureCanaryReceiptSchema,
  runWorkerDurableCanary,
  writeCanaryTargetPostImage
} = require('../../../../src/main-process/background-execution/canary/durable-recovery');
const {
  durableRecoveryPolicy
} = require('../../../../src/main-process/background-execution/canary');
const {
  createRecoveryControlReadRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  fsyncDirectory
} = require('../../../../src/main-process/background-execution/durable-file');
const {
  createInspectorRegistry
} = require('../../../../src/main-process/background-execution/inspector-registry');
const {
  normalizeRecoveryInspectionResult,
  normalizeRecoverySource,
  normalizeSettlementRecoveryResult,
  recoverySourceSchema
} = require('../../../../src/main-process/background-execution/recovery-source');
const {
  transitionRequestKey
} = require('../../../../src/main-process/background-execution/recovery-control-contract');
const {
  createRecoveryHoldGate
} = require('../../../../src/main-process/background-execution/recovery-hold-gate');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../../../src/main-process/background-execution/startup-recovery-coordinator');

const ROOT = path.resolve(__dirname, '../../../..');
const AUTHORITY_DIR = path.join(
  ROOT,
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution'
);
const VALID_SOURCES = require(path.join(
  AUTHORITY_DIR,
  'validation/fixtures/valid/recovery-sources.v1.json'
));
const VALID_RESULTS = require(path.join(
  AUTHORITY_DIR,
  'validation/fixtures/valid/recovery-results.v1.json'
));
const SUPPORTED_DIRECTORY_FSYNC = () => Object.freeze({ capability: 'supported' });

function openDb(filePath = ':memory:') {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  ensureCanaryReceiptSchema(db);
  return db;
}

function writeTransition(db, transition, safePayload = {}) {
  const owner = createRecoveryRequestOwnerRepository(db);
  const reserved = owner.reserveTransitionRequest({
    requestKey: transitionRequestKey(transition),
    transition,
    safePayload
  });
  return createRecoveryControlRepository(db).runInControlTransaction(
    (tx) => tx.transitionWithRecoveryEvent(reserved)
  );
}

function createIntent(db, additions = {}) {
  const boundedEvidence = additions.boundedEvidence || { expectedValue: 'value-1' };
  const input = {
    contractVersion: 1,
    intentId: additions.intentId || 'intent-canary-1',
    actionKey: 'background-execution:canary',
    operationKey: additions.operationKey || 'operation-canary-1',
    taskRunId: additions.taskRunId || 'task-canary-1',
    jobId: additions.jobId || 'job-canary-1',
    coordinationKind: additions.coordinationKind || 'worker-critical',
    conflictScopeKey: additions.conflictScopeKey || 'scope:canary-1',
    inspectorKey: 'inspector.background-execution:canary',
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(boundedEvidence),
    boundedEvidence
  };
  writeTransition(db, { entityKind: 'critical-intent', command: 'create-prepared', input }, {
    state: 'prepared'
  });
  if (additions.acked !== false) {
    writeTransition(db, {
      entityKind: 'critical-intent',
      command: 'mark-acked',
      intentId: input.intentId,
      expectedState: 'prepared',
      patch: { admission: 'main' }
    }, { state: 'acked' });
  }
  return input;
}

function coordinatorFor(db, options = {}) {
  return createStartupRecoveryCoordinator({
    readRepository: createRecoveryControlReadRepository(db),
    inspectorRegistry: options.inspectorRegistry,
    providerRegistry: options.providerRegistry,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db),
    resolvePolicy: options.resolvePolicy || (() => null),
    planTransitions: options.planTransitions,
    transientAttempts: options.transientAttempts || 2,
    backoffBaseMs: options.backoffBaseMs ?? 0,
    backoffMaxMs: options.backoffMaxMs ?? (options.backoffBaseMs ?? 0),
    sleep: options.sleep || (async () => undefined)
  });
}

function inspectionFor(source, outcome, boundedEvidence = { marker: outcome }) {
  return {
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome,
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(boundedEvidence),
    boundedEvidence
  };
}

function settlementFor(source, inspection, outcome, additions = {}) {
  const boundedResult = additions.boundedResult || { outcome };
  const failed = outcome === 'transient-failure' || outcome === 'terminal-failure';
  return {
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    settlementKey: source.settlementKey,
    inspectionEvidenceHash: inspection.evidenceHash,
    outcome,
    resultVersion: 1,
    resultHash: canonicalSha256(boundedResult),
    boundedResult,
    safeError: failed ? {
      code: additions.errorCode || 'SETTLEMENT_FAILED',
      message: 'settlement failed'
    } : null,
    retryAfterMs: outcome === 'transient-failure' ? 1 : null
  };
}

test('RecoverySource runtime schema 与 authority 语义等价，五类 source/result exact identity/hash fail closed', () => {
  const authority = JSON.parse(fs.readFileSync(path.join(
    AUTHORITY_DIR,
    'platform-recovery-source-v1.schema.json'
  ), 'utf8'));
  assert.deepEqual(recoverySourceSchema, authority);
  for (const source of VALID_SOURCES) assert.deepEqual(normalizeRecoverySource(source), source);
  assert.throws(() => normalizeRecoverySource({ ...VALID_SOURCES[0], sourceKind: 'manual' }), {
    code: 'RECOVERY_SOURCE_INVALID'
  });
  assert.throws(() => normalizeRecoverySource({ ...VALID_SOURCES[0], intent: {} }), {
    code: 'RECOVERY_SOURCE_INVALID'
  });
  assert.throws(() => normalizeRecoverySource({
    ...VALID_SOURCES[0],
    boundedEvidence: { value: 'x'.repeat(65536) }
  }), { code: 'RECOVERY_SOURCE_EVIDENCE_INVALID' });
  const fixture = VALID_RESULTS[0];
  assert.deepEqual(
    normalizeRecoveryInspectionResult(fixture.source, fixture.inspection),
    fixture.inspection
  );
  assert.deepEqual(
    normalizeSettlementRecoveryResult(fixture.source, fixture.inspection, fixture.settlement),
    fixture.settlement
  );
  assert.throws(() => normalizeRecoveryInspectionResult(fixture.source, {
    ...fixture.inspection,
    operationKey: 'wrong-owner'
  }), { code: 'RECOVERY_INSPECTION_IDENTITY_MISMATCH' });
  assert.throws(() => normalizeSettlementRecoveryResult(fixture.source, fixture.inspection, {
    ...fixture.settlement,
    resultHash: '0'.repeat(64)
  }), { code: 'SETTLEMENT_RECOVERY_RESULT_HASH_MISMATCH' });
});

test('canonical durable canary policy 逐字段匹配 authority 且 production=false', () => {
  const policyDocument = require(path.join(
    AUTHORITY_DIR,
    'validation/fixtures/valid/policy-registry.v3.2.x.json'
  ));
  assert.deepEqual(durableRecoveryPolicy, policyDocument.actions['background-execution:canary']);
  assert.equal(durableRecoveryPolicy.commit.kind, 'worker-durable');
  assert.equal(durableRecoveryPolicy.production.enabled, false);
});

test('Critical Intent/Hold 表字段逐项匹配冻结 DDL，不增加隐式状态列', () => {
  const db = openDb();
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.deepEqual(columns('background_execution_critical_intents'), [
    'id', 'contract_version', 'intent_id', 'action_key', 'operation_key', 'task_run_id',
    'job_id', 'coordination_kind', 'state', 'conflict_scope_key', 'inspector_key',
    'evidence_version', 'evidence_json', 'evidence_sha256', 'receipt_ref_json',
    'result_json', 'created_at', 'updated_at', 'closed_at', 'retention_until'
  ]);
  assert.deepEqual(columns('background_execution_recovery_holds'), [
    'id', 'hold_id', 'source_kind', 'source_ref', 'intent_id', 'action_key',
    'operation_key', 'task_run_id', 'conflict_scope_key', 'reason_code', 'status',
    'resolution', 'safe_summary_json', 'created_at', 'updated_at', 'resolved_at'
  ]);
  db.close();
});

test('产品 Main migration 不创建 canary receipt 表，private/test DB 必须显式 opt-in', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  const table = () => db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'background_execution_canary_receipts'
  `).get() || null;
  assert.equal(table(), null);
  ensureCanaryReceiptSchema(db);
  assert.equal(table().name, 'background_execution_canary_receipts');
  db.close();
});

test('Inspector/Provider registries exact API、Static Key completeness 与 freeze 后注册拒绝', () => {
  const inspectorRegistry = createInspectorRegistry({ expectedKeys: ['inspector.canary'] });
  assert.throws(() => inspectorRegistry.freeze(), { code: 'RECOVERY_REGISTRY_INCOMPLETE' });
  inspectorRegistry.register('inspector.canary', async () => ({}));
  inspectorRegistry.freeze();
  assert.equal(typeof inspectorRegistry.get('inspector.canary'), 'function');
  assert.throws(() => inspectorRegistry.register('inspector.late', async () => ({})), {
    code: 'RECOVERY_REGISTRY_FROZEN'
  });

  const provider = Object.freeze({ listOpenSources: async () => [], recover: async () => ({}) });
  const providerRegistry = createSettlementRecoveryProviderRegistry({
    expectedKeys: ['settlement.canary']
  });
  providerRegistry.register('settlement.canary', provider);
  providerRegistry.freeze();
  assert.deepEqual(providerRegistry.list(), [{ key: 'settlement.canary', provider }]);
  assert.throws(() => providerRegistry.register('settlement.late', provider), {
    code: 'RECOVERY_REGISTRY_FROZEN'
  });
});

test('normal startup 空 control DB + frozen 空 registries 可完成零 source/hold scan', async () => {
  const db = openDb();
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.deepEqual(summary, { sourceCount: 0, activeHoldCount: 0, decisions: [] });
  db.close();
});

test('worker-durable canary 在 COMMIT 后回包前 crash，重启 inspector 以同事务 receipt 收口 Intent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-worker-canary-'));
  const dbPath = path.join(tempDir, 'control.sqlite');
  let db = openDb(dbPath);
  db.close();
  const crash = await runWorkerDurableCanary({
    dbPath,
    operationKey: 'operation-canary-1',
    value: 'value-1',
    committedAt: '2026-08-24T00:00:00.000Z',
    crashAfterCommit: true
  });
  assert.equal(crash.status, 'crashed-after-commit');

  db = openDb(dbPath);
  const intent = createIntent(db);
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(
    'inspector.background-execution:canary',
    createCanaryReceiptInspector(db)
  );
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(summary.sourceCount, 1);
  assert.equal(createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state, 'closed');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM background_execution_canary_receipts
    WHERE operation_key = 'operation-canary-1' AND value = 'value-1'
  `).get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM background_execution_recovery_events
    WHERE event_type = 'inspection-completed'
  `).get().n, 1);
  db.close();
});

test('worker-durable canary 覆盖 ack 前/后无 receipt 与 receipt mismatch unknown Hold', async (t) => {
  for (const scenario of [
    { name: 'before-ack', acked: false },
    { name: 'after-ack', acked: true }
  ]) {
    await t.test(scenario.name, async () => {
      const db = openDb();
      const intent = createIntent(db, {
        intentId: `intent-${scenario.name}`,
        operationKey: `operation-${scenario.name}`,
        taskRunId: `task-${scenario.name}`,
        acked: scenario.acked
      });
      const inspectorRegistry = createInspectorRegistry();
      inspectorRegistry.register(intent.inspectorKey, createCanaryReceiptInspector(db));
      inspectorRegistry.freeze();
      const providerRegistry = createSettlementRecoveryProviderRegistry();
      providerRegistry.freeze();
      await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
      assert.equal(
        createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state,
        'closed'
      );
      assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds().length, 0);
      db.close();
    });
  }

  await t.test('receipt-mismatch-unknown', async () => {
    const db = openDb();
    const intent = createIntent(db, {
      intentId: 'intent-receipt-mismatch',
      operationKey: 'operation-receipt-mismatch',
      taskRunId: 'task-receipt-mismatch',
      boundedEvidence: { expectedValue: 'expected' }
    });
    db.prepare(`
      INSERT INTO background_execution_canary_receipts(operation_key, value, committed_at)
      VALUES (?, ?, ?)
    `).run(intent.operationKey, 'different', '2026-08-24T00:00:00.000Z');
    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(intent.inspectorKey, createCanaryReceiptInspector(db));
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.freeze();
    await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
    const hold = createRecoveryControlReadRepository(db).getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${intent.intentId}`
    );
    assert.equal(hold.reasonCode, 'INSPECTION_UNKNOWN');
    assert.equal(createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state, 'acked');
    db.close();
  });
});

test('publisher provider 可独立枚举 durable open journal，dedupe 后只 inspect/recover 一次', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-provider-canary-'));
  const dbPath = path.join(tempDir, 'control.sqlite');
  const db = openDb(dbPath);
  await runWorkerDurableCanary({
    dbPath,
    operationKey: 'provider-operation',
    value: 'provider-value',
    committedAt: '2026-08-24T00:00:00.000Z',
    crashAfterCommit: false
  });
  const journalDirectory = path.join(tempDir, 'journals');
  const provider = createCanarySettlementProvider({
    journalDirectory,
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC
  });
  const prepared = provider.prepare({
    sourceKind: 'publisher-journal',
    sourceRef: 'publisher-journal:canary-1',
    operationKey: 'provider-operation',
    taskRunId: 'provider-task',
    conflictScopeKey: 'scope:provider',
    settlementKey: 'settlement.background-execution:canary',
    intentId: null,
    boundedEvidence: { expectedValue: 'provider-value' }
  });
  assert.equal(prepared.durability.status, 'committed');

  let inspectorCalls = 0;
  const baseInspector = createCanaryReceiptInspector(db);
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register('inspector.background-execution:canary', async (source) => {
    inspectorCalls += 1;
    return baseInspector(source);
  });
  inspectorRegistry.freeze();
  let recoverCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register('settlement.background-execution:canary', {
    listOpenSources: async () => {
      const sources = await provider.listOpenSources();
      return [...sources, ...sources];
    },
    recover: async (...args) => {
      recoverCalls += 1;
      return provider.recover(...args);
    }
  });
  providerRegistry.freeze();
  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(summary.sourceCount, 1);
  assert.equal(inspectorCalls, 1);
  assert.equal(recoverCalls, 1);
  assert.equal((await provider.listOpenSources()).length, 0);
  db.close();
});

test('持久 source 缺 Inspector 时先落 Hold+observation 再 fail closed，Provider 不执行', async () => {
  const db = openDb();
  const source = VALID_SOURCES[4];
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.freeze();
  let providerCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source],
    recover: async () => { providerCalls += 1; }
  });
  providerRegistry.freeze();
  await assert.rejects(
    coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover(),
    { code: 'STARTUP_RECOVERY_INSPECTOR_MISSING' }
  );
  const hold = createRecoveryControlReadRepository(db).getRecoveryHoldBySource(
    source.sourceKind,
    source.sourceRef
  );
  assert.equal(hold.status, 'active');
  assert.equal(hold.reasonCode, 'INSPECTOR_UNAVAILABLE');
  assert.equal(providerCalls, 0);
  db.close();
});

test('open Intent persisted evidence/hash 漂移先落 Hold，再阻断 startup inspection', async () => {
  const db = openDb();
  const intent = createIntent(db, {
    intentId: 'intent-evidence-drift',
    operationKey: 'operation-evidence-drift',
    taskRunId: 'task-evidence-drift',
    conflictScopeKey: 'scope:evidence-drift'
  });
  db.prepare(`
    UPDATE background_execution_critical_intents
    SET evidence_json = ?
    WHERE intent_id = ?
  `).run(JSON.stringify({ expectedValue: 'tampered' }), intent.intentId);
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();

  await assert.rejects(
    coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover(),
    { code: 'STARTUP_RECOVERY_INTENT_SOURCE_INVALID' }
  );
  const hold = createRecoveryControlReadRepository(db).getRecoveryHoldBySource(
    'critical-intent',
    `critical-intent:${intent.intentId}`
  );
  assert.equal(hold.status, 'active');
  assert.equal(hold.reasonCode, 'INSPECTION_UNKNOWN');
  db.close();
});

test('同 source pair 的 owner tuple 冲突直接 Hold，Inspector/Provider 调用数均为 0', async () => {
  const db = openDb();
  const source = VALID_SOURCES[1];
  const conflicting = { ...source, operationKey: 'conflicting-operation' };
  let inspectorCalls = 0;
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async () => {
    inspectorCalls += 1;
    return inspectionFor(source, 'committed');
  });
  inspectorRegistry.freeze();
  let recoverCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source, conflicting],
    recover: async () => { recoverCalls += 1; }
  });
  providerRegistry.freeze();
  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(summary.sourceCount, 0);
  assert.equal(inspectorCalls, 0);
  assert.equal(recoverCalls, 0);
  assert.equal(
    createRecoveryControlReadRepository(db).getRecoveryHoldBySource(source.sourceKind, source.sourceRef).reasonCode,
    'RECOVERY_SOURCE_OWNER_CONFLICT'
  );
  db.close();
});

test('同 source pair/owner 但其它 identity/evidence 漂移也拒绝 first-row winner', async () => {
  const db = openDb();
  const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:evidence-conflict' };
  const conflicting = { ...source, boundedEvidence: { marker: 'different' } };
  let inspectorCalls = 0;
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async () => {
    inspectorCalls += 1;
    return inspectionFor(source, 'committed');
  });
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source, conflicting],
    recover: async () => { throw new Error('不得调用'); }
  });
  providerRegistry.freeze();
  await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(inspectorCalls, 0);
  assert.equal(
    createRecoveryControlReadRepository(db).getRecoveryHoldBySource(source.sourceKind, source.sourceRef).reasonCode,
    'RECOVERY_SOURCE_IDENTITY_CONFLICT'
  );
  db.close();
});

test('active primary Hold 下不同 source 只记录 blocked inspection，不调用 Provider 或新增 Hold', async () => {
  const db = openDb();
  const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:blocked-source' };
  writeTransition(db, {
    entityKind: 'recovery-hold',
    command: 'create-or-get',
    input: {
      contractVersion: 1,
      holdId: 'hold-manual-primary',
      sourceKind: 'manual',
      sourceRef: 'manual:primary',
      intentId: null,
      actionKey: source.actionKey,
      operationKey: 'manual-operation',
      taskRunId: 'manual-task',
      conflictScopeKey: source.conflictScopeKey,
      reasonCode: 'MANUAL_REVIEW',
      safeSummary: { reasonCode: 'MANUAL_REVIEW' },
      evidenceHash: canonicalSha256({ reasonCode: 'MANUAL_REVIEW' })
    }
  });
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async (value) => inspectionFor(value, 'committed'));
  inspectorRegistry.freeze();
  let recoverCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source],
    recover: async () => { recoverCalls += 1; }
  });
  providerRegistry.freeze();
  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(summary.decisions[0].blocked, true);
  assert.equal(recoverCalls, 0);
  assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds().length, 1);
  const events = createRecoveryControlReadRepository(db).listRecoveryEvents(source.taskRunId);
  assert.equal(events.length, 1);
  assert.equal(events[0].holdId, 'hold-manual-primary');
  assert.equal(events[0].safePayload.disposition, 'blocked-by-active-scope-hold');
  db.close();
});

test('同次 scan 新建 primary Hold 后刷新 scope gate，后续 source 只观察不 settlement', async () => {
  const db = openDb();
  const first = {
    ...VALID_SOURCES[1],
    sourceRef: 'publisher-journal:dynamic-a',
    operationKey: 'operation-dynamic-a',
    taskRunId: 'task-dynamic-a',
    conflictScopeKey: 'scope:dynamic-hold'
  };
  const second = {
    ...VALID_SOURCES[1],
    sourceRef: 'publisher-journal:dynamic-b',
    operationKey: 'operation-dynamic-b',
    taskRunId: 'task-dynamic-b',
    conflictScopeKey: first.conflictScopeKey
  };
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(first.inspectorKey, async (source) => (
    inspectionFor(source, source.sourceRef === first.sourceRef ? 'unknown' : 'committed')
  ));
  inspectorRegistry.freeze();
  let recoverCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(first.settlementKey, {
    listOpenSources: async () => [second, first],
    recover: async () => { recoverCalls += 1; }
  });
  providerRegistry.freeze();

  const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(summary.activeHoldCount, 1);
  assert.equal(summary.decisions[0].held, true);
  assert.equal(summary.decisions[1].blocked, true);
  assert.equal(recoverCalls, 0);
  const holds = createRecoveryControlReadRepository(db).listActiveRecoveryHolds();
  assert.equal(holds.length, 1);
  const events = createRecoveryControlReadRepository(db).listRecoveryEvents(second.taskRunId);
  assert.equal(events.length, 1);
  assert.equal(events[0].holdId, holds[0].holdId);
  assert.equal(events[0].safePayload.disposition, 'blocked-by-active-scope-hold');
  db.close();
});

test('active same-source Hold 下 Inspector/Provider failure 关联 primary holdId，不撞唯一约束', async (t) => {
  async function runScenario(kind) {
    const db = openDb();
    const source = {
      ...VALID_SOURCES[1],
      sourceRef: `publisher-journal:active-${kind}`,
      taskRunId: `task-active-${kind}`,
      operationKey: `operation-active-${kind}`,
      conflictScopeKey: `scope:active-${kind}`
    };
    writeTransition(db, {
      entityKind: 'recovery-hold',
      command: 'create-or-get',
      input: {
        contractVersion: 1,
        holdId: `hold-active-${kind}`,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        intentId: null,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        conflictScopeKey: source.conflictScopeKey,
        reasonCode: 'SETTLEMENT_PROVIDER_UNAVAILABLE',
        safeSummary: { reasonCode: 'SETTLEMENT_PROVIDER_UNAVAILABLE' },
        evidenceHash: canonicalSha256({ reasonCode: 'SETTLEMENT_PROVIDER_UNAVAILABLE' })
      }
    });
    const inspection = inspectionFor(source, 'committed');
    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(source.inspectorKey, async () => {
      if (kind === 'inspector') throw Object.assign(new Error('retry'), { code: 'CANARY_TRANSIENT' });
      return inspection;
    });
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.register(source.settlementKey, {
      listOpenSources: async () => [source],
      recover: async () => settlementFor(source, inspection, 'transient-failure', {
        errorCode: 'CANARY_TRANSIENT'
      })
    });
    providerRegistry.freeze();
    await coordinatorFor(db, {
      inspectorRegistry,
      providerRegistry,
      transientAttempts: 3
    }).scanAndRecover();
    assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds().length, 1);
    const failures = createRecoveryControlReadRepository(db).listRecoveryEvents(source.taskRunId)
      .filter((event) => event.eventType.endsWith('failed-transient'));
    assert.equal(failures.length, 3);
    assert.deepEqual(failures.map((event) => event.holdId), [
      `hold-active-${kind}`,
      `hold-active-${kind}`,
      `hold-active-${kind}`
    ]);
    assert.equal(failures[0].safePayload.disposition, undefined);
    assert.deepEqual(failures.map((event) => event.safePayload.thresholdReached), [
      false,
      false,
      true
    ]);
    db.close();
  }
  await t.test('inspector', () => runScenario('inspector'));
  await t.test('provider', () => runScenario('provider'));
});

test('inspection partial/compensated 与 Provider incomplete 按冻结结果语义收口', async (t) => {
  await t.test('partially-committed creates hold and keeps intent open', async () => {
    const db = openDb();
    const intent = createIntent(db, {
      intentId: 'intent-partial',
      operationKey: 'operation-partial',
      taskRunId: 'task-partial',
      conflictScopeKey: 'scope:partial'
    });
    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(intent.inspectorKey, async (source) => (
      inspectionFor(source, 'partially-committed')
    ));
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.freeze();
    const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
    assert.equal(summary.decisions[0].held, true);
    assert.equal(createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state, 'acked');
    assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds()[0].reasonCode, 'PARTIALLY_COMMITTED');
    db.close();
  });

  await t.test('compensated closes intent through recovered state', async () => {
    const db = openDb();
    const intent = createIntent(db, {
      intentId: 'intent-compensated',
      operationKey: 'operation-compensated',
      taskRunId: 'task-compensated',
      conflictScopeKey: 'scope:compensated'
    });
    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(intent.inspectorKey, async (source) => inspectionFor(source, 'compensated'));
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.freeze();
    await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
    const persisted = createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId);
    assert.equal(persisted.state, 'closed');
    assert.equal(persisted.result.outcome, 'compensated');
    assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds().length, 0);
    db.close();
  });

  await t.test('provider incomplete keeps source open without hold', async () => {
    const db = openDb();
    const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:incomplete' };
    const inspection = inspectionFor(source, 'committed');
    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(source.inspectorKey, async () => inspection);
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.register(source.settlementKey, {
      listOpenSources: async () => [source],
      recover: async () => settlementFor(source, inspection, 'incomplete')
    });
    providerRegistry.freeze();
    const summary = await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
    assert.equal(summary.decisions[0].outcome, 'incomplete');
    assert.equal(createRecoveryControlReadRepository(db).listActiveRecoveryHolds().length, 0);
    db.close();
  });
});

test('target-post-image 从 open Main-owned Intent 枚举，回读 post-image 后由 Provider 幂等收口', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-target-recovery-'));
  const db = openDb();
  const targetPath = path.join(tempDir, 'target.json');
  fs.writeFileSync(targetPath, '{"post":true}');
  const expectedPostHash = createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  const intent = createIntent(db, {
    intentId: 'intent-target-post-image',
    operationKey: 'operation-target-post-image',
    taskRunId: 'task-target-post-image',
    coordinationKind: 'main-owned-settlement',
    boundedEvidence: { expectedPostHash, expectedPreHash: null }
  });
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(
    intent.inspectorKey,
    createCanaryPostImageInspector({ resolveTargetPath: () => targetPath })
  );
  inspectorRegistry.freeze();
  const provider = createCanarySettlementProvider({
    journalDirectory: path.join(tempDir, 'journal'),
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC
  });
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register('settlement.background-execution:canary', provider);
  providerRegistry.freeze();
  await coordinatorFor(db, {
    inspectorRegistry,
    providerRegistry,
    resolvePolicy: () => ({ commit: { settlementKey: 'settlement.background-execution:canary' } })
  }).scanAndRecover();
  assert.equal(
    createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state,
    'closed'
  );
  assert.equal((await provider.listOpenSources()).length, 0);
  db.close();
});

test('持久 target source 缺 Provider 时先 Hold 再让 startup fail closed', async () => {
  const db = openDb();
  const intent = createIntent(db, {
    intentId: 'intent-missing-provider',
    operationKey: 'operation-missing-provider',
    taskRunId: 'task-missing-provider',
    coordinationKind: 'main-owned-settlement'
  });
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(intent.inspectorKey, async (source) => inspectionFor(source, 'committed'));
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  await assert.rejects(coordinatorFor(db, {
    inspectorRegistry,
    providerRegistry,
    resolvePolicy: () => ({ commit: { settlementKey: 'settlement.missing' } })
  }).scanAndRecover(), { code: 'STARTUP_RECOVERY_PROVIDER_MISSING' });
  const hold = createRecoveryControlReadRepository(db).getRecoveryHoldBySource(
    'target-post-image',
    `target-post-image:${intent.intentId}`
  );
  assert.equal(hold.reasonCode, 'SETTLEMENT_PROVIDER_UNAVAILABLE');
  assert.equal(hold.status, 'active');
  db.close();
});

test('Provider durability terminal result 创建专用 DURABILITY_BARRIER_UNAVAILABLE Hold', async () => {
  const db = openDb();
  const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:durability-terminal' };
  const inspection = inspectionFor(source, 'committed');
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async () => inspection);
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source],
    recover: async () => settlementFor(source, inspection, 'terminal-failure', {
      errorCode: 'DURABILITY_BARRIER_UNAVAILABLE'
    })
  });
  providerRegistry.freeze();
  await coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover();
  assert.equal(
    createRecoveryControlReadRepository(db).getRecoveryHoldBySource(source.sourceKind, source.sourceRef).reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE'
  );
  db.close();
});

test('Provider transient failure 使用有界指数退避，阈值末次 observation 与 Hold 原子落库', async () => {
  const db = openDb();
  const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:transient-threshold' };
  const inspection = inspectionFor(source, 'committed');
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async () => inspection);
  inspectorRegistry.freeze();
  let recoverCalls = 0;
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source],
    recover: async () => {
      recoverCalls += 1;
      return settlementFor(source, inspection, 'transient-failure', {
        errorCode: 'CANARY_TRANSIENT'
      });
    }
  });
  providerRegistry.freeze();
  const sleeps = [];
  await coordinatorFor(db, {
    inspectorRegistry,
    providerRegistry,
    transientAttempts: 3,
    backoffBaseMs: 7,
    backoffMaxMs: 20,
    sleep: async (ms) => { sleeps.push(ms); }
  }).scanAndRecover();
  assert.equal(recoverCalls, 3);
  assert.deepEqual(sleeps, [7, 14]);
  const hold = createRecoveryControlReadRepository(db).getRecoveryHoldBySource(
    source.sourceKind,
    source.sourceRef
  );
  assert.equal(hold.reasonCode, 'SETTLEMENT_PROVIDER_UNAVAILABLE');
  const failures = createRecoveryControlReadRepository(db).listRecoveryEvents(source.taskRunId)
    .filter((event) => event.eventType === 'settlement-failed-transient');
  assert.equal(failures.length, 3);
  assert.equal(failures[2].holdId, hold.holdId);
  assert.equal(failures[2].safePayload.thresholdReached, true);
  db.close();
});

test('Provider result identity/hash 漂移先落 Hold，再 fail closed 且不进入后续 transition', async () => {
  const db = openDb();
  const source = { ...VALID_SOURCES[1], sourceRef: 'publisher-journal:invalid-result' };
  const inspection = inspectionFor(source, 'committed');
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(source.inspectorKey, async () => inspection);
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(source.settlementKey, {
    listOpenSources: async () => [source],
    recover: async () => ({
      ...settlementFor(source, inspection, 'completed'),
      operationKey: 'wrong-operation'
    })
  });
  providerRegistry.freeze();
  await assert.rejects(
    coordinatorFor(db, { inspectorRegistry, providerRegistry }).scanAndRecover(),
    { code: 'STARTUP_RECOVERY_SETTLEMENT_RESULT_INVALID' }
  );
  assert.equal(
    createRecoveryControlReadRepository(db).getRecoveryHoldBySource(source.sourceKind, source.sourceRef).reasonCode,
    'SETTLEMENT_PROVIDER_UNAVAILABLE'
  );
  db.close();
});

test('inspection observation 与多个即时 transition 同 tx；末项 CAS 失败时全部状态/event 回滚', async () => {
  const db = openDb();
  const intent = createIntent(db, {
    intentId: 'intent-atomic-rollback',
    operationKey: 'operation-atomic-rollback',
    taskRunId: 'task-atomic-rollback'
  });
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(intent.inspectorKey, async (source) => inspectionFor(source, 'not-committed'));
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  await assert.rejects(coordinatorFor(db, {
    inspectorRegistry,
    providerRegistry,
    planTransitions: ({ phase, source }) => phase === 'inspection-result' ? [{
      transition: {
        entityKind: 'task-run',
        command: 'mark-interrupted',
        actionKey: source.actionKey,
        expectedTaskKey: 'missing-task-policy',
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        expectedState: 'running',
        failureCode: 'RECOVERY_ATOMICITY_PROBE',
        failureMessage: 'expected missing Task identity',
        metadataPatch: {}
      },
      safePayload: { probe: 'rollback' }
    }] : []
  }).scanAndRecover(), { code: 'RECOVERY_TASK_IDENTITY_CONFLICT' });
  assert.equal(createRecoveryControlReadRepository(db).getCriticalIntentById(intent.intentId).state, 'acked');
  assert.equal(createRecoveryControlReadRepository(db).listRecoveryEvents(intent.taskRunId).length, 2);
  db.close();
});

test('target post-image durable replace 正常回读；directory fsync 明确 unsupported 与其他错误分流', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-post-image-'));
  const hostDirectoryBarrier = fsyncDirectory(tempDir);
  assert.ok(['supported', 'unsupported'].includes(hostDirectoryBarrier.capability));
  if (hostDirectoryBarrier.capability === 'unsupported') {
    assert.equal(typeof hostDirectoryBarrier.errorCode, 'string');
  }
  t.diagnostic(
    `hostDirectoryFsync=${hostDirectoryBarrier.capability}` +
    (hostDirectoryBarrier.errorCode ? `:${hostDirectoryBarrier.errorCode}` : '')
  );

  const target = path.join(tempDir, 'target.json');
  const result = writeCanaryTargetPostImage(target, '{"value":1}', {
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC
  });
  assert.equal(result.status, 'committed');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"value":1}');

  const unavailableTarget = path.join(tempDir, 'unavailable.json');
  const unavailable = writeCanaryTargetPostImage(unavailableTarget, '{"value":2}', {
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' })
  });
  assert.equal(unavailable.status, 'durability-unavailable');
  assert.equal(unavailable.directoryFsync.errorCode, 'EPERM');
  assert.equal(fs.readFileSync(unavailableTarget, 'utf8'), '{"value":2}');

  const unsupportedProvider = createCanarySettlementProvider({
    journalDirectory: path.join(tempDir, 'unsupported-provider'),
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' })
  });
  const prepared = unsupportedProvider.prepare({
    sourceKind: 'publisher-journal',
    sourceRef: 'publisher-journal:unsupported-provider',
    operationKey: 'operation-unsupported-provider',
    taskRunId: 'task-unsupported-provider',
    conflictScopeKey: 'scope:unsupported-provider',
    settlementKey: 'settlement.background-execution:canary',
    intentId: null,
    boundedEvidence: { expectedValue: 'unsupported-provider' }
  });
  assert.equal(prepared.durability.status, 'durability-unavailable');
  const terminal = await unsupportedProvider.recover(
    prepared.source,
    inspectionFor(prepared.source, 'committed')
  );
  assert.equal(terminal.outcome, 'terminal-failure');
  assert.equal(terminal.safeError.code, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal((await unsupportedProvider.listOpenSources()).length, 1);

  const unsupportedFs = {
    openSync() { throw Object.assign(new Error('unsupported'), { code: 'EINVAL' }); },
    closeSync() {}
  };
  assert.deepEqual(fsyncDirectory(tempDir, { fs: unsupportedFs }), {
    capability: 'unsupported',
    errorCode: 'EINVAL'
  });

  for (const errorCode of ['EACCES', 'EISDIR', 'EPERM']) {
    const windowsUnsupportedFs = {
      openSync() { throw Object.assign(new Error('unsupported on Windows'), { code: errorCode }); },
      closeSync() {}
    };
    assert.deepEqual(fsyncDirectory(tempDir, {
      fs: windowsUnsupportedFs,
      platform: 'win32'
    }), {
      capability: 'unsupported',
      errorCode
    });
    assert.throws(() => fsyncDirectory(tempDir, {
      fs: windowsUnsupportedFs,
      platform: 'linux'
    }), {
      code: 'DURABILITY_DIRECTORY_FSYNC_FAILED'
    });
  }

  const failedFs = {
    openSync() { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); },
    closeSync() {}
  };
  assert.throws(() => fsyncDirectory(tempDir, { fs: failedFs, platform: 'win32' }), {
    code: 'DURABILITY_DIRECTORY_FSYNC_FAILED'
  });
});

test('产品 Main 真实等待 Recovery Coordinator 后才 initializeArchiveCenter，之后才启动 cleanup', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const start = source.indexOf('async function initializeApplication()');
  const end = source.indexOf('if (hasSingleInstanceLock) app.whenReady()', start);
  const body = source.slice(start, end);
  const dbInit = body.indexOf('database.init(');
  const recovery = body.indexOf('await initializeBackgroundExecutionRecovery()');
  const archive = body.indexOf('initializeArchiveCenter()');
  const cleanup = body.indexOf('runStartupPostSetup()');
  assert.ok(dbInit >= 0 && dbInit < recovery);
  assert.ok(recovery < archive);
  assert.ok(archive < cleanup);
  const readyStart = source.indexOf('if (hasSingleInstanceLock) app.whenReady()');
  const bindingStartup = source.indexOf('await runActionTaskBindingStartup()', readyStart);
  const createWindow = source.indexOf('await createWindow(', readyStart);
  assert.ok(bindingStartup >= 0 && bindingStartup < createWindow);
  const initializeRecovery = source.slice(
    source.indexOf('async function initializeBackgroundExecutionRecovery()'),
    source.indexOf('function assertTaskPolicyNotHeld(')
  );
  assert.equal(initializeRecovery.includes('catch ('), false);
});

test('Recovery Hold gate 读取 Main control DB；真实 Archive 入口在 prepare/admission/beforeStart 三处复核', () => {
  const db = openDb();
  writeTransition(db, {
    entityKind: 'recovery-hold',
    command: 'create-or-get',
    input: {
      contractVersion: 1,
      holdId: 'hold-gate-1',
      sourceKind: 'manual',
      sourceRef: 'manual:gate-1',
      intentId: null,
      actionKey: 'statement:generate-current',
      operationKey: 'operation-gate-1',
      taskRunId: 'task-gate-1',
      conflictScopeKey: 'scope:gate-1',
      reasonCode: 'MANUAL_REVIEW',
      safeSummary: { reasonCode: 'MANUAL_REVIEW' },
      evidenceHash: canonicalSha256({ reasonCode: 'MANUAL_REVIEW' })
    }
  });
  const gate = createRecoveryHoldGate(createRecoveryControlReadRepository(db));
  assert.throws(() => gate.assertNoRecoveryHold({ conflictScopeKey: 'scope:gate-1' }), {
    code: 'RECOVERY_HOLD_ACTIVE',
    holdId: 'hold-gate-1'
  });
  assert.equal(gate.assertNoRecoveryHold({ conflictScopeKey: 'scope:free' }), true);
  writeTransition(db, {
    entityKind: 'recovery-hold',
    command: 'resolve',
    holdId: 'hold-gate-1',
    expectedState: 'active',
    resolution: 'manual-override',
    evidence: { reviewRef: 'test-only-resolution-evidence' }
  });
  assert.equal(gate.assertNoRecoveryHold({ conflictScopeKey: 'scope:gate-1' }), true);
  db.close();

  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const start = source.indexOf('async function runArchiveAwareOperation(');
  const end = source.indexOf('function runRegisteredBusinessOperation(', start);
  const body = source.slice(start, end);
  const firstGate = body.indexOf('assertTaskPolicyNotHeld(policy, null)');
  const prepare = body.indexOf('prepareIpcTaskInvocation(');
  const secondGate = body.indexOf('assertTaskPolicyNotHeld(policy, prepared)', firstGate + 1);
  const archiveAdmission = body.indexOf('archiveTaskLifecycle.run');
  assert.ok(firstGate >= 0 && firstGate < prepare);
  assert.ok(prepare < secondGate && secondGate < archiveAdmission);
  assert.ok(body.match(/assertTaskPolicyNotHeld\(policy, (?:null|prepared)\)/g).length >= 4);
  assert.match(source, /PRE_FUND_SCOPED_HOLD_TASK_KEYS[\s\S]*?prepared === null\) return true/);
  assert.match(source, /PREFUND_RECOVERY_SCOPE_UNAVAILABLE/);
  assert.match(source, /RECOVERY_HOLD_ACTION_UNBOUND/);
  assert.match(source, /allowedTaskKeys\(hold\.actionKey\)/);
});

test('target post-image hash 辅助证据使用 raw bytes SHA-256', () => {
  const bytes = Buffer.from('post-image', 'utf8');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'd3cb748eb49be9d76f897c62953819d92a27c6f0db112842e93de44cf14ccffc'
  );
});
