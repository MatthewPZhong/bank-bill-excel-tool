'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const {
  assertVccStorageContract,
  getVccStorageContractVersion,
  migrateVccStorageContractV3
} = require('./storage-contract');

// 由启动准入或持有维护互斥的协调器调用。迁移连接不交给业务使用。
function upgradeVccStorageFile(dbPath, { faultInjector } = {}) {
  if (!fs.existsSync(dbPath)) return { upgraded: false, fromVersion: 1, toVersion: 1 };
  let inspector = new DatabaseSync(dbPath, { readOnly: true });
  let version;
  try {
    version = getVccStorageContractVersion(inspector);
    if (version >= 2) assertVccStorageContract(inspector, version);
  } finally { inspector.close(); }
  if (version !== 2) return { upgraded: false, fromVersion: version, toVersion: version };

  const migrationDb = new DatabaseSync(dbPath);
  let result;
  let failure;
  try {
    migrationDb.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000; BEGIN IMMEDIATE');
    result = migrateVccStorageContractV3(migrationDb, { faultInjector });
    migrationDb.exec('COMMIT');
    if (faultInjector) faultInjector('after-commit');
  } catch (error) {
    failure = error;
    if (migrationDb.isTransaction) {
      try { migrationDb.exec('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
  } finally { migrationDb.close(); }

  // 函数注册不能由 SQL 回滚撤销。无论成功失败，都通过全新只读连接确认持久状态。
  inspector = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const persistedVersion = getVccStorageContractVersion(inspector);
    assertVccStorageContract(inspector, persistedVersion);
    if (failure) {
      failure.persistedContractVersion = persistedVersion;
      failure.migrationCommitted = persistedVersion === 3;
    } else if (persistedVersion !== 3) {
      throw new Error('VCC 迁移提交后未形成 v3');
    }
  } catch (error) {
    if (!failure) failure = error;
    else failure.verificationError = error;
  } finally { inspector.close(); }
  if (failure) throw failure;
  return result;
}

module.exports = { upgradeVccStorageFile };
