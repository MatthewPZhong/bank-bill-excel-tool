// v2.1.12 需求1 T-vcc-1 — VCC业务OP计算：运行历史 CRUD（主 DB tool-data.sqlite）
// 表 A：vcc_op_calc_runs（按月一行 = 一次计算汇总）
// 表 B：vcc_op_calc_run_files（每次运行的逐文件发生额明细）
// 范式蓝本：src/backend/bank-bu-recon-db/run-repository.js
//
// 资金红线 ⚠️：金额列（total_amount_out/in、total_amount、begin_op、end_op、amount_*）一律 TEXT 存储，
//   防 JS Number 浮点漂移（spec §1.2 / Q5）；调用方（session）负责整数分精度计算后传字符串。

const RUNS_TABLE = 'vcc_op_calc_runs';
const RUN_FILES_TABLE = 'vcc_op_calc_run_files';

// 插入一条运行汇总（表 A），返回新 runId
// payload: { yearMonth, fileCount, totalAmountOut, totalAmountIn, totalAmount, beginOp, endOp, currency }
// 资金红线 ⚠️：金额字段必须是已算好的字符串（session 整数分计算后传入），本层不做数值运算。
function insertRun(db, payload) {
  const {
    yearMonth,
    fileCount = 0,
    totalAmountOut,
    totalAmountIn,
    totalAmount,
    beginOp,
    endOp,
    currency = null
  } = payload || {};

  const stmt = db.prepare(`
    INSERT INTO ${RUNS_TABLE}
      (year_month, file_count, total_amount_out, total_amount_in, total_amount, begin_op, end_op, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    yearMonth,
    fileCount,
    String(totalAmountOut),
    String(totalAmountIn),
    String(totalAmount),
    String(beginOp),
    String(endOp),
    currency
  );
  return Number(result.lastInsertRowid);
}

// 批量插入逐文件明细（表 B），files = [{ fileName, rowCount, amountOut, amountIn, amount }]
// 调用方（session.saveRun）须把本调用与 insertRun 放在同一事务内（资金红线：runs/run_files 原子落库）。
function insertRunFiles(db, runId, files) {
  if (!Array.isArray(files) || files.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO ${RUN_FILES_TABLE}
      (run_id, file_name, row_count, amount_out, amount_in, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let n = 0;
  for (const f of files) {
    stmt.run(
      runId,
      String(f.fileName == null ? '' : f.fileName),
      Number(f.rowCount) || 0,
      String(f.amountOut),
      String(f.amountIn),
      String(f.amount)
    );
    n += 1;
  }
  return n;
}

// 列出某月全部 run（倒序）
function listRuns(db, yearMonth) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE year_month = ? ORDER BY run_at DESC, id DESC`).all(yearMonth);
}

// 取单条 run
function getRun(db, runId) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(runId) || null;
}

// 取某 run 的逐文件明细
function getRunFiles(db, runId) {
  return db.prepare(`SELECT * FROM ${RUN_FILES_TABLE} WHERE run_id = ? ORDER BY id ASC`).all(runId);
}

// distinct 已计算月份（供「显示余额」下拉），倒序
function listDistinctMonths(db) {
  return db.prepare(`
    SELECT
      year_month AS yearMonth,
      MAX(id) AS latestRunId,
      MAX(run_at) AS latestRunAt
    FROM ${RUNS_TABLE}
    GROUP BY year_month
    ORDER BY year_month DESC
  `).all();
}

// 取某月最新一次 run（"显示余额"取最新，仿 bank-bu-recon MAX(id)）
// 同月多 run 时取 id 最大者（与 listDistinctMonths 的 latestRunId 口径一致；run_at 默认精度到秒，
// 同秒多次运行用 id 兜底保证"最新"确定性）。
function getLatestRunByMonth(db, yearMonth) {
  return db.prepare(`
    SELECT * FROM ${RUNS_TABLE}
    WHERE year_month = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(yearMonth) || null;
}

module.exports = {
  insertRun,
  insertRunFiles,
  listRuns,
  getRun,
  getRunFiles,
  listDistinctMonths,
  getLatestRunByMonth
};
