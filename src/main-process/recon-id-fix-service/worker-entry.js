'use strict';

const crypto = require('node:crypto');
const { parentPort } = require('node:worker_threads');

const {
  createCanonicalEventEmitter
} = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const {
  createServiceControlEnvelope
} = require('../background-execution/protocol');
const {
  validateEnvelope,
  validateJobEnvelope,
  validateServiceControlEnvelope
} = require('../background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../background-execution/sequence-tracker');
const {
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_SERVICE_KEY
} = require('./policies');
const { createReconFixService } = require('./service');

if (!parentPort) throw new Error('ReconFix Service 需要 worker_threads parentPort');

const ALLOWED_ACTIONS = new Set([RECON_FIX_IMPORT_ACTION, RECON_FIX_RUN_READONLY_ACTION]);
const RECON_FIX_CANCELLED = 'RECON_FIX_CANCELLED';
const incomingControlSequence = createDirectionSequenceTracker();
const incomingJobSequence = createDirectionSequenceTracker();
const pendingRequests = new Map();
let serviceIdentity = null;
let service = null;
let controlEventSeq = 0;
let activeJob = null;
// Service 一次只有一个 job；仅保留同 Worker generation 最近一个
// 已发 terminal 的 jobId，下一个 terminal 直接替换，不建立历史集合。
let lastTerminalJobId = null;
let closeRequested = false;

function nextId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cancellationError() {
  const error = new Error('ReconFix Service 已在安全点取消');
  error.code = RECON_FIX_CANCELLED;
  error.stage = 'cancel';
  return error;
}

async function cancellationSafepoint(job) {
  // parse/engine 都是同步 legacy 逻辑；先让出一个 event-loop turn，
  // 使 parse 期间到达的 job:cancel 能被观测，再决定是否进入 adoption。
  await new Promise((resolve) => setImmediate(resolve));
  if (job.cancelRequested) throw cancellationError();
}

function jobRef(job) {
  return Object.freeze({
    actionKey: job.envelope.actionKey,
    operationKey: job.envelope.operationKey,
    jobId: job.envelope.jobId,
    unitId: null
  });
}

function emitJobTerminal(job, operation, payload) {
  const event = job.emit(operation, payload);
  if (event) lastTerminalJobId = job.envelope.jobId;
  return event;
}

function emitControl(operation, controlId, reference, payload) {
  if (!serviceIdentity) throw new Error('ReconFix Service 尚未初始化 identity');
  controlEventSeq += 1;
  const event = createServiceControlEnvelope({
    direction: 'event',
    operation,
    serviceKey: serviceIdentity.serviceKey,
    controlId,
    workerInstanceId: serviceIdentity.workerInstanceId,
    serviceGeneration: serviceIdentity.serviceGeneration,
    seq: controlEventSeq,
    jobRef: reference,
    payload
  });
  parentPort.postMessage(event);
  return event;
}

function assertServiceIdentity(envelope) {
  if (!serviceIdentity || envelope.serviceKey !== serviceIdentity.serviceKey ||
      envelope.workerInstanceId !== serviceIdentity.workerInstanceId ||
      envelope.serviceGeneration !== serviceIdentity.serviceGeneration) {
    const error = new Error('ReconFix Service 收到 stale generation control');
    error.code = 'RECON_FIX_SERVICE_GENERATION_STALE';
    throw error;
  }
}

function assertJobIdentity(envelope) {
  if (!serviceIdentity || envelope.workerInstanceId !== serviceIdentity.workerInstanceId ||
      envelope.serviceGeneration !== serviceIdentity.serviceGeneration ||
      !ALLOWED_ACTIONS.has(envelope.actionKey)) {
    const error = new Error('ReconFix Service 收到非法或 stale job route');
    error.code = 'RECON_FIX_JOB_ROUTE_INVALID';
    throw error;
  }
}

function requestPersistentAdoption(job, candidate) {
  const requestId = nextId('recon-state');
  const controlId = nextId('recon-control');
  const owner = Object.freeze({
    kind: 'service-state',
    ownerKeyHash: crypto.createHash('sha256').update(RECON_FIX_SERVICE_KEY).digest('hex'),
    candidateRevision: candidate.revision
  });
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      requestId,
      job,
      candidate,
      owner,
      stage: 'requesting',
      publicResult: null,
      grantId: null,
      reservationId: null,
      resolve,
      reject
    });
    try {
      emitControl('resource:request', controlId, jobRef(job), {
        requestId,
        requestKind: 'persistent-state-replace',
        requested: {
          memoryBytes: candidate.memoryBytes,
          cpuSlots: 0,
          ioHeavySlots: 0
        },
        replacesReservationId: service.reservationId,
        owner
      });
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error);
    }
  });
}

async function adoptCandidateAtSafepoint(job, candidate) {
  await cancellationSafepoint(job);
  try {
    const result = await requestPersistentAdoption(job, candidate);
    // resource request 一旦发出就不伪造平台 cancel 方言；等待
    // grant/reject/adopt-ack 真实收口后，再在下一安全点终止 job。
    await cancellationSafepoint(job);
    return result;
  } catch (error) {
    if (job.cancelRequested) throw cancellationError();
    throw error;
  }
}

function handleResourceGrant(envelope) {
  const payload = envelope.payload;
  const pending = pendingRequests.get(payload.requestId);
  if (!pending || pending.stage !== 'requesting' || pending.job !== activeJob ||
      payload.replacesReservationId !== service.reservationId) {
    const error = new Error('ReconFix PersistentReservation grant 无对应候选');
    error.code = 'RECON_FIX_RESOURCE_GRANT_INVALID';
    throw error;
  }
  pending.publicResult = service.adopt(pending.candidate, payload.reservationId);
  pending.grantId = payload.grantId;
  pending.reservationId = payload.reservationId;
  pending.stage = 'adopting';
  emitControl('resource:adopted', nextId('recon-control'), jobRef(pending.job), {
    requestId: pending.requestId,
    grantId: pending.grantId,
    reservationId: pending.reservationId,
    owner: pending.owner
  });
}

function handleResourceAdoptAck(envelope) {
  const payload = envelope.payload;
  const pending = pendingRequests.get(payload.requestId);
  if (!pending || pending.stage !== 'adopting' ||
      pending.grantId !== payload.grantId || pending.reservationId !== payload.reservationId) {
    const error = new Error('ReconFix PersistentReservation adopt-ack 无对应候选');
    error.code = 'RECON_FIX_RESOURCE_ADOPT_ACK_INVALID';
    throw error;
  }
  pendingRequests.delete(payload.requestId);
  pending.stage = 'adopted';
  pending.resolve(pending.publicResult);
}

function handleResourceReject(envelope) {
  const pending = pendingRequests.get(envelope.payload.requestId);
  if (!pending || pending.stage !== 'requesting') {
    const error = new Error('ReconFix PersistentReservation reject 无对应请求');
    error.code = 'RECON_FIX_RESOURCE_REJECT_INVALID';
    throw error;
  }
  pendingRequests.delete(pending.requestId);
  const error = new Error('ReconFix 状态未获资源准入，旧状态保持不变');
  error.code = envelope.payload.reasonCode || 'RECON_FIX_RESOURCE_REJECTED';
  pending.reject(error);
}

function handleResourceRevoke(envelope) {
  const reservationId = envelope.payload.reservationId;
  if (!service || service.reservationId !== reservationId) {
    const error = new Error('ReconFix Service 收到非当前 reservation revoke');
    error.code = 'RECON_FIX_RESOURCE_REVOKE_STALE';
    throw error;
  }
  closeRequested = true;
  service.close();
  emitControl('resource:release', envelope.controlId, envelope.jobRef, {
    reservationId,
    reason: 'service-close'
  });
}

async function runJob(job) {
  try {
    const plan = service.begin(job.envelope.actionKey, job.envelope.payload.input);
    let result;
    if (plan.kind === 'candidate') {
      result = await adoptCandidateAtSafepoint(job, plan.candidate);
    } else {
      if (plan.invalidationCandidate) {
        await adoptCandidateAtSafepoint(job, plan.invalidationCandidate);
      }
      // invalidation 已 adopt 后、result 计算/采用前的阶段边界。
      await cancellationSafepoint(job);
      const resultCandidate = plan.execute();
      result = await adoptCandidateAtSafepoint(job, resultCandidate);
    }
    emitJobTerminal(job, 'job:done', { result });
  } catch (error) {
    if (error && error.code === RECON_FIX_CANCELLED) {
      if (!job.cancelAckEmitted) {
        job.cancelAckEmitted = true;
        job.emit('cancel:ack', { cancellation: { scope: 'job' } });
      }
    }
    emitJobTerminal(job, 'job:error', {
      error: toProtocolError(error, error && error.code || 'RECON_FIX_SERVICE_FAILED')
    });
  } finally {
    if (service && !closeRequested) service.finish();
    if (activeJob === job) activeJob = null;
  }
}

function handleJob(rawEnvelope) {
  if (!service || closeRequested) {
    const error = new Error('ReconFix Service 尚未 ready 或正在关闭');
    error.code = 'RECON_FIX_SERVICE_NOT_READY';
    throw error;
  }
  const envelope = validateJobEnvelope(rawEnvelope, {
    actionKey: rawEnvelope.actionKey,
    operationKey: rawEnvelope.operationKey,
    jobId: rawEnvelope.jobId,
    workerInstanceId: serviceIdentity.workerInstanceId,
    serviceGeneration: serviceIdentity.serviceGeneration,
    direction: 'command'
  });
  assertJobIdentity(envelope);
  incomingJobSequence.observe(envelope);
  if (envelope.operation === 'job:cancel') {
    if (!activeJob && lastTerminalJobId === envelope.jobId) {
      // Worker terminal 已投递、Main 尚未 settle 时的 shutdown cancel：
      // 同 jobId 幂等忽略，不再发 ACK/terminal，也不放宽未知 job。
      return;
    }
    if (!activeJob || activeJob.envelope.jobId !== envelope.jobId || activeJob.cancelRequested) {
      const error = new Error('ReconFix Service 收到无对应 active job 或重复的 cancel');
      error.code = 'RECON_FIX_CANCEL_INVALID';
      throw error;
    }
    activeJob.cancelRequested = true;
    return;
  }
  if (envelope.operation !== 'job:start') {
    const error = new Error(`ReconFix E11-A 不支持 job operation：${envelope.operation}`);
    error.code = 'RECON_FIX_JOB_OPERATION_UNSUPPORTED';
    throw error;
  }
  if (activeJob) {
    const busyEmit = createCanonicalEventEmitter(envelope, (event) => parentPort.postMessage(event));
    const error = new Error('ReconFix Service 同时只允许一个 command');
    error.code = 'RECON_FIX_SERVICE_BUSY';
    busyEmit('job:error', { error: toProtocolError(error, error.code) });
    return;
  }
  const job = {
    envelope,
    emit: createCanonicalEventEmitter(envelope, (event) => parentPort.postMessage(event)),
    cancelRequested: false,
    cancelAckEmitted: false
  };
  activeJob = job;
  void runJob(job);
}

function handleControl(rawEnvelope) {
  const envelope = serviceIdentity
    ? validateServiceControlEnvelope(rawEnvelope, {
        serviceKey: serviceIdentity.serviceKey,
        workerInstanceId: serviceIdentity.workerInstanceId,
        serviceGeneration: serviceIdentity.serviceGeneration,
        direction: 'command'
      })
    : rawEnvelope;
  if (envelope.direction !== 'command') {
    const error = new Error('ReconFix Service control direction 必须是 command');
    error.code = 'RECON_FIX_CONTROL_DIRECTION_INVALID';
    throw error;
  }
  incomingControlSequence.observe(envelope);
  if (envelope.operation === 'executor:init') {
    if (serviceIdentity || envelope.serviceKey !== RECON_FIX_SERVICE_KEY || envelope.jobRef !== null) {
      const error = new Error('ReconFix Service executor:init identity 无效或重复');
      error.code = 'RECON_FIX_SERVICE_INIT_INVALID';
      throw error;
    }
    serviceIdentity = Object.freeze({
      serviceKey: envelope.serviceKey,
      workerInstanceId: envelope.workerInstanceId,
      serviceGeneration: envelope.serviceGeneration
    });
    service = createReconFixService({ serviceGeneration: envelope.serviceGeneration });
    emitControl('executor:ready', nextId('recon-control'), null, {
      contractVersion: 1,
      capabilities: ['resource-control-v1', 'recon-fix-readonly-v1']
    });
    return;
  }
  assertServiceIdentity(envelope);
  if (envelope.operation === 'resource:grant') return handleResourceGrant(envelope);
  if (envelope.operation === 'resource:adopt-ack') return handleResourceAdoptAck(envelope);
  if (envelope.operation === 'resource:reject') return handleResourceReject(envelope);
  if (envelope.operation === 'resource:revoke') return handleResourceRevoke(envelope);
  if (envelope.operation === 'resource:release-ack') return;
  if (envelope.operation === 'executor:close') {
    if (activeJob || pendingRequests.size > 0) {
      const error = new Error('ReconFix Service busy 时不得 close');
      error.code = 'RECON_FIX_SERVICE_CLOSE_BUSY';
      throw error;
    }
    closeRequested = true;
    if (service) service.close();
    emitControl('executor:close-ack', envelope.controlId, null, {});
    return;
  }
  const error = new Error(`ReconFix Service 不支持 control operation：${envelope.operation}`);
  error.code = 'RECON_FIX_CONTROL_OPERATION_UNSUPPORTED';
  throw error;
}

parentPort.on('message', (rawMessage) => {
  try {
    const envelope = validateEnvelope(rawMessage);
    if (envelope.channel === 'service-control') handleControl(envelope);
    else handleJob(envelope);
  } catch (error) {
    if (activeJob) {
      emitJobTerminal(activeJob, 'job:error', {
        error: toProtocolError(error, error && error.code || 'RECON_FIX_SERVICE_PROTOCOL_ERROR')
      });
      if (service && !closeRequested) service.finish();
      activeJob = null;
      return;
    }
    throw error;
  }
});
