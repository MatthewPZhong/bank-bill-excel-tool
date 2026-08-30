'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { POSITION_READ_ONLY_ACTION_SET } = require('./policies');
const { executePositionReadOnlyExport } = require('./writer');

startReadOnlyExportWorker(POSITION_READ_ONLY_ACTION_SET, executePositionReadOnlyExport);
