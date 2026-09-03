'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ACQUIRING_ADAPTER_ACTIONS,
  ACQUIRING_ADAPTER_POLICIES,
  validateAcquiringImportAdapterResult,
  validateAcquiringRunAdapterResult
} = require('../../../../src/main-process/background-execution/acquiring-adapter-policies');
const {
  createAcquiringImportMatureBinding,
  createAcquiringRunMatureBindings
} = require('../../../../src/main-process/background-execution/adapters/acquiring-adapter');
const {
  BACKGROUND_EXECUTION_POLICIES,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  assertFinanceSafeValue
} = require('../../../../src/main-process/background-execution/error-codec');
const {
  bindingSnapshot
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const {
  FLOW_HEADERS
} = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const runDataStore = require('../../../../src/backend/run-data-store');
const bigTableFixtures = require('../../backend/big-table-import/_fixtures');

const CANONICAL_POLICY_FIXTURE = path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
);

function currentExpectedPolicy(actionKey) {
  const fixture = JSON.parse(fs.readFileSync(CANONICAL_POLICY_FIXTURE, 'utf8'));
  const expected = structuredClone(fixture.actions[actionKey]);
  expected.description = `v3.2.5 E13-E Acquiring existing-dispatch capability for ${actionKey}`;
  expected.production = {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  };
  if (actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE) {
    expected.resources.compound.childrenMax = 8;
    expected.workUnits.requestedMaxWorkers = 8;
  }
  if (actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME) {
    expected.resources.compound = null;
  }
  return expected;
}

function operationContext(operationKey = 'operation-e13-e') {
  return Object.freeze({
    taskRunId: 'task-e13-e',
    taskKey: 'acquiringBillCurrency:run',
    moduleId: 'acquiring-bill-currency',
    parentRunId: 'parent-e13-e',
    operationKey
  });
}

function batchContext(operationKey = 'operation-e13-e') {
  return Object.freeze({
    batchId: 32515,
    batchNumber: '2026-08-31-32515',
    ...operationContext(operationKey)
  });
}

function runRequest(overrides = {}) {
  const operationKey = overrides.operationKey || 'operation-e13-e';
  const operation = operationContext(operationKey);
  const batch = batchContext(operationKey);
  return {
    actionKey: ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE,
    operationKey,
    context: { kind: 'operation', value: operation },
    topology: { effectiveChildCount: 8 },
    input: {
      monthKey: '2026-08',
      storageRoot: '/tmp/e13-e-storage',
      chunkSize: 100000,
      workerCount: 8,
      tempDir: '/tmp/e13-e-temp',
      batchContext: batch,
      outputIntent: {
        diffFilePath: '/tmp/e13-e-output.xlsx',
        reportFilePath: '/tmp/e13-e-output.xlsx'
      },
      ...(overrides.input || {})
    },
    ...(overrides.request || {})
  };
}

function validRunResult() {
  return {
    runId: 17,
    totalBillRows: 400000,
    matchedRows: 399000,
    mismatchRows: 10,
    unmatchedRows: 1000,
    diffFilePath: '/tmp/e13-e-output.xlsx',
    reportFilePath: '/tmp/e13-e-output.xlsx',
    cleanupNeeded: true
  };
}

function fakeMainDb() {
  return {
    prepare() {},
    exec() {}
  };
}

test.after(() => bigTableFixtures.cleanupTmpDirs());

test('E13-E 三条 policy 对齐冻结字段并只修正 current topology/production authority', () => {
  assert.equal(ACQUIRING_ADAPTER_POLICIES.length, 3);
  for (const policy of ACQUIRING_ADAPTER_POLICIES) {
    assert.deepEqual(policy, currentExpectedPolicy(policy.actionKey));
    assert.equal(policy.adapterKind, 'existing-dispatch');
    assert.equal(policy.entryKey, null);
    assert.equal(policy.commit.kind, 'existing-critical-protocol');
    assert.equal(policy.production.enabled, false);
  }
  const runNew = ACQUIRING_ADAPTER_POLICIES.find(
    (policy) => policy.actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE
  );
  const single = ACQUIRING_ADAPTER_POLICIES.find(
    (policy) => policy.actionKey === ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME
  );
  assert.equal(runNew.resources.compound.childrenMax, 8);
  assert.equal(runNew.workUnits.requestedMaxWorkers, 8);
  assert.equal(single.resources.compound, null);
  assert.equal(Object.hasOwn(single, 'workUnits'), false);
});

test('E13-E 真实 Runtime 注册三条 adapter/topology/validator 且保持 production false', async (t) => {
  const runtime = createNonProductionBackgroundExecutionRuntime({
    resourceGovernor: createResourceGovernor({
      budgets: {
        cpuSlots: 16,
        workerThreadSlots: 16,
        utilityProcessSlots: 0,
        ioHeavySlots: 16,
        memoryBytes: 8 * 1024 ** 3
      }
    }),
    workerThreadAdapter: {
      start() { throw new Error('Acquiring existing-dispatch 外层不得创建 wrapper Worker'); }
    }
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 10000 }); });
  const policies = new Map(BACKGROUND_EXECUTION_POLICIES.map((policy) => [policy.actionKey, policy]));
  const bindings = bindingSnapshot();
  assert.deepEqual(bindings[ACQUIRING_ADAPTER_ACTIONS.IMPORT], [
    'acquiringBillCurrency:importBill',
    'acquiringBillCurrency:importFlow'
  ]);
  assert.deepEqual(bindings[ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE], [
    'acquiringBillCurrency:run'
  ]);
  assert.deepEqual(bindings[ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME], [
    'acquiringBillCurrency:run',
    'acquiringBillCurrency:run:resume'
  ]);

  for (const policy of ACQUIRING_ADAPTER_POLICIES) {
    assert.deepEqual(policies.get(policy.actionKey), policy);
    const adapter = runtime.policyRegistry.getBinding(policy.actionKey, 'adapterKey');
    assert.equal(typeof adapter.dispatch, 'function');
    if (policy.resources.compound) {
      assert.equal(typeof adapter.inspectTopology, 'function');
      assert.equal(
        typeof runtime.policyRegistry.getBinding(
          policy.actionKey,
          'resources.compound.topologyKey'
        ),
        'function'
      );
    } else {
      assert.equal(Object.hasOwn(adapter, 'inspectTopology'), false);
    }
    assert.equal(runtime.policyRegistry.get(policy.actionKey).production.enabled, false);
  }
  assert.equal(
    runtime.policyRegistry.getBinding(
      ACQUIRING_ADAPTER_ACTIONS.IMPORT,
      'result.validatorKey'
    ),
    validateAcquiringImportAdapterResult
  );
  assert.equal(
    runtime.policyRegistry.getBinding(
      ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE,
      'result.validatorKey'
    ),
    validateAcquiringRunAdapterResult
  );
});

test('E13-E import 复用 admitted Parser topology、Main DB authority 并保留旧进度/结果合同', async () => {
  const calls = [];
  const progress = [];
  let openCount = 0;
  const binding = createAcquiringImportMatureBinding({
    userDataDir: '/tmp/e13-e-user-data',
    nowIso: () => '2026-08-31T00:00:00.000Z',
    openSideDb() {
      openCount += 1;
      return { close() {} };
    },
    dispatchEngine(request) {
      calls.push(request);
      request.onEngineProgress({ sourceFile: 'two.xlsx', importedCount: 12 });
      return {
        promise: Promise.resolve({
          monthKey: '2026-08',
          fileCount: 2,
          totalImported: 12,
          deletedCount: 3,
          maxParallel: 2
        }),
        cancel() { return { acknowledged: false }; },
        close() {},
        terminate() {}
      };
    }
  });
  const context = batchContext('operation-e13-e-import');
  const request = {
    operationKey: context.operationKey,
    context: { kind: 'file-batch', value: context },
    topology: { effectiveChildCount: 2 },
    input: {
      kind: 'flow',
      monthKey: '2026-08',
      files: ['/tmp/one.xlsx', '/tmp/two.xlsx'],
      overwrite: true,
      batchContext: context
    },
    onProgress(event) { progress.push(event); }
  };
  assert.deepEqual(binding.inspectTopology(request), { effectiveChildCount: 2 });
  const handle = binding.dispatch(request);
  assert.deepEqual(await handle.promise, {
    monthKey: '2026-08',
    fileCount: 2,
    totalImported: 12,
    perFileStats: [{ sourceFile: 'one.xlsx' }, { sourceFile: 'two.xlsx' }],
    deletedCount: 3
  });
  assert.equal(openCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].dbPath, /run-data[/\\]acquiring-bill-currency[/\\]month-2026-08\.sqlite$/);
  assert.match(calls[0].contractModulePath, /contract-flow\.js$/);
  assert.deepEqual(calls[0].contractOptions, { importedAt: '2026-08-31T00:00:00.000Z' });
  assert.equal(calls[0].parallel, 2);
  assert.equal(calls[0].parallelFrozen, true);
  assert.deepEqual(calls[0].batchContext, context);
  assert.deepEqual(progress, [
    { stage: 'reading', fileIndex: 0, fileCount: 2, filePath: '/tmp/one.xlsx' },
    { stage: 'reading', fileIndex: 1, fileCount: 2, filePath: '/tmp/two.xlsx' },
    {
      stage: 'inserting',
      fileIndex: 1,
      fileCount: 2,
      sourceFile: 'two.xlsx',
      importedCount: 12
    }
  ]);
});

test('E13-E 真实 Runtime 直接复用 Acquiring Parser Worker 并写入 Main-owned side DB', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e13-e-runtime-import-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const row = Array.from({ length: FLOW_HEADERS.length }, () => '');
  row[0] = '2026-08-31';
  row[6] = 'FLOW-RUNTIME-1';
  row[28] = '123.45';
  row[29] = 'USD';
  const filePath = await bigTableFixtures.writeFixtureExcelJS({
    rows: [FLOW_HEADERS, row]
  });
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 0,
      ioHeavySlots: 8,
      memoryBytes: 4 * 1024 ** 3
    }
  });
  let wrapperStarts = 0;
  const runtime = createNonProductionBackgroundExecutionRuntime({
    userDataDir,
    resourceGovernor: governor,
    workerThreadAdapter: {
      start() {
        wrapperStarts += 1;
        throw new Error('Acquiring existing-dispatch 外层不得创建 wrapper Worker');
      }
    }
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 10000 }); });
  const operationKey = 'operation-e13-e-runtime-import';
  const context = Object.freeze({
    batchId: 3251501,
    batchNumber: '2026-08-31-3251501',
    taskRunId: 'task-e13-e-runtime-import',
    taskKey: 'acquiringBillCurrency:importFlow',
    moduleId: 'acquiring-bill-currency',
    parentRunId: 'parent-e13-e-runtime-import',
    operationKey
  });
  const progress = [];
  const execution = await runtime.execute({
    actionKey: ACQUIRING_ADAPTER_ACTIONS.IMPORT,
    operationKey,
    jobId: 'job-e13-e-runtime-import',
    production: false,
    context: { kind: 'file-batch', value: context },
    input: {
      kind: 'flow',
      monthKey: '2026-08',
      files: [filePath],
      parallel: 1,
      overwrite: false,
      batchContext: context
    },
    onProgress(event) { progress.push(event); }
  });

  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.deepEqual(execution.result, {
    monthKey: '2026-08',
    fileCount: 1,
    totalImported: 1,
    perFileStats: [{ sourceFile: path.basename(filePath) }]
  });
  assert.equal(wrapperStarts, 0);
  assert.equal(progress.some((event) => event.stage === 'reading'), true);
  const sideDbPath = runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_ACQUIRING,
    '2026-08'
  );
  const sideDb = new DatabaseSync(sideDbPath, { readOnly: true });
  try {
    const imported = sideDb.prepare(`
      SELECT month_key, recon_main_id, settle_amount, settle_currency_norm
      FROM acquiring_bill_currency_flow_imports
    `).get();
    assert.deepEqual({ ...imported }, {
      month_key: '2026-08',
      recon_main_id: 'FLOW-RUNTIME-1',
      settle_amount: '123.45',
      settle_currency_norm: 'usd'
    });
  } finally {
    sideDb.close();
  }
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('E13-E import 在 side DB/dispatcher 前拒绝 authority override 与 exact-7 分叉', () => {
  let opened = 0;
  let dispatched = 0;
  const binding = createAcquiringImportMatureBinding({
    userDataDir: '/tmp/e13-e-user-data',
    openSideDb() { opened += 1; return { close() {} }; },
    dispatchEngine() { dispatched += 1; return { promise: Promise.resolve({}) }; }
  });
  const context = batchContext('operation-e13-e-import-reject');
  const base = {
    operationKey: context.operationKey,
    context: { kind: 'file-batch', value: context },
    topology: { effectiveChildCount: 1 },
    input: {
      kind: 'bill',
      monthKey: '2026-08',
      files: ['/tmp/one.xlsx'],
      batchContext: context
    }
  };
  assert.throws(
    () => binding.dispatch({
      ...base,
      input: { ...base.input, dbPath: '/tmp/caller.sqlite' }
    }),
    { code: 'ACQUIRING_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN' }
  );
  assert.throws(
    () => binding.dispatch({
      ...base,
      input: {
        ...base.input,
        batchContext: { ...context, taskRunId: 'caller-task' }
      }
    }),
    { code: 'BIG_TABLE_ADAPTER_BATCH_CONTEXT_MISMATCH' }
  );
  assert.equal(opened, 0);
  assert.equal(dispatched, 0);
});

test('E13-E run-new 在 admission/dispatch 双重应用 D31 gate 并透传 admitted workerCount', async () => {
  const calls = [];
  const pool = {
    dispatchRunCheck() {},
    cancel() { return true; },
    shutdown() { return Promise.resolve(); }
  };
  const bindings = createAcquiringRunMatureBindings({
    userDataDir: '/tmp/e13-e-user-data',
    mainDbProvider: fakeMainDb,
    countBillRows: () => 400000,
    shouldFallbackToSingleWorker: ({ totalBillRows, workerCount }) =>
      totalBillRows < 300000 || workerCount < 2,
    pool,
    runData: {
      runCheckViaSideDb(request) {
        calls.push(request);
        return Promise.resolve(validRunResult());
      },
      resumeRunCheck() { throw new Error('unexpected resume'); }
    }
  });
  const request = runRequest({ request: { topology: { effectiveChildCount: 6 } } });
  assert.deepEqual(bindings.runNew.inspectTopology(runRequest()), { effectiveChildCount: 8 });
  const handle = bindings.runNew.dispatch(request);
  assert.deepEqual(await handle.promise, validRunResult());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workerCount, 6);
  assert.deepEqual(calls[0].batchContext, batchContext());
  assert.equal(calls[0].dispatchFn, pool.dispatchRunCheck);
  assert.deepEqual(await handle.cancel(), { acknowledged: false });
  assert.equal(handle.isCancellationTerminalError(Object.assign(new Error('cancelled'), {
    name: 'CancelError'
  })), true);
  await handle.close();
  await handle.terminate();
});

test('E13-E run 在 dispatcher/DB 写前拒绝 exact-5/7 identity 分叉和错误 action 分类', () => {
  let countCalls = 0;
  let runCalls = 0;
  const bindings = createAcquiringRunMatureBindings({
    userDataDir: '/tmp/e13-e-user-data',
    mainDbProvider: fakeMainDb,
    countBillRows() { countCalls += 1; return 400000; },
    shouldFallbackToSingleWorker: ({ totalBillRows }) => totalBillRows < 300000,
    pool: {
      dispatchRunCheck() {},
      cancel() { return false; },
      shutdown() {}
    },
    runData: {
      runCheckViaSideDb() { runCalls += 1; return Promise.resolve(validRunResult()); },
      resumeRunCheck() { runCalls += 1; return Promise.resolve(validRunResult()); }
    }
  });
  const mismatch = runRequest({
    input: { batchContext: { ...batchContext(), operationKey: 'other-operation' } }
  });
  assert.throws(
    () => bindings.runNew.inspectTopology(mismatch),
    { code: 'ACQUIRING_RUN_CONTEXT_MISMATCH' }
  );
  assert.equal(countCalls, 0);
  assert.equal(runCalls, 0);

  assert.throws(
    () => bindings.runSingle.dispatch(runRequest()),
    { code: 'ACQUIRING_RUN_ACTION_CLASSIFICATION_MISMATCH' }
  );
  assert.throws(
    () => bindings.runSingle.dispatch(runRequest({
      input: { resumePlan: { dbPath: '/tmp/caller.sqlite', runId: 17 } }
    })),
    { code: 'ACQUIRING_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN' }
  );
  assert.equal(runCalls, 0);
});

test('E13-E run-new 对小数据 fail closed；single 冻结为 root-only 防止 TOCTOU 动态起 child', async () => {
  const runCalls = [];
  const options = {
    userDataDir: '/tmp/e13-e-user-data',
    mainDbProvider: fakeMainDb,
    countBillRows: () => 100000,
    shouldFallbackToSingleWorker: ({ totalBillRows }) => totalBillRows < 300000,
    pool: {
      dispatchRunCheck() {},
      cancel() { return false; },
      shutdown() {}
    },
    runData: {
      runCheckViaSideDb(request) {
        runCalls.push(request);
        return Promise.resolve(validRunResult());
      },
      resumeRunCheck() { throw new Error('unexpected resume'); }
    }
  };
  const bindings = createAcquiringRunMatureBindings(options);
  assert.throws(
    () => bindings.runNew.inspectTopology(runRequest()),
    { code: 'ACQUIRING_RUN_MULTIWORKER_INELIGIBLE' }
  );
  const handle = bindings.runSingle.dispatch(runRequest());
  await handle.promise;
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].workerCount, 1);
});

test('E13-E resume 永远调用既有 resume wrapper 且不携带 multiworker workerCount', async () => {
  const preparedCalls = [];
  const freshnessCalls = [];
  const calls = [];
  const authoritativePlan = {
    mode: 'resume',
    source: 'side',
    dbPath: '/tmp/e13-e-user-data/run-data/acquiring-bill-currency/month-2026-08.sqlite',
    monthKey: '2026-08',
    runId: 17,
    progress: { lastCompletedChunkIndex: 2, chunkSize: 65536 },
    progressEvidence: '{"lastCompletedChunkIndex":2,"chunkSize":65536}',
    recovery: { batchContext: batchContext() },
    outputIntent: {
      diffFilePath: '/tmp/e13-e-output.xlsx',
      reportFilePath: '/tmp/e13-e-output.xlsx'
    }
  };
  const bindings = createAcquiringRunMatureBindings({
    userDataDir: '/tmp/e13-e-user-data',
    mainDbProvider: fakeMainDb,
    mainDatabasePath: '/tmp/e13-e-main.sqlite',
    countBillRows() { throw new Error('resume 不得读取 multiworker gate'); },
    pool: {
      dispatchRunCheck() {},
      cancel() { return false; },
      shutdown() {}
    },
    runData: {
      runCheckViaSideDb() { throw new Error('unexpected fresh run'); },
      prepareRunResume(request) {
        preparedCalls.push(request);
        return authoritativePlan;
      },
      assertRunResumeFresh(request) {
        freshnessCalls.push(request);
      },
      resumeRunCheck(request) {
        calls.push(request);
        return Promise.resolve({
          runId: 17,
          totalBillRows: 400000,
          matchedRows: 399000,
          mismatchRows: 10,
          unmatchedRows: 1000,
          diffFilePath: '/tmp/e13-e-output.xlsx',
          reportFilePath: '/tmp/e13-e-output.xlsx'
        });
      }
    }
  });
  const request = runRequest({
    input: {
      workerCount: undefined,
      resumeRunId: 17
    }
  });
  const result = await bindings.runSingle.dispatch(request).promise;
  assert.equal(validateAcquiringRunAdapterResult(result), true);
  assert.equal(preparedCalls.length, 1);
  assert.equal(preparedCalls[0].userDataDir, path.resolve('/tmp/e13-e-user-data'));
  assert.equal(preparedCalls[0].mainDbPath, path.resolve('/tmp/e13-e-main.sqlite'));
  assert.equal(preparedCalls[0].runId, 17);
  assert.equal(freshnessCalls.length, 1);
  assert.equal(freshnessCalls[0].prepared, authoritativePlan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prepared, authoritativePlan);
  assert.equal(calls[0].chunkSize, 65536, 'resume 必须优先使用持久 chunkSize');
  assert.equal(Object.hasOwn(calls[0], 'workerCount'), false);
  assert.deepEqual(calls[0].batchContext, batchContext());
});

test('E13-E resume 在 dispatcher 前拒绝持久 owner/output intent 分叉', () => {
  let dispatched = 0;
  const makeBindings = (plan) => createAcquiringRunMatureBindings({
    userDataDir: '/tmp/e13-e-user-data',
    mainDbProvider: fakeMainDb,
    mainDatabasePath: '/tmp/e13-e-main.sqlite',
    pool: {
      dispatchRunCheck() {},
      cancel() { return false; },
      shutdown() {}
    },
    runData: {
      prepareRunResume() { return plan; },
      assertRunResumeFresh() {},
      resumeRunCheck() {
        dispatched += 1;
        return Promise.resolve(validRunResult());
      },
      runCheckViaSideDb() { throw new Error('unexpected fresh run'); }
    }
  });
  const basePlan = {
    mode: 'resume',
    source: 'side',
    dbPath: '/tmp/e13-e-user-data/run-data/acquiring-bill-currency/month-2026-08.sqlite',
    monthKey: '2026-08',
    runId: 17,
    progress: { lastCompletedChunkIndex: 2, chunkSize: 100000 },
    recovery: { batchContext: batchContext() },
    outputIntent: {
      diffFilePath: '/tmp/e13-e-output.xlsx',
      reportFilePath: '/tmp/e13-e-output.xlsx'
    }
  };
  const request = runRequest({
    input: { workerCount: undefined, resumeRunId: 17 }
  });
  assert.throws(
    () => makeBindings({
      ...basePlan,
      recovery: { batchContext: { ...batchContext(), taskRunId: 'other-task' } }
    }).runSingle.dispatch(request),
    { code: 'ACQUIRING_RUN_RESUME_OWNER_MISMATCH' }
  );
  assert.throws(
    () => makeBindings({
      ...basePlan,
      outputIntent: {
        diffFilePath: '/tmp/other-output.xlsx',
        reportFilePath: '/tmp/other-output.xlsx'
      }
    }).runSingle.dispatch(request),
    { code: 'ACQUIRING_RUN_RESUME_OUTPUT_INTENT_MISMATCH' }
  );
  assert.equal(dispatched, 0);
});

test('E13-E run adapter 通过真实 run-data wrapper 保留 side-DB → Main mirror', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e13-e-run-mirror-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mainDb = new DatabaseSync(':memory:');
  t.after(() => mainDb.close());
  mainDb.exec(`
    CREATE TABLE acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT,
      ran_at TEXT,
      total_bill_rows INTEGER,
      matched_rows INTEGER,
      mismatch_rows INTEGER,
      unmatched_rows INTEGER,
      status TEXT,
      diff_file_path TEXT,
      report_file_path TEXT,
      side_db_rel_path TEXT
    );
  `);
  const result = validRunResult();
  const pool = {
    dispatchRunCheck() { return Promise.resolve(result); },
    cancel() { return false; },
    shutdown() {}
  };
  const bindings = createAcquiringRunMatureBindings({
    userDataDir: dir,
    mainDbProvider: () => mainDb,
    countBillRows: () => 400000,
    shouldFallbackToSingleWorker: () => false,
    pool
  });
  assert.deepEqual(await bindings.runNew.dispatch(runRequest()).promise, result);
  const mirror = mainDb.prepare(
    'SELECT * FROM acquiring_bill_currency_runs WHERE month_key = ?'
  ).get('2026-08');
  assert.equal(mirror.status, 'success');
  assert.equal(mirror.total_bill_rows, 400000);
  assert.equal(mirror.matched_rows, 399000);
  assert.equal(mirror.side_db_rel_path, path.join(
    'run-data',
    'acquiring-bill-currency',
    'month-2026-08.sqlite'
  ));
});

test('E13-E result validator 对旧 DTO 两种合法形状 fail closed', () => {
  const append = {
    monthKey: '2026-08',
    fileCount: 2,
    totalImported: 10,
    perFileStats: [{ sourceFile: 'one.xlsx' }, { sourceFile: 'two.xlsx' }]
  };
  assert.equal(validateAcquiringImportAdapterResult(append), true);
  assert.equal(validateAcquiringImportAdapterResult({ ...append, deletedCount: 3 }), true);
  assert.equal(validateAcquiringImportAdapterResult({ ...append, injected: true }), false);
  assert.equal(validateAcquiringImportAdapterResult({
    ...append,
    perFileStats: [{ sourceFile: 'one.xlsx' }]
  }), false);
  assert.equal(validateAcquiringImportAdapterResult({
    ...append,
    perFileStats: [
      { sourceFile: '/Users/example/Documents/one.xlsx' },
      { sourceFile: 'two.xlsx' }
    ]
  }), false);
  const sensitiveImportResult = {
    monthKey: '2026-08',
    fileCount: 1,
    totalImported: 1,
    perFileStats: [{ sourceFile: '6222021234567890.xlsx' }]
  };
  assert.doesNotThrow(() => assertFinanceSafeValue(
    sensitiveImportResult,
    'finance-safe-v1',
    '/payload/result',
    { allowValue: validateAcquiringImportAdapterResult.allowFinanceSafeValue }
  ));
  assert.doesNotThrow(() => assertFinanceSafeValue(
    {
      stage: 'reading',
      fileIndex: 0,
      fileCount: 1,
      filePath: '/Users/example/Documents/6222021234567890.xlsx'
    },
    'finance-safe-v1',
    '/payload/progress',
    { allowValue: validateAcquiringImportAdapterResult.allowFinanceSafeValue }
  ));

  const fresh = validRunResult();
  const resumed = { ...fresh };
  delete resumed.cleanupNeeded;
  assert.equal(validateAcquiringRunAdapterResult(fresh), true);
  assert.equal(validateAcquiringRunAdapterResult(resumed), true);
  assert.equal(validateAcquiringRunAdapterResult({ ...fresh, mismatchRows: 400000 }), false);
  assert.equal(validateAcquiringRunAdapterResult({
    ...fresh,
    reportFilePath: '/tmp/other.xlsx'
  }), false);
  assert.equal(validateAcquiringRunAdapterResult({ ...fresh, injected: true }), false);

  const userDirectoryResult = {
    ...fresh,
    diffFilePath: '/Users/example/Documents/acquiring-result.xlsx',
    reportFilePath: '/Users/example/Documents/acquiring-result.xlsx'
  };
  assert.equal(validateAcquiringRunAdapterResult(userDirectoryResult), true);
  assert.doesNotThrow(() => assertFinanceSafeValue(
    userDirectoryResult,
    'finance-safe-v1',
    '/payload/result',
    { allowValue: validateAcquiringRunAdapterResult.allowFinanceSafeValue }
  ));
  assert.equal(
    validateAcquiringRunAdapterResult.allowFinanceSafeValue({
      value: userDirectoryResult.diffFilePath,
      path: '/payload/result/unexpectedPath',
      parent: userDirectoryResult,
      key: 'diffFilePath'
    }),
    false
  );
});
