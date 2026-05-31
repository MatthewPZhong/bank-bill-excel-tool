// v2.1.3 T2 — 业务OP数据核对：业务OP 主表 CRUD
// 主 DB (tool-data.sqlite) biz_op_recon_imports
// 操作：
//   - clearByDateBu(db, date, buName)：DELETE 同 (date, BU)（runs/diff_rows 联动清空由 run-repository.clearRunsAndDiffsByDateBu 完成）
//   - insertRows(db, date, buName, rows)：批量插入（rows 入参带 _rowIndex）
//   - getRowsByDateBu(db, date, buName)：对账算法用，按 normalizeBu 过滤（SQL LOWER(TRIM(bu_name))）
//   - getRowById(db, id)：writer 用
//   - listDistinctBus(db)：BU 下拉枚举（保留原值不 normalize；#A 拍板）
//   - listImportedDateBuPairs(db)：模块状态 + check-single-day
//   - countByBu(db, buName) / countDistinctDatesByBu(db, buName)：check-single-day 用

const { BIZ_OP_DB_COLUMNS } = require('./columns');

const TABLE = 'biz_op_recon_imports';

// 构造 INSERT SQL（共 25 个占位：data_date + bu_name + row_index + 22 列；其中 bu_name 在 23 列中
// 已包含 = 位置 2 的 bu_name，DB 列定义 = bu_name 单独列，BIZ_OP_DB_COLUMNS 已含 bu_name）
// 设计选择：直接用 BIZ_OP_DB_COLUMNS 全部 23 列 + 加 data_date + row_index 两个元数据 = 25 列
function buildInsertSql() {
  const cols = ['data_date', 'row_index', ...BIZ_OP_DB_COLUMNS].join(', ');
  const placeholders = ['?', '?', ...BIZ_OP_DB_COLUMNS.map(() => '?')].join(', ');
  return `INSERT INTO ${TABLE} (${cols}) VALUES (${placeholders})`;
}

const INSERT_SQL = buildInsertSql();

function clearByDateBu(db, date, buName) {
  // 仅清 imports；runs/diff_rows 联动清空由 run-repository.clearRunsAndDiffsByDateBu 调用（#15 拍板 A）
  // 资金红线 ⚠️ v2.1.3-fix7-C1：BU 比较与 getRowsByDateBu / countDistinctDatesByBu / getLatestDateByBu
  // 对齐用 LOWER(TRIM(bu_name))；否则首次落库 'BU-A' 后再用 ' bu-a ' 重新导入 → DELETE 命中 0 行 →
  // INSERT 追加 → DB 同 (date) 出现两份 BU 数据 → 对账串入串出，资金红线穿透
  const stmt = db.prepare(`
    DELETE FROM ${TABLE}
    WHERE data_date = ?
      AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
  `);
  return stmt.run(date, buName).changes || 0;
}

function insertRows(db, date, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  let count = 0;
  for (const row of rows) {
    const params = [date, row._rowIndex ?? 0];
    for (const col of BIZ_OP_DB_COLUMNS) {
      // 注意：bu_name 在 BIZ_OP_DB_COLUMNS 中由 reader 解析自列 2 业务方；直接保留原值落库
      params.push(row[col] == null ? '' : String(row[col]));
    }
    stmt.run(...params);
    count += 1;
  }
  return count;
}

// v2.1.12-beta β.2-T2：预编译逐行 inserter（边流式读边 INSERT 用，避免百万次 db.prepare）
// 返回 insertOne(date, row)；与 insertRows 共用 INSERT_SQL + 同列序/同 null→'' 归一（单一真理来源）。
// 调用方负责开事务（worker 内 BEGIN…COMMIT 包裹）。
function makeRowInserter(db) {
  const stmt = db.prepare(INSERT_SQL);
  return (date, row) => {
    const params = [date, row._rowIndex ?? 0];
    for (const col of BIZ_OP_DB_COLUMNS) {
      params.push(row[col] == null ? '' : String(row[col]));
    }
    return stmt.run(...params);
  };
}

// 按 (date, BU) 取业务 OP 行；BU 用 LOWER(TRIM(...)) 实现 normalizeBu 语义（#7 拍板 C）
// 对账算法用，需要原值落库 + 比较时 normalize
function getRowsByDateBu(db, date, buName) {
  const sql = `
    SELECT * FROM ${TABLE}
    WHERE data_date = ?
      AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
    ORDER BY row_index ASC
  `;
  return db.prepare(sql).all(date, buName);
}

function getRowById(db, id) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id);
}

// BU 下拉框枚举：保留原值（不 normalize）→ 下拉显示用户原始的"业务方"字面值
// 注意：多 BU 同名仅大小写不同时（如 "BU-A" / "bu-a"），用户视觉上是两个 option；
// 这是 #A 拍板（动态从业务方 distinct）的直接结果；对账时按 normalizeBu 会归并，
// 与下拉显示不强一致是设计接受的代价（spec §三 bu:list 标注）
function listDistinctBus(db) {
  const sql = `
    SELECT bu_name AS buName, COUNT(*) AS count
    FROM ${TABLE}
    GROUP BY bu_name
    ORDER BY bu_name ASC
  `;
  return db.prepare(sql).all();
}

// 已导入 (date, BU) 二元组 + 行数（模块状态查询用）
function listImportedDateBuPairs(db) {
  const sql = `
    SELECT data_date AS date, bu_name AS buName, COUNT(*) AS rowCount
    FROM ${TABLE}
    GROUP BY data_date, bu_name
    ORDER BY data_date DESC, bu_name ASC
  `;
  return db.prepare(sql).all();
}

// 按 BU 统计已导入日期数（#11 拍板 B：仅 1 日 → 弹续导对话框）
function countDistinctDatesByBu(db, buName) {
  const sql = `
    SELECT COUNT(DISTINCT data_date) AS cnt
    FROM ${TABLE}
    WHERE LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
  `;
  const row = db.prepare(sql).get(buName);
  return row ? Number(row.cnt || 0) : 0;
}

// 取某 BU 已导入的最新日期（check-single-day 用，返回给前端确认对话框文案）
function getLatestDateByBu(db, buName) {
  const sql = `
    SELECT MAX(data_date) AS latestDate
    FROM ${TABLE}
    WHERE LOWER(TRIM(bu_name)) = LOWER(TRIM(?))
  `;
  const row = db.prepare(sql).get(buName);
  return row ? row.latestDate : null;
}

module.exports = {
  TABLE,
  clearByDateBu,
  insertRows,
  makeRowInserter,
  getRowsByDateBu,
  getRowById,
  listDistinctBus,
  listImportedDateBuPairs,
  countDistinctDatesByBu,
  getLatestDateByBu
};
