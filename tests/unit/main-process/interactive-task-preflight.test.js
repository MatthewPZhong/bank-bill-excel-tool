'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const acorn = require('acorn');

const {
  readBalanceSeedRecords,
  writeBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');
const {
  balanceSeedRecordsEvidence,
  prepareManualBalanceSeedSubmission,
  writeManualBalanceSeedPlan
} = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  executePendingImportSubmission,
  pendingMonthEvidenceValue,
  readPendingMonthEvidence,
  preparePendingImportSubmission
} = require('../../../src/main-process/pending-import-preflight');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  createIpcTaskContext,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../../src/main-process/archive-center/ipc-task-contract');
const {
  createTaskLifecycle
} = require('../../../src/main-process/archive-center/task-lifecycle');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
const mainAst = acorn.parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script' });

function loadMainFunction(name, names = [], values = []) {
  const node = mainAst.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到函数：${name}`);
  return Function(
    ...names,
    `return (${mainSource.slice(node.start, node.end)});`
  )(...values);
}

const POLICY = Object.freeze({
  channel: 'test:interactive-preflight',
  scopeId: 'test-scope',
  moduleCode: 'TEST',
  moduleName: '交互预检测试',
  taskKey: 'interactive-preflight',
  batchPolicy: 'reserve',
  startsNewFlow: true,
  resultClassifier(result) {
    if (result && result.status === 'success') return 'succeeded';
    throw new TypeError(`unexpected status: ${result && result.status}`);
  }
});

function createLifecycleHarness() {
  const calls = [];
  const lifecycle = createTaskLifecycle({
    businessOperationRegistry: {
      begin() {
        calls.push('bor-begin');
        return { accepted: true, token: 'bor-1' };
      },
      end() { calls.push('bor-end'); }
    },
    archiveService: {
      async reserveTaskBatch(payload) {
        calls.push('reserve');
        return {
          ok: true,
          created: true,
          batchId: 1,
          batchNumber: 'batch-1',
          batch: {
            id: 1,
            batchNumber: 'batch-1',
            taskRunId: payload.taskRunId,
            taskKey: payload.taskKey,
            moduleId: payload.moduleId,
            parentRunId: payload.parentRunId,
            operationKey: payload.operationKey
          }
        };
      },
      async beginTaskRecovery() { throw new Error('unexpected recovery'); },
      async markTaskStarted() {
        calls.push('started');
        return { ok: true };
      },
      async completeTaskBatch() {
        calls.push('complete');
        return { ok: true };
      },
      async failTaskBatch() {
        calls.push('fail');
        return { ok: true };
      },
      async cancelTaskBatch() {
        calls.push('cancel');
        return { ok: true };
      },
      async recordFailure() {
        calls.push('record-failure');
        return { ok: true };
      }
    },
    flowResolver: {
      async resolve() {
        calls.push('resolve-flow');
        return { parentRunId: 'parent-1', source: 'new', identity: null };
      },
      async bind() { return []; },
      async persistBindIntent() { return []; }
    },
    operationTracker: {
      async appendOperationFiles() {
        calls.push('append');
        return { archiveFailed: false };
      }
    },
    createTaskRunId: () => 'task-1'
  });
  return { calls, lifecycle };
}

async function invokePrepared(harness, prepared, execute) {
  const contract = normalizeIpcTaskHandler({
    prepare: async () => prepared,
    execute: async (_event, _prepared, taskContext) => execute(prepared, taskContext)
  });
  const normalized = await prepareIpcTaskInvocation(contract, {}, []);
  if (!normalized.proceed) return normalized.result;
  return harness.lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    prepared: normalized,
    execute: (batchContext, controls) => contract.execute(
      {},
      normalized,
      createIpcTaskContext(batchContext, controls)
    )
  });
}

function manualBalanceArgs(storageRoot, overrides = {}) {
  return {
    payload: { billDate: '2026-08-09', endBalance: '20.50' },
    confirmation: null,
    pendingPrompt: {
      templateName: 'ICBC-境内',
      merchantId: 'M001',
      currency: 'CNY',
      targetBillDate: '2026-08-10',
      queueIndex: 1,
      queueTotal: 1
    },
    importContext: { template: { name: 'ICBC-境内' } },
    generatedExports: { detail: { filePath: '/detail.xlsx' }, balance: null },
    storageRoot,
    session: null,
    createContextId: () => 'balance-context-1',
    createFreshnessGuard: () => ({
      inputFilePaths: [],
      assertFresh() {}
    }),
    ...overrides
  };
}

test('manual balance 无效输入在 prepare 停止：0 BOR/reserve/execute/写盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-balance-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storageRoot = path.join(dir, 'not-created');
  const resolution = prepareManualBalanceSeedSubmission(manualBalanceArgs(storageRoot, {
    payload: { billDate: '', endBalance: '20.50' }
  }));
  const harness = createLifecycleHarness();
  let executeCount = 0;
  const result = await invokePrepared(harness, resolution.prepared, async () => {
    executeCount += 1;
    return { status: 'success' };
  });
  assert.equal(result.status, 'manual-balance-invalid');
  assert.equal(result.errorReportReady, false);
  assert.deepEqual(harness.calls, []);
  assert.equal(executeCount, 0);
  assert.equal(fs.existsSync(storageRoot), false);
});

test('manual balance 覆盖首调与取消不入批次，确认后只 reserve/写入一次', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-balance-confirm-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  writeBalanceSeedRecords(storageRoot, 'ICBC', [{
    merchantId: 'M001',
    currency: 'CNY',
    billDate: '2026-08-09',
    endBalance: 10,
    templateName: 'ICBC-境内',
    generationMethod: '人工录入',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }]);
  const seedPath = path.join(storageRoot, 'balance-seeds', 'ICBC.json');
  const before = fs.readFileSync(seedPath, 'utf8');
  let freshnessChecks = 0;
  const first = prepareManualBalanceSeedSubmission(manualBalanceArgs(storageRoot, {
    createFreshnessGuard: () => ({
      inputFilePaths: [],
      assertFresh() { freshnessChecks += 1; }
    })
  }));
  assert.equal(first.prepared.proceed, false);
  assert.deepEqual(Object.keys(first.prepared.result).sort(), ['contextId', 'message', 'status']);
  assert.equal(first.prepared.result.status, 'confirm-overwrite');
  assert.equal(fs.readFileSync(seedPath, 'utf8'), before);

  const cancelHarness = createLifecycleHarness();
  let cancelledExecuteCount = 0;
  await invokePrepared(cancelHarness, first.prepared, async () => {
    cancelledExecuteCount += 1;
    return { status: 'success' };
  });
  // 取消对话不发第二次 IPC：到此仍无 BOR/reserve/业务写入。
  assert.deepEqual(cancelHarness.calls, []);
  assert.equal(cancelledExecuteCount, 0);
  assert.equal(fs.readFileSync(seedPath, 'utf8'), before);

  const confirmed = prepareManualBalanceSeedSubmission(manualBalanceArgs(storageRoot, {
    payload: { contextId: first.prepared.result.contextId, confirmOverwrite: true },
    confirmation: first.nextConfirmation
  }));
  assert.equal(confirmed.prepared.proceed, true);
  assert.equal(freshnessChecks, 2, '首调后与人工确认后各重读一次证据');

  const harness = createLifecycleHarness();
  let writeCount = 0;
  const result = await invokePrepared(harness, confirmed.prepared, async (prepared) => {
    writeCount += 1;
    writeManualBalanceSeedPlan(prepared.plan, new Date('2026-08-10T00:00:00.000Z'));
    return { status: 'success' };
  });
  assert.equal(result.status, 'success');
  assert.equal(harness.calls.filter((name) => name === 'bor-begin').length, 1);
  assert.equal(harness.calls.filter((name) => name === 'reserve').length, 1);
  assert.equal(writeCount, 1);
  assert.equal(readBalanceSeedRecords(storageRoot, 'ICBC')[0].endBalance, 20.5);
});

test('manual balance 确认期证据变化返回结构化 proceed:false 且不进入 lifecycle', async () => {
  const confirmation = {
    contextId: 'balance-context-changed',
    assertFresh() { throw new Error('seed changed'); }
  };
  const resolution = prepareManualBalanceSeedSubmission({
    payload: { contextId: confirmation.contextId, confirmOverwrite: true },
    confirmation
  });
  assert.equal(resolution.prepared.proceed, false);
  assert.equal(resolution.prepared.result.status, 'error');
  assert.equal(resolution.prepared.result.errorCode, 'BALANCE_SEED_CONFIRMATION_CHANGED');
  assert.match(resolution.prepared.result.message, /seed changed/);
  const harness = createLifecycleHarness();
  let executeCount = 0;
  const result = await invokePrepared(harness, resolution.prepared, async () => {
    executeCount += 1;
    return { status: 'success' };
  });
  assert.equal(result.errorCode, 'BALANCE_SEED_CONFIRMATION_CHANGED');
  assert.deepEqual(harness.calls, []);
  assert.equal(executeCount, 0);
});

function pendingArgs(overrides = {}) {
  const db = {};
  const monthRepository = {
    countRowsInMonth: () => 5,
    getMonthMeta: () => ({
      yearMonth: '2026-07',
      importedAt: '2026-08-01T00:00:00.000Z',
      rowCount: 5,
      sourceFiles: ['old.xlsx'],
      archivePath: null
    })
  };
  return {
    payload: { files: ['/input/a.xlsx'], yearMonth: '2026-07' },
    confirmation: null,
    db,
    monthRepository,
    dbPath: '/data/pending.sqlite',
    createContextId: () => 'pending-context-1',
    createFreshnessGuard: () => ({
      assertFresh() {}
    }).assertFresh,
    ...overrides
  };
}

test('Pending 无效输入与 need-confirm 均 0 BOR/reserve/worker，取消不触发二次调用', async () => {
  const invalid = preparePendingImportSubmission(pendingArgs({
    payload: { files: [], yearMonth: '2026-07' }
  }));
  const invalidHarness = createLifecycleHarness();
  let workerCount = 0;
  const invalidResult = await invokePrepared(invalidHarness, invalid.prepared, async () => {
    workerCount += 1;
    return { status: 'success' };
  });
  assert.equal(invalidResult.status, 'error');
  assert.deepEqual(invalidHarness.calls, []);

  const first = preparePendingImportSubmission(pendingArgs());
  assert.equal(first.prepared.proceed, false);
  assert.equal(first.prepared.result.status, 'need-confirm');
  assert.equal(first.prepared.result.contextId, 'pending-context-1');
  assert.deepEqual(Object.keys(first.prepared.result).sort(), [
    'contextId',
    'existingImportedAt',
    'existingRowCount',
    'status',
    'yearMonth'
  ]);
  const cancelHarness = createLifecycleHarness();
  await invokePrepared(cancelHarness, first.prepared, async () => {
    workerCount += 1;
    return { status: 'success' };
  });
  assert.deepEqual(cancelHarness.calls, []);
  assert.equal(workerCount, 0);
});

test('Pending 确认只用 opaque context，确认成功恰好一次 reserve/worker', async () => {
  let freshnessChecks = 0;
  const first = preparePendingImportSubmission(pendingArgs({
    createFreshnessGuard: () => () => { freshnessChecks += 1; }
  }));
  const confirmed = preparePendingImportSubmission(pendingArgs({
    payload: { contextId: first.prepared.result.contextId, confirmOverwrite: true },
    confirmation: first.nextConfirmation
  }));
  assert.equal(confirmed.prepared.proceed, true);
  assert.equal(freshnessChecks, 2, '首调后与人工确认后各重读一次证据');
  const harness = createLifecycleHarness();
  const runImportCalls = [];
  const progressEvents = [];
  const fakePendingSession = {
    async runImport(options) {
      runImportCalls.push(options);
      options.onProgress({ type: 'progress', rowsProcessed: 1 });
      return { status: 'success' };
    }
  };
  const result = await invokePrepared(harness, confirmed.prepared, async (prepared, taskContext) => {
    return executePendingImportSubmission({
      pendingSession: fakePendingSession,
      prepared,
      batchContext: taskContext.batchContext,
      onProgress: (event) => progressEvents.push(event)
    });
  });
  assert.equal(result.status, 'success');
  assert.equal(harness.calls.filter((name) => name === 'bor-begin').length, 1);
  assert.equal(harness.calls.filter((name) => name === 'reserve').length, 1);
  assert.equal(harness.calls.filter((name) => name === 'started').length, 1);
  assert.equal(harness.calls.filter((name) => name === 'append').length, 1);
  assert.equal(harness.calls.filter((name) => name === 'complete').length, 1);
  assert.equal(runImportCalls.length, 1);
  assert.equal(runImportCalls[0].yearMonth, '2026-07');
  assert.deepEqual(runImportCalls[0].files, ['/input/a.xlsx']);
  assert.equal(runImportCalls[0].overwriteConfirmed, true);
  assert.equal(runImportCalls[0].dbPath, '/data/pending.sqlite');
  assert.equal(runImportCalls[0].batchContext.batchId, 1);
  assert.equal(Object.isFrozen(runImportCalls[0].batchContext), true);
  assert.deepEqual(progressEvents, [{ type: 'progress', rowsProcessed: 1 }]);
});

test('Pending 确认期证据变化返回结构化 proceed:false 且不进入 lifecycle', async () => {
  const confirmation = {
    contextId: 'pending-context-changed',
    assertFresh() { throw new Error('month changed'); }
  };
  const resolution = preparePendingImportSubmission({
    payload: { contextId: confirmation.contextId, confirmOverwrite: true },
    confirmation
  });
  assert.equal(resolution.prepared.proceed, false);
  assert.equal(resolution.prepared.result.status, 'error');
  assert.match(resolution.prepared.result.errors[0].message, /month changed/);
  const harness = createLifecycleHarness();
  let executeCount = 0;
  const result = await invokePrepared(harness, resolution.prepared, async () => {
    executeCount += 1;
    return { status: 'success' };
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(harness.calls, []);
  assert.equal(executeCount, 0);
});

test('Pending 生产 freshness guard 重读源文件与月份 count/meta', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-freshness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'pending.xlsx');
  fs.writeFileSync(inputPath, 'before', 'utf8');
  const db = {};
  let existingCount = 5;
  const monthRepository = {
    countRowsInMonth: () => existingCount,
    getMonthMeta: () => ({
      yearMonth: '2026-07',
      importedAt: '2026-08-01T00:00:00.000Z',
      rowCount: existingCount,
      sourceFiles: ['old.xlsx'],
      archivePath: null
    })
  };
  const sourceGuardFactory = loadMainFunction(
    'createPreviewSourceFreshnessGuard',
    ['path', 'sourceSnapshotFromStat', 'fs', 'sourceSnapshotMatchesStat'],
    [path, sourceSnapshotFromStat, fs, sourceSnapshotMatchesStat]
  );
  const createGuard = loadMainFunction(
    'createPendingImportFreshnessGuard',
    [
      'pendingMonthEvidenceValue',
      'createPreviewSourceFreshnessGuard',
      'pendingDb',
      'readPendingMonthEvidence',
      'pendingMonthRepo'
    ],
    [
      pendingMonthEvidenceValue,
      sourceGuardFactory,
      db,
      readPendingMonthEvidence,
      monthRepository
    ]
  );
  let evidence = readPendingMonthEvidence(db, monthRepository, '2026-07');
  let guard = createGuard({
    db,
    yearMonth: '2026-07',
    files: [inputPath],
    evidence
  });
  guard();
  existingCount = 6;
  assert.throws(guard, /月份 2026-07 在确认期间已变化/);

  existingCount = 5;
  evidence = readPendingMonthEvidence(db, monthRepository, '2026-07');
  guard = createGuard({
    db,
    yearMonth: '2026-07',
    files: [inputPath],
    evidence
  });
  fs.writeFileSync(inputPath, 'after-confirmation-is-longer', 'utf8');
  assert.throws(guard, /Pending 导入源文件在确认期间已变化/);
});

test('manual balance 生产 freshness guard 重读账单 session 与 seed 证据', (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-freshness-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  writeBalanceSeedRecords(storageRoot, 'ICBC', [{
    merchantId: 'M001',
    currency: 'CNY',
    billDate: '2026-08-09',
    endBalance: 10,
    templateName: 'ICBC-境内',
    generationMethod: '人工录入',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }]);
  const pendingPrompt = { merchantId: 'M001' };
  const importContext = {
    templateId: 1,
    preparedDetailRows: [['BillDate'], ['2026-08-10']],
    inputFilePaths: [],
    statementSessionKey: '1'
  };
  const session = {
    key: '1',
    importCount: 1,
    currentBatchId: 'batch-1',
    fileEntries: [{ id: 'entry-1', filePath: '/input.xlsx', matchedTemplateId: 1 }],
    batches: [{ id: 'batch-1', entryIds: ['entry-1'] }]
  };
  const generatedDetail = { filePath: '/detail.xlsx' };
  const lastGeneratedExports = { detail: generatedDetail };
  const sessionEvidence = loadMainFunction(
    'statementSessionFreshnessEvidence',
    ['normalizeCell'],
    [(value) => String(value == null ? '' : value).trim()]
  );
  const createGuard = loadMainFunction(
    'createManualBalanceSeedFreshnessGuard',
    [
      'statementSessionFreshnessEvidence',
      'lastGeneratedExports',
      'isFilenameMappingMode',
      'normalizeInputFilePaths',
      'createPreviewSourceFreshnessGuard',
      'lastManualBalancePrompt',
      'lastFileImportContext',
      'statementImportSessions',
      'readBalanceSeedRecords',
      'balanceSeedRecordsEvidence'
    ],
    [
      sessionEvidence,
      lastGeneratedExports,
      () => false,
      (values) => values,
      () => { throw new Error('缓存行路不应读源文件'); },
      pendingPrompt,
      importContext,
      new Map([['1', session]]),
      readBalanceSeedRecords,
      balanceSeedRecordsEvidence
    ]
  );
  const records = readBalanceSeedRecords(storageRoot, 'ICBC');
  const plan = {
    storageRoot,
    bankName: 'ICBC',
    recordsEvidence: balanceSeedRecordsEvidence(records)
  };
  let guard = createGuard({ pendingPrompt, importContext, session, plan }).assertFresh;
  guard();
  session.currentBatchId = 'batch-2';
  assert.throws(guard, /账单会话在确认期间已变化/);

  session.currentBatchId = 'batch-1';
  guard = createGuard({ pendingPrompt, importContext, session, plan }).assertFresh;
  writeBalanceSeedRecords(storageRoot, 'ICBC', [{
    ...records[0],
    endBalance: 99
  }]);
  assert.throws(guard, /余额种子在确认期间已变化/);
});

test('renderer 确认请求只生成 contextId + confirm flag', () => {
  const pendingSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer-pending.js'),
    'utf8'
  );
  const pendingContext = { window: {} };
  vm.runInNewContext(
    pendingSource,
    pendingContext
  );
  const pendingRequest = pendingContext.window.__rendererPending
    .buildPendingImportConfirmationRequest('pending-context');
  assert.deepEqual(JSON.parse(JSON.stringify(pendingRequest)), {
    contextId: 'pending-context',
    confirmOverwrite: true
  });
  assert.match(
    pendingSource,
    /startImport\(\s*buildPendingImportConfirmationRequest\(result\.contextId\),\s*displayContext\s*\)/,
    'active Pending 覆盖确认路径必须只提交 opaque context builder 的结果'
  );

  const dialogsSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer-dialogs.js'),
    'utf8'
  );
  const dialogsContext = { window: {} };
  vm.runInNewContext(
    dialogsSource,
    dialogsContext
  );
  const balanceRequest = dialogsContext.window.__rendererDialogs
    .buildBalanceSeedConfirmationRequest('balance-context');
  assert.deepEqual(JSON.parse(JSON.stringify(balanceRequest)), {
    contextId: 'balance-context',
    confirmOverwrite: true
  });
  assert.match(
    dialogsSource,
    /saveBalanceSeed\(\s*buildBalanceSeedConfirmationRequest\(result\.contextId\)\s*\)/,
    'active manual balance dialog 必须只提交 opaque context builder 的结果'
  );

  const rendererSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer.js'),
    'utf8'
  );
  assert.match(
    rendererSource,
    /saveBalanceSeed\(\s*window\.__rendererDialogs\.buildBalanceSeedConfirmationRequest\(result\.contextId\)\s*\)/,
    'legacy active manual balance dialog 也必须只提交 opaque context builder 的结果'
  );
});
