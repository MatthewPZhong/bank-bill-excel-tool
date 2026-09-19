'use strict';

const { ROWS_ACTION } = require('./contracts');
const { executeRowsGeneration } = require('./executor');
const { startToolboxGenerationWorker } = require('../toolbox-background/worker-host');

startToolboxGenerationWorker(ROWS_ACTION, executeRowsGeneration);
