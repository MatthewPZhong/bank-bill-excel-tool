'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  createExecutionSupervisor
} = require('../../../src/main-process/background-execution/supervisor');
const {
  ensureBankBuReconTablesSupport,
  ensureBankBuReconRunsSideDbPath,
  ensureBankBuReconRunIdentitySupport
} = require('../../../src/backend/database/migrations');
const runDataStore = require('../../../src/backend/run-data-store');
const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('../../../src/backend/bank-bu-recon-db/columns');
const {
  buildImportEvidence
} = require('../../../src/main-process/bank-bu-worker/identity');
const {
  importCommittedDataset
} = require('../../../src/main-process/bank-bu-worker/side-database');
const {
  createBankBuMainCoordinator
} = require('../../../src/main-process/bank-bu-worker/main-coordinator');
const {
  BANK_BU_ACTIONS,
  bankBuPolicy
} = require('../../../src/main-process/bank-bu-worker/policies');
const {
  BANK_BU_SINGLETON_UNIT_ID
} = require('../../../src/main-process/bank-bu-worker/singleton-unit');

function pending() {
  const row = { _rowIndex: 2 };
  for (const column of PENDING_GUANLI_DB_COLUMNS) row[column] = '';
  row.recon_id = 'SUPERVISOR-1';
  row.finance_bu = 'BU-A';
  row.amount = '100';
  row.currency = 'USD';
  return row;
}

function bank() {
  const row = { _rowIndex: 2 };
  for (const column of BANK_DB_COLUMNS) row[column] = '';
  row.reconciliation_id = 'SUPERVISOR-1';
  row.remark_bu = 'bu-a';
  row.credit_amount = '100';
  row.currency = 'USD';
  return row;
}

function openMain(filePath) {
  const db = new DatabaseSync(filePath);
  ensureBankBuReconTablesSupport(db);
  ensureBankBuReconRunsSideDbPath(db);
  ensureBankBuReconRunIdentitySupport(db);
  db.exec(`
    CREATE TABLE e08_test_intents (
      intent_id TEXT PRIMARY KEY,
      action_key TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      task_run_id TEXT NOT NULL,
      state TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      receipt_json TEXT
    );
    CREATE TABLE e08_test_holds (
      intent_id TEXT PRIMARY KEY,
      detail_json TEXT NOT NULL
    );
  `);
  return db;
}

function seedMonth(userDataDir, yearMonth) {
  const pendingRows = [pending()];
  const bankRows = [bank()];
  const evidence = buildImportEvidence({
    yearMonth,
    pendingFileSha256: '1'.repeat(64),
    bankFileSha256: '2'.repeat(64),
    pendingRows,
    bankRows
  });
  importCommittedDataset({
    userDataDir,
    yearMonth,
    pendingRows,
    bankRows,
    evidence,
    operationIdentity: {
      actionKey: BANK_BU_ACTIONS.IMPORT_MONTH,
      operationKey: `bank-bu/import/${yearMonth}`,
      producerTaskRunId: `task-import-${yearMonth}`
    }
  });
  return evidence.datasetHash;
}

function mirrorCount(mainDb) {
  return mainDb.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count;
}

function sideRunCount(userDataDir) {
  const sideDb = runDataStore.openSideDb(
    userDataDir, runDataStore.MODULE_BANK_BU, '2026-08'
  );
  try {
    return sideDb.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count;
  } finally {
    sideDb.close();
  }
}

function assertPersistedCombinedReceipt(mainDb, receipt) {
  assert.ok(receipt && receipt.side);
  if (receipt.side.actionKey === BANK_BU_ACTIONS.IMPORT_MONTH) {
    assert.equal(receipt.main, null);
    return;
  }
  const mirror = mainDb.prepare('SELECT * FROM bank_bu_recon_runs').get();
  assert.ok(mirror, 'run commit receipt持久化前Main mirror必须已CAS COMMIT');
  assert.ok(receipt.main);
  assert.equal(receipt.main.operationKey, receipt.side.operationKey);
  assert.equal(receipt.main.sideRunId, receipt.side.sideRunId);
  assert.equal(receipt.main.mirrorId, Number(mirror.id));
  assert.equal(receipt.main.stableHash, mirror.stable_hash);
}

function assertTransportLossCommittedLifecycle(calls) {
  const intentIndexes = calls
    .map((entry, index) => entry.startsWith('intent:') ? index : -1)
    .filter((index) => index >= 0);
  const receiptIndexes = calls
    .map((entry, index) => entry.startsWith('receipt:') ? index : -1)
    .filter((index) => index >= 0);
  const closeIndexes = calls
    .map((entry, index) => entry.startsWith('close:') ? index : -1)
    .filter((index) => index >= 0);

  assert.deepEqual(intentIndexes, [0], 'transport-loss必须先且只持久一次Intent');
  assert.equal(receiptIndexes.length <= 1, true, 'wire receipt若可见只能持久一次');
  assert.deepEqual(closeIndexes, [calls.length - 1], 'committed close必须最终且只发生一次');
  assert.equal(calls[closeIndexes[0]], 'close:committed:mirror=1');
  if (receiptIndexes.length === 1) {
    assert.equal(receiptIndexes[0] > intentIndexes[0], true);
    assert.equal(receiptIndexes[0] < closeIndexes[0], true);
    assert.equal(calls[receiptIndexes[0]], 'receipt:mirror=1');
  }
  assert.equal(calls.includes('hold'), false);
}

function createIntentStore(mainDb, calls, isLocked, options = {}) {
  return {
    async persistCriticalIntent(evidence, metadata) {
      assert.equal(isLocked(), true);
      assert.equal(metadata.taskRunId, evidence.producerTaskRunId);
      const intentId = `intent:${metadata.operationKey}`;
      mainDb.prepare(`
        INSERT INTO e08_test_intents (
          intent_id,action_key,operation_key,task_run_id,state,evidence_json
        ) VALUES (?, ?, ?, ?, 'acked', ?)
      `).run(
        intentId, metadata.actionKey, metadata.operationKey,
        metadata.taskRunId, JSON.stringify(evidence)
      );
      calls.push(`intent:mirror=${mirrorCount(mainDb)}`);
      return { intentId };
    },
    async markCriticalCommitted(value) {
      assert.equal(isLocked(), true);
      assertPersistedCombinedReceipt(mainDb, value.receipt);
      mainDb.prepare(`
        UPDATE e08_test_intents SET state='committed', receipt_json=? WHERE intent_id=?
      `).run(JSON.stringify(value.receipt), value.intentId);
      calls.push(`receipt:mirror=${mirrorCount(mainDb)}`);
      if (options.failMarkAfterPersist) {
        throw Object.assign(new Error('模拟Main committed evidence响应丢失'), {
          code: 'E08_TEST_MARK_RESPONSE_LOST'
        });
      }
    },
    async closeCriticalIntent(value) {
      assert.equal(isLocked(), true);
      if (value.receipt) assertPersistedCombinedReceipt(mainDb, value.receipt);
      mainDb.prepare(`
        UPDATE e08_test_intents SET state='closed', receipt_json=? WHERE intent_id=?
      `).run(JSON.stringify(value.receipt), value.intentId);
      calls.push(`close:${value.outcome}:mirror=${mirrorCount(mainDb)}`);
    },
    async loadCriticalIntent(intentId) {
      const row = mainDb.prepare('SELECT * FROM e08_test_intents WHERE intent_id=?').get(intentId);
      return row ? {
        intentId: row.intent_id,
        actionKey: row.action_key,
        operationKey: row.operation_key,
        taskRunId: row.task_run_id,
        boundedEvidence: JSON.parse(row.evidence_json)
      } : null;
    },
    async createRecoveryHold(value) {
      assert.equal(isLocked(), true);
      mainDb.prepare(`
        INSERT OR REPLACE INTO e08_test_holds (intent_id,detail_json) VALUES (?, ?)
      `).run(value.intentId, JSON.stringify(value));
      calls.push('hold');
    }
  };
}

function createCoordinator(mainDb, userDataDir, calls, storeOptions = {}) {
  let locked = false;
  const store = createIntentStore(mainDb, calls, () => locked, storeOptions);
  return createBankBuMainCoordinator({
    mainDb,
    userDataDir,
    async withOperationLock(yearMonth, work) {
      assert.equal(yearMonth, '2026-08');
      assert.equal(locked, false);
      locked = true;
      try { return await work(); } finally { locked = false; }
    },
    ...store
  });
}

function createRegistry(entryPath) {
  const policy = bankBuPolicy(BANK_BU_ACTIONS.RUN);
  const entryRegistry = createStaticRegistry({ [policy.entryKey]: entryPath });
  const validatorRegistry = createStaticRegistry({
    [policy.result.validatorKey]: (value) => Boolean(
      value && value.status === 'ok' && value.operation === 'run' &&
      Number.isSafeInteger(value.sideRunId) && value.sideRunId > 0
    )
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const registry = createExecutionPolicyRegistry({
    policies: [policy],
    entryRegistry,
    validatorRegistry,
    staticKeys: {
      resourceProfileKeys: [policy.resources.profile],
      inspectorKeys: [policy.commit.inspectorKey],
      conflictScopeResolverKeys: [policy.commit.conflictScopeResolverKey]
    },
    generatedAt: '2026-08-28T00:00:00Z'
  });
  registry.freeze();
  return registry;
}

function operationContext(operationKey, taskRunId) {
  return {
    kind: 'operation',
    value: {
      taskRunId,
      taskKey: 'bankBuRecon:run',
      moduleId: 'bank-bu-recon',
      parentRunId: 'bank-bu-parent-run',
      operationKey
    }
  };
}

async function executeSupervisor({
  entryPath,
  coordinator,
  userDataDir,
  mainDatabasePath,
  failureMode = null,
  executionTimeoutMs = 5000
}) {
  const operationKey = `bank-bu/run/supervisor/${failureMode || 'success'}`;
  const taskRunId = `task-${failureMode || 'success'}`;
  const supervisor = createExecutionSupervisor({
    policyRegistry: createRegistry(entryPath),
    workerDurableCoordinator: coordinator,
    executionTimeoutMs
  });
  return supervisor.execute({
    actionKey: BANK_BU_ACTIONS.RUN,
    operationKey,
    jobId: `job-${failureMode || 'success'}`,
    workerInstanceId: `worker-${failureMode || 'success'}`,
    context: operationContext(operationKey, taskRunId),
    input: {},
    units: [{
      unitId: BANK_BU_SINGLETON_UNIT_ID,
      input: {
        userDataDir,
        yearMonth: '2026-08',
        ...(failureMode ? { failureMode, mainDatabasePath } : {})
      }
    }]
  });
}

function fixturePath(name) {
  return path.resolve(__dirname, name);
}

test('真实Supervisor+worker_threads singleton mutation完成intent→side→Main双identity settle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-supervisor-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = openMain(mainPath);
  const calls = [];
  try {
    const datasetHash = seedMonth(dir, '2026-08');
    const result = await executeSupervisor({
      entryPath: fixturePath('../../../src/main-process/bank-bu-worker/worker-entry.js'),
      coordinator: createCoordinator(mainDb, dir, calls),
      userDataDir: dir,
      mainDatabasePath: mainPath
    });
    assert.equal(result.outcome, 'completed');
    calls.push(`done:mirror=${mirrorCount(mainDb)}`);
    assert.deepEqual(calls, [
      'intent:mirror=0', 'receipt:mirror=1',
      'close:committed:mirror=1', 'done:mirror=1'
    ]);
    const mirror = mainDb.prepare('SELECT * FROM bank_bu_recon_runs').get();
    assert.equal(mirror.operation_key, 'bank-bu/run/supervisor/success');
    assert.ok(Number(mirror.side_run_id) > 0);
    assert.equal(mirror.input_evidence_hash, datasetHash);
    const intent = mainDb.prepare('SELECT * FROM e08_test_intents').get();
    assert.equal(intent.state, 'closed');
    const receipt = JSON.parse(intent.receipt_json);
    assert.equal(receipt.side.sideRunId, Number(mirror.side_run_id));
    assert.equal(receipt.main.mirrorId, Number(mirror.id));
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('import singleton coordinator在同月锁内持久ACK、验证side receipt并无Main mirror收口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-import-coordinator-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = openMain(mainPath);
  const calls = [];
  try {
    const pendingRows = [pending()];
    const bankRows = [bank()];
    const evidence = buildImportEvidence({
      yearMonth: '2026-08', pendingFileSha256: '3'.repeat(64),
      bankFileSha256: '4'.repeat(64), pendingRows, bankRows
    });
    const coordinator = createCoordinator(mainDb, dir, calls);
    const base = {
      policy: bankBuPolicy(BANK_BU_ACTIONS.IMPORT_MONTH),
      actionKey: BANK_BU_ACTIONS.IMPORT_MONTH,
      parentOperationKey: 'bank-bu/import/supervisor',
      taskRunId: 'task-import-supervisor',
      batchId: null,
      jobId: 'job-import-supervisor',
      workerInstanceId: 'worker-import-supervisor',
      unitId: BANK_BU_SINGLETON_UNIT_ID
    };
    const prepared = await coordinator.prepareAndAck({
      ...base,
      critical: {
        operationKind: 'import', yearMonth: '2026-08',
        inputEvidenceHash: evidence.datasetHash, pendingCount: 1, bankCount: 1
      }
    });
    const committed = importCommittedDataset({
      userDataDir: dir,
      yearMonth: '2026-08',
      pendingRows,
      bankRows,
      evidence,
      operationIdentity: {
        actionKey: base.actionKey,
        operationKey: base.parentOperationKey,
        producerTaskRunId: base.taskRunId
      }
    });
    await coordinator.observeReceipt({
      ...base,
      intentId: prepared.intentId,
      fileOperationKey: prepared.fileOperationKey,
      receipt: committed.receipt
    });
    await coordinator.settleCommitted({
      ...base,
      intentId: prepared.intentId,
      fileOperationKey: prepared.fileOperationKey,
      receiptHint: null,
      result: {
        status: 'ok', operation: 'import-month', yearMonth: '2026-08',
        pendingCount: 1, bankCount: 1, inputEvidenceHash: evidence.datasetHash,
        replay: false, receipt: committed.receipt
      }
    });
    assert.deepEqual(calls, [
      'intent:mirror=0', 'receipt:mirror=0', 'close:committed:mirror=0'
    ]);
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count, 0);
    const closed = mainDb.prepare('SELECT state,receipt_json FROM e08_test_intents').get();
    assert.equal(closed.state, 'closed');
    assert.equal(JSON.parse(closed.receipt_json).main, null);
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { mode: 'reply-loss', expectedHold: false },
  { mode: 'unknown-hold', expectedHold: true }
]) {
  test(`真实Supervisor side COMMIT后${scenario.mode}按Inspector收口`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bank-bu-e08-${scenario.mode}-`));
    const mainPath = path.join(dir, 'tool-data.sqlite');
    const mainDb = openMain(mainPath);
    const calls = [];
    try {
      seedMonth(dir, '2026-08');
      const result = await executeSupervisor({
        entryPath: fixturePath('fixtures/bank-bu-supervisor-loss-worker.js'),
        coordinator: createCoordinator(mainDb, dir, calls),
        userDataDir: dir,
        mainDatabasePath: mainPath,
        failureMode: scenario.mode
      });
      assert.equal(result.outcome, 'interrupted');
      assert.equal(calls.includes('intent:mirror=0'), true);
      assert.equal(calls.some((entry) => entry.startsWith('receipt:')), false,
        'reply丢失时不得伪造wire receipt');
      assert.equal(calls.includes('hold'), scenario.expectedHold);
      assert.equal(
        mainDb.prepare('SELECT COUNT(*) AS count FROM e08_test_holds').get().count,
        scenario.expectedHold ? 1 : 0
      );
      if (scenario.expectedHold) {
        assert.equal(mainDb.prepare(`
          SELECT COUNT(*) AS count FROM bank_bu_recon_runs WHERE side_db_rel_path='concurrent.sqlite'
        `).get().count, 1);
      } else {
        const mirror = mainDb.prepare('SELECT operation_key FROM bank_bu_recon_runs').get();
        assert.equal(mirror.operation_key, 'bank-bu/run/supervisor/reply-loss');
        assert.equal(calls.includes('close:committed:mirror=1'), true);
        assert.equal(sideRunCount(dir), 1, 'CAS前reply-loss恢复不得重跑算法或新增side run');
      }
    } finally {
      mainDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('真实Supervisor Main CAS后committed evidence响应丢失由Inspector幂等收口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-mark-loss-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = openMain(mainPath);
  const calls = [];
  try {
    seedMonth(dir, '2026-08');
    const result = await executeSupervisor({
      entryPath: fixturePath('../../../src/main-process/bank-bu-worker/worker-entry.js'),
      coordinator: createCoordinator(mainDb, dir, calls, { failMarkAfterPersist: true }),
      userDataDir: dir,
      mainDatabasePath: mainPath,
      failureMode: 'mark-response-loss'
    });
    assert.equal(result.outcome, 'interrupted');
    assert.deepEqual(calls, [
      'intent:mirror=0', 'receipt:mirror=1', 'close:committed:mirror=1'
    ]);
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM e08_test_holds').get().count, 0);
    assert.equal(sideRunCount(dir), 1, 'CAS后mark响应丢失恢复不得新增side run');
    const intent = mainDb.prepare('SELECT state,receipt_json FROM e08_test_intents').get();
    assert.equal(intent.state, 'closed');
    assertPersistedCombinedReceipt(mainDb, JSON.parse(intent.receipt_json));
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实Supervisor unit done transport丢失由Inspector committed收口且receipt事件可选', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-unit-done-loss-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = openMain(mainPath);
  const calls = [];
  try {
    seedMonth(dir, '2026-08');
    const result = await executeSupervisor({
      entryPath: fixturePath('fixtures/bank-bu-supervisor-loss-worker.js'),
      coordinator: createCoordinator(mainDb, dir, calls),
      userDataDir: dir,
      mainDatabasePath: mainPath,
      failureMode: 'unit-done-loss',
      executionTimeoutMs: 250
    });
    assert.equal(result.outcome, 'interrupted');
    assertTransportLossCommittedLifecycle(calls);
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM e08_test_holds').get().count, 0);
    const mirror = mainDb.prepare('SELECT * FROM bank_bu_recon_runs').get();
    assert.ok(mirror);
    assert.equal(mirror.operation_key, 'bank-bu/run/supervisor/unit-done-loss');
    assert.equal(mirror.producer_task_run_id, 'task-unit-done-loss');

    const intent = mainDb.prepare('SELECT state,receipt_json FROM e08_test_intents').get();
    assert.equal(intent.state, 'closed');
    const combinedReceipt = JSON.parse(intent.receipt_json);
    assertPersistedCombinedReceipt(mainDb, combinedReceipt);

    const sideDb = runDataStore.openSideDb(
      dir, runDataStore.MODULE_BANK_BU, '2026-08'
    );
    try {
      const sideRun = sideDb.prepare('SELECT * FROM bank_bu_recon_runs').get();
      const sideReceipt = sideDb.prepare(`
        SELECT * FROM bank_bu_operation_receipts
        WHERE action_key='bank-bu:run'
      `).get();
      assert.ok(sideRun);
      assert.ok(sideReceipt);
      assert.equal(sideReceipt.operation_key, 'bank-bu/run/supervisor/unit-done-loss');
      assert.equal(sideReceipt.producer_task_run_id, 'task-unit-done-loss');
      assert.equal(Number(sideReceipt.side_run_id), Number(sideRun.id));
      assert.equal(sideRun.operation_key, sideReceipt.operation_key);
      assert.equal(sideRun.producer_task_run_id, sideReceipt.producer_task_run_id);
      assert.equal(sideRun.input_evidence_hash, sideReceipt.input_evidence_hash);
      assert.equal(combinedReceipt.side.sideRunId, Number(sideRun.id));
      assert.equal(combinedReceipt.side.operationKey, sideReceipt.operation_key);
      assert.equal(combinedReceipt.side.inputEvidenceHash, sideReceipt.input_evidence_hash);
    } finally {
      sideDb.close();
    }
    assert.equal(sideRunCount(dir), 1, 'transport-loss恢复不得重跑算法或新增side run');
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
