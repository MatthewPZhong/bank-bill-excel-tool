'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { createCanonicalEventEmitter } = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const { createDirectionSequenceTracker } = require('../background-execution/sequence-tracker');
const { NEW_ACCOUNT_GENERATION_ACTION } = require('./generation-contract');
const { executeNewAccountGeneration } = require('./generation-core');

if (!parentPort) throw new Error('NewAccount worker requires worker_threads parentPort');

const defaultTemplatePath = path.resolve(__dirname, '..', '..', '..', 'assets', '余额账单模版.xlsx');
const allowedTemplatePath = workerData && typeof workerData.allowedTemplatePath === 'string'
  ? path.resolve(workerData.allowedTemplatePath)
  : defaultTemplatePath;
const incomingSequence = createDirectionSequenceTracker();
let startEnvelope = null;
let emit = null;
let abortController = null;
let terminal = false;

parentPort.on('message', (message) => {
  try {
    const envelope = validateEnvelope(message);
    if (envelope.direction !== 'command' || envelope.actionKey !== NEW_ACCOUNT_GENERATION_ACTION) {
      throw new Error('NewAccount worker received an invalid command route');
    }
    incomingSequence.observe(envelope);
    if (envelope.operation === 'job:start') {
      if (startEnvelope) throw new Error('NewAccount worker received duplicate job:start');
      startEnvelope = envelope;
      emit = createCanonicalEventEmitter(startEnvelope, (event) => parentPort.postMessage(event));
      abortController = new AbortController();
      executeNewAccountGeneration(envelope.payload.input, abortController.signal, { allowedTemplatePath })
        .then((result) => {
          if (terminal) return;
          terminal = true;
          emit('job:done', { result });
        }, (error) => {
          if (terminal) return;
          terminal = true;
          emit('job:error', { error: toProtocolError(error) });
        });
      return;
    }
    if (envelope.operation === 'job:cancel' && abortController && !terminal) {
      abortController.abort(envelope.payload.cancel);
      emit('cancel:ack', { cancellation: { scope: 'job' } });
      return;
    }
    throw new Error(`NewAccount worker received unsupported operation: ${envelope.operation}`);
  } catch (error) {
    if (emit && !terminal) {
      terminal = true;
      emit('job:error', { error: toProtocolError(error, 'NEW_ACCOUNT_GENERATION_PROTOCOL_ERROR') });
    } else {
      throw error;
    }
  }
});
