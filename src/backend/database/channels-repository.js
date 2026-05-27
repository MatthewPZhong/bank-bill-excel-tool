// v2.1.9 N5：银行渠道 CRUD repository
//
// schema 定义在 migrations.js → ensureChannelsTable
//
// 设计要点（PRD §四 / spec §4 / D1-D5 决策）：
// - 「通用」渠道 is_builtin=1（id=1），不可删不可改名（D1=a）
// - listChannels 返回所有渠道 + displayIndex（1-based）
//   2026-05-27 fix1-N5-UI-6.3：排序改为 is_builtin ASC, sort_order DESC, id DESC
//   → 自定义渠道（is_builtin=0）在前，「通用」(is_builtin=1) 排最下；
//   → 自定义渠道内部按 sort_order DESC, id DESC，新增的 id 大 → 排在最上
// - 删除渠道前必须检测下属 scenarios 数量 = 0（spec §3.2 (b) 阻止策略）
// - findByNameAndLocation 是 N5-8 调度 hot path，加 prepare 复用（caller 缓存 stmt）
// - UNIQUE (name, owner_location) 联合约束 → 抛 friendly error
// - 2026-05-27 fix1-N5-UI-6.2：「通用」(is_builtin=1) 的 label = name（即 '通用'），
//   非 builtin 渠道 label = `${name}-${ownerLocation}`

const GENERAL_CHANNEL_ID = 1;
const GENERAL_NAME = '通用';
const GENERAL_LOCATION = '通用';

function validateName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('渠道名称不能为空');
  if (trimmed.length > 100) throw new Error('渠道名称长度不能超过 100 字符');
  return trimmed;
}

function validateLocation(location) {
  const trimmed = String(location || '').trim();
  if (!trimmed) throw new Error('开户地不能为空');
  if (trimmed.length > 100) throw new Error('开户地长度不能超过 100 字符');
  return trimmed;
}

function rowToChannel(row, displayIndex) {
  if (!row) return null;
  const isBuiltin = row.is_builtin === 1;
  return {
    id: row.id,
    name: row.name,
    ownerLocation: row.owner_location,
    isBuiltin,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
    displayIndex,
    // 2026-05-27 fix1-N5-UI-6.2：「通用」(is_builtin=1) label 退化为 name（不再「通用-通用」）
    label: isBuiltin ? row.name : `${row.name}-${row.owner_location}`,
  };
}

// 列出所有渠道（2026-05-27 fix1-N5-UI-6.3：自定义渠道在前，通用排最下；自定义内部新增的排最上）
//   排序逻辑：is_builtin ASC（0 在前 / 1 在后）→ sort_order DESC（大的在前）→ id DESC（新建的在前）
//   等价语义：所有自定义渠道按"新建优先"排列，「通用」永远殿后兜底
function listChannels(db) {
  const rows = db
    .prepare('SELECT * FROM channels ORDER BY is_builtin ASC, sort_order DESC, id DESC')
    .all();
  return rows.map((row, i) => rowToChannel(row, i + 1));
}

function getChannelById(db, id) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!row) return null;
  // displayIndex 需要在 listChannels 全集里算；单查时不返
  return rowToChannel(row, null);
}

// N5-8 调度 hot path：按 (name, owner_location) 查渠道
function findByNameAndLocation(db, name, ownerLocation) {
  const row = db
    .prepare('SELECT * FROM channels WHERE name = ? AND owner_location = ?')
    .get(String(name || '').trim(), String(ownerLocation || '').trim());
  return row ? rowToChannel(row, null) : null;
}

// 取「通用」内置渠道（dispatcher 兜底用）
function getBuiltinGeneral(db) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(GENERAL_CHANNEL_ID);
  if (!row) {
    throw new Error('[channels-repository] 「通用」内置渠道丢失（id=1）— ensureChannelsTable 未跑');
  }
  return rowToChannel(row, 1);
}

function createChannel(db, { name, ownerLocation, sortOrder }) {
  const safeName = validateName(name);
  const safeLocation = validateLocation(ownerLocation);
  // 2026-05-27 fix1-N5-UI-6.4：未显式传 sortOrder 时默认 = max(existing sort_order) + 1
  //   配合 listChannels ORDER BY sort_order DESC 让新增渠道稳定排在最上（即使 id 不连续）；
  //   显式传 sortOrder（非负整数）则尊重 caller 意图。
  let safeSortOrder;
  if (Number.isInteger(sortOrder)) {
    safeSortOrder = sortOrder;
  } else {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM channels WHERE is_builtin = 0')
      .get();
    safeSortOrder = (Number(maxRow && maxRow.max_sort) || 0) + 1;
  }
  try {
    const result = db
      .prepare(`
        INSERT INTO channels (name, owner_location, is_builtin, sort_order, created_at)
        VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP)
      `)
      .run(safeName, safeLocation, safeSortOrder);
    return getChannelById(db, result.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE constraint failed: channels.name, channels.owner_location/.test(String(e && e.message))) {
      throw new Error(`渠道 "${safeName}-${safeLocation}" 已存在`);
    }
    throw e;
  }
}

function updateChannel(db, id, { name, ownerLocation, sortOrder }) {
  const existing = getChannelById(db, id);
  if (!existing) throw new Error(`渠道 id=${id} 不存在`);
  if (existing.isBuiltin) {
    throw new Error('系统内置「通用」渠道不可修改');
  }
  const safeName = name !== undefined ? validateName(name) : existing.name;
  const safeLocation = ownerLocation !== undefined ? validateLocation(ownerLocation) : existing.ownerLocation;
  const safeSortOrder = sortOrder !== undefined && Number.isInteger(sortOrder)
    ? sortOrder
    : existing.sortOrder;
  try {
    db.prepare(`
      UPDATE channels SET name = ?, owner_location = ?, sort_order = ?
      WHERE id = ?
    `).run(safeName, safeLocation, safeSortOrder, id);
    return getChannelById(db, id);
  } catch (e) {
    if (/UNIQUE constraint failed: channels.name, channels.owner_location/.test(String(e && e.message))) {
      throw new Error(`渠道 "${safeName}-${safeLocation}" 已存在`);
    }
    throw e;
  }
}

// 删除渠道（spec §3.2 (b) 阻止策略：is_builtin=1 + 下属 scenarios 数 > 0 都阻止）
function deleteChannel(db, id) {
  const existing = getChannelById(db, id);
  if (!existing) throw new Error(`渠道 id=${id} 不存在`);
  if (existing.isBuiltin) {
    throw new Error('系统内置「通用」渠道不可删除');
  }
  const cntRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM scenarios WHERE channel_id = ?')
    .get(id);
  if (cntRow && Number(cntRow.cnt) > 0) {
    throw new Error(`该渠道下有 ${cntRow.cnt} 个场景，请先转移或删除场景后再删除渠道`);
  }
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  return true;
}

module.exports = {
  GENERAL_CHANNEL_ID,
  GENERAL_NAME,
  GENERAL_LOCATION,
  listChannels,
  getChannelById,
  findByNameAndLocation,
  getBuiltinGeneral,
  createChannel,
  updateChannel,
  deleteChannel,
};
