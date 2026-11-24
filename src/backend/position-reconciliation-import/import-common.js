'use strict';

// 平盘导入进程各命令共用的小工具：连接参数、取消检查、范围版本号、暂存文件身份比对与侧库结构版本检查。

const fs = require('node:fs');

const {
  POSITION_SCHEMA_VERSION
} = require('../../main-process/position-reconciliation/constants');
const {
  PositionReconciliationError
} = require('../../main-process/position-reconciliation/common');
const {
  sourceSnapshotMatchesStat
} = require('../../main-process/archive-center/source-snapshot');
const {
  readIdentityStat
} = require('../../main-process/archive-center/filesystem-identity');

// 导入在独立进程里执行，写库缓存不必像主进程那样压到最低。
const IMPORT_CACHE_SIZE_KIB = 131072;
const IMPORT_MMAP_SIZE_BYTES = 268435456;

function cancelledError() {
  return new PositionReconciliationError('position-import-cancelled', '平盘导入已取消');
}

function assertNotCancelled(cancelToken) {
  if (cancelToken && cancelToken.cancelled) throw cancelledError();
}

function configureImportDatabase(db) {
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA busy_timeout=30000;');
  db.exec(`PRAGMA cache_size=-${IMPORT_CACHE_SIZE_KIB};`);
  db.exec(`PRAGMA mmap_size=${IMPORT_MMAP_SIZE_BYTES};`);
  db.exec('PRAGMA temp_store=FILE;');
  db.exec('PRAGMA journal_mode=WAL;');
}

// 侧库结构由 Main 的 store 建好；导入进程只核对结构版本，不做迁移，也不做整库扫描。
function assertPositionSchemaCurrent(db) {
  let version = null;
  try {
    const row = db.prepare(
      "SELECT value FROM position_meta WHERE key = 'position_schema_version'"
    ).get();
    version = Number(row && row.value);
  } catch (_error) {
    version = null;
  }
  if (version !== POSITION_SCHEMA_VERSION) {
    throw new PositionReconciliationError(
      'position-side-db-outdated',
      '平盘对账侧库结构版本与当前版本不一致，请重启软件后重试'
    );
  }
}

function bumpRevision(db, kind, key) {
  const row = db.prepare(`
    INSERT INTO position_revisions(kind, scope_key, revision, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(kind, scope_key) DO UPDATE SET
      revision = position_revisions.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    RETURNING revision
  `).get(kind, key);
  return Number(row && row.revision);
}

// 暂存文件在解析完成后、提交前只做一次身份快照比对（大小、时间、inode），不重读内容。
async function assertStagedFileUntouched(file) {
  let stat;
  try {
    stat = await readIdentityStat(fs, file.archivePath, 'stat');
  } catch (cause) {
    const error = new PositionReconciliationError(
      'position-staged-input-changed',
      `导入暂存文件在确认前发生变化：${file.fileName}`
    );
    error.cause = cause;
    throw error;
  }
  if (!sourceSnapshotMatchesStat(file.stagedSnapshot, stat)) {
    throw new PositionReconciliationError(
      'position-staged-input-changed',
      `导入暂存文件在确认前发生变化：${file.fileName}`
    );
  }
}

// 大事务的 WAL 在导入进程里就地回写，避免留给主进程下一次写入时同步回写而卡住界面。
function truncateWalAfterCommit(db) {
  try {
    db.exec('PRAGMA busy_timeout=2000;');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (_checkpointError) {
    // 回写失败不影响已提交的数据，交给后续自动 checkpoint。
  }
}

module.exports = {
  assertNotCancelled,
  assertPositionSchemaCurrent,
  assertStagedFileUntouched,
  bumpRevision,
  cancelledError,
  configureImportDatabase,
  truncateWalAfterCommit
};
