'use strict';

const { deriveReconFixJpmConflictScopeKey } = require('./jpm-conflict-scope');

function createReconFixJpmHoldGate(options = {}) {
  if (!options.recoveryHoldGate ||
      typeof options.recoveryHoldGate.assertNoRecoveryHold !== 'function') {
    throw new TypeError('ReconFix JPM Hold gate依赖不完整');
  }
  return Object.freeze({
    assertMutationAllowed() {
      return options.recoveryHoldGate.assertNoRecoveryHold({
        conflictScopeKey: deriveReconFixJpmConflictScopeKey()
      });
    }
  });
}

module.exports = {
  createReconFixJpmHoldGate
};
