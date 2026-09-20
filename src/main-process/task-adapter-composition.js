'use strict';

const { createTaskAdapterRegistry } = require('./task-adapters/registry');
const { createPassthroughTaskAdapter } = require('./task-adapters/passthrough');
const { createPositionTaskAdapter } = require('./position-reconciliation/task-adapter');
const { createToolboxTaskAdapter } = require('./toolbox-background/task-adapter');
const { createVccOutputTaskAdapter } = require('./vcc-financial-op-output/task-adapter');

// 只在 Main 启动期消费既有 policy 清单，生成每个 taskKey 的显式绑定。
// 领域依赖仅存在于此装配入口，通用 registry / scope / executor 不认识领域状态。
function createBusinessTaskAdapterRegistry({ policies, positionOwner, acknowledgeReceipts, reportArchiveFailure }) {
  const scopeAdapters = Object.freeze({
    'position-reconciliation-process': 'position-reconciliation',
    toolbox: 'toolbox',
    'vcc-financial-op': 'vcc-financial-op'
  });
  const taskBindings = policies.filter((policy) => policy.batchPolicy !== 'exclude').map((policy) => ({
    taskKey: policy.taskKey,
    adapterId: scopeAdapters[policy.scopeId] || 'passthrough'
  }));
  return createTaskAdapterRegistry({
    adapters: [
      createPassthroughTaskAdapter(),
      createPositionTaskAdapter({ owner: positionOwner, reportArchiveFailure }),
      createToolboxTaskAdapter({ acknowledgeReceipts }),
      createVccOutputTaskAdapter({ acknowledgeReceipts })
    ],
    taskBindings
  });
}

module.exports = { createBusinessTaskAdapterRegistry };
