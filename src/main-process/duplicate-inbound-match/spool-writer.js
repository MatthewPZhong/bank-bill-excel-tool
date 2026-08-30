'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readBankStatement } = require('../bank-statement-io');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const { fsyncDirectory } = require('../background-execution/durable-file');
const { streamDocumentStatement } = require('./document-statement-reader');
const { prepareStoredBankRows } = require('./import-model');
const { inspectDuplicateInputFile } = require('./input-classifier');
const {
  DUPLICATE_INPUT_ROLES,
  DUPLICATE_SPOOL_SCHEMA_VERSION,
  duplicateSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const {
  cleanupDuplicateSpool,
  ensurePrivateSpoolDirectory
} = require('./spool-filesystem');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sourceSnapshot(descriptor) {
  let stat;
  try {
    stat = fs.lstatSync(descriptor.source.filePath, { bigint: true });
  } catch (_error) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入文件不可读或已变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入必须是普通文件且不能是符号链接');
  }
  const snapshot = sourceSnapshotFromStat(stat);
  if (!snapshot) throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入快照不可用');
  return Object.freeze(snapshot);
}

function assertSourceUnchanged(descriptor, snapshot) {
  let stat;
  try {
    stat = fs.lstatSync(descriptor.source.filePath, { bigint: true });
  } catch (_error) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入文件在解析期间发生变化');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !sourceSnapshotMatchesStat(snapshot, stat)) {
    throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入文件在解析期间发生变化');
  }
}

function checkCancelled(signal) {
  if (!signal || !signal.aborted) return;
  throw spoolError('DUPLICATE_PARSER_CANCELLED', 'Duplicate Parser已取消');
}

function writeRow(state, row) {
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  fs.writeFileSync(state.fd, bytes);
  state.hash.update(bytes);
  state.byteSize += bytes.length;
  state.count += 1;
}

async function writeDuplicateInputSpool(rawDescriptor, options = {}) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = duplicateSpoolPaths(descriptor);
  const signal = options.signal || null;
  const rowState = { fd: null, hash: crypto.createHash('sha256'), byteSize: 0, count: 0 };
  let manifestFd = null;
  let ownsFiles = false;
  try {
    checkCancelled(signal);
    const snapshot = sourceSnapshot(descriptor);
    const sourceHash = await hashFile(descriptor.source.filePath);
    assertSourceUnchanged(descriptor, snapshot);
    const inspected = await inspectDuplicateInputFile(descriptor.source.filePath);
    checkCancelled(signal);
    ensurePrivateSpoolDirectory(paths);
    ownsFiles = true;
    rowState.fd = fs.openSync(paths.rowsPart, 'wx', 0o600);
    let role;
    let counts;
    if (inspected.isBank) {
      role = DUPLICATE_INPUT_ROLES.BANK;
      const parsed = readBankStatement(descriptor.source.filePath);
      const rows = prepareStoredBankRows(parsed.rows);
      for (const row of rows) {
        checkCancelled(signal);
        writeRow(rowState, row);
      }
      counts = Object.freeze({ rowCount: rows.length });
    } else {
      role = DUPLICATE_INPUT_ROLES.DOCUMENT;
      const parsed = await streamDocumentStatement(descriptor.source.filePath, {
        onRow(row) {
          checkCancelled(signal);
          writeRow(rowState, row);
        }
      });
      counts = Object.freeze({
        rowCount: parsed.rowCount,
        matchableRowCount: parsed.matchableRowCount,
        emptyBusinessOrderCount: parsed.emptyBusinessOrderCount
      });
    }
    checkCancelled(signal);
    assertSourceUnchanged(descriptor, snapshot);
    const sourceHashAfter = await hashFile(descriptor.source.filePath);
    if (sourceHashAfter !== sourceHash) {
      throw spoolError('DUPLICATE_SPOOL_SOURCE_CHANGED', 'Duplicate输入文件在解析期间发生变化');
    }
    fs.fsyncSync(rowState.fd);
    fs.closeSync(rowState.fd);
    rowState.fd = null;
    fs.renameSync(paths.rowsPart, paths.rowsReady);
    fsyncDirectory(paths.slotDir);
    const rowsStat = fs.lstatSync(paths.rowsReady);
    if (rowsStat.isSymbolicLink() || !rowsStat.isFile() || rowsStat.size !== rowState.byteSize ||
        rowState.count !== counts.rowCount) {
      throw spoolError('DUPLICATE_SPOOL_PUBLISH_INVALID', 'Duplicate rows spool发布身份不一致');
    }
    const manifest = Object.freeze({
      schemaVersion: DUPLICATE_SPOOL_SCHEMA_VERSION,
      jobId: descriptor.jobId,
      operationKey: descriptor.operationKey,
      producerTaskRunId: descriptor.producerTaskRunId,
      slotIndex: descriptor.slotIndex,
      unitId: descriptor.unitId,
      role,
      source: Object.freeze({
        fileName: path.basename(descriptor.source.filePath),
        snapshot,
        sha256: sourceHash
      }),
      classification: Object.freeze({
        isBank: inspected.isBank,
        sheetNames: Object.freeze(inspected.sheetNames.slice())
      }),
      counts,
      files: Object.freeze({
        rows: Object.freeze({
          basename: path.basename(paths.rowsReady),
          byteSize: rowState.byteSize,
          sha256: rowState.hash.digest('hex'),
          count: rowState.count
        })
      })
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    manifestFd = fs.openSync(paths.manifestPart, 'wx', 0o600);
    fs.writeFileSync(manifestFd, manifestBytes);
    fs.fsyncSync(manifestFd);
    fs.closeSync(manifestFd);
    manifestFd = null;
    fs.renameSync(paths.manifestPart, paths.manifestReady);
    fsyncDirectory(paths.slotDir);
    return Object.freeze({
      schemaVersion: DUPLICATE_SPOOL_SCHEMA_VERSION,
      jobId: descriptor.jobId,
      slotIndex: descriptor.slotIndex,
      unitId: descriptor.unitId,
      role,
      fileName: manifest.source.fileName,
      rowCount: manifest.counts.rowCount
    });
  } catch (error) {
    if (rowState.fd !== null) {
      try { fs.closeSync(rowState.fd); } catch (_closeError) { /* original wins */ }
    }
    if (manifestFd !== null) {
      try { fs.closeSync(manifestFd); } catch (_closeError) { /* original wins */ }
    }
    if (ownsFiles) {
      try { cleanupDuplicateSpool(descriptor); } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
    }
    throw error;
  }
}

module.exports = {
  hashFile,
  writeDuplicateInputSpool
};
