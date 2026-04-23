// 对账时间预估：固定取 10000 行样本跑 NOT EXISTS JOIN，线性外推（OT-5 = a，精度 ±20%）
//
// v2.0.0-beta.2 性能修复：
// - benchmark 必须先建 (year_month, matchFields) 复合索引，否则 121 万行 subquery 会 O(n²) 全表扫描
// - JOIN 条件用 `=` 而不是 `IS`（两者 planner 计划相同，但 `=` 语义明确，更不依赖 planner 启发式）

const { ensureMatchIndex } = require('./engine');

const SAMPLE_SIZE = 10000;

function getMonthRowCount(db, yearMonth) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?').get(yearMonth);
  return row ? Number(row.n) || 0 : 0;
}

function estimateRunTimeMs(db, { upperMonth, lowerMonth, matchFields }) {
  if (!Array.isArray(matchFields) || matchFields.length === 0) {
    throw new Error('matchFields 不能为空');
  }
  const upperCount = getMonthRowCount(db, upperMonth);
  const lowerCount = getMonthRowCount(db, lowerMonth);
  const total = upperCount + lowerCount;
  if (total === 0) return 0;

  ensureMatchIndex(db, matchFields);

  // 样本 JOIN：lower LIMIT 10000 NOT EXISTS upper
  const onClause = matchFields
    .map((f) => `B.\`${f}\` = A.\`${f}\``)
    .join(' AND ');

  const start = Date.now();
  db.prepare(
    `SELECT 1 FROM pending_rows A
     WHERE A.year_month = ?
       AND NOT EXISTS (SELECT 1 FROM pending_rows B WHERE B.year_month = ? AND ${onClause})
     LIMIT ${SAMPLE_SIZE}`
  ).all(lowerMonth, upperMonth);
  const sampleMs = Date.now() - start;

  const sampleRowsActual = Math.min(lowerCount, SAMPLE_SIZE);
  if (sampleRowsActual === 0) {
    // 小数据集不足 benchmark 样本：直接返回 sample 时间作为估算
    return Math.max(sampleMs, 0);
  }

  // 线性外推：total_rows / sample_rows * sample_ms
  return Math.max(Math.round((total / sampleRowsActual) * sampleMs), 0);
}

module.exports = {
  estimateRunTimeMs,
  SAMPLE_SIZE
};
