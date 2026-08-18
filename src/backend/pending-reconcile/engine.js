// 对账 engine — 三类差异（new / missing / changed）
// ⚠️ 资金敏感：任何 SQL 改动必须跑 test-v2.0.0-pending-reconcile.js（小样本手工对照）
//
// v2.0.0-beta.2 Reverse Sync #5：对账语义改"单字段 fallback + id 升序 1 对 1 配对"
//   - 原 AND 语义：N 个对账字段全等才算同一笔（太严，order_no 变了就配不上）
//   - 新 A1 语义：按对账字段顺序逐轮匹配；第 n 轮用第 n 个字段做 key
//     - 每轮：未匹配的 upper/lower 行，按单字段 key 分组 + id 升序 → 同组 1 对 1 配对
//     - 配对成功的行移出候选池，进入下一轮用下一个字段
//     - N 轮跑完剩余：upper → missing；lower → new
//   - 同一对最多用到 1 个对账字段相等（符合"任一相等即同一笔"）
//   - changed 判定仍基于 compareFields 任一不等（IS NOT，NULL-safe）
//
// 索引：为每个对账字段 (year_month, col) 建单列索引（不是复合索引）

const crypto = require('node:crypto');
const PENDING_COLUMNS = require('../pending-db/columns');
const diffRepo = require('../pending-db/diff-repository');

function makeFieldIndexName(field) {
  const hash = crypto.createHash('sha1').update(field).digest('hex').slice(0, 12);
  return `idx_pending_match_${hash}`;
}

function assertFieldsInPendingColumns(fields, label) {
  for (const f of fields) {
    if (!PENDING_COLUMNS.includes(f)) {
      throw new Error(`${label} "${f}" 不在 Pending 模板 31 列内`);
    }
  }
}

// 为每个对账字段建覆盖索引 (year_month, col, id)
// - year_month 作前缀：WHERE 过滤
// - col 第 2：ROW_NUMBER OVER PARTITION BY col
// - id 第 3：ORDER BY id 走索引自然顺序，免 sort
// 3 个字段就建 3 个索引；lazy IF NOT EXISTS
function ensureMatchIndex(db, matchFields) {
  if (!Array.isArray(matchFields) || matchFields.length === 0) return [];
  assertFieldsInPendingColumns(matchFields, 'match field');
  const names = [];
  for (const f of matchFields) {
    const name = makeFieldIndexName(f);
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON pending_rows(year_month, \`${f}\`, id);`);
    names.push(name);
  }
  return names;
}

function buildChangedClause(compareFields, leftAlias, rightAlias) {
  if (!compareFields || compareFields.length === 0) return null;
  return compareFields
    .map((f) => `(${leftAlias}.\`${f}\` IS NOT ${rightAlias}.\`${f}\`)`)
    .join(' OR ');
}

function runReconciliationCore(db, {
  upperMonth,
  lowerMonth,
  rule,
  archiveReceipt,
  expectedDatasets = null
}) {
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
    if (archiveReceipt.archiveContractVersion === 1) {
      const currentUpper = db.prepare(
        'SELECT dataset_id FROM pending_months WHERE year_month = ?'
      ).get(upperMonth);
      const currentLower = db.prepare(
        'SELECT dataset_id FROM pending_months WHERE year_month = ?'
      ).get(lowerMonth);
      const currentRemoved = db.prepare(
        'SELECT dataset_id FROM pending_removed_months WHERE year_month = ?'
      ).get(upperMonth);
      if (!expectedDatasets
          || !currentUpper || currentUpper.dataset_id !== expectedDatasets.upper.datasetId
          || !currentLower || currentLower.dataset_id !== expectedDatasets.lower.datasetId
          || (currentRemoved ? currentRemoved.dataset_id : null) !== expectedDatasets.removedDatasetId) {
        throw new Error('Pending 来源 dataset 在运算开始前已变化，请重新运行');
      }
    }
    const createRun = archiveReceipt.archiveContractVersion === 1
      ? diffRepo.createRun
      : diffRepo.createLegacyRun;
    const runId = createRun(db, {
      upperMonth,
      lowerMonth,
      ruleSnapshot,
      archiveReceipt
    });

    // === 多轮配对：tmp_pairs(upper_id, lower_id) 累积已配对的 pair ===
    // UNIQUE 约束防单行被多轮重复配对
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS tmp_pairs (
        upper_id INTEGER NOT NULL UNIQUE,
        lower_id INTEGER NOT NULL UNIQUE
      );
    `);
    db.exec('DELETE FROM tmp_pairs;');

    // v2.0.0-beta.2 性能修复：原 SQL CTE + ROW_NUMBER + LEFT JOIN 在 121 万行规模 planner 出低效计划（11 分钟未完）
    // 改用 JS 层配对：SQL 只扫 (id, key) 覆盖索引（index-only scan ~500ms），JS 层 Map 分组 + 已匹配 Set 过滤 + 1 对 1 配对
    const matchedUpperIds = new Set();
    const matchedLowerIds = new Set();
    const insertPair = db.prepare('INSERT INTO tmp_pairs(upper_id, lower_id) VALUES (?, ?)');

    for (const field of matchFields) {
      const fieldEsc = `\`${field}\``;
      // SELECT 按 id 升序，走 (year_month, col, id) 覆盖索引，index-only scan
      const selectSql = `SELECT id, ${fieldEsc} AS k FROM pending_rows
        WHERE year_month = ? AND ${fieldEsc} IS NOT NULL AND ${fieldEsc} <> ''
        ORDER BY id`;
      const upperRows = db.prepare(selectSql).all(upperMonth);
      const lowerRows = db.prepare(selectSql).all(lowerMonth);

      // 分组：key → [id 升序]（SELECT 已 ORDER BY id，push 即保持升序）
      const upperByKey = new Map();
      for (const r of upperRows) {
        if (matchedUpperIds.has(r.id)) continue;
        let bucket = upperByKey.get(r.k);
        if (!bucket) { bucket = []; upperByKey.set(r.k, bucket); }
        bucket.push(r.id);
      }
      const lowerByKey = new Map();
      for (const r of lowerRows) {
        if (matchedLowerIds.has(r.id)) continue;
        let bucket = lowerByKey.get(r.k);
        if (!bucket) { bucket = []; lowerByKey.set(r.k, bucket); }
        bucket.push(r.id);
      }

      // 1 对 1 配对：同 key 取前 min(upper.length, lower.length) 对
      for (const [k, uIds] of upperByKey) {
        const lIds = lowerByKey.get(k);
        if (!lIds || lIds.length === 0) continue;
        const n = Math.min(uIds.length, lIds.length);
        for (let i = 0; i < n; i++) {
          insertPair.run(uIds[i], lIds[i]);
          matchedUpperIds.add(uIds[i]);
          matchedLowerIds.add(lIds[i]);
        }
      }
    }

    // === changed: 配对成功且 compareFields 任一不等 ===
    let changedResult = { changes: 0 };
    const changedClause = buildChangedClause(compareFields, 'A', 'B');
    if (changedClause) {
      changedResult = db.prepare(`
        INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id)
        SELECT ?, 'changed', p.upper_id, p.lower_id
        FROM tmp_pairs p
        INNER JOIN pending_rows A ON A.id = p.upper_id
        INNER JOIN pending_rows B ON B.id = p.lower_id
        WHERE ${changedClause}
      `).run(runId);
    }

    // === new: lower 月未配对的行 ===
    const newResult = db.prepare(`
      INSERT INTO diff_rows (run_id, type, lower_row_id)
      SELECT ?, 'new', A.id FROM pending_rows A
      LEFT JOIN tmp_pairs t ON t.lower_id = A.id
      WHERE A.year_month = ? AND t.lower_id IS NULL
    `).run(runId, lowerMonth);

    // === missing: upper 月未配对的行 ===
    const missingResult = db.prepare(`
      INSERT INTO diff_rows (run_id, type, upper_row_id)
      SELECT ?, 'missing', A.id FROM pending_rows A
      LEFT JOIN tmp_pairs t ON t.upper_id = A.id
      WHERE A.year_month = ? AND t.upper_id IS NULL
    `).run(runId, upperMonth);

    db.exec('DROP TABLE tmp_pairs;');

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
    try { db.exec('DROP TABLE IF EXISTS tmp_pairs;'); } catch (_e) { /* swallow */ }
    throw err;
  }
}

function runReconciliation(db, payload) {
  const receipt = payload && payload.archiveReceipt;
  const expected = payload && payload.expectedDatasets;
  if (!receipt || receipt.archiveContractVersion !== 1
      || typeof receipt.archiveTaskRunId !== 'string' || !receipt.archiveTaskRunId.trim()
      || !expected || !expected.upper || !expected.lower
      || typeof expected.upper.datasetId !== 'string' || !expected.upper.datasetId.trim()
      || typeof expected.lower.datasetId !== 'string' || !expected.lower.datasetId.trim()
      || (expected.removedDatasetId !== null
        && (typeof expected.removedDatasetId !== 'string' || !expected.removedDatasetId.trim()))) {
    throw new TypeError('Pending reconcile 必须携带 v1 Archive receipt 与 frozen dataset heads');
  }
  return runReconciliationCore(db, payload);
}

function runLegacyReconciliation(db, payload) {
  return runReconciliationCore(db, {
    ...payload,
    archiveReceipt: {
      archiveContractVersion: 0,
      archiveTaskRunId: null
    }
  });
}

module.exports = {
  runReconciliation,
  runLegacyReconciliation,
  ensureMatchIndex,
  // 暴露给测试的内部函数
  __internal: {
    buildChangedClause,
    makeFieldIndexName
  }
};
