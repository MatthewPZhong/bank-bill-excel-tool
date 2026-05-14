// v2.1.3 T2 — 业务OP数据核对：流水对账单主表 CRUD
// 主 DB (tool-data.sqlite) biz_op_recon_flow_imports
// 操作：
//   - clearByDate(db, date)：DELETE WHERE data_date=?（流水不分 BU，按 date 级清空，#4 拍板 A）
//   - insertRows(db, date, rows)：批量插入
//   - getRowsByDate(db, date)：返回全部流水（对账阶段在 session 层用 normalizeBu 过滤）
//   - getRowsByDateBu(db, date, buName)：SQL 层用 LOWER(TRIM(bu_dept)) 过滤（#7 拍板 C 一致性）
//   - listImportedDates(db)：模块状态查询

const { FLOW_DB_COLUMNS } = require('./columns');

const TABLE = 'biz_op_recon_flow_imports';

function buildInsertSql() {
  const cols = ['data_date', 'row_index', ...FLOW_DB_COLUMNS].join(', ');
  const placeholders = ['?', '?', ...FLOW_DB_COLUMNS.map(() => '?')].join(', ');
  return `INSERT INTO ${TABLE} (${cols}) VALUES (${placeholders})`;
}

const INSERT_SQL = buildInsertSql();

function clearByDate(db, date) {
  const stmt = db.prepare(`DELETE FROM ${TABLE} WHERE data_date = ?`);
  return stmt.run(date).changes || 0;
}

function insertRows(db, date, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  let count = 0;
  for (const row of rows) {
    const params = [date, row._rowIndex ?? 0];
    for (const col of FLOW_DB_COLUMNS) {
      params.push(row[col] == null ? '' : String(row[col]));
    }
    stmt.run(...params);
    count += 1;
  }
  return count;
}

function getRowsByDate(db, date) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE data_date = ? ORDER BY row_index ASC`).all(date);
}

// SQL 层 normalizeBu 过滤（与 imports-repository 一致；#7 拍板 C）
function getRowsByDateBu(db, date, buName) {
  const sql = `
    SELECT * FROM ${TABLE}
    WHERE data_date = ?
      AND LOWER(TRIM(bu_dept)) = LOWER(TRIM(?))
    ORDER BY row_index ASC
  `;
  return db.prepare(sql).all(date, buName);
}

function listImportedDates(db) {
  const sql = `
    SELECT data_date AS date, COUNT(*) AS rowCount
    FROM ${TABLE}
    GROUP BY data_date
    ORDER BY data_date DESC
  `;
  return db.prepare(sql).all();
}

module.exports = {
  TABLE,
  clearByDate,
  insertRows,
  getRowsByDate,
  getRowsByDateBu,
  listImportedDates
};
