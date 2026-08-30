'use strict';

// JPM reads and may rewrite the complete ADM image, so a narrower row/scenario
// scope would permit an overlapping legacy mutation to bypass recovery.
const RECON_FIX_JPM_ADM_CONFLICT_SCOPE = 'recon-fix:adm-writeback';

function deriveReconFixJpmConflictScopeKey() {
  return RECON_FIX_JPM_ADM_CONFLICT_SCOPE;
}

module.exports = {
  RECON_FIX_JPM_ADM_CONFLICT_SCOPE,
  deriveReconFixJpmConflictScopeKey
};
