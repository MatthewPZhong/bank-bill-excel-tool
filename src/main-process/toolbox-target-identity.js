'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usesCaseInsensitivePathAliases(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function foldAsciiCase(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * 工具箱输出目标的唯一别名规则：
 * - macOS 的默认 volume 已用真实 inode probe 证明 NFC/NFD、大小写和 expansion
 *   case-fold（例如 ß/SS）别名，因此使用 NFD → uppercase expansion → lowercase → NFC；
 * - Windows 的 NTFS case identity 由 volume upcase table 决定，Node 没有可移植 API 可在
 *   缺失目标上查询该表。lexical fallback 只折叠稳定的 ASCII 大小写，绝不擅自把
 *   NFC/NFD、ß/SS 等不同 legacy 名称合并；目标已存在时 realpath/inode 仍提供物理证据；
 * - Linux 沿用 NFC，但保留大小写差异。
 */
function normalizeTargetAliasKey(value, options = {}) {
  const platform = options.platform || process.platform;
  const raw = String(value == null ? '' : value);
  if (platform === 'win32') return foldAsciiCase(raw);
  const normalized = raw.normalize('NFC');
  if (platform !== 'darwin') return normalized;
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
  try {
    return normalizeTargetAliasKey(realpathSyncWith(fsImpl, resolvedTarget), options);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
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
