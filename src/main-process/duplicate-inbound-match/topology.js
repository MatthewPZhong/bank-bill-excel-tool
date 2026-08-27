'use strict';

const { normalizePairedImportDescriptor } = require('./spool-contract');

function createDuplicatePairedTopologyPlanner(options = {}) {
  const availableParallelism = Number(options.availableParallelism);
  if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1) {
    throw new TypeError('Duplicate topology需要正安全整数availableParallelism');
  }
  return function planDuplicateTopology(request) {
    if (!request || request.actionKey !== 'duplicate:import' || request.unitCount !== 0 ||
        !request.input || !request.input.pairedImport || availableParallelism < 3) {
      return Object.freeze({ effectiveChildCount: 1 });
    }
    try {
      normalizePairedImportDescriptor(request.input.pairedImport);
    } catch (_error) {
      return Object.freeze({ effectiveChildCount: 1 });
    }
    return Object.freeze({ effectiveChildCount: 2 });
  };
}

module.exports = { createDuplicatePairedTopologyPlanner };
