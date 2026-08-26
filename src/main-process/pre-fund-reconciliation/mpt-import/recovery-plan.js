'use strict';

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');

const TASK_KEYS = Object.freeze({
  'pre-fund:mpt-import': 'pre-fund-reconciliation:import-mpt',
  'pre-fund:mpt-repair-import': 'pre-fund-reconciliation:mpt-errors:repair'
});

function createInterruptedTransitions(source, reasonCode) {
  const expectedTaskKey = TASK_KEYS[source.actionKey];
  const batchId = source.boundedEvidence.archiveBatchId;
  const parentOperationKey = source.boundedEvidence.parentOperationKey;
  if (!expectedTaskKey || !Number.isSafeInteger(batchId) || batchId < 1) return [];
  const failureMessage = reasonCode === 'RESULT_LOST'
    ? 'Writer已提交当前文件但结果回包丢失，任务进入恢复保留'
    : 'Writer提交结果无法唯一判定，任务进入恢复保留';
  return [
    {
      transition: {
        entityKind: 'task-run',
        command: 'mark-interrupted',
        actionKey: source.actionKey,
        expectedTaskKey,
        operationKey: parentOperationKey,
        taskRunId: source.taskRunId,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        expectedState: 'running',
        failureCode: reasonCode,
        failureMessage,
        metadataPatch: { recoveryHold: true }
      },
      safePayload: { reasonCode }
    },
    {
      transition: {
        entityKind: 'batch-overlay',
        command: 'mark-interrupted',
        actionKey: source.actionKey,
        expectedTaskKey,
        operationKey: parentOperationKey,
        batchId,
        taskRunId: source.taskRunId,
        expectedState: null,
        failureCode: reasonCode,
        failureMessage,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef
      },
      safePayload: { reasonCode }
    }
  ];
}

function createResultLostHold(source, holdId) {
  if (typeof holdId !== 'string' || !holdId) {
    throw new TypeError('PreFund RESULT_LOST recovery plan缺少Main-owned holdId');
  }
  const safeSummary = { reasonCode: 'RESULT_LOST', disposition: 'committed-result-lost' };
  return {
    transition: {
      entityKind: 'recovery-hold',
      command: 'create-or-get',
      input: {
        contractVersion: 1,
        holdId,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        intentId: source.intentId,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        conflictScopeKey: source.conflictScopeKey,
        reasonCode: 'RESULT_LOST',
        safeSummary,
        evidenceHash: canonicalSha256(safeSummary)
      }
    },
    safePayload: { reasonCode: 'RESULT_LOST' }
  };
}

function preFundMptRecoveryPlanTransitions({ phase, source, inspection, holdId }) {
  if (!source || !Object.hasOwn(TASK_KEYS, source.actionKey)) return [];
  if (phase === 'inspection-hold' && inspection &&
      ['unknown', 'partially-committed'].includes(inspection.outcome)) {
    return createInterruptedTransitions(source, inspection.outcome === 'unknown'
      ? 'INSPECTION_UNKNOWN'
      : 'PARTIALLY_COMMITTED');
  }
  if (phase === 'inspection-result' && inspection && inspection.outcome === 'committed') {
    return [
      createResultLostHold(source, holdId),
      ...createInterruptedTransitions(source, 'RESULT_LOST')
    ];
  }
  return [];
}

module.exports = {
  TASK_KEYS,
  preFundMptRecoveryPlanTransitions
};
