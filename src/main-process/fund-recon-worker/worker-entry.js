'use strict';

const { parentPort } = require('node:worker_threads');

const { startFundReconWorker } = require('./worker-host');

if (!parentPort) throw new Error('FundRecon Worker需要worker_threads parentPort');

startFundReconWorker(parentPort, {
  close() {
    parentPort.close();
  }
});
