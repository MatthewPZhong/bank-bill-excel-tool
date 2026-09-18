'use strict';

const { parentPort, receiveMessageOnPort } = require('node:worker_threads');

const {
  createCanonicalEventEmitter
} = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../background-execution/sequence-tracker');

function startToolboxGenerationWorker(actionKey, executeGeneration) {
  if (!parentPort) throw new Error(`${actionKey} worker requires worker_threads parentPort`);
  const incomingSequence = createDirectionSequenceTracker();
  let startEnvelope = null;
  let emit = null;
  let abortController = null;
  let terminal = false;

  function handleMessage(message) {
    try {
      const envelope = validateEnvelope(message);
      if (envelope.direction !== 'command' || envelope.actionKey !== actionKey) {
        throw new Error(`${actionKey} worker received an invalid command route`);
      }
      incomingSequence.observe(envelope);
      if (envelope.operation === 'job:start') {
        if (startEnvelope) throw new Error(`${actionKey} worker received duplicate job:start`);
        startEnvelope = envelope;
        emit = createCanonicalEventEmitter(startEnvelope, (event) => parentPort.postMessage(event));
        abortController = new AbortController();
        executeGeneration(envelope.payload.input, abortController.signal, {
          // 同步源回调不能 await；rows 可在安全点主动读取相同端口的取消命令。
          // 仍由同一 canonical envelope/sequence 校验入口处理，旧执行器不使用该能力。
          pollCommands() {
            let queued;
            while ((queued = receiveMessageOnPort(parentPort))) handleMessage(queued.message);
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
      throw new Error(`${actionKey} worker received unsupported operation: ${envelope.operation}`);
    } catch (error) {
      if (emit && !terminal) {
        terminal = true;
        emit('job:error', { error: toProtocolError(error, 'TOOLBOX_GENERATION_PROTOCOL_ERROR') });
      } else {
        throw error;
      }
    }
  }
  parentPort.on('message', handleMessage);
}

module.exports = { startToolboxGenerationWorker };
