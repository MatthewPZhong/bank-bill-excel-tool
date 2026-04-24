// diff_runs + diff_rows CRUD
// key: (upper_month, lower_month, created_at) 按 OT-10 决策单月导出可选 run

function parseSnapshot(raw) {
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    upperMonth: row.upper_month,
    lowerMonth: row.lower_month,
    ruleSnapshot: parseSnapshot(row.rule_snapshot),
    createdAt: row.created_at,
    statNew: Number(row.stat_new) || 0,
    statMissing: Number(row.stat_missing) || 0,
    statChanged: Number(row.stat_changed) || 0
  };
}

function createRun(db, { upperMonth, lowerMonth, ruleSnapshot }) {
  const createdAt = new Date().toISOString();
  const snapshotJson = JSON.stringify(ruleSnapshot || {});
  const result = db.prepare(
    `INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
     VALUES (?, ?, ?, ?, 0, 0, 0)`
  ).run(upperMonth, lowerMonth, snapshotJson, createdAt);
  return Number(result.lastInsertRowid);
}

function updateRunStats(db, runId, { statNew = 0, statMissing = 0, statChanged = 0 }) {
  db.prepare('UPDATE diff_runs SET stat_new = ?, stat_missing = ?, stat_changed = ? WHERE id = ?')
    .run(Number(statNew) || 0, Number(statMissing) || 0, Number(statChanged) || 0, runId);
}

function getRunById(db, runId) {
  return mapRun(db.prepare('SELECT * FROM diff_runs WHERE id = ?').get(runId));
}

// created_at 是 ISO-8601 毫秒精度；同毫秒多 run 时用 id DESC 做 tie-breaker
// （资金敏感：防止"最新 run"取错导致用户导出错数据）
function listAllRuns(db) {
  return db.prepare('SELECT * FROM diff_runs ORDER BY created_at DESC, id DESC').all().map(mapRun);
}

function listRunsForMonthPair(db, upperMonth, lowerMonth) {
  return db
    .prepare('SELECT * FROM diff_runs WHERE upper_month = ? AND lower_month = ? ORDER BY created_at DESC, id DESC')
    .all(upperMonth, lowerMonth)
    .map(mapRun);
}

function getLatestRunForMonthPair(db, upperMonth, lowerMonth) {
  return mapRun(
    db
      .prepare('SELECT * FROM diff_runs WHERE upper_month = ? AND lower_month = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(upperMonth, lowerMonth)
  );
}

function listDiffRows(db, runId, type) {
  const sql = type
    ? 'SELECT id, run_id, type, upper_row_id, lower_row_id FROM diff_rows WHERE run_id = ? AND type = ? ORDER BY id'
    : 'SELECT id, run_id, type, upper_row_id, lower_row_id FROM diff_rows WHERE run_id = ? ORDER BY id';
  const rows = type
    ? db.prepare(sql).all(runId, type)
    : db.prepare(sql).all(runId);
  return rows.map((r) => ({
    id: Number(r.id),
    runId: Number(r.run_id),
    type: r.type,
    upperRowId: r.upper_row_id == null ? null : Number(r.upper_row_id),
    lowerRowId: r.lower_row_id == null ? null : Number(r.lower_row_id)
  }));
}

module.exports = {
  createRun,
  updateRunStats,
  getRunById,
  listAllRuns,
  listRunsForMonthPair,
  getLatestRunForMonthPair,
  listDiffRows
};
