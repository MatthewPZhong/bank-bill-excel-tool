// v2.1.2 T2 — 月度银行对账单BU回填校验：月份数据 CRUD
// 主 DB (tool-data.sqlite) bank_bu_recon_pending_imports + bank_bu_recon_bank_imports
// 操作：
//   - listMonths：列已导入月份 + 各侧行数 + latestRunAt
//   - getMonthMeta：单月统计
//   - clearMonth：重新导入前清空指定月份两侧数据（事务）
//   - insertPendingRows / insertBankRows：批量插入（事务 + prepared stmt）
//   - getPendingRows / getBankRows：对账算法读取（含 row_index）

const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('./columns');

const PENDING_TABLE = 'bank_bu_recon_pending_imports';
const BANK_TABLE = 'bank_bu_recon_bank_imports';
const RUNS_TABLE = 'bank_bu_recon_runs';

function buildInsertSql(table, dbColumns) {
  const cols = ['year_month', 'row_index', ...dbColumns].join(', ');
  const placeholders = ['?', '?', ...dbColumns.map(() => '?')].join(', ');
  return `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`;
}

const PENDING_INSERT_SQL = buildInsertSql(PENDING_TABLE, PENDING_GUANLI_DB_COLUMNS);
const BANK_INSERT_SQL = buildInsertSql(BANK_TABLE, BANK_DB_COLUMNS);

function listMonths(db) {
  // 用 LEFT JOIN 拼三表，按 month 聚合，rows 来自 pending + bank 子查询
  const sql = `
    WITH pending_cnt AS (
      SELECT year_month, COUNT(*) AS pending_count
      FROM ${PENDING_TABLE} GROUP BY year_month
    ),
    bank_cnt AS (
      SELECT year_month, COUNT(*) AS bank_count
      FROM ${BANK_TABLE} GROUP BY year_month
    ),
    latest_run AS (
      SELECT year_month, MAX(run_at) AS latest_run_at, COUNT(*) AS run_count
      FROM ${RUNS_TABLE} GROUP BY year_month
    ),
    months AS (
      SELECT year_month FROM pending_cnt
      UNION
      SELECT year_month FROM bank_cnt
      UNION
      SELECT year_month FROM latest_run
    )
    SELECT
      months.year_month AS yearMonth,
      COALESCE(pending_cnt.pending_count, 0) AS pendingCount,
      COALESCE(bank_cnt.bank_count, 0) AS bankCount,
      COALESCE(latest_run.run_count, 0) AS runCount,
      latest_run.latest_run_at AS latestRunAt
    FROM months
    LEFT JOIN pending_cnt ON pending_cnt.year_month = months.year_month
    LEFT JOIN bank_cnt ON bank_cnt.year_month = months.year_month
    LEFT JOIN latest_run ON latest_run.year_month = months.year_month
    ORDER BY months.year_month DESC
  `;
  return db.prepare(sql).all();
}

function getMonthMeta(db, yearMonth) {
  const pendingRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${PENDING_TABLE} WHERE year_month = ?`).get(yearMonth);
  const bankRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${BANK_TABLE} WHERE year_month = ?`).get(yearMonth);
  return {
    yearMonth,
    pendingCount: pendingRow ? Number(pendingRow.cnt) : 0,
    bankCount: bankRow ? Number(bankRow.cnt) : 0
  };
}

// v2.1.2 PR #43 Codex F3 修复：拆出"无 BEGIN/COMMIT"的内部 inserter，让上层
// importMonthAtomic() 包一个事务 — 保证 clear+pending+bank 三步原子（任一失败全回滚）
// PR #43 self-review round 3 S1：删除外层 buildBatchInserter / insertPendingRows / insertBankRows /
// clearMonth — 这些 export 在 importMonth 改用 importMonthAtomic 后已无人调（src/ scripts/ 0 引用）
function buildBatchInserterInTxn(insertSql, dbColumns) {
  return function insertRowsInTxn(db, yearMonth, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const stmt = db.prepare(insertSql);
    let count = 0;
    for (const row of rows) {
      const params = [yearMonth, row._rowIndex ?? 0];
      for (const col of dbColumns) {
        params.push(row[col] ?? '');
      }
      stmt.run(...params);
      count += 1;
    }
    return count;
  };
}

const insertPendingRowsInTxn = buildBatchInserterInTxn(PENDING_INSERT_SQL, PENDING_GUANLI_DB_COLUMNS);
const insertBankRowsInTxn = buildBatchInserterInTxn(BANK_INSERT_SQL, BANK_DB_COLUMNS);

function getPendingRows(db, yearMonth) {
  return db.prepare(`SELECT * FROM ${PENDING_TABLE} WHERE year_month = ? ORDER BY row_index ASC`).all(yearMonth);
}

function getBankRows(db, yearMonth) {
  return db.prepare(`SELECT * FROM ${BANK_TABLE} WHERE year_month = ? ORDER BY row_index ASC`).all(yearMonth);
}

// v2.1.2 PR #43 Codex F3 修复：覆盖导入原子事务
// clearMonth(pending+bank+runs 删除) + insertPendingRows + insertBankRows 包成单个事务，
// 任一失败全部回滚（防止"清空 + 仅一侧导入成功"的不一致状态）
function importMonthAtomic(db, yearMonth, pendingRows, bankRows) {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${PENDING_TABLE} WHERE year_month = ?`).run(yearMonth);
    db.prepare(`DELETE FROM ${BANK_TABLE} WHERE year_month = ?`).run(yearMonth);
    db.prepare(`DELETE FROM ${RUNS_TABLE} WHERE year_month = ?`).run(yearMonth);
    const pCount = insertPendingRowsInTxn(db, yearMonth, pendingRows);
    const bCount = insertBankRowsInTxn(db, yearMonth, bankRows);
    db.exec('COMMIT');
    return { pendingCount: pCount, bankCount: bCount };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  listMonths,
  getMonthMeta,
  importMonthAtomic,
  getPendingRows,
  getBankRows,
  PENDING_TABLE,
  BANK_TABLE,
  RUNS_TABLE
};
