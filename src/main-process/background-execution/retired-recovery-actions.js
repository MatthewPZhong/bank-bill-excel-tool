'use strict';

// v3.2.20 下线「业务OP数据核对」（BizOP v327）。旧版可能在恢复控制表中留下这些 action 的
//   active recovery hold（BizOP 恢复未完成时的保护）；新版已没有对应的 provider / inspector / TaskPolicy，
//   若照常参与启动扫描会以 STARTUP_RECOVERY_HOLD_SOURCE_MISSING / RECOVERY_HOLD_ACTION_UNBOUND 阻断启动。
// 处理口径（数据保留不动）：只读跳过——不改写、不删除这些记录；回退旧版安装包后由旧版继续恢复。
//   保留模块的 hold 按 conflictScopeKey 判定，与已下线 action 的作用域互不相交，不受影响。

const RETIRED_RECOVERY_ACTION_KEYS = Object.freeze([
  'biz-op-v327:import-candidate',
  'biz-op-v327:run-candidate',
  'biz-op-v327:delete-plan',
  'biz-op-v327:upgrade-preflight',
  'biz-op-v327:reclaim',
  'biz-op-v327:export-op-raw',
  'biz-op-v327:export-flow-raw',
  'biz-op-v327:export-op-check',
  'biz-op-v327:export-flow-check',
  'biz-op-v327:export-result-full',
  'biz-op-v327:export-result-diff',
  'biz-op-v327:export-errors'
]);
const RETIRED_SET = new Set(RETIRED_RECOVERY_ACTION_KEYS);

function isRetiredRecoveryAction(actionKey) {
  return RETIRED_SET.has(String(actionKey || ''));
}

function withoutRetiredRecoveryRecords(readRepository) {
  if (!readRepository || typeof readRepository.listActiveRecoveryHolds !== 'function'
      || typeof readRepository.listOpenCriticalIntents !== 'function') {
    throw new TypeError('withoutRetiredRecoveryRecords 需要 RecoveryControlReadRepository');
  }
  const wrapped = {};
  for (const [name, value] of Object.entries(readRepository)) {
    wrapped[name] = typeof value === 'function' ? value.bind(readRepository) : value;
  }
  wrapped.listActiveRecoveryHolds = () => readRepository.listActiveRecoveryHolds()
    .filter((hold) => !isRetiredRecoveryAction(hold && hold.actionKey));
  wrapped.listOpenCriticalIntents = () => readRepository.listOpenCriticalIntents()
    .filter((intent) => !isRetiredRecoveryAction(intent && intent.actionKey));
  return Object.freeze(wrapped);
}

module.exports = {
  RETIRED_RECOVERY_ACTION_KEYS,
  isRetiredRecoveryAction,
  withoutRetiredRecoveryRecords
};
