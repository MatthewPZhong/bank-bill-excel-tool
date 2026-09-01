'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeTargetAliasKey,
  pathsAlias
} = require('../toolbox-target-identity');

class StatementStagingOwnershipError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'StatementStagingOwnershipError';
    this.code = 'STATEMENT_STAGING_OWNERSHIP_INVALID';
    this.reason = reason;
  }
}

function invalid(reason, message) {
  throw new StatementStagingOwnershipError(reason, message);
}

function isMissing(error) {
  return Boolean(error && error.code === 'ENOENT');
}

function isStrictDescendant(rootPath, candidatePath, options = {}) {
  const rootKey = normalizeTargetAliasKey(path.resolve(rootPath), options);
  const candidateKey = normalizeTargetAliasKey(path.resolve(candidatePath), options);
  return candidateKey !== rootKey && candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function readLstat(fsImpl, filePath) {
  return fsImpl.lstatSync(filePath, { bigint: true });
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function isValidTaskStagingResourceId(resourceId) {
  if (typeof resourceId !== 'string' || resourceId.length < 1 || resourceId.length > 256 ||
      resourceId.includes('\0') || path.isAbsolute(resourceId) || path.win32.isAbsolute(resourceId)) {
    return false;
  }
  const components = resourceId.split(/[\\/]/);
  return components.every((component) => component !== '' && component !== '.' && component !== '..');
}

function resolveTaskStagingResource(stagingRoot, resourceId) {
  const root = path.resolve(String(stagingRoot || ''));
  const candidate = path.resolve(root, String(resourceId || ''));
  if (!isStrictDescendant(root, candidate)) {
    invalid('outside', 'Statement staging resource escapes the task staging root');
  }
  return candidate;
}

/**
 * Verifies ownership from the task staging root down to a candidate. System
 * ancestors above stagingRoot are intentionally outside this ownership chain.
 */
function validateTaskOwnedStagingPath(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = path.resolve(String(options.stagingRoot || ''));
  const candidate = path.resolve(String(options.candidatePath || ''));
  const finalState = options.finalState || 'file';
  const allowMissingAncestors = options.allowMissingAncestors === true;

  if (!['file', 'missing', 'missing-or-file'].includes(finalState)) {
    throw new TypeError('Unsupported Statement staging finalState');
  }
  if (!isStrictDescendant(root, candidate)) {
    invalid('outside', 'Statement artifact is outside task staging');
  }

  let rootStat;
  try {
    rootStat = readLstat(fsImpl, root);
  } catch (_error) {
    invalid('root', 'Statement task staging root is missing');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    invalid('root', 'Statement task staging root must be a non-symlink directory');
  }

  let realRoot;
  try {
    realRoot = path.resolve(fsImpl.realpathSync(root));
  } catch (_error) {
    invalid('root', 'Statement task staging root realpath is unavailable');
  }

  const relative = path.relative(root, candidate);
  const components = relative.split(path.sep);
  let cursor = root;
  let missingAncestor = false;
  for (const component of components.slice(0, -1)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = readLstat(fsImpl, cursor);
    } catch (error) {
      if (allowMissingAncestors && isMissing(error)) {
        missingAncestor = true;
        continue;
      }
      invalid('ancestor-missing', 'Statement staging ancestor is missing');
    }
    if (missingAncestor) {
      invalid('ancestor-race', 'Statement staging ancestor appeared during validation');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      invalid('ancestor', 'Statement staging ancestors must be non-symlink directories');
    }
    let realAncestor;
    try {
      realAncestor = fsImpl.realpathSync(cursor);
    } catch (_error) {
      invalid('ancestor', 'Statement staging ancestor realpath is unavailable');
    }
    if (!isStrictDescendant(realRoot, realAncestor)) {
      invalid('realpath-outside', 'Statement staging ancestor realpath escapes task staging');
    }
  }

  let finalStat = null;
  try {
    finalStat = readLstat(fsImpl, candidate);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (!finalStat) {
    if (finalState === 'file') {
      invalid('file-missing', 'Statement staging artifact is missing');
    }
    return Object.freeze({
      root,
      realRoot,
      candidate,
      exists: false,
      stat: null
    });
  }
  if (missingAncestor) {
    invalid('ancestor-race', 'Statement staging ancestor appeared during validation');
  }
  if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
    invalid('file-type', 'Statement staging artifact must be a non-symlink regular file');
  }
  if (finalState === 'missing') {
    invalid('collision', 'Statement staging artifact already exists');
  }
  if (typeof finalStat.nlink === 'bigint' ? finalStat.nlink !== 1n : finalStat.nlink !== 1) {
    invalid('hardlink', 'Statement staging artifact must not have hard-link aliases');
  }

  let realCandidate;
  let realStat;
  try {
    realCandidate = path.resolve(fsImpl.realpathSync(candidate));
    realStat = readLstat(fsImpl, realCandidate);
  } catch (_error) {
    invalid('file-realpath', 'Statement staging artifact realpath is unavailable');
  }
  if (!isStrictDescendant(realRoot, realCandidate) || !sameIdentity(finalStat, realStat)) {
    invalid('realpath-outside', 'Statement staging artifact identity escapes task staging');
  }

  return Object.freeze({
    root,
    realRoot,
    candidate,
    realCandidate,
    exists: true,
    stat: finalStat
  });
}

function assertDistinctTaskOwnedPaths(filePaths, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const paths = Array.isArray(filePaths) ? filePaths.map((item) => path.resolve(String(item))) : [];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pathsAlias(fsImpl, paths[left], paths[right], {
        allowMissingParentLexicalFallback: true,
        platform: options.platform || process.platform
      })) {
        invalid('alias', 'Statement staging artifacts must not alias one another');
      }
    }
  }
  return Object.freeze(paths);
}

module.exports = {
  StatementStagingOwnershipError,
  assertDistinctTaskOwnedPaths,
  isValidTaskStagingResourceId,
  isStrictDescendant,
  resolveTaskStagingResource,
  validateTaskOwnedStagingPath
};
