'use strict';

const { isDeepStrictEqual } = require('node:util');

const {
  sameDuplicateSideDbRelPath
} = require('../duplicate-inbound-match-side-db-identity');

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function mapMirror(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    monthKey: row.month_key,
    sideRunId: Number(row.side_run_id),
    status: row.status,
    summary: parseJson(row.summary_json, {}),
    snapshotHash: row.snapshot_hash,
    bankFileName: row.bank_file_name,
    bankFileHash: row.bank_file_hash,
    documentFileName: row.document_file_name,
    documentFileHash: row.document_file_hash,
    sideDbRelPath: row.side_db_rel_path,
    operationKey: row.operation_key || null,
    producerTaskRunId: row.producer_task_run_id || null,
    inputEvidenceHash: row.input_evidence_hash || null,
    resultDigest: row.result_digest || null,
    errorMessage: row.error_message || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`重复入金主镜像 ${label} 必须是无首尾空格的非空字符串`);
  }
  return value;
}

function requireHash(value, label) {
  const hash = requireText(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new TypeError(`重复入金主镜像 ${label} 必须是SHA-256`);
  }
  return hash;
}

function requireSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`重复入金主镜像 ${label} 必须是正安全整数`);
  }
  return value;
}

function normalizeManagedIdentity(payload) {
  return {
    operationKey: requireText(payload.operationKey, 'operationKey'),
    producerTaskRunId: requireText(payload.producerTaskRunId, 'producerTaskRunId'),
    inputEvidenceHash: requireHash(payload.inputEvidenceHash, 'inputEvidenceHash')
  };
}

function createRunMirror(db, payload = {}) {
  const hasManagedIdentity = payload.operationKey != null || payload.producerTaskRunId != null ||
    payload.inputEvidenceHash != null;
  const identity = hasManagedIdentity ? normalizeManagedIdentity(payload) : {
    operationKey: null,
    producerTaskRunId: null,
    inputEvidenceHash: null
  };
  const result = db.prepare(`
    INSERT INTO duplicate_inbound_match_run_mirrors (
      month_key, side_run_id, status, summary_json, snapshot_hash,
      bank_file_name, bank_file_hash, document_file_name, document_file_hash, side_db_rel_path,
      operation_key, producer_task_run_id, input_evidence_hash, result_digest
    ) VALUES (?, ?, 'running', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(payload.monthKey || ''),
    Number(payload.sideRunId),
    String(payload.snapshotHash || ''),
    String(payload.bankFileName || ''),
    String(payload.bankFileHash || ''),
    String(payload.documentFileName || ''),
    String(payload.documentFileHash || ''),
    String(payload.sideDbRelPath || ''),
    identity.operationKey,
    identity.producerTaskRunId,
    identity.inputEvidenceHash,
    payload.resultDigest == null ? null : requireHash(payload.resultDigest, 'resultDigest')
  );
  return Number(result.lastInsertRowid);
}

function getRunMirrorByOperation(db, operationKey) {
  return mapMirror(db.prepare(`
    SELECT * FROM duplicate_inbound_match_run_mirrors WHERE operation_key = ?
  `).get(requireText(operationKey, 'operationKey')));
}

function sameCommittedMirror(mirror, payload, identity) {
  return Boolean(mirror && mirror.status === 'success' &&
    mirror.operationKey === identity.operationKey &&
    mirror.producerTaskRunId === identity.producerTaskRunId &&
    mirror.inputEvidenceHash === identity.inputEvidenceHash &&
    mirror.resultDigest === payload.resultDigest &&
    mirror.monthKey === String(payload.monthKey || '') &&
    mirror.sideRunId === Number(payload.sideRunId) &&
    mirror.snapshotHash === String(payload.snapshotHash || '') &&
    mirror.bankFileName === String(payload.bankFileName || '') &&
    mirror.bankFileHash === String(payload.bankFileHash || '') &&
    mirror.documentFileName === String(payload.documentFileName || '') &&
    mirror.documentFileHash === String(payload.documentFileHash || '') &&
    sameDuplicateSideDbRelPath(mirror.sideDbRelPath, payload.sideDbRelPath) &&
    isDeepStrictEqual(mirror.summary, payload.summary || {}));
}

function createCommittedRunMirror(db, payload = {}) {
  const identity = normalizeManagedIdentity(payload);
  requireSafeId(payload.sideRunId, 'sideRunId');
  const resultDigest = requireHash(payload.resultDigest, 'resultDigest');
  const existing = getRunMirrorByOperation(db, identity.operationKey);
  if (existing) {
    if (!sameCommittedMirror(existing, payload, identity)) {
      const error = new Error('同一Duplicate operationKey已存在不同Main mirror identity');
      error.code = 'DUPLICATE_MIRROR_IDENTITY_CONFLICT';
      throw error;
    }
    return { created: false, mirror: existing };
  }
  const result = db.prepare(`
    INSERT INTO duplicate_inbound_match_run_mirrors (
      month_key, side_run_id, status, summary_json, snapshot_hash,
      bank_file_name, bank_file_hash, document_file_name, document_file_hash,
      side_db_rel_path, operation_key, producer_task_run_id, input_evidence_hash,
      result_digest, error_message, finished_at
    ) VALUES (?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
  `).run(
    String(payload.monthKey || ''),
    Number(payload.sideRunId),
    JSON.stringify(payload.summary || {}),
    String(payload.snapshotHash || ''),
    String(payload.bankFileName || ''),
    String(payload.bankFileHash || ''),
    String(payload.documentFileName || ''),
    String(payload.documentFileHash || ''),
    String(payload.sideDbRelPath || ''),
    identity.operationKey,
    identity.producerTaskRunId,
    identity.inputEvidenceHash,
    resultDigest
  );
  return { created: true, mirror: getRunMirror(db, Number(result.lastInsertRowid)) };
}

function finishRunMirror(db, mirrorId, summary = {}) {
  const result = db.prepare(`
    UPDATE duplicate_inbound_match_run_mirrors
    SET status = 'success', summary_json = ?, error_message = NULL,
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(JSON.stringify(summary || {}), Number(mirrorId));
  if (result.changes !== 1) throw new Error(`重复入金匹配主库 run 镜像不存在或状态非法：${mirrorId}`);
  return getRunMirror(db, mirrorId);
}

function failRunMirror(db, mirrorId, error) {
  const message = error && error.message ? error.message : String(error || '运行失败');
  const result = db.prepare(`
    UPDATE duplicate_inbound_match_run_mirrors
    SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(message, Number(mirrorId));
  return result.changes === 1;
}

function markRunMirrorUnavailable(db, mirrorId, status, message) {
  if (!['interrupted', 'missing-side-db', 'invalid-side-db', 'superseded', 'expired'].includes(status)) {
    throw new TypeError(`重复入金匹配 run 镜像失效状态非法：${status}`);
  }
  const result = db.prepare(`
    UPDATE duplicate_inbound_match_run_mirrors
    SET status = ?, error_message = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(status, String(message || ''), Number(mirrorId));
  return result.changes === 1;
}

function getRunMirror(db, mirrorId) {
  return mapMirror(
    db.prepare('SELECT * FROM duplicate_inbound_match_run_mirrors WHERE id = ?').get(Number(mirrorId))
  );
}

function listRunMirrors(db) {
  return db.prepare(`
    SELECT * FROM duplicate_inbound_match_run_mirrors ORDER BY id ASC
  `).all().map(mapMirror);
}

function mapRecoveryAudit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sourceRef: row.source_ref,
    actionKey: row.action_key,
    operationKey: row.operation_key,
    producerTaskRunId: row.producer_task_run_id,
    inspectionEvidenceHash: row.inspection_evidence_hash,
    outcome: row.outcome,
    recoveryAction: row.recovery_action,
    sideRunId: row.side_run_id == null ? null : Number(row.side_run_id),
    mirrorId: row.mirror_id == null ? null : Number(row.mirror_id),
    boundedResult: parseJson(row.bounded_result_json, {}),
    resultHash: row.result_hash,
    createdAt: row.created_at
  };
}

function getRecoveryAuditBySource(db, sourceRef) {
  return mapRecoveryAudit(db.prepare(`
    SELECT * FROM duplicate_inbound_match_recovery_audits WHERE source_ref = ?
  `).get(requireText(sourceRef, 'sourceRef')));
}

function getRecoveryAuditByOperation(db, actionKey, operationKey, producerTaskRunId) {
  return mapRecoveryAudit(db.prepare(`
    SELECT * FROM duplicate_inbound_match_recovery_audits
    WHERE action_key = ? AND operation_key = ? AND producer_task_run_id = ?
  `).get(
    requireText(actionKey, 'actionKey'),
    requireText(operationKey, 'operationKey'),
    requireText(producerTaskRunId, 'producerTaskRunId')
  ));
}

function insertRecoveryAudit(db, payload = {}) {
  if (db.isTransaction !== true) {
    const error = new Error('Duplicate recovery audit必须在Main事务内写入');
    error.code = 'DUPLICATE_RECOVERY_AUDIT_TRANSACTION_REQUIRED';
    throw error;
  }
  const actionKey = requireText(payload.actionKey, 'actionKey');
  const operationKey = requireText(payload.operationKey, 'operationKey');
  const producerTaskRunId = requireText(payload.producerTaskRunId, 'producerTaskRunId');
  const sourceRef = requireText(payload.sourceRef, 'sourceRef');
  const inspectionEvidenceHash = requireHash(payload.inspectionEvidenceHash, 'inspectionEvidenceHash');
  const resultHash = requireHash(payload.resultHash, 'resultHash');
  const boundedResultJson = JSON.stringify(payload.boundedResult || {});
  const inserted = db.prepare(`
    INSERT INTO duplicate_inbound_match_recovery_audits (
      source_ref, action_key, operation_key, producer_task_run_id,
      inspection_evidence_hash, outcome, recovery_action, side_run_id, mirror_id,
      bounded_result_json, result_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_ref) DO NOTHING
  `).run(
    sourceRef,
    actionKey,
    operationKey,
    producerTaskRunId,
    inspectionEvidenceHash,
    requireText(payload.outcome, 'outcome'),
    requireText(payload.recoveryAction, 'recoveryAction'),
    payload.sideRunId == null ? null : requireSafeId(payload.sideRunId, 'sideRunId'),
    payload.mirrorId == null ? null : requireSafeId(payload.mirrorId, 'mirrorId'),
    boundedResultJson,
    resultHash
  );
  const audit = getRecoveryAuditBySource(db, sourceRef);
  const same = audit && audit.actionKey === actionKey && audit.operationKey === operationKey &&
    audit.producerTaskRunId === producerTaskRunId &&
    audit.inspectionEvidenceHash === inspectionEvidenceHash &&
    audit.outcome === payload.outcome && audit.recoveryAction === payload.recoveryAction &&
    audit.sideRunId === (payload.sideRunId == null ? null : payload.sideRunId) &&
    audit.mirrorId === (payload.mirrorId == null ? null : payload.mirrorId) &&
    audit.resultHash === resultHash && JSON.stringify(audit.boundedResult) === boundedResultJson;
  if (!same) {
    const error = new Error('同一Duplicate recovery source已存在不同审计结果');
    error.code = 'DUPLICATE_RECOVERY_AUDIT_CONFLICT';
    throw error;
  }
  return { created: Number(inserted.changes) === 1, audit };
}

module.exports = {
  createRunMirror,
  createCommittedRunMirror,
  finishRunMirror,
  failRunMirror,
  markRunMirrorUnavailable,
  getRunMirror,
  getRunMirrorByOperation,
  getRecoveryAuditByOperation,
  getRecoveryAuditBySource,
  insertRecoveryAudit,
  listRunMirrors
};
