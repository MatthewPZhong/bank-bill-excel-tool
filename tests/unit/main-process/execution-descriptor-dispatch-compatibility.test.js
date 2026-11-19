'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBackgroundExecutionRuntime } = require('../../../src/main-process/execution-descriptors/composition');
const { baselineRuntimeOptions } = require('../../helpers/execution-descriptor-runtime-baseline');

// 只观察到达 adapter 的边界；替身不创建真实 worker，不读写业务文件。
// v3.2.20：业务OP数据核对下线，原「BizOP Main 授权存在时其他域缺本域派发 hook 一律拒绝」的混合门禁随之删除，
//   回到无 BizOP 授权时的路径；生产已启用 action 缺派发 hook 的拒绝由 runtime 自身保留。
async function probeDispatch({ actionKey = 'toolbox:merge', production = false,
  beforeCarrierDispatch } = {}) {
  const events = [];
  const runtime = createBackgroundExecutionRuntime(baselineRuntimeOptions({
    carrierClosureActionKeys: [actionKey],
    ...(beforeCarrierDispatch ? { beforeCarrierDispatch: (identity) => {
      events.push('hook');
      return beforeCarrierDispatch(identity);
    } } : {}),
    workerThreadAdapter: {
      start() {
        events.push('adapter');
        return {
          carrierKind: 'thread-single',
          ready: Promise.reject(Object.assign(new Error('测试已到达 adapter'), { code: 'PROBE_REACHED_ADAPTER' })),
          send() {}, close() {}, terminate() { return Promise.resolve(0); }
        };
      }
    }
  }));
  const policy = runtime.policyRegistry.get(actionKey);
  const operationKey = 'dispatch-compatibility-operation';
  let result;
  try {
    result = await runtime.execute({ actionKey, operationKey, production, input: {},
      context: { kind: 'operation', value: {
        taskRunId: 'dispatch-compatibility-task', taskKey: actionKey,
        moduleId: policy.moduleId, parentRunId: 'dispatch-compatibility-parent', operationKey
      } }
    }).then((outcome) => ({ errorCode: outcome.error && outcome.error.code }),
      (error) => ({ errorCode: error.code }));
    return { ...result, events, productionEnabled: policy.production.enabled };
  } finally {
    await runtime.shutdown();
  }
}

test('P3：非生产关闭观察未配置派发 hook 时保持到达 adapter 的旧行为', async () => {
  const observed = await probeDispatch();
  assert.equal(observed.productionEnabled, false);
  assert.equal(observed.errorCode, 'PROBE_REACHED_ADAPTER');
  assert.deepEqual(observed.events, ['adapter']);
});

test('P3：实际已启用的生产 action 缺少派发 hook 仍在 adapter 前拒绝', async () => {
  const observed = await probeDispatch({ actionKey: 'toolbox:split-rows', production: true });
  assert.equal(observed.productionEnabled, true, '本例不能被 production-disabled 提前拒绝遮挡');
  assert.equal(observed.errorCode, 'CARRIER_DISPATCH_BINDING_REQUIRED');
  assert.deepEqual(observed.events, []);
});

test('P3：生产与非生产已配置 hook 均先调用 hook 再进入 adapter', async (t) => {
  for (const production of [false, true]) {
    await t.test(`production=${production}`, async () => {
      const observed = await probeDispatch({ actionKey: 'toolbox:split-rows', production,
        beforeCarrierDispatch(identity) {
          assert.equal(identity.actionKey, 'toolbox:split-rows');
          assert.equal(identity.operationKey, 'dispatch-compatibility-operation');
        }
      });
      assert.equal(observed.errorCode, 'PROBE_REACHED_ADAPTER');
      assert.deepEqual(observed.events, ['hook', 'adapter']);
    });
  }
});

test('P3：真实 hook 抛出缺授权错误时不能被非生产兼容路径吞掉', async () => {
  const observed = await probeDispatch({ beforeCarrierDispatch() {
    throw Object.assign(new Error('本域拒绝派发'), { code: 'CARRIER_DISPATCH_BINDING_REQUIRED' });
  } });
  assert.equal(observed.errorCode, 'CARRIER_DISPATCH_BINDING_REQUIRED');
  assert.deepEqual(observed.events, ['hook']);
});
