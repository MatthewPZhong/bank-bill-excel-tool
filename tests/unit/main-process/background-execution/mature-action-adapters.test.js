'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const canary = require(
  '../../../../src/main-process/background-execution/canary'
);
const {
  MATURE_ACTION_KEYS,
  MATURE_ACTION_PRODUCTION,
  createMatureActionAdapterBindings,
  isMatureActionProductionEnabled
} = require(
  '../../../../src/main-process/background-execution/mature-action-adapters'
);
const {
  createExecutionSupervisor
} = require('../../../../src/main-process/background-execution/supervisor');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  bindingSnapshot
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const {
  dispatchEngineImportHandle,
  inspectBigTableImportTopology
} = require('../../../../src/main-process/big-table-import-dispatch');
const bigTableFixtures = require('../../backend/big-table-import/_fixtures');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

function pendingPolicy(commitKind = 'existing-critical-protocol') {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.actionKey = MATURE_ACTION_KEYS.pendingImport;
  policy.adapterKind = 'existing-dispatch';
  policy.adapterKey = 'adapter.pending:import';
  policy.entryKey = null;
  policy.mode = 'thread-pool';
  policy.resources.base = {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 5
  };
  policy.resources.phase = {
    cpuSlots: 1,
    workerThreadSlots: 1,
    utilityProcessSlots: 0,
    ioHeavySlots: 1,
    memoryBytes: 10
  };
  policy.resources.compound = {
    topologyKey: 'topology.pending:import',
    childrenMax: 4,
    childResource: {
      cpuSlots: 1,
      workerThreadSlots: 1,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 20
    }
  };
  policy.resources.lowMemoryBehavior = 'downgrade-to-single';
  policy.commit = {
    kind: commitKind,
    criticalIntent: false,
    receiptKind: 'existing-protocol',
    inspectorKey: 'inspector.pending:import',
    conflictScopeResolverKey: 'scope.pending:import',
    settlementKey: 'settlement.pending:import'
  };
  policy.production = {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 1,
    recoveryStatus: 'blocked',
    evidenceStatus: 'missing',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  };
  return policy;
}

function registryFor(policy, binding) {
  return Object.freeze({
    isFrozen() { return true; },
    assertRunnable(actionKey, options = {}) {
      assert.equal(actionKey, policy.actionKey);
      if (options.production === true && policy.production.enabled !== true) {
        const error = new Error('production disabled');
        error.code = 'POLICY_PRODUCTION_DISABLED';
        throw error;
      }
      return policy;
    },
    get(actionKey) {
      return actionKey === policy.actionKey ? policy : undefined;
    },
    getBinding(actionKey, fieldPath) {
      if (actionKey !== policy.actionKey) return undefined;
      if (fieldPath === 'adapterKey') return binding;
      if (fieldPath === 'result.validatorKey') return () => true;
      return undefined;
    },
    list() { return Object.freeze([policy]); }
  });
}

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

async function waitForRealCondition(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('real worker condition not reached');
}

function createRollbackDatabase(dir) {
  const dbPath = path.join(dir, 'mature-cancel.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT, k TEXT NOT NULL, a TEXT, UNIQUE(k));');
  db.prepare('INSERT INTO t (d, k, a) VALUES (?, ?, ?)').run('2026-03-01', 'OLD', '99');
  db.close();
  return dbPath;
}

function writeRollbackContract(dir) {
  const contractModulePath = path.join(dir, 'rollback-contract.js');
  fs.writeFileSync(contractModulePath, `'use strict';
const fs = require('node:fs');
module.exports = function createContract(options = {}) {
  return {
    expectedHeaders: ['日期', '主键', '金额'],
    valueColumnWhitelist: null,
    validateHeaders(cells) {
      const ok = cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额';
      return ok ? { ok: true } : { ok: false, error: '表头不匹配', detailLines: ['实际: ' + cells.join(',')] };
    },
    mapRow({ values }) {
      const key = String(values[1] || '').trim();
      if (!key) return { error: { reason: '主键为空' } };
      return { params: [values[0], key, values[2]] };
    },
    insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
    requiredColumns: [0, 1, 2],
    monthKeyOf({ values }) {
      const match = String(values[0] || '').match(/^(\\d{4})[-/](\\d{1,2})/);
      return match ? match[1] + '-' + String(match[2]).padStart(2, '0') : null;
    },
    deleteSqlForOverwrite: 'DELETE FROM t WHERE d LIKE ?',
    deleteParamsFromMonthKey(monthKey) {
      fs.writeFileSync(options.deleteMarkerPath, 'delete-entered', 'utf8');
      return [monthKey + '%'];
    }
  };
};
`, 'utf8');
  return contractModulePath;
}

function writeBlockedInvalidContract(dir) {
  const contractModulePath = path.join(dir, 'blocked-invalid-contract.js');
  fs.writeFileSync(contractModulePath, `'use strict';
const fs = require('node:fs');
module.exports = function createContract(options = {}) {
  fs.writeFileSync(options.enteredMarkerPath, 'contract-entered', 'utf8');
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(options.releaseMarkerPath) && Date.now() < deadline) {
    Atomics.wait(waitArray, 0, 0, 5);
  }
  return {};
};
`, 'utf8');
  return contractModulePath;
}

async function createRollbackImportFixture() {
  const dir = bigTableFixtures.mkTmpDir('mature-cancel-');
  const dbPath = createRollbackDatabase(dir);
  const contractModulePath = writeRollbackContract(dir);
  const deleteMarkerPath = path.join(dir, 'delete-entered.marker');
  const rows = [['日期', '主键', '金额']];
  for (let index = 0; index < 3000; index += 1) {
    rows.push(['2026-03-02', `NEW-${index}`, String(index)]);
  }
  const filePath = await bigTableFixtures.writeFixtureExcelJS({ rows });
  return { contractModulePath, dbPath, deleteMarkerPath, filePath };
}

function readImportRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT d, k, a FROM t ORDER BY id').all()
    .map((row) => ({ d: row.d, k: row.k, a: row.a }));
  db.close();
  return rows;
}

function createRealMatureSupervisor({ userCooperative = false } = {}) {
  const policy = pendingPolicy();
  policy.cancellation.capability = userCooperative ? 'user-cooperative' : 'shutdown-only';
  policy.cancellation.cooperativeTimeoutMs = 10000;
  policy.cancellation.terminateTimeoutMs = 10000;
  const binding = createMatureActionAdapterBindings()[policy.actionKey];
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, binding),
    resourceGovernor: createResourceGovernor({
      budgets: {
        cpuSlots: 4,
        workerThreadSlots: 4,
        utilityProcessSlots: 0,
        ioHeavySlots: 2,
        memoryBytes: 200
      }
    })
  });
  return { policy, supervisor };
}

function executeRollbackImport(supervisor, policy, fixture, jobId) {
  return supervisor.execute({
    actionKey: policy.actionKey,
    operationKey: 'pending-import-real-cancellation',
    jobId,
    input: {
      dbPath: fixture.dbPath,
      files: [fixture.filePath],
      contractModulePath: fixture.contractModulePath,
      contractOptions: { deleteMarkerPath: fixture.deleteMarkerPath },
      mode: 'overwrite',
      monthKey: '2026-03',
      parallel: 1
    }
  });
}

test.after(() => bigTableFixtures.cleanupTmpDirs());

test('生产 topology inspector 同步复用 engine 并行度算法并拒绝空文件批次', (t) => {
  t.mock.method(os, 'freemem', () => 8 * 1024 * 1024 * 1024);
  const inspected = inspectBigTableImportTopology({
    input: { files: ['1.xlsx', '2.xlsx'], parallel: 4 }
  });
  assert.deepEqual(inspected, { effectiveChildCount: 2 });
  assert.equal(inspected && typeof inspected.then, 'undefined');
  assert.throws(
    () => inspectBigTableImportTopology({ input: { files: [] } }),
    /non-empty input\.files/
  );
});

test('Pending mature adapter admission 前冻结 Parser topology，root+children 精确计费且不创建 wrapper Worker', async () => {
  const gate = deferred();
  let dispatchRequest = null;
  const bindings = createMatureActionAdapterBindings({
    bigTable: {
      pending: {
        inspectTopology() { return { effectiveChildCount: 3 }; },
        dispatch(request) {
          dispatchRequest = request;
          return { promise: gate.promise };
        }
      }
    }
  });
  const policy = pendingPolicy();
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 8,
      workerThreadSlots: 8,
      utilityProcessSlots: 0,
      ioHeavySlots: 4,
      memoryBytes: 200
    }
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, bindings[policy.actionKey]),
    resourceGovernor: governor,
    workerThreadAdapter: {
      start() { throw new Error('platform wrapper Worker must not be spawned'); }
    }
  });

  const execution = supervisor.execute({
    actionKey: policy.actionKey,
    operationKey: 'pending-import-contract',
    jobId: 'pending-import-contract-job',
    input: { files: ['1.xlsx', '2.xlsx', '3.xlsx'], mode: 'append' }
  });
  await waitFor(() => dispatchRequest !== null);
  assert.equal(Object.isFrozen(dispatchRequest.topology), true);
  assert.equal(dispatchRequest.topology.effectiveChildCount, 3);
  assert.equal(dispatchRequest.parallel, 3);
  assert.equal(dispatchRequest.parallelFrozen, true);
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 4,
    workerThreadSlots: 4,
    utilityProcessSlots: 0,
    ioHeavySlots: 1,
    memoryBytes: 75
  });
  gate.resolve({ totalImported: 9, maxParallel: 3 });
  const result = await execution;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.receiptHint, null, 'execution terminal 不伪造 settlement receipt/task success');
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('Pending mature 正常终态等待共享 engine termination barrier 后才释放 CompoundLease', async () => {
  const termination = deferred();
  let dispatchHandle = null;
  let fakeWorker = null;
  let terminateCount = 0;

  class ControlledTerminationWorker extends EventEmitter {
    constructor() {
      super();
      fakeWorker = this;
      this.jobId = null;
    }

    postMessage(message) {
      if (message && message.type === 'run') this.jobId = message.jobId;
    }

    terminate() {
      terminateCount += 1;
      return termination.promise;
    }

    complete(result) {
      this.emit('message', { type: 'done', jobId: this.jobId, result });
    }
  }

  const bindings = createMatureActionAdapterBindings({
    bigTable: {
      pending: {
        inspectTopology() { return { effectiveChildCount: 1 }; },
        dispatch(request) {
          dispatchHandle = dispatchEngineImportHandle({
            ...request.input,
            parallel: request.parallel,
            parallelFrozen: request.parallelFrozen,
            WorkerClass: ControlledTerminationWorker
          });
          return dispatchHandle;
        }
      }
    }
  });
  const policy = pendingPolicy();
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 0,
      ioHeavySlots: 2,
      memoryBytes: 200
    }
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, bindings[policy.actionKey]),
    resourceGovernor: governor
  });
  const execution = supervisor.execute({
    actionKey: policy.actionKey,
    operationKey: 'pending-import-termination-barrier',
    jobId: 'pending-import-termination-barrier-job',
    input: { files: ['controlled.xlsx'], mode: 'append' }
  });
  let executionSettled = false;
  void execution.then(() => { executionSettled = true; });

  await waitFor(() => fakeWorker !== null && dispatchHandle !== null);
  const activeUsage = governor.snapshot().activeUsage;
  assert.equal(activeUsage.workerThreadSlots, 2);
  fakeWorker.complete({ totalImported: 1, maxParallel: 1 });
  await waitFor(() => terminateCount === 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executionSettled, false);
  assert.deepEqual(governor.snapshot().activeUsage, activeUsage);
  assert.strictEqual(dispatchHandle.close(), dispatchHandle.terminate());
  assert.equal(terminateCount, 1);

  termination.resolve(0);
  const result = await execution;
  assert.equal(result.outcome, 'completed');
  assert.equal(terminateCount, 1);
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('Governor downgrade 后只把获批 childCount 透传 engine，禁止按 inspect 上限再扩容', async () => {
  let dispatchedParallel = null;
  const bindings = createMatureActionAdapterBindings({
    bigTable: {
      pending: {
        inspectTopology() { return { effectiveChildCount: 4 }; },
        dispatch(request) {
          dispatchedParallel = request.parallel;
          return Promise.resolve({ totalImported: 0, maxParallel: request.parallel });
        }
      }
    }
  });
  const policy = pendingPolicy();
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 2,
      workerThreadSlots: 2,
      utilityProcessSlots: 0,
      ioHeavySlots: 1,
      memoryBytes: 45
    }
  });
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, bindings[policy.actionKey]),
    resourceGovernor: governor
  });
  const result = await supervisor.execute({
    actionKey: policy.actionKey,
    operationKey: 'pending-import-downgraded',
    jobId: 'pending-import-downgraded-job',
    input: { files: ['1', '2', '3', '4'] }
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(dispatchedParallel, 1);
  assert.equal(result.metrics.workerCount, 1);
});

test('Pending/BizOP 共用 adapter 只追加冻结并行度，业务 options/result/error/cancel 原样透传', async () => {
  for (const actionKey of [MATURE_ACTION_KEYS.pendingImport, MATURE_ACTION_KEYS.bizOpImportFlow]) {
    const expectedError = new Error(`${actionKey} rejected`);
    expectedError.code = 'BUSINESS_CONTRACT_REJECTED';
    let received = null;
    let cancelReason = null;
    const bindings = createMatureActionAdapterBindings({
      bigTable: {
        [actionKey === MATURE_ACTION_KEYS.pendingImport ? 'pending' : 'bizOp']: {
          dispatch(options) {
            received = options;
            return {
              promise: Promise.reject(expectedError),
              cancel(reason) { cancelReason = reason; return { acknowledged: true }; }
            };
          }
        }
      }
    });
    const binding = bindings[actionKey];
    const handle = binding.dispatch({
      input: {
        dbPath: '/tmp/contract.sqlite',
        files: ['a.xlsx', 'b.xlsx'],
        mode: 'overwrite',
        monthKey: '2026-08',
        contractOptions: { rejectEmptyBatch: true }
      },
      topology: { effectiveChildCount: 2 },
      onProgress() {}
    });
    assert.equal(received.dbPath, '/tmp/contract.sqlite');
    assert.deepEqual(received.files, ['a.xlsx', 'b.xlsx']);
    assert.equal(received.mode, 'overwrite');
    assert.equal(received.monthKey, '2026-08');
    assert.deepEqual(received.contractOptions, { rejectEmptyBatch: true });
    assert.equal(received.parallel, 2);
    assert.equal(received.parallelFrozen, true);
    assert.equal(handle.cancel({ reason: 'shutdown' }).acknowledged, true);
    assert.deepEqual(cancelReason, { reason: 'shutdown' });
    await assert.rejects(handle.promise, (error) => error === expectedError);
  }
});

test('Toolbox generation/publisher/recovery 严格分层，recover 不触发 generation 或 publish', async () => {
  const calls = { generation: 0, publish: 0, recover: 0 };
  const bindings = createMatureActionAdapterBindings({
    toolboxSplit: {
      dispatch(input) {
        calls.generation += 1;
        return { promise: Promise.resolve({ stagingPath: input.savePath }) };
      }
    },
    toolboxPublication: {
      publish(options) { calls.publish += 1; return Promise.resolve({ taskId: options.taskId }); },
      recover(options) { calls.recover += 1; return Promise.resolve({ recovered: [], userDataDir: options.userDataDir }); }
    }
  });

  await bindings[MATURE_ACTION_KEYS.toolboxSplitLarge].dispatch({
    input: { op: 'exportFilter', savePath: '/tmp/staging.xlsx' }
  }).promise;
  await bindings[MATURE_ACTION_KEYS.toolboxPublish].dispatch({
    input: { lifecycleOperation: 'publish', options: { taskId: 'publish-1' } }
  });
  assert.deepEqual(calls, { generation: 1, publish: 1, recover: 0 });

  calls.generation = 0;
  calls.publish = 0;
  await bindings[MATURE_ACTION_KEYS.toolboxPublish].dispatch({
    input: { lifecycleOperation: 'recover', options: { userDataDir: '/tmp/toolbox-user-data' } }
  });
  assert.deepEqual(calls, { generation: 0, publish: 0, recover: 1 });
});

test('全部 mature action 机器可证 production=false，默认 IPC 仍直达既有 dispatcher', () => {
  assert.deepEqual(Object.keys(MATURE_ACTION_PRODUCTION).sort(), Object.values(MATURE_ACTION_KEYS).sort());
  for (const actionKey of Object.values(MATURE_ACTION_KEYS)) {
    assert.equal(MATURE_ACTION_PRODUCTION[actionKey], false);
    assert.equal(isMatureActionProductionEnabled(actionKey), false);
  }
  const taskBindings = bindingSnapshot();
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.pendingImport], ['pending:import:start']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.bizOpImportFlow], ['bizOpRecon:import:run-flow']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.toolboxSplitLarge], ['toolbox:split:export']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.toolboxPublish], ['toolbox:split:export']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.positionImport], [
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:run:import-result',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:prepare-import'
  ]);
  const projectRoot = path.resolve(__dirname, '../../../..');
  const pendingSource = fs.readFileSync(path.join(projectRoot, 'src/main-process/pending-session.js'), 'utf8');
  const bizOpSource = fs.readFileSync(path.join(projectRoot, 'src/main-process/biz-op-recon-session.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src/main.js'), 'utf8');
  assert.match(pendingSource, /dispatchEngineImport\s*\(/);
  assert.match(bizOpSource, /dispatchEngineImport\s*\(/);
  assert.match(mainSource, /dispatchLargeSplit\s*\(/);
  assert.doesNotMatch(mainSource, /createMatureActionAdapterBindings\s*\(/);
});

test('Supervisor 经真实 Pending mature binding 取消 Worker 导入：以真实终止证据落 cancelled 并回滚覆盖事务', async () => {
  const fixture = await createRollbackImportFixture();
  const { policy, supervisor } = createRealMatureSupervisor({ userCooperative: true });
  const jobId = 'pending-import-real-cancel-job';
  const execution = executeRollbackImport(supervisor, policy, fixture, jobId);

  await waitForRealCondition(() => fs.existsSync(fixture.deleteMarkerPath));
  const cancellation = await supervisor.cancel(jobId, { reason: 'user-requested' });
  assert.deepEqual(cancellation, { jobId, accepted: true, status: 'cancelling' });

  const result = await execution;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'job:error');
  assert.match(result.error.message, /导入已取消/);
  assert.equal(result.result, null);
  assert.equal(result.receiptHint, null, '取消不得伪造 settlement receipt/task success');
  assert.deepEqual(readImportRows(fixture.dbPath), [
    { d: '2026-03-01', k: 'OLD', a: '99' }
  ], 'overwrite DELETE 与新增行必须随 CancelError 整体回滚');
});

test('Supervisor shutdown 经真实 Pending mature binding 取消 Worker 导入并报告 cancelled job', async () => {
  const fixture = await createRollbackImportFixture();
  const { policy, supervisor } = createRealMatureSupervisor();
  const jobId = 'pending-import-real-shutdown-job';
  const execution = executeRollbackImport(supervisor, policy, fixture, jobId);

  await waitForRealCondition(() => fs.existsSync(fixture.deleteMarkerPath));
  const shutdownReport = await supervisor.shutdown({ timeoutMs: 10000 });
  const result = await execution;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'job:error');
  assert.match(result.error.message, /导入已取消/);
  assert.equal(result.receiptHint, null);
  assert.deepEqual(shutdownReport.cancelledJobs, [jobId]);
  assert.deepEqual(shutdownReport.leakedTransports, []);
  assert.deepEqual(shutdownReport.errors, []);
  assert.deepEqual(readImportRows(fixture.dbPath), [
    { d: '2026-03-01', k: 'OLD', a: '99' }
  ], 'shutdown cancellation 必须回滚同一覆盖事务');
});

test('Supervisor 已投递 cancel 后真实 Worker 先返回非取消 error 仍落 failed', async () => {
  const dir = bigTableFixtures.mkTmpDir('mature-error-');
  const dbPath = createRollbackDatabase(dir);
  const contractModulePath = writeBlockedInvalidContract(dir);
  const enteredMarkerPath = path.join(dir, 'contract-entered.marker');
  const releaseMarkerPath = path.join(dir, 'release-contract.marker');
  const { policy, supervisor } = createRealMatureSupervisor({ userCooperative: true });
  const jobId = 'pending-import-real-error-after-cancel-job';
  const execution = supervisor.execute({
    actionKey: policy.actionKey,
    operationKey: 'pending-import-real-error',
    jobId,
    input: {
      dbPath,
      files: [path.join(dir, 'unused.xlsx')],
      contractModulePath,
      contractOptions: { enteredMarkerPath, releaseMarkerPath },
      mode: 'append',
      monthKey: '2026-03',
      parallel: 1
    }
  });

  await waitForRealCondition(() => fs.existsSync(enteredMarkerPath));
  const cancellation = await supervisor.cancel(jobId, { reason: 'race-with-engine-error' });
  assert.deepEqual(cancellation, { jobId, accepted: true, status: 'cancelling' });
  await new Promise((resolve) => setImmediate(resolve));
  fs.writeFileSync(releaseMarkerPath, 'release', 'utf8');
  const result = await execution;

  assert.equal(result.outcome, 'failed');
  assert.equal(result.terminalSource, 'job:error');
  assert.equal(result.error.code, 'EXISTING_DISPATCH_ERROR');
  assert.match(result.error.message, /expectedHeaders/);
  assert.doesNotMatch(result.error.message, /导入已取消/);
  assert.equal(result.receiptHint, null);
  assert.deepEqual(readImportRows(dbPath), [
    { d: '2026-03-01', k: 'OLD', a: '99' }
  ]);
});

test('native existing-critical-protocol 仍 fail-closed，不借 main-settlement seam 扩张 Worker commit', async () => {
  const policy = pendingPolicy('existing-critical-protocol');
  policy.adapterKind = 'native';
  policy.adapterKey = null;
  policy.entryKey = 'native.entry';
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, null),
    resourceGovernor: createResourceGovernor({
      budgets: {
        cpuSlots: 8,
        workerThreadSlots: 8,
        utilityProcessSlots: 0,
        ioHeavySlots: 8,
        memoryBytes: 1000
      }
    })
  });
  await assert.rejects(
    supervisor.execute({
      actionKey: policy.actionKey,
      operationKey: 'native-existing-critical-must-fail',
      jobId: 'native-existing-critical-must-fail-job',
      input: { files: ['a.xlsx'] }
    }),
    (error) => error.code === 'E02A_DURABLE_COMMIT_UNSUPPORTED'
  );
});
