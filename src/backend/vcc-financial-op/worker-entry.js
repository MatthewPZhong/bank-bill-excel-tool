'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../vcc-financial-op-db/migrations');
const { inspectFiles, importFiles } = require('./import-service');
const { calculateMonth } = require('./calculator');
const { unarchiveMonth } = require('./unarchive');
const { deleteDataTarget } = require('./data-target-deletion');
const { writeDatasetWorkbook } = require('../../main-process/vcc-financial-op-dataset-writer');
const { serializeError } = require('../../main-process/serialize-error');

let cancelRequested = false;
let resolveCriticalDecision = null;
const DESTRUCTIVE_ACTIONS = new Set([
  'unarchive-month',
  'delete-data-target'
]);

function handleControlMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'cancel') {
    cancelRequested = true;
    if (resolveCriticalDecision) resolveCriticalDecision('cancel');
  } else if (message.type === 'critical-ack' && resolveCriticalDecision) {
    resolveCriticalDecision('ack');
  }
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

function cancelledError() {
  const error = new Error('操作已在进入事务前取消。');
  error.code = 'operation-cancelled';
  return error;
}

async function enterCriticalSection(action) {
  if (cancelRequested) throw cancelledError();
  const decision = await new Promise((resolve) => {
    let settled = false;
    resolveCriticalDecision = (value) => {
      if (settled) return;
      settled = true;
      resolveCriticalDecision = null;
      resolve(value);
    };
    parentPort.postMessage({ type: 'critical-ready', action });
  });
  if (decision !== 'ack' || cancelRequested) throw cancelledError();
}

async function run() {
  // 破坏性任务在打开数据库（含 migration 写事务）前就进入父进程保护区。
  if (DESTRUCTIVE_ACTIONS.has(workerData.action)) {
    await enterCriticalSection(workerData.action);
  }
  const db = openDb(workerData.dbPath);
  try {
    if (workerData.action === 'inspect') {
      return await inspectFiles(workerData.payload.filePaths);
    }
    if (workerData.action === 'import') {
      return await importFiles({
        db,
        ...workerData.payload,
        shouldCancel: () => cancelRequested,
        onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
      });
    }
    if (workerData.action === 'calculate') {
      return calculateMonth({ db, ...workerData.payload });
    }
    if (workerData.action === 'unarchive-month') {
      return unarchiveMonth({ db, ...workerData.payload });
    }
    if (workerData.action === 'delete-data-target') {
      return deleteDataTarget({ db, ...workerData.payload });
    }
    if (workerData.action === 'export-dataset') {
      return await writeDatasetWorkbook({
        db,
        ...workerData.payload,
        onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
      });
    }
    throw new Error(`未知 VCC 财务OP worker action：${workerData.action}`);
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
