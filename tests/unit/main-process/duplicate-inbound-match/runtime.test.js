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
  createBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createWorkerThreadAdapter
} = require('../../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  validateDuplicateImportResult
} = require('../../../../src/main-process/duplicate-inbound-match/policies');

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

test('真实native Worker跨两条import复用单Service、替换reservation并在shutdown释放', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-native-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(databasePath);
  ensureDuplicateInboundMatchRunMetadataSupport(db);
  db.close();
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const bankOne = path.join(dir, 'bank-one.xlsx');
  const bankTwo = path.join(dir, 'bank-two.xlsx');
  const row = (bizId) => BANK_STATEMENT_FIELDS.map((field) => field === 'BizId' ? bizId : '');
  writeWorkbook(bankOne, BANK_STATEMENT_FIELDS, '渠道对账单', [row('BIZ-1')]);
  writeWorkbook(bankTwo, BANK_STATEMENT_FIELDS, '渠道对账单', [row('BIZ-2'), row('BIZ-3')]);
  const coordinator = {
    prepareAndAck() { throw new Error('E07-A service command不发布E07-B live receipt'); },
    observeReceipt() { throw new Error('unexpected'); },
    settleCommitted() { throw new Error('unexpected'); },
    resolveUncertain() { throw new Error('unexpected'); }
  };
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
  const afterCrash = await executeImport('duplicate-import-after-crash', bankOne);
  assert.equal(afterCrash.outcome, 'completed');
  assert.equal(afterCrash.result.stateRevision, 2, 'crash后新generation不得继承旧revision/state');
  assert.equal(workerHandles.length, 2, 'crash后必须cold-start新Worker generation');
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
});
