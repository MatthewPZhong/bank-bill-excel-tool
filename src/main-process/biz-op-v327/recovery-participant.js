'use strict';

function createBizOpRecoveryParticipant({ module, onRecovery = () => {} }) {
  return Object.freeze({
    id: 'biz-op-v327',
    ownerName: 'biz-op-v327',
    hookName: 'BizOP activation and recovery',
    async preflight() {
      const summary = await module.recovery.run({ initialPlatformOnly: true });
      if (summary.reason && summary.reason !== 'ARCHIVE_OWNER_PHASE_REQUIRED') {
        throw Object.assign(new Error('业务 OP 恢复预检未通过，已保留启动保护'), { code: summary.reason });
      }
      return summary;
    },
    async recoverOwner() {
      if (module.activation.needed()) await module.activation.run({ quiesceOnly: true });
      if (!module.activation.needed() && module.recovery.openObligations()) {
        const result = await module.recovery.run();
        onRecovery(result);
        return result;
      }
    },
    async postOutbox() {
      if (module.activation.needed()) return module.retryRecovery();
    }
  });
}

module.exports = { createBizOpRecoveryParticipant };
