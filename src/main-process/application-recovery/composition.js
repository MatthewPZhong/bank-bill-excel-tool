'use strict';

const { createApplicationRecoveryCoordinator } = require('./coordinator');

const RECOVERY_PARTICIPANT_ORDER = Object.freeze([
  'platform-scan', 'pre-fund-runs', 'position', 'toolbox-vcc-publications',
  'vcc-import-terminal', 'vcc-import-lineage'
]);

// 启动预检阶段执行一次后台执行平台全量扫描（scanAndRecover），完成后才允许应用 ready。
// v3.2.20 业务OP数据核对下线前由 BizOP 恢复参与者在预检中触发（无 BizOP 未决来源时同样在预检完成）；
// 平台扫描本身与恢复预算、hold 判定规则不变。
function createPlatformScanParticipant() {
  let platformFacade = null;
  const participant = Object.freeze({
    id: 'platform-scan',
    ownerName: 'background-execution platform',
    hookName: 'Background execution platform scan',
    async preflight() {
      if (!platformFacade) {
        throw Object.assign(new Error('后台执行平台恢复入口尚未绑定'), {
          code: 'APPLICATION_RECOVERY_PLATFORM_NOT_BOUND'
        });
      }
      const summary = await platformFacade.scanAndRecover();
      return Object.freeze({
        ready: true,
        sourceCount: summary.sourceCount,
        activeHoldCount: summary.activeHoldCount
      });
    },
    recoverOwner: null,
    postOutbox: null
  });
  return {
    participant,
    bindPlatform(facade) {
      if (platformFacade || !facade || typeof facade.scanAndRecover !== 'function') {
        throw Object.assign(new TypeError('后台执行平台恢复入口只能绑定一次'), {
          code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID'
        });
      }
      platformFacade = facade;
    }
  };
}

// 以 preflight 函数身份登记绑定：G7 汇总与 coordinator 都会浅拷贝参与者对象，函数引用保持不变；
//   伪造的参与者拿不到登记过的 preflight，绑定时失败关闭。
const platformScanBindings = new WeakMap();

function createApplicationRecoveryParticipants({ recoverPreFundRuns, recoverPosition,
  recoverToolboxVccPublications, recoverVccImportTerminal, reconcileVccImportLineage }) {
  // 顺序是启动合同，不由模块加载或对象枚举顺序推断。
  const owners = [
    ['pre-fund-runs', 'Pre-fund runs', recoverPreFundRuns],
    ['position', 'Position', recoverPosition],
    ['toolbox-vcc-publications', 'Toolbox/VCC output publications', recoverToolboxVccPublications],
    ['vcc-import-terminal', 'VCC import terminal', recoverVccImportTerminal]
  ];
  const platformScan = createPlatformScanParticipant();
  platformScanBindings.set(platformScan.participant.preflight, platformScan.bindPlatform);
  return Object.freeze([
      platformScan.participant,
      ...owners.map(([id, ownerName, recoverOwner]) => ({ id, ownerName, recoverOwner, preflight: null, postOutbox: null })),
      { id: 'vcc-import-lineage', ownerName: 'VCC import lineage/hold reconcile',
        preflight: null, recoverOwner: null, postOutbox: reconcileVccImportLineage }
  ].map(Object.freeze));
}

function createApplicationRecoveryComposition(options) {
  const { platform } = options;
  const participants = options.participants || createApplicationRecoveryParticipants(options);
  if (!Array.isArray(participants) || participants.length !== RECOVERY_PARTICIPANT_ORDER.length
      || participants.some((entry, index) => entry.id !== RECOVERY_PARTICIPANT_ORDER[index])) {
    throw Object.assign(new TypeError('应用恢复参与者必须保持既定顺序与完整覆盖'), {
      code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID'
    });
  }
  const bindPlatform = participants[0] && platformScanBindings.get(participants[0].preflight);
  if (typeof bindPlatform !== 'function') {
    throw Object.assign(new TypeError('平台扫描参与者必须来自 createApplicationRecoveryParticipants'), {
      code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID'
    });
  }
  const coordinator = createApplicationRecoveryCoordinator({ platform, participants });
  bindPlatform(coordinator.platformFacade);
  return coordinator;
}

module.exports = {
  RECOVERY_PARTICIPANT_ORDER,
  createApplicationRecoveryParticipants,
  createApplicationRecoveryComposition
};
