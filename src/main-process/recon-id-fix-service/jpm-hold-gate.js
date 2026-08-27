'use strict';

const { deriveReconFixJpmConflictScopeKey } = require('./jpm-conflict-scope');

function createReconFixJpmHoldGate(options = {}) {
  if (!options.recoveryHoldGate ||
      typeof options.recoveryHoldGate.assertNoRecoveryHold !== 'function' ||
      !options.readRepository ||
      typeof options.readRepository.listCriticalIntentsByScope !== 'function') {
    throw new TypeError('ReconFix JPM Hold gate依赖不完整');
  }
  const conflictScopeKey = deriveReconFixJpmConflictScopeKey();
  function assertMutationAllowed() {
    options.recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey });
    const lease = options.readRepository.listCriticalIntentsByScope(conflictScopeKey)
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
