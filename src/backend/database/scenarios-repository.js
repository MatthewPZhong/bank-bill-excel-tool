// v2.0.0-beta.3：银行对账单处理模块 — 场景 CRUD repository
//
// schema 定义在 migrations.js → ensureScenariosSupport
//
// 设计要点：
// - listScenarios 不返 config_json（轻量，列表只展示元数据）
// - getScenario(id) 才返完整 config（详情时拉，自动 JSON.parse）
// - 排序 (priority desc, id asc) — 与 PRD §7.4 调度顺序一致
// - name UNIQUE 约束破坏 → 抛 friendly error

const VALID_CATEGORIES = [
  'extract-recon-id',
  'offset-bill-mark',
  'gateway-recon-join'
];

function validateCategory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`非法功能类别 "${category}"，必须是以下之一：${VALID_CATEGORIES.join(' | ')}`);
  }
}

function validatePriority(priority) {
  const n = Number(priority);
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw new Error(`优先级必须是 0-3 的整数，当前为 ${priority}`);
  }
  return n;
}

function validateEnabled(enabled) {
  if (enabled === true || enabled === 1) return 1;
  if (enabled === false || enabled === 0) return 0;
  throw new Error(`enabled 必须是 0 / 1 / true / false，当前为 ${enabled}`);
}

function validateName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new Error('场景名称不能为空');
  }
  return trimmed;
}

function serializeConfig(config) {
  if (config === null || config === undefined) {
    throw new Error('场景配置 (config) 不能为空');
  }
  try {
    return JSON.stringify(config);
  } catch (error) {
    throw new Error(`场景配置序列化失败：${error.message || error}`);
  }
}

function parseConfig(configJson) {
  try {
    return JSON.parse(configJson);
  } catch (error) {
    return null;
  }
}

function rowToListItem(row) {
  return {
    id: Number(row.id),
    category: row.category,
    name: row.name,
    priority: Number(row.priority),
    enabled: Number(row.enabled) === 1,
    isBuiltin: Number(row.is_builtin) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToDetail(row) {
  return {
    ...rowToListItem(row),
    config: parseConfig(row.config_json)
  };
}

function listScenarios(db) {
  const rows = db
    .prepare(`
      SELECT id, category, name, priority, enabled, is_builtin, created_at, updated_at
      FROM scenarios
      ORDER BY priority DESC, id ASC
    `)
    .all();
  return rows.map(rowToListItem);
}

function getScenario(db, id) {
  const row = db
    .prepare(`
      SELECT id, category, name, priority, enabled, is_builtin, config_json, created_at, updated_at
      FROM scenarios
      WHERE id = ?
    `)
    .get(Number(id));
  return row ? rowToDetail(row) : null;
}

// 计算最小未使用的 scenario id：从 1 起找第一个 missing
// （PRD 用户偏好 2026-04-29：删除某条后新增应填补 gap，不用 AUTOINCREMENT 单调递增）
function calculateNextScenarioId(db) {
  const rows = db.prepare('SELECT id FROM scenarios ORDER BY id ASC').all();
  const used = new Set(rows.map((r) => Number(r.id)));
  let next = 1;
  while (used.has(next)) next++;
  return next;
}

function createScenario(db, payload) {
  const category = payload.category;
  validateCategory(category);
  const name = validateName(payload.name);
  const priority = validatePriority(payload.priority);
  const enabled = validateEnabled(payload.enabled);
  const configJson = serializeConfig(payload.config);
  const isBuiltin = payload.isBuiltin ? 1 : 0;
  const now = new Date().toISOString();
  const nextId = calculateNextScenarioId(db);

  try {
    db.prepare(`
        INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(nextId, category, name, priority, enabled, configJson, isBuiltin, now, now);
    return { id: nextId };
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE constraint failed: scenarios.name')) {
      throw new Error(`场景名 "${name}" 已存在，请换一个名字`);
    }
    throw error;
  }
}

function updateScenario(db, id, fields) {
  const numericId = Number(id);
  const existing = getScenario(db, numericId);
  if (!existing) {
    throw new Error(`场景 id=${numericId} 不存在`);
  }

  // category 和 is_builtin 不可改
  const sets = [];
  const params = [];

  if (fields.name !== undefined) {
    const name = validateName(fields.name);
    sets.push('name = ?');
    params.push(name);
  }
  if (fields.priority !== undefined) {
    const priority = validatePriority(fields.priority);
    sets.push('priority = ?');
    params.push(priority);
  }
  if (fields.enabled !== undefined) {
    const enabled = validateEnabled(fields.enabled);
    sets.push('enabled = ?');
    params.push(enabled);
  }
  if (fields.config !== undefined) {
    const configJson = serializeConfig(fields.config);
    sets.push('config_json = ?');
    params.push(configJson);
  }

  if (sets.length === 0) {
    return { id: numericId, changed: false };
  }

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(numericId);

  try {
    db.prepare(`UPDATE scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { id: numericId, changed: true };
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE constraint failed: scenarios.name')) {
      throw new Error(`场景名 "${fields.name}" 已存在，请换一个名字`);
    }
    throw error;
  }
}

function deleteScenario(db, id) {
  const numericId = Number(id);
  const result = db.prepare('DELETE FROM scenarios WHERE id = ?').run(numericId);
  return { id: numericId, deleted: Number(result.changes) > 0 };
}

function toggleScenarioEnabled(db, id, enabled) {
  const numericId = Number(id);
  const validatedEnabled = validateEnabled(enabled);
  const now = new Date().toISOString();
  const result = db
    .prepare('UPDATE scenarios SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(validatedEnabled, now, numericId);
  if (Number(result.changes) === 0) {
    throw new Error(`场景 id=${numericId} 不存在`);
  }
  return { id: numericId, enabled: validatedEnabled === 1 };
}

module.exports = {
  VALID_CATEGORIES,
  calculateNextScenarioId,
  createScenario,
  deleteScenario,
  getScenario,
  listScenarios,
  toggleScenarioEnabled,
  updateScenario
};
