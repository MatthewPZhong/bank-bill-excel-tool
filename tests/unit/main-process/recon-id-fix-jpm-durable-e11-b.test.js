'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../../src/backend/database');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../src/backend/database/background-execution-schema');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const {
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const legacyLinkedRepository = require('../../../src/backend/database/linked-table-repository');
const receiptRepository = require('../../../src/backend/database/recon-fix-operation-receipt-repository');
const {
  readAdmRowsForWriteback
} = require('../../../src/backend/database/linked-table-writeback-reader');
const {
  buildAdmRows
} = require('../../../src/main-process/adm-bank-deposit-builder');
const {
  rebuildAdmDerivation
} = require('../../../src/main-process/linked-derive-rebuild');
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
  canonicalSha256
} = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  observationScopeKey,
  transitionRequestKey
} = require('../../../src/main-process/background-execution/recovery-control-contract');
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
  deriveReconFixJpmDatabaseIdentity
} = require('../../../src/main-process/recon-id-fix-service/jpm-database-authority');
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
  boundedJpmReceiptFromExact
} = require('../../../src/main-process/recon-id-fix-service/jpm-receipt-evidence');
const {
  reconFixJpmRecoveryPlanTransitions
} = require('../../../src/main-process/recon-id-fix-service/jpm-recovery-plan');
const {
  createReconFixJpmRecoveryTaskStateReader
} = require('../../../src/main-process/recon-id-fix-service/jpm-recovery-task-state');
const {
  createReconFixJpmWorkerDurableCoordinator
} = require('../../../src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator');
const {
  generateValidateAndPublishReconFixExport
} = require('../../../src/main-process/recon-id-fix-service/export-operation');
const {
  reconFixEvidenceSha256
} = require('../../../src/main-process/recon-id-fix-service/evidence-projection');
const {
  RECON_FIX_EXPORT_ACTION,
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
  const baseRequestOwnerRepository = createRecoveryRequestOwnerRepository(database.db);
  const requestOwnerRepository = options.wrapRequestOwnerRepository
    ? options.wrapRequestOwnerRepository(baseRequestOwnerRepository)
    : baseRequestOwnerRepository;
  const baseRecoveryControlRepository = createRecoveryControlRepository(database.db);
  const recoveryControlRepository = options.wrapRecoveryControlRepository
    ? options.wrapRecoveryControlRepository(baseRecoveryControlRepository)
    : baseRecoveryControlRepository;
  const baseInspector = createReconFixJpmOutcomeInspector({ databasePath });
  const inspector = options.wrapInspector ? options.wrapInspector(baseInspector) : baseInspector;
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
    resolveTaskState: createReconFixJpmRecoveryTaskStateReader(database.db),
    planTransitions: options.planTransitions || (() => []),
    transientAttempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0
  });
  const holdGate = createReconFixJpmHoldGate({
    recoveryHoldGate: createRecoveryHoldGate(readRepository),
    readRepository
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
    databaseIdentity: deriveReconFixJpmDatabaseIdentity(databasePath),
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
    reconFixJpmDatabasePath: databasePath,
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
    requestOwnerRepository,
    recoveryControlRepository,
    recoveryCoordinator,
    holdGate,
    inspector,
    authority,
    durable,
    runtime,
    messages: capture.messages
  };
}

function openRecoveryLayer(databasePath, options = {}) {
  const database = new AppDatabase(databasePath);
  database.init();
  const readRepository = createRecoveryControlReadRepository(database.db);
  const requestOwnerRepository = createRecoveryRequestOwnerRepository(database.db);
  const inspectors = createInspectorRegistry();
  inspectors.register(
    RECON_FIX_JPM_POLICY.commit.inspectorKey,
    options.inspector || createReconFixJpmOutcomeInspector({ databasePath })
  );
  inspectors.freeze();
  const providers = createSettlementRecoveryProviderRegistry();
  providers.freeze();
  let controlTransactionCount = 0;
  const baseControlRepository = createRecoveryControlRepository(database.db);
  const recoveryControlRepository = Object.freeze({
    runInControlTransaction(work) {
      controlTransactionCount += 1;
      return baseControlRepository.runInControlTransaction(work);
    }
  });
  const recoveryCoordinator = createStartupRecoveryCoordinator({
    readRepository,
    inspectorRegistry: inspectors,
    providerRegistry: providers,
    requestOwnerRepository,
    observationAttemptRepository: createRecoveryObservationAttemptRepository(database.db),
    recoveryControlRepository,
    resolvePolicy: () => RECON_FIX_JPM_POLICY,
    resolveTaskState: createReconFixJpmRecoveryTaskStateReader(database.db),
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    transientAttempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0
  });
  return Object.freeze({
    database,
    readRepository,
    recoveryCoordinator,
    controlTransactionCount: () => controlTransactionCount
  });
}

function criticalIdentity(operationKey, taskRunId, critical) {
  return Object.freeze({
    policy: RECON_FIX_JPM_POLICY,
    actionKey: RECON_FIX_RUN_JPM_ACTION,
    parentOperationKey: operationKey,
    taskRunId,
    batchId: null,
    jobId: `job-${operationKey}`,
    workerInstanceId: `worker-${operationKey}`,
    unitId: RECON_FIX_JPM_UNIT_ID,
    critical
  });
}

function commitCriticalFixture(harness, fixture, identity) {
  harness.database.db.exec('BEGIN IMMEDIATE');
  try {
    harness.database.db.prepare(
      'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
    ).run(JSON.stringify(fixture.post));
    const receipt = receiptRepository.insertOperationReceipt(harness.database.db, {
      actionKey: identity.actionKey,
      operationKey: identity.parentOperationKey,
      producerTaskRunId: identity.taskRunId,
      scenarioId: fixture.critical.scenarioId,
      preImageHash: fixture.critical.preImageHash,
      postImageHash: fixture.critical.postImageHash,
      idSequenceDigest: fixture.critical.idSequenceDigest,
      rowCount: fixture.critical.rowCount,
      changedRowCount: fixture.critical.changedRowCount
    });
    harness.database.db.exec('COMMIT');
    return receipt;
  } catch (error) {
    if (harness.database.db.isTransaction) harness.database.db.exec('ROLLBACK');
    throw error;
  }
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
      scenario: SCENARIO
    }
  });
}

function buildCriticalFixture(harness, label) {
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
  const post = engine.admUpdates[0];
  harness.database.db.prepare(
    'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
  ).run(JSON.stringify(post));
  const postEvidence = readAdmRowsForWriteback(harness.database.db);
  harness.database.db.prepare(
    'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
  ).run(before.rows[0].rawJsonText);
  return Object.freeze({
    before,
    post,
    critical: Object.freeze({
      contractVersion: 1,
      databaseIdentity: deriveReconFixJpmDatabaseIdentity(harness.databasePath),
      scenarioId: String(SCENARIO.id),
      preImageHash: before.imageHash,
      postImageHash: postEvidence.imageHash,
      idSequenceDigest: before.idSequenceDigest,
      rowCount: before.rowCount,
      changedRowCount: 1,
      resultHandle: canonicalSha256(['result-handle', label]),
      boundedSummary: Object.freeze({
        runKind: 'jpm',
        fixedRowCount: 1,
        warningCount: 0,
        unmatchedRowCount: 0,
        resultDigest: canonicalSha256(['result-digest', label])
      })
    })
  });
}

function criticalIntentSource(harness, intentId) {
  const intent = harness.readRepository.getCriticalIntentById(intentId);
  assert.ok(intent, `missing Critical Intent ${intentId}`);
  return Object.freeze({
    contractVersion: 1,
    sourceKind: 'critical-intent',
    sourceRef: `critical-intent:${intent.intentId}`,
    actionKey: intent.actionKey,
    operationKey: intent.operationKey,
    taskRunId: intent.taskRunId,
    conflictScopeKey: intent.conflictScopeKey,
    inspectorKey: intent.inspectorKey,
    settlementKey: null,
    intentId: intent.intentId,
    evidenceVersion: intent.evidenceVersion,
    boundedEvidence: intent.boundedEvidence
  });
}

function inspectionUnavailableSeedPlan(harness, intentId) {
  const source = criticalIntentSource(harness, intentId);
  const holdId = `hold:v1:${canonicalSha256([source.sourceKind, source.sourceRef])}`;
  const taskState = createReconFixJpmRecoveryTaskStateReader(harness.database.db)(source);
  const planned = reconFixJpmRecoveryPlanTransitions({
    phase: 'inspection-unavailable-hold',
    source,
    inspection: null,
    activeHold: null,
    holdId,
    taskState
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].transition.entityKind, 'task-run');
  assert.equal(planned[0].transition.failureCode, 'INSPECTOR_UNAVAILABLE');
  const safeSummary = Object.freeze({
    reasonCode: 'INSPECTOR_UNAVAILABLE',
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef
  });
  const hold = Object.freeze({
    entityKind: 'recovery-hold',
    command: 'create-or-get',
    input: Object.freeze({
      contractVersion: 1,
      holdId,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      intentId: source.intentId,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      conflictScopeKey: source.conflictScopeKey,
      reasonCode: 'INSPECTOR_UNAVAILABLE',
      safeSummary,
      evidenceHash: canonicalSha256(safeSummary)
    })
  });
  const observationScope = Object.freeze({
    eventType: 'inspection-failed-transient',
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    batchId: null,
    intentId: source.intentId,
    holdId,
    recoveryAttemptId: null
  });
  return Object.freeze({
    source,
    hold,
    holdId,
    task: planned[0],
    observationScope
  });
}

function reserveTransitionDraft(repository, draft) {
  const transition = draft.transition || draft;
  const safePayload = draft.safePayload || { reasonCode: 'INSPECTOR_UNAVAILABLE' };
  return repository.reserveTransitionRequest({
    requestKey: transitionRequestKey(transition),
    transition,
    safePayload
  });
}

function seedLegacyInspectionUnavailableGap(harness, intentId, stage) {
  const plan = inspectionUnavailableSeedPlan(harness, intentId);
  reserveTransitionDraft(harness.requestOwnerRepository, plan.task);
  if (stage !== 'task-owner') {
    reserveTransitionDraft(harness.requestOwnerRepository, plan.hold);
  }
  if (stage === 'unbound-attempt') {
    createRecoveryObservationAttemptRepository(harness.database.db)
      .allocateNextObservationAttempt(plan.observationScope);
  }
  return plan;
}

function seedActiveHoldLegacyInspectionUnavailableGap(harness, intentId, stage) {
  const plan = inspectionUnavailableSeedPlan(harness, intentId);
  reserveTransitionDraft(harness.requestOwnerRepository, plan.task);
  if (stage === 'task-unbound-attempt') {
    createRecoveryObservationAttemptRepository(harness.database.db)
      .allocateNextObservationAttempt(plan.observationScope);
  }
  return plan;
}

function wrapThresholdOwnerCrash(base, fault, crashStage) {
  return Object.freeze({
    ...base,
    reserveObservationAnchor(input) {
      const reserved = base.reserveObservationAnchor(input);
      if (fault.armed) fault.order.push('anchor');
      return reserved;
    },
    reserveTransitionRequest(input) {
      const reserved = base.reserveTransitionRequest(input);
      if (!fault.armed) return reserved;
      const transition = input.transition;
      const stage = transition.entityKind === 'task-run' &&
          transition.command === 'mark-interrupted' &&
          transition.failureCode === 'INSPECTOR_UNAVAILABLE'
        ? 'task-owner'
        : transition.entityKind === 'recovery-hold' &&
            transition.command === 'create-or-get' &&
            transition.input.reasonCode === 'INSPECTOR_UNAVAILABLE'
          ? 'hold-owner'
          : null;
      if (!stage) return reserved;
      fault.order.push(stage);
      if (stage === crashStage) {
        fault.armed = false;
        throw Object.assign(new Error(`injected ${stage} crash`), {
          code: 'TEST_THRESHOLD_STAGE_CRASH'
        });
      }
      return reserved;
    }
  });
}

function recoveryPersistenceCounts(db) {
  const owner = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) AS prepared
    FROM background_execution_recovery_request_owners
  `).get();
  const attempt = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) AS prepared,
           SUM(CASE WHEN status = 'prepared' AND request_key IS NULL THEN 1 ELSE 0 END) AS unbound
    FROM background_execution_recovery_observation_attempts
  `).get();
  return Object.freeze({
    ownerTotal: Number(owner.total),
    ownerPrepared: Number(owner.prepared || 0),
    attemptTotal: Number(attempt.total),
    attemptPrepared: Number(attempt.prepared || 0),
    attemptUnbound: Number(attempt.unbound || 0)
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

async function establishUnknownPostWithoutReceipt(harness, operationKey) {
  const task = seedRunningReconTask(harness, operationKey);
  const fixture = buildCriticalFixture(harness, operationKey);
  const identity = {
    policy: RECON_FIX_JPM_POLICY,
    actionKey: RECON_FIX_RUN_JPM_ACTION,
    parentOperationKey: operationKey,
    taskRunId: task.taskRunId,
    batchId: null,
    jobId: `job-${operationKey}`,
    workerInstanceId: `worker-${operationKey}`,
    unitId: RECON_FIX_JPM_UNIT_ID,
    critical: fixture.critical
  };
  const prepared = await harness.durable.prepareAndAck(identity);
  harness.database.db.prepare(
    'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
  ).run(JSON.stringify(fixture.post));
  const inspection = await harness.durable.resolveUncertain({
    actionKey: RECON_FIX_RUN_JPM_ACTION,
    fileOperationKey: operationKey,
    taskRunId: task.taskRunId,
    jobId: identity.jobId,
    workerInstanceId: identity.workerInstanceId,
    unitId: RECON_FIX_JPM_UNIT_ID,
    intentId: prepared.intentId,
    terminalSource: 'worker-exit'
  });
  assert.equal(inspection.outcome, 'unknown');
  assert.equal(task.archive.getTaskRun(task.taskRunId).status, 'interrupted');
  assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 1);
  return Object.freeze({ ...task, ...fixture, identity, intentId: prepared.intentId });
}

function assertHeldDefinitiveRecoveryState(
  layer,
  taskRunId,
  intentId,
  definitiveOutcome,
  holdReason
) {
  const task = createArchiveRepository(layer.database.db).getTaskRun(taskRunId);
  const hold = layer.readRepository.getRecoveryHoldBySource(
    'critical-intent',
    `critical-intent:${intentId}`
  );
  if (definitiveOutcome === 'committed') {
    assert.equal(task.status, 'interrupted');
    assert.equal(task.failureCode, 'RESULT_LOST');
    assert.equal(task.metadata.recoveryHold, true);
    assert.equal(task.metadata.recoveryOutcome, 'committed');
    assert.equal(hold.status, 'active');
    assert.equal(hold.reasonCode, holdReason);
    assert.equal(hold.resolution, null);
  } else {
    assert.equal(task.status, 'failed');
    assert.equal(task.failureCode, 'NOT_COMMITTED');
    assert.equal(task.metadata.recoveryHold, false);
    assert.equal(task.metadata.recoveryOutcome, 'not-committed');
    assert.equal(hold.status, 'resolved');
    assert.equal(hold.reasonCode, holdReason);
    assert.equal(hold.resolution, 'not-committed');
  }
  assert.equal(layer.readRepository.getCriticalIntentById(intentId).state, 'closed');
  return { task, hold };
}

test('JPM canonical policy保持production false，runtime固定single unit且禁止caller override', async () => {
  assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_RUN_JPM_ACTION), false);
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(RECON_FIX_JPM_POLICY, fixture[RECON_FIX_RUN_JPM_ACTION]);
  const jpmResult = {
    resultKind: 'noop',
    serviceGeneration: 1,
    revision: 2,
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
      input: { expectedRevision: 1, scenario: SCENARIO }
    }), { code: 'UNIT_REGISTRATION_OVERRIDE_FORBIDDEN' });
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('Main-owned JPM database authority拒绝caller B库与ACK identity漂移且A/B均零写入', async () => {
  const harness = createHarness();
  const databaseBPath = path.join(harness.root, 'other-tool-data.sqlite');
  const databaseB = new AppDatabase(databaseBPath);
  databaseB.init();
  legacyLinkedRepository.replaceAdmBankDeposit(databaseB.db, [admRow({ reconFundId: 'B-UNCHANGED' })]);
  try {
    await importSession(harness);
    const beforeA = readAdmRowsForWriteback(harness.database.db);
    const beforeB = readAdmRowsForWriteback(databaseB.db);
    const operationKey = 'jpm-caller-database-b-forbidden';
    let rejected;
    await assert.rejects(harness.runtime.execute({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      context: operationContext(operationKey),
      input: {
        expectedRevision: 1,
        databasePath: databaseBPath,
        scenario: SCENARIO
      }
    }), (error) => {
      rejected = error;
      return error && error.code === 'RECON_FIX_JPM_DATABASE_AUTHORITY_OVERRIDE_FORBIDDEN';
    });
    assert.equal(String(rejected && rejected.message).includes(databaseBPath), false);
    assert.equal(harness.messages.some((message) => message.operationKey === operationKey), false);

    const fixture = buildCriticalFixture(harness, 'database-authority-mismatch');
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: RECON_FIX_JPM_POLICY,
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      parentOperationKey: 'jpm-critical-database-b-forbidden',
      taskRunId: 'task-jpm-critical-database-b-forbidden',
      batchId: null,
      jobId: 'job-jpm-critical-database-b-forbidden',
      workerInstanceId: 'worker-jpm-critical-database-b-forbidden',
      unitId: RECON_FIX_JPM_UNIT_ID,
      critical: {
        ...fixture.critical,
        databaseIdentity: deriveReconFixJpmDatabaseIdentity(databaseBPath)
      }
    }), { code: 'RECON_FIX_JPM_CRITICAL_PAYLOAD_INVALID' });

    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, beforeA.imageHash);
    assert.equal(readAdmRowsForWriteback(databaseB.db).imageHash, beforeB.imageHash);
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      operationKey
    ), null);
    assert.equal(receiptRepository.getOperationReceipt(
      databaseB.db,
      RECON_FIX_RUN_JPM_ACTION,
      operationKey
    ), null);
  } finally {
    databaseB.close();
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('E11前序control DB幂等升级JPM open-scope唯一索引', () => {
  const root = tempRoot();
  const db = new DatabaseSync(path.join(root, 'control-upgrade.sqlite'));
  try {
    ensureBackgroundExecutionRecoveryControlSchema(db);
    db.exec('DROP INDEX ux_bg_exec_recon_jpm_open_intent_scope');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'ux_bg_exec_recon_jpm_open_intent_scope'
    `).get().count, 0);
    ensureBackgroundExecutionRecoveryControlSchema(db);
    ensureBackgroundExecutionRecoveryControlSchema(db);
    const index = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'ux_bg_exec_recon_jpm_open_intent_scope'
    `).get();
    assert.match(index.sql, /UNIQUE INDEX/);
    assert.match(index.sql, /action_key = 'recon-fix:run-jpm'/);
    assert.match(index.sql, /state <> 'closed'/);
  } finally {
    db.close();
  }
});

test('control DB唯一租约拒绝跨operation ACK及同/换worker再ACK，legacy边界观察open Intent', async () => {
  const harness = createHarness();
  try {
    const makeDurable = () => createReconFixJpmWorkerDurableCoordinator({
      readRepository: harness.readRepository,
      requestOwnerRepository: harness.requestOwnerRepository,
      recoveryControlRepository: harness.recoveryControlRepository,
      recoveryCoordinator: harness.recoveryCoordinator,
      receiptAuthority: harness.authority,
      databaseIdentity: deriveReconFixJpmDatabaseIdentity(harness.databasePath)
    });
    const first = makeDurable();
    const second = makeDurable();
    const fixture = buildCriticalFixture(harness, 'scope-exclusivity');
    let legacyReadRan = false;
    assert.equal(harness.holdGate.runSynchronousMutationBoundary(() => {
      legacyReadRan = true;
      return 'read-ok';
    }), 'read-ok');
    assert.equal(legacyReadRan, true);

    const firstIdentity = {
      policy: RECON_FIX_JPM_POLICY,
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      parentOperationKey: 'scope-owner-operation',
      taskRunId: 'task-scope-owner-operation',
      batchId: null,
      jobId: 'job-scope-owner-operation',
      workerInstanceId: 'worker-scope-owner-operation',
      unitId: RECON_FIX_JPM_UNIT_ID,
      critical: fixture.critical
    };
    await first.prepareAndAck(firstIdentity);
    const storedOwner = harness.readRepository.listOpenCriticalIntents()[0];
    assert.equal(
      storedOwner.boundedEvidence.workerInstanceIdentity,
      canonicalSha256(['recon-fix-jpm-worker-instance-v1', firstIdentity.workerInstanceId])
    );
    assert.equal(JSON.stringify(storedOwner).includes(firstIdentity.workerInstanceId), false);

    await assert.rejects(() => second.prepareAndAck({
      ...firstIdentity,
      parentOperationKey: 'scope-contender-operation',
      taskRunId: 'task-scope-contender-operation',
      jobId: 'job-scope-contender-operation',
      workerInstanceId: 'worker-scope-contender-operation'
    }), { code: 'RECOVERY_INTENT_SCOPE_CONFLICT' });
    await assert.rejects(() => first.prepareAndAck(firstIdentity), {
      code: 'RECON_FIX_JPM_OPERATION_REPLAY_FORBIDDEN'
    });
    await assert.rejects(() => first.prepareAndAck({
      ...firstIdentity,
      workerInstanceId: 'worker-scope-owner-reack'
    }), { code: 'RECON_FIX_JPM_OPERATION_REPLAY_FORBIDDEN' });
    await assert.rejects(() => first.awaitPersistentStateAdoption({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey: firstIdentity.parentOperationKey,
      jobId: firstIdentity.jobId,
      unitId: RECON_FIX_JPM_UNIT_ID,
      workerInstanceId: 'worker-scope-owner-reack'
    }), { code: 'RECON_FIX_JPM_ADOPTION_IDENTITY_CONFLICT' });

    let legacyWriteRan = false;
    assert.throws(() => harness.holdGate.runSynchronousMutationBoundary(() => {
      legacyWriteRan = true;
    }), { code: 'RECON_FIX_JPM_SCOPE_LEASE_HELD' });
    assert.equal(legacyWriteRan, false);
    assert.equal(harness.readRepository.listOpenCriticalIntents().length, 1);

    const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
    const handler = mainSource.slice(
      mainSource.indexOf("trackedIpcHandle('recon-id-fix:run'"),
      mainSource.indexOf("trackedIpcHandle('recon-id-fix:export'", mainSource.indexOf("trackedIpcHandle('recon-id-fix:run'"))
    );
    assert.equal((handler.match(/runSynchronousMutationBoundary/g) || []).length, 2);
    assert.ok(handler.indexOf('runSynchronousMutationBoundary') <
      handler.indexOf('database.readAdmBankDepositRows'));
    assert.ok(handler.lastIndexOf('runSynchronousMutationBoundary') <
      handler.indexOf('database.writeAdmMatchFlags'));
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('ACKed JPM Intent在真实bank source mutation前fail closed且Main import/delete接线早于写入', async () => {
  const harness = createHarness();
  try {
    harness.database.upsertLinkedBankDeposit([{
      MerchantId: ADM_MERCHANT_ID,
      Channel: 'ADM',
      FundType: 'FundTransfer',
      BillDate: '2026-05-04',
      BizId: 'BANK-SOURCE-LEASE',
      ReconciliationId: 'BANK-SOURCE-LEASE'
    }], { sourceFileName: 'lease-source.xlsx' });
    const beforeSource = harness.database.readLinkedTableRows('bank-deposit');
    const beforeAdm = readAdmRowsForWriteback(harness.database.db);
    const operationKey = 'source-mutation-open-intent-gate';
    const { taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    await harness.durable.prepareAndAck(criticalIdentity(operationKey, taskRunId, fixture.critical));

    let sourceMutationRan = false;
    assert.throws(() => {
      harness.holdGate.assertMutationAllowed();
      sourceMutationRan = true;
      harness.database.deleteBankDepositByDateRange('2026-05-04', '2026-05-04');
    }, { code: 'RECON_FIX_JPM_SCOPE_LEASE_HELD' });
    assert.equal(sourceMutationRan, false);
    assert.deepEqual(harness.database.readLinkedTableRows('bank-deposit'), beforeSource);
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, beforeAdm.imageHash);

    const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
    const importBlock = mainSource.slice(
      mainSource.indexOf('async function importLinkedFileToRepo'),
      mainSource.indexOf('// v3.0.0 块 B / PR-2', mainSource.indexOf('async function importLinkedFileToRepo'))
    );
    assert.match(importBlock, /isBankDeposit \|\| isMidAllocation/);
    const importGateIndex = importBlock.indexOf('assertReconFixJpmAdmMutationAllowed()');
    const bankStreamingWriteIndex = importBlock.indexOf('upsertLinkedBankDepositStreaming');
    const midStreamingWriteIndex = importBlock.indexOf('replaceLinkedTableStreaming');
    assert.notEqual(importGateIndex, -1);
    assert.notEqual(bankStreamingWriteIndex, -1);
    assert.notEqual(midStreamingWriteIndex, -1);
    assert.ok(importGateIndex < bankStreamingWriteIndex);
    assert.ok(importGateIndex < midStreamingWriteIndex);
    assert.match(importBlock, /admMutationBoundary: runReconFixJpmAdmMutationBoundary/);
    const deleteBlock = mainSource.slice(
      mainSource.indexOf("if (tableKey === 'bank-deposit')", mainSource.indexOf("trackedIpcHandle('linked-table:delete-by-date-range'")),
      mainSource.indexOf('// gateway-bill（缺省）', mainSource.indexOf("trackedIpcHandle('linked-table:delete-by-date-range'"))
    );
    const deleteGateIndex = deleteBlock.indexOf('assertReconFixJpmAdmMutationAllowed()');
    const deleteWriteIndex = deleteBlock.indexOf('deleteBankDepositByDateRange');
    assert.notEqual(deleteGateIndex, -1);
    assert.notEqual(deleteWriteIndex, -1);
    assert.ok(deleteGateIndex < deleteWriteIndex);
    assert.match(deleteBlock, /admMutationBoundary: runReconFixJpmAdmMutationBoundary/);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('active JPM Hold在真实ADM replace同步边界重检，gate错误不被兼容catch吞且source/image不变', async () => {
  const harness = createHarness({ planTransitions: reconFixJpmRecoveryPlanTransitions });
  try {
    harness.database.upsertLinkedBankDeposit([{
      MerchantId: ADM_MERCHANT_ID,
      Channel: 'ADM',
      FundType: 'FundTransfer',
      BillDate: '2026-05-04',
      BizId: 'BANK-SOURCE-HOLD',
      ReconciliationId: 'BANK-SOURCE-HOLD'
    }], { sourceFileName: 'hold-source.xlsx' });
    await establishUnknownPostWithoutReceipt(harness, 'source-mutation-active-hold');
    const beforeSource = harness.database.readLinkedTableRows('bank-deposit');
    const beforeAdm = readAdmRowsForWriteback(harness.database.db);
    let replaceBoundaryEntered = false;
    assert.throws(() => rebuildAdmDerivation({
      database: harness.database,
      buildAdmRows,
      admMutationBoundary(work) {
        replaceBoundaryEntered = true;
        return harness.holdGate.runSynchronousMutationBoundary(work);
      }
    }), { code: 'RECOVERY_HOLD_ACTIVE' });
    assert.equal(replaceBoundaryEntered, true);
    assert.deepEqual(harness.database.readLinkedTableRows('bank-deposit'), beforeSource);
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, beforeAdm.imageHash);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('两个runtime/coordinator并发竞争全局ADM scope时仅首个获得持久ACK', async () => {
  const capture = createPausedCriticalAckCapture();
  const harness = createHarness({ capture });
  const secondDurable = createReconFixJpmWorkerDurableCoordinator({
    readRepository: harness.readRepository,
    requestOwnerRepository: harness.requestOwnerRepository,
    recoveryControlRepository: harness.recoveryControlRepository,
    recoveryCoordinator: harness.recoveryCoordinator,
    receiptAuthority: harness.authority,
    databaseIdentity: deriveReconFixJpmDatabaseIdentity(harness.databasePath),
    conflictScopeGate: () => harness.holdGate.assertMutationAllowed()
  });
  const secondRuntime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    reconFixJpmDatabasePath: harness.databasePath,
    workerDurableCoordinator: createWorkerDurableCoordinatorRouter({
      [RECON_FIX_RUN_JPM_ACTION]: secondDurable
    }),
    shutdownTimeoutMs: 10000
  });
  try {
    await importSession(harness);
    const secondImportKey = `second-import-${path.basename(harness.root)}`;
    const secondImport = await secondRuntime.execute({
      actionKey: RECON_FIX_IMPORT_ACTION,
      operationKey: secondImportKey,
      context: operationContext(secondImportKey),
      input: {
        expectedRevision: 0,
        filePath: harness.workbookPath,
        subMode: 'gateway'
      }
    });
    assert.equal(secondImport.outcome, 'completed', JSON.stringify(secondImport));

    const firstRun = runManagedJpm(harness, 'runtime-scope-owner');
    await capture.criticalAckPaused;
    const contender = await secondRuntime.execute({
      actionKey: RECON_FIX_RUN_JPM_ACTION,
      operationKey: 'runtime-scope-contender',
      context: operationContext('runtime-scope-contender'),
      input: { expectedRevision: 1, scenario: SCENARIO }
    });
    assert.notEqual(contender.outcome, 'completed');
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'runtime-scope-contender'
    ), null);
    assert.equal(harness.readRepository.listOpenCriticalIntents().length, 1);

    capture.releaseCriticalAck();
    const owner = await firstRun;
    assert.equal(owner.outcome, 'completed', JSON.stringify(owner));
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'runtime-scope-owner'
    ).operationKey, 'runtime-scope-owner');
  } finally {
    await secondRuntime.shutdown();
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

test('E11-C JPM exact adopted result可导出，ADM evidence漂移时Publisher保持0新增调用', async () => {
  const harness = createHarness();
  let publisherCalls = 0;
  try {
    await importSession(harness);
    const run = await runManagedJpm(harness, 'jpm-export-e11-c');
    assert.equal(run.outcome, 'completed', JSON.stringify(run));
    assert.equal(run.result.resultKind, 'committed');
    assert.equal(run.result.serviceGeneration, 1);
    assert.equal(run.result.revision, 2);
    assert.equal(run.result.boundedSummary.fixedRowCount, 1);

    const targetDirectory = path.join(harness.root, 'export-target');
    const stagingDirectory = path.join(harness.root, 'export-staging');
    fs.mkdirSync(targetDirectory);
    fs.mkdirSync(stagingDirectory);
    const filePlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{
        filePath: path.join(targetDirectory, 'jpm-result.xlsx'),
        role: 'output',
        sourceOperation: 'recon-id-fix:export'
      }]
    });
    const published = await generateValidateAndPublishReconFixExport({
      runtime: harness.runtime,
      result: run.result,
      filePlan,
      stagingDirectory,
      operationKey: 'jpm-export-e11-c-success',
      context: operationContext('jpm-export-e11-c-success'),
      batchContext: {
        batchId: 9001,
        batchNumber: '2026-08-28-9001',
        taskRunId: 'task-jpm-export-e11-c-success',
        taskKey: 'recon-id-fix:export',
        moduleId: 'recon-fix',
        parentRunId: 'parent-e11-b',
        operationKey: 'jpm-export-e11-c-success'
      },
      readCurrentEvidence() {
        const linkedEvidence = readAdmRowsForWriteback(harness.database.db);
        return {
          serviceGeneration: run.result.serviceGeneration,
          revision: run.result.revision,
          resultHandle: run.result.resultHandle,
          scenarioSnapshotHash: reconFixEvidenceSha256(SCENARIO, { maxBytes: 262144 }),
          linkedEvidenceHash: linkedEvidence.imageHash
        };
      },
      async publishPublication(payload) {
        publisherCalls += 1;
        assert.deepEqual(payload.artifacts.map((artifact) => artifact.outputId), ['recon-fix-main']);
        return { outcome: 'committed' };
      }
    });
    assert.equal(published.summary.fixedRowCount, 1);
    assert.equal(publisherCalls, 1);

    const current = readAdmRowsForWriteback(harness.database.db).rows[0].parsed;
    harness.database.db.prepare(
      'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
    ).run(JSON.stringify({ ...current, Amount: 101 }));
    const staleStaging = path.join(harness.root, 'export-staging-stale');
    fs.mkdirSync(staleStaging);
    await assert.rejects(() => generateValidateAndPublishReconFixExport({
      runtime: harness.runtime,
      result: run.result,
      filePlan,
      stagingDirectory: staleStaging,
      operationKey: 'jpm-export-e11-c-stale',
      context: operationContext('jpm-export-e11-c-stale'),
      batchContext: {
        batchId: 9002,
        batchNumber: '2026-08-28-9002',
        taskRunId: 'task-jpm-export-e11-c-stale',
        taskKey: 'recon-id-fix:export',
        moduleId: 'recon-fix',
        parentRunId: 'parent-e11-b',
        operationKey: 'jpm-export-e11-c-stale'
      },
      readCurrentEvidence() {
        throw new Error('Worker evidence gate 后不应进入 Main Join');
      },
      async publishPublication() {
        publisherCalls += 1;
      }
    }), { code: 'RECON_FIX_EXPORT_LINKED_EVIDENCE_STALE' });
    assert.equal(publisherCalls, 1);
    assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_EXPORT_ACTION), false);
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

test('JPM等待fixed unit:start后执行，stale job不杀Service且无需重导入即可同generation合法run', async () => {
  const harness = createHarness();
  try {
    await importSession(harness);
    const stale = await runManagedJpm(harness, 'jpm-stale-preserve-service', 0);
    assert.notEqual(stale.outcome, 'completed');
    assert.equal(receiptRepository.getOperationReceipt(
      harness.database.db,
      RECON_FIX_RUN_JPM_ACTION,
      'jpm-stale-preserve-service'
    ), null);

    const valid = await runManagedJpm(harness, 'jpm-valid-after-stale', 1);
    assert.equal(valid.outcome, 'completed', JSON.stringify(valid));
    assert.equal(valid.result.resultKind, 'committed');
    const initMessages = harness.messages.filter((message) =>
      message.channel === 'service-control' && message.operation === 'executor:ready');
    assert.equal(initMessages.length, 1);
    const generations = new Set(harness.messages.filter((message) =>
      message.channel === 'job').map((message) => message.serviceGeneration));
    assert.deepEqual([...generations], [1]);
    assert.equal(readAdmRowsForWriteback(harness.database.db).rows[0]
      .parsed[FIELD_MAP.admReconFundId], 'RID-E11-B');
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
    assert.equal(controls.some((message) => message.operation === 'resource:adopted' &&
      message.payload.owner.kind === 'phase'), true);
    assert.equal(controls.some((message) => message.operation === 'resource:adopted' &&
      message.payload.owner.kind === 'service-state'), false);
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
      databaseIdentity: deriveReconFixJpmDatabaseIdentity(harness.databasePath),
      workerInstanceIdentity: canonicalSha256([
        'recon-fix-jpm-worker-instance-v1',
        'worker-inspector-matrix'
      ]),
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

test('mark-committed owner已reserve后崩溃，第二次startup exact replay收敛且第三次零动作', async () => {
  const fault = { armed: false };
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          if (fault.armed) {
            fault.armed = false;
            throw Object.assign(new Error('injected post-owner mark-committed crash'), {
              code: 'TEST_POST_OWNER_MARK_COMMITTED_CRASH'
            });
          }
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  let harnessClosed = false;
  let second = null;
  let third = null;
  try {
    const operationKey = 'owner-resume-mark-committed';
    const { taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
    const prepared = await harness.durable.prepareAndAck(identity);
    const receipt = commitCriticalFixture(harness, fixture, identity);
    fault.armed = true;
    await assert.rejects(() => harness.durable.observeReceipt({
      actionKey: identity.actionKey,
      fileOperationKey: identity.parentOperationKey,
      taskRunId,
      jobId: identity.jobId,
      workerInstanceId: identity.workerInstanceId,
      unitId: identity.unitId,
      intentId: prepared.intentId,
      receipt: boundedJpmReceiptFromExact(receipt)
    }), { code: 'TEST_POST_OWNER_MARK_COMMITTED_CRASH' });
    const owner = harness.database.db.prepare(`
      SELECT status, request_jcs FROM background_execution_recovery_request_owners
      WHERE status = 'prepared' AND writer = 'transitionWithRecoveryEvent'
      ORDER BY rowid DESC LIMIT 1
    `).get();
    assert.equal(owner.status, 'prepared');
    assert.equal(JSON.parse(owner.request_jcs).input.transition.command, 'mark-committed');
    assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');

    await harness.runtime.shutdown();
    harness.database.close();
    harnessClosed = true;
    second = openRecoveryLayer(harness.databasePath);
    const recovered = await second.recoveryCoordinator.scanAndRecover();
    assert.equal(recovered.sourceCount, 1);
    assert.equal(recovered.decisions[0].inspection.outcome, 'committed');
    const intent = second.readRepository.getCriticalIntentById(prepared.intentId);
    assert.equal(intent.state, 'closed');
    assert.deepEqual(intent.receiptRef, {
      receiptKind: 'module-local',
      receiptDigest: boundedJpmReceiptFromExact(receipt).receiptDigest,
      actionKey: identity.actionKey,
      operationKey
    });
    const task = createArchiveRepository(second.database.db).getTaskRun(taskRunId);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.failureCode, 'RESULT_LOST');
    assert.equal(task.metadata.recoveryHold, true);
    assert.equal(second.readRepository.listActiveRecoveryHolds()[0].reasonCode, 'RESULT_LOST');
    assert.equal(second.database.db.prepare(`
      SELECT COUNT(*) AS count FROM background_execution_recovery_request_owners
      WHERE status = 'prepared'
    `).get().count, 0);
    second.database.close();
    second = null;

    third = openRecoveryLayer(harness.databasePath);
    const beforeThird = third.controlTransactionCount();
    const replay = await third.recoveryCoordinator.scanAndRecover();
    assert.equal(replay.sourceCount, 0);
    assert.equal(replay.activeHoldCount, 1);
    assert.equal(third.controlTransactionCount(), beforeThird);
  } finally {
    if (!harnessClosed) {
      await harness.runtime.shutdown();
      harness.database.close();
    }
    if (second) second.database.close();
    if (third) third.database.close();
  }
});

test('close owner已reserve后崩溃，第二次startup exact replay收敛且第三次零动作', async () => {
  const fault = { armed: false };
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          if (fault.armed) {
            fault.armed = false;
            throw Object.assign(new Error('injected post-owner close crash'), {
              code: 'TEST_POST_OWNER_CLOSE_CRASH'
            });
          }
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  let harnessClosed = false;
  let second = null;
  let third = null;
  try {
    const operationKey = 'owner-resume-close';
    const { taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
    const prepared = await harness.durable.prepareAndAck(identity);
    const receipt = commitCriticalFixture(harness, fixture, identity);
    await harness.durable.observeReceipt({
      actionKey: identity.actionKey,
      fileOperationKey: identity.parentOperationKey,
      taskRunId,
      jobId: identity.jobId,
      workerInstanceId: identity.workerInstanceId,
      unitId: identity.unitId,
      intentId: prepared.intentId,
      receipt: boundedJpmReceiptFromExact(receipt)
    });
    assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'committed');
    fault.armed = true;
    await assert.rejects(() => harness.durable.settleCommitted({
      intentId: prepared.intentId,
      jobId: identity.jobId,
      result: {
        resultKind: 'committed',
        resultHandle: fixture.critical.resultHandle,
        boundedSummary: fixture.critical.boundedSummary
      }
    }), { code: 'TEST_POST_OWNER_CLOSE_CRASH' });
    const owner = harness.database.db.prepare(`
      SELECT status, request_jcs FROM background_execution_recovery_request_owners
      WHERE status = 'prepared' AND writer = 'transitionWithRecoveryEvent'
      ORDER BY rowid DESC LIMIT 1
    `).get();
    assert.equal(owner.status, 'prepared');
    assert.equal(JSON.parse(owner.request_jcs).input.transition.command, 'close');

    await harness.runtime.shutdown();
    harness.database.close();
    harnessClosed = true;
    second = openRecoveryLayer(harness.databasePath);
    const recovered = await second.recoveryCoordinator.scanAndRecover();
    assert.equal(recovered.sourceCount, 1);
    assert.equal(recovered.decisions[0].inspection.outcome, 'committed');
    const intent = second.readRepository.getCriticalIntentById(prepared.intentId);
    assert.equal(intent.state, 'closed');
    assert.deepEqual(intent.result, {
      outcome: 'completed',
      resultHandle: fixture.critical.resultHandle,
      resultKind: 'committed'
    });
    const task = createArchiveRepository(second.database.db).getTaskRun(taskRunId);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.failureCode, 'RESULT_LOST');
    assert.equal(task.metadata.recoveryHold, true);
    assert.equal(second.readRepository.listActiveRecoveryHolds()[0].reasonCode, 'RESULT_LOST');
    assert.equal(second.database.db.prepare(`
      SELECT COUNT(*) AS count FROM background_execution_recovery_request_owners
      WHERE status = 'prepared'
    `).get().count, 0);
    second.database.close();
    second = null;

    third = openRecoveryLayer(harness.databasePath);
    const beforeThird = third.controlTransactionCount();
    const replay = await third.recoveryCoordinator.scanAndRecover();
    assert.equal(replay.sourceCount, 0);
    assert.equal(replay.activeHoldCount, 1);
    assert.equal(third.controlTransactionCount(), beforeThird);
  } finally {
    if (!harnessClosed) {
      await harness.runtime.shutdown();
      harness.database.close();
    }
    if (second) second.database.close();
    if (third) third.database.close();
  }
});

test('INSPECTOR_UNAVAILABLE observation anchor写入失败时attempt与owner同事务回滚', async () => {
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapInspector() {
      return async () => {
        throw Object.assign(new Error('injected transient inspector failure'), {
          code: 'TEST_INSPECTOR_TRANSIENT'
        });
      };
    }
  });
  try {
    const operationKey = 'threshold-anchor-atomic-rollback';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
    const prepared = await harness.durable.prepareAndAck(identity);
    const before = recoveryPersistenceCounts(harness.database.db);
    harness.database.db.exec(`
      CREATE TEMP TRIGGER fail_threshold_anchor_owner
      BEFORE INSERT ON background_execution_recovery_request_owners
      WHEN NEW.writer = 'appendObservationEvent'
      BEGIN
        SELECT RAISE(ABORT, 'injected threshold anchor owner failure');
      END
    `);
    await assert.rejects(
      () => harness.recoveryCoordinator.scanAndRecover(),
      /injected threshold anchor owner failure/
    );
    harness.database.db.exec('DROP TRIGGER fail_threshold_anchor_owner');
    assert.deepEqual(recoveryPersistenceCounts(harness.database.db), before);
    assert.equal(archive.getTaskRun(taskRunId).status, 'running');
    assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 0);
    assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

for (const crashStage of ['task-owner', 'hold-owner']) {
  for (const definitiveOutcome of ['committed', 'not-committed']) {
    test(`threshold atomic anchor后${crashStage}崩溃，重启先恢复exact bundle再收敛${definitiveOutcome}`, async () => {
      const fault = { armed: false, order: [] };
      const harness = createHarness({
        planTransitions: reconFixJpmRecoveryPlanTransitions,
        wrapInspector() {
          return async () => {
            throw Object.assign(new Error('injected transient inspector failure'), {
              code: 'TEST_INSPECTOR_TRANSIENT'
            });
          };
        },
        wrapRequestOwnerRepository(base) {
          return wrapThresholdOwnerCrash(base, fault, crashStage);
        }
      });
      let harnessClosed = false;
      let second = null;
      let third = null;
      try {
        const operationKey = `threshold-${crashStage}-${definitiveOutcome}`;
        const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
        const fixture = buildCriticalFixture(harness, operationKey);
        const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
        const prepared = await harness.durable.prepareAndAck(identity);
        if (definitiveOutcome === 'committed') {
          commitCriticalFixture(harness, fixture, identity);
        }
        const baseline = recoveryPersistenceCounts(harness.database.db);
        fault.armed = true;
        await assert.rejects(
          () => harness.recoveryCoordinator.scanAndRecover(),
          { code: 'TEST_THRESHOLD_STAGE_CRASH' }
        );
        assert.deepEqual(
          fault.order,
          crashStage === 'task-owner'
            ? ['anchor', 'task-owner']
            : ['anchor', 'task-owner', 'hold-owner']
        );
        assert.deepEqual(recoveryPersistenceCounts(harness.database.db), {
          ownerTotal: baseline.ownerTotal + (crashStage === 'task-owner' ? 2 : 3),
          ownerPrepared: crashStage === 'task-owner' ? 2 : 3,
          attemptTotal: baseline.attemptTotal + 1,
          attemptPrepared: 1,
          attemptUnbound: 0
        });
        assert.equal(archive.getTaskRun(taskRunId).status, 'running');
        assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 0);
        assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');

        await harness.runtime.shutdown();
        harness.database.close();
        harnessClosed = true;
        const inspectExact = createReconFixJpmOutcomeInspector({
          databasePath: harness.databasePath
        });
        let inspectorCalls = 0;
        second = openRecoveryLayer(harness.databasePath, {
          inspector: async (source) => {
            inspectorCalls += 1;
            const resumedTask = createArchiveRepository(second.database.db).getTaskRun(taskRunId);
            assert.equal(resumedTask.status, 'interrupted');
            assert.equal(resumedTask.failureCode, 'INSPECTOR_UNAVAILABLE');
            assert.equal(resumedTask.metadata.recoveryHold, true);
            const hold = second.readRepository.getRecoveryHoldBySource(
              'critical-intent',
              `critical-intent:${prepared.intentId}`
            );
            assert.equal(hold.status, 'active');
            assert.equal(hold.reasonCode, 'INSPECTOR_UNAVAILABLE');
            assert.equal(second.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
            assert.deepEqual(recoveryPersistenceCounts(second.database.db), {
              ownerTotal: baseline.ownerTotal + 3,
              ownerPrepared: 0,
              attemptTotal: baseline.attemptTotal + 1,
              attemptPrepared: 0,
              attemptUnbound: 0
            });
            return inspectExact(source);
          }
        });
        const recovered = await second.recoveryCoordinator.scanAndRecover();
        assert.equal(inspectorCalls, 1);
        assert.equal(recovered.sourceCount, 1);
        assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
        assertHeldDefinitiveRecoveryState(
          second,
          taskRunId,
          prepared.intentId,
          definitiveOutcome,
          'INSPECTOR_UNAVAILABLE'
        );
        const settledCounts = recoveryPersistenceCounts(second.database.db);
        assert.deepEqual(settledCounts, {
          ownerTotal: baseline.ownerTotal + (definitiveOutcome === 'committed' ? 8 : 9),
          ownerPrepared: 0,
          attemptTotal: baseline.attemptTotal + 2,
          attemptPrepared: 0,
          attemptUnbound: 0
        });
        second.database.close();
        second = null;

        third = openRecoveryLayer(harness.databasePath);
        const beforeThird = third.controlTransactionCount();
        const replay = await third.recoveryCoordinator.scanAndRecover();
        assert.equal(replay.sourceCount, 0);
        assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
        assert.equal(third.controlTransactionCount(), beforeThird);
        assert.deepEqual(recoveryPersistenceCounts(third.database.db), settledCounts);
      } finally {
        if (!harnessClosed) {
          await harness.runtime.shutdown();
          harness.database.close();
        }
        if (second) second.database.close();
        if (third) third.database.close();
      }
    });
  }
}

for (const definitiveOutcome of ['committed', 'not-committed']) {
  test(`active INSPECTOR_UNAVAILABLE Hold下anchor先于Task owner且崩溃后收敛${definitiveOutcome}`, async () => {
    let historicalPlan = true;
    const fault = { armed: false, order: [] };
    const harness = createHarness({
      planTransitions(input) {
        if (historicalPlan && input.phase === 'inspection-unavailable-hold') return [];
        return reconFixJpmRecoveryPlanTransitions(input);
      },
      wrapInspector() {
        return async () => {
          throw Object.assign(new Error('injected transient inspector failure'), {
            code: 'TEST_INSPECTOR_TRANSIENT'
          });
        };
      },
      wrapRequestOwnerRepository(base) {
        return wrapThresholdOwnerCrash(base, fault, 'task-owner');
      }
    });
    let harnessClosed = false;
    let second = null;
    let third = null;
    try {
      const operationKey = `active-hold-anchor-task-${definitiveOutcome}`;
      const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
      const fixture = buildCriticalFixture(harness, operationKey);
      const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
      const prepared = await harness.durable.prepareAndAck(identity);
      if (definitiveOutcome === 'committed') {
        commitCriticalFixture(harness, fixture, identity);
      }
      const first = await harness.recoveryCoordinator.scanAndRecover();
      assert.equal(first.activeHoldCount, 1);
      assert.equal(archive.getTaskRun(taskRunId).status, 'running');
      const activeHold = harness.readRepository.getRecoveryHoldBySource(
        'critical-intent',
        `critical-intent:${prepared.intentId}`
      );
      assert.equal(activeHold.status, 'active');
      assert.equal(activeHold.reasonCode, 'INSPECTOR_UNAVAILABLE');
      historicalPlan = false;
      const baseline = recoveryPersistenceCounts(harness.database.db);
      fault.armed = true;
      await assert.rejects(
        () => harness.recoveryCoordinator.scanAndRecover(),
        { code: 'TEST_THRESHOLD_STAGE_CRASH' }
      );
      assert.deepEqual(fault.order, ['anchor', 'task-owner']);
      assert.deepEqual(recoveryPersistenceCounts(harness.database.db), {
        ownerTotal: baseline.ownerTotal + 2,
        ownerPrepared: 2,
        attemptTotal: baseline.attemptTotal + 1,
        attemptPrepared: 1,
        attemptUnbound: 0
      });
      assert.equal(archive.getTaskRun(taskRunId).status, 'running');
      assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');

      await harness.runtime.shutdown();
      harness.database.close();
      harnessClosed = true;
      const inspectExact = createReconFixJpmOutcomeInspector({
        databasePath: harness.databasePath
      });
      let inspectorCalls = 0;
      second = openRecoveryLayer(harness.databasePath, {
        inspector: async (source) => {
          inspectorCalls += 1;
          const resumedTask = createArchiveRepository(second.database.db).getTaskRun(taskRunId);
          assert.equal(resumedTask.status, 'interrupted');
          assert.equal(resumedTask.failureCode, 'INSPECTOR_UNAVAILABLE');
          const resumedHold = second.readRepository.getRecoveryHoldBySource(
            'critical-intent',
            `critical-intent:${prepared.intentId}`
          );
          assert.equal(resumedHold.status, 'active');
          assert.deepEqual(recoveryPersistenceCounts(second.database.db), {
            ownerTotal: baseline.ownerTotal + 2,
            ownerPrepared: 0,
            attemptTotal: baseline.attemptTotal + 1,
            attemptPrepared: 0,
            attemptUnbound: 0
          });
          return inspectExact(source);
        }
      });
      const recovered = await second.recoveryCoordinator.scanAndRecover();
      assert.equal(inspectorCalls, 1);
      assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
      assertHeldDefinitiveRecoveryState(
        second,
        taskRunId,
        prepared.intentId,
        definitiveOutcome,
        'INSPECTOR_UNAVAILABLE'
      );
      const settledCounts = recoveryPersistenceCounts(second.database.db);
      assert.deepEqual(settledCounts, {
        ownerTotal: baseline.ownerTotal + (definitiveOutcome === 'committed' ? 7 : 8),
        ownerPrepared: 0,
        attemptTotal: baseline.attemptTotal + 2,
        attemptPrepared: 0,
        attemptUnbound: 0
      });
      second.database.close();
      second = null;

      third = openRecoveryLayer(harness.databasePath);
      const beforeThird = third.controlTransactionCount();
      const replay = await third.recoveryCoordinator.scanAndRecover();
      assert.equal(replay.sourceCount, 0);
      assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
      assert.equal(third.controlTransactionCount(), beforeThird);
      assert.deepEqual(recoveryPersistenceCounts(third.database.db), settledCounts);
    } finally {
      if (!harnessClosed) {
        await harness.runtime.shutdown();
        harness.database.close();
      }
      if (second) second.database.close();
      if (third) third.database.close();
    }
  });
}

for (const legacyStage of ['task-owner', 'task-unbound-attempt']) {
  for (const definitiveOutcome of ['committed', 'not-committed']) {
    test(`active Hold下71c1 legacy ${legacyStage}先清理再Inspector收敛${definitiveOutcome}`, async () => {
      const harness = createHarness({
        planTransitions(input) {
          return input.phase === 'inspection-unavailable-hold'
            ? []
            : reconFixJpmRecoveryPlanTransitions(input);
        },
        wrapInspector() {
          return async () => {
            throw Object.assign(new Error('injected transient inspector failure'), {
              code: 'TEST_INSPECTOR_TRANSIENT'
            });
          };
        }
      });
      let harnessClosed = false;
      let second = null;
      let third = null;
      try {
        const operationKey = `active-hold-legacy-${legacyStage}-${definitiveOutcome}`;
        const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
        const fixture = buildCriticalFixture(harness, operationKey);
        const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
        const prepared = await harness.durable.prepareAndAck(identity);
        if (definitiveOutcome === 'committed') {
          commitCriticalFixture(harness, fixture, identity);
        }
        const first = await harness.recoveryCoordinator.scanAndRecover();
        assert.equal(first.activeHoldCount, 1);
        assert.equal(archive.getTaskRun(taskRunId).status, 'running');
        const baseline = recoveryPersistenceCounts(harness.database.db);
        seedActiveHoldLegacyInspectionUnavailableGap(
          harness,
          prepared.intentId,
          legacyStage
        );
        const legacyAttemptCount = legacyStage === 'task-unbound-attempt' ? 1 : 0;
        assert.deepEqual(recoveryPersistenceCounts(harness.database.db), {
          ownerTotal: baseline.ownerTotal + 1,
          ownerPrepared: 1,
          attemptTotal: baseline.attemptTotal + legacyAttemptCount,
          attemptPrepared: legacyAttemptCount,
          attemptUnbound: legacyAttemptCount
        });

        await harness.runtime.shutdown();
        harness.database.close();
        harnessClosed = true;
        const inspectExact = createReconFixJpmOutcomeInspector({
          databasePath: harness.databasePath
        });
        let inspectorCalls = 0;
        second = openRecoveryLayer(harness.databasePath, {
          inspector: async (source) => {
            inspectorCalls += 1;
            assert.deepEqual(recoveryPersistenceCounts(second.database.db), baseline);
            const preInspectionTask = createArchiveRepository(second.database.db)
              .getTaskRun(taskRunId);
            assert.equal(preInspectionTask.status, 'running');
            const existingHold = second.readRepository.getRecoveryHoldBySource(
              'critical-intent',
              `critical-intent:${prepared.intentId}`
            );
            assert.equal(existingHold.status, 'active');
            assert.equal(existingHold.reasonCode, 'INSPECTOR_UNAVAILABLE');
            assert.equal(second.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
            return inspectExact(source);
          }
        });
        const recovered = await second.recoveryCoordinator.scanAndRecover();
        assert.equal(inspectorCalls, 1);
        assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
        assertHeldDefinitiveRecoveryState(
          second,
          taskRunId,
          prepared.intentId,
          definitiveOutcome,
          'INSPECTOR_UNAVAILABLE'
        );
        const settledCounts = recoveryPersistenceCounts(second.database.db);
        assert.deepEqual(settledCounts, {
          ownerTotal: baseline.ownerTotal + (definitiveOutcome === 'committed' ? 6 : 7),
          ownerPrepared: 0,
          attemptTotal: baseline.attemptTotal + 1,
          attemptPrepared: 0,
          attemptUnbound: 0
        });
        second.database.close();
        second = null;

        third = openRecoveryLayer(harness.databasePath);
        const beforeThird = third.controlTransactionCount();
        const replay = await third.recoveryCoordinator.scanAndRecover();
        assert.equal(replay.sourceCount, 0);
        assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
        assert.equal(third.controlTransactionCount(), beforeThird);
        assert.deepEqual(recoveryPersistenceCounts(third.database.db), settledCounts);
      } finally {
        if (!harnessClosed) {
          await harness.runtime.shutdown();
          harness.database.close();
        }
        if (second) second.database.close();
        if (third) third.database.close();
      }
    });
  }
}

for (const legacyStage of ['task-owner', 'hold-owner', 'unbound-attempt']) {
  for (const definitiveOutcome of ['committed', 'not-committed']) {
    test(`71c1 legacy ${legacyStage}残留先确定性清理再Inspector收敛${definitiveOutcome}`, async () => {
      const harness = createHarness();
      let harnessClosed = false;
      let second = null;
      let third = null;
      try {
        const operationKey = `legacy-threshold-${legacyStage}-${definitiveOutcome}`;
        const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
        const fixture = buildCriticalFixture(harness, operationKey);
        const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
        const prepared = await harness.durable.prepareAndAck(identity);
        if (definitiveOutcome === 'committed') {
          commitCriticalFixture(harness, fixture, identity);
        }
        const baseline = recoveryPersistenceCounts(harness.database.db);
        seedLegacyInspectionUnavailableGap(harness, prepared.intentId, legacyStage);
        const legacyOwnerCount = legacyStage === 'task-owner' ? 1 : 2;
        const legacyAttemptCount = legacyStage === 'unbound-attempt' ? 1 : 0;
        assert.deepEqual(recoveryPersistenceCounts(harness.database.db), {
          ownerTotal: baseline.ownerTotal + legacyOwnerCount,
          ownerPrepared: legacyOwnerCount,
          attemptTotal: baseline.attemptTotal + legacyAttemptCount,
          attemptPrepared: legacyAttemptCount,
          attemptUnbound: legacyAttemptCount
        });
        assert.equal(archive.getTaskRun(taskRunId).status, 'running');
        assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 0);
        assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');

        await harness.runtime.shutdown();
        harness.database.close();
        harnessClosed = true;
        const inspectExact = createReconFixJpmOutcomeInspector({
          databasePath: harness.databasePath
        });
        let inspectorCalls = 0;
        second = openRecoveryLayer(harness.databasePath, {
          inspector: async (source) => {
            inspectorCalls += 1;
            assert.deepEqual(recoveryPersistenceCounts(second.database.db), baseline);
            const preInspectionTask = createArchiveRepository(second.database.db)
              .getTaskRun(taskRunId);
            assert.equal(preInspectionTask.status, 'running');
            assert.equal(second.readRepository.getRecoveryHoldBySource(
              'critical-intent',
              `critical-intent:${prepared.intentId}`
            ), null);
            assert.equal(second.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
            return inspectExact(source);
          }
        });
        const recovered = await second.recoveryCoordinator.scanAndRecover();
        assert.equal(inspectorCalls, 1);
        assert.equal(recovered.sourceCount, 1);
        assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
        const finalTask = createArchiveRepository(second.database.db).getTaskRun(taskRunId);
        assert.equal(finalTask.status, 'interrupted');
        assert.equal(
          finalTask.failureCode,
          definitiveOutcome === 'committed' ? 'RESULT_LOST' : 'NOT_COMMITTED'
        );
        assert.equal(finalTask.metadata.recoveryHold, definitiveOutcome === 'committed');
        const finalHold = second.readRepository.getRecoveryHoldBySource(
          'critical-intent',
          `critical-intent:${prepared.intentId}`
        );
        if (definitiveOutcome === 'committed') {
          assert.equal(finalHold.status, 'active');
          assert.equal(finalHold.reasonCode, 'RESULT_LOST');
          assert.equal(finalHold.resolution, null);
        } else {
          assert.equal(finalHold, null);
        }
        assert.equal(second.readRepository.getCriticalIntentById(prepared.intentId).state, 'closed');
        const settledCounts = recoveryPersistenceCounts(second.database.db);
        assert.deepEqual(settledCounts, {
          ownerTotal: baseline.ownerTotal + (definitiveOutcome === 'committed' ? 5 : 4),
          ownerPrepared: 0,
          attemptTotal: baseline.attemptTotal + 1,
          attemptPrepared: 0,
          attemptUnbound: 0
        });
        second.database.close();
        second = null;

        third = openRecoveryLayer(harness.databasePath);
        const beforeThird = third.controlTransactionCount();
        const replay = await third.recoveryCoordinator.scanAndRecover();
        assert.equal(replay.sourceCount, 0);
        assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
        assert.equal(third.controlTransactionCount(), beforeThird);
        assert.deepEqual(recoveryPersistenceCounts(third.database.db), settledCounts);
      } finally {
        if (!harnessClosed) {
          await harness.runtime.shutdown();
          harness.database.close();
        }
        if (second) second.database.close();
        if (third) third.database.close();
      }
    });
  }
}

for (const definitiveOutcome of ['committed', 'not-committed']) {
  test(`INSPECTOR_UNAVAILABLE threshold bundle reserve后崩溃，重启先恢复bundle再收敛${definitiveOutcome}`, async () => {
    const fault = { armed: false };
    const harness = createHarness({
      planTransitions: reconFixJpmRecoveryPlanTransitions,
      wrapInspector() {
        return async () => {
          throw Object.assign(new Error('injected transient inspector failure'), {
            code: 'TEST_INSPECTOR_TRANSIENT'
          });
        };
      },
      wrapRecoveryControlRepository(base) {
        return Object.freeze({
          runInControlTransaction(work) {
            if (fault.armed) {
              fault.armed = false;
              throw Object.assign(new Error('injected post-threshold-owner crash'), {
                code: 'TEST_POST_THRESHOLD_OWNER_CRASH'
              });
            }
            return base.runInControlTransaction(work);
          }
        });
      }
    });
    let harnessClosed = false;
    let second = null;
    let third = null;
    try {
      const operationKey = `prepared-threshold-bundle-${definitiveOutcome}`;
      const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
      const fixture = buildCriticalFixture(harness, operationKey);
      const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
      const prepared = await harness.durable.prepareAndAck(identity);
      if (definitiveOutcome === 'committed') {
        commitCriticalFixture(harness, fixture, identity);
      }

      fault.armed = true;
      await assert.rejects(
        () => harness.recoveryCoordinator.scanAndRecover(),
        { code: 'TEST_POST_THRESHOLD_OWNER_CRASH' }
      );
      assert.equal(archive.getTaskRun(taskRunId).status, 'running');
      assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 0);
      assert.equal(harness.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM background_execution_recovery_request_owners
        WHERE status = 'prepared'
      `).get().count, 3);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM background_execution_recovery_observation_attempts
        WHERE status = 'prepared'
      `).get().count, 1);

      await harness.runtime.shutdown();
      harness.database.close();
      harnessClosed = true;
      second = openRecoveryLayer(harness.databasePath);
      const recovered = await second.recoveryCoordinator.scanAndRecover();
      assert.equal(recovered.sourceCount, 1);
      assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
      assertHeldDefinitiveRecoveryState(
        second,
        taskRunId,
        prepared.intentId,
        definitiveOutcome,
        'INSPECTOR_UNAVAILABLE'
      );
      assert.equal(second.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM background_execution_recovery_request_owners
        WHERE status = 'prepared'
      `).get().count, 0);
      assert.equal(second.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM background_execution_recovery_observation_attempts
        WHERE status = 'prepared'
      `).get().count, 0);
      assert.deepEqual(second.database.db.prepare(`
        SELECT event_type AS eventType, status
        FROM background_execution_recovery_observation_attempts
        ORDER BY event_type
      `).all().map((row) => ({ ...row })), [{
        eventType: 'inspection-completed',
        status: 'committed'
      }, {
        eventType: 'inspection-failed-transient',
        status: 'committed'
      }]);
      second.database.close();
      second = null;

      third = openRecoveryLayer(harness.databasePath);
      const beforeThird = third.controlTransactionCount();
      const replay = await third.recoveryCoordinator.scanAndRecover();
      assert.equal(replay.sourceCount, 0);
      assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
      assert.equal(third.controlTransactionCount(), beforeThird);
    } finally {
      if (!harnessClosed) {
        await harness.runtime.shutdown();
        harness.database.close();
      }
      if (second) second.database.close();
      if (third) third.database.close();
    }
  });
}

test('prepared threshold Task body不兼容时fail closed且不关闭Intent', async () => {
  const fault = { armed: false };
  const harness = createHarness({
    planTransitions(input) {
      const planned = reconFixJpmRecoveryPlanTransitions(input);
      if (input.phase !== 'inspection-unavailable-hold') return planned;
      return planned.map((item) => ({
        ...item,
        transition: {
          ...item.transition,
          failureMessage: 'persisted incompatible threshold body'
        }
      }));
    },
    wrapInspector() {
      return async () => {
        throw Object.assign(new Error('injected transient inspector failure'), {
          code: 'TEST_INSPECTOR_TRANSIENT'
        });
      };
    },
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          if (fault.armed) {
            fault.armed = false;
            throw Object.assign(new Error('injected post-threshold-owner crash'), {
              code: 'TEST_POST_THRESHOLD_OWNER_CRASH'
            });
          }
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  let harnessClosed = false;
  let second = null;
  try {
    const operationKey = 'prepared-threshold-body-conflict';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
    const prepared = await harness.durable.prepareAndAck(identity);
    fault.armed = true;
    await assert.rejects(
      () => harness.recoveryCoordinator.scanAndRecover(),
      { code: 'TEST_POST_THRESHOLD_OWNER_CRASH' }
    );
    await harness.runtime.shutdown();
    harness.database.close();
    harnessClosed = true;

    second = openRecoveryLayer(harness.databasePath);
    await assert.rejects(
      () => second.recoveryCoordinator.scanAndRecover(),
      { code: 'RECOVERY_REQUEST_KEY_CONFLICT' }
    );
    assert.equal(createArchiveRepository(second.database.db).getTaskRun(taskRunId).status, 'running');
    assert.equal(second.readRepository.getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${prepared.intentId}`
    ), null);
    assert.equal(second.readRepository.getCriticalIntentById(prepared.intentId).state, 'acked');
    assert.equal(second.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_recovery_request_owners
      WHERE status = 'prepared'
    `).get().count, 3);
    assert.equal(second.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_recovery_observation_attempts
      WHERE status = 'prepared'
    `).get().count, 1);
  } finally {
    if (!harnessClosed) {
      await harness.runtime.shutdown();
      harness.database.close();
    }
    if (second) second.database.close();
  }
});

for (const definitiveOutcome of ['committed', 'not-committed']) {
  test(`既有INSPECTOR_UNAVAILABLE Hold + running Task重启收敛${definitiveOutcome}且再重启零动作`, async () => {
    let inspectorUnavailable = true;
    const harness = createHarness({
      // 模拟 74bb754 reviewed head 已持久化的旧窗口：threshold 创建 Hold 时尚未
      // 规划 Task interruption；第二次 startup 改由当前 reason+state plan 收敛。
      planTransitions(input) {
        return input.phase === 'inspection-unavailable-hold'
          ? []
          : reconFixJpmRecoveryPlanTransitions(input);
      },
      wrapInspector(base) {
        return async (source) => {
          if (inspectorUnavailable) {
            throw Object.assign(new Error('injected transient inspector failure'), {
              code: 'TEST_INSPECTOR_TRANSIENT'
            });
          }
          return base(source);
        };
      }
    });
    let harnessClosed = false;
    let second = null;
    let third = null;
    try {
      const operationKey = `inspector-unavailable-${definitiveOutcome}`;
      const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
      const fixture = buildCriticalFixture(harness, operationKey);
      const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
      const prepared = await harness.durable.prepareAndAck(identity);
      if (definitiveOutcome === 'committed') {
        commitCriticalFixture(harness, fixture, identity);
      }

      const threshold = await harness.recoveryCoordinator.scanAndRecover();
      assert.equal(threshold.sourceCount, 1);
      assert.equal(threshold.activeHoldCount, 1);
      const activeHold = harness.readRepository.listActiveRecoveryHolds()[0];
      assert.equal(activeHold.reasonCode, 'INSPECTOR_UNAVAILABLE');
      const heldTask = archive.getTaskRun(taskRunId);
      assert.equal(heldTask.status, 'running');
      assert.equal(heldTask.failureCode, '');

      await harness.runtime.shutdown();
      harness.database.close();
      harnessClosed = true;
      inspectorUnavailable = false;
      second = openRecoveryLayer(harness.databasePath);
      const recovered = await second.recoveryCoordinator.scanAndRecover();
      assert.equal(recovered.sourceCount, 1);
      assert.equal(recovered.decisions[0].inspection.outcome, definitiveOutcome);
      assertHeldDefinitiveRecoveryState(
        second,
        taskRunId,
        prepared.intentId,
        definitiveOutcome,
        'INSPECTOR_UNAVAILABLE'
      );
      second.database.close();
      second = null;

      third = openRecoveryLayer(harness.databasePath);
      const beforeThird = third.controlTransactionCount();
      const replay = await third.recoveryCoordinator.scanAndRecover();
      assert.equal(replay.sourceCount, 0);
      assert.equal(replay.activeHoldCount, definitiveOutcome === 'committed' ? 1 : 0);
      assert.equal(third.controlTransactionCount(), beforeThird);
    } finally {
      if (!harnessClosed) {
        await harness.runtime.shutdown();
        harness.database.close();
      }
      if (second) second.database.close();
      if (third) third.database.close();
    }
  });
}

test('新INSPECTOR_UNAVAILABLE threshold把Task interruption与Hold同次收口', async () => {
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapInspector() {
      return async () => {
        throw Object.assign(new Error('injected transient inspector failure'), {
          code: 'TEST_INSPECTOR_TRANSIENT'
        });
      };
    }
  });
  try {
    const operationKey = 'inspector-unavailable-atomic-threshold';
    const { archive, taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    await harness.durable.prepareAndAck(criticalIdentity(operationKey, taskRunId, fixture.critical));
    const threshold = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(threshold.sourceCount, 1);
    assert.equal(threshold.activeHoldCount, 1);
    assert.equal(harness.readRepository.listActiveRecoveryHolds()[0].reasonCode, 'INSPECTOR_UNAVAILABLE');
    const heldTask = archive.getTaskRun(taskRunId);
    assert.equal(heldTask.status, 'interrupted');
    assert.equal(heldTask.failureCode, 'INSPECTOR_UNAVAILABLE');
    assert.equal(heldTask.metadata.recoveryHold, true);
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

test('COMMIT后receipt event丢失保持interrupted并创建RESULT_LOST Hold且不重跑mutation', async () => {
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
    assert.equal(recoveredTask.metadata.recoveryHold, true);
    const holds = harness.readRepository.listActiveRecoveryHolds();
    assert.equal(holds.length, 1);
    assert.equal(holds[0].reasonCode, 'RESULT_LOST');
    assert.equal(holds[0].taskRunId, taskRunId);
    assert.throws(() => harness.holdGate.assertMutationAllowed(), {
      code: 'RECOVERY_HOLD_ACTIVE'
    });
    assert.equal(harness.database.db.prepare(`
      SELECT COUNT(*) AS count FROM archive_batches WHERE task_run_id = ?
    `).get(taskRunId).count, 0);
    assert.equal(harness.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM background_execution_batch_recovery_states WHERE task_run_id = ?
    `).get(taskRunId).count, 0);
    const replay = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(replay.sourceCount, 0);
    assert.equal(replay.activeHoldCount, 1);
    assert.equal(harness.database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM recon_fix_adm_operation_receipts
      WHERE action_key = ? AND operation_key = ?
    `).get(RECON_FIX_RUN_JPM_ACTION, operationKey).count, 1);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('closed committed-result-lost仅在Intent/Hold exact identity与Task保护态完整时保留且重复startup零副作用', async () => {
  let inspectorCalls = 0;
  let controlTransactionCount = 0;
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapInspector(base) {
      return async (source) => {
        inspectorCalls += 1;
        return base(source);
      };
    },
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          controlTransactionCount += 1;
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  try {
    const operationKey = 'jpm-result-lost-retained-exact';
    const { taskRunId } = seedRunningReconTask(harness, operationKey);
    const fixture = buildCriticalFixture(harness, operationKey);
    const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
    const prepared = await harness.durable.prepareAndAck(identity);
    commitCriticalFixture(harness, fixture, identity);
    const recovered = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(recovered.sourceCount, 1);
    assert.equal(recovered.decisions[0].inspection.outcome, 'committed');
    const intent = harness.readRepository.getCriticalIntentByOperation(
      RECON_FIX_RUN_JPM_ACTION,
      operationKey,
      taskRunId
    );
    assert.equal(intent.intentId, prepared.intentId);
    assert.equal(intent.state, 'closed');
    const hold = harness.readRepository.getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${intent.intentId}`
    );
    assert.equal(hold.status, 'active');
    assert.equal(hold.reasonCode, 'RESULT_LOST');
    assert.equal(recovered.decisions[0].held, true);
    assert.equal(recovered.decisions[0].holdId, hold.holdId);
    const task = createArchiveRepository(harness.database.db).getTaskRun(taskRunId);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.failureCode, 'RESULT_LOST');
    assert.equal(task.metadata.recoveryHold, true);

    const baseline = Object.freeze({
      inspectorCalls,
      controlTransactionCount,
      admImageHash: readAdmRowsForWriteback(harness.database.db).imageHash,
      receiptCount: harness.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM recon_fix_adm_operation_receipts
        WHERE action_key = ? AND operation_key = ?
      `).get(RECON_FIX_RUN_JPM_ACTION, operationKey).count,
      holdCount: harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_holds
      `).get().count,
      eventCount: harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_events
      `).get().count
    });
    assert.equal(baseline.receiptCount, 1);
    assert.equal(baseline.holdCount, 1);

    function assertNoRecoverySideEffect() {
      assert.equal(inspectorCalls, baseline.inspectorCalls);
      assert.equal(controlTransactionCount, baseline.controlTransactionCount);
      assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, baseline.admImageHash);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count
        FROM recon_fix_adm_operation_receipts
        WHERE action_key = ? AND operation_key = ?
      `).get(RECON_FIX_RUN_JPM_ACTION, operationKey).count, baseline.receiptCount);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_holds
      `).get().count, baseline.holdCount);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_events
      `).get().count, baseline.eventCount);
      const retained = harness.database.db.prepare(`
        SELECT status, resolution FROM background_execution_recovery_holds
        WHERE hold_id = ?
      `).get(hold.holdId);
      assert.deepEqual({ ...retained }, { status: 'active', resolution: null });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = await harness.recoveryCoordinator.scanAndRecover();
      assert.equal(replay.sourceCount, 0);
      assert.equal(replay.activeHoldCount, 1);
      assertNoRecoverySideEffect();
    }

    const originalTask = harness.database.db.prepare(`
      SELECT task_key AS taskKey, status,
             failure_code AS failureCode, metadata_json AS metadataJson
      FROM archive_task_runs WHERE task_run_id = ?
    `).get(taskRunId);
    const originalHold = harness.database.db.prepare(`
      SELECT action_key AS actionKey, conflict_scope_key AS conflictScopeKey,
             reason_code AS reasonCode, safe_summary_json AS safeSummaryJson
      FROM background_execution_recovery_holds WHERE hold_id = ?
    `).get(hold.holdId);
    const driftCases = [{
      label: 'correlated Intent/Hold action identity',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET action_key = ? WHERE intent_id = ?
        `).run(`${RECON_FIX_RUN_JPM_ACTION}:drift`, intent.intentId);
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET action_key = ? WHERE hold_id = ?
        `).run(`${RECON_FIX_RUN_JPM_ACTION}:drift`, hold.holdId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET action_key = ? WHERE intent_id = ?
        `).run(RECON_FIX_RUN_JPM_ACTION, intent.intentId);
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET action_key = ? WHERE hold_id = ?
        `).run(originalHold.actionKey, hold.holdId);
      }
    }, {
      label: 'correlated Intent/Hold canonical conflict scope',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET conflict_scope_key = 'recon-fix:adm-writeback:drift'
          WHERE intent_id = ?
        `).run(intent.intentId);
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET conflict_scope_key = 'recon-fix:adm-writeback:drift'
          WHERE hold_id = ?
        `).run(hold.holdId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET conflict_scope_key = ? WHERE intent_id = ?
        `).run(intent.conflictScopeKey, intent.intentId);
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET conflict_scope_key = ? WHERE hold_id = ?
        `).run(originalHold.conflictScopeKey, hold.holdId);
      }
    }, {
      label: 'Intent coordinationKind',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET coordination_kind = 'main-owned-settlement' WHERE intent_id = ?
        `).run(intent.intentId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET coordination_kind = ? WHERE intent_id = ?
        `).run(intent.coordinationKind, intent.intentId);
      }
    }, {
      label: 'Task canonical taskKey',
      apply() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET task_key = 'recon-id-fix:drift' WHERE task_run_id = ?
        `).run(taskRunId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET task_key = ? WHERE task_run_id = ?
        `).run(originalTask.taskKey, taskRunId);
      }
    }, {
      label: 'closed Intent operation identity',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET operation_key = ? WHERE intent_id = ?
        `).run(`${operationKey}-drift`, intent.intentId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_critical_intents
          SET operation_key = ? WHERE intent_id = ?
        `).run(operationKey, intent.intentId);
      }
    }, {
      label: 'Hold source identity',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET source_ref = ? WHERE hold_id = ?
        `).run(`critical-intent:${intent.intentId}:drift`, hold.holdId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET source_ref = ? WHERE hold_id = ?
        `).run(`critical-intent:${intent.intentId}`, hold.holdId);
      }
    }, {
      label: 'Hold reason/summary correspondence',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET reason_code = 'INSPECTION_UNKNOWN' WHERE hold_id = ?
        `).run(hold.holdId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET reason_code = ? WHERE hold_id = ?
        `).run(originalHold.reasonCode, hold.holdId);
      }
    }, {
      label: 'Hold safeSummary',
      apply() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET safe_summary_json = ? WHERE hold_id = ?
        `).run(JSON.stringify({
          reasonCode: 'RESULT_LOST',
          disposition: 'committed-result-lost-drift'
        }), hold.holdId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE background_execution_recovery_holds
          SET safe_summary_json = ? WHERE hold_id = ?
        `).run(originalHold.safeSummaryJson, hold.holdId);
      }
    }, {
      label: 'Task status',
      apply() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET status = 'failed' WHERE task_run_id = ?
        `).run(taskRunId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET status = ? WHERE task_run_id = ?
        `).run(originalTask.status, taskRunId);
      }
    }, {
      label: 'Task failureCode',
      apply() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET failure_code = 'NOT_COMMITTED' WHERE task_run_id = ?
        `).run(taskRunId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET failure_code = ? WHERE task_run_id = ?
        `).run(originalTask.failureCode, taskRunId);
      }
    }, {
      label: 'Task recoveryHold',
      apply() {
        const metadata = JSON.parse(originalTask.metadataJson);
        metadata.recoveryHold = false;
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET metadata_json = ? WHERE task_run_id = ?
        `).run(JSON.stringify(metadata), taskRunId);
      },
      restore() {
        harness.database.db.prepare(`
          UPDATE archive_task_runs SET metadata_json = ? WHERE task_run_id = ?
        `).run(originalTask.metadataJson, taskRunId);
      }
    }];

    for (const drift of driftCases) {
      drift.apply();
      try {
        await assert.rejects(
          () => harness.recoveryCoordinator.scanAndRecover(),
          { code: 'STARTUP_RECOVERY_HOLD_SOURCE_MISSING' },
          `${drift.label} drift must fail closed`
        );
        assertNoRecoverySideEffect();
      } finally {
        drift.restore();
      }
      const restoredReplay = await harness.recoveryCoordinator.scanAndRecover();
      assert.equal(restoredReplay.sourceCount, 0);
      assert.equal(restoredReplay.activeHoldCount, 1);
      assertNoRecoverySideEffect();
    }
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('open unknown/unavailable Hold的correlated scope漂移在Inspector前fail closed且JPM gate持续阻断', async () => {
  for (const initialReason of ['INSPECTION_UNKNOWN', 'INSPECTOR_UNAVAILABLE']) {
    let inspectorUnavailable = initialReason === 'INSPECTOR_UNAVAILABLE';
    let inspectorCalls = 0;
    let controlTransactionCount = 0;
    const harness = createHarness({
      planTransitions: reconFixJpmRecoveryPlanTransitions,
      wrapInspector(base) {
        return async (source) => {
          inspectorCalls += 1;
          if (inspectorUnavailable) {
            throw Object.assign(new Error('injected transient inspector failure'), {
              code: 'TEST_INSPECTOR_TRANSIENT'
            });
          }
          return base(source);
        };
      },
      wrapRecoveryControlRepository(base) {
        return Object.freeze({
          runInControlTransaction(work) {
            controlTransactionCount += 1;
            return base.runInControlTransaction(work);
          }
        });
      }
    });
    try {
      const operationKey = `open-correlated-scope-${initialReason.toLowerCase()}`;
      let taskRunId;
      let intentId;
      if (initialReason === 'INSPECTION_UNKNOWN') {
        const seeded = await establishUnknownPostWithoutReceipt(harness, operationKey);
        taskRunId = seeded.taskRunId;
        intentId = seeded.intentId;
        harness.database.db.exec('BEGIN IMMEDIATE');
        try {
          receiptRepository.insertOperationReceipt(harness.database.db, {
            actionKey: RECON_FIX_RUN_JPM_ACTION,
            operationKey,
            producerTaskRunId: taskRunId,
            scenarioId: seeded.critical.scenarioId,
            preImageHash: seeded.critical.preImageHash,
            postImageHash: seeded.critical.postImageHash,
            idSequenceDigest: seeded.critical.idSequenceDigest,
            rowCount: seeded.critical.rowCount,
            changedRowCount: seeded.critical.changedRowCount
          });
          harness.database.db.exec('COMMIT');
        } catch (error) {
          if (harness.database.db.isTransaction) harness.database.db.exec('ROLLBACK');
          throw error;
        }
      } else {
        const seeded = seedRunningReconTask(harness, operationKey);
        taskRunId = seeded.taskRunId;
        const fixture = buildCriticalFixture(harness, operationKey);
        const identity = criticalIdentity(operationKey, taskRunId, fixture.critical);
        const prepared = await harness.durable.prepareAndAck(identity);
        intentId = prepared.intentId;
        commitCriticalFixture(harness, fixture, identity);
        const threshold = await harness.recoveryCoordinator.scanAndRecover();
        assert.equal(threshold.sourceCount, 1);
        assert.equal(threshold.activeHoldCount, 1);
        inspectorUnavailable = false;
      }

      const intent = harness.readRepository.getCriticalIntentById(intentId);
      const hold = harness.readRepository.getRecoveryHoldBySource(
        'critical-intent',
        `critical-intent:${intentId}`
      );
      assert.equal(intent.state, 'acked');
      assert.equal(hold.status, 'active');
      assert.equal(hold.reasonCode, initialReason);
      assert.equal(createArchiveRepository(harness.database.db).getTaskRun(taskRunId).status,
        'interrupted');
      const baseline = Object.freeze({
        inspectorCalls,
        controlTransactionCount,
        admImageHash: readAdmRowsForWriteback(harness.database.db).imageHash,
        eventCount: harness.database.db.prepare(`
          SELECT COUNT(*) AS count FROM background_execution_recovery_events
        `).get().count,
        holdCount: harness.database.db.prepare(`
          SELECT COUNT(*) AS count FROM background_execution_recovery_holds
        `).get().count
      });

      harness.database.db.prepare(`
        UPDATE background_execution_critical_intents
        SET conflict_scope_key = 'recon-fix:adm-writeback:drift'
        WHERE intent_id = ?
      `).run(intentId);
      harness.database.db.prepare(`
        UPDATE background_execution_recovery_holds
        SET conflict_scope_key = 'recon-fix:adm-writeback:drift'
        WHERE hold_id = ?
      `).run(hold.holdId);
      assert.throws(() => harness.holdGate.assertMutationAllowed(), {
        code: 'RECOVERY_HOLD_ACTIVE'
      });
      await assert.rejects(
        () => harness.recoveryCoordinator.scanAndRecover(),
        { code: 'STARTUP_RECOVERY_SOURCE_AUTHORITY_CONFLICT' }
      );
      assert.equal(inspectorCalls, baseline.inspectorCalls);
      assert.equal(controlTransactionCount, baseline.controlTransactionCount);
      assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, baseline.admImageHash);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_events
      `).get().count, baseline.eventCount);
      assert.equal(harness.database.db.prepare(`
        SELECT COUNT(*) AS count FROM background_execution_recovery_holds
      `).get().count, baseline.holdCount);
      assert.equal(harness.readRepository.getCriticalIntentById(intentId).state, 'acked');
      assert.equal(harness.readRepository.getRecoveryHoldBySource(
        'critical-intent',
        `critical-intent:${intentId}`
      ).status, 'active');

      harness.database.db.prepare(`
        UPDATE background_execution_critical_intents
        SET conflict_scope_key = ? WHERE intent_id = ?
      `).run(intent.conflictScopeKey, intentId);
      harness.database.db.prepare(`
        UPDATE background_execution_recovery_holds
        SET conflict_scope_key = ? WHERE hold_id = ?
      `).run(hold.conflictScopeKey, hold.holdId);
      const definitive = await harness.recoveryCoordinator.scanAndRecover();
      assert.equal(definitive.decisions[0].inspection.outcome, 'committed');
      assert.equal(definitive.decisions[0].held, true);
      assert.equal(definitive.decisions[0].holdId, hold.holdId);
      const task = createArchiveRepository(harness.database.db).getTaskRun(taskRunId);
      assert.equal(task.status, 'interrupted');
      assert.equal(task.failureCode, 'RESULT_LOST');
      assert.equal(task.metadata.recoveryHold, true);
      assert.equal(harness.readRepository.getCriticalIntentById(intentId).state, 'closed');
      assert.equal(harness.readRepository.getRecoveryHoldBySource(
        'critical-intent',
        `critical-intent:${intentId}`
      ).status, 'active');
    } finally {
      await harness.runtime.shutdown();
      harness.database.close();
    }
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

test('unknown经人工补齐exact receipt后保持active Hold与interrupted RESULT_LOST', async () => {
  let controlTransactionCount = 0;
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          controlTransactionCount += 1;
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  try {
    const recovered = await establishUnknownPostWithoutReceipt(
      harness,
      'unknown-converges-committed'
    );
    harness.database.db.exec('BEGIN IMMEDIATE');
    try {
      receiptRepository.insertOperationReceipt(harness.database.db, {
        actionKey: RECON_FIX_RUN_JPM_ACTION,
        operationKey: recovered.identity.parentOperationKey,
        producerTaskRunId: recovered.taskRunId,
        scenarioId: recovered.critical.scenarioId,
        preImageHash: recovered.critical.preImageHash,
        postImageHash: recovered.critical.postImageHash,
        idSequenceDigest: recovered.critical.idSequenceDigest,
        rowCount: recovered.critical.rowCount,
        changedRowCount: recovered.critical.changedRowCount
      });
      harness.database.db.exec('COMMIT');
    } catch (error) {
      if (harness.database.db.isTransaction) harness.database.db.exec('ROLLBACK');
      throw error;
    }

    const beforeDefinitive = controlTransactionCount;
    const second = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(controlTransactionCount - beforeDefinitive, 1);
    assert.equal(second.decisions[0].inspection.outcome, 'committed');
    const task = recovered.archive.getTaskRun(recovered.taskRunId);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.failureCode, 'RESULT_LOST');
    assert.equal(task.metadata.recoveryHold, true);
    assert.equal(task.metadata.recoveryOutcome, 'committed');
    assert.equal(harness.readRepository.getCriticalIntentById(recovered.intentId).state, 'closed');
    const hold = harness.readRepository.getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${recovered.intentId}`
    );
    assert.equal(hold.status, 'active');
    assert.equal(hold.reasonCode, 'INSPECTION_UNKNOWN');
    assert.equal(hold.resolution, null);
    assert.equal(second.decisions[0].held, true);
    assert.equal(second.decisions[0].holdId, hold.holdId);
    assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 1);
    assert.throws(() => harness.holdGate.assertMutationAllowed(), {
      code: 'RECOVERY_HOLD_ACTIVE'
    });

    const beforeThird = controlTransactionCount;
    const third = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(third.sourceCount, 0);
    assert.equal(third.activeHoldCount, 1);
    assert.equal(recovered.archive.getTaskRun(recovered.taskRunId).status, 'interrupted');
    assert.equal(harness.readRepository.getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${recovered.intentId}`
    ).status, 'active');
    assert.equal(controlTransactionCount, beforeThird);
  } finally {
    await harness.runtime.shutdown();
    harness.database.close();
  }
});

test('unknown经人工恢复exact pre后原子收敛not-committed并第三次startup幂等', async () => {
  let controlTransactionCount = 0;
  const harness = createHarness({
    planTransitions: reconFixJpmRecoveryPlanTransitions,
    wrapRecoveryControlRepository(base) {
      return Object.freeze({
        runInControlTransaction(work) {
          controlTransactionCount += 1;
          return base.runInControlTransaction(work);
        }
      });
    }
  });
  try {
    const recovered = await establishUnknownPostWithoutReceipt(
      harness,
      'unknown-converges-not-committed'
    );
    harness.database.db.prepare(
      'UPDATE linked_adm_bank_deposit SET raw_json = ? WHERE id = 1'
    ).run(recovered.before.rows[0].rawJsonText);

    const beforeDefinitive = controlTransactionCount;
    const second = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(controlTransactionCount - beforeDefinitive, 1);
    assert.equal(second.decisions[0].inspection.outcome, 'not-committed');
    assert.equal(second.decisions[0].held, false);
    assert.equal(Object.hasOwn(second.decisions[0], 'holdId'), false);
    const task = recovered.archive.getTaskRun(recovered.taskRunId);
    assert.equal(task.status, 'failed');
    assert.equal(task.failureCode, 'NOT_COMMITTED');
    assert.equal(task.metadata.recoveryHold, false);
    assert.equal(task.metadata.recoveryOutcome, 'not-committed');
    assert.equal(harness.readRepository.getCriticalIntentById(recovered.intentId).state, 'closed');
    const hold = harness.readRepository.getRecoveryHoldBySource(
      'critical-intent',
      `critical-intent:${recovered.intentId}`
    );
    assert.equal(hold.status, 'resolved');
    assert.equal(hold.resolution, 'not-committed');
    assert.equal(harness.readRepository.listActiveRecoveryHolds().length, 0);
    assert.equal(readAdmRowsForWriteback(harness.database.db).imageHash, recovered.before.imageHash);

    const beforeThird = controlTransactionCount;
    const third = await harness.recoveryCoordinator.scanAndRecover();
    assert.equal(third.sourceCount, 0);
    assert.equal(third.activeHoldCount, 0);
    assert.equal(controlTransactionCount, beforeThird);
  } finally {
    await harness.runtime.shutdown();
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
      databaseIdentity: deriveReconFixJpmDatabaseIdentity(harness.databasePath),
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
