// G6 B3 Main operation lock：直接执行 Main 原文 run/resume prepare、execute、cancel 与 failure listener。
// idle 使用真实生产 pool/worker；其他执行场景使用真实 pool + 可控 Worker，数据库为自建 SQLite。
// 显式替身边界：侧库业务桥接、Archive 查询、文件结算、Electron 通知/IPC 注册。
// 未加载共享 runArchiveAwareOperation 包装器，不覆盖其第二 Hold gate / initialize 的既有清理缺口。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const pool = require('../../../src/main-process/run-check-worker-pool');
const runRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');

const source = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
const RUN = 'acquiringBillCurrency:run';
const RESUME = 'acquiringBillCurrency:run:resume';
const ACTIONS = [RUN, RESUME];

function sourceParts() {
  const lockStart = source.indexOf('const acquiringBillCurrencyOperationLock =');
  const lockEnd = source.indexOf('// v3.0.11 需求3', lockStart);
  const handlersStart = source.indexOf("  trackedIpcHandle('acquiringBillCurrency:run',");
  const handlersEnd = source.indexOf('  // v0.8 fix5：export =', handlersStart);
  const listenerCall = 'runCheckWorkerPool.setFailureListener(';
  const listenerStart = source.indexOf(listenerCall + '(info) => {') + listenerCall.length;
  const listenerEnd = source.indexOf('\n      });', listenerStart) + 8;
  assert.ok(lockStart >= 0 && lockEnd > lockStart);
  assert.ok(handlersStart >= 0 && handlersEnd > handlersStart);
  assert.ok(listenerStart >= listenerCall.length && listenerEnd > listenerStart);
  return {
    lock: source.slice(lockStart, lockEnd),
    handlers: source.slice(handlersStart, handlersEnd),
    listener: source.slice(listenerStart, listenerEnd),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness({ controlledWorker = false, rejectResumePrepare = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-main-lock-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE acquiring_bill_currency_runs(id INTEGER PRIMARY KEY, month_key TEXT, chunk_progress TEXT)');
  db.prepare('INSERT INTO acquiring_bill_currency_runs VALUES (7, ?, ?)').run('2026-04', JSON.stringify({
    lastCompletedChunkIndex: 1, totalChunks: 4, chunkSize: 100, status: 'in-progress',
  }));
  const handlers = new Map();
  const ipcHandlers = new Map();
  const logs = [];
  const notifications = [];
  const failureObservations = [];
  const started = deferred();
  const failed = deferred();
  let settlementCount = 0;
  let dispatchCount = 0;
  let releaseCalls = 0;
  const database = { db, dbPath,
    getAcquiringBillChunkSize: () => 100, getAcquiringBillWorkerCount: () => 1 };
  const dispatch = (opts, isResume) => {
    dispatchCount++;
    return opts.dispatchFn({
      __dbPath: dbPath, monthKey: isResume ? opts.prepared.monthKey : opts.monthKey,
      storageRoot: dir, chunkSize: opts.chunkSize, batchContext: opts.batchContext,
      outputIntent: opts.outputIntent,
      ...(isResume ? { resumeFromRun: { runId: opts.prepared.runId, lastCompletedChunkIndex: 1 } } : {}),
    }, opts.dispatchCallbacks);
  };
  const context = vm.createContext({
    path, os, fs, database, runRepo,
    archiveCenterService: null,
    businessOperationRegistry: { isInstallTransitionActive: () => false },
    INSTALL_BUSY_MESSAGE: 'busy',
    trackedIpcHandle(key, _moduleName, _operationName, handler) { handlers.set(key, handler); },
    ipcMain: { handle(key, handler) { ipcHandlers.set(key, handler); } },
    runCheckWorkerPool: { ...pool,
      // 测试取消真实发给 Worker，关闭仅用于兜底的 5 秒 timer，避免已完成回归空等。
      cancel: (jobId) => pool.cancel(jobId, { hardTimeoutMs: 0 }),
    },
    acquiringRunData: {
      findBoundResumableRun: () => null,
      prepareRunResume({ monthKey, runId }) {
        if (rejectResumePrepare) throw new Error('fixture resume prepare failed');
        return { monthKey, runId, progress: { chunkSize: 100 }, recovery: { batchContext: null },
          flowPlan: { startsNewFlow: true, flowIdentity: null }, outputIntent: null };
      },
      runCheckViaSideDb: (opts) => dispatch(opts, false),
      resumeRunCheck: (opts) => dispatch(opts, true),
      transferRunResumeOwner() {},
    },
    acquiringBillCurrencyWriter: { planRunOutputPaths: () => ({ diffFilePath: path.join(dir, 'diff.xlsx') }) },
    normalizeFilePlanV1: (plan) => plan,
    ensureStorageRoot: () => dir,
    createRunProgressForwarder: () => (progress) => {
      if (progress.stage === 'fixture-started') started.resolve();
    },
    notifyAcquiringBillCurrencyResult: (monthKey, status, detail) => notifications.push({ monthKey, status, detail }),
    appendActivityLogEntry: (entry) => logs.push(entry),
    Notification: class {
      static isSupported() { return true; }
      constructor(options) { this.options = options; }
      show() { notifications.push({ native: this.options }); }
    },
    countRelease() { releaseCalls++; },
  });
  const parts = sourceParts();
  // 包装最外层别名只计数，锁函数、prepare 的幂等闭包与 execute finally 均用实际 Main 原文。
  vm.runInContext(parts.lock + `
    const tryAcquireOpLock = tryAcquireAcquiringBillCurrencyOpLock;
    const releaseOpLock = () => { countRelease(); releaseAcquiringBillCurrencyOpLock(); };
    globalThis.currentLock = acquiringBillCurrencyOperationLock;
  ` + parts.handlers, context);
  const failureListener = vm.runInContext('(' + parts.listener + ')', context);
  pool.setFailureListener((info) => {
    failureListener(info);
    failureObservations.push({ hadActiveJob: info.hadActiveJob, source: info.source,
      lockAfterCallback: JSON.parse(JSON.stringify(context.currentLock)) });
    failed.resolve(info);
  });
  if (controlledWorker) pool.__test_only_set_worker_script__(path.join(__dirname, '__fixtures__/acquiring-main-lock-worker.js'));
  const taskContext = { batchContext: {},
    fileEvidence: { filePlan: { outputs: [{ filePath: path.join(dir, 'diff.xlsx'), artifactKey: 'fixture-output' }] } },
    async settleArtifacts() { settlementCount++; },
  };
  return {
    dir, dbPath, db, handlers, ipcHandlers, context, started, failed, logs, notifications, failureObservations,
    get releaseCalls() { return releaseCalls; },
    get dispatchCount() { return dispatchCount; },
    get settlementCount() { return settlementCount; },
    prepare: (action, monthKey = '2026-04') => handlers.get(action).prepare({}, { monthKey, runId: 7 }),
    execute: (action, prepared) => handlers.get(action).execute({}, prepared, taskContext),
    async cleanup() {
      pool.setFailureListener(null);
      await pool.__reset_for_test__();
      pool.__test_only_set_worker_script__(null);
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function assertNextOwnerAndIdempotence(harness, previous, action) {
  const before = harness.releaseCalls;
  const next = await harness.prepare(action, '2026-05');
  assert.equal(next.proceed, true, '所属流程收尾后下一 prepare 应获锁');
  previous.releaseLock();
  previous.onAbandon();
  assert.equal(harness.releaseCalls, before, '旧 owner 重复 release/abandon 不得再释放全局锁');
  assert.equal(harness.context.currentLock.monthKey, '2026-05');
  const blocked = await harness.prepare(action, '2026-06');
  assert.equal(blocked.result.status, 'busy');
  next.onAbandon();
  assert.equal(harness.context.currentLock.inFlight, false);
}

for (const action of ACTIONS) {
  test(`Main ${action}：真实 idle failure 不释放下一 prepare 的锁`, async () => {
    const harness = createHarness();
    try {
      await pool.preWarm(harness.dbPath);
      assert.equal(pool.getStatus().busy, false);
      const owner = await harness.prepare(action);
      assert.equal(owner.proceed, true);
      pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });
      const info = await harness.failed.promise;
      assert.equal(info.hadActiveJob, false);
      assert.equal(harness.context.currentLock.inFlight, true, 'idle failure callback 不拥有当前 prepare 的锁');
      const second = await harness.prepare(action, '2026-05');
      assert.equal(second.result.status, 'busy');
      assert.equal(harness.releaseCalls, 0);
      assert.equal(runRepo.getRunChunkProgress(harness.db, 7).status, 'in-progress', 'idle failure 不改 partial');
      assert.ok(harness.logs.some((entry) => entry.level === 'error'));
      assert.ok(harness.notifications.some((entry) => entry.native));
      owner.onAbandon();
      assert.equal(harness.releaseCalls, 1);
      await assertNextOwnerAndIdempotence(harness, owner, action);
    } finally { await harness.cleanup(); }
  });

  test(`Main ${action}：真实 active failure 经所属 execute finally 解锁`, async () => {
    const harness = createHarness({ controlledWorker: true });
    let execution;
    try {
      const owner = await harness.prepare(action);
      assert.equal(owner.proceed, true);
      execution = harness.execute(action, owner);
      await harness.started.promise;
      assert.equal(pool.getStatus().busy, true);
      assert.equal((await harness.prepare(action, '2026-05')).result.status, 'busy');
      pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });
      await harness.failed.promise;
      const outcome = await execution;
      assert.equal(harness.failureObservations[0].hadActiveJob, true);
      assert.equal(harness.failureObservations[0].lockAfterCallback.inFlight, true,
        'callback 不得抢在所属 execute finally 前解锁');
      assert.equal(outcome.status, 'error');
      assert.match(outcome.message, /worker exit 异常/);
      assert.equal(harness.releaseCalls, 1, '真实 execute finally 释放一次');
      assert.equal(harness.context.currentLock.inFlight, false);
      assert.equal(harness.dispatchCount, 1);
      assert.equal(harness.settlementCount, 0);
      const progress = runRepo.getRunChunkProgress(harness.db, 7);
      assert.equal(progress.status, 'partial', '原 failureListener partial 兜底仍执行');
      assert.equal(progress.chunkSize, 100, '原 resume chunkSize 合同保留');
      await assertNextOwnerAndIdempotence(harness, owner, action);
    } finally {
      await harness.cleanup();
      if (execution) await execution;
    }
  });

  for (const terminal of ['normal', 'cancel']) {
    test(`Main ${action}：${terminal} 经真实 execute finally 释放且旧 owner 幂等`, async () => {
      const harness = createHarness({ controlledWorker: true });
      let execution;
      try {
        const owner = await harness.prepare(action);
        execution = harness.execute(action, owner);
        await harness.started.promise;
        assert.equal(harness.context.currentLock.inFlight, true);
        assert.equal((await harness.prepare(action, '2026-05')).result.status, 'busy');
        if (terminal === 'normal') pool.__test_only_post__({ type: 'test-complete' });
        else {
          const cancelled = harness.ipcHandlers.get('acquiringBillCurrency:run:cancel')({}, {});
          assert.equal(cancelled.status, 'success');
        }
        const outcome = await execution;
        assert.equal(outcome.status, terminal === 'normal' ? 'success' : 'cancelled');
        assert.equal(harness.releaseCalls, 1);
        assert.equal(harness.dispatchCount, 1);
        assert.equal(harness.settlementCount, terminal === 'normal' ? 1 : 0);
        assert.equal(harness.context.currentLock.inFlight, false);
        assert.equal(harness.failureObservations.length, 0);
        await assertNextOwnerAndIdempotence(harness, owner, action);
      } finally {
        await harness.cleanup();
        if (execution) await execution;
      }
    });
  }

  test(`Main ${action}：prepare 后 onAbandon 释放一次且不清下一 owner`, async () => {
    const harness = createHarness();
    try {
      const owner = await harness.prepare(action);
      assert.equal(owner.proceed, true);
      assert.equal((await harness.prepare(action, '2026-05')).result.status, 'busy');
      owner.onAbandon();
      assert.equal(harness.releaseCalls, 1);
      assert.equal(harness.dispatchCount, 0);
      await assertNextOwnerAndIdempotence(harness, owner, action);
    } finally { await harness.cleanup(); }
  });
}

test('Main resume prepare 业务预检失败：持锁异常分支自行释放', async () => {
  const harness = createHarness({ rejectResumePrepare: true });
  try {
    const outcome = await harness.prepare(RESUME);
    assert.equal(outcome.proceed, false);
    assert.equal(outcome.result.status, 'error');
    assert.match(outcome.result.message, /fixture resume prepare failed/);
    assert.equal(harness.releaseCalls, 1);
    assert.equal(harness.context.currentLock.inFlight, false);
    const next = await harness.prepare(RUN, '2026-05');
    assert.equal(next.proceed, true);
    next.onAbandon();
  } finally { await harness.cleanup(); }
});
