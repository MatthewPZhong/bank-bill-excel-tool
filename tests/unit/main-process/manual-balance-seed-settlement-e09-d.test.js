'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  BALANCE_SEED_GENERATION_METHODS,
  getBalanceSeedFilePath,
  readBalanceSeedRecords,
  serializeBalanceSeedRecords,
  writeBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');
const {
  createArchiveRepository,
  ensureArchiveMetadataSupport
} = require('../../../src/backend/database/archive-repository');
const {
  DurabilityBarrierError
} = require('../../../src/main-process/background-execution/durable-file');
const {
  balanceSeedRecordsEvidence,
  materializeManualBalanceSeedPlan
} = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  createRecoveryControlReadRepository
} = require('../../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createInspectorRegistry
} = require('../../../src/main-process/background-execution/inspector-registry');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../../src/main-process/background-execution/startup-recovery-coordinator');
const {
  createRecoveryHoldGate
} = require('../../../src/main-process/background-execution/recovery-hold-gate');
const {
  transitionRequestKey
} = require('../../../src/main-process/background-execution/recovery-control-contract');
const {
  MANUAL_BALANCE_ACTION_KEY,
  MANUAL_BALANCE_INSPECTOR_KEY,
  MANUAL_BALANCE_SETTLEMENT_KEY,
  createMainSettlementIntentCoordinator,
  createManualBalanceInteractionOrdinalAllocator,
  createManualBalanceOperationIdentity,
  createManualBalanceRecoveryPlanTransitions,
  createManualBalanceSeedPlanFreshnessGate,
  createManualBalanceSeedInspector,
  createManualBalanceSettlementRecoveryProvider,
  createManualBalanceTargetAlias,
  createRecoveryTransitionWriter,
  manualBalanceRecoveryPolicy,
  resolveManualBalanceTargetAlias,
  snapshotForBytes,
  targetSnapshot
} = require('../../../src/main-process/manual-balance-seed-settlement');

const NOW = '2026-08-29T00:00:00.000Z';
const SUPPORTED_DIRECTORY_FSYNC = () => Object.freeze({ capability: 'supported' });

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  return db;
}

function seedTask(db, taskRunId = 'task-manual-seed') {
  const archive = createArchiveRepository(db, { now: () => new Date(NOW) });
  archive.beginTaskRun({
    taskRunId,
    moduleId: 'statement',
    taskKey: 'file:save-balance-seed',
    operationKey: `${taskRunId}/file:save-balance-seed`,
    parentRunId: 'parent-statement'
  });
  return taskRunId;
}

function record(additions = {}) {
  return {
    merchantId: '6222 0212 3456 7890',
    currency: 'CNY',
    billDate: '2026-08-01',
    endBalance: 1234.56,
    templateName: '中行-上海',
    generationMethod: BALANCE_SEED_GENERATION_METHODS.manual,
    updatedAt: NOW,
    ...additions
  };
}

function createHarness(t, additions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-d-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb();
  t.after(() => db.close());
  const readRepository = createRecoveryControlReadRepository(db);
  const requestOwnerRepository = createRecoveryRequestOwnerRepository(db);
  const recoveryControlRepository = createRecoveryControlRepository(db);
  const observationAttemptRepository = createRecoveryObservationAttemptRepository(db);
  const transitionWriter = createRecoveryTransitionWriter({
    requestOwnerRepository,
    observationAttemptRepository,
    recoveryControlRepository
  });
  const resolveTargetPath = (alias) => resolveManualBalanceTargetAlias(root, alias);
  const recoveryHoldGate = additions.recoveryHoldGate || createRecoveryHoldGate(readRepository);
  const preCommitGate = additions.preCommitGate || createManualBalanceSeedPlanFreshnessGate({
    assertContinuationFresh: additions.assertContinuationFresh || (async () => true),
    fs: additions.fs,
    platform: additions.platform
  });
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter,
    readRepository,
    resolveTargetPath,
    recoveryHoldGate,
    preCommitGate,
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC,
    now: () => new Date(NOW),
    ...additions
  });
  return {
    root,
    db,
    readRepository,
    requestOwnerRepository,
    observationAttemptRepository,
    recoveryControlRepository,
    transitionWriter,
    resolveTargetPath,
    recoveryHoldGate,
    preCommitGate,
    coordinator
  };
}

function createStartupForHarness(h) {
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(MANUAL_BALANCE_INSPECTOR_KEY, createManualBalanceSeedInspector({
    resolveTargetPath: h.resolveTargetPath,
    readRepository: h.readRepository
  }));
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(
    MANUAL_BALANCE_SETTLEMENT_KEY,
    createManualBalanceSettlementRecoveryProvider()
  );
  providerRegistry.freeze();
  return createStartupRecoveryCoordinator({
    readRepository: h.readRepository,
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository: h.requestOwnerRepository,
    observationAttemptRepository: h.observationAttemptRepository,
    recoveryControlRepository: h.recoveryControlRepository,
    resolvePolicy: (actionKey) => actionKey === MANUAL_BALANCE_ACTION_KEY
      ? manualBalanceRecoveryPolicy()
      : null,
    planTransitions: createManualBalanceRecoveryPlanTransitions(h.readRepository)
  });
}

function settlementInput(overrides = {}) {
  const taskRunId = overrides.taskRunId || 'task-manual-seed';
  const interactionOrdinal = overrides.interactionOrdinal || 1;
  const desiredRecords = overrides.records || [record({ endBalance: 1200 + interactionOrdinal })];
  const sourceRecords = desiredRecords.slice(0, -1).map((item) => ({ ...item }));
  const incoming = { ...desiredRecords[desiredRecords.length - 1] };
  delete incoming.updatedAt;
  const existingIndex = sourceRecords.findIndex((item) => (
    [item.merchantId, item.currency, item.billDate].join('|') ===
    [incoming.merchantId, incoming.currency, incoming.billDate].join('|')
  ));
  return {
    taskRunId,
    ...createManualBalanceOperationIdentity(taskRunId, interactionOrdinal),
    jobId: overrides.jobId || `job-manual-${interactionOrdinal}`,
    tokenIdHash: overrides.tokenIdHash || createHash('sha256').update(`token-${interactionOrdinal}`).digest('hex'),
    sessionRevision: overrides.sessionRevision ?? 3,
    plan: overrides.plan || {
      storageRoot: overrides.storageRoot || '',
      bankName: overrides.bankName || '中行',
      records: sourceRecords,
      recordsEvidence: balanceSeedRecordsEvidence(sourceRecords),
      existingIndex,
      record: incoming
    },
    ...(overrides.faultHooks ? { faultHooks: overrides.faultHooks } : {})
  };
}

function expectedRecords(input) {
  return materializeManualBalanceSeedPlan(input.plan, new Date(NOW)).records;
}

function targetAlias(input, options = {}) {
  return createManualBalanceTargetAlias(input.plan.bankName, options);
}

test('legacy与atomic共享唯一serializer，字段/排序/中文生成方式/尾换行逐字节等价', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-d-golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = [
    record({ merchantId: 'B', currency: 'USD', billDate: '2026-08-02', endBalance: 2 }),
    record({ merchantId: 'A', currency: 'CNY', billDate: '2026-08-01', endBalance: 1 })
  ];
  const filePath = writeBalanceSeedRecords(root, '中行', records);
  const legacy = fs.readFileSync(filePath, 'utf8');
  assert.equal(legacy, serializeBalanceSeedRecords(records));
  assert.equal(legacy.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(legacy).map((item) => item.merchantId), ['A', 'B']);
  assert.equal(JSON.parse(legacy)[0]['生成方式'], '人工录入');
  assert.deepEqual(readBalanceSeedRecords(root, '中行'), [
    record({ merchantId: 'A', currency: 'CNY', billDate: '2026-08-01', endBalance: 1 }),
    record({ merchantId: 'B', currency: 'USD', billDate: '2026-08-02', endBalance: 2 })
  ]);
});

test('TaskRun持久ordinal history：同token复用、新token递增、A/B/A旧token fail closed', () => {
  const db = openDb();
  const taskRunId = seedTask(db);
  const allocator = createManualBalanceInteractionOrdinalAllocator(db);
  const token1 = createHash('sha256').update('token-1').digest('hex');
  const token2 = createHash('sha256').update('token-2').digest('hex');
  const first = allocator.allocate({ taskRunId, tokenIdHash: token1 });
  const replay = allocator.allocate({ taskRunId, tokenIdHash: token1 });
  const second = allocator.allocate({ taskRunId, tokenIdHash: token2 });
  assert.throws(() => allocator.allocate({ taskRunId, tokenIdHash: token1 }), {
    code: 'MANUAL_BALANCE_TOKEN_STALE'
  });
  assert.deepEqual(first, replay);
  assert.equal(first.interactionOrdinal, 1);
  assert.equal(second.interactionOrdinal, 2);
  assert.equal(first.operationKey, `${taskRunId}/${MANUAL_BALANCE_ACTION_KEY}/1`);
  assert.equal(second.operationKey, `${taskRunId}/${MANUAL_BALANCE_ACTION_KEY}/2`);
  const metadata = JSON.parse(db.prepare(
    'SELECT metadata_json FROM archive_task_runs WHERE task_run_id = ?'
  ).get(taskRunId).metadata_json);
  assert.equal(metadata.statementManualBalanceOrdinal, 2);
  assert.deepEqual(metadata.statementManualBalanceCurrent, {
    tokenIdHash: token2,
    interactionOrdinal: 2
  });
  assert.deepEqual(metadata.statementManualBalanceOrdinalHistory, [
    { tokenIdHash: token1, interactionOrdinal: 1 },
    { tokenIdHash: token2, interactionOrdinal: 2 }
  ]);
  db.close();
});

test('TaskRun ordinal metadata类型/范围漂移fail closed且事务回滚', () => {
  const db = openDb();
  const taskRunId = seedTask(db, 'task-corrupt-ordinal');
  db.prepare('UPDATE archive_task_runs SET metadata_json = ? WHERE task_run_id = ?').run(
    JSON.stringify({ statementManualBalanceOrdinal: '1' }),
    taskRunId
  );
  const allocator = createManualBalanceInteractionOrdinalAllocator(db);
  assert.throws(() => allocator.allocate({
    taskRunId,
    tokenIdHash: createHash('sha256').update('token-corrupt').digest('hex')
  }), { code: 'MANUAL_BALANCE_TASK_METADATA_INVALID' });
  assert.equal(db.isTransaction, false);
  assert.equal(
    JSON.parse(db.prepare('SELECT metadata_json FROM archive_task_runs WHERE task_run_id = ?')
      .get(taskRunId).metadata_json).statementManualBalanceOrdinal,
    '1'
  );
  db.close();
});

test('TaskRun ordinal history拒绝重复token/ordinal与非单调映射', () => {
  const db = openDb();
  const taskRunId = seedTask(db, 'task-corrupt-history');
  const token1 = createHash('sha256').update('history-1').digest('hex');
  const token2 = createHash('sha256').update('history-2').digest('hex');
  db.prepare('UPDATE archive_task_runs SET metadata_json = ? WHERE task_run_id = ?').run(
    JSON.stringify({
      statementManualBalanceOrdinal: 2,
      statementManualBalanceCurrent: { tokenIdHash: token2, interactionOrdinal: 2 },
      statementManualBalanceOrdinalHistory: [
        { tokenIdHash: token1, interactionOrdinal: 1 },
        { tokenIdHash: token2, interactionOrdinal: 1 }
      ]
    }),
    taskRunId
  );
  assert.throws(() => createManualBalanceInteractionOrdinalAllocator(db).allocate({
    taskRunId,
    tokenIdHash: createHash('sha256').update('history-3').digest('hex')
  }), { code: 'MANUAL_BALANCE_TASK_METADATA_INVALID' });
  db.close();
});

test('no-op在Intent/critical前返回且不产生任何control event', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({
    storageRoot: h.root,
    records: [
      record({ endBalance: 1201 }),
      record({ endBalance: 1201 })
    ]
  });
  const targetPath = h.resolveTargetPath(targetAlias(input));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, serializeBalanceSeedRecords(expectedRecords(input)));
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'noop');
  assert.equal(result.intentId, null);
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
  assert.deepEqual(h.readRepository.listRecoveryEvents(input.taskRunId), []);
});

test('MainSettlementIntentCoordinator缺canonical Hold/freshness依赖时构造即fail closed', (t) => {
  const h = createHarness(t);
  const base = {
    transitionWriter: h.transitionWriter,
    readRepository: h.readRepository,
    resolveTargetPath: h.resolveTargetPath
  };
  assert.throws(() => createMainSettlementIntentCoordinator({
    ...base,
    preCommitGate: h.preCommitGate
  }), /canonical RecoveryHoldGate/);
  assert.throws(() => createMainSettlementIntentCoordinator({
    ...base,
    recoveryHoldGate: h.recoveryHoldGate
  }), /canonical manual balance freshness gate/);
});

test('awaited admission后noop target漂移由final preimage复核fail closed', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({
    storageRoot: h.root,
    records: [
      record({ endBalance: 1201 }),
      record({ endBalance: 1201 })
    ]
  });
  const target = h.resolveTargetPath(targetAlias(input));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeBalanceSeedRecords(expectedRecords(input)));
  let holdChecks = 0;
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter: h.transitionWriter,
    readRepository: h.readRepository,
    resolveTargetPath: h.resolveTargetPath,
    preCommitGate: h.preCommitGate,
    recoveryHoldGate: {
      assertNoRecoveryHold(scope) {
        h.recoveryHoldGate.assertNoRecoveryHold(scope);
        holdChecks += 1;
        if (holdChecks === 2) {
          fs.writeFileSync(target, serializeBalanceSeedRecords([
            record({ endBalance: 9999 })
          ]));
        }
        return true;
      }
    },
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC,
    now: () => new Date(NOW)
  });
  await assert.rejects(coordinator.settle(input), { code: 'MANUAL_BALANCE_PREIMAGE_STALE' });
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 9999);
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
});

test('canonical freshness gate拒绝stale plan并守恒并发新增seed record', async (t) => {
  let h;
  let injected = false;
  h = createHarness(t, {
    async assertContinuationFresh() {
      await Promise.resolve();
      if (injected) return;
      injected = true;
      writeBalanceSeedRecords(h.root, '中行', [
        record({ endBalance: 10 }),
        record({
          merchantId: 'concurrent-account',
          billDate: '2026-07-31',
          endBalance: 88
        })
      ]);
    }
  });
  writeBalanceSeedRecords(h.root, '中行', [record({ endBalance: 10 })]);
  const input = settlementInput({
    storageRoot: h.root,
    records: [record({ endBalance: 10 }), record({ endBalance: 20 })]
  });
  await assert.rejects(h.coordinator.settle(input), { code: 'MANUAL_BALANCE_PLAN_STALE' });
  const records = readBalanceSeedRecords(h.root, '中行');
  assert.equal(records.length, 2);
  assert.equal(records.some((item) => item.merchantId === 'concurrent-account'), true);
  assert.equal(records.find((item) => item.merchantId !== 'concurrent-account').endBalance, 10);
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
});

test('updatedAt只在await admission与final preimage后按commit attempt时钟materialize', async (t) => {
  const delayedNow = '2026-08-29T00:00:09.000Z';
  let admitted = false;
  let nowCalls = 0;
  const h = createHarness(t, {
    async assertContinuationFresh() {
      await Promise.resolve();
      admitted = true;
    },
    now() {
      assert.equal(admitted, true, 'now不得早于awaited admission');
      nowCalls += 1;
      return new Date(delayedNow);
    }
  });
  const result = await h.coordinator.settle(settlementInput({ storageRoot: h.root }));
  const intent = h.readRepository.getCriticalIntentById(result.intentId);
  assert.equal(nowCalls, 1);
  assert.equal(intent.boundedEvidence.commitUpdatedAt, delayedNow);
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].updatedAt, delayedNow);
});

test('async preCommit stale gate与persistent prepared request conflict均在no-op前fail closed', async (t) => {
  const stale = createHarness(t, {
    assertContinuationFresh: async () => {
      await Promise.resolve();
      throw Object.assign(new Error('stale'), { code: 'ACTION_TOKEN_STALE' });
    }
  });
  const noopInput = settlementInput({
    storageRoot: stale.root,
    records: [
      record({ endBalance: 1201 }),
      record({ endBalance: 1201 })
    ]
  });
  const noopTarget = stale.resolveTargetPath(targetAlias(noopInput));
  fs.mkdirSync(path.dirname(noopTarget), { recursive: true });
  fs.writeFileSync(noopTarget, serializeBalanceSeedRecords(expectedRecords(noopInput)));
  await assert.rejects(stale.coordinator.settle(noopInput), { code: 'ACTION_TOKEN_STALE' });
  assert.deepEqual(stale.readRepository.listRecoveryEvents(noopInput.taskRunId), []);

  const h = createHarness(t);
  let reserveOnly = true;
  const crashyWriter = {
    ...h.transitionWriter,
    write(transition, safePayload = {}) {
      if (reserveOnly && transition.entityKind === 'critical-intent' &&
          transition.command === 'create-prepared') {
        reserveOnly = false;
        h.requestOwnerRepository.reserveTransitionRequest({
          requestKey: transitionRequestKey(transition),
          transition,
          safePayload
        });
        throw Object.assign(new Error('crash after owner reservation'), { simulatedCrash: true });
      }
      return h.transitionWriter.write(transition, safePayload);
    }
  };
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter: crashyWriter,
    readRepository: h.readRepository,
    resolveTargetPath: h.resolveTargetPath,
    recoveryHoldGate: h.recoveryHoldGate,
    preCommitGate: h.preCommitGate,
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC,
    now: () => new Date(NOW)
  });
  const input = settlementInput({ storageRoot: h.root });
  await assert.rejects(coordinator.settle(input), { simulatedCrash: true });
  const conflictTarget = h.resolveTargetPath(targetAlias(input));
  fs.mkdirSync(path.dirname(conflictTarget), { recursive: true });
  fs.writeFileSync(conflictTarget, serializeBalanceSeedRecords(expectedRecords(input)));
  const noopRetry = settlementInput({
    storageRoot: h.root,
    records: [
      record({ endBalance: 1201 }),
      record({ endBalance: 1201 })
    ]
  });
  await assert.rejects(coordinator.settle(noopRetry), { code: 'RECOVERY_REQUEST_KEY_CONFLICT' });
  assert.deepEqual(h.readRepository.listRecoveryEvents(input.taskRunId), []);
});

test('non-noop只走Main-owned prepared/acked，durable post inspection后committed/closed', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({ storageRoot: h.root });
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'committed');
  assert.equal(result.inspection.outcome, 'committed');
  const intent = h.readRepository.getCriticalIntentById(result.intentId);
  assert.equal(intent.coordinationKind, 'main-owned-settlement');
  assert.equal(intent.state, 'closed');
  assert.deepEqual(readBalanceSeedRecords(h.root, '中行'), expectedRecords(input));
  const events = h.readRepository.listRecoveryEvents(input.taskRunId);
  assert.deepEqual(events.filter((item) => item.nextState !== null).map((item) => item.nextState), [
    'prepared', 'acked', 'committed', 'closed'
  ]);
  assert.equal(JSON.stringify(events).includes('critical:ready'), false);
  assert.equal(JSON.stringify(events).includes('critical:ack'), false);
});

test('temp/rename前失败保持pre并以not-committed recovered关闭；可用新ordinal重试', async (t) => {
  const h = createHarness(t);
  const target = getBalanceSeedFilePath(h.root, '中行');
  writeBalanceSeedRecords(h.root, '中行', [record({ endBalance: 10 })]);
  const original = fs.readFileSync(target);
  const input = settlementInput({
    storageRoot: h.root,
    records: [record({ endBalance: 10 }), record({ endBalance: 20 })],
    faultHooks: { beforeRename() { throw Object.assign(new Error('rename blocked'), { code: 'EIO' }); } }
  });
  let firstIntentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.code, 'MANUAL_BALANCE_ATOMIC_REPLACE_FAILED');
    assert.equal(error.settlementOutcome, 'not-committed');
    firstIntentId = error.intentId;
    return true;
  });
  assert.deepEqual(fs.readFileSync(target), original);
  const firstIntent = h.readRepository.getCriticalIntentById(firstIntentId);
  assert.equal(firstIntent.state, 'closed');
  const decidedReplay = await h.coordinator.settle(input);
  assert.equal(decidedReplay.status, 'not-committed');
  assert.equal(decidedReplay.replayed, true);
  assert.equal(decidedReplay.intentId, firstIntentId);
  assert.deepEqual(fs.readFileSync(target), original, 'recovered replay不得再次写target');
  const retry = await h.coordinator.settle(settlementInput({
    storageRoot: h.root,
    interactionOrdinal: 2,
    records: [record({ endBalance: 10 }), record({ endBalance: 20 })]
  }));
  assert.equal(retry.status, 'committed');
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 20);
});

test('directory fsync unsupported保持acked Intent并建立DURABILITY_BARRIER_UNAVAILABLE Hold', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' })
  });
  const input = settlementInput({ storageRoot: h.root });
  fs.mkdirSync(path.dirname(h.resolveTargetPath(targetAlias(input))), { recursive: true });
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'terminal-failure');
  assert.equal(result.errorCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(h.readRepository.getCriticalIntentById(result.intentId).state, 'acked');
  const holds = h.readRepository.listActiveRecoveryHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].reasonCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 1201);
});

test('active durability Hold经canonical gate阻止后续operation提交或覆盖target', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' })
  });
  const first = settlementInput({ storageRoot: h.root });
  fs.mkdirSync(path.dirname(h.resolveTargetPath(targetAlias(first))), { recursive: true });
  const failed = await h.coordinator.settle(first);
  assert.equal(failed.status, 'terminal-failure');
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
  const bytesBeforeRetry = fs.readFileSync(h.resolveTargetPath(targetAlias(first)));
  const second = settlementInput({
    storageRoot: h.root,
    taskRunId: 'task-held-scope-retry',
    records: [record({ endBalance: 1201 }), record({ endBalance: 1300 })]
  });
  await assert.rejects(h.coordinator.settle(second), { code: 'RECOVERY_HOLD_ACTIVE' });
  assert.deepEqual(fs.readFileSync(h.resolveTargetPath(targetAlias(first))), bytesBeforeRetry);
  assert.equal(h.readRepository.listOpenCriticalIntents().length, 1,
    'active Hold后不得创建第二Intent');
});

test('Hold reservation后control-tx崩溃由startup复用exact request并双启动幂等收口', async (t) => {
  const h = createHarness(t);
  const crash = Object.assign(new Error('crash after hold reservations'), {
    simulatedCrash: true
  });
  let controlTransactions = 0;
  const crashingControlRepository = {
    runInControlTransaction(work) {
      controlTransactions += 1;
      if (controlTransactions === 3) throw crash;
      return h.recoveryControlRepository.runInControlTransaction(work);
    }
  };
  const crashingWriter = createRecoveryTransitionWriter({
    requestOwnerRepository: h.requestOwnerRepository,
    observationAttemptRepository: h.observationAttemptRepository,
    recoveryControlRepository: crashingControlRepository
  });
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter: crashingWriter,
    readRepository: h.readRepository,
    resolveTargetPath: h.resolveTargetPath,
    recoveryHoldGate: h.recoveryHoldGate,
    preCommitGate: h.preCommitGate,
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' }),
    now: () => new Date(NOW)
  });
  const input = settlementInput({ storageRoot: h.root });
  fs.mkdirSync(path.dirname(h.resolveTargetPath(targetAlias(input))), { recursive: true });
  await assert.rejects(coordinator.settle(input), (error) => error === crash);
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0,
    'control transaction前Hold尚未可见');
  assert.equal(h.readRepository.listOpenCriticalIntents()[0].state, 'acked');

  const firstStartup = await createStartupForHarness(h).scanAndRecover();
  assert.equal(firstStartup.decisions[0].inspection.outcome, 'unknown');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 1);
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
  const secondStartup = await createStartupForHarness(h).scanAndRecover();
  assert.equal(secondStartup.decisions[0].inspection.outcome, 'unknown');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 1);
  assert.equal(h.readRepository.listOpenCriticalIntents()[0].state, 'acked');
});

test('首次创建target目录时先持久化parent entry；unsupported不写target并保持Intent/Hold', async (t) => {
  let fsyncCalls = 0;
  const h = createHarness(t, {
    fsyncDirectory: () => {
      fsyncCalls += 1;
      return Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' });
    }
  });
  const input = settlementInput({ storageRoot: h.root });
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'terminal-failure');
  assert.equal(result.errorCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(fsyncCalls, 1);
  assert.equal(fs.existsSync(h.resolveTargetPath(targetAlias(input))), false);
  assert.equal(h.readRepository.getCriticalIntentById(result.intentId).state, 'acked');
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
});

test('rename后的directory fsync error不能把exact post误报为durable committed', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => {
      throw new DurabilityBarrierError(
        'DURABILITY_DIRECTORY_FSYNC_FAILED',
        'simulated directory fsync failure',
        { errorCode: 'EIO' }
      );
    }
  });
  const input = settlementInput({ storageRoot: h.root });
  fs.mkdirSync(path.dirname(h.resolveTargetPath(targetAlias(input))), { recursive: true });
  let intentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.code, 'DURABILITY_DIRECTORY_FSYNC_FAILED');
    assert.equal(error.inspectionOutcome, 'unknown');
    assert.equal(error.settlementOutcome, 'unknown');
    intentId = error.intentId;
    return true;
  });
  assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'acked');
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
  assert.deepEqual(readBalanceSeedRecords(h.root, '中行'), expectedRecords(input));
});

test('target写入前parent-directory fsync error持久Hold且清理新目录，startup不得source-missing', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => {
      throw new DurabilityBarrierError(
        'DURABILITY_DIRECTORY_FSYNC_FAILED',
        'simulated parent directory fsync failure',
        { errorCode: 'EIO' }
      );
    }
  });
  const input = settlementInput({ storageRoot: h.root });
  let intentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.settlementOutcome, 'unknown');
    assert.equal(error.inspectionOutcome, 'unknown');
    intentId = error.intentId;
    return true;
  });
  assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'acked');
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(fs.existsSync(h.resolveTargetPath(targetAlias(input))), false);
  assert.equal(fs.existsSync(path.dirname(h.resolveTargetPath(targetAlias(input)))), false,
    'parent entry barrier失败不得遗留目录导致下次跳过');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const summary = await createStartupForHarness(h).scanAndRecover();
    assert.equal(summary.sourceCount, 1);
    assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'acked');
    assert.equal(h.readRepository.listActiveRecoveryHolds().length, 1);
  }
});

test('Inspector重读target，exact post/pre/neither分别committed/not-committed/unknown且证据有界', async (t) => {
  const h = createHarness(t);
  const alias = createManualBalanceTargetAlias('中行');
  const target = h.resolveTargetPath(alias);
  const preBytes = Buffer.from(serializeBalanceSeedRecords([record({ endBalance: 10 })]));
  const postBytes = Buffer.from(serializeBalanceSeedRecords([record({ endBalance: 20 })]));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const source = {
    contractVersion: 1,
    sourceKind: 'target-post-image',
    sourceRef: 'target-post-image:intent-inspector',
    actionKey: MANUAL_BALANCE_ACTION_KEY,
    operationKey: 'task-inspector/statement:resolve-manual-balance/1',
    taskRunId: 'task-inspector',
    conflictScopeKey: 'statement:manual-balance:inspector',
    inspectorKey: MANUAL_BALANCE_INSPECTOR_KEY,
    settlementKey: MANUAL_BALANCE_SETTLEMENT_KEY,
    intentId: 'intent-inspector',
    evidenceVersion: 1,
    boundedEvidence: {
      targetAliasKey: alias,
      pre: snapshotForBytes(preBytes),
      expectedPost: snapshotForBytes(postBytes),
      sessionRevision: 1,
      tokenIdHash: 'a'.repeat(64),
      interactionOrdinal: 1,
      planBindingHash: 'b'.repeat(64),
      commitUpdatedAt: NOW,
      durabilityBarrierRequired: true
    }
  };
  const inspector = createManualBalanceSeedInspector({ resolveTargetPath: h.resolveTargetPath });
  for (const [bytes, outcome] of [
    [postBytes, 'committed'],
    [preBytes, 'not-committed'],
    [Buffer.from('{}'), 'unknown']
  ]) {
    fs.writeFileSync(target, bytes);
    const result = await inspector(source, { durabilityBarrierCompleted: outcome === 'committed' });
    assert.equal(result.outcome, outcome);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 4096);
  }
});

test('live Inspector不可用时保留acked Intent并立即建立unknown Hold', async (t) => {
  const h = createHarness(t, {
    inspect: async () => {
      throw Object.assign(new Error('target read unavailable'), { code: 'EIO' });
    }
  });
  const input = settlementInput({ storageRoot: h.root });
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.code, 'EIO');
    assert.equal(error.settlementOutcome, 'unknown');
    assert.equal(h.readRepository.getCriticalIntentById(error.intentId).state, 'acked');
    assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
      'DURABILITY_BARRIER_UNAVAILABLE');
    return true;
  });
});

test('COMMIT后reply前crash已由canonical observation+Intent同事务收口，exact replay不重复seed', async (t) => {
  const h = createHarness(t);
  const crash = Object.assign(new Error('simulated process crash'), { simulatedCrash: true });
  await assert.rejects(h.coordinator.settle(settlementInput({
    storageRoot: h.root,
    faultHooks: { afterCommitBeforeReply() { throw crash; } }
  })), (error) => error === crash);
  const open = h.readRepository.listOpenCriticalIntents();
  assert.equal(open.length, 0);
  const target = getBalanceSeedFilePath(h.root, '中行');
  const committedBytes = fs.readFileSync(target);

  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(MANUAL_BALANCE_INSPECTOR_KEY, createManualBalanceSeedInspector({
    resolveTargetPath: h.resolveTargetPath,
    readRepository: h.readRepository
  }));
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.register(
    MANUAL_BALANCE_SETTLEMENT_KEY,
    createManualBalanceSettlementRecoveryProvider()
  );
  providerRegistry.freeze();
  const startup = createStartupRecoveryCoordinator({
    readRepository: h.readRepository,
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository: h.requestOwnerRepository,
    observationAttemptRepository: h.observationAttemptRepository,
    recoveryControlRepository: h.recoveryControlRepository,
    resolvePolicy: (actionKey) => actionKey === MANUAL_BALANCE_ACTION_KEY
      ? manualBalanceRecoveryPolicy()
      : null,
    planTransitions: createManualBalanceRecoveryPlanTransitions(h.readRepository)
  });
  const summary = await startup.scanAndRecover();
  assert.equal(summary.sourceCount, 0);
  assert.deepEqual(fs.readFileSync(target), committedBytes, 'startup不得重复写seed');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0);
  const replay = await h.coordinator.settle(settlementInput({ storageRoot: h.root }));
  assert.equal(replay.status, 'committed');
  assert.equal(replay.replayed, true);
  assert.deepEqual(fs.readFileSync(target), committedBytes, 'exact replay不得重复写seed');
});

test('rename/dir-fsync完成与canonical observation之间crash时startup仅unknown+Hold且可重复扫描', async (t) => {
  const h = createHarness(t);
  const crash = Object.assign(new Error('crash before canonical observation'), { simulatedCrash: true });
  const input = settlementInput({
    storageRoot: h.root,
    faultHooks: { afterDirectoryFsync() { throw crash; } }
  });
  await assert.rejects(h.coordinator.settle(input), (error) => error === crash);
  const intent = h.readRepository.listOpenCriticalIntents()[0];
  assert.equal(intent.state, 'acked');
  assert.deepEqual(readBalanceSeedRecords(h.root, '中行'), expectedRecords(input));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const summary = await createStartupForHarness(h).scanAndRecover();
    assert.equal(summary.sourceCount, 1);
    assert.equal(summary.decisions[0].inspection.outcome, 'unknown');
    assert.equal(h.readRepository.getCriticalIntentById(intent.intentId).state, 'acked');
    assert.equal(h.readRepository.listActiveRecoveryHolds().length, 1);
  }
});

test('post-image neither/rename后异常进入Hold，后续自动settlement不得覆盖未知target', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({
    storageRoot: h.root,
    faultHooks: {
      afterRename({ targetPath }) {
        fs.writeFileSync(targetPath, '{"foreign":true}\n');
        throw Object.assign(new Error('after rename fault'), { code: 'EIO' });
      }
    }
  });
  let intentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.settlementOutcome, 'unknown');
    intentId = error.intentId;
    return true;
  });
  assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'acked');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 1);
  assert.equal(fs.readFileSync(getBalanceSeedFilePath(h.root, '中行'), 'utf8'), '{"foreign":true}\n');
});

test('hold与业务preCommit阻断均发生在prepared前，不留下Intent或文件写入', async (t) => {
  for (const blocked of ['hold', 'preCommit']) {
    const h = createHarness(t, blocked === 'hold'
      ? {
          recoveryHoldGate: {
            assertNoRecoveryHold() {
              throw Object.assign(new Error('active hold'), { code: 'RECOVERY_HOLD_ACTIVE' });
            }
          }
        }
      : {
          assertContinuationFresh() {
            throw Object.assign(new Error('token stale'), { code: 'ACTION_TOKEN_STALE' });
          }
        });
    const input = settlementInput({ storageRoot: h.root, taskRunId: `task-${blocked}` });
    await assert.rejects(h.coordinator.settle(input), { code: blocked === 'hold'
      ? 'RECOVERY_HOLD_ACTIVE'
      : 'ACTION_TOKEN_STALE' });
    assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
    assert.equal(fs.existsSync(h.resolveTargetPath(targetAlias(input))), false);
  }
});

test('settlement identity拒绝字符串化ordinal/revision与空白身份，不做control mutation', async (t) => {
  const h = createHarness(t);
  for (const patch of [
    { interactionOrdinal: '1' },
    { sessionRevision: '3' },
    { jobId: ' job-manual-1' }
  ]) {
    const input = { ...settlementInput({ storageRoot: h.root }), ...patch };
    await assert.rejects(h.coordinator.settle(input), (error) => {
      assert.match(error.code, /^MANUAL_BALANCE_(OPERATION|SETTLEMENT)_IDENTITY_INVALID$/);
      return true;
    });
  }
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
});

test('同operation exact closed retry返回稳定已决结果；不同post-image在mutation前deterministic conflict', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({ storageRoot: h.root });
  const first = await h.coordinator.settle(input);
  assert.equal(first.status, 'committed');
  const retry = await h.coordinator.settle(input);
  assert.equal(retry.status, 'committed');
  assert.equal(retry.replayed, true);
  assert.equal(retry.intentId, first.intentId);

  const target = h.resolveTargetPath(targetAlias(input));
  const committedBytes = fs.readFileSync(target);
  const conflicting = settlementInput({
    storageRoot: h.root,
    records: [record({ endBalance: 9999 })]
  });
  await assert.rejects(h.coordinator.settle(conflicting), {
    code: 'MANUAL_BALANCE_OPERATION_CONFLICT'
  });
  assert.deepEqual(fs.readFileSync(target), committedBytes);
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0);
});

test('settlement只接受同一legacy plan绑定并以commit-time updatedAt生成兼容bytes', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({ storageRoot: h.root });
  await assert.rejects(h.coordinator.settle({ ...input, records: expectedRecords(input) }), {
    code: 'MANUAL_BALANCE_PLAN_BINDING_REQUIRED'
  });
  await assert.rejects(h.coordinator.settle({
    ...input,
    plan: { ...input.plan, recordsEvidence: 'tampered' }
  }), { code: 'BALANCE_SEED_PLAN_RECORDS_CHANGED' });
  await assert.rejects(h.coordinator.settle({
    ...input,
    plan: {
      ...input.plan,
      bankName: '工行'
    }
  }), { code: 'BALANCE_SEED_PLAN_BINDING_INVALID' });
  assert.deepEqual(h.readRepository.listRecoveryEvents(input.taskRunId), []);

  const result = await h.coordinator.settle(input);
  const persisted = readBalanceSeedRecords(h.root, '中行');
  assert.equal(persisted[0].updatedAt, NOW);
  assert.equal(
    fs.readFileSync(h.resolveTargetPath(targetAlias(input)), 'utf8'),
    serializeBalanceSeedRecords(expectedRecords(input)),
    'atomic settlement必须复用legacy serializer字节合同'
  );
  const intent = h.readRepository.getCriticalIntentById(result.intentId);
  assert.equal(intent.boundedEvidence.commitUpdatedAt, NOW);
  assert.equal(intent.boundedEvidence.planBindingHash.length, 64);
  assert.equal(JSON.stringify(intent.boundedEvidence).includes('6222'), false,
    'intent不得持久化原始账号');
});

test('async admission期间调用方篡改plan不能改变已绑定post-image', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({ storageRoot: h.root });
  const expected = serializeBalanceSeedRecords(expectedRecords(input));
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter: h.transitionWriter,
    readRepository: h.readRepository,
    resolveTargetPath: h.resolveTargetPath,
    recoveryHoldGate: h.recoveryHoldGate,
    preCommitGate: createManualBalanceSeedPlanFreshnessGate({
      async assertContinuationFresh() {
        await Promise.resolve();
        input.plan.record.endBalance = 9999;
        input.plan.record.currency = 'USD';
      }
    }),
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC,
    now: () => new Date(NOW)
  });
  const result = await coordinator.settle(input);
  assert.equal(result.status, 'committed');
  assert.equal(fs.readFileSync(h.resolveTargetPath(targetAlias(input)), 'utf8'), expected);
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].currency, 'CNY');
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 1201);
});

test('物理target alias可逆，Darwin同物理拼写共享scope，Windows NFD/ß不改写或误合并', async (t) => {
  const composed = 'ÉBANK';
  const decomposed = 'e\u0301bank';
  assert.notEqual(
    createManualBalanceTargetAlias(composed, { platform: 'darwin' }),
    createManualBalanceTargetAlias(decomposed, { platform: 'darwin' })
  );
  assert.notEqual(
    createManualBalanceTargetAlias('BANK', { platform: 'win32' }),
    createManualBalanceTargetAlias('bank', { platform: 'win32' })
  );
  assert.notEqual(
    createManualBalanceTargetAlias('ébank', { platform: 'win32' }),
    createManualBalanceTargetAlias('e\u0301bank', { platform: 'win32' })
  );
  assert.notEqual(
    createManualBalanceTargetAlias('straße', { platform: 'win32' }),
    createManualBalanceTargetAlias('STRASSE', { platform: 'win32' })
  );
  assert.equal(
    path.basename(resolveManualBalanceTargetAlias(
      'C:\\storage',
      createManualBalanceTargetAlias('e\u0301bank', { platform: 'win32' }),
      { platform: 'win32' }
    )),
    'e\u0301bank.json'
  );
  assert.equal(
    path.basename(resolveManualBalanceTargetAlias(
      'C:\\storage',
      createManualBalanceTargetAlias('straße', { platform: 'win32' }),
      { platform: 'win32' }
    )),
    'straße.json'
  );

  const h = createHarness(t, { platform: 'darwin' });
  const first = settlementInput({
    storageRoot: h.root,
    bankName: composed,
    records: [record({ templateName: `${composed}-上海`, endBalance: 10 })]
  });
  const second = settlementInput({
    storageRoot: h.root,
    taskRunId: 'task-alias-second',
    bankName: decomposed,
    records: [
      record({ templateName: `${composed}-上海`, endBalance: 10 }),
      record({ templateName: `${decomposed}-上海`, endBalance: 20 })
    ]
  });
  const firstResult = await h.coordinator.settle(first);
  const secondResult = await h.coordinator.settle(second);
  const firstIntent = h.readRepository.getCriticalIntentById(firstResult.intentId);
  const secondIntent = h.readRepository.getCriticalIntentById(secondResult.intentId);
  assert.equal(firstIntent.conflictScopeKey, secondIntent.conflictScopeKey);
  assert.equal(fs.readdirSync(path.join(h.root, 'balance-seeds')).length, 1,
    '物理同target不得因case/Unicode别名创建第二文件');
});

test('startup binding不复制production policy authority且target alias不携带账号/路径', () => {
  const recoveryBinding = manualBalanceRecoveryPolicy();
  assert.equal(Object.hasOwn(recoveryBinding, 'production'), false);
  assert.equal(recoveryBinding.commit.settlementKey, MANUAL_BALANCE_SETTLEMENT_KEY);
  const alias = createManualBalanceTargetAlias('中行');
  assert.equal(alias.includes('/'), false);
  assert.equal(alias.includes('6222'), false);
  assert.equal(resolveManualBalanceTargetAlias('/storage', alias), '/storage/balance-seeds/中行.json');
  assert.equal(
    createManualBalanceTargetAlias('A/B'),
    createManualBalanceTargetAlias('A-B'),
    '会落到同一文件名的银行名必须共享target alias/conflict scope'
  );
  assert.throws(() => createManualBalanceOperationIdentity('task', 0), {
    code: 'MANUAL_BALANCE_OPERATION_IDENTITY_INVALID'
  });
  assert.equal(targetSnapshot('/definitely/missing/manual-balance.json').exists, false);
});
