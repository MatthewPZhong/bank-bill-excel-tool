'use strict';

const { canonicalJsonSnapshot } = require('./protocol-validator');
const { createActionManifest } = require('./action-manifest');
const { createCapabilityInventory, validateCapabilityInventory } = require('./capability-inventory');
const {
  createEffectiveProductionStrategySnapshot,
  validateEffectiveProductionStrategySnapshot
} = require('./production-strategy-snapshot');

// 私有批准快照来自固定 release 的旧 runtime，独立于候选 descriptor/catalog。
// 不接受调用方 override，也不随 manifest --write 重建；更新须单独记录批准来源及语义差量。
const approved = canonicalJsonSnapshot(require('./approved-execution-baseline.json'));

function validateApprovedExecutionPolicies(policies, { bindings }) {
  const manifest = createActionManifest({ bindings, policies });
  const capabilityInventory = createCapabilityInventory({ manifest, policies });
  // 一侧是固定批准数据，另一侧才由 candidate 推导，不能用 candidate 同时生成两侧。
  validateCapabilityInventory(approved.capabilityInventory, { manifest, policies });
  const productionStrategy = createEffectiveProductionStrategySnapshot({ capabilityInventory, policies });
  validateEffectiveProductionStrategySnapshot(approved.productionStrategy, { capabilityInventory, policies });
  return Object.freeze({ manifest, capabilityInventory, productionStrategy });
}

module.exports = { validateApprovedExecutionPolicies };
