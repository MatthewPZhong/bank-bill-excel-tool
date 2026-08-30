'use strict';

const { parentPort } = require('node:worker_threads');
const { startBankBuWorker } = require('./worker-host');

if (!parentPort) throw new Error('BankBU Worker需要worker_threads parentPort');
startBankBuWorker(parentPort);
