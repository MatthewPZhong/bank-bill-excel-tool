// v2.1.6 T6 — 收单单据币种校验：对账运行 + 差异行 CRUD
// 主 DB (tool-data.sqlite) acquiring_bill_currency_runs + acquiring_bill_currency_diff_rows
// ⚠️ 资金红线：spec §5.2 核心 SQL JOIN 在 `insertDiffRowsByJoin`

const RUNS_TABLE = 'acquiring_bill_currency_runs';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const BILL_TABLE = 'acquiring_bill_currency_bill_imports';

// v0.14 fix12：显式传 ranAt（ISO 8601 带 Z 后缀），不再依赖 SQLite DEFAULT CURRENT_TIMESTAMP（返回 UTC 无 Z 后缀）
// caller 应传 new Date().toISOString()；caller 不传时仍依赖 DEFAULT（向后兼容旧调用方但语义模糊）
function insertRun(db, { monthKey, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status = 'success', ranAt = null }) {
  if (ranAt) {
    const stmt = db.prepare(`
      INSERT INTO ${RUNS_TABLE}
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(monthKey, ranAt, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status);
    return Number(result.lastInsertRowid);
  }
  // fallback：依赖 schema DEFAULT CURRENT_TIMESTAMP（UTC 无 Z）
  const stmt = db.prepare(`
    INSERT INTO ${RUNS_TABLE}
      (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(monthKey, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status);
  return Number(result.lastInsertRowid);
}

function getRunById(db, runId) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(runId) || null;
}

function getLatestRun(db, monthKey) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE month_key = ? ORDER BY ran_at DESC, id DESC LIMIT 1`).get(monthKey) || null;
}

// v0.8 fix5：run 完成后写盘成功时回填 diff/report 路径（写盘失败不应回滚 run 记录，仅日志）
function updateRunPaths(db, { runId, diffFilePath, reportFilePath }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET diff_file_path = ?, report_file_path = ? WHERE id = ?`)
    .run(diffFilePath || null, reportFilePath || null, runId);
}

// PR #50 NewF2：写盘失败后 run.status 改 'success-no-files'，让 cleanupOrphanData 跳过此类可恢复 run
function updateRunStatus(db, { runId, status }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET status = ? WHERE id = ?`).run(status, runId);
}

// 清空某月历史 runs + diff_rows（重新运行前调用，避免累积旧 diff_rows）
function clearRunsByMonth(db, monthKey) {
  db.prepare(`DELETE FROM ${DIFF_TABLE} WHERE run_id IN (SELECT id FROM ${RUNS_TABLE} WHERE month_key = ?)`).run(monthKey);
  db.prepare(`DELETE FROM ${RUNS_TABLE} WHERE month_key = ?`).run(monthKey);
}

// ⚠️ 资金红线 ⚠️ — spec §5.2 核心 SQL
// INNER JOIN flow + bill 按 (month_key, recon_main_id)；仅当 settle_currency_norm 不一致时写入 diff_rows
// diff_type:
//   - 单据 settle_currency_norm 为空/NULL → 'bill_currency_missing'
//   - 否则 → 'currency_mismatch'
// 入库时已 LOWER+TRIM 归一到 settle_currency_norm，此处直接比较（spec §5.3 + §3.1/§3.2 实现优化）
// v0.7 fix4：DB 字段重命名 currency_norm → settle_currency_norm / recon_amount_abs → settle_amount_abs
// diff_rows.flow_currency / flow_amount_abs 列名保留（避免 schema 二次变更），内容指向流水侧 settle_*
function insertDiffRowsByJoin(db, { runId, monthKey }) {
  const stmt = db.prepare(`
    INSERT INTO ${DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    SELECT
      ?,
      b.id,
      f.settle_currency,
      f.settle_amount_abs,
      CASE
        WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
        ELSE 'currency_mismatch'
      END
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
      AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `);
  const result = stmt.run(runId, monthKey);
  return Number(result.changes);
}

// 月内统计：单据总数 / matched（JOIN 上的） / mismatch / unmatched（单据有 ID 但流水无）
function computeRunStats(db, { monthKey }) {
  const totalBillRows = db.prepare(`SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?`).get(monthKey).c;

  const matchedRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
  `).get(monthKey).c;

  const mismatchRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
      AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `).get(monthKey).c;

  const unmatchedRows = totalBillRows - matchedRows;

  return { totalBillRows, matchedRows, mismatchRows, unmatchedRows };
}

// writer 用：按 source_file 拉某 run 的 diff 行 + 原始 raw_json
function listDiffRowsBySourceFile(db, { runId, sourceFile }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      b.source_row_index AS bill_source_row_index,
      d.flow_currency,
      d.flow_amount_abs,
      d.diff_type
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ? AND b.source_file = ?
    ORDER BY b.source_row_index ASC
  `).all(runId, sourceFile);
}

// v0.8 fix5：合并所有 source_file 的差异行，按 source_file + source_row_index 排序
function listAllDiffRowsByRun(db, { runId }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      b.source_file AS bill_source_file,
      b.source_row_index AS bill_source_row_index,
      d.flow_currency,
      d.flow_amount_abs,
      d.diff_type
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    ORDER BY b.source_file ASC, b.source_row_index ASC
  `).all(runId);
}

// v0.14 fix11：writer 多 sheet 用 — 统计每个账单日期的 diff 行数（按 bill_imports.raw_json '账单日期'）
// 返回 [{ billDate: '2026-03-01', count: 80000 }, ...] 按 billDate ASC
// 用 json_extract 路径 $."账单日期"（中文 key 需引号包裹）
function getBillDateCounts(db, { runId }) {
  return db.prepare(`
    SELECT
      json_extract(b.raw_json, '$."账单日期"') AS bill_date,
      COUNT(*) AS c
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    GROUP BY bill_date
    ORDER BY bill_date ASC
  `).all(runId).map((r) => ({ billDate: r.bill_date || '', count: r.c }));
}

// v0.14 fix11：writer 多 sheet 用 — 按账单日期范围分批拉 diff 行
// 同账单日期内按 source_file + source_row_index 排序保持稳定
function listDiffRowsByDateRange(db, { runId, startDate, endDate, limit, offset }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      d.flow_currency,
      d.flow_amount_abs
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') >= ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') <= ?
    ORDER BY json_extract(b.raw_json, '$."账单日期"') ASC, b.source_file ASC, b.source_row_index ASC
    LIMIT ? OFFSET ?
  `).all(runId, startDate, endDate, limit, offset);
}

// writer 用：拉某 run 涉及的所有 source_file（按用户导入的单据文件名 1 对 1 输出）
function listSourceFilesByRun(db, { runId, monthKey }) {
  return db.prepare(`
    SELECT DISTINCT source_file
    FROM ${BILL_TABLE}
    WHERE month_key = ?
    ORDER BY source_file ASC
  `).all(monthKey).map((r) => r.source_file);
}

module.exports = {
  insertRun,
  getRunById,
  getLatestRun,
  updateRunPaths,
  updateRunStatus,
  clearRunsByMonth,
  insertDiffRowsByJoin,
  computeRunStats,
  listDiffRowsBySourceFile,
  listAllDiffRowsByRun,
  getBillDateCounts,
  listDiffRowsByDateRange,
  listSourceFilesByRun
};
