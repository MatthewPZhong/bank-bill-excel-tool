'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET } = require('./policies');
const { executeVccFinancialOpReadOnlyExport } = require('./writer');

startReadOnlyExportWorker(
  VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET,
  executeVccFinancialOpReadOnlyExport
);
