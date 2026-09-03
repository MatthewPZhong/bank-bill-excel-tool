'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { BIZ_OP_READ_ONLY_ACTION_SET } = require('./policies');
const { executeBizOpReadOnlyExport } = require('./writer');

startReadOnlyExportWorker(BIZ_OP_READ_ONLY_ACTION_SET, executeBizOpReadOnlyExport);
