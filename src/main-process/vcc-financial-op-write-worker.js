'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');
const {
  VCC_MUTATION_OPERATIONS
} = require('../backend/vcc-financial-op/mutation-policy');
const {
  executeResultMutationWithSafeAudit
} = require('../backend/vcc-financial-op/result-write');
const { serializeError } = require('./serialize-error');

const WRITE_ACTIONS = Object.freeze([
  VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT,
  VCC_MUTATION_OPERATIONS.ARCHIVE_RESULT
]);
const WRITE_ACTION_SET = new Set(WRITE_ACTIONS);

let cancelRequested = false;
let resolveCriticalDecision = null;

function invalidWriteAction(action) {
  const error = new Error(`未知 VCC 财务OP结果写入 action：${action || ''}`);
  error.code = 'invalid-vcc-write-action';
  return error;
}

function cancelledError() {
  const error = new Error('操作已在进入受保护事务前取消。');
  error.code = 'operation-cancelled';
  return error;
}

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

async function enterCriticalSection(action, payload) {
  if (cancelRequested) throw cancelledError();
  parentPort.postMessage({
    type: 'progress',
    progress: {
      action: action === VCC_MUTATION_OPERATIONS.ADD_ADJUSTMENT ? 'adjustment' : 'archive',
      targetMonth: '',
      runId: Number.isSafeInteger(Number(payload.runId)) ? Number(payload.runId) : null,
      phase: 'validating',
      cancellable: true
    }
  });
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
  const action = workerData && workerData.action;
  if (!WRITE_ACTION_SET.has(action)) throw invalidWriteAction(action);
  const payload = workerData && workerData.payload || {};
  const batchContext = freezeWorkerBatchContext(payload.batchContext);
  void batchContext;
  await enterCriticalSection(action, payload);
  return executeResultMutationWithSafeAudit({
    dbPath: workerData.dbPath,
    action,
    payload,
    taskGeneration: payload.taskGeneration,
    appVersion: payload.appVersion,
    buildSha: payload.buildSha,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
    onDiagnostic: (diagnostic) => parentPort.postMessage({ type: 'diagnostic', diagnostic })
  });
}

function finish(message) {
  parentPort.off('message', handleControlMessage);
  parentPort.postMessage(message);
  parentPort.close();
}

Promise.resolve().then(run).then(
  (result) => finish({ type: 'result', result }),
  (error) => finish({ type: 'error', error: serializeError(error) })
);

module.exports = {
  WRITE_ACTIONS,
  invalidWriteAction
};
