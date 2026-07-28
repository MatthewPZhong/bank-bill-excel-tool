'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STAGING_RELATIVE_PATH = 'run-data/position-reconciliation/import-staging';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sourceStat(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    ino: Number(stat.ino)
  };
}

function sameSourceStat(left, right) {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (
      !Number.isSafeInteger(left.ino)
      || !Number.isSafeInteger(right.ino)
      || left.ino === right.ino
    );
}

function stageInputFiles(userDataDir, filePaths, batchId) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  const batchRoot = path.join(
    path.resolve(userDataDir),
    STAGING_RELATIVE_PATH,
    String(batchId)
  );
  const staged = [];
  try {
    paths.forEach((filePath, index) => {
      const originalPath = path.resolve(String(filePath || ''));
      const before = sourceStat(originalPath);
      const stagingDir = path.join(batchRoot, String(index + 1));
      fs.mkdirSync(stagingDir, { recursive: true });
      const stagedPath = path.join(stagingDir, path.basename(originalPath));
      fs.copyFileSync(originalPath, stagedPath, fs.constants.COPYFILE_EXCL);
      const after = sourceStat(originalPath);
      const stagedStat = sourceStat(stagedPath);
      if (!sameSourceStat(before, after) || stagedStat.size !== before.size) {
        throw new Error(`复制期间源文件发生变化：${path.basename(originalPath)}`);
      }
      staged.push({
        filePath: stagedPath,
        sourceFilePath: originalPath,
        sourceFileName: path.basename(originalPath),
        archivePath: stagedPath,
        stagingDir
      });
    });
    return staged;
  } catch (error) {
    fs.rmSync(batchRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupStagingPaths(paths) {
  const unique = new Set((Array.isArray(paths) ? paths : []).filter(Boolean).map((value) => (
    path.resolve(String(value))
  )));
  for (const target of unique) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function pruneStagingRoot(userDataDir, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  protectedPaths = []
} = {}) {
  const root = path.join(path.resolve(userDataDir), STAGING_RELATIVE_PATH);
  if (!fs.existsSync(root)) return 0;
  const protectedBatchRoots = new Set();
  for (const value of Array.isArray(protectedPaths) ? protectedPaths : []) {
    const candidate = path.resolve(String(value || ''));
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    const [batchName] = relative.split(path.sep);
    if (batchName) protectedBatchRoots.add(path.join(root, batchName));
  }
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    if (protectedBatchRoots.has(target)) continue;
    try {
      const stat = fs.statSync(target);
      if (now - Number(stat.mtimeMs) < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (_error) {
      // 清理失败留待下次启动，不影响业务初始化。
    }
  }
  return removed;
}

module.exports = {
  STAGING_RELATIVE_PATH,
  stageInputFiles,
  cleanupStagingPaths,
  pruneStagingRoot
};
