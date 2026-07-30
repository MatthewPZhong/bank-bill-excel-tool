'use strict';

const { isMainThread, parentPort } = require('node:worker_threads');
const {
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
} = require('./toolbox-output-publication');
const { serializeError } = require('./serialize-error');

function runPublicationOperation(op, payload = {}, onCheckpoint = null) {
  const checkpoint = typeof onCheckpoint === 'function' ? onCheckpoint : null;
  if (op === 'publish') {
    const prepared = prepareToolboxPublication({
      taskId: payload.taskId,
      artifacts: payload.artifacts,
      targets: payload.targets,
      userDataDir: payload.userDataDir,
      requireValidatedArtifacts: payload.requireValidatedArtifacts === true,
      checkpoint
    });
    return publishPreparedToolboxPublication(prepared);
  }
  if (op === 'recover') {
    return recoverPendingToolboxPublications({
      userDataDir: payload.userDataDir,
      checkpoint
    });
  }
  throw new Error(`未知的工具箱发布 worker 操作：${String(op)}`);
}

if (!isMainThread && parentPort) {
  let activeJobId = null;

  parentPort.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'close') {
      process.exit(0);
      return;
    }
    if (message.type !== 'run') return;

    const { jobId, op, payload } = message;
    if (activeJobId) {
      const error = new Error('工具箱发布 worker 不允许并发执行多个作业');
      parentPort.postMessage({
        type: 'error',
        jobId,
        error: serializeError(error)
      });
      return;
    }

    activeJobId = jobId;
    try {
      const result = runPublicationOperation(op, payload, (name, context) => {
        parentPort.postMessage({
          type: 'progress',
          jobId,
          payload: { checkpoint: name, context: context || {} }
        });
      });
      parentPort.postMessage({ type: 'done', jobId, result });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        jobId,
        error: serializeError(error)
      });
    } finally {
      activeJobId = null;
    }
  });
}

module.exports = {
  runPublicationOperation
};
