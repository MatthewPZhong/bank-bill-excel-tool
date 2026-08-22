'use strict';

const { createJobEnvelope } = require('../protocol');

function createCanonicalEventEmitter(startEnvelope, onMessage, onError) {
  let seq = 0;
  let failed = false;
  let terminal = false;

  function reportFailure(error) {
    if (failed) return null;
    failed = true;
    if (typeof onError === 'function') {
      try { onError(error); } catch (_callbackError) {}
      return null;
    }
    throw error;
  }

  return function emit(operation, payload, unitId = null) {
    if (failed) return null;
    if (terminal) {
      const error = new Error(`Canonical event emitted after terminal operation: ${operation}`);
      error.code = 'ADAPTER_LATE_EVENT';
      return reportFailure(error);
    }
    seq += 1;
    try {
      const envelope = createJobEnvelope({
        direction: 'event',
        operation,
        actionKey: startEnvelope.actionKey,
        operationKey: startEnvelope.operationKey,
        jobId: startEnvelope.jobId,
        workerInstanceId: startEnvelope.workerInstanceId,
        serviceGeneration: startEnvelope.serviceGeneration,
        unitId,
        seq,
        context: startEnvelope.context,
        payload
      });
      onMessage(envelope);
      if (operation === 'job:done' || operation === 'job:error') terminal = true;
      return envelope;
    } catch (error) {
      return reportFailure(error);
    }
  };
}

module.exports = {
  createCanonicalEventEmitter
};
