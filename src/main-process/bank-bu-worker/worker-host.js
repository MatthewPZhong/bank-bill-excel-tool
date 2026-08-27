'use strict';

const { createCanonicalEventEmitter } = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const { createDirectionSequenceTracker } = require('../background-execution/sequence-tracker');
const { executeImportMonth } = require('./import-operation');
const { executeRun } = require('./run-operation');
const { executeExportSingle, executeExportAggregate } = require('./export-operation');
const { BANK_BU_ACTIONS } = require('./policies');
const { BANK_BU_SINGLETON_UNIT_ID } = require('./singleton-unit');

const EXECUTORS = Object.freeze({
  [BANK_BU_ACTIONS.IMPORT_MONTH]: executeImportMonth,
  [BANK_BU_ACTIONS.RUN]: executeRun,
  [BANK_BU_ACTIONS.EXPORT_SINGLE]: executeExportSingle,
  [BANK_BU_ACTIONS.EXPORT_AGGREGATE]: executeExportAggregate
});
const MUTATION_ACTIONS = new Set([BANK_BU_ACTIONS.IMPORT_MONTH, BANK_BU_ACTIONS.RUN]);

function startBankBuWorker(port, options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new TypeError('BankBU Worker需要MessagePort');
  }
  const incoming = createDirectionSequenceTracker();
  let startEnvelope = null;
  let emit = null;
  let abortController = null;
  let critical = null;
  let terminal = false;
  let protectedPhase = false;
  let activeUnitId = null;
  let unitTerminal = false;

  function assertStartIdentity(envelope) {
    if (!startEnvelope) return;
    const fields = ['jobId', 'workerInstanceId', 'actionKey', 'operationKey'];
    if (fields.some((field) => envelope[field] !== startEnvelope[field]) ||
        envelope.context.kind !== startEnvelope.context.kind ||
        envelope.context.value.taskRunId !== startEnvelope.context.value.taskRunId) {
      throw new Error('BankBU command与job:start identity不一致');
    }
  }

  function fail(error) {
    if (!emit || terminal) throw error;
    const safeError = toProtocolError(error, 'BANK_BU_JOB_FAILED');
    if (activeUnitId && !unitTerminal) {
      unitTerminal = true;
      emit('unit:error', { error: safeError }, activeUnitId);
    }
    terminal = true;
    emit('job:error', { error: safeError });
  }

  function awaitCritical(body, unitId) {
    if (critical) throw new Error('BankBU重复进入critical');
    if (abortController && abortController.signal.aborted) {
      const error = new Error('BankBU在critical前已取消');
      error.code = 'BANK_BU_CANCELLED';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      critical = { body, resolve, reject, unitId };
      emit('critical:ready', { critical: body }, unitId);
    });
  }

  async function executeEnvelope(envelope, unitId = null) {
    const execute = options.executors && options.executors[envelope.actionKey] || EXECUTORS[envelope.actionKey];
    if (typeof execute !== 'function') throw new Error(`BankBU action未注册：${envelope.actionKey}`);
    const result = await execute(envelope.payload.input, {
      signal: abortController.signal,
      operationIdentity: Object.freeze({
        actionKey: envelope.actionKey,
        operationKey: envelope.operationKey,
        producerTaskRunId: envelope.context.value.taskRunId
      }),
      awaitCritical: [BANK_BU_ACTIONS.IMPORT_MONTH, BANK_BU_ACTIONS.RUN].includes(envelope.actionKey)
        ? (body) => awaitCritical(body, unitId)
        : undefined
    });
    if (result.receipt) emit('commit:receipt', { receipt: result.receipt }, unitId);
    if (unitId) {
      unitTerminal = true;
      emit('unit:done', { result }, unitId);
    }
    terminal = true;
    emit('job:done', { result });
  }

  port.on('message', (raw) => {
    try {
      const envelope = validateEnvelope(raw);
      if (envelope.direction !== 'command' || !EXECUTORS[envelope.actionKey]) {
        throw new Error('BankBU Worker收到非法command route');
      }
      incoming.observe(envelope);
      if (envelope.operation === 'job:start') {
        if (startEnvelope) throw new Error('BankBU Worker重复job:start');
        startEnvelope = envelope;
        emit = createCanonicalEventEmitter(envelope, (event) => port.postMessage(event));
        abortController = new AbortController();
        if (!MUTATION_ACTIONS.has(envelope.actionKey)) {
          Promise.resolve().then(() => executeEnvelope(envelope)).catch(fail);
        }
        return;
      }
      if (!startEnvelope) throw new Error('BankBU Worker必须先收到job:start');
      assertStartIdentity(envelope);
      if (envelope.operation === 'unit:start') {
        if (!MUTATION_ACTIONS.has(envelope.actionKey) || activeUnitId ||
            envelope.unitId !== BANK_BU_SINGLETON_UNIT_ID) {
          throw new Error('BankBU mutation必须使用唯一singleton operation unit');
        }
        activeUnitId = envelope.unitId;
        Promise.resolve().then(() => executeEnvelope(envelope, activeUnitId)).catch(fail);
        return;
      }
      if (envelope.operation === 'critical:ack') {
        if (!critical || protectedPhase || !envelope.payload.critical ||
            typeof envelope.payload.critical.intentId !== 'string' ||
            envelope.unitId !== critical.unitId ||
            envelope.payload.critical.fileOperationKey !== startEnvelope.operationKey) {
          throw new Error('BankBU critical ACK identity非法');
        }
        protectedPhase = true;
        const resolve = critical.resolve;
        critical = null;
        resolve(envelope.payload.critical);
        return;
      }
      if (envelope.operation === 'critical:reject') {
        if (!critical || protectedPhase || envelope.unitId !== critical.unitId) {
          throw new Error('BankBU critical reject状态非法');
        }
        const error = new Error('BankBU Main拒绝进入critical');
        error.code = 'BANK_BU_CRITICAL_REJECTED';
        const reject = critical.reject;
        critical = null;
        reject(error);
        return;
      }
      if (envelope.operation === 'job:cancel') {
        if (protectedPhase) return;
        abortController.abort(envelope.payload.cancel);
        if (critical) {
          const error = new Error('BankBU在critical ACK前取消');
          error.code = 'BANK_BU_CANCELLED';
          const reject = critical.reject;
          critical = null;
          reject(error);
        }
        emit('cancel:ack', { cancellation: { scope: 'job' } });
        return;
      }
      throw new Error(`BankBU Worker不支持command：${envelope.operation}`);
    } catch (error) {
      fail(error);
    }
  });

  return Object.freeze({ get protectedPhase() { return protectedPhase; } });
}

module.exports = { startBankBuWorker };
