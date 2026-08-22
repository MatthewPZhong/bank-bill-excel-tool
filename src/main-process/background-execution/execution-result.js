'use strict';

const { EXECUTION_TERMINAL_SOURCES } = require('./protocol');
const { canonicalJsonSnapshot } = require('./protocol-validator');

const TERMINAL_SOURCE_SET = new Set(EXECUTION_TERMINAL_SOURCES);

function createExecutionResult(fields) {
  if (!TERMINAL_SOURCE_SET.has(fields.terminalSource)) {
    throw new TypeError(`Unsupported execution terminalSource: ${fields.terminalSource}`);
  }
  if (fields.terminalSource !== 'job:done' && fields.result !== null) {
    throw new TypeError('Only job:done may carry a non-null execution result');
  }
  return Object.freeze({
    contractVersion: 1,
    actionKey: fields.actionKey,
    operationKey: fields.operationKey,
    jobId: fields.jobId,
    outcome: fields.outcome,
    terminalSource: fields.terminalSource,
    result: fields.result === null ? null : canonicalJsonSnapshot(fields.result),
    error: fields.error === null ? null : canonicalJsonSnapshot(fields.error),
    receiptHint: fields.receiptHint ? canonicalJsonSnapshot(fields.receiptHint) : null,
    metrics: Object.freeze({
      queuedAt: fields.metrics.queuedAt,
      startedAt: fields.metrics.startedAt,
      endedAt: fields.metrics.endedAt,
      workerCount: fields.metrics.workerCount
    })
  });
}

module.exports = {
  createExecutionResult
};
