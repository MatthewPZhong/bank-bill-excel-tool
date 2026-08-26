'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { toProtocolError } = require('../background-execution/error-codec');
const { writeOutputsFromSealedRouteDb } = require('./output-writer-core');

if (!parentPort) throw new Error('toolbox output writer requires worker_threads parentPort');

const abortController = new AbortController();
parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') abortController.abort();
});

writeOutputsFromSealedRouteDb(workerData.input, abortController.signal).then(
  (result) => {
    parentPort.postMessage({ ok: true, result });
    parentPort.close();
  },
  (error) => {
    parentPort.postMessage({ ok: false, error: toProtocolError(error) });
    parentPort.close();
  }
);
