'use strict';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const isPrimary = (source) => ['OPERATION', 'RECLAIM'].includes(source.boundedEvidence.category);
const matches = (status, outcome) => outcome === 'committed' ? status === 'succeeded' : ['failed', 'cancelled'].includes(status);

// p/s/t 是目录、结算和 Task 的固定别名。完成缓存不能隐藏提交/批次终态矛盾。
const NEEDS_RECOVERY_SQL = `p.phase!='CLOSED' OR s.state!='COMPLETE'
  OR t.status NOT IN ('succeeded','failed','cancelled')
  OR (p.action='RECLAIM' AND t.status!='succeeded')
  OR ((s.business_fact IN ('COMMITTED','PUBLISHED')
    OR EXISTS (SELECT 1 FROM biz_op_v327_receipts r WHERE r.task_run_id=p.task_run_id)) AND t.status!='succeeded')
  OR (EXISTS (SELECT 1 FROM biz_op_v327_abort_finalizations f
    WHERE f.source_kind=s.source_kind AND f.source_ref=s.source_ref) AND t.status='succeeded')
  OR EXISTS (SELECT 1 FROM archive_batches b
    LEFT JOIN background_execution_batch_recovery_states o ON o.batch_id=b.id
    WHERE b.task_run_id=p.task_run_id AND (o.state IS NOT NULL AND o.state!='resolved'
      OR COALESCE(o.final_outcome,b.task_status) NOT IN ('succeeded','failed','cancelled')
      OR (t.status='succeeded')!=(COALESCE(o.final_outcome,b.task_status)='succeeded')))`;

function taskAlignment(catalog, source, outcome) {
  const task = catalog.task(source.taskRunId);
  const state = { taskStatus: task?.status || 'missing', conflict: null, pendingBatches: 0, complete: false };
  if (!task || !['committed', 'compensated'].includes(outcome)) return state;
  if (!isPrimary(source)) return { ...state, complete: TERMINAL.has(task.status) };
  if (TERMINAL.has(task.status) && !matches(task.status, outcome)) state.conflict = 'TASK_RESULT_CONFLICT';
  for (const batch of catalog.db.prepare(`SELECT b.task_status,o.state,o.final_outcome,o.source_kind,o.source_ref
    FROM archive_batches b LEFT JOIN background_execution_batch_recovery_states o ON o.batch_id=b.id
    WHERE b.task_run_id=?`).iterate(source.taskRunId)) {
    if (batch.state && (batch.source_kind !== source.sourceKind || batch.source_ref !== source.sourceRef)) {
      state.conflict ||= 'BATCH_SOURCE_CONFLICT';
    }
    if (batch.state && batch.state !== 'resolved') { state.pendingBatches += 1; continue; }
    const actual = batch.state === 'resolved' ? batch.final_outcome : batch.task_status;
    if (!TERMINAL.has(actual)) state.pendingBatches += 1;
    else if (!matches(actual, outcome)) state.conflict ||= 'BATCH_RESULT_CONFLICT';
  }
  state.complete = TERMINAL.has(task.status) && !state.conflict && state.pendingBatches === 0;
  return state;
}

module.exports = { NEEDS_RECOVERY_SQL, TERMINAL, isPrimary, taskAlignment };
