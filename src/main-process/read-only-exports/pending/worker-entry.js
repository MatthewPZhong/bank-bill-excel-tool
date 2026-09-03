'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { PENDING_READ_ONLY_ACTION_SET } = require('./policies');
const { executePendingReadOnlyExport } = require('./writer');

startReadOnlyExportWorker(PENDING_READ_ONLY_ACTION_SET, executePendingReadOnlyExport);
