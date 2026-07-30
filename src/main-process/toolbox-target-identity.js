'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usesCaseInsensitivePathAliases(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * 工具箱输出目标的唯一别名规则：
 * - 所有平台先统一 Unicode NFC，防止组合字符与预组合字符指向同一文件；
 * - macOS / Windows 再执行无 locale 的完整大小写折叠近似：NFD → uppercase expansion
 *   → lowercase → NFC。不能只用 toLowerCase，否则会漏掉 ß/SS、σ/ς 和 ligature 等
 *   文件系统已视为同一名称的别名；
 * - Linux 保留大小写差异。
 */
function normalizeTargetAliasKey(value, options = {}) {
  const platform = options.platform || process.platform;
  const normalized = String(value == null ? '' : value).normalize('NFC');
  if (!usesCaseInsensitivePathAliases(platform)) return normalized;
  return normalized
    .normalize('NFD')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC');
}

function realpathSyncWith(fsImpl, filePath) {
  const implementation = fsImpl && typeof fsImpl.realpathSync === 'function'
    ? fsImpl
    : fs;
  return implementation.realpathSync(filePath);
}

function targetPathAliasKey(fsImpl, targetPath, options = {}) {
  const resolvedTarget = path.resolve(String(targetPath));
  const realParent = realpathSyncWith(fsImpl, path.dirname(resolvedTarget));
  return normalizeTargetAliasKey(
    path.join(realParent, path.basename(resolvedTarget)),
    options
  );
}

function directoryPathAliasKey(fsImpl, directoryPath, options = {}) {
  return normalizeTargetAliasKey(
    realpathSyncWith(fsImpl, path.resolve(String(directoryPath))),
    options
  );
}

module.exports = {
  directoryPathAliasKey,
  normalizeTargetAliasKey,
  targetPathAliasKey,
  usesCaseInsensitivePathAliases
};
