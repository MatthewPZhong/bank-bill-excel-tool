// v2.1.2 T2 — 月度银行对账单BU回填校验：对账运行历史 CRUD
// 主 DB (tool-data.sqlite) bank_bu_recon_runs
// status: v0.4 设计 'success'/'failed_anomaly'；v0.8 后实际只用 'success'（schema 字段保留兼容）

const RUNS_TABLE = 'bank_bu_recon_runs';

function insertRun(db, payload) {
  const {
    yearMonth,
    status,
    pendingTotal = 0,
    bankTotal = 0,
    matchedCount = 0,
    buDiffCount = 0,
    pendingUnmatched = 0,
    bankUnmatched = 0,
    anomalyCount = 0,
    anomalyReportPath = null,
    exportPath = null
  } = payload || {};

  const stmt = db.prepare(`
    INSERT INTO ${RUNS_TABLE}
      (year_month, status, pending_total, bank_total, matched_count, bu_diff_count,
       pending_unmatched, bank_unmatched, anomaly_count, anomaly_report_path, export_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    yearMonth,
    status,
    pendingTotal,
    bankTotal,
    matchedCount,
    buDiffCount,
    pendingUnmatched,
    bankUnmatched,
    anomalyCount,
    anomalyReportPath,
    exportPath
  );
  return Number(result.lastInsertRowid);
}

function updateRunExportPath(db, runId, exportPath) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET export_path = ? WHERE id = ?`).run(exportPath, runId);
}

function listRuns(db, yearMonth) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE year_month = ? ORDER BY run_at DESC`).all(yearMonth);
}

function getLatestRun(db, yearMonth) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE year_month = ? ORDER BY run_at DESC LIMIT 1`).get(yearMonth) || null;
}

function getRun(db, runId) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(runId) || null;
}

module.exports = {
  insertRun,
  updateRunExportPath,
  listRuns,
  getLatestRun,
  getRun
};
