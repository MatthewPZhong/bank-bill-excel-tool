'use strict';
const { legacyMode, retiredError } = require('../../backend/biz-op-legacy-guard');
// 注册过程同步完成；只包装旧命名空间，所有旧 pick/read/write 入口在回调前读当前模式。
function registerWithLegacyGuard(ipcMain, getDatabase, register) {
  const handle = ipcMain.handle;
  ipcMain.handle = function (channel, callback) {
    return handle.call(this, channel, channel.startsWith('bizOpRecon:') ? (...args) => {
      const db = getDatabase();
      if (db && legacyMode(db) !== 'DISABLED') {
        const error = retiredError(); return { status: 'error', code: error.code, message: error.message };
      }
      return callback(...args);
    } : callback);
  };
  try { return register(); } finally { ipcMain.handle = handle; }
}
module.exports = { registerWithLegacyGuard };
