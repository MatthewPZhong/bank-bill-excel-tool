'use strict';

const path = require('node:path');

const {
  isValidTaskStagingResourceId,
  resolveTaskStagingResource,
  validateTaskOwnedStagingPath
} = require('../../statement-worker/staging-ownership');

function contractError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw contractError('READ_ONLY_EXPORT_CONTRACT_INVALID', `${label}必须是普通对象`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw contractError(
      'READ_ONLY_EXPORT_CONTRACT_INVALID',
      `${label}字段必须精确为：${expected.join(', ')}`
    );
  }
}

function nonEmptyText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw contractError('READ_ONLY_EXPORT_CONTRACT_INVALID', `${label}不能为空`);
  }
  return value;
}

function absolutePath(value, label) {
  const normalized = path.normalize(nonEmptyText(value, label));
  if (!path.isAbsolute(normalized)) {
    throw contractError('READ_ONLY_EXPORT_CONTRACT_INVALID', `${label}必须是绝对路径`);
  }
  return normalized;
}

function normalizeGenerationPlan(value) {
  exactKeys(
    value,
    ['generationPath', 'outputArtifactKey', 'stagingResourceId', 'stagingRoot'],
    'generationPlan'
  );
  const stagingRoot = absolutePath(value.stagingRoot, 'generationPlan.stagingRoot');
  const generationPath = absolutePath(value.generationPath, 'generationPlan.generationPath');
  if (!isValidTaskStagingResourceId(value.stagingResourceId) ||
      resolveTaskStagingResource(stagingRoot, value.stagingResourceId) !== generationPath) {
    throw contractError('READ_ONLY_EXPORT_CONTRACT_INVALID', 'generationPlan staging identity 非法');
  }
  validateTaskOwnedStagingPath({
    stagingRoot,
    candidatePath: generationPath,
    finalState: 'missing',
    allowMissingAncestors: false
  });
  return Object.freeze({
    stagingRoot,
    stagingResourceId: value.stagingResourceId,
    generationPath,
    outputArtifactKey: nonEmptyText(
      value.outputArtifactKey,
      'generationPlan.outputArtifactKey'
    )
  });
}

function normalizeReadOnlyExportInput(value, allowedActions, normalizeSource, normalizeEvidence, normalizeContext) {
  exactKeys(value, [
    'actionKey', 'context', 'dbPathOrManagedSource', 'generationPlan',
    'operationKey', 'stableRunEvidence', 'taskRunId'
  ], 'read-only export input');
  const actionKey = nonEmptyText(value.actionKey, 'actionKey');
  if (!allowedActions.has(actionKey)) {
    throw contractError('READ_ONLY_EXPORT_CONTRACT_INVALID', `不支持的只读导出 action：${actionKey}`);
  }
  return Object.freeze({
    actionKey,
    operationKey: nonEmptyText(value.operationKey, 'operationKey'),
    taskRunId: nonEmptyText(value.taskRunId, 'taskRunId'),
    stableRunEvidence: normalizeEvidence(value.stableRunEvidence, actionKey),
    dbPathOrManagedSource: normalizeSource(value.dbPathOrManagedSource, actionKey),
    generationPlan: normalizeGenerationPlan(value.generationPlan),
    context: normalizeContext(value.context, actionKey)
  });
}

module.exports = {
  absolutePath,
  contractError,
  exactKeys,
  nonEmptyText,
  normalizeGenerationPlan,
  normalizeReadOnlyExportInput,
  plainObject
};
