'use strict';

const { parentPort } = require('node:worker_threads');

const {
  createCanonicalEventEmitter
} = require('../../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../../background-execution/error-codec');
const { validateEnvelope } = require('../../background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../../background-execution/sequence-tracker');

function startReadOnlyExportWorker(allowedActions, executeExport) {
  if (!parentPort) throw new Error('read-only export worker requires worker_threads parentPort');
  const actionSet = allowedActions instanceof Set ? allowedActions : new Set(allowedActions || []);
  const incomingSequence = createDirectionSequenceTracker();
  let startEnvelope = null;
  let emit = null;
  let abortController = null;
  let terminal = false;

  parentPort.on('message', (message) => {
    try {
      const envelope = validateEnvelope(message);
      if (envelope.direction !== 'command' || !actionSet.has(envelope.actionKey)) {
        throw new Error('read-only export worker received an invalid command route');
      }
      incomingSequence.observe(envelope);
      if (envelope.operation === 'job:start') {
        if (startEnvelope) throw new Error('read-only export worker received duplicate job:start');
        startEnvelope = envelope;
        emit = createCanonicalEventEmitter(startEnvelope, (event) => parentPort.postMessage(event));
        abortController = new AbortController();
        Promise.resolve(executeExport(envelope.payload.input, abortController.signal)).then((result) => {
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
      throw new Error(`read-only export worker received unsupported operation: ${envelope.operation}`);
    } catch (error) {
      if (emit && !terminal) {
        terminal = true;
        emit('job:error', { error: toProtocolError(error, 'READ_ONLY_EXPORT_PROTOCOL_ERROR') });
      } else {
        throw error;
      }
    }
  });
}

module.exports = { startReadOnlyExportWorker };
