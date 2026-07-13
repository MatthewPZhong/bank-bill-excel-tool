'use strict';

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function mapMirror(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    monthKey: row.month_key,
    sideRunId: Number(row.side_run_id),
    scenario: row.scenario,
    status: row.status,
    summary: parseJson(row.summary_json, {}),
    snapshotHash: row.snapshot_hash,
    bankFiles: parseJson(row.bank_files_json, []),
    sideDbRelPath: row.side_db_rel_path,
    errorMessage: row.error_message || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function createRunMirror(db, payload = {}) {
  const result = db.prepare(`
    INSERT INTO pre_fund_reconciliation_run_mirrors (
      month_key, side_run_id, scenario, status, summary_json,
      snapshot_hash, bank_files_json, side_db_rel_path
    ) VALUES (?, ?, ?, 'running', '{}', ?, ?, ?)
  `).run(
    String(payload.monthKey || ''),
    Number(payload.sideRunId),
    String(payload.scenario || ''),
    String(payload.snapshotHash || ''),
    JSON.stringify(Array.isArray(payload.bankFiles) ? payload.bankFiles : []),
    String(payload.sideDbRelPath || '')
  );
  return Number(result.lastInsertRowid);
}

function finishRunMirror(db, mirrorId, summary = {}) {
  const result = db.prepare(`
    UPDATE pre_fund_reconciliation_run_mirrors
    SET status = 'success', summary_json = ?, error_message = NULL,
        finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(summary || {}), Number(mirrorId));
  if (result.changes !== 1) throw new Error(`前置资金对账主库 run 镜像不存在：${mirrorId}`);
  return getRunMirror(db, mirrorId);
}

function failRunMirror(db, mirrorId, error) {
  const message = error && error.message ? error.message : String(error || '运行失败');
  const result = db.prepare(`
    UPDATE pre_fund_reconciliation_run_mirrors
    SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(message, Number(mirrorId));
  return result.changes === 1;
}

function markRunMirrorUnavailable(db, mirrorId, status, message) {
  if (!['interrupted', 'missing-side-db', 'superseded', 'expired'].includes(status)) {
    throw new TypeError(`前置资金对账 run 镜像失效状态非法：${status}`);
  }
  const result = db.prepare(`
    UPDATE pre_fund_reconciliation_run_mirrors
    SET status = ?, error_message = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).run(status, String(message || ''), Number(mirrorId));
  return result.changes === 1;
}

function getRunMirror(db, mirrorId) {
  return mapMirror(
    db.prepare('SELECT * FROM pre_fund_reconciliation_run_mirrors WHERE id = ?').get(Number(mirrorId))
  );
}

function listRunMirrors(db) {
  return db.prepare(`
    SELECT *
    FROM pre_fund_reconciliation_run_mirrors
    ORDER BY id ASC
  `).all().map(mapMirror);
}

module.exports = {
  createRunMirror,
  finishRunMirror,
  failRunMirror,
  markRunMirrorUnavailable,
  getRunMirror,
  listRunMirrors
};
