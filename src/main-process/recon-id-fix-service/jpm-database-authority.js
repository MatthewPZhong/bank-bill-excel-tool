'use strict';

const path = require('node:path');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');

function normalizeReconFixJpmDatabasePath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) ||
      path.resolve(value) !== value || value.includes('\u0000')) {
    const error = new TypeError('ReconFix JPM Main databasePath 必须是规范绝对路径');
    error.code = 'RECON_FIX_JPM_DATABASE_AUTHORITY_INVALID';
    throw error;
  }
  return value;
}

function deriveReconFixJpmDatabaseIdentity(databasePath) {
  return canonicalSha256({
    contractVersion: 1,
    authorityKind: 'main-runtime-generation',
    databasePath: normalizeReconFixJpmDatabasePath(databasePath)
  });
}

function createReconFixJpmDatabaseAuthority(databasePath) {
  const ownedPath = normalizeReconFixJpmDatabasePath(databasePath);
  return Object.freeze({
    databasePath: ownedPath,
    databaseIdentity: deriveReconFixJpmDatabaseIdentity(ownedPath)
  });
}

module.exports = {
  createReconFixJpmDatabaseAuthority,
  deriveReconFixJpmDatabaseIdentity,
  normalizeReconFixJpmDatabasePath
};
