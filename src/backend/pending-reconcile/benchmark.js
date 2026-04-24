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

  // 新 A1 语义多轮 fallback：样本 JOIN 只取第 1 个对账字段做 NOT EXISTS 取样，
  // 再按 matchFields.length 线性粗放（近似每轮耗时相当）
  const firstField = matchFields[0];
  const onClause = `B.\`${firstField}\` = A.\`${firstField}\``;

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
    return Math.max(sampleMs * matchFields.length, 0);
  }

  // 线性外推 × 轮数
  const perRoundMs = (total / sampleRowsActual) * sampleMs;
  return Math.max(Math.round(perRoundMs * matchFields.length), 0);
}

module.exports = {
  estimateRunTimeMs,
  SAMPLE_SIZE
};
