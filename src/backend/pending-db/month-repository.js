// Pending 月份元数据 + 行数据 CRUD
// pending_months：月元信息（year_month / imported_at / row_count / source_files / archive_path）
// pending_rows：31 列数据 + row_hash

const PENDING_COLUMNS = require('./columns');

function countRowsInMonth(db, yearMonth) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?')
    .get(yearMonth);
  return row ? row.n : 0;
}

function getMonthMeta(db, yearMonth) {
  const row = db
    .prepare(
      'SELECT year_month, imported_at, row_count, source_files, archive_path FROM pending_months WHERE year_month = ?'
    )
    .get(yearMonth);
  if (!row) return null;
  let sourceFiles = [];
  try {
    const parsed = JSON.parse(row.source_files);
    if (Array.isArray(parsed)) sourceFiles = parsed;
  } catch (_err) {
    // swallow
  }
  return {
    yearMonth: row.year_month,
    importedAt: row.imported_at,
    rowCount: row.row_count,
    sourceFiles,
    archivePath: row.archive_path || null
  };
}

function listMonths(db) {
  return db
    .prepare('SELECT year_month FROM pending_months ORDER BY year_month DESC')
    .all()
    .map((r) => r.year_month);
}

function upsertMonthMeta(db, { yearMonth, rowCount, sourceFiles, archivePath }) {
  const importedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO pending_months (year_month, imported_at, row_count, source_files, archive_path)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(year_month) DO UPDATE SET
       imported_at = excluded.imported_at,
       row_count = excluded.row_count,
       source_files = excluded.source_files,
       archive_path = excluded.archive_path`
  ).run(
    yearMonth,
    importedAt,
    Number(rowCount) || 0,
    JSON.stringify(Array.isArray(sourceFiles) ? sourceFiles : []),
    archivePath || null
  );
}

function deleteMonth(db, yearMonth) {
  db.prepare('DELETE FROM pending_rows WHERE year_month = ?').run(yearMonth);
  db.prepare('DELETE FROM pending_months WHERE year_month = ?').run(yearMonth);
}

// 返回一个 inserter 函数：inserter(yearMonth, rowHash, cellsArray31)
// 调用方负责开 transaction；每次调用一行 INSERT
function createRowInserter(db) {
  const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
  const placeholders = PENDING_COLUMNS.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO pending_rows (year_month, row_hash, ${colList}) VALUES (?, ?, ${placeholders})`
  );
  return (yearMonth, rowHash, cells) => {
    if (!Array.isArray(cells) || cells.length !== PENDING_COLUMNS.length) {
      throw new Error(`cells 长度必须为 ${PENDING_COLUMNS.length}（实际 ${Array.isArray(cells) ? cells.length : 'N/A'}）`);
    }
    return stmt.run(yearMonth, rowHash, ...cells);
  };
}

module.exports = {
  countRowsInMonth,
  getMonthMeta,
  listMonths,
  upsertMonthMeta,
  deleteMonth,
  createRowInserter
};
