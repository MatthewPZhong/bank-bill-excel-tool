'use strict';

const { parentPort } = require('node:worker_threads');

const { createCanonicalEventEmitter } = require('../adapters/canonical-event-emitter');
const { toProtocolError } = require('../error-codec');
const { validateEnvelope } = require('../protocol-validator');
const { createDirectionSequenceTracker } = require('../sequence-tracker');
const { executePureComputeCanary } = require('./pure-compute');

if (!parentPort) {
  throw new Error('pure-compute canary worker requires worker_threads parentPort');
}

const incomingSequence = createDirectionSequenceTracker();
let startEnvelope = null;
let emit = null;
let abortController = null;
let terminal = false;

parentPort.on('message', (message) => {
  try {
    const envelope = validateEnvelope(message);
    if (envelope.direction !== 'command') throw new Error('canary worker only accepts command envelopes');
    incomingSequence.observe(envelope);
    if (envelope.operation === 'job:start') {
      if (startEnvelope) throw new Error('canary worker received duplicate job:start');
      startEnvelope = envelope;
      emit = createCanonicalEventEmitter(startEnvelope, (envelope) => parentPort.postMessage(envelope));
      abortController = new AbortController();
      executePureComputeCanary({
        input: envelope.payload.input,
        signal: abortController.signal,
        reportProgress(progress) {
          if (!terminal) emit('job:progress', { progress });
        }
      }).then((result) => {
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
    throw new Error(`canary worker received unsupported operation: ${envelope.operation}`);
  } catch (error) {
    if (emit && !terminal) {
      terminal = true;
      emit('job:error', { error: toProtocolError(error, 'CANARY_PROTOCOL_ERROR') });
    } else {
      throw error;
    }
  }
});
