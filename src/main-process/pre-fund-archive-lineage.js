'use strict';

const PRE_FUND_MODULE_ID = 'pre-fund-reconciliation';
const PRE_FUND_RUN_TASK_KEY = 'pre-fund-reconciliation:run';

function datasetIntent({ datasetId, producerTaskRunId, archiveContractVersion }, inputRole) {
  if (typeof datasetId !== 'string' || !datasetId.trim()) {
    throw new Error(`前置资金 ${inputRole} dataset identity 不存在`);
  }
  const sourceContractVersion = archiveContractVersion === 1 ? 1 : 0;
  if (sourceContractVersion === 1
      && (typeof producerTaskRunId !== 'string' || !producerTaskRunId.trim())) {
    throw new Error(`前置资金 ${inputRole} v1 dataset 缺少 producer TaskRun`);
  }
  return {
    version: 1,
    kind: 'dataset-input',
    lineageKey: datasetId,
    inputRole,
    sourceContractVersion,
    producerTaskRunId: sourceContractVersion === 1 ? producerTaskRunId : null
  };
}

function gatewayTagKey(tag) {
  return JSON.stringify([
    tag.sourceContractVersion,
    tag.datasetId,
    tag.producerTaskRunId,
    tag.rowCount
  ]);
}

function freezeGatewayTags(tags) {
  return Object.freeze(tags.map((tag) => Object.freeze({
    datasetId: tag.datasetId,
    producerTaskRunId: tag.producerTaskRunId,
    sourceContractVersion: tag.sourceContractVersion === 1 ? 1 : 0,
    rowCount: Number(tag.rowCount)
  })).sort((left, right) => {
    const a = gatewayTagKey(left);
    const b = gatewayTagKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }));
}

function preFundRunLineagePlan({ bankSession, mptBatches, gatewayTags }) {
  if (!bankSession || bankSession.archiveContractVersion !== 1
      || typeof bankSession.datasetId !== 'string' || !bankSession.datasetId.trim()
      || typeof bankSession.producerTaskRunId !== 'string'
      || !bankSession.producerTaskRunId.trim()) {
    throw new Error('前置资金银行 session 缺少 v1 dataset identity');
  }
  const batches = Object.freeze(mptBatches.map((batch) => Object.freeze({
    monthKey: batch.monthKey,
    id: batch.id,
    datasetId: batch.datasetId,
    producerTaskRunId: batch.producerTaskRunId,
    datasetVersion: batch.datasetVersion,
    archiveContractVersion: batch.archiveContractVersion
  })));
  const frozenGatewayTags = freezeGatewayTags(gatewayTags);
  const intents = [datasetIntent(bankSession, 'Bank')];
  for (const batch of batches) intents.push(datasetIntent(batch, 'MPT'));
  for (const tag of frozenGatewayTags) {
    if (tag.sourceContractVersion !== 1) continue;
    intents.push(datasetIntent({
      datasetId: tag.datasetId,
      producerTaskRunId: tag.producerTaskRunId,
      archiveContractVersion: 1
    }, 'Gateway'));
  }
  return Object.freeze({
    lineageIntents: Object.freeze(intents),
    expectedDatasets: Object.freeze({
      bankDatasetId: bankSession.datasetId,
      mptBatches: batches,
      gatewayTags: frozenGatewayTags
    })
  });
}

function preFundRunOutputIntent(run) {
  if (!run
      || !Number.isSafeInteger(run.mirrorRunId) || run.mirrorRunId <= 0
      || typeof run.archiveTaskRunId !== 'string' || !run.archiveTaskRunId.trim()) {
    throw new Error('前置资金 run-output 缺少精确 mirror/TaskRun identity');
  }
  return {
    version: 1,
    kind: 'run-output',
    lineageKey: `pre-fund:${run.mirrorRunId}`,
    inputRole: 'Pre-fund Run',
    sourceContractVersion: 1,
    producerTaskRunId: run.archiveTaskRunId
  };
}

function preFundRunTerminalRoute(taskRunId) {
  return Object.freeze({ route: 'pre-fund-run', taskRunId });
}

async function preservePreFundRunOwnerAfterMirrorCompensationFailure({
  error,
  archiveService,
  taskRunId
}) {
  if (error.preserveArchiveTaskRun !== true) return false;
  const interrupted = await archiveService.finishTaskRun(taskRunId, {
    taskStatus: 'interrupted',
    code: error.code,
    message: error.message,
    metadata: { preFundRunReceiptPending: true }
  });
  if (interrupted.ok === false) throw error;
  return true;
}

function recoveryError(message) {
  const error = new Error(message);
  error.blocksArchiveStartup = true;
  return error;
}

async function bindPreFundRunFlow({ archiveService, taskRun, mirrorRunId }) {
  const identity = {
    moduleId: PRE_FUND_MODULE_ID,
    identityType: 'business-run-id',
    identityValue: String(mirrorRunId),
    parentRunId: taskRun.parentRunId,
    sourceTaskRunId: taskRun.taskRunId
  };
  const bound = await archiveService.bindFlowAnchor(identity);
  if (bound && bound.ok !== false) return;
  const persisted = await archiveService.persistTaskFlowBindIntent(identity);
  if (!persisted || persisted.ok === false) {
    throw recoveryError(`前置资金 run #${mirrorRunId} 的业务流程身份无法持久接管`);
  }
}

async function recoverPreFundRunReceipts({ service, archiveService }) {
  const receipts = service.runStore.listUnacknowledgedArchiveRuns();
  let recovered = 0;
  for (const receipt of receipts) {
    const taskRun = archiveService.repository.getTaskRun(receipt.archiveTaskRunId);
    if (!taskRun
        || taskRun.moduleId !== PRE_FUND_MODULE_ID
        || taskRun.taskKey !== PRE_FUND_RUN_TASK_KEY) {
      throw recoveryError(`前置资金 run #${receipt.id} 的 Archive TaskRun 身份不一致`);
    }
    if (taskRun.status === 'interrupted') {
      const reopened = await archiveService.beginTaskRunRecovery(taskRun.taskRunId);
      if (!reopened || reopened.ok === false) {
        throw recoveryError(`前置资金 run #${receipt.id} 的 Archive TaskRun 无法恢复`);
      }
    } else if (taskRun.status !== 'running' && taskRun.status !== 'succeeded') {
      throw recoveryError(
        `前置资金 run #${receipt.id} 的 Archive TaskRun 已由 ${taskRun.status} 终结`
      );
    }
    let mirror;
    try {
      mirror = service.recoverRunMirror(receipt, {
        createIfMissing: taskRun.status !== 'succeeded'
      });
    } catch (error) {
      throw recoveryError(error.message || String(error));
    }
    await bindPreFundRunFlow({ archiveService, taskRun, mirrorRunId: mirror.id });
    if (taskRun.status !== 'succeeded') {
      const finished = await archiveService.finishTaskRun(taskRun.taskRunId, {
        taskStatus: 'succeeded',
        metadata: {
          preFundRunLocator: `pre-fund:${mirror.id}`
        }
      });
      if (!finished || finished.ok === false) {
        throw recoveryError(`前置资金 run #${receipt.id} 的 Archive terminal 未完成`);
      }
    }
    service.acknowledgeRunByTaskRun(taskRun.taskRunId);
    recovered += 1;
  }
  return { recovered };
}

function finalizePreFundTerminalIntent({ route, record, terminalOutcome, terminalResult, service }) {
  if (!route || route.route !== 'pre-fund-run') {
    throw new Error(`不支持的前置资金 terminal 路由：${route && route.route || '<empty>'}`);
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
    throw new Error('前置资金 terminal outbox owner 与 run receipt 不一致');
  }
  return service.acknowledgeRunByTaskRun(route.taskRunId);
}

module.exports = {
  PRE_FUND_MODULE_ID,
  PRE_FUND_RUN_TASK_KEY,
  finalizePreFundTerminalIntent,
  freezeGatewayTags,
  gatewayTagKey,
  preFundRunLineagePlan,
  preFundRunOutputIntent,
  preFundRunTerminalRoute,
  preservePreFundRunOwnerAfterMirrorCompensationFailure,
  recoverPreFundRunReceipts
};
