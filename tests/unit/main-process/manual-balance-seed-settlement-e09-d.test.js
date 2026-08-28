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
  MANUAL_BALANCE_ACTION_KEY,
  MANUAL_BALANCE_INSPECTOR_KEY,
  MANUAL_BALANCE_SETTLEMENT_KEY,
  createMainSettlementIntentCoordinator,
  createManualBalanceInteractionOrdinalAllocator,
  createManualBalanceOperationIdentity,
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
  const transitionWriter = createRecoveryTransitionWriter({
    requestOwnerRepository,
    recoveryControlRepository
  });
  const resolveTargetPath = (alias) => resolveManualBalanceTargetAlias(root, alias);
  const coordinator = createMainSettlementIntentCoordinator({
    transitionWriter,
    resolveTargetPath,
    fsyncDirectory: SUPPORTED_DIRECTORY_FSYNC,
    ...additions
  });
  return {
    root,
    db,
    readRepository,
    requestOwnerRepository,
    recoveryControlRepository,
    transitionWriter,
    resolveTargetPath,
    coordinator
  };
}

function settlementInput(overrides = {}) {
  const taskRunId = overrides.taskRunId || 'task-manual-seed';
  const interactionOrdinal = overrides.interactionOrdinal || 1;
  return {
    taskRunId,
    ...createManualBalanceOperationIdentity(taskRunId, interactionOrdinal),
    jobId: overrides.jobId || `job-manual-${interactionOrdinal}`,
    targetAliasKey: overrides.targetAliasKey || createManualBalanceTargetAlias('中行'),
    tokenIdHash: overrides.tokenIdHash || createHash('sha256').update(`token-${interactionOrdinal}`).digest('hex'),
    sessionRevision: overrides.sessionRevision ?? 3,
    records: overrides.records || [record({ endBalance: 1200 + interactionOrdinal })],
    ...(overrides.faultHooks ? { faultHooks: overrides.faultHooks } : {})
  };
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

test('TaskRun持久ordinal：同token transport recovery复用，新token顺序分配且operationKey不复用', () => {
  const db = openDb();
  const taskRunId = seedTask(db);
  const allocator = createManualBalanceInteractionOrdinalAllocator(db);
  const token1 = createHash('sha256').update('token-1').digest('hex');
  const token2 = createHash('sha256').update('token-2').digest('hex');
  const first = allocator.allocate({ taskRunId, tokenIdHash: token1 });
  const replay = allocator.allocate({ taskRunId, tokenIdHash: token1 });
  const second = allocator.allocate({ taskRunId, tokenIdHash: token2 });
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

test('no-op在Intent/critical前返回且不产生任何control event', async (t) => {
  const h = createHarness(t);
  const input = settlementInput();
  const targetPath = h.resolveTargetPath(input.targetAliasKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, serializeBalanceSeedRecords(input.records));
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'noop');
  assert.equal(result.intentId, null);
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
  assert.deepEqual(h.readRepository.listRecoveryEvents(input.taskRunId), []);
});

test('non-noop只走Main-owned prepared/acked，durable post inspection后committed/closed', async (t) => {
  const h = createHarness(t);
  const input = settlementInput();
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'committed');
  assert.equal(result.inspection.outcome, 'committed');
  const intent = h.readRepository.getCriticalIntentById(result.intentId);
  assert.equal(intent.coordinationKind, 'main-owned-settlement');
  assert.equal(intent.state, 'closed');
  assert.deepEqual(readBalanceSeedRecords(h.root, '中行'), input.records);
  const events = h.readRepository.listRecoveryEvents(input.taskRunId);
  assert.deepEqual(events.map((item) => item.nextState), [
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
    records: [record({ endBalance: 20 })],
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
  const retry = await h.coordinator.settle(settlementInput({
    interactionOrdinal: 2,
    records: [record({ endBalance: 20 })]
  }));
  assert.equal(retry.status, 'committed');
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 20);
});

test('directory fsync unsupported保持acked Intent并建立DURABILITY_BARRIER_UNAVAILABLE Hold', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' })
  });
  const input = settlementInput();
  fs.mkdirSync(path.dirname(h.resolveTargetPath(input.targetAliasKey)), { recursive: true });
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'terminal-failure');
  assert.equal(result.errorCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(h.readRepository.getCriticalIntentById(result.intentId).state, 'acked');
  const holds = h.readRepository.listActiveRecoveryHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].reasonCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(readBalanceSeedRecords(h.root, '中行')[0].endBalance, 1201);
});

test('首次创建target目录时先持久化parent entry；unsupported不写target并保持Intent/Hold', async (t) => {
  let fsyncCalls = 0;
  const h = createHarness(t, {
    fsyncDirectory: () => {
      fsyncCalls += 1;
      return Object.freeze({ capability: 'unsupported', errorCode: 'EPERM' });
    }
  });
  const input = settlementInput();
  const result = await h.coordinator.settle(input);
  assert.equal(result.status, 'terminal-failure');
  assert.equal(result.errorCode, 'DURABILITY_BARRIER_UNAVAILABLE');
  assert.equal(fsyncCalls, 1);
  assert.equal(fs.existsSync(h.resolveTargetPath(input.targetAliasKey)), false);
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
  const input = settlementInput();
  fs.mkdirSync(path.dirname(h.resolveTargetPath(input.targetAliasKey)), { recursive: true });
  let intentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.code, 'DURABILITY_DIRECTORY_FSYNC_FAILED');
    assert.equal(error.inspectionOutcome, 'committed');
    assert.equal(error.settlementOutcome, 'unknown');
    intentId = error.intentId;
    return true;
  });
  assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'acked');
  assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
    'DURABILITY_BARRIER_UNAVAILABLE');
  assert.deepEqual(readBalanceSeedRecords(h.root, '中行'), input.records);
});

test('target写入前parent-directory fsync error按exact pre收口not-committed', async (t) => {
  const h = createHarness(t, {
    fsyncDirectory: () => {
      throw new DurabilityBarrierError(
        'DURABILITY_DIRECTORY_FSYNC_FAILED',
        'simulated parent directory fsync failure',
        { errorCode: 'EIO' }
      );
    }
  });
  const input = settlementInput();
  let intentId;
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.settlementOutcome, 'not-committed');
    assert.equal(error.inspectionOutcome, 'not-committed');
    intentId = error.intentId;
    return true;
  });
  assert.equal(h.readRepository.getCriticalIntentById(intentId).state, 'closed');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0);
  assert.equal(fs.existsSync(h.resolveTargetPath(input.targetAliasKey)), false);
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
      interactionOrdinal: 1
    }
  };
  const inspector = createManualBalanceSeedInspector({ resolveTargetPath: h.resolveTargetPath });
  for (const [bytes, outcome] of [
    [postBytes, 'committed'],
    [preBytes, 'not-committed'],
    [Buffer.from('{}'), 'unknown']
  ]) {
    fs.writeFileSync(target, bytes);
    const result = await inspector(source);
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
  const input = settlementInput();
  await assert.rejects(h.coordinator.settle(input), (error) => {
    assert.equal(error.code, 'EIO');
    assert.equal(error.settlementOutcome, 'unknown');
    assert.equal(h.readRepository.getCriticalIntentById(error.intentId).state, 'acked');
    assert.equal(h.readRepository.listActiveRecoveryHolds()[0].reasonCode,
      'MANUAL_BALANCE_POST_IMAGE_UNKNOWN');
    return true;
  });
});

test('COMMIT后reply前crash由startup target-post-image重验收口，seed不重复且session要求重导', async (t) => {
  const h = createHarness(t);
  const crash = Object.assign(new Error('simulated process crash'), { simulatedCrash: true });
  await assert.rejects(h.coordinator.settle(settlementInput({
    faultHooks: { afterDirectoryFsync() { throw crash; } }
  })), (error) => error === crash);
  const open = h.readRepository.listOpenCriticalIntents();
  assert.equal(open.length, 1);
  assert.equal(open[0].state, 'acked');
  const target = getBalanceSeedFilePath(h.root, '中行');
  const committedBytes = fs.readFileSync(target);

  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(MANUAL_BALANCE_INSPECTOR_KEY, createManualBalanceSeedInspector({
    resolveTargetPath: h.resolveTargetPath
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
    observationAttemptRepository: createRecoveryObservationAttemptRepository(h.db),
    recoveryControlRepository: h.recoveryControlRepository,
    resolvePolicy: (actionKey) => actionKey === MANUAL_BALANCE_ACTION_KEY
      ? manualBalanceRecoveryPolicy()
      : null
  });
  const summary = await startup.scanAndRecover();
  assert.equal(summary.sourceCount, 1);
  assert.deepEqual(summary.decisions[0].boundedResult, {
    seedCommitted: true,
    sessionReimportRequired: true
  });
  assert.equal(h.readRepository.getCriticalIntentById(open[0].intentId).state, 'closed');
  assert.deepEqual(fs.readFileSync(target), committedBytes, 'startup不得重复写seed');
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0);
});

test('post-image neither/rename后异常进入Hold，后续自动settlement不得覆盖未知target', async (t) => {
  const h = createHarness(t);
  const input = settlementInput({
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
      ? { assertNoHold() { throw Object.assign(new Error('active hold'), { code: 'RECOVERY_HOLD_ACTIVE' }); } }
      : {});
    const input = settlementInput({ taskRunId: `task-${blocked}` });
    if (blocked === 'preCommit') {
      input.preCommitCheck = () => {
        throw Object.assign(new Error('token stale'), { code: 'ACTION_TOKEN_STALE' });
      };
    }
    await assert.rejects(h.coordinator.settle(input), { code: blocked === 'hold'
      ? 'RECOVERY_HOLD_ACTIVE'
      : 'ACTION_TOKEN_STALE' });
    assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
    assert.equal(fs.existsSync(h.resolveTargetPath(input.targetAliasKey)), false);
  }
});

test('settlement identity拒绝字符串化ordinal/revision与空白身份，不做control mutation', async (t) => {
  const h = createHarness(t);
  for (const patch of [
    { interactionOrdinal: '1' },
    { sessionRevision: '3' },
    { jobId: ' job-manual-1' }
  ]) {
    const input = { ...settlementInput(), ...patch };
    await assert.rejects(h.coordinator.settle(input), (error) => {
      assert.match(error.code, /^MANUAL_BALANCE_(OPERATION|SETTLEMENT)_IDENTITY_INVALID$/);
      return true;
    });
  }
  assert.deepEqual(h.readRepository.listOpenCriticalIntents(), []);
});

test('同operation exact retry由post-image no-op收口；不同post-image在mutation前deterministic conflict', async (t) => {
  const h = createHarness(t);
  const input = settlementInput();
  const first = await h.coordinator.settle(input);
  assert.equal(first.status, 'committed');
  const retry = await h.coordinator.settle(input);
  assert.equal(retry.status, 'noop');
  assert.equal(retry.intentId, null);

  const target = h.resolveTargetPath(input.targetAliasKey);
  const committedBytes = fs.readFileSync(target);
  await assert.rejects(h.coordinator.settle({
    ...input,
    records: [record({ endBalance: 9999 })]
  }), (error) => {
    assert.match(String(error.code || error.message), /RECOVERY|CONFLICT/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(target), committedBytes);
  assert.equal(h.readRepository.listActiveRecoveryHolds().length, 0);
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
