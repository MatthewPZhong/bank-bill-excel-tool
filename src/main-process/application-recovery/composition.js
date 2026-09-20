'use strict';

const { createApplicationRecoveryCoordinator } = require('./coordinator');
const { createBizOpRecoveryParticipant } = require('../biz-op-v327/recovery-participant');

function createApplicationRecoveryComposition({ platform, bizOpModule, recoverPendingRuns,
  recoverLegacyBizOpRuns, recoverPreFundRuns, recoverPosition, recoverToolboxVccPublications,
  recoverVccImportTerminal, reconcileVccImportLineage, onBizOpRecovery }) {
  // 顺序是启动合同，不由模块加载或对象枚举顺序推断。
  const owners = [
    ['pending-runs', 'Pending runs', recoverPendingRuns],
    ['legacy-biz-op-runs', 'Biz OP runs', recoverLegacyBizOpRuns],
    ['pre-fund-runs', 'Pre-fund runs', recoverPreFundRuns],
    ['position', 'Position', recoverPosition],
    ['toolbox-vcc-publications', 'Toolbox/VCC output publications', recoverToolboxVccPublications],
    ['vcc-import-terminal', 'VCC import terminal', recoverVccImportTerminal]
  ];
  const coordinator = createApplicationRecoveryCoordinator({
    platform,
    participants: [
      createBizOpRecoveryParticipant({ module: bizOpModule, onRecovery: onBizOpRecovery }),
      ...owners.map(([id, ownerName, recoverOwner]) => ({ id, ownerName, recoverOwner, preflight: null, postOutbox: null })),
      { id: 'vcc-import-lineage', ownerName: 'VCC import lineage/hold reconcile',
        preflight: null, recoverOwner: null, postOutbox: reconcileVccImportLineage }
    ]
  });
  bizOpModule.recovery.bindPlatform(coordinator.platformFacade);
  return coordinator;
}

module.exports = { createApplicationRecoveryComposition };
