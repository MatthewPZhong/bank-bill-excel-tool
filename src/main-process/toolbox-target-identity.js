'use strict';

const fs = require('node:fs');
const path = require('node:path');

class TargetIdentityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TargetIdentityError';
    this.code = code;
    this.details = details;
  }
}

function usesCaseInsensitivePathAliases(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function windowsSimpleUppercaseIdentity(value, options = {}) {
  let identity = '';
  for (const character of String(value)) {
    const mapped = Array.from(character.toUpperCase());
    if (mapped.length !== 1) {
      if (options.preserveExpandingCodePoint === true) {
        identity += character;
        continue;
      }
      throw new TargetIdentityError(
        'TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE',
        'Windows 缺失目标包含无法可靠表达的大小写映射',
        Object.freeze({ platform: 'win32', reason: 'expanding-case-mapping' })
      );
    }
    identity += mapped[0];
  }
  return identity;
}

function existingPathAliasKey(realPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    // realpath 已证明路径存在。对 full-uppercase 会扩展的 code point 保留原 code
    // point token；同一物理目标的其他拼写仍会先收口到同一 realpath。
    return windowsSimpleUppercaseIdentity(realPath, { preserveExpandingCodePoint: true });
  }
  return normalizeTargetAliasKey(realPath, options);
}

/**
 * 工具箱输出目标的唯一别名规则：
 * - macOS 的默认 volume 已用真实 inode probe 证明 NFC/NFD、大小写和 expansion
 *   case-fold（例如 ß/SS）别名，因此使用 NFD → uppercase expansion → lowercase → NFC；
 * - Windows 的 NTFS case identity 由 volume upcase table 决定，Node 没有可移植 API 可在
 *   缺失目标上查询该表。确证 missing target 的 lexical identity 逐 code point 只接受
 *   单 code point Unicode uppercase，不做 NFC/NFD；ß/SS 等 expansion mapping 直接
 *   fail closed；目标已存在时 realpath/inode 仍提供物理证据；
 * - Linux 沿用 NFC，但保留大小写差异。
 */
function normalizeTargetAliasKey(value, options = {}) {
  const platform = options.platform || process.platform;
  const raw = String(value == null ? '' : value);
  if (platform === 'win32') {
    // 该通用 helper 也服务 staging 相对路径/descendant 检查，无法证明目标缺失。
    // expansion code point 保持原字符可避免误并；只有 targetPathAliasKey 确认的
    // missing segment 才执行严格 fail-closed。
    return windowsSimpleUppercaseIdentity(raw, { preserveExpandingCodePoint: true });
  }
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
    return existingPathAliasKey(realpathSyncWith(fsImpl, resolvedTarget), options);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  let realParent;
  let missingSegments = [];
  try {
    realParent = realpathSyncWith(fsImpl, path.dirname(resolvedTarget));
  } catch (error) {
    if (!options.allowMissingParentLexicalFallback || !error || error.code !== 'ENOENT') {
      throw error;
    }
    let cursor = path.dirname(resolvedTarget);
    for (;;) {
      try {
        realParent = realpathSyncWith(fsImpl, cursor);
        break;
      } catch (ancestorError) {
        if (!ancestorError || ancestorError.code !== 'ENOENT') throw ancestorError;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw ancestorError;
        missingSegments.push(path.basename(cursor));
        cursor = parent;
      }
    }
    missingSegments = missingSegments.reverse();
  }
  const targetName = path.basename(resolvedTarget);
  const fullTargetPath = path.join(realParent, ...missingSegments, targetName);
  if ((options.platform || process.platform) === 'win32') {
    // 仅缺失的目录/文件名需要 lexical 推断；existing realpath 部分可以包含 expansion
    // code point。任何缺失 segment 无法用单 code point uppercase 表达时，在产生 scope
    // 之前 fail closed，不暴露路径，也不允许调用方猜测 fallback identity。
    for (const segment of [...missingSegments, targetName]) {
      windowsSimpleUppercaseIdentity(segment);
    }
    return existingPathAliasKey(fullTargetPath, options);
  }
  return normalizeTargetAliasKey(fullTargetPath, options);
}

function directoryPathAliasKey(fsImpl, directoryPath, options = {}) {
  return existingPathAliasKey(
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
  TargetIdentityError,
  directoryPathAliasKey,
  normalizeTargetAliasKey,
  pathAliasKeys,
  pathsAlias,
  targetPathAliasKey,
  usesCaseInsensitivePathAliases
};
