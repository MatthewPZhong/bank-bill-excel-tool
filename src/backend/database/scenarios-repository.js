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
  'gateway-recon-join',
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复（C4，business 子模式）
  'recon-id-fix',
  // v2.1.0-beta.3：网关对账单 ReconID 修复（C4，gateway 子模式）
  'gateway-recon-id-fix'
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

// v2.1.9 SR-FIX-1 (spec §16.3)：判定是否「scenarios.name UNIQUE 冲突」（兼容新旧约束）
//   旧：UNIQUE (name) → "UNIQUE constraint failed: scenarios.name"
//   新：UNIQUE (channel_id, name) → "UNIQUE constraint failed: scenarios.channel_id, scenarios.name"
function isScenarioNameUniqueError(error) {
  const msg = String(error && error.message ? error.message : error || '');
  return msg.includes('UNIQUE constraint failed: scenarios.name')
    || msg.includes('UNIQUE constraint failed: scenarios.channel_id, scenarios.name');
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
    // v2.1.9 N5：返 channel_id 给 UI（场景管理弹框按渠道过滤）
    //   channel_id 列在 N5 migration 中加上，老库升级后默认 backfill 到 1（通用）
    //   未 migration 的列不存在场景使用 row.channel_id ?? 1 兜底（不影响幂等）
    channelId: row.channel_id != null ? Number(row.channel_id) : 1,
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

// v2.1.9 N5 Phase 2 → Phase 4 reverse sync：listScenarios SQL 需兼容 channel_id 列
//   不存在的旧 schema（smoke 内部直接 CREATE TABLE 不跑 N5 migration 的场景）
//   - 优先 SELECT 含 channel_id（生产路径走 migration 后必有该列）
//   - 列不存在 → fallback 到不含 channel_id 的 SQL（rowToListItem 用 row.channel_id ?? 1 兜底）
//   - 用 db 实例 WeakMap 缓存检测结果，避免 hot path 每次 pragma 查询
const hasChannelIdColumnCache = new WeakMap();

function hasChannelIdColumn(db) {
  if (hasChannelIdColumnCache.has(db)) return hasChannelIdColumnCache.get(db);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM pragma_table_info('scenarios') WHERE name='channel_id'")
      .get();
    const has = row && Number(row.cnt) > 0;
    hasChannelIdColumnCache.set(db, has);
    return has;
  } catch (e) {
    hasChannelIdColumnCache.set(db, false);
    return false;
  }
}

function listScenarios(db) {
  const hasChannel = hasChannelIdColumn(db);
  const sql = hasChannel
    ? `SELECT id, category, name, priority, enabled, is_builtin, channel_id, created_at, updated_at
       FROM scenarios ORDER BY priority DESC, id ASC`
    : `SELECT id, category, name, priority, enabled, is_builtin, created_at, updated_at
       FROM scenarios ORDER BY priority DESC, id ASC`;
  const rows = db.prepare(sql).all();
  // v2.1.8 N3-1：派发 displayIndex（1-based），UI 列表序号 + dispatcher 命中场景显示统一来源
  //   spec.md §五 N3-D1 锁定：repository 层统一附 displayIndex，UI / 引擎共享 → 避免双源真理
  // 2026-05-27 N5 fix（资金红线）：N5 引入渠道维度后 displayIndex 必须按 channel 分组 1-based
  //   - UI 渠道过滤后 visible.forEach((s, idx) => renderRow(s, idx + 1)) — 渠道内序号
  //   - 全表 displayIndex 会导致 dispatcher 命中显示 7/8/9 但 UI 显示 1/2/3 串号
  //   - 老库无 channel_id 列 → 全部归通用 → 行为退化为全表 1-based（与 v2.1.8 一致）
  const idxByChannel = new Map();
  return rows.map((row) => {
    const item = rowToListItem(row);
    const next = (idxByChannel.get(item.channelId) || 0) + 1;
    idxByChannel.set(item.channelId, next);
    return Object.assign(item, { displayIndex: next });
  });
}

// v2.1.9 N5 (Phase 4 T17) — 双维调度 hot path API：
//   按 channelId + category 过滤 enabled scenarios，返回完整详情（含 config）
//   - 排序与 listScenarios 一致：priority DESC, id ASC（spec §2.4 first-match-wins 不变量依赖）
//   - 只返 enabled=1（dispatcher 调度不跑禁用场景，逻辑前置降低 caller 复杂度）
//   - 返字段：包含 config（dispatcher 内的 runScenario 需读 config）→ getScenario 同等粒度
//   - displayIndex 来源：在过滤后子集内 1-based（与全局 listScenarios 序号语义脱钩，
//     仅作为本次调度子集的位次，N5 实施初版统一附；caller 当前不依赖此 displayIndex）
//
// 资金红线（spec §2.4）：sort 顺序必须与 listScenarios 完全一致，否则 first-match-wins
//   在两套排序间漂移 → 同一行专属/通用阶段命中场景可能不一致。
function listByChannelIdAndCategory(db, channelId, category) {
  const numericChannelId = Number(channelId);
  if (!Number.isFinite(numericChannelId)) {
    throw new Error(`listByChannelIdAndCategory: channelId 必须是数字，当前为 ${channelId}`);
  }
  if (typeof category !== 'string' || !category) {
    throw new Error(`listByChannelIdAndCategory: category 必须是非空字符串，当前为 ${category}`);
  }
  const rows = db
    .prepare(`
      SELECT id, category, name, priority, enabled, is_builtin, channel_id, config_json, created_at, updated_at
      FROM scenarios
      WHERE channel_id = ? AND category = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `)
    .all(numericChannelId, String(category));
  return rows.map((row, idx) => Object.assign(rowToDetail(row), { displayIndex: idx + 1 }));
}

// v2.1.9 SR-FIX-1 (spec §16.3 / §6.3.2)：按 (channel_id, name) 查场景
//   - N7 bundle import 路径「channel 内同名跳过」语义依赖：先查目标 channel 内同名是否已存在
//   - 返回完整 detail（含 config）便于 caller 决定 skip / overwrite
//   - 返 null 表示该 channel 内无同名场景（可安全插入）
//   - 老 schema（无 channel_id 列）兜底：仅当 channelId=1（通用）时做全表 name 查；其他渠道返 null
function findByChannelAndName(db, channelId, name) {
  const numericChannelId = Number(channelId);
  if (!Number.isFinite(numericChannelId) || numericChannelId <= 0) {
    throw new Error(`findByChannelAndName: channelId 必须是正整数，当前为 ${channelId}`);
  }
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    throw new Error('findByChannelAndName: name 不能为空');
  }
  const hasChannel = hasChannelIdColumn(db);
  if (!hasChannel) {
    // 老 schema 无 channel_id 列 → 仅当请求「通用」(id=1) 时做全表 name 查
    if (numericChannelId !== 1) return null;
    const row = db
      .prepare(`SELECT id, category, name, priority, enabled, is_builtin, config_json, created_at, updated_at
                FROM scenarios WHERE name = ?`)
      .get(trimmedName);
    return row ? rowToDetail(row) : null;
  }
  const row = db
    .prepare(`SELECT id, category, name, priority, enabled, is_builtin, channel_id, config_json, created_at, updated_at
              FROM scenarios WHERE channel_id = ? AND name = ?`)
    .get(numericChannelId, trimmedName);
  return row ? rowToDetail(row) : null;
}

function getScenario(db, id) {
  // v2.1.9 N5 fix（资金红线）：必须 SELECT channel_id —— dispatcher.groupScenariosByChannelId
  //   依赖 scenario.channelId 切片；缺失会兜底到 1（通用），导致专属渠道场景被错应用到其他渠道行
  //   兼容老 schema（无 channel_id 列）：rowToDetail 内部 channelId 字段在 rowToListItem 已用 `row.channel_id != null ? Number(row.channel_id) : 1` 兜底
  const hasChannel = hasChannelIdColumn(db);
  const sql = hasChannel
    ? `SELECT id, category, name, priority, enabled, is_builtin, channel_id, config_json, created_at, updated_at
       FROM scenarios WHERE id = ?`
    : `SELECT id, category, name, priority, enabled, is_builtin, config_json, created_at, updated_at
       FROM scenarios WHERE id = ?`;
  const row = db.prepare(sql).get(Number(id));
  return row ? rowToDetail(row) : null;
}

// v2.1.9 N7 (Phase 7 T29) — 按 channelId 拉全部场景（含 disabled + 全 category）做 bundle 导出
//   - listByChannelIdAndCategory 受 enabled=1 + category 双重过滤，不适合导出场景
//   - 导出语义：用户当前看到的渠道全集（含 disabled），便于跨机器复制完整配置
//   - 排序与 listScenarios 一致：(priority desc, id asc)，保证 bundle 落盘顺序稳定（git diff 友好）
//   - 返字段含 config（已 JSON.parse）+ channelId（缺失列兜底为 1）
function listAllByChannelId(db, channelId) {
  const numericChannelId = Number(channelId);
  if (!Number.isFinite(numericChannelId)) {
    throw new Error(`listAllByChannelId: channelId 必须是数字，当前为 ${channelId}`);
  }
  const hasChannel = hasChannelIdColumn(db);
  if (!hasChannel) {
    // 老 schema 无 channel_id 列 → 仅当请求「通用」(id=1) 时返全表；其他渠道返空
    if (numericChannelId !== 1) return [];
    const rows = db
      .prepare(`SELECT id, category, name, priority, enabled, is_builtin, config_json, created_at, updated_at
                FROM scenarios ORDER BY priority DESC, id ASC`)
      .all();
    return rows.map(rowToDetail);
  }
  const rows = db
    .prepare(`SELECT id, category, name, priority, enabled, is_builtin, channel_id, config_json, created_at, updated_at
              FROM scenarios WHERE channel_id = ? ORDER BY priority DESC, id ASC`)
    .all(numericChannelId);
  return rows.map(rowToDetail);
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
    // v2.1.9 SR-FIX-1 (spec §16.3)：兼容新旧两种 UNIQUE 错误消息
    //   - 旧：UNIQUE (name) → "UNIQUE constraint failed: scenarios.name"
    //   - 新：UNIQUE (channel_id, name) → "UNIQUE constraint failed: scenarios.channel_id, scenarios.name"
    //   两种都抛 friendly error（同 channel 内同名）
    if (isScenarioNameUniqueError(error)) {
      throw new Error(`场景名 "${name}" 在该渠道下已存在，请换一个名字`);
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
  // PR #35 round 3 self-review P3-B：把 silent ignore 升级为显式 throw，约束可读
  if (fields && Object.prototype.hasOwnProperty.call(fields, 'category')) {
    throw new Error('updateScenario: category 不可修改（如需改类别请先 delete 再 create）');
  }
  if (fields && Object.prototype.hasOwnProperty.call(fields, 'is_builtin')) {
    throw new Error('updateScenario: is_builtin 不可修改');
  }
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
    // v2.1.9 SR-FIX-1 (spec §16.3)：兼容新旧两种 UNIQUE 错误消息（同 createScenario）
    if (isScenarioNameUniqueError(error)) {
      throw new Error(`场景名 "${fields.name}" 在该渠道下已存在，请换一个名字`);
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

// v2.1.9 N5 (Phase 5 T23) — 批量转移场景到目标渠道
//   入参：
//     scenarioIds 数组（单条转移 = 长度 1；批量转移 = 长度 N）
//     targetChannelId 目标渠道 id
//   校验：
//     - scenarioIds 必须是非空数组
//     - 所有 id 必须能转成有限数字（防 NaN / 字符串）
//     - targetChannelId 必须存在于 channels 表（避免 dispatch fallback 到不存在的渠道）
//     - 所有 scenarioIds 必须存在于 scenarios 表（部分缺失抛错；不可静默忽略）
//   行为：事务包裹 UPDATE scenarios SET channel_id=? WHERE id IN (...)
//   返回：{ transferredCount, targetChannelId }
//
// 资金红线（spec §10.1 转移搬运语义不可逆）：
//   - D4=a 搬运语义：A→B 后 A 内场景不再存在 → 必须事务包裹 + UI 二次确认
//   - 单事务原子性：任何一行 id 不存在或 channels 表无 targetChannelId → 全部回滚
//   - is_builtin scenarios 也允许转移（spec §4.3 未禁止内置场景在渠道间搬运）
function transferScenarios(db, scenarioIds, targetChannelId) {
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    throw new Error('transferScenarios: scenarioIds 必须是非空数组');
  }
  const numericTargetChannelId = Number(targetChannelId);
  if (!Number.isFinite(numericTargetChannelId) || numericTargetChannelId <= 0) {
    throw new Error(`transferScenarios: targetChannelId 必须是正整数，当前为 ${targetChannelId}`);
  }
  const numericIds = scenarioIds.map((id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`transferScenarios: scenario id 必须是正整数，当前为 ${id}`);
    }
    return n;
  });

  db.exec('BEGIN');
  try {
    // 1. 校验目标渠道存在
    const channelRow = db
      .prepare('SELECT id FROM channels WHERE id = ?')
      .get(numericTargetChannelId);
    if (!channelRow) {
      throw new Error(`目标渠道 id=${numericTargetChannelId} 不存在`);
    }
    // 2. 校验所有 scenarioIds 存在（事务内一次性查，找出缺失 id）
    const placeholders = numericIds.map(() => '?').join(',');
    const existRows = db
      .prepare(`SELECT id FROM scenarios WHERE id IN (${placeholders})`)
      .all(...numericIds);
    const existIds = new Set(existRows.map((r) => Number(r.id)));
    const missing = numericIds.filter((id) => !existIds.has(id));
    if (missing.length > 0) {
      throw new Error(`场景 id=${missing.join(',')} 不存在`);
    }
    // 3. 批量 UPDATE
    const now = new Date().toISOString();
    const updateStmt = db.prepare('UPDATE scenarios SET channel_id = ?, updated_at = ? WHERE id = ?');
    let transferredCount = 0;
    for (const id of numericIds) {
      const r = updateStmt.run(numericTargetChannelId, now, id);
      transferredCount += Number(r.changes);
    }
    db.exec('COMMIT');
    return { transferredCount, targetChannelId: numericTargetChannelId };
  } catch (error) {
    db.exec('ROLLBACK');
    // v2.1.9 SR-FIX-1 v0.10 reverse sync（spec §16.3.1）：transferScenarios UPDATE channel_id 也是
    //   (channel_id, name) 组合变更入口 — 目标渠道已有同名场景会撞复合 UNIQUE → 抛 friendly error
    //   与 createScenario / updateScenario UX 一致
    if (isScenarioNameUniqueError(error)) {
      throw new Error('目标渠道已有同名场景，请先重命名或删除目标渠道的同名场景');
    }
    throw error;
  }
}

// v2.1.9 N5 (Phase 5 T23) — 批量删除场景
//   入参：scenarioIds 数组（单条删除 = 长度 1；批量删除 = 长度 N）
//   校验：
//     - scenarioIds 必须是非空数组
//     - 所有 id 必须能转成有限正整数
//     - 内置场景（is_builtin=1）阻止删除（DB 层保护，不依赖 UI；spec §10.1 资金红线）
//   行为：事务包裹 DELETE FROM scenarios WHERE id IN (...) AND is_builtin = 0
//   返回：{ deletedCount }
//
// 资金红线（spec §10.1 批量删除有数据丢失风险）：
//   - is_builtin=1 保护必须在 DB 层（不依赖 UI 层禁用，防 DevTools 绕过）
//   - 事务包裹：内置场景检测失败时整批回滚（不允许"已删一半再抛错"）
//   - 内置场景命中即抛错（不静默跳过，让 UI 能反馈"操作未完成"）
function batchDelete(db, scenarioIds) {
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    throw new Error('batchDelete: scenarioIds 必须是非空数组');
  }
  const numericIds = scenarioIds.map((id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`batchDelete: scenario id 必须是正整数，当前为 ${id}`);
    }
    return n;
  });

  db.exec('BEGIN');
  try {
    const placeholders = numericIds.map(() => '?').join(',');
    // 1. 内置场景检测（DB 层保护）
    const builtinRows = db
      .prepare(`SELECT id, name FROM scenarios WHERE id IN (${placeholders}) AND is_builtin = 1`)
      .all(...numericIds);
    if (builtinRows.length > 0) {
      const names = builtinRows.map((r) => `"${r.name}"(id=${r.id})`).join(', ');
      throw new Error(`内置场景不可删：${names}`);
    }
    // 2. 批量删除（is_builtin=0 双保险条件，与 builtin 检测互为兜底）
    const result = db
      .prepare(`DELETE FROM scenarios WHERE id IN (${placeholders}) AND is_builtin = 0`)
      .run(...numericIds);
    const deletedCount = Number(result.changes);
    db.exec('COMMIT');
    return { deletedCount };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  VALID_CATEGORIES,
  calculateNextScenarioId,
  createScenario,
  deleteScenario,
  getScenario,
  listScenarios,
  // v2.1.9 N5 Phase 4 T17：双维调度 hot path
  listByChannelIdAndCategory,
  // v2.1.9 N7 Phase 7 T29：按渠道拉全部场景（导出 bundle 用）
  listAllByChannelId,
  // v2.1.9 N5 Phase 5 T23：转移 + 批量删除
  transferScenarios,
  batchDelete,
  toggleScenarioEnabled,
  updateScenario,
  // v2.1.9 SR-FIX-1 (spec §16.3 / §6.3.2)：按 (channel_id, name) 查（bundle import 路径用）
  findByChannelAndName,
  // 测试 hook：暴露 UNIQUE 错误判定 helper（unit test 验证兼容性用）
  isScenarioNameUniqueError
};
