'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { serializeError } = require('./serialize-error');
const { openVccReadDatabase } = require('../backend/vcc-financial-op/read-schema');
const {
  listArchiveMonthsSnapshot,
  previewUnarchiveSnapshot,
  listActiveMonthsSnapshot,
  listDeleteTargetsSnapshot,
  previewDeleteTargetSnapshot
} = require('../backend/vcc-financial-op/read-snapshot');

const READ_ACTIONS = Object.freeze([
  'list-archive-months',
  'preview-unarchive',
  'list-delete-targets',
  'preview-delete-target',
  'list-active-months'
]);
const READ_ACTION_SET = new Set(READ_ACTIONS);

function invalidReadAction(action) {
  const error = new Error(`未知 VCC 财务OP只读 worker action：${action || ''}`);
  error.code = 'invalid-vcc-read-action';
  return error;
}

function runReadAction(db, action, payload, trace) {
  const options = { ...(payload || {}), trace };
  if (action === 'list-archive-months') return listArchiveMonthsSnapshot(db, options);
  if (action === 'preview-unarchive') return previewUnarchiveSnapshot(db, options);
  if (action === 'list-delete-targets') return listDeleteTargetsSnapshot(db, options);
  if (action === 'preview-delete-target') return previewDeleteTargetSnapshot(db, options);
  if (action === 'list-active-months') return listActiveMonthsSnapshot(db, options);
  throw invalidReadAction(action);
}

function run() {
  const action = workerData && workerData.action;
  if (!READ_ACTION_SET.has(action)) throw invalidReadAction(action);
  const db = openVccReadDatabase(workerData.dbPath);
  const startedAt = performance.now();
  const sqlTrace = [];
  const trace = (entry) => sqlTrace.push(entry);
  try {
    db.exec('BEGIN DEFERRED');
    const result = runReadAction(db, action, workerData.payload || {}, trace);
    db.exec('COMMIT');
    const readMetrics = Object.freeze({
      action,
      queryCount: sqlTrace.length,
      workerWallMs: Number((performance.now() - startedAt).toFixed(3)),
      sqlTrace: workerData.payload && workerData.payload.includeSqlTrace
        ? Object.freeze(sqlTrace)
        : undefined
    });
    return Object.freeze({ ...result, readMetrics });
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* close below */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

Promise.resolve().then(run).then(
  (result) => {
    parentPort.postMessage({ type: 'result', result });
    parentPort.close();
  },
  (error) => {
    parentPort.postMessage({ type: 'error', error: serializeError(error) });
    parentPort.close();
  }
);
