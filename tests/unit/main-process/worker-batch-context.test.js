'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const {
  WORKER_BATCH_CONTEXT_FIELDS,
  freezeWorkerBatchContext
} = require('../../../src/main-process/archive-center/worker-batch-context');
const {
  runMigrations
} = require('../../../src/backend/pending-db/migrations');

const BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'task-run-worker-319',
  taskKey: 'pending:import:start',
  moduleId: 'pending-reconciliation',
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

test('Pending 留底真实 child worker 接收 batchContext 后仍完成原有导出', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-archive-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'pending.sqlite');
  const archivePath = path.join(dir, 'archive.xlsx');
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  db.close();

  const workerPath = require.resolve('../../../src/main-process/pending-archive-worker');
  const result = spawnSync(process.execPath, [workerPath, JSON.stringify({
    dbPath,
    yearMonth: '2026-08',
    archivePath,
    batchContext: BATCH_CONTEXT
  })], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(archivePath), true);
  const events = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(events.at(-1).type, 'complete');
});
