'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  VCC_MUTATION_OPERATIONS
} = require('../../../src/backend/vcc-financial-op/mutation-policy');
const {
  createVccFinancialOpService
} = require('../../../src/main-process/vcc-financial-op-service');

class FakeWriteWorker extends EventEmitter {
  constructor(filename, options) {
    super();
    this.filename = filename;
    this.options = options;
    this.sentMessages = [];
    this.terminateCount = 0;
    this.onPostMessage = null;
  }

  postMessage(message) {
    this.sentMessages.push(message);
    if (this.onPostMessage) this.onPostMessage(message);
  }

  async terminate() {
    this.terminateCount += 1;
    this.emit('exit', 1);
    return 1;
  }
}

function createHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const workers = [];
  const diagnostics = [];
  const service = createVccFinancialOpService({
    database: { db, dbPath: ':memory:' },
    assetsDir: '',
    writeWorkerFactory(filename, options) {
      const worker = new FakeWriteWorker(filename, options);
      workers.push(worker);
      return worker;
    },
    operationDiagnosticLogger: (diagnostic) => diagnostics.push(diagnostic),
    cancelTimeoutMs: 5
  });
  return { db, workers, diagnostics, service };
}

function archivePayload(overrides = {}) {
  return {
    runId: 7,
    expectedResultRevision: 3,
    expectedPreviewToken: `v2:${'a'.repeat(64)}`,
    taskGeneration: 0,
    ...overrides
  };
}

test('结果写 claim 绑定 action/generation/进程内 identity，protected 标记先于 ACK', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.service.terminate();
    harness.db.close();
  });
  const progress = [];
  const operation = harness.service._runResultWriteWorkerForTests(
    VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT,
    archivePayload(),
    (entry) => progress.push(entry)
  );
  const worker = harness.workers[0];
  assert.equal(path.basename(worker.filename), 'vcc-financial-op-write-worker.js');
  assert.deepEqual(worker.options.workerData.payload, {
    runId: 7,
    expectedResultRevision: 3,
    expectedPreviewToken: `v2:${'a'.repeat(64)}`,
    batchContext: null,
    taskGeneration: 0,
    appVersion: null,
    buildSha: null
  });

  const claim = harness.service._claimForTests();
  assert.equal(claim.action, VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT);
  assert.equal(claim.generation, 0);
  assert.equal(Object.isFrozen(claim), true);
  assert.equal(Object.isFrozen(claim.identity), true);
  worker.onPostMessage = (message) => {
    if (message.type === 'critical-ack') {
      assert.equal(harness.service._taskStateForTests().protected, true);
      assert.equal(harness.service._claimForTests(), claim, 'critical section 沿用同一 claim identity');
    }
  };
  worker.emit('message', { type: 'progress', progress: { phase: 'validating' } });
  worker.emit('message', { type: 'diagnostic', diagnostic: { code: 'fixture-diagnostic' } });
  worker.emit('message', { type: 'critical-ready' });
  assert.deepEqual(worker.sentMessages, [{ type: 'critical-ack' }]);
  assert.deepEqual(progress, [{ phase: 'validating' }]);
  assert.deepEqual(harness.diagnostics, [{ code: 'fixture-diagnostic' }]);

  let cancelSettled = false;
  const cancellation = harness.service.cancelActiveTask().then((value) => {
    cancelSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelSettled, false, 'protected worker 取消必须等待终态');
  assert.equal(worker.terminateCount, 0);
  worker.emit('message', { type: 'result', result: { status: 'archived', runId: 7 } });
  worker.emit('message', { type: 'result', result: { status: 'duplicate-terminal' } });

  assert.deepEqual(await operation, { status: 'archived', runId: 7 });
  assert.deepEqual(await cancellation, { status: 'completed', protected: true });
  assert.equal(worker.terminateCount, 0);
  assert.equal(harness.service._claimForTests(), null);
  assert.equal(harness.service._taskStateForTests().taskGeneration, 1, 'claim 只释放一次');
});

test('结果写 stale generation 与非法 action 均在创建 worker 前 fail-closed', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.service.terminate();
    harness.db.close();
  });
  assert.throws(
    () => harness.service._runResultWriteWorkerForTests(
      VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
      archivePayload({ taskGeneration: 1 })
    ),
    (error) => error.code === 'state-changed'
  );
  assert.throws(
    () => harness.service._runResultWriteWorkerForTests('not-registered', archivePayload()),
    (error) => error.code === 'invalid-vcc-write-action'
  );
  assert.equal(harness.workers.length, 0);
  assert.equal(harness.service._claimForTests(), null);
  assert.equal(harness.service._taskStateForTests().taskGeneration, 0);
});
