'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WORKER_BATCH_CONTEXT_FIELDS,
  freezeWorkerBatchContext
} = require('../../../src/main-process/archive-center/worker-batch-context');

const BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'task-run-worker-319',
  taskKey: 'toolbox:merge',
  moduleId: 'toolbox',
  parentRunId: 'parent-worker-319',
  operationKey: 'operation-worker-319'
});

test('worker entry helper 拒绝 structured clone 夹带字段，并重建 exact-7 冻结 DTO', () => {
  const cloned = structuredClone({ ...BATCH_CONTEXT, settleArtifacts: 'must-not-cross' });
  assert.throws(
    () => freezeWorkerBatchContext(cloned, { required: true }),
    /exact-7/
  );
  const context = freezeWorkerBatchContext(structuredClone(BATCH_CONTEXT), { required: true });
  assert.deepEqual(Object.keys(context), WORKER_BATCH_CONTEXT_FIELDS);
  assert.deepEqual(context, BATCH_CONTEXT);
  assert.equal(Object.isFrozen(context), true);
  assert.notEqual(context, cloned);
});
