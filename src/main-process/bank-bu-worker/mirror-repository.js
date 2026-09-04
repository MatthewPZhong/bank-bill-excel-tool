'use strict';

const { isDeepStrictEqual } = require('node:util');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { ABSENT_MIRROR_DIGEST, requireMonth } = require('./identity');

const RUNS_TABLE = 'bank_bu_recon_runs';

function mirrorError(code, message) {
  return Object.assign(new Error(message), { code });
}

function mapRow(row) {
  if (!row) return null;
  const mirror = {
    mirrorId: Number(row.id),
    yearMonth: row.year_month,
    sideRunId: row.side_run_id == null ? null : Number(row.side_run_id),
    operationKey: row.operation_key || null,
    producerTaskRunId: row.producer_task_run_id || null,
    inputEvidenceHash: row.input_evidence_hash || null,
    status: row.status,
    runAt: row.run_at,
    sideDbRelPath: row.side_db_rel_path || null,
    stats: Object.freeze({
      pendingTotal: Number(row.pending_total),
      bankTotal: Number(row.bank_total),
      matchedCount: Number(row.matched_count),
      buDiffCount: Number(row.bu_diff_count),
      pendingUnmatched: Number(row.pending_unmatched),
      bankUnmatched: Number(row.bank_unmatched),
      nmAnomalyCount: Number(row.anomaly_count)
    })
  };
  mirror.stableHash = row.stable_hash || canonicalSha256({
    yearMonth: mirror.yearMonth,
    sideRunId: mirror.sideRunId,
    operationKey: mirror.operationKey,
    producerTaskRunId: mirror.producerTaskRunId,
    inputEvidenceHash: mirror.inputEvidenceHash,
    status: mirror.status,
    runAt: mirror.runAt,
    sideDbRelPath: mirror.sideDbRelPath,
    stats: mirror.stats
  });
  return Object.freeze(mirror);
}

function hashMirror(mirror) {
  return mirror ? canonicalSha256({
    mirrorId: mirror.mirrorId,
    yearMonth: mirror.yearMonth,
    sideRunId: mirror.sideRunId,
    operationKey: mirror.operationKey,
    producerTaskRunId: mirror.producerTaskRunId,
    inputEvidenceHash: mirror.inputEvidenceHash,
    status: mirror.status,
    runAt: mirror.runAt,
    sideDbRelPath: mirror.sideDbRelPath,
    stats: mirror.stats,
    stableHash: mirror.stableHash
  }) : ABSENT_MIRROR_DIGEST;
}

function captureMirrorPreimage(db, yearMonth) {
  requireMonth(yearMonth);
  const rows = db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE year_month = ? ORDER BY id ASC`)
    .all(yearMonth);
  if (rows.length > 1) {
    throw mirrorError(
      'BANK_BU_MIRROR_NOT_UNIQUE',
      'BankBU同月存在多个Main mirror，无法建立唯一CAS pre-image'
    );
  }
  const mirror = rows.length === 1 ? mapRow(rows[0]) : null;
  return Object.freeze({
    yearMonth,
    expectedPreviousMirror: mirror,
    expectedPreviousMirrorHash: hashMirror(mirror)
  });
}

function samePreimage(current, expected) {
  if (current.expectedPreviousMirrorHash !== expected.expectedPreviousMirrorHash) return false;
  return isDeepStrictEqual(current.expectedPreviousMirror, expected.expectedPreviousMirror);
}

function postImageFromSide({ yearMonth, sideRun, receipt, relPath }) {
  if (!sideRun || !receipt || Number(sideRun.id) !== receipt.sideRunId ||
      sideRun.operation_key !== receipt.operationKey) {
    throw mirrorError('BANK_BU_SIDE_POST_IMAGE_INVALID', 'BankBU side run/receipt identity不一致');
  }
  const stats = Object.freeze({
    pendingTotal: Number(sideRun.pending_total),
    bankTotal: Number(sideRun.bank_total),
    matchedCount: Number(sideRun.matched_count),
    buDiffCount: Number(sideRun.bu_diff_count),
    pendingUnmatched: Number(sideRun.pending_unmatched),
    bankUnmatched: Number(sideRun.bank_unmatched),
    nmAnomalyCount: Number(sideRun.anomaly_count)
  });
  return Object.freeze({
    yearMonth,
    sideRunId: receipt.sideRunId,
    operationKey: receipt.operationKey,
    producerTaskRunId: receipt.producerTaskRunId,
    inputEvidenceHash: receipt.inputEvidenceHash,
    status: sideRun.status,
    runAt: sideRun.run_at,
    sideDbRelPath: relPath,
    stats
  });
}

function samePostImage(mirror, postImage) {
  return Boolean(mirror && mirror.yearMonth === postImage.yearMonth &&
    mirror.sideRunId === postImage.sideRunId && mirror.operationKey === postImage.operationKey &&
    mirror.producerTaskRunId === postImage.producerTaskRunId &&
    mirror.inputEvidenceHash === postImage.inputEvidenceHash &&
    mirror.status === postImage.status && mirror.runAt === postImage.runAt &&
    mirror.sideDbRelPath === postImage.sideDbRelPath &&
    isDeepStrictEqual(mirror.stats, postImage.stats));
}

function commitMirrorCas(db, expectedPreimage, postImage) {
  requireMonth(postImage.yearMonth);
  if (!expectedPreimage || expectedPreimage.yearMonth !== postImage.yearMonth) {
    throw mirrorError('BANK_BU_MIRROR_PREIMAGE_SCOPE_MISMATCH', 'BankBU mirror pre-image月份不匹配');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = captureMirrorPreimage(db, postImage.yearMonth);
    if (samePostImage(current.expectedPreviousMirror, postImage)) {
      db.exec('COMMIT');
      return Object.freeze({ replay: true, mirror: current.expectedPreviousMirror });
    }
    if (!samePreimage(current, expectedPreimage)) {
      throw mirrorError('BANK_BU_MIRROR_CAS_CONFLICT', 'BankBU Main mirror在side提交后发生并发变化');
    }
    db.prepare(`DELETE FROM ${RUNS_TABLE} WHERE year_month = ?`).run(postImage.yearMonth);
    const inserted = db.prepare(`
      INSERT INTO ${RUNS_TABLE} (
        year_month, run_at, status, pending_total, bank_total, matched_count, bu_diff_count,
        pending_unmatched, bank_unmatched, anomaly_count, side_db_rel_path, side_run_id,
        operation_key, producer_task_run_id, input_evidence_hash, stable_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      postImage.yearMonth, postImage.runAt, postImage.status,
      postImage.stats.pendingTotal, postImage.stats.bankTotal, postImage.stats.matchedCount,
      postImage.stats.buDiffCount, postImage.stats.pendingUnmatched,
      postImage.stats.bankUnmatched, postImage.stats.nmAnomalyCount,
      postImage.sideDbRelPath, postImage.sideRunId, postImage.operationKey,
      postImage.producerTaskRunId, postImage.inputEvidenceHash,
      canonicalSha256(postImage)
    );
    const mirror = mapRow(db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`)
      .get(Number(inserted.lastInsertRowid)));
    db.exec('COMMIT');
    return Object.freeze({ replay: false, mirror });
  } catch (error) {
    try { if (db.isTransaction) db.exec('ROLLBACK'); } catch (_rollbackError) { /* 原错误优先 */ }
    throw error;
  }
}

module.exports = {
  captureMirrorPreimage,
  commitMirrorCas,
  hashMirror,
  mapRow,
  postImageFromSide,
  samePostImage,
  samePreimage
};
