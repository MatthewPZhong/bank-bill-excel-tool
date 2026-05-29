// v2.1.11 T2 — removed_pending_rows CRUD（移除归档 Pending 行）
// 表结构见 migrations.js（removed_pending_rows）：全 46 列 raw_json + 6 索引列。
//
// 接口：
//   - replaceByMonth(db, yearMonth, rows, sourceFile)：同月先删后插（幂等，避免重复导入累积）
//   - listByMonth(db, yearMonth)：返回该月全部行（含 raw 解析 + 索引列 + id）
//
// rows 来自 removed-reader.readRemovedPendingFile().rows，每项形如：
//   { raw:{列名:值,...}, order_no, recon_id, 金额, channel, merchant_id, bank_ref }
//
// ⚠️ 不动现有 pending_rows / diff_rows / diff_runs；本表为增量。

// 索引列写入顺序（与 migrations.js removed_pending_rows 列对齐）
const INDEX_COLUMNS = Object.freeze([
  'order_no',
  'recon_id',
  '金额',
  'channel',
  'merchant_id',
  'bank_ref'
]);

// 从一行 row（reader 输出）取索引字段值；优先取 row 顶层（reader 已抽），否则回落 raw
function indexValue(row, field) {
  if (row && row[field] !== undefined && row[field] !== null) return String(row[field]);
  if (row && row.raw && row.raw[field] !== undefined && row.raw[field] !== null) {
    return String(row.raw[field]);
  }
  return '';
}

// 同月先删后插（幂等）。调用方无需自开事务——本函数内部包一个事务保证原子。
// 返回 { deleted, inserted }
function replaceByMonth(db, yearMonth, rows, sourceFile) {
  if (!yearMonth) throw new Error('replaceByMonth: yearMonth 必填');
  const list = Array.isArray(rows) ? rows : [];
  const createdAt = new Date().toISOString();
  const src = sourceFile == null ? null : String(sourceFile);

  const insertStmt = db.prepare(
    `INSERT INTO removed_pending_rows
       (year_month, source_file, raw_json, order_no, recon_id, \`金额\`, channel, merchant_id, bank_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    const delResult = db
      .prepare('DELETE FROM removed_pending_rows WHERE year_month = ?')
      .run(yearMonth);
    let inserted = 0;
    for (const row of list) {
      const raw = row && row.raw && typeof row.raw === 'object' ? row.raw : {};
      insertStmt.run(
        yearMonth,
        src,
        JSON.stringify(raw),
        indexValue(row, 'order_no'),
        indexValue(row, 'recon_id'),
        indexValue(row, '金额'),
        indexValue(row, 'channel'),
        indexValue(row, 'merchant_id'),
        indexValue(row, 'bank_ref'),
        createdAt
      );
      inserted += 1;
    }
    db.exec('COMMIT');
    return { deleted: Number(delResult.changes) || 0, inserted };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }
}

// 解析 raw_json → 对象（损坏 JSON 返回 {}，不抛）
function parseRaw(rawJson) {
  if (typeof rawJson !== 'string' || !rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

// 返回该月全部移除行：[{ id, yearMonth, sourceFile, raw:{...46列}, order_no, recon_id, 金额, channel, merchant_id, bank_ref, createdAt }]
// 按 id 升序（与 engine 配对的"id 升序 1 对 1"语义一致）
function listByMonth(db, yearMonth) {
  const rows = db
    .prepare(
      `SELECT id, year_month, source_file, raw_json, order_no, recon_id, \`金额\`, channel, merchant_id, bank_ref, created_at
       FROM removed_pending_rows WHERE year_month = ? ORDER BY id`
    )
    .all(yearMonth);
  return rows.map((r) => ({
    id: Number(r.id),
    yearMonth: r.year_month,
    sourceFile: r.source_file || null,
    raw: parseRaw(r.raw_json),
    order_no: r.order_no == null ? '' : String(r.order_no),
    recon_id: r.recon_id == null ? '' : String(r.recon_id),
    金额: r['金额'] == null ? '' : String(r['金额']),
    channel: r.channel == null ? '' : String(r.channel),
    merchant_id: r.merchant_id == null ? '' : String(r.merchant_id),
    bank_ref: r.bank_ref == null ? '' : String(r.bank_ref),
    createdAt: r.created_at
  }));
}

function countByMonth(db, yearMonth) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM removed_pending_rows WHERE year_month = ?')
    .get(yearMonth);
  return row ? Number(row.n) || 0 : 0;
}

module.exports = {
  replaceByMonth,
  listByMonth,
  countByMonth,
  INDEX_COLUMNS
};
