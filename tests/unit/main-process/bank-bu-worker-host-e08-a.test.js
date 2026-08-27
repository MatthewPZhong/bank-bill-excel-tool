'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createJobEnvelope } = require('../../../src/main-process/background-execution/protocol');
const { startBankBuWorker } = require('../../../src/main-process/bank-bu-worker/worker-host');

class FakePort extends EventEmitter {
  constructor() { super(); this.sent = []; }
  postMessage(message) { this.sent.push(message); }
  command(message) { this.emit('message', message); }
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function envelope(operation, seq, payload, operationKey = 'bank-bu/run/protocol') {
  return createJobEnvelope({
    direction: 'command', operation, actionKey: 'bank-bu:run', operationKey,
    jobId: 'bank-bu-job-1', workerInstanceId: 'bank-bu-worker-1',
    serviceGeneration: null, unitId: null, seq,
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
  assert.equal(port.sent.at(-1).operation, 'critical:ready');
  assert.equal(mutationStarted, false);
  assert.equal(port.sent.some((event) => event.operation === 'job:done'), false);

  port.command(envelope('critical:ack', 2, {
    critical: { intentId: 'intent-bank-bu-run-protocol', yearMonth: '2026-08' }
  }));
  // protected后cancel只能等待settle，不能伪造cancel ACK/取消终态。
  port.command(envelope('job:cancel', 3, { cancel: { reason: 'shutdown' } }));
  await tick();
  assert.equal(mutationStarted, true);
  const operations = port.sent.map((event) => event.operation);
  assert.ok(operations.indexOf('commit:receipt') > operations.indexOf('critical:ready'));
  assert.ok(operations.indexOf('job:done') > operations.indexOf('commit:receipt'));
  assert.equal(operations.includes('cancel:ack'), false);
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
  mismatchedPort.command(envelope('critical:ack', 2, {
    critical: { intentId: 'intent-wrong-operation', yearMonth: '2026-08' }
  }, 'bank-bu/run/other'));
  await tick();
  assert.equal(mismatchedPort.sent.at(-1).operation, 'job:error');
  assert.equal(mutationCount, 0);

  const rejectedPort = new FakePort();
  startBankBuWorker(rejectedPort, { executors: { 'bank-bu:run': executor() } });
  rejectedPort.command(envelope('job:start', 1, { input: {} }));
  await tick();
  rejectedPort.command(envelope('critical:reject', 2, {
    critical: { reason: 'intent-persist-failed' }
  }));
  await tick();
  assert.equal(rejectedPort.sent.at(-1).operation, 'job:error');
  assert.equal(mutationCount, 0);
});
