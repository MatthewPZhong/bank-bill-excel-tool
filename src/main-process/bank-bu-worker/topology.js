'use strict';

const { normalizeDualImportDescriptor } = require('./spool-contract');

function createBankBuDualTopologyPlanner(options = {}) {
  const availableParallelism = Number(options.availableParallelism);
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1) {
    throw new TypeError('BankBU topology需要正安全整数availableParallelism');
  }
  return function planBankBuTopology(request) {
    if (!request || request.actionKey !== 'bank-bu:import-month' ||
        !request.input || !request.input.dualParserImport || availableParallelism < 3) {
      return Object.freeze({ effectiveChildCount: 1 });
    }
    try { normalizeDualImportDescriptor(request.input.dualParserImport); } catch (_error) {
      return Object.freeze({ effectiveChildCount: 1 });
    }
    return Object.freeze({ effectiveChildCount: 2 });
  };
}

module.exports = { createBankBuDualTopologyPlanner };
