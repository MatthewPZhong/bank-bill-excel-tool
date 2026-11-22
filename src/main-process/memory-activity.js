'use strict';
const activity = require('./background-execution/memory-activity');
const { runMemoryActivity, sealMemoryActivityInventory } = activity;

// 迁移入口的重型工作分别由真实 phase 管理。控制/取消/分页查询不被重型
// 屏障锁住；其他 IPC 默认视为增长未知，新增入口不会自动获得低内存并发资格。
function ipcOwnsAdmission(channel, args) {
  if (channel === 'toolbox:split:read') return args[0]?.version === 2;
  if (channel === 'toolbox:split:read-values' || channel === 'toolbox:split:cancel-read') return true;
  return channel === 'toolbox:split:export' && args[0]?.mode === 'rows';
}
function isControlIpc(channel, args) {
  // v3.2.21：拆分账单行管理窗口挂载时激活、释放时结束撤销会话（只改主进程内存中的会话、不读库），与取消同属控制操作：
  //   不能因低内存屏障被拒而让已关闭窗口的撤销令牌继续有效，也不能被屏障打乱激活顺序；同一通道的配置读取仍受观察。
  if (channel === 'template:get-bill-split-config') {
    const options = args[1];
    return Boolean(options) && typeof options === 'object'
      && ['endRestoreSession', 'activateRestoreSession'].some((key) => Object.prototype.hasOwnProperty.call(options, key));
  }
  return ['window:minimize', 'window:toggle-maximize', 'window:close', 'app:get-info',
    'app-update:get-status', 'app-update:set-enabled', 'app-update:check-now', 'app-update:restart-and-install'].includes(channel) ||
    /(?:^|:)(?:cancel|status|progress|heartbeat)(?:$|:)/.test(channel);
}
// v3.2.21：同一模板的拆分配置写入与行管理打开时的快照读取（openRestoreSession）按受理顺序串行执行。低内存屏障的等待
//   各自轮询、不保证先后：旧窗口已受理、仍在等屏障的写入可能晚于新窗口打开时的读取落库，新窗口的【返回】撤销快照便漏掉
//   该写入，撤销时把它一并删除（拆分写入不改模板代次，签名无法发现）。按模板排队后，快照读取总在此前受理的写入结算后进行。
const BILL_SPLIT_WRITE_CHANNELS = new Set([
  'template:save-bill-split-mappings', 'template:save-bill-split-row-count', 'template:save-bill-split-row',
  'template:delete-bill-split-row', 'template:save-bill-split-merge-group', 'template:clear-bill-split-merge-groups',
  'template:save-bill-split-amount-rules', 'template:save-bill-split-meta'
]);
function ipcOrderKey(channel, args) {
  let templateId;
  if (BILL_SPLIT_WRITE_CHANNELS.has(channel)) templateId = args[0]?.templateId;
  else if (channel === 'template:get-bill-split-config' && args[1] && typeof args[1] === 'object' && args[1].openRestoreSession === true) {
    templateId = args[0];
  }
  const id = Number(templateId);
  return Number.isInteger(id) && id > 0 ? `bill-split:${id}` : '';
}
const orderTails = new Map();
function runOrdered(key, task) {
  if (!key) return task();
  const previous = orderTails.get(key) || Promise.resolve();
  const current = previous.then(task);
  const tail = current.then(() => {}, () => {});
  orderTails.set(key, tail);
  tail.then(() => { if (orderTails.get(key) === tail) orderTails.delete(key); });
  return current;
}

function registerWithMemoryActivity(ipcMain, register) {
  const original = ipcMain.handle;
  ipcMain.handle = function (channel, callback) {
    return original.call(this, channel, (event, ...args) => {
      if (ipcOwnsAdmission(channel, args) || isControlIpc(channel, args)) return callback(event, ...args);
      // IPC 返回值可能是数组、标量或领域对象。资源等待失败走现有 rejection
      // 通道，不制造统一 busy 对象破坏各入口的成功结果形状。
      // 等待低内存屏障的超时从受理时起算：同一模板排队时，排在后面的请求不会在前序之后再各等满一轮超时
      const acceptedAt = Date.now();
      return runOrdered(ipcOrderKey(channel, args), () => runMemoryActivity(() => callback(event, ...args), { startedAt: acceptedAt }));
    });
  };
  try { register(); sealMemoryActivityInventory(); } finally { ipcMain.handle = original; }
}

module.exports = { ...activity, registerWithMemoryActivity };
