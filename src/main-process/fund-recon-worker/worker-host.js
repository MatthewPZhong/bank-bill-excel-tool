'use strict';

const crypto = require('node:crypto');

const {
  createCanonicalEventEmitter
} = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const { createServiceControlEnvelope } = require('../background-execution/protocol');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../background-execution/sequence-tracker');
const {
  FUND_RECON_ACTIONS,
  FUND_RECON_SERVICE_KEY,
  FUND_RECON_STATE_OWNER_KEY
} = require('./policies');
const { createFundReconService } = require('./service');

const OWNED_ACTIONS = new Set(Object.values(FUND_RECON_ACTIONS));
const OWNER_KEY_HASH = crypto.createHash('sha256')
  .update(FUND_RECON_STATE_OWNER_KEY, 'utf8')
  .digest('hex');

function jobRef(envelope) {
  return Object.freeze({
    actionKey: envelope.actionKey,
    operationKey: envelope.operationKey,
    jobId: envelope.jobId,
    unitId: envelope.unitId
  });
}

function startFundReconWorker(port, options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new TypeError('FundRecon Worker需要MessagePort');
  }
  const service = options.service || createFundReconService(options.serviceOptions);
  const incomingSequence = createDirectionSequenceTracker();
  const outgoingSequence = createDirectionSequenceTracker();
  const pendingControl = new Map();
  let identity = null;
  let ready = false;
  let closing = false;
  let activeJob = null;
  let currentReservation = null;

  function controlIdentity() {
    if (!identity) throw new Error('FundRecon Worker尚未初始化');
    return {
      channel: 'service-control',
      serviceKey: identity.serviceKey,
      workerInstanceId: identity.workerInstanceId,
      serviceGeneration: identity.serviceGeneration,
      direction: 'event'
    };
  }

  function emitControl(operation, controlId, ownedJobRef, payload) {
    const event = createServiceControlEnvelope({
      direction: 'event',
      operation,
      serviceKey: identity.serviceKey,
      controlId,
      workerInstanceId: identity.workerInstanceId,
      serviceGeneration: identity.serviceGeneration,
      seq: outgoingSequence.next(controlIdentity()),
      jobRef: ownedJobRef,
      payload
    });
    port.postMessage(event);
    return event;
  }

  function waitForControl(controlId, operations) {
    if (pendingControl.has(controlId)) {
      throw new Error(`FundRecon controlId重复等待：${controlId}`);
    }
    return new Promise((resolve, reject) => {
      pendingControl.set(controlId, { operations: new Set(operations), resolve, reject });
    });
  }

  function deliverControl(envelope) {
    const pending = pendingControl.get(envelope.controlId);
    if (!pending) return false;
    if (!pending.operations.has(envelope.operation)) {
      const error = new Error(`FundRecon control response非法：${envelope.operation}`);
      error.code = 'FUND_RECON_CONTROL_RESPONSE_INVALID';
      pendingControl.delete(envelope.controlId);
      pending.reject(error);
      return true;
    }
    pendingControl.delete(envelope.controlId);
    pending.resolve(envelope);
    return true;
  }

  async function adoptCandidate(_candidate, adoption) {
    if (!activeJob || closing) {
      const error = new Error('FundRecon adoption失去active job');
      error.code = 'FUND_RECON_ADOPTION_JOB_STALE';
      throw error;
    }
    const requestId = `request-${crypto.randomUUID()}`;
    const requestControlId = `request-control-${crypto.randomUUID()}`;
    const owner = Object.freeze({
      kind: 'service-state',
      ownerKeyHash: OWNER_KEY_HASH,
      candidateRevision: adoption.candidateRevision
    });
    const ref = activeJob.ref;
    const responsePromise = waitForControl(requestControlId, ['resource:grant', 'resource:reject']);
    emitControl('resource:request', requestControlId, ref, {
      requestId,
      requestKind: 'persistent-state-replace',
      requested: {
        memoryBytes: adoption.memoryBytes,
        cpuSlots: 0,
        ioHeavySlots: 0
      },
      replacesReservationId: currentReservation ? currentReservation.reservationId : null,
      owner
    });
    const response = await responsePromise;
    if (response.operation === 'resource:reject') {
      const error = new Error(response.payload.safeSummary || 'FundRecon state reservation被拒绝');
      error.code = response.payload.reasonCode || 'FUND_RECON_RESERVATION_REJECTED';
      throw error;
    }
    if (response.payload.requestId !== requestId ||
        response.payload.replacesReservationId !== (currentReservation ? currentReservation.reservationId : null)) {
      const error = new Error('FundRecon resource grant identity不一致');
      error.code = 'FUND_RECON_GRANT_IDENTITY_MISMATCH';
      throw error;
    }
    const adoptionControlId = `adoption-control-${crypto.randomUUID()}`;
    const ackPromise = waitForControl(adoptionControlId, ['resource:adopt-ack']);
    emitControl('resource:adopted', adoptionControlId, ref, {
      requestId,
      grantId: response.payload.grantId,
      reservationId: response.payload.reservationId,
      owner
    });
    const ack = await ackPromise;
    if (ack.payload.requestId !== requestId || ack.payload.grantId !== response.payload.grantId ||
        ack.payload.reservationId !== response.payload.reservationId) {
      const error = new Error('FundRecon resource adopt ACK identity不一致');
      error.code = 'FUND_RECON_ADOPT_ACK_IDENTITY_MISMATCH';
      throw error;
    }
    currentReservation = Object.freeze({
      grantId: response.payload.grantId,
      reservationId: response.payload.reservationId,
      jobRef: ref
    });
  }

  function startJob(envelope) {
    if (!ready || closing || activeJob) {
      const error = new Error(activeJob ? 'FundRecon Service busy' : 'FundRecon Service未就绪');
      error.code = activeJob ? 'SERVICE_BUSY' : 'FUND_RECON_SERVICE_NOT_READY';
      throw error;
    }
    if (!OWNED_ACTIONS.has(envelope.actionKey) ||
        envelope.workerInstanceId !== identity.workerInstanceId ||
        envelope.serviceGeneration !== identity.serviceGeneration) {
      throw new Error('FundRecon job route identity非法');
    }
    const emitJob = createCanonicalEventEmitter(envelope, (event) => port.postMessage(event));
    const abortController = new AbortController();
    const record = {
      envelope,
      ref: jobRef(envelope),
      emit: emitJob,
      abortController,
      terminal: false
    };
    activeJob = record;
    Promise.resolve().then(() => service.execute(
      envelope.actionKey,
      envelope.payload.input,
      {
        signal: abortController.signal,
        adoptCandidate,
        onProgress(progress) {
          if (abortController.signal.aborted) {
            const error = new Error('FundRecon Service正在关闭');
            error.code = 'FUND_RECON_SHUTDOWN';
            throw error;
          }
          emitJob('job:progress', { progress });
        }
      }
    )).then((result) => {
      if (record.terminal) return;
      record.terminal = true;
      emitJob('job:done', { result });
    }, (error) => {
      if (record.terminal) return;
      record.terminal = true;
      emitJob('job:error', { error: toProtocolError(error, 'FUND_RECON_JOB_FAILED') });
    }).finally(() => {
      if (activeJob === record) activeJob = null;
    });
  }

  async function releaseForRevoke(envelope) {
    if (!currentReservation ||
        envelope.payload.reservationId !== currentReservation.reservationId ||
        envelope.payload.grantId !== currentReservation.grantId) {
      throw new Error('FundRecon resource revoke identity非法');
    }
    const ackPromise = waitForControl(envelope.controlId, ['resource:release-ack']);
    emitControl('resource:release', envelope.controlId, envelope.jobRef, {
      reservationId: currentReservation.reservationId,
      reason: envelope.payload.reasonCode === 'service-crash' ? 'service-crash' : 'service-close'
    });
    await ackPromise;
    currentReservation = null;
  }

  function handleControl(envelope) {
    if (envelope.operation === 'executor:init') {
      if (identity) throw new Error('FundRecon Worker重复executor:init');
      if (envelope.serviceKey !== FUND_RECON_SERVICE_KEY) throw new Error('FundRecon serviceKey非法');
      identity = Object.freeze({
        serviceKey: envelope.serviceKey,
        workerInstanceId: envelope.workerInstanceId,
        serviceGeneration: envelope.serviceGeneration
      });
      ready = true;
      emitControl('executor:ready', `ready-${crypto.randomUUID()}`, null, {
        contractVersion: 1,
        capabilities: ['resource-control-v1']
      });
      return;
    }
    if (!identity || envelope.serviceKey !== identity.serviceKey ||
        envelope.workerInstanceId !== identity.workerInstanceId ||
        envelope.serviceGeneration !== identity.serviceGeneration) {
      throw new Error('FundRecon service control identity非法');
    }
    if (deliverControl(envelope)) return;
    if (envelope.operation === 'resource:revoke') {
      void releaseForRevoke(envelope).catch((error) => {
        emitControl('executor:error', `error-${crypto.randomUUID()}`, null, {
          error: toProtocolError(error, 'FUND_RECON_RELEASE_FAILED')
        });
      });
      return;
    }
    if (envelope.operation === 'executor:close') {
      if (activeJob || currentReservation || pendingControl.size > 0) {
        throw new Error('FundRecon Service仍有active job/resource，不能close');
      }
      closing = true;
      ready = false;
      emitControl('executor:close-ack', envelope.controlId, null, {});
      return;
    }
    throw new Error(`FundRecon不支持service control：${envelope.operation}`);
  }

  function handleMessage(rawMessage) {
    let envelope;
    try {
      envelope = validateEnvelope(rawMessage);
      if (envelope.direction !== 'command') throw new Error('FundRecon只接受command');
      incomingSequence.observe(envelope);
      if (envelope.channel === 'service-control') {
        handleControl(envelope);
        return;
      }
      if (envelope.channel !== 'job') throw new Error('FundRecon channel非法');
      if (envelope.operation === 'job:start') {
        startJob(envelope);
        return;
      }
      if (envelope.operation === 'job:cancel' && activeJob && activeJob.envelope.jobId === envelope.jobId) {
        activeJob.abortController.abort(envelope.payload.cancel);
        activeJob.emit('cancel:ack', { cancellation: { scope: 'job' } });
        return;
      }
      throw new Error(`FundRecon不支持job command：${envelope.operation}`);
    } catch (error) {
      if (activeJob && !activeJob.terminal) {
        activeJob.terminal = true;
        activeJob.emit('job:error', { error: toProtocolError(error, 'FUND_RECON_PROTOCOL_ERROR') });
        activeJob = null;
        return;
      }
      throw error;
    }
  }

  port.on('message', handleMessage);
  return Object.freeze({
    service,
    snapshot() {
      return Object.freeze({
        activeJobId: activeJob ? activeJob.envelope.jobId : null,
        closing,
        ready,
        reservationId: currentReservation ? currentReservation.reservationId : null,
        status: service.status()
      });
    }
  });
}

module.exports = {
  OWNER_KEY_HASH,
  jobRef,
  startFundReconWorker
};
