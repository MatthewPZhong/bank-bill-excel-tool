'use strict';

const WORKER_BATCH_CONTEXT_FIELDS = Object.freeze([
  'batchId',
  'batchNumber',
  'taskRunId',
  'taskKey',
  'moduleId',
  'parentRunId',
  'operationKey'
]);

function freezeWorkerBatchContext(value, options = {}) {
  const required = options.required === true;
  if (value == null) {
    if (required) throw new TypeError('worker batchContext 缺失');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('worker batchContext 必须是对象');
  }
  const keys = Object.keys(value).sort();
  const expected = [...WORKER_BATCH_CONTEXT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('worker batchContext 必须只包含 exact-7 字段');
  }
  const batchId = Number(value.batchId);
  if (!Number.isSafeInteger(batchId) || batchId < 1) {
    throw new TypeError('worker batchContext.batchId 必须是正安全整数');
  }
  const context = {
    batchId,
    batchNumber: String(value.batchNumber || ''),
    taskRunId: String(value.taskRunId || ''),
    taskKey: String(value.taskKey || ''),
    moduleId: String(value.moduleId || ''),
    parentRunId: String(value.parentRunId || ''),
    operationKey: String(value.operationKey || '')
  };
  for (const [key, field] of Object.entries(context)) {
    if (key !== 'batchId' && !field.trim()) {
      throw new TypeError(`worker batchContext.${key} 不能为空`);
    }
  }
  return Object.freeze(context);
}

module.exports = {
  WORKER_BATCH_CONTEXT_FIELDS,
  freezeWorkerBatchContext
};
