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

const CURRENT_MODULE_KEY = 'current_module';
const CURRENT_MODULE_VALID = [
  'statement-generator',
  'new-account-generator',
  'pending-reconciliation',
  'bank-statement-process',
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块
  'recon-id-fix'
];
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
  ensureUiStyleDefault,
  getBackgroundConfig,
  getCurrentModule,
  getEnumConfig,
  getReconIdFixBillCategory,
  getSetting,
  getUiStyle,
  listAccountMappings,
  saveAccountMappings,
  setBackgroundConfig,
  setCurrentModule,
  setEnumConfig,
  setReconIdFixBillCategory,
  setSetting,
  setUiStyle
};
