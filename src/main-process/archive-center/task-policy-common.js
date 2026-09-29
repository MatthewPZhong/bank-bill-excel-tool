'use strict';

const { resolveArchiveScope } = require('./module-scope-registry');
const { getTaskFilePlanDefinition } = require('./task-file-plan-registry');
const { NO_FILE_ACTION_CHANNELS, EXCLUDE_REASONS } = require('./task-policy-registry');
const NO_FILE_ACTION_SET = new Set(NO_FILE_ACTION_CHANNELS);
const EXCLUDE_REASON_SET = new Set(EXCLUDE_REASONS);

const STANDARD_SUCCESS_STATUSES = new Set([
  'completed_with_errors',
  'ok',
  'ready',
  'success',
  'warning'
]);
const STANDARD_FAILURE_STATUSES = new Set([
  'ambiguous',
  'busy',
  'conflict',
  'disabled',
  'empty',
  'error',
  'failed',
  'invalid',
  'manual-balance-invalid',
  'not-active',
  'not-cancellable',
  'overwrite-required',
  'partial',
  'read-error',
  'rejected',
  'stopping',
  'unrecognized',
  'unsupported',
  'write-error'
]);

function classifyKnownStatus(result, extraSuccessStatuses = []) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (!status || STANDARD_SUCCESS_STATUSES.has(status) || extraSuccessStatuses.includes(status)) {
    return 'succeeded';
  }
  if (STANDARD_FAILURE_STATUSES.has(status)) return 'failed';
  throw new TypeError(`未审计的业务结果 status：${status}`);
}

function standardResultClassifier(result) {
  return classifyKnownStatus(result);
}

function standardResultMetadataResolver(result) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (!status) return {};
  return {
    resultStatus: status,
    ...(status === 'completed_with_errors' ? { completedWithErrors: true } : {})
  };
}

function resultBusinessRunIdentities(result) {
  if (!result || typeof result !== 'object') return [];
  for (const key of ['runId', 'mirrorId', 'operationToken', 'ranAt']) {
    const value = String(result[key] == null ? '' : result[key]).trim();
    if (value) return [{ type: key === 'operationToken' ? 'operation-token' : 'business-run-id', value }];
  }
  return [];
}

function invocationBusinessRunIdentity(invocation = {}) {
  const args = Array.isArray(invocation.args) ? invocation.args : [];
  const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
  const candidate = payload.runId ?? (
    typeof args[0] === 'string' || typeof args[0] === 'number' ? args[0] : null
  );
  const value = String(candidate == null ? '' : candidate).trim();
  if (!value) {
    const error = new TypeError('续接任务缺少稳定 runId');
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return { type: 'business-run-id', value };
}

// 只生成通用字段；领域显式传入其分类、flow、metadata 与 lineage 函数。
function createBaseTaskPolicy(channel, scopeKey, {
  workerContext = 'none',
  startsNewFlow = true,
  flowIdentityResolver = null,
  flowPlanResolver = null,
  resultClassifier = standardResultClassifier,
  bindResultFlowIdentitiesOnFailure = false,
  resultMetadataResolver = standardResultMetadataResolver,
  resultFlowIdentities = resultBusinessRunIdentities
} = {}) {
  const scope = resolveArchiveScope(scopeKey);
  if (!scope) throw new Error('未知 archive scope：' + scopeKey);
  const fileDefinition = getTaskFilePlanDefinition(channel);
  if (Boolean(fileDefinition) === NO_FILE_ACTION_SET.has(channel)) {
    throw new TypeError('mutation action 必须且只能登记一种 task kind：' + channel);
  }
  const taskKind = fileDefinition ? 'file' : 'no-file';
  return Object.freeze({
    channel,
    scopeId: scope.id,
    moduleCode: scope.storageCode,
    moduleName: scope.name,
    taskKey: channel,
    batchPolicy: taskKind === 'file' ? 'reserve' : 'no-file',
    taskKind,
    allocation: fileDefinition ? fileDefinition.allocation : 'none',
    filePlanSourceKind: fileDefinition ? fileDefinition.sourceKind : null,
    filePlanResolver: fileDefinition ? fileDefinition.filePlanResolver : null,
    promotionManifestResolver: fileDefinition ? fileDefinition.promotionManifestResolver : null,
    workerContext: fileDefinition ? fileDefinition.workerContext : workerContext,
    startsNewFlow,
    flowIdentityResolver,
    flowPlanResolver,
    resultClassifier,
    bindResultFlowIdentitiesOnFailure,
    resultMetadataResolver,
    resultFlowIdentities
  });
}

function createExcludePolicy(channel, excludeReason) {
  if (!EXCLUDE_REASON_SET.has(excludeReason)) {
    throw new TypeError(`不支持的 excludeReason：${excludeReason}`);
  }
  return Object.freeze({
    channel,
    batchPolicy: 'exclude',
    taskKind: 'exclude',
    workerContext: 'none',
    excludeReason
  });
}

module.exports = {
  classifyKnownStatus,
  createBaseTaskPolicy,
  createExcludePolicy,
  invocationBusinessRunIdentity,
  resultBusinessRunIdentities,
  standardResultClassifier,
  standardResultMetadataResolver
};
