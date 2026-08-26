'use strict';

const { TOOLBOX_GENERATION_ACTIONS } = require('./generation-contract');
const { executeMergeGeneration } = require('./generation-core');
const { startToolboxGenerationWorker } = require('./worker-host');

startToolboxGenerationWorker(TOOLBOX_GENERATION_ACTIONS.MERGE, executeMergeGeneration);
