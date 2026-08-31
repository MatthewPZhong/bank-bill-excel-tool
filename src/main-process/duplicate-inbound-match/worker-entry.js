'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { startDuplicateWorker } = require('./worker-host');

if (!parentPort) throw new Error('Duplicate Worker需要worker_threads parentPort');

startDuplicateWorker(parentPort, {
  close() {
    parentPort.close();
  },
  serviceOptions: {
    startupGateDescriptor: workerData && workerData.startupGate
  }
});
