'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { startDuplicateWorker } = require('./worker-host');

if (!parentPort) throw new Error('Duplicate Worker需要worker_threads parentPort');

startDuplicateWorker(parentPort, {
  serviceOptions: {
    startupGateDescriptor: workerData && workerData.startupGate
  }
});
