'use strict';

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { fromProtocolError } = require('../../background-execution/error-codec');
const {
  freezeWorkerOperationContext
} = require('../../archive-center/worker-operation-context');
const { validatePreFundGeneratedArtifact } = require('./business-validator');
const {
  PRE_FUND_READ_ONLY_ACTIONS,
  PRE_FUND_READ_ONLY_ACTION_SET
} = require('./policies');

function managedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function childOperationContext(batchContext, operationKey) {
  return freezeWorkerOperationContext({
    taskRunId: batchContext && batchContext.taskRunId,
    taskKey: batchContext && batchContext.taskKey,
    moduleId: batchContext && batchContext.moduleId,
    parentRunId: batchContext && batchContext.parentRunId,
    operationKey
  }, { required: true });
}

function normalizeUnits(units, stableRunEvidence) {
  if (!Array.isArray(units) || units.length === 0) {
    throw new TypeError('PreFund managed export units 缺失');
  }
  const outputKeys = new Set();
  const channelDigests = new Set();
  const inventory = units.map((unit, index) => {
    if (!unit || typeof unit !== 'object' || !PRE_FUND_READ_ONLY_ACTION_SET.has(unit.actionKey) ||
        !unit.context || typeof unit.context.channel !== 'string' || !unit.context.channel ||
        typeof unit.context.channelDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(unit.context.channelDigest) ||
        typeof unit.context.hasDuplicateRecords !== 'boolean' ||
        unit.context.hasDuplicateRecords !==
          (unit.actionKey === PRE_FUND_READ_ONLY_ACTIONS.AUDIT) ||
        !unit.generationPlan || typeof unit.generationPlan.outputArtifactKey !== 'string' ||
        !unit.generationPlan.outputArtifactKey) {
      throw new TypeError(`PreFund managed export unit #${index + 1} 非法`);
    }
    if (outputKeys.has(unit.generationPlan.outputArtifactKey) ||
        channelDigests.has(unit.context.channelDigest)) {
      throw managedError('PRE_FUND_EXPORT_UNIT_DUPLICATE', 'PreFund 渠道或 artifact authority 重复');
    }
    outputKeys.add(unit.generationPlan.outputArtifactKey);
    channelDigests.add(unit.context.channelDigest);
    return Object.freeze({
      channel: unit.context.channel,
      channelDigest: unit.context.channelDigest,
      hasDuplicateRecords: unit.context.hasDuplicateRecords
    });
  });
  if (!stableRunEvidence ||
      canonicalSha256(Object.freeze(inventory)) !== stableRunEvidence.channelSetDigest) {
    throw managedError('PRE_FUND_EXPORT_UNIT_SET_MISMATCH', 'PreFund 渠道 job 集合与冻结来源不一致');
  }
  return Object.freeze(units.slice());
}

async function executeUnit(options, unit, index) {
  const operationKey = `${options.batchContext.operationKey}:pre-fund:${index + 1}`;
  const operationContext = childOperationContext(options.batchContext, operationKey);
  const execution = await options.runtime.execute({
    actionKey: unit.actionKey,
    operationKey,
    production: options.production === true,
    context: { kind: 'operation', value: operationContext },
    input: {
      actionKey: unit.actionKey,
      operationKey,
      taskRunId: options.taskRunId,
      stableRunEvidence: options.stableRunEvidence,
      dbPathOrManagedSource: options.dbPathOrManagedSource,
      generationPlan: unit.generationPlan,
      context: unit.context
    }
  });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw managedError('PRE_FUND_EXPORT_GENERATION_FAILED', 'PreFund read-only export Worker 失败');
  }
  const result = execution.result;
  if (!result || result.actionKey !== unit.actionKey ||
      result.operationKey !== operationKey || result.taskRunId !== options.taskRunId ||
      result.sourceDigest !== options.stableRunEvidence.sourceDigest ||
      !result.summary || result.summary.channelDigest !== unit.context.channelDigest) {
    throw managedError('PRE_FUND_EXPORT_MANIFEST_IDENTITY_MISMATCH', 'PreFund manifest identity 不一致');
  }
  const artifact = await validatePreFundGeneratedArtifact({
    generationPlan: unit.generationPlan,
    result
  });
  return Object.freeze({ artifact, summary: result.summary });
}

async function generateValidateAndPublishPreFundExport(options = {}) {
  if (!options.runtime || typeof options.runtime.execute !== 'function') {
    throw new TypeError('PreFund read-only export runtime 缺失');
  }
  if (typeof options.publisher !== 'function') {
    throw new TypeError('PreFund read-only export Publisher 缺失');
  }
  if (!options.batchContext || options.batchContext.taskRunId !== options.taskRunId) {
    throw managedError('PRE_FUND_EXPORT_TASK_AUTHORITY_MISMATCH', 'PreFund task authority 不一致');
  }
  const units = normalizeUnits(options.units, options.stableRunEvidence);
  const artifacts = [];
  const summaries = [];
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  for (let index = 0; index < units.length; index += 1) {
    if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
    const generated = await executeUnit(options, units[index], index);
    artifacts.push(generated.artifact);
    summaries.push(generated.summary);
  }
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const publication = await options.publisher(
    Object.freeze(artifacts.slice()),
    Object.freeze(summaries.slice())
  );
  return Object.freeze({
    artifacts: Object.freeze(artifacts.slice()),
    summaries: Object.freeze(summaries.slice()),
    publication
  });
}

module.exports = {
  childOperationContext,
  executeUnit,
  generateValidateAndPublishPreFundExport,
  normalizeUnits
};
