'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DUPLICATE_SPOOL_FILE_NAMES,
  duplicateSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');

function pathFailure(code, message, paths, invalidPath) {
  return spoolError(code, message, { invalidPath, residualPaths: [paths.slotDir] });
}

function realDirectory(directory, code, paths) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (_error) {
    throw pathFailure(code, 'Duplicate spool目录缺失或不可访问', paths, directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathFailure(code, 'Duplicate spool目录必须是非符号链接目录', paths, directory);
  }
  try { return fs.realpathSync(directory); } catch (_error) {
    throw pathFailure(code, 'Duplicate spool真实目录不可访问', paths, directory);
  }
}

function ensureContained(directory, rootReal, paths) {
  const real = realDirectory(directory, 'DUPLICATE_SPOOL_PATH_INVALID', paths);
  if (real === rootReal || !real.startsWith(`${rootReal}${path.sep}`)) {
    throw pathFailure('DUPLICATE_SPOOL_PATH_INVALID', 'Duplicate spool越过task staging边界', paths, directory);
  }
}

function createDirectory(directory, rootReal, paths) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw pathFailure('DUPLICATE_SPOOL_PATH_INVALID', 'Duplicate spool目录创建失败', paths, directory);
    }
  }
  ensureContained(directory, rootReal, paths);
}

function ensurePrivateSpoolDirectory(paths, options = {}) {
  try { fs.mkdirSync(paths.taskStagingDir, { recursive: true, mode: 0o700 }); } catch (_error) {
    throw pathFailure(
      'DUPLICATE_SPOOL_PATH_INVALID', 'Duplicate task staging创建失败', paths, paths.taskStagingDir
    );
  }
  const rootReal = realDirectory(paths.taskStagingDir, 'DUPLICATE_SPOOL_PATH_INVALID', paths);
  for (const directory of [paths.pairedDir, paths.jobDir, paths.slotDir]) {
    createDirectory(directory, rootReal, paths);
  }
  if (options.requireEmpty === false) return;
  for (const basename of Object.values(DUPLICATE_SPOOL_FILE_NAMES)) {
    try {
      fs.lstatSync(path.join(paths.slotDir, basename));
      throw spoolError('DUPLICATE_SPOOL_ALREADY_EXISTS', '当前job/slot spool已存在');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function validatePrivateSpoolDirectory(rawDescriptor) {
  const paths = duplicateSpoolPaths(normalizeSpoolDescriptor(rawDescriptor));
  const rootReal = realDirectory(
    paths.taskStagingDir,
    'DUPLICATE_SPOOL_PATH_INVALID',
    paths
  );
  for (const directory of [paths.pairedDir, paths.jobDir, paths.slotDir]) {
    ensureContained(directory, rootReal, paths);
  }
  return paths;
}

function cleanupKnownFiles(paths) {
  for (const basename of Object.values(DUPLICATE_SPOOL_FILE_NAMES)) {
    try { fs.rmSync(path.join(paths.slotDir, basename), { force: true }); } catch (_error) { /* best effort */ }
  }
  try { fs.rmdirSync(paths.slotDir); } catch (_error) { /* only empty owner dir */ }
  const residualPaths = [];
  for (const basename of Object.values(DUPLICATE_SPOOL_FILE_NAMES)) {
    const artifactPath = path.join(paths.slotDir, basename);
    try { fs.lstatSync(artifactPath); residualPaths.push(artifactPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') residualPaths.push(artifactPath);
    }
  }
  try { fs.lstatSync(paths.slotDir); residualPaths.push(paths.slotDir); } catch (error) {
    if (!error || error.code !== 'ENOENT') residualPaths.push(paths.slotDir);
  }
  return residualPaths;
}

function cleanupDuplicateSpool(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = duplicateSpoolPaths(descriptor);
  let rootReal;
  try { rootReal = realDirectory(paths.taskStagingDir, 'DUPLICATE_SPOOL_CLEANUP_PATH_INVALID', paths); }
  catch (error) {
    try { fs.lstatSync(paths.taskStagingDir); } catch (statError) {
      if (statError && statError.code === 'ENOENT') {
        return Object.freeze({ status: 'absent', residualPaths: Object.freeze([]) });
      }
    }
    throw error;
  }
  for (const directory of [paths.pairedDir, paths.jobDir, paths.slotDir]) {
    try { fs.lstatSync(directory); } catch (error) {
      if (error && error.code === 'ENOENT') {
        return Object.freeze({ status: 'absent', residualPaths: Object.freeze([]) });
      }
      throw pathFailure(
        'DUPLICATE_SPOOL_CLEANUP_PATH_INVALID',
        'Duplicate spool cleanup目录不可访问', paths, directory
      );
    }
    const real = realDirectory(directory, 'DUPLICATE_SPOOL_CLEANUP_PATH_INVALID', paths);
    if (real === rootReal || !real.startsWith(`${rootReal}${path.sep}`)) {
      throw pathFailure(
        'DUPLICATE_SPOOL_CLEANUP_PATH_INVALID',
        'Duplicate spool cleanup越过task staging边界', paths, directory
      );
    }
  }
  const residualPaths = cleanupKnownFiles(paths);
  if (residualPaths.length > 0) {
    throw spoolError(
      'DUPLICATE_SPOOL_CLEANUP_INCOMPLETE',
      'Duplicate spool cleanup未删除全部当前slot artifact',
      { residualPaths: Object.freeze(residualPaths) }
    );
  }
  return Object.freeze({ status: 'cleaned', residualPaths: Object.freeze([]) });
}

function cleanupDuplicateSpoolParents(rawDescriptor) {
  const paths = duplicateSpoolPaths(normalizeSpoolDescriptor(rawDescriptor));
  for (const directory of [paths.jobDir, paths.pairedDir, paths.taskStagingDir]) {
    try { fs.rmdirSync(directory); } catch (error) {
      if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

module.exports = {
  cleanupDuplicateSpool,
  cleanupDuplicateSpoolParents,
  ensurePrivateSpoolDirectory,
  validatePrivateSpoolDirectory
};
