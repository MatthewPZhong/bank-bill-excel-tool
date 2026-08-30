'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { toProtocolError } = require('../background-execution/error-codec');
const { VCC_EXPORT_SUBJECTS_ACTION } = require('./policies');
const { executeVccExportWriter } = require('./writer-core');

if (!parentPort) throw new Error('VCC shard Writer需要worker_threads parentPort');

const abortController = new AbortController();
let terminal = false;

parentPort.on('message', (message) => {
  if (message && message.contractVersion === 1 && message.operation === 'cancel' && !terminal) {
    abortController.abort();
  }
});

executeVccExportWriter(
  workerData && workerData.input,
  abortController.signal,
  VCC_EXPORT_SUBJECTS_ACTION,
  { allowShard: true }
).then(
  (result) => {
    if (terminal) return;
    terminal = true;
    parentPort.postMessage({ contractVersion: 1, ok: true, result, error: null });
    parentPort.close();
  },
  (error) => {
    if (terminal) return;
    terminal = true;
    parentPort.postMessage({
      contractVersion: 1,
      ok: false,
      result: null,
      error: toProtocolError(error, 'VCC_EXPORT_SHARD_FAILED', {
        maxBytes: 65536,
        maxErrorItems: 100,
        privacyProfile: 'finance-safe-v1',
        stage: 'execute'
      })
    });
    parentPort.close();
  }
);
