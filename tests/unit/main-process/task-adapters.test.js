'use strict';

// 通过实际 Main 公共函数和真实 adapter 验证迁移合同，lifecycle/domain owner 使用边界夹具。
// deferred/legacy Position 是兼容能力夹具，不代表当前存在这些生产 taskKey。
const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskPolicyRegistry } = require('../../../src/main-process/archive-center/task-policy-registry');
const { createArchiveAwareOperationHarness } = require('../../helpers/archive-aware-operation-harness');

const positionFile = createTaskPolicyRegistry().require('position-reconciliation:bank:export');
const cases = [
  { name: 'eager', channel: positionFile.channel, method: 'runFileTask' },
  { name: 'deferred 兼容能力', channel: positionFile.channel, method: 'runDeferredFileTask',
    policy: { ...positionFile, allocation: 'deferred' } },
  { name: 'no-file', channel: 'position-reconciliation:run', method: 'runOperationOnly' },
  { name: 'legacy 兼容能力', channel: positionFile.channel, method: 'run', legacy: true }
];

for (const scenario of cases) {
  for (const explicit of [false, true]) {
    test(`Position ${scenario.name} 保留 ${explicit ? '显式 prepared' : '生成 token'} 身份优先级`, async () => {
      const prepared = {
        proceed: true,
        ...(scenario.legacy ? { legacyExistingBatchRecovery: true, recovery: { batchId: 17 } } : {}),
        ...(explicit ? { taskRunId: 'prepared-task', operationKey: 'prepared-operation' } : {})
      };
      const harness = createArchiveAwareOperationHarness({
        ...scenario,
        runLifecycle: async () => ({ status: 'busy' })
      });
      await harness.run({ prepare: () => prepared, execute: () => assert.fail('仅检查传给生命周期的身份') });
      const { method, input } = harness.lifecycleOptions[0];
      assert.equal(method, scenario.method);
      assert.equal(input.taskRunId, explicit ? 'prepared-task' : 'position-token-fixture');
      assert.equal(input.operationKey, explicit ? 'prepared-operation'
        : `position:position-token-fixture:${scenario.channel}`);
      assert.equal(input.afterTerminalIntent.route, 'position-reconciliation');
      assert.equal(input.afterTerminalIntent.operationToken, 'position-token-fixture');
      if (scenario.legacy) {
        assert.equal(input.recovery, prepared.recovery);
        assert.equal(input.filePlanResolver, null);
      }
      assert.equal(harness.counts.business, 0);
    });
  }
}

test('普通任务直接透传 prepared hooks、身份和 args，不调用 Position admission', async () => {
  const afterTerminal = () => {};
  const afterTerminalIntent = { route: 'pending-run', taskRunId: 'prepared-task' };
  const args = [{ id: 8 }];
  const harness = createArchiveAwareOperationHarness({ runLifecycle: async () => ({ status: 'busy' }) });
  await harness.run({
    prepare: () => ({ proceed: true, args, afterTerminal, afterTerminalIntent,
      taskRunId: 'prepared-task', operationKey: 'prepared-operation' }),
    execute: () => assert.fail('仅检查接线')
  });
  const input = harness.lifecycleOptions[0].input;
  assert.equal(input.afterTerminal, afterTerminal);
  assert.equal(input.afterTerminalIntent, afterTerminalIntent);
  assert.equal(input.args, args);
  assert.equal(input.taskRunId, 'prepared-task');
  assert.equal(input.operationKey, 'prepared-operation');
  assert.equal(harness.counts.admission, 0);
});

test('Position finalizer 先执行，prepared afterTerminal 后执行；第一步失败不继续', async () => {
  const order = [];
  const error = new Error('pending owner 不匹配');
  let rejectFinalizer = false;
  const harness = createArchiveAwareOperationHarness({
    channel: 'position-reconciliation:run',
    bindings: { finalizePositionPendingAfterTaskTerminal: async () => {
      order.push('position');
      if (rejectFinalizer) throw error;
    } },
    runLifecycle: async () => ({ status: 'busy' })
  });
  await harness.run({ prepare: () => ({ proceed: true, afterTerminal: () => order.push('prepared') }),
    execute: () => assert.fail('仅检查接线') });
  const hook = harness.lifecycleOptions[0].input.afterTerminal;
  await hook({});
  assert.deepEqual(order, ['position', 'prepared']);
  rejectFinalizer = true;
  await assert.rejects(hook({}), (actual) => actual === error);
  assert.deepEqual(order, ['position', 'prepared', 'position']);
});

for (const channel of ['toolbox:merge', 'toolbox:split:export',
  'vccFinancialOp:data-manager:export', 'vccFinancialOp:export:import-audit', 'vccFinancialOp:export:result']) {
  test(`${channel} receipt hook 优先于 prepared hook，并保留空 toolbox 数组优先级`, async () => {
    const acknowledgements = [];
    const harness = createArchiveAwareOperationHarness({ channel,
      runLifecycle: async () => ({ status: 'busy' }),
      bindings: { acknowledgeToolboxPublicationReceipts: (ids) => acknowledgements.push(ids) }
    });
    const toolboxIds = [];
    await harness.run({ prepare: () => ({ proceed: true,
      toolboxPublicationTaskIds: toolboxIds, vccOutputPublicationTaskIds: ['vcc-id'],
      afterTerminal: () => assert.fail('publication-only 不调用 prepared hook') }),
    execute: () => assert.fail('仅检查接线') });
    await harness.lifecycleOptions[0].input.afterTerminal({});
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0], toolboxIds);
  });
}

test('其他 publication-only 领域仍透传 prepared hook，不扩大公共 receipt 确认范围', async () => {
  const afterTerminal = () => {};
  const harness = createArchiveAwareOperationHarness({ channel: 'pending:error:export-report',
    runLifecycle: async () => ({ status: 'busy' }) });
  await harness.run({ prepare: () => ({ proceed: true, afterTerminal }), execute: () => {} });
  assert.equal(harness.lifecycleOptions[0].input.afterTerminal, afterTerminal);
});

for (const durable of [true, false]) {
  test(`Position manifest durable=${durable} 时保持结果及清理边界`, async () => {
    const harness = createArchiveAwareOperationHarness({ channel: positionFile.channel,
      controls: { fileEvidence: { filePlan: { inputs: [], outputs: [] } },
        settleArtifacts: async () => ({ durable }) }
    });
    const result = { status: 'ok', cleanupPaths: ['/受管暂存/fixture'] };
    let abandon = 0;
    assert.equal(await harness.run({ prepare: () => ({ proceed: true, onAbandon: () => { abandon += 1; } }),
      execute: () => result }), result);
    const names = harness.calls.filter((call) => call && call.name).map((call) => call.name);
    assert.deepEqual(names, durable
      ? ['position-intent', 'position-outcome', 'position-durable', 'position-cleanup', 'position-finalize']
      : ['position-intent', 'position-outcome', 'position-incomplete', 'position-finalize']);
    assert.equal(abandon, 0);
  });
}

test('Position current wrapper 业务与 settlement 双异常保留 settlement 优先，通用 abandon 不接管', async () => {
  const businessError = new Error('业务失败');
  const settlementError = new Error('manifest settlement 失败');
  let abandon = 0;
  const harness = createArchiveAwareOperationHarness({ channel: positionFile.channel,
    controls: { fileEvidence: { filePlan: { inputs: [], outputs: [] } },
      settleArtifacts: async () => { throw settlementError; } }
  });
  await assert.rejects(harness.run({ prepare: () => ({ proceed: true, onAbandon: () => { abandon += 1; } }),
    execute: () => { throw businessError; } }), (actual) => actual === settlementError);
  assert.equal(abandon, 0);
  assert.equal(harness.calls.some((call) => call && call.name === 'position-cleanup'), false);
});
