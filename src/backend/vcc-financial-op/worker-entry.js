'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../vcc-financial-op-db/migrations');
const { inspectFiles, importFiles } = require('./import-service');
const { calculateMonth } = require('./calculator');
const { writeDatasetWorkbook } = require('../../main-process/vcc-financial-op-dataset-writer');
const { serializeError } = require('../../main-process/serialize-error');
const {
  freezeWorkerBatchContext
} = require('../../main-process/archive-center/worker-batch-context');
const {
  freezeWorkerOperationContext
} = require('../../main-process/archive-center/worker-operation-context');

let cancelRequested = false;

function handleControlMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'cancel') cancelRequested = true;
}

parentPort.on('message', handleControlMessage);

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;
  `);
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

async function run() {
  const action = workerData.action;
  const rawPayload = workerData.payload || {};
  const payload = ['import', 'export-dataset'].includes(action)
    ? {
        ...rawPayload,
        batchContext: freezeWorkerBatchContext(rawPayload.batchContext, { required: true })
      }
    : action === 'calculate'
      ? {
          ...rawPayload,
          operationContext: freezeWorkerOperationContext(
            rawPayload.operationContext,
            { required: true }
          )
        }
    : rawPayload;
  const db = openDb(workerData.dbPath);
  try {
    if (action === 'inspect') {
      return await inspectFiles(payload.filePaths);
    }
    if (action === 'import') {
      return await importFiles({
        db,
        ...payload,
        shouldCancel: () => cancelRequested,
        onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
      });
    }
    if (action === 'calculate') {
      return calculateMonth({ db, ...payload });
    }
    if (action === 'export-dataset') {
      return await writeDatasetWorkbook({
        db,
        ...payload,
        onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
      });
    }
    throw new Error(`未知 VCC 财务OP worker action：${action}`);
  } finally {
    db.close();
  }
}

function finish(message) {
  parentPort.off('message', handleControlMessage);
  parentPort.postMessage(message);
  parentPort.close();
}

run().then(
  (result) => finish({ type: 'result', result }),
  (error) => finish({ type: 'error', error: serializeError(error) })
);
