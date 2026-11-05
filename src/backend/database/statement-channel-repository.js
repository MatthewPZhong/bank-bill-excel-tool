// v3.2.15 网银账单：渠道与子模板（取代主模板）。
//   渠道是本模块自己的模板分组（与对账模块的 channels 表无关）；模板经 templates.channel_id 归属渠道。
//   渠道下的子模板共用一份渠道账户映射（statement_channel_account_mappings），
//   迁移或模板包导入合并时的不一致账户号登记为待处理冲突，由用户选定后写入。
const { randomUUID } = require('node:crypto');
const { normalizeText } = require('./utils');

const CHILD_TEMPLATE_NAME_INFIX = '-子模板-';

function createChannelError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.detailLines = Array.isArray(extra.detailLines) ? extra.detailLines : [];
  error.context = extra.context || {};
  return error;
}

// 与 balance-seed-store.splitTemplateName 同口径（按 '-' 取前两段）；此处不引用以免把文件服务拉进数据层。
function splitOutputNameSegments(name) {
  const parts = String(name || '').split('-');
  return { bankName: parts[0] || '', location: parts[1] || '' };
}

function buildChildTemplateName(channelName, childNo) {
  return `${channelName}${CHILD_TEMPLATE_NAME_INFIX}${childNo}`;
}

function mapChannelRow(row) {
  return {
    id: Number(row.id),
    name: normalizeText(row.name),
    nextChildNo: Number(row.nextChildNo || 1),
    templateCount: Number(row.templateCount || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

const CHANNEL_SELECT = `
  SELECT
    c.id,
    c.name,
    c.next_child_no AS nextChildNo,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt,
    (SELECT COUNT(1) FROM templates t WHERE t.channel_id = c.id) AS templateCount
  FROM statement_channels c
`;

function listChannels(db) {
  return db.prepare(`${CHANNEL_SELECT} ORDER BY c.name ASC, c.id ASC`).all().map(mapChannelRow);
}

function getChannel(db, channelId) {
  const id = Number(channelId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.prepare(`${CHANNEL_SELECT} WHERE c.id = ?`).get(id);
  return row ? mapChannelRow(row) : null;
}

function getChannelByName(db, name) {
  const normalized = normalizeText(name);
  if (!normalized) return null;
  const row = db.prepare(`${CHANNEL_SELECT} WHERE c.name = ?`).get(normalized);
  return row ? mapChannelRow(row) : null;
}

function requireChannel(db, channelId) {
  const channel = getChannel(db, channelId);
  if (!channel) {
    throw createChannelError('CHANNEL_NOT_FOUND', '未找到对应渠道，请刷新后重试', {
      context: { channelId }
    });
  }
  return channel;
}

function normalizeChannelNameOrThrow(db, name, { excludeChannelId = null } = {}) {
  const normalized = normalizeText(name);
  if (!normalized) {
    throw createChannelError('CHANNEL_NAME_REQUIRED', '请输入渠道名称');
  }
  const existing = db.prepare('SELECT id FROM statement_channels WHERE name = ?').get(normalized);
  if (existing && Number(existing.id) !== Number(excludeChannelId)) {
    throw createChannelError('CHANNEL_NAME_DUPLICATED', `渠道「${normalized}」已存在`, {
      context: { channelName: normalized, channelId: Number(existing.id) }
    });
  }
  return normalized;
}

// 不开事务：供 saveMappings / 迁移 / 模板包导入在各自事务内调用。
function insertChannelRow(db, name, now = new Date().toISOString()) {
  const normalized = normalizeChannelNameOrThrow(db, name);
  const result = db
    .prepare('INSERT INTO statement_channels (name, next_child_no, created_at, updated_at) VALUES (?, 1, ?, ?)')
    .run(normalized, now, now);
  return Number(result.lastInsertRowid);
}

function getOrCreateChannelId(db, name, now = new Date().toISOString()) {
  const normalized = normalizeText(name);
  const existing = db.prepare('SELECT id FROM statement_channels WHERE name = ?').get(normalized);
  if (existing) return { channelId: Number(existing.id), created: false };
  return { channelId: insertChannelRow(db, normalized, now), created: true };
}

function runInTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v3.2.15（PR #246 审查）：普通模板（不属于任何渠道）与渠道同名时，两者的输出名称相同——明细 Channel 列、
//   余额银行名称与所在地、种子、余额调整和生成文件路径都按名称归属，生成时两组会互相覆盖、余额链混在一起。
//   因此渠道名不能与普通模板同名；生成前另有兜底检查（main.js findGenerationGroupOutputNameConflicts）。
function assertNoOrdinaryTemplateNamed(db, name, message) {
  const template = db.prepare('SELECT id FROM templates WHERE name = ? AND channel_id IS NULL').get(normalizeText(name));
  if (template) {
    throw createChannelError('CHANNEL_OUTPUT_NAME_CONFLICT', message, {
      context: { name: normalizeText(name), templateId: Number(template.id) }
    });
  }
}

function createChannel(db, name) {
  return runInTransaction(db, () => getChannel(db, insertChannelRow(db, name)));
}

function renameChannel(db, channelId, name) {
  return runInTransaction(db, () => {
    const channel = requireChannel(db, channelId);
    const normalized = normalizeChannelNameOrThrow(db, name, { excludeChannelId: channel.id });
    assertNoOrdinaryTemplateNamed(db, normalized,
      `已有同名的普通模板「${normalized}」，渠道与普通模板同名会使两者的输出名称相同、生成的账单与余额混在一起；请换一个渠道名称`);
    db.prepare('UPDATE statement_channels SET name = ?, updated_at = ? WHERE id = ?')
      .run(normalized, new Date().toISOString(), channel.id);
    return { previous: channel, channel: getChannel(db, channel.id) };
  });
}

function listTemplateIdsByChannel(db, channelId) {
  return db
    .prepare('SELECT id, name FROM templates WHERE channel_id = ? ORDER BY id ASC')
    .all(Number(channelId))
    .map((row) => ({ id: Number(row.id), name: normalizeText(row.name) }));
}

// ===== 账户映射 =====

function normalizeAccountMappingSetting(mapping = {}) {
  const noCurrency = Boolean(mapping.noCurrency);
  return {
    bankAccountId: normalizeText(mapping.bankAccountId),
    clearingAccountId: normalizeText(mapping.clearingAccountId),
    noCurrency,
    // 币种只在“无币种”时参与输出（file-service 兜底币种），比较口径与之一致。
    currency: noCurrency ? normalizeText(mapping.currency).toUpperCase() : ''
  };
}

function accountMappingSettingKey(mapping) {
  const normalized = normalizeAccountMappingSetting(mapping);
  return JSON.stringify([normalized.clearingAccountId, normalized.noCurrency, normalized.currency]);
}

function describeAccountMappingSetting(mapping) {
  const normalized = normalizeAccountMappingSetting(mapping);
  const currencyLabel = normalized.noCurrency ? `无币种，兜底币种 ${normalized.currency}` : '取账单币种';
  return `清结算账号 ${normalized.clearingAccountId}（${currencyLabel}）`;
}

function listTemplateAccountMappings(db, templateId) {
  return db
    .prepare(`
      SELECT id, bank_account_id AS bankAccountId, clearing_account_id AS clearingAccountId,
        no_currency AS noCurrency, currency, row_index AS rowIndex
      FROM account_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(Number(templateId));
}

function listChannelAccountMappings(db, channelId) {
  return db
    .prepare(`
      SELECT id, bank_account_id AS bankAccountId, clearing_account_id AS clearingAccountId,
        no_currency AS noCurrency, currency, row_index AS rowIndex
      FROM statement_channel_account_mappings
      WHERE channel_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(Number(channelId));
}

function writeChannelAccountMappingRows(db, channelId, mappings, now = new Date().toISOString()) {
  db.prepare('DELETE FROM statement_channel_account_mappings WHERE channel_id = ?').run(Number(channelId));
  const insert = db.prepare(`
    INSERT INTO statement_channel_account_mappings (
      channel_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  mappings.forEach((mapping, index) => {
    insert.run(
      Number(channelId),
      normalizeText(mapping.bankAccountId),
      normalizeText(mapping.clearingAccountId),
      mapping.noCurrency ? 1 : 0,
      normalizeText(mapping.currency),
      index,
      now,
      now
    );
  });
}

function writeTemplateAccountMappingRows(db, templateId, mappings, now = new Date().toISOString()) {
  db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(Number(templateId));
  const insert = db.prepare(`
    INSERT INTO account_mappings (
      template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  mappings.forEach((mapping, index) => {
    insert.run(
      Number(templateId),
      normalizeText(mapping.bankAccountId),
      normalizeText(mapping.clearingAccountId),
      mapping.noCurrency ? 1 : 0,
      normalizeText(mapping.currency),
      index,
      now,
      now
    );
  });
}

// 用户在渠道层显式设置了某个冲突账户号的映射，即视为已为该账户号选定设置，删除对应冲突。
//   返回 { resolvedConflictBankAccountIds }。
function saveChannelAccountMappings(db, channelId, mappings) {
  return runInTransaction(db, () => {
    requireChannel(db, channelId);
    writeChannelAccountMappingRows(db, channelId, mappings);
    const saved = new Set((mappings || []).map((mapping) => normalizeText(mapping.bankAccountId)).filter(Boolean));
    const resolved = listConflictRows(db, channelId)
      .map((conflict) => conflict.bankAccountId)
      .filter((bankAccountId) => saved.has(bankAccountId));
    const remove = db.prepare(
      'DELETE FROM statement_channel_account_mapping_conflicts WHERE channel_id = ? AND bank_account_id = ?'
    );
    resolved.forEach((bankAccountId) => remove.run(Number(channelId), bankAccountId));
    return { resolvedConflictBankAccountIds: resolved };
  });
}

// 生成时读取：属于渠道取渠道映射，否则取模板映射（T11）。
function listEffectiveAccountMappings(db, template) {
  if (!template) return [];
  const channelId = Number(template.channelId || 0);
  if (channelId > 0) return listChannelAccountMappings(db, channelId);
  return listTemplateAccountMappings(db, template.id);
}

// 合并多个来源（[{ sourceName | sourceNames, mappings }]）到“账户号 → 设置”；返回可写入的映射与冲突。
//   完全相同的设置去重；同一账户号设置不同即冲突（不静默取舍，D8 / A9）。
function mergeAccountMappingSources(sources) {
  const byBankAccount = new Map();
  const order = [];
  for (const source of sources) {
    for (const mapping of source.mappings || []) {
      const normalized = normalizeAccountMappingSetting(mapping);
      if (!normalized.bankAccountId) continue;
      if (!byBankAccount.has(normalized.bankAccountId)) {
        byBankAccount.set(normalized.bankAccountId, new Map());
        order.push(normalized.bankAccountId);
      }
      const settings = byBankAccount.get(normalized.bankAccountId);
      const key = accountMappingSettingKey(normalized);
      if (!settings.has(key)) {
        settings.set(key, {
          clearingAccountId: normalized.clearingAccountId,
          noCurrency: normalized.noCurrency,
          currency: normalized.currency,
          sourceNames: []
        });
      }
      const sourceNames = settings.get(key).sourceNames;
      const names = Array.isArray(source.sourceNames) ? source.sourceNames : [source.sourceName];
      for (const name of names) {
        const normalizedName = normalizeText(name);
        if (normalizedName && !sourceNames.includes(normalizedName)) sourceNames.push(normalizedName);
      }
    }
  }
  const mappings = [];
  const conflicts = [];
  for (const bankAccountId of order) {
    const candidates = Array.from(byBankAccount.get(bankAccountId).values());
    if (candidates.length === 1) {
      const [only] = candidates;
      mappings.push({
        bankAccountId,
        clearingAccountId: only.clearingAccountId,
        noCurrency: only.noCurrency,
        currency: only.currency
      });
    } else {
      conflicts.push({ bankAccountId, candidates });
    }
  }
  return { mappings, conflicts };
}

// 模板包 v5 还原：整体替换渠道的待处理冲突；候选可带 sourceTemplateNames（包内格式）或 sourceNames。
function replaceChannelAccountMappingConflicts(db, channelId, conflicts, now = new Date().toISOString()) {
  db.prepare('DELETE FROM statement_channel_account_mapping_conflicts WHERE channel_id = ?').run(Number(channelId));
  insertConflictRows(db, channelId, (Array.isArray(conflicts) ? conflicts : []).map((conflict) => ({
    bankAccountId: normalizeText(conflict && conflict.bankAccountId),
    candidates: (Array.isArray(conflict && conflict.candidates) ? conflict.candidates : []).map((candidate) => {
      const normalized = normalizeAccountMappingSetting(candidate);
      const names = Array.isArray(candidate && candidate.sourceTemplateNames)
        ? candidate.sourceTemplateNames
        : (Array.isArray(candidate && candidate.sourceNames) ? candidate.sourceNames : []);
      return {
        clearingAccountId: normalized.clearingAccountId,
        noCurrency: normalized.noCurrency,
        currency: normalized.currency,
        sourceNames: names.map((name) => normalizeText(name)).filter(Boolean)
      };
    })
  })).filter((conflict) => conflict.bankAccountId && conflict.candidates.length > 1), now);
}

function insertConflictRows(db, channelId, conflicts, now = new Date().toISOString()) {
  const upsert = db.prepare(`
    INSERT INTO statement_channel_account_mapping_conflicts (channel_id, bank_account_id, candidates_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id, bank_account_id) DO UPDATE SET candidates_json = excluded.candidates_json
  `);
  for (const conflict of conflicts) {
    upsert.run(Number(channelId), conflict.bankAccountId, JSON.stringify(conflict.candidates.map((candidate) => ({
      clearingAccountId: candidate.clearingAccountId,
      noCurrency: Boolean(candidate.noCurrency),
      currency: candidate.currency || '',
      sourceTemplateNames: Array.isArray(candidate.sourceNames) ? candidate.sourceNames.slice() : []
    }))), now);
  }
}

// 迁移与旧版模板包导入：按各来源模板的账户映射整体重建渠道映射与待处理冲突（D8）。
//   sources：[{ sourceName, mappings }]；返回 { mergedCount, conflictCount }。调用方负责事务，
//   并在之后删除来源模板的模板级映射。
// v1.5.1 账户映射迁移标记：旧的全局映射复制给每个模板后，待用户逐条分配。分配只面向普通模板（渠道子模板的映射在渠道层，D7）；
//   已没有普通模板持有模板级映射时无可分配内容，清除标记——否则分配弹窗既无数据也无目标、提交空分配被拒，
//   两个账单导入入口被永久阻断（v3.2.15 PR #246 审查）。仍有普通模板持有映射时保持原样，由用户分配。
const LEGACY_ACCOUNT_MAPPING_MIGRATION_KEY = 'account_mapping_migration_pending';

function settleLegacyAccountMappingMigration(db, now = new Date().toISOString()) {
  const row = db.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(LEGACY_ACCOUNT_MAPPING_MIGRATION_KEY);
  if (!row || row.value !== 'true') return false;
  const remaining = db.prepare(`
    SELECT COUNT(1) AS cnt FROM account_mappings m JOIN templates t ON t.id = m.template_id WHERE t.channel_id IS NULL
  `).get();
  if (Number(remaining && remaining.cnt) > 0) return false;
  db.prepare('UPDATE app_settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?')
    .run('false', now, LEGACY_ACCOUNT_MAPPING_MIGRATION_KEY);
  return true;
}

// 渠道已有的账户映射设置作为合并来源：生效映射 + 待处理冲突的每个候选（v3.2.15 PR #246 审查）。
//   启动迁移与旧版模板包导入都先纳入这些来源，再按新来源重建映射与冲突，避免未涉及的冲突账户号连同冲突记录一起消失、
//   渠道在用户未选定设置时解除生成阻断。
function listChannelExistingSources(db, channelId, channelName) {
  const sources = [];
  const mappings = listChannelAccountMappings(db, channelId);
  if (mappings.length) sources.push({ sourceName: `渠道「${normalizeText(channelName)}」原有设置`, mappings });
  for (const conflict of listConflictRows(db, channelId)) {
    for (const candidate of conflict.candidates) {
      sources.push({
        sourceNames: candidate.sourceTemplateNames,
        mappings: [{ bankAccountId: conflict.bankAccountId, ...candidate }]
      });
    }
  }
  return sources;
}

function replaceChannelAccountMappingsFromSources(db, channelId, sources, now = new Date().toISOString()) {
  const merged = mergeAccountMappingSources(sources);
  writeChannelAccountMappingRows(db, channelId, merged.mappings, now);
  db.prepare('DELETE FROM statement_channel_account_mapping_conflicts WHERE channel_id = ?').run(Number(channelId));
  insertConflictRows(db, channelId, merged.conflicts, now);
  return { mergedCount: merged.mappings.length, conflictCount: merged.conflicts.length };
}

function listConflictRows(db, channelId) {
  return db
    .prepare(`
      SELECT bank_account_id AS bankAccountId, candidates_json AS candidatesJson
      FROM statement_channel_account_mapping_conflicts
      WHERE channel_id = ?
      ORDER BY id ASC
    `)
    .all(Number(channelId))
    .map((row) => {
      let candidates = [];
      try {
        const parsed = JSON.parse(row.candidatesJson);
        candidates = Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        candidates = [];
      }
      return {
        bankAccountId: normalizeText(row.bankAccountId),
        candidates: candidates.map((candidate) => ({
          clearingAccountId: normalizeText(candidate && candidate.clearingAccountId),
          noCurrency: Boolean(candidate && candidate.noCurrency),
          currency: normalizeText(candidate && candidate.currency),
          sourceTemplateNames: Array.isArray(candidate && candidate.sourceTemplateNames)
            ? candidate.sourceTemplateNames.map((name) => normalizeText(name)).filter(Boolean)
            : []
        }))
      };
    });
}

function listChannelAccountMappingConflicts(db, channelId = null) {
  const channels = channelId ? [requireChannel(db, channelId)] : listChannels(db);
  return channels
    .map((channel) => ({
      channelId: channel.id,
      channelName: channel.name,
      conflicts: listConflictRows(db, channel.id)
    }))
    .filter((item) => item.conflicts.length > 0);
}

function countChannelAccountMappingConflicts(db, channelId) {
  const row = db
    .prepare('SELECT COUNT(1) AS cnt FROM statement_channel_account_mapping_conflicts WHERE channel_id = ?')
    .get(Number(channelId));
  return row ? Number(row.cnt) : 0;
}

// choices: [{ bankAccountId, candidateIndex }]；只接受当前登记的冲突与候选下标。
function resolveChannelAccountMappingConflicts(db, channelId, choices = []) {
  return runInTransaction(db, () => {
    requireChannel(db, channelId);
    const conflicts = listConflictRows(db, channelId);
    const byBankAccount = new Map(conflicts.map((conflict) => [conflict.bankAccountId, conflict]));
    const seen = new Set();
    const resolved = [];
    for (const choice of Array.isArray(choices) ? choices : []) {
      const bankAccountId = normalizeText(choice && choice.bankAccountId);
      const candidateIndex = Number(choice && choice.candidateIndex);
      const conflict = byBankAccount.get(bankAccountId);
      if (!conflict || seen.has(bankAccountId) || !Number.isSafeInteger(candidateIndex)
        || candidateIndex < 0 || candidateIndex >= conflict.candidates.length) {
        throw createChannelError(
          'CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE',
          '账户映射冲突已变化，请关闭后重新打开再选择',
          { context: { channelId, bankAccountId, candidateIndex } }
        );
      }
      seen.add(bankAccountId);
      resolved.push({ bankAccountId, ...conflict.candidates[candidateIndex] });
    }
    if (resolved.length === 0) {
      throw createChannelError('CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE', '请为每个账户号选择一条设置');
    }
    const existing = listChannelAccountMappings(db, channelId).filter(
      (mapping) => !seen.has(normalizeText(mapping.bankAccountId))
    );
    const now = new Date().toISOString();
    writeChannelAccountMappingRows(db, channelId, [
      ...existing,
      ...resolved.map((item) => ({
        bankAccountId: item.bankAccountId,
        clearingAccountId: item.clearingAccountId,
        noCurrency: item.noCurrency,
        currency: item.currency
      }))
    ], now);
    const remove = db.prepare(
      'DELETE FROM statement_channel_account_mapping_conflicts WHERE channel_id = ? AND bank_account_id = ?'
    );
    resolved.forEach((item) => remove.run(Number(channelId), item.bankAccountId));
    return { resolved, remaining: countChannelAccountMappingConflicts(db, channelId) };
  });
}

// ===== 模板归属 =====

// 在调用方事务内改变模板的渠道归属，并按 §4.9 移动账户映射。
//   assignment：{ mode: 'keep' } | { mode: 'none' } | { mode: 'create' } | { mode: 'join', channelId }
//   返回 { changed, channelId, previousChannelId, createdChannel }
function applyTemplateChannelAssignment(db, templateId, assignment, now = new Date().toISOString()) {
  const mode = normalizeText(assignment && assignment.mode) || 'keep';
  const template = db.prepare('SELECT id, name, channel_id AS channelId FROM templates WHERE id = ?').get(Number(templateId));
  if (!template) {
    throw createChannelError('TEMPLATE_NOT_FOUND', '未找到对应模板', { context: { templateId } });
  }
  const previousChannelId = template.channelId ? Number(template.channelId) : null;
  if (mode === 'keep') {
    return { changed: false, channelId: previousChannelId, previousChannelId, createdChannel: null };
  }
  // 原渠道还有待处理的账户映射冲突时不允许移出或转入其他渠道：模板拿到的映射副本会缺少冲突账户号，
  //   之后这些账户号按原值输出且没有提示（D8 不静默取舍）。删除渠道另有确认与提示（§4.6）。
  const leavingChannel = previousChannelId
    && (mode === 'none' || mode === 'create' || (mode === 'join' && Number(assignment.channelId) !== previousChannelId));
  if (leavingChannel && countChannelAccountMappingConflicts(db, previousChannelId) > 0) {
    const previous = db.prepare('SELECT name FROM statement_channels WHERE id = ?').get(previousChannelId);
    throw createChannelError(
      'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING',
      `渠道「${normalizeText(previous && previous.name)}」的账户映射还有待处理的冲突，请先在「账户映射」中处理后再移出该渠道`,
      { context: { channelId: previousChannelId, templateId: template.id } }
    );
  }
  if (!['none', 'create', 'join'].includes(mode)) {
    throw createChannelError('CHANNEL_ASSIGNMENT_INVALID', '渠道归属参数无效', { context: { mode } });
  }
  const templateName = normalizeText(template.name);

  if (mode === 'none') {
    if (!previousChannelId) {
      return { changed: false, channelId: null, previousChannelId, createdChannel: null };
    }
    const sameNameChannel = db.prepare('SELECT id FROM statement_channels WHERE name = ?').get(templateName);
    if (sameNameChannel) {
      throw createChannelError(
        'CHANNEL_OUTPUT_NAME_CONFLICT',
        `模板「${templateName}」与渠道「${templateName}」同名，移出渠道后两者的输出名称相同、生成的账单与余额会混在一起；请先重命名模板或渠道再移出`,
        { context: { templateId: template.id, channelId: Number(sameNameChannel.id) } }
      );
    }
    // A10：移出渠道时复制渠道映射，输出保持不变。
    writeTemplateAccountMappingRows(db, template.id, listChannelAccountMappings(db, previousChannelId), now);
    db.prepare('UPDATE templates SET channel_id = NULL, updated_at = ? WHERE id = ?').run(now, template.id);
    return { changed: true, channelId: null, previousChannelId, createdChannel: null };
  }

  if (mode === 'create') {
    const existing = db.prepare('SELECT id FROM statement_channels WHERE name = ?').get(templateName);
    if (existing) {
      // D6：已有同名渠道时不新建，提示改用【设为子模板】。
      throw createChannelError(
        'CHANNEL_NAME_DUPLICATED',
        `已存在同名渠道「${templateName}」，请改用【设为子模板】选择该渠道`,
        { context: { channelName: templateName, channelId: Number(existing.id) } }
      );
    }
    const channelId = insertChannelRow(db, templateName, now);
    // 原属其他渠道时先移出：新渠道取原渠道映射的副本（与移出时复制的口径一致，A10）。
    const sourceMappings = previousChannelId
      ? listChannelAccountMappings(db, previousChannelId)
      : listTemplateAccountMappings(db, template.id);
    writeChannelAccountMappingRows(db, channelId, sourceMappings, now);
    db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(template.id);
    db.prepare('UPDATE templates SET channel_id = ?, updated_at = ? WHERE id = ?').run(channelId, now, template.id);
    settleLegacyAccountMappingMigration(db, now);
    return { changed: true, channelId, previousChannelId, createdChannel: { id: channelId, name: templateName } };
  }

  const targetChannelId = Number(assignment.channelId);
  const channel = db.prepare('SELECT id, name FROM statement_channels WHERE id = ?').get(targetChannelId);
  if (!channel) {
    throw createChannelError('CHANNEL_NOT_FOUND', '未找到所选渠道，请刷新后重试', { context: { channelId: assignment.channelId } });
  }
  if (previousChannelId === targetChannelId) {
    return { changed: false, channelId: targetChannelId, previousChannelId, createdChannel: null };
  }
  // 从另一个渠道直接转入：先按移出处理，模板拿到原渠道映射的副本，再并入目标渠道。
  const ownMappings = previousChannelId
    ? listChannelAccountMappings(db, previousChannelId)
    : listTemplateAccountMappings(db, template.id);
  const channelMappings = listChannelAccountMappings(db, targetChannelId);
  const merged = mergeAccountMappingSources([
    { sourceName: normalizeText(channel.name), mappings: channelMappings },
    { sourceName: templateName, mappings: ownMappings }
  ]);
  if (merged.conflicts.length > 0) {
    // A9：并入已有渠道时同一账户号设置不同，阻断整个保存，列出冲突。
    throw createChannelError(
      'CHANNEL_ACCOUNT_MAPPING_CONFLICT',
      `模板「${templateName}」的账户映射与渠道「${normalizeText(channel.name)}」有 ${merged.conflicts.length} 个账户号设置不同，请先在账户映射中统一`,
      {
        detailLines: merged.conflicts.map((conflict) => {
          const channelSide = conflict.candidates.find((candidate) => candidate.sourceNames.includes(normalizeText(channel.name)));
          const templateSide = conflict.candidates.find((candidate) => candidate.sourceNames.includes(templateName));
          return `账户号 ${conflict.bankAccountId}：渠道为${channelSide ? describeAccountMappingSetting(channelSide) : '（无）'}，模板为${templateSide ? describeAccountMappingSetting(templateSide) : '（无）'}`;
        }),
        context: {
          channelId: targetChannelId,
          templateId: template.id,
          conflictBankAccountIds: merged.conflicts.map((conflict) => conflict.bankAccountId)
        }
      }
    );
  }
  writeChannelAccountMappingRows(db, targetChannelId, merged.mappings, now);
  db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(template.id);
  db.prepare('UPDATE templates SET channel_id = ?, updated_at = ? WHERE id = ?').run(targetChannelId, now, template.id);
  settleLegacyAccountMappingMigration(db, now);
  return { changed: true, channelId: targetChannelId, previousChannelId, createdChannel: null };
}

// 删除渠道：子模板恢复为普通模板并获得渠道映射副本（A5、A10）；冲突随渠道级联清除。
function deleteChannel(db, channelId) {
  return runInTransaction(db, () => {
    const channel = requireChannel(db, channelId);
    const now = new Date().toISOString();
    const channelMappings = listChannelAccountMappings(db, channel.id);
    const conflictCount = countChannelAccountMappingConflicts(db, channel.id);
    const templates = listTemplateIdsByChannel(db, channel.id);
    for (const template of templates) {
      writeTemplateAccountMappingRows(db, template.id, channelMappings, now);
    }
    // 不单独依赖连接上的 foreign_keys 设置（§3.1）。
    db.prepare('UPDATE templates SET channel_id = NULL, updated_at = ? WHERE channel_id = ?').run(now, channel.id);
    db.prepare('DELETE FROM statement_channel_account_mapping_conflicts WHERE channel_id = ?').run(channel.id);
    db.prepare('DELETE FROM statement_channel_account_mappings WHERE channel_id = ?').run(channel.id);
    db.prepare('DELETE FROM statement_channels WHERE id = ?').run(channel.id);
    return { channel, releasedTemplates: templates, conflictCount };
  });
}

// 【导入子模板】：单个事务内分配编号、插入模板并归入渠道（D9、A11）。
//   名称从 next_child_no 开始找第一个未被任何模板占用的 `<渠道名>-子模板-<N>`，成功后 next_child_no = N + 1。
function createChildTemplate(db, channelId, { sourceFileName, headers }) {
  return runInTransaction(db, () => {
    const channel = requireChannel(db, channelId);
    const nameExists = db.prepare('SELECT 1 FROM templates WHERE name = ?');
    let childNo = Math.max(1, Number(channel.nextChildNo || 1));
    let name = buildChildTemplateName(channel.name, childNo);
    while (nameExists.get(name)) {
      childNo += 1;
      name = buildChildTemplateName(channel.name, childNo);
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(`
        INSERT INTO templates (template_key, name, source_file_name, headers_json, created_at, updated_at, channel_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), name, normalizeText(sourceFileName), JSON.stringify(Array.isArray(headers) ? headers : []), now, now, channel.id);
    db.prepare('UPDATE statement_channels SET next_child_no = ?, updated_at = ? WHERE id = ?')
      .run(childNo + 1, now, channel.id);
    return { templateId: Number(result.lastInsertRowid), name, childNo, channel };
  });
}

// 模板包导入：直接设置归属，不移动账户映射（由导入流程按包内容整体写入）。
function setTemplateChannel(db, templateId, channelId) {
  db.prepare('UPDATE templates SET channel_id = ?, updated_at = ? WHERE id = ?')
    .run(channelId ? Number(channelId) : null, new Date().toISOString(), Number(templateId));
}

module.exports = {
  CHILD_TEMPLATE_NAME_INFIX,
  applyTemplateChannelAssignment,
  buildChildTemplateName,
  countChannelAccountMappingConflicts,
  createChannel,
  createChannelError,
  listChannelExistingSources,
  settleLegacyAccountMappingMigration,
  createChildTemplate,
  deleteChannel,
  describeAccountMappingSetting,
  getChannel,
  getChannelByName,
  getOrCreateChannelId,
  listChannelAccountMappingConflicts,
  listChannelAccountMappings,
  listChannels,
  listConflictRows,
  listEffectiveAccountMappings,
  listTemplateAccountMappings,
  listTemplateIdsByChannel,
  mergeAccountMappingSources,
  normalizeAccountMappingSetting,
  renameChannel,
  replaceChannelAccountMappingConflicts,
  replaceChannelAccountMappingsFromSources,
  resolveChannelAccountMappingConflicts,
  saveChannelAccountMappings,
  setTemplateChannel,
  splitOutputNameSegments,
  writeChannelAccountMappingRows,
  writeTemplateAccountMappingRows
};
