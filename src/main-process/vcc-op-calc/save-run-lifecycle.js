'use strict';

const {
  VCC_OP_SAVE_RUN_ACTION_KEY,
  VccOpSaveRunContractError,
  normalizeOperationOwner
} = require('./save-run-contract');

const VCC_OP_SAVE_RUN_RECOVERY_REQUIRED_STATUS = 'recovery-required';

function isVccOpSaveRunRecoveryRequired(error) {
  return error instanceof VccOpSaveRunContractError
    && error.code === 'VCC_OP_SAVE_RUN_OUTCOME_UNKNOWN'
    && error.outcome === 'unknown'
    && error.recoveryRequired === true
    && error.preserveArchiveTaskRun === true
    && error.recoveryIdentity
    && error.recoveryIdentity.actionKey === VCC_OP_SAVE_RUN_ACTION_KEY;
}

// Renderer-safe result：只表达需要恢复，不外泄 receipt inspection boundedEvidence、
// snapshot hash、operation identity、文件名或路径。具体证据只留在 typed error seam。
function vccOpSaveRunRecoveryRequiredResult(error) {
  if (!isVccOpSaveRunRecoveryRequired(error)) {
    throw new TypeError('仅 VCC saveRun unknown outcome 可形成 recovery-required result');
  }
  return Object.freeze({
    status: VCC_OP_SAVE_RUN_RECOVERY_REQUIRED_STATUS,
    code: error.code,
    outcome: 'unknown',
    recoveryRequired: true,
    message: 'VCC 业务 OP 保存结果需要恢复检查'
  });
}

// E03-B 只收口当前真实 Task owner 的 interrupted 边界。C2 Critical Intent/Hold
// 尚未接入该 legacy action，因此本桥不创建 Hold、不注册 Inspector，也不宣称可自动恢复。
async function interruptVccOpSaveRunTask(options = {}) {
  const error = options.error;
  if (!isVccOpSaveRunRecoveryRequired(error)) {
    throw new TypeError('interruptVccOpSaveRunTask 需要 typed unknown outcome error');
  }
  const owner = normalizeOperationOwner(options.operationOwner);
  if (error.recoveryIdentity.operationKey !== owner.operationKey
      || error.recoveryIdentity.taskRunId !== owner.taskRunId) {
    throw new TypeError('unknown outcome identity 与当前 Main Task owner 不一致');
  }
  const archiveService = options.archiveService;
  if (!archiveService || typeof archiveService.finishTaskRun !== 'function') {
    throw new TypeError('VCC saveRun interrupted seam 需要 archiveService.finishTaskRun');
  }
  const interrupted = await archiveService.finishTaskRun(owner.taskRunId, {
    taskStatus: 'interrupted',
    code: error.code,
    message: 'VCC 业务 OP 保存结果需要恢复检查',
    metadata: {
      vccOpSaveRunRecoveryRequired: true,
      vccOpSaveRunUnknownReasonCode: /^[A-Z0-9_:-]{1,64}$/.test(String(
        error.boundedEvidence && error.boundedEvidence.reasonCode || ''
      ))
        ? error.boundedEvidence.reasonCode
        : 'VCC_OP_SAVE_RUN_OUTCOME_UNKNOWN'
    }
  });
  if (!interrupted || interrupted.ok === false) throw error;
  return vccOpSaveRunRecoveryRequiredResult(error);
}

module.exports = {
  VCC_OP_SAVE_RUN_RECOVERY_REQUIRED_STATUS,
  interruptVccOpSaveRunTask,
  isVccOpSaveRunRecoveryRequired,
  vccOpSaveRunRecoveryRequiredResult
};
