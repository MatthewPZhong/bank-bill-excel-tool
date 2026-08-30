'use strict';

const path = require('node:path');

const STATEMENT_ENTRY_KEYS = Object.freeze([
  'executor.statement:import',
  'executor.statement:resolve-big-account',
  'executor.statement:resolve-manual-balance',
  'executor.statement:generate-current',
  'executor.statement:generate-all'
]);

function createStatementWorkerEntry(options = {}) {
  return Object.freeze({
    path: path.join(__dirname, 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['STATEMENT_IMPORT_CANCELLED']),
    ...(options.workerData === undefined ? {} : { workerData: options.workerData })
  });
}

function createStatementWorkerEntryRegistry(options = {}) {
  const entry = createStatementWorkerEntry(options);
  return Object.freeze(Object.fromEntries(STATEMENT_ENTRY_KEYS.map((key) => [key, entry])));
}

module.exports = {
  STATEMENT_ENTRY_KEYS,
  createStatementWorkerEntry,
  createStatementWorkerEntryRegistry
};
