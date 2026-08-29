'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  directoryPathAliasKey
} = require('../toolbox-target-identity');

const IDENTITY_KEYS = Object.freeze([
  'canonicalRealPath',
  'aliasKey',
  'deviceId',
  'inode',
  'identityReliable',
  'identityKind'
]);
const MAX_PATH_BYTES = 32 * 1024;
const MAX_ID_DIGITS = 32;

class TargetParentIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TargetParentIdentityError';
    this.code = code;
    this.detailLines = Array.isArray(details.detailLines)
      ? details.detailLines.slice()
      : [];
    if (details.cause) this.cause = details.cause;
  }
}

function fail(code, message, details) {
  throw new TargetParentIdentityError(code, message, details);
}

function boundedText(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\u0000') ||
      Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    fail('TARGET_PARENT_IDENTITY_INVALID', `${label}无效`);
  }
  return value;
}

function positiveDecimal(value, label) {
  if (typeof value !== 'string' ||
      !new RegExp(`^[1-9]\\d{0,${MAX_ID_DIGITS - 1}}$`).test(value)) {
    fail('TARGET_PARENT_IDENTITY_INVALID', `${label}必须是非零bounded十进制string`);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTargetParentIdentity(value, options = {}) {
  if (!isPlainObject(value)) {
    fail('TARGET_PARENT_IDENTITY_INVALID', 'target parent identity必须是plain object');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = IDENTITY_KEYS.slice().sort();
  if (keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])) {
    fail('TARGET_PARENT_IDENTITY_INVALID', 'target parent identity字段集合无效');
  }
  const canonicalRealPath = boundedText(value.canonicalRealPath, 'canonicalRealPath');
  if (!path.isAbsolute(canonicalRealPath) || path.normalize(canonicalRealPath) !== canonicalRealPath) {
    fail('TARGET_PARENT_IDENTITY_INVALID', 'canonicalRealPath必须是规范绝对路径');
  }
  const aliasKey = boundedText(value.aliasKey, 'aliasKey');
  const identityReliable = value.identityReliable;
  if (typeof identityReliable !== 'boolean') {
    fail('TARGET_PARENT_IDENTITY_INVALID', 'identityReliable必须是boolean');
  }
  let deviceId = null;
  let inode = null;
  let identityKind;
  if (identityReliable) {
    identityKind = value.identityKind;
    if (identityKind !== 'dev-inode') {
      fail('TARGET_PARENT_IDENTITY_INVALID', '可靠identityKind必须是dev-inode');
    }
    deviceId = positiveDecimal(value.deviceId, 'deviceId');
    inode = positiveDecimal(value.inode, 'inode');
  } else {
    identityKind = value.identityKind;
    if (identityKind !== 'unsupported' || value.deviceId !== null || value.inode !== null) {
      fail('TARGET_PARENT_IDENTITY_INVALID', '不可靠identity必须使用unsupported/null dev/ino');
    }
  }
  if (options.requireReliable === true && !identityReliable) {
    fail(
      'TARGET_PARENT_IDENTITY_UNAVAILABLE',
      '当前文件系统不能提供可靠的direct target parent dev/ino identity'
    );
  }
  return Object.freeze({
    canonicalRealPath,
    aliasKey,
    deviceId,
    inode,
    identityReliable,
    identityKind
  });
}

function bigintIdentity(stat) {
  if (!stat || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' ||
      stat.dev <= 0n || stat.ino <= 0n) {
    return null;
  }
  return { deviceId: stat.dev.toString(10), inode: stat.ino.toString(10) };
}

function identitiesEqual(left, right) {
  return Boolean(
    left
    && right
    && left.deviceId === right.deviceId
    && left.inode === right.inode
  );
}

function captureTargetParentIdentity(fsImpl = fs, targetPath, options = {}) {
  const implementation = fsImpl || fs;
  const resolvedTarget = path.resolve(String(targetPath));
  const parentPath = path.dirname(resolvedTarget);
  let before;
  let canonicalRealPath;
  let resolved;
  let after;
  let aliasKey;
  try {
    before = implementation.lstatSync(parentPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      fail(
        'TARGET_PARENT_INVALID',
        'direct target parent必须是已存在的非symlink ordinary directory'
      );
    }
    canonicalRealPath = path.normalize(path.resolve(implementation.realpathSync(parentPath)));
    resolved = implementation.statSync(canonicalRealPath, { bigint: true });
    after = implementation.lstatSync(parentPath, { bigint: true });
    if (after.isSymbolicLink() || !after.isDirectory() || !resolved.isDirectory()) {
      fail(
        'TARGET_PARENT_INVALID',
        'resolved direct target parent必须是ordinary directory'
      );
    }
    aliasKey = directoryPathAliasKey(implementation, canonicalRealPath, {
      platform: options.platform || process.platform
    });
  } catch (error) {
    if (error instanceof TargetParentIdentityError) throw error;
    fail(
      'TARGET_PARENT_IDENTITY_CAPTURE_FAILED',
      '无法捕获direct target parent identity',
      { detailLines: [`父目录：${parentPath}`], cause: error }
    );
  }
  const beforeIdentity = bigintIdentity(before);
  const resolvedIdentity = bigintIdentity(resolved);
  const afterIdentity = bigintIdentity(after);
  const reliable = identitiesEqual(beforeIdentity, resolvedIdentity)
    && identitiesEqual(resolvedIdentity, afterIdentity);
  return normalizeTargetParentIdentity({
    canonicalRealPath,
    aliasKey,
    deviceId: reliable ? resolvedIdentity.deviceId : null,
    inode: reliable ? resolvedIdentity.inode : null,
    identityReliable: reliable,
    identityKind: reliable ? 'dev-inode' : 'unsupported'
  });
}

function targetParentIdentitiesMatch(expected, actual) {
  if (expected.canonicalRealPath !== actual.canonicalRealPath ||
      expected.aliasKey !== actual.aliasKey) {
    return false;
  }
  if (!expected.identityReliable) return true;
  return actual.identityReliable &&
    expected.deviceId === actual.deviceId &&
    expected.inode === actual.inode;
}

function assertTargetParentIdentityFresh(
  fsImpl,
  targetPath,
  expectedIdentity,
  options = {}
) {
  const expected = normalizeTargetParentIdentity(expectedIdentity, {
    requireReliable: options.requireReliable === true
  });
  let actual;
  try {
    actual = captureTargetParentIdentity(fsImpl || fs, targetPath, options);
  } catch (error) {
    if (error && error.code === 'TARGET_PARENT_IDENTITY_UNAVAILABLE') throw error;
    fail(
      'TARGET_PARENT_IDENTITY_CHANGED',
      'direct target parent在确认后无法按原路径解析',
      { detailLines: [`目标：${path.resolve(String(targetPath))}`], cause: error }
    );
  }
  if (options.requireReliable === true && !actual.identityReliable) {
    fail(
      'TARGET_PARENT_IDENTITY_UNAVAILABLE',
      '当前文件系统不能复核可靠的direct target parent dev/ino identity'
    );
  }
  if (!targetParentIdentitiesMatch(expected, actual)) {
    fail(
      'TARGET_PARENT_IDENTITY_CHANGED',
      'direct target parent identity在确认后发生变化',
      {
        detailLines: [
          `目标：${path.resolve(String(targetPath))}`,
          `预期父目录：${expected.canonicalRealPath}`,
          `当前父目录：${actual.canonicalRealPath}`
        ]
      }
    );
  }
  return expected;
}

module.exports = {
  TargetParentIdentityError,
  assertTargetParentIdentityFresh,
  captureTargetParentIdentity,
  normalizeTargetParentIdentity,
  targetParentIdentitiesMatch
};
