'use strict';

const { createApplicationRecoveryCoordinator } = require('./coordinator');
const { createBizOpRecoveryParticipant } = require('../biz-op-v327/recovery-participant');

const RECOVERY_PARTICIPANT_ORDER = Object.freeze([
  'biz-op-v327', 'pending-runs', 'legacy-biz-op-runs', 'pre-fund-runs',
  'position', 'toolbox-vcc-publications', 'vcc-import-terminal', 'vcc-import-lineage'
]);

function createApplicationRecoveryParticipants({ bizOpModule, recoverPendingRuns,
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
  return Object.freeze([
      createBizOpRecoveryParticipant({ module: bizOpModule, onRecovery: onBizOpRecovery }),
      ...owners.map(([id, ownerName, recoverOwner]) => ({ id, ownerName, recoverOwner, preflight: null, postOutbox: null })),
      { id: 'vcc-import-lineage', ownerName: 'VCC import lineage/hold reconcile',
        preflight: null, recoverOwner: null, postOutbox: reconcileVccImportLineage }
  ].map(Object.freeze));
}

function createApplicationRecoveryComposition(options) {
  const { platform, bizOpModule } = options;
  const participants = options.participants || createApplicationRecoveryParticipants(options);
  if (!Array.isArray(participants) || participants.length !== RECOVERY_PARTICIPANT_ORDER.length
      || participants.some((entry, index) => entry.id !== RECOVERY_PARTICIPANT_ORDER[index])) {
    throw Object.assign(new TypeError('应用恢复参与者必须保持既定顺序与完整覆盖'), {
      code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID'
    });
  }
  const coordinator = createApplicationRecoveryCoordinator({ platform, participants });
  bizOpModule.recovery.bindPlatform(coordinator.platformFacade);
  return coordinator;
}

module.exports = {
  RECOVERY_PARTICIPANT_ORDER,
  createApplicationRecoveryParticipants,
  createApplicationRecoveryComposition
};
