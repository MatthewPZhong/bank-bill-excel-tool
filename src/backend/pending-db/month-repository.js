// Pending 月份元数据 + 行数据 CRUD
// pending_months：月元信息（year_month / imported_at / row_count / source_files / archive_path）
// pending_rows：31 列数据 + row_hash

const PENDING_COLUMNS = require('./columns');
const { randomUUID } = require('node:crypto');

function countRowsInMonth(db, yearMonth) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?')
    .get(yearMonth);
  return row ? row.n : 0;
}

function getMonthMeta(db, yearMonth) {
  const row = db
    .prepare(
      `SELECT year_month, imported_at, row_count, source_files, archive_path,
              dataset_id, producer_task_run_id, dataset_version, archive_contract_version
       FROM pending_months WHERE year_month = ?`
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
    archivePath: row.archive_path || null,
    datasetId: row.dataset_id || null,
    producerTaskRunId: row.producer_task_run_id || null,
    datasetVersion: Number(row.dataset_version) || 0,
    archiveContractVersion: Number(row.archive_contract_version) || 0
  };
}

function listMonths(db) {
  return db
    .prepare('SELECT year_month FROM pending_months ORDER BY year_month DESC')
    .all()
    .map((r) => r.year_month);
}

function writeMonthMeta(db, {
  yearMonth,
  rowCount,
  sourceFiles,
  archivePath,
  datasetIdentity
}) {
  const importedAt = new Date().toISOString();
  const identity = datasetIdentity;
  db.prepare(
    `INSERT INTO pending_months (
       year_month, imported_at, row_count, source_files, archive_path,
       dataset_id, producer_task_run_id, dataset_version, archive_contract_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year_month) DO UPDATE SET
       imported_at = excluded.imported_at,
       row_count = excluded.row_count,
       source_files = excluded.source_files,
       archive_path = excluded.archive_path,
       dataset_id = excluded.dataset_id,
       producer_task_run_id = excluded.producer_task_run_id,
       dataset_version = excluded.dataset_version,
       archive_contract_version = excluded.archive_contract_version`
  ).run(
    yearMonth,
    importedAt,
    Number(rowCount) || 0,
    JSON.stringify(Array.isArray(sourceFiles) ? sourceFiles : []),
    archivePath || null,
    identity.datasetId,
    identity.producerTaskRunId,
    identity.datasetVersion,
    identity.archiveContractVersion
  );
}

function upsertMonthMeta(db, payload) {
  return writeMonthMeta(db, payload);
}

function upsertMonthMetaLegacy(db, payload) {
  const current = getMonthMeta(db, payload.yearMonth);
  return writeMonthMeta(db, {
    ...payload,
    datasetIdentity: {
      datasetId: randomUUID(),
      producerTaskRunId: null,
      datasetVersion: current ? current.datasetVersion + 1 : 0,
      archiveContractVersion: 0
    }
  });
}

// 覆盖导入时调用：清空该月的 pending_rows / pending_months
// 另外清理**引用到该月**的 diff_runs / diff_rows —— 否则旧 run 的 upper_row_id / lower_row_id 悬空，
// 导出差异时 readPendingRow 返回 null → 写出空快照，严重资金敏感
// 还要清理 v2.1.11 T2 移除核对的 pending_removal_matches / removed_pending_rows —— 见下方注释。
// （FK ON DELETE CASCADE 在 migrations 仅 diff_rows.run_id 声明了，且 DatabaseSync 默认
//   PRAGMA foreign_keys = OFF；pending_removal_matches / removed_pending_rows 无 FK，
//   这里全部手动删除更稳妥，删除顺序见下）
//
// ⚠️ Codex PR #55 Finding 1（🔴 对账数据污染红线）：覆盖导入某月 pending = 该月数据整体重来，
//   该月所有相关数据（含移除归档 removed_pending_rows + 对账后核对匹配 pending_removal_matches）
//   一并失效，必须同步清。否则旧归档残留：reconcile handler（main.js `pending:reconcile:run`）
//   一旦发现该 upperMonth 仍有 removed_pending_rows（countByMonth>0）就自动跑移除核对，
//   用陈旧旧归档给新 missing 行错误标「核对无误 / 核对有差异」——即使用户在导入提示里点「否，跳过」。
//   语义：用户要核对需重新导入移除归档文件。
function deleteMonth(db, yearMonth) {
  const unacknowledged = db.prepare(`
    SELECT id FROM diff_runs
    WHERE (upper_month = ? OR lower_month = ?)
      AND archive_contract_version = 1
      AND archive_terminal_ack_at IS NULL
    LIMIT 1
  `).get(yearMonth, yearMonth);
  if (unacknowledged) {
    throw new Error('Pending run Archive terminal 尚未确认，禁止覆盖来源月份');
  }
  // 1) 先删 pending_removal_matches（依赖 diff_runs.id；必须在删 diff_runs 之前，
  //    否则 run 行删掉后 run_id 子查询取不到 id → 残留孤儿匹配记录）
  db.prepare(`DELETE FROM pending_removal_matches WHERE run_id IN (
    SELECT id FROM diff_runs WHERE upper_month = ? OR lower_month = ?
  )`).run(yearMonth, yearMonth);
  // 2) 删该月相关 diff_rows / diff_runs（diff_rows.run_id 同样依赖 diff_runs.id，先删 rows）
  db.prepare(`DELETE FROM diff_rows WHERE run_id IN (
    SELECT id FROM diff_runs WHERE upper_month = ? OR lower_month = ?
  )`).run(yearMonth, yearMonth);
  db.prepare('DELETE FROM diff_runs WHERE upper_month = ? OR lower_month = ?').run(yearMonth, yearMonth);
  // 3) 删该月移除归档行（覆盖导入 = 该月数据重来，旧归档基于旧数据应失效；Codex PR #55 Finding 1）
  db.prepare('DELETE FROM removed_pending_rows WHERE year_month = ?').run(yearMonth);
  db.prepare('DELETE FROM pending_removed_months WHERE year_month = ?').run(yearMonth);
  // 4) 删该月 pending 行 + 月元数据
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
  upsertMonthMetaLegacy,
  deleteMonth,
  createRowInserter
};
