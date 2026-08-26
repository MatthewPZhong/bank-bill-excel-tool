'use strict';

const { TOOLBOX_GENERATION_ACTIONS } = require('./generation-contract');
const { executeSplitGeneration } = require('./generation-core');
const { startToolboxGenerationWorker } = require('./worker-host');

startToolboxGenerationWorker(TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE, executeSplitGeneration);
