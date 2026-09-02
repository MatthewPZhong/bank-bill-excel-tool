'use strict';

const { workerData } = require('node:worker_threads');

const { startToolboxGenerationWorker } = require('../toolbox-background/worker-host');
const {
  ADMITTED_TOPOLOGY_WORKER_DATA_KEY
} = require('../background-execution/adapters/worker-thread-adapter');
const { VCC_EXPORT_SUBJECTS_ACTION } = require('./policies');
const { executeVccExportWriterGraph } = require('./writer-coordinator');

startToolboxGenerationWorker(
  VCC_EXPORT_SUBJECTS_ACTION,
  (input, signal) => executeVccExportWriterGraph(input, signal, {
    admittedTopology: workerData && workerData[ADMITTED_TOPOLOGY_WORKER_DATA_KEY]
  })
);
