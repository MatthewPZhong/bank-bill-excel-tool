'use strict';

const { startToolboxGenerationWorker } = require('../toolbox-background/worker-host');
const { VCC_EXPORT_SUBJECTS_ACTION } = require('./policies');
const { executeVccExportWriter } = require('./writer-core');

startToolboxGenerationWorker(
  VCC_EXPORT_SUBJECTS_ACTION,
  (input, signal) => executeVccExportWriter(input, signal, VCC_EXPORT_SUBJECTS_ACTION)
);
