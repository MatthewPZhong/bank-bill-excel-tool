'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureArchiveMetadataSupport
} = require('../../../backend/database/archive-repository');
const { canonicalSha256 } = require('../canonical-json-v1');
const {
  createRecoveryControlReadRepository
} = require('../critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../critical/recovery-control-repository');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../critical/recovery-request-owner-repository');
const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../execution-policy-registry');
const { createInspectorRegistry } = require('../inspector-registry');
const { transitionRequestKey } = require('../recovery-control-contract');
const { createResourceGovernor } = require('../resource-governor');
const {
  createSettlementRecoveryProviderRegistry
} = require('../settlement-recovery-provider-registry');
const { createStartupRecoveryCoordinator } = require('../startup-recovery-coordinator');
const { createExecutionSupervisor } = require('../supervisor');
const canary = require('./index');
const {
  createCanaryReceiptInspector,
  ensureCanaryReceiptSchema,
  runWorkerDurableCanary
} = require('./durable-recovery');
const {
  REPORT_CHECK_KEYS,
  REPORT_MODE,
  serializePackagedRuntimeReport
} = require('./packaged-runtime-request');

const CANARY_SCHEMA_PATH = require.resolve('./canary-schema');
const DURABLE_WORKER_PATH = require.resolve('./durable-worker');

function canaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code)
    ? error.code
    : 'PACKAGED_CANARY_FAILED';
}

function pathUsesAppAsar(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized.endsWith('/app.asar') || normalized.includes('/app.asar/');
}

function assertPackagedLayout(options = {}) {
  const electronApp = options.app;
  if (!electronApp || electronApp.isPackaged !== true) {
    throw canaryError('PACKAGED_CANARY_NOT_PACKAGED', 'packaged canary 只允许 packaged Electron');
  }
  const appPath = electronApp.getAppPath();
  const requiredPaths = [
    appPath,
    options.moduleDir || __dirname,
    options.workerPath || canary.PURE_COMPUTE_WORKER_ENTRY,
    options.durableWorkerPath || DURABLE_WORKER_PATH,
    options.schemaPath || CANARY_SCHEMA_PATH
  ];
  if (!requiredPaths.every(pathUsesAppAsar)) {
    throw canaryError('PACKAGED_CANARY_ASAR_LAYOUT_INVALID', 'packaged canary 入口未全部来自 app.asar');
  }
  return true;
}

function createChecks() {
  return Object.fromEntries(REPORT_CHECK_KEYS.map((key) => [key, false]));
}

function buildReport(state, status) {
  return {
    schemaVersion: 1,
    mode: REPORT_MODE,
    status,
    packaged: state.packaged,
    appAsar: state.appAsar,
    checks: Object.fromEntries(REPORT_CHECK_KEYS.map((key) => [key, state.checks[key]]))
  };
}

function writePackagedRuntimeReport(request, report) {
  const serialized = serializePackagedRuntimeReport(report);
  const parent = path.dirname(request.reportPath);
  if (parent !== request.runnerTemp || !fs.statSync(parent).isDirectory()) {
    throw canaryError('PACKAGED_CANARY_REPORT_PARENT_INVALID', 'packaged canary report parent 非法');
  }
  let fd = null;
  try {
    fd = fs.openSync(request.reportPath, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function buildSupervisor() {
  const entryRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_ENTRY_KEY]: canary.PURE_COMPUTE_WORKER_BINDING
  });
  const validatorRegistry = createStaticRegistry({
    [canary.PURE_COMPUTE_RESULT_VALIDATOR_KEY]: canary.validatePureComputeCanaryResult
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({
    policies: [canary.pureComputePolicy],
    entryRegistry,
    validatorRegistry,
    staticKeys: { resourceProfileKeys: [canary.pureComputePolicy.resources.profile] }
  });
  policyRegistry.freeze();
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 16,
      workerThreadSlots: 16,
      utilityProcessSlots: 4,
      ioHeavySlots: 16,
      memoryBytes: 4 * 1024 * 1024 * 1024
    }
  });
  return {
    resourceGovernor,
    supervisor: createExecutionSupervisor({
      policyRegistry,
      entryRegistry,
      validatorRegistry,
      resourceGovernor,
      executionTimeoutMs: 10000,
      shutdownTimeoutMs: 2000
    })
  };
}

async function waitUntilRunning(supervisor, jobId) {
  for (let count = 0; count < 200; count += 1) {
    const diagnostics = supervisor.inspect(jobId);
    if (diagnostics && diagnostics.state === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw canaryError('PACKAGED_CANARY_WORKER_START_TIMEOUT', 'canary worker 未进入 running');
}

async function runWorkerLifecycleProbe(state) {
  const { supervisor, resourceGovernor } = buildSupervisor();
  let shutdownComplete = false;
  try {
    const completed = await supervisor.execute({
      actionKey: canary.PURE_COMPUTE_ACTION_KEY,
      operationKey: 'packaged-runtime-complete',
      jobId: 'packaged-runtime-complete-job',
      input: { values: [1, 2, 3], rounds: 20 }
    });
    if (completed.outcome !== 'completed' || completed.terminalSource !== 'job:done' ||
        !canary.validatePureComputeCanaryResult(completed.result)) {
      throw canaryError('PACKAGED_CANARY_WORKER_COMPLETE_INVALID', 'real Worker complete 结果非法');
    }
    state.checks.workerComplete = true;

    const cancelJobId = 'packaged-runtime-cancel-job';
    const cancellationExecution = supervisor.execute({
      actionKey: canary.PURE_COMPUTE_ACTION_KEY,
      operationKey: 'packaged-runtime-cancel',
      jobId: cancelJobId,
      input: { values: new Array(100).fill(1), rounds: 1000000 }
    });
    await waitUntilRunning(supervisor, cancelJobId);
    const cancellationRequest = await supervisor.cancel(cancelJobId, { reason: 'packaged-canary-shutdown' });
    const shutdownReport = await supervisor.shutdown({ timeoutMs: 2000 });
    shutdownComplete = true;
    const cancelled = await cancellationExecution;
    const governor = resourceGovernor.snapshot();
    const clean = cancellationRequest.accepted === false
      && cancelled.outcome === 'cancelled'
      && cancelled.error && cancelled.error.code === 'CANARY_CANCELLED'
      && shutdownReport.cancelledJobs.length === 1
      && shutdownReport.cancelledJobs[0] === cancelJobId
      && shutdownReport.leakedTransports.length === 0
      && shutdownReport.errors.length === 0
      && governor.activeLeaseCount === 0
      && governor.activeDependencyCount === 0
      && governor.queued.size === 0;
    if (!clean) {
      throw canaryError('PACKAGED_CANARY_SHUTDOWN_LEAK', 'supervisor shutdown/cancel 存在泄漏');
    }
    state.checks.shutdownNoLeak = true;
  } finally {
    if (!shutdownComplete) {
      await supervisor.shutdown({ timeoutMs: 2000 }).catch(() => {});
    }
  }
}

function openPrivateDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    ensureArchiveMetadataSupport(db);
    ensureCanaryReceiptSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transition(db, value, safePayload) {
  const request = createRecoveryRequestOwnerRepository(db).reserveTransitionRequest({
    requestKey: transitionRequestKey(value),
    transition: value,
    safePayload
  });
  return createRecoveryControlRepository(db).runInControlTransaction(
    (tx) => tx.transitionWithRecoveryEvent(request)
  );
}

function createIntent(db) {
  const evidence = { expectedValue: 'durable-value' };
  const input = {
    contractVersion: 1,
    intentId: 'intent-packaged-runtime-canary',
    actionKey: 'background-execution:canary',
    operationKey: 'operation-packaged-runtime-canary',
    taskRunId: 'task-packaged-runtime-canary',
    jobId: 'job-packaged-runtime-canary',
    coordinationKind: 'worker-critical',
    conflictScopeKey: 'scope:packaged-runtime-canary',
    inspectorKey: 'inspector.background-execution:canary',
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(evidence),
    boundedEvidence: evidence
  };
  transition(db, { entityKind: 'critical-intent', command: 'create-prepared', input }, { state: 'prepared' });
  transition(db, {
    entityKind: 'critical-intent',
    command: 'mark-acked',
    intentId: input.intentId,
    expectedState: 'prepared',
    patch: { admission: 'packaged-canary' }
  }, { state: 'acked' });
  return input;
}

function quickCheckIsOk(db) {
  const rows = db.prepare('PRAGMA quick_check').all();
  return rows.length === 1 && Object.values(rows[0]).length === 1 && Object.values(rows[0])[0] === 'ok';
}

async function runRecoveryProbe(state, dbPath) {
  let db = openPrivateDatabase(dbPath);
  let input;
  try {
    input = createIntent(db);
  } finally {
    db.close();
    db = null;
  }

  const crash = await runWorkerDurableCanary({
    dbPath,
    operationKey: input.operationKey,
    value: 'durable-value',
    committedAt: '2026-08-24T00:00:00.000Z',
    crashAfterCommit: true
  });
  if (crash.status !== 'crashed-after-commit') {
    throw canaryError('PACKAGED_CANARY_DURABLE_CRASH_INVALID', 'durable Worker 未在 COMMIT 后 crash');
  }
  state.checks.durableCrashAfterCommit = true;

  try {
    db = openPrivateDatabase(dbPath);
    if (!quickCheckIsOk(db)) {
      throw canaryError('PACKAGED_CANARY_SQLITE_QUICK_CHECK_FAILED', 'private SQLite quick_check 失败');
    }
    state.checks.quickCheck = true;

    const inspectorRegistry = createInspectorRegistry();
    inspectorRegistry.register(input.inspectorKey, createCanaryReceiptInspector(db));
    inspectorRegistry.freeze();
    const providerRegistry = createSettlementRecoveryProviderRegistry();
    providerRegistry.freeze();
    const coordinator = createStartupRecoveryCoordinator({
      readRepository: createRecoveryControlReadRepository(db),
      inspectorRegistry,
      providerRegistry,
      requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
      observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
      recoveryControlRepository: createRecoveryControlRepository(db),
      backoffBaseMs: 0,
      backoffMaxMs: 0
    });
    const first = await coordinator.scanAndRecover();
    const eventCountAfterFirst = db.prepare(`
      SELECT COUNT(*) AS count FROM background_execution_recovery_events
      WHERE intent_id = ?
    `).get(input.intentId).count;
    const second = await coordinator.scanAndRecover();
    const eventCountAfterSecond = db.prepare(`
      SELECT COUNT(*) AS count FROM background_execution_recovery_events
      WHERE intent_id = ?
    `).get(input.intentId).count;
    const intent = createRecoveryControlReadRepository(db).getCriticalIntentById(input.intentId);
    const receiptCount = db.prepare(`
      SELECT COUNT(*) AS count FROM background_execution_canary_receipts
      WHERE operation_key = ?
    `).get(input.operationKey).count;
    if (first.sourceCount !== 1 || second.sourceCount !== 0 || intent.state !== 'closed' ||
        receiptCount !== 1 || eventCountAfterFirst !== eventCountAfterSecond) {
      throw canaryError('PACKAGED_CANARY_STARTUP_EXACTLY_ONCE_FAILED', 'fresh startup recovery 非 exactly-once');
    }
    state.checks.startupExactlyOnce = true;
  } finally {
    if (db) db.close();
  }
}

async function executePackagedRuntimeCanary(request, state) {
  if (canary.pureComputePolicy.production.enabled !== false ||
      canary.durableRecoveryPolicy.production.enabled !== false ||
      canary.pureComputePolicy.production.effectiveMode !== 'legacy' ||
      canary.durableRecoveryPolicy.production.effectiveMode !== 'legacy') {
    throw canaryError('PACKAGED_CANARY_PRODUCTION_POLICY_ENABLED', 'canary production policy 必须关闭');
  }
  state.checks.productionPoliciesDisabled = true;

  const prefix = path.join(request.runnerTemp, 'bank-bill-packaged-canary-');
  const privateDirectory = fs.mkdtempSync(prefix);
  let cleanupFailed = false;
  try {
    await runWorkerLifecycleProbe(state);
    await runRecoveryProbe(state, path.join(privateDirectory, 'private-control.sqlite'));
  } finally {
    try {
      fs.rmSync(privateDirectory, { recursive: true, force: false });
    } catch (_error) {
      cleanupFailed = true;
      state.checks.shutdownNoLeak = false;
    }
  }
  if (cleanupFailed) {
    throw canaryError('PACKAGED_CANARY_PRIVATE_CLEANUP_FAILED', 'packaged canary private directory 清理失败');
  }
}

async function runPackagedRuntimeCanary(options = {}) {
  const request = options.request;
  const electronApp = options.app;
  const state = {
    packaged: Boolean(electronApp && electronApp.isPackaged === true),
    appAsar: false,
    checks: createChecks()
  };
  try {
    (options.assertLayout || assertPackagedLayout)({ app: electronApp });
    state.appAsar = true;
    await (options.execute || executePackagedRuntimeCanary)(request, state);
    writePackagedRuntimeReport(request, buildReport(state, 'PASS'));
    return Object.freeze({ exitCode: 0, errorCode: null });
  } catch (error) {
    if (state.packaged && state.appAsar && REPORT_CHECK_KEYS.every((key) => state.checks[key])) {
      state.checks.shutdownNoLeak = false;
    }
    try {
      writePackagedRuntimeReport(request, buildReport(state, 'FAIL'));
    } catch (writeError) {
      return Object.freeze({ exitCode: 1, errorCode: safeErrorCode(writeError) });
    }
    return Object.freeze({ exitCode: 1, errorCode: safeErrorCode(error) });
  }
}

module.exports = {
  CANARY_SCHEMA_PATH,
  DURABLE_WORKER_PATH,
  assertPackagedLayout,
  buildReport,
  executePackagedRuntimeCanary,
  pathUsesAppAsar,
  runPackagedRuntimeCanary,
  safeErrorCode,
  writePackagedRuntimeReport
};
