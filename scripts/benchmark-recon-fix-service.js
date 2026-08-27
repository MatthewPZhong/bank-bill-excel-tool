'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS,
  ORDER_REPAIR_SHEET_NAME,
  RECON_RESULT_FIELDS,
  RECON_RESULT_SHEET_NAME
} = require('../src/constants/recon-id-fix-fields');
const {
  createBackgroundExecutionRuntime
} = require('../src/main-process/background-execution/runtime');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_RUN_READONLY_ACTION
} = require('../src/main-process/recon-id-fix-service/policies');

function parseRows(argv) {
  const token = argv.find((item) => item.startsWith('--rows='));
  const rows = token ? Number(token.slice('--rows='.length)) : 5000;
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 50000) {
    throw new TypeError('--rows 必须是 1..50000 的安全整数');
  }
  return rows;
}

function appendSheet(workbook, name, fields, rows = []) {
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      fields.slice(),
      ...rows.map((row) => fields.map((field) => row[field] === undefined ? '' : row[field]))
    ]),
    name
  );
}

function writeFixture(filePath, rowCount) {
  const business = [];
  const opponent = [];
  for (let index = 0; index < rowCount; index += 1) {
    business.push({
      BillDate: '2026-08-27', BillType: 'biz', OrderId: `MAIN-${index}`,
      Currency: 'CNY', Amount: index + 1, reconId: ''
    });
    opponent.push({
      BillDate: '2026-08-27', BillType: 'other', OrderId: `OPP-${index}`,
      Currency: 'CNY', Amount: index + 1, reconId: `RID-${index}`
    });
  }
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, RECON_RESULT_SHEET_NAME, RECON_RESULT_FIELDS);
  appendSheet(workbook, BUSINESS_BILL_SHEET_NAME, BUSINESS_BILL_FIELDS, business);
  appendSheet(workbook, OPPONENT_BILL_SHEET_NAME, OPPONENT_BILL_FIELDS, opponent);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME, ORDER_REPAIR_FIELDS);
  XLSX.writeFile(workbook, filePath);
}

function request(actionKey, operationKey, input) {
  return {
    actionKey,
    operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: `task-${operationKey}`,
        taskKey: 'task.recon-fix:e11-a-benchmark',
        moduleId: 'recon-fix',
        parentRunId: 'parent-e11-a-benchmark',
        operationKey
      }
    },
    input
  };
}

async function main() {
  const rowCount = parseRows(process.argv.slice(2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-fix-service-benchmark-'));
  const filePath = path.join(dir, 'recon-fix-scale.xlsx');
  let runtime;
  let sampler;
  try {
    writeFixture(filePath, rowCount);
    const baselineRssBytes = process.memoryUsage().rss;
    let peakRssBytes = baselineRssBytes;
    sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);
    runtime = createBackgroundExecutionRuntime({
      availableParallelism: 4,
      freeMemoryBytes: 8 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      shutdownTimeoutMs: 10000
    });
    const imported = await runtime.execute(request(RECON_FIX_IMPORT_ACTION, 'benchmark-import', {
      expectedRevision: 0, filePath, subMode: 'business'
    }));
    assert.equal(imported.outcome, 'completed');
    const afterImport = runtime.resourceGovernor.snapshot();
    const importedPersistent = afterImport.activeLeases.find((lease) => lease.kind === 'persistent');
    assert.ok(importedPersistent);
    const run = await runtime.execute(request(RECON_FIX_RUN_READONLY_ACTION, 'benchmark-run', {
      bocDatabasePath: null,
      expectedRevision: 1,
      scenario: {
        id: 1,
        category: 'recon-id-fix',
        name: 'E11-A scale probe',
        priority: 0,
        enabled: true,
        config: {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [],
          reconGroups: [],
          output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SCALE' } }
        }
      }
    }));
    clearInterval(sampler);
    sampler = null;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    assert.equal(run.outcome, 'completed');
    assert.ok(Buffer.byteLength(JSON.stringify(run.result), 'utf8') < 8192);
    const active = runtime.resourceGovernor.snapshot();
    assert.equal(active.activeLeaseCount, 2);
    const persistent = active.activeLeases.find((lease) => lease.kind === 'persistent');
    assert.ok(persistent);
    const report = {
      rowCountPerSide: rowCount,
      totalInputRows: rowCount * 2,
      inputFileBytes: fs.statSync(filePath).size,
      serviceGeneration: run.result.serviceGeneration,
      revision: run.result.revision,
      resultDtoBytes: Buffer.byteLength(JSON.stringify(run.result), 'utf8'),
      importedPersistentReservationBytes: importedPersistent.resources.memoryBytes,
      persistentReservationBytes: persistent.resources.memoryBytes,
      declaredReplacementEnvelopeBytes:
        67108864 + 201326592 +
        importedPersistent.resources.memoryBytes + persistent.resources.memoryBytes,
      baselineRssBytes,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes)
    };
    const shutdown = await runtime.shutdown({ timeoutMs: 10000 });
    runtime = null;
    assert.deepEqual(shutdown.leakedTransports, []);
    assert.deepEqual(shutdown.errors, []);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (sampler) clearInterval(sampler);
    if (runtime) await runtime.shutdown({ timeoutMs: 10000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
