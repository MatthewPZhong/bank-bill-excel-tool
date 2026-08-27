'use strict';

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { RECON_FIX_RUN_JPM_ACTION } = require('./policies');

function recoveryPlanError(code, message) {
  return Object.assign(new Error(message), { code });
}

function failureForOutcome(outcome) {
  return outcome === 'committed'
    ? Object.freeze({
        code: 'RESULT_LOST',
        message: 'JPM ADM写回已提交但内存结果丢失，请重新加载后生成只读结果'
      })
    : Object.freeze({
        code: 'NOT_COMMITTED',
        message: 'JPM ADM写回未提交，任务已停止且不会自动重跑'
      });
}

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
      metadataPatch: {
        recoveryHold: ['INSPECTION_UNKNOWN', 'INSPECTOR_UNAVAILABLE'].includes(failureCode)
      }
    },
    safePayload: { reasonCode: failureCode }
  };
}

function exactTaskState(source, taskState) {
  if (!taskState || taskState.taskRunId !== source.taskRunId ||
      taskState.taskKey !== 'recon-id-fix:run' ||
      taskState.operationKey !== source.operationKey) {
    throw recoveryPlanError(
      'RECON_FIX_JPM_RECOVERY_TASK_IDENTITY_CONFLICT',
      'JPM recovery 持久 Task identity 不匹配'
    );
  }
  return taskState;
}

function ordinaryRunningTask(taskState) {
  return taskState.status === 'running' && taskState.recoveryMode === false &&
    taskState.recoveryAttemptId === null;
}

function inspectorUnavailableInterruption(source, taskState) {
  const current = exactTaskState(source, taskState);
  if (current.status === 'interrupted' && current.recoveryMode === false &&
      current.recoveryAttemptId === null) {
    return [];
  }
  if (!ordinaryRunningTask(current)) {
    throw recoveryPlanError(
      'RECON_FIX_JPM_RECOVERY_TASK_STATE_CONFLICT',
      'JPM INSPECTOR_UNAVAILABLE Hold 与持久 Task state 不兼容'
    );
  }
  return [interruptedTransition(
    source,
    'INSPECTOR_UNAVAILABLE',
    'JPM ADM写回 Inspector 暂不可用，任务进入恢复保留'
  )];
}

function definitiveHeldRecoveryTransitions(source, inspection, activeHold, taskState) {
  const current = exactTaskState(source, taskState);
  const prefix = activeHold.reasonCode === 'INSPECTOR_UNAVAILABLE'
    ? inspectorUnavailableInterruption(source, current)
    : [];
  if (prefix.length === 0 && (current.status !== 'interrupted' ||
      current.recoveryMode !== false || current.recoveryAttemptId !== null)) {
    throw recoveryPlanError(
      'RECON_FIX_JPM_RECOVERY_TASK_STATE_CONFLICT',
      'JPM definitive Hold recovery 要求合法 interrupted Task state'
    );
  }
  const failure = failureForOutcome(inspection.outcome);
  const recoveryAttemptId = `recon-jpm-recovery:${canonicalSha256([
    source.sourceKind,
    source.sourceRef,
    activeHold.holdId,
    inspection.outcome,
    inspection.evidenceHash
  ])}`;
  const base = {
    entityKind: 'task-run',
    actionKey: source.actionKey,
    expectedTaskKey: 'recon-id-fix:run',
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    recoveryAttemptId
  };
  return [...prefix, {
    transition: {
      ...base,
      command: 'begin-recovery',
      expectedState: 'interrupted',
      metadataPatch: {
        recoveryHold: true,
        recoveryOutcome: inspection.outcome
      }
    },
    safePayload: { outcome: inspection.outcome, phase: 'begin-definitive-recovery' }
  }, {
    transition: {
      ...base,
      command: 'complete-recovery-failure',
      expectedState: 'running',
      failureCode: failure.code,
      failureMessage: failure.message,
      metadataPatch: {
        recoveryHold: false,
        recoveryOutcome: inspection.outcome
      }
    },
    safePayload: { outcome: inspection.outcome, phase: 'complete-definitive-recovery' }
  }, {
    transition: {
      entityKind: 'recovery-hold',
      command: 'resolve',
      holdId: activeHold.holdId,
      expectedState: 'active',
      resolution: inspection.outcome === 'committed' ? 'committed' : 'not-committed',
      evidence: {
        inspectionEvidenceHash: inspection.evidenceHash,
        outcome: inspection.outcome
      }
    },
    safePayload: { outcome: inspection.outcome, phase: 'resolve-definitive-hold' }
  }];
}

function reconFixJpmRecoveryPlanTransitions({
  phase,
  source,
  inspection,
  activeHold = null,
  taskState = null
}) {
  if (!source || source.actionKey !== RECON_FIX_RUN_JPM_ACTION) return [];
  if (phase === 'inspection-unavailable-hold') {
    if (activeHold && activeHold.reasonCode !== 'INSPECTOR_UNAVAILABLE') return [];
    return inspectorUnavailableInterruption(source, taskState);
  }
  if (!inspection) return [];
  if (phase === 'inspection-hold' && inspection.outcome === 'unknown') {
    return [interruptedTransition(
      source,
      'INSPECTION_UNKNOWN',
      'JPM ADM写回结果无法唯一判定，任务进入人工恢复保留'
    )];
  }
  if (phase === 'inspection-result' && inspection.outcome === 'committed') {
    if (activeHold) {
      return definitiveHeldRecoveryTransitions(source, inspection, activeHold, taskState);
    }
    return [interruptedTransition(
      source,
      failureForOutcome(inspection.outcome).code,
      failureForOutcome(inspection.outcome).message
    )];
  }
  if (phase === 'inspection-result' && inspection.outcome === 'not-committed') {
    if (activeHold) {
      return definitiveHeldRecoveryTransitions(source, inspection, activeHold, taskState);
    }
    return [interruptedTransition(
      source,
      failureForOutcome(inspection.outcome).code,
      failureForOutcome(inspection.outcome).message
    )];
  }
  return [];
}

module.exports = {
  reconFixJpmRecoveryPlanTransitions
};
