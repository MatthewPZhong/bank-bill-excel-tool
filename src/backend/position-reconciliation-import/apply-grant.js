'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  PositionReconciliationError,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  assertPositionLargeImportSchema,
  positionLargeImportSchemaFingerprint
} = require('../../main-process/position-reconciliation/large-import-schema');
const {
  normalizePositionCheckpoint,
  positionCheckpointsEqual,
  readPositionDatabaseCheckpoint
} = require('../../main-process/position-reconciliation/side-db-mutation');

const SHA256_RE = /^[a-f0-9]{64}$/;

function invalidGrant(message) {
  return new PositionReconciliationError(
    'position-import-intent-not-durable',
    message
  );
}

function verifyPositionImportApplyGrant({
  grant,
  jobId,
  archiveManifestHash,
  sideDbPath,
  allowPreflightOnly = false
}) {
  const payload = grant && typeof grant === 'object' && !Array.isArray(grant)
    ? grant
    : {};
  const expectedJobId = text(jobId);
  const expectedManifestHash = text(archiveManifestHash).toLowerCase();
  if (text(payload.jobId) !== expectedJobId
      || text(payload.archiveManifestHash).toLowerCase() !== expectedManifestHash
      || !SHA256_RE.test(expectedManifestHash)) {
    throw invalidGrant('平盘导入 apply grant 与预检 manifest 不一致');
  }
  if (payload.preflightOnly === true) {
    if (!allowPreflightOnly) {
      throw invalidGrant('生产写入禁止使用 preflight-only grant');
    }
    return {
      preflightOnly: true,
      jobId: expectedJobId,
      archiveManifestHash: expectedManifestHash
    };
  }

  const operationToken = text(payload.operationToken);
  const schemaFingerprint = text(payload.schemaFingerprint).toLowerCase();
  const baseCheckpoint = normalizePositionCheckpoint(
    payload.baseCheckpoint,
    '导入 apply 基准 checkpoint'
  );
  const resolvedSideDbPath = path.resolve(String(sideDbPath || ''));
  if (!operationToken
      || !SHA256_RE.test(schemaFingerprint)
      || !baseCheckpoint
      || !String(sideDbPath || '').trim()
      || !fs.existsSync(resolvedSideDbPath)) {
    throw invalidGrant('平盘导入 apply grant 缺少持久化提交凭证');
  }

  const db = new DatabaseSync(resolvedSideDbPath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 30000;');
    assertPositionLargeImportSchema(db);
    const currentCheckpoint = readPositionDatabaseCheckpoint(db);
    const actualFingerprint = positionLargeImportSchemaFingerprint(db);
    if (!positionCheckpointsEqual(currentCheckpoint, baseCheckpoint)
        || actualFingerprint !== schemaFingerprint) {
      throw invalidGrant('平盘导入 apply 前侧库 checkpoint 或 schema 已变化');
    }
    return {
      preflightOnly: false,
      jobId: expectedJobId,
      operationToken,
      archiveManifestHash: expectedManifestHash,
      schemaFingerprint,
      baseCheckpoint
    };
  } finally {
    db.close();
  }
}

module.exports = {
  verifyPositionImportApplyGrant
};
