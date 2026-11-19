'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const canary = require(
  '../../../../src/main-process/background-execution/canary'
);
const {
  MATURE_ACTION_KEYS,
  MATURE_ACTION_PRODUCTION,
  createMatureActionAdapterBindings,
  isMatureActionProductionEnabled
} = require(
  '../../../../src/main-process/background-execution/mature-action-adapters'
);
const {
  createExecutionSupervisor
} = require('../../../../src/main-process/background-execution/supervisor');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  bindingSnapshot
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');

// v3.2.20：Pending / 业务OP / 收单的大表导入 mature binding 随模块下线删除，相关 engine 取消、回滚用例一并移除。

function compoundImportPolicy(commitKind = 'existing-critical-protocol') {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.actionKey = 'test:compound-import';
  policy.adapterKind = 'existing-dispatch';
  policy.adapterKey = 'adapter.test:compound-import';
  policy.entryKey = null;
  policy.mode = 'thread-pool';
  policy.resources.base = {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 5
  };
  policy.resources.phase = {
    cpuSlots: 1,
    workerThreadSlots: 1,
    utilityProcessSlots: 0,
    ioHeavySlots: 1,
    memoryBytes: 10
  };
  policy.resources.compound = {
    topologyKey: 'topology.test:compound-import',
    childrenMax: 4,
    childResource: {
      cpuSlots: 1,
      workerThreadSlots: 1,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 20
    }
  };
  policy.resources.lowMemoryBehavior = 'downgrade-to-single';
  policy.commit = {
    kind: commitKind,
    criticalIntent: false,
    receiptKind: 'existing-protocol',
    inspectorKey: 'inspector.test:compound-import',
    conflictScopeResolverKey: 'scope.test:compound-import',
    settlementKey: 'settlement.test:compound-import'
  };
  policy.production = {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 1,
    recoveryStatus: 'blocked',
    evidenceStatus: 'missing',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  };
  return policy;
}

function registryFor(policy, binding) {
  return Object.freeze({
    isFrozen() { return true; },
    assertRunnable(actionKey, options = {}) {
      assert.equal(actionKey, policy.actionKey);
      if (options.production === true && policy.production.enabled !== true) {
        const error = new Error('production disabled');
        error.code = 'POLICY_PRODUCTION_DISABLED';
        throw error;
      }
      return policy;
    },
    get(actionKey) {
      return actionKey === policy.actionKey ? policy : undefined;
    },
    getBinding(actionKey, fieldPath) {
      if (actionKey !== policy.actionKey) return undefined;
      if (fieldPath === 'adapterKey') return binding;
      if (fieldPath === 'result.validatorKey') return () => true;
      return undefined;
    },
    list() { return Object.freeze([policy]); }
  });
}

test('Toolbox generation/publisher/recovery 严格分层，recover 不触发 generation 或 publish', async () => {
  const calls = { generation: 0, publish: 0, recover: 0 };
  let recoveryRequest;
  const bindings = createMatureActionAdapterBindings({
    toolboxSplit: {
      dispatch(input) {
        calls.generation += 1;
        return { promise: Promise.resolve({ stagingPath: input.savePath }) };
      }
    },
    toolboxPublication: {
      publish(options) { calls.publish += 1; return Promise.resolve({ taskId: options.taskId }); },
      recover(options) { calls.recover += 1; recoveryRequest = options; return Promise.resolve({ recovered: [], deferred: [], skippedActive: [] }); }
    }
  });

  await bindings[MATURE_ACTION_KEYS.toolboxSplitLarge].dispatch({
    input: { op: 'exportFilter', savePath: '/tmp/staging.xlsx' }
  }).promise;
  await bindings[MATURE_ACTION_KEYS.toolboxPublish].dispatch({
    input: { lifecycleOperation: 'publish', options: { taskId: 'publish-1' } }
  });
  assert.deepEqual(calls, { generation: 1, publish: 1, recover: 0 });

  calls.generation = 0;
  calls.publish = 0;
  await bindings[MATURE_ACTION_KEYS.toolboxPublish].dispatch({
    input: { lifecycleOperation: 'recover', options: { reason: 'receipt-ack', taskIds: ['publish-1'],
      acknowledgedCommittedTaskIds: ['publish-1'], deferCommittedFinalization: true } }
  });
  assert.deepEqual(calls, { generation: 0, publish: 0, recover: 1 });
  assert.deepEqual(recoveryRequest, { reason: 'receipt-ack', taskIds: ['publish-1'],
    acknowledgedCommittedTaskIds: ['publish-1'], deferCommittedFinalization: true, onProgress: undefined });
});

test('Toolbox mature recovery 缺 facade 或请求自选 root/owner/capability 均在业务调用前拒绝', () => {
  let calls = 0;
  const make = (toolboxPublication) => createMatureActionAdapterBindings({ toolboxPublication })[MATURE_ACTION_KEYS.toolboxPublish];
  const absent = make({ publish() { calls += 1; } });
  assert.throws(() => absent.dispatch({ input: { lifecycleOperation: 'recover', options: { taskIds: ['p'] } } }),
    (error) => error.code === 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' && error.preserveTemporaryFiles === true);
  const controlled = make({ publish() { calls += 1; }, recover() { calls += 1; } });
  for (const options of [{ root: '/tmp/other' }, { userDataDir: '/tmp/other' }, { ownerId: 'other-owner' },
    { observation: { verifyScope: () => true, release() {} } }]) {
    assert.throws(() => controlled.dispatch({ input: { lifecycleOperation: 'recover', options } }),
      (error) => error.code === 'PUBLICATION_RECOVERY_GRANT_INVALID' && error.preserveTemporaryFiles === true);
  }
  assert.equal(calls, 0);
});

test('全部 mature action 机器可证 production=false，默认 IPC 仍直达既有 dispatcher', () => {
  assert.deepEqual(Object.keys(MATURE_ACTION_PRODUCTION).sort(), Object.values(MATURE_ACTION_KEYS).sort());
  for (const actionKey of Object.values(MATURE_ACTION_KEYS)) {
    assert.equal(MATURE_ACTION_PRODUCTION[actionKey], false);
    assert.equal(isMatureActionProductionEnabled(actionKey), false);
  }
  const taskBindings = bindingSnapshot();
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.toolboxSplitLarge], ['toolbox:split:export']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.toolboxPublish], ['toolbox:split:export']);
  assert.deepEqual(taskBindings[MATURE_ACTION_KEYS.positionImport], [
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:run:import-result',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:prepare-import'
  ]);
  const projectRoot = path.resolve(__dirname, '../../../..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src/main.js'), 'utf8');
  assert.match(mainSource, /dispatchLargeSplit\s*\(/);
  assert.doesNotMatch(mainSource, /createMatureActionAdapterBindings\s*\(/);
});

test('native existing-critical-protocol 仍 fail-closed，不借 main-settlement seam 扩张 Worker commit', async () => {
  const policy = compoundImportPolicy('existing-critical-protocol');
  policy.adapterKind = 'native';
  policy.adapterKey = null;
  policy.entryKey = 'native.entry';
  const supervisor = createExecutionSupervisor({
    policyRegistry: registryFor(policy, null),
    resourceGovernor: createResourceGovernor({
      budgets: {
        cpuSlots: 8,
        workerThreadSlots: 8,
        utilityProcessSlots: 0,
        ioHeavySlots: 8,
        memoryBytes: 1000
      }
    })
  });
  await assert.rejects(
    supervisor.execute({
      actionKey: policy.actionKey,
      operationKey: 'native-existing-critical-must-fail',
      jobId: 'native-existing-critical-must-fail-job',
      input: { files: ['a.xlsx'] }
    }),
    (error) => error.code === 'E02A_DURABLE_COMMIT_UNSUPPORTED'
  );
});
