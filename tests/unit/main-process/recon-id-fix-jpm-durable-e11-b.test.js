'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../../src/backend/database');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const legacyLinkedRepository = require('../../../src/backend/database/linked-table-repository');
const receiptRepository = require('../../../src/backend/database/recon-fix-operation-receipt-repository');
const {
  readAdmRowsForWriteback
} = require('../../../src/backend/database/linked-table-writeback-reader');
const {
  CHANNEL_BILL_FIELDS,
  CHANNEL_BILL_SHEET_NAME,
  GATEWAY_BILL_FIELDS,
  GATEWAY_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS_GATEWAY,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../../src/constants/gateway-bill-recon-fields');
const {
  ADM_MERCHANT_ID,
  FIELD_MAP
} = require('../../../src/constants/adm-bank-deposit-fields');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
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
  createRecoveryHoldGate
} = require('../../../src/main-process/background-execution/recovery-hold-gate');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../../src/main-process/background-execution/startup-recovery-coordinator');
const {
  createWorkerDurableCoordinatorRouter
} = require('../../../src/main-process/background-execution/worker-durable-coordinator-router');
const {
  deriveReconFixJpmConflictScopeKey
} = require('../../../src/main-process/recon-id-fix-service/jpm-conflict-scope');
const {
  createReconFixJpmHoldGate
} = require('../../../src/main-process/recon-id-fix-service/jpm-hold-gate');
const {
  createReconFixJpmOutcomeInspector
} = require('../../../src/main-process/recon-id-fix-service/jpm-outcome-inspector');
const {
  createReconFixJpmReceiptAuthority
} = require('../../../src/main-process/recon-id-fix-service/jpm-receipt-authority');
const {
  reconFixJpmRecoveryPlanTransitions
} = require('../../../src/main-process/recon-id-fix-service/jpm-recovery-plan');
const {
  createReconFixJpmWorkerDurableCoordinator
} = require('../../../src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_JPM_POLICY,
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_RUN_JPM_ACTION,
  validateReconFixJpmResult,
  validateReconFixServiceResult
} = require('../../../src/main-process/recon-id-fix-service/policies');
const {
  runJpmDispatchOrderFix
} = require('../../../src/main-process/scenario-engines/jpm-dispatch-order-fix');

const tempRoots = [];
test.after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-jpm-e11-b-'));
  tempRoots.push(root);
  return root;
}

const SCENARIO = Object.freeze({
  id: 99,
  name: 'JPM调拨订单修复',
  category: 'gateway-recon-id-fix',
  config: Object.freeze({
    subCategory: 'jpm-dispatch-order-fix',
    merchantId: ADM_MERCHANT_ID
  })
});

function admRow(overrides = {}) {
  return {
    MerchantId: ADM_MERCHANT_ID,
    Currency: 'USD',
    Amount: 100,
    BillDate: '2026-05-04',
    ChannelOrderNo: 'CO1',
    CustomerRef: 'CUSTOMER-1',
    [FIELD_MAP.admBatchNo]: '2026-05-04-CO1',
    [FIELD_MAP.admAllocationNo]: 'A1',
    [FIELD_MAP.admFundtransferInAmount]: 100,
    [FIELD_MAP.admReconFundId]: overrides.reconFundId || '',
    [FIELD_MAP.admChannelMatched]: overrides.channelMatched === undefined
      ? 0
      : overrides.channelMatched,
    [FIELD_MAP.admGatewayMatched]: overrides.gatewayMatched === undefined
      ? 0
      : overrides.gatewayMatched
  };
}

function appendSheet(workbook, name, fields, rows = []) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    fields.slice(),
    ...rows.map((row) => fields.map((field) => row[field] ?? ''))
  ]), name);
}

function writeGatewayWorkbook(filePath, options = {}) {
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, RECON_RESULT_FIELDS_GATEWAY);
  appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS,
    options.gatewayRows === undefined ? [{
      MerchantId: ADM_MERCHANT_ID,
      OrderId: 'A1',
      Amount: 100
    }] : options.gatewayRows);
  appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS,
    options.channelRows === undefined ? [{
      merchantId: ADM_MERCHANT_ID,
      reconciliationId: 'RID-E11-B',
      receiveAmount: 100,
      additionInfo: 'ATS OF 26/05/04'
    }] : options.channelRows);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function operationContext(operationKey, taskRunId = `task-${operationKey}`) {
  return {
    kind: 'operation',
    value: {
      taskRunId,
      taskKey: 'recon-id-fix:run',
      moduleId: 'recon-fix',
      parentRunId: 'parent-e11-b',
      operationKey
    }
  };
}

function createAdapterCapture() {
  const base = createWorkerThreadAdapter();
  const messages = [];
  return {
    messages,
    adapter: Object.freeze({
      kind: base.kind,
      start(options) {
        return base.start({
          ...options,
          onMessage(message) {
            messages.push(structuredClone(message));
            options.onMessage(message);
          }
        });
      }
    })
  };
}

function createCrashAfterCommitCapture() {
  const base = createWorkerThreadAdapter();
  const messages = [];
  let crashed = false;
  return {
    messages,
    adapter: Object.freeze({
      kind: base.kind,
      start(options) {
        let handle;
        handle = base.start({
          ...options,
          onMessage(message) {
            messages.push(structuredClone(message));
            if (!crashed && message.channel === 'job' && message.direction === 'event' &&
                message.actionKey === RECON_FIX_RUN_JPM_ACTION &&
                message.operation === 'commit:receipt') {
              crashed = true;
              void handle.worker.terminate();
              return;
            }
            if (!crashed) options.onMessage(message);
          }
        });
        return handle;
      }
    })
  };
}

function createPausedCriticalAckCapture() {
  const base = createWorkerThreadAdapter();
  const messages = [];
  const commands = [];
  let paused = null;
  let activeHandle = null;
  let resolvePaused;
  const criticalAckPaused = new Promise((resolve) => { resolvePaused = resolve; });
  return {
    messages,
    commands,
    criticalAckPaused,
    releaseCriticalAck() {
      assert.ok(paused, 'critical:ack must be paused before release');
      const release = paused;
      paused = null;
      release.handle.send(release.message, release.transferList);
    },
    terminateWorker() {
      assert.ok(activeHandle, 'worker must exist before termination');
      return activeHandle.worker.terminate();
    },
    adapter: Object.freeze({
      kind: base.kind,
      start(options) {
        const handle = base.start({
          ...options,
          onMessage(message) {
            messages.push(structuredClone(message));
            options.onMessage(message);
          }
        });
        activeHandle = handle;
        return Object.freeze({
          ready: handle.ready,
          worker: handle.worker,
          send(message, transferList) {
            commands.push(structuredClone(message));
            if (!paused && message.channel === 'job' && message.direction === 'command' &&
                message.actionKey === RECON_FIX_RUN_JPM_ACTION &&
                message.operation === 'critical:ack') {
              paused = { handle, message, transferList };
              resolvePaused(message);
              return;
            }
            handle.send(message, transferList);
          },
          close() { return handle.close(); },
          terminate() { return handle.terminate(); }
        });
      }
    })
  };
}

function createPausedCriticalReadyCapture() {
  const base = createWorkerThreadAdapter();
  const messages = [];
  let paused = null;
  let resolvePaused;
  const criticalReadyPaused = new Promise((resolve) => { resolvePaused = resolve; });
  return {
    messages,
    criticalReadyPaused,
    releaseCriticalReady() {
      assert.ok(paused, 'critical:ready must be paused before release');
      const release = paused;
      paused = null;
      release.onMessage(release.message);
    },
    adapter: Object.freeze({
      kind: base.kind,
      start(options) {
        return base.start({
          ...options,
          onMessage(message) {
            messages.push(structuredClone(message));
            if (!paused && message.channel === 'job' && message.direction === 'event' &&
                message.actionKey === RECON_FIX_RUN_JPM_ACTION &&
                message.operation === 'critical:ready') {
              paused = { onMessage: options.onMessage, message };
              resolvePaused(message);
              return;
            }
            options.onMessage(message);
          }
        });
      }
    })
  };
}

function createHarness(options = {}) {
  const root = tempRoot();
  const databasePath = path.join(root, 'tool-data.sqlite');
  const workbookPath = writeGatewayWorkbook(path.join(root, 'gateway.xlsx'), options.workbook);
  const database = new AppDatabase(databasePath);
  database.init();
  legacyLinkedRepository.replaceAdmBankDeposit(database.db, options.admRows || [admRow()]);

  const readRepository = createRecoveryControlReadRepository(database.db);
  const requestOwnerRepository = createRecoveryRequestOwnerRepository(database.db);
  const baseRecoveryControlRepository = createRecoveryControlRepository(database.db);
  const recoveryControlRepository = options.wrapRecoveryControlRepository
    ? options.wrapRecoveryControlRepository(baseRecoveryControlRepository)
    : baseRecoveryControlRepository;
  const inspector = createReconFixJpmOutcomeInspector({ databasePath });
  const inspectors = createInspectorRegistry();
  inspectors.register(RECON_FIX_JPM_POLICY.commit.inspectorKey, inspector);
  inspectors.freeze();
  const providers = createSettlementRecoveryProviderRegistry();
  providers.freeze();
  const recoveryCoordinator = createStartupRecoveryCoordinator({
    readRepository,
    inspectorRegistry: inspectors,
    providerRegistry: providers,
    requestOwnerRepository,
    observationAttemptRepository: createRecoveryObservationAttemptRepository(database.db),
    recoveryControlRepository,
    resolvePolicy: () => RECON_FIX_JPM_POLICY,
    planTransitions: options.planTransitions || (() => []),
    transientAttempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0
  });
  const holdGate = createReconFixJpmHoldGate({
    recoveryHoldGate: createRecoveryHoldGate(readRepository)
  });
  const baseAuthority = createReconFixJpmReceiptAuthority({
    databasePath,
    outcomeInspector: inspector
  });
  const authority = options.wrapAuthority ? options.wrapAuthority(baseAuthority) : baseAuthority;
  const durable = createReconFixJpmWorkerDurableCoordinator({
    readRepository,
    requestOwnerRepository,
    recoveryControlRepository,
    recoveryCoordinator,
    receiptAuthority: authority,
    conflictScopeGate: () => holdGate.assertMutationAllowed()
  });
  const router = createWorkerDurableCoordinatorRouter({
    [RECON_FIX_RUN_JPM_ACTION]: durable
  });
  const capture = options.capture || createAdapterCapture();
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    workerDurableCoordinator: router,
    workerThreadAdapter: capture.adapter,
    shutdownTimeoutMs: 10000
  });
  return {
    root,
    databasePath,
    workbookPath,
    database,
    readRepository,
    recoveryCoordinator,
    holdGate,
    inspector,
    authority,
    durable,
    runtime,
    messages: capture.messages
  };
}

async function importSession(harness) {
  const operationKey = `import-${path.basename(harness.root)}`;
  const result = await harness.runtime.execute({
    actionKey: RECON_FIX_IMPORT_ACTION,
    operationKey,
    context: operationContext(operationKey),
    input: {
      expectedRevision: 0,
      filePath: harness.workbookPath,
      subMode: 'gateway'
    }
  });
  assert.equal(result.outcome, 'completed', JSON.stringify(result));
  return result.result.revision;
}

async function runManagedJpm(harness, operationKey, expectedRevision = 1) {
  return harness.runtime.execute({
    actionKey: RECON_FIX_RUN_JPM_ACTION,
    operationKey,
    context: operationContext(operationKey),
    input: {
      expectedRevision,
      databasePath: harness.databasePath,
      scenario: SCENARIO
    }
  });
}

function seedRunningReconTask(harness, operationKey) {
  const taskRunId = `task-${operationKey}`;
  const archive = createArchiveRepository(harness.database.db);
  archive.ensureSchema();
  archive.beginTaskRun({
    taskRunId,
    moduleId: 'recon-fix',
    taskKey: 'recon-id-fix:run',
    operationKey,
    parentRunId: 'parent-e11-b-recovery'
  });
  archive.transitionTaskRun(taskRunId, 'running', { expectedStatuses: ['prepared'] });
  return { archive, taskRunId };
}

test('JPM canonical policy保持production false，runtime固定single unit且禁止caller override', async () => {
  assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_RUN_JPM_ACTION), false);
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(RECON_FIX_JPM_POLICY, fixture[RECON_FIX_RUN_JPM_ACTION]);
  const jpmResult = {
    resultKind: 'noop',
    resultHandle: '1'.repeat(64),
    boundedSummary: {
      runKind: 'jpm', fixedRowCount: 0, warningCount: 0,
      unmatchedRowCount: 0, resultDigest: '2'.repeat(64)
    }
  };
  assert.equal(validateReconFixJpmResult(jpmResult), true);
  assert.equal(validateReconFixServiceResult(jpmResult), false);
  const harness = createHarness();
  try {
    await importSession(harness);
    assert.throws(() => harness.runtime.start({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey: 'caller-unit-override',
      context: operationContext('caller-unit-override'),
      units: [{ unitId: 'caller-controlled', input: {} }],
      input: { expectedRevision: 1, databasePath: harness.databasePath, scenario: SCENARIO }
    }), { code: 'UNIT_REGISTRATION_OVERRIDE_FORBIDDEN' });
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('managed JPM mutation按ACK→同事务receipt→authority gate→adopt收口且payload有界', async () => {
  const harness = createHarness();
  try {
    await importSession(harness);
    const result = await runManagedJpm(harness, 'jpm-mutation-e11-b');
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(result.result.resultKind, 'committed');
    assert.match(result.result.resultHandle, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(result.result, 'fixedRows'), false);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-mutation-e11-b'
    ).producerTaskRunId, 'task-jpm-mutation-e11-b');
    assert.equal(readAdmRowsForWriteback(harness.database.db).rows[0]
      .parsed[FIELD_MAP.admReconFundId], 'RID-E11-B');
    const intent = harness.readRepository.getCriticalIntentByOperation(
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-mutation-e11-b',
      'task-jpm-mutation-e11-b'
    );
    assert.equal(intent.state, 'closed');

    const events = harness.messages.filter((message) => message.channel === 'job' &&
      message.direction === 'event' && message.actionKey === RECON_FIX_RUN_JPM_ACTION);
    assert.deepEqual(events.map((event) => event.operation), [
      'critical:ready', 'commit:receipt', 'unit:done', 'job:done'
    ]);
    assert.ok(events.filter((event) => [
      'critical:ready', 'commit:receipt', 'unit:done', 'job:done'
    ].includes(event.operation)).every((event) =>
      !/fixedRows|unmatchedRows|admUpdates|rawJsonText|databasePath/.test(JSON.stringify(event))));
    assert.ok(events.every((event) => event.unitId === RECON_FIX_JPM_UNIT_ID ||
      event.operation === 'job:done'));

    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: RECON_FIX_JPM_POLICY,
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      parentOperationKey: 'jpm-mutation-e11-b',
      taskRunId: 'task-jpm-mutation-e11-b',
      batchId: null,
      jobId: 'replay-job-e11-b',
      workerInstanceId: 'replay-worker-e11-b',
      unitId: RECON_FIX_JPM_UNIT_ID,
      critical: events[0].payload.critical
    }), { code: 'RECON_FIX_JPM_OPERATION_ALREADY_COMMITTED' });
    assert.equal(readAdmRowsForWriteback(harness.database.db).rows[0]
      .parsed[FIELD_MAP.admReconFundId], 'RID-E11-B');

    const replay = await runManagedJpm(harness, 'jpm-mutation-e11-b', 2);
    assert.notEqual(replay.outcome, 'completed');
    const freshNoop = await runManagedJpm(harness, 'jpm-fresh-noop-after-replay', 2);
    assert.equal(freshNoop.outcome, 'completed', JSON.stringify(freshNoop));
    assert.equal(freshNoop.result.resultKind, 'noop');
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('exact noop不创建Intent/transaction/receipt，只采用bounded result', async () => {
  const harness = createHarness({
    admRows: [admRow({ reconFundId: 'RID-E11-B', channelMatched: 1, gatewayMatched: 1 })]
  });
  try {
    const before = readAdmRowsForWriteback(harness.database.db);
    await importSession(harness);
    const result = await runManagedJpm(harness, 'jpm-noop-e11-b');
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(result.result.resultKind, 'noop');
    assert.equal(harness.readRepository.listOpenCriticalIntents().length, 0);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-noop-e11-b'
    ), null);
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, before.imageHash);
    const operations = harness.messages.filter((message) =>
      message.channel === 'job' && message.actionKey === RECON_FIX_RUN_JPM_ACTION)
      .map((message) => message.operation);
    assert.deepEqual(operations, ['unit:done', 'job:done']);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('stale revision在critical前fail closed且不触碰ADM/Intent/receipt', async () => {
  const harness = createHarness();
  try {
    const before = readAdmRowsForWriteback(harness.database.db);
    await importSession(harness);
    const result = await runManagedJpm(harness, 'jpm-stale-revision', 0);
    assert.notEqual(result.outcome, 'completed');
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, before.imageHash);
    assert.deepEqual(harness.readRepository.listOpenCriticalIntents(), []);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-stale-revision'
    ), null);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('authority拒绝commit receipt时resource adoption gate不grant full candidate', async () => {
  const harness = createHarness({
    wrapAuthority(base) {
      return {
        find: base.find,
        async verify() {
          throw Object.assign(new Error('injected receipt mismatch'), {
            code: 'RECON_FIX_JPM_RECEIPT_IDENTITY_CONFLICT'
          });
        }
      };
    }
  });
  try {
    await importSession(harness);
    const result = await runManagedJpm(harness, 'jpm-authority-reject');
    assert.notEqual(result.outcome, 'completed');
    assert.ok(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-authority-reject'
    ));
    const controls = harness.messages.filter((message) => message.channel === 'service-control' &&
      message.jobRef && message.jobRef.actionKey === RECON_FIX_RUN_JPM_ACTION);
    assert.equal(controls.some((message) => message.operation === 'resource:adopted'), false);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('receipt-first Inspector覆盖pre/post-without-receipt/committed/bad-json并保留WAL family', async () => {
  const harness = createHarness();
  try {
    const before = readAdmRowsForWriteback(harness.database.db);
    const engine = runJpmDispatchOrderFix({
      scenario: SCENARIO,
      admRows: before.rows.map((row) => row.parsed),
      sheets: {
        opponentBills: [{
          merchantId: ADM_MERCHANT_ID,
          reconciliationId: 'RID-E11-B',
          receiveAmount: 100,
          additionInfo: 'ATS OF 26/05/04'
        }],
        businessBills: [{ MerchantId: ADM_MERCHANT_ID, OrderId: 'A1', Amount: 100 }]
      }
    });
    const postJson = JSON.stringify(engine.admUpdates[0]);
    const postHashDb = new DatabaseSync(harness.databasePath);
    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1').run(postJson);
    const post = readAdmRowsForWriteback(postHashDb);
    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
      .run(before.rows[0].rawJsonText);
    postHashDb.exec('PRAGMA journal_mode = WAL');
    postHashDb.exec('PRAGMA wal_autocheckpoint = 0');

    const boundedEvidence = {
      scenarioId: String(SCENARIO.id),
      preImageHash: before.imageHash,
      postImageHash: post.imageHash,
      idSequenceDigest: before.idSequenceDigest,
      rowCount: before.rowCount,
      changedRowCount: 1,
      resultHandle: 'a'.repeat(64),
      boundedSummary: {
        runKind: 'jpm', fixedRowCount: 1, warningCount: 0,
        unmatchedRowCount: 0, resultDigest: 'b'.repeat(64)
      }
    };
    const source = {
      contractVersion: 1,
      sourceKind: 'critical-intent',
      sourceRef: 'critical-intent:inspector-matrix',
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey: 'inspector-matrix',
      taskRunId: 'task-inspector-matrix',
      conflictScopeKey: deriveReconFixJpmConflictScopeKey(),
      inspectorKey: RECON_FIX_JPM_POLICY.commit.inspectorKey,
      settlementKey: null,
      intentId: 'intent-inspector-matrix',
      evidenceVersion: 1,
      boundedEvidence
    };

    assert.equal((await harness.inspector(source)).outcome, 'not-committed');
    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1').run(postJson);
    assert.equal((await harness.inspector(source)).outcome, 'unknown');

    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
      .run(before.rows[0].rawJsonText);
    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET id = 2 WHERE id = 1').run();
    const changedId = await harness.inspector(source);
    assert.equal(changedId.outcome, 'unknown');
    assert.notEqual(changedId.boundedEvidence.currentIdSequenceDigest, before.idSequenceDigest);
    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET id = 1 WHERE id = 2').run();

    postHashDb.exec('BEGIN IMMEDIATE');
    try {
      postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
        .run(postJson);
      receiptRepository.insertOperationReceipt(postHashDb, {
        actionKey: RECON_FIX_RUN_JPM_ACTION,
        operationKey: source.operationKey,
        producerTaskRunId: source.taskRunId,
        scenarioId: boundedEvidence.scenarioId,
        preImageHash: boundedEvidence.preImageHash,
        postImageHash: boundedEvidence.postImageHash,
        idSequenceDigest: boundedEvidence.idSequenceDigest,
        rowCount: boundedEvidence.rowCount,
        changedRowCount: boundedEvidence.changedRowCount
      });
      postHashDb.exec('COMMIT');
    } catch (error) {
      if (postHashDb.isTransaction) postHashDb.exec('ROLLBACK');
      throw error;
    }
    const committed = await harness.inspector(source);
    assert.equal(committed.outcome, 'committed');
    assert.equal(committed.boundedEvidence.receiptCount, 1);
    assert.match(committed.boundedEvidence.receiptDigest, /^[a-f0-9]{64}$/);
    const receiptConflict = await harness.inspector({
      ...source,
      sourceRef: 'critical-intent:inspector-matrix-conflict',
      taskRunId: 'task-inspector-matrix-conflict'
    });
    assert.equal(receiptConflict.outcome, 'unknown');
    assert.equal(receiptConflict.boundedEvidence.disposition, 'receipt-or-current-post-conflict');

    postHashDb.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1').run('{bad-json');
    const corrupt = await harness.inspector(source);
    assert.equal(corrupt.outcome, 'unknown');
    assert.equal(corrupt.boundedEvidence.disposition, 'adm-image-unreadable');
    assert.equal(corrupt.boundedEvidence.receiptCount, 1);
    assert.doesNotMatch(JSON.stringify(corrupt), /bad-json/);
    const family = fs.readdirSync(harness.root).filter((name) => name.startsWith('tool-data.sqlite'));
    assert.ok(family.every((name) => [
      'tool-data.sqlite', 'tool-data.sqlite-wal', 'tool-data.sqlite-shm'
    ].includes(name)));
    postHashDb.close();
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('prepared与acked同一Control transaction，ACK注入失败不遗留open Intent', async () => {
  let transitionCount = 0;
  const harness = createHarness({
    wrapRecoveryControlRepository(base) {
      return {
        runInControlTransaction(work) {
          return base.runInControlTransaction((tx) => work({
            transitionWithRecoveryEvent(request) {
              transitionCount += 1;
              if (transitionCount === 2) {
                throw Object.assign(new Error('injected JPM mark-acked failure'), {
                  code: 'TEST_JPM_MARK_ACKED_FAILED'
                });
              }
              return tx.transitionWithRecoveryEvent(request);
            },
            appendObservationEvent(event) {
              return tx.appendObservationEvent(event);
            }
          }));
        }
      };
    }
  });
  try {
    await importSession(harness);
    const result = await runManagedJpm(harness, 'jpm-atomic-ack-failure');
    assert.notEqual(result.outcome, 'completed');
    assert.equal(transitionCount, 2);
    assert.deepEqual(harness.readRepository.listOpenCriticalIntents(), []);
    assert.deepEqual(harness.readRepository.listActiveRecoveryHolds(), []);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-atomic-ack-failure'
    ), null);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('COMMIT后receipt event丢失按Inspector收口为committed-lost且不重跑mutation', async () => {
  const capture = createCrashAfterCommitCapture();
  const harness = createHarness({
    capture,
    planTransitions: reconFixJpmRecoveryPlanTransitions
  });
  try {
    await importSession(harness);
    const operationKey = 'jpm-crash-after-commit';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const result = await runManagedJpm(harness, operationKey);
    assert.equal(result.outcome, 'interrupted', JSON.stringify(result));
    assert.equal(result.result, null);
    const receipt = receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      operationKey
    );
    assert.ok(receipt);
    assert.equal(harness.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM recon_fix_adm_operation_receipts
      WHERE action_key = ? AND operation_key = ?
    `).get(RECON_FIX_RUN_JPM_ACTION, operationKey).count, 1);
    assert.equal(readAdmRowsForWriteback(harness.database.db).rows[0]
      .parsed[FIELD_MAP.admReconFundId], 'RID-E11-B');
    const intent = harness.readRepository.getCriticalIntentByOperation(
      RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      taskRunId
    );
    assert.equal(intent.state, 'closed');
    const recoveredTask = archive.getTaskRun(taskRunId);
    assert.equal(recoveredTask.status, 'interrupted');
    assert.equal(recoveredTask.failureCode, 'RESULT_LOST');
    assert.deepEqual(harness.readRepository.listActiveRecoveryHolds(), []);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('critical ACK后的shutdown将JPM保持protected，transport loss不降级为cancelled', async () => {
  const capture = createPausedCriticalAckCapture();
  const harness = createHarness({ capture });
  let shutdownStarted = false;
  try {
    await importSession(harness);
    const operationKey = 'jpm-protected-cancel';
    const control = harness.runtime.start({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      context: operationContext(operationKey),
      input: {
        expectedRevision: 1,
        databasePath: harness.databasePath,
        scenario: SCENARIO
      }
    });
    const ack = await capture.criticalAckPaused;
    assert.equal(harness.runtime.inspect(ack.jobId).state, 'protected');
    shutdownStarted = true;
    const shutdown = harness.runtime.shutdown({ timeoutMs: 10000 });
    assert.equal(capture.commands.some((message) =>
      message.actionKey === RECON_FIX_RUN_JPM_ACTION && message.operation === 'job:cancel'), false);
    await capture.terminateWorker();
    const [result, report] = await Promise.all([control.promise, shutdown]);
    assert.equal(result.outcome, 'transport-lost', JSON.stringify(result));
    assert.notEqual(result.outcome, 'cancelled');
    assert.ok(report.protectedJobs.includes(ack.jobId));
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      operationKey
    ), null);
    const intent = harness.readRepository.getCriticalIntentByOperation(
      RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      `task-${operationKey}`
    );
    assert.equal(intent.state, 'closed');
    assert.deepEqual(harness.readRepository.listActiveRecoveryHolds(), []);
  } finally {
    if (!shutdownStarted) await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('critical前cancel即使随后持久ACK也由Inspector判定not-committed且不重跑', async () => {
  const capture = createPausedCriticalReadyCapture();
  const harness = createHarness({
    capture,
    planTransitions: reconFixJpmRecoveryPlanTransitions
  });
  let shutdownCompleted = false;
  try {
    const before = readAdmRowsForWriteback(harness.database.db);
    await importSession(harness);
    const operationKey = 'jpm-cancel-before-critical-ack';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const control = harness.runtime.start({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      context: operationContext(operationKey),
      input: {
        expectedRevision: 1,
        databasePath: harness.databasePath,
        scenario: SCENARIO
      }
    });
    await capture.criticalReadyPaused;
    const shutdown = harness.runtime.shutdown({ timeoutMs: 10000 });
    await new Promise((resolve) => setImmediate(resolve));
    capture.releaseCriticalReady();
    const [result, report] = await Promise.all([control.promise, shutdown]);
    shutdownCompleted = true;
    assert.equal(result.outcome, 'cancelled', JSON.stringify(result));
    assert.ok(report.cancelledJobs.includes(result.jobId));
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, before.imageHash);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      operationKey
    ), null);
    const intent = harness.readRepository.getCriticalIntentByOperation(
      RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      taskRunId
    );
    assert.equal(intent.state, 'closed');
    const recoveredTask = archive.getTaskRun(taskRunId);
    assert.equal(recoveredTask.status, 'interrupted');
    assert.equal(recoveredTask.failureCode, 'NOT_COMMITTED');
    assert.deepEqual(harness.readRepository.listActiveRecoveryHolds(), []);
    const criticalReady = capture.messages.find((message) =>
      message.channel === 'job' && message.actionKey === RECON_FIX_RUN_JPM_ACTION &&
      message.operation === 'critical:ready');
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: RECON_FIX_JPM_POLICY,
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      parentOperationKey: operationKey,
      taskRunId,
      batchId: null,
      jobId: 'cancelled-operation-replay-job',
      workerInstanceId: 'cancelled-operation-replay-worker',
      unitId: RECON_FIX_JPM_UNIT_ID,
      critical: criticalReady.payload.critical
    }), { code: 'RECON_FIX_JPM_OPERATION_REPLAY_FORBIDDEN' });
  } finally {
    if (!shutdownCompleted) await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('post-without-receipt恢复为unknown，startup幂等创建ADM Hold并阻断mutation gate', async () => {
  const harness = createHarness({ planTransitions: reconFixJpmRecoveryPlanTransitions });
  try {
    const operationKey = 'unknown-post-no-receipt';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const source = readAdmRowsForWriteback(harness.database.db);
    const engine = runJpmDispatchOrderFix({
      scenario: SCENARIO,
      admRows: source.rows.map((row) => row.parsed),
      sheets: {
        opponentBills: [{
          merchantId: ADM_MERCHANT_ID,
          reconciliationId: 'RID-E11-B',
          receiveAmount: 100,
          additionInfo: 'ATS OF 26/05/04'
        }],
        businessBills: [{ MerchantId: ADM_MERCHANT_ID, OrderId: 'A1', Amount: 100 }]
      }
    });
    const post = engine.admUpdates[0];
    const critical = {
      contractVersion: 1,
      scenarioId: String(SCENARIO.id),
      preImageHash: source.imageHash,
      postImageHash: '',
      idSequenceDigest: source.idSequenceDigest,
      rowCount: source.rowCount,
      changedRowCount: 1,
      resultHandle: 'c'.repeat(64),
      boundedSummary: {
        runKind: 'jpm', fixedRowCount: 1, warningCount: 0,
        unmatchedRowCount: 0, resultDigest: 'd'.repeat(64)
      }
    };
    harness.database.db.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
      .run(JSON.stringify(post));
    critical.postImageHash = readAdmRowsForWriteback(harness.database.db).imageHash;
    harness.database.db.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
      .run(source.rows[0].rawJsonText);
    const prepared = await harness.durable.prepareAndAck({
      policy: RECON_FIX_JPM_POLICY,
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      parentOperationKey: operationKey,
      taskRunId,
      batchId: null,
      jobId: 'job-unknown-post-no-receipt',
      workerInstanceId: 'worker-unknown-post-no-receipt',
      unitId: RECON_FIX_JPM_UNIT_ID,
      critical
    });
    harness.database.db.prepare('UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1')
      .run(JSON.stringify(post));
    const inspected = await harness.durable.resolveUncertain({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      fileOperationKey: operationKey,
      taskRunId,
      jobId: 'job-unknown-post-no-receipt',
      workerInstanceId: 'worker-unknown-post-no-receipt',
      unitId: RECON_FIX_JPM_UNIT_ID,
      intentId: prepared.intentId,
      terminalSource: 'worker-exit'
    });
    assert.equal(inspected.outcome, 'unknown');
    assert.throws(() => harness.holdGate.assertMutationAllowed(), { code: 'RECOVERY_HOLD_ACTIVE' });
    await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 1);
    const recoveredTask = archive.getTaskRun(taskRunId);
    assert.equal(recoveredTask.status, 'interrupted');
    assert.equal(recoveredTask.failureCode, 'INSPECTION_UNKNOWN');
    assert.equal(recoveredTask.metadata.recoveryHold, true);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});
