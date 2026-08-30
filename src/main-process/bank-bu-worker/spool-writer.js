'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const { fsyncDirectory } = require('../background-execution/durable-file');
const { readPendingGuanliFile, readBankFile } = require('../../backend/bank-bu-recon-import/reader');
const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('../../backend/bank-bu-recon-db/columns');
const { sha256File } = require('./identity');
const {
  BANK_BU_INPUT_ROLES,
  BANK_BU_SPOOL_SCHEMA_VERSION,
  bankBuSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const {
  cleanupBankBuSpool,
  ensurePrivateSpoolDirectory
} = require('./spool-filesystem');

function sourceSnapshot(descriptor) {
  let stat;
  try { stat = fs.lstatSync(descriptor.source.filePath, { bigint: true }); } catch (_error) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入文件不可读或已变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入必须是普通文件且不能是符号链接');
  }
  const snapshot = sourceSnapshotFromStat(stat);
  if (!snapshot) throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入快照不可用');
  return Object.freeze(snapshot);
}

function assertSnapshot(descriptor, snapshot) {
  let stat;
  try { stat = fs.lstatSync(descriptor.source.filePath, { bigint: true }); } catch (_error) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入文件在解析期间发生变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !sourceSnapshotMatchesStat(snapshot, stat)) {
    throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入文件在解析期间发生变化');
  }
}

function checkCancelled(signal) {
  if (!signal || !signal.aborted) return;
  throw spoolError('BANK_BU_PARSER_CANCELLED', 'BankBU Parser已取消');
}

function rowColumns(role) {
  return role === BANK_BU_INPUT_ROLES.PENDING ? PENDING_GUANLI_DB_COLUMNS : BANK_DB_COLUMNS;
}

function normalizedRow(row, columns) {
  const output = { _rowIndex: row._rowIndex };
  for (const column of columns) output[column] = String(row[column] == null ? '' : row[column]);
  return output;
}

async function writeBankBuInputSpool(rawDescriptor, options = {}) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = bankBuSpoolPaths(descriptor);
  const signal = options.signal || null;
  const columns = rowColumns(descriptor.role);
  const reader = descriptor.role === BANK_BU_INPUT_ROLES.PENDING
    ? readPendingGuanliFile
    : readBankFile;
  let rowsFd = null;
  let manifestFd = null;
  let ownsFiles = false;
  try {
    checkCancelled(signal);
    const snapshot = sourceSnapshot(descriptor);
    const sourceHash = await sha256File(descriptor.source.filePath);
    assertSnapshot(descriptor, snapshot);
    const parsed = reader(descriptor.source.filePath);
    checkCancelled(signal);
    assertSnapshot(descriptor, snapshot);
    const sourceHashAfter = await sha256File(descriptor.source.filePath);
    if (sourceHashAfter !== sourceHash) {
      throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入文件在解析期间发生变化');
    }
    ensurePrivateSpoolDirectory(paths);
    ownsFiles = true;
    rowsFd = fs.openSync(paths.rowsPart, 'wx', 0o600);
    const rowsHash = crypto.createHash('sha256');
    let byteSize = 0;
    let count = 0;
    for (const sourceRow of parsed.rows) {
      checkCancelled(signal);
      const row = normalizedRow(sourceRow, columns);
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
      fs.writeFileSync(rowsFd, bytes);
      rowsHash.update(bytes);
      byteSize += bytes.length;
      count += 1;
    }
    checkCancelled(signal);
    assertSnapshot(descriptor, snapshot);
    if (await sha256File(descriptor.source.filePath) !== sourceHash) {
      throw spoolError('BANK_BU_SPOOL_SOURCE_CHANGED', 'BankBU输入文件在spool发布前发生变化');
    }
    fs.fsyncSync(rowsFd);
    fs.closeSync(rowsFd);
    rowsFd = null;
    fs.renameSync(paths.rowsPart, paths.rowsReady);
    fsyncDirectory(paths.roleDir);
    const rowsStat = fs.lstatSync(paths.rowsReady);
    if (rowsStat.isSymbolicLink() || !rowsStat.isFile() || rowsStat.size !== byteSize ||
        count !== parsed.rows.length) {
      throw spoolError('BANK_BU_SPOOL_PUBLISH_INVALID', 'BankBU rows spool发布身份不一致');
    }
    const manifest = Object.freeze({
      schemaVersion: BANK_BU_SPOOL_SCHEMA_VERSION,
      jobId: descriptor.jobId,
      operationKey: descriptor.operationKey,
      producerTaskRunId: descriptor.producerTaskRunId,
      yearMonth: descriptor.yearMonth,
      role: descriptor.role,
      source: Object.freeze({
        fileName: path.basename(descriptor.source.filePath),
        snapshot,
        sha256: sourceHash
      }),
      rowCount: count,
      rows: Object.freeze({
        basename: path.basename(paths.rowsReady),
        byteSize,
        sha256: rowsHash.digest('hex'),
        count
      })
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    manifestFd = fs.openSync(paths.manifestPart, 'wx', 0o600);
    fs.writeFileSync(manifestFd, manifestBytes);
    fs.fsyncSync(manifestFd);
    fs.closeSync(manifestFd);
    manifestFd = null;
    fs.renameSync(paths.manifestPart, paths.manifestReady);
    fsyncDirectory(paths.roleDir);
    return Object.freeze({
      schemaVersion: BANK_BU_SPOOL_SCHEMA_VERSION,
      jobId: descriptor.jobId,
      yearMonth: descriptor.yearMonth,
      role: descriptor.role,
      fileName: manifest.source.fileName,
      rowCount: count
    });
  } catch (error) {
    if (rowsFd !== null) {
      try { fs.closeSync(rowsFd); } catch (_closeError) { /* original wins */ }
    }
    if (manifestFd !== null) {
      try { fs.closeSync(manifestFd); } catch (_closeError) { /* original wins */ }
    }
    if (ownsFiles) {
      try { cleanupBankBuSpool(descriptor); } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
    }
    throw error;
  }
}

module.exports = { writeBankBuInputSpool };
