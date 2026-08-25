'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { writeMptFileSpool } = require('./spool-writer');

if (!parentPort) throw new Error('PreFund MPT parser worker必须运行在worker_threads');

const controller = new AbortController();
parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') controller.abort();
});

function safeError(error) {
  return Object.freeze({
    name: error && error.name ? String(error.name) : 'Error',
    code: error && error.code ? String(error.code) : 'PREFUND_PARSER_WORKER_FAILED',
    message: error && error.message ? String(error.message) : 'MPT parser worker失败'
  });
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
