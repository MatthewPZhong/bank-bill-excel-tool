'use strict';

// v3.2.13：设置 → 模板文件的用户版本仓储。
//   表由 migrations.ensureTemplateResourceVersionSupport 建立；内置版本 v1 不入库，没有 state 行即当前为内置。
//   版本行、当前指针与变更记录在同一事务内更新；冲突（当前版本已变化）在事务内判定并整体回滚。

const BUILTIN_VERSION_ID = 'v1';
const FIRST_USER_VERSION_NO = 2;

function plain(row) {
  return row ? { ...row } : null;
}

function parseStructure(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_error) {
    return {};
  }
}

function listVersions(db) {
  return db.prepare(`
    SELECT resource_id AS resourceId, version_id AS versionId, version_no AS versionNo,
      file_name AS fileName, size_bytes AS sizeBytes, sha256, validation,
      structure_json AS structureJson, app_version AS appVersion, created_at AS createdAt
    FROM template_resource_versions
    ORDER BY resource_id ASC, version_no DESC
  `).all().map((row) => {
    const { structureJson, ...rest } = plain(row);
    return { ...rest, structure: parseStructure(structureJson) };
  });
}

function listStates(db) {
  return db.prepare(`
    SELECT resource_id AS resourceId, current_version_id AS currentVersionId,
      next_version_no AS nextVersionNo, updated_at AS updatedAt
    FROM template_resource_state
  `).all().map(plain);
}

function readState(db, resourceId) {
  const row = db.prepare(`
    SELECT current_version_id AS currentVersionId, next_version_no AS nextVersionNo
    FROM template_resource_state WHERE resource_id = ?
  `).get(resourceId);
  return row
    ? { currentVersionId: row.currentVersionId, nextVersionNo: row.nextVersionNo }
    : { currentVersionId: BUILTIN_VERSION_ID, nextVersionNo: FIRST_USER_VERSION_NO };
}

function versionExists(db, resourceId, versionId) {
  if (versionId === BUILTIN_VERSION_ID) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM template_resource_versions WHERE resource_id = ? AND version_id = ?
  `).get(resourceId, versionId));
}

function writeState(db, resourceId, currentVersionId, nextVersionNo, now) {
  db.prepare(`
    INSERT INTO template_resource_state (resource_id, current_version_id, next_version_no, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET
      current_version_id = excluded.current_version_id,
      next_version_no = excluded.next_version_no,
      updated_at = excluded.updated_at
  `).run(resourceId, currentVersionId, nextVersionNo, now);
}

function insertChange(db, change) {
  db.prepare(`
    INSERT INTO template_resource_changes (
      created_at, resource_id, action, from_label, to_label, result, detail, app_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    change.createdAt,
    change.resourceId,
    change.action,
    change.fromLabel || '',
    change.toLabel || '',
    change.result === 'failed' ? 'failed' : 'success',
    change.detail || '',
    change.appVersion || ''
  );
}

function inTransaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    if (result && result.status !== 'success') {
      db.exec('ROLLBACK');
      return result;
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  }
}

// 新增用户版本；enable 时同时设为当前版本。expectedVersionId 与 versionNo 均须与事务内状态一致。
function commitVersion(db, { resourceId, version, enable, expectedVersionId, change, now }) {
  return inTransaction(db, () => {
    const state = readState(db, resourceId);
    if (expectedVersionId && state.currentVersionId !== expectedVersionId) {
      return { status: 'conflict', currentVersionId: state.currentVersionId };
    }
    if (version.versionNo !== state.nextVersionNo) {
      return { status: 'conflict', currentVersionId: state.currentVersionId };
    }
    db.prepare(`
      INSERT INTO template_resource_versions (
        resource_id, version_id, version_no, file_name, size_bytes, sha256, validation,
        structure_json, app_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resourceId,
      version.versionId,
      version.versionNo,
      version.fileName,
      version.sizeBytes,
      version.sha256,
      version.validation,
      JSON.stringify(version.structure || {}),
      version.appVersion || '',
      version.createdAt
    );
    writeState(
      db,
      resourceId,
      enable ? version.versionId : state.currentVersionId,
      state.nextVersionNo + 1,
      now
    );
    insertChange(db, change);
    return { status: 'success', previousVersionId: state.currentVersionId };
  });
}

function setCurrentVersion(db, { resourceId, versionId, expectedVersionId, change, now }) {
  return inTransaction(db, () => {
    const state = readState(db, resourceId);
    if (expectedVersionId && state.currentVersionId !== expectedVersionId) {
      return { status: 'conflict', currentVersionId: state.currentVersionId };
    }
    if (!versionExists(db, resourceId, versionId)) return { status: 'missing' };
    if (state.currentVersionId === versionId) return { status: 'success', unchanged: true };
    writeState(db, resourceId, versionId, state.nextVersionNo, now);
    insertChange(db, change);
    return { status: 'success', previousVersionId: state.currentVersionId };
  });
}

function deleteVersion(db, { resourceId, versionId, change }) {
  return inTransaction(db, () => {
    if (versionId === BUILTIN_VERSION_ID) return { status: 'builtin' };
    const state = readState(db, resourceId);
    if (state.currentVersionId === versionId) return { status: 'current' };
    const result = db.prepare(`
      DELETE FROM template_resource_versions WHERE resource_id = ? AND version_id = ?
    `).run(resourceId, versionId);
    if (!result.changes) return { status: 'missing' };
    insertChange(db, change);
    return { status: 'success' };
  });
}

function appendChange(db, change) {
  insertChange(db, change);
}

function listChanges(db, limit = 200) {
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
  return db.prepare(`
    SELECT id, created_at AS createdAt, resource_id AS resourceId, action,
      from_label AS fromLabel, to_label AS toLabel, result, detail, app_version AS appVersion
    FROM template_resource_changes
    ORDER BY id DESC
    LIMIT ?
  `).all(bounded).map(plain);
}

module.exports = {
  BUILTIN_VERSION_ID,
  FIRST_USER_VERSION_NO,
  appendChange,
  commitVersion,
  deleteVersion,
  listChanges,
  listStates,
  listVersions,
  setCurrentVersion
};
