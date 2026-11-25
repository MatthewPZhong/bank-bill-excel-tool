'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  PositionReconciliationError
} = require('../../main-process/position-reconciliation/common');

const POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
const POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW = Object.freeze({
  bank: 8192,
  account: 6144,
  source: 4096,
  maintenance: 2048
});

// 单遍导入在读文件之前不知道行数：按暂存文件大小估算侧库与 WAL 的增长。
// 倍数取自 100 万行样本的实测峰值（银行 173MB → 增长约 0.73GB，链接原始表 146MB → 增长约 2.5GB，
// 后者来源行与链接行各存一份且整批一个事务），向上取整留余量。
const POSITION_IMPORT_GROWTH_PER_STAGED_BYTE = Object.freeze({
  bank: 5,
  source: 18
});

function existingStorageBytes(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return [resolved, `${resolved}-wal`, `${resolved}-shm`].reduce(
    (total, candidate) => {
      try {
        return total + BigInt(fs.statSync(candidate).size);
      } catch (_error) {
        return total;
      }
    },
    0n
  );
}

function availableStorageBytes(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const stats = fs.statfsSync(path.dirname(resolved), { bigint: true });
  return stats.bavail * stats.bsize;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function estimatePositionImportDiskBytes({
  kind,
  sideDbPath,
  rowCount = 0,
  stagedBytes = 0,
  estimateGrowthFromStagedBytes = false,
  safetyMarginBytes = POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES
}) {
  const normalizedKind = Object.prototype.hasOwnProperty.call(
    POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW,
    kind
  ) ? kind : 'source';
  const perRow = BigInt(POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW[normalizedKind]);
  const rows = BigInt(normalizeNonNegativeInteger(rowCount));
  const staged = BigInt(normalizeNonNegativeInteger(stagedBytes));
  const existing = existingStorageBytes(sideDbPath);
  const safety = BigInt(normalizeNonNegativeInteger(safetyMarginBytes));
  const growthFactor = estimateGrowthFromStagedBytes === true
    ? BigInt(POSITION_IMPORT_GROWTH_PER_STAGED_BYTE[normalizedKind] || 0)
    : 0n;
  const rowBytes = (rows * perRow) + (staged * growthFactor);

  // The estimate intentionally counts current DB pages and staged artifacts again.
  // They are already allocated at apply time, but retaining this headroom covers
  // WAL/rollback growth, page splits and temporary SQLite structures.
  return {
    kind: normalizedKind,
    existingBytes: existing,
    stagedBytes: staged,
    rowBytes,
    safetyMarginBytes: safety,
    requiredBytes: existing + staged + rowBytes + safety
  };
}

function assertPositionImportDiskSpace(input = {}) {
  const estimate = estimatePositionImportDiskBytes(input);
  let available;
  try {
    available = input.availableBytes === undefined
      ? availableStorageBytes(input.sideDbPath)
      : BigInt(input.availableBytes);
  } catch (error) {
    throw new PositionReconciliationError(
      'position-import-disk-space-insufficient',
      '无法确认平盘导入可用磁盘空间，已停止写入',
      [error && error.message ? error.message : String(error)]
    );
  }
  if (available < estimate.requiredBytes) {
    throw new PositionReconciliationError(
      'position-import-disk-space-insufficient',
      '平盘导入可用磁盘空间不足，未修改现有数据',
      [
        `至少需要 ${estimate.requiredBytes.toString()} 字节`,
        `当前可用 ${available.toString()} 字节`
      ]
    );
  }
  return {
    ...estimate,
    availableBytes: available
  };
}

module.exports = {
  POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES,
  POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW,
  POSITION_IMPORT_GROWTH_PER_STAGED_BYTE,
  assertPositionImportDiskSpace,
  availableStorageBytes,
  estimatePositionImportDiskBytes,
  existingStorageBytes
};
