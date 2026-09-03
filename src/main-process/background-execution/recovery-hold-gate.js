'use strict';

class RecoveryHoldActiveError extends Error {
  constructor(hold) {
    super('该业务范围存在未解决的恢复阻断，请先完成恢复或人工处理');
    this.name = 'RecoveryHoldActiveError';
    this.code = 'RECOVERY_HOLD_ACTIVE';
    this.holdId = hold.holdId;
    this.reasonCode = hold.reasonCode;
    this.conflictScopeKey = hold.conflictScopeKey;
  }
}

function createRecoveryHoldGate(readRepository) {
  if (!readRepository || typeof readRepository.getActiveRecoveryHoldByScope !== 'function') {
    throw new TypeError('RecoveryHoldGate 需要 RecoveryControlReadRepository');
  }
  return Object.freeze({
    assertNoRecoveryHold(input = {}) {
      if (typeof input.conflictScopeKey !== 'string' || input.conflictScopeKey.length === 0) {
        throw new TypeError('conflictScopeKey 不能为空');
      }
      const hold = readRepository.getActiveRecoveryHoldByScope(input.conflictScopeKey);
      if (hold) throw new RecoveryHoldActiveError(hold);
      return true;
    }
  });
}

module.exports = {
  RecoveryHoldActiveError,
  createRecoveryHoldGate
};
