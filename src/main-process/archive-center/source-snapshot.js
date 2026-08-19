'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PAYLOAD_PATH_KEYS = Object.freeze([
  'filePath',
  'pendingPath',
  'bankPath',
  'savePath'
]);

const RESULT_PATH_KEYS = Object.freeze([
  'filePath',
  'savedPath',
  'savePath',
  'mainFilePath',
  'hitRowsReportPath',
  'platformCleanupPath',
  'refundBackfillPath',
  'unmatchedFilePath',
  'diffFilePath',
  'reportFilePath'
]);

function normalizeSourceSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sizeBytes = Number(value.sizeBytes);
  const mtimeMs = Number(value.mtimeMs);
  const ctimeMs = Number(value.ctimeMs);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
  if (!Number.isFinite(ctimeMs) || ctimeMs < 0) return null;
  const snapshot = { sizeBytes, mtimeMs, ctimeMs };
  let inode;
  if (typeof value.ino === 'bigint' && value.ino >= 0n) {
    inode = value.ino.toString(10);
  } else if (typeof value.ino === 'string' && /^\d+$/.test(value.ino)) {
    inode = BigInt(value.ino).toString(10);
  } else if (Number.isSafeInteger(value.ino) && value.ino >= 0) {
    inode = String(value.ino);
  }
  if (inode !== undefined) snapshot.ino = inode;
  return snapshot;
}

function statTimeMs(stat, millisecondKey, nanosecondKey) {
  if (typeof stat[nanosecondKey] === 'bigint') {
    const nanoseconds = stat[nanosecondKey];
    return Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1e6;
  }
  return Number(stat[millisecondKey]);
}

function sourceSnapshotFromStat(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) return null;
  return normalizeSourceSnapshot({
    sizeBytes: Number(stat.size),
    mtimeMs: statTimeMs(stat, 'mtimeMs', 'mtimeNs'),
    ctimeMs: statTimeMs(stat, 'ctimeMs', 'ctimeNs'),
    ino: stat.ino
  });
}

function sourceSnapshotMatchesStat(snapshot, stat) {
  const expected = normalizeSourceSnapshot(snapshot);
  const actual = sourceSnapshotFromStat(stat);
  if (!expected || !actual) return false;
  if (expected.sizeBytes !== actual.sizeBytes
      || expected.mtimeMs !== actual.mtimeMs
      || expected.ctimeMs !== actual.ctimeMs) {
    return false;
  }
  return expected.ino === undefined || actual.ino === undefined || expected.ino === actual.ino;
}

function addPath(target, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  target.add(path.resolve(value));
}

function addPathValues(target, value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  for (const item of values) {
    if (typeof item === 'string') addPath(target, item);
    else if (item && typeof item === 'object') {
      addPath(target, item.filePath || item.savedPath || item.path);
    }
  }
}

function collectArchiveCandidatePaths({ args = [], result, selectedPaths = [], runtime = {} } = {}) {
  const candidates = new Set();
  addPathValues(candidates, selectedPaths);
  addPathValues(candidates, runtime.inputPaths);
  addPathValues(candidates, runtime.inputFiles);
  addPathValues(candidates, runtime.outputPaths);

  const payload = Array.isArray(args) && args[0] && typeof args[0] === 'object'
    ? args[0]
    : {};
  addPathValues(candidates, payload.files);
  addPathValues(candidates, payload.filePaths);
  for (const key of PAYLOAD_PATH_KEYS) addPath(candidates, payload[key]);

  if (result && typeof result === 'object') {
    for (const key of RESULT_PATH_KEYS) addPath(candidates, result[key]);
    addPathValues(candidates, result.files);
    addPathValues(candidates, result.archivedSourcePaths);
  }
  return Array.from(candidates);
}

function captureArchiveSourceSnapshots(input = {}, fsImpl = fs) {
  const snapshots = new Map();
  for (const filePath of collectArchiveCandidatePaths(input)) {
    try {
      const snapshot = sourceSnapshotFromStat(fsImpl.statSync(filePath));
      if (snapshot) snapshots.set(filePath, snapshot);
    } catch (_error) {
      // 无法快照的路径仍交给存档服务记录明确失败，不能影响原业务返回。
    }
  }
  return snapshots;
}

function sourceSnapshotForPath(snapshots, filePath) {
  if (!(snapshots instanceof Map)) return null;
  const resolved = path.resolve(String(filePath || ''));
  return normalizeSourceSnapshot(snapshots.get(resolved));
}

module.exports = {
  captureArchiveSourceSnapshots,
  collectArchiveCandidatePaths,
  normalizeSourceSnapshot,
  sourceSnapshotForPath,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
};
