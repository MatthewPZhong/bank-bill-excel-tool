'use strict';

const { ACTIONS, identity, hash, sameSource, fail } = require('./contracts');

function createBizOpRecoveryPlan({ catalog }) {
  const { db } = catalog;
  function taskState(source) {
    if (!source || !ACTIONS[source.actionKey]) return null;
    const task = catalog.task(source.taskRunId);
    if (!task) return null;
    return { ...task, recoveryMode: task.metadata.recoveryMode === true,
      recoveryAttemptId: task.metadata.recoveryAttemptId || null };
  }
  function plan({ phase, source, inspection, settlement, activeHold }) {
    if (!source || !ACTIONS[source.actionKey]) return [];
    const task = taskState(source);
    if (!task || task.taskKey !== ACTIONS[source.actionKey].taskKey || task.operationKey !== source.operationKey) {
      fail('BIZOP_RECOVERY_TASK_MISMATCH');
    }
    const finalization = db.prepare(`SELECT * FROM biz_op_v327_abort_finalizations WHERE source_kind=? AND source_ref=?`)
      .get(source.sourceKind, source.sourceRef);
    const complete = phase === 'settlement-result' && settlement && settlement.outcome === 'completed'
      || phase === 'inspection-result' && inspection && inspection.outcome === 'compensated' && finalization;
    const unknown = phase === 'inspection-hold' || phase === 'inspector-unavailable';
    const primary = ['OPERATION', 'RECLAIM'].includes(source.boundedEvidence.category);
    const transitions = [];
    const common = { ...identity(source), expectedTaskKey: task.taskKey };
    const wrap = (transition) => ({ transition, safePayload: { phase, outcome: inspection ? inspection.outcome : 'unknown' } });
    const batches = db.prepare('SELECT id,task_status FROM archive_batches WHERE task_run_id=? ORDER BY id').all(task.taskRunId);
    const overlays = new Map(db.prepare('SELECT * FROM background_execution_batch_recovery_states WHERE task_run_id=?')
      .all(task.taskRunId).map((item) => [item.batch_id, item]));
    if ((complete && primary || unknown) && ['prepared', 'running'].includes(task.status) && !task.recoveryMode) {
      transitions.push(wrap({ ...common, entityKind: 'task-run', command: 'mark-interrupted', expectedState: task.status,
        failureCode: 'BIZOP_RECOVERY_PENDING', failureMessage: '业务 OP 正在核验持久结果和载体关闭', metadataPatch: { recoveryHold: true } }));
      for (const batch of batches) {
        if (overlays.has(batch.id)) fail('BIZOP_BATCH_RECOVERY_CONFLICT');
        transitions.push(wrap({ ...common, entityKind: 'batch-overlay', command: 'mark-interrupted', batchId: batch.id,
          expectedState: null, failureCode: 'BIZOP_RECOVERY_PENDING', failureMessage: '业务 OP 正在核验持久结果和载体关闭' }));
      }
    }
    if (complete && primary && !['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      const attempt = task.recoveryMode ? task.recoveryAttemptId : `biz-op-v327:recovery:${hash([
        source.sourceRef, finalization ? finalization.finalization_ref : inspection.evidenceHash
      ])}`;
      if (!task.recoveryMode) {
        transitions.push(wrap({ ...common, entityKind: 'task-run', command: 'begin-recovery', recoveryAttemptId: attempt,
          expectedState: 'interrupted', metadataPatch: { recoveryHold: true } }));
      }
      transitions.push(wrap({ ...common, entityKind: 'task-run',
        command: finalization ? 'complete-recovery-failure' : 'complete-recovery-success', recoveryAttemptId: attempt,
        expectedState: 'running', ...(finalization ? { failureCode: 'BIZOP_NOT_COMMITTED',
          failureMessage: '业务 OP 未提交，已保留诊断并安全结束本次任务' } : {}),
        metadataPatch: { recoveryHold: false, recoveryMode: false } }));
      for (const batch of batches) {
        const overlay = overlays.get(batch.id);
        if (overlay && overlay.state === 'resolved') continue;
        if (!overlay || overlay.state === 'interrupted') {
          transitions.push(wrap({ ...common, entityKind: 'batch-overlay', command: 'begin-recovery',
            batchId: batch.id, expectedState: 'interrupted', recoveryAttemptId: attempt }));
        }
        transitions.push(wrap({ ...common, entityKind: 'batch-overlay', command: finalization ? 'resolve-failure' : 'resolve-success',
          batchId: batch.id, expectedState: 'recovering', recoveryAttemptId: attempt,
          finalOutcome: finalization ? 'failed' : 'succeeded' }));
      }
    }
    if (complete && activeHold) {
      if (!sameSource(source, activeHold)) fail('BIZOP_HOLD_OWNER_CHANGED');
      transitions.push(wrap({ entityKind: 'recovery-hold', command: 'resolve', holdId: activeHold.holdId,
        expectedState: 'active', resolution: finalization ? 'compensated' : 'committed',
        evidence: { inspectionEvidenceHash: inspection.evidenceHash, terminalVerified: true } }));
    }
    return transitions;
  }
  return { taskState, plan };
}

module.exports = { createBizOpRecoveryPlan };
