'use strict';

const { startToolboxGenerationWorker } = require('../toolbox-background/worker-host');
const { VCC_EXPORT_SINGLE_ACTION } = require('./policies');
const { executeVccExportWriter } = require('./writer-core');

startToolboxGenerationWorker(
  VCC_EXPORT_SINGLE_ACTION,
  (input, signal) => executeVccExportWriter(input, signal, VCC_EXPORT_SINGLE_ACTION)
);
