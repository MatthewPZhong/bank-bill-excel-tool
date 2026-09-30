'use strict';
const activity = require('./background-execution/memory-activity');
const { runMemoryActivity, sealMemoryActivityInventory } = activity;

// 迁移入口的重型工作分别由真实 phase 管理。控制/取消/分页查询不被重型
// 屏障锁住；其他 IPC 默认视为增长未知，新增入口不会自动获得低内存并发资格。
function ipcOwnsAdmission(channel, args) {
  if (channel.startsWith('bizOpReconV327:')) return true;
  if (channel === 'toolbox:split:read') return args[0]?.version === 2;
  if (channel === 'toolbox:split:read-values' || channel === 'toolbox:split:cancel-read') return true;
  return channel === 'toolbox:split:export' && args[0]?.mode === 'rows';
}
function isControlIpc(channel) {
  return ['window:minimize', 'window:toggle-maximize', 'window:close', 'app:get-info',
    'app-update:get-status', 'app-update:set-enabled', 'app-update:check-now', 'app-update:restart-and-install'].includes(channel) ||
    /(?:^|:)(?:cancel|status|progress|heartbeat)(?:$|:)/.test(channel);
}
function registerWithMemoryActivity(ipcMain, register) {
  const original = ipcMain.handle;
  ipcMain.handle = function (channel, callback) {
    return original.call(this, channel, (event, ...args) => {
      if (ipcOwnsAdmission(channel, args) || isControlIpc(channel)) return callback(event, ...args);
      // IPC 返回值可能是数组、标量或领域对象。资源等待失败走现有 rejection
      // 通道，不制造统一 busy 对象破坏各入口的成功结果形状。
      return runMemoryActivity(() => callback(event, ...args));
    });
  };
  try { register(); sealMemoryActivityInventory(); } finally { ipcMain.handle = original; }
}

module.exports = { ...activity, registerWithMemoryActivity };
