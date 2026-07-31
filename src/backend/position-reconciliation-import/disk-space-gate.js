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
  ledgerBytes = 0,
  safetyMarginBytes = POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES
}) {
  const normalizedKind = Object.prototype.hasOwnProperty.call(
    POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW,
    kind
  ) ? kind : 'source';
  const perRow = BigInt(POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW[normalizedKind]);
  const rows = BigInt(normalizeNonNegativeInteger(rowCount));
  const staged = BigInt(normalizeNonNegativeInteger(stagedBytes));
  const ledger = BigInt(normalizeNonNegativeInteger(ledgerBytes));
  const existing = existingStorageBytes(sideDbPath);
  const safety = BigInt(normalizeNonNegativeInteger(safetyMarginBytes));

  // The estimate intentionally counts current DB pages and staged artifacts again.
  // They are already allocated at apply time, but retaining this headroom covers
  // WAL/rollback growth, page splits and temporary SQLite structures.
  return {
    kind: normalizedKind,
    existingBytes: existing,
    stagedBytes: staged,
    ledgerBytes: ledger,
    rowBytes: rows * perRow,
    safetyMarginBytes: safety,
    requiredBytes: existing + staged + ledger + (rows * perRow) + safety
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
  assertPositionImportDiskSpace,
  availableStorageBytes,
  estimatePositionImportDiskBytes,
  existingStorageBytes
};
