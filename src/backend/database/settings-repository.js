function getSetting(db, settingKey) {
  const row = db
    .prepare(`
      SELECT setting_value AS settingValue
      FROM app_settings
      WHERE setting_key = ?
    `)
    .get(settingKey);

  return row ? row.settingValue : null;
}

function setSetting(db, settingKey, settingValue) {
  const now = new Date().toISOString();
  db
    .prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
    `)
    .run(settingKey, settingValue, now);
}

function getEnumConfig(db) {
  const raw = getSetting(db, 'enum_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setEnumConfig(db, enumConfig) {
  setSetting(db, 'enum_config', JSON.stringify(enumConfig));
}

function getBackgroundConfig(db) {
  const raw = getSetting(db, 'background_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setBackgroundConfig(db, backgroundConfig) {
  setSetting(db, 'background_config', JSON.stringify(backgroundConfig));
}

const UI_STYLE_KEY = 'ui_style';
const UI_STYLE_VALID = ['Clear', 'General'];
const UI_STYLE_DEFAULT = 'Clear';

function getUiStyle(db) {
  const value = getSetting(db, UI_STYLE_KEY);
  if (value && UI_STYLE_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setUiStyle(db, style) {
  if (!UI_STYLE_VALID.includes(style)) {
    throw new Error(`Invalid ui_style: ${style}, must be one of ${UI_STYLE_VALID.join(' | ')}`);
  }
  setSetting(db, UI_STYLE_KEY, style);
}

function ensureUiStyleDefault(db) {
  const current = getUiStyle(db);
  if (!current) {
    setSetting(db, UI_STYLE_KEY, UI_STYLE_DEFAULT);
    return UI_STYLE_DEFAULT;
  }
  return current;
}

// v2.1.4：7 个主模块的 ID 全集（renderer 端 MODULES 常量必须与此一致；新增模块时两边都要加）
//   修复历史 bug — v2.1.2 新增 bank-bu-recon、v2.1.3 新增 biz-op-recon 时忘了同步 CURRENT_MODULE_VALID 枚举，
//   导致用户切到这两个模块时 setCurrentModule 抛 "Invalid current_module"
const ALL_MODULE_IDS = Object.freeze([
  'statement-generator',
  'new-account-generator',
  'pending-reconciliation',
  'bank-statement-process',
  'recon-id-fix',          // v2.1.0-beta.1 PR-A 新增
  'bank-bu-recon',         // v2.1.2 新增
  'biz-op-recon'           // v2.1.3 新增
]);

const CURRENT_MODULE_KEY = 'current_module';
const CURRENT_MODULE_VALID = ALL_MODULE_IDS;
const CURRENT_MODULE_DEFAULT = 'statement-generator';

function getCurrentModule(db) {
  const value = getSetting(db, CURRENT_MODULE_KEY);
  if (value && CURRENT_MODULE_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setCurrentModule(db, moduleId) {
  if (!CURRENT_MODULE_VALID.includes(moduleId)) {
    throw new Error(
      `Invalid current_module: ${moduleId}, must be one of ${CURRENT_MODULE_VALID.join(' | ')}`
    );
  }
  setSetting(db, CURRENT_MODULE_KEY, moduleId);
}

// v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business / gateway / null）
const RECON_ID_FIX_BILL_CATEGORY_KEY = 'recon_id_fix_bill_category';
const RECON_ID_FIX_BILL_CATEGORY_VALID = ['business', 'gateway'];

function getReconIdFixBillCategory(db) {
  const value = getSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY);
  if (value && RECON_ID_FIX_BILL_CATEGORY_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setReconIdFixBillCategory(db, category) {
  if (category === null || category === '' || category === undefined) {
    setSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY, '');
    return;
  }
  if (!RECON_ID_FIX_BILL_CATEGORY_VALID.includes(category)) {
    throw new Error(
      `Invalid recon_id_fix_bill_category: ${category}, must be one of ${RECON_ID_FIX_BILL_CATEGORY_VALID.join(' | ')} | null`
    );
  }
  setSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY, category);
}

// v2.1.4 T3：左上角模块切换按钮的启用列表（JSON 数组，元素为 ALL_MODULE_IDS 子集）
const ENABLED_MODULES_KEY = 'enabled_modules';
const DEFAULT_ENABLED_MODULES = Object.freeze([
  'statement-generator',
  'bank-statement-process',
  'recon-id-fix'
]);

function getEnabledModules(db) {
  const raw = getSetting(db, ENABLED_MODULES_KEY);
  if (!raw) {
    // 首次启动 seed 默认值（幂等）
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (_error) {
    // 解析失败 → 回退默认值（不抛错，避免阻断启动）
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  // 过滤非法 ID + 去重 + 保留顺序
  const seen = new Set();
  const sanitized = parsed.filter((id) => {
    if (typeof id !== 'string' || !ALL_MODULE_IDS.includes(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // 若 sanitize 后为空（DB 内全是非法 ID）→ 回退默认值，避免锁死 UI
  if (sanitized.length === 0) {
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  return sanitized;
}

function setEnabledModules(db, moduleList) {
  if (!Array.isArray(moduleList)) {
    throw new Error('enabled_modules must be an array');
  }
  const seen = new Set();
  const sanitized = [];
  moduleList.forEach((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Invalid enabled_modules entry: ${JSON.stringify(id)}, must be non-empty string`);
    }
    if (!ALL_MODULE_IDS.includes(id)) {
      throw new Error(
        `Invalid module id: ${id}, must be one of ${ALL_MODULE_IDS.join(' | ')}`
      );
    }
    if (seen.has(id)) return;  // 静默去重
    seen.add(id);
    sanitized.push(id);
  });
  if (sanitized.length === 0) {
    throw new Error('enabled_modules must not be empty');  // PRD B1：至少保留 1 个
  }
  setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(sanitized));
}

function listAccountMappings(db, templateId) {
  return db
    .prepare(`
      SELECT
        id,
        bank_account_id AS bankAccountId,
        clearing_account_id AS clearingAccountId,
        no_currency AS noCurrency,
        currency,
        row_index AS rowIndex
      FROM account_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId);
}

function saveAccountMappings(db, templateId, mappings) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO account_mappings (
        template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      insertStatement.run(
        templateId,
        mapping.bankAccountId,
        mapping.clearingAccountId,
        mapping.noCurrency ? 1 : 0,
        mapping.currency || '',
        index,
        now,
        now
      );
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ALL_MODULE_IDS,
  DEFAULT_ENABLED_MODULES,
  ensureUiStyleDefault,
  getBackgroundConfig,
  getCurrentModule,
  getEnabledModules,
  getEnumConfig,
  getReconIdFixBillCategory,
  getSetting,
  getUiStyle,
  listAccountMappings,
  saveAccountMappings,
  setBackgroundConfig,
  setCurrentModule,
  setEnabledModules,
  setEnumConfig,
  setReconIdFixBillCategory,
  setSetting,
  setUiStyle
};
