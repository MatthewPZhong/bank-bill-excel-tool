'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const XLSX = require('xlsx');

const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const {
  BANK_STATEMENT_SHEET_NAME
} = require('../../../src/main-process/bank-statement-io');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  FUND_RECON_ACTIONS,
  validateFundReconImportResult
} = require('../../../src/main-process/fund-recon-worker/policies');

function writeBankWorkbook(filePath, rowCount) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows.push(BANK_STATEMENT_FIELDS.map((header) => `${header}-${rowIndex + 1}`));
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BANK_STATEMENT_FIELDS, ...rows]),
    BANK_STATEMENT_SHEET_NAME
  );
  XLSX.writeFile(workbook, filePath);
}

function operationContext(operationKey) {
  return Object.freeze({
    kind: 'operation',
    value: Object.freeze({
      taskRunId: `task-run-${operationKey}`,
      taskKey: 'task.fund-recon:e06-a',
      moduleId: 'fund-recon',
      parentRunId: 'parent-run-e06-a',
      operationKey
    })
  });
}

test('真实native Worker复用Service、完成PersistentReservation替换并在shutdown释放资源', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-recon-worker-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firstPath = path.join(dir, 'first.xlsx');
  const secondPath = path.join(dir, 'second.xlsx');
  writeBankWorkbook(firstPath, 1);
  writeBankWorkbook(secondPath, 2);

  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 4 * (2 ** 30),
    totalMemoryBytes: 4 * (2 ** 30),
    memoryHardCeilingBytes: 2 * (2 ** 30),
    systemReserveBytes: 0,
    executionTimeoutMs: 10000,
    shutdownTimeoutMs: 10000
  });
  let shutdown = false;
  t.after(async () => {
    if (!shutdown) await runtime.shutdown({ timeoutMs: 10000 });
  });

  const firstOperationKey = 'fund-recon-import-first';
  await assert.rejects(
    runtime.execute({
      actionKey: FUND_RECON_ACTIONS.IMPORT,
      operationKey: firstOperationKey,
      production: true,
      context: operationContext(firstOperationKey),
      input: { sources: [{ kind: 'bank', filePath: firstPath }] }
    }),
    (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
  );
  const first = await runtime.execute({
    actionKey: FUND_RECON_ACTIONS.IMPORT,
    operationKey: firstOperationKey,
    production: false,
    context: operationContext(firstOperationKey),
    input: { sources: [{ kind: 'bank', filePath: firstPath }] }
  });
  assert.equal(first.outcome, 'completed', JSON.stringify(first));
  assert.equal(first.terminalSource, 'job:done');
  assert.equal(validateFundReconImportResult(first.result), true);
  assert.equal(first.result.stateRevision, 1);
  assert.equal(first.result.summary.bankRowCount, 1);
  assert.equal(JSON.stringify(first.result).includes(dir), false);

  const secondOperationKey = 'fund-recon-import-second';
  const second = await runtime.execute({
    actionKey: FUND_RECON_ACTIONS.IMPORT,
    operationKey: secondOperationKey,
    production: false,
    context: operationContext(secondOperationKey),
    input: { sources: [{ kind: 'bank', filePath: secondPath }] }
  });
  assert.equal(second.outcome, 'completed');
  assert.equal(second.terminalSource, 'job:done');
  assert.equal(validateFundReconImportResult(second.result), true);
  assert.equal(second.result.stateRevision, 2);
  assert.equal(second.result.summary.bankRowCount, 2);
  assert.equal(second.result.summary.sourceFileCount, 1);
  assert.equal(JSON.stringify(second.result).includes(dir), false);

  const report = await runtime.shutdown({ timeoutMs: 10000 });
  shutdown = true;
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(runtime.resourceGovernor.snapshot().activeDependencyCount, 0);
});
