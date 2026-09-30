'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { validateExecutionMemoryConfig } = require('./background-execution/execution-memory-config');
const { checkExecutionMemory } = require('./background-execution/execution-memory-options');
const memoryConfig = workerData?.backgroundExecutionMemoryConfig
  ? validateExecutionMemoryConfig(workerData.backgroundExecutionMemoryConfig) : null;
const { createWorkerAuthority, recoveryError } = require('./publication-recovery/worker-authority');
const workerAuthority = workerData && workerData.publicationRecoveryKey
  ? createWorkerAuthority(workerData.publicationRecoveryKey) : null;
const {
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications,
  discoverToolboxPublicationRecovery
} = require('./toolbox-output-publication');
const { serializeError } = require('./serialize-error');
const { freezeWorkerBatchContext } = require('./archive-center/worker-batch-context');

function runPublicationOperation(op, payload = {}, onCheckpoint = null) {
  checkExecutionMemory(memoryConfig);
  const checkpoint = (name, context) => {
    checkExecutionMemory(memoryConfig);
    if (typeof onCheckpoint === 'function') onCheckpoint(name, context);
  };
  if (op === 'publish') {
    const batchContext = freezeWorkerBatchContext(payload.batchContext, { required: true });
    const prepared = prepareToolboxPublication({
      workerAuthority,
      preflight: payload.preflight,
      taskId: payload.taskId,
      artifacts: payload.artifacts,
      targets: payload.targets,
      userDataDir: payload.userDataDir,
      requireValidatedArtifacts: payload.requireValidatedArtifacts === true,
      requireTargetParentIdentity: payload.requireTargetParentIdentity === true,
      protectedSourcePaths: payload.protectedSourcePaths,
      batchContext,
      archiveInputFiles: payload.archiveInputFiles,
      requireArchiveHandoff: payload.requireArchiveHandoff === true,
      allowEmptyArchiveInputs: payload.allowEmptyArchiveInputs === true,
      checkpoint
    });
    return publishPreparedToolboxPublication(prepared);
  }
  if (op === 'discover-recovery') {
    return discoverToolboxPublicationRecovery({ userDataDir: payload.userDataDir });
  }
  if (op === 'execute-recovery') {
    return recoverPendingToolboxPublications({ userDataDir: payload.userDataDir,
      authorization: payload.authorization, workerAuthority, checkpoint });
  }
  if (op === 'recover') {
    throw recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', payload.userDataDir, 'worker raw recover 已停用');
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
