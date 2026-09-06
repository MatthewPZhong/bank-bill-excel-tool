'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const recoveryAuthority = new AsyncLocalStorage();
const liveConnections = new Map();

function legacyMode(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='biz_op_v327_control'").get()) return 'DISABLED';
  const row = db.prepare('SELECT mode FROM biz_op_v327_control WHERE singleton=1').get();
  if (!row || !['DISABLED', 'MIGRATING', 'ACTIVE', 'RECOVERY_HOLD'].includes(row.mode)) throw retiredError();
  return row.mode;
}
function retiredError() {
  return Object.assign(new Error('业务 OP 已进入新版迁移或启用状态，请使用新版客户端；旧入口已停止写入'), { code: 'BIZOP_LEGACY_RETIRED' });
}
function assertLegacyDb(db) { if (legacyMode(db) !== 'DISABLED') throw retiredError(); }
function assertLegacyRecoveryClosed(userDataDir) {
  if (liveConnections.get(path.resolve(userDataDir))?.size) {
    throw Object.assign(new Error('旧业务 OP 恢复连接尚未实际关闭，已阻止清旧'), { code: 'BIZOP_LEGACY_CONNECTION_PENDING' });
  }
}
async function withLegacyRecovery(userDataDir, work) {
  assertLegacyRecoveryClosed(userDataDir);
  const result = await recoveryAuthority.run(path.resolve(userDataDir), work);
  assertLegacyRecoveryClosed(userDataDir);
  return result;
}
function trackLegacyConnection(userDataDir, db) {
  const root = path.resolve(userDataDir);
  if (recoveryAuthority.getStore() !== root) return;
  if (!liveConnections.has(root)) liveConnections.set(root, new Set());
  const connections = liveConnections.get(root); connections.add(db);
  const close = db.close;
  db.close = function () {
    const result = close.call(this);
    connections.delete(db); if (!connections.size) liveConnections.delete(root);
    return result;
  };
}
function assertLegacyPath(userDataDir) {
  if (recoveryAuthority.getStore() === path.resolve(userDataDir)) return;
  const databasePath = path.join(userDataDir, 'tool-data.sqlite');
  if (!fs.existsSync(databasePath)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { assertLegacyDb(db); } finally { db.close(); }
}
module.exports = { legacyMode, retiredError, assertLegacyDb, assertLegacyPath, withLegacyRecovery, trackLegacyConnection, assertLegacyRecoveryClosed };
