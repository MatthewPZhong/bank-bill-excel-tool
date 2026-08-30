'use strict';

const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const {
  createCanonicalEventEmitter
} = require('../../../../src/main-process/background-execution/adapters/canonical-event-emitter');
const {
  validateEnvelope
} = require('../../../../src/main-process/background-execution/protocol-validator');
const {
  createDirectionSequenceTracker
} = require('../../../../src/main-process/background-execution/sequence-tracker');
const { executeRun } = require('../../../../src/main-process/bank-bu-worker/run-operation');
const {
  BANK_BU_SINGLETON_UNIT_ID
} = require('../../../../src/main-process/bank-bu-worker/singleton-unit');

const incoming = createDirectionSequenceTracker();
let start = null;
let emit = null;
let pendingAck = null;

function exitAfterSideCommit(input) {
  if (input.failureMode === 'unknown-hold') {
    const db = new DatabaseSync(input.mainDatabasePath);
    try {
      db.prepare(`INSERT INTO bank_bu_recon_runs (
        year_month,status,pending_total,bank_total,matched_count,bu_diff_count,
        pending_unmatched,bank_unmatched,anomaly_count,side_db_rel_path
      ) VALUES (?, 'success', 9, 9, 0, 0, 9, 9, 0, 'concurrent.sqlite')`).run(
        input.yearMonth
      );
    } finally {
      db.close();
    }
  }
  process.exit(91);
}

parentPort.on('message', (raw) => {
  const envelope = validateEnvelope(raw);
  incoming.observe(envelope);
  if (envelope.operation === 'job:start') {
    start = envelope;
    emit = createCanonicalEventEmitter(start, (message) => parentPort.postMessage(message));
    return;
  }
  if (!start) throw new Error('loss worker必须先收到job:start');
  if (envelope.operation === 'unit:start') {
    if (envelope.unitId !== BANK_BU_SINGLETON_UNIT_ID) {
      throw new Error('loss worker unitId非法');
    }
    executeRun(envelope.payload.input, {
      operationIdentity: {
        actionKey: envelope.actionKey,
        operationKey: envelope.operationKey,
        producerTaskRunId: envelope.context.value.taskRunId
      },
      awaitCritical(critical) {
        return new Promise((resolve) => {
          pendingAck = { resolve, unitId: envelope.unitId };
          emit('critical:ready', { critical }, envelope.unitId);
        });
      }
    }).then((result) => {
      if (envelope.payload.input.failureMode === 'unit-done-loss') {
        emit('commit:receipt', { receipt: result.receipt }, envelope.unitId);
        setImmediate(() => process.exit(91));
        return;
      }
      exitAfterSideCommit(envelope.payload.input);
    });
    return;
  }
  if (envelope.operation === 'critical:ack') {
    if (!pendingAck || pendingAck.unitId !== envelope.unitId) {
      throw new Error('loss worker critical ACK非法');
    }
    const resolve = pendingAck.resolve;
    pendingAck = null;
    resolve(envelope.payload.critical);
  }
});
