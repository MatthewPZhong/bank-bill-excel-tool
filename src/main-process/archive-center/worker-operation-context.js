'use strict';

const WORKER_OPERATION_CONTEXT_FIELDS = Object.freeze([
  'taskRunId',
  'taskKey',
  'moduleId',
  'parentRunId',
  'operationKey'
]);

function freezeWorkerOperationContext(value, options = {}) {
  const required = options.required === true;
  if (value == null) {
    if (required) throw new TypeError('worker operationContext 缺失');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('worker operationContext 必须是对象');
  }
  const keys = Object.keys(value).sort();
  const expected = [...WORKER_OPERATION_CONTEXT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('worker operationContext 必须只包含 exact-5 字段');
  }
  const context = {};
  for (const field of WORKER_OPERATION_CONTEXT_FIELDS) {
    const text = String(value[field] == null ? '' : value[field]).trim();
    if (!text) throw new TypeError(`worker operationContext.${field} 不能为空`);
    context[field] = text;
  }
  return Object.freeze(context);
}

function freezePersistedTaskOwner(value, options = {}) {
  const required = options.required === true;
  if (value == null) {
    if (required) throw new TypeError('persisted task owner 缺失');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('persisted task owner 必须是对象');
  }
  if (value.version === 1 && value.kind === 'operation') {
    return Object.freeze({
      version: 1,
      kind: 'operation',
      operationContext: freezeWorkerOperationContext(value.operationContext, { required: true })
    });
  }
  if (value.version === 1 && value.kind === 'file-batch') {
    const { freezeWorkerBatchContext } = require('./worker-batch-context');
    return Object.freeze({
      version: 1,
      kind: 'file-batch',
      batchContext: freezeWorkerBatchContext(value.batchContext, { required: true })
    });
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'version')) {
    const { freezeWorkerBatchContext } = require('./worker-batch-context');
    return Object.freeze({
      version: 0,
      kind: 'file-batch',
      batchContext: freezeWorkerBatchContext(value, { required: true })
    });
  }
  throw new TypeError('persisted task owner 版本或 kind 非法');
}

module.exports = {
  WORKER_OPERATION_CONTEXT_FIELDS,
  freezePersistedTaskOwner,
  freezeWorkerOperationContext
};
