'use strict';

const { parentPort } = require('node:worker_threads');
const { startDuplicateWorker } = require('./worker-host');

if (!parentPort) throw new Error('Duplicate Worker需要worker_threads parentPort');

startDuplicateWorker(parentPort);
