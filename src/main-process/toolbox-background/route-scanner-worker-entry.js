'use strict';

const { TOOLBOX_GENERATION_ACTIONS } = require('./generation-contract');
const { executeMultiSplitGeneration } = require('./route-scanner-core');
const { startToolboxGenerationWorker } = require('./worker-host');

startToolboxGenerationWorker(
  TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
  executeMultiSplitGeneration
);
