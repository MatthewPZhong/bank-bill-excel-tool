'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { pathsAlias } = require('../toolbox-target-identity');

const STAGING_IDENTITY_CONTRACT_VERSION = 1;
const UUID_TOKEN_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function identityError(stage, identity, message) {
  const error = new Error(message);
  error.code = 'VCC_EXPORT_STAGING_IDENTITY_CHANGED';
  error.stage = stage;
  error.detailLines = [
    `taskRootIdentityDigest=${identity && identity.identityDigest
      ? identity.identityDigest
      : 'unavailable'}`
  ];
  error.preserveTemporaryFiles = true;
  error.recoveryPaths = [];
  error.context = Object.freeze({
    kind: 'vcc-task-staging-identity',
    stage,
    identityDigest: identity && identity.identityDigest
  });
  return error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function statIdentity(directoryPath) {
  const stat = fs.lstatSync(directoryPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError('VCC task-private staging 必须是真实目录');
  }
  return Object.freeze({
    deviceId: String(stat.dev),
    inodeId: String(stat.ino)
  });
}

function identityPayload(value) {
  return Object.freeze({
    contractVersion: value.contractVersion,
    resolvedPath: value.resolvedPath,
    realPath: value.realPath,
    parentResolvedPath: value.parentResolvedPath,
    parentRealPath: value.parentRealPath,
    parentDeviceId: value.parentDeviceId,
    parentInodeId: value.parentInodeId,
    deviceId: value.deviceId,
    inodeId: value.inodeId
  });
}

function createTaskStagingIdentity({ resolvedPath, realPath }) {
  const resolved = path.resolve(String(resolvedPath || ''));
  const real = path.resolve(String(realPath || ''));
  if (resolved !== resolvedPath || real !== realPath) {
    throw new TypeError('VCC task-private staging identity 必须是规范绝对路径');
  }
  const parentResolvedPath = path.dirname(resolved);
  const parentRealPath = path.dirname(real);
  const stat = statIdentity(resolved);
  const parentStat = statIdentity(parentResolvedPath);
  if (fs.realpathSync(resolved) !== real ||
      fs.realpathSync(parentResolvedPath) !== parentRealPath) {
    throw new TypeError('VCC task-private staging identity realpath 已变化');
  }
  const payload = Object.freeze({
    contractVersion: STAGING_IDENTITY_CONTRACT_VERSION,
    resolvedPath: resolved,
    realPath: real,
    parentResolvedPath,
    parentRealPath,
    parentDeviceId: parentStat.deviceId,
    parentInodeId: parentStat.inodeId,
    deviceId: stat.deviceId,
    inodeId: stat.inodeId
  });
  return Object.freeze({
    ...payload,
    identityDigest: canonicalSha256(payload)
  });
}

function normalizeTaskStagingIdentity(value) {
  if (!exactKeys(value, [
    'contractVersion', 'deviceId', 'identityDigest', 'inodeId',
    'parentDeviceId', 'parentInodeId', 'parentRealPath', 'parentResolvedPath',
    'realPath', 'resolvedPath'
  ]) || value.contractVersion !== STAGING_IDENTITY_CONTRACT_VERSION ||
      typeof value.deviceId !== 'string' || !/^\d+$/.test(value.deviceId) ||
      typeof value.inodeId !== 'string' || !/^\d+$/.test(value.inodeId) ||
      typeof value.parentDeviceId !== 'string' || !/^\d+$/.test(value.parentDeviceId) ||
      typeof value.parentInodeId !== 'string' || !/^\d+$/.test(value.parentInodeId) ||
      typeof value.identityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.identityDigest)) {
    throw new TypeError('VCC task-private staging identity contract 非法');
  }
  for (const key of ['resolvedPath', 'realPath', 'parentResolvedPath', 'parentRealPath']) {
    if (typeof value[key] !== 'string' || path.resolve(value[key]) !== value[key]) {
      throw new TypeError(`VCC task-private staging identity ${key} 非法`);
    }
  }
  if (path.dirname(value.resolvedPath) !== value.parentResolvedPath ||
      path.dirname(value.realPath) !== value.parentRealPath ||
      canonicalSha256(identityPayload(value)) !== value.identityDigest) {
    throw new TypeError('VCC task-private staging identity digest/parent 非法');
  }
  return Object.freeze({ ...value });
}

function isDirectChild(rootPath, candidatePath) {
  const resolved = path.resolve(String(candidatePath || ''));
  return resolved === candidatePath && path.dirname(resolved) === rootPath;
}

function assertTaskStagingIdentity({
  identity: rawIdentity,
  generationPaths,
  transientPaths = [],
  stage = 'worker'
}) {
  let identity;
  try {
    identity = normalizeTaskStagingIdentity(rawIdentity);
  } catch (_error) {
    throw identityError(stage, rawIdentity, 'VCC task-private staging identity contract 已变化');
  }
  try {
    const parentStat = fs.lstatSync(identity.parentResolvedPath, { bigint: true });
    const taskStat = fs.lstatSync(identity.resolvedPath, { bigint: true });
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() ||
        taskStat.isSymbolicLink() || !taskStat.isDirectory() ||
        fs.realpathSync(identity.parentResolvedPath) !== identity.parentRealPath ||
        fs.realpathSync(identity.resolvedPath) !== identity.realPath ||
        String(parentStat.dev) !== identity.parentDeviceId ||
        String(parentStat.ino) !== identity.parentInodeId ||
        String(taskStat.dev) !== identity.deviceId || String(taskStat.ino) !== identity.inodeId) {
      throw new Error('identity mismatch');
    }
    const canonicalGenerations = generationPaths.map((candidate) => path.resolve(String(candidate)));
    if (new Set(canonicalGenerations).size !== canonicalGenerations.length ||
        canonicalGenerations.some((candidate, index) => (
          !isDirectChild(identity.resolvedPath, generationPaths[index]) ||
          path.dirname(path.join(identity.realPath, path.basename(candidate))) !== identity.realPath
        ))) {
      throw new Error('generation containment mismatch');
    }
    for (let left = 0; left < canonicalGenerations.length; left += 1) {
      for (let right = left + 1; right < canonicalGenerations.length; right += 1) {
        if (pathsAlias(fs, canonicalGenerations[left], canonicalGenerations[right], {
          allowMissingParentLexicalFallback: true
        })) throw new Error('generation alias');
      }
    }
    for (const candidate of canonicalGenerations) {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() ||
          fs.realpathSync(candidate) !== path.join(identity.realPath, path.basename(candidate))) {
        throw new Error('generation file identity mismatch');
      }
    }
    for (const transientPath of transientPaths) {
      const resolved = path.resolve(String(transientPath || ''));
      if (!isDirectChild(identity.resolvedPath, transientPath) ||
          !canonicalGenerations.some((generationPath) => new RegExp(
            `^${generationPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${UUID_TOKEN_PATTERN}\\.tmp$`
          ).test(resolved))) {
        throw new Error('atomic transient containment mismatch');
      }
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile() ||
          fs.realpathSync(resolved) !== path.join(identity.realPath, path.basename(resolved))) {
        throw new Error('atomic transient identity mismatch');
      }
    }
  } catch (_error) {
    throw identityError(stage, identity, 'VCC task-private staging identity 已变化');
  }
  return identity;
}

module.exports = {
  STAGING_IDENTITY_CONTRACT_VERSION,
  assertTaskStagingIdentity,
  createTaskStagingIdentity,
  normalizeTaskStagingIdentity
};
