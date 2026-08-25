'use strict';

const { parentPort } = require('node:worker_threads');

const { PreFundReconciliationStore } = require('../../../backend/pre-fund-reconciliation-store');
const {
  createCanonicalEventEmitter
} = require('../../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../../background-execution/error-codec');
const { validateEnvelope } = require('../../background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../../background-execution/sequence-tracker');
const { createSingleWriterSession } = require('./single-writer-session');

if (!parentPort) throw new Error('PreFund MPT Writer需要worker_threads parentPort');

const incomingSequence = createDirectionSequenceTracker();
let startEnvelope = null;
let emit = null;
let session = null;
let terminal = false;

function fail(error) {
  if (!emit || terminal) throw error;
  terminal = true;
  emit('job:error', { error: toProtocolError(error, 'PREFUND_WRITER_PROTOCOL_ERROR') });
}

parentPort.on('message', (message) => {
  try {
    const envelope = validateEnvelope(message);
    if (envelope.direction !== 'command' ||
        !['pre-fund:mpt-import', 'pre-fund:mpt-repair-import'].includes(envelope.actionKey)) {
      throw new Error('PreFund Writer收到非法command route');
    }
    incomingSequence.observe(envelope);
    if (envelope.operation === 'job:start') {
      if (startEnvelope) throw new Error('PreFund Writer重复job:start');
      startEnvelope = envelope;
      emit = createCanonicalEventEmitter(startEnvelope, (event) => parentPort.postMessage(event));
      const input = envelope.payload.input;
      if (!input || typeof input.userDataDir !== 'string') {
        throw new Error('PreFund Writer job缺少userDataDir');
      }
      session = createSingleWriterSession({
        actionKey: envelope.actionKey,
        jobInput: input,
        store: new PreFundReconciliationStore(input.userDataDir),
        emit(operation, payload, unitId) {
          const event = emit(operation, payload, unitId);
          if (operation === 'job:done' || operation === 'job:error') terminal = true;
          return event;
        }
      });
      return;
    }
    if (!session) throw new Error('PreFund Writer必须先收到job:start');
    if (envelope.operation === 'unit:start') {
      session.startUnit(envelope.payload.input, envelope.unitId).catch(fail);
      return;
    }
    if (envelope.operation === 'critical:ack') {
      session.acknowledge(envelope.unitId, envelope.payload.critical);
      return;
    }
    if (envelope.operation === 'job:cancel') {
      session.cancel();
      return;
    }
    throw new Error(`PreFund Writer不支持command：${envelope.operation}`);
  } catch (error) {
    fail(error);
  }
});
