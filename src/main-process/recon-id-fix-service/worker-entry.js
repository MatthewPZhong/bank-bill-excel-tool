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
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_SERVICE_KEY
} = require('./policies');
const { createReconFixService } = require('./service');

if (!parentPort) throw new Error('ReconFix Service 需要 worker_threads parentPort');

const ALLOWED_ACTIONS = new Set([
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_RUN_READONLY_ACTION,
  RECON_FIX_RUN_JPM_ACTION
]);
const RECON_FIX_CANCELLED = 'RECON_FIX_CANCELLED';
const incomingControlSequence = createDirectionSequenceTracker();
const incomingJobSequence = createDirectionSequenceTracker();
const pendingRequests = new Map();
const phaseReservations = new Map();
const pendingReleases = new Map();
const mainRevokeReleases = new Map();
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

function jobRef(job, unitId = null) {
  return Object.freeze({
    actionKey: job.envelope.actionKey,
    operationKey: job.envelope.operationKey,
    jobId: job.envelope.jobId,
    unitId
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

function requestPersistentAdoption(job, candidate, options = {}) {
  const requestId = nextId('recon-state');
  const controlId = nextId('recon-control');
  const owner = Object.freeze({
    kind: 'service-state',
    ownerKeyHash: crypto.createHash('sha256').update(RECON_FIX_SERVICE_KEY).digest('hex'),
    candidateRevision: candidate.revision
  });
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      kind: 'persistent',
      requestId,
      job,
      candidate,
      adopt: typeof options.adopt === 'function'
        ? options.adopt
        : (reservationId) => service.adopt(candidate, reservationId),
      unitId: options.unitId || null,
      owner,
      stage: 'requesting',
      publicResult: null,
      grantId: null,
      reservationId: null,
      resolve,
      reject
    });
    try {
      emitControl('resource:request', controlId, jobRef(job, options.unitId || null), {
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

function requestPhaseExtension(job, resourcePlan) {
  if (!resourcePlan || resourcePlan.requestKind !== 'phase-extension' ||
      !Number.isSafeInteger(resourcePlan.memoryBytes) || resourcePlan.memoryBytes < 1) {
    const error = new Error('ReconFix phase-extension 资源计划无效');
    error.code = 'RECON_FIX_PHASE_PLAN_INVALID';
    throw error;
  }
  const requestId = nextId('recon-phase');
  const controlId = nextId('recon-control');
  const owner = Object.freeze({
    kind: 'phase',
    ownerKeyHash: crypto.createHash('sha256')
      .update(`${RECON_FIX_SERVICE_KEY}:${serviceIdentity.serviceGeneration}:${job.envelope.jobId}:phase`)
      .digest('hex'),
    candidateRevision: 1
  });
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      kind: 'phase',
      requestId,
      job,
      owner,
      stage: 'requesting',
      grantId: null,
      reservationId: null,
      resolve,
      reject
    });
    try {
      emitControl('resource:request', controlId, jobRef(job), {
        requestId,
        requestKind: 'phase-extension',
        requested: {
          memoryBytes: resourcePlan.memoryBytes,
          cpuSlots: 0,
          ioHeavySlots: 0
        },
        replacesReservationId: null,
        owner
      });
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error);
    }
  });
}

function releasePhaseReservation(job, phase, reason) {
  if (!phase || phase.released) return Promise.resolve(false);
  if (phase.job !== job || phaseReservations.get(phase.reservationId) !== phase) {
    const error = new Error('ReconFix phase reservation 不属于当前 job');
    error.code = 'RECON_FIX_PHASE_RELEASE_INVALID';
    return Promise.reject(error);
  }
  const controlId = nextId('recon-control');
  return new Promise((resolve, reject) => {
    pendingReleases.set(controlId, {
      controlId,
      job,
      phase,
      reservationId: phase.reservationId,
      resolve,
      reject
    });
    try {
      emitControl('resource:release', controlId, jobRef(job), {
        reservationId: phase.reservationId,
        reason
      });
    } catch (error) {
      pendingReleases.delete(controlId);
      reject(error);
    }
  });
}

async function adoptCandidateAtSafepoint(job, candidate, options = {}) {
  if (options.protectedPhase !== true) await cancellationSafepoint(job);
  try {
    const result = await requestPersistentAdoption(job, candidate, options);
    // resource request 一旦发出就不伪造平台 cancel 方言；等待
    // grant/reject/adopt-ack 真实收口后，再在下一安全点终止 job。
    if (options.protectedPhase !== true) await cancellationSafepoint(job);
    return result;
  } catch (error) {
    if (job.cancelRequested && options.protectedPhase !== true) throw cancellationError();
    throw error;
  }
}

function handleResourceGrant(envelope) {
  const payload = envelope.payload;
  const pending = pendingRequests.get(payload.requestId);
  const replacementMatches = pending && pending.kind === 'persistent'
    ? payload.replacesReservationId === service.reservationId
    : payload.replacesReservationId === null;
  if (!pending || pending.stage !== 'requesting' || pending.job !== activeJob || !replacementMatches) {
    const error = new Error('ReconFix resource grant 无对应请求');
    error.code = 'RECON_FIX_RESOURCE_GRANT_INVALID';
    throw error;
  }
  if (pending.kind === 'persistent') {
    pending.publicResult = pending.adopt(payload.reservationId);
  }
  pending.grantId = payload.grantId;
  pending.reservationId = payload.reservationId;
  pending.stage = 'adopting';
  emitControl('resource:adopted', nextId('recon-control'), jobRef(pending.job, pending.unitId), {
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
  if (pending.kind === 'phase') {
    const phase = {
      job: pending.job,
      owner: pending.owner,
      grantId: pending.grantId,
      reservationId: pending.reservationId,
      released: false
    };
    phaseReservations.set(phase.reservationId, phase);
    pending.resolve(phase);
    return;
  }
  pending.resolve(pending.publicResult);
}

function handleResourceReject(envelope) {
  const pending = pendingRequests.get(envelope.payload.requestId);
  if (!pending || pending.stage !== 'requesting') {
    const error = new Error('ReconFix resource reject 无对应请求');
    error.code = 'RECON_FIX_RESOURCE_REJECT_INVALID';
    throw error;
  }
  pendingRequests.delete(pending.requestId);
  const error = new Error(pending.kind === 'phase'
    ? 'ReconFix 临时内存未获资源准入，未开始解析或整表加载'
    : 'ReconFix 状态未获资源准入，旧状态保持不变');
  error.code = envelope.payload.reasonCode || 'RECON_FIX_RESOURCE_REJECTED';
  pending.reject(error);
}

function handleResourceRevoke(envelope) {
  const reservationId = envelope.payload.reservationId;
  const phase = phaseReservations.get(reservationId) || null;
  if (phase) {
    phase.released = true;
    phaseReservations.delete(reservationId);
    mainRevokeReleases.set(envelope.controlId, reservationId);
    emitControl('resource:release', envelope.controlId, envelope.jobRef, {
      reservationId,
      reason: 'job-failed'
    });
    return;
  }
  if (!service || service.reservationId !== reservationId) {
    const error = new Error('ReconFix Service 收到非当前 reservation revoke');
    error.code = 'RECON_FIX_RESOURCE_REVOKE_STALE';
    throw error;
  }
  closeRequested = true;
  service.close();
  mainRevokeReleases.set(envelope.controlId, reservationId);
  emitControl('resource:release', envelope.controlId, envelope.jobRef, {
    reservationId,
    reason: 'service-close'
  });
}

function handleResourceReleaseAck(envelope) {
  const pending = pendingReleases.get(envelope.controlId);
  if (!pending || pending.reservationId !== envelope.payload.reservationId) {
    // Main 发起 revoke 的 release-ack 沿用原 controlId，不属于 Worker 主动 release promise。
    if (mainRevokeReleases.get(envelope.controlId) === envelope.payload.reservationId) {
      mainRevokeReleases.delete(envelope.controlId);
      return;
    }
    const error = new Error('ReconFix resource release-ack 无对应 release');
    error.code = 'RECON_FIX_RESOURCE_RELEASE_ACK_INVALID';
    throw error;
  }
  pendingReleases.delete(envelope.controlId);
  pending.phase.released = true;
  phaseReservations.delete(pending.reservationId);
  pending.resolve(true);
}

async function runJob(job) {
  let phase = null;
  let terminal = null;
  try {
    const preparation = await service.prepare(
      job.envelope.actionKey,
      job.envelope.payload.input,
      { operationKey: job.envelope.operationKey }
    );
    await cancellationSafepoint(job);
    try {
      phase = await requestPhaseExtension(job, preparation.resourcePlan);
    } catch (error) {
      if (job.cancelRequested) throw cancellationError();
      throw error;
    }
    await cancellationSafepoint(job);
    const plan = preparation.begin();
    // XLSX parse / BOC .all() 都在 begin 内同步完成；在任何 state adoption 前
    // 让 shutdown cancel 真实获胜，同时 phase reservation 仍保持占用。
    await cancellationSafepoint(job);
    let result;
    if (plan.kind === 'jpm-run-plan') {
      if (plan.invalidation) {
        await adoptCandidateAtSafepoint(job, {
          revision: plan.invalidation.candidateRevision,
          memoryBytes: plan.invalidation.candidateMemoryBytes
        }, {
          unitId: RECON_FIX_JPM_UNIT_ID,
          adopt: (reservationId) => service.adoptJpmInvalidation(plan, reservationId)
        });
      }
      if (plan.outcome === 'noop') {
        result = await adoptCandidateAtSafepoint(job, {
          revision: plan.candidateRevision,
          memoryBytes: plan.candidateMemoryBytes
        }, {
          unitId: RECON_FIX_JPM_UNIT_ID,
          adopt: (reservationId) => service.adoptJpmPending(plan, reservationId, null)
        });
      } else {
        await cancellationSafepoint(job);
        const ack = new Promise((resolve, reject) => {
          job.resolveCriticalAck = resolve;
          job.rejectCriticalAck = reject;
        });
        job.emit('critical:ready', { critical: plan.critical }, RECON_FIX_JPM_UNIT_ID);
        await ack;
        job.resolveCriticalAck = null;
        job.rejectCriticalAck = null;
        if (job.cancelRequested) throw cancellationError();
        job.protected = true;
        const receipt = service.commitJpmPending(plan, {
          producerTaskRunId: job.envelope.context.value.taskRunId
        });
        job.emit('commit:receipt', { receipt }, RECON_FIX_JPM_UNIT_ID);
        result = await adoptCandidateAtSafepoint(job, {
          revision: plan.candidateRevision,
          memoryBytes: plan.candidateMemoryBytes
        }, {
          protectedPhase: true,
          unitId: RECON_FIX_JPM_UNIT_ID,
          adopt: (reservationId) => service.adoptJpmPending(plan, reservationId, receipt)
        });
      }
      job.unitTerminal = true;
      job.emit('unit:done', { result }, RECON_FIX_JPM_UNIT_ID);
    } else if (plan.kind === 'candidate') {
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
    terminal = { operation: 'job:done', payload: { result } };
  } catch (error) {
    if (error && error.code === RECON_FIX_CANCELLED) {
      if (!job.cancelAckEmitted) {
        job.cancelAckEmitted = true;
        job.emit('cancel:ack', { cancellation: { scope: 'job' } });
      }
    }
    if (job.envelope.actionKey === RECON_FIX_RUN_JPM_ACTION && !job.unitTerminal) {
      job.unitTerminal = true;
      job.emit('unit:error', {
        error: toProtocolError(error, error && error.code || 'RECON_FIX_JPM_FAILED')
      }, RECON_FIX_JPM_UNIT_ID);
    }
    terminal = {
      operation: 'job:error',
      payload: { error: toProtocolError(error, error && error.code || 'RECON_FIX_SERVICE_FAILED') }
    };
  } finally {
    if (phase && !phase.released) {
      try {
        await releasePhaseReservation(job, phase, terminal && terminal.operation === 'job:done'
          ? 'phase-complete'
          : 'job-failed');
      } catch (error) {
        terminal = {
          operation: 'job:error',
          payload: {
            error: toProtocolError(error, error && error.code || 'RECON_FIX_PHASE_RELEASE_FAILED')
          }
        };
      }
    }
    if (terminal && terminal.operation === 'job:done' && job.cancelRequested) {
      const error = cancellationError();
      if (!job.cancelAckEmitted) {
        job.cancelAckEmitted = true;
        job.emit('cancel:ack', { cancellation: { scope: 'job' } });
      }
      terminal = {
        operation: 'job:error',
        payload: { error: toProtocolError(error, error.code) }
      };
    }
    if (service && !closeRequested) service.finish();
    if (terminal) emitJobTerminal(job, terminal.operation, terminal.payload);
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
    if (!activeJob.protected) activeJob.cancelRequested = true;
    return;
  }
  if (envelope.operation === 'unit:start') {
    if (!activeJob || activeJob.envelope.jobId !== envelope.jobId ||
        envelope.actionKey !== RECON_FIX_RUN_JPM_ACTION ||
        envelope.unitId !== RECON_FIX_JPM_UNIT_ID ||
        Object.keys(envelope.payload.input || {}).length !== 0 || activeJob.unitStarted) {
      const error = new Error('ReconFix JPM unit:start identity 无效或重复');
      error.code = 'RECON_FIX_JPM_UNIT_START_INVALID';
      throw error;
    }
    activeJob.unitStarted = true;
    return;
  }
  if (envelope.operation === 'critical:ack') {
    const critical = envelope.payload.critical;
    if (!activeJob || activeJob.envelope.jobId !== envelope.jobId ||
        envelope.actionKey !== RECON_FIX_RUN_JPM_ACTION ||
        envelope.unitId !== RECON_FIX_JPM_UNIT_ID || !activeJob.resolveCriticalAck ||
        !critical || critical.fileOperationKey !== envelope.operationKey ||
        typeof critical.intentId !== 'string' || !critical.intentId) {
      const error = new Error('ReconFix JPM critical ACK identity 无效');
      error.code = 'RECON_FIX_JPM_CRITICAL_ACK_INVALID';
      throw error;
    }
    const resolve = activeJob.resolveCriticalAck;
    activeJob.resolveCriticalAck = null;
    resolve(critical);
    return;
  }
  if (envelope.operation === 'critical:reject') {
    if (!activeJob || !activeJob.rejectCriticalAck || envelope.unitId !== RECON_FIX_JPM_UNIT_ID) {
      const error = new Error('ReconFix JPM critical reject identity 无效');
      error.code = 'RECON_FIX_JPM_CRITICAL_REJECT_INVALID';
      throw error;
    }
    const reject = activeJob.rejectCriticalAck;
    activeJob.rejectCriticalAck = null;
    const error = new Error('ReconFix JPM critical intent 未获 Main 持久准入');
    error.code = 'RECON_FIX_JPM_CRITICAL_REJECTED';
    reject(error);
    return;
  }
  if (envelope.operation !== 'job:start') {
    const error = new Error(`ReconFix Service 不支持 job operation：${envelope.operation}`);
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
    cancelAckEmitted: false,
    protected: false,
    unitStarted: false,
    unitTerminal: false,
    resolveCriticalAck: null,
    rejectCriticalAck: null
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
      capabilities: ['resource-control-v1', 'recon-fix-readonly-v1', 'recon-fix-jpm-durable-v1']
    });
    return;
  }
  assertServiceIdentity(envelope);
  if (envelope.operation === 'resource:grant') return handleResourceGrant(envelope);
  if (envelope.operation === 'resource:adopt-ack') return handleResourceAdoptAck(envelope);
  if (envelope.operation === 'resource:reject') return handleResourceReject(envelope);
  if (envelope.operation === 'resource:revoke') return handleResourceRevoke(envelope);
  if (envelope.operation === 'resource:release-ack') return handleResourceReleaseAck(envelope);
  if (envelope.operation === 'executor:close') {
    if (activeJob || pendingRequests.size > 0 || pendingReleases.size > 0 ||
        phaseReservations.size > 0) {
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
