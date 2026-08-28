'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');

const SOURCE_IDENTITY_VERSION = 1;

class StatementSourceIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementSourceIdentityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatementSourceIdentityError(code, message);
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function windowsComparablePath(value) {
  return String(value).normalize('NFC').replace(/\\/g, '/').toLowerCase();
}

function windowsComparableBasename(value) {
  return path.posix.basename(String(value).replace(/\\/g, '/')).normalize('NFC').toLowerCase();
}

function statInteger(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  fail('STATEMENT_SOURCE_FILE_ID_INVALID', `Statement source ${label} is invalid`);
}

function regularFileStat(filePath, fsImpl) {
  let stat;
  try {
    stat = fsImpl.statSync(filePath, { bigint: true });
  } catch (_error) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source is unavailable');
  }
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source is not a regular file');
  }
  return stat;
}

function canonicalRealPath(filePath, fsImpl) {
  try {
    return path.resolve(fsImpl.realpathSync(filePath));
  } catch (_error) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source cannot be resolved');
  }
}

function assertInsideAllowedRoot(realPath, allowedRoot, fsImpl) {
  if (allowedRoot === undefined || allowedRoot === null) return;
  const realRoot = canonicalRealPath(allowedRoot, fsImpl);
  const relative = path.relative(realRoot, realPath);
  if (relative !== '' &&
      (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) {
    fail('STATEMENT_SOURCE_RESOURCE_UNAVAILABLE', 'Statement source is outside the allowed root');
  }
}

function assertSourceSnapshot(snapshot, stat) {
  if (!sourceSnapshotMatchesStat(snapshot, stat)) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source evidence changed');
  }
}

async function streamSha256(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const createReadStream = typeof fsImpl.createReadStream === 'function'
    ? fsImpl.createReadStream.bind(fsImpl)
    : fs.createReadStream.bind(fs);
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(filePath)) {
      if (typeof options.assertNotCancelled === 'function') options.assertNotCancelled();
      hash.update(chunk);
    }
  } catch (error) {
    if (error && error.code === 'STATEMENT_IMPORT_CANCELLED') throw error;
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source content cannot be read');
  }
  if (typeof options.assertNotCancelled === 'function') options.assertNotCancelled();
  return hash.digest('hex');
}

function buildSourceIdentity(realPath, legacyPath, stat, contentSha256) {
  const deviceId = statInteger(stat.dev, 'device identity');
  const inode = statInteger(stat.ino, 'inode identity');
  const sizeBytes = Number(stat.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    fail('STATEMENT_SOURCE_SIZE_INVALID', 'Statement source size exceeds the supported range');
  }
  return Object.freeze({
    version: SOURCE_IDENTITY_VERSION,
    canonicalPathSha256: sha256Text(windowsComparablePath(realPath)),
    legacyBasenameSha256: sha256Text(windowsComparableBasename(legacyPath)),
    deviceId,
    inode,
    fileIdReliable: deviceId !== '0' || inode !== '0',
    sizeBytes,
    contentSha256
  });
}

function assertMetadataCurrent(source, fsImpl = fs) {
  const currentRealPath = canonicalRealPath(source.path, fsImpl);
  if (currentRealPath !== source.path) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source canonical path changed');
  }
  const stat = regularFileStat(currentRealPath, fsImpl);
  assertSourceSnapshot(source.snapshot, stat);
  const identity = source.sourceIdentity;
  if (!identity || identity.version !== SOURCE_IDENTITY_VERSION) {
    fail('STATEMENT_SOURCE_IDENTITY_MISSING', 'Statement source identity is missing');
  }
  const deviceId = statInteger(stat.dev, 'device identity');
  const inode = statInteger(stat.ino, 'inode identity');
  if (identity.fileIdReliable &&
      (identity.deviceId !== deviceId || identity.inode !== inode)) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source file identity changed');
  }
  return stat;
}

async function resolveStatementSourceIdentity(source, resolvedPath, options = {}) {
  const fsImpl = options.fs || fs;
  const realPath = canonicalRealPath(resolvedPath, fsImpl);
  assertInsideAllowedRoot(realPath, options.allowedRoot, fsImpl);
  const before = regularFileStat(realPath, fsImpl);
  assertSourceSnapshot(source.snapshot, before);
  const contentSha256 = await streamSha256(realPath, options);
  const after = regularFileStat(realPath, fsImpl);
  assertSourceSnapshot(source.snapshot, after);
  const beforeSnapshot = sourceSnapshotFromStat(before);
  if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, after)) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source changed while hashing');
  }
  return Object.freeze({
    resourceId: source.resourceId,
    templateRef: source.templateRef,
    path: realPath,
    snapshot: Object.freeze({ ...beforeSnapshot }),
    sourceIdentity: buildSourceIdentity(
      realPath,
      options.legacyPath || realPath,
      after,
      contentSha256
    )
  });
}

async function assertStatementSourceIdentityCurrent(source, options = {}) {
  const fsImpl = options.fs || fs;
  assertMetadataCurrent(source, fsImpl);
  const contentSha256 = await streamSha256(source.path, options);
  assertMetadataCurrent(source, fsImpl);
  if (contentSha256 !== source.sourceIdentity.contentSha256) {
    fail('BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT', 'Statement source content changed');
  }
  return true;
}

function fileIdKey(identity) {
  return identity.fileIdReliable ? `${identity.deviceId}:${identity.inode}` : null;
}

function duplicateCode(indexes, identity) {
  if (indexes.canonicalPaths.has(identity.canonicalPathSha256)) {
    return 'STATEMENT_SOURCE_CANONICAL_DUPLICATE';
  }
  const identityFileId = fileIdKey(identity);
  if (identityFileId && indexes.fileIds.has(identityFileId)) {
    return 'STATEMENT_SOURCE_FILE_ID_DUPLICATE';
  }
  if (indexes.legacyBasenames.has(identity.legacyBasenameSha256)) {
    return 'STATEMENT_SOURCE_NAME_DUPLICATE';
  }
  if (indexes.contents.has(identity.contentSha256)) {
    return 'STATEMENT_SOURCE_CONTENT_DUPLICATE';
  }
  return null;
}

function addIdentity(indexes, identity) {
  indexes.canonicalPaths.add(identity.canonicalPathSha256);
  const identityFileId = fileIdKey(identity);
  if (identityFileId) indexes.fileIds.add(identityFileId);
  indexes.legacyBasenames.add(identity.legacyBasenameSha256);
  indexes.contents.add(identity.contentSha256);
}

function existingSourceIdentities(state) {
  const identities = [];
  for (const session of state.sessions.values()) {
    for (const entry of session.fileEntries) {
      if (!entry.sourceIdentity) {
        fail('STATEMENT_SOURCE_IDENTITY_MISSING', 'Existing Statement entry lacks source identity');
      }
      identities.push(entry.sourceIdentity);
    }
  }
  return identities;
}

function createStatementSourceIdentityGuard(state) {
  const indexes = {
    canonicalPaths: new Set(),
    fileIds: new Set(),
    legacyBasenames: new Set(),
    contents: new Set()
  };
  for (const identity of existingSourceIdentities(state)) addIdentity(indexes, identity);

  function accept(source) {
    const identity = source && source.sourceIdentity;
    if (!identity) fail('STATEMENT_SOURCE_IDENTITY_MISSING', 'Statement source identity is missing');
    const code = duplicateCode(indexes, identity);
    if (code) {
      fail(code, 'Statement source duplicates a selected or previously imported source');
    }
    addIdentity(indexes, identity);
    return true;
  }

  return Object.freeze({ accept });
}

module.exports = {
  SOURCE_IDENTITY_VERSION,
  StatementSourceIdentityError,
  assertMetadataCurrent,
  assertStatementSourceIdentityCurrent,
  createStatementSourceIdentityGuard,
  resolveStatementSourceIdentity
};
