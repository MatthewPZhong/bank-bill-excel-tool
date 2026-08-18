'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  finalizePreFundTerminalIntent,
  preFundRunLineagePlan,
  preFundRunOutputIntent,
  recoverPreFundRunReceipts
} = require('../../../src/main-process/pre-fund-archive-lineage');

test('Pre-fund run lineage 精确冻结 Bank/MPT/Gateway producer，v0 不伪造 producer', () => {
  const plan = preFundRunLineagePlan({
    bankSession: {
      datasetId: 'bank-dataset',
      producerTaskRunId: 'bank-task',
      archiveContractVersion: 1
    },
    mptBatches: [{
      monthKey: '2026-07',
      id: 1,
      datasetId: 'mpt-legacy',
      producerTaskRunId: null,
      datasetVersion: 0,
      archiveContractVersion: 0
    }],
    gatewayTags: [{
      datasetId: 'gateway-v1',
      producerTaskRunId: 'gateway-task',
      sourceContractVersion: 1,
      rowCount: 2
    }, {
      datasetId: null,
      producerTaskRunId: null,
      sourceContractVersion: 0,
      rowCount: 1
    }]
  });

  assert.deepEqual(plan.lineageIntents.map((intent) => ({
    key: intent.lineageKey,
    role: intent.inputRole,
    version: intent.sourceContractVersion,
    producer: intent.producerTaskRunId
  })), [
    { key: 'bank-dataset', role: 'Bank', version: 1, producer: 'bank-task' },
    { key: 'mpt-legacy', role: 'MPT', version: 0, producer: null },
    { key: 'gateway-v1', role: 'Gateway', version: 1, producer: 'gateway-task' }
  ]);
  assert.equal(Object.isFrozen(plan.expectedDatasets.gatewayTags), true);
});

test('Pre-fund run-output lineage 使用不复用的主库 mirror id', () => {
  assert.deepEqual(
    preFundRunOutputIntent({ mirrorRunId: 41, archiveTaskRunId: 'task-41' }),
    {
      version: 1,
      kind: 'run-output',
      lineageKey: 'pre-fund:41',
      inputRole: 'Pre-fund Run',
      sourceContractVersion: 1,
      producerTaskRunId: 'task-41'
    }
  );
  assert.notEqual(
    preFundRunOutputIntent({ mirrorRunId: 41, archiveTaskRunId: 'task-41' }).lineageKey,
    preFundRunOutputIntent({ mirrorRunId: 42, archiveTaskRunId: 'task-42' }).lineageKey
  );
  assert.throws(
    () => preFundRunOutputIntent({ mirrorRunId: 41, archiveTaskRunId: '' }),
    /精确 mirror\/TaskRun identity/
  );
});

test('startup receipt owner 在 terminal/ack 前恢复镜像并耐久绑定 exact business run id', async () => {
  const calls = [];
  const receipt = {
    id: 1,
    monthKey: '2026-07',
    archiveTaskRunId: 'task-run-1',
    sideDbRelPath: 'run-data/pre-fund-reconciliation-results/month-2026-07.sqlite'
  };
  const service = {
    runStore: {
      listUnacknowledgedArchiveRuns: () => [receipt]
    },
    recoverRunMirror(value, options) {
      calls.push(['mirror', value.id, options.createIfMissing]);
      return { id: 91 };
    },
    acknowledgeRunByTaskRun(taskRunId) {
      calls.push(['ack', taskRunId]);
    }
  };
  const taskRun = {
    taskRunId: 'task-run-1',
    moduleId: 'pre-fund-reconciliation',
    taskKey: 'pre-fund-reconciliation:run',
    parentRunId: 'parent-1',
    status: 'interrupted'
  };
  const archiveService = {
    repository: { getTaskRun: () => taskRun },
    async beginTaskRunRecovery(taskRunId) {
      calls.push(['reopen', taskRunId]);
      return { ok: true };
    },
    async bindFlowAnchor(identity) {
      calls.push(['bind', identity]);
      return { ok: false };
    },
    async persistTaskFlowBindIntent(identity) {
      calls.push(['persist', identity]);
      return { ok: true };
    },
    async finishTaskRun(taskRunId, outcome) {
      calls.push(['finish', taskRunId, outcome]);
      return { ok: true };
    }
  };

  assert.deepEqual(await recoverPreFundRunReceipts({ service, archiveService }), { recovered: 1 });
  assert.deepEqual(calls.map((call) => call[0]), [
    'reopen', 'mirror', 'bind', 'persist', 'finish', 'ack'
  ]);
  assert.deepEqual(calls[2][1], {
    moduleId: 'pre-fund-reconciliation',
    identityType: 'business-run-id',
    identityValue: '91',
    parentRunId: 'parent-1',
    sourceTaskRunId: 'task-run-1'
  });
  assert.equal(calls[4][2].metadata.preFundRunLocator, 'pre-fund:91');
});

test('receipt 指向错误 TaskRun 时 fail-closed，不恢复镜像、不 ack', async () => {
  let mutated = false;
  const service = {
    runStore: {
      listUnacknowledgedArchiveRuns: () => [{ id: 1, archiveTaskRunId: 'wrong-task' }]
    },
    recoverRunMirror() { mutated = true; },
    acknowledgeRunByTaskRun() { mutated = true; }
  };
  const archiveService = {
    repository: {
      getTaskRun: () => ({
        taskRunId: 'wrong-task',
        moduleId: 'another-module',
        taskKey: 'pre-fund-reconciliation:run',
        status: 'running'
      })
    }
  };
  await assert.rejects(
    () => recoverPreFundRunReceipts({ service, archiveService }),
    (error) => error.blocksArchiveStartup === true && /身份不一致/.test(error.message)
  );
  assert.equal(mutated, false);
});

test('failed terminal outbox replay 对 Pre-fund receipt 无副作用', () => {
  let acknowledged = false;
  const result = finalizePreFundTerminalIntent({
    route: { route: 'pre-fund-run', taskRunId: 'task-run-1' },
    record: {
      payload: {
        owner: {
          kind: 'operation',
          operationContext: { taskRunId: 'task-run-1' }
        }
      }
    },
    terminalOutcome: { taskStatus: 'failed' },
    terminalResult: { taskRun: { status: 'failed' } },
    service: {
      acknowledgeRunByTaskRun() { acknowledged = true; }
    }
  });
  assert.equal(result, null);
  assert.equal(acknowledged, false);
});
