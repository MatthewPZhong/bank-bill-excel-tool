'use strict';

const { fromProtocolError } = require('../../background-execution/error-codec');
const {
  freezeWorkerOperationContext
} = require('../../archive-center/worker-operation-context');
const { validatePositionGeneratedArtifact } = require('./business-validator');

function managedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function operationContextFromBatch(batchContext) {
  return freezeWorkerOperationContext({
    taskRunId: batchContext && batchContext.taskRunId,
    taskKey: batchContext && batchContext.taskKey,
    moduleId: batchContext && batchContext.moduleId,
    parentRunId: batchContext && batchContext.parentRunId,
    operationKey: batchContext && batchContext.operationKey
  }, { required: true });
}

async function generateValidateAndPublishPositionExport(options = {}) {
  if (!options.runtime || typeof options.runtime.execute !== 'function') {
    throw new TypeError('Position read-only export runtime 缺失');
  }
  if (typeof options.publisher !== 'function') {
    throw new TypeError('Position read-only export Publisher 缺失');
  }
  const operationContext = operationContextFromBatch(options.batchContext);
  if (operationContext.operationKey !== options.operationKey ||
      operationContext.taskRunId !== options.taskRunId) {
    throw managedError('POSITION_EXPORT_TASK_AUTHORITY_MISMATCH', 'Position task authority 不一致');
  }
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const execution = await options.runtime.execute({
    actionKey: options.actionKey,
    operationKey: options.operationKey,
    production: options.production === true,
    context: { kind: 'operation', value: operationContext },
    input: {
      actionKey: options.actionKey,
      operationKey: options.operationKey,
      taskRunId: options.taskRunId,
      stableRunEvidence: options.stableRunEvidence,
      dbPathOrManagedSource: options.dbPathOrManagedSource,
      generationPlan: options.generationPlan,
      context: options.context
    }
  });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw managedError('POSITION_EXPORT_GENERATION_FAILED', 'Position read-only export Worker 失败');
  }
  if (!execution.result || execution.result.actionKey !== options.actionKey ||
      execution.result.operationKey !== options.operationKey ||
      execution.result.taskRunId !== options.taskRunId ||
      execution.result.sourceDigest !== options.stableRunEvidence.sourceDigest) {
    throw managedError('POSITION_EXPORT_MANIFEST_IDENTITY_MISMATCH', 'Position manifest identity 不一致');
  }
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const artifact = await validatePositionGeneratedArtifact({
    generationPlan: options.generationPlan,
    result: execution.result
  });
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const publication = await options.publisher(Object.freeze([artifact]), execution.result.summary);
  return Object.freeze({ artifact, summary: execution.result.summary, publication });
}

module.exports = { generateValidateAndPublishPositionExport, operationContextFromBatch };
