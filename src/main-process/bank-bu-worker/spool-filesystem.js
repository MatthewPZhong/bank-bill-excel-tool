'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  BANK_BU_SPOOL_FILE_NAMES,
  bankBuSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');

function pathFailure(code, message, paths, invalidPath) {
  return spoolError(code, message, { invalidPath, residualPaths: [paths.roleDir] });
}

function realDirectory(directory, code, paths) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (_error) {
    throw pathFailure(code, 'BankBU spool目录缺失或不可访问', paths, directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathFailure(code, 'BankBU spool目录必须是非符号链接目录', paths, directory);
  }
  try { return fs.realpathSync(directory); } catch (_error) {
    throw pathFailure(code, 'BankBU spool真实目录不可访问', paths, directory);
  }
}

function ensureContained(directory, rootReal, paths, code = 'BANK_BU_SPOOL_PATH_INVALID') {
  const real = realDirectory(directory, code, paths);
  if (real === rootReal || !real.startsWith(`${rootReal}${path.sep}`)) {
    throw pathFailure(code, 'BankBU spool越过task staging边界', paths, directory);
  }
}

function ensurePrivateSpoolDirectory(paths, options = {}) {
  try { fs.mkdirSync(paths.taskStagingDir, { recursive: true, mode: 0o700 }); } catch (_error) {
    throw pathFailure(
      'BANK_BU_SPOOL_PATH_INVALID', 'BankBU task staging创建失败', paths, paths.taskStagingDir
    );
  }
  const rootReal = realDirectory(paths.taskStagingDir, 'BANK_BU_SPOOL_PATH_INVALID', paths);
  for (const directory of [paths.dualDir, paths.jobDir, paths.roleDir]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw pathFailure('BANK_BU_SPOOL_PATH_INVALID', 'BankBU spool目录创建失败', paths, directory);
      }
    }
    ensureContained(directory, rootReal, paths);
  }
  if (options.requireEmpty === false) return;
  for (const basename of Object.values(BANK_BU_SPOOL_FILE_NAMES)) {
    try {
      fs.lstatSync(path.join(paths.roleDir, basename));
      throw spoolError('BANK_BU_SPOOL_ALREADY_EXISTS', '当前job/role spool已存在');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function validatePrivateSpoolDirectory(rawDescriptor) {
  const paths = bankBuSpoolPaths(normalizeSpoolDescriptor(rawDescriptor));
  const rootReal = realDirectory(paths.taskStagingDir, 'BANK_BU_SPOOL_PATH_INVALID', paths);
  for (const directory of [paths.dualDir, paths.jobDir, paths.roleDir]) {
    ensureContained(directory, rootReal, paths);
  }
  return paths;
}

function cleanupBankBuSpool(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = bankBuSpoolPaths(descriptor);
  try { fs.lstatSync(paths.taskStagingDir); } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({ status: 'absent', residualPaths: Object.freeze([]) });
    }
    throw error;
  }
  const rootReal = realDirectory(
    paths.taskStagingDir, 'BANK_BU_SPOOL_CLEANUP_PATH_INVALID', paths
  );
  for (const directory of [paths.dualDir, paths.jobDir, paths.roleDir]) {
    try { fs.lstatSync(directory); } catch (error) {
      if (error && error.code === 'ENOENT') {
        return Object.freeze({ status: 'absent', residualPaths: Object.freeze([]) });
      }
      throw error;
    }
    ensureContained(directory, rootReal, paths, 'BANK_BU_SPOOL_CLEANUP_PATH_INVALID');
  }
  for (const basename of Object.values(BANK_BU_SPOOL_FILE_NAMES)) {
    fs.rmSync(path.join(paths.roleDir, basename), { force: true });
  }
  try { fs.rmdirSync(paths.roleDir); } catch (_error) { /* checked below */ }
  const residualPaths = [];
  try { fs.lstatSync(paths.roleDir); residualPaths.push(paths.roleDir); } catch (error) {
    if (!error || error.code !== 'ENOENT') residualPaths.push(paths.roleDir);
  }
  if (residualPaths.length > 0) {
    throw spoolError(
      'BANK_BU_SPOOL_CLEANUP_INCOMPLETE',
      'BankBU spool cleanup未删除全部当前role artifact',
      { residualPaths: Object.freeze(residualPaths) }
    );
  }
  return Object.freeze({ status: 'cleaned', residualPaths: Object.freeze([]) });
}

function cleanupBankBuSpoolParents(rawDescriptor) {
  const paths = bankBuSpoolPaths(normalizeSpoolDescriptor(rawDescriptor));
  for (const directory of [paths.jobDir, paths.dualDir, paths.taskStagingDir]) {
    try { fs.rmdirSync(directory); } catch (error) {
      if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

module.exports = {
  cleanupBankBuSpool,
  cleanupBankBuSpoolParents,
  ensurePrivateSpoolDirectory,
  validatePrivateSpoolDirectory
};
