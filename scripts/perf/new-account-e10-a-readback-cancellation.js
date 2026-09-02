'use strict';

// E10-A 最大合法 shape 的真实 Worker 回读/取消探针。
// 每个场景放在独立子进程，避免 250k/最大文本 workbook 的 SheetJS 对照回读彼此保留 heap。
// 用法：node scripts/perf/new-account-e10-a-readback-cancellation.js

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');

const { extractHeaders } = require('../../src/backend/file-service/readers');
const { normalizeCell } = require('../../src/backend/file-service/common');
const {
  parseDateValue,
  parseNumericValue
} = require('../../src/backend/file-service/normalizers');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const {
  createWorkerThreadAdapter
} = require('../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  canonicalSha256
} = require('../../src/main-process/background-execution/canonical-json-v1');
const {
  createBackgroundExecutionRuntime
} = require('../../src/main-process/background-execution/runtime');
const {
  MAX_RECORDS,
  NEW_ACCOUNT_GENERATION_ACTION
} = require('../../src/main-process/new-account/generation-contract');
const {
  formatDateLabel,
  prepareNewAccountGeneration,
  readBackAndValidate
} = require('../../src/main-process/new-account/generation-core');
const {
  generateAndValidateNewAccount
} = require('../../src/main-process/new-account/worker-client');

const TEMPLATE_PATH = path.resolve(__dirname, '../../assets/余额账单模版.xlsx');
const SHORT_250K = Object.freeze([
  Object.freeze({ dayCount: 2500, currencyCount: 50, bankName: 'B0', location: 'L', bankAccount: 'A0' }),
  Object.freeze({ dayCount: 2500, currencyCount: 50, bankName: 'B1', location: 'L', bankAccount: 'A1' })
]);
const LONG_60416 = Object.freeze([
  Object.freeze({
    dayCount: 944,
    currencyCount: 64,
    bankName: '银'.repeat(256),
    location: '地'.repeat(256),
    bankAccount: '账'.repeat(256),
    currencyFactory: (index) => `${'币'.repeat(62)}${String(index).padStart(2, '0')}`
  })
]);

function isoDateBefore(asOfDate, days) {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function createOptions(dir, scenario, shapes) {
  const asOfDate = '2030-01-01';
  const accounts = shapes.map((shape, accountIndex) => {
    const currencies = Array.from({ length: shape.currencyCount }, (_, currencyIndex) => (
      typeof shape.currencyFactory === 'function'
        ? shape.currencyFactory(currencyIndex)
        : `C${String(currencyIndex).padStart(2, '0')}`
    ));
    return {
      bankName: shape.bankName || `测试银行${accountIndex}`,
      location: shape.location || '上海',
      bankAccount: shape.bankAccount || `A${accountIndex}`,
      openingDate: isoDateBefore(asOfDate, shape.dayCount),
      isMultiCurrency: currencies.length > 1,
      currency: currencies[0],
      currencies
    };
  });
  const stagingRoot = path.join(dir, 'staging');
  const generationPath = path.join(stagingRoot, 'new-account-balance.xlsx');
  const finalPath = path.join(dir, 'final-must-not-exist.xlsx');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const operationKey = `new-account-e10-a-${scenario}`;
  return {
    filePlan: normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{
        filePath: TEMPLATE_PATH,
        originalName: path.basename(TEMPLATE_PATH),
        role: 'new-account-template',
        sourceOperation: NEW_ACCOUNT_GENERATION_ACTION
      }],
      outputs: [{
        filePath: finalPath,
        originalName: path.basename(finalPath),
        role: 'new-account-output',
        sourceOperation: NEW_ACCOUNT_GENERATION_ACTION
      }]
    }),
    templatePath: TEMPLATE_PATH,
    payload: { accounts },
    asOfDate,
    stagingRoot,
    stagingResourceId: 'new-account-balance.xlsx',
    generationPath,
    operationKey,
    context: Object.freeze({
      kind: 'operation',
      value: {
        taskRunId: `task-${scenario}`,
        taskKey: 'task.new-account:generate',
        moduleId: 'new-account',
        parentRunId: `parent-${scenario}`,
        operationKey
      }
    }),
    production: false
  };
}

function createRuntime(workerThreadAdapter) {
  return createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 12 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    memoryHardCeilingBytes: 4 * 1024 ** 3,
    systemReserveBytes: 0,
    workerThreadAdapter,
    shutdownTimeoutMs: 10000
  });
}

function createStageAdapter(pauseStage) {
  const nativeAdapter = createWorkerThreadAdapter();
  const channel = new MessageChannel();
  let resolvePaused;
  let rejectPaused;
  const paused = new Promise((resolve, reject) => {
    resolvePaused = resolve;
    rejectPaused = reject;
  });
  channel.port1.on('message', (message) => {
    if (message && message.kind === 'new-account-readback-stage' && message.paused === true) {
      resolvePaused(message);
    }
  });
  channel.port1.on('messageerror', rejectPaused);
  return {
    paused,
    close() { channel.port1.close(); },
    adapter: Object.freeze({
      kind: 'worker-thread',
      start(startOptions) {
        const entry = typeof startOptions.entry === 'string'
          ? { path: startOptions.entry }
          : startOptions.entry;
        return nativeAdapter.start({
          ...startOptions,
          entry: {
            ...entry,
            workerData: {
              testReadbackStagePort: channel.port2,
              testReadbackPauseStage: pauseStage,
              testReadbackPauseOccurrence: 1
            },
            transferList: [channel.port2]
          }
        });
      }
    })
  };
}

function legacyBusinessEvidence(headers, records) {
  const amountHeaders = new Set(['期初余额', '期初可用余额', '期末余额', '期末可用余额']);
  const canonical = records.map((row) => row.map((value, index) => {
    if (headers[index] === '账单日期') {
      const date = parseDateValue(value);
      return date ? formatDateLabel(date) : '';
    }
    if (amountHeaders.has(headers[index])) {
      const amount = parseNumericValue(value);
      return amount === null ? '' : amount;
    }
    return normalizeCell(value);
  }));
  const select = (header) => headers
    .map((value, index) => value === header ? index : -1)
    .filter((index) => index >= 0);
  const dates = select('账单日期');
  const accounts = select('银行账号');
  const currencies = select('币种');
  return {
    recordsSha256: canonicalSha256(canonical),
    datesSha256: canonicalSha256(canonical.map((row) => dates.map((index) => row[index]))),
    accountsSha256: canonicalSha256(canonical.map((row) => accounts.map((index) => row[index]))),
    currenciesSha256: canonicalSha256(canonical.map((row) => currencies.map((index) => row[index])))
  };
}

async function waitWithTimeout(promise, label, timeoutMs = 30000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

async function runCancellationScenario(scenario, pauseStage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${scenario}-`));
  const options = createOptions(dir, scenario, SHORT_250K);
  const stageControl = createStageAdapter(pauseStage);
  const runtime = createRuntime(stageControl.adapter);
  let cleanupCalls = 0;
  try {
    const generation = generateAndValidateNewAccount({
      ...options,
      runtime,
      onOwnedGenerationCleanup() { cleanupCalls += 1; }
    });
    const stage = await waitWithTimeout(stageControl.paused, pauseStage);
    assert.equal(stage.stage, pauseStage);
    assert.ok(fs.existsSync(options.generationPath));
    assert.ok(fs.statSync(options.generationPath).size > 0);
    const cancelStartedAt = Date.now();
    const shutdown = runtime.shutdown({ timeoutMs: 10000 });
    const result = await generation;
    const report = await shutdown;
    const cancelElapsedMs = Date.now() - cancelStartedAt;
    assert.ok(cancelElapsedMs < 5000, `${pauseStage}: ${cancelElapsedMs}ms`);
    assert.equal(result.execution.outcome, 'cancelled');
    assert.equal(result.execution.terminalSource, 'job:error');
    assert.equal(result.execution.result, null);
    assert.equal(result.generated, null);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(fs.readdirSync(options.stagingRoot), []);
    assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);
    assert.equal(report.cancelledJobs.length, 1);
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    assert.equal(runtime.resourceGovernor.snapshot().activeUsage.memoryBytes, 0);
    process.stdout.write(`${JSON.stringify({ scenario, rows: 250000, pauseStage, cancelElapsedMs })}\n`);
  } finally {
    stageControl.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runNormalScenario(scenario, shapes, expectedRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${scenario}-`));
  const options = createOptions(dir, scenario, shapes);
  const runtime = createRuntime(createWorkerThreadAdapter());
  let ticks = 0;
  let peakRss = process.memoryUsage().rss;
  const tickTimer = setInterval(() => { ticks += 1; }, 5);
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const startedAt = performance.now();
  try {
    const result = await generateAndValidateNewAccount({ ...options, runtime });
    const workerElapsedMs = performance.now() - startedAt;
    clearInterval(tickTimer);
    clearInterval(rssTimer);
    assert.equal(result.execution.outcome, 'completed');
    assert.equal(result.execution.terminalSource, 'job:done');
    assert.equal(result.generated.artifact.rowCount, expectedRows);
    assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);
    const report = await runtime.shutdown({ timeoutMs: 10000 });
    assert.deepEqual(report.cancelledJobs, []);
    assert.deepEqual(report.leakedTransports, []);
    assert.deepEqual(report.errors, []);
    if (typeof global.gc === 'function') global.gc();

    const headers = extractHeaders(TEMPLATE_PATH);
    const prepared = prepareNewAccountGeneration({
      payload: options.payload,
      balanceTemplateFields: headers,
      today: new Date(`${options.asOfDate}T00:00:00`),
      maxRecords: MAX_RECORDS
    });
    assert.equal(prepared.records.length, expectedRows);
    const syncStartedAt = performance.now();
    const sync = readBackAndValidate(options.generationPath, {
      sheetName: result.generated.artifact.sheetName,
      headers,
      records: prepared.records
    });
    const syncReadbackMs = performance.now() - syncStartedAt;
    assert.deepEqual(sync.businessEvidence, result.generated.artifact.businessEvidence);
    if (typeof global.gc === 'function') global.gc();
    const oracleStartedAt = performance.now();
    const oracle = legacyBusinessEvidence(headers, prepared.records);
    const legacyOracleMs = performance.now() - oracleStartedAt;
    assert.deepEqual(oracle, result.generated.artifact.businessEvidence);
    process.stdout.write(`${JSON.stringify({
      scenario,
      rows: expectedRows,
      workerElapsedMs: Math.round(workerElapsedMs),
      syncReadbackMs: Math.round(syncReadbackMs),
      legacyOracleMs: Math.round(legacyOracleMs),
      peakRss,
      eventLoopTicks: ticks,
      evidence: oracle
    })}\n`);
  } finally {
    clearInterval(tickTimer);
    clearInterval(rssTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runChild(scenario) {
  const cancellationStages = {
    'cancel-open-1': 'readback:workbook-opened',
    'cancel-open-2': 'readback:workbook-opened',
    'cancel-row': 'readback:row-batch',
    'cancel-row-scan-complete': 'readback:row-scan-complete',
    'cancel-evidence': 'readback:evidence-batch',
    'cancel-terminal': 'worker:before-job-done'
  };
  if (cancellationStages[scenario]) {
    await runCancellationScenario(scenario, cancellationStages[scenario]);
    return;
  }
  if (scenario === 'normal-250k-short') {
    await runNormalScenario(scenario, SHORT_250K, 250000);
    return;
  }
  if (scenario === 'normal-60416-long') {
    await runNormalScenario(scenario, LONG_60416, 60416);
    return;
  }
  throw new Error(`未知场景：${scenario}`);
}

async function main() {
  if (process.argv[2] === '--child') {
    await runChild(process.argv[3]);
    return;
  }
  const scenarios = [
    'cancel-open-1',
    'cancel-open-2',
    'cancel-row',
    'cancel-row-scan-complete',
    'cancel-evidence',
    'cancel-terminal',
    'normal-250k-short',
    'normal-60416-long'
  ];
  for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, [
      '--expose-gc',
      __filename,
      '--child',
      scenario
    ], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, `${scenario} 子进程失败（signal=${child.signal || 'none'}）`);
  }
  process.stdout.write('NewAccount E10-A readback cancellation/performance probe PASS\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
