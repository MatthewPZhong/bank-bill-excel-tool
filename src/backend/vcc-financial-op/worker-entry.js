'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../vcc-financial-op-db/migrations');
const { inspectFiles, importFiles } = require('./import-service');
const { inspectWorkbookImportPlan, revalidateImportPlan } = require('./workbook-import-plan');
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
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 30000;
  `);
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

// 大批量导入会把 WAL 撑到 GB 级；提交后截断，失败不影响导入结果（对齐 big-table-import）。
function truncateWal(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) {
    parentPort.postMessage({
      type: 'diagnostic',
      diagnostic: {
        operation: 'vcc-import-wal-checkpoint',
        code: error && error.code ? error.code : 'wal-checkpoint-failed',
        message: error && error.message ? error.message : String(error)
      }
    });
  }
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
  const inspectionOptions = { shouldCancel: () => cancelRequested,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }) };
  if (action === 'inspect-plan') {
    return inspectWorkbookImportPlan(payload.filePaths, { ...inspectionOptions, sourceStructures: payload.sourceStructures || null });
  }
  if (action === 'revalidate-plan') { await revalidateImportPlan(payload.plan, inspectionOptions); return { valid: true }; }
  const db = openDb(workerData.dbPath);
  try {
    if (action === 'inspect') {
      return await inspectFiles(payload.filePaths);
    }
    if (action === 'import') {
      try {
        return await importFiles({
          db,
          ...payload,
          shouldCancel: () => cancelRequested,
          onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
        });
      } finally {
        truncateWal(db);
      }
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
