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
  let realParent;
  try {
    realParent = realpathSyncWith(fsImpl, path.dirname(resolvedTarget));
  } catch (error) {
    if (!options.allowMissingParentLexicalFallback || !error || error.code !== 'ENOENT') {
      throw error;
    }
    const missingSegments = [];
    let cursor = path.dirname(resolvedTarget);
    for (;;) {
      try {
        realParent = path.join(
          realpathSyncWith(fsImpl, cursor),
          ...missingSegments.reverse()
        );
        break;
      } catch (ancestorError) {
        if (!ancestorError || ancestorError.code !== 'ENOENT') throw ancestorError;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw ancestorError;
        missingSegments.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
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

function pathAliasKeys(fsImpl, filePath, options = {}) {
  const keys = new Set([targetPathAliasKey(fsImpl, filePath, options)]);
  try {
    const implementation = fsImpl && typeof fsImpl.realpathSync === 'function'
      ? fsImpl
      : fs;
    keys.add(targetPathAliasKey(
      fsImpl,
      implementation.realpathSync(path.resolve(String(filePath))),
      options
    ));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return Array.from(keys);
}

function pathsAlias(fsImpl, leftPath, rightPath, options = {}) {
  const leftKeys = new Set(pathAliasKeys(fsImpl, leftPath, options));
  if (pathAliasKeys(fsImpl, rightPath, options).some((key) => leftKeys.has(key))) {
    return true;
  }
  try {
    const left = fsImpl.lstatSync(path.resolve(String(leftPath)), { bigint: true });
    const right = fsImpl.lstatSync(path.resolve(String(rightPath)), { bigint: true });
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  directoryPathAliasKey,
  normalizeTargetAliasKey,
  pathAliasKeys,
  pathsAlias,
  targetPathAliasKey,
  usesCaseInsensitivePathAliases
};
