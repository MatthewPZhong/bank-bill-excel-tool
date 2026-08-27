'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createJobEnvelope } = require('../../../src/main-process/background-execution/protocol');
const { startBankBuWorker } = require('../../../src/main-process/bank-bu-worker/worker-host');
const {
  BANK_BU_SINGLETON_UNIT_ID
} = require('../../../src/main-process/bank-bu-worker/singleton-unit');

class FakePort extends EventEmitter {
  constructor() { super(); this.sent = []; }
  postMessage(message) { this.sent.push(message); }
  command(message) { this.emit('message', message); }
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function envelope(
  operation,
  seq,
  payload,
  operationKey = 'bank-bu/run/protocol',
  unitId = null,
  actionKey = 'bank-bu:run'
) {
  return createJobEnvelope({
    direction: 'command', operation, actionKey, operationKey,
    jobId: 'bank-bu-job-1', workerInstanceId: 'bank-bu-worker-1',
    serviceGeneration: null, unitId, seq,
    context: { kind: 'operation', value: {
      taskRunId: 'task-bank-bu-run-protocol', taskKey: 'bankBuRecon:run',
      moduleId: 'bank-bu-recon', parentRunId: 'parent-bank-bu-run', operationKey
    } },
    payload
  });
}

test('one-shot Worker在critical ACK前不提交，ACK后按receipt→done收口且protected拒绝取消', async () => {
  const port = new FakePort();
  let mutationStarted = false;
  startBankBuWorker(port, { executors: {
    'bank-bu:run': async (_input, context) => {
      await context.awaitCritical({
        operationKind: 'run', yearMonth: '2026-08', inputEvidenceHash: '1'.repeat(64),
        expectedNewOperationKey: 'bank-bu/run/protocol', stats: {}
      });
      mutationStarted = true;
      return {
        status: 'ok', operation: 'run', yearMonth: '2026-08', sideRunId: 7,
        inputEvidenceHash: '1'.repeat(64), stats: {}, replay: false,
        sideDbRelPath: 'run-data/bank-bu-recon/month-2026-08.sqlite',
        receipt: {
          actionKey: 'bank-bu:run', operationKey: 'bank-bu/run/protocol',
          producerTaskRunId: 'task-bank-bu-run-protocol', operationKind: 'run',
          yearMonth: '2026-08', sideRunId: 7, inputEvidenceHash: '1'.repeat(64),
          committedAt: '2026-08-28T00:00:00.000Z'
        }
      };
    }
  } });
  port.command(envelope('job:start', 1, { input: {} }));
  await tick();
  assert.deepEqual(port.sent, [], 'mutation job:start只初始化，必须等待registered unit:start');
  port.command(envelope(
    'unit:start', 2, { input: {} }, 'bank-bu/run/protocol', BANK_BU_SINGLETON_UNIT_ID
  ));
  await tick();
  assert.equal(port.sent.at(-1).operation, 'critical:ready');
  assert.equal(port.sent.at(-1).unitId, BANK_BU_SINGLETON_UNIT_ID);
  assert.equal(mutationStarted, false);
  assert.equal(port.sent.some((event) => event.operation === 'job:done'), false);

  port.command(envelope('critical:ack', 3, {
    critical: {
      intentId: 'intent-bank-bu-run-protocol', fileOperationKey: 'bank-bu/run/protocol'
    }
  }, 'bank-bu/run/protocol', BANK_BU_SINGLETON_UNIT_ID));
  // protected后cancel只能等待settle，不能伪造cancel ACK/取消终态。
  port.command(envelope('job:cancel', 4, { cancel: { reason: 'shutdown' } }));
  await tick();
  assert.equal(mutationStarted, true);
  const operations = port.sent.map((event) => event.operation);
  assert.ok(operations.indexOf('commit:receipt') > operations.indexOf('critical:ready'));
  assert.ok(operations.indexOf('unit:done') > operations.indexOf('commit:receipt'));
  assert.ok(operations.indexOf('job:done') > operations.indexOf('unit:done'));
  assert.equal(operations.includes('cancel:ack'), false);
});

test('import mutation同样只在singleton unit执行且按unit receipt/done收口', async () => {
  const actionKey = 'bank-bu:import-month';
  const operationKey = 'bank-bu/import/protocol';
  const port = new FakePort();
  startBankBuWorker(port, { executors: {
    [actionKey]: async (_input, context) => {
      await context.awaitCritical({
        operationKind: 'import', yearMonth: '2026-08', inputEvidenceHash: '2'.repeat(64),
        pendingCount: 1, bankCount: 1
      });
      return {
        status: 'ok', operation: 'import-month', yearMonth: '2026-08',
        pendingCount: 1, bankCount: 1, inputEvidenceHash: '2'.repeat(64), replay: false,
        receipt: {
          actionKey, operationKey,
          producerTaskRunId: 'task-bank-bu-run-protocol', operationKind: 'import',
          yearMonth: '2026-08', sideRunId: null, inputEvidenceHash: '2'.repeat(64),
          committedAt: '2026-08-28T00:00:00.000Z'
        }
      };
    }
  } });
  port.command(envelope('job:start', 1, { input: {} }, operationKey, null, actionKey));
  await tick();
  assert.deepEqual(port.sent, []);
  port.command(envelope(
    'unit:start', 2, { input: {} }, operationKey, BANK_BU_SINGLETON_UNIT_ID, actionKey
  ));
  await tick();
  assert.equal(port.sent.at(-1).operation, 'critical:ready');
  port.command(envelope('critical:ack', 3, {
    critical: { intentId: 'intent-bank-bu-import', fileOperationKey: operationKey }
  }, operationKey, BANK_BU_SINGLETON_UNIT_ID, actionKey));
  await tick();
  assert.deepEqual(port.sent.map((event) => event.operation), [
    'critical:ready', 'commit:receipt', 'unit:done', 'job:done'
  ]);
  assert.ok(port.sent.slice(0, 3).every(
    (event) => event.unitId === BANK_BU_SINGLETON_UNIT_ID
  ));
});

test('one-shot Worker拒绝跨operation ACK，critical reject在mutation前失败收口', async () => {
  let mutationCount = 0;
  function executor() {
    return async (_input, context) => {
      await context.awaitCritical({
        operationKind: 'run', yearMonth: '2026-08', inputEvidenceHash: '1'.repeat(64),
        expectedNewOperationKey: 'bank-bu/run/protocol', stats: {}
      });
      mutationCount += 1;
      return { status: 'ok' };
    };
  }

  const mismatchedPort = new FakePort();
  startBankBuWorker(mismatchedPort, { executors: { 'bank-bu:run': executor() } });
  mismatchedPort.command(envelope('job:start', 1, { input: {} }));
  await tick();
  mismatchedPort.command(envelope(
    'unit:start', 2, { input: {} }, 'bank-bu/run/protocol', BANK_BU_SINGLETON_UNIT_ID
  ));
  await tick();
  mismatchedPort.command(envelope('critical:ack', 3, {
    critical: { intentId: 'intent-wrong-operation', fileOperationKey: 'bank-bu/run/other' }
  }, 'bank-bu/run/other', BANK_BU_SINGLETON_UNIT_ID));
  await tick();
  assert.equal(mismatchedPort.sent.at(-1).operation, 'job:error');
  assert.equal(mutationCount, 0);

  const rejectedPort = new FakePort();
  startBankBuWorker(rejectedPort, { executors: { 'bank-bu:run': executor() } });
  rejectedPort.command(envelope('job:start', 1, { input: {} }));
  await tick();
  rejectedPort.command(envelope(
    'unit:start', 2, { input: {} }, 'bank-bu/run/protocol', BANK_BU_SINGLETON_UNIT_ID
  ));
  await tick();
  rejectedPort.command(envelope('critical:reject', 3, {
    critical: { reason: 'intent-persist-failed' }
  }, 'bank-bu/run/protocol', BANK_BU_SINGLETON_UNIT_ID));
  await tick();
  assert.equal(rejectedPort.sent.at(-1).operation, 'job:error');
  assert.equal(mutationCount, 0);
});
