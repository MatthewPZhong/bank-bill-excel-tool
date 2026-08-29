'use strict';

const {
  RecoveryHoldActiveError
} = require('../background-execution/recovery-hold-gate');
const { deriveReconFixJpmConflictScopeKey } = require('./jpm-conflict-scope');
const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

function createReconFixJpmHoldGate(options = {}) {
  if (!options.recoveryHoldGate ||
      typeof options.recoveryHoldGate.assertNoRecoveryHold !== 'function' ||
      !options.readRepository ||
      typeof options.readRepository.listActiveRecoveryHolds !== 'function' ||
      typeof options.readRepository.listCriticalIntentsByScope !== 'function' ||
      typeof options.readRepository.listOpenCriticalIntents !== 'function') {
    throw new TypeError('ReconFix JPM Hold gate依赖不完整');
  }
  const conflictScopeKey = deriveReconFixJpmConflictScopeKey();
  function assertMutationAllowed() {
    const actionHold = options.readRepository.listActiveRecoveryHolds()
      .find((hold) => hold.actionKey === RECON_FIX_RUN_JPM_ACTION);
    if (actionHold) throw new RecoveryHoldActiveError(actionHold);
    options.recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey });
    const lease = options.readRepository.listOpenCriticalIntents()
      .find((intent) => intent.actionKey === RECON_FIX_RUN_JPM_ACTION) ||
      options.readRepository.listCriticalIntentsByScope(conflictScopeKey)
        .find((intent) => intent.state !== 'closed');
    if (lease) {
      const error = new Error('ReconFix JPM ADM scope 已由 durable Critical Intent 持有');
      error.code = 'RECON_FIX_JPM_SCOPE_LEASE_HELD';
      throw error;
    }
    return true;
  }
  return Object.freeze({
    assertMutationAllowed,
    runSynchronousMutationBoundary(work) {
      if (typeof work !== 'function') {
        throw new TypeError('ReconFix JPM legacy mutation boundary 需要同步 work');
      }
      assertMutationAllowed();
      const result = work();
      if (result && typeof result.then === 'function') {
        const error = new TypeError('ReconFix JPM legacy mutation boundary 不接受异步 work');
        error.code = 'RECON_FIX_JPM_LEGACY_ASYNC_BOUNDARY_FORBIDDEN';
        throw error;
      }
      return result;
    }
  });
}

module.exports = {
  createReconFixJpmHoldGate
};
