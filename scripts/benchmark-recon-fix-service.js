'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_SERVICE_KEY
} = require('../src/main-process/recon-id-fix-service/policies');
const {
  MAX_PHASE_EXTENSION_BYTES
} = require('../src/main-process/recon-id-fix-service/service');

const MATRIX_CASES = Object.freeze([
  Object.freeze({ name: 'scale-5k', rows: 5000 }),
  Object.freeze({ name: 'scale-10k', rows: 10000 }),
  Object.freeze({ name: 'near-phase-admission-boundary', rows: 9750 })
]);

function parseRows(argv) {
  const token = argv.find((item) => item.startsWith('--rows='));
  const rows = token ? Number(token.slice('--rows='.length)) : 5000;
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 50000) {
    throw new TypeError('--rows 必须是 1..50000 的安全整数');
  }
  return rows;
}

function parseCaseName(argv, rowCount) {
  const token = argv.find((item) => item.startsWith('--case-name='));
  return token ? token.slice('--case-name='.length) : `rows-${rowCount}`;
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

function memoryEnvelope(snapshot) {
  return snapshot.activeLeases.reduce(
    (total, lease) => total + lease.resources.memoryBytes,
    0
  );
}

function memoryByLeaseKind(snapshot) {
  const totals = {};
  for (const lease of snapshot.activeLeases) {
    totals[lease.kind] = (totals[lease.kind] || 0) + lease.resources.memoryBytes;
  }
  return totals;
}

function dynamicPhaseMemory(snapshot) {
  return snapshot.activeLeases
    .filter((lease) => lease.kind === 'phase' &&
      lease.actionKey === `service:${RECON_FIX_SERVICE_KEY}`)
    .reduce((total, lease) => total + lease.resources.memoryBytes, 0);
}

function createRssLeaseSampler(runtime, baselineRssBytes) {
  let currentPhase = 'idle';
  let peak = null;
  let maxObservedRssBytes = baselineRssBytes;
  let maxHeldLeaseEnvelopeBytes = 0;
  const maxDynamicPhaseByOperation = { import: 0, run: 0 };
  const sample = () => {
    const rssBytes = process.memoryUsage().rss;
    const snapshot = runtime.resourceGovernor.snapshot();
    const heldLeaseEnvelopeBytes = memoryEnvelope(snapshot);
    const dynamicPhaseExtensionBytes = dynamicPhaseMemory(snapshot);
    maxObservedRssBytes = Math.max(maxObservedRssBytes, rssBytes);
    maxHeldLeaseEnvelopeBytes = Math.max(maxHeldLeaseEnvelopeBytes, heldLeaseEnvelopeBytes);
    if (Object.hasOwn(maxDynamicPhaseByOperation, currentPhase)) {
      maxDynamicPhaseByOperation[currentPhase] = Math.max(
        maxDynamicPhaseByOperation[currentPhase],
        dynamicPhaseExtensionBytes
      );
    }
    if (dynamicPhaseExtensionBytes > 0 && (!peak || rssBytes > peak.rssBytes)) {
      peak = {
        rssBytes,
        rssDeltaBytes: Math.max(0, rssBytes - baselineRssBytes),
        heldLeaseEnvelopeBytes,
        dynamicPhaseExtensionBytes,
        phase: currentPhase,
        leaseMemoryByKind: memoryByLeaseKind(snapshot)
      };
    }
  };
  sample();
  const timer = setInterval(sample, 2);
  return Object.freeze({
    setPhase(value) { currentPhase = value; sample(); },
    stop() {
      clearInterval(timer);
      sample();
      return Object.freeze({
        peak: peak && Object.freeze({
          ...peak,
          leaseMemoryByKind: Object.freeze({ ...peak.leaseMemoryByKind })
        }),
        maxObservedRssBytes,
        maxHeldLeaseEnvelopeBytes,
        maxDynamicPhaseByOperation: Object.freeze({ ...maxDynamicPhaseByOperation })
      });
    }
  });
}

async function runCase(rowCount, caseName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-fix-service-benchmark-'));
  const filePath = path.join(dir, 'recon-fix-scale.xlsx');
  let runtime;
  let sampler;
  try {
    writeFixture(filePath, rowCount);
    runtime = createBackgroundExecutionRuntime({
      availableParallelism: 4,
      freeMemoryBytes: 8 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      shutdownTimeoutMs: 10000
    });
    const baselineRssBytes = process.memoryUsage().rss;
    sampler = createRssLeaseSampler(runtime, baselineRssBytes);
    sampler.setPhase('import');
    const imported = await runtime.execute(request(RECON_FIX_IMPORT_ACTION, 'benchmark-import', {
      expectedRevision: 0, filePath, subMode: 'business'
    }));
    assert.equal(imported.outcome, 'completed');
    const afterImport = runtime.resourceGovernor.snapshot();
    const importedPersistent = afterImport.activeLeases.find((lease) => lease.kind === 'persistent');
    assert.ok(importedPersistent);
    assert.equal(afterImport.activeLeases.some((lease) => lease.kind === 'phase'), false);
    sampler.setPhase('run');
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
    sampler.setPhase('settled');
    const sampled = sampler.stop();
    sampler = null;
    assert.equal(run.outcome, 'completed');
    assert.ok(Buffer.byteLength(JSON.stringify(run.result), 'utf8') < 8192);
    const active = runtime.resourceGovernor.snapshot();
    assert.equal(active.activeLeaseCount, 2);
    const persistent = active.activeLeases.find((lease) => lease.kind === 'persistent');
    assert.ok(persistent);
    assert.equal(active.activeLeases.some((lease) => lease.kind === 'phase'), false);
    assert.ok(sampled.maxDynamicPhaseByOperation.import > 0);
    assert.ok(sampled.maxDynamicPhaseByOperation.run > 0);
    assert.ok(sampled.peak, '必须在 dynamic phase-extension 持有期间取得 RSS 样本');
    assert.ok(
      sampled.peak.rssDeltaBytes <= sampled.peak.heldLeaseEnvelopeBytes,
      `peak RSS delta ${sampled.peak.rssDeltaBytes} exceeds held lease envelope ` +
        `${sampled.peak.heldLeaseEnvelopeBytes} during ${sampled.peak.phase}`
    );
    const report = {
      caseName,
      rowCountPerSide: rowCount,
      totalInputRows: rowCount * 2,
      inputFileBytes: fs.statSync(filePath).size,
      serviceGeneration: run.result.serviceGeneration,
      revision: run.result.revision,
      resultDtoBytes: Buffer.byteLength(JSON.stringify(run.result), 'utf8'),
      importedPersistentReservationBytes: importedPersistent.resources.memoryBytes,
      persistentReservationBytes: persistent.resources.memoryBytes,
      maxPhaseExtensionBytes: MAX_PHASE_EXTENSION_BYTES,
      importPhaseExtensionBytes: sampled.maxDynamicPhaseByOperation.import,
      runPhaseExtensionBytes: sampled.maxDynamicPhaseByOperation.run,
      baselineRssBytes,
      peakScope: 'dynamic-phase-extension-active',
      peakRssBytes: sampled.peak.rssBytes,
      peakRssDeltaBytes: sampled.peak.rssDeltaBytes,
      peakPhase: sampled.peak.phase,
      peakHeldLeaseEnvelopeBytes: sampled.peak.heldLeaseEnvelopeBytes,
      peakDynamicPhaseExtensionBytes: sampled.peak.dynamicPhaseExtensionBytes,
      peakLeaseMemoryByKind: sampled.peak.leaseMemoryByKind,
      maxHeldLeaseEnvelopeBytes: sampled.maxHeldLeaseEnvelopeBytes,
      maxObservedRssBytes: sampled.maxObservedRssBytes,
      maxObservedRssDeltaBytes: Math.max(0, sampled.maxObservedRssBytes - baselineRssBytes),
      peakLeaseHeadroomBytes:
        sampled.peak.heldLeaseEnvelopeBytes - sampled.peak.rssDeltaBytes,
      rssWithinHeldLeaseEnvelope: true
    };
    const governor = runtime.resourceGovernor;
    const shutdown = await runtime.shutdown({ timeoutMs: 10000 });
    runtime = null;
    assert.deepEqual(shutdown.leakedTransports, []);
    assert.deepEqual(shutdown.errors, []);
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    assert.equal(governor.snapshot().activeDependencyCount, 0);
    return report;
  } finally {
    if (sampler) sampler.stop();
    if (runtime) await runtime.shutdown({ timeoutMs: 10000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runMatrix() {
  const reports = MATRIX_CASES.map((item) => {
    const child = spawnSync(process.execPath, [
      __filename,
      '--internal-case',
      `--rows=${item.rows}`,
      `--case-name=${item.name}`
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    if (child.status !== 0) {
      const error = new Error(`benchmark case ${item.name} failed\n${child.stderr || child.stdout}`);
      error.code = 'RECON_FIX_BENCHMARK_CASE_FAILED';
      throw error;
    }
    return JSON.parse(child.stdout);
  });
  const boundary = reports.find((report) => report.caseName === 'near-phase-admission-boundary');
  const boundaryPhaseBytes = Math.max(
    boundary.importPhaseExtensionBytes,
    boundary.runPhaseExtensionBytes
  );
  assert.ok(boundaryPhaseBytes >= Math.floor(MAX_PHASE_EXTENSION_BYTES * 0.9));
  assert.ok(boundaryPhaseBytes <= MAX_PHASE_EXTENSION_BYTES);
  assert.ok(reports.every((report) => report.rssWithinHeldLeaseEnvelope === true));
  return Object.freeze({
    gate: 'PASS',
    cases: reports,
    nearBoundaryUtilization: boundaryPhaseBytes / MAX_PHASE_EXTENSION_BYTES
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--internal-case') && !argv.some((item) => item.startsWith('--rows='))) {
    console.log(JSON.stringify(runMatrix(), null, 2));
    return;
  }
  const rowCount = parseRows(argv);
  const report = await runCase(rowCount, parseCaseName(argv, rowCount));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
