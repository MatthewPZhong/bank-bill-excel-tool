'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { PRE_FUND_READ_ONLY_ACTION_SET } = require('./policies');
const { executePreFundReadOnlyExport } = require('./writer');

startReadOnlyExportWorker(PRE_FUND_READ_ONLY_ACTION_SET, executePreFundReadOnlyExport);
