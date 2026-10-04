'use strict';
const { hasLegacyMemoryActivity } = require('../memory-activity');

const PUBLICATION_MEMORY_ACTION = 'publication:shared-io';
const PUBLICATION_RESOURCES = Object.freeze({ cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
  // 兼容路径沿用共享 Publisher 原有的零内存记账；真实载体仍按未知增长观察。
  // 获批档位由 memory policy 替换为 publication-io 阶段预算。
  ioHeavySlots: 1, memoryBytes: 0 });

function createPublicationMemoryAdmission(getRuntime) {
  return async function acquirePublicationMemory() {
    // legacy IPC 已按增长未知的重型活动观察；保留原路径的资源合同。
    // 在它的阶段里再申请低档会自等待，也会误放宽未迁移 action。
    if (hasLegacyMemoryActivity()) return null;
    return getRuntime().resourceGovernor.acquirePhaseLease({ ownerKey: 'publication:shared-io',
      actionKey: PUBLICATION_MEMORY_ACTION, operationKey: 'publication:shared-io',
      resources: PUBLICATION_RESOURCES, timeoutMs: 5000, lowMemoryBehavior: 'queue' });
  };
}
module.exports = { createPublicationMemoryAdmission, PUBLICATION_MEMORY_ACTION };
