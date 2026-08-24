'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../backend/database/background-execution-schema');
const { ensureCanaryReceiptSchema } = require('./canary-schema');

const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA foreign_keys = ON');
ensureBackgroundExecutionRecoveryControlSchema(db);
ensureCanaryReceiptSchema(db);
db.exec('BEGIN IMMEDIATE');
try {
  const existing = db.prepare(`
    SELECT value FROM background_execution_canary_receipts WHERE operation_key = ?
  `).get(workerData.operationKey);
  if (existing && existing.value !== workerData.value) {
    const error = new Error('canary operationKey 已提交不同 value');
    error.code = 'CANARY_RECEIPT_CONFLICT';
    throw error;
  }
  if (!existing) {
    db.prepare(`
      INSERT INTO background_execution_canary_receipts (
        operation_key, value, committed_at
      ) VALUES (?, ?, ?)
    `).run(workerData.operationKey, workerData.value, workerData.committedAt);
  }
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 原错误优先。 */ }
  throw error;
}
db.close();

if (workerData.crashAfterCommit === true) process.exit(91);
parentPort.postMessage(Object.freeze({
  operationKey: workerData.operationKey,
  value: workerData.value,
  committedAt: workerData.committedAt
}));
