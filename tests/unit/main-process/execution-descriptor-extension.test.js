'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileExecutionDescriptors, passthroughInput } = require('../../../src/main-process/execution-descriptors/contract');
const { STATIC_REFERENCE_PATHS } = require('../../../src/main-process/background-execution/execution-policy-registry');
const { createExecutionSupervisor } = require('../../../src/main-process/background-execution/supervisor');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const canary = require('../../../src/main-process/background-execution/canary');

// 此 descriptor 只存在测试文件；生产 factory 列表和私有 authority 均不登记它。
function extensionDescriptor(actionKey, increment) {
  const policy = structuredClone(canary.pureComputePolicy);
  policy.actionKey = actionKey;
  policy.moduleId = 'descriptor-extension-fixture';
  policy.mode = 'inline-async';
  policy.entryKey = `executor.${actionKey}`;
  policy.result.validatorKey = `validator.${actionKey}`;
  policy.resources.profile = `resource.${actionKey}`;
  policy.resources.phase.workerThreadSlots = 0;
  const staticKeys = Object.fromEntries(STATIC_REFERENCE_PATHS.map(([field, bucket]) => {
    const value = field.split('.').reduce((current, key) => current && current[key], policy);
    return [bucket, value === null || value === undefined ? [] : [value]];
  }));
  return {
    schemaVersion: 1, moduleId: policy.moduleId, policies: [policy],
    entries: [{ key: policy.entryKey, value: async ({ input }) => ({ value: input.value + increment }) }],
    adapters: [], validators: [{ key: policy.result.validatorKey, value(result) {
      assert.equal(typeof result.value, 'number'); return true;
    } }], resourceProfiles: [], topologies: [],
    mainBindings: [{ actionKey, bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }],
    staticKeys, archivePolicies: [], taskAdapters: [], taskBindings: [], terminalRoutes: [], recoveryParticipants: []
  };
}

function nonProductionHarness(descriptors) {
  const compiled = compileExecutionDescriptors(descriptors, { generatedAt: '2026-08-25T00:00:00+08:00' });
  const supervisor = createExecutionSupervisor({
    policyRegistry: compiled.policyRegistry,
    bindInputForAction: compiled.bindInputForAction,
    beforeCarrierDispatch: compiled.beforeCarrierDispatch,
    defaultUnitsForAction: compiled.defaultUnitsForAction,
    resourceGovernor: createResourceGovernor({ budgets: {
      cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0,
      ioHeavySlots: 2, memoryBytes: 1024 ** 3
    } })
  });
  return { compiled, supervisor };
}

test('非生产 harness 仅新增 descriptor 即可执行新 action，无公共 runtime 分支', async () => {
  const first = extensionDescriptor('descriptor-test:first', 1);
  const second = extensionDescriptor('descriptor-test:second', 7);
  second.moduleId = 'descriptor-extension-second';
  const { compiled, supervisor } = nonProductionHarness([first, second]);
  try {
    for (const [index, source] of [first, second].entries()) {
      const actionKey = source.policies[0].actionKey;
      const outcome = await supervisor.execute({
        actionKey, operationKey: `extension-operation-${index}`,
        jobId: `extension-job-${index}`, workerInstanceId: `extension-worker-${index}`,
        input: { value: 10 }
      });
      assert.equal(outcome.outcome, 'completed');
      assert.deepEqual(outcome.result, { value: index === 0 ? 11 : 17 });
      assert.equal(compiled.policyRegistry.get(actionKey).production.enabled, false);
      assert.throws(() => compiled.policyRegistry.assertRunnable(actionKey, { production: true }),
        (error) => error.code === 'POLICY_PRODUCTION_DISABLED');
    }
  } finally {
    await supervisor.shutdown();
  }
});

test('生产装配的独立 authority/coverage 拒绝测试 descriptor，即便自报 production enabled', () => {
  const {
    composeExecutionDescriptors, validateProductionExecutionDescriptors
  } = require('../../../src/main-process/execution-descriptors/composition');
  const production = composeExecutionDescriptors({ availableParallelism: 4 });
  const testPolicy = extensionDescriptor('descriptor-test:unauthorized', 0).policies[0];
  const count = production.actionTaskBindingRegistry.summary.actionKeys.length;
  assert.equal(count, 67);
  assert.equal(production.actionTaskBindingRegistry.allowedTaskKeys(testPolicy.actionKey), undefined);
  for (const enabled of [false, true]) {
    testPolicy.production.enabled = enabled;
    assert.throws(() => validateProductionExecutionDescriptors({
      ...production, policies: [...production.policies, testPolicy]
    }), (error) => error.code === 'ACTION_COVERAGE_POLICY_ACTION_UNKNOWN'
      || error.code === 'ACTION_MANIFEST_POLICY_ACTION_UNKNOWN');
  }
  assert.throws(() => compileExecutionDescriptors([extensionDescriptor('descriptor-test:override', 0)], {
    productionOverride: true
  }), (error) => error.code === 'EXECUTION_DESCRIPTOR_INVALID');
});
