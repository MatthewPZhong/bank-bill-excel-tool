'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('../../../../src/main-process/background-execution/protocol');
const {
  DUPLICATE_SERVICE_KEY
} = require('../../../../src/main-process/duplicate-inbound-match/policies');
const {
  startDuplicateWorker
} = require('../../../../src/main-process/duplicate-inbound-match/worker-host');

class FakePort extends EventEmitter {
  constructor() { super(); this.sent = []; }
  postMessage(message) { this.sent.push(message); }
  command(message) { this.emit('message', message); }
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function context(operationKey) {
  return { kind: 'operation', value: {
    taskRunId: `task-${operationKey}`,
    taskKey: 'duplicate-inbound-match:import-files',
    moduleId: 'duplicate',
    parentRunId: 'parent-duplicate',
    operationKey
  } };
}

function job(operationKey, jobId, seq) {
  return createJobEnvelope({
    direction: 'command', operation: 'job:start', actionKey: 'duplicate:import',
    operationKey, jobId, workerInstanceId: 'duplicate-worker-1', serviceGeneration: 7,
    unitId: null, seq, context: context(operationKey), payload: { input: {} }
  });
}

function cancel(operationKey, jobId, seq) {
  return createJobEnvelope({
    direction: 'command', operation: 'job:cancel', actionKey: 'duplicate:import',
    operationKey, jobId, workerInstanceId: 'duplicate-worker-1', serviceGeneration: 7,
    unitId: null, seq, context: context(operationKey), payload: {
      cancel: { reasonCode: 'shutdown', safeSummary: 'app shutdown' }
    }
  });
}

test('Worker busy不排队、不终止active job，并在adopt ACK后才完成', async () => {
  const port = new FakePort();
  let finish;
  let closed = 0;
  let transportClosed = 0;
  const service = {
    status: () => ({ active: true, stateRevision: 0, stableSummary: {} }),
    close() { closed += 1; },
    async execute(_action, _input, jobContext) {
      await new Promise((resolve) => { finish = resolve; });
      await jobContext.adoptCandidate({}, {
        candidateRevision: 1, memoryBytes: 4096, operation: 'import'
      });
      return {
        status: 'ok', operation: 'import', stateRevision: 1,
        summary: { bankRowCount: 1, documentRowCount: 1, canRun: true, canExport: false }
      };
    }
  };
  startDuplicateWorker(port, {
    service,
    close() { transportClosed += 1; }
  });
  let mainSeq = 0;
  const control = (operation, controlId, jobRef, payload) => createServiceControlEnvelope({
    direction: 'command', operation, serviceKey: DUPLICATE_SERVICE_KEY, controlId,
    workerInstanceId: 'duplicate-worker-1', serviceGeneration: 7,
    seq: ++mainSeq, jobRef, payload
  });
  port.command(control('executor:init', 'init-1', null, {
    contractVersion: 1, policyDigest: 'a'.repeat(64), baseLeaseId: 'base-1'
  }));
  port.command(job('operation-1', 'job-1', 1));
  await tick();
  port.command(job('operation-2', 'job-2', 1));
  assert.equal(port.sent.some((event) => event.jobId === 'job-2' &&
    event.operation === 'job:error' && event.payload.error.code === 'SERVICE_BUSY'), true);
  assert.equal(port.sent.some((event) => event.jobId === 'job-1' && event.operation === 'job:error'), false);
  finish();
  await tick();
  const request = port.sent.find((event) => event.operation === 'resource:request');
  assert.ok(request);
  port.command(control('resource:grant', request.controlId, request.jobRef, {
    requestId: request.payload.requestId, grantId: 'grant-1', reservationId: 'reservation-1',
    replacesReservationId: null, granted: request.payload.requested, adoptionDeadlineMs: 30000
  }));
  await tick();
  const adopted = port.sent.find((event) => event.operation === 'resource:adopted');
  assert.ok(adopted);
  assert.equal(port.sent.some((event) => event.jobId === 'job-1' && event.operation === 'job:done'), false);
  port.command(control('resource:adopt-ack', adopted.controlId, adopted.jobRef, {
    requestId: request.payload.requestId, grantId: 'grant-1', reservationId: 'reservation-1'
  }));
  await tick();
  assert.equal(port.sent.some((event) => event.jobId === 'job-1' && event.operation === 'job:done'), true);
  port.command(control('resource:revoke', 'revoke-1', request.jobRef, {
    grantId: 'grant-1', reservationId: 'reservation-1', reasonCode: 'service-close'
  }));
  await tick();
  port.command(control('resource:release-ack', 'revoke-1', request.jobRef, {
    reservationId: 'reservation-1'
  }));
  await tick();
  port.command(control('executor:close', 'close-1', null, {}));
  assert.equal(closed, 1);
  assert.equal(port.sent.at(-1).operation, 'executor:close-ack');
  assert.equal(transportClosed, 0, '必须先投递close-ack再关闭MessagePort');
  await tick();
  assert.equal(transportClosed, 1);
});

test('terminal先于shutdown cancel到达时精确迟到cancel幂等且不追加ACK', async () => {
  const port = new FakePort();
  const service = {
    status: () => ({ active: false, stateRevision: 0, stableSummary: {} }),
    close() {},
    async execute() {
      const error = new Error('Parser已按shutdown收口');
      error.code = 'DUPLICATE_PARSER_CANCELLED';
      throw error;
    }
  };
  startDuplicateWorker(port, { service });
  port.command(createServiceControlEnvelope({
    direction: 'command', operation: 'executor:init', serviceKey: DUPLICATE_SERVICE_KEY,
    controlId: 'init-terminal-race', workerInstanceId: 'duplicate-worker-1',
    serviceGeneration: 7, seq: 1, jobRef: null,
    payload: { contractVersion: 1, policyDigest: 'a'.repeat(64), baseLeaseId: 'base-1' }
  }));
  port.command(job('operation-terminal-race', 'job-terminal-race', 1));
  await tick();

  assert.equal(port.sent.some((event) => event.jobId === 'job-terminal-race' &&
    event.operation === 'job:error'), true);
  const sentBeforeLateCancel = port.sent.length;
  assert.doesNotThrow(() => {
    port.command(cancel('operation-terminal-race', 'job-terminal-race', 2));
  });
  assert.equal(port.sent.length, sentBeforeLateCancel, 'terminal后不得追加cancel:ack或第二个terminal');

  assert.throws(
    () => port.command(cancel('operation-unowned', 'job-unowned', 1)),
    /Duplicate不支持job command：job:cancel/,
    '迟到cancel豁免必须精确绑定已收口route'
  );
});
