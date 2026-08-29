'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { writeBalanceWorkbook } = require('../../../src/backend/file-service');
const { extractHeaders } = require('../../../src/backend/file-service/readers');
const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  createCanonicalEventEmitter
} = require('../../../src/main-process/background-execution/adapters/canonical-event-emitter');
const {
  assertFinanceSafeValue
} = require('../../../src/main-process/background-execution/error-codec');
const {
  MAX_RECORDS,
  NEW_ACCOUNT_GENERATION_ACTION,
  createNewAccountGenerationInput,
  projectNewAccountGenerationRecordCount,
  validateNewAccountGenerationResult
} = require('../../../src/main-process/new-account/generation-contract');
const {
  buildNewAccountBalanceRecords,
  buildNewAccountBillDates,
  buildNewAccountOutputName,
  createTemplateEvidence,
  executeNewAccountGeneration,
  prepareNewAccountGeneration
} = require('../../../src/main-process/new-account/generation-core');
const {
  cleanupOwnedGeneration,
  createNewAccountWorkerInput,
  generateAndValidateNewAccount
} = require('../../../src/main-process/new-account/worker-client');
const {
  FIXED_MEMORY_ENVELOPE_BYTES,
  MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES,
  MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL,
  createNewAccountGenerationResourceEstimate,
  estimateNewAccountGenerationMemory
} = require('../../../src/main-process/new-account/resource-estimator');
const {
  GENERATION_RESOURCES,
  NEW_ACCOUNT_GENERATION_POLICY
} = require('../../../src/main-process/new-account/policies');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../assets/余额账单模版.xlsx');
const tmpDirs = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'new-account-e10-a-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function payload(overrides = {}) {
  return {
    accounts: [{
      bankName: '测试银行',
      location: '上海',
      bankAccount: '622200001234',
      openingDate: '2026-02-28',
      isMultiCurrency: true,
      currency: '',
      currencies: ['USD', 'CNY']
    }],
    ...overrides
  };
}

function filePlan(finalPath) {
  return normalizeFilePlanV1({
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
  });
}

function operationContext(operationKey = 'new-account-e10-a-operation') {
  return Object.freeze({
    kind: 'operation',
    value: {
      taskRunId: 'new-account-e10-a-task',
      taskKey: 'task.new-account:generate',
      moduleId: 'new-account',
      parentRunId: 'new-account-e10-a-parent',
      operationKey
    }
  });
}

function inputOptions(dir, overrides = {}) {
  const stagingRoot = path.join(dir, 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingResourceId = 'new-account-balance.xlsx';
  return {
    filePlan: filePlan(path.join(dir, 'final-must-not-exist.xlsx')),
    templatePath: TEMPLATE_PATH,
    payload: payload(),
    asOfDate: '2026-03-02',
    stagingRoot,
    stagingResourceId,
    generationPath: path.join(stagingRoot, stagingResourceId),
    operationKey: 'new-account-e10-a-operation',
    context: operationContext(),
    production: false,
    ...overrides
  };
}

function isoDateBefore(asOfDate, days) {
  const date = new Date(`${asOfDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function shapedWorkerInput(dir, shapes, overrides = {}) {
  const asOfDate = overrides.asOfDate || '2030-01-01';
  const accounts = shapes.map((shape, index) => {
    const currencies = Array.from({ length: shape.currencyCount }, (_, currencyIndex) =>
      `C${String(currencyIndex).padStart(2, '0')}`);
    return {
      bankName: `测试银行${index}`,
      location: '上海',
      bankAccount: `62220000${String(index).padStart(4, '0')}`,
      openingDate: isoDateBefore(asOfDate, shape.dayCount),
      isMultiCurrency: currencies.length > 1,
      currency: currencies[0],
      currencies
    };
  });
  const options = inputOptions(dir, {
    asOfDate,
    payload: payload({ accounts }),
    ...overrides
  });
  return createNewAccountWorkerInput(options);
}

function localDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function cancellableHoldingAdapter() {
  const state = { starts: 0 };
  return Object.freeze({
    state,
    adapter: Object.freeze({
      start(startOptions) {
        state.starts += 1;
        let emit = null;
        return Object.freeze({
          ready: Promise.resolve(),
          send(message) {
            if (message.operation === 'job:start') {
              emit = createCanonicalEventEmitter(message, startOptions.onMessage, startOptions.onError);
              return;
            }
            if (message.operation !== 'job:cancel' || !emit) return;
            startOptions.onCancellationTerminal();
            emit('cancel:ack', { cancellation: { scope: 'job' } });
            emit('job:error', {
              error: {
                code: 'NEW_ACCOUNT_GENERATION_CANCELLED',
                message: '新开账户余额账单生成已取消',
                stage: 'cancel',
                detailLines: []
              }
            });
          },
          close() {},
          terminate() { return Promise.resolve(0); }
        });
      }
    })
  });
}

function workbookProjection(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: true, cellNF: true, cellStyles: true });
  return {
    sheetNames: workbook.SheetNames,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
      defval: '',
      blankrows: false,
      raw: true
    })
  };
}

async function waitForCondition(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('E10-A policy保持 thread-single/job/main-settlement 与 production=false/legacy/0', () => {
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.actionKey, NEW_ACCOUNT_GENERATION_ACTION);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.mode, 'thread-single');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.lifetime, 'job');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.adapterKind, 'native');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.commit.kind, 'main-settlement');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.artifacts.maxArtifacts, 1);
  assert.deepEqual(NEW_ACCOUNT_GENERATION_POLICY.cancellation.safePoints, [
    'before-write', 'after-write', 'after-readback', 'before-terminal'
  ]);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.enabled, false);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.effectiveMode, 'legacy');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.effectiveWorkerCount, 0);
  assert.equal(isBackgroundExecutionProductionEnabled(NEW_ACCOUNT_GENERATION_ACTION), false);

  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  const workerOwnedSource = [
    '../../../src/main-process/new-account/generation-core.js',
    '../../../src/main-process/new-account/worker-entry.js'
  ].map((file) => fs.readFileSync(path.resolve(__dirname, file), 'utf8')).join('\n');
  assert.match(mainSource, /require\('\.\/main-process\/new-account\/generation-core'\)/);
  assert.doesNotMatch(mainSource, /isProductionEnabled\('new-account:generate'\)/);
  assert.doesNotMatch(mainSource, /generateAndValidateNewAccount\(/);
  assert.doesNotMatch(workerOwnedSource, /fs\.(?:rm|rmSync|unlink|unlinkSync)\s*\(/);
});

test('唯一 core 锁定昨日/10年边界、币种去重、记录顺序与 legacy 文件名', () => {
  assert.deepEqual(
    buildNewAccountBillDates(new Date(2026, 2, 1), new Date(2026, 2, 2)).map((date) => date.getDate()),
    [1]
  );
  assert.throws(
    () => buildNewAccountBillDates(new Date(2026, 2, 2), new Date(2026, 2, 2)),
    /开户日期不能晚于昨日/
  );
  const today = new Date(2026, 2, 2);
  const yesterday = new Date(2026, 2, 1);
  const exactly3650 = new Date(yesterday);
  exactly3650.setDate(exactly3650.getDate() - 3649);
  assert.equal(buildNewAccountBillDates(exactly3650, today).length, 3650);
  const tooOld = new Date(exactly3650);
  tooOld.setDate(tooOld.getDate() - 1);
  assert.throws(() => buildNewAccountBillDates(tooOld, today), /超过 10 年/);

  const headers = extractHeaders(TEMPLATE_PATH);
  const prepared = prepareNewAccountGeneration({
    payload: payload({
      accounts: [{
        ...payload().accounts[0],
        currencies: ['USD', 'CNY', 'USD']
      }]
    }),
    balanceTemplateFields: headers,
    today: new Date(2026, 2, 2)
  });
  assert.equal(prepared.records.length, 4);
  assert.deepEqual(prepared.records.map((row) => [row[2], row[4]]), [
    ['USD', '2026-02-28'], ['CNY', '2026-02-28'],
    ['USD', '2026-03-01'], ['CNY', '2026-03-01']
  ]);
  assert.deepEqual(prepared.records.map((row) => row.slice(5)), [
    ['', '', 0, ''], ['', '', 0, ''], ['', '', 0, ''], ['', '', 0, '']
  ]);
  assert.equal(prepared.fileName, '测试银行-上海-1234-多币种-NEW_BALANCE.xlsx');
  assert.equal(buildNewAccountOutputName([
    { bankName: 'A', location: 'B', bankAccount: '1234' },
    { bankName: 'C', location: 'D', bankAccount: '5678' }
  ], ['USD']).fileName, 'A-B-多账号-多币种-NEW_BALANCE.xlsx');
  assert.throws(
    () => prepareNewAccountGeneration({ payload: {}, balanceTemplateFields: headers, today }),
    (error) => error.code === 'NEW_ACCOUNT_REQUIRED' &&
      error.detailLines[0] === '1. 缺少字段：银行名称、所在地、银行账号、开户日期、币种'
  );
});

test('共享行数投影与实际 records.length 同口径，覆盖闰日和多账户/币种', () => {
  const headers = extractHeaders(TEMPLATE_PATH);
  const cases = [
    { asOfDate: '2026-03-02', shapes: [{ dayCount: 1, currencyCount: 1 }] },
    { asOfDate: '2026-03-02', shapes: [{ dayCount: 2, currencyCount: 2 }] },
    { asOfDate: '2028-03-01', shapes: [{ dayCount: 2, currencyCount: 3 }] },
    {
      asOfDate: '2026-03-02',
      shapes: [{ dayCount: 28, currencyCount: 3 }, { dayCount: 7, currencyCount: 5 }]
    },
    { asOfDate: '2026-03-02', shapes: [{ dayCount: 366, currencyCount: 8 }] }
  ];
  for (const entry of cases) {
    const input = shapedWorkerInput(tempDir('new-account-projection-'), entry.shapes, {
      asOfDate: entry.asOfDate
    });
    const projected = projectNewAccountGenerationRecordCount(input.accounts, input.asOfDate);
    const accounts = input.accounts.map((account) => ({
      ...account,
      openingDateRaw: account.openingDate,
      openingDate: localDate(account.openingDate),
      currency: account.currencies[0],
      isMultiCurrency: account.currencies.length > 1
    }));
    const generated = buildNewAccountBalanceRecords({
      accounts,
      balanceTemplateFields: headers,
      today: localDate(input.asOfDate),
      maxRecords: MAX_RECORDS
    });
    const expected = entry.shapes.reduce(
      (sum, shape) => sum + shape.dayCount * shape.currencyCount,
      0
    );
    assert.equal(projected, expected);
    assert.equal(generated.records.length, projected);
  }
});

test('动态内存 estimator 锁定最小/typical/29,192/60,416/250,000、上下界与overflow', () => {
  assert.equal(GENERATION_RESOURCES.memoryBytes, MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES);
  assert.equal(estimateNewAccountGenerationMemory(0).memoryBytes, FIXED_MEMORY_ENVELOPE_BYTES);
  const cases = [
    { label: 'minimum', rows: 1, shapes: [{ dayCount: 1, currencyCount: 1 }] },
    { label: 'typical', rows: 4, shapes: [{ dayCount: 2, currencyCount: 2 }] },
    { label: '29,192', rows: 29192, shapes: [{ dayCount: 3649, currencyCount: 8 }] },
    { label: '60,416', rows: 60416, shapes: [{ dayCount: 944, currencyCount: 64 }] },
    {
      label: '250,000',
      rows: 250000,
      shapes: [{ dayCount: 2500, currencyCount: 50 }, { dayCount: 2500, currencyCount: 50 }]
    }
  ];
  const estimates = [];
  for (const entry of cases) {
    const input = shapedWorkerInput(tempDir('new-account-estimate-'), entry.shapes);
    const estimate = createNewAccountGenerationResourceEstimate(input, GENERATION_RESOURCES);
    assert.equal(estimate.projectedOutputRows, entry.rows, entry.label);
    assert.equal(
      estimate.resources.memoryBytes,
      FIXED_MEMORY_ENVELOPE_BYTES + entry.rows * NEW_ACCOUNT_GENERATION_MEMORY_MODEL.perProjectedRowBytes,
      entry.label
    );
    assert.equal(Number.isSafeInteger(estimate.resources.memoryBytes), true);
    estimates.push(estimate.resources.memoryBytes);
  }
  assert.deepEqual([...estimates].sort((left, right) => left - right), estimates);
  assert.ok(estimates[0] < MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES);
  assert.equal(estimates.at(-1), MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES);
  assert.ok(estimates[2] >= 467648512, '29,192行 reservation 应覆盖本机观测 envelope');
  assert.ok(estimates[3] >= 572456960, '60,416行 reservation 应覆盖本机观测 envelope');
  assert.throws(
    () => estimateNewAccountGenerationMemory(Number.MAX_SAFE_INTEGER),
    (error) => error.code === 'NEW_ACCOUNT_RESOURCE_ESTIMATE_OVERFLOW'
  );
  assert.throws(
    () => estimateNewAccountGenerationMemory(MAX_RECORDS + 1),
    (error) => error.code === 'NEW_ACCOUNT_RESOURCE_ESTIMATE_ROW_LIMIT'
  );
  assert.throws(
    () => estimateNewAccountGenerationMemory(1.5),
    (error) => error.code === 'NEW_ACCOUNT_RESOURCE_ESTIMATE_ROW_COUNT_INVALID'
  );
});

test('低总预算在 Worker spawn 前 fail closed，小任务按实际行数而非最大值预留', async () => {
  const dir = tempDir('new-account-low-budget-');
  const options = inputOptions(dir);
  const input = createNewAccountWorkerInput(options);
  const estimate = createNewAccountGenerationResourceEstimate(input, GENERATION_RESOURCES);
  let workerStarts = 0;
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    memoryHardCeilingBytes: estimate.resources.memoryBytes - 1,
    systemReserveBytes: 0,
    workerThreadAdapter: {
      start() {
        workerStarts += 1;
        throw new Error('低预算不得创建 Worker');
      }
    }
  });
  const execution = await runtime.execute({
    actionKey: NEW_ACCOUNT_GENERATION_ACTION,
    operationKey: options.operationKey,
    context: options.context,
    input
  });
  assert.equal(execution.outcome, 'transport-lost');
  assert.equal(execution.terminalSource, 'spawn-error');
  assert.equal(execution.result, null);
  assert.equal(execution.error.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(workerStarts, 0);
  assert.equal(estimate.resources.memoryBytes < MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES, true);
  assert.equal(runtime.resourceGovernor.snapshot().activeUsage.memoryBytes, 0);
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
});

test('并发 NewAccount admission 不超 Governor memory budget/system reserve，第二任务未创建 Worker', async () => {
  const firstDir = tempDir('new-account-concurrent-a-');
  const secondDir = tempDir('new-account-concurrent-b-');
  const firstOptions = inputOptions(firstDir, {
    operationKey: 'new-account-concurrent-a',
    context: operationContext('new-account-concurrent-a')
  });
  const secondOptions = inputOptions(secondDir, {
    operationKey: 'new-account-concurrent-b',
    context: operationContext('new-account-concurrent-b')
  });
  const firstInput = createNewAccountWorkerInput(firstOptions);
  const secondInput = createNewAccountWorkerInput(secondOptions);
  const estimate = createNewAccountGenerationResourceEstimate(firstInput, GENERATION_RESOURCES);
  const memoryBudget = estimate.resources.memoryBytes + 1024 * 1024;
  const systemReserveBytes = 512 * 1024 * 1024;
  const freeMemoryBytes = memoryBudget + systemReserveBytes;
  const holding = cancellableHoldingAdapter();
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes,
    totalMemoryBytes: 8 * 1024 ** 3,
    memoryHardCeilingBytes: memoryBudget,
    systemReserveBytes,
    workerThreadAdapter: holding.adapter,
    shutdownTimeoutMs: 10000
  });
  const first = runtime.start({
    actionKey: NEW_ACCOUNT_GENERATION_ACTION,
    operationKey: firstOptions.operationKey,
    jobId: 'new-account-concurrent-job-a',
    context: firstOptions.context,
    input: firstInput
  });
  await first.ready;
  await waitForCondition(
    () => runtime.inspect(first.jobId)?.state === 'running',
    '第一个并发任务未进入 running'
  );
  const second = runtime.start({
    actionKey: NEW_ACCOUNT_GENERATION_ACTION,
    operationKey: secondOptions.operationKey,
    jobId: 'new-account-concurrent-job-b',
    context: secondOptions.context,
    input: secondInput
  });
  await waitForCondition(
    () => runtime.resourceGovernor.snapshot().queued.size === 1,
    '第二个并发任务未进入资源队列'
  );
  const snapshot = runtime.resourceGovernor.snapshot();
  const phaseLeases = snapshot.activeLeases.filter((lease) => lease.kind === 'phase');
  assert.equal(holding.state.starts, 1);
  assert.equal(phaseLeases.length, 1);
  assert.equal(phaseLeases[0].resources.memoryBytes, estimate.resources.memoryBytes);
  assert.ok(snapshot.activeUsage.memoryBytes <= snapshot.budgets.memoryBytes);
  assert.ok(freeMemoryBytes - snapshot.activeUsage.memoryBytes >= systemReserveBytes);

  const shutdown = runtime.shutdown({ timeoutMs: 10000 });
  const [firstResult, secondResult, report] = await Promise.all([first.promise, second.promise, shutdown]);
  assert.equal(firstResult.outcome, 'cancelled');
  assert.equal(secondResult.outcome, 'cancelled');
  assert.equal(holding.state.starts, 1);
  assert.equal(runtime.resourceGovernor.snapshot().activeUsage.memoryBytes, 0);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
});

test('Main contract exact/bounded，Worker不接final target且拒绝路径逃逸/任意模板/记录爆炸', async () => {
  const dir = tempDir();
  const options = inputOptions(dir);
  const input = createNewAccountWorkerInput(options);
  assert.deepEqual(Object.keys(input), ['schemaVersion', 'accounts', 'asOfDate', 'template', 'generation']);
  assert.equal(JSON.stringify(input).includes('final-must-not-exist.xlsx'), false);
  assert.equal(Object.hasOwn(input, 'finalTarget'), false);
  const slashDateInput = createNewAccountWorkerInput({
    ...inputOptions(tempDir()),
    payload: payload({ accounts: [{ ...payload().accounts[0], openingDate: '2026/02/28' }] })
  });
  assert.equal(slashDateInput.accounts[0].openingDate, '2026-02-28');
  assert.throws(
    () => createNewAccountGenerationInput({ ...input, unexpected: true }),
    (error) => error.code === 'NEW_ACCOUNT_GENERATION_SHAPE_INVALID'
  );
  assert.throws(
    () => createNewAccountGenerationInput({
      ...input,
      generation: { ...input.generation, generationPath: path.join(dir, 'outside.xlsx') }
    }),
    (error) => error.code === 'NEW_ACCOUNT_GENERATION_PATH_INVALID'
  );
  assert.throws(
    () => createNewAccountWorkerInput({
      ...options,
      filePlan: filePlan(options.generationPath)
    }),
    (error) => error.code === 'NEW_ACCOUNT_GENERATION_PATH_ALIAS'
  );
  const foreignTemplate = path.join(dir, '余额账单模版.xlsx');
  fs.copyFileSync(TEMPLATE_PATH, foreignTemplate);
  const foreignInput = createNewAccountGenerationInput({
    ...input,
    template: createTemplateEvidence(foreignTemplate)
  });
  await assert.rejects(
    executeNewAccountGeneration(foreignInput, new AbortController().signal, {
      allowedTemplatePath: TEMPLATE_PATH
    }),
    (error) => error.code === 'NEW_ACCOUNT_TEMPLATE_NOT_ALLOWED'
  );

  const wide = payload({
    accounts: Array.from({ length: 64 }, (_, index) => ({
      bankName: '银行', location: '上海', bankAccount: `A${index}`,
      openingDate: '2016-03-05', isMultiCurrency: true,
      currency: '', currencies: Array.from({ length: 64 }, (__, currency) => `C${currency}`)
    }))
  });
  assert.throws(
    () => createNewAccountWorkerInput({ ...inputOptions(tempDir()), payload: wide }),
    (error) => [
      'CANONICAL_JSON_TOO_LARGE',
      'NEW_ACCOUNT_GENERATION_INPUT_INVALID',
      'NEW_ACCOUNT_GENERATION_RECORD_LIMIT'
    ].includes(error.code)
  );
  assert.equal(MAX_RECORDS, 250000);
});

test('真实 one-shot Worker 写单一 staging workbook、业务回读、Main技术验证并与legacy golden等价', async () => {
  const dir = tempDir();
  const options = inputOptions(dir);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  await assert.rejects(
    runtime.execute({
      actionKey: NEW_ACCOUNT_GENERATION_ACTION,
      operationKey: options.operationKey,
      production: true,
      context: options.context,
      input: createNewAccountWorkerInput(options)
    }),
    (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
  );
  const rssBefore = process.memoryUsage().rss;
  let eventLoopTicks = 0;
  const timer = setInterval(() => { eventLoopTicks += 1; }, 2);
  const result = await generateAndValidateNewAccount({ ...options, runtime });
  clearInterval(timer);
  const rssDelta = process.memoryUsage().rss - rssBefore;
  assert.equal(result.execution.outcome, 'completed');
  assert.equal(validateNewAccountGenerationResult(result.execution.result), true);
  assert.equal(result.generated.artifact.rowCount, 4);
  assert.equal(result.generated.artifact.fileName, '测试银行-上海-1234-多币种-NEW_BALANCE.xlsx');
  assert.equal(Object.hasOwn(result.execution.result.artifact, 'generationPath'), false);
  assert.equal(JSON.stringify(result.execution.result).includes('622200001234'), false);
  assert.doesNotThrow(() => assertFinanceSafeValue(result.execution.result));
  assert.equal(fs.existsSync(options.generationPath), true);
  assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);
  assert.ok(eventLoopTicks >= 1, `Worker生成期间event loop仅推进${eventLoopTicks}次`);
  assert.ok(rssDelta < 384 * 1024 * 1024, `RSS增长${rssDelta} bytes超出探针阈值`);

  const legacyPath = path.join(dir, 'legacy.xlsx');
  const headers = extractHeaders(TEMPLATE_PATH);
  const legacy = prepareNewAccountGeneration({
    payload: options.payload,
    balanceTemplateFields: headers,
    today: new Date(2026, 2, 2)
  });
  writeBalanceWorkbook({
    templateFilePath: TEMPLATE_PATH,
    records: legacy.records,
    templateFields: headers,
    outputFilePath: legacyPath
  });
  assert.deepEqual(workbookProjection(options.generationPath), workbookProjection(legacyPath));

  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.cancelledJobs, []);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(result.execution.outcome, 'completed');
  assert.equal(fs.existsSync(options.generationPath), true);
});

test('真实 running Worker 收到 shutdown 后cancel-wins，不产生handle并由Main清空staging', async () => {
  const dir = tempDir();
  const operationKey = 'new-account-running-shutdown';
  const options = inputOptions(dir, {
    operationKey,
    context: operationContext(operationKey),
    payload: payload({
      accounts: [{
        ...payload().accounts[0],
        openingDate: '2024-01-01',
        currencies: ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD', 'AUD', 'CAD']
      }]
    })
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  let resolveControl;
  const controlPromise = new Promise((resolve) => { resolveControl = resolve; });
  const generation = generateAndValidateNewAccount({
    ...options,
    runtime: {
      execute(request) {
        const control = runtime.start(request);
        resolveControl(control);
        return control.promise;
      }
    }
  });
  const control = await controlPromise;
  await control.ready;
  await waitForCondition(
    () => runtime.inspect(control.jobId)?.state === 'running',
    '真实 Worker 未进入 running'
  );

  const shutdown = runtime.shutdown({ timeoutMs: 10000 });
  const result = await generation;
  const report = await shutdown;

  assert.equal(result.execution.outcome, 'cancelled');
  assert.equal(result.execution.terminalSource, 'job:error');
  assert.equal(result.execution.result, null);
  assert.equal(result.generated, null);
  assert.deepEqual(report.cancelledJobs, [control.jobId]);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(fs.readdirSync(options.stagingRoot), []);
  assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);
});

test('模板 TOCTOU、staging collision/symlink 与业务 tamper fail closed', async () => {
  const dir = tempDir();
  const options = inputOptions(dir);
  const input = createNewAccountWorkerInput(options);
  const changed = structuredClone(input);
  changed.template.sha256 = '0'.repeat(64);
  await assert.rejects(
    executeNewAccountGeneration(changed, new AbortController().signal, { allowedTemplatePath: TEMPLATE_PATH }),
    (error) => error.code === 'NEW_ACCOUNT_TEMPLATE_CHANGED'
  );
  fs.writeFileSync(options.generationPath, 'collision');
  await assert.rejects(
    executeNewAccountGeneration(input, new AbortController().signal, { allowedTemplatePath: TEMPLATE_PATH }),
    (error) => error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID'
  );
  fs.rmSync(options.generationPath);
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  const link = path.join(options.stagingRoot, 'linked');
  fs.symlinkSync(outside, link, 'dir');
  const linkedInput = createNewAccountGenerationInput({
    ...input,
    generation: {
      ...input.generation,
      stagingResourceId: 'linked/output.xlsx',
      generationPath: path.join(link, 'output.xlsx')
    }
  });
  await assert.rejects(
    executeNewAccountGeneration(linkedInput, new AbortController().signal, { allowedTemplatePath: TEMPLATE_PATH }),
    (error) => error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID'
  );
});

test('cancel/crash结果不产生handle，Main只清理已授权staging且不碰final target', async () => {
  const dir = tempDir();
  const options = inputOptions(dir);
  const fakeRuntime = {
    async execute() {
      fs.writeFileSync(options.generationPath, 'partial');
      return Object.freeze({ outcome: 'cancelled', terminalSource: 'cancel:ack', jobId: 'cancelled-job' });
    }
  };
  const cancelled = await generateAndValidateNewAccount({ ...options, runtime: fakeRuntime });
  assert.equal(cancelled.generated, null);
  assert.equal(fs.existsSync(options.generationPath), false);
  assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);

  const input = createNewAccountWorkerInput(inputOptions(tempDir()));
  fs.writeFileSync(input.generation.generationPath, 'owned');
  assert.equal(cleanupOwnedGeneration(input), true);
  assert.equal(fs.existsSync(input.generation.generationPath), false);
});

test('真实 Supervisor 收到 Worker crash 后忽略迟到 done，恢复清理不发布也不泄漏 transport', async () => {
  const dir = tempDir();
  const options = inputOptions(dir, { operationKey: 'new-account-crash-late' });
  options.context = operationContext(options.operationKey);
  let terminateCalls = 0;
  const crashingAdapter = Object.freeze({
    kind: 'worker-thread',
    start(startOptions) {
      return Object.freeze({
        ready: Promise.resolve(),
        send(message) {
          if (message.operation !== 'job:start') return;
          fs.writeFileSync(message.payload.input.generation.generationPath, 'partial-worker-output');
          const emit = createCanonicalEventEmitter(message, startOptions.onMessage);
          setImmediate(() => {
            startOptions.onExit(17, null);
            setImmediate(() => emit('job:done', {
              result: {
                schemaVersion: 1,
                status: 'generated',
                artifact: {
                  artifactKey: message.payload.input.generation.artifactKey,
                  fileName: 'late.xlsx',
                  byteSize: 21,
                  sha256: '0'.repeat(64),
                  sheetName: 'balance',
                  headers: ['银行账号'],
                  rowCount: 1,
                  templateSha256: message.payload.input.template.sha256,
                  businessEvidence: {
                    recordsSha256: '1'.repeat(64),
                    datesSha256: '2'.repeat(64),
                    accountsSha256: '3'.repeat(64),
                    currenciesSha256: '4'.repeat(64)
                  }
                },
                summary: { accountCount: 1, currencyCount: 1, dateCount: 1, rowCount: 1 }
              }
            }));
          });
        },
        close() {},
        async terminate() { terminateCalls += 1; return 17; }
      });
    }
  });
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    workerThreadAdapter: crashingAdapter,
    shutdownTimeoutMs: 10000
  });
  const outcome = await generateAndValidateNewAccount({ ...options, runtime });
  assert.equal(outcome.execution.outcome, 'transport-lost');
  assert.equal(outcome.execution.terminalSource, 'unexpected-exit');
  assert.equal(outcome.generated, null);
  assert.equal(fs.existsSync(options.generationPath), false);
  assert.equal(fs.existsSync(options.filePlan.outputs[0].filePath), false);
  await new Promise((resolve) => setImmediate(resolve));
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.ok(terminateCalls <= 1);
});
