// v2.1.3 T3 — 业务OP数据核对：对账运行 + 差异行 CRUD
// 主 DB (tool-data.sqlite) biz_op_recon_runs + biz_op_recon_diff_rows
// status: 永远 'success'（系统错误不落 runs，直接 throw 给 IPC handler）
//
// 关键函数：
//   - insertRun / getRunById / listRunsByDateBu / updateRunExportPath
//   - listSuccessDates(db, buName)：导出指定日期下拉来源（#13 拍板 A）
//   - listSuccessDatesInRange(db, buName, startDate, endDate)：区间导出
//   - listReadyDates(db, buName)：三件齐日期（T-1 业务OP + T-2 业务OP + T-1 流水按 normalizeBu 过滤均非空，#12 拍板 A）
//   - insertDiffRows / getDiffRowsByRun
//   - clearRunsAndDiffsByDateBu：重新导入清空旧 runs + diff_rows（#15 拍板 A，FK 顺序）

const RUNS_TABLE = 'biz_op_recon_runs';
const DIFF_TABLE = 'biz_op_recon_diff_rows';
const IMPORTS_TABLE = 'biz_op_recon_imports';
const FLOW_TABLE = 'biz_op_recon_flow_imports';

function insertRun(db, payload) {
  const {
    date,
    buName,
    status = 'success',
    stats = {}
  } = payload || {};

  const {
    t1OpTotal = 0,
    t2OpTotal = 0,
    flowTotal = 0,
    amountDiffCount = 0,
    multiOpAccountCount = 0,
    t1NotT2Count = 0,
    t2NotT1Count = 0
  } = stats;

  const stmt = db.prepare(`
    INSERT INTO ${RUNS_TABLE}
      (data_date, bu_name, status,
       t1_op_total, t2_op_total, flow_total,
       amount_diff_count, multi_op_account_count,
       t1_not_t2_count, t2_not_t1_count, export_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    date,
    buName,
    status,
    t1OpTotal,
    t2OpTotal,
    flowTotal,
    amountDiffCount,
    multiOpAccountCount,
    t1NotT2Count,
    t2NotT1Count,
    null
  );
  return Number(result.lastInsertRowid);
}

function getRunById(db, runId) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(runId) || null;
}

function listRunsByDateBu(db, date, buName) {
  return db.prepare(`
    SELECT * FROM ${RUNS_TABLE}
    WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
    ORDER BY run_at DESC
  `).all(date, buName);
}

function updateRunExportPath(db, runId, exportPath) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET export_path = ? WHERE id = ?`).run(exportPath, runId);
}

// 导出"指定日期"下拉来源：每个有 success run 的日期，取最近一次 run
// 返回 [{date, runId, runAt}]
function listSuccessDates(db, buName) {
  const sql = `
    SELECT
      data_date AS date,
      MAX(id) AS runId,
      MAX(run_at) AS runAt
    FROM ${RUNS_TABLE}
    WHERE status = 'success'
      AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
    GROUP BY data_date
    ORDER BY data_date DESC
  `;
  return db.prepare(sql).all(buName);
}

// 区间导出：返回区间内有 success run 的日期 + runId（取最近一次）
function listSuccessDatesInRange(db, buName, startDate, endDate) {
  const sql = `
    SELECT
      data_date AS date,
      MAX(id) AS runId,
      MAX(run_at) AS runAt
    FROM ${RUNS_TABLE}
    WHERE status = 'success'
      AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
      AND data_date >= ?
      AND data_date <= ?
    GROUP BY data_date
    ORDER BY data_date ASC
  `;
  return db.prepare(sql).all(buName, startDate, endDate);
}

// 列出"三件齐"日期（#12 拍板 A）：
//   - 业务 OP 含 (date=D, bu=BU)
//   - 业务 OP 含 (date=D-1, bu=BU)  即 T-2
//   - 流水 含 (date=D, normalizeBu(bu_dept)=normalizeBu(BU))
// 返回 [{date}] 按 date 倒序
// 实现思路：
//   1) 拿到该 BU 已导入的所有日期 D
//   2) 对每个 D，判断 D-1 是否在该 BU 已导入日期内
//   3) 对每个通过 1+2 的 D，判断该 date 下流水是否含该 BU 行（按 normalizeBu 过滤）
function listReadyDates(db, buName) {
  // 步 1：拿该 BU 已导入的全部日期
  const opDatesRows = db.prepare(`
    SELECT DISTINCT data_date AS date
    FROM ${IMPORTS_TABLE}
    WHERE LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
    ORDER BY data_date DESC
  `).all(buName);
  const opDateSet = new Set(opDatesRows.map(r => r.date));

  if (opDateSet.size === 0) return [];

  // 步 2 + 3：对每个 D，检查 D-1 在集合内 + 流水含 BU 行
  const result = [];
  const flowCheckStmt = db.prepare(`
    SELECT 1 FROM ${FLOW_TABLE}
    WHERE data_date = ?
      AND LOWER(TRIM(bu_dept)) = LOWER(TRIM(?))
    LIMIT 1
  `);

  for (const { date } of opDatesRows) {
    const prevDate = subOneDay(date);
    if (!opDateSet.has(prevDate)) continue;
    const flowRow = flowCheckStmt.get(date, buName);
    if (!flowRow) continue;
    result.push({ date });
  }
  return result;
}

// T → T-1 字符串日期减一（与 session.js 同名 helper 一致；UTC 避免时区抢跑）
function subOneDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 差异行批量插入（事务由调用方包，spec §五.1 步骤 6）
function insertDiffRows(db, runId, date, buName, diffRows) {
  if (!Array.isArray(diffRows) || diffRows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO ${DIFF_TABLE}
      (run_id, data_date, bu_name, source_table, source_row_id,
       cmp_t2, multi_op_flag, cmp_amount, amount_diff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const r of diffRows) {
    stmt.run(
      runId,
      date,
      buName,
      r.source_table,
      r.source_row_id,
      r.cmp_t2 || '',
      r.multi_op_flag || '',
      r.cmp_amount || '',
      r.amount_diff == null ? '' : String(r.amount_diff)
    );
    count += 1;
  }
  return count;
}

function getDiffRowsByRun(db, runId) {
  return db.prepare(`
    SELECT * FROM ${DIFF_TABLE}
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId);
}

// 重新导入清空旧 runs + diff_rows（#15 拍板 A）
// FK 顺序：先 diff_rows，再 runs（diff_rows.run_id FK runs.id）
// 调用方应包在更大的事务里（与 imports.clearByDateBu 同事务）
function clearRunsAndDiffsByDateBu(db, date, buName) {
  // 先删 diff_rows（按 run_id IN ...）
  const diffDel = db.prepare(`
    DELETE FROM ${DIFF_TABLE}
    WHERE run_id IN (
      SELECT id FROM ${RUNS_TABLE}
      WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
    )
  `).run(date, buName).changes || 0;

  // 再删 runs
  const runsDel = db.prepare(`
    DELETE FROM ${RUNS_TABLE}
    WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
  `).run(date, buName).changes || 0;

  return { diffRowsDeleted: diffDel, runsDeleted: runsDel };
}

module.exports = {
  insertRun,
  getRunById,
  listRunsByDateBu,
  updateRunExportPath,
  listSuccessDates,
  listSuccessDatesInRange,
  listReadyDates,
  insertDiffRows,
  getDiffRowsByRun,
  clearRunsAndDiffsByDateBu,
  // 内部 helper 导出便于测试
  subOneDay
};
