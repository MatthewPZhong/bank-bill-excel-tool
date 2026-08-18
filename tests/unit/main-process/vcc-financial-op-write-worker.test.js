'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const WORKER_PATH = path.resolve(
  __dirname,
  '../../../src/main-process/vcc-financial-op-write-worker.js'
);

function runWorker(workerData, onMessage = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    const messages = [];
    let settled = false;
    worker.on('message', (message) => {
      messages.push(message);
      if (typeof onMessage === 'function') onMessage(worker, message);
      if (message && ['result', 'error'].includes(message.type) && !settled) {
        settled = true;
        resolve({ terminal: message, messages });
      }
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`write worker exit ${code}`));
    });
  });
}

function payload() {
  return {
    runId: 1,
    expectedResultRevision: 0,
    expectedPreviewToken: `v2:${'a'.repeat(64)}`,
    taskGeneration: 0,
    appVersion: '3.1.9',
    buildSha: 'worker-test',
    operationContext: {
      taskRunId: 'task-1',
      taskKey: 'vccFinancialOp:run:archive',
      moduleId: 'vcc-financial-op',
      parentRunId: 'parent-1',
      operationKey: 'operation-1'
    }
  };
}

test('unknown write action 在 critical-ready 与开库前拒绝', async () => {
  const missing = path.join(os.tmpdir(), `vcc-write-worker-missing-${process.pid}.sqlite`);
  fs.rmSync(missing, { force: true });
  const outcome = await runWorker({
    action: 'unknown-action',
    payload: payload(),
    dbPath: missing
  });
  assert.equal(outcome.terminal.type, 'error');
  assert.equal(outcome.terminal.error.code, 'invalid-vcc-write-action');
  assert.equal(outcome.messages.some((message) => message.type === 'critical-ready'), false);
  assert.equal(fs.existsSync(missing), false);
});

test('critical-ready 前 cancel 不开库并返回 operation-cancelled', async () => {
  const missing = path.join(os.tmpdir(), `vcc-write-worker-cancel-${process.pid}.sqlite`);
  fs.rmSync(missing, { force: true });
  const outcome = await runWorker({
    action: 'archive-result',
    payload: payload(),
    dbPath: missing
  }, (worker, message) => {
    if (message && message.type === 'critical-ready') worker.postMessage({ type: 'cancel' });
  });
  assert.equal(outcome.terminal.type, 'error');
  assert.equal(outcome.terminal.error.code, 'operation-cancelled');
  assert.equal(fs.existsSync(missing), false);
});

test('critical ack 后新 worker 零 migration，缺 schema fail-closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-write-worker-schema-'));
  const dbPath = path.join(root, 'empty.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outcome = await runWorker({
    action: 'archive-result',
    payload: payload(),
    dbPath
  }, (worker, message) => {
    if (message && message.type === 'critical-ready') worker.postMessage({ type: 'critical-ack' });
  });
  assert.equal(outcome.terminal.type, 'error');
  assert.equal(outcome.terminal.error.code, 'vcc-schema-not-ready');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'vcc_fin_op_%'
  `).get().count);
  db.close();
  assert.equal(count, 0);
});

test('operationContext 缺失或字段不全均拒绝，完整值沿用 exact-5 refreeze 合同', async () => {
  const missing = path.join(os.tmpdir(), `vcc-write-worker-context-${process.pid}.sqlite`);
  fs.rmSync(missing, { force: true });
  const absent = await runWorker({
    action: 'archive-result',
    payload: { ...payload(), operationContext: null },
    dbPath: missing
  });
  assert.equal(absent.terminal.type, 'error');
  assert.match(absent.terminal.error.message, /operationContext/);
  assert.equal(absent.messages.some((message) => message.type === 'critical-ready'), false);
  assert.equal(fs.existsSync(missing), false);

  const invalid = await runWorker({
    action: 'archive-result',
    payload: { ...payload(), operationContext: { taskRunId: 'task-1' } },
    dbPath: missing
  });
  assert.equal(invalid.terminal.type, 'error');
  assert.match(invalid.terminal.error.message, /exact-5/);
  assert.equal(invalid.messages.some((message) => message.type === 'critical-ready'), false);
  assert.equal(fs.existsSync(missing), false);

  const valid = await runWorker({
    action: 'delete-data-target',
    payload: {
      targetMonth: '2026-07',
      targetType: 'result',
      expectedPreviewToken: `v2:${'b'.repeat(64)}`,
      taskGeneration: 0,
      operationContext: {
        taskRunId: 'run-1',
        taskKey: 'task-1',
        moduleId: 'vcc-financial-op',
        parentRunId: 'parent-1',
        operationKey: 'delete-result'
      }
    },
    dbPath: missing
  }, (worker, message) => {
    if (message && message.type === 'critical-ready') worker.postMessage({ type: 'cancel' });
  });
  assert.equal(valid.terminal.type, 'error');
  assert.equal(valid.terminal.error.code, 'operation-cancelled');
  assert.equal(valid.messages.some((message) => message.type === 'critical-ready'), true);
  assert.equal(fs.existsSync(missing), false);
});
