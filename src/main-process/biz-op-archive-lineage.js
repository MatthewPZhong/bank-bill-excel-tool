'use strict';

const datasetHeads = require('../backend/biz-op-recon-db/dataset-head-repository');

const BIZ_OP_MODULE_ID = 'biz-op-recon';
const BIZ_OP_RUN_TASK_KEY = 'bizOpRecon:run';

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function datasetLineageIntent(head, inputRole) {
  if (!head || !head.datasetId) {
    throw new Error(`Biz OP ${inputRole} dataset head 不存在`);
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

function bizOpRunLineagePlan(db, { date, buName }) {
  const t1 = datasetHeads.getHead(db, 'op', date, buName);
  const t2 = datasetHeads.getHead(db, 'op', previousDate(date), buName);
  const flow = datasetHeads.getHead(db, 'flow', date);
  return Object.freeze({
    lineageIntents: Object.freeze([
      datasetLineageIntent(t1, 'T-1 Biz OP'),
      datasetLineageIntent(t2, 'T-2 Biz OP'),
      datasetLineageIntent(flow, 'Biz Flow')
    ]),
    expectedDatasets: Object.freeze({
      t1DatasetId: t1.datasetId,
      t2DatasetId: t2.datasetId,
      flowDatasetId: flow.datasetId
    })
  });
}

function bizOpRunOutputIntent({ sideDbRelPath, sideRunId, archiveTaskRunId }) {
  const sourceContractVersion = archiveTaskRunId ? 1 : 0;
  const persistedRunPath = sideDbRelPath || 'legacy-main';
  return {
    version: 1,
    kind: 'run-output',
    lineageKey: `biz-op:${persistedRunPath}#${sideRunId}`,
    inputRole: 'Biz OP Run',
    sourceContractVersion,
    producerTaskRunId: sourceContractVersion === 1 ? archiveTaskRunId : null
  };
}

function bizOpRunTerminalRoute(taskRunId) {
  return Object.freeze({ route: 'biz-op-run', taskRunId });
}

function publicBizOpRun(run) {
  if (!run) return null;
  const {
    archive_contract_version: _archiveContractVersion,
    archive_task_run_id: _archiveTaskRunId,
    archive_terminal_ack_at: _archiveTerminalAckAt,
    ...publicRun
  } = run;
  return publicRun;
}

module.exports = {
  BIZ_OP_MODULE_ID,
  BIZ_OP_RUN_TASK_KEY,
  bizOpRunLineagePlan,
  bizOpRunOutputIntent,
  bizOpRunTerminalRoute,
  datasetLineageIntent,
  publicBizOpRun
};
