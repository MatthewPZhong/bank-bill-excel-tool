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
  validateNewAccountGenerationResult
} = require('../../../src/main-process/new-account/generation-contract');
const {
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

test('E10-A policy保持 thread-single/job/main-settlement 与 production=false/legacy/0', () => {
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.actionKey, NEW_ACCOUNT_GENERATION_ACTION);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.mode, 'thread-single');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.lifetime, 'job');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.adapterKind, 'native');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.commit.kind, 'main-settlement');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.artifacts.maxArtifacts, 1);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.enabled, false);
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.effectiveMode, 'legacy');
  assert.equal(NEW_ACCOUNT_GENERATION_POLICY.production.effectiveWorkerCount, 0);
  assert.equal(isBackgroundExecutionProductionEnabled(NEW_ACCOUNT_GENERATION_ACTION), false);

  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  assert.match(mainSource, /require\('\.\/main-process\/new-account\/generation-core'\)/);
  assert.doesNotMatch(mainSource, /isProductionEnabled\('new-account:generate'\)/);
  assert.doesNotMatch(mainSource, /generateAndValidateNewAccount\(/);
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
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
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
