'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  createTaskLifecycle
} = require('../../../src/main-process/archive-center/task-lifecycle');
const {
  createTaskPolicyRegistry
} = require('../../../src/main-process/archive-center/task-policy-registry');
const {
  createVccFinancialOpService
} = require('../../../src/main-process/vcc-financial-op-service');
const {
  WORKER_BATCH_CONTEXT_FIELDS
} = require('../../../src/main-process/archive-center/worker-batch-context');

class FakeWorker extends EventEmitter {
  constructor(options, result) {
    super();
    this.options = options;
    this.result = result;
    this.sentMessages = [];
  }

  postMessage(message) { this.sentMessages.push(message); }

  async terminate() {
    return 0;
  }
}

function createLifecycleHarness({
  reserveResult,
  appendResult,
  completeError,
  persistTerminalIntent
} = {}) {
  const calls = [];
  let token = 0;
  let terminalStatus = '';
  const terminalResult = (name, batchId, status) => {
    calls.push([name, batchId]);
    if (terminalStatus) {
      return {
        ok: false,
        code: 'ARCHIVE_TASK_STATUS_CONFLICT',
        batch: { taskStatus: terminalStatus }
      };
    }
    terminalStatus = status;
    return { ok: true, batch: { taskStatus: status } };
  };
  const archiveService = {
    async reserveTaskBatch(payload) {
      calls.push(['reserve', payload]);
      if (reserveResult) return reserveResult;
      return {
        ok: true,
        created: true,
        batchId: 41,
        batch: {
          id: 41,
          batchNumber: '2026-08-11-001',
          taskRunId: payload.taskRunId,
          taskKey: payload.taskKey,
          moduleId: payload.moduleId,
          parentRunId: payload.parentRunId,
          operationKey: payload.operationKey,
          taskStatus: 'reserved'
        }
      };
    },
    async beginTaskRecovery() { throw new Error('unexpected recovery'); },
    async markTaskStarted(batchId) { calls.push(['started', batchId]); return { ok: true }; },
    async completeTaskBatch(batchId) {
      if (completeError) throw completeError;
      return terminalResult('completed', batchId, 'succeeded');
    },
    async failTaskBatch(batchId) { return terminalResult('failed', batchId, 'failed'); },
    async cancelTaskBatch(batchId) { return terminalResult('cancelled', batchId, 'cancelled'); },
    async recordFailure(batchId) { calls.push(['archive-failure', batchId]); return { ok: true }; }
  };
  const flowResolver = {
    async resolve(payload) {
      calls.push(['flow', payload]);
      return { parentRunId: 'vcc-parent-1', source: 'new', identity: null };
    },
    async bind(payload) { calls.push(['bind', payload]); return payload.identities; },
    async persistBindIntent() { throw new Error('unexpected bind intent'); }
  };
  const lifecycle = createTaskLifecycle({
    businessOperationRegistry: {
      begin(meta) { calls.push(['bor-begin', meta.channel]); token += 1; return { accepted: true, token }; },
      end(value) { calls.push(['bor-end', value]); }
    },
    archiveService,
    flowResolver,
    operationTracker: {
      async appendOperationFiles(payload) {
        calls.push(['artifacts', payload.batchContext.batchId]);
        return appendResult || { ok: true, handled: false };
      }
    },
    createTaskRunId: () => 'vcc-task-1',
    persistTerminalIntent
  });
  return { calls, lifecycle, terminalStatus: () => terminalStatus };
}

test('VCC calculate reserve 失败时零 worker，成功时 exact7 贯穿并绑定 run identity', async (t) => {
  const registry = createTaskPolicyRegistry();
  const policy = registry.require('vccFinancialOp:run:calculate');
  const rejected = createLifecycleHarness({
    reserveResult: { ok: false, code: 'reserve-failed', message: 'fixture reserve failed' }
  });
  let rejectedExecuteCount = 0;
  const rejectedResult = await rejected.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ targetMonth: '2026-08' }],
    execute: async () => {
      rejectedExecuteCount += 1;
      return { status: 'calculated', runId: 99 };
    }
  });
  assert.equal(rejectedResult.status, 'failed');
  assert.equal(rejectedExecuteCount, 0);
  assert.equal(rejected.calls.some(([name]) => name === 'started'), false);

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    workerFactory(_filename, options) {
      const worker = new FakeWorker(options, {
        status: 'calculated',
        runId: 73,
        targetMonth: '2026-08'
      });
      workers.push(worker);
      setImmediate(() => worker.emit('message', { type: 'result', result: worker.result }));
      return worker;
    }
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const accepted = createLifecycleHarness();
  const result = await accepted.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ targetMonth: '2026-08' }],
    resultFlowIdentities: (value) => policy.resultFlowIdentities(value),
    execute: (batchContext) => service.calculate({
      targetMonth: '2026-08',
      expectedInputFingerprint: 'a'.repeat(64)
    }, batchContext)
  });
  assert.equal(result.runId, 73);
  assert.equal(workers.length, 1);
  const workerContext = workers[0].options.workerData.payload.batchContext;
  assert.deepEqual(Object.keys(workerContext), WORKER_BATCH_CONTEXT_FIELDS);
  assert.equal(Object.isFrozen(workerContext), true);
  assert.deepEqual(workerContext, {
    batchId: 41,
    batchNumber: '2026-08-11-001',
    taskRunId: 'vcc-task-1',
    taskKey: 'vccFinancialOp:run:calculate',
    moduleId: 'vcc-financial-op',
    parentRunId: 'vcc-parent-1',
    operationKey: 'vccFinancialOp:run:calculate:vcc-task-1'
  });
  const bind = accepted.calls.find(([name]) => name === 'bind');
  assert.deepEqual(bind[1].identities, [{
    type: 'vcc-financial-op-run',
    value: '73'
  }]);
  assert.deepEqual(
    accepted.calls.filter(([name]) => ['bor-begin', 'flow', 'reserve', 'started', 'artifacts', 'bind', 'completed', 'bor-end'].includes(name)).map(([name]) => name),
    ['bor-begin', 'flow', 'reserve', 'started', 'artifacts', 'bind', 'completed', 'bor-end']
  );
});

test('VCC pre-critical cancel 终结原batch，protected等待业务终态，worker crash归为failed', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeWorkerFactory(_filename, options) {
      const worker = new FakeWorker(options, null);
      workers.push(worker);
      return worker;
    },
    cancelTimeoutMs: 50
  });
  t.after(async () => {
    await service.terminate();
    db.close();
  });
  const policy = createTaskPolicyRegistry().require('vccFinancialOp:run:archive');

  const cancellable = createLifecycleHarness();
  const cancelledRun = cancellable.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ runId: 7 }],
    execute: (batchContext) => service.archive({
      runId: 7,
      expectedResultRevision: 0,
      expectedPreviewToken: `v2:${'a'.repeat(64)}`,
      taskGeneration: 0
    }, undefined, batchContext)
  });
  await new Promise((resolve) => setImmediate(resolve));
  const firstWorker = workers[0];
  const cancelled = service.cancelActiveTask(() => cancellable.lifecycle.cancelActive(
    (context) => context.moduleId === 'vcc-financial-op',
    'fixture cancel'
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellable.terminalStatus(), 'cancelled');
  assert.deepEqual(firstWorker.sentMessages, [{ type: 'cancel' }]);
  firstWorker.emit('message', {
    type: 'error',
    error: { name: 'Error', code: 'operation-cancelled', message: 'cancelled' }
  });
  await assert.rejects(cancelledRun, (error) => error.code === 'operation-cancelled');
  assert.deepEqual(await cancelled, { status: 'cancelled', forced: false });
  assert.equal(cancellable.terminalStatus(), 'cancelled');

  const protectedHarness = createLifecycleHarness();
  const protectedRun = protectedHarness.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ runId: 8 }],
    execute: (batchContext) => service.archive({
      runId: 8,
      expectedResultRevision: 0,
      expectedPreviewToken: `v2:${'b'.repeat(64)}`,
      taskGeneration: 1
    }, undefined, batchContext)
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondWorker = workers[1];
  secondWorker.emit('message', { type: 'critical-ready' });
  assert.deepEqual(secondWorker.sentMessages, [{ type: 'critical-ack' }]);
  let protectedCancelHookCount = 0;
  const protectedCancel = service.cancelActiveTask(() => {
    protectedCancelHookCount += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(protectedCancelHookCount, 0);
  assert.equal(protectedHarness.terminalStatus(), '');
  secondWorker.emit('message', {
    type: 'result',
    result: { status: 'archived', runId: 8, targetMonth: '2026-08' }
  });
  assert.equal((await protectedRun).status, 'archived');
  assert.deepEqual(await protectedCancel, { status: 'completed', protected: true });
  assert.equal(protectedHarness.terminalStatus(), 'succeeded');
  assert.deepEqual(await protectedHarness.lifecycle.cancelActive(
    (context) => context.moduleId === 'vcc-financial-op',
    'late cancel'
  ), { status: 'not-found', cancelled: false });
  assert.equal(protectedHarness.terminalStatus(), 'succeeded');

  const crashHarness = createLifecycleHarness();
  const crashedRun = crashHarness.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ runId: 9 }],
    execute: (batchContext) => service.archive({
      runId: 9,
      expectedResultRevision: 0,
      expectedPreviewToken: `v2:${'c'.repeat(64)}`,
      taskGeneration: 2
    }, undefined, batchContext)
  });
  await new Promise((resolve) => setImmediate(resolve));
  workers[2].emit('error', new Error('fixture worker crash'));
  await assert.rejects(crashedRun, /fixture worker crash/);
  assert.equal(crashHarness.terminalStatus(), 'failed');
});

test('VCC artifact/terminal 持久失败只登记原batch outbox intent且不重复reserve', async () => {
  const intents = [];
  const terminalError = new Error('fixture terminal unavailable');
  terminalError.code = 'SQLITE_BUSY';
  const harness = createLifecycleHarness({
    appendResult: {
      ok: false,
      archiveFailed: true,
      persistentRetryAvailable: true,
      failureRecorded: true
    },
    completeError: terminalError,
    persistTerminalIntent: async (payload) => {
      intents.push(payload);
      return { persisted: true };
    }
  });
  const policy = createTaskPolicyRegistry().require('vccFinancialOp:run:archive');
  const result = await harness.lifecycle.run({
    meta: { channel: policy.channel },
    policy,
    args: [{ runId: 15 }],
    execute: async () => ({ status: 'archived', runId: 15, targetMonth: '2026-08' })
  });
  assert.equal(result.status, 'archived');
  assert.equal(harness.calls.filter(([name]) => name === 'reserve').length, 1);
  assert.equal(harness.calls.filter(([name]) => name === 'artifacts').length, 1);
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].batchContext, {
    batchId: 41,
    batchNumber: '2026-08-11-001',
    taskRunId: 'vcc-task-1',
    taskKey: 'vccFinancialOp:run:archive',
    moduleId: 'vcc-financial-op',
    parentRunId: 'vcc-parent-1',
    operationKey: 'vccFinancialOp:run:archive:vcc-task-1'
  });
  assert.deepEqual(intents[0].terminalOutcome, {
    taskStatus: 'succeeded',
    code: '',
    message: '',
    metadata: {
      resultStatus: 'archived',
      runId: 15,
      targetMonth: '2026-08'
    }
  });
});
