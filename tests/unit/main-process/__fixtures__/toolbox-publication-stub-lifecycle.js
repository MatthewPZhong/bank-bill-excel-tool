'use strict';

const { isMainThread, parentPort } = require('node:worker_threads');

function serializedError(message) {
  return {
    name: 'Error',
    message,
    stack: null,
    code: null,
    cause: null,
    detailLines: null,
    context: null,
    recoveryPaths: null,
    preserveTemporaryFiles: false
  };
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'close') {
      process.exit(0);
      return;
    }
    if (message.type !== 'run') return;

    const { jobId, op, payload = {} } = message;
    const label = op === 'publish'
      ? String(payload.taskId || 'publish')
      : String(payload.userDataDir || 'recover');
    parentPort.postMessage({
      type: 'progress',
      jobId,
      payload: { checkpoint: 'start', context: { label } }
    });

    if (op === 'publish' && payload.taskId === 'transport-error') {
      setImmediate(() => {
        throw new Error('lifecycle fixture uncaught transport error');
      });
      return;
    }
    if (op === 'publish' && payload.taskId === 'business-error') {
      parentPort.postMessage({
        type: 'error',
        jobId,
        error: serializedError('lifecycle fixture business error')
      });
      return;
    }
    parentPort.postMessage({
      type: 'done',
      jobId,
      result: op === 'recover'
        ? { recovered: [], label }
        : { committed: true, files: [], warnings: [] }
    });
  });
}
