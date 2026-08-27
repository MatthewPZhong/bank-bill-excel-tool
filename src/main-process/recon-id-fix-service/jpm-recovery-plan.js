'use strict';

const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

function interruptedTransition(source, failureCode, failureMessage) {
  return {
    transition: {
      entityKind: 'task-run',
      command: 'mark-interrupted',
      actionKey: source.actionKey,
      expectedTaskKey: 'recon-id-fix:run',
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      expectedState: 'running',
      failureCode,
      failureMessage,
      metadataPatch: { recoveryHold: failureCode === 'INSPECTION_UNKNOWN' }
    },
    safePayload: { reasonCode: failureCode }
  };
}

function reconFixJpmRecoveryPlanTransitions({ phase, source, inspection }) {
  if (!source || source.actionKey !== RECON_FIX_RUN_JPM_ACTION || !inspection) return [];
  if (phase === 'inspection-hold' && inspection.outcome === 'unknown') {
    return [interruptedTransition(
      source,
      'INSPECTION_UNKNOWN',
      'JPM ADM写回结果无法唯一判定，任务进入人工恢复保留'
    )];
  }
  if (phase === 'inspection-result' && inspection.outcome === 'committed') {
    return [interruptedTransition(
      source,
      'RESULT_LOST',
      'JPM ADM写回已提交但内存结果丢失，请重新加载后生成只读结果'
    )];
  }
  if (phase === 'inspection-result' && inspection.outcome === 'not-committed') {
    return [interruptedTransition(
      source,
      'NOT_COMMITTED',
      'JPM ADM写回未提交，任务已停止且不会自动重跑'
    )];
  }
  return [];
}

module.exports = {
  reconFixJpmRecoveryPlanTransitions
};
