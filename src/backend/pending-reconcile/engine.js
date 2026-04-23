// 对账 engine — 三类差异（new / missing / changed）
// ⚠️ 资金敏感：任何 SQL 改动必须跑 test-v2.0.0-pending-reconcile.js（小样本手工对照）
//
// SQL 说明:
// - JOIN 用 A.col IS B.col（非 =），处理 NULL 友好（TechDoc R-T4）
// - changed 条件: compareFields 任一列 IS NOT 对应列
// - matchFields 上 lazy 建 index（OT-T3）

const crypto = require('node:crypto');
const PENDING_COLUMNS = require('../pending-db/columns');
const diffRepo = require('../pending-db/diff-repository');

function makeMatchIndexName(matchFields) {
  const hash = crypto
    .createHash('sha1')
    .update(matchFields.join('\u0001'))
    .digest('hex')
    .slice(0, 12);
  return `idx_pending_match_${hash}`;
}

function assertFieldsInPendingColumns(fields, label) {
  for (const f of fields) {
    if (!PENDING_COLUMNS.includes(f)) {
      throw new Error(`${label} "${f}" 不在 Pending 模板 31 列内`);
    }
  }
}

function ensureMatchIndex(db, matchFields) {
  if (!Array.isArray(matchFields) || matchFields.length === 0) return null;
  assertFieldsInPendingColumns(matchFields, 'match field');
  const name = makeMatchIndexName(matchFields);
  const colList = matchFields.map((f) => `\`${f}\``).join(', ');
  db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON pending_rows(year_month, ${colList});`);
  return name;
}

function buildOnClause(matchFields, leftAlias, rightAlias) {
  return matchFields
    .map((f) => `${leftAlias}.\`${f}\` IS ${rightAlias}.\`${f}\``)
    .join(' AND ');
}

function buildChangedClause(compareFields, leftAlias, rightAlias) {
  if (!compareFields || compareFields.length === 0) return null;
  return compareFields
    .map((f) => `(${leftAlias}.\`${f}\` IS NOT ${rightAlias}.\`${f}\`)`)
    .join(' OR ');
}

function runReconciliation(db, { upperMonth, lowerMonth, rule }) {
  const matchFields = Array.isArray(rule && rule.matchFields) ? rule.matchFields : [];
  const compareFields = Array.isArray(rule && rule.compareFields) ? rule.compareFields : [];

  if (matchFields.length === 0) {
    throw new Error('matchFields 不能为空（未设置对账字段无法匹配 key）');
  }
  if (!upperMonth || !lowerMonth) {
    throw new Error('upperMonth / lowerMonth 必须提供');
  }
  assertFieldsInPendingColumns(matchFields, 'match field');
  assertFieldsInPendingColumns(compareFields, 'compare field');

  ensureMatchIndex(db, matchFields);

  const ruleSnapshot = {
    matchFields: matchFields.slice(),
    compareFields: compareFields.slice()
  };

  db.exec('BEGIN');
  try {
    const runId = diffRepo.createRun(db, { upperMonth, lowerMonth, ruleSnapshot });

    // 1) new: lower 有, upper 无
    const notExistsUpper = buildOnClause(matchFields, 'B', 'A');
    const newResult = db.prepare(
      `INSERT INTO diff_rows (run_id, type, lower_row_id)
       SELECT ?, 'new', A.id FROM pending_rows A
       WHERE A.year_month = ?
         AND NOT EXISTS (
           SELECT 1 FROM pending_rows B
           WHERE B.year_month = ? AND ${notExistsUpper}
         )`
    ).run(runId, lowerMonth, upperMonth);

    // 2) missing: upper 有, lower 无
    const notExistsLower = buildOnClause(matchFields, 'B', 'A');
    const missingResult = db.prepare(
      `INSERT INTO diff_rows (run_id, type, upper_row_id)
       SELECT ?, 'missing', A.id FROM pending_rows A
       WHERE A.year_month = ?
         AND NOT EXISTS (
           SELECT 1 FROM pending_rows B
           WHERE B.year_month = ? AND ${notExistsLower}
         )`
    ).run(runId, upperMonth, lowerMonth);

    // 3) changed: 两月匹配 key + compareFields 有差异
    let changedResult = { changes: 0 };
    const changedClause = buildChangedClause(compareFields, 'A', 'B');
    if (changedClause) {
      const joinOn = buildOnClause(matchFields, 'A', 'B');
      changedResult = db.prepare(
        `INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id)
         SELECT ?, 'changed', A.id, B.id
         FROM pending_rows A
         INNER JOIN pending_rows B ON ${joinOn}
         WHERE A.year_month = ? AND B.year_month = ?
           AND (${changedClause})`
      ).run(runId, upperMonth, lowerMonth);
    }

    const stats = {
      statNew: Number(newResult.changes) || 0,
      statMissing: Number(missingResult.changes) || 0,
      statChanged: Number(changedResult.changes) || 0
    };
    diffRepo.updateRunStats(db, runId, stats);
    db.exec('COMMIT');

    return {
      runId,
      ...stats,
      total: stats.statNew + stats.statMissing + stats.statChanged
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }
}

module.exports = {
  runReconciliation,
  ensureMatchIndex,
  // 暴露给测试的内部函数（避免 export 泄漏太广）
  __internal: {
    buildOnClause,
    buildChangedClause,
    makeMatchIndexName
  }
};
