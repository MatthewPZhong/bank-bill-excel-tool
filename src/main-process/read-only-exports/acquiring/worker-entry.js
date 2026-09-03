'use strict';

const { startReadOnlyExportWorker } = require('../common/worker-host');
const { executeAcquiringExport } = require('./executor');
const { ACQUIRING_EXPORT_ACTIONS } = require('./policies');

startReadOnlyExportWorker(
  new Set([ACQUIRING_EXPORT_ACTIONS.REGENERATE]),
  executeAcquiringExport
);
