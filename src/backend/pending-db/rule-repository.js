// Pending 模块规则 CRUD（单条全局）
// rule 表 id 固定 '__GLOBAL__'；matchFields / compareFields 以 JSON 数组序列化

const RULE_GLOBAL_ID = '__GLOBAL__';

function parseJsonArray(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x) : [];
  } catch (_err) {
    return [];
  }
}

function getRule(db) {
  const row = db
    .prepare('SELECT id, match_fields, compare_fields, updated_at FROM rule WHERE id = ?')
    .get(RULE_GLOBAL_ID);
  if (!row) return null;
  return {
    matchFields: parseJsonArray(row.match_fields),
    compareFields: parseJsonArray(row.compare_fields),
    updatedAt: row.updated_at
  };
}

function upsertRule(db, payload = {}) {
  const matchFields = Array.isArray(payload.matchFields)
    ? payload.matchFields.filter((x) => typeof x === 'string' && x)
    : [];
  const compareFields = Array.isArray(payload.compareFields)
    ? payload.compareFields.filter((x) => typeof x === 'string' && x)
    : [];
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO rule (id, match_fields, compare_fields, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       match_fields = excluded.match_fields,
       compare_fields = excluded.compare_fields,
       updated_at = excluded.updated_at`
  ).run(RULE_GLOBAL_ID, JSON.stringify(matchFields), JSON.stringify(compareFields), now);
  return { matchFields, compareFields, updatedAt: now };
}

module.exports = {
  RULE_GLOBAL_ID,
  getRule,
  upsertRule
};
