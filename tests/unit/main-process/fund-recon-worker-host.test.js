'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createJobEnvelope,
  createServiceControlEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const {
  FUND_RECON_ACTIONS,
  FUND_RECON_SERVICE_KEY
} = require('../../../src/main-process/fund-recon-worker/policies');
const {
  startFundReconWorker
} = require('../../../src/main-process/fund-recon-worker/worker-host');

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  postMessage(message) {
    this.sent.push(message);
    this.emit('posted', message);
  }

  command(message) {
    this.emit('message', message);
  }
}

function context(operationKey) {
  return {
    kind: 'operation',
    value: {
      taskRunId: 'task-run:fund-recon-test',
      taskKey: FUND_RECON_ACTIONS.IMPORT,
      moduleId: 'fund-recon',
      parentRunId: 'parent-run:fund-recon-test',
      operationKey
    }
  };
}

test('Worker等待grant+adopt-ack后才job:done，并在close前完成release ACK', async () => {
  const port = new FakePort();
  const state = { published: false };
  let transportClosed = 0;
  const service = {
    status: () => ({ active: false, stateRevision: state.published ? 1 : 0, stableSummary: {} }),
    async execute(_actionKey, _input, jobContext) {
      await jobContext.adoptCandidate({ value: 1 }, {
        candidateRevision: 1,
        memoryBytes: 4096,
        operation: 'import'
      });
      state.published = true;
      return {
        status: 'ok', operation: 'import', stateRevision: 1,
        summary: {
          bankRowCount: 1, hasGateway: false, hasProcessingResult: false,
          hasRefund: false, sourceFileCount: 1
        }
      };
    }
  };
  startFundReconWorker(port, {
    service,
    close() { transportClosed += 1; }
  });
  let mainSeq = 0;
  const control = (operation, controlId, jobRef, payload) => createServiceControlEnvelope({
    direction: 'command',
    operation,
    serviceKey: FUND_RECON_SERVICE_KEY,
    controlId,
    workerInstanceId: 'worker-1',
    serviceGeneration: 1,
    seq: ++mainSeq,
    jobRef,
    payload
  });

  port.command(control('executor:init', 'init-1', null, {
    contractVersion: 1,
    policyDigest: 'a'.repeat(64),
    baseLeaseId: 'base-1'
  }));
  assert.equal(port.sent.at(-1).operation, 'executor:ready');
  assert.notEqual(port.sent.at(-1).controlId, 'init-1');

  const operationKey = 'operation:fund-recon-test';
  const job = createJobEnvelope({
    direction: 'command',
    operation: 'job:start',
    actionKey: FUND_RECON_ACTIONS.IMPORT,
    operationKey,
    jobId: 'job-1',
    workerInstanceId: 'worker-1',
    serviceGeneration: 1,
    unitId: null,
    seq: 1,
    context: context(operationKey),
    payload: { input: { sources: [{ kind: 'bank', filePath: '/tmp/bank.xlsx' }] } }
  });
  port.command(job);
  await nextTick();
  const request = port.sent.find((message) => message.operation === 'resource:request');
  assert.ok(request);
  assert.equal(state.published, false);
  assert.equal(port.sent.some((message) => message.operation === 'job:done'), false);

  port.command(control('resource:grant', request.controlId, request.jobRef, {
    requestId: request.payload.requestId,
    grantId: 'grant-1',
    reservationId: 'reservation-1',
    replacesReservationId: null,
    granted: request.payload.requested,
    adoptionDeadlineMs: 30000
  }));
  await nextTick();
  const adopted = port.sent.find((message) => message.operation === 'resource:adopted');
  assert.ok(adopted);
  assert.notEqual(adopted.controlId, request.controlId);
  assert.equal(state.published, false);

  port.command(control('resource:adopt-ack', adopted.controlId, adopted.jobRef, {
    requestId: request.payload.requestId,
    grantId: 'grant-1',
    reservationId: 'reservation-1'
  }));
  await nextTick();
  assert.equal(state.published, true);
  assert.equal(port.sent.some((message) => message.operation === 'job:done'), true);

  port.command(control('resource:revoke', 'revoke-1', request.jobRef, {
    grantId: 'grant-1', reservationId: 'reservation-1', reasonCode: 'service-close'
  }));
  await nextTick();
  const release = port.sent.find((message) => message.operation === 'resource:release');
  assert.ok(release);
  port.command(control('resource:release-ack', 'revoke-1', request.jobRef, {
    reservationId: 'reservation-1'
  }));
  await nextTick();
  port.command(control('executor:close', 'close-1', null, {}));
  assert.equal(port.sent.at(-1).operation, 'executor:close-ack');
  assert.equal(transportClosed, 0, '必须先投递close-ack再关闭MessagePort');
  await nextTick();
  assert.equal(transportClosed, 1);
});
