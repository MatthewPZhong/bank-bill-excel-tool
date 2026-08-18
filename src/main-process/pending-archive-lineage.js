'use strict';

const monthRepository = require('../backend/pending-db/month-repository');
const removedRepository = require('../backend/pending-db/removed-repository');
const diffRepository = require('../backend/pending-db/diff-repository');

const PENDING_MODULE_ID = 'pending-reconciliation';
const PENDING_RUN_TASK_KEY = 'pending:reconcile:run';

function datasetLineageIntent(head, inputRole) {
  if (!head || !head.datasetId) {
    throw new Error(`Pending ${inputRole} dataset head 不存在`);
  }
  const sourceContractVersion = head.archiveContractVersion === 1 ? 1 : 0;
  return {
    version: 1,
    kind: 'dataset-input',
    lineageKey: head.datasetId,
    inputRole,
    sourceContractVersion,
    producerTaskRunId: sourceContractVersion === 1 ? head.producerTaskRunId : null
  };
}

function pendingRunLineagePlan(db, { upperMonth, lowerMonth }) {
  const upper = monthRepository.getMonthMeta(db, upperMonth);
  const lower = monthRepository.getMonthMeta(db, lowerMonth);
  const intents = [
    datasetLineageIntent(upper, 'Upper Pending'),
    datasetLineageIntent(lower, 'Lower Pending')
  ];
  const removed = removedRepository.getMonthHead(db, upperMonth);
  if (removed) intents.push(datasetLineageIntent(removed, 'Removed Pending'));
  return Object.freeze({
    lineageIntents: Object.freeze(intents),
    expectedDatasets: Object.freeze({
      upper: Object.freeze({ yearMonth: upperMonth, datasetId: upper.datasetId }),
      lower: Object.freeze({ yearMonth: lowerMonth, datasetId: lower.datasetId }),
      removedDatasetId: removed ? removed.datasetId : null
    })
  });
}

function runOutputLineageIntent(run) {
  if (!run) throw new Error('Pending run 不存在');
  const sourceContractVersion = run.archiveContractVersion === 1 ? 1 : 0;
  return {
    version: 1,
    kind: 'run-output',
    lineageKey: `pending:${run.id}`,
    inputRole: 'Pending Run',
    sourceContractVersion,
    producerTaskRunId: sourceContractVersion === 1 ? run.archiveTaskRunId : null
  };
}

function pendingAggregateRunSelection(db) {
  const runs = diffRepository.listLatestRunsByMonthPair(db);
  return Object.freeze({
    runIds: Object.freeze(runs.map((run) => run.id)),
    lineageIntents: Object.freeze(runs.map(runOutputLineageIntent))
  });
}

function publicPendingRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    upperMonth: run.upperMonth,
    lowerMonth: run.lowerMonth,
    ruleSnapshot: run.ruleSnapshot,
    createdAt: run.createdAt,
    statNew: run.statNew,
    statMissing: run.statMissing,
    statChanged: run.statChanged
  };
}

function pendingRunTerminalRoute(taskRunId) {
  return Object.freeze({ route: 'pending-run', taskRunId });
}

function acknowledgePendingRun(db, runId, taskRunId) {
  return diffRepository.acknowledgeArchiveTerminal(db, runId, taskRunId);
}

function acknowledgePendingRunByTaskRun(db, taskRunId) {
  const run = diffRepository.getRunByArchiveTaskRunId(db, taskRunId);
  if (!run) throw new Error('Pending TaskRun 对应的业务 run receipt 不存在');
  return acknowledgePendingRun(db, run.id, taskRunId);
}

function pendingRecoveryError(message) {
  const error = new Error(message);
  error.code = 'ARCHIVE_PENDING_RUN_RECOVERY_CONFLICT';
  error.blocksArchiveStartup = true;
  return error;
}

async function bindPendingRunFlow({ archiveService, taskRun, runId }) {
  const identity = {
    moduleId: PENDING_MODULE_ID,
    identityType: 'business-run-id',
    identityValue: String(runId),
    parentRunId: taskRun.parentRunId,
    sourceTaskRunId: taskRun.taskRunId
  };
  const bound = await archiveService.bindFlowAnchor(identity);
  if (bound && bound.ok !== false) return;
  const persisted = await archiveService.persistTaskFlowBindIntent(identity);
  if (!persisted || persisted.ok === false) {
    throw pendingRecoveryError(`Pending run #${runId} 的业务流程身份无法持久接管`);
  }
}

async function recoverPendingRunReceipts({ db, archiveService }) {
  const receipts = diffRepository.listUnacknowledgedArchiveRuns(db);
  let recovered = 0;
  for (const receipt of receipts) {
    const taskRun = archiveService.repository.getTaskRun(receipt.archiveTaskRunId);
    if (!taskRun
        || taskRun.moduleId !== PENDING_MODULE_ID
        || taskRun.taskKey !== PENDING_RUN_TASK_KEY) {
      throw pendingRecoveryError(`Pending run #${receipt.id} 的 Archive TaskRun 身份不一致`);
    }
    if (taskRun.status === 'interrupted') {
      const reopened = await archiveService.beginTaskRunRecovery(taskRun.taskRunId);
      if (!reopened || reopened.ok === false) {
        throw pendingRecoveryError(`Pending run #${receipt.id} 的 Archive TaskRun 无法恢复`);
      }
    } else if (taskRun.status !== 'running' && taskRun.status !== 'succeeded') {
      throw pendingRecoveryError(
        `Pending run #${receipt.id} 的 Archive TaskRun 已由 ${taskRun.status} 终结`
      );
    }
    await bindPendingRunFlow({ archiveService, taskRun, runId: receipt.id });
    if (taskRun.status !== 'succeeded') {
      const finished = await archiveService.finishTaskRun(taskRun.taskRunId, {
        taskStatus: 'succeeded',
        metadata: { pendingRunLocator: `pending:${receipt.id}` }
      });
      if (!finished || finished.ok === false) {
        throw pendingRecoveryError(`Pending run #${receipt.id} 的 Archive terminal 未完成`);
      }
    }
    acknowledgePendingRun(db, receipt.id, taskRun.taskRunId);
    recovered += 1;
  }
  return { recovered };
}

function finalizePendingTerminalIntent({ route, record, terminalOutcome, terminalResult, db }) {
  if (!route || route.route !== 'pending-run') {
    throw new Error(`不支持的 Pending terminal 路由：${route && route.route || '<empty>'}`);
  }
  const actualStatus = terminalResult && terminalResult.taskRun
    ? terminalResult.taskRun.status
    : terminalOutcome && terminalOutcome.taskStatus;
  if (actualStatus !== 'succeeded') return null;
  const owner = record && record.payload && record.payload.owner;
  const ownerTaskRunId = owner && owner.kind === 'operation'
    ? owner.operationContext && owner.operationContext.taskRunId
    : null;
  if (ownerTaskRunId !== route.taskRunId) {
    throw new Error('Pending terminal outbox owner 与 run receipt 不一致');
  }
  return acknowledgePendingRunByTaskRun(db, route.taskRunId);
}

module.exports = {
  PENDING_MODULE_ID,
  PENDING_RUN_TASK_KEY,
  acknowledgePendingRun,
  acknowledgePendingRunByTaskRun,
  datasetLineageIntent,
  finalizePendingTerminalIntent,
  pendingAggregateRunSelection,
  pendingRunLineagePlan,
  pendingRunTerminalRoute,
  publicPendingRun,
  recoverPendingRunReceipts,
  runOutputLineageIntent
};
