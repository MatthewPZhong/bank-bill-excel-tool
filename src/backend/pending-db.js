// Pending 模块独立 SQLite DB facade
// 文件：{userData}/tool-data-pending.sqlite（独立于主 tool-data.sqlite）
// 打开时自动跑 migrations（幂等）

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('./pending-db/migrations');

const PENDING_DB_FILENAME = 'tool-data-pending.sqlite';

function openPendingDb(userDataDir) {
  const dbPath = path.join(userDataDir, PENDING_DB_FILENAME);
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  return db;
}

module.exports = {
  openPendingDb,
  PENDING_DB_FILENAME,
};
