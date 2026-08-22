'use strict';

const { toProtocolError } = require('../error-codec');
const { createCanonicalEventEmitter } = require('./canonical-event-emitter');

function resolveInlineEntry(entry) {
  if (typeof entry === 'function') {
    return entry;
  }
  if (entry && typeof entry.execute === 'function') {
    return entry.execute.bind(entry);
  }
  throw new TypeError('inline-async entry must be a function or expose execute()');
}

function createInlineAsyncAdapter() {
  return Object.freeze({
    kind: 'inline-async',
    start(options) {
      const execute = resolveInlineEntry(options.entry);
      const policy = options.policy || {
        protocolLimits: { eventMaxBytes: 262144 },
        result: { maxErrorItems: 100 },
        metrics: { privacyProfile: 'finance-safe-v1' }
      };
      const abortController = new AbortController();
      let startEnvelope = null;
      let emit = null;
      let started = false;
      let closed = false;

      function run(envelope) {
        Promise.resolve().then(() => execute({
          actionKey: envelope.actionKey,
          operationKey: envelope.operationKey,
          jobId: envelope.jobId,
          context: envelope.context,
          input: envelope.payload.input,
          signal: abortController.signal,
          reportProgress(progress) {
            if (!closed) emit('job:progress', { progress });
          }
        })).then((result) => {
          if (!closed) emit('job:done', { result });
        }, (error) => {
          if (!closed && abortController.signal.aborted && error === abortController.signal.reason &&
              typeof options.onCancellationTerminal === 'function') {
            options.onCancellationTerminal();
          }
          if (!closed) emit('job:error', {
            error: toProtocolError(error, 'INLINE_EXECUTION_ERROR', {
              maxBytes: policy.protocolLimits.eventMaxBytes,
              maxErrorItems: policy.result.maxErrorItems,
              privacyProfile: policy.metrics.privacyProfile,
              stage: 'execute'
            })
          });
        });
      }

      return Object.freeze({
        ready: Promise.resolve(),
        send(envelope) {
          if (closed) return;
          if (envelope.operation === 'job:start') {
            if (started) throw new Error('inline-async adapter received duplicate job:start');
            started = true;
            startEnvelope = envelope;
            emit = createCanonicalEventEmitter(startEnvelope, options.onMessage, options.onError);
            run(envelope);
          } else if (envelope.operation === 'job:cancel') {
            if (!startEnvelope) return;
            abortController.abort(envelope.payload.cancel);
            emit('cancel:ack', { cancellation: { scope: 'job' } });
          }
        },
        close() {
          closed = true;
        },
        async terminate() {
          closed = true;
          abortController.abort();
          return 0;
        }
      });
    }
  });
}

module.exports = {
  createInlineAsyncAdapter,
  resolveInlineEntry
};
