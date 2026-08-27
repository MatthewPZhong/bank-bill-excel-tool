'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const { BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../../src/backend/database/background-execution-schema');
const {
  createBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createWorkerThreadAdapter
} = require('../../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  validateDuplicateImportResult
} = require('../../../../src/main-process/duplicate-inbound-match/policies');
const {
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider,
  operationSource
} = require('../../../../src/main-process/duplicate-inbound-match/startup-recovery');
const mirrorRepository = require(
  '../../../../src/backend/database/duplicate-inbound-match-run-repository'
);

const ROOT = path.resolve(__dirname, '../../../..');

function writeWorkbook(filePath, headers, sheetName, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    sheetName
  );
  XLSX.writeFile(workbook, filePath);
}

function operationContext(operationKey) {
  return { kind: 'operation', value: {
    taskRunId: `task-${operationKey}`,
    taskKey: 'duplicate-inbound-match:import-files',
    moduleId: 'duplicate',
    parentRunId: 'parent-duplicate-runtime',
    operationKey
  } };
}

function initializeMainDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  ensureDuplicateInboundMatchRunMetadataSupport(db);
  ensureBackgroundExecutionRecoveryControlSchema(db);
  db.close();
}

function startupGateDescriptor() {
  return { contractVersion: 1, startupRecoveryReady: true };
}

function requiredWorkerDurableCoordinator() {
  return Object.freeze({
    prepareAndAck() { throw new Error('E07-A service command不发布E07-B live receipt'); },
    observeReceipt() { throw new Error('unexpected'); },
    settleCommitted() { throw new Error('unexpected'); },
    resolveUncertain() { throw new Error('unexpected'); }
  });
}

function listRunMirrors(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return mirrorRepository.listRunMirrors(db);
  } finally {
    db.close();
  }
}

test('真实native Worker跨两条import复用单Service、crash后exact receipt允许新generation安全续跑', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-native-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const bankOne = path.join(dir, 'bank-one.xlsx');
  const bankTwo = path.join(dir, 'bank-two.xlsx');
  const row = (bizId) => BANK_STATEMENT_FIELDS.map((field) => field === 'BizId' ? bizId : '');
  writeWorkbook(bankOne, BANK_STATEMENT_FIELDS, '渠道对账单', [row('BIZ-1')]);
  writeWorkbook(bankTwo, BANK_STATEMENT_FIELDS, '渠道对账单', [row('BIZ-2'), row('BIZ-3')]);
  const coordinator = requiredWorkerDurableCoordinator();
  const nativeWorkerAdapter = createWorkerThreadAdapter();
  const workerHandles = [];
  const capturingWorkerAdapter = Object.freeze({
    kind: nativeWorkerAdapter.kind,
    start(startOptions) {
      const handle = nativeWorkerAdapter.start(startOptions);
      workerHandles.push(handle);
      return handle;
    }
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
    duplicateStartupGate: startupGateDescriptor(),
    workerDurableCoordinator: coordinator,
    workerThreadAdapter: capturingWorkerAdapter
  });
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const workerRuntime = {
    userDataDir: dir,
    databasePath,
    mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
    bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx')
  };
  const executeImport = (operationKey, bankPath) => runtime.execute({
    actionKey: 'duplicate:import',
    operationKey,
    production: false,
    context: operationContext(operationKey),
    input: { runtime: workerRuntime, filePaths: [bankPath, documentPath] }
  });
  assert.throws(() => runtime.start({
    actionKey: 'duplicate:import', operationKey: 'production-disabled', production: true,
    context: operationContext('production-disabled'), input: {}
  }), (error) => error.code === 'POLICY_PRODUCTION_DISABLED');
  const first = await executeImport('duplicate-import-1', bankOne);
  assert.equal(first.outcome, 'completed');
  assert.equal(validateDuplicateImportResult(first.result), true);
  assert.equal(first.result.stateRevision, 2);
  assert.equal(first.result.summary.bankRowCount, 1);
  const second = await executeImport('duplicate-import-2', bankTwo);
  assert.equal(second.outcome, 'completed');
  assert.equal(second.result.stateRevision, 4, '同一长驻Service保留generation内revision');
  assert.equal(second.result.summary.bankRowCount, 2);
  assert.equal(JSON.stringify(second.result).includes(dir), false);
  assert.equal(workerHandles.length, 1, '前两条命令复用同一Worker generation');
  await workerHandles[0].worker.terminate();
  for (let attempt = 0;
    attempt < 50 && runtime.resourceGovernor.snapshot().activeLeaseCount !== 0;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0, 'crash释放旧generation资源');
  const sideDirectory = path.join(dir, 'run-data', 'duplicate-inbound-match');
  const beforeRetry = fs.readdirSync(sideDirectory).sort();
  const afterCrash = await executeImport('duplicate-import-after-crash', bankOne);
  assert.equal(afterCrash.outcome, 'completed');
  assert.deepEqual(fs.readdirSync(sideDirectory).sort(), beforeRetry,
    'crash后新generation保留旧receipt/side证据并追加新bundle');
  assert.equal(workerHandles.length, 2, 'crash后必须cold-start新Worker generation');
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});

test('active Hold阻断managed runtime import且零删持久证据', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-native-hold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const db = new DatabaseSync(databasePath);
  db.prepare(`
    INSERT INTO background_execution_recovery_holds (
      hold_id, source_kind, source_ref, intent_id, action_key,
      operation_key, task_run_id, conflict_scope_key, reason_code,
      status, resolution, safe_summary_json, created_at, updated_at, resolved_at
    ) VALUES (?, 'module-recovery', ?, NULL, 'duplicate:run', ?, ?, ?,
      'INSPECTION_UNKNOWN', 'active', NULL, '{}', ?, ?, NULL)
  `).run(
    'hold:duplicate-runtime-test',
    'module-recovery:duplicate-inbound-match:v1',
    'duplicate-startup-recovery:v1',
    'duplicate-startup-recovery:v1',
    DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
    '2026-08-27T00:00:00.000Z',
    '2026-08-27T00:00:00.000Z'
  );
  db.close();
  const sideDirectory = path.join(dir, 'run-data', 'duplicate-inbound-match');
  fs.mkdirSync(sideDirectory, { recursive: true });
  const evidencePath = path.join(sideDirectory, 'month-2026-07.sqlite');
  fs.writeFileSync(evidencePath, 'hold-evidence-must-survive');
  const evidenceBefore = fs.readFileSync(evidencePath);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
    duplicateStartupGate: startupGateDescriptor(),
    workerDurableCoordinator: requiredWorkerDurableCoordinator()
  });
  let shutdown = false;
  t.after(async () => { if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 }); });
  const result = await runtime.execute({
    actionKey: 'duplicate:import',
    operationKey: 'duplicate-active-hold',
    production: false,
    context: operationContext('duplicate-active-hold'),
    input: {
      runtime: {
        userDataDir: dir,
        databasePath,
        mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
        bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx')
      },
      filePaths: [path.join(dir, 'bank.xlsx'), path.join(dir, 'document.xlsx')]
    }
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'RECOVERY_HOLD_ACTIVE');
  assert.deepEqual(fs.readFileSync(evidencePath), evidenceBefore);
  assert.deepEqual(fs.readdirSync(sideDirectory), ['month-2026-07.sqlite']);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.errors, []);
});

test('normal close保留exact side receipt且下次startup inspector判committed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-native-close-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  initializeMainDatabase(databasePath);
  const documentPath = path.join(dir, 'document.xlsx');
  const bankPath = path.join(dir, 'bank.xlsx');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const row = BANK_STATEMENT_FIELDS.map((field) => field === 'BizId' ? 'CLOSE-BIZ' : '');
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [row]);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
    duplicateStartupGate: startupGateDescriptor(),
    workerDurableCoordinator: requiredWorkerDurableCoordinator()
  });
  const imported = await runtime.execute({
    actionKey: 'duplicate:import', operationKey: 'duplicate-close-import', production: false,
    context: operationContext('duplicate-close-import'), input: {
      runtime: {
        userDataDir: dir, databasePath,
        mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
        bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx')
      },
      filePaths: [bankPath, documentPath]
    }
  });
  assert.equal(imported.outcome, 'completed');
  const sideDirectory = path.join(dir, 'run-data', 'duplicate-inbound-match');
  assert.equal(fs.readdirSync(sideDirectory).some((name) => name.endsWith('.sqlite')), true);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.errors, []);
  const source = operationSource({
    actionKey: 'duplicate:import',
    operationKey: 'duplicate-close-import',
    producerTaskRunId: 'task-duplicate-close-import'
  });
  const inspection = await createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => listRunMirrors(databasePath)
  })(source);
  assert.equal(inspection.outcome, 'committed');
  assert.equal(inspection.boundedEvidence.importBundleId > 0, true);
});
