'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { writeMptFileSpool } = require('./spool-writer');

if (!parentPort) throw new Error('PreFund MPT parser worker必须运行在worker_threads');

const CLEANUP_ERROR_CODES = new Set([
  'PREFUND_SPOOL_CLEANUP_INCOMPLETE',
  'PREFUND_SPOOL_CLEANUP_PATH_INVALID'
]);
const SAFE_CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

const controller = new AbortController();
parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') controller.abort();
});

function safeError(error) {
  const result = {
    name: error && error.name ? String(error.name) : 'Error',
    code: error && error.code ? String(error.code) : 'PREFUND_PARSER_WORKER_FAILED',
    message: error && error.message ? String(error.message) : 'MPT parser worker失败'
  };
  const residualPaths = error && error.details && error.details.residualPaths;
  if (Array.isArray(error && error.detailLines)) {
    result.detailLines = error.detailLines
      .filter((line) => typeof line === 'string')
      .slice(0, 1000);
  }
  if (CLEANUP_ERROR_CODES.has(result.code) && Array.isArray(residualPaths) && residualPaths.length > 0) {
    const causeCode = error.cause && typeof error.cause.code === 'string'
      ? error.cause.code
      : null;
    result.cleanupRequired = true;
    result.cleanupScope = 'current-file-spool';
    result.causeCode = causeCode && SAFE_CAUSE_CODE_PATTERN.test(causeCode) ? causeCode : null;
  }
  return Object.freeze(result);
}

(async () => {
  try {
    const result = await writeMptFileSpool(workerData && workerData.input, {
      signal: controller.signal
    });
    parentPort.postMessage({
      ok: true,
      result: Object.freeze({
        schemaVersion: result.schemaVersion,
        jobId: result.jobId,
        fileIndex: result.fileIndex,
        fileOperationKey: result.fileOperationKey,
        unitId: result.unitId
      })
    });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: safeError(error) });
  } finally {
    parentPort.close();
  }
})();
